'use server';

import { revalidatePath } from 'next/cache';
import { api, unwrap } from '@/lib/api';
import { errorToFormState, type FormState } from '@/lib/errors';
import { formText } from '@/lib/form-data';

const UUID = /^[0-9a-f-]{36}$/i;
const HOURS = new Set([1, 8, 24, 72]);
const SOMETHING_WRONG: FormState = {
  ok: false,
  message: 'Something went wrong. Please try again.',
};

/** Lets EventHub support read the organization for a while (ADR-0045). */
export async function grantSupportAccessAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const organizationId = formText(form, 'organizationId');
  const hours = Number(formText(form, 'hours'));
  if (!UUID.test(organizationId) || !HOURS.has(hours)) return SOMETHING_WRONG;
  try {
    const client = await api();
    unwrap(
      await client.POST('/v1/organizations/{organizationId}/support-access', {
        params: {
          path: { organizationId },
          header: { 'Idempotency-Key': formText(form, 'idempotencyKey') },
        },
        body: { hours },
      }),
    );
  } catch (error) {
    return errorToFormState(error);
  }
  revalidatePath(`/orgs/${organizationId}/settings`);
  return { ok: true, message: 'Support access is on. Your Owners have been emailed.' };
}

/** Ends support access now. */
export async function revokeSupportAccessAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const organizationId = formText(form, 'organizationId');
  if (!UUID.test(organizationId)) return SOMETHING_WRONG;
  try {
    const client = await api();
    unwrap(
      await client.POST('/v1/organizations/{organizationId}/support-access/revoke', {
        params: {
          path: { organizationId },
          header: { 'Idempotency-Key': formText(form, 'idempotencyKey') },
        },
      }),
    );
  } catch (error) {
    return errorToFormState(error);
  }
  revalidatePath(`/orgs/${organizationId}/settings`);
  return { ok: true, message: 'Support access is off.' };
}

/** Staff: lifts a bounce suppression by hand (ADR-0043, ADR-0045). */
export async function liftBounceAction(_prev: FormState, form: FormData): Promise<FormState> {
  const address = formText(form, 'address');
  try {
    const client = await api();
    const r = unwrap(
      await client.POST('/v1/platform/email-suppressions/lift-bounce', {
        params: { header: { 'Idempotency-Key': formText(form, 'idempotencyKey') } },
        body: { address },
      }),
    );
    return r.lifted
      ? { ok: true, message: 'Bounce lifted. Emails to this address go out again.' }
      : { ok: false, message: 'Nothing to lift: there is no active bounce for this address.' };
  } catch (error) {
    return errorToFormState(error);
  }
}
