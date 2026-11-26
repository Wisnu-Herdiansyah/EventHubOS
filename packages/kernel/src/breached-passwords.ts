/**
 * Breached-password screening (ADR-0078). New passwords at sign-up, reset and change are checked
 * against passwords known from data breaches. The production adapter asks Pwned Passwords with
 * a 5-character hash prefix only (k-anonymity); the password itself never leaves the API.
 *
 * `unknown` means the source could not be asked (timeout, error). Callers accept the password on
 * length alone then, so an outside outage never stops sign-up, and the gap is logged.
 */
export type BreachCheck = 'breached' | 'clear' | 'unknown';

export interface BreachedPasswordChecker {
  readonly name: string;
  /** Never throws: an unavailable source answers `unknown`. Never logs the password. */
  check(password: string): Promise<BreachCheck>;
}

/**
 * Passwords the in-memory checker treats as breached, for local runs and tests. They are
 * well-known examples from public breach lists, long enough to pass the length rule.
 */
export const EXAMPLE_BREACHED_PASSWORDS: readonly string[] = [
  'password1234',
  'qwertyuiop123',
  '123456789012',
];

/** In-memory checker: a local/test fake only. Configuration refuses it in staging/production. */
export class InMemoryBreachedPasswordChecker implements BreachedPasswordChecker {
  readonly name = 'in_memory';
  readonly #breached: Set<string>;
  #unavailable = false;

  constructor(breached: readonly string[] = EXAMPLE_BREACHED_PASSWORDS) {
    this.#breached = new Set(breached);
  }

  /** Test helper: answer `unknown`, as if the source were down. */
  setUnavailable(unavailable: boolean): void {
    this.#unavailable = unavailable;
  }

  check(password: string): Promise<BreachCheck> {
    if (this.#unavailable) return Promise.resolve('unknown');
    return Promise.resolve(this.#breached.has(password) ? 'breached' : 'clear');
  }
}
