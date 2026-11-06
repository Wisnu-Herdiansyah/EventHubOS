'use server';

import { redirect } from 'next/navigation';
import { api, unwrap } from '@/lib/api';
import { errorToFormState, type FormState } from '@/lib/errors';
import { formText, submittedValues } from '@/lib/form-data';

const str = (form: FormData, key: string) => formText(form, key);

export async function createOrganizationAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  let id: string;
  try {
    const client = await api();
    const org = unwrap(
      await client.POST('/v1/organizations', {
        params: { header: { 'Idempotency-Key': str(form, 'idempotencyKey') } },
        body: {
          displayName: str(form, 'displayName'),
          locale: str(form, 'locale'),
          timezone: str(form, 'timezone'),
        },
      }),
    );
    id = org.id;
  } catch (error) {
    return { ...errorToFormState(error), values: submittedValues(form) };
  }
  redirect(`/orgs/${id}`);
}
