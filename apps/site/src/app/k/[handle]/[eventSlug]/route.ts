import { eventIcs, icsFilename } from '@/lib/calendar';
import { siteConfig, siteDevPort } from '@/lib/config';
import { HANDLE, SLUG } from '@/lib/host';
import { publicEventCalendar } from '@/lib/public-api';

/**
 * An event as a calendar file (ADR-0048), reached as /{slug}/calendar.ics on the organization's
 * own host. Same visibility as the page: anything not public is a plain 404. Short caching, so
 * a changed time reaches people who add the event later; the file holds nothing personal.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ handle: string; eventSlug: string }> },
) {
  const { handle, eventSlug } = await params;
  if (!HANDLE.test(handle) || !SLUG.test(eventSlug)) return notFound();
  const event = await publicEventCalendar(handle, eventSlug);
  if (!event) return notFound();
  const { domain, https } = siteConfig();
  const pageUrl = `${https ? 'https' : 'http'}://${handle}.${domain}${siteDevPort()}/${eventSlug}`;
  return new Response(eventIcs(event, pageUrl), {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="${icsFilename(eventSlug)}"`,
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
}

function notFound() {
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
