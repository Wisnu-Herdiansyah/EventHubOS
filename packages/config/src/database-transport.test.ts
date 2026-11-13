import { describe, expect, it } from 'vitest';
import {
  databaseTransport,
  loadApiConfig,
  loadMigratorConfig,
  loadWorkerConfig,
  ConfigError,
} from './index.ts';

// Not a password: a marker, so tests can prove it never appears in an error.
const PW = `marker-${'x'.repeat(24)}`;
const SOCKET = '/cloudsql/event-hub-2b58e:asia-southeast1:eventhub-staging';
const socketUrl = (role: string) => `postgres://${role}:${PW}@localhost/eventhub?host=${SOCKET}`;

describe('databaseTransport (ADR-0057)', () => {
  it('accepts verified TLS to a network address', () => {
    for (const mode of ['require', 'verify-ca', 'verify-full']) {
      expect(databaseTransport(`postgres://u:${PW}@db.internal:5432/e?sslmode=${mode}`)).toBe(
        'tls',
      );
    }
    // A `host` parameter naming another network host is still TLS.
    expect(
      databaseTransport(`postgres://u:${PW}@10.0.0.5/e?host=db.internal&sslmode=verify-full`),
    ).toBe('tls');
  });

  it('accepts exactly the canonical Cloud SQL socket form', () => {
    expect(databaseTransport(socketUrl('eventhub_app'))).toBe('cloud_sql_socket');
    expect(
      databaseTransport(`postgres://u:${PW}@localhost/e?host=/cloudsql/my-proj-1:europe-west4:db1`),
    ).toBe('cloud_sql_socket');
  });

  it('refuses everything else', () => {
    const cases: Record<string, string> = {
      'no sslmode on a network address': `postgres://u:${PW}@db.internal/e`,
      'sslmode=disable': `postgres://u:${PW}@db.internal/e?sslmode=disable`,
      'sslmode=prefer': `postgres://u:${PW}@db.internal/e?sslmode=prefer`,
      'network host parameter without TLS': `postgres://u:${PW}@localhost/e?host=db.internal`,
      'another socket directory': `postgres://u:${PW}@localhost/e?host=/var/run/postgresql`,
      'a path that only starts like Cloud SQL': `postgres://u:${PW}@localhost/e?host=/cloudsql/../tmp/x:y1:z`,
      'socket with a trailing path': `postgres://u:${PW}@localhost/e?host=${SOCKET}/extra`,
      'malformed instance name': `postgres://u:${PW}@localhost/e?host=/cloudsql/proj:asia-southeast1`,
      'uppercase instance name': `postgres://u:${PW}@localhost/e?host=/cloudsql/Proj-123:asia-southeast1:db`,
      'socket that also asks for TLS': `${socketUrl('u')}&sslmode=require`,
      'socket with ssl=true': `${socketUrl('u')}&ssl=true`,
      'socket with a port parameter': `${socketUrl('u')}&port=6543`,
      'socket with a URL port': `postgres://u:${PW}@localhost:5433/e?host=${SOCKET}`,
      'socket with a real host in the URL': `postgres://u:${PW}@db.internal/e?host=${SOCKET}`,
      'two host parameters': `${socketUrl('u')}&host=db.internal`,
      'socket percent-encoded into the host': `postgres://u:${PW}@%2Fcloudsql%2Fp-12345%3Aasia-southeast1%3Adb/e`,
      'encoded socket with TLS': `postgres://u:${PW}@%2Ftmp%2Fx/e?sslmode=require`,
    };
    for (const [name, url] of Object.entries(cases)) {
      expect(databaseTransport(url), name).toBe('insecure');
    }
  });
});

describe('staging and production accept the Cloud SQL socket for every database role', () => {
  const MFA_KEY = Buffer.alloc(32, 7).toString('base64');
  const worker = {
    EVENT_PUBLISHER: 'postgres_outbox',
    EMAIL_SENDER: 'resend',
    EMAIL_FROM: 'EventHub <no-reply@example.test>',
    RESEND_API_KEY: 'x'.repeat(24),
    APP_BASE_URL: 'https://admin.example.test',
    EMAIL_TOKEN_SECRET: 'x'.repeat(32),
  };

  it.each(['staging', 'production'])('%s', (env) => {
    expect(
      loadApiConfig({
        EVENTHUB_ENV: env,
        DATABASE_APP_URL: socketUrl('eventhub_app'),
        MFA_ENCRYPTION_KEY: MFA_KEY,
      }).database.appUrl,
    ).toBe(socketUrl('eventhub_app'));
    expect(
      loadWorkerConfig({
        EVENTHUB_ENV: env,
        DATABASE_WORKER_URL: socketUrl('eventhub_worker'),
        ...worker,
      }).database.workerUrl,
    ).toBe(socketUrl('eventhub_worker'));
    expect(
      loadMigratorConfig({
        EVENTHUB_ENV: env,
        DATABASE_MIGRATOR_URL: socketUrl('eventhub_migrator'),
      }).database.migratorUrl,
    ).toBe(socketUrl('eventhub_migrator'));
  });

  it('still refuse other sockets and plain connections, without echoing the URL', () => {
    for (const url of [
      `postgres://eventhub_app:${PW}@localhost/eventhub?host=/var/run/postgresql`,
      `postgres://eventhub_app:${PW}@db.internal/eventhub`,
      `${socketUrl('eventhub_app')}&sslmode=require`,
    ]) {
      let error: unknown;
      try {
        loadApiConfig({
          EVENTHUB_ENV: 'staging',
          DATABASE_APP_URL: url,
          MFA_ENCRYPTION_KEY: MFA_KEY,
        });
      } catch (e) {
        error = e;
      }
      expect(error, url.replace(PW, '***')).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).keys).toEqual(['DATABASE_APP_URL']);
      expect((error as ConfigError).message).not.toContain(PW);
      expect((error as ConfigError).message).toContain('ADR-0057');
    }
  });

  it('do not change local and CI, where any transport is allowed', () => {
    expect(
      loadApiConfig({
        EVENTHUB_ENV: 'local',
        DATABASE_APP_URL: `postgres://eventhub_app:${PW}@localhost/eventhub?host=/var/run/postgresql`,
      }).database.appUrl,
    ).toContain('/var/run/postgresql');
  });
});
