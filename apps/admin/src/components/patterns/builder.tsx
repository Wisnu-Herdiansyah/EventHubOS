'use client';

import { useEffect, useRef, useState, useTransition, type FocusEvent } from 'react';
import { publishPageAction, savePageDraftAction } from '@/app/actions/pages';
import {
  SECTION_LABELS,
  SECTION_TYPES,
  describeIssues,
  newAgendaItem,
  newSection,
  newSpeaker,
  pageSpeakers,
  removeSpeaker,
  uniqueSectionId,
  type AgendaItem,
  type Speaker,
  type EditorIssue,
  type EventPage,
  type Section,
  type SectionType,
} from '@/lib/page-editor';
import { Button } from '../ui/button';
import { Dialog, DialogCancel } from '../ui/dialog';
import type { IconName } from '../ui/icons';
import { Notice } from '../ui/notice';
import { Tooltip } from '../ui/tooltip';
import {
  checkpoint,
  commit,
  initHistory,
  move,
  redo,
  replacePresent,
  undo,
  type History,
} from './builder-history';
import { SitePreview, upgradeSections } from '@eventhub/microsite';

type Viewport = 'desktop' | 'tablet' | 'mobile';

const VIEWPORTS: Array<{ value: Viewport; label: string; icon: IconName }> = [
  { value: 'desktop', label: 'Desktop', icon: 'desktop' },
  { value: 'tablet', label: 'Tablet', icon: 'tablet' },
  { value: 'mobile', label: 'Phone', icon: 'phone' },
];

/** Connects the editor to a real event page. Without it, the editor runs on sample content. */
export interface LiveBinding {
  organizationId: string;
  eventId: string;
  canEdit: boolean;
  canPublish: boolean;
  published: EventPage['published'];
  hasUnpublishedChanges: boolean;
}

interface Result {
  tone: 'success' | 'danger';
  message: string;
  issues?: EditorIssue[];
  reference?: string;
}

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

const sectionName = (s: Section) => s.heading.trim() || SECTION_LABELS[s.type];

/**
 * Microsite editor: section navigator (left), live preview (centre), configuration (right).
 * Edits stay in this tab until saved; one field edit is one undo step (Ctrl/⌘+Z outside text
 * fields). Saving sends the whole draft with the version it was based on; publishing turns the
 * saved draft into an immutable revision (ADR-0020).
 */
