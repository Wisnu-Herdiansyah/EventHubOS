/**
 * Public microsite section renderers (preview only). Each section type has a typed, versioned
 * shape; nothing here renders tenant-supplied HTML or script. The page builder will store these
 * as validated section instances (see docs/design/design-system.md, "Builder").
 */
export type SectionType = 'hero' | 'about' | 'agenda' | 'speakers' | 'register';

export interface SectionInstance {
  id: string;
  type: SectionType;
  version: 1;
  visible: boolean;
  heading: string;
  body: string;
}

export const SECTION_LABELS: Record<SectionType, string> = {
  hero: 'Hero',
  about: 'About',
  agenda: 'Agenda',
  speakers: 'Speakers',
  register: 'Registration',
};

const AGENDA = [
  { time: '09:00', title: 'Doors open and coffee' },
  { time: '09:30', title: 'Opening keynote' },
  { time: '11:00', title: 'Operations at scale: a panel' },
  { time: '13:00', title: 'Lunch' },
  { time: '14:00', title: 'Workshops' },
];

const SPEAKERS = [
  { name: 'Speaker One', role: 'Head of Operations' },
  { name: 'Speaker Two', role: 'Brand Director' },
  { name: 'Speaker Three', role: 'Founder' },
  { name: 'Speaker Four', role: 'Programme Lead' },
];

function initials(name: string) {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2);
}

export function SiteSection({
  section,
  selected,
}: {
  section: SectionInstance;
  selected?: boolean;
}) {
  const mark = selected ? { 'data-selected-section': '' } : {};
  switch (section.type) {
    case 'hero':
      return (
        <section className="site-hero" {...mark} aria-label={section.heading}>
          <span className="site-hero__image-note">Event image</span>
          <p className="site-hero__eyebrow">12–13 March · Jakarta</p>
          <h2 className="site-hero__title">{section.heading}</h2>
          <p className="site-hero__lede">{section.body}</p>
          <div>
            <a className="site-cta site-cta--on-hero" href="#register">
              Register now
            </a>
          </div>
        </section>
      );
    case 'about':
      return (
        <section className="site-section" {...mark} aria-label={section.heading}>
          <h2 className="site-section__title">{section.heading}</h2>
          <p className="site-section__lede">{section.body}</p>
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
          <ol className="site-agenda">
            {AGENDA.map((a) => (
              <li key={a.time}>
                <time>{a.time}</time>
                <span>{a.title}</span>
              </li>
            ))}
          </ol>
        </section>
      );
    case 'speakers':
      return (
        <section className="site-section" {...mark} aria-label={section.heading}>
          <h2 className="site-section__title">{section.heading}</h2>
          <ul className="site-speakers">
            {SPEAKERS.map((s) => (
              <li key={s.name} className="site-speaker">
                <span className="site-speaker__photo" aria-hidden="true">
                  {initials(s.name)}
                </span>
                <strong>{s.name}</strong>
                <span className="site-speaker__role">{s.role}</span>
              </li>
            ))}
          </ul>
        </section>
      );
    case 'register':
      return (
        <section className="site-section" id="register" {...mark} aria-label={section.heading}>
          <div className="site-register">
            <div>
              <h2 className="site-section__title">{section.heading}</h2>
              <p className="site-section__lede">{section.body}</p>
            </div>
            <a className="site-cta" href="#register">
              Register now
            </a>
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
  sections: SectionInstance[];
  selectedId?: string;
}) {
  return (
    <div className="site" data-brand={brand}>
      <header className="site-nav">
        <span className="site-nav__name">{name}</span>
        <ul className="site-nav__links">
          <li>
            <a href="#register">Agenda</a>
          </li>
          <li>
            <a href="#register">Speakers</a>
          </li>
        </ul>
        <a className="site-cta" href="#register">
          Register
        </a>
      </header>
      {sections
        .filter((s) => s.visible)
        .map((s) => (
          <SiteSection key={s.id} section={s} selected={s.id === selectedId} />
        ))}
      <footer className="site-footer">© 2027 {name}. Example content.</footer>
    </div>
  );
}

export const SAMPLE_SECTIONS: SectionInstance[] = [
  {
    id: 's-hero',
    type: 'hero',
    version: 1,
    visible: true,
    heading: 'Operations Summit 2027',
    body: 'Two days on running events with precision: systems, teams and the craft of hospitality.',
  },
  {
    id: 's-about',
    type: 'about',
    version: 1,
    visible: true,
    heading: 'Why attend',
    body: 'Practical sessions from teams who run hundreds of events a year, and time to meet them.',
  },
  { id: 's-agenda', type: 'agenda', version: 1, visible: true, heading: 'Agenda', body: '' },
  { id: 's-speakers', type: 'speakers', version: 1, visible: true, heading: 'Speakers', body: '' },
  {
    id: 's-register',
    type: 'register',
    version: 1,
    visible: true,
    heading: 'Save your seat',
    body: 'Places are limited. Registration closes on 1 March.',
  },
];
