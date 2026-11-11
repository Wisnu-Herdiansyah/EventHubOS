import { describe, expect, it } from 'vitest';
import { handleFromHost, internalPath } from './host';

describe('handleFromHost', () => {
  it('reads the handle label directly under the site domain', () => {
    expect(handleFromHost('awh-events.eventhub.example', 'eventhub.example')).toBe('awh-events');
    expect(handleFromHost('AWH-Events.EventHub.example:443', 'eventhub.example')).toBe(
      'awh-events',
    );
    expect(handleFromHost('acme.localhost:3002', 'localhost')).toBe('acme');
    expect(handleFromHost('acme.eventhub.example.', 'eventhub.example')).toBe('acme');
  });

  it('rejects everything else', () => {
    for (const host of [
      null,
      'eventhub.example',
      'evil.example',
      'acme.eventhub.example.evil.example',
      'a.b.eventhub.example',
      'ab.eventhub.example',
      '-acme.eventhub.example',
      'acme_x.eventhub.example',
      'xeventhub.example',
    ]) {
      expect(handleFromHost(host, 'eventhub.example'), String(host)).toBeNull();
    }
  });
});

describe('internalPath', () => {
  it('maps the root and single valid slugs, nothing else', () => {
    expect(internalPath('acme', '/')).toBe('/s/acme');
    expect(internalPath('acme', '/jakarta-summit')).toBe('/s/acme/jakarta-summit');
    expect(internalPath('acme', '/jakarta-summit/')).toBe('/s/acme/jakarta-summit');
    expect(internalPath('acme', '/cancel-registration')).toBe('/c/acme');
    expect(internalPath('acme', '/s/other/x')).toBeNull();
    expect(internalPath('acme', '/Bad_Slug')).toBeNull();
    expect(internalPath('acme', '/a/b')).toBeNull();
  });

  it('maps library images, and only well-formed ones (ADR-0042)', () => {
    const id = '0b6f6a3e-6f39-4c7e-9b0b-2f4a1c9d8e7f';
    expect(internalPath('acme', `/images/${id}/small.webp`)).toBe(`/i/acme/${id}/small`);
    expect(internalPath('acme', `/images/${id}/large.webp`)).toBe(`/i/acme/${id}/large`);
    for (const bad of [
      `/images/${id}/original.webp`,
      `/images/${id}/small.png`,
      `/images/${id.toUpperCase()}/small.webp`,
      `/images/../small.webp`,
      `/images/${id}`,
      `/images/${id}/small.webp/x`,
    ]) {
      expect(internalPath('acme', bad), bad).toBeNull();
    }
  });
});

describe('site CSP', async () => {
  const { buildCsp } = await import('./csp');
  it('allows only nonce scripts, same-site forms and no framing', () => {
    const csp = buildCsp('abc', { development: false, https: true });
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).not.toContain('unsafe-inline');
  });
});
