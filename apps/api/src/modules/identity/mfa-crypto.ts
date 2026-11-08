import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';

/**
 * Authenticator secrets are encrypted at rest with AES-256-GCM under a key only the API holds
 * (MFA_ENCRYPTION_KEY), bound to the user ID as associated data so a ciphertext cannot be moved
 * to another account. Layout: version (1) | IV (12) | tag (16) | ciphertext. ADR-0022.
 */
const VERSION = 1;

export interface SecretBox {
  seal(plaintext: Uint8Array, userId: string): Buffer;
  open(sealed: Uint8Array, userId: string): Buffer;
}

export function secretBox(key: Uint8Array): SecretBox {
  if (key.length !== 32) throw new Error('MFA encryption key must be 32 bytes');
  return {
    seal(plaintext, userId) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(userId));
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
    },
    open(sealed, userId) {
      const buf = Buffer.from(sealed);
      if (buf.length < 29 || buf[0] !== VERSION) throw new Error('Unsupported MFA secret format');
      const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(1, 13));
      decipher.setAAD(Buffer.from(userId));
      decipher.setAuthTag(buf.subarray(13, 29));
      return Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]);
    },
  };
}

/** Recovery codes: 10 per set, 10 characters each (≈50 bits), shown as xxxxx-xxxxx. */
export const RECOVERY_CODE_COUNT = 10;
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/l/i

export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const chars = Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

/** Normalised (case and separators ignored) and hashed; only hashes are stored. */
export function hashRecoveryCode(code: string): Buffer {
  const normalised = code.toLowerCase().replace(/[\s-]/g, '');
  return createHash('sha256').update(`eventhub-recovery:${normalised}`).digest();
}

export function isRecoveryCodeShape(code: string): boolean {
  return /^[a-z0-9]{5}-?[a-z0-9]{5}$/i.test(code.trim());
}
