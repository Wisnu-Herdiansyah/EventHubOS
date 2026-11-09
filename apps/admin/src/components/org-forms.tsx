'use client';

import { useActionState } from 'react';
import {
  createEventAction,
  transitionEventAction,
  updateEventSettingsAction,
} from '@/app/actions/events';
import {
  createOrganizationAction,
  updateBillingContactAction,
  updateOrganizationProfileAction,
  updatePublicHandleAction,
  updateTwoStepRequirementAction,
} from '@/app/actions/orgs';
import { initialFormState } from '@/lib/errors';
import { VENUE_MODES, VISIBILITY } from '@/lib/options';
import { Field, FormMessage, Select, SubmitButton } from './form';
import { Icon } from './ui/icons';

export function CreateOrganizationForm({
  idempotencyKey,
  timeZones,
  locales,
}: {
  idempotencyKey: string;
  timeZones: string[];
  locales: string[];
}) {
  const [state, action] = useActionState(createOrganizationAction, initialFormState);
  return (
    <form action={action} className="form" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <Field name="displayName" label="Organization name" state={state} maxLength={200} required />
      <div className="form__row">
        <Field
          name="locale"
          label="Language"
          state={state}
          defaultValue="en"
          list="locales"
          required
          hint="A language tag such as en or id-ID."
        />
        <Select
          name="timezone"
          label="Time zone"
          state={state}
          options={timeZones.map((z) => ({ value: z, label: z }))}
          defaultValue="UTC"
        />
      </div>
      <datalist id="locales">
        {locales.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
      <SubmitButton pendingLabel="Creating…">Create organization</SubmitButton>
    </form>
  );
}

export function CreateEventForm({
  organizationId,
  idempotencyKey,
  timeZones,
  defaultTimeZone,
}: {
  organizationId: string;
  idempotencyKey: string;
  timeZones: string[];
  defaultTimeZone: string;
}) {
  const [state, action] = useActionState(createEventAction, initialFormState);
  return (
    <form action={action} className="form" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="organizationId" value={organizationId} />
      <Field name="name" label="Event name" state={state} maxLength={200} required />
      <Field
        name="slug"
        label="URL slug"
        state={state}
        maxLength={64}
        required
        hint="Lowercase letters, digits and hyphens, e.g. jakarta-summit-2027."
      />
      <div className="form__row">
        <Select
          name="timezone"
          label="Event time zone"
          state={state}
          options={timeZones.map((z) => ({ value: z, label: z }))}
          defaultValue={defaultTimeZone}
        />
        <Select
          name="venueMode"
          label="Format"
          state={state}
          options={VENUE_MODES}
          defaultValue="in_person"
        />
      </div>
      <div className="form__row">
        <Field
          name="startsAt"
          label="Starts"
          type="datetime-local"
          state={state}
          required
          hint="In the event time zone."
        />
        <Field
          name="endsAt"
          label="Ends"
          type="datetime-local"
          state={state}
          required
          hint="In the event time zone."
        />
      </div>
      <Field
        name="primaryLanguage"
        label="Primary language"
        state={state}
        defaultValue="en"
        required
      />
      <SubmitButton pendingLabel="Creating…">Create event</SubmitButton>
    </form>
  );
}

export interface SettingsDefaults {
  visibility: string;
  title: string;
  description: string;
  privacyPolicyUrl: string;
  termsUrl: string;
  email: string;
  contactUrl: string;
  opensAt: string;
  closesAt: string;
  capacity: string;
}

export function EventSettingsForm(props: {
  organizationId: string;
  eventId: string;
  version: number;
  timeZone: string;
  idempotencyKey: string;
  defaults: SettingsDefaults;
}) {
  const [state, action] = useActionState(updateEventSettingsAction, initialFormState);
  const d = props.defaults;
  return (
    <form action={action} className="form" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="organizationId" value={props.organizationId} />
      <input type="hidden" name="eventId" value={props.eventId} />
      <input type="hidden" name="expectedVersion" value={props.version} />
      <input type="hidden" name="timezone" value={props.timeZone} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <Select
        name="visibility"
        label="Visibility"
        state={state}
        options={VISIBILITY}
        defaultValue={d.visibility}
      />
      <fieldset className="fieldset">
        <legend className="fieldset__legend">Sharing</legend>
        <Field
          name="title"
          label="Sharing title"
          state={state}
          defaultValue={d.title}
          maxLength={70}
          hint="Up to 70 characters, shown in search results and link previews."
        />
        <Field
          name="description"
          label="Sharing description"
          state={state}
          defaultValue={d.description}
          maxLength={200}
          hint="Up to 200 characters."
        />
      </fieldset>
      <fieldset className="fieldset">
        <legend className="fieldset__legend">Legal</legend>
        <Field
          name="privacyPolicyUrl"
          label="Privacy policy URL"
          type="url"
          state={state}
          defaultValue={d.privacyPolicyUrl}
          placeholder="https://"
          hint="Required before scheduling. Must start with https://."
        />
        <Field
          name="termsUrl"
          label="Terms URL"
          type="url"
          state={state}
          defaultValue={d.termsUrl}
          placeholder="https://"
        />
      </fieldset>
      <fieldset className="fieldset">
        <legend className="fieldset__legend">Contact</legend>
        <div className="form__row">
          <Field
            name="email"
            label="Contact email"
            type="email"
            state={state}
            defaultValue={d.email}
          />
          <Field
            name="contactUrl"
            label="Contact page URL"
            type="url"
            state={state}
            defaultValue={d.contactUrl}
            placeholder="https://"
          />
        </div>
      </fieldset>
      <fieldset className="fieldset">
        <legend className="fieldset__legend">Registration</legend>
        <div className="form__row">
          <Field
            name="opensAt"
            label="Opens"
            type="datetime-local"
            state={state}
            defaultValue={d.opensAt}
            hint={`In ${props.timeZone}.`}
          />
          <Field
            name="closesAt"
            label="Closes"
            type="datetime-local"
            state={state}
            defaultValue={d.closesAt}
            hint={`In ${props.timeZone}.`}
          />
          <Field
            name="capacity"
            label="Capacity"
            type="number"
            min={1}
            state={state}
            defaultValue={d.capacity}
          />
        </div>
      </fieldset>
      <div className="form__actions">
        <SubmitButton pendingLabel="Saving…">Save settings</SubmitButton>
      </div>
    </form>
  );
}

export interface TransitionProps {
  organizationId: string;
  eventId: string;
  version: number;
  to: string;
  label: string;
  idempotencyKey: string;
  /** Incomplete recommended items that must be acknowledged (scheduling only). */
  warnings?: Array<{ id: string; message: string }>;
  tone?: 'primary' | 'secondary' | 'danger';
  /** What the transition does, shown beside the button. */
  description?: string;
}

export function TransitionForm(props: TransitionProps) {
  const [state, action] = useActionState(transitionEventAction, initialFormState);
  return (
    <form action={action} className="form">
      <FormMessage state={state} />
      <input type="hidden" name="organizationId" value={props.organizationId} />
      <input type="hidden" name="eventId" value={props.eventId} />
      <input type="hidden" name="expectedVersion" value={props.version} />
      <input type="hidden" name="to" value={props.to} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      {props.warnings && props.warnings.length > 0 ? (
        <fieldset className="fieldset">
          <legend className="fieldset__legend">Recommended items you are skipping</legend>
          {props.warnings.map((w) => (
            <label key={w.id} className="checkbox">
              <input type="checkbox" name="acknowledgedWarnings" value={w.id} required />
              <span>{w.message}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="form__actions">
        <SubmitButton
          variant={props.tone === 'danger' ? 'danger-secondary' : props.tone}
          pendingLabel="Updating…"
        >
          {props.label}
        </SubmitButton>
        {props.description ? <span className="field__hint">{props.description}</span> : null}
      </div>
    </form>
  );
}

export function OrganizationProfileForm(props: {
  organizationId: string;
  version: number;
  idempotencyKey: string;
  timeZones: string[];
  locales: string[];
  defaults: { displayName: string; legalName: string; locale: string; timezone: string };
}) {
  const [state, action] = useActionState(updateOrganizationProfileAction, initialFormState);
  const d = props.defaults;
  return (
    <form action={action} className="form" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="organizationId" value={props.organizationId} />
      <input type="hidden" name="expectedVersion" value={props.version} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <Field
        name="displayName"
        label="Organization name"
        state={state}
        defaultValue={d.displayName}
        maxLength={200}
        required
      />
      <Field
        name="legalName"
        label="Legal name"
        state={state}
        defaultValue={d.legalName}
        maxLength={300}
        hint="The registered company name, if different. Leave empty to remove."
      />
      <div className="form__row">
        <Field
          name="locale"
          label="Language"
          state={state}
          defaultValue={d.locale}
          list="settings-locales"
          required
          hint="A language tag such as en or id-ID."
        />
        <Select
          name="timezone"
          label="Time zone"
          state={state}
          options={props.timeZones.map((z) => ({ value: z, label: z }))}
          defaultValue={d.timezone}
          hint="Default for new events. Existing events keep their own time zone."
        />
      </div>
      <datalist id="settings-locales">
        {props.locales.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
      <SubmitButton pendingLabel="Saving…">Save profile</SubmitButton>
    </form>
  );
}

export function BillingContactForm(props: {
  organizationId: string;
  version: number;
  idempotencyKey: string;
  defaults: { name: string; email: string };
}) {
  const [state, action] = useActionState(updateBillingContactAction, initialFormState);
  return (
    <form action={action} className="form" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="organizationId" value={props.organizationId} />
      <input type="hidden" name="expectedVersion" value={props.version} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <Field
        name="billingName"
        label="Billing contact name"
        state={state}
        defaultValue={props.defaults.name}
        maxLength={200}
        autoComplete="off"
      />
      <Field
        name="billingEmail"
        label="Billing contact email"
        type="email"
        state={state}
        defaultValue={props.defaults.email}
        maxLength={254}
        autoComplete="off"
        hint="Receives invoices and payment notices. Clear both fields to remove the contact."
      />
      <SubmitButton pendingLabel="Saving…">Save billing contact</SubmitButton>
    </form>
  );
}

export function PublicHandleForm(props: {
  organizationId: string;
  version: number;
  idempotencyKey: string;
  handle: string;
  example: string;
}) {
  const [state, action] = useActionState(updatePublicHandleAction, initialFormState);
  return (
    <form action={action} className="form" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="organizationId" value={props.organizationId} />
      <input type="hidden" name="expectedVersion" value={props.version} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <Field
        name="publicHandle"
        label="Public handle"
        state={state}
        defaultValue={props.handle}
        maxLength={40}
        autoComplete="off"
        hint={`3–40 lowercase letters, digits and hyphens. Event pages live at ${props.example}. Changing it breaks links already shared.`}
      />
      <div className="form__actions">
        <SubmitButton pendingLabel="Saving…">Save public address</SubmitButton>
      </div>
    </form>
  );
}

/** ADR-0024: require two-step verification for Owners and Admins. */
export function TwoStepRequirementForm(props: {
  organizationId: string;
  version: number;
  idempotencyKey: string;
  required: boolean;
}) {
  const [state, action] = useActionState(updateTwoStepRequirementAction, initialFormState);
  const error = state.fields?.requireMfaForAdmins;
  const hintId = 'require-mfa-hint';
  const errorId = 'require-mfa-error';
  return (
    <form action={action} className="form" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="organizationId" value={props.organizationId} />
      <input type="hidden" name="expectedVersion" value={props.version} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <div className="field">
        <label className="checkbox">
          <input
            type="checkbox"
            name="requireMfaForAdmins"
            defaultChecked={props.required}
            aria-describedby={error ? `${errorId} ${hintId}` : hintId}
            aria-invalid={error ? true : undefined}
          />
          <span>Require two-step verification for Owners and Admins</span>
        </label>
        <span className="field__hint" id={hintId}>
          Owners and Admins without it can’t open this organization’s events, team or settings until
          they set it up. Other roles are not affected.
        </span>
        {error ? (
          <div className="field__error" id={errorId}>
            <Icon name="error" size={16} />
            <span>{error}</span>
          </div>
        ) : null}
      </div>
      <div className="form__actions">
        <SubmitButton pendingLabel="Saving…">Save security settings</SubmitButton>
      </div>
    </form>
  );
}
