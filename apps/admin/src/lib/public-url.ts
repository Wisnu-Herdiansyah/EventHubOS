/**
 * Public site addresses (ADR-0021): {template with {handle}}/{event-slug}. Pure; unit-tested.
 * Returns null when no template is configured or no handle is set, so callers show no link.
 */
export function publicSiteUrl(
  template: string | null,
  handle: string | null,
  eventSlug?: string,
): string | null {
  if (!template || !handle) return null;
  const origin = template.replace('{handle}', handle);
  return eventSlug ? `${origin}/${eventSlug}` : origin;
}

/** The address shape for hints, e.g. "https://your-handle.eventhub.example/event-slug". */
export function publicSiteExample(template: string | null, handle: string | null): string {
  return `${(template ?? 'https://{handle}.your-platform-domain').replace('{handle}', handle || 'your-handle')}/event-slug`;
}
