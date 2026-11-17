import { describe, expect, it } from 'vitest';
import { batchKey } from './batch-key';

describe('batchKey (ADR-0066)', () => {
  const a = '00000000-0000-4000-8000-00000000000a';
  const b = '00000000-0000-4000-8000-00000000000b';
  it('is the same for the same batch, whatever the order', () => {
    expect(batchKey('admin-k', 'approve', [a, b])).toBe(batchKey('admin-k', 'approve', [b, a]));
    expect(batchKey('admin-k', 'approve', [a])).toMatch(/^admin-k-[A-Za-z0-9_-]{22}$/);
  });
  it('differs by decision, selection and page key', () => {
    const k = batchKey('admin-k', 'approve', [a, b]);
    expect(batchKey('admin-k', 'decline', [a, b])).not.toBe(k);
    expect(batchKey('admin-k', 'approve', [a])).not.toBe(k);
    expect(batchKey('admin-j', 'approve', [a, b])).not.toBe(k);
  });
});
