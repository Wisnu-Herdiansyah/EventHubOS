import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertObjectKey, type ObjectStore, type StoredObject } from '../ports.ts';

/**
 * Files in a local directory (ADR-0042): for local development and CI only, refused by
 * configuration in staging/production. Shared by the API (writes, reads) and the worker
 * (deletes) when both run on one machine. Each object is two files: the bytes and a small JSON
 * sidecar with the content type. Writes go to a temporary name first and are renamed into
 * place, so a reader never sees half a file.
 */
export class LocalDirectoryObjectStore implements ObjectStore {
  readonly name = 'local_directory';
  readonly #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  #paths(key: string): { data: string; meta: string } {
    assertObjectKey(key);
    const data = path.resolve(this.#root, key);
    // The key pattern already forbids `..`; this keeps the guarantee local to the adapter.
    if (!data.startsWith(this.#root + path.sep)) throw new Error('Invalid object key');
    return { data, meta: `${data}.meta.json` };
  }

  async put(key: string, object: StoredObject): Promise<void> {
    const p = this.#paths(key);
    await mkdir(path.dirname(p.data), { recursive: true });
    const tmp = `${p.data}.${randomUUID()}.tmp`;
    await writeFile(`${tmp}.meta`, JSON.stringify({ contentType: object.contentType }));
    await writeFile(tmp, object.data);
    await rename(`${tmp}.meta`, p.meta);
    await rename(tmp, p.data);
  }

  async get(key: string): Promise<StoredObject | null> {
    const p = this.#paths(key);
    try {
      const [data, meta] = await Promise.all([readFile(p.data), readFile(p.meta, 'utf8')]);
      const parsed = JSON.parse(meta) as { contentType?: unknown };
      if (typeof parsed.contentType !== 'string') return null;
      return { data, contentType: parsed.contentType };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const p = this.#paths(key);
    await rm(p.data, { force: true });
    await rm(p.meta, { force: true });
  }
}
