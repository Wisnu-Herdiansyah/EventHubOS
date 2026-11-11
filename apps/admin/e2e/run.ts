/**
 * End-to-end harness: a disposable PostgreSQL database (production role model, all migrations),
 * the real API, the outbox worker writing emails to a temp folder, and the production builds of
 * this app and the public site app (served on *.localhost), then Playwright against them. Everything is torn down afterwards, pass or fail.
 *
 * Needs TEST_DATABASE_ADMIN_URL (superuser URL of a disposable PostgreSQL 16 instance).
 * Set E2E_SKIP_BUILD=1 to reuse an existing `next build`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ROLE_NAMES, bootstrapDatabase, loadMigrations, migrate } from '@eventhub/db';

const adminDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(adminDir, '..', '..');
const siteDir = join(repoRoot, 'apps', 'site');
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl) {
  process.stderr.write(
    'TEST_DATABASE_ADMIN_URL is required (disposable PostgreSQL 16 superuser URL).\n',
  );
  process.exit(2);
}

function withCredentials(user: string, password: string, database: string): string {
  const u = new URL(adminUrl!);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      srv.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

const children: ChildProcess[] = [];
function start(
  name: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd = repoRoot,
) {
  const child = spawn(command, args, {
    cwd,
    // Only what each process needs: no inherited secrets beyond PATH/HOME.
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'production',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = (chunk: Buffer) =>
    chunk
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((l) => `[${name}] ${l}`)
      .join('\n');
  child.stdout?.on('data', (c: Buffer) => process.stdout.write(`${prefix(c)}\n`));
  child.stderr?.on('data', (c: Buffer) => process.stderr.write(`${prefix(c)}\n`));
  children.push(child);
  return child;
}

function run(command: string, args: string[], env: Record<string, string>, cwd = repoRoot) {
  return new Promise<number>((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function waitFor(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const database = `eventhub_e2e_${randomBytes(6).toString('hex')}`;
const mailDir = await mkdtemp(join(tmpdir(), 'eventhub-e2e-mail-'));
// Uploaded images (ADR-0042): the API writes, the worker deletes; one local directory per run.
const objectDir = await mkdtemp(join(tmpdir(), 'eventhub-e2e-objects-'));
let exitCode = 1;
let created = false;
try {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(database)}`);
  created = true;
  await admin.end();

  const passwords = {
    migrator: randomBytes(24).toString('hex'),
    app: randomBytes(24).toString('hex'),
    worker: randomBytes(24).toString('hex'),
  };
  const u = new URL(adminUrl);
  const dbAdmin = new pg.Client({
    connectionString: withCredentials(u.username, decodeURIComponent(u.password), database),
  });
  await dbAdmin.connect();
  await bootstrapDatabase(dbAdmin, database, passwords);
  await dbAdmin.end();
  const migrator = new pg.Client({
    connectionString: withCredentials(ROLE_NAMES.migrator, passwords.migrator, database),
  });
  await migrator.connect();
  await migrate(migrator, await loadMigrations());
  await migrator.end();

  const [apiPort, adminPort, sitePort] = [await freePort(), await freePort(), await freePort()];
  // Chromium resolves every *.localhost name to this machine, so {handle}.localhost works.
  const siteTemplate = `http://{handle}.localhost:${sitePort}`;
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  // `localhost` is a secure context in Chromium, so the Secure __Host- cookie works without TLS.
  const baseUrl = `http://localhost:${adminPort}`;

  if (process.env.E2E_SKIP_BUILD !== '1') {
    const code = await run(
      'pnpm',
      ['exec', 'next', 'build'],
      { NEXT_TELEMETRY_DISABLED: '1' },
      adminDir,
    );
    if (code !== 0) throw new Error('next build failed');
    const siteCode = await run(
      'pnpm',
      ['exec', 'next', 'build'],
      { NEXT_TELEMETRY_DISABLED: '1' },
      siteDir,
    );
    if (siteCode !== 0) throw new Error('site next build failed');
  }

  start('api', process.execPath, ['apps/api/src/main.ts'], {
    EVENTHUB_ENV: 'ci',
    LOG_LEVEL: 'warn',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: String(apiPort),
    DATABASE_APP_URL: withCredentials(ROLE_NAMES.app, passwords.app, database),
    // Only the admin app (same host here) may supply X-Forwarded-For.
    TRUST_PROXY: '127.0.0.1,::1',
    RATE_LIMIT_PER_MINUTE: '2000',
    // Seals authenticator secrets (ADR-0022); random per run.
    MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    // Passkeys are bound to the admin app's host (ADR-0033); localhost counts as a secure origin.
    PASSKEY_ORIGIN: baseUrl,
    OBJECT_STORE: 'local_directory',
    OBJECT_STORE_DIR: objectDir,
  });
  start('worker', process.execPath, ['apps/worker/src/main.ts'], {
    EVENTHUB_ENV: 'ci',
    LOG_LEVEL: 'warn',
    DATABASE_WORKER_URL: withCredentials(ROLE_NAMES.worker, passwords.worker, database),
    EVENT_PUBLISHER: 'postgres_outbox',
    OUTBOX_POLL_INTERVAL_MS: '200',
    EMAIL_SENDER: 'local_file',
    EMAIL_LOCAL_DIR: mailDir,
    APP_BASE_URL: baseUrl,
    EMAIL_TOKEN_SECRET: randomBytes(32).toString('hex'),
    // Registration cancel links point at the public sites (ADR-0023).
    PUBLIC_SITE_URL: siteTemplate,
    OBJECT_STORE: 'local_directory',
    OBJECT_STORE_DIR: objectDir,
  });
  start(
    'admin',
    'pnpm',
    ['exec', 'next', 'start', '--hostname', 'localhost', '--port', String(adminPort)],
    {
      NEXT_TELEMETRY_DISABLED: '1',
      ADMIN_API_URL: apiUrl,
      // Tests send X-Forwarded-For the way a load balancer would (see e2e/support.ts).
      ADMIN_TRUSTED_PROXY_HOPS: '1',
      // The design-system spec checks every component in the gallery (ADR-0019).
      ADMIN_DESIGN_GALLERY: '1',
      ADMIN_PUBLIC_SITE_URL: siteTemplate,
    },
    adminDir,
  );
  start(
    'site',
    'pnpm',
    ['exec', 'next', 'start', '--hostname', 'localhost', '--port', String(sitePort)],
    {
      NEXT_TELEMETRY_DISABLED: '1',
      SITE_API_URL: apiUrl,
      SITE_DOMAIN: 'localhost',
      SITE_HTTPS: '0',
      // Tests send X-Forwarded-For like a load balancer; the site passes the visitor IP on.
      SITE_TRUSTED_PROXY_HOPS: '1',
    },
    siteDir,
  );

  await waitFor(`${apiUrl}/health/live`);
  await waitFor(`${baseUrl}/login`);
  await waitFor(`http://localhost:${sitePort}/`);

  exitCode = await run(
    'pnpm',
    ['exec', 'playwright', 'test', ...process.argv.slice(2)],
    {
      E2E_BASE_URL: baseUrl,
      E2E_API_URL: apiUrl,
      E2E_MAIL_DIR: mailDir,
      E2E_SITE_URL_TEMPLATE: siteTemplate,
      // Disposable test database, for fixtures that cannot wait in real time (e.g. idle timeout).
      E2E_FIXTURE_DATABASE_URL: withCredentials(ROLE_NAMES.migrator, passwords.migrator, database),
    },
    adminDir,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
} finally {
  for (const child of children) child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  await rm(mailDir, { recursive: true, force: true });
  await rm(objectDir, { recursive: true, force: true });
  if (created) {
    const teardown = new pg.Client({ connectionString: adminUrl });
    await teardown.connect();
    await teardown.query(
      `DROP DATABASE IF EXISTS ${teardown.escapeIdentifier(database)} WITH (FORCE)`,
    );
    await teardown.end();
  }
}
process.exit(exitCode);
