import { describe, expect, it } from 'vitest';
import { ConfigError, loadApiConfig, loadMigratorConfig, loadWorkerConfig } from './index.ts';

// Leak-detection sentinel, not a credential.
const SECRET = 'S3cr3t-should-never-appear'; // pragma: allowlist secret
const localUrl = `postgres://eventhub_app:${SECRET}@localhost:5432/eventhub`;

function captureError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error('expected ConfigError');
}

describe('loadApiConfig', () => {
  it('parses a valid local configuration with defaults', () => {
    const c = loadApiConfig({ EVENTHUB_ENV: 'local', DATABASE_APP_URL: localUrl });
    expect(c.environment).toBe('local');
    expect(c.http).toEqual({ host: '127.0.0.1', port: 3000, trustProxy: false });
    expect(c.logLevel).toBe('info');
  });

  it('fails closed when a critical value is missing', () => {
    const e = captureError(() => loadApiConfig({ EVENTHUB_ENV: 'local' }));
    expect(e.keys).toEqual(['DATABASE_APP_URL']);
  });

  it('rejects an unknown environment', () => {
    const e = captureError(() =>
      loadApiConfig({ EVENTHUB_ENV: 'prod', DATABASE_APP_URL: localUrl }),
    );
    expect(e.keys).toContain('EVENTHUB_ENV');
  });

  it('never echoes configuration values in errors', () => {
    const e = captureError(() =>
      loadApiConfig({ EVENTHUB_ENV: 'production', DATABASE_APP_URL: localUrl }),
    );
    expect(e.message).not.toContain(SECRET);
    expect(e.keys).toEqual(['DATABASE_APP_URL']);
  });

  it('requires database TLS in staging and production', () => {
    expect(() => loadApiConfig({ EVENTHUB_ENV: 'staging', DATABASE_APP_URL: localUrl })).toThrow(
      ConfigError,
    );
    const ok = loadApiConfig({
      EVENTHUB_ENV: 'production',
      DATABASE_APP_URL: `${localUrl}?sslmode=verify-full`,
    });
    expect(ok.environment).toBe('production');
  });

  it('rejects non-postgres URLs', () => {
    const e = captureError(() =>
      loadApiConfig({ EVENTHUB_ENV: 'local', DATABASE_APP_URL: 'mysql://x@y/z' }),
    );
    expect(e.keys).toEqual(['DATABASE_APP_URL']);
  });
});

describe('loadWorkerConfig', () => {
  const base = { DATABASE_WORKER_URL: localUrl, EVENT_PUBLISHER: 'in_memory' };

  it('accepts the in-memory publisher locally', () => {
    expect(loadWorkerConfig({ ...base, EVENTHUB_ENV: 'ci' }).eventPublisher).toBe('in_memory');
  });

  it('refuses the non-durable in-memory publisher in production', () => {
    const e = captureError(() =>
      loadWorkerConfig({
        ...base,
        EVENTHUB_ENV: 'production',
        DATABASE_WORKER_URL: `${localUrl}?sslmode=require`,
      }),
    );
    expect(e.keys).toEqual(['EVENT_PUBLISHER']);
  });
});

describe('loadMigratorConfig', () => {
  it('requires the migrator URL', () => {
    expect(() => loadMigratorConfig({ EVENTHUB_ENV: 'local' })).toThrow(ConfigError);
  });
});
