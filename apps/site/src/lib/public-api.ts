import 'server-only';
import { cache } from 'react';
import type { components } from './api-types';
import { siteConfig } from './config';
import { HANDLE, SLUG } from './host';

export type PublicEventPage = components['schemas']['PublicEventPage'];
export type Question = components['schemas']['RegistrationQuestion'];
export type PublicEventCalendar = components['schemas']['PublicEventCalendar'];

/**
 * Fetches a public page (published revision only). null means "not public" in every form the
 * API distinguishes; other failures throw and render the error page. Cached per request so
 * metadata and the page share one call.
 */
export const publicEventPage = cache(
  async (handle: string, eventSlug: string): Promise<PublicEventPage | null> => {
    if (!HANDLE.test(handle) || !SLUG.test(eventSlug)) return null;
    const { apiUrl } = siteConfig();
    const res = await fetch(
      `${apiUrl}/v1/public/sites/${encodeURIComponent(handle)}/events/${encodeURIComponent(eventSlug)}`,
      { cache: 'no-store', headers: { accept: 'application/json' } },
    );
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new Error(`Public page lookup failed (HTTP ${res.status})`);
    return (await res.json()) as PublicEventPage;
  },
);

/** What the calendar file needs (ADR-0048); null when the page is not public. */
export async function publicEventCalendar(
  handle: string,
  eventSlug: string,
): Promise<PublicEventCalendar | null> {
  if (!HANDLE.test(handle) || !SLUG.test(eventSlug)) return null;
  const { apiUrl } = siteConfig();
  const res = await fetch(
    `${apiUrl}/v1/public/sites/${encodeURIComponent(handle)}/events/${encodeURIComponent(eventSlug)}/calendar`,
    { cache: 'no-store', headers: { accept: 'application/json' } },
  );
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`Calendar lookup failed (HTTP ${res.status})`);
  return (await res.json()) as PublicEventCalendar;
}
