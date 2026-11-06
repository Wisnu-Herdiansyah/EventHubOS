import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ChangePasswordForm,
  RevokeOtherSessionsForm,
  RevokeSessionForm,
} from '@/components/account-forms';
import { api, signInOn401, unwrap } from '@/lib/api';
import { readSessionToken } from '@/lib/session';
import { formatInZone, relativeTime } from '@/lib/time';
import { describeUserAgent } from '@/lib/user-agent';

export const metadata: Metadata = { title: 'Account' };

/** Confirmations after actions whose row disappears. Unknown codes are ignored. */
const NOTICES: Record<string, string> = {
  session_signed_out: 'That session was signed out.',
  others_signed_out: 'All other sessions were signed out. This one stays signed in.',
};

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await readSessionToken())) redirect('/login?next=%2Faccount');
  const code = (await searchParams).notice;
  const notice = typeof code === 'string' ? NOTICES[code] : undefined;
  let me, sessions;
  try {
    const client = await api();
    me = unwrap(await client.GET('/v1/me'));
    sessions = unwrap(await client.GET('/v1/auth/sessions')).data;
  } catch (error) {
    signInOn401(error, '/account');
  }
  const now = new Date();
  const others = sessions.filter((s) => !s.current);
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="eyebrow">Your account</p>
          <h1>Account</h1>
          <p className="muted">Signed in as {me.email}</p>
        </div>
      </div>
      {notice ? (
        <div className="message success" role="status">
          {notice}
        </div>
      ) : null}
      <section className="card narrow-card" aria-labelledby="sessions-heading">
        <h2 id="sessions-heading">Signed-in sessions</h2>
        <p className="muted">
          Where you are signed in. If you do not recognise a session, sign it out and change your
          password.
        </p>
        <ul className="member-list">
          {sessions.map((s) => {
            const label = describeUserAgent(s.userAgent);
            return (
              <li key={s.id}>
                <div className="member-head">
                  <span>
                    <span className="member-email">{label}</span>
                    <span className="hint">
                      Last active {relativeTime(s.lastSeenAt, now)} · signed in{' '}
                      {formatInZone(s.createdAt, 'UTC')}
                    </span>
                  </span>
                  {s.current ? <span className="badge accepted">This device</span> : null}
                </div>
                {s.current ? null : <RevokeSessionForm sessionId={s.id} label={label} />}
              </li>
            );
          })}
        </ul>
        {others.length > 0 ? <RevokeOtherSessionsForm /> : null}
      </section>
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
