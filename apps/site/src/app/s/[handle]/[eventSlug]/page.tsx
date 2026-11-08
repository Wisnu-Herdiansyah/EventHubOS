import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SitePreview } from '@eventhub/microsite';
import { eventDateLine } from '@/lib/format';
import { publicEventPage } from '@/lib/public-api';

type Params = Promise<{ handle: string; eventSlug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { handle, eventSlug } = await params;
  const page = await publicEventPage(handle, eventSlug);
  if (!page) return { title: 'Page not found' };
  const title = page.sharing.title ?? page.name;
  const description = page.sharing.description ?? undefined;
  return {
    title,
    description,
    // Unlisted events are shared by link only.
    robots: page.indexable ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: { title, description, type: 'website' },
  };
}

/** A public event page: the published revision, rendered with the editor's own components. */
export default async function PublicEventPage({ params }: { params: Params }) {
  const { handle, eventSlug } = await params;
  const page = await publicEventPage(handle, eventSlug);
  if (!page) notFound();
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <main id="main">
        <SitePreview
          asPage
          name={page.name}
          lang={page.language}
          dateLine={eventDateLine(page.startsAt, page.timezone)}
          sections={page.sections}
        />
      </main>
    </>
  );
}
