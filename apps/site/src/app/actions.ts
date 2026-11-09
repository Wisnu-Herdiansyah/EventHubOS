'use server';

import { headers } from 'next/headers';
import { clientIpFromForwarded } from '@/lib/client-ip';
import { siteConfig } from '@/lib/config';
import { HANDLE, SLUG } from '@/lib/host';

/** What the registration form shows after a submit. */
export interface RegisterState {
  status: 'idle' | 'done' | 'error';
  message?: string;
  fields?: Partial<Record<'name' | 'email' | 'privacyConsent', string>>;
  values?: { name: string; email: string };
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

/** Free registration (ADR-0023). The API applies every rule; this only relays and explains. */
export async function registerAction(
  handle: string,
  eventSlug: string,
  _prev: RegisterState,
  form: FormData,
): Promise<RegisterState> {
  const values = { name: text(form, 'name'), email: text(form, 'email') };
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
    const fields: RegisterState['fields'] = {};
    for (const f of body.error?.details?.fields ?? []) {
      const m = FIELD.exec(f.path);
      if (m) fields[m[1] as 'name' | 'email' | 'privacyConsent'] ??= f.message;
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
      error?: { message?: string };
    };
    if (res.ok) {
      return {
        ok: true,
        message: `Your registration for ${body.eventName ?? 'the event'} is cancelled.`,
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
