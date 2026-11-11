import type { components } from './api-types';
import { toCsv } from './csv';
import { isoToZonedLocal } from './time';

type Export = components['schemas']['RegistrationExport'];
type Question = components['schemas']['RegistrationQuestion'];

/** An answer as people read it (ADR-0041): yes/no in words, nothing when unanswered. */
export function answerText(q: Pick<Question, 'type'>, value: string | boolean | undefined): string {
  if (value === undefined) return '';
  if (q.type === 'yes_no' || typeof value === 'boolean')
    return value === true ? 'Yes' : value === false ? 'No' : String(value);
  return value;
}

/** "2027-03-01 09:00" in the event's time zone: sortable and read correctly by spreadsheets. */
const local = (iso: string | null, timeZone: string) =>
  iso ? isoToZonedLocal(iso, timeZone).replace('T', ' ') : '';

const STATUS: Record<string, string> = {
  confirmed: 'Registered',
  cancelled: 'Cancelled',
  waitlisted: 'On the waitlist',
};
const BY: Record<string, string> = { attendee: 'Attendee', organizer: 'Organizer' };

/**
 * The attendee list as CSV (ADR-0027), times in the event's time zone, then one column per
 * registration question (ADR-0041). Answers come from the public, so the same formula
 * protection applies to them as to names.
 */
export function registrationsCsv(e: Export): string {
  const tz = e.timezone;
  const questions = e.questions;
  return toCsv(
    [
      'Name',
      'Email',
      'Status',
      `Registered at (${tz})`,
      `Cancelled at (${tz})`,
      'Cancelled by',
      `Checked in at (${tz})`,
      ...questions.map((q) => q.label),
    ],
    e.data.map((r) => [
      r.name,
      r.email,
      STATUS[r.status] ?? r.status,
      local(r.createdAt, tz),
      local(r.cancelledAt, tz),
      r.cancelledBy ? (BY[r.cancelledBy] ?? r.cancelledBy) : '',
      local(r.checkedInAt, tz),
      ...questions.map((q) => answerText(q, r.answers?.[q.id])),
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
