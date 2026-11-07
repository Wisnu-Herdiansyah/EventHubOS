import { describe, expect, it } from 'vitest';
import { describeIssues, newSection, uniqueSectionId, type Section } from './page-editor';

describe('page editor model', () => {
  it('creates sections with unique IDs', () => {
    expect(uniqueSectionId('agenda', [])).toBe('agenda');
    expect(uniqueSectionId('agenda', ['agenda', 'agenda-2'])).toBe('agenda-3');
    const s = newSection('speakers', ['speakers']);
    expect(s).toMatchObject({ id: 'speakers-2', type: 'speakers', items: [], visible: true });
  });

  it('explains API field errors in terms of the page', () => {
    const sections = [
      newSection('hero', []),
      { ...newSection('agenda', []), heading: 'Day one' } as Section,
    ];
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
