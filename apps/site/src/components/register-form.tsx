'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { registerAction, type RegisterState } from '@/app/actions';
import type { Question } from '@/lib/public-api';

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
  questions = [],
}: {
  handle: string;
  eventSlug: string;
  privacyPolicyUrl: string | null;
  ctaLabel: string;
  waitlist?: boolean;
  /** The event's extra questions (ADR-0041). */
  questions?: Question[];
}) {
  const [state, action] = useActionState<RegisterState, FormData>(
    registerAction.bind(null, handle, eventSlug, questions),
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
      {questions.map((q) => (
        <QuestionField
          key={q.id}
          question={q}
          error={err[`q-${q.id}`]}
          value={state.values?.[`q-${q.id}`]}
        />
      ))}
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

/** One registration question (ADR-0041), with its hint and error tied to the input. */
function QuestionField({
  question: q,
  error,
  value,
}: {
  question: Question;
  error?: string;
  value?: string;
}) {
  const id = `reg-q-${q.id}`;
  const name = `q-${q.id}`;
  const described =
    [q.help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') ||
    undefined;
  const label = (
    <>
      {q.label}
      {q.required ? null : <span className="site-optional"> (optional)</span>}
    </>
  );
  const help = q.help ? (
    <span id={`${id}-help`} className="site-help">
      {q.help}
    </span>
  ) : null;
  const errorText = error ? (
    <span id={`${id}-error`} className="site-error">
      {error}
    </span>
  ) : null;
  if (q.type === 'choice' || q.type === 'yes_no') {
    const options =
      q.type === 'yes_no'
        ? [
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]
        : (q.options ?? []).map((o) => ({ value: o, label: o }));
    return (
      <fieldset
        className="site-field site-choice"
        aria-describedby={described}
        aria-invalid={error ? true : undefined}
      >
        <legend>{label}</legend>
        {help}
        {options.map((o, i) => (
          <label key={o.value} className="site-check">
            <input
              type="radio"
              name={name}
              value={o.value}
              required={q.required && i === 0}
              defaultChecked={value === o.value}
            />
            <span>{o.label}</span>
          </label>
        ))}
        {errorText}
      </fieldset>
    );
  }
  return (
    <div className="site-field">
      <label htmlFor={id}>{label}</label>
      {help}
      {q.type === 'long_text' ? (
        <textarea
          id={id}
          name={name}
          className="site-input"
          rows={4}
          maxLength={2000}
          required={q.required}
          defaultValue={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
        />
      ) : (
        <input
          id={id}
          name={name}
          className="site-input"
          maxLength={200}
          required={q.required}
          defaultValue={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
        />
      )}
      {errorText}
    </div>
  );
}
