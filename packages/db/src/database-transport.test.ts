import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { databaseTransport } from '@eventhub/config';

/**
 * The configuration's judgement of a database URL (ADR-0057) must match what the driver actually
 * does with it. This asks the driver itself, so a change in its URL parsing fails here.
 */
const PW = `marker-${'x'.repeat(24)}`;
const SOCKET = '/cloudsql/event-hub-2b58e:asia-southeast1:eventhub-staging';
/** What the driver resolved the URL to. Present at runtime; not in the driver's published types. */
type Resolved = {
  host: string;
  port: number;
  user: string;
  database: string;
  ssl: unknown;
  isDomainSocket: boolean;
};
const driver = (url: string) =>
  (new pg.Client({ connectionString: url }) as unknown as { connectionParameters: Resolved })
    .connectionParameters;

describe('database transport: configuration and driver agree', () => {
  it('the accepted socket form connects to that socket, without TLS', () => {
    const url = `postgres://eventhub_app:${PW}@localhost/eventhub?host=${SOCKET}`;
    expect(databaseTransport(url)).toBe('cloud_sql_socket');
    const c = driver(url);
    expect(c.isDomainSocket).toBe(true);
    expect(c.host).toBe(SOCKET);
    expect(c.ssl).toBe(false);
    expect(c.user).toBe('eventhub_app');
    expect(c.database).toBe('eventhub');
  });

  it('whatever the configuration calls TLS, the driver connects over the network with TLS', () => {
    for (const url of [
      `postgres://u:${PW}@db.internal:5432/e?sslmode=require`,
      `postgres://u:${PW}@db.internal/e?sslmode=verify-full`,
      `postgres://u:${PW}@10.0.0.5/e?host=db.internal&sslmode=verify-full`,
    ]) {
      expect(databaseTransport(url), url.replace(PW, '***')).toBe('tls');
      const c = driver(url);
      expect(c.isDomainSocket).toBe(false);
      expect(c.ssl).toBeTruthy();
    }
  });

  it('every spelling the driver would send to a socket is refused, except the accepted one', () => {
    const spellings = [
      `postgres://u:${PW}@%2Fcloudsql%2Fp-12345%3Aasia-southeast1%3Adb/e`,
      `postgres://u:${PW}@localhost/e?host=/var/run/postgresql`,
      `postgres://u:${PW}@localhost/e?host=${SOCKET}&sslmode=require`,
      `postgres://u:${PW}@db.internal/e?host=${SOCKET}`,
    ];
    for (const url of spellings) {
      expect(driver(url).isDomainSocket, url.replace(PW, '***')).toBe(true);
      expect(databaseTransport(url), url.replace(PW, '***')).toBe('insecure');
    }
  });

  it('a host parameter replaces the URL host, which is why the configuration judges by it', () => {
    expect(driver(`postgres://u:${PW}@10.0.0.5/e?host=db.internal`).host).toBe('db.internal');
    expect(databaseTransport(`postgres://u:${PW}@10.0.0.5/e?host=db.internal`)).toBe('insecure');
  });
});
