import { randomUUID } from 'node:crypto';
import {
  SupabaseStorageObjectStore,
  supabaseStorageBucket,
} from '@eventhub/kernel/supabase-object-store';
import { objectStoreContract } from '@eventhub/kernel/testing';
import { describe, expect, it } from 'vitest';

/**
 * Live contract against a real Supabase Storage bucket (`pnpm test:live`, ADR-0054). Requires:
 *   SUPABASE_CONTRACT_URL         the test project's URL, https://<ref>.supabase.co
 *   SUPABASE_CONTRACT_BUCKET      a private test bucket (never production data)
 *   SUPABASE_CONTRACT_SECRET_KEY  that project's server-side secret key, from your secret store
 * It also proves the two behaviours the adapter assumes: how a missing object is reported, and
 * that the bucket does not serve objects without the key.
 */
const url = process.env.SUPABASE_CONTRACT_URL;
const bucket = process.env.SUPABASE_CONTRACT_BUCKET;
const secretKey = process.env.SUPABASE_CONTRACT_SECRET_KEY;
const configured = Boolean(url && bucket && secretKey);

describe.skipIf(!configured)('Supabase Storage live contract', () => {
  const store = () =>
    new SupabaseStorageObjectStore(
      supabaseStorageBucket({ url: url!, bucket: bucket!, secretKey: secretKey! }),
    );
  objectStoreContract('supabase (live)', () => Promise.resolve(store()));

  it('is private: the public URL of an object is refused', async () => {
    const key = `contract/${randomUUID()}/large.webp`;
    await store().put(key, { data: Buffer.from('x'), contentType: 'image/webp' });
    try {
      const res = await fetch(`${url}/storage/v1/object/public/${bucket}/${key}`);
      expect(res.ok).toBe(false);
    } finally {
      await store().delete(key);
    }
  });
});
