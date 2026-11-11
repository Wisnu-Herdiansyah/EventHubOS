/**
 * Suggested values for copying an event (ADR-0036; pure, unit-tested). Organizers usually copy
 * last year's event, so the suggestion moves a trailing year forward and starts a year later.
 */
const SLUG_MAX = 64;
const YEAR_SUFFIX = /^(.*-)(\d{4})$/;
const YEAR_IN_NAME = /\b(19|20)\d{2}\b/;

/** "summit-2026" → "summit-2027"; otherwise "summit-copy", within the slug length limit. */
export function suggestSlug(slug: string): string {
  const m = YEAR_SUFFIX.exec(slug);
  if (m) return `${m[1]}${Number(m[2]) + 1}`;
  const base = slug.slice(0, SLUG_MAX - '-copy'.length).replace(/-+$/, '');
  return `${base}-copy`;
}

/** "Summit 2026" → "Summit 2027"; otherwise "Summit (copy)", within 200 characters. */
export function suggestName(name: string): string {
  const year = YEAR_IN_NAME.exec(name);
  if (year) return name.replace(year[0], String(Number(year[0]) + 1));
  return `${name.slice(0, 200 - ' (copy)'.length)} (copy)`;
}

/** The same wall-clock time a year later, as YYYY-MM-DDTHH:mm (29 Feb becomes 28 Feb). */
export function nextYearLocal(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2})$/.exec(local);
  if (!m) return local;
  const year = Number(m[1]) + 1;
  const day = m[2] === '02' && m[3] === '29' ? '28' : m[3];
  return `${year}-${m[2]}-${day}${m[4]}`;
}
