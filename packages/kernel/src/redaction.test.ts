import { describe, expect, it } from 'vitest';
import {
  LOG_CENSOR,
  isSensitiveLogKey,
  redactLogLine,
  redactLogValue,
  scrubLogText,
} from './redaction.ts';

const MARK = `marker-${'x'.repeat(24)}`;

describe('sensitive field names (ADR-0060)', () => {
  it('recognises a credential however the name is spelled', () => {
    for (const key of [
      'password',
      'newPassword',
      'EVENTHUB_APP_PASSWORD',
      'token',
      'resetToken',
      'session-token',
      'secret',
      'emailWebhookSecret',
      'RESEND_WEBHOOK_SECRET',
      'apiKey',
      'RESEND_API_KEY',
      'x-api-key',
      'secretKey',
      'MFA_ENCRYPTION_KEY',
      'visitorAddressKey',
      'Authorization',
      'set-cookie',
      'Cookie',
      'email',
      'recipients',
      'body',
      'x-eventhub-visitor',
      'recoveryCodes',
      'credentials',
    ]) {
      expect(isSensitiveLogKey(key), key).toBe(true);
    }
  });

  it('leaves ordinary names alone, including ones that only look close', () => {
    for (const key of [
      'emailSender',
      'emailVerified',
      'tokens_remaining_count',
      'key',
      'idempotencyKey',
      'objectKey',
      'published',
      'correlationId',
      'url',
      'passwordless',
      'secretive',
      'bodyLimit',
      'cookies_enabled',
    ]) {
      expect(isSensitiveLogKey(key), key).toBe(false);
    }
  });
});

