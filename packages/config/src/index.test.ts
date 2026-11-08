import { describe, expect, it } from 'vitest';
import { ConfigError, loadApiConfig, loadMigratorConfig, loadWorkerConfig } from './index.ts';

// Leak-detection sentinel, not a credential.
const SECRET = 'S3cr3t-should-never-appear'; // pragma: allowlist secret
const localUrl = `postgres://eventhub_app:${SECRET}@localhost:5432/eventhub`;
const MFA_KEY = Buffer.alloc(32, 3).toString('base64');

function captureError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error('expected ConfigError');
}

describe('loadApiConfig: MFA key (ADR-0022)', () => {
  const key = Buffer.alloc(32, 9).toString('base64');
  it('is optional locally and decoded when present', () => {
    expect(loadApiConfig({ EVENTHUB_ENV: 'local', DATABASE_APP_URL: localUrl }).mfa).toEqual({
      encryptionKey: null,
    });
    const c = loadApiConfig({
      EVENTHUB_ENV: 'local',
      DATABASE_APP_URL: localUrl,
      MFA_ENCRYPTION_KEY: key,
    });
    expect(c.mfa.encryptionKey).toEqual(Buffer.alloc(32, 9));
  });

  it('must be 32 bytes, and never echoes the value', () => {
    const bad = Buffer.from(SECRET).toString('base64');
    const e = captureError(() =>
      loadApiConfig({ EVENTHUB_ENV: 'local', DATABASE_APP_URL: localUrl, MFA_ENCRYPTION_KEY: bad }),
    );
    expect(e.keys).toEqual(['MFA_ENCRYPTION_KEY']);
    expect(e.message).not.toContain(bad);
  });

  it('is required in staging and production', () => {
    const remoteUrl = `postgres://eventhub_app:${SECRET}@db.internal:5432/eventhub?sslmode=require`;
    for (const env of ['staging', 'production']) {
      const e = captureError(() =>
        loadApiConfig({ EVENTHUB_ENV: env, DATABASE_APP_URL: remoteUrl, TRUST_PROXY: '10.0.0.1' }),
      );
      expect(e.keys).toEqual(['MFA_ENCRYPTION_KEY']);
    }
  });
});

