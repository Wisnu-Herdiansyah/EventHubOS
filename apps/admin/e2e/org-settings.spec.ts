import { expect, type Page } from '@playwright/test';
import {
  createOrgViaApi,
  expectAccessible,
  joinAs,
  patchOrgViaApi,
  signIn,
  signOut,
  test,
  verifiedAccount,
} from './support';

const section = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

test('an Owner edits the profile and billing contact', async ({ page }) => {
  const owner = await verifiedAccount('settings-owner');
  const orgId = await createOrgViaApi(owner.token, 'Settings Org');
  await signIn(page, owner.email);
  await page.getByRole('main').getByRole('link', { name: 'Settings Org', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings Org' })).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Settings', exact: true }),
  ).toBeVisible();
  await expectAccessible(page);

  // Nothing changed: nothing is sent.
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('No changes to save.')).toBeVisible();

  const profile = section(page, 'Profile');
  await profile.getByLabel('Organization name').fill('Systematic Elegance Co');
  await profile.getByLabel('Legal name').fill('PT Systematic Elegance');
  await profile.getByLabel('Time zone').selectOption('Asia/Singapore');
  await profile.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Organization profile saved.')).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Breadcrumb' })
      .getByRole('link', { name: 'Systematic Elegance Co' }),
  ).toBeVisible();
  await page.reload();
  await expect(profile.getByLabel('Legal name')).toHaveValue('PT Systematic Elegance');
  await expect(profile.getByLabel('Time zone')).toHaveValue('Asia/Singapore');

  // Clearing an optional field removes it.
  await profile.getByLabel('Legal name').fill('');
  await profile.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Organization profile saved.')).toBeVisible();
  await page.reload();
  await expect(profile.getByLabel('Legal name')).toHaveValue('');

  // Billing contact: both parts or neither.
  const billing = section(page, 'Billing contact');
  await billing.getByLabel('Billing contact name').fill('Finance Team');
  await billing.getByRole('button', { name: 'Save billing contact' }).click();
  await expect(billing.getByLabel('Billing contact email')).toHaveAttribute('aria-invalid', 'true');
  await expect(billing.getByLabel('Billing contact name')).toHaveValue('Finance Team');
  await billing.getByLabel('Billing contact email').fill('finance@example.test');
  await billing.getByRole('button', { name: 'Save billing contact' }).click();
  await expect(page.getByText('Billing contact saved.')).toBeVisible();
  await page.reload();
  await expect(billing.getByLabel('Billing contact email')).toHaveValue('finance@example.test');

  await billing.getByLabel('Billing contact name').fill('');
  await billing.getByLabel('Billing contact email').fill('');
  await billing.getByRole('button', { name: 'Save billing contact' }).click();
  await expect(page.getByText('Billing contact removed.')).toBeVisible();
  expect(orgId).toBeTruthy();
});

test('a concurrent edit is reported in plain language and nothing is overwritten', async ({
  page,
}) => {
  const owner = await verifiedAccount('settings-race');
  const orgId = await createOrgViaApi(owner.token, 'Race Org');
  await signIn(page, owner.email);
  await page.goto(`/orgs/${orgId}/settings`);
  const profile = section(page, 'Profile');
  await profile.getByLabel('Organization name').fill('My Edit');

  // Someone else saves first.
  await patchOrgViaApi(owner.token, orgId, { displayName: 'Their Edit' });

  await profile.getByRole('button', { name: 'Save profile' }).click();
  await expect(profile.getByRole('alert')).toContainText(
    'Someone else changed this while you were editing, so nothing was saved.',
  );
  await expect(profile.getByLabel('Organization name')).toHaveValue('My Edit');
  await page.reload();
  await expect(profile.getByLabel('Organization name')).toHaveValue('Their Edit');
});

test('each role sees exactly the settings it may change', async ({ page }) => {
  const owner = await verifiedAccount('roles-owner');
  const orgId = await createOrgViaApi(owner.token, 'Roles Org');
  await patchOrgViaApi(owner.token, orgId, {
    billingContact: { name: 'Finance Team', email: 'finance@example.test' },
  });
  const admin = await joinAs(owner.token, orgId, 'roles-admin', 'admin');
  const billingAdmin = await joinAs(owner.token, orgId, 'roles-billing', 'billing_admin');
  const viewer = await joinAs(owner.token, orgId, 'roles-viewer', 'viewer');

  // Admin: profile editable, billing contact read-only.
  await signIn(page, admin.email);
  await page.goto(`/orgs/${orgId}/settings`);
  await expect(
    section(page, 'Profile').getByRole('button', { name: 'Save profile' }),
  ).toBeVisible();
  const adminBilling = section(page, 'Billing contact');
  await expect(adminBilling).toContainText('finance@example.test');
  await expect(adminBilling.getByRole('button')).toHaveCount(0);
  await signOut(page);

  // Billing admin: billing editable, profile read-only; the organization page works without
  // event access and links to Settings but not Team.
  await signIn(page, billingAdmin.email);
  await page.getByRole('main').getByRole('link', { name: 'Roles Org', exact: true }).click();
  await expect(page.getByText('Events are not part of your role')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Team', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(section(page, 'Profile').getByRole('button')).toHaveCount(0);
  await expect(section(page, 'Profile')).toContainText('Roles Org');
  const billing = section(page, 'Billing contact');
  await billing.getByLabel('Billing contact name').fill('Accounts Payable');
  await billing.getByRole('button', { name: 'Save billing contact' }).click();
  await expect(page.getByText('Billing contact saved.')).toBeVisible();
  await expectAccessible(page);
  await signOut(page);

  // Viewer: no Settings link, no billing data.
  await signIn(page, viewer.email);
  await page.getByRole('main').getByRole('link', { name: 'Roles Org', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Roles Org' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
  await page.goto(`/orgs/${orgId}/settings`);
  await expect(
    page.getByText('Only Owners, Admins and Billing admins can see organization settings.'),
  ).toBeVisible();
  await expect(page.getByText('finance@example.test')).toHaveCount(0);
});

test("another organization's settings page is not found", async ({ page }) => {
  const owner = await verifiedAccount('settings-tenant-a');
  const orgId = await createOrgViaApi(owner.token, 'Settings Tenant A');
  const outsider = await verifiedAccount('settings-tenant-b');
  await signIn(page, outsider.email);
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
  const response = await page.goto(`/orgs/${orgId}/settings`);
  expect(response?.status()).toBe(404);
  await expect(page.getByText('Settings Tenant A')).toHaveCount(0);
});
