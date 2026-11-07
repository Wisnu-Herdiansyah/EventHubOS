import type { ReactNode } from 'react';

/**
 * A titled surface. `titleId` labels the section for assistive tech, so every card on a page is
 * a named region. Flush cards hold edge-to-edge content such as tables.
 */
export function Card({
  title,
  titleId,
  description,
  actions,
  flush,
  footer,
  className,
  children,
}: {
  title?: ReactNode;
  titleId?: string;
  description?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const header =
    title || actions ? (
      <div className="card__header">
        <div>
          {title ? (
            <h2 className="card__title" id={titleId}>
              {title}
            </h2>
          ) : null}
          {description ? <p className="card__description">{description}</p> : null}
        </div>
        {actions ? <div className="cluster">{actions}</div> : null}
      </div>
    ) : null;
  const classes = ['card', flush ? 'card--flush' : null, className].filter(Boolean).join(' ');
  return (
    <section className={classes} aria-labelledby={title ? titleId : undefined}>
      {header}
      {flush ? <div className="card__body">{children}</div> : children}
      {footer ? <div className="card__footer">{footer}</div> : null}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="card stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      {hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  );
}
