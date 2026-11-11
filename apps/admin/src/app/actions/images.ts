'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, unwrap } from '@/lib/api';
import { errorToFormState, type FormState } from '@/lib/errors';
import { formText, submittedValues } from '@/lib/form-data';
import { imageNameFromFile, uploadProblem } from '@/lib/images';

const UUID = /^[0-9a-f-]{36}$/i;
const SOMETHING_WRONG: FormState = {
  ok: false,
  message: 'Something went wrong. Please try again.',
};

/** Uploads an image to the organization's library (ADR-0042). The API re-encodes it. */
export async function uploadImageAction(_prev: FormState, form: FormData): Promise<FormState> {
  const organizationId = formText(form, 'organizationId');
  if (!UUID.test(organizationId)) return SOMETHING_WRONG;
  const file = form.get('data');
  if (!(file instanceof File)) {
    return {
      ok: false,
      message: 'Check the highlighted fields.',
      fields: { data: 'Choose an image to upload.' },
    };
  }
  const problem = uploadProblem(file);
  if (problem) {
    return { ok: false, message: 'Check the highlighted fields.', fields: { data: problem } };
  }
  const values = submittedValues(form);
  try {
    const client = await api();
    unwrap(
      await client.POST('/v1/organizations/{organizationId}/assets', {
        params: {
          path: { organizationId },
          header: { 'Idempotency-Key': formText(form, 'idempotencyKey') },
        },
        body: {
          name: formText(form, 'name') || imageNameFromFile(file.name),
          altText: formText(form, 'altText'),
          data: Buffer.from(await file.arrayBuffer()).toString('base64'),
        },
      }),
    );
  } catch (error) {
    return { ...errorToFormState(error), values };
  }
  redirect(`/orgs/${organizationId}/images?notice=uploaded`);
}

/** Renames an image or changes its text alternative. */
export async function updateImageAction(_prev: FormState, form: FormData): Promise<FormState> {
  const organizationId = formText(form, 'organizationId');
  const assetId = formText(form, 'assetId');
  if (!UUID.test(organizationId) || !UUID.test(assetId)) return SOMETHING_WRONG;
  try {
    const client = await api();
    unwrap(
      await client.PATCH('/v1/organizations/{organizationId}/assets/{assetId}', {
        params: {
          path: { organizationId, assetId },
          header: { 'Idempotency-Key': formText(form, 'idempotencyKey') },
        },
        body: { name: formText(form, 'name'), altText: formText(form, 'altText') },
      }),
    );
  } catch (error) {
    return { ...errorToFormState(error), values: submittedValues(form) };
  }
  revalidatePath(`/orgs/${organizationId}/images`);
  return { ok: true, message: 'Image updated.' };
}

/** Deletes an image; the API refuses while a page uses it and says which. */
export async function deleteImageAction(_prev: FormState, form: FormData): Promise<FormState> {
  const organizationId = formText(form, 'organizationId');
  const assetId = formText(form, 'assetId');
  if (!UUID.test(organizationId) || !UUID.test(assetId)) return SOMETHING_WRONG;
  try {
    const client = await api();
    unwrap(
      await client.POST('/v1/organizations/{organizationId}/assets/{assetId}/delete', {
        params: {
          path: { organizationId, assetId },
          header: { 'Idempotency-Key': formText(form, 'idempotencyKey') },
        },
      }),
    );
  } catch (error) {
    return errorToFormState(error);
  }
  redirect(`/orgs/${organizationId}/images?notice=deleted`);
}
