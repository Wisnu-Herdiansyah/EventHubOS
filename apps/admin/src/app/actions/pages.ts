'use server';

import { revalidatePath } from 'next/cache';
import { api, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import type { EventPage } from '@/lib/page-editor';

/**
 * Microsite editor actions (ADR-0020). The editor sends the whole section list; the API
 * validates it, checks the version and permissions, and audits the change. Only identifiers are
 * checked here.
 */
export interface PageActionResult {
  ok: boolean;
  message: string;
  page?: EventPage;
  /** API field errors (paths such as body.sections.1.heading) for the editor to explain. */
  fields?: Array<{ path: string; message: string }>;
  reason?: string;
  reference?: string;
}

const UUID = /^[0-9a-f-]{36}$/i;
const KEY = /^[A-Za-z0-9_-]{8,128}$/;

const REASONS: Record<string, string> = {
  version_conflict:
    'Someone else changed this page since you opened it. Reload to see their version (your unsaved edits will be lost).',
  event_archived: 'Archived events are read-only. Restore the event to edit its page.',
  nothing_to_publish: 'This version is already published.',
  draft_missing: 'Save the page before publishing it.',
  page_empty: 'Show at least one section before publishing.',
};

function failure(error: unknown): PageActionResult {
  if (error instanceof ApiError) {
    return {
      ok: false,
      message:
        error.fields.length > 0
          ? 'Some sections need attention before saving.'
          : (REASONS[error.reason ?? ''] ??
            (error.status === 403
              ? 'Your role does not allow this.'
              : error.status === 401
                ? 'Your session has ended. Sign in again in another tab, then save.'
                : error.message)),
      ...(error.fields.length > 0 ? { fields: error.fields } : {}),
      ...(error.reason ? { reason: error.reason } : {}),
      ...(error.correlationId ? { reference: error.correlationId } : {}),
    };
  }
  return { ok: false, message: 'Something went wrong. Please try again.' };
}

function checkIds(organizationId: string, eventId: string, idempotencyKey: string): void {
  if (!UUID.test(organizationId) || !UUID.test(eventId) || !KEY.test(idempotencyKey)) {
    throw new Error('Malformed identifiers');
  }
}

const pagePath = (organizationId: string, eventId: string) =>
  `/orgs/${organizationId}/events/${eventId}/page`;

export async function savePageDraftAction(
  organizationId: string,
  eventId: string,
  expectedVersion: number,
  sections: unknown,
  idempotencyKey: string,
): Promise<PageActionResult> {
  try {
    checkIds(organizationId, eventId, idempotencyKey);
    const client = await api();
    const page = unwrap(
      await client.POST('/v1/organizations/{organizationId}/events/{eventId}/page/draft', {
        params: {
          path: { organizationId, eventId },
          header: { 'Idempotency-Key': idempotencyKey },
        },
        // Validated by the API; the editor only produces this shape.
        body: { expectedVersion, sections: sections as EventPage['draft']['sections'] },
      }),
    );
    revalidatePath(pagePath(organizationId, eventId));
    return { ok: true, message: `Draft saved (version ${page.draft.version}).`, page };
  } catch (error) {
    return failure(error);
  }
}

export async function publishPageAction(
  organizationId: string,
  eventId: string,
  expectedVersion: number,
  idempotencyKey: string,
): Promise<PageActionResult> {
  try {
    checkIds(organizationId, eventId, idempotencyKey);
    const client = await api();
    const page = unwrap(
      await client.POST('/v1/organizations/{organizationId}/events/{eventId}/page/publish', {
        params: {
          path: { organizationId, eventId },
          header: { 'Idempotency-Key': idempotencyKey },
        },
        body: { expectedVersion },
      }),
    );
    revalidatePath(pagePath(organizationId, eventId));
    return {
      ok: true,
      message: `Published as revision ${page.published?.revision ?? ''}.`,
      page,
    };
  } catch (error) {
    return failure(error);
  }
}
