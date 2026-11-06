import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { ROLE_NAMES, bootstrapDatabase } from '../bootstrap.ts';
import { loadMigrations, migrate } from '../migrate.ts';
import type { TestDatabaseUrls } from './index.ts';

function withCredentials(base: string, user: string, password: string, database: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

/**
 * Creates an isolated, uniquely named database for this test run, bootstraps the production
 * role model with random per-run passwords, applies migrations as the migrator role, and drops
 * the database afterwards.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  if (!adminUrl) {
    throw new Error(
      'TEST_DATABASE_ADMIN_URL is required for integration tests (superuser URL of a disposable PostgreSQL 16 instance).',
    );
  }
  const database = `eventhub_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(database)}`);
  await admin.end();

  const passwords = {
    migrator: randomBytes(24).toString('hex'),
    app: randomBytes(24).toString('hex'),
    worker: randomBytes(24).toString('hex'),
  };
  const dbAdmin = new pg.Client({
    connectionString: withCredentials(
      adminUrl,
      new URL(adminUrl).username,
      decodeURIComponent(new URL(adminUrl).password),
      database,
    ),
  });
  await dbAdmin.connect();
  await bootstrapDatabase(dbAdmin, database, passwords);
  await dbAdmin.end();

  const urls: TestDatabaseUrls = {
    migratorUrl: withCredentials(adminUrl, ROLE_NAMES.migrator, passwords.migrator, database),
    appUrl: withCredentials(adminUrl, ROLE_NAMES.app, passwords.app, database),
    workerUrl: withCredentials(adminUrl, ROLE_NAMES.worker, passwords.worker, database),
    databaseName: database,
  };
  const migrator = new pg.Client({ connectionString: urls.migratorUrl });
  await migrator.connect();
  await migrate(migrator, await loadMigrations());
  await migrator.end();

  project.provide('eventhubDb', urls);

  return async () => {
    const teardown = new pg.Client({ connectionString: adminUrl });
    await teardown.connect();
    await teardown.query(
      `DROP DATABASE IF EXISTS ${teardown.escapeIdentifier(database)} WITH (FORCE)`,
    );
    await teardown.end();
  };
}
