'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { components } from '@/lib/api-types';
import { api, unwrap } from '@/lib/api';
import { ApiError, errorToFormState, type FormState } from '@/lib/errors';
import { zonedLocalToIso } from '@/lib/time';
import { formText, submittedValues } from '@/lib/form-data';

const str = (form: FormData, key: string) => formText(form, key);
const UUID = /^[0-9a-f-]{36}$/i;

function ids(form: FormData): { organizationId: string; eventId?: string } {
  const organizationId = str(form, 'organizationId');
  const eventId = str(form, 'eventId') || undefined;
  if (!UUID.test(organizationId) || (eventId && !UUID.test(eventId)))
    throw new Error('Malformed identifiers');
  return { organizationId, ...(eventId ? { eventId } : {}) };
}

/** Wall-clock input in the event time zone → instant, with a field error when malformed. */
function instant(
  form: FormData,
  key: string,
  timeZone: string,
  fields: Record<string, string>,
): string | undefined {
  const raw = str(form, key);
  if (!raw) return undefined;
  const iso = zonedLocalToIso(raw, timeZone);
  if (!iso) fields[key] = 'Enter a date and time.';
  return iso ?? undefined;
}

export async function createEventAction(_prev: FormState, form: FormData): Promise<FormState> {
  let target: string;
  try {
    const { organizationId } = ids(form);
    const timezone = str(form, 'timezone');
    const fields: Record<string, string> = {};
    const startsAt = instant(form, 'startsAt', timezone, fields);
    const endsAt = instant(form, 'endsAt', timezone, fields);
    if (!startsAt) fields.startsAt ??= 'Required.';
    if (!endsAt) fields.endsAt ??= 'Required.';
    if (Object.keys(fields).length > 0)
      return {
        ok: false,
        message: 'Check the highlighted fields.',
        fields,
        values: submittedValues(form),
      };
    const client = await api();
    const evt = unwrap(
      await client.POST('/v1/organizations/{organizationId}/events', {
        params: {
          path: { organizationId },
          header: { 'Idempotency-Key': str(form, 'idempotencyKey') },
        },
        body: {
          name: str(form, 'name'),
          slug: str(form, 'slug'),
          timezone,
          startsAt: startsAt!,
          endsAt: endsAt!,
          venueMode: str(
            form,
            'venueMode',
          ) as components['schemas']['CreateEventRequest']['venueMode'],
          primaryLanguage: str(form, 'primaryLanguage'),
        },
      }),
    );
    target = `/orgs/${organizationId}/events/${evt.id}`;
  } catch (error) {
    return { ...errorToFormState(error), values: submittedValues(form) };
  }
  redirect(target);
}

/**
 * Copies an event into a new draft (ADR-0036) and opens it. The copy keeps the original's length;
 * only the start is asked for, in the event's time zone.
 */
export async function duplicateEventAction(_prev: FormState, form: FormData): Promise<FormState> {
  let target: string;
  try {
    const { organizationId, eventId } = ids(form);
    const fields: Record<string, string> = {};
    const startsAt = instant(form, 'startsAt', str(form, 'timezone'), fields);
    if (!startsAt) fields.startsAt ??= 'Enter a date and time.';
    if (Object.keys(fields).length > 0 || !eventId)
      return {
        ok: false,
        message: 'Check the highlighted fields.',
        fields,
        values: submittedValues(form),
      };
    const client = await api();
    const copy = unwrap(
      await client.POST('/v1/organizations/{organizationId}/events/{eventId}/duplicate', {
        params: {
          path: { organizationId, eventId },
          header: { 'Idempotency-Key': str(form, 'idempotencyKey') },
        },
        body: { name: str(form, 'name'), slug: str(form, 'slug'), startsAt: startsAt! },
      }),
    );
    target = `/orgs/${organizationId}/events/${copy.id}?notice=duplicated`;
  } catch (error) {
    return { ...errorToFormState(error), values: submittedValues(form) };
  }
  redirect(target);
}

type SettingsPatch = NonNullable<components['schemas']['UpdateEventRequest']['settings']>;

/** Builds a settings patch: each section is replaced as a whole, or cleared when left empty. */
function settingsFromForm(
  form: FormData,
  timeZone: string,
  fields: Record<string, string>,
): SettingsPatch {
  const opt = (k: string) => str(form, k) || undefined;
  const section = <T extends Record<string, unknown>>(obj: T): T | null =>
    Object.values(obj).some((v) => v !== undefined) ? obj : null;
  const capacityRaw = str(form, 'capacity');
  const capacity = capacityRaw ? Number(capacityRaw) : undefined;
  if (capacityRaw && (!Number.isInteger(capacity) || capacity! < 1))
    fields.capacity = 'Enter a whole number of at least 1.';
  const waitlist = form.get('waitlist') === 'on' ? true : undefined;
  if (waitlist && !capacityRaw) fields.waitlist = 'Set a capacity to use a waitlist.';
  const limitRaw = str(form, 'waitlistLimit');
  const waitlistLimit = waitlist && limitRaw ? Number(limitRaw) : undefined;
  if (waitlist && limitRaw && (!Number.isInteger(waitlistLimit) || waitlistLimit! < 1))
    fields.waitlistLimit = 'Enter a whole number of at least 1, or leave it empty.';
  return {
    visibility: (str(form, 'visibility') || 'public') as SettingsPatch['visibility'],
    // The standard colours are the absence of a theme (ADR-0046).
    theme:
      str(form, 'theme') && str(form, 'theme') !== 'default'
        ? (str(form, 'theme') as SettingsPatch['theme'])
        : null,
    sharing: section({
      title: opt('title'),
      description: opt('description'),
      imageAssetId: opt('sharingImage'),
    }),
    legal: section({ privacyPolicyUrl: opt('privacyPolicyUrl'), termsUrl: opt('termsUrl') }),
    contact: section({ email: opt('email'), url: opt('contactUrl') }),
    registration: section({
      opensAt: instant(form, 'opensAt', timeZone, fields),
      closesAt: instant(form, 'closesAt', timeZone, fields),
      capacity,
      waitlist,
      waitlistLimit,
    }),
  };
}

