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
