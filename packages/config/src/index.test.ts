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
    expect(c.auth).toEqual({
      sessionTtlSeconds: 43_200,
      loginMaxFailures: 5,
      loginLockSeconds: 900,
    });
  });

  it('bounds authentication settings', () => {
    const e = captureError(() =>
      loadApiConfig({ EVENTHUB_ENV: 'local', DATABASE_APP_URL: localUrl, LOGIN_MAX_FAILURES: '1' }),
    );
    expect(e.keys).toEqual(['LOGIN_MAX_FAILURES']);
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
  const base = {
    DATABASE_WORKER_URL: localUrl,
    EVENT_PUBLISHER: 'local_dispatch',
    EMAIL_SENDER: 'in_memory',
    APP_BASE_URL: 'http://localhost:3001/',
  };

  it('accepts local adapters locally and normalises the base URL', () => {
    const c = loadWorkerConfig({ ...base, EVENTHUB_ENV: 'ci' });
    expect(c.eventPublisher).toBe('local_dispatch');
    expect(c.appBaseUrl).toBe('http://localhost:3001');
    expect(c.emailVerificationTtlSeconds).toBe(86_400);
  });

  it('refuses local-only adapters in staging and production', () => {
    for (const env of ['staging', 'production']) {
      const e = captureError(() =>
        loadWorkerConfig({
          ...base,
          EVENTHUB_ENV: env,
          DATABASE_WORKER_URL: `${localUrl}?sslmode=require`,
        }),
      );
      expect(e.keys).toEqual(['EVENT_PUBLISHER', 'EMAIL_SENDER']);
    }
  });

  it('requires a directory for the local file email sender', () => {
    const e = captureError(() =>
      loadWorkerConfig({ ...base, EVENTHUB_ENV: 'local', EMAIL_SENDER: 'local_file' }),
    );
    expect(e.keys).toEqual(['EMAIL_LOCAL_DIR']);
  });

  it('requires an http(s) application base URL', () => {
    const e = captureError(() =>
      loadWorkerConfig({ ...base, EVENTHUB_ENV: 'local', APP_BASE_URL: 'javascript:alert(1)' }),
    );
    expect(e.keys).toEqual(['APP_BASE_URL']);
  });
});

describe('loadMigratorConfig', () => {
  it('requires the migrator URL', () => {
    expect(() => loadMigratorConfig({ EVENTHUB_ENV: 'local' })).toThrow(ConfigError);
  });
});