describe('loadApiConfig', () => {
  it('parses a valid local configuration with defaults', () => {
    const c = loadApiConfig({ EVENTHUB_ENV: 'local', DATABASE_APP_URL: localUrl });
    expect(c.environment).toBe('local');
    expect(c.http).toEqual({ host: '127.0.0.1', port: 3000, trustProxy: false });
    expect(c.logLevel).toBe('info');
    expect(c.invitations).toEqual({ ttlSeconds: 7 * 24 * 3600 });
    expect(c.auth).toEqual({
      sessionTtlSeconds: 43_200,
      sessionIdleSeconds: 3_600,
      loginMaxFailures: 5,
      loginLockSeconds: 900,
    });
  });

  it('bounds the idle session timeout (15 minutes to 24 hours)', () => {
    const base = { EVENTHUB_ENV: 'local', DATABASE_APP_URL: localUrl };
    expect(loadApiConfig({ ...base, SESSION_IDLE_MINUTES: '30' }).auth.sessionIdleSeconds).toBe(
      1_800,
    );
    for (const bad of ['10', '1441', 'forever']) {
      expect(
        captureError(() => loadApiConfig({ ...base, SESSION_IDLE_MINUTES: bad })).keys,
      ).toEqual(['SESSION_IDLE_MINUTES']);
    }
  });

  it('trusts only listed proxies remotely', () => {
    const tls = `${localUrl}?sslmode=require`;
    expect(
      loadApiConfig({
        EVENTHUB_ENV: 'production',
        DATABASE_APP_URL: tls,
        TRUST_PROXY: '10.0.0.0/8, 192.168.1.5',
        MFA_ENCRYPTION_KEY: MFA_KEY,
      }).http.trustProxy,
    ).toEqual(['10.0.0.0/8', '192.168.1.5']);
    expect(
      captureError(() =>
        loadApiConfig({ EVENTHUB_ENV: 'production', DATABASE_APP_URL: tls, TRUST_PROXY: 'true' }),
      ).keys,
    ).toEqual(['TRUST_PROXY']);
    expect(
      loadApiConfig({ EVENTHUB_ENV: 'local', DATABASE_APP_URL: localUrl, TRUST_PROXY: 'true' }).http
        .trustProxy,
    ).toBe(true);
    expect(
      captureError(() =>
        loadApiConfig({
          EVENTHUB_ENV: 'local',
          DATABASE_APP_URL: localUrl,
          TRUST_PROXY: 'evil.example',
        }),
      ).keys,
    ).toEqual(['TRUST_PROXY']);
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
      MFA_ENCRYPTION_KEY: MFA_KEY,
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
    EVENT_PUBLISHER: 'postgres_outbox',
    EMAIL_SENDER: 'in_memory',
    APP_BASE_URL: 'http://localhost:3001/',
    EMAIL_TOKEN_SECRET: 'x'.repeat(32),
  };

  it('accepts local adapters locally and normalises the base URL', () => {
    const c = loadWorkerConfig({ ...base, EVENTHUB_ENV: 'ci' });
    expect(c.eventPublisher).toBe('postgres_outbox');
    expect(c.outbox).toEqual({
      pollIntervalMs: 1000,
      batchSize: 50,
      maxAttempts: 12,
      healthIntervalMs: 60_000,
      lagWarnSeconds: 300,
    });
    expect(c.appBaseUrl).toBe('http://localhost:3001');
    expect(c.emailVerificationTtlSeconds).toBe(86_400);
    expect(c.passwordResetTtlSeconds).toBe(3_600);
  });

  it('requires a token secret of at least 32 characters', () => {
    const e = captureError(
      () => loadWorkerConfig({ ...base, EVENTHUB_ENV: 'local', EMAIL_TOKEN_SECRET: 'short' }), // pragma: allowlist secret
    );
    expect(e.keys).toEqual(['EMAIL_TOKEN_SECRET']);
    expect(e.message).not.toContain('short');
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
      expect(e.keys).toEqual(['EMAIL_SENDER', 'APP_BASE_URL']);
    }
  });

  describe('resend', () => {
    // Deliberately low-entropy fixture so secret scanners never mistake it for a real key.
    const API_KEY = `re_${'x'.repeat(24)}`;
    const resend = {
      ...base,
      EVENTHUB_ENV: 'local',
      EMAIL_SENDER: 'resend',
      RESEND_API_KEY: API_KEY,
      EMAIL_FROM: 'EventHub OS <no-reply@mail.example.test>',
    };

    it('loads Resend settings with safe defaults', () => {
      expect(loadWorkerConfig(resend).email).toEqual({
        sender: 'resend',
        localDir: undefined,
        resend: {
          apiKey: API_KEY,
          from: 'EventHub OS <no-reply@mail.example.test>',
          baseUrl: 'https://api.resend.com',
          timeoutMs: 10_000,
        },
      });
    });

    it('requires an API key and a sender address', () => {
      const e = captureError(() =>
        loadWorkerConfig({ ...resend, RESEND_API_KEY: undefined, EMAIL_FROM: undefined }),
      );
      expect(e.keys).toEqual(['RESEND_API_KEY', 'EMAIL_FROM']);
    });

    it('rejects a malformed sender address', () => {
      const e = captureError(() => loadWorkerConfig({ ...resend, EMAIL_FROM: 'not an address' }));
      expect(e.keys).toEqual(['EMAIL_FROM']);
    });

    it('a complete production worker configuration loads (ADR-0009)', () => {
      const c = loadWorkerConfig({
        ...resend,
        EVENTHUB_ENV: 'production',
        DATABASE_WORKER_URL: `${localUrl}?sslmode=verify-full`,
        APP_BASE_URL: 'https://app.eventhub.example',
      });
      expect(c.environment).toBe('production');
      expect(c.eventPublisher).toBe('postgres_outbox');
      expect(c.email.sender).toBe('resend');
    });

    it('still refuses local email adapters in production', () => {
      const e = captureError(() =>
        loadWorkerConfig({
          ...resend,
          EMAIL_SENDER: 'in_memory',
          EVENTHUB_ENV: 'production',
          DATABASE_WORKER_URL: `${localUrl}?sslmode=verify-full`,
          APP_BASE_URL: 'https://app.eventhub.example',
        }),
      );
      expect(e.keys).toEqual(['EMAIL_SENDER']);
    });

    it('requires HTTPS for the Resend endpoint remotely', () => {
      const e = captureError(() =>
        loadWorkerConfig({
          ...resend,
          EVENTHUB_ENV: 'staging',
          DATABASE_WORKER_URL: `${localUrl}?sslmode=require`,
          APP_BASE_URL: 'https://app.eventhub.example',
          RESEND_BASE_URL: 'http://insecure.example',
        }),
      );
      expect(e.keys).toContain('RESEND_BASE_URL');
    });
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
