'use server';

import { redirect } from 'next/navigation';
import { api, unwrap } from '@/lib/api';
import { errorToFormState, type FormState } from '@/lib/errors';
import { formText, submittedValues } from '@/lib/form-data';

const UUID = /^[0-9a-f-]{36}$/i;

/** Sends an announcement to the people signed up for an event (ADR-0037). */
export async function sendAnnouncementAction(_prev: FormState, form: FormData): Promise<FormState> {
  const organizationId = formText(form, 'organizationId');
  const eventId = formText(form, 'eventId');
  if (![organizationId, eventId].every((id) => UUID.test(id))) {
    return { ok: false, message: 'Something went wrong. Please try again.' };
  }
  const audience =
    formText(form, 'audience') === 'registered_and_waitlist'
      ? 'registered_and_waitlist'
      : 'registered';
  try {
    const client = await api();
    unwrap(
      await client.POST('/v1/organizations/{organizationId}/events/{eventId}/announcements', {
        params: {
          path: { organizationId, eventId },
          header: { 'Idempotency-Key': formText(form, 'idempotencyKey') },
        },
        // The message keeps its line breaks; the API trims the ends.
        body: {
          subject: formText(form, 'subject'),
          body: formText(form, 'body', { trim: false }),
          audience,
        },
      }),
    );
  } catch (error) {
    return { ...errorToFormState(error), values: submittedValues(form) };
  }
  redirect(`/orgs/${organizationId}/events/${eventId}/announcements?notice=sent`);
}
