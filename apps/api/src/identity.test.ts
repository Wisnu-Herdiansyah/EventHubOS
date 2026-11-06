import { describe, expect, it } from 'vitest';
import { ARGON2ID_BASELINE, Argon2idPasswordHasher } from './adapters/argon2id-password-hasher.ts';
import { emailSchema, passwordSchema } from './modules/identity/password.ts';

describe('Argon2idPasswordHasher', () => {
  const hasher = new Argon2idPasswordHasher();

  it('produces Argon2id PHC strings with the baseline parameters and unique salts', async () => {
    const a = await hasher.hash('correct horse battery staple');
    const b = await hasher.hash('correct horse battery staple');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects others', async () => {
    const h = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify(h, 'correct horse battery staple')).toBe(true);
    expect(await hasher.verify(h, 'correct horse battery stapl')).toBe(false);
  });

  it('never accepts non-Argon2id or malformed hashes', async () => {
    const argon2i = (await hasher.hash('pw-for-test-123')).replace('$argon2id$', '$argon2i$');
    expect(await hasher.verify(argon2i, 'pw-for-test-123')).toBe(false);
    expect(await hasher.verify('$argon2id$garbage', 'x')).toBe(false);
    expect(await hasher.verify('plaintext', 'plaintext')).toBe(false);
  });

  it('flags hashes made with weaker parameters for upgrade', async () => {
    const weak = new Argon2idPasswordHasher({
      ...ARGON2ID_BASELINE,
      memoryCost: 8192,
      timeCost: 1,
    });
    const h = await weak.hash('correct horse battery staple');
    expect(hasher.needsRehash(h)).toBe(true);
    expect(hasher.needsRehash(await hasher.hash('correct horse battery staple'))).toBe(false);
    expect(hasher.needsRehash('not-a-hash')).toBe(true);
  });
});

describe('password policy (NIST SP 800-63B style)', () => {
  it('enforces length only, counting Unicode code points', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('a'.repeat(12)).success).toBe(true);
    expect(passwordSchema.safeParse('🔐'.repeat(12)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(129)).success).toBe(false);
    expect(passwordSchema.safeParse(' '.repeat(20)).success).toBe(false);
  });

  it('normalises to NFKC so equivalent input hashes identically', () => {
    expect(passwordSchema.parse('ｆｕｌｌｗｉｄｔｈ-pass')).toBe('fullwidth-pass');
  });
});

describe('email normalisation', () => {
  it('trims and lowercases', () => {
    expect(emailSchema.parse('  Alice@Example.COM ')).toBe('alice@example.com');
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
  });
});
