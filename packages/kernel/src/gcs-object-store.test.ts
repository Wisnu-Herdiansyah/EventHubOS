import type { Storage } from '@google-cloud/storage';
import { describe, expect, it } from 'vitest';
import {
  CloudStorageObjectStore,
  cloudStorageBucket,
  type BucketClient,
} from './adapters/gcs-object-store.ts';
import { objectStoreContract } from './testing/object-store.contract.ts';

/** An in-memory bucket with the same not-found behaviour as the SDK glue. */
function memoryBucket(): BucketClient & { names(): string[] } {
  const objects = new Map<string, { data: Buffer; contentType: string }>();
  return {
    names: () => [...objects.keys()],
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

objectStoreContract('gcs (in-memory bucket)', () =>
  Promise.resolve(new CloudStorageObjectStore(memoryBucket())),
);

describe('CloudStorageObjectStore (ADR-0051)', () => {
  it('checks keys before anything reaches the bucket', async () => {
    const bucket = memoryBucket();
    const store = new CloudStorageObjectStore(bucket);
    await expect(
      store.put('../escape', { data: Buffer.from('x'), contentType: 'image/webp' }),
    ).rejects.toThrow('Invalid object key');
    expect(bucket.names()).toEqual([]);
  });

  it('falls back to a neutral content type when the bucket has none', async () => {
    const store = new CloudStorageObjectStore({
      save: () => Promise.resolve(),
      load: () => Promise.resolve({ data: Buffer.from('x'), contentType: undefined }),
      remove: () => Promise.resolve(),
    });
    expect((await store.get('a/b.webp'))?.contentType).toBe('application/octet-stream');
  });
});

/** Records what the SDK glue asks of Cloud Storage. */
function fakeStorage(behaviour: { download?: () => Promise<unknown> } = {}) {
  const calls: Array<{ op: string; bucket: string; name: string; options?: unknown }> = [];
  let bucketName = '';
  const storage = {
    bucket(name: string) {
      bucketName = name;
      return {
        file(file: string) {
          return {
            save(data: Buffer, options: unknown) {
              calls.push({ op: 'save', bucket: bucketName, name: file, options });
              return Promise.resolve();
            },
            download() {
              calls.push({ op: 'download', bucket: bucketName, name: file });
              return behaviour.download
                ? behaviour.download()
                : Promise.resolve([Buffer.from('bytes')]);
            },
            getMetadata() {
              return Promise.resolve([{ contentType: 'image/webp' }]);
            },
            delete(options: unknown) {
              calls.push({ op: 'delete', bucket: bucketName, name: file, options });
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
  return { storage: storage as unknown as Storage, calls };
}

describe('cloudStorageBucket (SDK glue)', () => {
  it('uploads privately in one request, uncached, to the named bucket', async () => {
    const { storage, calls } = fakeStorage();
    await cloudStorageBucket('eventhub-images', storage).save(
      'orgs/a/b.webp',
      Buffer.from('x'),
      'image/webp',
    );
    expect(calls).toEqual([
      {
        op: 'save',
        bucket: 'eventhub-images',
        name: 'orgs/a/b.webp',
        options: {
          resumable: false,
          contentType: 'image/webp',
          metadata: { cacheControl: 'private, no-store' },
        },
      },
    ]);
    // Nothing asks for a public ACL.
    expect(JSON.stringify(calls)).not.toMatch(/public|predefinedAcl/i);
  });

  it('reads bytes and type; a missing object is null; other errors propagate', async () => {
    const ok = cloudStorageBucket('eventhub-images', fakeStorage().storage);
    expect(await ok.load('a/b.webp')).toEqual({
      data: Buffer.from('bytes'),
      contentType: 'image/webp',
    });
    const missing = cloudStorageBucket(
      'eventhub-images',
      fakeStorage({
        download: () => Promise.reject(Object.assign(new Error('No such object'), { code: 404 })),
      }).storage,
    );
    expect(await missing.load('a/b.webp')).toBeNull();
    const denied = cloudStorageBucket(
      'eventhub-images',
      fakeStorage({
        download: () => Promise.reject(Object.assign(new Error('Forbidden'), { code: 403 })),
      }).storage,
    );
    await expect(denied.load('a/b.webp')).rejects.toThrow('Forbidden');
  });

  it('deletes without failing on a missing object', async () => {
    const { storage, calls } = fakeStorage();
    await cloudStorageBucket('eventhub-images', storage).remove('a/b.webp');
    expect(calls).toEqual([
      {
        op: 'delete',
        bucket: 'eventhub-images',
        name: 'a/b.webp',
        options: { ignoreNotFound: true },
      },
    ]);
  });

  it('refuses malformed bucket names', () => {
    for (const bad of ['', 'Upper', 'a', 'has.dot', '-start', 'end-', 'x'.repeat(64)]) {
      expect(() => cloudStorageBucket(bad, fakeStorage().storage), bad).toThrow(
        'Invalid Cloud Storage bucket name',
      );
    }
  });
});
