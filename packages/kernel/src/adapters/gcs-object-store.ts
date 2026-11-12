import { Storage } from '@google-cloud/storage';
import { BucketObjectStore, type BucketClient } from './bucket-object-store.ts';

export type { BucketClient } from './bucket-object-store.ts';

/** Bucket names per Cloud Storage rules (no dots: domain-named buckets need verification). */
export const GCS_BUCKET = /^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/;

/**
 * Uploaded images in a private Cloud Storage bucket (ADR-0051). The bucket is never public: the
 * API reads objects and serves them under its own rules (ADR-0042, ADR-0046). Credentials come
 * from Application Default Credentials; no key is passed in configuration.
 */
export class CloudStorageObjectStore extends BucketObjectStore {
  constructor(bucket: BucketClient) {
    super('gcs', bucket);
  }
}

const notFound = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 404;

/**
 * The Cloud Storage SDK as a BucketClient. Uploads are single requests (images are at most a
 * few MB), are not made public, and are not cached by Google's edge: the API decides who may
 * read each image.
 */
export function cloudStorageBucket(bucketName: string, storage = new Storage()): BucketClient {
  if (!GCS_BUCKET.test(bucketName)) throw new Error('Invalid Cloud Storage bucket name');
  const bucket = storage.bucket(bucketName);
  return {
    async save(name, data, contentType) {
      await bucket.file(name).save(data, {
        resumable: false,
        contentType,
        metadata: { cacheControl: 'private, no-store' },
      });
    },
    async load(name) {
      const file = bucket.file(name);
      try {
        const [[data], [metadata]] = await Promise.all([file.download(), file.getMetadata()]);
        return { data, contentType: metadata.contentType };
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    async remove(name) {
      await bucket.file(name).delete({ ignoreNotFound: true });
    },
  };
}
