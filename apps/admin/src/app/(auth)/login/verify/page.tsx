import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthCard } from '@/components/auth-card';
import { VerifyLoginForm } from '@/components/auth-forms';
import { PasskeyLoginButton } from '@/components/passkeys';
import { Notice } from '@/components/ui/notice';
import { safeNext } from '@/lib/redirect';
import { readMfaChallenge } from '@/lib/session';

export const metadata: Metadata = { title: 'Two-step verification' };

/** Second step of sign-in (ADR-0022). */
export default async function VerifyLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const recovery = params.method === 'recovery';
  // ADR-0033: the password step said a passkey can finish this sign-in (only the UI uses this).
  const passkey = params.pk === '1';
  const pending = Boolean(await readMfaChallenge());
  const base = `/login/verify?${next !== '/' ? `next=${encodeURIComponent(next)}&` : ''}${
    passkey ? 'pk=1&' : ''
  }`;
  return (
    <AuthCard
      title="Two-step verification"
      description={
        recovery
          ? 'Enter one of your recovery codes. Each code works once.'
          : passkey
            ? 'Use your passkey, or enter the 6-digit code from your authenticator app.'
            : 'Enter the 6-digit code from your authenticator app.'
      }
    >
      {pending ? (
        <>
          {passkey && !recovery ? (
            <>
              <PasskeyLoginButton next={next} />
              <p className="auth-divider" aria-hidden="true">
                or
              </p>
            </>
          ) : null}
          <VerifyLoginForm next={next} recovery={recovery} secondary={passkey && !recovery} />
          <p className="field__hint">
            {recovery ? (
              <Link href={`${base}method=code`}>Use your authenticator app instead</Link>
            ) : (
              <Link href={`${base}method=recovery`}>Can’t use your app? Use a recovery code</Link>
            )}
          </p>
        </>
      ) : (
        <Notice tone="warning" title="This sign-in has expired">
          <Link href={`/login${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}>
            Sign in again
          </Link>
          .
        </Notice>
      )}
    </AuthCard>
  );
}
