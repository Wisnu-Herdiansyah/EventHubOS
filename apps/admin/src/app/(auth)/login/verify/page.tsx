import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthCard } from '@/components/auth-card';
import { VerifyLoginForm } from '@/components/auth-forms';
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
  const pending = Boolean(await readMfaChallenge());
  const base = `/login/verify?${next !== '/' ? `next=${encodeURIComponent(next)}&` : ''}`;
  return (
    <AuthCard
      title="Two-step verification"
      description={
        recovery
          ? 'Enter one of your recovery codes. Each code works once.'
          : 'Enter the 6-digit code from your authenticator app.'
      }
    >
      {pending ? (
        <>
          <VerifyLoginForm next={next} recovery={recovery} />
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
