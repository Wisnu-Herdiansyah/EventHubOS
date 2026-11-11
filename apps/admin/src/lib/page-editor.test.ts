import { describe, expect, it } from 'vitest';
import {
  describeIssues,
  newAgendaItem,
  newSection,
  newSpeaker,
  pageSpeakers,
  removeSpeaker,
  uniqueSectionId,
  type Section,
} from './page-editor';

describe('page editor model', () => {
  it('creates sections with unique IDs', () => {
    expect(uniqueSectionId('agenda', [])).toBe('agenda');
    expect(uniqueSectionId('agenda', ['agenda', 'agenda-2'])).toBe('agenda-3');
    const s = newSection('speakers', ['speakers']);
    expect(s).toMatchObject({ id: 'speakers-2', type: 'speakers', items: [], visible: true });
  });

  it('explains API field errors in terms of the page', () => {
    const sections = [newSection('hero', []), { ...newSection('agenda', []), heading: 'Day one' }];
    expect(
      describeIssues(
        [
          { path: 'body.sections.1.items.0.time', message: 'Use 24-hour time.' },
          { path: 'body.sections.0.heading', message: 'Add a heading.' },
          { path: 'body.sections', message: 'Too many sections.' },
          { path: 'body.sections.9', message: 'Invalid.' },
        ],
        sections,
      ),
    ).toEqual([
      { sectionIndex: 1, message: 'Day one · item 1 · Time: Use 24-hour time.' },
      { sectionIndex: 0, message: 'Event name · Heading: Add a heading.' },
      { sectionIndex: null, message: 'Too many sections.' },
      { sectionIndex: 9, message: 'Section 10: Invalid.' },
    ]);
  });
});

describe('program editing (ADR-0040)', () => {
  const speakers = (id: string, people: string[]): Section => ({
    id,
    type: 'speakers',
    version: 2,
    visible: true,
    heading: 'Speakers',
    items: people.map((p) => ({ id: p, name: p, role: '', bio: '' })),
  });
  const agenda: Section = {
    id: 'agenda',
    type: 'agenda',
    version: 2,
    visible: true,
    heading: 'Agenda',
    items: [
      {
        id: 'session-1',
        day: '2027-03-01',
        start: '09:00',
        end: '',
        title: 'A',
        room: '',
        description: '',
        speakerIds: ['speaker-1', 'speaker-2'],
      },
      {
        id: 'session-3',
        day: '2027-03-02',
        start: '23:00',
        end: '',
        title: 'B',
        room: '',
        description: '',
        speakerIds: ['speaker-2'],
      },
    ],
  };

  it('creates v2 agenda and speakers sections', () => {
    expect(newSection('agenda', [])).toMatchObject({ type: 'agenda', version: 2, items: [] });
    expect(newSection('speakers', [])).toMatchObject({ type: 'speakers', version: 2, items: [] });
    expect(newSection('hero', [])).toMatchObject({ version: 1 });
  });

  it('adds sessions after the last, on the same day', () => {
    expect(newAgendaItem(agenda)).toMatchObject({
      id: 'session-2',
      day: '2027-03-02',
      start: '23:00',
    });
    const empty = newSection('agenda', []) as Extract<Section, { type: 'agenda'; version: 2 }>;
    expect(newAgendaItem(empty)).toMatchObject({ id: 'session-1', day: '', start: '09:00' });
  });

  it('gives new speakers IDs unique across the page', () => {
    const page = [speakers('a', ['speaker-1']), speakers('b', ['speaker-2'])];
    expect(newSpeaker(page).id).toBe('speaker-3');
    expect(pageSpeakers(page).map((p) => p.id)).toEqual(['speaker-1', 'speaker-2']);
  });

  it('removes a speaker from their section and from every session', () => {
    const page = [speakers('people', ['speaker-1', 'speaker-2']), agenda];
    const next = removeSpeaker(page, 'people', 'speaker-2');
    expect(pageSpeakers(next).map((p) => p.id)).toEqual(['speaker-1']);
    const a = next[1] as Extract<Section, { type: 'agenda'; version: 2 }>;
    expect(a.items.map((i) => i.speakerIds)).toEqual([['speaker-1'], []]);
    // Untouched sections keep their identity (no needless re-render or undo noise).
    expect(removeSpeaker(page, 'people', 'nobody')[1]).toBe(agenda);
  });

  it('names the new fields in error messages', () => {
    const issues = describeIssues(
      [
        {
          path: 'body.sections.1.items.0.speakerIds.1',
          message: 'This speaker is not on the page.',
        },
      ],
      [speakers('people', []), agenda],
    );
    expect(issues[0]!.message).toBe('Agenda · item 1 · Speakers: This speaker is not on the page.');
  });
});
