import {
  claimIdempotencyKey,
  recordIdempotentResponse,
  requestHash,
  type Queryable,
} from '@eventhub/db';
import type { RouteResult } from './route.ts';

/**
 * Runs a side-effecting command under an idempotency key, inside the caller's transaction.
 * Only successful results are stored; a failed command rolls back and releases the key.
 */
export async function runIdempotentCommand(
  client: Queryable,
  input: { actorId: string; scope: string; key: string; body: unknown },
  execute: () => Promise<RouteResult>,
): Promise<RouteResult> {
  const claim = {
    actorId: input.actorId,
    scope: input.scope,
    key: input.key,
    requestHash: requestHash(input.scope, input.body),
  };
  const outcome = await claimIdempotencyKey(client, claim);
  if (outcome.kind === 'replay')
    return { status: outcome.status, body: outcome.body, replayed: true };
  const result = await execute();
  await recordIdempotentResponse(client, claim, result.status, result.body);
  return result;
}
