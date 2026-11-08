import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RECOVERY_CODE_COUNT,
  hashRecoveryCode,
  isRecoveryCodeShape,
  newRecoveryCodes,
  secretBox,
} from './modules/identity/mfa-crypto.ts';
import {
  base32Decode,
  base32Encode,
  hotp,
  matchTotp,
  otpauthUri,
  totp,
  totpStep,
} from './modules/identity/totp.ts';

// RFC 6238 Appendix B / RFC 4226 Appendix D shared secret ("12345678901234567890").
const RFC_SECRET = Buffer.from('12345678901234567890');

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC 4226 HOTP test vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676'];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });

  it('matches the RFC 6238 SHA-1 vectors (8 digits)', () => {
    expect(totp(RFC_SECRET, 59_000, 8)).toBe('94287082');
    expect(totp(RFC_SECRET, 1_111_111_109_000, 8)).toBe('07081804');
    expect(totp(RFC_SECRET, 1_234_567_890_000, 8)).toBe('89005924');
    expect(totp(RFC_SECRET, 20_000_000_000_000, 8)).toBe('65353130');
  });

  it('accepts one step of drift either way, nothing more', () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    for (const delta of [-1, 0, 1]) {
      expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + delta), now)).toBe(step + delta);
    }
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), now)).toBeNull();
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + 2), now)).toBeNull();
    for (const bad of ['', '12345', '1234567', 'abcdef', ' 12345']) {
      expect(matchTotp(RFC_SECRET, bad, now)).toBeNull();
    }
  });

  it('round-trips base32 and builds an authenticator URI', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw 6ytb oi')).toEqual(Buffer.from('foobar'));
    expect(() => base32Decode('1!')).toThrow();
    const uri = otpauthUri(RFC_SECRET, 'ade@example.test');
    expect(uri).toMatch(/^otpauth:\/\/totp\/EventHub%20OS%3Aade%40example\.test\?/);
    expect(new URL(uri).searchParams.get('secret')).toBe(base32Encode(RFC_SECRET));
  });
});

describe('MFA secret box', () => {
  const key = Buffer.alloc(32, 7);
  it('encrypts per user and refuses tampering or another account', () => {
    const box = secretBox(key);
    const user = randomUUID();
    const sealed = box.seal(RFC_SECRET, user);
    expect(sealed.includes(RFC_SECRET)).toBe(false);
    expect(box.open(sealed, user)).toEqual(RFC_SECRET);
    expect(() => box.open(sealed, randomUUID())).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => box.open(tampered, user)).toThrow();
    expect(() => secretBox(Buffer.alloc(32, 8)).open(sealed, user)).toThrow();
    expect(() => secretBox(Buffer.alloc(16))).toThrow();
  });
});

describe('recovery codes', () => {
  it('are unique, readable and hashed independent of case and hyphens', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const c of codes) {
      expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
      expect(isRecoveryCodeShape(c)).toBe(true);
    }
    expect(hashRecoveryCode('ABCDE-fghjk')).toEqual(hashRecoveryCode('abcdefghjk'));
    expect(hashRecoveryCode('abcde-fghjk')).not.toEqual(hashRecoveryCode('abcde-fghjm'));
    expect(isRecoveryCodeShape('123456')).toBe(false);
  });
});
