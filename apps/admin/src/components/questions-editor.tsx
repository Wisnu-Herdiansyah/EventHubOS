'use client';

import { useActionState, useState } from 'react';
import { updateRegistrationQuestionsAction } from '@/app/actions/events';
import type { components } from '@/lib/api-types';
import { initialFormState } from '@/lib/errors';
import { FormMessage, SubmitButton } from './form';
import { Button } from './ui/button';

type Question = components['schemas']['RegistrationQuestion'];

const TYPES: Array<{ value: Question['type']; label: string }> = [
  { value: 'short_text', label: 'Short answer' },
  { value: 'long_text', label: 'Paragraph' },
  { value: 'choice', label: 'One of several options' },
  { value: 'yes_no', label: 'Yes or no' },
];
const MAX = 10;

/** "question-N" not yet used. */
function nextId(qs: Question[]): string {
  const used = new Set(qs.map((q) => q.id));
  for (let n = 1; ; n++) if (!used.has(`question-${n}`)) return `question-${n}`;
}

/**
 * Registration questions (ADR-0041): up to 10 extra questions on the sign-up form. Saved as a
 * whole; the API checks every rule and its messages name the question.
 */
export function QuestionsEditor(props: {
  organizationId: string;
  eventId: string;
  version: number;
  idempotencyKey: string;
  initial: Question[];
}) {
  const [state, action] = useActionState(updateRegistrationQuestionsAction, initialFormState);
  const [questions, setQuestions] = useState<Question[]>(props.initial);
  const set = (i: number, patch: Partial<Question>) =>
    setQuestions((qs) => qs.map((q, k) => (k === i ? { ...q, ...patch } : q)));
  // Options are typed one per line; the saved shape is a list.
  const [optionText, setOptionText] = useState<Record<string, string>>(() =>
    Object.fromEntries(props.initial.map((q) => [q.id, (q.options ?? []).join('\n')])),
  );
  const payload = questions.map((q) => {
    const { options: _o, help, ...rest } = q;
    const base = { ...rest, ...(help && help.trim() ? { help: help.trim() } : {}) };
    if (q.type !== 'choice') return base;
    const options = (optionText[q.id] ?? '')
      .split('\n')
      .map((o) => o.trim())
      .filter(Boolean);
    return { ...base, options };
  });
  return (
    <form action={action} className="form" noValidate>
      <FormMessage state={state} />
      {state.ok === false && state.fields ? (
        <ul className="issue-list">
          {Object.entries(state.fields).map(([k, m]) => (
            <li key={k}>{m}</li>
          ))}
        </ul>
      ) : null}
      <input type="hidden" name="organizationId" value={props.organizationId} />
      <input type="hidden" name="eventId" value={props.eventId} />
      <input type="hidden" name="expectedVersion" value={props.version} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <input type="hidden" name="questions" value={JSON.stringify(payload)} />
      {questions.length === 0 ? (
        <p className="text-secondary">
          The sign-up form asks only for name and email. Add a question to ask more, for example a
          company or a dietary need.
        </p>
      ) : (
        <ol className="item-list">
          {questions.map((q, i) => {
            const id = (name: string) => `question-${i}-${name}`;
            const n = i + 1;
            return (
              <li key={q.id} className="session-editor">
                <div className="field">
                  <label className="field__label" htmlFor={id('label')}>
                    Question {n}
                  </label>
                  <input
                    id={id('label')}
                    className="input"
                    maxLength={200}
                    value={q.label}
                    onChange={(e) => set(i, { label: e.target.value })}
                  />
                </div>
                <div className="session-editor__row session-editor__row--two">
                  <div className="field">
                    <label className="field__label" htmlFor={id('type')}>
                      Answer type <span className="visually-hidden">(question {n})</span>
                    </label>
                    <select
                      id={id('type')}
                      className="select"
                      value={q.type}
                      onChange={(e) => set(i, { type: e.target.value as Question['type'] })}
                    >
                      {TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor={id('help')}>
                      Hint <span className="visually-hidden">(question {n})</span>
                    </label>
                    <input
                      id={id('help')}
                      className="input"
                      maxLength={200}
                      value={q.help ?? ''}
                      onChange={(e) => set(i, { help: e.target.value })}
                    />
                  </div>
                </div>
                {q.type === 'choice' ? (
                  <div className="field">
                    <label className="field__label" htmlFor={id('options')}>
                      Options <span className="visually-hidden">(question {n})</span>
                    </label>
                    <textarea
                      id={id('options')}
                      className="input textarea"
                      rows={4}
                      value={optionText[q.id] ?? ''}
                      onChange={(e) => setOptionText((o) => ({ ...o, [q.id]: e.target.value }))}
                      aria-describedby={id('options-hint')}
                    />
                    <span className="field__hint" id={id('options-hint')}>
                      One per line, 2 to 20.
                    </span>
                  </div>
                ) : null}
                <div className="cluster">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={q.required}
                      onChange={(e) => set(i, { required: e.target.checked })}
                    />
                    <span>
                      Required <span className="visually-hidden">(question {n})</span>
                    </span>
                  </label>
                  <span className="topbar__spacer" />
                  <Button
                    variant="plain"
                    size="sm"
                    icon="trash"
                    onClick={() => setQuestions((qs) => qs.filter((_, k) => k !== i))}
                  >
                    {`Remove question ${n}`}
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <div className="form__actions">
        <Button
          variant="secondary"
          size="sm"
          icon="plus"
          disabled={questions.length >= MAX}
          onClick={() =>
            setQuestions((qs) => [
              ...qs,
              { id: nextId(qs), type: 'short_text', label: '', required: false },
            ])
          }
        >
          Add question
        </Button>
        <SubmitButton pendingLabel="Saving…">Save questions</SubmitButton>
      </div>
      <p className="field__hint">
        Answers are personal data: Owners, Admins, Event and Registration managers see them in the
        attendee list and download. Removing a question hides its answers but keeps them.
      </p>
    </form>
  );
}
