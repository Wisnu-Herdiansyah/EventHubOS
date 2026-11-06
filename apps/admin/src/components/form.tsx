'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { FormState } from '@/lib/errors';

/** Submit button that disables itself while the Server Action runs (prevents double submits). */
export function SubmitButton({
  children,
  className,
  pendingLabel,
}: {
  children: ReactNode;
  className?: string;
  pendingLabel?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} aria-busy={pending}>
      {pending ? (pendingLabel ?? 'Working…') : children}
    </button>
  );
}

/** Form-level result. Errors are announced immediately; success politely. */
export function FormMessage({ state }: { state: FormState }) {
  if (!state.message) return null;
  const error = state.ok === false;
  return (
    <div className={`message ${error ? 'error' : 'success'}`} role={error ? 'alert' : 'status'}>
      {state.message}
      {state.reference ? <span className="reference">Reference: {state.reference}</span> : null}
    </div>
  );
}

interface FieldProps {
  name: string;
  /** Needed when the same field name appears in several forms on one page. */
  id?: string;
  label: string;
  state: FormState;
  hint?: string;
  type?: string;
  required?: boolean;
  defaultValue?: string | number;
  autoComplete?: string;
  placeholder?: string;
  maxLength?: number;
  min?: number;
  list?: string;
}

/** Labelled input with hint and error wired up via aria-describedby / aria-invalid. */
export function Field({
  name,
  id: idProp,
  label,
  state,
  hint,
  type = 'text',
  defaultValue,
  ...rest
}: FieldProps) {
  const id = idProp ?? `f-${name}`;
  const error = state.fields?.[name];
  const describedBy =
    [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') ||
    undefined;
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {rest.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        defaultValue={state.values?.[name] ?? defaultValue}
        {...rest}
      />
      {hint ? (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <div className="field-error" id={`${id}-error`}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

interface SelectProps {
  name: string;
  id?: string;
  label: string;
  state: FormState;
  options: Array<{ value: string; label: string }>;
  defaultValue?: string;
  hint?: string;
  required?: boolean;
}

export function Select({
  name,
  id: idProp,
  label,
  state,
  options,
  hint,
  defaultValue,
  ...rest
}: SelectProps) {
  const id = idProp ?? `f-${name}`;
  const error = state.fields?.[name];
  const describedBy =
    [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') ||
    undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        defaultValue={state.values?.[name] ?? defaultValue}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <div className="field-error" id={`${id}-error`}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
