import { expect } from '@playwright/test';
import {
  createEventViaApi,
  createOrgViaApi,
  PASSWORD,
  signIn,
  test,
  verifiedAccount,
} from './support';

test.describe('session cookie', () => {
  test('is HttpOnly, Secure, SameSite=Lax, host-only and invisible to page scripts', async ({
    page,
    context,
  }) => {
    const user = await verifiedAccount('cookie');
    await signIn(page, user.email);
    await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();

    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === '__Host-eventhub_session');
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect(session?.domain).toBe('localhost');
    expect(await page.evaluate(() => document.cookie)).not.toContain('eventhub_session');
  });
});

test.describe('response headers', () => {
  test('a fresh nonce-based CSP per response, applied to every script', async ({
    page,
    request,
  }) => {
    const first = await request.get('/login');
    const second = await request.get('/login');
    const csp = first.headers()['content-security-policy'] ?? '';
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(second.headers()['content-security-policy']).not.toBe(csp);

    const headers = first.headers();
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-powered-by']).toBeUndefined();

    // Every script on the page carries this response's nonce, and nothing is blocked by CSP.
    const violations: string[] = [];
    page.on('console', (m) => {
      if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
    });
    const response = await page.goto('/login');
    const pageNonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(
      response?.headers()['content-security-policy'] ?? '',
    )?.[1];
    const scriptNonces = await page
      .locator('script')
      .evaluateAll((els) => els.map((e) => (e as HTMLScriptElement).nonce));
    expect(scriptNonces.length).toBeGreaterThan(0);
    for (const n of scriptNonces) expect(n).toBe(pageNonce);
    // The page is interactive (hydrated) under the CSP.
    await page.getByLabel('Email').fill('x@example.test');
    expect(violations).toEqual([]);
  });
});

test.describe('access control', () => {
  test('signed-out visitors are sent to sign in, then back to where they were going', async ({
    page,
  }) => {
    const user = await verifiedAccount('returning');
    const orgId = await createOrgViaApi(user.token, 'Return Path Org');
    await page.goto(`/orgs/${orgId}`);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Forgs%2F${orgId}`));
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Return Path Org' })).toBeVisible();
  });

  test('the post-login redirect never leaves this site', async ({ page }) => {
    const user = await verifiedAccount('redirect');
    for (const next of ['https://evil.example/', '//evil.example/', '/\\evil.example']) {
      await page.context().clearCookies();
      await signIn(page, user.email, next);
      await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
      expect(new URL(page.url()).host).toBe(new URL(process.env.E2E_BASE_URL!).host);
    }
  });

  test("another organization's pages and events are not found", async ({ page }) => {
    const owner = await verifiedAccount('tenant-a');
    const orgId = await createOrgViaApi(owner.token, 'Tenant A');
    const eventId = await createEventViaApi(owner.token, orgId);

    const outsider = await verifiedAccount('tenant-b');
    await signIn(page, outsider.email);
    await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();

    for (const path of [`/orgs/${orgId}`, `/orgs/${orgId}/events/${eventId}`]) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(404);
      await expect(page.getByText('Tenant A')).toHaveCount(0);
      await expect(page.getByText('Private Summit')).toHaveCount(0);
    }
  });

  test('Server Actions refuse cross-origin requests', async ({ page, request }) => {
    const user = await verifiedAccount('csrf');
    await signIn(page, user.email);
    await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
    // Capture a real Server Action call (sign out) to learn its action id.
    let actionId = '';
    page.on('request', (r) => {
      const id = r.headers()['next-action'];
      if (id) actionId = id;
    });
    const cookies = await page.context().cookies();
    await page.route('**/*', (route) =>
      route.request().headers()['next-action'] ? route.abort() : route.continue(),
    );
    // Sign out from the account menu; the aborted request never navigates.
    await page.getByRole('button', { name: /account menu$/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect.poll(() => actionId).not.toBe('');

    const session = cookies.find((c) => c.name === '__Host-eventhub_session');
    const forged = await request.post('/', {
      headers: {
        'next-action': actionId,
        origin: 'https://evil.example',
        cookie: `__Host-eventhub_session=${session?.value ?? ''}`,
        'content-type': 'text/plain;charset=UTF-8',
      },
      data: '[]',
      maxRedirects: 0,
    });
    expect(forged.status()).toBeGreaterThanOrEqual(400);

    // The session survived: the forged sign-out did nothing.
    await page.unroute('**/*');
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
  });
});
