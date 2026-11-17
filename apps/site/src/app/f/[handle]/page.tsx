import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FeedbackForm } from '@/components/feedback-form';
import { HANDLE } from '@/lib/host';

// The personal link must not be indexed or leak through a referrer.
export const metadata: Metadata = {
  title: 'Feedback',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/** /feedback on an organization's site (ADR-0063). */
export default async function FeedbackPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  if (!HANDLE.test(handle)) notFound();
  return (
    <main id="main" className="site site-missing">
      <div>
        <h1>Feedback</h1>
        <FeedbackForm />
      </div>
    </main>
  );
}
