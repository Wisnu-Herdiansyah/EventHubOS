'use client';

import { useActionState } from 'react';
import {
  grantSupportAccessAction,
  liftBounceAction,
  revokeSupportAccessAction,
} from '@/app/actions/support';
import { initialFormState } from '@/lib/errors';
import { FormMessage, SubmitButton } from './form';
import { Dialog, DialogCancel } from './ui/dialog';

const DURATIONS = [
  { hours: 1, label: '1 hour' },
  { hours: 8, label: '8 hours' },
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days (the maximum)' },
];

/** Turn support access on for a while (ADR-0045). */
export function GrantSupportAccessForm(props: { organizationId: string; idempotencyKey: string }) {
  const [state, action] = useActionState(grantSupportAccessAction, initialFormState);
  return (
    <form action={action} className="form" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="organizationId" value={props.organizationId} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <div className="field">
        <label className="field__label" htmlFor="support-hours">
          For how long
        </label>
        <select id="support-hours" name="hours" className="select" defaultValue="8">
          {DURATIONS.map((d) => (
            <option key={d.hours} value={d.hours}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <SubmitButton pendingLabel="Turning on…">Turn on support access</SubmitButton>
      </div>
    </form>
  );
}

/** End support access now, confirmed in a dialog. */
export function RevokeSupportAccessDialog(props: {
  organizationId: string;
  idempotencyKey: string;
}) {
  const [state, action] = useActionState(revokeSupportAccessAction, initialFormState);
  return (
    <Dialog
      trigger={{ label: 'Turn off support access', variant: 'danger-secondary', size: 'sm' }}
      title="Turn off support access?"
      description="EventHub support can no longer view your organization. Your Owners are emailed."
    >
      <form action={action} className="form">
        <FormMessage state={state} />
        <input type="hidden" name="organizationId" value={props.organizationId} />
        <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
        <div className="cluster">
          <SubmitButton variant="danger" pendingLabel="Turning off…">
            Turn off
          </SubmitButton>
          <DialogCancel />
        </div>
      </form>
    </Dialog>
  );
}

/** Staff: lift a bounce for the address being looked at. */
export function LiftBounceForm(props: { address: string; idempotencyKey: string }) {
  const [state, action] = useActionState(liftBounceAction, initialFormState);
  return (
    <form action={action} className="form">
      <FormMessage state={state} />
      <input type="hidden" name="address" value={props.address} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      {state.ok ? null : (
        <div>
          <SubmitButton variant="secondary" pendingLabel="Lifting…">
            Lift the bounce
          </SubmitButton>
        </div>
      )}
    </form>
  );
}
