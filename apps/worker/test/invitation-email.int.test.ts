import { createHash, randomUUID } from 'node:crypto';
import { createDomainEvent, InMemoryEmailSender, type DomainEvent } from '@eventhub/kernel';
import { withTransaction } from '@eventhub/db';
import {
  createFixtureOrganization,
  createFixtureUser,
  createTestPools,
} from '@eventhub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MEMBERSHIP_INVITED,
  sendInvitationEmailConsumer,
} from '../src/consumers/send-invitation-email.ts';
import { OutboxDispatchPublisher } from '../src/outbox-dispatch-publisher.ts';

const SECRET = 'test-token-secret-0123456789abcdef'; // pragma: allowlist secret

describe('send-invitation-email consumer', () => {
  const pools = createTestPools();
  let ownerId: string;
  let orgId: string;
  let otherOrg: string;
  beforeAll(async () => {
    ownerId = (await createFixtureUser(pools.migrator)).id;
    orgId = await createFixtureOrganization(
      pools.migrator,
      ownerId,
      'Systematic <Elegance>\nEvents',
    );
    otherOrg = await createFixtureOrganization(pools.migrator, ownerId);
  });
  afterAll(() => pools.end());

  async function invitation(role = 'event_manager'): Promise<{ id: string; email: string }> {
    const email = `inv-${randomUUID()}@example.test`;
    const { rows } = await withTransaction(
      pools.app,
      { userId: ownerId, organizationId: orgId },
      (c) =>
        c.query<{ id: string }>(
          `INSERT INTO eventhub.invitation (organization_id, email, role, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '7 days') RETURNING id`,
          [orgId, email, role, ownerId],
        ),
    );
    return { id: rows[0]!.id, email };
  }

  const event = (
    invitationId: string,
    organizationId = orgId,
    envelopeOrg = organizationId,
  ): DomainEvent =>
    createDomainEvent({
      eventType: MEMBERSHIP_INVITED,
      schemaVersion: 1,
      actor: { type: 'user', id: ownerId },
      organizationId: envelopeOrg,
      aggregateType: 'invitation',
      aggregateId: invitationId,
      correlationId: randomUUID(),
      payload: { invitationId, organizationId },
    });

  const setup = () => {
    const sender = new InMemoryEmailSender();
    const consumer = sendInvitationEmailConsumer(sender, {
      appBaseUrl: 'https://app.example.test',
      tokenSecret: SECRET,
    });
    return { sender, publisher: new OutboxDispatchPublisher(pools.worker, [consumer]) };
  };

  it('emails the invitee with org name, role label, and a single-use fragment link', async () => {
    const inv = await invitation();
    const { sender, publisher } = setup();
    await publisher.publish(event(inv.id));
    expect(sender.sent).toHaveLength(1);
    const m = sender.sent[0]!;
    expect(m.to).toBe(inv.email);
    expect(m.subject).toBe("You're invited to join Systematic Elegance Events on EventHub OS"); // newline/<> stripped
    expect(m.text).toContain('as Event manager');
    const token = /#token=([A-Za-z0-9_-]{43})$/m.exec(m.text)![1]!;
    const resolved = await pools.app.query(
      'SELECT out_invitation_id FROM eventhub.invitation_resolve($1)',
      [createHash('sha256').update(token).digest()],
    );
    expect(resolved.rows[0]).toEqual({ out_invitation_id: inv.id });
  });

  it('sends once per event even on re-delivery', async () => {
    const inv = await invitation();
    const { sender, publisher } = setup();
    const e = event(inv.id);
    await publisher.publish(e);
    await publisher.publish(e);
    expect(sender.sent).toHaveLength(1);
  });

  it('sends nothing for a revoked invitation or a mismatched organization', async () => {
    const { sender, publisher } = setup();
    const revoked = await invitation();
    await withTransaction(pools.app, { userId: ownerId, organizationId: orgId }, (c) =>
      c.query(`UPDATE eventhub.invitation SET status = 'revoked' WHERE id = $1`, [revoked.id]),
    );
    await publisher.publish(event(revoked.id));

    const inv = await invitation();
    await publisher.publish(event(inv.id, otherOrg)); // payload claims another tenant
    await publisher.publish(event(inv.id, orgId, otherOrg)); // envelope disagrees with payload
    expect(sender.sent).toHaveLength(0);
  });
});
