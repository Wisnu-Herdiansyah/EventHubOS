/**
 * Event times are entered as wall-clock time in the event's time zone (PRD: render schedules in
 * the event time zone), and the API stores instants. These helpers convert both ways using Intl,
 * including across daylight-saving changes. Pure; unit-tested.
 */

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** `2027-05-10T09:00` in `Asia/Jakarta` → `2027-05-10T02:00:00.000Z`. Returns null if malformed. */
export function zonedLocalToIso(local: string, timeZone: string): string | null {
  const m = LOCAL_RE.exec(local);
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // Two passes converge for every real zone, including at DST boundaries.
  let instant = wall - offsetMs(wall, timeZone);
  instant = wall - offsetMs(instant, timeZone);
  return new Date(instant).toISOString();
}

/** Instant → `YYYY-MM-DDTHH:mm` wall time in `timeZone`, for `<input type="datetime-local">`. */
export function isoToZonedLocal(iso: string, timeZone: string): string {
  const instant = Date.parse(iso);
  const shifted = new Date(instant + offsetMs(instant, timeZone));
  return shifted.toISOString().slice(0, 16);
}

export function formatInZone(iso: string, timeZone: string, locale = 'en-GB'): string {
  // dateStyle/timeStyle cannot be combined with timeZoneName, so the fields are listed explicitly.
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(new Date(iso));
}

/** "09:12" in the given time zone (24-hour), for times on the event day. */
export function timeInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

/** "just now", "12 minutes ago", "3 hours ago", "2 days ago" (past times only). */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const units: Array<[number, string]> = [
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}
