import { createHmac, randomBytes, randomUUID } from 'node:crypto';
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

/** Waits for the worker to write an email for `to` and returns its subject and text. */
export async function mailMessage(
  to: string,
  template: string,
): Promise<{ subject: string; text: string }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const file of await readdir(MAIL_DIR).catch(() => [] as string[])) {
      try {
        const mail = JSON.parse(await readFile(join(MAIL_DIR, file), 'utf8')) as Mail & {
          subject: string;
        };
        if (mail.to === to && mail.template === template) return mail;
      } catch {
        // Still being written; picked up on the next poll.
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No ${template} email arrived for ${to}`);
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

export async function apiCall<T>(
  method: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<T> {
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
  await axeScan(page);
}

/** The axe scan alone, for pages with their own titles (public event sites). */
export async function axeScan(page: Page): Promise<void> {
  // Let opening transitions (dialogs, drawers) finish: mid-fade colours are not the real ones.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  // On failure, say why (axe's own summary, e.g. which element covers a button) and how big the
  // element was, so a CI-only failure can be diagnosed from the log alone.
  const details: string[] = [];
  for (const v of results.violations) {
    for (const n of v.nodes) {
      const box = await page
        .locator(n.target.join(' '))
        .first()
        .boundingBox()
        .catch(() => null);
      details.push(
        `${v.id}: ${n.target.join(' ')}\n  ${(n.failureSummary ?? '').replace(/\n/g, '\n  ')}\n  box: ${JSON.stringify(box)}\n  viewport: ${JSON.stringify(page.viewportSize())}`,
      );
    }
  }
  expect(details).toEqual([]);
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

/** An account that signed up but has not verified its email yet. */
export async function unverifiedAccount(label: string): Promise<{ email: string }> {
  const email = uniqueEmail(label);
  await apiCall('POST', '/v1/auth/signup', { email, password: PASSWORD });
  return { email };
}

/** Waits until `count` emails of a template reached `to`, and returns their links. */
export async function mailLinks(to: string, template: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const links: string[] = [];
    for (const file of await readdir(MAIL_DIR).catch(() => [] as string[])) {
      try {
        const mail = JSON.parse(await readFile(join(MAIL_DIR, file), 'utf8')) as Mail;
        const link = /https?:\/\/\S+#token=[A-Za-z0-9_-]{43}/.exec(mail.text)?.[0];
        if (mail.to === to && mail.template === template && link) links.push(link);
      } catch {
        // Still being written; picked up on the next poll.
      }
    }
    if (links.length >= count) return links;
    if (Date.now() > deadline) throw new Error(`Expected ${count} ${template} emails for ${to}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Pretends every session of `email` last made a request `minutes` ago (test database only). */
export async function lastActiveMinutesAgo(email: string, minutes: number): Promise<void> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: process.env.E2E_FIXTURE_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `UPDATE eventhub.auth_session s SET last_seen_at = now() - make_interval(mins => $2)
         FROM eventhub.app_user u
        WHERE u.id = s.user_id AND u.email = $1 AND s.revoked_at IS NULL`,
      [email, minutes],
    );
  } finally {
    await client.end();
  }
}

/** Signs out from the account menu in the top bar. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /account menu$/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL((url) => url.pathname === '/login');
}

/**
 * The 6-digit code an authenticator app would show for a base32 key (RFC 6238), `offset` steps
 * from now. Tests use later steps because each step is accepted only once.
 */
export function totpFromKey(key: string, offset = 0): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of key.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const o = mac[mac.length - 1]! & 0x0f;
  const n = ((mac[o]! & 0x7f) << 24) | (mac[o + 1]! << 16) | (mac[o + 2]! << 8) | mac[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
}

/**
 * Turns on two-step verification through the API and returns the authenticator key. Confirming
 * signs out the account's other sessions, browsers included. The confirming code's step is spent,
 * so the next sign-in uses `totpFromKey(key, 1)`.
 */
export async function enableMfaViaApi(token: string): Promise<string> {
  const setup = await apiCall<{ secret: string }>(
    'POST',
    '/v1/auth/mfa/setup',
    { currentPassword: PASSWORD },
    token,
  );
  await apiCall('POST', '/v1/auth/mfa/confirm', { code: totpFromKey(setup.secret) }, token);
  return setup.secret;
}

/** Signs in an account that has two-step verification on. */
export async function signInWithCode(page: Page, email: string, key: string): Promise<void> {
  await signIn(page, email);
  await page.getByLabel('Verification code').fill(totpFromKey(key, 1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}
