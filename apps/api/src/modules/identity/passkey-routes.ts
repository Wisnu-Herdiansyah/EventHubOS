import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, type Actor } from '@eventhub/kernel';
import { withTransaction, type Pool } from '@eventhub/db';
import { definePublicRoute, defineRoute, type AnyRoute } from '../../http/route.ts';
import { uuid } from '../../http/schemas.ts';
import { notify } from './mfa-routes.ts';
import { credentialIdOf, type PasskeyRelyingParty, type StoredPasskey } from './passkeys.ts';
import { loginPasswordSchema, type PasswordHasher } from './password.ts';
import { reauthenticate } from './reauth.ts';
import { audit, type IdentitySettings } from './routes.ts';

/**
 * Passkeys as a second step of sign-in (ADR-0033): add one once two-step verification is on,
 * list and remove them, and get the options for using one at sign-in. Using one completes
 * POST /v1/auth/login/mfa like an app code does.
 */
const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CHALLENGE_TTL_SECONDS = 300;

/** A WebAuthn JSON credential as browsers produce it; the adapter checks the contents. */
export const webauthnResponseSchema = z
  .looseObject({
    id: z.string().regex(/^[A-Za-z0-9_-]{16,1400}$/),
    rawId: z.string().regex(/^[A-Za-z0-9_-]{16,1400}$/),
    type: z.literal('public-key'),
    response: z.record(z.string(), z.unknown()),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: 'WebAuthnCredential' });

