import { createHash } from 'node:crypto';
import type { Pool } from '@eventhub/db';

/**
 * Identity boundary (ADR-0005, ADR-0007). Sessions are issued by the password login flow in
 * `routes.ts`; enterprise SSO/SCIM will add further issuers behind the same principal shape.
 */
export interface Principal {
  type: 'user';
  userId: string;
  sessionId: string;
  emailVerified: boolean;
}

export interface SessionAuthenticator {
  authenticate(rawToken: string): Promise<Principal | null>;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;

/** Default idle timeout (ADR-0018); deployments set SESSION_IDLE_MINUTES. */
export const DEFAULT_SESSION_IDLE_SECONDS = 3600;

export function parseBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer (\S+)$/.exec(header);
  const token = match?.[1];
  return token && TOKEN_RE.test(token) ? token : null;
}

/**
 * Verifies opaque, high-entropy bearer tokens against SHA-256 hashes stored in
 * `eventhub.auth_session`, via a SECURITY DEFINER function so the runtime role has no direct
 * access to the session table.
 */
export class DatabaseSessionAuthenticator implements SessionAuthenticator {
  readonly #pool: Pool;
  readonly #idleSeconds: number;
  constructor(pool: Pool, options: { idleSeconds?: number } = {}) {
    this.#pool = pool;
    this.#idleSeconds = options.idleSeconds ?? DEFAULT_SESSION_IDLE_SECONDS;
  }

  async authenticate(rawToken: string): Promise<Principal | null> {
    if (!TOKEN_RE.test(rawToken)) return null;
    const hash = createHash('sha256').update(rawToken).digest();
    const { rows } = await this.#pool.query<{
      out_session_id: string;
      out_user_id: string;
      out_email_verified: boolean;
    }>(
      // Records "last active" at most every 5 minutes (ADR-0017) and ends sessions idle for
      // longer than the timeout (ADR-0018).
      'SELECT out_session_id, out_user_id, out_email_verified FROM eventhub.auth_resolve_and_touch_session($1, $2)',
      [hash, this.#idleSeconds],
    );
    const row = rows[0];
    return row
      ? {
          type: 'user',
          userId: row.out_user_id,
          sessionId: row.out_session_id,
          emailVerified: row.out_email_verified,
        }
      : null;
  }
}
