import Link from 'next/link';
import type { ReactNode } from 'react';

export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((c, i) =>
          i === items.length - 1 || !c.href ? (
            <li key={c.label + i} aria-current={i === items.length - 1 ? 'page' : undefined}>
              {c.label}
            </li>
          ) : (
            <li key={c.label + i}>
              <Link href={c.href}>{c.label}</Link>
            </li>
          ),
        )}
      </ol>
    </nav>
  );
}

/** The one page heading pattern: breadcrumbs, eyebrow, large title, description, actions. */
export function PageHeader({
  title,
  eyebrow,
  description,
  breadcrumbs,
  actions,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  breadcrumbs?: Crumb[];
  actions?: ReactNode;
}) {
  return (
    <header>
      {breadcrumbs && breadcrumbs.length > 1 ? <Breadcrumbs items={breadcrumbs} /> : null}
      <div className="page-header">
        <div className="page-header__text">
          {eyebrow ? <p className="page-header__eyebrow">{eyebrow}</p> : null}
          <h1 className="page-header__title">{title}</h1>
          {description ? <div className="page-header__description">{description}</div> : null}
        </div>
        {actions ? <div className="cluster">{actions}</div> : null}
      </div>
    </header>
  );
}
