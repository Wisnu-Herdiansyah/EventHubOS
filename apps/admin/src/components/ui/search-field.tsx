import type { InputHTMLAttributes } from 'react';
import { Icon } from './icons';

/** Search input with a visually hidden label (the magnifier and placeholder are not labels). */
export function SearchField({
  label,
  size,
  ...rest
}: { label: string; size?: 'sm' } & Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'>) {
  const id = rest.id ?? `search-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <div className={size === 'sm' ? 'search-field search-field--sm' : 'search-field'} role="search">
      <label className="visually-hidden" htmlFor={id}>
        {label}
      </label>
      <span className="search-field__icon">
        <Icon name="search" size={16} />
      </span>
      <input {...rest} id={id} type="search" className="input" autoComplete="off" />
    </div>
  );
}
