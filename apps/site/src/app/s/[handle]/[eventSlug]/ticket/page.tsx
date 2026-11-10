import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Ticket } from '@/components/ticket';
import { eventDateLine } from '@/lib/format';
import { publicEventPage } from '@/lib/public-api';

type Params = Promise<{ handle: string; eventSlug: string }>;

export const metadata: Metadata = {
  title: 'Your ticket',
  // Personal: never indexed, never followed.
  robots: { index: false, follow: false },
};

/**
 * An attendee's ticket (ADR-0029): the event, and a QR code drawn in the browser from the
 * registration ID in the link's fragment. The server never sees the ID and looks nothing up
 * about the attendee; door staff resolve it while signed in.
 */
export default async function TicketPage({ params }: { params: Params }) {
  const { handle, eventSlug } = await params;
  const page = await publicEventPage(handle, eventSlug);
  if (!page) notFound();
  return (
    <main id="main" className="site site-missing">
      <div className="site-ticket">
        <p className="site-ticket__eyebrow">Your ticket</p>
        <h1>{page.name}</h1>
        <p>{eventDateLine(page.startsAt, page.timezone)}</p>
        <Ticket />
      </div>
    </main>
  );
}
