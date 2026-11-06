import { createHash } from 'node:crypto';
import { AppError } from '@eventhub/kernel';
import type { Queryable } from './pool.ts';

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,255}$/;
const DEFAULT_TTL_HOURS = 24;

/** Stable JSON (sorted keys) so semantically equal payloads hash identically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function requestHash(scope: string, body: unknown): string {
  return createHash('sha256').update(scope).update('\n').update(canonicalJson(body)).digest('hex');
}

export interface IdempotencyClaim {
  actorId: string;
  scope: string;
  key: string;
  requestHash: string;
  ttlHours?: number;
}

export type IdempotencyOutcome =
  { kind: 'new' } | { kind: 'replay'; status: number; body: unknown };

/**
 * Claims an idempotency key inside the command's own transaction. Because the claim row is
 * written in the same transaction as the business change, audit and outbox records:
 *  - a concurrent duplicate blocks on the unique key until the first transaction finishes,
 *    then replays its committed response;
 *  - if the first transaction rolls back, the key is released and the retry executes normally;
 *  - the same key with a different payload is rejected (422).
 * Requires `app.user_id` to be set (RLS scopes keys to the actor).
 */
export async function claimIdempotencyKey(
  client: Queryable,
  claim: IdempotencyClaim,
): Promise<IdempotencyOutcome> {
  if (!IDEMPOTENCY_KEY_PATTERN.test(claim.key)) {
    throw new AppError('validation_failed', 'Idempotency-Key header is malformed.', {
      details: {
        fields: [{ path: 'Idempotency-Key', message: 'Use 8-255 characters [A-Za-z0-9_.:-].' }],
      },
    });
  }
  const ttl = claim.ttlHours ?? DEFAULT_TTL_HOURS;
  const inserted = await client.query(
    `INSERT INTO eventhub.idempotency_key (actor_id, scope, key, request_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 hour'))
     ON CONFLICT DO NOTHING`,
    [claim.actorId, claim.scope, claim.key, claim.requestHash, ttl],
  );
  if (inserted.rowCount === 1) return { kind: 'new' };

  const { rows } = await client.query<{
    request_hash: string;
    response_status: number | null;
    response_body: unknown;
    expired: boolean;
  }>(
    `SELECT request_hash, response_status, response_body, expires_at <= now() AS expired
       FROM eventhub.idempotency_key
      WHERE actor_id = $1 AND scope = $2 AND key = $3
      FOR UPDATE`,
    [claim.actorId, claim.scope, claim.key],
  );
  const existing = rows[0];
  if (!existing) {
    // Row vanished between statements (should not happen without DELETE grants); be safe.
    throw new AppError('conflict', 'Idempotency key state changed; retry the request.');
  }
  if (existing.expired) {
    await client.query(
      `UPDATE eventhub.idempotency_key
          SET request_hash = $4, response_status = NULL, response_body = NULL,
              created_at = now(), expires_at = now() + ($5::int * interval '1 hour')
        WHERE actor_id = $1 AND scope = $2 AND key = $3`,
      [claim.actorId, claim.scope, claim.key, claim.requestHash, ttl],
    );
    return { kind: 'new' };
  }
  if (existing.request_hash !== claim.requestHash) {
    throw new AppError(
      'idempotency_key_reused',
      'This Idempotency-Key was already used with a different request.',
    );
  }
  if (existing.response_status === null) {
    throw new AppError('conflict', 'A request with this Idempotency-Key is still being processed.');
  }
  return { kind: 'replay', status: existing.response_status, body: existing.response_body };
}

export async function recordIdempotentResponse(
  client: Queryable,
  claim: Pick<IdempotencyClaim, 'actorId' | 'scope' | 'key'>,
  status: number,
  body: unknown,
): Promise<void> {
  await client.query(
    `UPDATE eventhub.idempotency_key SET response_status = $4, response_body = $5
      WHERE actor_id = $1 AND scope = $2 AND key = $3`,
    [claim.actorId, claim.scope, claim.key, status, JSON.stringify(body)],
  );
}
