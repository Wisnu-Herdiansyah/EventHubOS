import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureOrganization, createFixtureUser, createTestPools } from './testing/index.ts';
import { withTransaction } from './transaction.ts';

describe('invitation storage isolation (ORG-02)', () => {
  const pools = createTestPools();
  let ownerA: string;
  let ownerB: string;
  let orgA: string;
  let orgB: string;
  let invB: string;

  const insertInvitation = async (
    orgId: string,
    invitedBy: string,
    email = `i-${randomUUID()}@example.test`,
  ) =>
    (
      await withTransaction(pools.app, { userId: invitedBy, organizationId: orgId }, (c) =>
        c.query<{ id: string }>(
          `INSERT INTO eventhub.invitation (organization_id, email, role, invited_by, expires_at)
           VALUES ($1, $2, 'viewer', $3, now() + interval '1 day') RETURNING id`,
          [orgId, email, invitedBy],
        ),
      )
    ).rows[0]!.id;

  beforeAll(async () => {
    ownerA = (await createFixtureUser(pools.migrator)).id;
    ownerB = (await createFixtureUser(pools.migrator)).id;
    orgA = await createFixtureOrganization(pools.migrator, ownerA);
    orgB = await createFixtureOrganization(pools.migrator, ownerB);
    invB = await insertInvitation(orgB, ownerB);
  });
  afterAll(() => pools.end());

  const asA = <T>(fn: Parameters<typeof withTransaction<T>>[2]) =>
    withTransaction(pools.app, { userId: ownerA, organizationId: orgA }, fn);

  it('is covered by the forced-RLS catalog guarantee (has organization_id)', async () => {
    const { rows } = await pools.migrator.query(
      `SELECT relrowsecurity AND relforcerowsecurity AS ok FROM pg_class WHERE oid = 'eventhub.invitation'::regclass`,
    );
    expect(rows[0]).toEqual({ ok: true });
  });

  it('cannot read, revoke, or insert invitations in another tenant', async () => {
    expect(
      (await asA((c) => c.query('SELECT id FROM eventhub.invitation WHERE id = $1', [invB]))).rows,
    ).toEqual([]);
    const upd = await asA((c) =>
      c.query(`UPDATE eventhub.invitation SET status = 'revoked' WHERE id = $1`, [invB]),
    );
    expect(upd.rowCount).toBe(0);
    await expect(
      asA((c) =>
        c.query(
          `INSERT INTO eventhub.invitation (organization_id, email, role, invited_by, expires_at)
           VALUES ($1, 'x@example.test', 'owner', $2, now() + interval '1 day')`,
          [orgB, ownerA],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('runtime role cannot read or write token hashes', async () => {
    await expect(
      asA((c) => c.query('SELECT token_hash FROM eventhub.invitation')),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asA((c) => c.query('UPDATE eventhub.invitation SET token_hash = NULL')),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('runtime role cannot change role, email, or tenant of an invitation', async () => {
    for (const sql of [
      `UPDATE eventhub.invitation SET role = 'owner'`,
      `UPDATE eventhub.invitation SET email = 'other@example.test'`,
      `UPDATE eventhub.invitation SET organization_id = '${orgB}'`,
    ]) {
      await expect(asA((c) => c.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('member helpers refuse to answer for any tenant but the current one', async () => {
    const members = await asA((c) =>
      c.query('SELECT * FROM eventhub.organization_members($1)', [orgB]),
    );
    expect(members.rows).toEqual([]);
    const ownerBEmail = (
      await pools.migrator.query<{ email: string }>(
        'SELECT email FROM eventhub.app_user WHERE id = $1',
        [ownerB],
      )
    ).rows[0]!.email;
    const probe = await asA((c) =>
      c.query<{ r: boolean }>('SELECT eventhub.organization_has_member_email($1, $2) AS r', [
        orgB,
        ownerBEmail,
      ]),
    );
    expect(probe.rows[0]!.r).toBe(false);
  });

  it('worker issues a token only for a pending invitation of the stated organization', async () => {
    const inv = await insertInvitation(orgA, ownerA);
    const wrongOrg = await pools.worker.query(
      'SELECT * FROM eventhub.invitation_issue_token($1, $2, $3)',
      [inv, orgB, randomBytes(32)],
    );
    expect(wrongOrg.rows).toEqual([]);
    const token = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(token).digest();
    const ok = await pools.worker.query(
      'SELECT out_email FROM eventhub.invitation_issue_token($1, $2, $3)',
      [inv, orgA, hash],
    );
    expect(ok.rows).toHaveLength(1);
    const resolved = await pools.app.query(
      'SELECT out_organization_id FROM eventhub.invitation_resolve($1)',
      [hash],
    );
    expect(resolved.rows[0]).toEqual({ out_organization_id: orgA });

    await asA((c) =>
      c.query(`UPDATE eventhub.invitation SET status = 'revoked' WHERE id = $1`, [inv]),
    );
    expect(
      (await pools.app.query('SELECT * FROM eventhub.invitation_resolve($1)', [hash])).rows,
    ).toEqual([]);
    expect(
      (
        await pools.worker.query('SELECT * FROM eventhub.invitation_issue_token($1, $2, $3)', [
          inv,
          orgA,
          randomBytes(32),
        ])
      ).rows,
    ).toEqual([]);
  });

  it('each function is executable only by the role that needs it, and the worker cannot read invitations', async () => {
    await expect(
      pools.app.query('SELECT * FROM eventhub.invitation_issue_token($1, $2, $3)', [
        invB,
        orgB,
        randomBytes(32),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      pools.worker.query('SELECT * FROM eventhub.invitation_resolve($1)', [randomBytes(32)]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(pools.worker.query('SELECT * FROM eventhub.invitation')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('allows only one pending invitation per address per organization', async () => {
    const email = `dup-${randomUUID()}@example.test`;
    await insertInvitation(orgA, ownerA, email);
    await expect(insertInvitation(orgA, ownerA, email)).rejects.toMatchObject({ code: '23505' });
    await expect(insertInvitation(orgB, ownerB, email)).resolves.toBeTruthy(); // other tenant unaffected
  });
});
