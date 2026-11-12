import { createDomainEvent } from '@eventhub/kernel';
import { enqueueEvent, type Queryable } from '@eventhub/db';

/** Outbox event behind the data download alert (ADR-0049). */
export const DATA_DOWNLOADED = 'organization.data_downloaded';

export interface DataDownload {
  organizationId: string;
  userId: string;
  correlationId: string;
  what: 'attendee_list' | 'audit_log';
  count: number;
  truncated: boolean;
  /** For an attendee list: the event, by ID and name. Never attendee details. */
  event?: { id: string; name: string };
}

/**
 * Written in the export's own transaction, next to its audit entry, so an alert goes out exactly
 * when the export happened (the worker then emails each recipient once per event ID).
 */
export async function enqueueDataDownload(client: Queryable, d: DataDownload): Promise<void> {
  await enqueueEvent(
    client,
    createDomainEvent({
      eventType: DATA_DOWNLOADED,
      schemaVersion: 1,
      actor: { type: 'user', id: d.userId },
      organizationId: d.organizationId,
      aggregateType: d.event ? 'event' : 'organization',
      aggregateId: d.event?.id ?? d.organizationId,
      correlationId: d.correlationId,
      payload: {
        organizationId: d.organizationId,
        what: d.what,
        count: d.count,
        truncated: d.truncated,
        eventId: d.event?.id ?? null,
        eventName: d.event?.name ?? null,
      },
    }),
  );
}
