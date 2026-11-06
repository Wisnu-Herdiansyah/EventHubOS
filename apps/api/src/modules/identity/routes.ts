import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError, createDomainEvent, type Actor } from '@eventhub/kernel';
import {
  enqueueEvent,
  withTransaction,
  writeAudit,
  type Pool,
  type PoolClient,
} from '@eventhub/db';
import { runIdempotentCommand } from '../../http/idempotent-command.ts';
import { definePublicRoute, defineRoute, type AnyRoute } from '../../http/route.ts';
import { uuid } from '../../http/schemas.ts';
import {
  emailSchema,
  loginPasswordSchema,
  passwordSchema,
  type PasswordHasher,
} from './password.ts';

export interface IdentitySettings {
  sessionTtlSeconds: number;
  loginMaxFailures: number;
  loginLockSeconds: number;
}

export const EMAIL_VERIFICATION_REQUESTED = 'identity.email_verification_requested';

const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };
const VERIFY_RATE_LIMIT = { max: 20, timeWindow: '1 minute' };
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

const signupBody = z
  .object({ email: emailSchema, password: passwordSchema })
  .strict()
  .superRefine((b, ctx) => {
    if (b.password.toLowerCase() === b.email) {
      ctx.addIssue({
        code: 'custom',
        path: ['password'],
        message: 'Password must not be your email address.',
      });
    }
  })
  .meta({ id: 'SignUpRequest' });

const loginBody = z
  .object({ email: emailSchema, password: loginPasswordSchema })
  .strict()
  .meta({ id: 'LoginRequest' });

const verifyBody = z
  .object({ token: z.string().regex(TOKEN_RE, 'Malformed token.') })
  .strict()
  .meta({ id: 'VerifyEmailRequest' });

const acceptedSchema = z
  .object({ status: z.literal('accepted'), message: z.string() })
  .meta({ id: 'Accepted' });

const sessionSchema = z
  .object({
    token: z.string(),
    tokenType: z.literal('Bearer'),
    expiresAt: z.iso.datetime(),
    emailVerified: z.boolean(),
  })
  .meta({ id: 'Session' });

const meSchema = z
  .object({ userId: uuid, email: z.string(), emailVerified: z.boolean() })
  .meta({ id: 'CurrentUser' });

function newSessionToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token).digest() };
}

async function audit(
  client: PoolClient,
  action: string,
  actor: Actor,
  targetId: string | null,
  correlationId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await writeAudit(client, {
    organizationId: null,
    actor,
    action,
    targetType: 'user',
    targetId,
    correlationId,
    metadata,
  });
}

async function requestVerificationEmail(
  client: PoolClient,
  userId: string,
  credentialVersion: number | null,
  correlationId: string,
): Promise<void> {
  // Only identifiers travel through the outbox: the worker mints the single-use token at send
  // time, so raw tokens never touch the database, the outbox, or logs.
  await enqueueEvent(
    client,
    createDomainEvent({
      eventType: EMAIL_VERIFICATION_REQUESTED,
      schemaVersion: 1,
      actor: { type: 'user', id: userId },
      organizationId: null,
      aggregateType: 'user',
      aggregateId: userId,
      correlationId,
      payload: { userId, credentialVersion },
    }),
  );
}

const ACCEPTED_BODY = {
  status: 'accepted' as const,
  message: 'If this address can be registered, a verification email is on its way.',
};

