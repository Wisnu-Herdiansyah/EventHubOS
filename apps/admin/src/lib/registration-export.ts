import type { components } from './api-types';
import { toCsv } from './csv';
import { isoToZonedLocal } from './time';

type Export = components['schemas']['RegistrationExport'];

/** "2027-03-01 09:00" in the event's time zone: sortable and read correctly by spreadsheets. */
const local = (iso: string | null, timeZone: string) =>
  iso ? isoToZonedLocal(iso, timeZone).replace('T', ' ') : '';

const STATUS: Record<string, string> = { confirmed: 'Registered', cancelled: 'Cancelled' };
const BY: Record<string, string> = { attendee: 'Attendee', organizer: 'Organizer' };

/** The attendee list as CSV (ADR-0027), times in the event's time zone. */
export function registrationsCsv(e: Export): string {
  const tz = e.timezone;
  return toCsv(
    [
      'Name',
      'Email',
      'Status',
      `Registered at (${tz})`,
      `Cancelled at (${tz})`,
      'Cancelled by',
      `Checked in at (${tz})`,
    ],
    e.data.map((r) => [
      r.name,
      r.email,
      STATUS[r.status] ?? r.status,
      local(r.createdAt, tz),
      local(r.cancelledAt, tz),
      r.cancelledBy ? (BY[r.cancelledBy] ?? r.cancelledBy) : '',
      local(r.checkedInAt, tz),
    ]),
  );
}

/** e.g. jakarta-summit-registrations-2027-03-01.csv (the slug is already filename-safe). */
export function exportFilename(e: Pick<Export, 'eventSlug' | 'generatedAt' | 'timezone'>): string {
  const day = isoToZonedLocal(e.generatedAt, e.timezone).slice(0, 10);
  const slug = /^[a-z0-9-]+$/.test(e.eventSlug) ? e.eventSlug : 'event';
  return `${slug}-registrations-${day}.csv`;
}

/**
 * A downloaded file is a state change (it is audited), so the request must come from this app;
 * cookies alone are not enough. Browsers send Sec-Fetch-Site on every request, and it must say
 * same-origin. (The Origin header cannot be relied on here: with this app's
 * `Referrer-Policy: no-referrer`, browsers send `Origin: null` on form posts.) Clients without
 * Sec-Fetch-Site must send an Origin matching the host they asked.
 */
export function isSameOriginPost(headers: {
  origin: string | null;
  host: string | null;
  secFetchSite: string | null;
}): boolean {
  if (headers.secFetchSite) return headers.secFetchSite === 'same-origin';
  if (!headers.origin || !headers.host) return false;
  try {
    return new URL(headers.origin).host === headers.host;
  } catch {
    return false;
  }
}
