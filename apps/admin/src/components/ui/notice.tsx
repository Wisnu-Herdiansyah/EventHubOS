import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';

const ICONS: Record<NoticeTone, IconName> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'error',
};

/**
 * Inline message. Errors are alerts (announced at once); everything else is a polite status.
 * Pass `role={null}` for static explanatory text that should not be announced.
 */
export function Notice({
  tone = 'info',
  title,
  reference,
  role,
  children,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  reference?: string;
  role?: 'alert' | 'status' | null;
  children?: ReactNode;
}) {
  const resolvedRole =
    role === null ? undefined : (role ?? (tone === 'danger' ? 'alert' : 'status'));
  return (
    <div className={tone === 'info' ? 'notice' : `notice notice--${tone}`} role={resolvedRole}>
      <span className="notice__icon">
        <Icon name={ICONS[tone]} size={18} />
      </span>
      <div className="notice__body">
        {title ? <p className="notice__title">{title}</p> : null}
        {children}
        {reference ? <span className="notice__reference">Reference: {reference}</span> : null}
      </div>
    </div>
  );
}
