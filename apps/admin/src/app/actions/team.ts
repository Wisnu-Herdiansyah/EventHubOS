'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { components } from '@/lib/api-types';
import { api, unwrap } from '@/lib/api';
import { errorToFormState, type FormState } from '@/lib/errors';
import { formText, submittedValues } from '@/lib/form-data';

type Role = components['schemas']['CreateInvitationRequest']['role'];

const UUID = /^[0-9a-f-]{36}$/i;

function uuidField(form: FormData, key: string): string {
  const value = formText(form, key);
  if (!UUID.test(value)) throw new Error(`Malformed ${key}`);
  return value;
}

function idempotency(form: FormData) {
  return { 'Idempotency-Key': formText(form, 'idempotencyKey') };
}

const teamPath = (organizationId: string) => `/orgs/${organizationId}/team`;

export async function inviteMemberAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const organizationId = uuidField(form, 'organizationId');
    const email = formText(form, 'email');
    if (!email) {
      return {
        ok: false,
        message: 'Check the highlighted fields.',
        fields: { email: 'Enter an email address.' },
        values: submittedValues(form),
      };
    }
    const client = await api();
    const invitation = unwrap(
      await client.POST('/v1/organizations/{organizationId}/invitations', {
        params: { path: { organizationId }, header: idempotency(form) },
        body: { email, role: formText(form, 'role') as Role },
      }),
    );
    revalidatePath(teamPath(organizationId));
    return { ok: true, message: `Invitation sent to ${invitation.email}.` };
  } catch (error) {
    return { ...errorToFormState(error), values: submittedValues(form) };
  }
}

export async function revokeInvitationAction(_prev: FormState, form: FormData): Promise<FormState> {
  let target: string;
  try {
    const organizationId = uuidField(form, 'organizationId');
    const invitationId = uuidField(form, 'invitationId');
    const client = await api();
    unwrap(
      await client.POST('/v1/organizations/{organizationId}/invitations/{invitationId}/revoke', {
        params: { path: { organizationId, invitationId }, header: idempotency(form) },
      }),
    );
    target = `${teamPath(organizationId)}?notice=invitation_revoked`;
  } catch (error) {
    return errorToFormState(error);
  }
  // The revoked row disappears, so the confirmation is shown at page level.
  redirect(target);
}

export async function changeMemberRoleAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const organizationId = uuidField(form, 'organizationId');
    const membershipId = uuidField(form, 'membershipId');
    const client = await api();
    const member = unwrap(
      await client.POST('/v1/organizations/{organizationId}/members/{membershipId}/role', {
        params: { path: { organizationId, membershipId }, header: idempotency(form) },
        body: { role: formText(form, 'role') as Role },
      }),
    );
    revalidatePath(teamPath(organizationId));
    return { ok: true, message: `Role updated for ${member.email}.` };
  } catch (error) {
    return { ...errorToFormState(error), values: submittedValues(form) };
  }
}

export async function removeMemberAction(_prev: FormState, form: FormData): Promise<FormState> {
  let target: string;
  try {
    const organizationId = uuidField(form, 'organizationId');
    const membershipId = uuidField(form, 'membershipId');
    const client = await api();
    unwrap(
      await client.POST('/v1/organizations/{organizationId}/members/{membershipId}/remove', {
        params: { path: { organizationId, membershipId }, header: idempotency(form) },
      }),
    );
    // Navigation only; the API already decided whether the removal was allowed. Someone who
    // left has no access to the team page any more.
    target =
      formText(form, 'self') === '1' ? '/' : `${teamPath(organizationId)}?notice=member_removed`;
  } catch (error) {
    return errorToFormState(error);
  }
  redirect(target);
}
