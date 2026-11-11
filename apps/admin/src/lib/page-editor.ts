import type { components } from './api-types';

/**
 * Microsite editor model (pure; unit-tested). Section shapes come from the API schema; the API
 * validates every save, so these helpers only build defaults and explain errors.
 */
export type Section = components['schemas']['PageSection'];
export type SectionType = Section['type'];
export type EventPage = components['schemas']['EventPage'];
export type AgendaV2 = Extract<Section, { type: 'agenda'; version: 2 }>;
export type SpeakersV2 = Extract<Section, { type: 'speakers'; version: 2 }>;
export type AgendaItem = AgendaV2['items'][number];
export type Speaker = SpeakersV2['items'][number];

export const SECTION_TYPES: Array<{ type: SectionType; label: string; description: string }> = [
  { type: 'hero', label: 'Hero', description: 'Large title, short text and a call to action' },
  { type: 'text', label: 'Text', description: 'A heading and paragraphs' },
  { type: 'agenda', label: 'Agenda', description: 'Sessions by day, with rooms and speakers' },
  { type: 'speakers', label: 'Speakers', description: 'Names, roles and short bios' },
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
      return { ...base, version: 2, type, heading: 'Agenda', items: [] };
    case 'speakers':
      return { ...base, version: 2, type, heading: 'Speakers', items: [] };
    case 'register':
      return { ...base, type, heading: 'Save your seat', body: '', ctaLabel: 'Register now' };
  }
}

/** "prefix-N" not yet in `taken` (item IDs; speakers' must be unique on the whole page). */
function nextId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) if (!used.has(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

/** Every v2 speaker on the page, for session checkboxes. */
export function pageSpeakers(sections: Section[]): Speaker[] {
  return sections.flatMap((s) => (s.type === 'speakers' && s.version === 2 ? s.items : []));
}

/** A new session after the last one: same day, an hour later. */
export function newAgendaItem(section: AgendaV2): AgendaItem {
  const last = section.items.at(-1);
  const hour = last ? Math.min(Number(last.start.slice(0, 2)) + 1, 23) : 9;
  return {
    id: nextId(
      'session',
      section.items.map((i) => i.id),
    ),
    day: last?.day ?? '',
    start: `${String(hour).padStart(2, '0')}:00`,
    end: '',
    title: 'Session',
    room: '',
    description: '',
    speakerIds: [],
  };
}

export function newSpeaker(sections: Section[]): Speaker {
  return {
    id: nextId(
      'speaker',
      pageSpeakers(sections).map((p) => p.id),
    ),
    name: 'Speaker name',
    role: '',
    bio: '',
  };
}

/** Removes a speaker, and their name from every session, so the page stays valid. */
export function removeSpeaker(
  sections: Section[],
  sectionId: string,
  speakerId: string,
): Section[] {
  return sections.map((s) => {
    if (s.id === sectionId && s.type === 'speakers' && s.version === 2) {
      return { ...s, items: s.items.filter((p) => p.id !== speakerId) };
    }
    if (
      s.type === 'agenda' &&
      s.version === 2 &&
      s.items.some((i) => i.speakerIds.includes(speakerId))
    ) {
      return {
        ...s,
        items: s.items.map((i) => ({
          ...i,
          speakerIds: i.speakerIds.filter((id) => id !== speakerId),
        })),
      };
    }
    return s;
  });
}

const FIELD_LABELS: Record<string, string> = {
  day: 'Day',
  start: 'Starts',
  end: 'Ends',
  room: 'Room',
  description: 'Description',
  speakerIds: 'Speakers',
  bio: 'Bio',
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
