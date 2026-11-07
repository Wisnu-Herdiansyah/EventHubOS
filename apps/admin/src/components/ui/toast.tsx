'use client';

import { useEffect, useState } from 'react';
import { Icon } from './icons';

/**
 * Confirmation after an action that navigated (e.g. a removed row). The live region is in the
 * page before the message is inserted, so screen readers announce it. It stays until dismissed:
 * no time limit (WCAG 2.2.1). The one-off `notice` query parameter is removed from the address,
 * so a reload does not repeat it.
 */
export function Toast({ message }: { message?: string }) {
  const [shown, setShown] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!message) return;
    setShown(message);
    const url = new URL(window.location.href);
    if (url.searchParams.has('notice')) {
      url.searchParams.delete('notice');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  }, [message]);

  return (
    <div className="toast-region" role="status" aria-live="polite">
      {shown ? (
        <div className="toast">
          <span className="toast__icon">
            <Icon name="success" size={18} />
          </span>
          <p className="toast__body">{shown}</p>
          <button
            type="button"
            className="btn btn--plain btn--sm btn--icon"
            onClick={() => setShown(undefined)}
          >
            <Icon name="close" size={16} />
            <span className="visually-hidden">Dismiss</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
