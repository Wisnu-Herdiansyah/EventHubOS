import { Icon } from './icons';

/** A native date picker, styled to match (for GET forms, so not the FormState-bound Field). */
export function DateInput(props: {
  id: string;
  name: string;
  label: string;
  value?: string;
  required?: boolean;
  min?: string;
  max?: string;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={props.id}>
        {props.label}
      </label>
      <div className="date-field">
        <input
          id={props.id}
          name={props.name}
          type="date"
          className="input"
          defaultValue={props.value}
          required={props.required}
          min={props.min}
          max={props.max}
        />
        <span className="date-field__icon">
          <Icon name="calendar" size={18} />
        </span>
      </div>
    </div>
  );
}