const passkeySchema = z
  .object({
    id: uuid,
    name: z.string(),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Passkey' });

interface PasskeyRow {
  out_id: string;
  out_credential_id: Buffer;
  out_public_key: Buffer;
  out_counter: string;
  out_transports: string[];
  out_name: string;
  out_created_at: Date;
  out_last_used_at: Date | null;
}

export const toStored = (r: PasskeyRow): StoredPasskey => ({
  credentialId: r.out_credential_id.toString('base64url'),
  publicKey: new Uint8Array(r.out_public_key),
  counter: Number(r.out_counter),
  transports: r.out_transports,
});

export async function listPasskeys(pool: Pool, userId: string): Promise<PasskeyRow[]> {
  return (await pool.query<PasskeyRow>('SELECT * FROM eventhub.auth_passkey_list($1)', [userId]))
    .rows;
}

function unavailable(): AppError {
  return new AppError('service_unavailable', 'Passkeys are not available right now.', {
    details: { reason: 'passkeys_unavailable' },
  });
}

/**
 * The sign-in half (ADR-0033): checks a passkey assertion against the challenge issued for this
 * sign-in. The challenge is taken (spent) whatever the outcome. Returns the credential to record
 * use of and its new counter, or null.
 */
export async function checkLoginPasskey(
  pool: Pool,
  rp: PasskeyRelyingParty | null | undefined,
  input: { userId: string; mfaChallengeId: string; response: unknown },
): Promise<{ credentialId: Buffer; newCounter: number } | null> {
  if (!rp) return null;
  const taken = await pool.query<{ auth_webauthn_challenge_take: string | null }>(
    'SELECT eventhub.auth_webauthn_challenge_take($1, $2, $3)',
    [input.userId, 'login', input.mfaChallengeId],
  );
  const expected = taken.rows[0]?.auth_webauthn_challenge_take;
  const id = credentialIdOf(input.response);
  if (!expected || !id) return null;
  const row = (await listPasskeys(pool, input.userId)).find(
    (p) => p.out_credential_id.toString('base64url') === id,
  );
  if (!row) return null;
  const verified = await rp.verifyAuthentication({
    response: input.response,
    expectedChallenge: expected,
    credential: toStored(row),
  });
  return verified ? { credentialId: row.out_credential_id, newCounter: verified.newCounter } : null;
}

export function passkeyRoutes(
  pool: Pool,
  hasher: PasswordHasher,
  settings: IdentitySettings,
): AnyRoute[] {
  const rp = settings.passkeys ?? null;
  const mfaOn = async (userId: string) =>
    (
      await pool.query<{ auth_mfa_required: boolean }>('SELECT eventhub.auth_mfa_required($1)', [
        userId,
      ])
    ).rows[0]!.auth_mfa_required;

  return [
    defineRoute({
      method: 'GET',
      path: '/v1/auth/passkeys',
      operationId: 'listPasskeys',
      summary: 'Your passkeys, used as the second step of sign-in.',
      tags: ['identity'],
      requires: 'authenticated',
      idempotent: false,
      schemas: {
        response: {
          status: 200,
          schema: z
            .object({ available: z.boolean(), passkeys: z.array(passkeySchema) })
            .meta({ id: 'PasskeyList' }),
        },
      },
      async handler({ principal }) {
        const rows = await listPasskeys(pool, principal.userId);
        return {
          status: 200,
          body: {
            available: rp !== null,
            passkeys: rows.map((r) => ({
              id: r.out_id,
              name: r.out_name,
              createdAt: r.out_created_at.toISOString(),
              lastUsedAt: r.out_last_used_at?.toISOString() ?? null,
            })),
          },
        };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/auth/passkeys/options',
      operationId: 'startPasskeyRegistration',
      summary:
        'Start adding a passkey (re-enter your password). Needs two-step verification on. Returns options for navigator.credentials.create().',
      tags: ['identity'],
      requires: 'authenticated',
      idempotent: false,
      idempotencyExempt:
        'Re-authenticates; each call issues a fresh single-use challenge and replaces the last.',
      rateLimit: AUTH_RATE_LIMIT,
      schemas: {
        body: z
          .object({ currentPassword: loginPasswordSchema })
          .strict()
          .meta({ id: 'StartPasskeyRequest' }),
        response: {
          status: 200,
          schema: z
            .object({ options: z.record(z.string(), z.unknown()) })
            .meta({ id: 'PasskeyCreationOptions' }),
        },
      },
      async handler({ principal, body, correlationId }) {
        if (!rp) throw unavailable();
        const credential = await reauthenticate(pool, hasher, settings, {
          userId: principal.userId,
          password: body.currentPassword,
          correlationId,
          failureAction: 'identity.passkey_setup_failed',
          field: 'body.currentPassword',
        });
        if (!(await mfaOn(principal.userId))) {
          throw new AppError(
            'conflict',
            'Turn on two-step verification with an authenticator app first.',
            { details: { reason: 'mfa_not_enabled' } },
          );
        }
        const existing = (await listPasskeys(pool, principal.userId)).map(toStored);
        const { options, challenge } = await rp.registrationOptions({
          userId: principal.userId,
          userName: credential.email,
          exclude: existing,
        });
        await pool.query('SELECT eventhub.auth_webauthn_challenge_issue($1, $2, NULL, $3, $4)', [
          principal.userId,
          'register',
          challenge,
          CHALLENGE_TTL_SECONDS,
        ]);
        return { status: 200, body: { options } };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/auth/passkeys',
      operationId: 'addPasskey',
      summary:
        'Finish adding a passkey with the browser’s response. You are emailed about it, like other two-step changes.',
      tags: ['identity'],
      requires: 'authenticated',
      idempotent: false,
      idempotencyExempt:
        'The registration challenge is single-use; a repeat finds no challenge and adds nothing.',
      rateLimit: AUTH_RATE_LIMIT,
      schemas: {
        body: z
          .object({
            name: z
              .string()
              .trim()
              .min(1, 'Give the passkey a name, like “Work laptop”.')
              .max(60)
              // eslint-disable-next-line no-control-regex
              .regex(/^[^\u0000-\u001f\u007f]*$/, 'Use plain text.'),
            response: webauthnResponseSchema,
          })
          .strict()
          .meta({ id: 'AddPasskeyRequest' }),
        response: { status: 201, schema: passkeySchema },
      },
      async handler({ principal, body, correlationId }) {
        if (!rp) throw unavailable();
        const taken = await pool.query<{ auth_webauthn_challenge_take: string | null }>(
          'SELECT eventhub.auth_webauthn_challenge_take($1, $2, NULL)',
          [principal.userId, 'register'],
        );
        const expected = taken.rows[0]?.auth_webauthn_challenge_take;
        const created = expected
          ? await rp.verifyRegistration({ response: body.response, expectedChallenge: expected })
          : null;
        if (!created) {
          throw new AppError('validation_failed', 'This passkey could not be added. Try again.', {
            details: { reason: expected ? 'passkey_invalid' : 'passkey_setup_not_started' },
          });
        }
        const actor: Actor = { type: 'user', id: principal.userId };
        const added = await withTransaction(pool, { userId: principal.userId }, async (client) => {
          const r = await client.query<{ auth_passkey_add: string | null }>(
            'SELECT eventhub.auth_passkey_add($1, $2, $3, $4, $5, $6)',
            [
              principal.userId,
              Buffer.from(created.credentialId, 'base64url'),
              Buffer.from(created.publicKey),
              created.counter,
              created.transports,
              body.name,
            ],
          );
          const id = r.rows[0]!.auth_passkey_add;
          if (!id) return null;
          await audit(client, 'identity.passkey_added', actor, principal.userId, correlationId, {
            passkeyId: id,
          });
          await notify(client, principal.userId, 'passkey_added', correlationId);
          return id;
        });
        if (!added) {
          throw new AppError(
            'conflict',
            'This passkey could not be added. Two-step verification must be on, a passkey can be added once, and an account holds at most 10.',
            { details: { reason: 'passkey_not_added' } },
          );
        }
        const row = (await listPasskeys(pool, principal.userId)).find((p) => p.out_id === added)!;
        return {
          status: 201,
          body: {
            id: row.out_id,
            name: row.out_name,
            createdAt: row.out_created_at.toISOString(),
            lastUsedAt: null,
          },
        };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/auth/passkeys/:passkeyId/remove',
      operationId: 'removePasskey',
      summary: 'Remove one of your passkeys (re-enter your password).',
      tags: ['identity'],
      requires: 'authenticated',
      idempotent: false,
      idempotencyExempt: 'Re-authenticates; a repeat finds the passkey gone and changes nothing.',
      rateLimit: AUTH_RATE_LIMIT,
      schemas: {
        params: z.object({ passkeyId: uuid }).strict(),
        body: z
          .object({ currentPassword: loginPasswordSchema })
          .strict()
          .meta({ id: 'RemovePasskeyRequest' }),
        response: { status: 204 },
      },
      async handler({ principal, params, body, correlationId }) {
        await reauthenticate(pool, hasher, settings, {
          userId: principal.userId,
          password: body.currentPassword,
          correlationId,
          failureAction: 'identity.passkey_remove_failed',
          field: 'body.currentPassword',
        });
        const removed = await withTransaction(
          pool,
          { userId: principal.userId },
          async (client) => {
            const r = await client.query<{ auth_passkey_remove: string | null }>(
              'SELECT eventhub.auth_passkey_remove($1, $2)',
              [principal.userId, params.passkeyId],
            );
            if (!r.rows[0]!.auth_passkey_remove) return false;
            await audit(
              client,
              'identity.passkey_removed',
              { type: 'user', id: principal.userId },
              principal.userId,
              correlationId,
              { passkeyId: params.passkeyId },
            );
            await notify(client, principal.userId, 'passkey_removed', correlationId);
            return true;
          },
        );
        if (!removed) {
          throw new AppError('not_found', 'Passkey not found.', {
            details: { reason: 'passkey_not_found' },
          });
        }
        return { status: 204, body: null };
      },
    }),

    definePublicRoute({
      method: 'POST',
      path: '/v1/auth/login/mfa/passkey-options',
      operationId: 'startPasskeyLogin',
      summary:
        'Second step of sign-in with a passkey: options for navigator.credentials.get(), for the challenge from POST /v1/auth/login. Then send the browser’s response to POST /v1/auth/login/mfa.',
      tags: ['identity'],
      idempotent: false,
      idempotencyExempt:
        'Issues a fresh single-use WebAuthn challenge for this sign-in; the last one is replaced.',
      rateLimit: AUTH_RATE_LIMIT,
      schemas: {
        body: z
          .object({ challengeToken: z.string().regex(TOKEN_RE, 'Malformed challenge.') })
          .strict()
          .meta({ id: 'StartPasskeyLoginRequest' }),
        response: {
          status: 200,
          schema: z
            .object({ options: z.record(z.string(), z.unknown()) })
            .meta({ id: 'PasskeyRequestOptions' }),
        },
      },
      async handler({ body }) {
        if (!rp) throw unavailable();
        const challengeHash = createHash('sha256').update(body.challengeToken).digest();
        const { rows } = await pool.query<{ out_challenge_id: string; out_user_id: string }>(
          'SELECT out_challenge_id, out_user_id FROM eventhub.auth_mfa_challenge_lookup($1)',
          [challengeHash],
        );
        const ch = rows[0];
        if (!ch) {
          throw new AppError('invalid_credentials', 'This sign-in has expired. Sign in again.', {
            details: { reason: 'challenge_invalid' },
          });
        }
        const passkeys = (await listPasskeys(pool, ch.out_user_id)).map(toStored);
        if (passkeys.length === 0) {
          throw new AppError('conflict', 'This account has no passkeys. Use your app code.', {
            details: { reason: 'no_passkeys' },
          });
        }
        const { options, challenge } = await rp.authenticationOptions({ allow: passkeys });
        await pool.query('SELECT eventhub.auth_webauthn_challenge_issue($1, $2, $3, $4, $5)', [
          ch.out_user_id,
          'login',
          ch.out_challenge_id,
          challenge,
          CHALLENGE_TTL_SECONDS,
        ]);
        return { status: 200, body: { options } };
      },
    }),
  ];
}
