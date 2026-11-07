import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';

export function EmptyState({
  icon = 'layers',
  title,
  description,
  action,
  headingLevel = 3,
}: {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className="empty-state">
      <span className="empty-state__icon">
        <Icon name={icon} size={22} />
      </span>
      <Heading className="empty-state__title">{title}</Heading>
      {description ? <p className="empty-state__description">{description}</p> : null}
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}
