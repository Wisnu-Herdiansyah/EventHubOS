'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition, type FormEvent } from 'react';
import {
  searchCheckInAction,
  setCheckInAction,
  type CheckInSearchResult,
} from '@/app/actions/check-in';
import type { components } from '@/lib/api-types';
import { timeInZone } from '@/lib/time';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, Stat } from './ui/card';
import { EmptyState } from './ui/empty-state';
import { Notice } from './ui/notice';
import { SearchField } from './ui/search-field';

type Attendee = components['schemas']['Registration'];

/**
 * The door desk (ADR-0028): search, check in, undo. One request per action; the row updates
 * in place and a polite live region says what happened, so staff can keep their eyes on people.
 */
export function CheckInDesk(props: {
  organizationId: string;
  eventId: string;
  timezone: string;
  initial: components['schemas']['CheckInList'];
}) {
  const router = useRouter();
  const [list, setList] = useState(props.initial);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();
  const keys = useRef(new Map<string, string>());
  const input = useRef<HTMLInputElement>(null);

  function handleFailure(r: Extract<CheckInSearchResult, { ok: false }>) {
    if (r.redirectTo) router.push(r.redirectTo);
    setError(r.message);
  }

  /** `keepError`: a refresh after a conflict keeps its explanation on screen. */
  function search(q: string, keepError = false) {
    startSearch(async () => {
      const r = await searchCheckInAction(props.organizationId, props.eventId, q);
      if (!r.ok) return handleFailure(r);
      if (!keepError) setError(null);
      setList(r);
      setSearched(q.trim());
      setAnnouncement(
        r.data.length === 0
          ? 'No one found.'
          : `${r.data.length} ${r.data.length === 1 ? 'person' : 'people'} found.`,
      );
    });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    search(query);
  }

  async function toggle(a: Attendee) {
    const checkIn = a.checkedInAt === null;
    const slot = `${a.id}:${checkIn ? 'in' : 'out'}`;
    const key = keys.current.get(slot) ?? `admin-${crypto.randomUUID()}`;
    keys.current.set(slot, key);
    setBusyId(a.id);
    const r = await setCheckInAction(props.organizationId, props.eventId, a.id, checkIn, key);
    setBusyId(null);
    if (!r.ok) {
      handleFailure(r);
      // Someone else may have changed it at another door: show the current state.
      if (r.reason === 'already_checked_in' || r.reason === 'not_checked_in')
        search(searched, true);
      return;
    }
    keys.current.delete(slot);
    setError(null);
    setList((l) => ({
      ...l,
      checkedIn: l.checkedIn + (checkIn ? 1 : -1),
      data: l.data.map((x) => (x.id === a.id ? { ...x, checkedInAt: r.checkedInAt } : x)),
    }));
    setAnnouncement(checkIn ? `${a.name} checked in.` : `Check-in of ${a.name} undone.`);
    input.current?.select();
  }

  return (
    <div className="stack">
      <div className="grid">
        <Stat
          label="Checked in"
          value={`${list.checkedIn} of ${list.confirmed}`}
          hint={
            list.confirmed > 0
              ? `${Math.round((list.checkedIn / list.confirmed) * 100)}% arrived`
              : 'No registrations yet'
          }
        />
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      <Card flush title="Attendees" titleId="door-heading">
        <form className="door-search" onSubmit={onSubmit}>
          <SearchField
            ref={input}
            label="Find an attendee"
            placeholder="Name or email"
            value={query}
            maxLength={120}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={searching} aria-busy={searching}>
            Find
          </Button>
        </form>
        {list.data.length === 0 ? (
          <EmptyState
            icon="search"
            title={searched ? 'No one found' : 'No registrations yet'}
            description={
              searched
                ? 'Check the spelling, or search by the start of their email address.'
                : 'Confirmed registrations appear here.'
            }
          />
        ) : (
          <ul className="door-list" aria-label="Search results">
            {list.data.map((a) => (
              <li key={a.id} className="door-list__item">
                <span className="door-list__who">
                  <span className="table__primary wrap-anywhere">{a.name}</span>
                  <span className="table__secondary wrap-anywhere">{a.email}</span>
                </span>
                {a.checkedInAt ? (
                  <>
                    <Badge tone="success" dot>
                      Checked in {timeInZone(a.checkedInAt, props.timezone)}
                    </Badge>
                    <Button
                      variant="plain"
                      size="sm"
                      disabled={busyId === a.id}
                      onClick={() => void toggle(a)}
                    >
                      Undo<span className="visually-hidden"> check-in of {a.name}</span>
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    icon="check"
                    disabled={busyId === a.id}
                    aria-busy={busyId === a.id}
                    onClick={() => void toggle(a)}
                  >
                    Check in<span className="visually-hidden"> {a.name}</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {list.data.length === 25 ? (
          <p className="card__note text-secondary door-more">
            Showing the first 25. Type more of the name to narrow it down.
          </p>
        ) : null}
      </Card>
    </div>
  );
}
