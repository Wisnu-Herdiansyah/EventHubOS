import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { LOG_REDACT_PATHS } from '@eventhub/kernel';

/** Logs one line with the production redaction paths and returns what was written. */
function logged(obj: Record<string, unknown>): string {
  let out = '';
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      out += chunk.toString();
      done();
    },
  });
  pino({ redact: { paths: [...LOG_REDACT_PATHS], censor: '[REDACTED]' } }, sink).info(obj, 'x');
  return out;
}

describe('log redaction of provider keys (ADR-0054)', () => {
  const key = `marker-${'x'.repeat(32)}`;

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
});

describe('log redaction of nested sensitive fields', () => {
  // pino's `*` matches exactly one level, so each depth has its own path in LOG_REDACT_PATHS.
  const fields = ['password', 'token', 'secret', 'email', 'recipients', 'secretKey', 'apiKey'];
  const nest = (depth: number, leaf: Record<string, unknown>): Record<string, unknown> =>
    depth === 0 ? leaf : { [`level${depth}`]: nest(depth - 1, leaf) };

  for (const field of fields) {
    for (const depth of [1, 2, 3]) {
      it(`hides ${field} nested ${depth} level${depth === 1 ? '' : 's'} deep`, () => {
        const value = `marker-${field}-${depth}-${'x'.repeat(24)}`;
        // `recipients` arrives as a list of addresses; the whole list must go.
        const leaf = { [field]: field === 'recipients' ? [value] : value, kept: 'visible' };
        const line = logged(nest(depth, leaf));
        expect(line).not.toContain(value);
        expect(line).toContain('[REDACTED]');
        // Siblings stay readable: the path hides the field, not the object around it.
        expect(line).toContain('"kept":"visible"');
      });
    }
  }

  it('leaves a masked address logged under another key name readable', () => {
    const line = logged({ invitation: { to: 'a***@example.com', role: 'admin' } });
    expect(line).toContain('a***@example.com');
    expect(line).not.toContain('[REDACTED]');
  });
});
