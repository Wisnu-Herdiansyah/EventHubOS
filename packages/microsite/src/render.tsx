import type { ReactNode } from 'react';
import { agendaDays, dayLabel, speakerIndex, timeRange } from './program.ts';
import type { Section, SpeakerV2 } from './types.ts';

/**
 * Microsite section renderers, shared by the admin editor preview and the public site, so a
 * published page looks exactly like its preview. Every field is rendered as a text node, so
 * content can never become markup or script (ADR-0020, ADR-0021).
 */
function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => Array.from(w)[0])
      .join('')
      .toUpperCase() || '?'
  );
}

/** Paragraphs from plain text: blank lines separate them. */
function Paragraphs({ text, className }: { text: string; className: string }) {
  const parts = text.split(/\n{2,}/).filter((p) => p.trim());
  return (
    <>
      {parts.map((p, i) => (
        <p key={i} className={className}>
          {p}
        </p>
      ))}
    </>
  );
}

type SpeakerIndex = Map<string, SpeakerV2 & { linked: boolean }>;

/** "With Ade Wisnu and Rina", each name linking to the bio when it is shown on the page. */
function SessionSpeakers({ ids, speakers }: { ids: string[]; speakers: SpeakerIndex }) {
  const people = ids.map((id) => speakers.get(id)).filter((p) => p !== undefined);
  if (people.length === 0) return null;
  return (
    <span className="site-session__speakers">
      With{' '}
      {people.map((p, i) => (
        <span key={p.id}>
          {i > 0 ? (i === people.length - 1 ? ' and ' : ', ') : null}
          {p.linked ? <a href={`#speaker-${p.id}`}>{p.name}</a> : p.name}
        </span>
      ))}
    </span>
  );
}

/**
 * Where a library image is served from (ADR-0042): the admin's authenticated proxy in previews,
 * the public site's own path on the event site. Without it, speakers show their initials.
 */
export type ImageUrl = (assetId: string) => string;

