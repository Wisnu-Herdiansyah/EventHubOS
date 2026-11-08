import { z } from 'zod';

/**
 * Microsite section schema (ADR-0020). Sections are typed and versioned; every field is plain
 * text with a length limit. Nothing is ever interpreted as HTML or script: renderers output text
 * nodes only. A new section shape gets a new `version` (and a migration of stored drafts) rather
 * than changing an existing one.
 */
export const SECTIONS_SCHEMA_VERSION = 1;
export const MAX_SECTIONS = 30;

/** Single-line text: trimmed, no control characters. */
const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\u0000-\u001f\u007f]*$/, 'Use a single line of plain text.');

/** Multi-line text: newlines allowed, other control characters not. */
const paragraph = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\u0000-\u0009\u000b-\u001f\u007f]*$/, 'Use plain text.');

const base = {
  /** Client-generated, stable within a page (used for selection and ordering). */
  id: z.string().regex(/^[a-z0-9-]{1,40}$/, 'Use lowercase letters, digits and hyphens.'),
  version: z.literal(1),
  visible: z.boolean(),
  heading: line(120).min(1, 'Add a heading.'),
};

export const heroSection = z
  .object({ ...base, type: z.literal('hero'), body: paragraph(400), ctaLabel: line(40) })
  .strict()
  .meta({ id: 'HeroSection' });

export const textSection = z
  .object({ ...base, type: z.literal('text'), body: paragraph(4000) })
  .strict()
  .meta({ id: 'TextSection' });

export const agendaSection = z
  .object({
    ...base,
    type: z.literal('agenda'),
    items: z
      .array(
        z
          .object({
            time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour time, e.g. 09:30.'),
            title: line(160).min(1, 'Add a title.'),
          })
          .strict(),
      )
      .max(50),
  })
  .strict()
  .meta({ id: 'AgendaSection' });

export const speakersSection = z
  .object({
    ...base,
    type: z.literal('speakers'),
    items: z
      .array(z.object({ name: line(100).min(1, 'Add a name.'), role: line(120) }).strict())
      .max(60),
  })
  .strict()
  .meta({ id: 'SpeakersSection' });

export const registerSection = z
  .object({ ...base, type: z.literal('register'), body: paragraph(400), ctaLabel: line(40) })
  .strict()
  .meta({ id: 'RegisterSection' });

export const sectionSchema = z
  .discriminatedUnion('type', [
    heroSection,
    textSection,
    agendaSection,
    speakersSection,
    registerSection,
  ])
  .meta({ id: 'PageSection' });

export const sectionsSchema = z
  .array(sectionSchema)
  .max(MAX_SECTIONS)
  .superRefine((sections, ctx) => {
    const seen = new Set<string>();
    sections.forEach((s, i) => {
      if (seen.has(s.id)) {
        ctx.addIssue({ code: 'custom', path: [i, 'id'], message: 'Section IDs must be unique.' });
      }
      seen.add(s.id);
    });
  });

export type Section = z.infer<typeof sectionSchema>;

/** What a new page starts with: a sensible outline the organizer edits. Not stored until saved. */
export function starterSections(eventName: string): Section[] {
  return [
    {
      id: 'hero',
      type: 'hero',
      version: 1,
      visible: true,
      heading: eventName.slice(0, 120),
      body: 'Tell people in one or two sentences why this event matters.',
      ctaLabel: 'Register now',
    },
    {
      id: 'about',
      type: 'text',
      version: 1,
      visible: true,
      heading: 'About',
      body: 'What attendees will learn, who it is for, and what makes it worth their time.',
    },
    { id: 'agenda', type: 'agenda', version: 1, visible: true, heading: 'Agenda', items: [] },
    { id: 'speakers', type: 'speakers', version: 1, visible: true, heading: 'Speakers', items: [] },
    {
      id: 'register',
      type: 'register',
      version: 1,
      visible: true,
      heading: 'Save your seat',
      body: 'Places are limited.',
      ctaLabel: 'Register now',
    },
  ];
}
