import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth-card';
import { LoginForm } from '@/components/auth-forms';
import { Notice } from '@/components/ui/notice';
import { safeNext } from '@/lib/redirect';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return (
    <AuthCard title="Sign in" description="Welcome back to EventHub OS.">
      {params.ended === '1' ? (
        <Notice>
          Your session has ended, for example after a period of inactivity. Sign in again to
          continue where you left off.
        </Notice>
      ) : null}
      <LoginForm next={safeNext(params.next)} />
    </AuthCard>
  );
}
