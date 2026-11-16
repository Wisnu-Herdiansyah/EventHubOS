import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  VISITOR_ADDRESS_MAX_AGE_SECONDS,
  signVisitorAddress,
  verifyVisitorAddress,
} from './visitor-address.ts';

const KEY = `marker-${'k'.repeat(32)}`;
const OTHER = `marker-${'o'.repeat(32)}`;
const NOW = new Date('2026-11-16T10:00:00Z');
const later = (s: number) => new Date(NOW.getTime() + s * 1000);

describe('visitor address signing (ADR-0058)', () => {
  it('round-trips IPv4 and IPv6 addresses', () => {
    for (const ip of ['203.0.113.9', '2001:db8::1']) {
      const header = signVisitorAddress(KEY, ip, NOW)!;
      expect(verifyVisitorAddress(KEY, header, NOW)).toBe(ip);
    }
    // IPv6 is signed in one spelling, whatever the case it arrived in.
    expect(verifyVisitorAddress(KEY, signVisitorAddress(KEY, '2001:DB8::1', NOW), NOW)).toBe(
      '2001:db8::1',
    );
  });

  it('signs nothing that is not an IP address', () => {
    expect(signVisitorAddress(KEY, 'not-an-ip', NOW)).toBeUndefined();
    expect(signVisitorAddress(KEY, '203.0.113.9, 10.0.0.1', NOW)).toBeUndefined();
    expect(signVisitorAddress(KEY, '', NOW)).toBeUndefined();
  });

  it('refuses another key, and an address or time changed after signing', () => {
    const header = signVisitorAddress(KEY, '203.0.113.9', NOW)!;
    expect(verifyVisitorAddress(OTHER, header, NOW)).toBeNull();
    expect(
      verifyVisitorAddress(KEY, header.replace('203.0.113.9', '203.0.113.10'), NOW),
    ).toBeNull();
    const [v, ts, ip, sig] = header.split(',') as [string, string, string, string];
    expect(verifyVisitorAddress(KEY, [v, Number(ts) + 1, ip, sig].join(','), NOW)).toBeNull();
    expect(verifyVisitorAddress(KEY, ['v2', ts, ip, sig].join(','), NOW)).toBeNull();
    expect(
      verifyVisitorAddress(KEY, [v, ts, ip, `${sig.slice(0, -1)}_`].join(','), NOW),
    ).toBeNull();
    expect(verifyVisitorAddress(KEY, [v, ts, ip, sig.slice(0, -1)].join(','), NOW)).toBeNull();
  });

  it('accepts a signature only while it is recent, in either clock direction', () => {
    const header = signVisitorAddress(KEY, '203.0.113.9', NOW)!;
    expect(verifyVisitorAddress(KEY, header, later(VISITOR_ADDRESS_MAX_AGE_SECONDS))).toBe(
      '203.0.113.9',
    );
    expect(
      verifyVisitorAddress(KEY, header, later(VISITOR_ADDRESS_MAX_AGE_SECONDS + 1)),
    ).toBeNull();
    expect(verifyVisitorAddress(KEY, header, later(-VISITOR_ADDRESS_MAX_AGE_SECONDS))).toBe(
      '203.0.113.9',
    );
    expect(
      verifyVisitorAddress(KEY, header, later(-VISITOR_ADDRESS_MAX_AGE_SECONDS - 1)),
    ).toBeNull();
  });

  it('refuses anything that is not one well-formed header', () => {
    const header = signVisitorAddress(KEY, '203.0.113.9', NOW)!;
    for (const bad of [undefined, null, 42, '', 'v1', [header], [header, header], `${header},x`]) {
      expect(verifyVisitorAddress(KEY, bad, NOW)).toBeNull();
    }
    expect(verifyVisitorAddress(KEY, header.padEnd(161, ' '), NOW)).toBeNull();
    const [v, , ip, sig] = header.split(',') as [string, string, string, string];
    expect(verifyVisitorAddress(KEY, [v, '1e3', ip, sig].join(','), NOW)).toBeNull();
  });

  it('accepts one spelling of the time only', () => {
    const [v, ts, ip, sig] = signVisitorAddress(KEY, '203.0.113.9', NOW)!.split(',') as [
      string,
      string,
      string,
      string,
    ];
    for (const spelling of [`${ts}.0`, `+${ts}`, ` ${ts}`, `0x${Number(ts).toString(16)}`]) {
      expect(verifyVisitorAddress(KEY, [v, spelling, ip, sig].join(','), NOW)).toBeNull();
    }
  });

  it('refuses a correctly signed value that is not an IP address', () => {
    // Only a key holder could produce this; it is still never used as a rate-limit key.
    const ts = Math.floor(NOW.getTime() / 1000);
    for (const value of ['everyone', '203.0.113.9 ', '']) {
      const sig = createHmac('sha256', KEY).update(`v1\n${ts}\n${value}`).digest('base64url');
      expect(verifyVisitorAddress(KEY, `v1,${ts},${value},${sig}`, NOW)).toBeNull();
    }
    // The same construction with a real address is accepted, so the refusals above are the check.
    const sig = createHmac('sha256', KEY).update(`v1\n${ts}\n203.0.113.9`).digest('base64url');
    expect(verifyVisitorAddress(KEY, `v1,${ts},203.0.113.9,${sig}`, NOW)).toBe('203.0.113.9');
  });

  it('never puts the key in the header', () => {
    expect(signVisitorAddress(KEY, '203.0.113.9', NOW)).not.toContain(KEY);
  });
});
