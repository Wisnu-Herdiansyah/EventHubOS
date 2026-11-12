'use server';

import { revalidatePath } from 'next/cache';
import { api, unwrap } from '@/lib/api';
import { errorToFormState, type FormState } from '@/lib/errors';
import { formText } from '@/lib/form-data';

const UUID = /^[0-9a-f-]{36}$/i;

/** Saves the signed-in person's own download alert choice for one organization (ADR-0049). */
export async function updateDownloadAlertsAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const organizationId = formText(form, 'organizationId');
  if (!UUID.test(organizationId)) {
    return { ok: false, message: 'Something went wrong. Please try again.' };
  }
  const enabled = form.get('dataDownload') === 'on';
  try {
    const client = await api();
    unwrap(
      await client.PATCH('/v1/organizations/{organizationId}/notification-settings/{kind}', {
        params: {
          path: { organizationId, kind: 'data_download' },
          header: { 'Idempotency-Key': formText(form, 'idempotencyKey') },
        },
        body: { enabled },
      }),
    );
  } catch (error) {
    return errorToFormState(error);
  }
  revalidatePath(`/orgs/${organizationId}/settings`);
  return {
    ok: true,
    message: enabled
      ? 'Saved. You’ll be emailed when someone downloads attendee lists or the audit log.'
      : 'Saved. You won’t be emailed about downloads. They are still in the audit log.',
  };
}
