import type { components } from './api-types';

/**
 * Microsite editor model (pure; unit-tested). Section shapes come from the API schema; the API
 * validates every save, so these helpers only build defaults and explain errors.
 */
export type Section = components['schemas']['PageSection'];
export type SectionType = Section['type'];
export type EventPage = components['schemas']['EventPage'];

export const SECTION_TYPES: Array<{ type: SectionType; label: string; description: string }> = [
  { type: 'hero', label: 'Hero', description: 'Large title, short text and a call to action' },
  { type: 'text', label: 'Text', description: 'A heading and paragraphs' },
  { type: 'agenda', label: 'Agenda', description: 'Times and session titles' },
  { type: 'speakers', label: 'Speakers', description: 'Names and roles' },
  { type: 'register', label: 'Registration', description: 'Call to action to register' },
];

export const SECTION_LABELS = Object.fromEntries(
  SECTION_TYPES.map((t) => [t.type, t.label]),
) as Record<SectionType, string>;

/** A short ID not yet used on the page, e.g. agenda-2. */
export function uniqueSectionId(type: SectionType, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(type)) return type;
  for (let n = 2; ; n++) if (!used.has(`${type}-${n}`)) return `${type}-${n}`;
}

export function newSection(type: SectionType, taken: Iterable<string>): Section {
  const base = { id: uniqueSectionId(type, taken), version: 1 as const, visible: true };
  switch (type) {
    case 'hero':
      return { ...base, type, heading: 'Event name', body: '', ctaLabel: 'Register now' };
    case 'text':
      return { ...base, type, heading: 'About', body: '' };
    case 'agenda':
      return { ...base, type, heading: 'Agenda', items: [] };
    case 'speakers':
      return { ...base, type, heading: 'Speakers', items: [] };
    case 'register':
      return { ...base, type, heading: 'Save your seat', body: '', ctaLabel: 'Register now' };
  }
}

const FIELD_LABELS: Record<string, string> = {
  heading: 'Heading',
  body: 'Text',
  ctaLabel: 'Button label',
  time: 'Time',
  title: 'Title',
  name: 'Name',
  role: 'Role',
  id: 'ID',
};

export interface EditorIssue {
  sectionIndex: number | null;
  message: string;
}

/**
 * Turns API field paths (body.sections.2.items.0.time) into sentences a person can act on:
 * "Agenda · item 1 · Time: Use 24-hour time, e.g. 09:30."
 */
export function describeIssues(
  fields: Array<{ path: string; message: string }>,
  sections: Section[],
): EditorIssue[] {
  return fields.map((f) => {
    const m = /^body\.sections\.(\d+)(?:\.items\.(\d+))?(?:\.([A-Za-z]+))?/.exec(f.path);
    if (!m) return { sectionIndex: null, message: f.message };
    const index = Number(m[1]);
    const section = sections[index];
    const parts = [
      section ? section.heading.trim() || SECTION_LABELS[section.type] : `Section ${index + 1}`,
      m[2] !== undefined ? `item ${Number(m[2]) + 1}` : null,
      m[3] ? (FIELD_LABELS[m[3]] ?? m[3]) : null,
    ].filter(Boolean);
    return { sectionIndex: index, message: `${parts.join(' · ')}: ${f.message}` };
  });
}
