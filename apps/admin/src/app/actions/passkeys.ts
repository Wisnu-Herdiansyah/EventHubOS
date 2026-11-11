'use server';

import { revalidatePath } from 'next/cache';
import { api, unwrap } from '@/lib/api';
import { errorToFormState } from '@/lib/errors';
import { clearMfaChallenge, readMfaChallenge, writeSession } from '@/lib/session';

/**
 * Passkeys (ADR-0033). The browser does the WebAuthn ceremony; these actions carry options and
 * responses between it and the API. Nothing is stored here.
 */
export interface PasskeyActionResult {
  ok: boolean;
  message?: string;
  fields?: Record<string, string>;
  reason?: string;
  options?: Record<string, unknown>;
}

function failure(error: unknown): PasskeyActionResult {
  const s = errorToFormState(error);
  return {
    ok: false,
    message: s.message,
    ...(s.fields ? { fields: s.fields } : {}),
    ...(s.reason ? { reason: s.reason } : {}),
  };
}

const UUID = /^[0-9a-f-]{36}$/i;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
/** WebAuthn JSON from the browser, size-capped before it is forwarded. */
const credential = (v: unknown) =>
  v && typeof v === 'object' && JSON.stringify(v).length < 32_000 ? v : null;

export async function startPasskeyAction(currentPassword: string): Promise<PasskeyActionResult> {
  if (!text(currentPassword, 1024)) {
    return {
      ok: false,
      message: 'Check the highlighted fields.',
      fields: { currentPassword: 'Enter your current password.' },
    };
  }
  try {
    const client = await api();
    const r = unwrap(
      await client.POST('/v1/auth/passkeys/options', {
        body: { currentPassword: text(currentPassword, 1024) },
      }),
    );
    return { ok: true, options: r.options };
  } catch (error) {
    return failure(error);
  }
}

export async function addPasskeyAction(
  name: string,
  response: unknown,
): Promise<PasskeyActionResult> {
  const body = credential(response);
  if (!body) return { ok: false, message: 'The passkey could not be created. Try again.' };
  try {
    const client = await api();
    unwrap(
      await client.POST('/v1/auth/passkeys', {
        // The API validates the shape; the browser library produced it.
        body: { name: text(name, 60), response: body as never },
      }),
    );
  } catch (error) {
    return failure(error);
  }
  revalidatePath('/account');
  return { ok: true, message: 'Passkey added.' };
}

export async function removePasskeyAction(
  passkeyId: string,
  currentPassword: string,
): Promise<PasskeyActionResult> {
  if (!UUID.test(passkeyId))
    return { ok: false, message: 'Something went wrong. Please try again.' };
  try {
    const client = await api();
    unwrap(
      await client.POST('/v1/auth/passkeys/{passkeyId}/remove', {
        params: { path: { passkeyId } },
        body: { currentPassword: text(currentPassword, 1024) },
      }),
    );
  } catch (error) {
    return failure(error);
  }
  revalidatePath('/account');
  return { ok: true, message: 'Passkey removed.' };
}

/** Sign-in, second step: options for this sign-in's challenge (held in an HttpOnly cookie). */
export async function passkeyLoginOptionsAction(): Promise<PasskeyActionResult> {
  const challengeToken = await readMfaChallenge();
  if (!challengeToken) {
    return {
      ok: false,
      reason: 'challenge_invalid',
      message: 'This sign-in has expired. Sign in again.',
    };
  }
  try {
    const client = await api();
    const r = unwrap(
      await client.POST('/v1/auth/login/mfa/passkey-options', { body: { challengeToken } }),
    );
    return { ok: true, options: r.options };
  } catch (error) {
    return failure(error);
  }
}

export async function completePasskeyLoginAction(response: unknown): Promise<PasskeyActionResult> {
  const challengeToken = await readMfaChallenge();
  const body = credential(response);
  if (!challengeToken) {
    return {
      ok: false,
      reason: 'challenge_invalid',
      message: 'This sign-in has expired. Sign in again.',
    };
  }
  if (!body) return { ok: false, message: 'The passkey could not be used. Try again.' };
  try {
    const client = await api();
    const session = unwrap(
      await client.POST('/v1/auth/login/mfa', { body: { challengeToken, passkey: body as never } }),
    );
    await clearMfaChallenge();
    await writeSession(session.token, session.expiresAt);
    return { ok: true };
  } catch (error) {
    const r = failure(error);
    if (r.reason === 'challenge_invalid' || r.reason === 'locked') await clearMfaChallenge();
    return r;
  }
}
