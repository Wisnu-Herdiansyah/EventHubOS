import { readFile } from 'node:fs/promises';
import type { Pool } from '@eventhub/db';
import { describe, expect, it } from 'vitest';
import { ARGON2ID_BASELINE, Argon2idPasswordHasher } from './adapters/argon2id-password-hasher.ts';
import { allRoutes, undocumentedPaths } from './app.ts';
import { decodeCursor, encodeCursor } from './modules/event/routes.ts';
import { parseBearerToken } from './modules/identity/authenticator.ts';
import { buildOpenApiDocument } from './openapi.ts';

const routes = () =>
  allRoutes({
    pool: null as unknown as Pool,
    passwordHasher: new Argon2idPasswordHasher(ARGON2ID_BASELINE),
    identity: { sessionTtlSeconds: 1, loginMaxFailures: 5, loginLockSeconds: 60 },
  });

describe('OpenAPI contract', () => {
  it('committed openapi.json matches the route definitions (run `pnpm openapi:generate`)', async () => {
    const committed = JSON.parse(
      await readFile(new URL('../openapi.json', import.meta.url), 'utf8'),
    );
    expect(buildOpenApiDocument(routes())).toEqual(committed);
  });

  it('every mutating route requires an Idempotency-Key or documents why it is exempt', () => {
    for (const r of routes()) {
      if (r.method !== 'GET') {
        expect(r.idempotent || (r.idempotencyExempt ?? '').length > 20, r.operationId).toBe(true);
      }
      expect(r.requires).toBeTruthy();
    }
  });

  it('only pre-session identity flows are public', () => {
    const publicOps = routes()
      .filter((r) => r.auth === 'public')
      .map((r) => r.operationId)
      .sort();
    // Password reset is pre-session by nature: the user cannot sign in (ADR-0015).
    expect(publicOps).toEqual([
      'completePasswordReset',
      'logIn',
      'requestPasswordReset',
      'signUp',
      'verifyEmail',
    ]);
    for (const r of routes().filter((x) => x.auth === 'public'))
      expect(r.rateLimit, r.operationId).toBeDefined();
  });

  it('declares path parameters and path segments consistently (Fastify :name syntax)', () => {
    for (const r of routes()) {
      const inPath = [...r.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]).sort();
      const declared = Object.keys(
        (r.schemas.params as { shape?: Record<string, unknown> } | undefined)?.shape ?? {},
      ).sort();
      expect(r.path, r.operationId).not.toMatch(/[{}]/);
      expect(inPath, r.operationId).toEqual(declared);
    }
  });

  it('every $ref in the document resolves against the document root', () => {
    const doc = buildOpenApiDocument(routes());
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === '$ref' && typeof v === 'string') refs.push(v);
          else walk(v);
        }
      }
    };
    walk(doc);
    expect(refs.length).toBeGreaterThan(10);
    for (const ref of refs) {
      expect(ref, ref).toMatch(/^#\/components\/schemas\/[A-Za-z0-9]+$/);
      const name = ref.split('/').pop()!;
      expect(
        (doc.components as { schemas: Record<string, unknown> }).schemas[name],
        ref,
      ).toBeDefined();
    }
    expect(JSON.stringify(doc)).not.toContain('$defs');
  });

  it('operation IDs are unique', () => {
    const ids = routes().map((r) => r.operationId);
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

describe('undocumentedPaths (responses must match their documented schema)', () => {
  it('finds fields the schema does not describe, at any depth', () => {
    const actual = { data: [{ id: 'a', secret: 'x' }], policy: { idle: 1 }, extra: true };
    const documented = { data: [{ id: 'a' }], policy: { idle: 1 } };
    expect(undocumentedPaths(actual, documented)).toEqual(['$.data[0].secret', '$.extra']);
  });

  it('accepts exact matches and undefined optional fields', () => {
    expect(undocumentedPaths({ a: 1, b: undefined, c: [1, 2] }, { a: 1, c: [1, 2] })).toEqual([]);
  });
});
