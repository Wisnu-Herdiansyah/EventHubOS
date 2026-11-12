/**
 * An event as an iCalendar file (RFC 5545) for "Add to calendar" (ADR-0048). Pure; unit-tested.
 *
 * - Times are exact instants in UTC; calendar apps show them in the viewer's own zone. The
 *   event's own zone and local start are written into the description for reference.
 * - The UID is stable and the SEQUENCE rises with every change, so importing the file again
 *   updates the entry instead of adding a second one.
 * - Every text value is escaped and lines are folded at 75 octets, so names with commas,
 *   semicolons, line breaks or non-ASCII characters cannot break the file or add properties.
 */
export interface CalendarEvent {
  uid: string;
  sequence: number;
  updatedAt: string;
  name: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  venueMode: string;
  description: string | null;
  /** The event was cancelled (ADR-0050): STATUS:CANCELLED under the same UID. */
  cancelled?: boolean;
}

/** 20270301T020000Z */
export function icsDate(iso: string): string {
  return new Date(iso)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** TEXT value escaping (RFC 5545 §3.3.11). */
export function icsText(value: string): string {
  return (
    value
      .replace(/\r\n?/g, '\n')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n')
      // Control characters have no place in a calendar value; dropping them is the point.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  );
}

/** Folds a content line at 75 octets without splitting a UTF-8 character (§3.1). */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const bytes = Buffer.byteLength(ch, 'utf8');
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (size + bytes > limit) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += bytes;
  }
  out.push(current);
  return out.join('\r\n ');
}

const LOCATION: Record<string, string> = {
  virtual: 'Online',
  hybrid: 'In person and online',
};

/** "1 Mar 2027, 09:00 (Asia/Jakarta)" */
function localStart(startsAt: string, timeZone: string): string {
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(startsAt));
  return `${text} (${timeZone})`;
}

export function eventIcs(e: CalendarEvent, pageUrl: string): string {
  const description = [
    ...(e.description ? [e.description, ''] : []),
    `Starts ${localStart(e.startsAt, e.timezone)}.`,
    `Event page: ${pageUrl}`,
  ].join('\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//EventHub OS//Add to calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsText(e.uid)}`,
    `SEQUENCE:${Math.max(0, Math.trunc(e.sequence))}`,
    `DTSTAMP:${icsDate(e.updatedAt)}`,
    `LAST-MODIFIED:${icsDate(e.updatedAt)}`,
    `DTSTART:${icsDate(e.startsAt)}`,
    `DTEND:${icsDate(e.endsAt)}`,
    `SUMMARY:${icsText(e.cancelled ? `Cancelled: ${e.name}` : e.name)}`,
    `DESCRIPTION:${icsText(description)}`,
    ...(LOCATION[e.venueMode] ? [`LOCATION:${LOCATION[e.venueMode]}`] : []),
    `URL:${icsText(pageUrl)}`,
    e.cancelled ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    // A cancelled event no longer blocks the time.
    e.cancelled ? 'TRANSP:TRANSPARENT' : 'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/** e.g. summit-2027.ics */
export function icsFilename(eventSlug: string): string {
  return `${eventSlug}.ics`;
}
