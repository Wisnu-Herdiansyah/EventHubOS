'use client';

import { useActionState } from 'react';
import { changePasswordAction } from '@/app/actions/auth';
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
