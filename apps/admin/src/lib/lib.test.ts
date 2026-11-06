import { describe, expect, it } from 'vitest';
import { clientIpFromForwarded } from './client-ip';
import { buildCsp, newNonce } from './csp';
import { ApiError, errorToFormState, fieldName } from './errors';
import { safeNext } from './redirect';
import { formText, submittedValues } from './form-data';
import { formatInZone, isoToZonedLocal, zonedLocalToIso } from './time';

describe('safeNext (open-redirect protection)', () => {
  it('allows local paths', () => {
    expect(safeNext('/orgs/123?tab=events')).toBe('/orgs/123?tab=events');
  });

  it('rejects absolute, protocol-relative and tricky targets', () => {
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'evil',
      '',
      '/a\u0000b',
      '/x\nLocation: y',
      undefined,
      42,
      '/' + 'a'.repeat(600),
    ]) {
      expect(safeNext(bad), String(bad)).toBe('/');
    }
  });
});

describe('time-zone conversion', () => {
  it('converts event wall time to instants and back', () => {
    expect(zonedLocalToIso('2027-05-10T09:00', 'Asia/Jakarta')).toBe('2027-05-10T02:00:00.000Z');
    expect(isoToZonedLocal('2027-05-10T02:00:00.000Z', 'Asia/Jakarta')).toBe('2027-05-10T09:00');
    expect(zonedLocalToIso('2027-01-15T12:30', 'UTC')).toBe('2027-01-15T12:30:00.000Z');
  });

  it('handles daylight-saving time on both sides of the change', () => {
    // New York: EST (UTC-5) in January, EDT (UTC-4) in July.
    expect(zonedLocalToIso('2027-01-15T09:00', 'America/New_York')).toBe(
      '2027-01-15T14:00:00.000Z',
    );
    expect(zonedLocalToIso('2027-07-15T09:00', 'America/New_York')).toBe(
      '2027-07-15T13:00:00.000Z',
    );
    expect(isoToZonedLocal('2027-07-15T13:00:00.000Z', 'America/New_York')).toBe(
      '2027-07-15T09:00',
    );
  });

  it('rejects malformed input and formats in the event zone', () => {
    expect(zonedLocalToIso('10/05/2027 09:00', 'UTC')).toBeNull();
    expect(formatInZone('2027-05-10T02:00:00.000Z', 'Asia/Jakarta')).toContain('09:00');
  });
});

describe('API error mapping', () => {
  const body = {
    error: {
      code: 'validation_failed',
      message: 'Invalid request body.',
      retryable: false,
      correlationId: 'corr-1',
      details: {
        fields: [{ path: 'body.settings.legal.privacyPolicyUrl', message: 'Invalid URL' }],
      },
    },
  };

  it('maps API field paths to form field names and keeps the reference', () => {
    expect(fieldName('body.settings.legal.privacyPolicyUrl')).toBe('privacyPolicyUrl');
    expect(errorToFormState(new ApiError(400, body))).toEqual({
      ok: false,
      message: 'Check the highlighted fields.',
      fields: { privacyPolicyUrl: 'Invalid URL' },
      reference: 'corr-1',
    });
  });

  it('never exposes unexpected errors to the browser', () => {
    expect(errorToFormState(new Error('ECONNREFUSED 10.0.0.5:5432 password=hunter2'))).toEqual({
      ok: false,
      message: 'Something went wrong. Please try again.',
    });
  });

  it('tolerates non-standard error bodies', () => {
    const e = new ApiError(502, '<html>bad gateway</html>');
    expect(e.code).toBe('unknown_error');
    expect(e.message).toBe('Request failed (HTTP 502).');
  });
});

describe('content security policy', () => {
  it('requires a nonce, forbids framing and plugins, and only allows eval in development', () => {
    const prod = buildCsp('abc', { development: false, https: true });
    expect(prod).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(prod).toContain("frame-ancestors 'none'");
    expect(prod).toContain("object-src 'none'");
    expect(prod).toContain('upgrade-insecure-requests');
    expect(prod).not.toContain('unsafe-eval');
    expect(prod).not.toContain('unsafe-inline');
    expect(buildCsp('abc', { development: true, https: false })).toContain("'unsafe-eval'");
    expect(buildCsp('abc', { development: false, https: false })).not.toContain(
      'upgrade-insecure-requests',
    );
  });

  it('generates unpredictable nonces', () => {
    const a = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newNonce()).not.toBe(a);
  });
});

describe('formText', () => {
  it('returns trimmed strings and ignores file parts', () => {
    const form = new FormData();
    form.set('name', '  Summit  ');
    form.set('upload', new Blob(['x']), 'x.txt');
    expect(formText(form, 'name')).toBe('Summit');
    expect(formText(form, 'name', { trim: false })).toBe('  Summit  ');
    expect(formText(form, 'upload')).toBe('');
    expect(formText(form, 'missing')).toBe('');
  });
});

describe('clientIpFromForwarded (no spoofed client IPs)', () => {
  it('forwards nothing when no trusted proxy is configured', () => {
    expect(clientIpFromForwarded('203.0.113.9', 0)).toBeUndefined();
  });

  it('takes the entry appended by the outermost trusted proxy, ignoring client-written ones', () => {
    // The client sent "1.2.3.4"; the load balancer appended the real address.
    expect(clientIpFromForwarded('1.2.3.4, 198.51.100.7', 1)).toBe('198.51.100.7');
    expect(clientIpFromForwarded('1.2.3.4, 198.51.100.7, 10.0.0.2', 2)).toBe('198.51.100.7');
    expect(clientIpFromForwarded('2001:db8::1', 1)).toBe('2001:db8::1');
  });

  it('rejects missing, short or malformed headers', () => {
    expect(clientIpFromForwarded(null, 1)).toBeUndefined();
    expect(clientIpFromForwarded('198.51.100.7', 2)).toBeUndefined();
    expect(clientIpFromForwarded('evil, not-an-ip', 1)).toBeUndefined();
  });
});

describe('submittedValues', () => {
  it('keeps what the user typed but never passwords, tokens or framework fields', () => {
    const form = new FormData();
    form.set('email', 'ade@example.test');
    form.set('password', 'secret passphrase');
    form.set('token', 'x'.repeat(43));
    form.set('idempotencyKey', 'admin-123');
    form.set('$ACTION_ID_abc', '');
    form.set('slug', 'jakarta-summit');
    form.set('upload', new Blob(['x']), 'x.txt');
    expect(submittedValues(form)).toEqual({ email: 'ade@example.test', slug: 'jakarta-summit' });
  });
});

describe('friendly API reasons', () => {
  it('explains a version conflict in plain language', () => {
    const conflict = new ApiError(409, {
      error: {
        code: 'conflict',
        message: 'The organization changed since you loaded it (now version 7). Reload and retry.',
        correlationId: 'corr-2',
        details: { reason: 'version_conflict' },
      },
    });
    const state = errorToFormState(conflict);
    expect(state.message).toMatch(/Someone else changed this while you were editing/);
    expect(state.message).not.toContain('version 7');
    expect(state.reference).toBe('corr-2');
  });
});
