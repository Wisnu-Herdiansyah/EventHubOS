'use client';

import { useActionState } from 'react';
import {
  changeMemberRoleAction,
  inviteMemberAction,
  remindTwoStepAction,
  removeMemberAction,
  revokeInvitationAction,
} from '@/app/actions/team';
import { initialFormState } from '@/lib/errors';
import { Field, FormMessage, Select, SubmitButton } from './form';
import { Dialog, DialogCancel } from './ui/dialog';

type Option = { value: string; label: string };

export function InviteMemberForm(props: {
  organizationId: string;
  idempotencyKey: string;
  roles: Option[];
}) {
  const [state, action] = useActionState(inviteMemberAction, initialFormState);
  const fallbackRole = props.roles.at(-1)?.value;
  return (
    <form action={action} className="form" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="organizationId" value={props.organizationId} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <Field
        name="email"
        label="Email address"
        type="email"
        state={state}
        autoComplete="off"
        maxLength={254}
        required
        hint="They receive a link valid for 7 days and join with this exact address."
      />
      <Select
        name="role"
        label="Role"
        state={state}
        options={props.roles}
        defaultValue={fallbackRole}
        hint="You can grant roles up to your own."
      />
      <SubmitButton pendingLabel="Sending…">Send invitation</SubmitButton>
    </form>
  );
}

export function MemberRoleForm(props: {
  organizationId: string;
  membershipId: string;
  email: string;
  role: string;
  roles: Option[];
  idempotencyKey: string;
}) {
  const [state, action] = useActionState(changeMemberRoleAction, initialFormState);
  return (
    <form action={action} className="form form--inline" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="organizationId" value={props.organizationId} />
      <input type="hidden" name="membershipId" value={props.membershipId} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <Select
        id={`role-${props.membershipId}`}
        name="role"
        label={`Role for ${props.email}`}
        hideLabel
        state={state}
        options={props.roles}
        defaultValue={props.role}
      />
      <SubmitButton variant="secondary" pendingLabel="Saving…">
        Change role
      </SubmitButton>
    </form>
  );
}

export function RemoveMemberForm(props: {
  organizationId: string;
  membershipId: string;
  email: string;
  isSelf: boolean;
  idempotencyKey: string;
}) {
  const [state, action] = useActionState(removeMemberAction, initialFormState);
  const label = props.isSelf ? 'Leave organization' : `Remove ${props.email}`;
  return (
    <Dialog
      trigger={{
        label: props.isSelf ? (
          <>
            Leave<span className="visually-hidden"> organization</span>…
          </>
        ) : (
          <>
            Remove<span className="visually-hidden"> {props.email}</span>…
          </>
        ),
        variant: 'danger-secondary',
        size: 'sm',
      }}
      title={props.isSelf ? 'Leave this organization?' : `Remove ${props.email}?`}
      description={
        props.isSelf
          ? 'You will lose access to this organization immediately.'
          : 'They lose access immediately. Their past actions stay in the audit log.'
      }
    >
      <form action={action} className="form">
        <FormMessage state={state} />
        <input type="hidden" name="organizationId" value={props.organizationId} />
        <input type="hidden" name="membershipId" value={props.membershipId} />
        <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
        {props.isSelf ? <input type="hidden" name="self" value="1" /> : null}
        <div className="form__actions form__actions--end">
          <DialogCancel />
          <SubmitButton variant="danger" pendingLabel="Removing…">
            {label}
          </SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

export function RevokeInvitationForm(props: {
  organizationId: string;
  invitationId: string;
  email: string;
  idempotencyKey: string;
}) {
  const [state, action] = useActionState(revokeInvitationAction, initialFormState);
  return (
    <Dialog
      trigger={{
        label: (
          <>
            Revoke<span className="visually-hidden"> invitation for {props.email}</span>…
          </>
        ),
        variant: 'danger-secondary',
        size: 'sm',
      }}
      title="Revoke this invitation?"
      description={`The invitation link sent to ${props.email} stops working immediately.`}
    >
      <form action={action} className="form">
        <FormMessage state={state} />
        <input type="hidden" name="organizationId" value={props.organizationId} />
        <input type="hidden" name="invitationId" value={props.invitationId} />
        <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
        <div className="form__actions form__actions--end">
          <DialogCancel />
          <SubmitButton variant="danger" pendingLabel="Revoking…">
            {`Revoke invitation for ${props.email}`}
          </SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * "Remind" next to a member without two-step verification (ADR-0031). Once sent (or within a day
 * of the last reminder) it shows that instead of the button.
 */
export function RemindTwoStepForm(props: {
  organizationId: string;
  membershipId: string;
  email: string;
  remindedToday: boolean;
  idempotencyKey: string;
}) {
  const [state, action] = useActionState(remindTwoStepAction, initialFormState);
  if (props.remindedToday || state.ok) {
    return (
      <span className="text-secondary field__hint" role={state.ok ? 'status' : undefined}>
        Reminded today
      </span>
    );
  }
  return (
    <form action={action} className="form form--inline" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="organizationId" value={props.organizationId} />
      <input type="hidden" name="membershipId" value={props.membershipId} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <SubmitButton variant="plain" size="sm" pendingLabel="Sending…">
        Remind
        <span className="visually-hidden"> {props.email} to turn on two-step verification</span>
      </SubmitButton>
    </form>
  );
}
