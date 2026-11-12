import type { Metadata } from 'next';
import { siteConfig, siteDevPort } from '@/lib/config';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { after } from 'next/server';
import { SitePreview } from '@eventhub/microsite';
import { eventDateLine } from '@/lib/format';
import { RegisterForm } from '@/components/register-form';
import { countView } from '@/lib/count-view';
import { countsAsView } from '@/lib/page-views';
import { publicEventPage, type PublicEventPage as PublicEventPageData } from '@/lib/public-api';

type Params = Promise<{ handle: string; eventSlug: string }>;

/** The registration form while open or taking a waitlist; otherwise a short status (ADR-0023). */
function registerSlot(page: PublicEventPageData, handle: string, eventSlug: string) {
  const r = page.registration;
  if (r.state === 'open' || r.state === 'waitlist') {
    const register = page.sections.find((s) => s.type === 'register');
    return (
      <RegisterForm
        handle={handle}
        eventSlug={eventSlug}
        privacyPolicyUrl={page.privacyPolicyUrl}
        ctaLabel={(register?.type === 'register' && register.ctaLabel) || 'Register'}
        waitlist={r.state === 'waitlist'}
        questions={r.questions}
      />
    );
  }
  const message =
    r.state === 'not_open_yet'
      ? `Registration opens ${r.opensAt ? eventDateLine(r.opensAt, page.timezone) : 'soon'}.`
      : r.state === 'full'
        ? 'This event is full.'
        : 'Registration is closed.';
  return (
    <p className="site-notice" role="status">
      {message}
    </p>
  );
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { handle, eventSlug } = await params;
  const page = await publicEventPage(handle, eventSlug);
  if (!page) return { title: 'Page not found' };
  const title = page.sharing.title ?? page.name;
  const description = page.sharing.description ?? undefined;
  // The sharing image (ADR-0046), as an absolute address on this event's own site: link
  // previews fetch it from there.
  const { domain, https } = siteConfig();
  const origin = `${https ? 'https' : 'http'}://${handle}.${domain}${siteDevPort()}`;
  const image = page.sharing.imageAssetId
    ? `${origin}/images/${page.sharing.imageAssetId}/large.webp`
    : undefined;
  return {
    title,
    description,
    // Unlisted events are shared by link only.
    robots: page.indexable ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: {
      title,
      description,
      type: 'website',
      ...(image ? { images: [{ url: image }] } : {}),
    },
    twitter: image
      ? { card: 'summary_large_image', title, description, images: [image] }
      : { card: 'summary', title, description },
  };
}

/** A public event page: the published revision, rendered with the editor's own components. */
export default async function PublicEventPage({ params }: { params: Params }) {
  const { handle, eventSlug } = await params;
  const page = await publicEventPage(handle, eventSlug);
  if (!page) notFound();
  // Page views (ADR-0044): counted after the response, for real page loads only.
  const h = await headers();
  if (countsAsView(h)) {
    const forwarded = h.get('x-forwarded-for');
    after(() => countView(handle, eventSlug, forwarded));
  }
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <main id="main">
        <SitePreview
          asPage
          brand={page.theme === 'default' ? undefined : page.theme}
          registerSlot={registerSlot(page, handle, eventSlug)}
          name={page.name}
          lang={page.language}
          dateLine={eventDateLine(page.startsAt, page.timezone)}
          sections={page.sections}
          timezone={page.timezone}
          imageUrl={(id) => `/images/${id}/small.webp`}
        />
      </main>
    </>
  );
}
