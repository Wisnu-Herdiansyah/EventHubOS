'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';

export type MenuItem =
  | { kind: 'link'; href: string; label: string; icon?: IconName }
  | { kind: 'form'; action: () => void | Promise<void>; label: string; icon?: IconName }
  | { kind: 'separator' };

/**
 * Menu button (WAI-ARIA APG pattern): Enter, Space or ArrowDown opens it on the first item;
 * arrow keys, Home and End move; Escape closes and returns focus; Tab or a click outside closes.
 */
export function Menu({
  label,
  buttonLabel,
  button,
  buttonClassName,
  header,
  items,
}: {
  /** Names the menu itself. */
  label: string;
  /** Accessible name of the trigger, when its content alone is not enough. */
  buttonLabel?: string;
  button: ReactNode;
  buttonClassName?: string;
  header?: ReactNode;
  items: MenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const entries = () =>
    Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  const focusAt = (index: number) => {
    const all = entries();
    all[(index + all.length) % all.length]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    focusAt(0);
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const onTriggerKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
    }
  };
  const onMenuKey = (e: KeyboardEvent) => {
    const all = entries();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') focusAt(at + 1);
    else if (e.key === 'ArrowUp') focusAt(at - 1);
    else if (e.key === 'Home') focusAt(0);
    else if (e.key === 'End') focusAt(all.length - 1);
    else if (e.key === 'Escape') {
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
      return;
    } else return;
    e.preventDefault();
  };

  return (
    <div className="menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={buttonClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        aria-label={buttonLabel}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
      >
        {button}
      </button>
      <ul
        ref={list}
        id={`${id}-menu`}
        role="menu"
        aria-label={label}
        className="menu__popover"
        hidden={!open}
        onKeyDown={onMenuKey}
      >
        {header ? (
          <li role="none" className="menu__header">
            {header}
          </li>
        ) : null}
        {items.map((item, i) =>
          item.kind === 'separator' ? (
            <li key={`sep-${i}`} role="separator" className="menu__separator" />
          ) : item.kind === 'link' ? (
            <li key={item.href} role="none">
              <Link
                role="menuitem"
                tabIndex={-1}
                className="menu__item"
                href={item.href}
                onClick={() => setOpen(false)}
              >
                {item.icon ? <Icon name={item.icon} size={18} /> : null}
                {item.label}
              </Link>
            </li>
          ) : (
            <li key={item.label} role="none">
              <form action={item.action}>
                <button type="submit" role="menuitem" tabIndex={-1} className="menu__item">
                  {item.icon ? <Icon name={item.icon} size={18} /> : null}
                  {item.label}
                </button>
              </form>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
