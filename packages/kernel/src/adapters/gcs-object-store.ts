import { Storage } from '@google-cloud/storage';
import { assertObjectKey, type ObjectStore, type StoredObject } from '../ports.ts';

/**
 * The few bucket operations the adapter needs. The Cloud Storage SDK implements it in
 * production (`cloudStorageBucket`); tests pass an in-memory double, so the adapter's own rules
 * run against the shared ObjectStore contract without a live bucket.
 */
export interface BucketClient {
  save(name: string, data: Buffer, contentType: string): Promise<void>;
  /** null when the object does not exist. */
  load(name: string): Promise<{ data: Buffer; contentType: string | undefined } | null>;
  /** Succeeds when the object does not exist. */
  remove(name: string): Promise<void>;
}

/** Bucket names per Cloud Storage rules (no dots: domain-named buckets need verification). */
export const GCS_BUCKET = /^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/;

/**
 * Uploaded images in a private Cloud Storage bucket (ADR-0051, D1). The bucket is never public:
 * the API reads objects and serves them under its own rules (ADR-0042, ADR-0046). Credentials
 * come from Application Default Credentials (the service account on Cloud Run); no key is passed
 * in configuration. Keys are validated here as in every adapter.
 */
export class CloudStorageObjectStore implements ObjectStore {
  readonly name = 'gcs';
  readonly #bucket: BucketClient;

  constructor(bucket: BucketClient) {
    this.#bucket = bucket;
  }

  async put(key: string, object: StoredObject): Promise<void> {
    assertObjectKey(key);
    await this.#bucket.save(key, Buffer.from(object.data), object.contentType);
  }

  async get(key: string): Promise<StoredObject | null> {
    assertObjectKey(key);
    const found = await this.#bucket.load(key);
    if (!found) return null;
    return { data: found.data, contentType: found.contentType ?? 'application/octet-stream' };
  }

  async delete(key: string): Promise<void> {
    assertObjectKey(key);
    await this.#bucket.remove(key);
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
