import type { Tone } from '@/components/ui/badge';

/**
 * Registration state as people read it (pure; unit-tested). A full event that takes a waitlist
 * (ADR-0035) still accepts sign-ups, onto the waitlist.
 */
export function registrationStateLabel(
  state: string,
  waitlist = false,
): { label: string; tone: Tone } {
  if (state === 'full' && waitlist) return { label: 'Full, waitlist open', tone: 'warning' };
  switch (state) {
    case 'open':
      return { label: 'Open', tone: 'success' };
    case 'not_open_yet':
      return { label: 'Not open yet', tone: 'neutral' };
    case 'full':
      return { label: 'Full', tone: 'warning' };
    case 'cancelled':
      return { label: 'Closed: event cancelled', tone: 'danger' };
    default:
      return { label: 'Closed', tone: 'neutral' };
  }
}

/** "12 of 100" or "12" when there is no capacity. */
export function seatsLabel(confirmed: number, capacity: number | null): string {
  return capacity ? `${confirmed} of ${capacity}` : String(confirmed);
}

/** The most requests one bulk decision takes (ADR-0066); the API refuses more. */
export const BULK_DECIDE_MAX = 100;

const requests = (n: number) => (n === 1 ? '1 request' : `${n} requests`);

/**
 * What the organizer is told after deciding several requests at once (ADR-0066): how many were
 * decided, and how many had already been dealt with (by someone else, or withdrawn) and were left.
 */
export function bulkDecisionNotice(
  decision: 'approve' | 'decline',
  decided: number,
  skipped: number,
): string {
  const left =
    skipped === 0
      ? ''
      : ` ${skipped === 1 ? '1 was' : `${skipped} were`} already dealt with and left as is.`;
  if (decided === 0) {
    return 'Nothing changed: the selected requests had already been dealt with.';
  }
  return decision === 'approve'
    ? `${requests(decided)} approved. Each person is registered and has been emailed their ticket.${left}`
    : `${requests(decided)} declined. Each person has been told by email.${left}`;
}
