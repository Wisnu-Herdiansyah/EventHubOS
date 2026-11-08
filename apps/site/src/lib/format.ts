/** "1 Mar 2027, 09:00 GMT+7": the event's start in its own time zone. Pure; unit-tested. */
export function eventDateLine(startsAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  }).format(new Date(startsAt));
}
