import { readFile } from 'node:fs/promises';
import type { Pool } from '@eventhub/db';
import { describe, expect, it } from 'vitest';
import { allRoutes } from './app.ts';
import { decodeCursor, encodeCursor } from './modules/event/routes.ts';
import { parseBearerToken } from './modules/identity/authenticator.ts';
import { buildOpenApiDocument } from './openapi.ts';

describe('OpenAPI contract', () => {
  it('committed openapi.json matches the route definitions (run `pnpm openapi:generate`)', async () => {
    const committed = JSON.parse(
      await readFile(new URL('../openapi.json', import.meta.url), 'utf8'),
    );
    expect(buildOpenApiDocument(allRoutes(null as unknown as Pool))).toEqual(committed);
  });

  it('every mutating route requires an Idempotency-Key and declares a permission', () => {
    for (const r of allRoutes(null as unknown as Pool)) {
      if (r.method !== 'GET') expect(r.idempotent, r.operationId).toBe(true);
      expect(r.requires).toBeTruthy();
    }
  });

  it('operation IDs are unique', () => {
    const ids = allRoutes(null as unknown as Pool).map((r) => r.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('parseBearerToken', () => {
  it('accepts well-formed bearer tokens only', () => {
    const t = 'a'.repeat(43);
    expect(parseBearerToken(`Bearer ${t}`)).toBe(t);
    expect(parseBearerToken(`bearer ${t}`)).toBeNull();
    expect(parseBearerToken('Bearer short')).toBeNull();
    expect(parseBearerToken(`Bearer ${t}' OR 1=1`)).toBeNull();
    expect(parseBearerToken(undefined)).toBeNull();
  });
});

describe('event list cursor', () => {
  it('round-trips and rejects tampering', () => {
    const id = '3f1c1f0e-2a7b-4c3d-8e9f-0a1b2c3d4e5f';
    expect(decodeCursor(encodeCursor('1700000000123456', id))).toEqual({
      createdUs: '1700000000123456',
      id,
    });
    expect(() => decodeCursor(Buffer.from('1; DROP TABLE x').toString('base64url'))).toThrow();
  });
});
