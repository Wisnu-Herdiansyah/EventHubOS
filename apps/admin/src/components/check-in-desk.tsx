'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition, type FormEvent } from 'react';
import {
  lookupTicketAction,
  searchCheckInAction,
  setCheckInAction,
  type CheckInSearchResult,
} from '@/app/actions/check-in';
import type { components } from '@/lib/api-types';
import { ticketIdFromScan } from '@/lib/ticket-scan';
import { timeInZone } from '@/lib/time';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, Stat } from './ui/card';
import { EmptyState } from './ui/empty-state';
import { Notice } from './ui/notice';
import { SearchField } from './ui/search-field';
import { TicketScanner } from './ticket-scanner';

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
  /** The outcome of the last scanned ticket, shown large for the person at the door. */
  const [scan, setScan] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(
    null,
  );
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

  /**
   * A scanned ticket (camera, or a handheld scanner typing into the search box) checks the
   * person in straight away: one action per arrival. Problems are said plainly (ADR-0029).
   */
  function admitTicket(id: string) {
    startSearch(async () => {
      setScan(null);
      const r = await lookupTicketAction(props.organizationId, props.eventId, id);
      if (!r.ok) return handleFailure(r);
      setError(null);
      setList(r);
      setSearched('');
      const a = r.data[0];
      if (!a) {
        setScan({ tone: 'danger', text: 'This ticket is not for this event.' });
        return;
      }
      if (a.status === 'cancelled') {
        setScan({ tone: 'danger', text: `${a.name}’s registration was cancelled.` });
        return;
      }
      if (a.status === 'waitlisted') {
        // ADR-0035: waiting people get no ticket, but say it plainly if one turns up.
        setScan({ tone: 'danger', text: `${a.name} is on the waitlist and has no seat.` });
        return;
      }
      if (a.checkedInAt) {
        setScan({
          tone: 'warning',
          text: `${a.name} was already checked in at ${timeInZone(a.checkedInAt, props.timezone)}.`,
        });
        return;
      }
      await toggle(a, (name) => setScan({ tone: 'success', text: `${name} checked in.` }));
    });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const ticket = ticketIdFromScan(query);
    if (ticket) {
      setQuery('');
      admitTicket(ticket);
      return;
    }
    setScan(null);
    search(query);
  }

  async function toggle(a: Attendee, onDone?: (name: string) => void) {
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
    onDone?.(a.name);
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
      {scan ? (
        <Notice tone={scan.tone} role={scan.tone === 'success' ? 'status' : 'alert'}>
          <span className="ticket-result">{scan.text}</span>
        </Notice>
      ) : null}
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
            placeholder="Name, email or ticket code"
            value={query}
            maxLength={120}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={searching} aria-busy={searching}>
            Find
          </Button>
        </form>
        <div className="door-scan">
          <TicketScanner onTicket={admitTicket} />
        </div>
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
