import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  ChangePasswordForm,
  RevokeOtherSessionsForm,
  RevokeSessionForm,
} from '@/components/account-forms';
import { TwoStepPanel } from '@/components/two-step';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ThemePicker } from '@/components/ui/theme-picker';
import { Toast } from '@/components/ui/toast';
import { api, signInOn401, unwrap } from '@/lib/api';
import { THEME_COOKIE, parseTheme } from '@/lib/preferences';
import { readSessionToken } from '@/lib/session';
import { formatInZone, relativeTime } from '@/lib/time';
import { describeUserAgent } from '@/lib/user-agent';

export const metadata: Metadata = { title: 'Account' };

/** Confirmations after actions whose row disappears. Unknown codes are ignored. */
const NOTICES: Record<string, string> = {
  session_signed_out: 'That session was signed out.',
  others_signed_out: 'All other sessions were signed out. This one stays signed in.',
};

function duration(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  return `${minutes} minutes`;
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await readSessionToken())) redirect('/login?next=%2Faccount');
  const code = (await searchParams).notice;
  const notice = typeof code === 'string' ? NOTICES[code] : undefined;
  let me, sessions, policy, mfa;
  try {
    const client = await api();
    me = unwrap(await client.GET('/v1/me'));
    ({ data: sessions, policy } = unwrap(await client.GET('/v1/auth/sessions')));
    mfa = unwrap(await client.GET('/v1/auth/mfa'));
  } catch (error) {
    signInOn401(error, '/account');
  }
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const now = new Date();
  const others = sessions.filter((s) => !s.current);
  return (
    <div className="stack narrow">
      <PageHeader eyebrow="Your account" title="Account" description={`Signed in as ${me.email}`} />
      <Toast message={notice} />

      <Card
        title="Signed-in sessions"
        titleId="sessions-heading"
        description="Where you are signed in. If you do not recognise a session, sign it out and change your password."
        footer={others.length > 0 ? <RevokeOtherSessionsForm /> : undefined}
      >
        <div className="stack-sm">
          <ul className="list">
            {sessions.map((s) => {
              const label = describeUserAgent(s.userAgent);
              return (
                <li key={s.id} className="list__item">
                  <span className="list__main">
                    <span className="list__title">{label}</span>
                    <span className="list__meta">
                      Last active {relativeTime(s.lastSeenAt, now)} · signed in{' '}
                      {formatInZone(s.createdAt, 'UTC')}
                    </span>
                  </span>
                  {s.current ? (
                    <Badge tone="success" dot>
                      This device
                    </Badge>
                  ) : (
                    <RevokeSessionForm sessionId={s.id} label={label} />
                  )}
                </li>
              );
            })}
          </ul>
          <p className="field__hint">
            For your security, a session ends after {duration(policy.idleMinutes)} without activity,
            or {policy.maxHours} hours after signing in.
          </p>
        </div>
      </Card>

      <Card title="Change password" titleId="password-heading">
        <div className="stack-sm">
          <ChangePasswordForm />
          <p className="field__hint">
            Forgot your current password? <Link href="/forgot-password">Reset it by email</Link>.
          </p>
        </div>
      </Card>

      <Card
        title="Two-step verification"
        titleId="two-step-heading"
        description="A code from your phone, in addition to your password, when you sign in."
      >
        <TwoStepPanel
          status={mfa}
          enabledLabel={
            mfa.enabledAt ? (
              <span className="text-secondary">Since {formatInZone(mfa.enabledAt, 'UTC')}</span>
            ) : null
          }
        />
      </Card>

      <Card
        title="Appearance"
        titleId="appearance-heading"
        description="Automatic follows your device’s light or dark setting. Saved on this browser."
      >
        <ThemePicker initial={theme} />
      </Card>
    </div>
  );
}
