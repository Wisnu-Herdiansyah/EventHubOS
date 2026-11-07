import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth-card';
import { AcceptInvitation } from '@/components/auth-forms';
import { readSessionToken } from '@/lib/session';

export const metadata: Metadata = { title: 'Accept invitation' };

export default async function AcceptInvitationPage() {
  const signedIn = Boolean(await readSessionToken());
  return (
    <AuthCard title="Join your team" description="You have been invited to an organization.">
      <AcceptInvitation signedIn={signedIn} />
    </AuthCard>
  );
}
