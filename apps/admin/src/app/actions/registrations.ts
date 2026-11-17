'use server';

import { redirect } from 'next/navigation';
import { api, unwrap } from '@/lib/api';
import { errorToFormState, type FormState } from '@/lib/errors';
import { formText } from '@/lib/form-data';
import { BULK_DECIDE_MAX } from '@/lib/registrations';

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

/**
 * Organizer approves or declines a request (ADR-0064). Approved: they are registered and emailed
 * their ticket. Declined: they are told, with no reason given.
 */
export async function decideRegistrationAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const organizationId = formText(form, 'organizationId');
  const eventId = formText(form, 'eventId');
  const registrationId = formText(form, 'registrationId');
  const decision = formText(form, 'decision');
  if (
    ![organizationId, eventId, registrationId].every((id) => UUID.test(id)) ||
    (decision !== 'approve' && decision !== 'decline')
  ) {
    return { ok: false, message: 'Something went wrong. Please try again.' };
  }
  try {
    const client = await api();
    const options = {
      params: {
        path: { organizationId, eventId, registrationId },
        header: { 'Idempotency-Key': formText(form, 'idempotencyKey') },
      },
    };
    unwrap(
      decision === 'approve'
        ? await client.POST(
            '/v1/organizations/{organizationId}/events/{eventId}/registrations/{registrationId}/approve',
            options,
          )
        : await client.POST(
            '/v1/organizations/{organizationId}/events/{eventId}/registrations/{registrationId}/decline',
            options,
          ),
    );
  } catch (error) {
    return errorToFormState(error);
  }
  redirect(
    `/orgs/${organizationId}/events/${eventId}/registrations?status=pending&notice=request_${decision === 'approve' ? 'approved' : 'declined'}`,
  );
}

/**
 * Approves or declines several requests at once (ADR-0066). Each is emailed as a single decision
 * would be; requests someone else already dealt with are counted and left.
 */
export async function bulkDecideRegistrationsAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const organizationId = formText(form, 'organizationId');
  const eventId = formText(form, 'eventId');
  const decision = formText(form, 'decision');
  const registrationIds = [
    ...new Set(form.getAll('registrationIds').filter((v) => typeof v === 'string')),
  ];
  if (
    ![organizationId, eventId].every((id) => UUID.test(id)) ||
    (decision !== 'approve' && decision !== 'decline')
  ) {
    return { ok: false, message: 'Something went wrong. Please try again.' };
  }
  if (registrationIds.length === 0) {
    return { ok: false, message: 'Select at least one request.' };
  }
  if (registrationIds.length > BULK_DECIDE_MAX || !registrationIds.every((id) => UUID.test(id))) {
    return { ok: false, message: `Select up to ${BULK_DECIDE_MAX} requests at a time.` };
  }
  let result;
  try {
    const client = await api();
    result = unwrap(
      await client.POST(
        '/v1/organizations/{organizationId}/events/{eventId}/registrations/decide',
        {
          params: {
            path: { organizationId, eventId },
            header: { 'Idempotency-Key': formText(form, 'idempotencyKey') },
          },
          body: { decision, registrationIds },
        },
      ),
    );
  } catch (error) {
    return errorToFormState(error);
  }
  const skipped = result.results.length - result.decided;
  redirect(
    `/orgs/${organizationId}/events/${eventId}/registrations?status=pending&notice=requests_${decision === 'approve' ? 'approved' : 'declined'}&decided=${result.decided}&skipped=${skipped}`,
  );
}
