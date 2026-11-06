import { expect, type Page } from '@playwright/test';
import {
  createEventViaApi,
  createOrgViaApi,
  expectAccessible,
  joinAs,
  patchOrgViaApi,
  signIn,
  test,
  verifiedAccount,
} from './support';

const entries = (page: Page) =>
  page.getByRole('region', { name: 'Activity' }).getByRole('listitem');

async function applyFilters(page: Page) {
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await page.waitForURL(/\/audit\?/);
}

test('an Owner reads activity in plain language and narrows it down', async ({ page }) => {
  const owner = await verifiedAccount('audit-owner');
  const orgId = await createOrgViaApi(owner.token, 'Audit Org');
  const teammate = await joinAs(owner.token, orgId, 'audit-mate', 'viewer');
  const eventId = await createEventViaApi(owner.token, orgId);
  await patchOrgViaApi(owner.token, orgId, { displayName: 'Audit Org Renamed' });

  await signIn(page, owner.email);
  await page.getByRole('link', { name: 'Audit Org Renamed', exact: true }).click();
  await page.getByRole('link', { name: 'Audit log', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();

  const all = entries(page);
  await expect(all).toHaveCount(5);
  await expect(all.nth(0)).toContainText("Changed the organization's name");
  await expect(page.getByText('Created the event Private Summit')).toBeVisible();
  await expect(page.getByText('Joined as Viewer')).toBeVisible();
  await expect(page.getByText(/Invited \S+@example\.test as Viewer/)).toBeVisible();
  await expect(page.getByText('Created the organization')).toBeVisible();
  // Invitee addresses are stored masked; the full address never appears in a record summary.
  await expect(all.filter({ hasText: 'Invited' })).not.toContainText(teammate.email);
  await expectAccessible(page);

  // Category.
  await page.getByLabel('Category').selectOption('membership.');
  await applyFilters(page);
  await expect(all).toHaveCount(2);
  await expect(page.getByText('Created the organization')).toHaveCount(0);

  // Person (keeps the category until cleared).
  await page.getByRole('link', { name: 'Clear filters' }).click();
  await expect(all).toHaveCount(5);
  await page.getByLabel('Person').selectOption({ label: teammate.email });
  await applyFilters(page);
  await expect(all).toHaveCount(1);
  await expect(all.first()).toContainText('Joined as Viewer');
  await expect(all.first()).toContainText(teammate.email);

  // A date range before anything happened.
  await page.getByRole('link', { name: 'Clear filters' }).click();
  await page.getByLabel('To').fill('2020-01-01');
  await applyFilters(page);
  await expect(page.getByText('No activity matches these filters.')).toBeVisible();

  // One object's history, from the event page.
  await page.goto(`/orgs/${orgId}/events/${eventId}`);
  await page.getByRole('link', { name: 'View history' }).click();
  await expect(page.getByText('Showing the history of Private Summit.')).toBeVisible();
  await expect(all).toHaveCount(1);
  await expect(all.first()).toContainText('Created the event Private Summit');
  await page.getByRole('link', { name: 'Show all activity' }).click();
  await expect(all).toHaveCount(5);

  // A malformed link is not passed on to the API.
  await page.goto(`/orgs/${orgId}/audit?category=identity.&actorId=nope&from=2027-02-31`);
  await expect(
    page.getByText('Some filters in the link were not valid and were ignored.'),
  ).toBeVisible();
  await expect(all).toHaveCount(5);
});

test('long histories page through older entries', async ({ page }) => {
  const owner = await verifiedAccount('audit-pages');
  const orgId = await createOrgViaApi(owner.token, 'Paged Org');
  for (let i = 1; i <= 52; i += 1) {
    await patchOrgViaApi(owner.token, orgId, { displayName: `Paged Org ${i}` });
  }
  await signIn(page, owner.email);
  await page.goto(`/orgs/${orgId}/audit`);
  const all = entries(page);
  await expect(all).toHaveCount(50);
  await expect(page.getByText('Created the organization')).toHaveCount(0);
  await page.getByRole('link', { name: 'Older entries' }).click();
  await expect(all).toHaveCount(3);
  await expect(page.getByText('Created the organization')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Older entries' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to newest' }).click();
  await expect(all).toHaveCount(50);
});

test('only Owners and Admins can read the audit log', async ({ page }) => {
  const owner = await verifiedAccount('audit-roles');
  const orgId = await createOrgViaApi(owner.token, 'Audit Roles Org');
  const admin = await joinAs(owner.token, orgId, 'audit-admin', 'admin');
  const manager = await joinAs(owner.token, orgId, 'audit-manager', 'event_manager');

  await signIn(page, admin.email);
  await page.goto(`/orgs/${orgId}/audit`);
  await expect(page.getByText('Created the organization')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();

  await signIn(page, manager.email);
  await page.getByRole('link', { name: 'Audit Roles Org', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Audit Roles Org' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Audit log', exact: true })).toHaveCount(0);
  await page.goto(`/orgs/${orgId}/audit`);
  await expect(page.getByText('Only Owners and Admins can see the audit log.')).toBeVisible();
  await expect(page.getByText('Created the organization')).toHaveCount(0);
});

test("another organization's audit log is not found", async ({ page }) => {
  const owner = await verifiedAccount('audit-tenant-a');
  const orgId = await createOrgViaApi(owner.token, 'Audit Tenant A');
  const outsider = await verifiedAccount('audit-tenant-b');
  await signIn(page, outsider.email);
  const response = await page.goto(`/orgs/${orgId}/audit`);
  expect(response?.status()).toBe(404);
  await expect(page.getByText('Created the organization')).toHaveCount(0);
});
