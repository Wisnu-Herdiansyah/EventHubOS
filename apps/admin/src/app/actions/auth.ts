'use server';

import { redirect } from 'next/navigation';
import { api, unwrap } from '@/lib/api';
import { errorToFormState, type FormState } from '@/lib/errors';
import { safeNext } from '@/lib/redirect';
import { clearSession, writeSession } from '@/lib/session';
import { formText, submittedValues } from '@/lib/form-data';

const str = (form: FormData, key: string) => formText(form, key, { trim: false });

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const client = await api();
    const session = unwrap(
      await client.POST('/v1/auth/login', {
        body: { email: str(form, 'email'), password: str(form, 'password') },
      }),
    );
    await writeSession(session.token, session.expiresAt);
  } catch (error) {
    return { ...errorToFormState(error), values: submittedValues(form) };
  }
  redirect(safeNext(form.get('next')));
}

export async function signupAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const client = await api();
    const res = unwrap(
      await client.POST('/v1/auth/signup', {
        body: { email: str(form, 'email'), password: str(form, 'password') },
      }),
    );
    return {
      ok: true,
      message: `${res.message} Open the link in that email to verify your address.`,
    };
  } catch (error) {
    return { ...errorToFormState(error), values: submittedValues(form) };
  }
}

/** The token comes from the URL fragment (never sent to servers by the browser) via the page. */
export async function verifyEmailAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const client = await api();
    unwrap(await client.POST('/v1/auth/verify-email', { body: { token: str(form, 'token') } }));
    return { ok: true, message: 'Your email address is verified. You can sign in now.' };
  } catch (error) {
    return errorToFormState(error);
  }
}

export async function logoutAction(): Promise<void> {
  try {
    const client = await api();
    await client.POST('/v1/auth/logout');
  } catch {
    // The cookie is cleared regardless; an already-expired session is fine.
  }
  await clearSession();
  redirect('/login');
}

export async function acceptInvitationAction(_prev: FormState, form: FormData): Promise<FormState> {
  let organizationId: string;
  try {
    const client = await api();
    const res = unwrap(
      await client.POST('/v1/invitations/accept', { body: { token: str(form, 'token') } }),
    );
    organizationId = res.organizationId;
  } catch (error) {
    return errorToFormState(error);
  }
  redirect(`/orgs/${organizationId}`);
}
