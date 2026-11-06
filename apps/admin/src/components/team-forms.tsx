'use client';

import { useActionState, type ReactNode } from 'react';
import {
  changeMemberRoleAction,
  inviteMemberAction,
  removeMemberAction,
  revokeInvitationAction,
} from '@/app/actions/team';
import { initialFormState } from '@/lib/errors';
import { Field, FormMessage, Select, SubmitButton } from './form';

type Option = { value: string; label: string };

export function InviteMemberForm(props: {
  organizationId: string;
  idempotencyKey: string;
  roles: Option[];
}) {
  const [state, action] = useActionState(inviteMemberAction, initialFormState);
  const fallbackRole = props.roles.at(-1)?.value;
  return (
    <form action={action} noValidate>
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
    <form action={action} className="inline-form" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="organizationId" value={props.organizationId} />
      <input type="hidden" name="membershipId" value={props.membershipId} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <Select
        id={`role-${props.membershipId}`}
        name="role"
        label={`Role for ${props.email}`}
        state={state}
        options={props.roles}
        defaultValue={props.role}
      />
      <SubmitButton className="secondary" pendingLabel="Saving…">
        Change role
      </SubmitButton>
    </form>
  );
}

/** Destructive actions sit behind a disclosure so a single click cannot trigger them. */
function ConfirmDisclosure(props: { summary: string; children: ReactNode }) {
  return (
    <details className="confirm">
      <summary>{props.summary}</summary>
      <div className="confirm-body">{props.children}</div>
    </details>
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
    <ConfirmDisclosure summary={props.isSelf ? 'Leave…' : 'Remove…'}>
      <form action={action}>
        <FormMessage state={state} />
        <input type="hidden" name="organizationId" value={props.organizationId} />
        <input type="hidden" name="membershipId" value={props.membershipId} />
        <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
        {props.isSelf ? <input type="hidden" name="self" value="1" /> : null}
        <p>
          {props.isSelf
            ? 'You will lose access to this organization immediately.'
            : `${props.email} will lose access immediately. Their past actions stay in the audit log.`}
        </p>
        <SubmitButton className="danger" pendingLabel="Removing…">
          {label}
        </SubmitButton>
      </form>
    </ConfirmDisclosure>
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
    <ConfirmDisclosure summary="Revoke…">
      <form action={action}>
        <FormMessage state={state} />
        <input type="hidden" name="organizationId" value={props.organizationId} />
        <input type="hidden" name="invitationId" value={props.invitationId} />
        <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
        <p>The invitation link sent to {props.email} stops working immediately.</p>
        <SubmitButton className="danger" pendingLabel="Revoking…">
          {`Revoke invitation for ${props.email}`}
        </SubmitButton>
      </form>
    </ConfirmDisclosure>
  );
}
