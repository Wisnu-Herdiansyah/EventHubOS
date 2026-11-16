import type { Pool } from '@eventhub/db';
import { VISITOR_ADDRESS_HEADER, signVisitorAddress } from '@eventhub/kernel/visitor-address';
import { afterEach, describe, expect, it } from 'vitest';
import { ARGON2ID_BASELINE, Argon2idPasswordHasher } from './adapters/argon2id-password-hasher.ts';
import { buildApp, type AppDependencies } from './app.ts';

/**
 * Per-visitor rate limits when the admin and site apps have no fixed address (ADR-0058). Every
 * request here arrives from the same caller address, as calls from one web app do.
 */
const KEY = `marker-${'k'.repeat(32)}`;
const OTHER = `marker-${'o'.repeat(32)}`;
const LIMIT = 3;
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function api(overrides: Partial<AppDependencies> = {}) {
  const app = await buildApp({
    pool: null as unknown as Pool,
    passwordHasher: new Argon2idPasswordHasher(ARGON2ID_BASELINE),
    identity: { sessionTtlSeconds: 1, loginMaxFailures: 5, loginLockSeconds: 60 },
    rateLimitPerMinute: LIMIT,
    visitorAddressKey: KEY,
    ...overrides,
  } as AppDependencies);
  apps.push(app);
  const hit = async (headers: Record<string, string> = {}) =>
    (await app.inject({ method: 'GET', url: '/health/live', headers })).statusCode;
  const exhaust = async (headers: Record<string, string> = {}) => {
    for (let i = 0; i < LIMIT; i++) expect(await hit(headers)).toBe(200);
    expect(await hit(headers)).toBe(429);
  };
  return { hit, exhaust };
}
const signed = (ip: string, key = KEY, now = new Date()) => ({
  [VISITOR_ADDRESS_HEADER]: signVisitorAddress(key, ip, now)!,
});

describe('rate limits follow the signed visitor address', () => {
  it('each visitor has their own limit, separate from the calling app', async () => {
    const { hit, exhaust } = await api();
    await exhaust(signed('203.0.113.1'));
    expect(await hit(signed('203.0.113.2'))).toBe(200);
    // The app's own unsigned calls are a third bucket.
    expect(await hit()).toBe(200);
    // The first visitor stays limited, however often the header is re-signed.
    expect(await hit(signed('203.0.113.1', KEY, new Date(Date.now() + 5000)))).toBe(429);
  });

  it('a forged, stale or unsigned address shares the caller’s own limit', async () => {
    const { hit, exhaust } = await api();
    await exhaust();
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    expect(await hit(signed('203.0.113.3', OTHER))).toBe(429);
    expect(await hit(signed('203.0.113.4', KEY, stale))).toBe(429);
    expect(await hit({ [VISITOR_ADDRESS_HEADER]: '203.0.113.5' })).toBe(429);
    expect(await hit({ 'x-forwarded-for': '203.0.113.6' })).toBe(429);
    // A properly signed visitor is unaffected.
    expect(await hit(signed('203.0.113.7'))).toBe(200);
  });

  it('without a key, signed addresses are ignored', async () => {
    const { hit, exhaust } = await api({ visitorAddressKey: null });
    await exhaust();
    expect(await hit(signed('203.0.113.8'))).toBe(429);
  });
});