export function identityRoutes(
  pool: Pool,
  hasher: PasswordHasher,
  settings: IdentitySettings,
): AnyRoute[] {
  // Verifying against a real hash when the account is unknown keeps response timing uniform.
  const dummyHash = hasher.hash(randomBytes(24).toString('base64url'));

  return [
    definePublicRoute({
      method: 'POST',
      path: '/v1/auth/signup',
      operationId: 'signUp',
      summary:
        'Register with email and password. Always answers 202 to prevent account enumeration.',
      tags: ['identity'],
      idempotent: false,
      idempotencyExempt:
        'Keyed by email: repeating it cannot create a second account; it only replaces an unverified password and re-sends verification.',
      rateLimit: AUTH_RATE_LIMIT,
      schemas: { body: signupBody, response: { status: 202, schema: acceptedSchema } },
      async handler({ body, correlationId }) {
        // Hash before any lookup so every outcome costs the same.
        const passwordHash = await hasher.hash(body.password);
        await withTransaction(pool, {}, async (client) => {
          const { rows } = await client.query<{
            out_user_id: string;
            out_outcome: 'created' | 'replaced_unverified' | 'exists_verified';
            out_credential_version: number | null;
          }>(
            'SELECT out_user_id, out_outcome, out_credential_version FROM eventhub.auth_register($1, $2)',
            [body.email, passwordHash],
          );
          const r = rows[0]!;
          const actor: Actor = { type: 'user', id: r.out_user_id };
          if (r.out_outcome === 'exists_verified') {
            // TODO(D4): notify the owner that someone tried to register their address.
            await audit(
              client,
              'identity.signup_existing_verified',
              actor,
              r.out_user_id,
              correlationId,
            );
            return;
          }
          await audit(
            client,
            r.out_outcome === 'created'
              ? 'identity.signed_up'
              : 'identity.signup_replaced_unverified',
            actor,
            r.out_user_id,
            correlationId,
          );
          await requestVerificationEmail(
            client,
            r.out_user_id,
            r.out_credential_version,
            correlationId,
          );
        });
        return { status: 202, body: ACCEPTED_BODY };
      },
    }),

    definePublicRoute({
      method: 'POST',
      path: '/v1/auth/login',
      operationId: 'logIn',
      summary: 'Exchange email and password for a bearer session token.',
      tags: ['identity'],
      idempotent: false,
      idempotencyExempt:
        'Each call issues a fresh session; storing issued tokens for replay would persist secrets.',
      rateLimit: AUTH_RATE_LIMIT,
      schemas: { body: loginBody, response: { status: 200, schema: sessionSchema } },
      async handler({ body, correlationId }) {
        const { rows } = await pool.query<{
          out_user_id: string;
          out_password_hash: string;
          out_locked: boolean;
          out_email_verified: boolean;
        }>(
          'SELECT out_user_id, out_password_hash, out_locked, out_email_verified FROM eventhub.auth_login_lookup($1)',
          [body.email],
        );
        const account = rows[0];
        const passwordOk = await hasher.verify(
          account?.out_password_hash ?? (await dummyHash),
          body.password,
        );
        const upgradedHash =
          account &&
          passwordOk &&
          !account.out_locked &&
          hasher.needsRehash(account.out_password_hash)
            ? await hasher.hash(body.password)
            : null;

        // Failure evidence must commit, so the transaction returns an outcome instead of throwing.
        const outcome = await withTransaction(pool, {}, async (client) => {
          const actor: Actor = { type: 'user', id: account?.out_user_id ?? null };
          if (!account || account.out_locked || !passwordOk) {
            let lockedNow = account?.out_locked ?? false;
            if (account && !account.out_locked) {
              const r = await client.query<{ auth_record_login_failure: boolean }>(
                'SELECT eventhub.auth_record_login_failure($1, $2, $3)',
                [account.out_user_id, settings.loginMaxFailures, settings.loginLockSeconds],
              );
              lockedNow = r.rows[0]!.auth_record_login_failure;
            }
            await audit(
              client,
              'identity.login_failed',
              actor,
              account?.out_user_id ?? null,
              correlationId,
              {
                reason: !account
                  ? 'unknown_account'
                  : account.out_locked
                    ? 'locked'
                    : 'bad_password',
                locked: lockedNow,
              },
            );
            return null;
          }
          const { token, hash } = newSessionToken();
          const s = await client.query<{ out_session_id: string; out_expires_at: Date }>(
            'SELECT out_session_id, out_expires_at FROM eventhub.auth_complete_login($1, $2, $3, $4)',
            [account.out_user_id, hash, settings.sessionTtlSeconds, upgradedHash],
          );
          const session = s.rows[0]!;
          await audit(client, 'identity.logged_in', actor, account.out_user_id, correlationId, {
            sessionId: session.out_session_id,
            hashUpgraded: upgradedHash !== null,
          });
          return {
            token,
            tokenType: 'Bearer' as const,
            expiresAt: session.out_expires_at.toISOString(),
            emailVerified: account.out_email_verified,
          };
        });
        // One message for unknown account, wrong password, and lockout: no enumeration signal.
        if (!outcome) throw new AppError('invalid_credentials', 'Email or password is incorrect.');
        return { status: 200, body: outcome };
      },
    }),

    definePublicRoute({
      method: 'POST',
      path: '/v1/auth/verify-email',
      operationId: 'verifyEmail',
      summary: 'Confirm mailbox control with the single-use token from the verification email.',
      tags: ['identity'],
      idempotent: false,
      idempotencyExempt:
        'Single-use token: a repeat has no side effects and reports the token as used.',
      rateLimit: VERIFY_RATE_LIMIT,
      schemas: {
        body: verifyBody,
        response: {
          status: 200,
          schema: z.object({ status: z.literal('verified') }).meta({ id: 'EmailVerified' }),
        },
      },
      async handler({ body, correlationId }) {
        const tokenHash = createHash('sha256').update(body.token).digest();
        const verified = await withTransaction(pool, {}, async (client) => {
          const { rows } = await client.query<{ out_user_id: string }>(
            'SELECT out_user_id FROM eventhub.auth_consume_verification($1)',
            [tokenHash],
          );
          const userId = rows[0]?.out_user_id;
          if (!userId) return false;
          const actor: Actor = { type: 'user', id: userId };
          await audit(client, 'identity.email_verified', actor, userId, correlationId, {
            sessionsRevoked: true,
          });
          await enqueueEvent(
            client,
            createDomainEvent({
              eventType: 'identity.email_verified',
              schemaVersion: 1,
              actor,
              organizationId: null,
              aggregateType: 'user',
              aggregateId: userId,
              correlationId,
              payload: { userId },
            }),
          );
          return true;
        });
        if (!verified) {
          throw new AppError(
            'validation_failed',
            'This verification link is invalid or has expired.',
            {
              details: { reason: 'invalid_or_expired_token' },
            },
          );
        }
        return { status: 200, body: { status: 'verified' } };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/auth/logout',
      operationId: 'logOut',
      summary: 'Revoke the current session.',
      tags: ['identity'],
      requires: 'authenticated',
      idempotent: false,
      idempotencyExempt: 'Revoking an already-revoked session is a no-op.',
      schemas: { response: { status: 204 } },
      async handler({ principal, correlationId }) {
        await withTransaction(pool, { userId: principal.userId }, async (client) => {
          await client.query('SELECT eventhub.auth_revoke_session($1, $2)', [
            principal.sessionId,
            principal.userId,
          ]);
          await audit(
            client,
            'identity.logged_out',
            { type: 'user', id: principal.userId },
            principal.userId,
            correlationId,
            {
              sessionId: principal.sessionId,
            },
          );
        });
        return { status: 204, body: null };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/me',
      operationId: 'getCurrentUser',
      summary: 'Identity of the session holder.',
      tags: ['identity'],
      requires: 'authenticated',
      idempotent: false,
      schemas: { response: { status: 200, schema: meSchema } },
      async handler({ principal }) {
        const row = await withTransaction(pool, { userId: principal.userId }, async (client) => {
          const { rows } = await client.query<{
            id: string;
            email: string;
            email_verified_at: Date | null;
          }>('SELECT id, email, email_verified_at FROM eventhub.app_user WHERE id = $1', [
            principal.userId,
          ]);
          return rows[0]!;
        });
        return {
          status: 200,
          body: { userId: row.id, email: row.email, emailVerified: row.email_verified_at !== null },
        };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/auth/resend-verification',
      operationId: 'resendVerificationEmail',
      summary: 'Send a new verification email to the signed-in, unverified user.',
      tags: ['identity'],
      requires: 'authenticated',
      idempotent: true,
      rateLimit: AUTH_RATE_LIMIT,
      schemas: { response: { status: 202, schema: acceptedSchema } },
      async handler({ principal, correlationId, idempotencyKey, idempotencyScope }) {
        return withTransaction(pool, { userId: principal.userId }, (client) =>
          runIdempotentCommand(
            client,
            { actorId: principal.userId, scope: idempotencyScope, key: idempotencyKey!, body: {} },
            async () => {
              if (!principal.emailVerified) {
                await requestVerificationEmail(client, principal.userId, null, correlationId);
              }
              return {
                status: 202,
                body: {
                  status: 'accepted',
                  message: 'If your address is unverified, a new email is on its way.',
                },
              };
            },
          ),
        );
      },
    }),
  ];
}