describe('redactLogValue', () => {
  it('redacts at any depth, inside arrays too', () => {
    const input = {
      a: { b: { c: { d: { e: { password: MARK } } } } },
      list: [{ token: MARK }, [{ apiKey: MARK }]],
      config: { mail: { resend: { apiKey: MARK } }, object: { supabase: { secretKey: MARK } } },
      keep: { name: 'visible', count: 3, nested: { ok: true } },
    };
    const out = redactLogValue(input);
    expect(JSON.stringify(out)).not.toContain(MARK);
    expect(out).toEqual({
      a: { b: { c: { d: { e: { password: LOG_CENSOR } } } } },
      list: [{ token: LOG_CENSOR }, [{ apiKey: LOG_CENSOR }]],
      config: {
        mail: { resend: { apiKey: LOG_CENSOR } },
        object: { supabase: { secretKey: LOG_CENSOR } },
      },
      keep: { name: 'visible', count: 3, nested: { ok: true } },
    });
  });

  it('redacts a whole sensitive value, whatever its type', () => {
    const out = redactLogValue({
      body: { anything: MARK },
      recipients: [MARK, MARK],
      token: 12345,
      password: null,
      secret: undefined,
    }) as Record<string, unknown>;
    expect(out.body).toBe(LOG_CENSOR);
    expect(out.recipients).toBe(LOG_CENSOR);
    expect(out.token).toBe(LOG_CENSOR);
    // Nothing to hide: "not set" stays visible, which is useful when reading logs.
    expect(out.password).toBeNull();
    expect(out.secret).toBeUndefined();
  });

  it('never changes what it was given', () => {
    const input = { user: { password: MARK }, list: [{ token: MARK }] };
    const before = JSON.stringify(input);
    redactLogValue(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('survives cycles and very deep values without leaking', () => {
    const loop: Record<string, unknown> = { password: MARK, name: 'loop' };
    loop.self = loop;
    loop.again = { inner: loop };
    const out = redactLogValue(loop) as Record<string, unknown>;
    expect(out.self).toBe('[CIRCULAR]');
    expect(JSON.stringify(out)).not.toContain(MARK);

    let deep: Record<string, unknown> = { password: MARK };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    const flat = JSON.stringify(redactLogValue(deep));
    expect(flat).not.toContain(MARK);
    expect(flat).toContain('[TRUNCATED]');

    // The same object in two places is not a cycle.
    const shared = { name: 'shared' };
    expect(redactLogValue({ a: shared, b: shared })).toEqual({ a: shared, b: shared });
  });

  it('passes simple values, dates and binary data through', () => {
    const date = new Date('2026-11-16T00:00:00Z');
    const bytes = Buffer.from('abc');
    expect(redactLogValue('text')).toBe('text');
    expect(redactLogValue(7)).toBe(7);
    expect(redactLogValue(null)).toBeNull();
    expect(redactLogValue({ at: date, bytes })).toEqual({ at: date, bytes });
  });
});

describe('scrubLogText', () => {
  it('removes the password from a URL and keeps the rest', () => {
    expect(
      scrubLogText(`connect postgres://eventhub_app:${MARK}@db.internal:5432/eventhub failed`),
    ).toBe(`connect postgres://eventhub_app:${LOG_CENSOR}@db.internal:5432/eventhub failed`);
    expect(scrubLogText(`https://user:${MARK}@example.com/path`)).not.toContain(MARK);
    // The Cloud SQL socket form (ADR-0057).
    expect(
      scrubLogText(`postgres://eventhub_app:${MARK}@localhost/eventhub?host=/cloudsql/p:r:i`),
    ).toBe(`postgres://eventhub_app:${LOG_CENSOR}@localhost/eventhub?host=/cloudsql/p:r:i`);
    // A port is not a password.
    expect(scrubLogText('http://127.0.0.1:8080/health/ready')).toBe(
      'http://127.0.0.1:8080/health/ready',
    );
    expect(scrubLogText('https://example.com:8443/a@b')).toBe('https://example.com:8443/a@b');
  });

  it('removes secret query parameters and bearer tokens', () => {
    expect(scrubLogText(`/v1/cancel?token=${MARK}&lang=en`)).toBe(
      `/v1/cancel?token=${LOG_CENSOR}&lang=en`,
    );
    expect(scrubLogText(`/reset?lang=en&reset_token=${MARK}`)).toBe(
      `/reset?lang=en&reset_token=${LOG_CENSOR}`,
    );
    expect(scrubLogText(`/x?code=${MARK}#top`)).toBe(`/x?code=${LOG_CENSOR}#top`);
    expect(scrubLogText(`/x?api_key=${MARK}`)).not.toContain(MARK);
    expect(scrubLogText(`header was Bearer ${MARK}`)).toBe(`header was Bearer ${LOG_CENSOR}`);
    expect(scrubLogText('/v1/events?page=2&status=draft')).toBe('/v1/events?page=2&status=draft');
  });

  it('masks email addresses wherever they appear', () => {
    expect(scrubLogText('Key (email)=(ada.lovelace@example.com) already exists.')).toBe(
      'Key (email)=(a***@example.com) already exists.',
    );
    expect(scrubLogText('to grace@mail.example.co.uk and bob@example.org')).toBe(
      'to g***@mail.example.co.uk and b***@example.org',
    );
    expect(scrubLogText('no address here: a @ b')).toBe('no address here: a @ b');
    // Package paths in stack traces are not addresses.
    const frame =
      'at /app/node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.1/node_modules/pg-pool/index.js:45:11';
    expect(scrubLogText(frame)).toBe(frame);
    expect(scrubLogText('pnpm@10.28.0 and @eventhub/kernel')).toBe(
      'pnpm@10.28.0 and @eventhub/kernel',
    );
  });

  it('keeps a line of JSON valid', () => {
    const line = JSON.stringify({
      level: 30,
      msg: `failed for ada@example.com at postgres://u:${MARK}@h/db "quoted" back\\slash`,
      req: { url: `/v1/cancel?token=${MARK}` },
      err: { stack: `Error: x\n    at https://u:${MARK}@h/a.js:1:1` },
    });
    const scrubbed = scrubLogText(line);
    expect(scrubbed).not.toContain(MARK);
    expect(scrubbed).not.toContain('ada@');
    const parsed = JSON.parse(scrubbed) as { msg: string; req: { url: string } };
    expect(parsed.msg).toContain('"quoted" back\\slash');
    expect(parsed.req.url).toBe(`/v1/cancel?token=${LOG_CENSOR}`);
  });
});

describe('redactLogLine', () => {
  it('redacts names and text in one finished line, and keeps it one line of JSON', () => {
    const line = `${JSON.stringify({
      level: 30,
      req: { url: `/v1/cancel?token=${MARK}`, headers: { 'set-cookie': MARK } },
      child: { deep: { settings: { resetToken: MARK } } },
      msg: `sent to ada@example.com`,
    })}\n`;
    const out = redactLogLine(line);
    expect(out).not.toContain(MARK);
    expect(out.endsWith('\n')).toBe(true);
    expect(out.trimEnd().includes('\n')).toBe(false);
    expect(JSON.parse(out)).toEqual({
      level: 30,
      req: { url: `/v1/cancel?token=${LOG_CENSOR}`, headers: { 'set-cookie': LOG_CENSOR } },
      child: { deep: { settings: { resetToken: LOG_CENSOR } } },
      msg: 'sent to a***@example.com',
    });
  });

  it('still scrubs a line that is not JSON', () => {
    expect(redactLogLine(`plain text with postgres://u:${MARK}@h/db\n`)).toBe(
      `plain text with postgres://u:${LOG_CENSOR}@h/db\n`,
    );
  });
});
