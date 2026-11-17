import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ManageRegistration } from '@/components/manage-registration';
import { HANDLE } from '@/lib/host';

// A personal link: never indexed, never sent on as a referrer.
export const metadata: Metadata = {
  title: 'Your registration',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/** /manage-registration on an organization's site (ADR-0065). */
export default async function ManageRegistrationPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  if (!HANDLE.test(handle)) notFound();
  return (
    <main id="main" className="site site-missing">
      <div>
        <h1>Your registration</h1>
        <ManageRegistration />
      </div>
    </main>
  );
}
