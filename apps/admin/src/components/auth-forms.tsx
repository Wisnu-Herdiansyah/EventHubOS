'use client';

import Link from 'next/link';
import { useActionState, useEffect, useState } from 'react';
import {
  acceptInvitationAction,
  completePasswordResetAction,
  loginAction,
  requestPasswordResetAction,
  resendVerificationAction,
  signupAction,
  verifyEmailAction,
} from '@/app/actions/auth';
import { initialFormState } from '@/lib/errors';
import { Field, FormMessage, SubmitButton } from './form';
import { ButtonLink } from './ui/button';
import { Spinner } from './ui/loading';
import { Notice } from './ui/notice';

export function LoginForm({ next }: { next: string }) {
  const [state, action] = useActionState(loginAction, initialFormState);
  return (
    <form action={action} className="form" noValidate>
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
      <p className="field__hint">
        <Link href="/forgot-password">Forgot your password?</Link>
      </p>
      <div className="form__actions">
        <SubmitButton block pendingLabel="Signing in…">
          Sign in
        </SubmitButton>
        <Link href={`/signup${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}>
          Create an account
        </Link>
      </div>
    </form>
  );
}

export function SignupForm() {
  const [state, action] = useActionState(signupAction, initialFormState);
  if (state.ok) {
    return (
      <div className="stack-sm">
        <FormMessage state={state} />
        <p className="text-secondary">
          No email after a few minutes? <Link href="/login">Sign in</Link> and request a new link.
        </p>
      </div>
    );
  }
  return (
    <form action={action} className="form" noValidate>
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
      <div className="form__actions">
        <SubmitButton block pendingLabel="Creating account…">
          Create account
        </SubmitButton>
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
  if (token === undefined) return <Spinner label="Checking your link…" />;
  if (token === null && !state.message) {
    return (
      <Notice tone="danger">
        This verification link is incomplete. Open the link from your email again.
      </Notice>
    );
  }
  if (state.ok) {
    return (
      <>
        <FormMessage state={state} />
        <ButtonLink href="/login">Sign in</ButtonLink>
      </>
    );
  }
  if (state.ok === false) {
    // A used or expired link cannot be retried; the way forward is a new one.
    return (
      <div className="stack-sm">
        <FormMessage state={state} />
        <p>Verification links work once and expire after a day.</p>
        <ButtonLink href="/">Get a new verification link</ButtonLink>
      </div>
    );
  }
  return (
    <form action={action} className="form">
      <FormMessage state={state} />
      <input type="hidden" name="token" value={token ?? ''} />
      <p>Confirm that this email address belongs to you.</p>
      <SubmitButton pendingLabel="Verifying…">Verify my email</SubmitButton>
    </form>
  );
}

/** For signed-in, unverified users. After one successful send the button is replaced. */
export function ResendVerificationForm({ idempotencyKey }: { idempotencyKey: string }) {
  const [state, action] = useActionState(resendVerificationAction, initialFormState);
  if (state.ok) return <FormMessage state={state} />;
  return (
    <form action={action} className="form">
      <FormMessage state={state} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <SubmitButton variant="secondary" pendingLabel="Sending…">
        Send a new verification email
      </SubmitButton>
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

  if (token === undefined) return <Spinner label="Checking your invitation…" />;
  if (!token)
    return (
      <Notice tone="danger">
        This invitation link is incomplete. Open the link from your email again.
      </Notice>
    );
  if (!signedIn) {
    return (
      <div className="stack-sm">
        <p>
          Sign in with the email address the invitation was sent to. New to EventHub OS? Create an
          account with that address first.
        </p>
        <div className="form__actions">
          <ButtonLink href="/login?next=%2Faccept-invitation">Sign in</ButtonLink>
          <ButtonLink variant="secondary" href="/signup?next=%2Faccept-invitation">
            Create an account
          </ButtonLink>
        </div>
      </div>
    );
  }
  return (
    <form action={action} className="form">
      <FormMessage state={state} />
      <input type="hidden" name="token" value={token} />
      <SubmitButton pendingLabel="Joining…">Accept invitation</SubmitButton>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [state, action] = useActionState(requestPasswordResetAction, initialFormState);
  if (state.ok) {
    return (
      <div className="stack-sm">
        <FormMessage state={state} />
        <Link href="/login">Back to sign in</Link>
      </div>
    );
  }
  return (
    <form action={action} className="form" noValidate>
      <FormMessage state={state} />
      <p>
        Enter the email address you sign in with. We will send you a link to choose a new password.
      </p>
      <Field name="email" label="Email" type="email" state={state} autoComplete="email" required />
      <div className="form__actions">
        <SubmitButton pendingLabel="Sending…">Send reset link</SubmitButton>
        <Link href="/login">Back to sign in</Link>
      </div>
    </form>
  );
}

export function ResetPasswordForm() {
  const token = useFragmentToken();
  const [state, action] = useActionState(completePasswordResetAction, initialFormState);
  if (token === undefined) return <Spinner label="Checking your link…" />;
  if (state.ok) {
    return (
      <div className="stack-sm">
        <FormMessage state={state} />
        <ButtonLink href="/login">Sign in</ButtonLink>
      </div>
    );
  }
  if (!token || state.reason === 'invalid_or_expired_token') {
    // A broken, used or expired link cannot be retried; the way forward is a new one.
    return (
      <div className="stack-sm">
        {token ? (
          <FormMessage state={state} />
        ) : (
          <Notice tone="danger">
            This reset link is incomplete. Open the link from your email again.
          </Notice>
        )}
        <p>Reset links work once and expire after an hour.</p>
        <ButtonLink href="/forgot-password">Request a new link</ButtonLink>
      </div>
    );
  }
  return (
    <form action={action} className="form" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="token" value={token} />
      <Field
        name="password"
        label="New password"
        type="password"
        state={state}
        autoComplete="new-password"
        hint="At least 12 characters. A passphrase of several words works well."
        required
      />
      <SubmitButton pendingLabel="Saving…">Set new password</SubmitButton>
    </form>
  );
}
