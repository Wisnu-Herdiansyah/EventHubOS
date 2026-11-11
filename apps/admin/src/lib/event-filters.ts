/**
 * Event list filters from the page URL (pure, unit-tested). Anything the API would refuse is
 * dropped here and reported, so a hand-edited link still shows a list.
 */
import { LIFECYCLE_LABELS } from './options';

export interface EventFilters {
  q?: string;
  lifecycle?: string;
  when?: 'upcoming' | 'past';
  cursor?: string;
}

const CURSOR_RE = /^[A-Za-z0-9_-]{1,200}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parseEventFilters(search: Record<string, string | string[] | undefined>): {
  filters: EventFilters;
  ignored: boolean;
} {
  const filters: EventFilters = {};
  let ignored = false;
  const q = one(search.q)?.trim();
  if (q) {
    if (q.length <= 100 && !CONTROL.test(q)) filters.q = q;
    else ignored = true;
  }
  const lifecycle = one(search.status);
  if (lifecycle) {
    if (lifecycle in LIFECYCLE_LABELS) filters.lifecycle = lifecycle;
    else ignored = true;
  }
  const when = one(search.when);
  if (when) {
    if (when === 'upcoming' || when === 'past') filters.when = when;
    else ignored = true;
  }
  const cursor = one(search.cursor);
  if (cursor) {
    if (CURSOR_RE.test(cursor)) filters.cursor = cursor;
    else ignored = true;
  }
  return { filters, ignored };
}

/** Whether any filter (not just the page) is applied. */
export function isFiltered(f: EventFilters): boolean {
  return Boolean(f.q || f.lifecycle || f.when);
}

/** The overview link for these filters, optionally at another page. */
export function eventsHref(orgId: string, f: EventFilters, cursor?: string): string {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.lifecycle) p.set('status', f.lifecycle);
  if (f.when) p.set('when', f.when);
  if (cursor) p.set('cursor', cursor);
  const s = p.toString();
  return `/orgs/${orgId}${s ? `?${s}` : ''}#events-heading`;
}
