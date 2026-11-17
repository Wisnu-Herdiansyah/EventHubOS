'use client';

import { useActionState, useEffect, useState } from 'react';
import {
  cancelRegistrationAction,
  promoteRegistrationAction,
  decideRegistrationAction,
  bulkDecideRegistrationsAction,
} from '@/app/actions/registrations';
import { initialFormState } from '@/lib/errors';
import { BULK_DECIDE_MAX } from '@/lib/registrations';
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

/** Approves or declines a request waiting for a decision (ADR-0064). */
export function DecideRegistrationForm(props: {
  organizationId: string;
  eventId: string;
  registrationId: string;
  name: string;
  decision: 'approve' | 'decline';
  idempotencyKey: string;
  /** Seats taken and capacity, to warn when approving goes over. */
  confirmed: number;
  capacity: number | null;
}) {
  const [state, action] = useActionState(decideRegistrationAction, initialFormState);
  const approve = props.decision === 'approve';
  const over = approve && props.capacity !== null && props.confirmed >= props.capacity;
  return (
    <Dialog
      trigger={{
        label: (
          <>
            {approve ? 'Approve' : 'Decline'}
            <span className="visually-hidden"> {props.name}</span>…
          </>
        ),
        variant: approve ? 'secondary' : 'danger-secondary',
        size: 'sm',
      }}
      title={approve ? `Approve ${props.name}?` : `Decline ${props.name}?`}
      description={
        approve
          ? over
            ? `All ${props.capacity} seats are taken, so this goes over capacity. They get a confirmation email with their ticket.`
            : 'They are registered and get a confirmation email with their ticket.'
          : 'They get an email saying you can’t offer them a place, with no reason given. They can’t ask again for this event.'
      }
    >
      <form action={action} className="form">
        <FormMessage state={state} />
        <input type="hidden" name="organizationId" value={props.organizationId} />
        <input type="hidden" name="eventId" value={props.eventId} />
        <input type="hidden" name="registrationId" value={props.registrationId} />
        <input type="hidden" name="decision" value={props.decision} />
        <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
        <div className="form__actions form__actions--end">
          <DialogCancel>Not now</DialogCancel>
          <SubmitButton
            pendingLabel={approve ? 'Approving…' : 'Declining…'}
            variant={approve ? undefined : 'danger'}
          >
            {approve ? (over ? 'Approve over capacity' : 'Approve') : 'Decline request'}
          </SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

/** The row checkboxes the bulk bar reads: plain inputs rendered by the (server) table. */
const SELECTOR = 'input[data-bulk-decide]';
const boxes = () => Array.from(document.querySelectorAll<HTMLInputElement>(SELECTOR));

/**
 * Approve or decline the requests ticked in the table, in one step (ADR-0066). Each person is
 * emailed as a single decision would. Rendered above the Requests list.
 */
export function BulkDecideBar(props: {
  organizationId: string;
  eventId: string;
  idempotencyKey: string;
  confirmed: number;
  capacity: number | null;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  useEffect(() => {
    const sync = () => {
      const all = boxes();
      setTotal(all.length);
      setSelected(all.filter((b) => b.checked).map((b) => b.value));
    };
    sync();
    const onChange = (e: Event) => {
      if (e.target instanceof HTMLInputElement && e.target.matches(SELECTOR)) sync();
    };
    document.addEventListener('change', onChange);
    return () => document.removeEventListener('change', onChange);
    // A new key means the page was re-rendered after a decision: read the rows again.
  }, [props.idempotencyKey]);
  const setAll = (checked: boolean) => {
    for (const b of boxes()) b.checked = checked;
    setSelected(checked ? boxes().map((b) => b.value) : []);
  };
  const n = selected.length;
  const tooMany = n > BULK_DECIDE_MAX;
  const label = n === 1 ? '1 request' : `${n} requests`;
  const over =
    props.capacity !== null && props.confirmed + n > props.capacity
      ? props.confirmed >= props.capacity
        ? `All ${props.capacity} seats are taken, so every approval goes over capacity.`
        : `Only ${props.capacity - props.confirmed} of ${props.capacity} seats are free, so this goes over capacity.`
      : null;
  return (
    <div className="bulk-bar cluster" role="group" aria-label="Decide several requests">
      <label className="checkbox">
        <input
          type="checkbox"
          checked={total > 0 && n === total}
          ref={(el) => {
            if (el) el.indeterminate = n > 0 && n < total;
          }}
          onChange={(e) => setAll(e.target.checked)}
          disabled={total === 0}
        />
        <span>Select all</span>
      </label>
      <span className="text-secondary" aria-live="polite">
        {n === 0 ? 'None selected' : `${label} selected`}
      </span>
      {tooMany ? (
        <span className="text-secondary">{`Select up to ${BULK_DECIDE_MAX} at a time.`}</span>
      ) : null}
      <span className="cluster row-actions bulk-bar__actions">
        {(['approve', 'decline'] as const).map((decision) => (
          <BulkDecideDialog
            key={decision}
            {...props}
            decision={decision}
            selected={selected}
            label={label}
            disabled={n === 0 || tooMany}
            over={decision === 'approve' ? over : null}
          />
        ))}
      </span>
    </div>
  );
}

function BulkDecideDialog(props: {
  organizationId: string;
  eventId: string;
  idempotencyKey: string;
  decision: 'approve' | 'decline';
  selected: string[];
  label: string;
  disabled: boolean;
  over: string | null;
}) {
  const [state, action] = useActionState(bulkDecideRegistrationsAction, initialFormState);
  const approve = props.decision === 'approve';
  return (
    <Dialog
      trigger={{
        label: approve ? 'Approve selected…' : 'Decline selected…',
        variant: approve ? 'secondary' : 'danger-secondary',
        size: 'sm',
        disabled: props.disabled,
      }}
      title={approve ? `Approve ${props.label}?` : `Decline ${props.label}?`}
      description={
        approve
          ? `${props.over ? `${props.over} ` : ''}Each person is registered and gets a confirmation email with their ticket.`
          : 'Each person gets an email saying you can’t offer them a place, with no reason given. They can’t ask again for this event.'
      }
    >
      <form action={action} className="form">
        <FormMessage state={state} />
        <input type="hidden" name="organizationId" value={props.organizationId} />
        <input type="hidden" name="eventId" value={props.eventId} />
        <input type="hidden" name="decision" value={props.decision} />
        <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
        {props.selected.map((id) => (
          <input key={id} type="hidden" name="registrationIds" value={id} />
        ))}
        <div className="form__actions form__actions--end">
          <DialogCancel>Not now</DialogCancel>
          <SubmitButton
            pendingLabel={approve ? 'Approving…' : 'Declining…'}
            variant={approve ? undefined : 'danger'}
          >
            {approve
              ? props.over
                ? `Approve ${props.label} over capacity`
                : `Approve ${props.label}`
              : `Decline ${props.label}`}
          </SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}
