/**
 * Report periods and the report CSV (ADR-0034; pure, unit-tested). A period is a range of
 * calendar days in the organization's time zone; the API selects events that start on them.
 */
import type { components } from './api-types';
import { toCsv } from './csv';
import { attendanceRate, monthLabel } from './report';
import { lifecycleStatus } from './status';
import { isoToZonedLocal } from './time';

type OrganizationReport = components['schemas']['OrganizationReport'];

export type PeriodKey = 'all' | '30d' | 'year' | 'last-year' | 'custom';

export interface Period {
  key: PeriodKey;
  /** Inclusive calendar days, YYYY-MM-DD; absent for all time. */
  from?: string;
  to?: string;
}

export const PERIOD_PRESETS: Array<{ key: Exclude<PeriodKey, 'custom'>; label: string }> = [
  { key: 'all', label: 'All time' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'year', label: 'This year' },
  { key: 'last-year', label: 'Last year' },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A real calendar day the API accepts (2000–2099). */
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(d.getTime()) &&
    d.toISOString().slice(0, 10) === value &&
    value >= '2000-01-01' &&
    value <= '2099-12-31'
  );
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Today in a time zone, YYYY-MM-DD. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return isoToZonedLocal(now.toISOString(), timeZone).slice(0, 10);
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * The period a link asks for. `today` is in the organization's time zone. An unknown preset or
 * an incomplete, impossible or reversed custom range falls back to all time with `invalid` set.
 */
export function resolvePeriod(
  search: Record<string, string | string[] | undefined>,
  today: string,
): { period: Period; invalid: boolean } {
  const key = one(search.period);
  const year = today.slice(0, 4);
  switch (key) {
    case undefined:
    case 'all':
      return { period: { key: 'all' }, invalid: false };
    case '30d':
      return { period: { key: '30d', from: addDays(today, -29), to: today }, invalid: false };
    case 'year':
      return {
        period: { key: 'year', from: `${year}-01-01`, to: `${year}-12-31` },
        invalid: false,
      };
    case 'last-year': {
      const last = String(Number(year) - 1);
      return {
        period: { key: 'last-year', from: `${last}-01-01`, to: `${last}-12-31` },
        invalid: false,
      };
    }
    case 'custom': {
      const from = one(search.from);
      const to = one(search.to);
      if (isCalendarDay(from) && isCalendarDay(to) && from <= to) {
        return { period: { key: 'custom', from, to }, invalid: false };
      }
      return { period: { key: 'all' }, invalid: true };
    }
    default:
      return { period: { key: 'all' }, invalid: true };
  }
}

/** Query string for links and the export (leading "?", or "" for all time). */
export function periodSearch(period: Period): string {
  if (period.key === 'all') return '';
  if (period.key !== 'custom') return `?period=${period.key}`;
  return `?period=custom&from=${period.from}&to=${period.to}`;
}

/** "3 Mar 2026" for a YYYY-MM-DD day. */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

/** Human description, e.g. "Last 30 days (13 Oct 2026 – 11 Nov 2026)". */
export function periodLabel(period: Period): string {
  if (period.key === 'all' || !period.from || !period.to) return 'All time';
  const range =
    period.from === period.to
      ? dayLabel(period.from)
      : `${dayLabel(period.from)} – ${dayLabel(period.to)}`;
  const preset = PERIOD_PRESETS.find((p) => p.key === period.key);
  return preset ? `${preset.label} (${range})` : range;
}

/** Footnote for the sign-ups chart. */
export function monthsFootnote(
  report: Pick<OrganizationReport, 'period' | 'signUpsByMonth' | 'monthsTruncated' | 'timezone'>,
): string {
  if (!report.period) return `The last 12 months, in ${report.timezone}.`;
  const base = `Sign-ups made during the period, for any event, in ${report.timezone}.`;
  const first = report.signUpsByMonth[0];
  return report.monthsTruncated && first
    ? `${base} Showing the latest ${report.signUpsByMonth.length} months, from ${monthLabel(first.month)}.`
    : base;
}

export const REPORT_CSV_HEADER = [
  'Event',
  'Starts',
  'Status',
  'Registered',
  'Capacity',
  'Cancelled',
  'Checked in',
  'Attendance %',
];

/** One row per listed event; times in the organization's zone. Attendance only once ended. */
export function reportCsv(report: Pick<OrganizationReport, 'events' | 'timezone'>): string {
  return toCsv(
    REPORT_CSV_HEADER,
    report.events.map((e) => {
      const rate = e.ended ? attendanceRate(e.registered, e.checkedIn) : null;
      return [
        e.name,
        isoToZonedLocal(e.startsAt, report.timezone).replace('T', ' '),
        lifecycleStatus(e.lifecycle).label,
        String(e.registered),
        e.capacity === null ? '' : String(e.capacity),
        String(e.cancelled),
        String(e.checkedIn),
        rate === null ? '' : String(rate),
      ];
    }),
  );
}

/** "events-report-all-time-2026-11-11.csv" or "events-report-2026-01-01-to-2026-12-31.csv". */
export function reportFilename(period: Period, today: string): string {
  return period.from && period.to
    ? `events-report-${period.from}-to-${period.to}.csv`
    : `events-report-all-time-${today}.csv`;
}
