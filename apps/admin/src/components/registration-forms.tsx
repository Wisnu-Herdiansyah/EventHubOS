'use client';

import { useActionState } from 'react';
import { cancelRegistrationAction, promoteRegistrationAction } from '@/app/actions/registrations';
import { initialFormState } from '@/lib/errors';
import { FormMessage, SubmitButton } from './form';
import { Dialog, DialogCancel } from './ui/dialog';

export function CancelRegistrationForm(props: {
  organizationId: string;
  eventId: string;
  registrationId: string;
  name: string;
  idempotencyKey: string;
  /** Someone on the waitlist: "remove" rather than "cancel" (ADR-0035). */
  waitlisted?: boolean;
}) {
  const [state, action] = useActionState(cancelRegistrationAction, initialFormState);
  const w = props.waitlisted === true;
  return (
    <Dialog
      trigger={{
        label: w ? (
          <>
            Remove<span className="visually-hidden"> {props.name} from the waitlist</span>…
          </>
        ) : (
          <>
            Cancel<span className="visually-hidden"> the registration of {props.name}</span>…
          </>
        ),
        variant: 'danger-secondary',
        size: 'sm',
      }}
      title={w ? `Remove ${props.name} from the waitlist?` : `Cancel ${props.name}’s registration?`}
      description={
        w
          ? 'They lose their place in line and get an email saying the organizer removed them.'
          : 'They lose their place and get an email saying the organizer cancelled it. If people are waiting, the next one gets the seat.'
      }
    >
      <form action={action} className="form">
        <FormMessage state={state} />
        <input type="hidden" name="organizationId" value={props.organizationId} />
        <input type="hidden" name="eventId" value={props.eventId} />
        <input type="hidden" name="registrationId" value={props.registrationId} />
        <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
        {w ? <input type="hidden" name="waitlisted" value="yes" /> : null}
        <div className="form__actions form__actions--end">
          <DialogCancel>{w ? 'Keep them waiting' : 'Keep registration'}</DialogCancel>
          <SubmitButton variant="danger" pendingLabel={w ? 'Removing…' : 'Cancelling…'}>
            {w ? 'Remove from waitlist' : 'Cancel registration'}
          </SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

/** Gives someone on the waitlist a seat now (ADR-0035). */
export function PromoteRegistrationForm(props: {
  organizationId: string;
  eventId: string;
  registrationId: string;
  name: string;
  idempotencyKey: string;
  /** Seats taken and capacity, to warn when this goes over. */
  confirmed: number;
  capacity: number | null;
}) {
  const [state, action] = useActionState(promoteRegistrationAction, initialFormState);
  const over = props.capacity !== null && props.confirmed >= props.capacity;
  return (
    <Dialog
      trigger={{
        label: (
          <>
            Give a seat<span className="visually-hidden"> to {props.name}</span>…
          </>
        ),
        variant: 'secondary',
        size: 'sm',
      }}
      title={`Give ${props.name} a seat?`}
      description={
        over
          ? `All ${props.capacity} seats are taken, so this goes over capacity. They get a confirmation email with their ticket.`
          : 'They skip ahead of anyone waiting longer and get a confirmation email with their ticket.'
      }
    >
      <form action={action} className="form">
        <FormMessage state={state} />
        <input type="hidden" name="organizationId" value={props.organizationId} />
        <input type="hidden" name="eventId" value={props.eventId} />
        <input type="hidden" name="registrationId" value={props.registrationId} />
        <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
        <div className="form__actions form__actions--end">
          <DialogCancel>Not now</DialogCancel>
          <SubmitButton pendingLabel="Giving a seat…">
            {over ? 'Give a seat over capacity' : 'Give a seat'}
          </SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}
