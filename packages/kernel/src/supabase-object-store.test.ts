import { describe, expect, it } from 'vitest';
import type { BucketClient } from './adapters/bucket-object-store.ts';
import {
  SupabaseStorageObjectStore,
  supabaseStorageBucket,
} from './adapters/supabase-object-store.ts';
import { objectStoreContract } from './testing/object-store.contract.ts';

function memoryBucket(): BucketClient {
  const objects = new Map<string, { data: Buffer; contentType: string }>();
  return {
    save: (name, data, contentType) => {
      objects.set(name, { data: Buffer.from(data), contentType });
      return Promise.resolve();
    },
    load: (name) => Promise.resolve(objects.get(name) ?? null),
    remove: (name) => {
      objects.delete(name);
      return Promise.resolve();
    },
  };
}

objectStoreContract('supabase (in-memory bucket)', () =>
  Promise.resolve(new SupabaseStorageObjectStore(memoryBucket())),
);

// Not a key: a recognisable marker, so a test can prove it never appears in an error.
const SECRET = `marker-${'x'.repeat(32)}`;
const options = { url: 'https://abcdefghijkl.supabase.co', secretKey: SECRET, bucket: 'images' };

type Err = { status?: number; statusCode?: string; message?: string };
/** Records calls; each operation answers with the given result. */
function fakeClient(
  answers: {
    upload?: { error: Err | null };
    download?: { data: Blob | null; error: Err | null };
    remove?: { error: Err | null };
  } = {},
) {
  const calls: Array<{ op: string; bucket: string; args: unknown[] }> = [];
  const client = {
    from(bucket: string) {
      return {
        upload: (...args: unknown[]) => {
          calls.push({ op: 'upload', bucket, args });
          return Promise.resolve({ data: null, ...(answers.upload ?? { error: null }) });
        },
        download: (...args: unknown[]) => {
          calls.push({ op: 'download', bucket, args });
          return Promise.resolve(
            answers.download ?? { data: new Blob(['bytes'], { type: 'image/webp' }), error: null },
          );
        },
        remove: (...args: unknown[]) => {
          calls.push({ op: 'remove', bucket, args });
          return Promise.resolve({ data: [], ...(answers.remove ?? { error: null }) });
        },
      };
    },
  };
  return { client: client as never, calls };
}

describe('supabaseStorageBucket (ADR-0054)', () => {
  it('uploads to the named bucket, overwriting, uncached', async () => {
    const { client, calls } = fakeClient();
    await supabaseStorageBucket(options, client).save(
      'orgs/a/b.webp',
      Buffer.from('x'),
      'image/webp',
    );
    expect(calls).toEqual([
      {
        op: 'upload',
        bucket: 'images',
        args: [
          'orgs/a/b.webp',
          Buffer.from('x'),
          { contentType: 'image/webp', upsert: true, cacheControl: 'no-store' },
        ],
      },
    ]);
  });

  it('reads bytes and type', async () => {
    const got = await supabaseStorageBucket(options, fakeClient().client).load('a/b.webp');
    expect(got).toEqual({ data: Buffer.from('bytes'), contentType: 'image/webp' });
  });

  it('treats both forms of "not found" as missing, on read and delete', async () => {
    for (const error of [{ status: 404 }, { status: 400, statusCode: '404' }]) {
      const { client } = fakeClient({ download: { data: null, error }, remove: { error } });
      const b = supabaseStorageBucket(options, client);
      expect(await b.load('a/b.webp'), JSON.stringify(error)).toBeNull();
      await expect(b.remove('a/b.webp')).resolves.toBeUndefined();
    }
  });

  it('propagates other errors, without the secret key or request details', async () => {
    const error = { status: 403, statusCode: '403', message: `denied for ${SECRET}` };
    const { client } = fakeClient({
      upload: { error },
      download: { data: null, error },
      remove: { error },
    });
    const b = supabaseStorageBucket(options, client);
    for (const call of [
      () => b.save('a/b.webp', Buffer.from('x'), 'image/webp'),
      () => b.load('a/b.webp'),
      () => b.remove('a/b.webp'),
    ]) {
      const thrown = await call().then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(thrown?.message).toMatch(
        /^Supabase Storage (upload|download|delete) failed \(status 403, 403\)$/,
      );
      expect(thrown?.message).not.toContain(SECRET);
    }
  });

  it('refuses a malformed URL, bucket or key before any request', () => {
    const { client } = fakeClient();
    for (const bad of [
      { ...options, url: 'http://abcdefghijkl.supabase.co' },
      { ...options, url: 'https://abcdefghijkl.supabase.co/storage/v1' },
      { ...options, bucket: 'Images' },
      { ...options, bucket: 'has.dot' },
      { ...options, secretKey: 'x' },
    ]) {
      expect(() => supabaseStorageBucket(bad, client), JSON.stringify(bad)).toThrow(
        /Invalid Supabase/,
      );
    }
  });

  it('builds the real SDK client without a network call', () => {
    expect(() => supabaseStorageBucket(options)).not.toThrow();
  });
});
