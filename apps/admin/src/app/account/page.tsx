import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChangePasswordForm } from '@/components/account-forms';
import { api, signInOn401, unwrap } from '@/lib/api';
import { readSessionToken } from '@/lib/session';

export const metadata: Metadata = { title: 'Account' };

export default async function AccountPage() {
  if (!(await readSessionToken())) redirect('/login?next=%2Faccount');
  let me;
  try {
    me = unwrap(await (await api()).GET('/v1/me'));
  } catch (error) {
    signInOn401(error, '/account');
  }
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="eyebrow">Your account</p>
          <h1>Account</h1>
          <p className="muted">Signed in as {me.email}</p>
        </div>
      </div>
      <section className="card accent narrow-card" aria-labelledby="password-heading">
        <h2 id="password-heading">Change password</h2>
        <ChangePasswordForm />
        <p className="hint">
          Forgot your current password? <Link href="/forgot-password">Reset it by email</Link>.
        </p>
      </section>
    </div>
  );
}
