import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, createDomainEvent, type Actor } from '@eventhub/kernel';
import { enqueueEvent, withTransaction, type Pool, type PoolClient } from '@eventhub/db';
import { definePublicRoute, defineRoute, type AnyRoute } from '../../http/route.ts';
import {
  hashRecoveryCode,
  isRecoveryCodeShape,
  newRecoveryCodes,
  secretBox,
  type SecretBox,
} from './mfa-crypto.ts';
import { loginPasswordSchema, type PasswordHasher } from './password.ts';
import { checkLoginPasskey, webauthnResponseSchema } from './passkey-routes.ts';
import { reauthenticate } from './reauth.ts';
import { audit, newSessionToken, type IdentitySettings } from './routes.ts';
import { base32Encode, matchTotp, newTotpSecret, otpauthUri } from './totp.ts';

/**
 * Two-step verification with an authenticator app (ADR-0022): enrolment (setup, confirm),
 * turning it off, regenerating recovery codes, and the second step of sign-in.
 */
export const MFA_CHANGED = 'identity.mfa_changed';

const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const totpCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from your app.');
const recoveryCode = z
  .string()
  .trim()
  .refine(isRecoveryCodeShape, 'Enter a recovery code like abcde-fghjk.');

/** Exactly one of a current app code or an unused recovery code. */
const secondFactor = {
  code: totpCode.optional(),
  recoveryCode: recoveryCode.optional(),
};
const oneFactor = (b: { code?: string; recoveryCode?: string }) =>
  (b.code === undefined) !== (b.recoveryCode === undefined);
const oneFactorMessage = { message: 'Provide either code or recoveryCode.' };

const statusSchema = z
  .object({
    /** False when the server has no MFA encryption key configured. */
    available: z.boolean(),
    status: z.enum(['off', 'pending', 'on']),
    enabledAt: z.iso.datetime().nullable(),
    recoveryCodesRemaining: z.number().int(),
  })
  .meta({ id: 'MfaStatus' });

const recoveryCodesSchema = z
  .object({
    /** Shown once. Each works once instead of an app code. */
    recoveryCodes: z.array(z.string()),
  })
  .meta({ id: 'MfaRecoveryCodes' });

interface StatusRow {
  out_status: 'pending' | 'active';
  out_activated_at: Date | null;
  out_codes_remaining: number;
  out_secret_sealed: Buffer;
}

function unavailable(): AppError {
  return new AppError('service_unavailable', 'Two-step verification is not available right now.', {
    details: { reason: 'mfa_unavailable' },
  });
}

function badCode(path = 'body.code'): AppError {
  return new AppError('validation_failed', 'Invalid request body.', {
    details: {
      reason: 'bad_code',
      fields: [{ path, message: 'That code is incorrect or was already used. Try the next one.' }],
    },
  });
}

export type MfaChange =
  | 'enabled'
  | 'disabled'
  | 'recovery_codes_regenerated'
  | 'recovery_code_used'
  | 'passkey_added'
  | 'passkey_removed';

export async function notify(
  client: PoolClient,
  userId: string,
  change: MfaChange,
  correlationId: string,
): Promise<void> {
  await enqueueEvent(
    client,
    createDomainEvent({
      eventType: MFA_CHANGED,
      schemaVersion: 1,
      actor: { type: 'user', id: userId },
      organizationId: null,
      aggregateType: 'user',
      aggregateId: userId,
      correlationId,
      payload: { userId, change },
    }),
  );
}

const hashes = (codes: string[]) => codes.map(hashRecoveryCode);

