import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from '@eventhub/db';
import { allRoutes } from '../app.ts';
import { buildOpenApiDocument } from '../openapi.ts';

// Route definitions only close over the pool inside handlers; none run here.
const doc = buildOpenApiDocument(allRoutes(null as unknown as Pool));
const target = fileURLToPath(new URL('../../openapi.json', import.meta.url));
await writeFile(target, `${JSON.stringify(doc, null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);
