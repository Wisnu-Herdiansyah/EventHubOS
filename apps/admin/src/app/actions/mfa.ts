'use server';

import { revalidatePath } from 'next/cache';
import QRCode from 'qrcode';
import { api, unwrap } from '@/lib/api';
import { errorToFormState } from '@/lib/errors';

/**
 * Two-step verification on the Account page (ADR-0022). Results go straight to the client
 * component; secrets and recovery codes are returned once and never stored by this app.
 */
export interface MfaActionResult {
  ok: boolean;
  message?: string;
  fields?: Record<string, string>;
  reference?: string;
  /** Setup: the secret for typing in, and a QR code (SVG data URI) of the otpauth URI. */
  secret?: string;
  qr?: string;
  recoveryCodes?: string[];
}

function failure(error: unknown): MfaActionResult {
  const s = errorToFormState(error);
  return {
    ok: false,
    message: s.message,
    ...(s.fields ? { fields: s.fields } : {}),
    ...(s.reference ? { reference: s.reference } : {}),
  };
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

export async function startMfaSetupAction(currentPassword: string): Promise<MfaActionResult> {
  try {
    const client = await api();
    const setup = unwrap(
      await client.POST('/v1/auth/mfa/setup', {
        body: { currentPassword: clean(currentPassword, 1024) },
      }),
    );
    const svg = await QRCode.toString(setup.otpauthUri, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
    });
    return {
      ok: true,
      secret: setup.secret,
      qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    };
  } catch (error) {
    return failure(error);
  }
}

export async function confirmMfaAction(code: string): Promise<MfaActionResult> {
  try {
    const client = await api();
    const res = unwrap(
      await client.POST('/v1/auth/mfa/confirm', {
        body: { code: clean(code, 12).replace(/\s/g, '') },
      }),
    );
    // No revalidation here: the page refreshes once the codes are saved, so they stay on screen.
    return { ok: true, recoveryCodes: res.recoveryCodes };
  } catch (error) {
    return failure(error);
  }
}

export async function regenerateRecoveryCodesAction(
  currentPassword: string,
): Promise<MfaActionResult> {
  try {
    const client = await api();
    const res = unwrap(
      await client.POST('/v1/auth/mfa/recovery-codes', {
        body: { currentPassword: clean(currentPassword, 1024) },
      }),
    );
    return { ok: true, recoveryCodes: res.recoveryCodes };
  } catch (error) {
    return failure(error);
  }
}

export async function disableMfaAction(
  currentPassword: string,
  factor: { code?: string; recoveryCode?: string },
): Promise<MfaActionResult> {
  try {
    const client = await api();
    const code = clean(factor.code, 12).replace(/\s/g, '');
    const recoveryCode = clean(factor.recoveryCode, 24).trim();
    unwrap(
      await client.POST('/v1/auth/mfa/disable', {
        body: {
          currentPassword: clean(currentPassword, 1024),
          ...(recoveryCode ? { recoveryCode } : { code }),
        },
      }),
    );
    revalidatePath('/account');
    return { ok: true, message: 'Two-step verification is off.' };
  } catch (error) {
    return failure(error);
  }
}
