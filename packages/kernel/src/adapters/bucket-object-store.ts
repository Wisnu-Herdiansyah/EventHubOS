import { assertObjectKey, type ObjectStore, type StoredObject } from '../ports.ts';

/**
 * The few bucket operations an object-storage adapter needs (ADR-0051, ADR-0054). Each provider
 * implements it over its SDK (`cloudStorageBucket`, `supabaseStorageBucket`); tests pass an
 * in-memory double, so the shared rules below run against the ObjectStore contract without a
 * live bucket.
 */
export interface BucketClient {
  save(name: string, data: Buffer, contentType: string): Promise<void>;
  /** null when the object does not exist. */
  load(name: string): Promise<{ data: Buffer; contentType: string | undefined } | null>;
  /** Succeeds when the object does not exist. */
  remove(name: string): Promise<void>;
}

/** An ObjectStore over a private bucket. Keys are validated here, before any provider call. */
export class BucketObjectStore implements ObjectStore {
  readonly name: string;
  readonly #bucket: BucketClient;

  constructor(name: string, bucket: BucketClient) {
    this.name = name;
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
