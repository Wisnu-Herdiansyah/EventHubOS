'use server';

import { headers } from 'next/headers';
import { clientIpFromForwarded } from '@/lib/client-ip';
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
  const ip = clientIpFromForwarded(h.get('x-forwarded-for'), siteConfig().trustedProxyHops);
  return ip ? { 'x-forwarded-for': ip } : {};
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
      error?: { message?: string };
    };
    if (res.ok) {
      const event = body.eventName ?? 'the event';
      return {
        ok: true,
        message: body.wasWaitlisted
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
