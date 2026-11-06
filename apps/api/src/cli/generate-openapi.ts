import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from '@eventhub/db';
import { Argon2idPasswordHasher } from '../adapters/argon2id-password-hasher.ts';
import { allRoutes } from '../app.ts';
import { buildOpenApiDocument } from '../openapi.ts';

// Route definitions only close over the pool inside handlers; none run here.
const doc = buildOpenApiDocument(
  allRoutes({
    pool: null as unknown as Pool,
    passwordHasher: new Argon2idPasswordHasher(),
    identity: { sessionTtlSeconds: 1, loginMaxFailures: 5, loginLockSeconds: 60 },
  }),
);
const target = fileURLToPath(new URL('../../openapi.json', import.meta.url));
await writeFile(target, `${JSON.stringify(doc, null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);
