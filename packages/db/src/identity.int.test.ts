import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureUser, createTestPools } from './testing/index.ts';
import { withTransaction } from './transaction.ts';

const HASH =
  '$argon2id$v=19$m=19456,p=1,t=2$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g';

describe('identity storage privileges (ADR-0007)', () => {
  const pools = createTestPools();
  let userId: string;
  beforeAll(async () => {
    userId = (await createFixtureUser(pools.migrator)).id;
  });
  afterAll(() => pools.end());

  it('runtime role cannot read credentials or verification tokens directly, even as the user', async () => {
    for (const table of ['user_credential', 'email_verification_token']) {
      await expect(
        withTransaction(pools.app, { userId }, (c) => c.query(`SELECT * FROM eventhub.${table}`)),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('worker role cannot read users or credentials directly', async () => {
    for (const table of ['app_user', 'user_credential', 'auth_session']) {
      await expect(pools.worker.query(`SELECT * FROM eventhub.${table}`)).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('each identity function is executable only by the role that needs it', async () => {
    await expect(
      pools.app.query('SELECT * FROM eventhub.auth_issue_verification($1, 1, $2, 60)', [
        userId,
        randomBytes(32),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      pools.worker.query('SELECT * FROM eventhub.auth_register($1, $2)', ['x@example.test', HASH]),
    ).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      pools.worker.query('SELECT * FROM eventhub.auth_login_lookup($1)', ['x@example.test']),
    ).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('rejects non-Argon2id password hashes at the storage layer', async () => {
    await expect(
      pools.app.query('SELECT * FROM eventhub.auth_register($1, $2)', [
        `u-${randomUUID()}@example.test`,
        '$2b$10$bcrypthash',
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('runtime role may write identity.* audit/outbox rows without a tenant, but nothing else tenant-less', async () => {
    await withTransaction(pools.app, {}, (c) =>
      c.query(
        `INSERT INTO eventhub.audit_event (organization_id, actor_type, actor_id, action, target_type, correlation_id)
         VALUES (NULL, 'user', $1, 'identity.test_probe', 'user', 'c')`,
        [userId],
      ),
    );
    await expect(
      withTransaction(pools.app, {}, (c) =>
        c.query(
          `INSERT INTO eventhub.audit_event (organization_id, actor_type, actor_id, action, target_type, correlation_id)
           VALUES (NULL, 'user', $1, 'event.created', 'event', 'c')`,
          [userId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
