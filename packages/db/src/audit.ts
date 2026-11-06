import type { Actor } from '@eventhub/kernel';
import type { Queryable } from './pool.ts';

export interface AuditEntry {
  organizationId: string;
  actor: Actor;
  action: string;
  targetType: string;
  targetId: string | null;
  correlationId: string;
  /** Non-sensitive context only. Never place PII, secrets, or raw request bodies here. */
  metadata?: Record<string, unknown>;
}

/** Writes an append-only audit record inside the caller's transaction. */
export async function writeAudit(client: Queryable, entry: AuditEntry): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO eventhub.audit_event
       (organization_id, actor_type, actor_id, action, target_type, target_id, correlation_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      entry.organizationId,
      entry.actor.type,
      entry.actor.id,
      entry.action,
      entry.targetType,
      entry.targetId,
      entry.correlationId,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
  return rows[0]!.id;
}
