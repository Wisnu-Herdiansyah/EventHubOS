import { z } from 'zod';

/**
 * Password hashing port (ADR-0007). Domain code depends on this interface; the Argon2id
 * implementation lives in `src/adapters/argon2id-password-hasher.ts`.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /** Constant-shape verification; returns false (never throws) for malformed hashes. */
  verify(hash: string, password: string): Promise<boolean>;
  /** True when a stored hash uses weaker or different parameters than the current policy. */
  needsRehash(hash: string): boolean;
}

/**
 * Password policy per NIST SP 800-63B: length-based, no composition rules, all Unicode allowed,
 * NFKC-normalised before hashing so equivalent input always verifies. Max length bounds hashing
 * cost. A breached-password screen is a follow-up (needs an approved data source).
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const passwordSchema = z
  .string()
  .transform((v) => v.normalize('NFKC'))
  .refine(
    (v) => [...v].length >= PASSWORD_MIN_LENGTH,
    `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  )
  .refine(
    (v) => [...v].length <= PASSWORD_MAX_LENGTH,
    `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
  )
  .refine((v) => v.trim().length > 0, 'Password cannot be only whitespace.');

/** Login accepts any length up to the max so policy changes never lock existing users out. */
export const loginPasswordSchema = z
  .string()
  .min(1)
  .max(PASSWORD_MAX_LENGTH * 4)
  .transform((v) => v.normalize('NFKC'));

export const emailSchema = z
  .string()
  .trim()
  .max(254)
  .transform((v) => v.toLowerCase())
  .pipe(z.email('Enter a valid email address.'));
