import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page } from '@playwright/test';

export const API_URL = process.env.E2E_API_URL ?? '';
const MAIL_DIR = process.env.E2E_MAIL_DIR ?? '';
export const PASSWORD = 'Systematic elegance 2027!'; // pragma: allowlist secret

/** A random address in 198.18.0.0/15 (reserved for benchmarking), one simulated client each. */
export function testClientIp(): string {
  const b = randomBytes(3);
  return `198.${18 + (b[0]! % 2)}.${b[1]}.${b[2]}`;
}

/**
 * Each test browses from its own simulated client IP, sent the way a load balancer would. The
 * harness runs the admin app with ADMIN_TRUSTED_PROXY_HOPS=1, so the API's per-IP limits see one
 * client per test instead of every login coming from the admin server's address.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': testClientIp() });
    await use(page);
  },
});

export function uniqueEmail(label: string): string {
  return `${label}-${randomUUID()}@example.test`;
}

interface Mail {
  to: string;
  template: string;
  text: string;
}

/** Waits for the worker to write an email for `to` and returns the link it contains. */
export async function mailLink(to: string, template: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const file of await readdir(MAIL_DIR).catch(() => [] as string[])) {
      let mail: Mail;
      try {
        mail = JSON.parse(await readFile(join(MAIL_DIR, file), 'utf8')) as Mail;
      } catch {
        // The worker may still be writing this file (writes are not atomic); retry next poll.
        continue;
      }
      if (mail.to === to && mail.template === template) {
        const link = /https?:\/\/\S+#token=[A-Za-z0-9_-]{43}/.exec(mail.text)?.[0];
        if (link) return link;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No ${template} email arrived for ${to}`);
}

async function apiCall<T>(method: string, path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `e2e-${randomUUID()}`,
      // The API trusts the harness host as a proxy, so fixtures act as separate clients.
      'x-forwarded-for': testClientIp(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * Redeems an emailed token. The worker sends the email inside the transaction that stores the
 * token's hash (ADR-0008: retry-stable delivery), so for a few milliseconds the link exists before
 * the token is committed. People never notice; a test reading the mail file can. Retry briefly;
 * a token that is really invalid still fails after the deadline.
 */
async function redeemToken<T>(path: string, token: string, bearer?: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return await apiCall<T>('POST', path, { token }, bearer);
    } catch (error) {
      if (Date.now() > deadline || !/-> 400: .*invalid/i.test(String(error))) throw error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** Fixture shortcut: a verified account created through the API (the UI flow has its own test). */
export async function verifiedAccount(label: string): Promise<{ email: string; token: string }> {
  const email = uniqueEmail(label);
  await apiCall('POST', '/v1/auth/signup', { email, password: PASSWORD });
  const link = await mailLink(email, 'verify_email');
  const token = link.split('#token=')[1];
  await redeemToken('/v1/auth/verify-email', token!);
  const session = await apiCall<{ token: string }>('POST', '/v1/auth/login', {
    email,
    password: PASSWORD,
  });
  return { email, token: session.token };
}

export async function createOrgViaApi(token: string, displayName: string): Promise<string> {
  const org = await apiCall<{ id: string }>(
    'POST',
    '/v1/organizations',
    { displayName, locale: 'en', timezone: 'Asia/Jakarta' },
    token,
  );
  return org.id;
}

export async function createEventViaApi(token: string, orgId: string): Promise<string> {
  const evt = await apiCall<{ id: string }>(
    'POST',
    `/v1/organizations/${orgId}/events`,
    {
      name: 'Private Summit',
      slug: `private-${randomUUID().slice(0, 8)}`,
      timezone: 'Asia/Jakarta',
      startsAt: '2027-03-01T02:00:00Z',
      endsAt: '2027-03-01T10:00:00Z',
      primaryLanguage: 'en',
      venueMode: 'in_person',
    },
    token,
  );
  return evt.id;
}

export async function inviteViaApi(
  token: string,
  orgId: string,
  email: string,
  role: string,
): Promise<void> {
  await apiCall('POST', `/v1/organizations/${orgId}/invitations`, { email, role }, token);
}

export async function signIn(page: Page, email: string, next?: string): Promise<void> {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Signed in once the browser has left the sign-in page (the session cookie is set by then).
  await page.waitForURL((url) => url.pathname !== '/login');
}

/** WCAG 2.x A/AA automated checks. Automated scans catch only part of the issues. */
export async function expectAccessible(page: Page): Promise<void> {
  // Next.js streams page metadata, so the <title> can land just after the content. Every page
  // must end up with a proper title; wait for it before scanning.
  await expect(page).toHaveTitle(/\S.* · EventHub OS$|^EventHub OS$/);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

/** The invitee accepts through the API, using the token from their invitation email. */
export async function acceptInvitationViaApi(inviteeEmail: string, inviteeToken: string) {
  const link = await mailLink(inviteeEmail, 'organization_invitation');
  await redeemToken('/v1/invitations/accept', link.split('#token=')[1]!, inviteeToken);
}

export async function joinAs(
  ownerToken: string,
  orgId: string,
  label: string,
  role: string,
): Promise<{ email: string; token: string }> {
  const member = await verifiedAccount(label);
  await inviteViaApi(ownerToken, orgId, member.email, role);
  await acceptInvitationViaApi(member.email, member.token);
  return member;
}

/** Changes an organization through the API, as another person editing at the same time would. */
export async function patchOrgViaApi(
  token: string,
  orgId: string,
  changes: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${API_URL}/v1/organizations/${orgId}`, {
    headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': testClientIp() },
  });
  const { version } = (await res.json()) as { version: number };
  await apiCall(
    'PATCH',
    `/v1/organizations/${orgId}`,
    { expectedVersion: version, ...changes },
    token,
  );
}
