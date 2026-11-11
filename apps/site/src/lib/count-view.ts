import 'server-only';
import { clientIpFromForwarded } from './client-ip';
import { siteConfig } from './config';

/**
 * Tells the API that a public page was viewed (ADR-0044). Runs after the response is sent and
 * never affects the page: failures (rate limits, a slow API) are ignored. The visitor's address is
 * forwarded only for the API's per-visitor rate limit; nothing about the visitor is stored.
 */
export async function countView(
  handle: string,
  eventSlug: string,
  forwardedFor: string | null,
): Promise<void> {
  const { apiUrl, trustedProxyHops } = siteConfig();
  const ip = clientIpFromForwarded(forwardedFor, trustedProxyHops);
  try {
    await fetch(
      `${apiUrl}/v1/public/sites/${encodeURIComponent(handle)}/events/${encodeURIComponent(eventSlug)}/views`,
      {
        method: 'POST',
        cache: 'no-store',
        headers: ip ? { 'x-forwarded-for': ip } : {},
        signal: AbortSignal.timeout(3000),
      },
    );
  } catch {
    // Counting is best effort.
  }
}
