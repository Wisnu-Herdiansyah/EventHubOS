'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  registrationDetailsAction,
  saveRegistrationDetailsAction,
  type DetailsState,
  type OwnDetails,
} from '@/app/actions';
import { QuestionField } from './register-form';

function Save() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="site-cta" disabled={pending} aria-busy={pending}>
      {pending ? 'Saving…' : 'Save my details'}
    </button>
  );
}

/** Stored answers as the form shows them: yes/no as the radio values. */
function answerValues(d: OwnDetails): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of d.questions) {
    const a = d.answers[q.id];
    if (a === undefined) continue;
    out[`q-${q.id}`] = typeof a === 'boolean' ? (a ? 'yes' : 'no') : a;
  }
  return out;
}

const STATUS: Record<OwnDetails['status'], string> = {
  confirmed: 'You’re registered.',
  waitlisted: 'You’re on the waitlist.',
  pending: 'Your request is waiting for the organizer.',
};

function DetailsForm({ token, details }: { token: string; details: OwnDetails }) {
  const [state, action] = useActionState<DetailsState, FormData>(
    saveRegistrationDetailsAction.bind(null, token, details.questions),
    { status: 'idle' },
  );
  const values = state.values ?? { name: details.name, ...answerValues(details) };
  const err = state.fields ?? {};
  return (
    <form action={action} className="site-form" noValidate>
      <p>
        {STATUS[details.status]} Correct your details for <strong>{details.eventName}</strong>{' '}
        below. Your email address can’t be changed here.
      </p>
      {state.status === 'done' ? (
        <p className="site-notice site-notice--success" role="status">
          {state.message}
        </p>
      ) : null}
      {state.status === 'error' && state.message ? (
        <p className="site-error" role="alert">
          {state.message}
        </p>
      ) : null}
      <div className="site-field">
        <label htmlFor="manage-name">Name</label>
        <input
          id="manage-name"
          name="name"
          className="site-input"
          autoComplete="name"
          maxLength={120}
          required
          defaultValue={values.name}
          aria-invalid={err.name ? true : undefined}
          aria-describedby={err.name ? 'manage-name-error' : undefined}
        />
        {err.name ? (
          <span id="manage-name-error" className="site-error">
            {err.name}
          </span>
        ) : null}
      </div>
      {details.questions.map((q) => (
        <QuestionField
          key={q.id}
          question={q}
          error={err[`q-${q.id}`]}
          value={values[`q-${q.id}`]}
        />
      ))}
      <div>
        <Save />
      </div>
      <p className="site-help">
        Can’t come after all?{' '}
        <a href={`/cancel-registration#token=${token}`}>
          {details.status === 'pending'
            ? 'Withdraw your request'
            : details.status === 'waitlisted'
              ? 'Leave the waitlist'
              : 'Cancel your registration'}
        </a>
        .
      </p>
    </form>
  );
}

/**
 * Change your own registration details (ADR-0065). Reads the personal token from the URL
 * fragment (never sent to servers by the browser), removes it from the address bar, and shows
 * the person's name and answers to correct.
 */
export function ManageRegistration() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [details, setDetails] = useState<OwnDetails | { error: string } | null>(null);
  useEffect(() => {
    const m = /(?:^#|&)token=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash);
    if (m?.[1]) window.history.replaceState(null, '', window.location.pathname);
    const found = m?.[1] ?? null;
    setToken(found);
    if (found) void registrationDetailsAction(found).then(setDetails);
  }, []);
  if (token === undefined || (token && details === null)) {
    return <p role="status">Checking your link…</p>;
  }
  if (!token) {
    return (
      <p className="site-error" role="alert">
        This link is incomplete. Open it from your email again.
      </p>
    );
  }
  if (details && 'error' in details) {
    return (
      <p className="site-error" role="alert">
        {details.error}
      </p>
    );
  }
  return <DetailsForm token={token} details={details as OwnDetails} />;
}
