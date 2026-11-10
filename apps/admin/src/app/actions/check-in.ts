'use server';

import { randomUUID } from 'node:crypto';
import type { components } from '@/lib/api-types';
import { api, unwrap } from '@/lib/api';
import { ApiError, errorToFormState, isTwoStepRequired, twoStepRequiredPath } from '@/lib/errors';

const UUID = /^[0-9a-f-]{36}$/i;
const IDEM = /^admin-[A-Za-z0-9-]{8,80}$/;

type Failure = { ok: false; message: string; reason?: string; redirectTo?: string };
export type CheckInSearchResult = ({ ok: true } & components['schemas']['CheckInList']) | Failure;
export type CheckInResult = { ok: true; checkedInAt: string | null } | Failure;

/**
 * The door desk keeps its state in the browser rather than the address bar, so attendee names
 * typed into the search never end up in URLs, browser history or server access logs (ADR-0028).
 */
function failure(error: unknown, page: string): Failure {
  if (error instanceof ApiError && error.status === 401) {
    return {
      ok: false,
      message: 'Your session ended. Sign in again.',
      redirectTo: `/login?next=${encodeURIComponent(page)}&ended=1`,
    };
  }
  if (isTwoStepRequired(error)) {
    return {
      ok: false,
      message: 'Two-step verification is required.',
      redirectTo: twoStepRequiredPath(page),
    };
  }
  const state = errorToFormState(error);
  return { ok: false, message: state.message ?? 'Something went wrong.', reason: state.reason };
}

export async function searchCheckInAction(
  organizationId: string,
  eventId: string,
  q: string,
): Promise<CheckInSearchResult> {
  if (!UUID.test(organizationId) || !UUID.test(eventId) || typeof q !== 'string') {
    return { ok: false, message: 'Something went wrong. Please try again.' };
  }
  const query = q.trim().slice(0, 120);
  try {
    const client = await api();
    const list = unwrap(
      await client.GET('/v1/organizations/{organizationId}/events/{eventId}/check-in', {
        params: { path: { organizationId, eventId }, query: query ? { q: query } : {} },
      }),
    );
    return { ok: true, ...list };
  } catch (error) {
    return failure(error, `/orgs/${organizationId}/events/${eventId}/check-in`);
  }
}

/** Looks up the one registration a scanned ticket names (ADR-0029). */
export async function lookupTicketAction(
  organizationId: string,
  eventId: string,
  ticket: string,
): Promise<CheckInSearchResult> {
  if (![organizationId, eventId, ticket].every((id) => typeof id === 'string' && UUID.test(id))) {
    return { ok: false, message: 'That is not a ticket code.' };
  }
  try {
    const client = await api();
    const list = unwrap(
      await client.GET('/v1/organizations/{organizationId}/events/{eventId}/check-in', {
        params: { path: { organizationId, eventId }, query: { ticket } },
      }),
    );
    return { ok: true, ...list };
  } catch (error) {
    return failure(error, `/orgs/${organizationId}/events/${eventId}/check-in`);
  }
}

export async function setCheckInAction(
  organizationId: string,
  eventId: string,
  registrationId: string,
  checkIn: boolean,
  idempotencyKey: string,
): Promise<CheckInResult> {
  if (
    ![organizationId, eventId, registrationId].every((id) => UUID.test(id)) ||
    typeof checkIn !== 'boolean'
  ) {
    return { ok: false, message: 'Something went wrong. Please try again.' };
  }
  // A retried click reuses its key, so the API replays instead of refusing a second check-in.
  const key = IDEM.test(idempotencyKey) ? idempotencyKey : `admin-${randomUUID()}`;
  const params = {
    path: { organizationId, eventId, registrationId },
    header: { 'Idempotency-Key': key },
  };
  try {
    const client = await api();
    const res = unwrap(
      checkIn
        ? await client.POST(
            '/v1/organizations/{organizationId}/events/{eventId}/registrations/{registrationId}/check-in',
            { params },
          )
        : await client.POST(
            '/v1/organizations/{organizationId}/events/{eventId}/registrations/{registrationId}/undo-check-in',
            { params },
          ),
    );
    return { ok: true, checkedInAt: res.checkedInAt };
  } catch (error) {
    return failure(error, `/orgs/${organizationId}/events/${eventId}/check-in`);
  }
}
