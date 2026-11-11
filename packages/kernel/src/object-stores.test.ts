import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { LocalDirectoryObjectStore } from './adapters/local-directory-object-store.ts';
import { InMemoryObjectStore } from './ports.ts';
import { objectStoreContract } from './testing/object-store.contract.ts';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

objectStoreContract('in_memory', () => Promise.resolve(new InMemoryObjectStore()));
objectStoreContract('local_directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eventhub-objects-'));
  dirs.push(dir);
  return new LocalDirectoryObjectStore(dir);
});

it('local_directory leaves no temporary files behind and writes only under its root', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eventhub-objects-'));
  dirs.push(dir);
  const store = new LocalDirectoryObjectStore(dir);
  await store.put('orgs/a/b.webp', { data: Buffer.from('x'), contentType: 'image/webp' });
  expect((await readdir(path.join(dir, 'orgs', 'a'))).sort()).toEqual([
    'b.webp',
    'b.webp.meta.json',
  ]);
});

it('in_memory simulates outages for tests', async () => {
  const store = new InMemoryObjectStore();
  store.failNext(1);
  await expect(store.put('a.webp', { data: Buffer.from('x'), contentType: 'x' })).rejects.toThrow(
    /outage/,
  );
  await store.put('a.webp', { data: Buffer.from('x'), contentType: 'x' });
  expect(store.keys()).toEqual(['a.webp']);
});