export async function updateEventSettingsAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  try {
    const { organizationId, eventId } = ids(form);
    const fields: Record<string, string> = {};
    const settings = settingsFromForm(form, str(form, 'timezone'), fields);
    if (Object.keys(fields).length > 0)
      return {
        ok: false,
        message: 'Check the highlighted fields.',
        fields,
        values: submittedValues(form),
      };
    const client = await api();
    // The registration section is replaced as a whole: keep the questions, which have their own
    // editor (ADR-0041).
    const current = unwrap(
      await client.GET('/v1/organizations/{organizationId}/events/{eventId}', {
        params: { path: { organizationId, eventId: eventId! } },
      }),
    );
    const questions = current.settings.registration?.questions;
    if (questions && questions.length > 0) {
      settings.registration = { ...(settings.registration ?? {}), questions };
    }
    unwrap(
      await client.PATCH('/v1/organizations/{organizationId}/events/{eventId}', {
        params: {
          path: { organizationId, eventId: eventId! },
          header: { 'Idempotency-Key': str(form, 'idempotencyKey') },
        },
        body: { expectedVersion: Number(str(form, 'expectedVersion')), settings },
      }),
    );
    revalidatePath(`/orgs/${organizationId}/events/${eventId}`);
    return { ok: true, message: 'Settings saved.' };
  } catch (error) {
    return { ...errorToFormState(error), values: submittedValues(form) };
  }
}

type Question = components['schemas']['RegistrationQuestion'];

/**
 * Saves the registration questions (ADR-0041), keeping the rest of the registration settings.
 * The questions arrive as JSON from the editor; the API validates them.
 */
export async function updateRegistrationQuestionsAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  try {
    const { organizationId, eventId } = ids(form);
    let questions: Question[];
    try {
      const parsed: unknown = JSON.parse(str(form, 'questions') || '[]');
      if (!Array.isArray(parsed)) throw new Error('not a list');
      questions = parsed as Question[];
    } catch {
      return { ok: false, message: 'Something went wrong. Please try again.' };
    }
    const client = await api();
    const current = unwrap(
      await client.GET('/v1/organizations/{organizationId}/events/{eventId}', {
        params: { path: { organizationId, eventId: eventId! } },
      }),
    );
    const { questions: _old, ...rest } = current.settings.registration ?? {};
    const registration = questions.length > 0 ? { ...rest, questions } : rest;
    unwrap(
      await client.PATCH('/v1/organizations/{organizationId}/events/{eventId}', {
        params: {
          path: { organizationId, eventId: eventId! },
          header: { 'Idempotency-Key': str(form, 'idempotencyKey') },
        },
        body: {
          expectedVersion: Number(str(form, 'expectedVersion')),
          settings: { registration: Object.keys(registration).length > 0 ? registration : null },
        },
      }),
    );
    revalidatePath(`/orgs/${organizationId}/events/${eventId}`);
    return { ok: true, message: 'Questions saved.' };
  } catch (error) {
    if (error instanceof ApiError && error.fields.length > 0) {
      return {
        ok: false,
        message: 'Some questions need attention.',
        fields: Object.fromEntries(error.fields.map((f, i) => [String(i), questionIssue(f)])),
      };
    }
    return errorToFormState(error);
  }
}

const QUESTION_FIELDS: Record<string, string> = {
  label: 'Question',
  options: 'Options',
  help: 'Hint',
  id: 'ID',
};

/** "Question 2 · Options: Give at least two options." from an API field path. */
function questionIssue(f: { path: string; message: string }): string {
  const m = /questions\.(\d+)(?:\.([A-Za-z]+))?/.exec(f.path);
  if (!m) return f.message;
  const part = m[2] ? ` · ${QUESTION_FIELDS[m[2]] ?? m[2]}` : '';
  return `Question ${Number(m[1]) + 1}${part}: ${f.message}`;
}

export async function transitionEventAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { organizationId, eventId } = ids(form);
    const client = await api();
    const evt = unwrap(
      await client.POST('/v1/organizations/{organizationId}/events/{eventId}/transitions', {
        params: {
          path: { organizationId, eventId: eventId! },
          header: { 'Idempotency-Key': str(form, 'idempotencyKey') },
        },
        body: {
          to: str(form, 'to') as components['schemas']['EventTransitionRequest']['to'],
          expectedVersion: Number(str(form, 'expectedVersion')),
          acknowledgedWarnings: form.getAll('acknowledgedWarnings').map(String),
        },
      }),
    );
    revalidatePath(`/orgs/${organizationId}/events/${eventId}`);
    return { ok: true, message: `Event is now ${evt.lifecycle}.` };
  } catch (error) {
    return errorToFormState(error);
  }
}
