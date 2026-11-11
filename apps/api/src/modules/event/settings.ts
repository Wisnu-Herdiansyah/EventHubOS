import { z } from 'zod';

/**
 * Event settings (EVT-02), stored as versioned JSON on `event.settings`. JSON is used only for
 * presentation/configuration that has no relational meaning; ownership, lifecycle, and schedule
 * stay in columns. Bump SETTINGS_VERSION and add a migration step when the shape changes.
 *
 * Not yet here: theme/brand selection and sharing image (depend on the Phase 2 design system and
 * asset library).
 */
export const SETTINGS_VERSION = 1;

const httpsUrl = z
  .url({ protocol: /^https$/, hostname: z.regexes.domain })
  .max(2048)
  .describe('HTTPS URL');

export const visibilitySchema = z.enum(['public', 'unlisted', 'private']);

const sections = {
  visibility: visibilitySchema,
  registration: z
    .object({
      opensAt: z.iso.datetime({ offset: true }).optional(),
      closesAt: z.iso.datetime({ offset: true }).optional(),
      capacity: z.number().int().min(1).max(1_000_000).optional(),
      /** When full, sign-ups join a waitlist and get freed seats in order (ADR-0035). */
      waitlist: z.boolean().optional(),
      /** At most this many people waiting; then the event is full again (ADR-0038). */
      waitlistLimit: z.number().int().min(1).max(10_000).optional(),
    })
    .strict(),
  sharing: z
    .object({
      title: z.string().trim().min(1).max(70).optional(),
      description: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  contact: z
    .object({
      email: z.email().max(254).optional(),
      phone: z
        .string()
        .regex(/^\+[1-9]\d{6,14}$/, 'Use international format, e.g. +6281234567890')
        .optional(),
      url: httpsUrl.optional(),
    })
    .strict(),
  legal: z
    .object({
      privacyPolicyUrl: httpsUrl.optional(),
      termsUrl: httpsUrl.optional(),
      codeOfConductUrl: httpsUrl.optional(),
    })
    .strict(),
};

export const eventSettingsSchema = z
  .object({
    visibility: sections.visibility.optional(),
    registration: sections.registration.optional(),
    sharing: sections.sharing.optional(),
    contact: sections.contact.optional(),
    legal: sections.legal.optional(),
  })
  .strict()
  .meta({ id: 'EventSettings' });

export type EventSettings = z.infer<typeof eventSettingsSchema>;

/** PATCH shape: each provided section replaces the stored one; `null` clears it. */
export const eventSettingsPatchSchema = z
  .object({
    visibility: sections.visibility.nullable().optional(),
    registration: sections.registration.nullable().optional(),
    sharing: sections.sharing.nullable().optional(),
    contact: sections.contact.nullable().optional(),
    legal: sections.legal.nullable().optional(),
  })
  .strict()
  .meta({ id: 'EventSettingsPatch' });

export type EventSettingsPatch = z.infer<typeof eventSettingsPatchSchema>;

export function applySettingsPatch(
  current: EventSettings,
  patch: EventSettingsPatch,
): EventSettings {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return eventSettingsSchema.parse(next);
}

export interface Schedule {
  startsAt: Date;
  endsAt: Date;
}

/**
 * Cross-field coherence (EVT-02: "dates, capacity, routing, or required public metadata must not
 * be incoherent"). Returns field issues; empty means coherent.
 */
export function settingsIssues(
  settings: EventSettings,
  schedule: Schedule,
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const reg = settings.registration;
  if (schedule.endsAt <= schedule.startsAt) {
    issues.push({ path: 'body.endsAt', message: 'endsAt must be after startsAt.' });
  }
  if (reg?.opensAt && reg.closesAt && Date.parse(reg.closesAt) <= Date.parse(reg.opensAt)) {
    issues.push({
      path: 'body.settings.registration.closesAt',
      message: 'Registration must close after it opens.',
    });
  }
  if (reg?.opensAt && Date.parse(reg.opensAt) >= schedule.endsAt.getTime()) {
    issues.push({
      path: 'body.settings.registration.opensAt',
      message: 'Registration must open before the event ends.',
    });
  }
  if (reg?.closesAt && Date.parse(reg.closesAt) > schedule.endsAt.getTime()) {
    issues.push({
      path: 'body.settings.registration.closesAt',
      message: 'Registration cannot close after the event ends.',
    });
  }
  if (reg?.waitlistLimit !== undefined && !reg.waitlist) {
    issues.push({
      path: 'body.settings.registration.waitlistLimit',
      message: 'A waitlist limit needs the waitlist turned on.',
    });
  }
  if (reg?.waitlist && reg.capacity === undefined) {
    issues.push({
      path: 'body.settings.registration.waitlist',
      message: 'A waitlist needs a capacity.',
    });
  }
  return issues;
}
