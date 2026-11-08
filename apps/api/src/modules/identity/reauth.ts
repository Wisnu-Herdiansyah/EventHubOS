import { AppError, type Actor } from '@eventhub/kernel';
import { withTransaction, writeAudit, type Pool } from '@eventhub/db';
import type { PasswordHasher } from './password.ts';

export interface LockoutSettings {
  loginMaxFailures: number;
  loginLockSeconds: number;
}

/**
 * Re-authentication with the current password for sensitive account changes (change password,
 * two-step verification). Wrong attempts count toward the login lockout, so a stolen session
 * cannot be used to guess the password; the failure is committed before the error is raised.
 * Returns the credential for further checks.
 */
export async function reauthenticate(
  pool: Pool,
  hasher: PasswordHasher,
  settings: LockoutSettings,
  input: {
    userId: string;
    password: string;
    correlationId: string;
    /** Audit action recorded on failure, e.g. identity.password_change_failed. */
    failureAction: string;
    /** Request field the password came from, for the field error. */
    field: string;
  },
): Promise<{ passwordHash: string; email: string }> {
  const { rows } = await pool.query<{
    out_password_hash: string;
    out_locked: boolean;
    out_email: string;
  }>('SELECT out_password_hash, out_locked, out_email FROM eventhub.auth_credential_for_user($1)', [
    input.userId,
  ]);
  const credential = rows[0];
  if (!credential) throw new AppError('unauthenticated', 'Sign in again.');
  const ok =
    !credential.out_locked && (await hasher.verify(credential.out_password_hash, input.password));
  if (ok) return { passwordHash: credential.out_password_hash, email: credential.out_email };

  const actor: Actor = { type: 'user', id: input.userId };
  const lockedNow = await withTransaction(pool, { userId: input.userId }, async (client) => {
    let locked = credential.out_locked;
    if (!locked) {
      const r = await client.query<{ auth_record_login_failure: boolean }>(
        'SELECT eventhub.auth_record_login_failure($1, $2, $3)',
        [input.userId, settings.loginMaxFailures, settings.loginLockSeconds],
      );
      locked = r.rows[0]!.auth_record_login_failure;
    }
    await writeAudit(client, {
      organizationId: null,
      actor,
      action: input.failureAction,
      targetType: 'user',
      targetId: input.userId,
      correlationId: input.correlationId,
      metadata: { reason: credential.out_locked ? 'locked' : 'bad_password', locked },
    });
    return locked;
  });
  if (lockedNow) {
    throw new AppError(
      'validation_failed',
      'Too many incorrect attempts. Try again later, or reset your password by email.',
      { details: { reason: 'locked' } },
    );
  }
  throw new AppError('validation_failed', 'Invalid request body.', {
    details: {
      reason: 'bad_current_password',
      fields: [{ path: input.field, message: 'Your current password is incorrect.' }],
    },
  });
}
