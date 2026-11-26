import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryBreachedPasswordChecker } from '@eventhub/kernel';
import { breachedPasswordCheckerContract } from '@eventhub/kernel/testing';
import { PwnedPasswordsChecker } from './adapters/pwned-passwords-checker.ts';

const BREACHED = 'password1234';
const CLEAR = 'Systematic elegance, quietly 2027';

const sha1 = (s: string) => createHash('sha1').update(s, 'utf8').digest('hex').toUpperCase();

interface Call {
  url: string;
  headers: Record<string, string>;
}

/**
 * A stand-in for the range API: answers every prefix with padding entries (count 0), and lists
 * the breached password's suffix with a real count. The clear password's suffix appears too,
 * but only as padding, so treating padding as a match would be caught.
 */
function standIn(calls: Call[] = []): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const prefix = url.slice(-5);
    const lines = [`${'0'.repeat(35)}:0`, `${'F'.repeat(35)}:0`];
    if (sha1(BREACHED).startsWith(prefix)) lines.push(`${sha1(BREACHED).slice(5)}:2413945`);
    if (sha1(CLEAR).startsWith(prefix)) lines.push(`${sha1(CLEAR).slice(5)}:0`);
    return Promise.resolve(new Response(lines.join('\r\n'), { status: 200 }));
  };
}
const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));

breachedPasswordCheckerContract('pwned_passwords (stand-in)', () =>
  Promise.resolve({
    checker: new PwnedPasswordsChecker({ fetch: standIn() }),
    breached: BREACHED,
    clear: CLEAR,
    unavailable: () => new PwnedPasswordsChecker({ fetch: down }),
  }),
);

breachedPasswordCheckerContract('in_memory', () => {
  const checker = new InMemoryBreachedPasswordChecker();
  return Promise.resolve({
    checker,
    breached: BREACHED,
    clear: CLEAR,
    unavailable: () => {
      const c = new InMemoryBreachedPasswordChecker();
      c.setUnavailable(true);
      return c;
    },
  });
});

describe('PwnedPasswordsChecker', () => {
  it('sends only the first 5 characters of the hash, with padding asked for', async () => {
    const calls: Call[] = [];
    await new PwnedPasswordsChecker({ fetch: standIn(calls) }).check(BREACHED);
    expect(calls).toHaveLength(1);
    const { url, headers } = calls[0]!;
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${sha1(BREACHED).slice(0, 5)}`);
    const sent = JSON.stringify(calls);
    expect(sent).not.toContain(BREACHED);
    expect(sent).not.toContain(sha1(BREACHED).slice(5));
    expect(headers['Add-Padding']).toBe('true');
  });

  it('uses the configured address', async () => {
    const calls: Call[] = [];
    await new PwnedPasswordsChecker({
      fetch: standIn(calls),
      baseUrl: 'https://range.example.test/',
    }).check(CLEAR);
    expect(calls[0]!.url).toMatch(/^https:\/\/range\.example\.test\/range\/[0-9A-F]{5}$/);
  });

  it('says why a check could not be made, without the password', async () => {
    const reasons: string[] = [];
    const onUnavailable = (r: string) => reasons.push(r);
    const failing =
      (status: number): typeof fetch =>
      () =>
        Promise.resolve(new Response('', { status }));
    const timeout: typeof fetch = () =>
      Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    expect(
      await new PwnedPasswordsChecker({ fetch: failing(503), onUnavailable }).check(BREACHED),
    ).toBe('unknown');
    expect(
      await new PwnedPasswordsChecker({ fetch: failing(429), onUnavailable }).check(BREACHED),
    ).toBe('unknown');
    expect(await new PwnedPasswordsChecker({ fetch: timeout, onUnavailable }).check(BREACHED)).toBe(
      'unknown',
    );
    expect(await new PwnedPasswordsChecker({ fetch: down, onUnavailable }).check(BREACHED)).toBe(
      'unknown',
    );
    expect(reasons).toEqual(['status', 'status', 'timeout', 'error']);
  });

  it('gives up after its timeout', async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error));
      });
    const started = Date.now();
    const result = await new PwnedPasswordsChecker({ fetch: hang, timeoutMs: 50 }).check(CLEAR);
    expect(result).toBe('unknown');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('matches suffixes whatever their case', async () => {
    const lower: typeof fetch = () =>
      Promise.resolve(new Response(`${sha1(BREACHED).slice(5).toLowerCase()}:3`, { status: 200 }));
    expect(await new PwnedPasswordsChecker({ fetch: lower }).check(BREACHED)).toBe('breached');
  });
});
