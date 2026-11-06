'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { components } from '@/lib/api-types';
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

type OrgUpdate = components['schemas']['UpdateOrganizationRequest'];
const UUID = /^[0-9a-f-]{36}$/i;

function settingsTarget(form: FormData): { organizationId: string; expectedVersion: number } {
  const organizationId = str(form, 'organizationId');
  const expectedVersion = Number(str(form, 'expectedVersion'));
  if (!UUID.test(organizationId) || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error('Malformed settings form');
  }
  return { organizationId, expectedVersion };
}

/**
 * Sends only what changed, compared with the organization as stored now. The API checks
 * permission per field and `expectedVersion` catches edits made by someone else meanwhile.
 */
async function saveOrganization(
  form: FormData,
  diff: (current: components['schemas']['Organization']) => Omit<OrgUpdate, 'expectedVersion'>,
  successMessage: string,
  /** API field name → form input name, where they differ. */
  fieldMap: Record<string, string> = {},
): Promise<FormState> {
  try {
    const { organizationId, expectedVersion } = settingsTarget(form);
    const client = await api();
    const path = { organizationId };
    const current = unwrap(
      await client.GET('/v1/organizations/{organizationId}', { params: { path } }),
    );
    const changes = diff(current);
    if (Object.keys(changes).length === 0) return { ok: true, message: 'No changes to save.' };
    unwrap(
      await client.PATCH('/v1/organizations/{organizationId}', {
        params: { path, header: { 'Idempotency-Key': str(form, 'idempotencyKey') } },
        body: { expectedVersion, ...changes },
      }),
    );
    revalidatePath(`/orgs/${organizationId}`, 'layout');
    return { ok: true, message: successMessage };
  } catch (error) {
    const state = errorToFormState(error);
    if (state.fields) {
      state.fields = Object.fromEntries(
        Object.entries(state.fields).map(([k, v]) => [fieldMap[k] ?? k, v]),
      );
    }
    return { ...state, values: submittedValues(form) };
  }
}

export async function updateOrganizationProfileAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const displayName = str(form, 'displayName');
  if (!displayName) {
    return {
      ok: false,
      message: 'Check the highlighted fields.',
      fields: { displayName: 'Enter the organization name.' },
      values: submittedValues(form),
    };
  }
  const legalName = str(form, 'legalName') || null;
  const locale = str(form, 'locale');
  const timezone = str(form, 'timezone');
  return saveOrganization(
    form,
    (current) => ({
      ...(displayName !== current.displayName ? { displayName } : {}),
      ...(legalName !== current.legalName ? { legalName } : {}),
      ...(locale && locale !== current.locale ? { locale } : {}),
      ...(timezone && timezone !== current.timezone ? { timezone } : {}),
    }),
    'Organization profile saved.',
  );
}

export async function updateBillingContactAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const name = str(form, 'billingName');
  const email = str(form, 'billingEmail');
  if (Boolean(name) !== Boolean(email)) {
    return {
      ok: false,
      message: 'Check the highlighted fields.',
      fields: name
        ? { billingEmail: 'Enter an email address, or clear both fields.' }
        : { billingName: 'Enter a name, or clear both fields.' },
      values: submittedValues(form),
    };
  }
  const next = name ? { name, email } : null;
  return saveOrganization(
    form,
    (current) => {
      const now = current.billingContact;
      const stored = now?.name && now.email ? { name: now.name, email: now.email } : null;
      const same = JSON.stringify(stored) === JSON.stringify(next);
      return same ? {} : { billingContact: next };
    },
    next ? 'Billing contact saved.' : 'Billing contact removed.',
    { name: 'billingName', email: 'billingEmail' },
  );
}
