import { randomUUID } from 'node:crypto';
import { Storage } from '@google-cloud/storage';
import { CloudStorageObjectStore, cloudStorageBucket } from '@eventhub/kernel/gcs-object-store';
import { objectStoreContract } from '@eventhub/kernel/testing';
import { describe, expect, it } from 'vitest';

/**
 * Live contract against a real Cloud Storage bucket (`pnpm test:live`, ADR-0051). Requires:
 *   GCS_CONTRACT_BUCKET  a private test bucket (never production data)
 *   Application Default Credentials for an identity with Storage Object Admin on that bucket
 *   (e.g. `gcloud auth application-default login`); no key is read from this repository.
 */
const bucket = process.env.GCS_CONTRACT_BUCKET;

describe.skipIf(!bucket)('Cloud Storage live contract', () => {
  const store = () => new CloudStorageObjectStore(cloudStorageBucket(bucket!));
  objectStoreContract('gcs (live)', () => Promise.resolve(store()));

  it('keeps uploads private and uncached', async () => {
    const key = `contract/${randomUUID()}/large.webp`;
    await store().put(key, { data: Buffer.from('x'), contentType: 'image/webp' });
    try {
      const file = new Storage().bucket(bucket!).file(key);
      const [metadata] = await file.getMetadata();
      expect(metadata.cacheControl).toBe('private, no-store');
      const [isPublic] = await file.isPublic();
      expect(isPublic).toBe(false);
    } finally {
      await store().delete(key);
    }
  });
});
