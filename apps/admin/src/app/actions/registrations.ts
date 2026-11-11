'use server';

import { redirect } from 'next/navigation';
import { api, unwrap } from '@/lib/api';
import { errorToFormState, type FormState } from '@/lib/errors';
import { formText } from '@/lib/form-data';

const UUID = /^[0-9a-f-]{36}$/i;

/** Organizer cancels an attendee's registration (ADR-0023). The attendee is emailed. */
export async function cancelRegistrationAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const organizationId = formText(form, 'organizationId');
  const eventId = formText(form, 'eventId');
  const registrationId = formText(form, 'registrationId');
  if (![organizationId, eventId, registrationId].every((id) => UUID.test(id))) {
    return { ok: false, message: 'Something went wrong. Please try again.' };
  }
  try {
    const client = await api();
    unwrap(
      await client.POST(
        '/v1/organizations/{organizationId}/events/{eventId}/registrations/{registrationId}/cancel',
        {
          params: {
            path: { organizationId, eventId, registrationId },
            header: { 'Idempotency-Key': formText(form, 'idempotencyKey') },
          },
        },
      ),
    );
  } catch (error) {
    return errorToFormState(error);
  }
  const notice =
    formText(form, 'waitlisted') === 'yes' ? 'waitlist_removed' : 'registration_cancelled';
  redirect(`/orgs/${organizationId}/events/${eventId}/registrations?notice=${notice}`);
}

/**
 * Organizer gives someone on the waitlist a seat (ADR-0035), out of turn and even beyond
 * capacity. They are emailed their confirmation.
 */
export async function promoteRegistrationAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const organizationId = formText(form, 'organizationId');
  const eventId = formText(form, 'eventId');
  const registrationId = formText(form, 'registrationId');
  if (![organizationId, eventId, registrationId].every((id) => UUID.test(id))) {
    return { ok: false, message: 'Something went wrong. Please try again.' };
  }
  try {
    const client = await api();
    unwrap(
      await client.POST(
        '/v1/organizations/{organizationId}/events/{eventId}/registrations/{registrationId}/promote',
        {
          params: {
            path: { organizationId, eventId, registrationId },
            header: { 'Idempotency-Key': formText(form, 'idempotencyKey') },
          },
        },
      ),
    );
  } catch (error) {
    return errorToFormState(error);
  }
  redirect(
    `/orgs/${organizationId}/events/${eventId}/registrations?status=waitlisted&notice=registration_promoted`,
  );
}
