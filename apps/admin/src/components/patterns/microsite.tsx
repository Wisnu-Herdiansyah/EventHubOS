import type { Section } from '@/lib/page-editor';

/**
 * Public microsite section renderers. Every field is rendered as a text node, so content can
 * never become markup or script (ADR-0020). Used by the editor preview and the gallery; public
 * pages will render published revisions with the same components.
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

export function SiteSection({ section, selected }: { section: Section; selected?: boolean }) {
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
            {section.ctaLabel ? (
              <a className="site-cta" href="#register">
                {section.ctaLabel}
              </a>
            ) : null}
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
}: {
  brand?: string;
  name: string;
  sections: Section[];
  selectedId?: string;
}) {
  const register = sections.find((s) => s.visible && s.type === 'register');
  return (
    <div className="site" data-brand={brand}>
      <header className="site-nav">
        <span className="site-nav__name">{name}</span>
        {register && register.type === 'register' && register.ctaLabel ? (
          <a className="site-cta" href="#register">
            {register.ctaLabel}
          </a>
        ) : null}
      </header>
      {sections
        .filter((s) => s.visible)
        .map((s) => (
          <SiteSection key={s.id} section={s} selected={s.id === selectedId} />
        ))}
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
