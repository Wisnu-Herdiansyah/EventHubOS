'use client';

import { useEffect, useState, useTransition } from 'react';
import { feedbackLinkAction, submitFeedbackAction, type FeedbackLink } from '@/app/actions';

const RATINGS = [
  { value: 5, label: '5 – Excellent' },
  { value: 4, label: '4 – Good' },
  { value: 3, label: '3 – OK' },
  { value: 2, label: '2 – Poor' },
  { value: 1, label: '1 – Very poor' },
];
export const COMMENT_MAX = 2000;

/**
 * Feedback on an event (ADR-0063). Reads the personal token from the URL fragment (never sent to
 * servers by the browser), removes it from the address bar, shows what the link is for, and
 * sends a rating with an optional comment.
 */
export function FeedbackForm() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [link, setLink] = useState<FeedbackLink | { error: string } | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    const m = /(?:^#|&)token=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash);
    if (m?.[1]) window.history.replaceState(null, '', window.location.pathname);
    const found = m?.[1] ?? null;
    setToken(found);
    if (found) void feedbackLinkAction(found).then(setLink);
  }, []);

  if (token === undefined || (token && link === null)) {
    return <p role="status">Checking your link…</p>;
  }
  if (!token) {
    return (
      <p className="site-error" role="alert">
        This link is incomplete. Open it from your email again.
      </p>
    );
  }
  if (link && 'error' in link) {
    return (
      <p className="site-error" role="alert">
        {link.error}
      </p>
    );
  }
  if (done) {
    return (
      <p className="site-notice site-notice--success" role="status">
        {done}
      </p>
    );
  }
  const info = link as FeedbackLink;
  return (
    <form
      className="site-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (rating === null) {
          setProblem('Choose a rating.');
          return;
        }
        setProblem(null);
        start(async () => {
          const result = await submitFeedbackAction(token, rating, comment);
          if (result.ok) setDone(result.message);
          else setProblem(result.message);
        });
      }}
    >
      <p>
        How was <strong>{info.eventName}</strong>?
      </p>
      {info.answered ? (
        <p className="site-notice" role="status">
          You have already answered. Sending again replaces your earlier answer.
        </p>
      ) : null}
      {problem ? (
        <p className="site-error" role="alert" id="feedback-error">
          {problem}
        </p>
      ) : null}
      <fieldset
        className="site-field site-choice"
        aria-describedby={problem ? 'feedback-error' : undefined}
      >
        <legend>Your rating</legend>
        {RATINGS.map((r) => (
          <label key={r.value} className="site-check">
            <input
              type="radio"
              name="rating"
              value={r.value}
              checked={rating === r.value}
              onChange={() => setRating(r.value)}
            />
            <span>{r.label}</span>
          </label>
        ))}
      </fieldset>
      <div className="site-field">
        <label htmlFor="feedback-comment">
          Anything to add? <span className="site-optional">(optional)</span>
        </label>
        <textarea
          id="feedback-comment"
          className="site-input"
          rows={5}
          maxLength={COMMENT_MAX}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          aria-describedby="feedback-privacy"
        />
      </div>
      <p className="site-help" id="feedback-privacy">
        Your answer is shared with {info.organizationName} without your name. Please don’t include
        personal details in your comment.
      </p>
      <div>
        <button type="submit" className="site-cta" disabled={pending} aria-busy={pending}>
          {pending ? 'Sending…' : 'Send feedback'}
        </button>
      </div>
    </form>
  );
}
