'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { registerAction, type RegisterState } from '@/app/actions';

function Submit({ label, waitlist }: { label: string; waitlist: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="site-cta" disabled={pending} aria-busy={pending}>
      {pending ? (waitlist ? 'Joining…' : 'Registering…') : label}
    </button>
  );
}

/**
 * Free registration form (ADR-0023), or the waitlist form when the event is full (ADR-0035).
 * Works without JavaScript too (server action). The answer is the same either way, so it never
 * reveals whether an address was already registered.
 */
export function RegisterForm({
  handle,
  eventSlug,
  privacyPolicyUrl,
  ctaLabel,
  waitlist = false,
}: {
  handle: string;
  eventSlug: string;
  privacyPolicyUrl: string | null;
  ctaLabel: string;
  waitlist?: boolean;
}) {
  const [state, action] = useActionState<RegisterState, FormData>(
    registerAction.bind(null, handle, eventSlug),
    { status: 'idle' },
  );
  if (state.status === 'done') {
    return (
      <div className="site-notice site-notice--success" role="status">
        <strong>You’re almost done.</strong> {state.message}
      </div>
    );
  }
  const err = state.fields ?? {};
  const describe = (id: string, has?: string) => (has ? `${id}-error` : undefined);
  return (
    <form action={action} className="site-form" noValidate>
      {waitlist ? (
        <p className="site-notice" role="status">
          This event is full. Join the waitlist and we’ll email you if a seat opens up.
        </p>
      ) : null}
      {state.status === 'error' && state.message ? (
        <p className="site-error" role="alert">
          {state.message}
        </p>
      ) : null}
      <div className="site-field">
        <label htmlFor="reg-name">Name</label>
        <input
          id="reg-name"
          name="name"
          className="site-input"
          autoComplete="name"
          maxLength={120}
          required
          defaultValue={state.values?.name}
          aria-invalid={err.name ? true : undefined}
          aria-describedby={describe('reg-name', err.name)}
        />
        {err.name ? (
          <span id="reg-name-error" className="site-error">
            {err.name}
          </span>
        ) : null}
      </div>
      <div className="site-field">
        <label htmlFor="reg-email">Email</label>
        <input
          id="reg-email"
          name="email"
          type="email"
          className="site-input"
          autoComplete="email"
          maxLength={254}
          required
          defaultValue={state.values?.email}
          aria-invalid={err.email ? true : undefined}
          aria-describedby={describe('reg-email', err.email)}
        />
        {err.email ? (
          <span id="reg-email-error" className="site-error">
            {err.email}
          </span>
        ) : null}
      </div>
      {/* Honeypot: hidden from people and screen readers; bots tend to fill it in. */}
      <div className="site-trap" aria-hidden="true">
        <label htmlFor="reg-website">Website</label>
        <input id="reg-website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      <label className="site-check">
        <input
          type="checkbox"
          name="privacyConsent"
          value="yes"
          required
          aria-invalid={err.privacyConsent ? true : undefined}
          aria-describedby={describe('reg-consent', err.privacyConsent)}
        />
        <span>
          I agree that the organizer stores my name and email for this event, as described in the{' '}
          {privacyPolicyUrl ? (
            <a href={privacyPolicyUrl} target="_blank" rel="noopener noreferrer">
              privacy policy
            </a>
          ) : (
            'privacy policy'
          )}
          .
        </span>
      </label>
      {err.privacyConsent ? (
        <span id="reg-consent-error" className="site-error">
          {err.privacyConsent}
        </span>
      ) : null}
      <div>
        <Submit label={waitlist ? 'Join the waitlist' : ctaLabel} waitlist={waitlist} />
      </div>
    </form>
  );
}
