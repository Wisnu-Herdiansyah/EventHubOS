import { randomBytes } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import {
  apiCall,
  axeScan,
  createEventViaApi,
  createOrgViaApi,
  expectAccessible,
  signIn,
  test,
  verifiedAccount,
} from './support';

const TEMPLATE = process.env.E2E_SITE_URL_TEMPLATE ?? '';
const READY = {
  visibility: 'public',
  sharing: { title: 'Jakarta Summit 2027', description: 'Two days of operations and branding.' },
  legal: { privacyPolicyUrl: 'https://example.com/privacy' },
};

/** A scheduled event (via the API) ready for its page to be published. */
async function scheduledEvent(label: string) {
  const owner = await verifiedAccount(label);
  const orgId = await createOrgViaApi(owner.token, `${label} Org`);
  const eventId = await createEventViaApi(owner.token, orgId);
  const evt = await apiCall<{ version: number; slug: string }>(
    'PATCH',
    `/v1/organizations/${orgId}/events/${eventId}`,
    { expectedVersion: 1, settings: READY },
    owner.token,
  );
  await apiCall(
    'POST',
    `/v1/organizations/${orgId}/events/${eventId}/transitions`,
    {
      to: 'scheduled',
      expectedVersion: evt.version,
      acknowledgedWarnings: ['contact.details', 'registration.window', 'legal.terms'],
    },
    owner.token,
  );
  return { owner, orgId, eventId, slug: evt.slug };
}

const eventPage = (page: Page, orgId: string, eventId: string) =>
  page.goto(`/orgs/${orgId}/events/${eventId}`);

test('an organizer publishes the event and visitors see the published page only', async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const t = await scheduledEvent('public');
  const handle = `site-${randomBytes(4).toString('hex')}`;
  await signIn(page, t.owner.email);

  // Not ready yet: the event page says exactly what is missing.
  await eventPage(page, t.orgId, t.eventId);
  const lifecycle = page.getByRole('region', { name: 'Lifecycle' });
  await expect(lifecycle).toContainText('Publish a revision of the microsite.');
  await expect(lifecycle).toContainText('Choose a public address for the organization.');
  await expect(page.getByRole('button', { name: 'Publish event' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Public page' })).toContainText('Not public.');

  // Choose the organization's public address.
  await page.goto(`/orgs/${t.orgId}/settings`);
  const address = page.getByRole('region', { name: 'Public address' });
  await expect(address).toContainText(`${TEMPLATE.replace('{handle}', 'your-handle')}/event-slug`);
  await address.getByLabel('Public handle').fill(handle.toUpperCase());
  await address.getByRole('button', { name: 'Save public address' }).click();
  await expect(page.getByText('Public address saved.')).toBeVisible();
  await expect(address).toContainText(TEMPLATE.replace('{handle}', handle));
  await expectAccessible(page);

  // Publish a page revision.
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}/page`);
  const editor = page.locator('.builder');
  await editor.getByRole('button', { name: /^Private Summit/ }).click();
  await editor.getByLabel('Heading').fill('Welcome to the summit');
  await editor.getByRole('button', { name: 'Hide Speakers' }).click();
  await editor.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved (version 1).')).toBeVisible();
  await editor.getByRole('button', { name: 'Publish…' }).click();
  await page.getByRole('button', { name: 'Publish revision 1' }).click();
  await expect(page.getByText('Published as revision 1.')).toBeVisible();

  // Publish the event.
  await eventPage(page, t.orgId, t.eventId);
  await page.getByRole('button', { name: 'Publish event' }).click();
  await expect(page.getByText('Published', { exact: true }).first()).toBeVisible();
  const card = page.getByRole('region', { name: 'Public page' });
  const url = `${TEMPLATE.replace('{handle}', handle)}/${t.slug}`;
  await expect(card.getByRole('link', { name: new RegExp(url) })).toHaveAttribute('href', url);
  await expectAccessible(page);

  // A visitor (no session, separate cookies) opens the public page.
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  const res = await visitor.goto(url);
  expect(res?.status()).toBe(200);
  await expect(visitor).toHaveTitle('Jakarta Summit 2027');
  await expect(visitor.getByRole('heading', { level: 1, name: 'Private Summit' })).toBeVisible();
  await expect(visitor.getByRole('heading', { name: 'Welcome to the summit' })).toBeVisible();
  await expect(visitor.getByRole('heading', { name: 'Speakers' })).toHaveCount(0);
  await expect(visitor.locator('meta[name="robots"]')).toHaveAttribute('content', 'index, follow');
  expect(res?.headers()['content-security-policy']).toContain("form-action 'self'");
  expect(res?.headers()['set-cookie']).toBeUndefined();
  await axeScan(visitor);

  // Draft edits stay private until published again.
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}/page`);
  await editor.getByRole('button', { name: /^Welcome to the summit/ }).click();
  await editor.getByLabel('Heading').fill('A draft nobody should see');
  await editor.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved (version 2).')).toBeVisible();
  await visitor.reload();
  await expect(visitor.getByRole('heading', { name: 'Welcome to the summit' })).toBeVisible();
  await expect(visitor.getByText('A draft nobody should see')).toHaveCount(0);

  // Taking the event offline closes the public page.
  await eventPage(page, t.orgId, t.eventId);
  await page.getByRole('button', { name: 'Take offline' }).click();
  await expect(page.getByText('Scheduled', { exact: true }).first()).toBeVisible();
  expect((await visitor.goto(url))?.status()).toBe(404);
  await expect(visitor.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await visitorContext.close();
});

test('unknown addresses are not found and reveal nothing', async ({ page }) => {
  const host = TEMPLATE.replace('{handle}', `nobody-${randomBytes(3).toString('hex')}`);
  expect((await page.goto(`${host}/some-event`))?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  expect((await page.goto(`${host}/`))?.status()).toBe(404);
  // Internal routes cannot be addressed directly.
  expect((await page.goto(`${host}/s/nobody/some-event`))?.status()).toBe(404);
  // The bare platform host has no handle.
  expect((await page.goto(TEMPLATE.replace('{handle}.', '') + '/x'))?.status()).toBe(404);
});
