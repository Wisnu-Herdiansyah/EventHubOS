import type { ReactNode } from 'react';

/** The single card on signed-out pages. */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="card auth__card">
      <div className="auth__heading">
        <h1>{title}</h1>
        {description ? <p className="page-header__description">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}
