import { describe, expect, it } from 'vitest';
import { clientIpFromForwarded } from './client-ip';

describe('clientIpFromForwarded (site)', () => {
  it('believes only the entry added by trusted proxies', () => {
    expect(clientIpFromForwarded('1.2.3.4, 10.0.0.1', 1)).toBe('10.0.0.1');
    expect(clientIpFromForwarded('spoofed, 203.0.113.9, 10.0.0.1', 2)).toBe('203.0.113.9');
    expect(clientIpFromForwarded('1.2.3.4', 0)).toBeUndefined();
    expect(clientIpFromForwarded('not-an-ip', 1)).toBeUndefined();
  });
});
