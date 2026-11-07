'use client';

import { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import type { IconName } from '../ui/icons';
import { Tooltip } from '../ui/tooltip';
import { commit, initHistory, move, redo, undo, type History } from './builder-history';
import { SECTION_LABELS, SitePreview, type SectionInstance } from './microsite';

type Viewport = 'desktop' | 'tablet' | 'mobile';

const VIEWPORTS: Array<{ value: Viewport; label: string; icon: IconName }> = [
  { value: 'desktop', label: 'Desktop', icon: 'desktop' },
  { value: 'tablet', label: 'Tablet', icon: 'tablet' },
  { value: 'mobile', label: 'Phone', icon: 'phone' },
];

function ToolButton({
  label,
  icon,
  onClick,
  disabled,
  pressed,
}: {
  label: string;
  icon: IconName;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <Tooltip label={label} placement="top">
      <Button
        variant="plain"
        size="sm"
        icon={icon}
        iconOnly
        onClick={onClick}
        disabled={disabled}
        aria-pressed={pressed}
      >
        {label}
      </Button>
    </Tooltip>
  );
}

/**
 * Builder interaction pattern, with sample content held in this browser tab only: select,
 * reorder, show or hide, duplicate and edit sections; switch the preview size; undo and redo
 * (also Ctrl/⌘+Z and Shift+Ctrl/⌘+Z). Saving and publishing need the page and revision API,
 * so those buttons are present but disabled.
 */
export function BuilderPattern({ initial, brand }: { initial: SectionInstance[]; brand?: string }) {
  const [history, setHistory] = useState<History<SectionInstance[]>>(() => initHistory(initial));
  const [selectedId, setSelectedId] = useState(initial[0]?.id);
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [announcement, setAnnouncement] = useState('');
  const sections = history.present;
  const selected = sections.find((s) => s.id === selectedId);

  const apply = (next: SectionInstance[], message: string) => {
    setHistory((h) => commit(h, next));
    setAnnouncement(message);
  };
  const doUndo = () => {
    setHistory(undo);
    setAnnouncement('Undone');
  };
  const doRedo = () => {
    setHistory(redo);
    setAnnouncement('Redone');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const update = (id: string, patch: Partial<SectionInstance>, message: string) =>
    apply(
      sections.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      message,
    );

  return (
    <div className="builder">
      <div className="builder__toolbar" role="toolbar" aria-label="Builder">
        <div className="builder__toolbar-group">
          <ToolButton
            label="Undo"
            icon="undo"
            onClick={doUndo}
            disabled={history.past.length === 0}
          />
          <ToolButton
            label="Redo"
            icon="redo"
            onClick={doRedo}
            disabled={history.future.length === 0}
          />
        </div>
        <div className="builder__toolbar-group" role="group" aria-label="Preview size">
          {VIEWPORTS.map((v) => (
            <ToolButton
              key={v.value}
              label={`${v.label} preview`}
              icon={v.icon}
              pressed={viewport === v.value}
              onClick={() => setViewport(v.value)}
            />
          ))}
        </div>
        <span className="topbar__spacer" />
        <span className="builder__status">Sample content · changes stay in this tab</span>
        <Button variant="secondary" size="sm" disabled aria-describedby="builder-save-note">
          Save draft
        </Button>
        <Button size="sm" disabled aria-describedby="builder-save-note">
          Publish
        </Button>
        <span id="builder-save-note" className="visually-hidden">
          Saving and publishing arrive with the page builder API.
        </span>
      </div>

      <div className="builder__panel builder__panel--left">
        <h3 className="builder__panel-title" id="builder-sections">
          Sections
        </h3>
        <ol className="section-list" aria-labelledby="builder-sections">
          {sections.map((s, i) => {
            const name = `${SECTION_LABELS[s.type]}: ${s.heading}`;
            return (
              <li
                key={s.id}
                className="section-item"
                data-selected={s.id === selectedId ? '' : undefined}
                data-hidden={s.visible ? undefined : ''}
              >
                <button
                  type="button"
                  className="section-item__select"
                  aria-current={s.id === selectedId ? 'true' : undefined}
                  onClick={() => setSelectedId(s.id)}
                >
                  {SECTION_LABELS[s.type]}
                  {s.visible ? null : <span className="visually-hidden"> (hidden)</span>}
                </button>
                <span className="section-item__tools">
                  <Button
                    variant="plain"
                    size="sm"
                    icon="arrowUp"
                    iconOnly
                    disabled={i === 0}
                    onClick={() =>
                      apply(move(sections, i, -1), `${SECTION_LABELS[s.type]} moved up`)
                    }
                  >
                    {`Move ${name} up`}
                  </Button>
                  <Button
                    variant="plain"
                    size="sm"
                    icon="arrowDown"
                    iconOnly
                    disabled={i === sections.length - 1}
                    onClick={() =>
                      apply(move(sections, i, 1), `${SECTION_LABELS[s.type]} moved down`)
                    }
                  >
                    {`Move ${name} down`}
                  </Button>
                  <Button
                    variant="plain"
                    size="sm"
                    icon={s.visible ? 'eye' : 'eyeOff'}
                    iconOnly
                    aria-pressed={!s.visible}
                    onClick={() =>
                      update(
                        s.id,
                        { visible: !s.visible },
                        `${SECTION_LABELS[s.type]} ${s.visible ? 'hidden' : 'shown'}`,
                      )
                    }
                  >
                    {`Hide ${name}`}
                  </Button>
                  <Button
                    variant="plain"
                    size="sm"
                    icon="copy"
                    iconOnly
                    onClick={() => {
                      const copy = { ...s, id: `${s.id}-${Date.now().toString(36)}` };
                      apply(
                        [...sections.slice(0, i + 1), copy, ...sections.slice(i + 1)],
                        `${SECTION_LABELS[s.type]} duplicated`,
                      );
                      setSelectedId(copy.id);
                    }}
                  >
                    {`Duplicate ${name}`}
                  </Button>
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="builder__canvas" aria-label="Preview" role="region">
        <div className={`preview preview--${viewport}`}>
          <SitePreview
            brand={brand}
            name="Operations Summit"
            sections={sections}
            selectedId={selectedId}
          />
        </div>
      </div>

      <div className="builder__panel builder__panel--right">
        <h3 className="builder__panel-title">Configuration</h3>
        {selected ? (
          <div className="form" key={`${selected.id}:${selected.heading}:${selected.body}`}>
            <p className="text-secondary text-sm">
              {SECTION_LABELS[selected.type]} section · schema v{selected.version}
            </p>
            <div className="field">
              <label className="field__label" htmlFor="builder-heading">
                Heading
              </label>
              <input
                id="builder-heading"
                className="input"
                defaultValue={selected.heading}
                maxLength={80}
                onBlur={(e) =>
                  e.target.value !== selected.heading &&
                  update(selected.id, { heading: e.target.value }, 'Heading updated')
                }
              />
            </div>
            {selected.type === 'hero' ||
            selected.type === 'about' ||
            selected.type === 'register' ? (
              <div className="field">
                <label className="field__label" htmlFor="builder-body">
                  Text
                </label>
                <textarea
                  id="builder-body"
                  className="input textarea"
                  rows={4}
                  maxLength={280}
                  defaultValue={selected.body}
                  onBlur={(e) =>
                    e.target.value !== selected.body &&
                    update(selected.id, { body: e.target.value }, 'Text updated')
                  }
                />
                <span className="field__hint">Plain text only. Up to 280 characters.</span>
              </div>
            ) : (
              <p className="field__hint">
                This section lists agenda items or speakers, edited where they are managed.
              </p>
            )}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={selected.visible}
                onChange={(e) =>
                  update(
                    selected.id,
                    { visible: e.target.checked },
                    `${SECTION_LABELS[selected.type]} ${e.target.checked ? 'shown' : 'hidden'}`,
                  )
                }
              />
              <span>Show on the page</span>
            </label>
          </div>
        ) : (
          <p className="text-secondary">Select a section to configure it.</p>
        )}
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
