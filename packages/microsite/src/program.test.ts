import { describe, expect, it } from 'vitest';
import { agendaDays, dayLabel, speakerIndex, timeRange, upgradeSections } from './program.ts';
import type { AgendaItemV2, Section } from './types.ts';

const item = (id: string, day: string, start: string, end = ''): AgendaItemV2 => ({
  id,
  day,
  start,
  end,
  title: id,
  room: '',
  description: '',
  speakerIds: [],
});

describe('program helpers', () => {
  it('groups sessions by day and sorts each day by start time', () => {
    const days = agendaDays([
      item('d2-late', '2027-03-02', '14:00'),
      item('d1-late', '2027-03-01', '16:00'),
      item('d1-early', '2027-03-01', '09:00'),
      item('d2-early', '2027-03-02', '09:30'),
      item('d1-same-a', '2027-03-01', '11:00'),
      item('d1-same-b', '2027-03-01', '11:00'),
    ]);
    expect(days.map((d) => d.day)).toEqual(['2027-03-01', '2027-03-02']);
    expect(days[0]!.items.map((i) => i.id)).toEqual([
      'd1-early',
      'd1-same-a',
      'd1-same-b',
      'd1-late',
    ]);
    expect(days[1]!.items.map((i) => i.id)).toEqual(['d2-early', 'd2-late']);
    // Undated sessions (a one-day event) come first, as their own group.
    expect(
      agendaDays([item('dated', '2027-03-01', '09:00'), item('undated', '', '10:00')]).map(
        (d) => d.day,
      ),
    ).toEqual(['', '2027-03-01']);
    expect(agendaDays([])).toEqual([]);
  });

  it('labels days and time ranges', () => {
    expect(dayLabel('2027-03-01')).toBe('Mon, 1 Mar 2027');
    expect(dayLabel('not-a-day')).toBe('not-a-day');
    expect(timeRange({ start: '09:30', end: '10:15' })).toBe('09:30–10:15');
    expect(timeRange({ start: '09:30', end: '' })).toBe('09:30');
  });

  it('upgrades v1 agenda and speakers to v2, leaving other sections alone', () => {
    const v1: Section[] = [
      { id: 'hero', type: 'hero', version: 1, visible: true, heading: 'H', body: '', ctaLabel: '' },
      {
        id: 'agenda',
        type: 'agenda',
        version: 1,
        visible: false,
        heading: 'Agenda',
        items: [
          { time: '09:00', title: 'Doors' },
          { time: '10:00', title: 'Keynote' },
        ],
      },
      {
        id: 'people',
        type: 'speakers',
        version: 1,
        visible: true,
        heading: 'Speakers',
        items: [{ name: 'Ade', role: 'Host' }],
      },
    ];
    const v2 = upgradeSections(v1);
    expect(v2[0]).toBe(v1[0]);
    expect(v2[1]).toEqual({
      id: 'agenda',
      type: 'agenda',
      version: 2,
      visible: false,
      heading: 'Agenda',
      items: [
        {
          id: 'session-1',
          day: '',
          start: '09:00',
          end: '',
          title: 'Doors',
          room: '',
          description: '',
          speakerIds: [],
        },
        {
          id: 'session-2',
          day: '',
          start: '10:00',
          end: '',
          title: 'Keynote',
          room: '',
          description: '',
          speakerIds: [],
        },
      ],
    });
    // Speakers go straight to v3 (photos, ADR-0042), with no photo.
    expect(v2[2]).toEqual({
      id: 'people',
      type: 'speakers',
      version: 3,
      visible: true,
      heading: 'Speakers',
      items: [{ id: 'speaker-1', name: 'Ade', role: 'Host', bio: '', photoAssetId: null }],
    });
    // Already current: unchanged.
    expect(upgradeSections(v2)).toEqual(v2);
  });

  it('upgrades v2 speakers to v3 without photos, keeping IDs and bios', () => {
    const v2: Section[] = [
      {
        id: 'people',
        type: 'speakers',
        version: 2,
        visible: false,
        heading: 'Speakers',
        items: [{ id: 'ade', name: 'Ade', role: 'Host', bio: 'Runs events.' }],
      },
    ];
    expect(upgradeSections(v2)).toEqual([
      {
        id: 'people',
        type: 'speakers',
        version: 3,
        visible: false,
        heading: 'Speakers',
        items: [{ id: 'ade', name: 'Ade', role: 'Host', bio: 'Runs events.', photoAssetId: null }],
      },
    ]);
  });

  it('indexes v3 speakers like v2 ones', () => {
    const index = speakerIndex([
      {
        id: 's',
        type: 'speakers',
        version: 3,
        visible: true,
        heading: 'S',
        items: [{ id: 'p', name: 'P', role: 'R', bio: '', photoAssetId: 'x' }],
      },
    ]);
    expect(index.get('p')).toEqual({ id: 'p', name: 'P', role: 'R', bio: '', linked: true });
  });

  it('indexes v2 speakers, linking only those whose section is shown', () => {
    const sections: Section[] = [
      {
        id: 's1',
        type: 'speakers',
        version: 2,
        visible: true,
        heading: 'S',
        items: [{ id: 'a', name: 'A', role: '', bio: '' }],
      },
      {
        id: 's2',
        type: 'speakers',
        version: 2,
        visible: false,
        heading: 'Hidden',
        items: [{ id: 'b', name: 'B', role: '', bio: '' }],
      },
      {
        id: 's3',
        type: 'speakers',
        version: 1,
        visible: true,
        heading: 'Old',
        items: [{ name: 'C', role: '' }],
      },
    ];
    const index = speakerIndex(sections);
    expect([...index.keys()]).toEqual(['a', 'b']);
    expect(index.get('a')!.linked).toBe(true);
    expect(index.get('b')).toEqual({ id: 'b', name: 'B', role: '', bio: '', linked: false });
  });
});