function SpeakerPhoto({
  name,
  photoAssetId,
  imageUrl,
}: {
  name: string;
  photoAssetId: string | null;
  imageUrl?: ImageUrl;
}) {
  if (photoAssetId && imageUrl) {
    // Decorative: the speaker's name is right below it.
    return (
      <img
        className="site-speaker__photo site-speaker__photo--image"
        src={imageUrl(photoAssetId)}
        alt=""
        width={240}
        height={240}
        loading="lazy"
        decoding="async"
      />
    );
  }
  return (
    <span className="site-speaker__photo" aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function SiteSection({
  section,
  selected,
  registerSlot,
  speakers = new Map(),
  timezone,
  imageUrl,
}: {
  section: Section;
  selected?: boolean;
  /** Library images (speaker photos). */
  imageUrl?: ImageUrl;
  /** Public site only: the registration form or status, in place of the button. */
  registerSlot?: ReactNode;
  /** The page's speakers, for agenda sessions (ADR-0040). */
  speakers?: SpeakerIndex;
  /** The event's time zone, named under the agenda. */
  timezone?: string;
}) {
  const mark = selected ? { 'data-selected-section': '' } : {};
  switch (section.type) {
    case 'hero':
      return (
        <section className="site-hero" {...mark} aria-label={section.heading}>
          <span className="site-hero__image-note">Event image</span>
          <h2 className="site-hero__title">{section.heading}</h2>
          <Paragraphs text={section.body} className="site-hero__lede" />
          {section.ctaLabel ? (
            <div>
              <a className="site-cta site-cta--on-hero" href="#register">
                {section.ctaLabel}
              </a>
            </div>
          ) : null}
        </section>
      );
    case 'text':
      return (
        <section className="site-section" {...mark} aria-label={section.heading}>
          <h2 className="site-section__title">{section.heading}</h2>
          <Paragraphs text={section.body} className="site-section__lede" />
        </section>
      );
    case 'agenda':
      if (section.version === 2) {
        const days = agendaDays(section.items);
        return (
          <section
            className="site-section site-section--surface"
            {...mark}
            aria-label={section.heading}
          >
            <h2 className="site-section__title">{section.heading}</h2>
            {days.length === 0 ? (
              <p className="site-section__lede">The agenda will be announced soon.</p>
            ) : (
              <>
                {timezone ? <p className="site-section__note">Times are in {timezone}.</p> : null}
                {days.map((d) => (
                  <div key={d.day || 'one-day'} className="site-agenda-day">
                    {d.day ? <h3 className="site-agenda-day__title">{dayLabel(d.day)}</h3> : null}
                    <ol className="site-agenda">
                      {d.items.map((a) => (
                        <li key={a.id} className="site-session">
                          <time>{timeRange(a)}</time>
                          <div className="site-session__body">
                            <strong className="site-session__title">{a.title}</strong>
                            {a.room ? <span className="site-session__room">{a.room}</span> : null}
                            <SessionSpeakers ids={a.speakerIds} speakers={speakers} />
                            {a.description ? (
                              <Paragraphs text={a.description} className="site-session__text" />
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </>
            )}
          </section>
        );
      }
      return (
        <section
          className="site-section site-section--surface"
          {...mark}
          aria-label={section.heading}
        >
          <h2 className="site-section__title">{section.heading}</h2>
          {section.items.length === 0 ? (
            <p className="site-section__lede">The agenda will be announced soon.</p>
          ) : (
            <ol className="site-agenda">
              {section.items.map((a, i) => (
                <li key={i}>
                  <time>{a.time}</time>
                  <span>{a.title}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      );
    case 'speakers':
      if (section.version !== 1) {
        return (
          <section className="site-section" {...mark} aria-label={section.heading}>
            <h2 className="site-section__title">{section.heading}</h2>
            {section.items.length === 0 ? (
              <p className="site-section__lede">Speakers will be announced soon.</p>
            ) : (
              <ul className="site-speakers">
                {section.items.map((p) => (
                  <li key={p.id} id={`speaker-${p.id}`} className="site-speaker">
                    <SpeakerPhoto
                      name={p.name}
                      photoAssetId={'photoAssetId' in p ? p.photoAssetId : null}
                      imageUrl={imageUrl}
                    />
                    <strong>{p.name}</strong>
                    {p.role ? <span className="site-speaker__role">{p.role}</span> : null}
                    {p.bio ? <Paragraphs text={p.bio} className="site-speaker__bio" /> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      }
      return (
        <section className="site-section" {...mark} aria-label={section.heading}>
          <h2 className="site-section__title">{section.heading}</h2>
          {section.items.length === 0 ? (
            <p className="site-section__lede">Speakers will be announced soon.</p>
          ) : (
            <ul className="site-speakers">
              {section.items.map((s, i) => (
                <li key={i} className="site-speaker">
                  <span className="site-speaker__photo" aria-hidden="true">
                    {initials(s.name)}
                  </span>
                  <strong>{s.name}</strong>
                  {s.role ? <span className="site-speaker__role">{s.role}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      );
    case 'register':
      return (
        <section className="site-section" id="register" {...mark} aria-label={section.heading}>
          <div className="site-register">
            <div>
              <h2 className="site-section__title">{section.heading}</h2>
              <Paragraphs text={section.body} className="site-section__lede" />
            </div>
            {registerSlot ??
              (section.ctaLabel ? (
                <a className="site-cta" href="#register">
                  {section.ctaLabel}
                </a>
              ) : null)}
          </div>
        </section>
      );
  }
}

export function SitePreview({
  brand,
  name,
  sections,
  selectedId,
  lang,
  dateLine,
  asPage,
  registerSlot,
  timezone,
  imageUrl,
  calendarHref,
  banner,
}: {
  brand?: string;
  name: string;
  sections: Section[];
  selectedId?: string;
  /** The event's primary language, for screen readers and hyphenation. */
  lang?: string;
  /** e.g. "1 Mar 2027, 09:00 GMT+7", shown under the event name. */
  dateLine?: string;
  /** On a real page the event name is the page's h1; in previews it is plain text. */
  asPage?: boolean;
  /** Public site only: shown in the registration section (added at the end if the page has none). */
  registerSlot?: ReactNode;
  /** The event's time zone; agenda times are wall-clock times in it. */
  timezone?: string;
  /** Where library images are served from (ADR-0042). */
  imageUrl?: ImageUrl;
  /** Public site only: the event's calendar file (ADR-0048), linked under the date. */
  calendarHref?: string;
  /** Public site only: an important notice above the page, e.g. a cancellation (ADR-0050). */
  banner?: ReactNode;
}) {
  const Name = asPage ? 'h1' : 'span';
  const speakers = speakerIndex(sections);
  const register = sections.find((s) => s.visible && s.type === 'register');
  return (
    <div className="site" data-brand={brand} lang={lang}>
      <header className="site-nav">
        <span className="site-nav__title">
          <Name className="site-nav__name">{name}</Name>
          {dateLine ? <span className="site-nav__date">{dateLine}</span> : null}
          {calendarHref ? (
            <a className="site-calendar-link" href={calendarHref} download>
              Add to calendar
            </a>
          ) : null}
        </span>
        {register && register.type === 'register' && register.ctaLabel ? (
          <a className="site-cta" href="#register">
            {register.ctaLabel}
          </a>
        ) : null}
      </header>
      {banner ? (
        <div className="site-banner" role="status">
          {banner}
        </div>
      ) : null}
      {sections
        .filter((s) => s.visible)
        .map((s) => (
          <SiteSection
            key={s.id}
            section={s}
            selected={s.id === selectedId}
            registerSlot={s.type === 'register' ? registerSlot : undefined}
            speakers={speakers}
            timezone={timezone}
            imageUrl={imageUrl}
          />
        ))}
      {registerSlot && !register ? (
        <section className="site-section" id="register" aria-label="Register">
          <div className="site-register site-register--stacked">
            <h2 className="site-section__title">Register</h2>
            {registerSlot}
          </div>
        </section>
      ) : null}
      <footer className="site-footer">© {name}</footer>
    </div>
  );
}

export const SAMPLE_SECTIONS: Section[] = [
  {
    id: 'hero',
    type: 'hero',
    version: 1,
    visible: true,
    heading: 'Operations Summit 2027',
    body: 'Two days on running events with precision: systems, teams and the craft of hospitality.',
    ctaLabel: 'Register now',
  },
  {
    id: 'about',
    type: 'text',
    version: 1,
    visible: true,
    heading: 'Why attend',
    body: 'Practical sessions from teams who run hundreds of events a year, and time to meet them.',
  },
  {
    id: 'agenda',
    type: 'agenda',
    version: 1,
    visible: true,
    heading: 'Agenda',
    items: [
      { time: '09:00', title: 'Doors open and coffee' },
      { time: '09:30', title: 'Opening keynote' },
      { time: '11:00', title: 'Operations at scale: a panel' },
      { time: '13:00', title: 'Lunch' },
      { time: '14:00', title: 'Workshops' },
    ],
  },
  {
    id: 'speakers',
    type: 'speakers',
    version: 1,
    visible: true,
    heading: 'Speakers',
    items: [
      { name: 'Speaker One', role: 'Head of Operations' },
      { name: 'Speaker Two', role: 'Brand Director' },
      { name: 'Speaker Three', role: 'Founder' },
      { name: 'Speaker Four', role: 'Programme Lead' },
    ],
  },
  {
    id: 'register',
    type: 'register',
    version: 1,
    visible: true,
    heading: 'Save your seat',
    body: 'Places are limited. Registration closes on 1 March.',
    ctaLabel: 'Register now',
  },
];
