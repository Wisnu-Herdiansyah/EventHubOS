'use client';

import { useEffect, useState, useTransition } from 'react';
import { cancelRegistrationAction } from '@/app/actions';

/**
 * Reads the single-use token from the URL fragment (never sent to servers by the browser),
 * removes it from the address bar, and asks before cancelling.
 */
export function CancelRegistration() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    const m = /(?:^#|&)token=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash);
    if (m?.[1]) window.history.replaceState(null, '', window.location.pathname);
    setToken(m?.[1] ?? null);
  }, []);
  if (token === undefined) return <p role="status">Checking your link…</p>;
  if (result) {
    return (
      <p
        className={result.ok ? 'site-notice site-notice--success' : 'site-error'}
        role={result.ok ? 'status' : 'alert'}
      >
        {result.message}
      </p>
    );
  }
  if (!token) {
    return (
      <p className="site-error" role="alert">
        This link is incomplete. Open it from your email again.
      </p>
    );
  }
  return (
    <div className="site-form">
      <p>Cancel your registration, or leave the waitlist? Your place goes to the next person.</p>
      <div>
        <button
          type="button"
          className="site-cta"
          disabled={pending}
          aria-busy={pending}
          onClick={() => start(async () => setResult(await cancelRegistrationAction(token)))}
        >
          {pending ? 'Cancelling…' : 'Yes, cancel my place'}
        </button>
      </div>
    </div>
  );
}
