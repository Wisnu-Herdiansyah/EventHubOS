'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { FormState } from '@/lib/errors';
import { buttonClass, type ButtonVariant } from './ui/button';
import { Icon } from './ui/icons';
import { Notice } from './ui/notice';

/** Submit button that disables itself while the Server Action runs (prevents double submits). */
export function SubmitButton({
  children,
  variant,
  size,
  block,
  pendingLabel,
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: 'sm';
  block?: boolean;
  pendingLabel?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={buttonClass({ variant, size, block })}
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
      {pending ? (pendingLabel ?? 'Working…') : children}
    </button>
  );
}

/** Form-level result. Errors are announced immediately; success politely. */
export function FormMessage({ state }: { state: FormState }) {
  if (!state.message) return null;
  return (
    <Notice tone={state.ok === false ? 'danger' : 'success'} reference={state.reference}>
      {state.message}
    </Notice>
  );
}

interface FieldBase {
  name: string;
  /** Needed when the same field name appears in several forms on one page. */
  id?: string;
  label: string;
  state: FormState;
  hint?: string;
  required?: boolean;
  /** Keep the label for assistive tech only, where a table header already shows it. */
  hideLabel?: boolean;
}

function useFieldIds({ name, id: idProp, state, hint }: FieldBase) {
  const id = idProp ?? `f-${name}`;
  const error = state.fields?.[name];
  const describedBy =
    [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') ||
    undefined;
  return { id, error, describedBy };
}

function FieldFrame({
  id,
  label,
  hideLabel,
  required,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hideLabel?: boolean;
  required?: boolean;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className={hideLabel ? 'visually-hidden' : 'field__label'} htmlFor={id}>
        {label}
        {required ? (
          <span className="field__required" aria-hidden="true">
            {' '}
            *
          </span>
        ) : null}
      </label>
      {children}
      {hint ? (
        <span className="field__hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <div className="field__error" id={`${id}-error`}>
          <Icon name="error" size={16} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

interface FieldProps extends FieldBase {
  type?: string;
  defaultValue?: string | number;
  autoComplete?: string;
  placeholder?: string;
  maxLength?: number;
  min?: number;
  list?: string;
}

/** Labelled input with hint and error wired up via aria-describedby / aria-invalid. */
export function Field(props: FieldProps) {
  const { name, label, state, hint, type = 'text', defaultValue, required } = props;
  const { id, error, describedBy } = useFieldIds(props);
  const isDate = type === 'date' || type === 'datetime-local';
  const input = (
    <input
      id={id}
      name={name}
      type={type}
      className="input"
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy}
      defaultValue={state.values?.[name] ?? defaultValue}
      required={required}
      autoComplete={props.autoComplete}
      placeholder={props.placeholder}
      maxLength={props.maxLength}
      min={props.min}
      list={props.list}
    />
  );
  return (
    <FieldFrame
      id={id}
      label={label}
      hideLabel={props.hideLabel}
      required={required}
      hint={hint}
      error={error}
    >
      {isDate ? (
        <div className="date-field">
          {input}
          <span className="date-field__icon">
            <Icon name="calendar" size={18} />
          </span>
        </div>
      ) : (
        input
      )}
    </FieldFrame>
  );
}

interface SelectProps extends FieldBase {
  options: Array<{ value: string; label: string }>;
  defaultValue?: string;
}

export function Select(props: SelectProps) {
  const { name, label, state, options, hint, defaultValue, required } = props;
  const { id, error, describedBy } = useFieldIds(props);
  return (
    <FieldFrame id={id} label={label} hideLabel={props.hideLabel} hint={hint} error={error}>
      <select
        // React ignores later defaultValue changes on <select>, and resets forms to the first
        // one after an action; keying by the value remounts it with the saved choice.
        key={state.values?.[name] ?? defaultValue}
        id={id}
        name={name}
        className="select"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        defaultValue={state.values?.[name] ?? defaultValue}
        required={required}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldFrame>
  );
}
