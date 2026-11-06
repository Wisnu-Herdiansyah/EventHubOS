import type { Metadata } from 'next';
import { AcceptInvitation } from '@/components/auth-forms';
import { readSessionToken } from '@/lib/session';

export const metadata: Metadata = { title: 'Accept invitation' };

export default async function AcceptInvitationPage() {
  const signedIn = Boolean(await readSessionToken());
  return (
    <div className="narrow card accent">
      <p className="eyebrow">Team invitation</p>
      <h1>Join your team</h1>
      <AcceptInvitation signedIn={signedIn} />
    </div>
  );
}
