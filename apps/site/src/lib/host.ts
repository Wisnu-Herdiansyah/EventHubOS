/**
 * Public site addressing (ADR-0021, D6): https://{handle}.{site domain}/{event-slug}.
 * Pure; unit-tested. Anything that is not exactly one valid handle label directly under the
 * configured domain resolves to nothing (and is answered 404).
 */
export const HANDLE = /^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$/;
export const SLUG = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

export function handleFromHost(host: string | null, siteDomain: string): string | null {
  if (!host) return null;
  const name = host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  const suffix = `.${siteDomain.toLowerCase()}`;
  if (!name.endsWith(suffix)) return null;
  const label = name.slice(0, -suffix.length);
  return HANDLE.test(label) ? label : null;
}

/** Internal path for a public URL path, or null when it cannot be an event page. */
export function internalPath(handle: string, pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return `/s/${handle}`;
  // Cancel link from a registration email (ADR-0023); the slug is reserved for this.
  if (parts.length === 1 && parts[0] === 'cancel-registration') return `/c/${handle}`;
  if (parts.length === 1 && SLUG.test(parts[0]!)) return `/s/${handle}/${parts[0]}`;
  return null;
}
