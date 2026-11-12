'use client';

import { useActionState } from 'react';
import { cancelEventAction } from '@/app/actions/events';
import { initialFormState } from '@/lib/errors';
import { FormMessage, SubmitButton, TextArea } from './form';
import { Dialog, DialogCancel } from './ui/dialog';

/**
 * Cancel an event (ADR-0050), confirmed in a dialog because it is final: registration closes,
 * the public page and calendar file say so, and attendees can be emailed the reason.
 */
export function CancelEventDialog(props: {
  organizationId: string;
  eventId: string;
  version: number;
  idempotencyKey: string;
  /** People registered or on the waitlist. */
  people: number;
  canEmail: boolean;
}) {
  const [state, action] = useActionState(cancelEventAction, initialFormState);
  const people = props.people === 1 ? '1 person' : `${props.people.toLocaleString('en')} people`;
  return (
    <Dialog
      trigger={{ label: 'Cancel event', variant: 'danger-secondary', size: 'sm' }}
      title="Cancel this event?"
      description="This is final. Registration closes for good, and the public page and calendar file say the event is cancelled."
    >
      <form action={action} className="form" noValidate>
        <FormMessage state={state} />
        <input type="hidden" name="organizationId" value={props.organizationId} />
        <input type="hidden" name="eventId" value={props.eventId} />
        <input type="hidden" name="expectedVersion" value={props.version} />
        <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
        <TextArea
          name="reason"
          label="Reason"
          hint="Shown on the public page and in the email. Up to 2,000 characters."
          state={state}
          required
          maxLength={2000}
          rows={4}
        />
        {props.canEmail && props.people > 0 ? (
          <label className="checkbox">
            <input type="checkbox" name="notifyAttendees" defaultChecked />
            <span>Email the {people} registered or on the waitlist</span>
          </label>
        ) : null}
        <div className="cluster">
          <SubmitButton variant="danger" pendingLabel="Cancelling…">
            Cancel event
          </SubmitButton>
          <DialogCancel>Keep event</DialogCancel>
        </div>
      </form>
    </Dialog>
  );
}
