'use server';

import { headers } from 'next/headers';
import { visitorHeaders } from '@/lib/client-ip';
import { siteConfig } from '@/lib/config';
import { HANDLE, SLUG } from '@/lib/host';
import type { Question } from '@/lib/public-api';

/** What the registration form shows after a submit. */
export interface RegisterState {
  status: 'idle' | 'done' | 'error';
  message?: string;
  /** Errors by field: name, email, privacyConsent, or `q-<question id>`. */
  fields?: Record<string, string>;
  /** What was typed, by field name, so a failed submit keeps it. */
  values?: Record<string, string>;
}

async function forwardedFor(): Promise<Record<string, string>> {
  const h = await headers();
  const { trustedProxyHops, visitorAddressKey } = siteConfig();
  return visitorHeaders(h.get('x-forwarded-for'), trustedProxyHops, visitorAddressKey);
}

const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === 'string' ? v.slice(0, 400) : '';
};

const FIELD = /^body\.(name|email|privacyConsent)$/;
const ANSWER = /^body\.answers\.([a-z0-9-]{1,40})$/;

/**
 * Answers from the form (ADR-0041): text and choices as strings, yes/no as booleans (left out
 * when not chosen). The API checks them against the event's own questions.
 */
function answersFrom(questions: Question[], form: FormData): Record<string, string | boolean> {
  const answers: Record<string, string | boolean> = {};
  for (const q of questions.slice(0, 10)) {
    const raw = form.get(`q-${q.id}`);
    if (typeof raw !== 'string') continue;
    if (q.type === 'yes_no') {
      if (raw === 'yes' || raw === 'no') answers[q.id] = raw === 'yes';
    } else {
      answers[q.id] = raw.slice(0, 2000);
    }
  }
  return answers;
}

/** Free registration (ADR-0023). The API applies every rule; this only relays and explains. */
export async function registerAction(
  handle: string,
  eventSlug: string,
  questions: Question[],
  _prev: RegisterState,
  form: FormData,
): Promise<RegisterState> {
  const values: Record<string, string> = { name: text(form, 'name'), email: text(form, 'email') };
  for (const q of questions.slice(0, 10)) {
    const v = form.get(`q-${q.id}`);
    if (typeof v === 'string') values[`q-${q.id}`] = v.slice(0, 2000);
  }
  if (!HANDLE.test(handle) || !SLUG.test(eventSlug)) {
    return { status: 'error', message: 'This page is not available.' };
  }
  try {
    const res = await fetch(
      `${siteConfig().apiUrl}/v1/public/sites/${handle}/events/${eventSlug}/registrations`,
      {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', ...(await forwardedFor()) },
        body: JSON.stringify({
          name: values.name,
          email: values.email,
          privacyConsent: form.get('privacyConsent') === 'yes',
          website: text(form, 'website'),
          ...(questions.length > 0 ? { answers: answersFrom(questions, form) } : {}),
        }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      message?: string;
      error?: {
        message?: string;
        details?: { reason?: string; fields?: Array<{ path: string; message: string }> };
      };
    };
    if (res.status === 202) return { status: 'done', message: body.message };
    const fields: Record<string, string> = {};
    for (const f of body.error?.details?.fields ?? []) {
      const m = FIELD.exec(f.path);
      if (m) fields[m[1]!] ??= f.message;
      const a = ANSWER.exec(f.path);
      if (a) fields[`q-${a[1]}`] ??= f.message;
    }
    if (Object.keys(fields).length > 0) {
      return { status: 'error', message: 'Check the highlighted fields.', fields, values };
    }
    if (res.status === 429) {
      return { status: 'error', message: 'Too many attempts. Please wait a minute.', values };
    }
    return {
      status: 'error',
      message: body.error?.message ?? 'Registration is not available right now.',
      values,
    };
  } catch {
    return { status: 'error', message: 'Something went wrong. Please try again.', values };
  }
}

export async function cancelRegistrationAction(
  token: string,
): Promise<{ ok: boolean; message: string }> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return { ok: false, message: 'This link is incomplete. Open it from your email again.' };
  }
  try {
    const res = await fetch(`${siteConfig().apiUrl}/v1/public/registrations/cancel`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(await forwardedFor()) },
      body: JSON.stringify({ token }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      eventName?: string;
      wasWaitlisted?: boolean;
      wasPending?: boolean;
      error?: { message?: string };
    };
    if (res.ok) {
      const event = body.eventName ?? 'the event';
      return {
        ok: true,
        message: body.wasPending
          ? `You’ve withdrawn your request for ${event}.`
          : body.wasWaitlisted
            ? `You’ve left the waitlist for ${event}.`
            : `Your registration for ${event} is cancelled.`,
      };
    }
    return {
      ok: false,
      message: body.error?.message ?? 'This link is no longer valid.',
    };
  } catch {
    return { ok: false, message: 'Something went wrong. Please try again.' };
  }
}

