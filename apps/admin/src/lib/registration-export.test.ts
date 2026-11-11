import { describe, expect, it } from 'vitest';
import { neutralizeFormula, toCsv } from './csv';
import { exportFilename, isSameOriginPost, registrationsCsv } from './registration-export';

describe('CSV (formula injection and quoting)', () => {
  it('neutralises cells that a spreadsheet would run as formulas', () => {
    for (const v of ['=HYPERLINK("http://evil")', '+1', '-2+3', '@SUM(A1)', '\tx', '\rx']) {
      expect(neutralizeFormula(v)).toBe(`'${v}`);
    }
    expect(neutralizeFormula('Ade Wisnu')).toBe('Ade Wisnu');
    expect(neutralizeFormula('a=b')).toBe('a=b');
  });

  it('quotes commas, quotes, line breaks and edge spaces; uses CRLF and a BOM', () => {
    const csv = toCsv(
      ['A', 'B'],
      [
        ['x, y', 'say "hi"'],
        [' pad', 'line\nbreak'],
        ['=1+1', 'ok'],
      ],
    );
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual([
      'A,B',
      '"x, y","say ""hi"""',
      '" pad","line\nbreak"',
      "'=1+1,ok",
      '',
    ]);
  });
});

describe('attendee export (ADR-0027)', () => {
  const data = {
    eventName: 'Jakarta Summit',
    eventSlug: 'jakarta-summit',
    timezone: 'Asia/Jakarta',
    generatedAt: '2027-02-28T18:30:00Z',
    truncated: false,
    data: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Ade Wisnu',
        email: 'ade@example.test',
        status: 'confirmed' as const,
        createdAt: '2027-02-01T02:00:00Z',
        cancelledAt: null,
        cancelledBy: null,
        checkedInAt: '2027-03-01T01:05:00Z',
        promotedAt: null,
        promotedBy: null,
        waitlistClosedAt: null,
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        name: '=cmd',
        email: 'x@example.test',
        status: 'cancelled' as const,
        createdAt: '2027-02-02T02:00:00Z',
        cancelledAt: '2027-02-03T02:30:00Z',
        cancelledBy: 'organizer' as const,
        checkedInAt: null,
        promotedAt: null,
        promotedBy: null,
        waitlistClosedAt: null,
      },
    ],
  };

  it('lists attendees with times in the event time zone', () => {
    expect(registrationsCsv(data).slice(1).split('\r\n')).toEqual([
      'Name,Email,Status,Registered at (Asia/Jakarta),Cancelled at (Asia/Jakarta),Cancelled by,Checked in at (Asia/Jakarta)',
      'Ade Wisnu,ade@example.test,Registered,2027-02-01 09:00,,,2027-03-01 08:05',
      "'=cmd,x@example.test,Cancelled,2027-02-02 09:00,2027-02-03 09:30,Organizer,",
      '',
    ]);
  });

  it('names the file after the event and the local day', () => {
    expect(exportFilename(data)).toBe('jakarta-summit-registrations-2027-03-01.csv');
    expect(exportFilename({ ...data, eventSlug: 'bad"name' })).toBe(
      'event-registrations-2027-03-01.csv',
    );
  });

  it('accepts only same-origin form posts', () => {
    const ok = {
      origin: 'https://admin.example',
      host: 'admin.example',
      secFetchSite: 'same-origin',
    };
    expect(isSameOriginPost(ok)).toBe(true);
    expect(isSameOriginPost({ ...ok, secFetchSite: null })).toBe(true);
    expect(isSameOriginPost({ ...ok, secFetchSite: 'cross-site' })).toBe(false);
    expect(isSameOriginPost({ ...ok, origin: null, secFetchSite: null })).toBe(false);
    // A same-origin form post under Referrer-Policy: no-referrer carries Origin: null.
    expect(isSameOriginPost({ ...ok, origin: 'null' })).toBe(true);
    expect(isSameOriginPost({ ...ok, origin: 'null', secFetchSite: null })).toBe(false);
    expect(isSameOriginPost({ ...ok, origin: 'https://evil.example', secFetchSite: null })).toBe(
      false,
    );
    expect(isSameOriginPost({ ...ok, secFetchSite: 'same-site' })).toBe(false);
    expect(isSameOriginPost({ ...ok, secFetchSite: 'none' })).toBe(false);
  });
});
