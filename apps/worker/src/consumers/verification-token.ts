import { createHmac } from 'node:crypto';

/**
 * Deterministic verification token for a domain event (ADR-0008).
 *
 * The token must be identical on every delivery attempt of the same event: if the provider
 * accepted an email but our transaction rolled back (e.g. response timeout), the retry re-sends
 * a byte-identical message under the same idempotency key, which the provider deduplicates,
 * and the retry's commit makes the already-delivered link valid. A random token would make the
 * retry's payload differ, which providers reject for a reused idempotency key.
 *
 * Tokens are unguessable without the secret, single-use, and stored only as SHA-256 hashes.
 */
export const MIN_TOKEN_SECRET_LENGTH = 32;

/** Token purposes are domain-separated: a token minted for one flow is useless in another. */
export type EmailTokenPurpose = 'verify-email' | 'invitation';

export function deriveEmailToken(
  secret: string,
  purpose: EmailTokenPurpose,
  eventId: string,
): string {
  if (secret.length < MIN_TOKEN_SECRET_LENGTH) {
    throw new Error(`token secret must be at least ${MIN_TOKEN_SECRET_LENGTH} characters`);
  }
  return createHmac('sha256', secret)
    .update(`eventhub:${purpose}:v1:${eventId}`)
    .digest('base64url');
}

export function deriveVerificationToken(secret: string, eventId: string): string {
  return deriveEmailToken(secret, 'verify-email', eventId);
}