export function PageEditor({
  initialSections,
  initialVersion = 0,
  eventName,
  timezone,
  live,
}: {
  initialSections: Section[];
  initialVersion?: number;
  eventName: string;
  /** The event's time zone, for the agenda preview. */
  timezone?: string;
  live?: LiveBinding;
}) {
  // ADR-0040: drafts with v1 agenda or speakers open upgraded to v2. The upgrade is an unsaved
  // change until the organizer saves; people who cannot edit see the page as stored.
  const [start] = useState<Section[]>(() => {
    if (live && !live.canEdit) return initialSections;
    const upgraded = upgradeSections(initialSections) as Section[];
    return upgraded.some((s, i) => s !== initialSections[i]) ? upgraded : initialSections;
  });
  const upgradedOnOpen = start !== initialSections;
  const [history, setHistory] = useState<History<Section[]>>(() => initHistory(start));
  const [saved, setSaved] = useState<Section[]>(initialSections);
  const [version, setVersion] = useState(initialVersion);
  const [publication, setPublication] = useState({
    published: live?.published ?? null,
    hasUnpublishedChanges: live?.hasUnpublishedChanges ?? false,
  });
  const [selectedId, setSelectedId] = useState(initialSections[0]?.id);
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [announcement, setAnnouncement] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [addType, setAddType] = useState<SectionType>('text');
  const [pending, startTransition] = useTransition();
  const fieldStart = useRef<Section[] | null>(null);

  const sections = history.present;
  const selected = sections.find((s) => s.id === selectedId);
  const readOnly = live ? !live.canEdit : false;
  const dirty = sections !== saved;

  const apply = (next: Section[], message: string) => {
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
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [readOnly]);

  // Leaving with unsaved edits asks first.
  useEffect(() => {
    if (!live || !dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [live, dirty]);

  /** Discrete change: one undo step. */
  const update = (id: string, patch: Partial<Section>, message: string) =>
    apply(
      sections.map((s) => (s.id === id ? ({ ...s, ...patch } as Section) : s)),
      message,
    );

  /** Typing: changes the page now; the undo step is recorded when the field loses focus. */
  const edit = (id: string, patch: Partial<Section>) =>
    setHistory((h) =>
      replacePresent(
        h,
        h.present.map((s) => (s.id === id ? ({ ...s, ...patch } as Section) : s)),
      ),
    );
  const field = {
    onFocus: () => {
      fieldStart.current = history.present;
    },
    onBlur: (_e: FocusEvent) => {
      const before = fieldStart.current;
      fieldStart.current = null;
      if (before) setHistory((h) => checkpoint(h, before));
    },
  };

  const save = () => {
    if (!live) return;
    const snapshot = sections;
    const key = crypto.randomUUID();
    startTransition(async () => {
      const r = await savePageDraftAction(
        live.organizationId,
        live.eventId,
        version,
        snapshot,
        key,
      );
      if (r.ok && r.page) {
        setVersion(r.page.draft.version);
        setSaved(snapshot);
        setPublication({
          published: r.page.published,
          hasUnpublishedChanges: r.page.hasUnpublishedChanges,
        });
        setResult({ tone: 'success', message: r.message });
      } else {
        setResult({
          tone: 'danger',
          message: r.message,
          issues: describeIssues(r.fields ?? [], snapshot),
          reference: r.reference,
        });
      }
    });
  };

  const publish = (dialog: HTMLDialogElement | null) => {
    if (!live) return;
    const key = crypto.randomUUID();
    startTransition(async () => {
      const r = await publishPageAction(live.organizationId, live.eventId, version, key);
      dialog?.close();
      if (r.ok && r.page) {
        setPublication({
          published: r.page.published,
          hasUnpublishedChanges: r.page.hasUnpublishedChanges,
        });
      }
      setResult({ tone: r.ok ? 'success' : 'danger', message: r.message, reference: r.reference });
    });
  };

  const status = readOnly
    ? 'View only'
    : !live
      ? 'Sample content · changes stay in this tab'
      : dirty
        ? 'Unsaved changes'
        : version === 0
          ? 'Not saved yet'
          : `Saved · version ${version}`;
  const nextRevision = (publication.published?.revision ?? 0) + 1;
  const canPublishNow =
    !!live?.canPublish && !dirty && version > 0 && publication.hasUnpublishedChanges && !pending;
  const invalid = new Set(
    (result?.issues ?? []).map((i) => i.sectionIndex).filter((i) => i !== null),
  );

  return (
    <div className="stack-sm">
      {upgradedOnOpen && dirty && !result ? (
        <Notice role={null}>
          The agenda and speakers now support days, rooms, bios and linked speakers. This page was
          updated to the new format: save the draft to keep it.
        </Notice>
      ) : null}
      {result ? (
        <Notice tone={result.tone} reference={result.reference}>
          {result.message}
          {result.issues && result.issues.length > 0 ? (
            <ul className="issue-list">
              {result.issues.map((i, n) => (
                <li key={n}>{i.message}</li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}

      <div className="builder" data-readonly={readOnly ? '' : undefined}>
        <div className="builder__toolbar">
          {readOnly ? null : (
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
          )}
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
          <span className="builder__status">
            {status}
            {live && publication.published
              ? ` · published revision ${publication.published.revision}${publication.hasUnpublishedChanges ? ', newer changes not published' : ''}`
              : live
                ? ' · not published'
                : ''}
          </span>
          {readOnly ? null : (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={!live || !dirty || pending}
                aria-busy={pending}
                aria-describedby={live ? undefined : 'builder-sample-note'}
                onClick={save}
              >
                {pending ? 'Saving…' : 'Save draft'}
              </Button>
              {live && !live.canPublish ? null : (
                <Dialog
                  trigger={{ label: 'Publish…', size: 'sm', disabled: !canPublishNow }}
                  title={`Publish revision ${nextRevision}?`}
                  description="The saved draft becomes a new revision that cannot be changed. Earlier revisions are kept."
                >
                  <div className="form">
                    <p className="field__hint">
                      Visitors will see published revisions once public event sites launch. Drafts
                      are never shown publicly.
                    </p>
                    <div className="form__actions form__actions--end">
                      <DialogCancel />
                      <Button
                        disabled={pending}
                        onClick={(e) => publish(e.currentTarget.closest('dialog'))}
                      >
                        {`Publish revision ${nextRevision}`}
                      </Button>
                    </div>
                  </div>
                </Dialog>
              )}
            </>
          )}
          {live ? null : (
            <span id="builder-sample-note" className="visually-hidden">
              Sample content: nothing is saved.
            </span>
          )}
        </div>

        <div className="builder__panel builder__panel--left">
          <h3 className="builder__panel-title" id="builder-sections">
            Sections
          </h3>
          <ol className="section-list" aria-labelledby="builder-sections">
            {sections.map((s, i) => {
              const name = sectionName(s);
              return (
                <li
                  key={s.id}
                  className="section-item"
                  data-selected={s.id === selectedId ? '' : undefined}
                  data-hidden={s.visible ? undefined : ''}
                  data-invalid={invalid.has(i) ? '' : undefined}
                >
                  <button
                    type="button"
                    className="section-item__select"
                    aria-current={s.id === selectedId ? 'true' : undefined}
                    onClick={() => setSelectedId(s.id)}
                  >
                    <span className="section-item__name">{name}</span>
                    <span className="section-item__type">
                      {SECTION_LABELS[s.type]}
                      {s.visible ? '' : ' · hidden'}
                      {invalid.has(i) ? ' · needs attention' : ''}
                    </span>
                  </button>
                  {readOnly ? null : (
                    <span className="section-item__tools">
                      <Button
                        variant="plain"
                        size="sm"
                        icon="arrowUp"
                        iconOnly
                        disabled={i === 0}
                        onClick={() => apply(move(sections, i, -1), `${name} moved up`)}
                      >
                        {`Move ${name} up`}
                      </Button>
                      <Button
                        variant="plain"
                        size="sm"
                        icon="arrowDown"
                        iconOnly
                        disabled={i === sections.length - 1}
                        onClick={() => apply(move(sections, i, 1), `${name} moved down`)}
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
                            `${name} ${s.visible ? 'hidden' : 'shown'}`,
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
                          const copy = {
                            ...s,
                            id: uniqueSectionId(
                              s.type,
                              sections.map((x) => x.id),
                            ),
                          };
                          apply(
                            [...sections.slice(0, i + 1), copy, ...sections.slice(i + 1)],
                            `${name} duplicated`,
                          );
                          setSelectedId(copy.id);
                        }}
                      >
                        {`Duplicate ${name}`}
                      </Button>
                      <Button
                        variant="plain"
                        size="sm"
                        icon="trash"
                        iconOnly
                        onClick={() => {
                          apply(
                            sections.filter((x) => x.id !== s.id),
                            `${name} deleted. Undo is available.`,
                          );
                          if (selectedId === s.id)
                            setSelectedId(sections[i + 1]?.id ?? sections[i - 1]?.id);
                        }}
                      >
                        {`Delete ${name}`}
                      </Button>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          {readOnly ? null : (
            <div className="section-add">
              <label className="field__label" htmlFor="builder-add-type">
                Add a section
              </label>
              <div className="section-add__row">
                <select
                  id="builder-add-type"
                  className="select"
                  value={addType}
                  onChange={(e) => setAddType(e.target.value as SectionType)}
                >
                  {SECTION_TYPES.map((t) => (
                    <option key={t.type} value={t.type}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <Button
                  variant="secondary"
                  size="sm"
                  icon="plus"
                  disabled={sections.length >= 30}
                  onClick={() => {
                    const s = newSection(
                      addType,
                      sections.map((x) => x.id),
                    );
                    apply([...sections, s], `${SECTION_LABELS[addType]} section added`);
                    setSelectedId(s.id);
                  }}
                >
                  Add
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="builder__canvas" aria-label="Preview" role="region">
          <div className={`preview preview--${viewport}`}>
            <SitePreview
              name={eventName}
              sections={sections}
              selectedId={selectedId}
              timezone={timezone}
            />
          </div>
        </div>

        <div className="builder__panel builder__panel--right">
          <h3 className="builder__panel-title">Configuration</h3>
          {readOnly ? (
            <p className="text-secondary text-sm">
              Your role can view this page. Content editors, Event managers, Admins and Owners can
              edit it.
            </p>
          ) : selected ? (
            <SectionForm
              section={selected}
              sections={sections}
              edit={edit}
              update={update}
              apply={apply}
              field={field}
            />
          ) : (
            <p className="text-secondary">Select a section to configure it.</p>
          )}
        </div>
        <p className="visually-hidden" role="status" aria-live="polite">
          {announcement}
        </p>
      </div>
    </div>
  );
}

type Edit = (id: string, patch: Partial<Section>) => void;
type Update = (id: string, patch: Partial<Section>, message: string) => void;
type FieldEvents = { onFocus: () => void; onBlur: (e: FocusEvent) => void };

function TextInput(props: {
  id: string;
  label: string;
  value: string;
  maxLength: number;
  onChange: (v: string) => void;
  field: FieldEvents;
  multiline?: boolean;
  hint?: string;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={props.id}>
        {props.label}
      </label>
      {props.multiline ? (
        <textarea
          id={props.id}
          className="input textarea"
          rows={5}
          maxLength={props.maxLength}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          aria-describedby={props.hint ? `${props.id}-hint` : undefined}
          {...props.field}
        />
      ) : (
        <input
          id={props.id}
          className="input"
          maxLength={props.maxLength}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          {...props.field}
        />
      )}
      {props.hint ? (
        <span className="field__hint" id={`${props.id}-hint`}>
          {props.hint}
        </span>
      ) : null}
    </div>
  );
}

function SectionForm({
  section: s,
  sections,
  edit,
  update,
  apply,
  field,
}: {
  section: Section;
  sections: Section[];
  edit: Edit;
  update: Update;
  apply: (next: Section[], message: string) => void;
  field: FieldEvents;
}) {
  const id = (name: string) => `builder-${s.id}-${name}`;
  return (
    <div className="form">
      <p className="text-secondary text-sm">
        {SECTION_LABELS[s.type]} section · schema v{s.version}
      </p>
      <TextInput
        id={id('heading')}
        label="Heading"
        value={s.heading}
        maxLength={120}
        onChange={(v) => edit(s.id, { heading: v })}
        field={field}
      />
      {s.type === 'hero' || s.type === 'text' || s.type === 'register' ? (
        <TextInput
          id={id('body')}
          label="Text"
          multiline
          value={s.body}
          maxLength={s.type === 'text' ? 4000 : 400}
          onChange={(v) => edit(s.id, { body: v })}
          field={field}
          hint="Plain text. Leave a blank line between paragraphs."
        />
      ) : null}
      {s.type === 'hero' || s.type === 'register' ? (
        <TextInput
          id={id('cta')}
          label="Button label"
          value={s.ctaLabel}
          maxLength={40}
          onChange={(v) => edit(s.id, { ctaLabel: v })}
          field={field}
        />
      ) : null}
      {(s.type === 'agenda' || s.type === 'speakers') && s.version === 1 ? (
        <Notice role={null}>
          This section uses an older format. It is shown as published; an editor can update it.
        </Notice>
      ) : null}
      {s.type === 'agenda' && s.version === 2 ? (
        <fieldset className="fieldset">
          <legend className="fieldset__legend">Sessions</legend>
          <ol className="item-list">
            {s.items.map((item, n) => {
              const set = (patch: Partial<AgendaItem>) =>
                edit(s.id, {
                  items: s.items.map((x, k) => (k === n ? { ...x, ...patch } : x)),
                });
              const label = (text: string) => (
                <>
                  {text}
                  <span className="visually-hidden">{` (session ${n + 1})`}</span>
                </>
              );
              const speakers = pageSpeakers(sections);
              return (
                <li key={item.id} className="session-editor">
                  <div className="session-editor__row">
                    <div className="field">
                      <label className="field__label" htmlFor={id(`day-${n}`)}>
                        {label('Day')}
                      </label>
                      <input
                        id={id(`day-${n}`)}
                        className="input"
                        type="date"
                        value={item.day}
                        onChange={(e) => set({ day: e.target.value })}
                        {...field}
                      />
                    </div>
                    <div className="field">
                      <label className="field__label" htmlFor={id(`start-${n}`)}>
                        {label('Starts')}
                      </label>
                      <input
                        id={id(`start-${n}`)}
                        className="input"
                        type="time"
                        value={item.start}
                        onChange={(e) => set({ start: e.target.value })}
                        {...field}
                      />
                    </div>
                    <div className="field">
                      <label className="field__label" htmlFor={id(`end-${n}`)}>
                        {label('Ends')}
                      </label>
                      <input
                        id={id(`end-${n}`)}
                        className="input"
                        type="time"
                        value={item.end}
                        onChange={(e) => set({ end: e.target.value })}
                        {...field}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor={id(`title-${n}`)}>
                      {label('Title')}
                    </label>
                    <input
                      id={id(`title-${n}`)}
                      className="input"
                      maxLength={160}
                      value={item.title}
                      onChange={(e) => set({ title: e.target.value })}
                      {...field}
                    />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor={id(`room-${n}`)}>
                      {label('Room')}
                    </label>
                    <input
                      id={id(`room-${n}`)}
                      className="input"
                      maxLength={60}
                      value={item.room}
                      onChange={(e) => set({ room: e.target.value })}
                      {...field}
                    />
                  </div>
                  {speakers.length > 0 ? (
                    <fieldset className="fieldset session-editor__speakers">
                      <legend className="field__label">{label('Speakers')}</legend>
                      {speakers.map((p) => (
                        <label key={p.id} className="checkbox">
                          <input
                            type="checkbox"
                            checked={item.speakerIds.includes(p.id)}
                            onChange={(e) =>
                              update(
                                s.id,
                                {
                                  items: s.items.map((x, k) =>
                                    k === n
                                      ? {
                                          ...x,
                                          speakerIds: e.target.checked
                                            ? [...x.speakerIds, p.id]
                                            : x.speakerIds.filter((v) => v !== p.id),
                                        }
                                      : x,
                                  ),
                                },
                                `${p.name || 'Speaker'} ${e.target.checked ? 'added to' : 'removed from'} session ${n + 1}`,
                              )
                            }
                          />
                          <span>{p.name || 'Unnamed speaker'}</span>
                        </label>
                      ))}
                    </fieldset>
                  ) : null}
                  <TextInput
                    id={id(`description-${n}`)}
                    label={`Description (session ${n + 1})`}
                    multiline
                    value={item.description}
                    maxLength={800}
                    onChange={(v) => set({ description: v })}
                    field={field}
                  />
                  <div>
                    <Button
                      variant="plain"
                      size="sm"
                      icon="trash"
                      onClick={() =>
                        update(
                          s.id,
                          { items: s.items.filter((_, k) => k !== n) },
                          `Session ${n + 1} removed`,
                        )
                      }
                    >
                      {`Remove session ${n + 1}`}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
          <div>
            <Button
              variant="secondary"
              size="sm"
              icon="plus"
              disabled={s.items.length >= 100}
              onClick={() =>
                update(s.id, { items: [...s.items, newAgendaItem(s)] }, 'Session added')
              }
            >
              Add session
            </Button>
          </div>
        </fieldset>
      ) : null}
      {s.type === 'speakers' && s.version === 2 ? (
        <fieldset className="fieldset">
          <legend className="fieldset__legend">Speakers</legend>
          <ol className="item-list">
            {s.items.map((item, n) => {
              const set = (patch: Partial<Speaker>) =>
                edit(s.id, {
                  items: s.items.map((x, k) => (k === n ? { ...x, ...patch } : x)),
                });
              return (
                <li key={item.id} className="session-editor">
                  <div className="session-editor__row session-editor__row--two">
                    <TextInput
                      id={id(`name-${n}`)}
                      label={`Name (speaker ${n + 1})`}
                      value={item.name}
                      maxLength={100}
                      onChange={(v) => set({ name: v })}
                      field={field}
                    />
                    <TextInput
                      id={id(`role-${n}`)}
                      label={`Role (speaker ${n + 1})`}
                      value={item.role}
                      maxLength={120}
                      onChange={(v) => set({ role: v })}
                      field={field}
                    />
                  </div>
                  <TextInput
                    id={id(`bio-${n}`)}
                    label={`Bio (speaker ${n + 1})`}
                    multiline
                    value={item.bio}
                    maxLength={800}
                    onChange={(v) => set({ bio: v })}
                    field={field}
                    hint="A few sentences. Leave a blank line between paragraphs."
                  />
                  <div>
                    <Button
                      variant="plain"
                      size="sm"
                      icon="trash"
                      onClick={() =>
                        apply(removeSpeaker(sections, s.id, item.id), `Speaker ${n + 1} removed`)
                      }
                    >
                      {`Remove speaker ${n + 1}`}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
          <div>
            <Button
              variant="secondary"
              size="sm"
              icon="plus"
              disabled={s.items.length >= 60}
              onClick={() =>
                update(s.id, { items: [...s.items, newSpeaker(sections)] }, 'Speaker added')
              }
            >
              Add speaker
            </Button>
          </div>
        </fieldset>
      ) : null}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={s.visible}
          onChange={(e) =>
            update(
              s.id,
              { visible: e.target.checked },
              `${sectionName(s)} ${e.target.checked ? 'shown' : 'hidden'}`,
            )
          }
        />
        <span>Show on the page</span>
      </label>
    </div>
  );
}
