import { randomUUID } from 'node:crypto';
import type { Actor } from '@eventhub/kernel';
import type { Queryable } from './pool.ts';

export interface AuditEntry {
  /** Null only for platform-scoped `identity.*` actions (enforced by RLS policy). */
  organizationId: string | null;
  actor: Actor;
  action: string;
  targetType: string;
  targetId: string | null;
  correlationId: string;
  /** Non-sensitive context only. Never place PII, secrets, or raw request bodies here. */
  metadata?: Record<string, unknown>;
}

/**
 * Writes an append-only audit record inside the caller's transaction. The ID is generated here
 * rather than read back with RETURNING, because writers are not necessarily allowed to read
 * audit rows (platform-scoped identity events are write-only for the runtime role).
 */
export async function writeAudit(client: Queryable, entry: AuditEntry): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO eventhub.audit_event
       (id, organization_id, actor_type, actor_id, action, target_type, target_id, correlation_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
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
  return id;
}
