import type { Metadata } from 'next';
import { LoginForm } from '@/components/auth-forms';
import { safeNext } from '@/lib/redirect';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return (
    <div className="narrow card accent">
      <p className="eyebrow">Welcome back</p>
      <h1>Sign in</h1>
      <LoginForm next={safeNext(params.next)} />
    </div>
  );
}
