'use client';

import { useActionState } from 'react';
import { cancelRegistrationAction } from '@/app/actions/registrations';
import { initialFormState } from '@/lib/errors';
import { FormMessage, SubmitButton } from './form';
import { Dialog, DialogCancel } from './ui/dialog';

export function CancelRegistrationForm(props: {
  organizationId: string;
  eventId: string;
  registrationId: string;
  name: string;
  idempotencyKey: string;
}) {
  const [state, action] = useActionState(cancelRegistrationAction, initialFormState);
  return (
    <Dialog
      trigger={{
        label: (
          <>
            Cancel<span className="visually-hidden"> the registration of {props.name}</span>…
          </>
        ),
        variant: 'danger-secondary',
        size: 'sm',
      }}
      title={`Cancel ${props.name}’s registration?`}
      description="They lose their place and get an email saying the organizer cancelled it."
    >
      <form action={action} className="form">
        <FormMessage state={state} />
        <input type="hidden" name="organizationId" value={props.organizationId} />
        <input type="hidden" name="eventId" value={props.eventId} />
        <input type="hidden" name="registrationId" value={props.registrationId} />
        <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
        <div className="form__actions form__actions--end">
          <DialogCancel>Keep registration</DialogCancel>
          <SubmitButton variant="danger" pendingLabel="Cancelling…">
            Cancel registration
          </SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}
