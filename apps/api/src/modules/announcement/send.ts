import { createDomainEvent } from '@eventhub/kernel';
import { enqueueEvent, writeAudit, type Queryable } from '@eventhub/db';

export const ANNOUNCEMENT_REQUESTED = 'announcement.requested';

export interface NewAnnouncement {
  organizationId: string;
  eventId: string;
  userId: string;
  correlationId: string;
  subject: string;
  body: string;
  audience: 'registered' | 'registered_and_waitlist';
  /** Why it was sent: an organizer's message, or the notice of a cancellation (ADR-0050). */
  purpose?: 'announcement' | 'cancellation';
}

/**
 * Records an announcement, captures its recipients, audits it and queues the emails (ADR-0037),
 * all in the caller's transaction. Callers check limits first. Returns the announcement ID and
 * how many people it goes to.
 */
export async function createAnnouncement(
  client: Queryable,
  a: NewAnnouncement,
): Promise<{ id: string; recipients: number }> {
  const statuses =
    a.audience === 'registered_and_waitlist' ? ['confirmed', 'waitlisted'] : ['confirmed'];
  const ins = await client.query<{ id: string }>(
    `INSERT INTO eventhub.announcement
       (organization_id, event_id, subject, body, audience, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      a.organizationId,
      a.eventId,
      a.subject,
      // Browsers submit text areas with CRLF line breaks; emails use LF.
      a.body.replace(/\r\n?/g, '\n'),
      a.audience,
      a.userId,
    ],
  );
  const id = ins.rows[0]!.id;
  const captured = await client.query(
    `INSERT INTO eventhub.announcement_recipient
       (organization_id, announcement_id, registration_id)
     SELECT organization_id, $3, id FROM eventhub.registration
      WHERE organization_id = $1 AND event_id = $2 AND status = ANY($4)`,
    [a.organizationId, a.eventId, id, statuses],
  );
  const recipients = captured.rowCount ?? 0;
  const actor = { type: 'user' as const, id: a.userId };
  // How many and to whom by group: never the people themselves.
  await writeAudit(client, {
    organizationId: a.organizationId,
    actor,
    action: 'event.announcement_sent',
    targetType: 'event',
    targetId: a.eventId,
    correlationId: a.correlationId,
    metadata: {
      announcementId: id,
      audience: a.audience,
      recipients,
      ...(a.purpose === 'cancellation' ? { purpose: 'cancellation' } : {}),
    },
  });
  await enqueueEvent(
    client,
    createDomainEvent({
      eventType: ANNOUNCEMENT_REQUESTED,
      schemaVersion: 1,
      actor,
      organizationId: a.organizationId,
      aggregateType: 'event',
      aggregateId: a.eventId,
      correlationId: a.correlationId,
      payload: { announcementId: id },
    }),
  );
  return { id, recipients };
}
