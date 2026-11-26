import { createHash } from 'node:crypto';
import type { BreachCheck, BreachedPasswordChecker } from '@eventhub/kernel';

export interface PwnedPasswordsOptions {
  /** The range API's base address; https://api.pwnedpasswords.com unless testing. */
  baseUrl?: string;
  /** How long to wait before treating the service as unavailable. */
  timeoutMs?: number;
  /** Injected for tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  /** Told why a check could not be made (never the password or its hash). */
  onUnavailable?: (reason: 'timeout' | 'error' | 'status') => void;
}

export const PWNED_PASSWORDS_BASE_URL = 'https://api.pwnedpasswords.com'; // pragma: allowlist secret (a public address, not a secret)
export const PWNED_PASSWORDS_TIMEOUT_MS = 3000;

/**
 * Pwned Passwords range API (ADR-0078), by k-anonymity: the password is hashed with SHA-1 here,
 * only the first 5 hex characters of the hash are sent, and the returned suffixes are compared
 * locally. Responses are padded (`Add-Padding: true`), so their size reveals nothing; padding
 * entries carry a count of 0 and are never a match. No key is needed for this API.
 */
export class PwnedPasswordsChecker implements BreachedPasswordChecker {
  readonly name = 'pwned_passwords';
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #onUnavailable: NonNullable<PwnedPasswordsOptions['onUnavailable']>;

  constructor(options: PwnedPasswordsOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? PWNED_PASSWORDS_BASE_URL).replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? PWNED_PASSWORDS_TIMEOUT_MS;
    this.#fetch = options.fetch ?? fetch;
    this.#onUnavailable = options.onUnavailable ?? (() => undefined);
  }

  async check(password: string): Promise<BreachCheck> {
    const hash = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    let body: string;
    try {
      const res = await this.#fetch(`${this.#baseUrl}/range/${prefix}`, {
        headers: { 'Add-Padding': 'true' },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!res.ok) {
        this.#onUnavailable('status');
        return 'unknown';
      }
      body = await res.text();
    } catch (error) {
      this.#onUnavailable(
        error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'error',
      );
      return 'unknown';
    }
    for (const line of body.split('\n')) {
      const [candidate, count] = line.trim().split(':');
      if (candidate?.toUpperCase() === suffix && Number(count) > 0) return 'breached';
    }
    return 'clear';
  }
}
