'use client';

import { useState, type ReactNode } from 'react';

/**
 * A visual label for icon-only controls. The control must already have its own accessible name,
 * so the bubble is hidden from assistive tech. It appears on hover and keyboard focus, stays
 * while hovered, and Escape dismisses it (WCAG 1.4.13).
 */
export function Tooltip({
  label,
  placement = 'end',
  children,
}: {
  label: string;
  placement?: 'end' | 'top';
  children: ReactNode;
}) {
  const [dismissed, setDismissed] = useState(false);
  return (
    <span
      className={placement === 'top' ? 'tooltip tooltip--top' : 'tooltip'}
      data-dismissed={dismissed ? '' : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setDismissed(true);
      }}
      onPointerLeave={() => setDismissed(false)}
      onBlur={() => setDismissed(false)}
    >
      {children}
      <span className="tooltip__bubble" aria-hidden="true">
        {label}
      </span>
    </span>
  );
}
