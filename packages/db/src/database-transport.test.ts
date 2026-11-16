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

  /** True when the driver would connect over the network and check the server's certificate. */
  const verified = (c: Resolved) =>
    !c.isDomainSocket &&
    (c.ssl === true ||
      (typeof c.ssl === 'object' &&
        c.ssl !== null &&
        (c.ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized !== false));

  it('whatever the configuration calls TLS, the driver verifies the server (ADR-0061)', () => {
    const net = `postgres://u:${PW}@db.internal/e`;
    const modes = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify'];
    const extras = ['', '&uselibpqcompat=true', '&ssl=0', '&ssl=true', '&host=db2.internal'];
    const urls = [net, `${net}?ssl=true`, `${net}?uselibpqcompat=true&sslmode=prefer`];
    for (const first of modes) {
      for (const extra of extras) urls.push(`${net}?sslmode=${first}${extra}`);
      for (const second of modes) urls.push(`${net}?sslmode=${first}&sslmode=${second}`);
    }
    let accepted = 0;
    for (const url of urls) {
      if (databaseTransport(url) !== 'tls') continue;
      accepted += 1;
      // The driver refuses some combinations outright; an accepted URL must not be one of them.
      expect(verified(driver(url)), url.replace(PW, '***')).toBe(true);
    }
    // Only plain verify-full, with or without another network host.
    expect(accepted).toBe(2);
  });

  it('the refused spellings include ones the driver really would not verify', () => {
    const net = `postgres://u:${PW}@db.internal/e`;
    // Each of these was accepted by the rule before ADR-0061, or looks safe at a glance.
    for (const url of [
      `${net}?sslmode=require&uselibpqcompat=true`,
      `${net}?sslmode=verify-full&sslmode=disable`,
      `${net}?sslmode=verify-full&sslmode=no-verify`,
    ]) {
      expect(verified(driver(url)), url.replace(PW, '***')).toBe(false);
      expect(databaseTransport(url), url.replace(PW, '***')).toBe('insecure');
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