export function mfaRoutes(
  pool: Pool,
  hasher: PasswordHasher,
  settings: IdentitySettings,
): AnyRoute[] {
  const box: SecretBox | null = settings.mfaEncryptionKey
    ? secretBox(settings.mfaEncryptionKey)
    : null;
  const status = async (userId: string) =>
    (await pool.query<StatusRow>('SELECT * FROM eventhub.auth_mfa_status($1)', [userId])).rows[0];

  /** The verified TOTP step for a user's sealed secret, or null. */
  const verifyCode = (sealed: Buffer, userId: string, code: string): number | null => {
    if (!box) throw unavailable();
    return matchTotp(box.open(sealed, userId), code, Date.now());
  };

  return [
    defineRoute({
      method: 'GET',
      path: '/v1/auth/mfa',
      operationId: 'getMfaStatus',
      summary: 'Whether two-step verification is on for the signed-in user.',
      tags: ['identity'],
      requires: 'authenticated',
      idempotent: false,
      schemas: { response: { status: 200, schema: statusSchema } },
      async handler({ principal }) {
        const row = await status(principal.userId);
        return {
          status: 200,
          body: {
            available: box !== null,
            status: !row ? 'off' : row.out_status === 'active' ? 'on' : 'pending',
            enabledAt: row?.out_activated_at?.toISOString() ?? null,
            recoveryCodesRemaining: row?.out_status === 'active' ? row.out_codes_remaining : 0,
          },
        };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/auth/mfa/setup',
      operationId: 'startMfaSetup',
      summary:
        'Start turning on two-step verification (re-enter your password). Returns the secret for your authenticator app; confirm with a code to finish.',
      tags: ['identity'],
      requires: 'authenticated',
      idempotent: false,
      idempotencyExempt:
        'Re-authenticates with the password; a repeat replaces the pending secret, which is never stored in the clear.',
      rateLimit: AUTH_RATE_LIMIT,
      schemas: {
        body: z
          .object({ currentPassword: loginPasswordSchema })
          .strict()
          .meta({ id: 'StartMfaSetupRequest' }),
        response: {
          status: 200,
          schema: z
            .object({
              /** Base32, for typing into an app by hand. */
              secret: z.string(),
              /** otpauth:// URI, usually shown as a QR code. */
              otpauthUri: z.string(),
            })
            .meta({ id: 'MfaSetup' }),
        },
      },
      async handler({ principal, body, correlationId }) {
        if (!box) throw unavailable();
        const credential = await reauthenticate(pool, hasher, settings, {
          userId: principal.userId,
          password: body.currentPassword,
          correlationId,
          failureAction: 'identity.mfa_setup_failed',
          field: 'body.currentPassword',
        });
        const secret = newTotpSecret();
        const started = await withTransaction(
          pool,
          { userId: principal.userId },
          async (client) => {
            const r = await client.query<{ auth_mfa_begin_enrolment: boolean }>(
              'SELECT eventhub.auth_mfa_begin_enrolment($1, $2)',
              [principal.userId, box.seal(secret, principal.userId)],
            );
            if (!r.rows[0]!.auth_mfa_begin_enrolment) return false;
            await audit(
              client,
              'identity.mfa_setup_started',
              { type: 'user', id: principal.userId },
              principal.userId,
              correlationId,
            );
            return true;
          },
        );
        if (!started) {
          throw new AppError('conflict', 'Two-step verification is already on.', {
            details: { reason: 'mfa_already_enabled' },
          });
        }
        return {
          status: 200,
          body: {
            secret: base32Encode(secret).replace(/(.{4})(?!$)/g, '$1 '),
            otpauthUri: otpauthUri(secret, credential.email),
          },
        };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/auth/mfa/confirm',
      operationId: 'confirmMfaSetup',
      summary:
        'Finish turning on two-step verification with a code from your app. Returns recovery codes (shown once) and signs out other sessions.',
      tags: ['identity'],
      requires: 'authenticated',
      idempotent: false,
      idempotencyExempt:
        'Needs a fresh app code; a repeat finds nothing pending and changes nothing.',
      rateLimit: AUTH_RATE_LIMIT,
      schemas: {
        body: z.object({ code: totpCode }).strict().meta({ id: 'ConfirmMfaSetupRequest' }),
        response: { status: 200, schema: recoveryCodesSchema },
      },
      async handler({ principal, body, correlationId }) {
        const row = await status(principal.userId);
        if (!row || row.out_status !== 'pending') {
          throw new AppError('conflict', 'Start the setup again.', {
            details: { reason: row ? 'mfa_already_enabled' : 'mfa_setup_not_started' },
          });
        }
        const step = verifyCode(row.out_secret_sealed, principal.userId, body.code);
        if (step === null) throw badCode();
        const codes = newRecoveryCodes();
        const revoked = await withTransaction(
          pool,
          { userId: principal.userId },
          async (client) => {
            const r = await client.query<{ out_other_sessions_revoked: number }>(
              'SELECT out_other_sessions_revoked FROM eventhub.auth_mfa_activate($1, $2, $3, $4)',
              [principal.userId, step, hashes(codes), principal.sessionId],
            );
            const activated = r.rows[0];
            if (!activated) return null;
            await audit(
              client,
              'identity.mfa_enabled',
              { type: 'user', id: principal.userId },
              principal.userId,
              correlationId,
              { otherSessionsRevoked: activated.out_other_sessions_revoked },
            );
            await notify(client, principal.userId, 'enabled', correlationId);
            return activated.out_other_sessions_revoked;
          },
        );
        if (revoked === null) throw badCode();
        return { status: 200, body: { recoveryCodes: codes } };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/auth/mfa/disable',
      operationId: 'disableMfa',
      summary:
        'Turn off two-step verification. Needs your password and a current app code or a recovery code.',
      tags: ['identity'],
      requires: 'authenticated',
      idempotent: false,
      idempotencyExempt: 'Re-authenticates; a repeat finds MFA already off and changes nothing.',
      rateLimit: AUTH_RATE_LIMIT,
      schemas: {
        body: z
          .object({ currentPassword: loginPasswordSchema, ...secondFactor })
          .strict()
          .refine(oneFactor, oneFactorMessage)
          .meta({ id: 'DisableMfaRequest' }),
        response: {
          status: 200,
          schema: z.object({ status: z.literal('mfa_disabled') }).meta({ id: 'MfaDisabled' }),
        },
      },
      async handler({ principal, body, correlationId }) {
        await reauthenticate(pool, hasher, settings, {
          userId: principal.userId,
          password: body.currentPassword,
          correlationId,
          failureAction: 'identity.mfa_disable_failed',
          field: 'body.currentPassword',
        });
        const row = await status(principal.userId);
        if (!row || row.out_status !== 'active') {
          throw new AppError('conflict', 'Two-step verification is not on.', {
            details: { reason: 'mfa_not_enabled' },
          });
        }
        const actor: Actor = { type: 'user', id: principal.userId };
        const step =
          body.code !== undefined
            ? verifyCode(row.out_secret_sealed, principal.userId, body.code)
            : null;
        const outcome = await withTransaction(
          pool,
          { userId: principal.userId },
          async (client) => {
            const ok =
              body.code !== undefined
                ? step !== null &&
                  (
                    await client.query<{ auth_mfa_use_step: boolean }>(
                      'SELECT eventhub.auth_mfa_use_step($1, $2)',
                      [principal.userId, step],
                    )
                  ).rows[0]!.auth_mfa_use_step
                : (
                    await client.query<{ auth_mfa_use_recovery_code: boolean }>(
                      'SELECT eventhub.auth_mfa_use_recovery_code($1, $2)',
                      [principal.userId, hashRecoveryCode(body.recoveryCode!)],
                    )
                  ).rows[0]!.auth_mfa_use_recovery_code;
            if (!ok) {
              // A stolen session plus password must not get unlimited guesses at the second factor.
              await client.query('SELECT eventhub.auth_record_login_failure($1, $2, $3)', [
                principal.userId,
                settings.loginMaxFailures,
                settings.loginLockSeconds,
              ]);
              await audit(
                client,
                'identity.mfa_disable_failed',
                actor,
                principal.userId,
                correlationId,
                {
                  reason: 'bad_code',
                },
              );
              return false;
            }
            await client.query('SELECT eventhub.auth_mfa_disable($1)', [principal.userId]);
            // Passkeys are a way to give the second step (ADR-0033); without it they go too.
            const passkeys = await client.query<{ auth_passkey_remove_all: number }>(
              'SELECT eventhub.auth_passkey_remove_all($1)',
              [principal.userId],
            );
            await audit(client, 'identity.mfa_disabled', actor, principal.userId, correlationId, {
              method: body.code !== undefined ? 'totp' : 'recovery_code',
              passkeysRemoved: passkeys.rows[0]!.auth_passkey_remove_all,
            });
            await notify(client, principal.userId, 'disabled', correlationId);
            return true;
          },
        );
        if (!outcome) throw badCode(body.code !== undefined ? 'body.code' : 'body.recoveryCode');
        return { status: 200, body: { status: 'mfa_disabled' } };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/auth/mfa/recovery-codes',
      operationId: 'regenerateMfaRecoveryCodes',
      summary:
        'Replace your recovery codes (re-enter your password). The old ones stop working; the new ones are shown once.',
      tags: ['identity'],
      requires: 'authenticated',
      idempotent: false,
      idempotencyExempt:
        'Each call deliberately issues a new set; storing them for replay would persist secrets.',
      rateLimit: AUTH_RATE_LIMIT,
      schemas: {
        body: z
          .object({ currentPassword: loginPasswordSchema })
          .strict()
          .meta({ id: 'RegenerateRecoveryCodesRequest' }),
        response: { status: 200, schema: recoveryCodesSchema },
      },
      async handler({ principal, body, correlationId }) {
        await reauthenticate(pool, hasher, settings, {
          userId: principal.userId,
          password: body.currentPassword,
          correlationId,
          failureAction: 'identity.mfa_recovery_codes_failed',
          field: 'body.currentPassword',
        });
        const codes = newRecoveryCodes();
        const replaced = await withTransaction(
          pool,
          { userId: principal.userId },
          async (client) => {
            const r = await client.query<{ auth_mfa_replace_recovery_codes: boolean }>(
              'SELECT eventhub.auth_mfa_replace_recovery_codes($1, $2)',
              [principal.userId, hashes(codes)],
            );
            if (!r.rows[0]!.auth_mfa_replace_recovery_codes) return false;
            await audit(
              client,
              'identity.mfa_recovery_codes_regenerated',
              { type: 'user', id: principal.userId },
              principal.userId,
              correlationId,
            );
            await notify(client, principal.userId, 'recovery_codes_regenerated', correlationId);
            return true;
          },
        );
        if (!replaced) {
          throw new AppError('conflict', 'Two-step verification is not on.', {
            details: { reason: 'mfa_not_enabled' },
          });
        }
        return { status: 200, body: { recoveryCodes: codes } };
      },
    }),

    definePublicRoute({
      method: 'POST',
      path: '/v1/auth/login/mfa',
      operationId: 'completeMfaLogin',
      summary:
        'Second step of sign-in: the challenge from POST /v1/auth/login plus an app code, a recovery code or a passkey. Failures count toward the account lockout.',
      tags: ['identity'],
      idempotent: false,
      idempotencyExempt: 'The challenge is single-use; a repeat is refused.',
      rateLimit: AUTH_RATE_LIMIT,
      schemas: {
        body: z
          .object({
            challengeToken: z.string().regex(TOKEN_RE, 'Malformed challenge.'),
            ...secondFactor,
            /** A passkey assertion (ADR-0033), after POST /v1/auth/login/mfa/passkey-options. */
            passkey: webauthnResponseSchema.optional(),
          })
          .strict()
          .refine(
            (b) => [b.code, b.recoveryCode, b.passkey].filter((f) => f !== undefined).length === 1,
            { message: 'Provide one of code, recoveryCode or passkey.' },
          )
          .meta({ id: 'CompleteMfaLoginRequest' }),
        response: {
          status: 200,
          schema: z
            .object({
              token: z.string(),
              tokenType: z.literal('Bearer'),
              expiresAt: z.iso.datetime(),
              emailVerified: z.boolean(),
            })
            .meta({ id: 'MfaSession' }),
        },
      },
      async handler({ body, correlationId }) {
        const challengeHash = createHash('sha256').update(body.challengeToken).digest();
        const { rows } = await pool.query<{
          out_challenge_id: string;
          out_user_id: string;
          out_secret_sealed: Buffer;
          out_locked: boolean;
          out_email_verified: boolean;
          out_user_agent: string | null;
          out_pending_password_hash: string | null;
        }>('SELECT * FROM eventhub.auth_mfa_challenge_lookup($1)', [challengeHash]);
        const ch = rows[0];
        if (!ch) {
          throw new AppError('invalid_credentials', 'This sign-in has expired. Sign in again.', {
            details: { reason: 'challenge_invalid' },
          });
        }
        const userId = ch.out_user_id;
        const actor: Actor = { type: 'user', id: userId };
        const method =
          body.code !== undefined
            ? 'totp'
            : body.passkey !== undefined
              ? 'passkey'
              : 'recovery_code';
        const step =
          body.code !== undefined && !ch.out_locked
            ? verifyCode(ch.out_secret_sealed, userId, body.code)
            : null;
        const passkey =
          body.passkey !== undefined && !ch.out_locked
            ? await checkLoginPasskey(pool, settings.passkeys, {
                userId,
                mfaChallengeId: ch.out_challenge_id,
                response: body.passkey,
              })
            : null;

        const outcome = await withTransaction(pool, {}, async (client) => {
          let ok = false;
          if (!ch.out_locked && body.passkey !== undefined) {
            // The counter must move forward, or the authenticator may have been cloned.
            ok =
              passkey !== null &&
              (
                await client.query<{ auth_passkey_use: boolean }>(
                  'SELECT eventhub.auth_passkey_use($1, $2, $3)',
                  [userId, passkey.credentialId, passkey.newCounter],
                )
              ).rows[0]!.auth_passkey_use;
          } else if (!ch.out_locked) {
            ok =
              body.code !== undefined
                ? step !== null &&
                  (
                    await client.query<{ auth_mfa_use_step: boolean }>(
                      'SELECT eventhub.auth_mfa_use_step($1, $2)',
                      [userId, step],
                    )
                  ).rows[0]!.auth_mfa_use_step
                : (
                    await client.query<{ auth_mfa_use_recovery_code: boolean }>(
                      'SELECT eventhub.auth_mfa_use_recovery_code($1, $2)',
                      [userId, hashRecoveryCode(body.recoveryCode!)],
                    )
                  ).rows[0]!.auth_mfa_use_recovery_code;
          }
          if (ok) {
            const consumed = await client.query<{ auth_mfa_challenge_consume: boolean }>(
              'SELECT eventhub.auth_mfa_challenge_consume($1)',
              [ch.out_challenge_id],
            );
            ok = consumed.rows[0]!.auth_mfa_challenge_consume;
          }
          if (!ok) {
            await client.query('SELECT eventhub.auth_mfa_challenge_failed($1)', [
              ch.out_challenge_id,
            ]);
            let locked = ch.out_locked;
            if (!locked) {
              const r = await client.query<{ auth_record_login_failure: boolean }>(
                'SELECT eventhub.auth_record_login_failure($1, $2, $3)',
                [userId, settings.loginMaxFailures, settings.loginLockSeconds],
              );
              locked = r.rows[0]!.auth_record_login_failure;
            }
            await audit(client, 'identity.mfa_failed', actor, userId, correlationId, {
              method,
              locked,
            });
            return { ok: false as const, locked };
          }
          const session = newSessionToken();
          const s = await client.query<{ out_session_id: string; out_expires_at: Date }>(
            'SELECT out_session_id, out_expires_at FROM eventhub.auth_complete_login($1, $2, $3, $4, $5)',
            [
              userId,
              session.hash,
              settings.sessionTtlSeconds,
              ch.out_pending_password_hash,
              ch.out_user_agent,
            ],
          );
          await audit(client, 'identity.logged_in', actor, userId, correlationId, {
            sessionId: s.rows[0]!.out_session_id,
            mfa: method,
          });
          if (method === 'recovery_code') {
            await notify(client, userId, 'recovery_code_used', correlationId);
          }
          return {
            ok: true as const,
            body: {
              token: session.token,
              tokenType: 'Bearer' as const,
              expiresAt: s.rows[0]!.out_expires_at.toISOString(),
              emailVerified: ch.out_email_verified,
            },
          };
        });
        if (!outcome.ok) {
          throw new AppError(
            'invalid_credentials',
            outcome.locked
              ? 'Too many incorrect attempts. Try again later.'
              : method === 'passkey'
                ? 'That passkey could not be verified. Try again, or use your app code.'
                : 'That code is incorrect or was already used.',
            { details: { reason: outcome.locked ? 'locked' : 'bad_code' } },
          );
        }
        return { status: 200, body: outcome.body };
      },
    }),
  ];
}
