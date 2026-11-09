import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CancelRegistration } from '@/components/cancel-registration';
import { HANDLE } from '@/lib/host';

export const metadata: Metadata = { title: 'Cancel registration' };

/** /cancel-registration on an organization's site (ADR-0023). */
export default async function CancelRegistrationPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  if (!HANDLE.test(handle)) notFound();
  return (
    <main id="main" className="site site-missing">
      <div>
        <h1>Cancel registration</h1>
        <CancelRegistration />
      </div>
    </main>
  );
}
