'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { components } from '@/lib/api-types';
import { api, unwrap } from '@/lib/api';
import { errorToFormState, type FormState } from '@/lib/errors';
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
  return {
    visibility: (str(form, 'visibility') || 'public') as SettingsPatch['visibility'],
    sharing: section({ title: opt('title'), description: opt('description') }),
    legal: section({ privacyPolicyUrl: opt('privacyPolicyUrl'), termsUrl: opt('termsUrl') }),
    contact: section({ email: opt('email'), url: opt('contactUrl') }),
    registration: section({
      opensAt: instant(form, 'opensAt', timeZone, fields),
      closesAt: instant(form, 'closesAt', timeZone, fields),
      capacity,
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
