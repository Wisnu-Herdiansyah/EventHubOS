import { describe, expect, it } from 'vitest';
import { VISITOR_ADDRESS_HEADER, verifyVisitorAddress } from '@eventhub/kernel/visitor-address';
import { clientIpFromForwarded, visitorHeaders } from './client-ip';

describe('clientIpFromForwarded (admin)', () => {
  it('believes only the entry added by trusted proxies', () => {
    expect(clientIpFromForwarded('1.2.3.4, 10.0.0.1', 1)).toBe('10.0.0.1');
    expect(clientIpFromForwarded('spoofed, 203.0.113.9, 10.0.0.1', 2)).toBe('203.0.113.9');
    expect(clientIpFromForwarded('1.2.3.4', 0)).toBeUndefined();
    expect(clientIpFromForwarded('not-an-ip', 1)).toBeUndefined();
  });
});

describe('visitorHeaders (admin, ADR-0058)', () => {
  const KEY = `marker-${'k'.repeat(32)}`;
  const NOW = new Date('2026-11-16T10:00:00Z');

  it('signs the visitor address the trusted proxy reported, for the API to verify', () => {
    const headers = visitorHeaders('198.51.100.7, 203.0.113.9', 1, KEY, NOW);
    expect(headers['x-forwarded-for']).toBe('203.0.113.9');
    expect(verifyVisitorAddress(KEY, headers[VISITOR_ADDRESS_HEADER], NOW)).toBe('203.0.113.9');
    expect(Object.keys(headers).sort()).toEqual(['x-eventhub-visitor', 'x-forwarded-for']);
  });

  it('never signs an address the visitor wrote themselves', () => {
    // With no trusted proxy, the whole header is the visitor's own claim.
    expect(visitorHeaders('203.0.113.9', 0, KEY, NOW)).toStrictEqual({});
    expect(visitorHeaders('not-an-ip', 1, KEY, NOW)).toStrictEqual({});
    expect(visitorHeaders(null, 1, KEY, NOW)).toStrictEqual({});
    // The entry left of the proxy's is the visitor's claim too.
    const headers = visitorHeaders('198.51.100.7, 203.0.113.9', 1, KEY, NOW);
    expect(JSON.stringify(headers)).not.toContain('198.51.100.7');
  });

  it('without a key, forwards the address unsigned as before', () => {
    expect(visitorHeaders('203.0.113.9', 1, null, NOW)).toEqual({
      'x-forwarded-for': '203.0.113.9',
    });
  });
});
