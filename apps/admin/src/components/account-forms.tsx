'use client';

import { useActionState } from 'react';
import {
  changePasswordAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
} from '@/app/actions/auth';
import { initialFormState } from '@/lib/errors';
import { Field, FormMessage, SubmitButton } from './form';

export function ChangePasswordForm() {
  const [state, action] = useActionState(changePasswordAction, initialFormState);
  return (
    <form action={action} noValidate>
      <FormMessage state={state} />
      <Field
        name="currentPassword"
        label="Current password"
        type="password"
        state={state}
        autoComplete="current-password"
        required
      />
      <Field
        name="newPassword"
        label="New password"
        type="password"
        state={state}
        autoComplete="new-password"
        hint="At least 12 characters, different from your current password. A passphrase of several words works well."
        required
      />
      <p className="muted">
        Other devices and browsers will be signed out. This one stays signed in.
      </p>
      <SubmitButton pendingLabel="Saving…">Change password</SubmitButton>
    </form>
  );
}

export function RevokeSessionForm({ sessionId, label }: { sessionId: string; label: string }) {
  const [state, action] = useActionState(revokeSessionAction, initialFormState);
  return (
    <form action={action}>
      <FormMessage state={state} />
      <input type="hidden" name="sessionId" value={sessionId} />
      <SubmitButton className="secondary" pendingLabel="Signing out…">
        Sign out<span className="visually-hidden"> {label}</span>
      </SubmitButton>
    </form>
  );
}

export function RevokeOtherSessionsForm() {
  const [state, action] = useActionState(revokeOtherSessionsAction, initialFormState);
  return (
    <form action={action}>
      <FormMessage state={state} />
      <SubmitButton className="danger" pendingLabel="Signing out…">
        Sign out all other sessions
      </SubmitButton>
    </form>
  );
}
