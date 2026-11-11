import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ObjectStore } from '../ports.ts';

/** Shared contract every ObjectStore adapter must pass (local fakes now; the provider later). */
export function objectStoreContract(name: string, makeStore: () => Promise<ObjectStore>): void {
  describe(`ObjectStore contract: ${name}`, () => {
    const key = () => `contract/${randomUUID()}/large.webp`;
    const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x10]);

    it('has a stable adapter name', async () => {
      expect((await makeStore()).name).toMatch(/^[a-z][a-z0-9_]*$/);
    });

    it('stores and returns bytes and content type intact', async () => {
      const store = await makeStore();
      const k = key();
      await store.put(k, { data: bytes, contentType: 'image/webp' });
      const got = await store.get(k);
      expect(got?.contentType).toBe('image/webp');
      expect(got && Buffer.compare(got.data, bytes)).toBe(0);
    });

    it('overwrites an existing key', async () => {
      const store = await makeStore();
      const k = key();
      await store.put(k, { data: bytes, contentType: 'image/webp' });
      await store.put(k, { data: Buffer.from('second'), contentType: 'image/png' });
      const got = await store.get(k);
      expect(got?.data.toString()).toBe('second');
      expect(got?.contentType).toBe('image/png');
    });

    it('returns null for a missing key', async () => {
      expect(await (await makeStore()).get(key())).toBeNull();
    });

    it('deletes, and deleting again (or a missing key) succeeds', async () => {
      const store = await makeStore();
      const k = key();
      await store.put(k, { data: bytes, contentType: 'image/webp' });
      await store.delete(k);
      expect(await store.get(k)).toBeNull();
      await expect(store.delete(k)).resolves.toBeUndefined();
    });

    it('refuses keys that could escape their prefix', async () => {
      const store = await makeStore();
      for (const bad of ['../x', 'a/../../b', '/abs', 'A/upper', 'a//b', '', 'a/b/']) {
        await expect(store.put(bad, { data: bytes, contentType: 'image/webp' })).rejects.toThrow();
        await expect(store.get(bad)).rejects.toThrow();
        await expect(store.delete(bad)).rejects.toThrow();
      }
    });
  });
}
