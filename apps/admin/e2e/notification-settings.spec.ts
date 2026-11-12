import { expect } from '@playwright/test';
import {
  createOrgViaApi,
  expectAccessible,
  joinAs,
  mailMessage,
  signIn,
  signOut,
  test,
  verifiedAccount,
} from './support';

test('Owners hear about downloads and choose for themselves whether to (ADR-0049)', async ({
  page,
}) => {
  const owner = await verifiedAccount('notice-owner');
  const orgId = await createOrgViaApi(owner.token, 'Notice Org');
  const admin = await joinAs(owner.token, orgId, 'notice-admin', 'admin');

  // An Admin downloads the audit log; the Owner is told who did it.
  await signIn(page, admin.email);
  await page.goto(`/orgs/${orgId}/audit`);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^audit-log-/);
  const mail = await mailMessage(owner.email, 'organization_data_downloaded');
  expect(mail.subject).toBe(`Notice Org: ${admin.email} downloaded the audit log`);
  expect(mail.text).toContain(`/orgs/${orgId}/audit`);
  expect(mail.text).toContain('Turn these emails off:');

  // The Admin's own settings: the alert is on, and only the reminder is always sent.
  await page.goto(`/orgs/${orgId}/settings`);
  const adminCard = page.getByRole('region', { name: 'Email notifications' });
  await expect(adminCard.getByRole('checkbox')).toBeChecked();
  await expect(adminCard.getByRole('listitem')).toHaveText([
    'Reminders to set up two-step verification, while you need it',
  ]);
  await signOut(page);

  // The Owner turns the alert off for themselves; it stays off, and the change is recorded.
  await signIn(page, owner.email);
  await page.goto(`/orgs/${orgId}/settings`);
  const card = page.getByRole('region', { name: 'Email notifications' });
  await expect(card.getByRole('listitem')).toHaveCount(3);
  await expectAccessible(page);
  const box = card.getByRole('checkbox', {
    name: 'Email me when someone downloads an attendee list or the audit log',
  });
  await box.uncheck();
  await card.getByRole('button', { name: 'Save email settings' }).click();
  await expect(card.getByRole('status')).toContainText('You won’t be emailed about downloads');
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Email notifications' }).getByRole('checkbox'),
  ).not.toBeChecked();
  await page.goto(`/orgs/${orgId}/audit`);
  await expect(
    page.getByRole('region', { name: 'Activity' }).getByRole('listitem').first(),
  ).toContainText('Turned off download alert emails for themselves');
});

test('people without optional notices see no email settings card', async ({ page }) => {
  const owner = await verifiedAccount('notice-none-owner');
  const orgId = await createOrgViaApi(owner.token, 'Quiet Org');
  const billing = await joinAs(owner.token, orgId, 'notice-billing', 'billing_admin');
  await signIn(page, billing.email);
  await page.goto(`/orgs/${orgId}/settings`);
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Email notifications' })).toHaveCount(0);
});
