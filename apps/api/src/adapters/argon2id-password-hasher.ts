import argon2 from 'argon2';
import type { PasswordHasher } from '../modules/identity/password.ts';

/**
 * Argon2id via node-argon2 (binds the Password Hashing Competition reference implementation).
 * Baseline parameters follow the OWASP Password Storage Cheat Sheet minimum for Argon2id
 * (m=19 MiB, t=2, p=1). Raising them later is safe: `needsRehash` upgrades hashes on next login.
 */
export interface Argon2idParams {
  memoryCost: number; // KiB
  timeCost: number;
  parallelism: number;
}

export const ARGON2ID_BASELINE: Readonly<Argon2idParams> = Object.freeze({
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

export class Argon2idPasswordHasher implements PasswordHasher {
  readonly #params: Argon2idParams;

  constructor(params: Argon2idParams = ARGON2ID_BASELINE) {
    this.#params = { ...params };
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id, ...this.#params });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    // Only Argon2id hashes are acceptable; anything else is treated as a failed verification.
    if (!hash.startsWith('$argon2id$')) return false;
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    if (!hash.startsWith('$argon2id$')) return true;
    try {
      return argon2.needsRehash(hash, this.#params);
    } catch {
      return true;
    }
  }
}
