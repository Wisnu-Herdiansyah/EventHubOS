import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { createPool, type Pool } from '../pool.ts';

export interface TestDatabaseUrls {
  migratorUrl: string;
  appUrl: string;
  workerUrl: string;
  databaseName: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    eventhubDb: TestDatabaseUrls;
  }
}

export function testDatabaseUrls(): TestDatabaseUrls {
  return inject('eventhubDb');
}

/** Pools for each role. The migrator pool (BYPASSRLS) is for fixtures/assertions only. */
export function createTestPools(): {
  app: Pool;
  worker: Pool;
  migrator: Pool;
  end(): Promise<void>;
} {
  const urls = testDatabaseUrls();
  const app = createPool({ connectionString: urls.appUrl, applicationName: 'test-app', max: 5 });
  const worker = createPool({
    connectionString: urls.workerUrl,
    applicationName: 'test-worker',
    max: 2,
  });
  const migrator = createPool({
    connectionString: urls.migratorUrl,
    applicationName: 'test-fixtures',
    max: 2,
  });
  return {
    app,
    worker,
    migrator,
    end: async () => {
      await Promise.all([app.end(), worker.end(), migrator.end()]);
    },
  };
}

export interface FixtureUser {
  id: string;
  email: string;
  /** Raw opaque session token (only the SHA-256 hash is stored). */
  token: string;
}

/**
 * Seeds a user and a session directly (identity provider is an open decision; production
 * session issuance will come from the selected identity adapter).
 */
export async function createFixtureUser(
  fixtures: Pool,
  options: { verified?: boolean; sessionExpired?: boolean } = {},
): Promise<FixtureUser> {
  const email = `user-${randomUUID()}@example.test`;
  const { rows } = await fixtures.query<{ id: string }>(
    `INSERT INTO eventhub.app_user (email, email_verified_at) VALUES ($1, $2) RETURNING id`,
    [email, options.verified === false ? null : new Date()],
  );
  const id = rows[0]!.id;
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest();
  await fixtures.query(
    `INSERT INTO eventhub.auth_session (user_id, token_hash, created_at, expires_at)
     VALUES ($1, $2, now() - interval '2 hours', now() + $3::interval)`,
    [id, hash, options.sessionExpired ? '-1 hour' : '1 hour'],
  );
  return { id, email, token };
}

/** Seeds an organization with an active membership for `userId` in the given role. */
export async function createFixtureOrganization(
  fixtures: Pool,
  ownerId: string,
  name = `Org ${randomUUID().slice(0, 8)}`,
): Promise<string> {
  const id = randomUUID();
  await fixtures.query(
    `INSERT INTO eventhub.organization (id, display_name, locale, timezone, created_by)
     VALUES ($1, $2, 'en', 'UTC', $3)`,
    [id, name, ownerId],
  );
  await addFixtureMembership(fixtures, id, ownerId, 'owner');
  return id;
}

export async function addFixtureMembership(
  fixtures: Pool,
  organizationId: string,
  userId: string,
  role: string,
): Promise<void> {
  await fixtures.query(
    `INSERT INTO eventhub.membership (organization_id, user_id, role, status, accepted_at)
     VALUES ($1, $2, $3, 'active', now())`,
    [organizationId, userId, role],
  );
}

export async function createFixtureEvent(
  fixtures: Pool,
  organizationId: string,
  createdBy: string,
  slug = `event-${randomBytes(4).toString('hex')}`,
): Promise<string> {
  const { rows } = await fixtures.query<{ id: string }>(
    `INSERT INTO eventhub.event (organization_id, name, slug, timezone, starts_at, ends_at,
                                 venue_mode, primary_language, created_by)
     VALUES ($1, 'Fixture event', $2, 'UTC', now() + interval '30 days',
             now() + interval '31 days', 'in_person', 'en', $3)
     RETURNING id`,
    [organizationId, slug, createdBy],
  );
  return rows[0]!.id;
}
