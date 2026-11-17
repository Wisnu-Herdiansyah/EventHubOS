import { createHash } from 'node:crypto';

/**
 * One page render gives both bulk dialogs the same key. Tie it to what is sent, so retrying the
 * same batch replays the stored answer while a different selection or decision (after an error)
 * is a new command rather than a refused reuse of the key.
 */
export function batchKey(base: string, decision: string, ids: string[]): string {
  const digest = createHash('sha256')
    .update(`${decision}:${[...ids].sort().join(',')}`)
    .digest('base64url')
    .slice(0, 22);
  return `${base}-${digest}`;
}
