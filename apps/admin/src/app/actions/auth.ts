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

/**
 * Sends a fresh verification email to the signed-in, unverified user. The idempotency key is
 * rendered once per page, so repeated clicks on one page cannot send a stream of emails.
 */
export async function resendVerificationAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  try {
    const client = await api();
    unwrap(
      await client.POST('/v1/auth/resend-verification', {
        params: { header: { 'Idempotency-Key': str(form, 'idempotencyKey') } },
      }),
    );
    return {
      ok: true,
      message:
        'A new verification email is on its way. It can take a minute; check your spam folder too. Earlier links keep working until they expire.',
    };
  } catch (error) {
    return errorToFormState(error);
  }
}

/** Always answers the same way: whether an account exists is never revealed. */
export async function requestPasswordResetAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const email = formText(form, 'email');
  if (!email) {
    return {
      ok: false,
      message: 'Check the highlighted fields.',
      fields: { email: 'Enter the email address you sign in with.' },
    };
  }
  try {
    const client = await api();
    unwrap(await client.POST('/v1/auth/password-reset/request', { body: { email } }));
    return {
      ok: true,
      message:
        'If an account uses this address, we have sent it a link to choose a new password. The link expires in an hour and works once. Check your spam folder if it does not arrive.',
    };
  } catch (error) {
    return { ...errorToFormState(error), values: submittedValues(form) };
  }
}

/** The token comes from the URL fragment via the page; the new password is never echoed back. */
export async function completePasswordResetAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  try {
    const client = await api();
    unwrap(
      await client.POST('/v1/auth/password-reset/complete', {
        body: { token: str(form, 'token'), password: str(form, 'password') },
      }),
    );
  } catch (error) {
    return errorToFormState(error);
  }
  // Every session was revoked by the API, including any in this browser.
  await clearSession();
  return {
    ok: true,
    message:
      'Your password has been changed and you have been signed out everywhere. Sign in with your new password.',
  };
}

/** Re-authenticates with the current password; neither password is ever echoed back. */
export async function changePasswordAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const client = await api();
    const res = unwrap(
      await client.POST('/v1/auth/password/change', {
        body: {
          currentPassword: str(form, 'currentPassword'),
          newPassword: str(form, 'newPassword'),
        },
      }),
    );
    const others = res.otherSessionsSignedOut;
    return {
      ok: true,
      message:
        others > 0
          ? `Your password has been changed. You stay signed in here; ${others} other session${others === 1 ? ' was' : 's were'} signed out.`
          : 'Your password has been changed. You stay signed in here.',
    };
  } catch (error) {
    return errorToFormState(error);
  }
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Signs out one of the user's sessions; the row disappears, so the notice is page-level. */
export async function revokeSessionAction(_prev: FormState, form: FormData): Promise<FormState> {
  const sessionId = formText(form, 'sessionId');
  if (!SESSION_ID.test(sessionId))
    return { ok: false, message: 'Something went wrong. Please try again.' };
  try {
    const client = await api();
    unwrap(
      await client.POST('/v1/auth/sessions/{sessionId}/revoke', {
        params: { path: { sessionId } },
      }),
    );
  } catch (error) {
    return errorToFormState(error);
  }
  redirect('/account?notice=session_signed_out');
}

export async function revokeOtherSessionsAction(
  _prev: FormState,
  _form: FormData,
): Promise<FormState> {
  try {
    const client = await api();
    unwrap(await client.POST('/v1/auth/sessions/revoke-others'));
  } catch (error) {
    return errorToFormState(error);
  }
  redirect('/account?notice=others_signed_out');
}
