/**
 * Which requests count as a page view (ADR-0044; pure, unit-tested). Only a person's full page
 * load counts: not link prefetches or prerenders, not the site's own form submissions and
 * in-page refreshes, and not crawlers, link-preview bots or headless browsers. Nothing from the
 * request is stored; it only decides whether to count.
 */
const BOT =
  /bot|crawl|spider|slurp|preview|fetch|monitor|scan|headless|lighthouse|python|curl|wget|httpclient|okhttp|axios|go-http|java\/|facebookexternalhit|embedly|whatsapp|telegram|discord|slack|skype/i;

type HeaderGet = { get(name: string): string | null };

export function isLikelyBot(userAgent: string | null): boolean {
  if (!userAgent || userAgent.trim().length < 10) return true;
  return BOT.test(userAgent);
}

export function countsAsView(h: HeaderGet): boolean {
  // Prefetch or prerender, by the browser or the framework.
  const purpose = `${h.get('purpose') ?? ''} ${h.get('sec-purpose') ?? ''}`.toLowerCase();
  if (/prefetch|prerender/.test(purpose) || h.get('next-router-prefetch')) return false;
  // Server actions and client navigations re-render the page without a new visit.
  if (h.get('next-action') || h.get('rsc')) return false;
  // Browsers say when they load a document; anything else (an image, a fetch) is not a view.
  const dest = h.get('sec-fetch-dest');
  if (dest && dest !== 'document') return false;
  return !isLikelyBot(h.get('user-agent'));
}
