import { createHash } from 'node:crypto';
import type { Pool } from '@eventhub/db';

/**
 * Identity boundary. The identity vendor/library (password, MFA, SSO/SCIM) is an open
 * decision (docs/architecture/open-decisions.md). The API depends only on this port.
 * Session *issuance* belongs to the future identity adapter; this slice verifies sessions.
 */
export interface Principal {
  type: 'user';
  userId: string;
  emailVerified: boolean;
}

export interface SessionAuthenticator {
  authenticate(rawToken: string): Promise<Principal | null>;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;

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
  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async authenticate(rawToken: string): Promise<Principal | null> {
    if (!TOKEN_RE.test(rawToken)) return null;
    const hash = createHash('sha256').update(rawToken).digest();
    const { rows } = await this.#pool.query<{ user_id: string; email_verified: boolean }>(
      'SELECT user_id, email_verified FROM eventhub.resolve_session($1)',
      [hash],
    );
    const row = rows[0];
    return row ? { type: 'user', userId: row.user_id, emailVerified: row.email_verified } : null;
  }
}
