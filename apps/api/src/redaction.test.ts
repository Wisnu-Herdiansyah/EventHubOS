import { Writable } from 'node:stream';
import type { Pool } from '@eventhub/db';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { redactingLogOptions } from '@eventhub/kernel';
import { ARGON2ID_BASELINE, Argon2idPasswordHasher } from './adapters/argon2id-password-hasher.ts';
import { buildApp, loggerOptions, type AppDependencies } from './app.ts';

/** A place to write log lines to, and what was written. */
function capture() {
  let out = '';
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      out += chunk.toString();
      done();
    },
  });
  return { sink, text: () => out, lines: () => out.split('\n').filter(Boolean) };
}

/** Logs one line with the production redaction and returns what was written. */
function logged(obj: Record<string, unknown>, message = 'x'): string {
  const { sink, text } = capture();
  pino(redactingLogOptions(), sink).info(obj, message);
  return text();
}

const key = `marker-${'x'.repeat(32)}`;

describe('log redaction of provider keys (ADR-0054)', () => {
  it('hides configured keys and the apikey request header', () => {
    for (const obj of [
      { objectStore: { supabase: { url: 'https://p.supabase.co', secretKey: key } } },
      { email: undefined, resend: { apiKey: key } },
      { headers: { apikey: key } },
      { config: { objectStore: { supabase: { secretKey: key } } } },
      { req: { headers: { apikey: key } } },
    ]) {
      const line = logged(obj);
      expect(line, JSON.stringify(Object.keys(obj))).not.toContain(key);
      expect(line).toContain('[REDACTED]');
    }
  });

  it('hides signed visitor addresses (ADR-0058)', () => {
    const signed = `v1,1700000000,203.0.113.9,${'s'.repeat(43)}`;
    for (const obj of [
      { req: { headers: { 'x-eventhub-visitor': signed } } },
      { headers: { 'x-eventhub-visitor': signed } },
    ]) {
      const line = logged(obj);
      expect(line).not.toContain(signed);
      expect(line).toContain('[REDACTED]');
    }
  });
});

describe('log redaction at any depth and in any text (ADR-0060)', () => {
  it('hides sensitive fields nested deeper than any listed path', () => {
    const line = logged({
      config: {
        api: { identity: { mfa: { MFA_ENCRYPTION_KEY: key } } },
        worker: {
          email: { provider: { resend: { apiKey: key, from: 'EventHub <no-reply@x.test>' } } },
        },
        database: { roles: [{ name: 'eventhub_app', password: key }] },
      },
      user: { profile: { contact: { email: 'ada.lovelace@example.com' } } },
    });
    expect(line).not.toContain(key);
    expect(line).not.toContain('ada.lovelace');
    expect(line).toContain('eventhub_app');
    expect(JSON.parse(line)).toMatchObject({
      config: { database: { roles: [{ name: 'eventhub_app', password: '[REDACTED]' }] } },
    });
  });

  it('hides credentials inside messages, errors and stack traces', () => {
    const url = `postgres://eventhub_app:${key}@db.internal/eventhub`;
    const error = Object.assign(new Error(`connect failed for ${url}`), {
      detail: 'Key (email)=(ada.lovelace@example.com) already exists.',
      config: { connectionString: url, password: key },
      cause: new Error(`inner ${url}`),
    });
    const line = logged({ err: error }, `could not reach ${url} for ada.lovelace@example.com`);
    expect(line).not.toContain(key);
    expect(line).not.toContain('ada.lovelace');
    const parsed = JSON.parse(line) as { msg: string; err: { type: string; message: string } };
    expect(parsed.err.type).toBe('Error');
    expect(parsed.err.message).toContain('postgres://eventhub_app:[REDACTED]@db.internal/eventhub');
    expect(parsed.msg).toContain('a***@example.com');
  });

  it('hides them in child logger bindings', () => {
    const { sink, text } = capture();
    const child = pino(redactingLogOptions(), sink).child({
      job: { settings: { token: key } },
      origin: `https://user:${key}@example.com`,
    });
    child.warn('from a child');
    expect(text()).not.toContain(key);
    expect(text()).toContain('from a child');
  });

  it('keeps ordinary log content intact', () => {
    const line = logged(
      { published: 3, retried: 0, correlationId: 'admin-123', url: '/v1/events?page=2' },
      'relay pass',
    );
    expect(JSON.parse(line)).toMatchObject({
      published: 3,
      retried: 0,
      correlationId: 'admin-123',
      url: '/v1/events?page=2',
      msg: 'relay pass',
    });
  });
});

describe('the API server logs through the same redaction', () => {
  it('request lines never carry a secret from the URL or the headers', async () => {
    const { sink, text, lines } = capture();
    const app = await buildApp({
      pool: null as unknown as Pool,
      passwordHasher: new Argon2idPasswordHasher(ARGON2ID_BASELINE),
      identity: { sessionTtlSeconds: 1, loginMaxFailures: 5, loginLockSeconds: 60 },
      logger: { ...(loggerOptions('info') as object), stream: sink },
    } as unknown as AppDependencies);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/health/live?token=${key}&page=2`,
        headers: { authorization: `Bearer ${key}`, cookie: `session=${key}` },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
    // The request was logged, with its path, and without the secret.
    expect(lines().length).toBeGreaterThan(0);
    expect(text()).toContain('/health/live?token=[REDACTED]&page=2');
    expect(text()).not.toContain(key);
    for (const line of lines()) expect(() => JSON.parse(line) as unknown).not.toThrow();
  });
});
