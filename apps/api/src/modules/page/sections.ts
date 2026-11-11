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

const itemId = z.string().regex(/^[a-z0-9-]{1,40}$/, 'Use lowercase letters, digits and hyphens.');

const base = {
  /** Client-generated, stable within a page (used for selection and ordering). */
  id: itemId,
  version: z.literal(1),
  visible: z.boolean(),
  heading: line(120).min(1, 'Add a heading.'),
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Empty, or a time / date (one pattern each, so the API types stay plain strings). */
const OPTIONAL_TIME = /^(([01]\d|2[0-3]):[0-5]\d)?$/;
const OPTIONAL_DAY = /^(\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))?$/;

/** Item IDs must be unique within their section (they are link targets). */
function uniqueItemIds(items: Array<{ id: string }>, ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (seen.has(item.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['items', i, 'id'],
        message: 'Item IDs must be unique.',
      });
    }
    seen.add(item.id);
  });
}

export const heroSection = z
  .object({ ...base, type: z.literal('hero'), body: paragraph(400), ctaLabel: line(40) })
  .strict()
  .meta({ id: 'HeroSection' });

export const textSection = z
  .object({ ...base, type: z.literal('text'), body: paragraph(4000) })
  .strict()
  .meta({ id: 'TextSection' });

/** Agenda v1 (ADR-0020): a time and a title per item. Kept for published revisions. */
export const agendaSectionV1 = z
  .object({
    ...base,
    type: z.literal('agenda'),
    items: z
      .array(
        z
          .object({
            time: z.string().regex(TIME, 'Use 24-hour time, e.g. 09:30.'),
            title: line(160).min(1, 'Add a title.'),
          })
          .strict(),
      )
      .max(50),
  })
  .strict()
  .meta({ id: 'AgendaSection' });

/**
 * Agenda v2 (ADR-0040): sessions with an optional day (multi-day events), start and end, room,
 * description and the speakers presenting. Times are wall-clock times in the event's time zone.
 */
export const agendaSectionV2 = z
  .object({
    ...base,
    version: z.literal(2),
    type: z.literal('agenda'),
    items: z
      .array(
        z
          .object({
            id: itemId,
            /** YYYY-MM-DD, or empty for a one-day event. */
            day: z.string().regex(OPTIONAL_DAY, 'Use a date, e.g. 2027-03-01, or leave it empty.'),
            start: z.string().regex(TIME, 'Use 24-hour time, e.g. 09:30.'),
            /** Empty when open-ended. */
            end: z
              .string()
              .regex(OPTIONAL_TIME, 'Use 24-hour time, e.g. 10:30, or leave it empty.'),
            title: line(160).min(1, 'Add a title.'),
            room: line(60),
            description: paragraph(800),
            /** IDs of speakers (from a speakers section on the same page). */
            speakerIds: z.array(itemId).max(10),
          })
          .strict()
          .refine((i) => !i.end || i.end > i.start, {
            path: ['end'],
            message: 'End after the start.',
          }),
      )
      .max(100),
  })
  .strict()
  .superRefine((sec, ctx) => uniqueItemIds(sec.items, ctx))
  .meta({ id: 'AgendaSectionV2' });

export const agendaSection = z.discriminatedUnion('version', [agendaSectionV1, agendaSectionV2]);

/** Speakers v1 (ADR-0020): name and role. Kept for published revisions. */
export const speakersSectionV1 = z
  .object({
    ...base,
    type: z.literal('speakers'),
    items: z
      .array(z.object({ name: line(100).min(1, 'Add a name.'), role: line(120) }).strict())
      .max(60),
  })
  .strict()
  .meta({ id: 'SpeakersSection' });

/** Speakers v2 (ADR-0040): an ID agenda sessions can link to, and a short bio. No photos yet. */
export const speakersSectionV2 = z
  .object({
    ...base,
    version: z.literal(2),
    type: z.literal('speakers'),
    items: z
      .array(
        z
          .object({
            id: itemId,
            name: line(100).min(1, 'Add a name.'),
            role: line(120),
            bio: paragraph(800),
          })
          .strict(),
      )
      .max(60),
  })
  .strict()
  .superRefine((sec, ctx) => uniqueItemIds(sec.items, ctx))
  .meta({ id: 'SpeakersSectionV2' });

export const speakersSection = z.discriminatedUnion('version', [
  speakersSectionV1,
  speakersSectionV2,
]);

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
    // Speaker IDs are unique across the page: sessions refer to them, and each bio is a link
    // target (ADR-0040).
    const speakerIds = new Set<string>();
    sections.forEach((s, i) => {
      if (s.type !== 'speakers' || s.version !== 2) return;
      s.items.forEach((p, j) => {
        if (speakerIds.has(p.id)) {
          ctx.addIssue({
            code: 'custom',
            path: [i, 'items', j, 'id'],
            message: 'Speaker IDs must be unique on the page.',
          });
        }
        speakerIds.add(p.id);
      });
    });
    // Agenda sessions may only name speakers that exist on the same page.
    sections.forEach((s, i) => {
      if (s.type !== 'agenda' || s.version !== 2) return;
      s.items.forEach((item, j) => {
        item.speakerIds.forEach((sid, k) => {
          if (!speakerIds.has(sid)) {
            ctx.addIssue({
              code: 'custom',
              path: [i, 'items', j, 'speakerIds', k],
              message: 'This speaker is not on the page.',
            });
          }
        });
      });
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
    { id: 'agenda', type: 'agenda', version: 2, visible: true, heading: 'Agenda', items: [] },
    { id: 'speakers', type: 'speakers', version: 2, visible: true, heading: 'Speakers', items: [] },
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
