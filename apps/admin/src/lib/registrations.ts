import type { Tone } from '@/components/ui/badge';

/** Registration state as people read it (pure; unit-tested). */
export function registrationStateLabel(state: string): { label: string; tone: Tone } {
  switch (state) {
    case 'open':
      return { label: 'Open', tone: 'success' };
    case 'not_open_yet':
      return { label: 'Not open yet', tone: 'neutral' };
    case 'full':
      return { label: 'Full', tone: 'warning' };
    default:
      return { label: 'Closed', tone: 'neutral' };
  }
}

/** "12 of 100" or "12" when there is no capacity. */
export function seatsLabel(confirmed: number, capacity: number | null): string {
  return capacity ? `${confirmed} of ${capacity}` : String(confirmed);
}
