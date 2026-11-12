import { describe, expect, it } from 'vitest';
import { eventIcs, foldLine, icsDate, icsFilename, icsText, type CalendarEvent } from './calendar';

const event: CalendarEvent = {
  uid: '0123456789abcdef0123456789abcdef@eventhub',
  sequence: 3,
  updatedAt: '2027-01-15T08:30:00.000Z',
  name: 'Summit 2027',
  startsAt: '2027-03-01T02:00:00.000Z',
  endsAt: '2027-03-01T10:00:00.000Z',
  timezone: 'Asia/Jakarta',
  venueMode: 'virtual',
  description: null,
};
const url = 'https://acme.events.test/summit-2027';

/** Unfolds the file back into logical lines. */
const unfold = (ics: string) => ics.replace(/\r\n /g, '').split('\r\n').filter(Boolean);

describe('icsDate', () => {
  it('writes UTC basic format', () => {
    expect(icsDate('2027-03-01T02:00:00.000Z')).toBe('20270301T020000Z');
    expect(icsDate('2027-03-01T09:00:00+07:00')).toBe('20270301T020000Z');
  });
});

describe('icsText', () => {
  it('escapes the characters that would end a value or add a property', () => {
    expect(icsText('a,b;c\\d')).toBe('a\\,b\\;c\\\\d');
    expect(icsText('one\r\ntwo\nthree')).toBe('one\\ntwo\\nthree');
    expect(icsText('x\u0007y')).toBe('xy');
  });
});

describe('foldLine', () => {
  it('folds at 75 octets, never inside a character', () => {
    const long = `SUMMARY:${'é'.repeat(60)}`;
    const folded = foldLine(long);
    for (const line of folded.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, '')).toBe(long);
  });

  it('leaves short lines alone', () => {
    expect(foldLine('VERSION:2.0')).toBe('VERSION:2.0');
  });
});

describe('eventIcs', () => {
  it('writes one event with a stable UID, the change sequence and UTC times', () => {
    const ics = eventIcs(event, url);
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/);
    const lines = unfold(ics);
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines.at(-1)).toBe('END:VCALENDAR');
    expect(lines).toEqual(
      expect.arrayContaining([
        'VERSION:2.0',
        'METHOD:PUBLISH',
        `UID:${event.uid}`,
        'SEQUENCE:3',
        'DTSTAMP:20270115T083000Z',
        'DTSTART:20270301T020000Z',
        'DTEND:20270301T100000Z',
        'SUMMARY:Summit 2027',
        'LOCATION:Online',
        `URL:${url}`,
        'STATUS:CONFIRMED',
      ]),
    );
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
    const description = lines.find((l) => l.startsWith('DESCRIPTION:'))!;
    expect(description).toBe(
      `DESCRIPTION:Starts 1 Mar 2027\\, 09:00 (Asia/Jakarta).\\nEvent page: ${url}`,
    );
  });

  it('puts the sharing description first and gives no location for in-person events', () => {
    const lines = unfold(
      eventIcs({ ...event, venueMode: 'in_person', description: 'Talks; workshops' }, url),
    );
    expect(lines.find((l) => l.startsWith('DESCRIPTION:'))).toMatch(
      /^DESCRIPTION:Talks\\; workshops\\n\\nStarts /,
    );
    expect(lines.some((l) => l.startsWith('LOCATION:'))).toBe(false);
    expect(unfold(eventIcs({ ...event, venueMode: 'hybrid' }, url))).toContain(
      'LOCATION:In person and online',
    );
  });

  it('cannot be made to add properties or events through the name', () => {
    const hostile = 'Party\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Injected';
    const lines = unfold(eventIcs({ ...event, name: hostile }, url));
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('SUMMARY:'))).toEqual([
      'SUMMARY:Party\\nEND:VEVENT\\nBEGIN:VEVENT\\nSUMMARY:Injected',
    ]);
  });

  it('never writes a negative sequence', () => {
    expect(unfold(eventIcs({ ...event, sequence: -1 }, url))).toContain('SEQUENCE:0');
  });
});

describe('cancelled events (ADR-0050)', () => {
  it('keep the UID, say CANCELLED, stop blocking the time, and say so in the title', () => {
    const lines = unfold(eventIcs({ ...event, cancelled: true }, url));
    expect(lines).toEqual(
      expect.arrayContaining([
        `UID:${event.uid}`,
        'STATUS:CANCELLED',
        'TRANSP:TRANSPARENT',
        'SUMMARY:Cancelled: Summit 2027',
      ]),
    );
    expect(lines).not.toContain('STATUS:CONFIRMED');
    expect(unfold(eventIcs(event, url))).toEqual(
      expect.arrayContaining(['STATUS:CONFIRMED', 'TRANSP:OPAQUE', 'SUMMARY:Summit 2027']),
    );
  });
});

describe('icsFilename', () => {
  it('names the file after the event', () => {
    expect(icsFilename('summit-2027')).toBe('summit-2027.ics');
  });
});
