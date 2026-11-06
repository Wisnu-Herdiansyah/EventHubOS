import { describe, expect, it } from 'vitest';
import { deriveEmailToken, deriveVerificationToken } from './verification-token.ts';

const SECRET = 'test-token-secret-0123456789abcdef'; // pragma: allowlist secret

describe('deriveVerificationToken', () => {
  it('is stable per event so retries produce identical emails', () => {
    const id = '3f1c1f0e-2a7b-4c3d-8e9f-0a1b2c3d4e5f';
    expect(deriveVerificationToken(SECRET, id)).toBe(deriveVerificationToken(SECRET, id));
  });

  it('is 32 bytes base64url and differs per event and per secret', () => {
    const a = deriveVerificationToken(SECRET, 'event-a');
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deriveVerificationToken(SECRET, 'event-b')).not.toBe(a);
    expect(deriveVerificationToken(`${SECRET}-rotated`, 'event-a')).not.toBe(a);
  });

  it('refuses short secrets', () => {
    expect(() => deriveVerificationToken('short', 'e')).toThrow(/at least 32/);
  });
  it('separates purposes: the same event yields unrelated tokens per flow', () => {
    expect(deriveEmailToken(SECRET, 'invitation', 'e')).not.toBe(
      deriveEmailToken(SECRET, 'verify-email', 'e'),
    );
    expect(deriveEmailToken(SECRET, 'password-reset', 'e')).not.toBe(
      deriveEmailToken(SECRET, 'verify-email', 'e'),
    );
    expect(deriveVerificationToken(SECRET, 'e')).toBe(
      deriveEmailToken(SECRET, 'verify-email', 'e'),
    );
  });
});
