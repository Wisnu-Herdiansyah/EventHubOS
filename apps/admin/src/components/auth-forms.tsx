'use client';

import Link from 'next/link';
import { useActionState, useEffect, useState } from 'react';
import {
  acceptInvitationAction,
  loginAction,
  signupAction,
  verifyEmailAction,
} from '@/app/actions/auth';
import { initialFormState } from '@/lib/errors';
import { Field, FormMessage, SubmitButton } from './form';

export function LoginForm({ next }: { next: string }) {
  const [state, action] = useActionState(loginAction, initialFormState);
  return (
    <form action={action} noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="next" value={next} />
      <Field name="email" label="Email" type="email" state={state} autoComplete="email" required />
      <Field
        name="password"
        label="Password"
        type="password"
        state={state}
        autoComplete="current-password"
        required
      />
      <div className="actions">
        <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
        <Link href={`/signup${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}>
          Create an account
        </Link>
      </div>
    </form>
  );
}

export function SignupForm() {
  const [state, action] = useActionState(signupAction, initialFormState);
  if (state.ok) return <FormMessage state={state} />;
  return (
    <form action={action} noValidate>
      <FormMessage state={state} />
      <Field name="email" label="Email" type="email" state={state} autoComplete="email" required />
      <Field
        name="password"
        label="Password"
        type="password"
        state={state}
        autoComplete="new-password"
        hint="At least 12 characters. A passphrase of several words works well."
        required
      />
      <div className="actions">
        <SubmitButton pendingLabel="Creating account…">Create account</SubmitButton>
        <Link href="/login">I already have an account</Link>
      </div>
    </form>
  );
}

/** Reads the single-use token from the URL fragment, removes it from the address bar, submits it. */
function useFragmentToken(): string | null | undefined {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const match = /(?:^#|&)token=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash);
    if (match?.[1]) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    setToken(match?.[1] ?? null);
  }, []);
  return token;
}

export function VerifyEmail() {
  const token = useFragmentToken();
  const [state, action] = useActionState(verifyEmailAction, initialFormState);
  if (token === undefined) return <p>Checking your link…</p>;
  if (token === null && !state.message) {
    return (
      <div className="message error" role="alert">
        This verification link is incomplete. Open the link from your email again.
      </div>
    );
  }
  if (state.ok) {
    return (
      <>
        <FormMessage state={state} />
        <Link className="button" href="/login">
          Sign in
        </Link>
      </>
    );
  }
  return (
    <form action={action}>
      <FormMessage state={state} />
      <input type="hidden" name="token" value={token ?? ''} />
      <p>Confirm that this email address belongs to you.</p>
      <SubmitButton pendingLabel="Verifying…">Verify my email</SubmitButton>
    </form>
  );
}

const PENDING_INVITE_KEY = 'eventhub.pendingInvitation';

/**
 * Invitation links carry the token in the fragment. If the visitor still has to sign in or sign
 * up, the token waits in sessionStorage (this tab only) and is cleared once used.
 */
export function AcceptInvitation({ signedIn }: { signedIn: boolean }) {
  const fragment = useFragmentToken();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [state, action] = useActionState(acceptInvitationAction, initialFormState);

  useEffect(() => {
    if (fragment === undefined) return;
    let t = fragment;
    try {
      if (t) sessionStorage.setItem(PENDING_INVITE_KEY, t);
      else t = sessionStorage.getItem(PENDING_INVITE_KEY);
      if (t && signedIn) sessionStorage.removeItem(PENDING_INVITE_KEY);
    } catch {
      // Storage unavailable: the token from the fragment still works in this page view.
    }
    setToken(t);
  }, [fragment, signedIn]);

  if (token === undefined) return <p>Checking your invitation…</p>;
  if (!token)
    return (
      <div className="message error" role="alert">
        This invitation link is incomplete. Open the link from your email again.
      </div>
    );
  if (!signedIn) {
    return (
      <div className="stack">
        <p>
          Sign in with the email address the invitation was sent to. New to EventHub OS? Create an
          account with that address first.
        </p>
        <div className="actions">
          <Link className="button" href="/login?next=%2Faccept-invitation">
            Sign in
          </Link>
          <Link className="button secondary" href="/signup?next=%2Faccept-invitation">
            Create an account
          </Link>
        </div>
      </div>
    );
  }
  return (
    <form action={action}>
      <FormMessage state={state} />
      <input type="hidden" name="token" value={token} />
      <SubmitButton pendingLabel="Joining…">Accept invitation</SubmitButton>
    </form>
  );
}
