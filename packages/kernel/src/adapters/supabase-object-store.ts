import { StorageClient } from '@supabase/storage-js';
import { BucketObjectStore, type BucketClient } from './bucket-object-store.ts';

/** Supabase bucket ids: lowercase letters, digits, hyphens and underscores. */
export const SUPABASE_BUCKET = /^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/;
/** A Supabase project URL, e.g. https://abcdefghijklmnop.supabase.co (no path). */
export const SUPABASE_URL = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/;

/**
 * Uploaded images in a private Supabase Storage bucket (ADR-0054). The bucket is never public:
 * the API reads objects with the server-side secret key and serves them under its own rules
 * (ADR-0042, ADR-0046). The key comes from the environment (the secret store), is sent only to
 * the project's own Storage API, and never appears in errors or logs.
 */
export class SupabaseStorageObjectStore extends BucketObjectStore {
  constructor(bucket: BucketClient) {
    super('supabase', bucket);
  }
}

interface StorageErrorLike {
  status?: number;
  statusCode?: string;
  message?: string;
}

/** Storage answers a missing object with 404, or with 400 and statusCode "404" (older servers). */
function isNotFound(error: StorageErrorLike): boolean {
  return error.status === 404 || error.statusCode === '404' || error.statusCode === 'NoSuchKey';
}

/** A provider error without the request details (which could carry the key in a URL or header). */
function storageError(op: string, error: StorageErrorLike): Error {
  return new Error(
    `Supabase Storage ${op} failed (status ${error.status ?? 'unknown'}${
      error.statusCode ? `, ${error.statusCode}` : ''
    })`,
  );
}

/**
 * The Supabase Storage SDK as a BucketClient. Uploads overwrite (`upsert`) and ask for no caching:
 * the API decides who may read each image.
 */
export function supabaseStorageBucket(
  options: { url: string; secretKey: string; bucket: string },
  client?: Pick<StorageClient, 'from'>,
): BucketClient {
  if (!SUPABASE_URL.test(options.url)) throw new Error('Invalid Supabase project URL');
  if (!SUPABASE_BUCKET.test(options.bucket)) throw new Error('Invalid Supabase bucket name');
  if (options.secretKey.length < 20) throw new Error('Invalid Supabase secret key');
  const storage =
    client ??
    new StorageClient(`${options.url}/storage/v1`, {
      apikey: options.secretKey,
      Authorization: `Bearer ${options.secretKey}`,
    });
  const bucket = () => storage.from(options.bucket);
  return {
    async save(name, data, contentType) {
      const { error } = await bucket().upload(name, data, {
        contentType,
        upsert: true,
        cacheControl: 'no-store',
      });
      if (error) throw storageError('upload', error);
    },
    async load(name) {
      const { data, error } = await bucket().download(name);
      if (error) {
        if (isNotFound(error)) return null;
        throw storageError('download', error);
      }
      return { data: Buffer.from(await data.arrayBuffer()), contentType: data.type || undefined };
    },
    async remove(name) {
      // Deleting a missing object is not an error here: it removes nothing.
      const { error } = await bucket().remove([name]);
      if (error && !isNotFound(error)) throw storageError('delete', error);
    },
  };
}
