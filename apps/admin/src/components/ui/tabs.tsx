'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem {
  /** Stable id, also used in the URL fragment (#settings) so links and reloads keep the tab. */
  id: string;
  label: string;
  panel: ReactNode;
}

/**
 * Tabs (WAI-ARIA APG, automatic activation): arrow keys move between tabs, Home and End jump,
 * Tab moves into the panel. Inactive panels stay in the document but are hidden.
 */
export function Tabs({ label, tabs }: { label: string; tabs: TabItem[] }) {
  const [active, setActive] = useState(tabs[0]?.id);
  const base = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    if (tabs.some((t) => t.id === fromHash)) setActive(fromHash);
  }, [tabs]);

  const select = (id: string, focus = false) => {
    setActive(id);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#${id}`,
    );
    if (focus) refs.current.get(id)?.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    const at = tabs.findIndex((t) => t.id === active);
    const to =
      e.key === 'ArrowRight'
        ? (at + 1) % tabs.length
        : e.key === 'ArrowLeft'
          ? (at - 1 + tabs.length) % tabs.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? tabs.length - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    select(tabs[to]!.id, true);
  };

  return (
    <div className="tabs">
      <div role="tablist" aria-label={label} className="tabs__list" onKeyDown={onKey}>
        {tabs.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              if (el) refs.current.set(t.id, el);
            }}
            type="button"
            role="tab"
            id={`${base}-${t.id}-tab`}
            aria-controls={`${base}-${t.id}-panel`}
            aria-selected={t.id === active}
            tabIndex={t.id === active ? 0 : -1}
            className="tabs__tab"
            onClick={() => select(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-${t.id}-panel`}
          aria-labelledby={`${base}-${t.id}-tab`}
          className="tabs__panel"
          hidden={t.id !== active}
          tabIndex={0}
        >
          {t.panel}
        </div>
      ))}
    </div>
  );
}
