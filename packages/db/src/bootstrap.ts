import type pg from 'pg';

/**
 * Database role bootstrap, executed once per environment by a platform operator using a
 * superuser/admin connection to the target database. Creates three roles:
 *
 *  - eventhub_migrator: owns the `eventhub` schema; used only by the migration job.
 *    Holds BYPASSRLS for reviewed backfills. Never used by runtime workloads.
 *  - eventhub_app:      runtime API role. NOBYPASSRLS, owns nothing, column-scoped grants.
 *  - eventhub_worker:   outbox relay role. NOBYPASSRLS, delivery-state access only.
 *
 * Passwords are supplied at runtime (secret manager / CI-generated) and never stored.
 */

export const ROLE_NAMES = {
  migrator: 'eventhub_migrator',
  app: 'eventhub_app',
  worker: 'eventhub_worker',
} as const;

export interface RolePasswords {
  migrator: string;
  app: string;
  worker: string;
}

const MIN_PASSWORD_LENGTH = 24;

export async function bootstrapDatabase(
  admin: pg.Client,
  databaseName: string,
  passwords: RolePasswords,
): Promise<void> {
  for (const role of ['migrator', 'app', 'worker'] as const) {
    const pw = passwords[role];
    if (pw.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `Password for ${role} role must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }
  }
  const db = admin.escapeIdentifier(databaseName);
  const roles: Array<[string, string, boolean]> = [
    [ROLE_NAMES.migrator, passwords.migrator, true],
    [ROLE_NAMES.app, passwords.app, false],
    [ROLE_NAMES.worker, passwords.worker, false],
  ];

  await admin.query('BEGIN');
  try {
    // Keep role passwords out of server statement logs.
    await admin.query("SET LOCAL log_statement = 'none'");
    for (const [name, password, bypassRls] of roles) {
      const ident = admin.escapeIdentifier(name);
      await admin.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${admin.escapeLiteral(name)}) THEN
             CREATE ROLE ${ident};
           END IF;
         END $$`,
      );
      await admin.query(
        `ALTER ROLE ${ident} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
           ${bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS'} PASSWORD ${admin.escapeLiteral(password)}`,
      );
    }
    await admin.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
    await admin.query(
      `GRANT CONNECT ON DATABASE ${db} TO ${ROLE_NAMES.migrator}, ${ROLE_NAMES.app}, ${ROLE_NAMES.worker}`,
    );
    await admin.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await admin.query(`CREATE SCHEMA IF NOT EXISTS eventhub AUTHORIZATION ${ROLE_NAMES.migrator}`);
    await admin.query(`REVOKE ALL ON SCHEMA eventhub FROM PUBLIC`);
    await admin.query(`GRANT USAGE ON SCHEMA eventhub TO ${ROLE_NAMES.app}, ${ROLE_NAMES.worker}`);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
