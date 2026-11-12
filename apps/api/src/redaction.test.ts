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
