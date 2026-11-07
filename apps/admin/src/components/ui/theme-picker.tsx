'use client';

import { useState } from 'react';
import { THEME_COOKIE, preferenceCookie, type Theme } from '@/lib/preferences';
import { Icon, type IconName } from './icons';

const OPTIONS: Array<{ value: Theme; label: string; icon: IconName }> = [
  { value: 'system', label: 'Automatic', icon: 'monitor' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
];

/** Segmented control for the colour scheme. Applies at once and is remembered on this browser. */
export function ThemePicker({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const choose = (value: Theme) => {
    setTheme(value);
    const root = document.documentElement;
    if (value === 'system') delete root.dataset.theme;
    else root.dataset.theme = value;
    document.cookie = preferenceCookie(THEME_COOKIE, value, window.location.protocol === 'https:');
  };
  return (
    <fieldset className="segmented">
      <legend className="visually-hidden">Appearance</legend>
      {OPTIONS.map((o) => (
        <label key={o.value} className="segmented__option">
          <input
            type="radio"
            name="theme"
            value={o.value}
            checked={theme === o.value}
            onChange={() => choose(o.value)}
          />
          <span className="segmented__label">
            <Icon name={o.icon} size={16} />
            {o.label}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
