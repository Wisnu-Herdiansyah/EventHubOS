'use client';

import { useActionState } from 'react';
import { sendAnnouncementAction } from '@/app/actions/announcements';
import { initialFormState } from '@/lib/errors';
import { Field, FormMessage, TextArea } from './form';
import { buttonClass } from './ui/button';
import { Dialog, DialogCancel } from './ui/dialog';

const FORM_ID = 'announcement-form';

/**
 * Write and send an announcement (ADR-0037). Sending is confirmed in a dialog, because an email
 * cannot be taken back; the dialog's button submits the form on the page.
 */
export function AnnouncementForm(props: {
  organizationId: string;
  eventId: string;
  eventName: string;
  idempotencyKey: string;
  registered: number;
  waitlisted: number;
}) {
  const [state, action] = useActionState(sendAnnouncementAction, initialFormState);
  const chosen = state.values?.audience ?? 'registered';
  const people = (n: number) => (n === 1 ? '1 person' : `${n.toLocaleString('en')} people`);
  return (
    <form id={FORM_ID} action={action} className="form" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="organizationId" value={props.organizationId} />
      <input type="hidden" name="eventId" value={props.eventId} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <fieldset className="fieldset">
        <legend className="fieldset__legend">Send to</legend>
        <label className="checkbox">
          <input
            type="radio"
            name="audience"
            value="registered"
            defaultChecked={chosen !== 'registered_and_waitlist'}
          />
          <span>Everyone registered ({people(props.registered)})</span>
        </label>
        {props.waitlisted > 0 ? (
          <label className="checkbox">
            <input
              type="radio"
              name="audience"
              value="registered_and_waitlist"
              defaultChecked={chosen === 'registered_and_waitlist'}
            />
            <span>
              Everyone registered and on the waitlist ({people(props.registered + props.waitlisted)}
              )
            </span>
          </label>
        ) : null}
      </fieldset>
      <Field
        name="subject"
        label="Subject"
        state={state}
        maxLength={150}
        required
        hint={`Shown after the event name: “${props.eventName}: …”`}
      />
      <TextArea
        name="body"
        label="Message"
        state={state}
        maxLength={5000}
        required
        hint="Plain text. Each email starts with “Hello” and the person’s name, and ends with who sent it and a link to the event page."
      />
      <div className="form__actions">
        <Dialog
          trigger={{ label: 'Send…', icon: 'mail' }}
          title="Send this announcement now?"
          description="Everyone in the group you chose is emailed straight away. An email can’t be taken back."
        >
          <div className="form__actions form__actions--end">
            <DialogCancel>Keep editing</DialogCancel>
            <button
              type="submit"
              form={FORM_ID}
              className={buttonClass({})}
              onClick={(e) => e.currentTarget.closest('dialog')?.close()}
            >
              Send now
            </button>
          </div>
        </Dialog>
      </div>
    </form>
  );
}
