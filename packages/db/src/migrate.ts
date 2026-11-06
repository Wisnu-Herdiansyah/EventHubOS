import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/**
 * Forward-only, checksummed migrations. Each file runs in its own transaction with a lock
 * timeout so a blocked DDL fails fast rather than queueing behind production traffic.
 * Applied migrations are immutable: editing one is detected by checksum and aborts.
 * Schema changes follow expand -> migrate -> contract (docs/adr/0003, CONTRIBUTING.md).
 */

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const MIGRATION_LOCK_KEY = 72_410_001; // arbitrary constant advisory-lock key for migrations

export interface Migration {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  for (const [index, file] of files.entries()) {
    const match = FILE_RE.exec(file);
    if (!match) throw new Error(`Migration file name must match NNNN_snake_name.sql: ${file}`);
    const version = match[1]!;
    if (Number(version) !== index + 1) {
      throw new Error(
        `Migration versions must be contiguous from 0001; found ${file} at position ${index + 1}`,
      );
    }
    const sql = await readFile(`${dir}/${file}`, 'utf8');
    migrations.push({
      version,
      name: match[2]!,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return migrations;
}

const DESTRUCTIVE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bDROP\s+(TABLE|SCHEMA|COLUMN|TYPE|INDEX(?!\s+CONCURRENTLY))\b/i, 'DROP'],
  [/(^|;)\s*TRUNCATE\b/im, 'TRUNCATE'],
  [/\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i, 'column type change'],
  [/\bRENAME\s+(COLUMN|TO)\b/i, 'RENAME'],
  [/\bDELETE\s+FROM\b/i, 'DELETE'],
  [/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i, 'DISABLE ROW LEVEL SECURITY'],
  [/\bNO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b/i, 'NO FORCE ROW LEVEL SECURITY'],
  [/\bBYPASSRLS\b/i, 'BYPASSRLS'],
];
const ALLOW_MARKER = /^--\s*eventhub:allow-destructive\s+\S.{10,}$/m;

/**
 * Static safety lint: destructive or isolation-weakening statements require an explicit,
 * reviewed justification marker (`-- eventhub:allow-destructive <reason + plan reference>`).
 */
export function lintMigration(sql: string): string[] {
  const withoutComments = sql.replace(/--.*$/gm, '');
  const findings = DESTRUCTIVE_PATTERNS.filter(([re]) => re.test(withoutComments)).map(
    ([, label]) => label,
  );
  return findings.length > 0 && !ALLOW_MARKER.test(sql) ? findings : [];
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function migrate(client: pg.Client, migrations: Migration[]): Promise<MigrateResult> {
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS eventhub.schema_migration (
        version    text PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM eventhub.schema_migration ORDER BY version',
    );
    const known = new Map(migrations.map((m) => [m.version, m]));
    for (const row of rows) {
      const local = known.get(row.version);
      if (!local)
        throw new Error(`Database has migration ${row.version} that is not present locally`);
      if (local.checksum !== row.checksum) {
        throw new Error(`Applied migration ${row.version} was modified (checksum mismatch)`);
      }
    }
    const appliedVersions = new Set(rows.map((r) => r.version));
    const applied: string[] = [];
    for (const m of migrations) {
      if (appliedVersions.has(m.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query('SET LOCAL search_path = eventhub');
        await client.query(m.sql);
        await client.query(
          'INSERT INTO eventhub.schema_migration (version, name, checksum) VALUES ($1, $2, $3)',
          [m.version, m.name, m.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${m.version}_${m.name} failed`, { cause: error });
      }
      applied.push(m.version);
    }
    return { applied, alreadyApplied: [...appliedVersions] };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
  }
}