/** What a feedback link is for (ADR-0063). */
export interface FeedbackLink {
  eventName: string;
  organizationName: string;
  answered: boolean;
}
const FEEDBACK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export async function feedbackLinkAction(token: string): Promise<FeedbackLink | { error: string }> {
  if (!FEEDBACK_TOKEN.test(token)) {
    return { error: 'This link is incomplete. Open it from your email again.' };
  }
  try {
    const res = await fetch(`${siteConfig().apiUrl}/v1/public/feedback/lookup`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(await forwardedFor()) },
      body: JSON.stringify({ token }),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<FeedbackLink> & {
      error?: { message?: string };
    };
    if (res.ok && body.eventName && body.organizationName) {
      return {
        eventName: body.eventName,
        organizationName: body.organizationName,
        answered: body.answered === true,
      };
    }
    if (res.status === 429) return { error: 'Too many attempts. Please wait a minute.' };
    return { error: body.error?.message ?? 'This link is no longer valid.' };
  } catch {
    return { error: 'Something went wrong. Please try again.' };
  }
}

export async function submitFeedbackAction(
  token: string,
  rating: number,
  comment: string,
): Promise<{ ok: boolean; message: string }> {
  if (!FEEDBACK_TOKEN.test(token)) {
    return { ok: false, message: 'This link is incomplete. Open it from your email again.' };
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, message: 'Choose a rating.' };
  }
  const text = typeof comment === 'string' ? comment.slice(0, 2000) : '';
  try {
    const res = await fetch(`${siteConfig().apiUrl}/v1/public/feedback`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(await forwardedFor()) },
      body: JSON.stringify({ token, rating, ...(text.trim() ? { comment: text } : {}) }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      eventName?: string;
      error?: { message?: string };
    };
    if (res.ok) {
      return {
        ok: true,
        message: `Thank you. Your feedback on ${body.eventName ?? 'the event'} has been sent.`,
      };
    }
    if (res.status === 429)
      return { ok: false, message: 'Too many attempts. Please wait a minute.' };
    return { ok: false, message: body.error?.message ?? 'This link is no longer valid.' };
  } catch {
    return { ok: false, message: 'Something went wrong. Please try again.' };
  }
}

/** A person's own entry, as the "change your details" page shows it (ADR-0065). */
export interface OwnDetails {
  eventName: string;
  organizationName: string;
  status: 'confirmed' | 'waitlisted' | 'pending';
  name: string;
  answers: Record<string, string | boolean>;
  questions: Question[];
}
const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CLOSED_LINK =
  'This link can no longer be used to change your details. The event may have ended, or the registration was cancelled.';

export async function registrationDetailsAction(
  token: string,
): Promise<OwnDetails | { error: string }> {
  if (!LINK_TOKEN.test(token)) {
    return { error: 'This link is incomplete. Open it from your email again.' };
  }
  try {
    const res = await fetch(`${siteConfig().apiUrl}/v1/public/registrations/details`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(await forwardedFor()) },
      body: JSON.stringify({ token }),
    });
    if (res.status === 429) return { error: 'Too many attempts. Please wait a minute.' };
    if (!res.ok) return { error: CLOSED_LINK };
    return (await res.json()) as OwnDetails;
  } catch {
    return { error: 'Something went wrong. Please try again.' };
  }
}

/** What the "change your details" form shows after a save. */
export interface DetailsState {
  status: 'idle' | 'done' | 'error';
  message?: string;
  /** Errors by field: name, or `q-<question id>`. */
  fields?: Record<string, string>;
  values?: Record<string, string>;
}

export async function saveRegistrationDetailsAction(
  token: string,
  questions: Question[],
  _prev: DetailsState,
  form: FormData,
): Promise<DetailsState> {
  const values: Record<string, string> = { name: text(form, 'name') };
  for (const q of questions.slice(0, 10)) {
    const v = form.get(`q-${q.id}`);
    if (typeof v === 'string') values[`q-${q.id}`] = v.slice(0, 2000);
  }
  if (!LINK_TOKEN.test(token)) {
    return { status: 'error', message: 'This link is incomplete. Open it from your email again.' };
  }
  try {
    const res = await fetch(`${siteConfig().apiUrl}/v1/public/registrations/details/update`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(await forwardedFor()) },
      body: JSON.stringify({
        token,
        name: values.name,
        ...(questions.length > 0 ? { answers: answersFrom(questions, form) } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      changed?: boolean;
      error?: { details?: { fields?: Array<{ path: string; message: string }> } };
    };
    if (res.ok) {
      return {
        status: 'done',
        message: body.changed
          ? 'Your details are saved.'
          : 'Nothing changed: your details were already like this.',
        values,
      };
    }
    const fields: Record<string, string> = {};
    for (const f of body.error?.details?.fields ?? []) {
      if (f.path === 'body.name') fields.name ??= f.message;
      const a = ANSWER.exec(f.path);
      if (a) fields[`q-${a[1]}`] ??= f.message;
    }
    if (Object.keys(fields).length > 0) {
      return { status: 'error', message: 'Check the highlighted fields.', fields, values };
    }
    if (res.status === 429) {
      return { status: 'error', message: 'Too many attempts. Please wait a minute.', values };
    }
    return { status: 'error', message: CLOSED_LINK, values };
  } catch {
    return { status: 'error', message: 'Something went wrong. Please try again.', values };
  }
}
