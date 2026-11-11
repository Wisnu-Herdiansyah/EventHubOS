import { expect } from '@playwright/test';
import {
  createEventViaApi,
  createOrgViaApi,
  enableMfaViaApi,
  expectAccessible,
  joinAs,
  mailMessage,
  signIn,
  signInWithCode,
  signOut,
  test,
  verifiedAccount,
} from './support';

test('an Owner requires two-step verification; an Admin without it is held at an explanation', async ({
  page,
}) => {
  const owner = await verifiedAccount('require-mfa-owner');
  const orgId = await createOrgViaApi(owner.token, 'Secure Org');
  await createEventViaApi(owner.token, orgId);
  const admin = await joinAs(owner.token, orgId, 'require-mfa-admin', 'admin');
  const manager = await joinAs(owner.token, orgId, 'require-mfa-manager', 'event_manager');

  // Without two-step verification of their own, the Owner cannot require it.
  await signIn(page, owner.email);
  await page.goto(`/orgs/${orgId}/settings`);
  const security = page.getByRole('region', { name: 'Security', exact: true });
  await expect(security).toContainText('You don’t use two-step verification yet.');
  const box = security.getByRole('checkbox', {
    name: 'Require two-step verification for Owners and Admins',
  });
  await expect(box).not.toBeChecked();
  await box.check();
  await security.getByRole('button', { name: 'Save security settings' }).click();
  await expect(
    security.getByText('Set up two-step verification in your account first.'),
  ).toBeVisible();
  await expect(box).toHaveAttribute('aria-invalid', 'true');
  await expectAccessible(page);

  // With it on, the Owner can.
  const ownerKey = await enableMfaViaApi(owner.token);
  await signInWithCode(page, owner.email, ownerKey);
  await page.goto(`/orgs/${orgId}/settings`);
  await expect(security).not.toContainText('You don’t use two-step verification yet.');
  await box.check();
  await security.getByRole('button', { name: 'Save security settings' }).click();
  await expect(
    page.getByText('Two-step verification is now required for Owners and Admins.'),
  ).toBeVisible();
  await page.reload();
  await expect(box).toBeChecked();
  await page.goto(`/orgs/${orgId}/audit`);
  await expect(page.getByRole('main')).toContainText(
    'Required two-step verification for Owners and Admins',
  );
  await signOut(page);

  // The Admin without it reaches only the explanation, from any page of the organization.
  await signIn(page, admin.email);
  for (const path of ['', '/team', '/settings', '/audit']) {
    await page.goto(`/orgs/${orgId}${path}`);
    await expect(page).toHaveURL(`/two-step-required?org=${orgId}`);
  }
  await expect(
    page.getByRole('heading', { level: 1, name: 'Two-step verification required' }),
  ).toBeVisible();
  await expect(page.getByRole('main')).toContainText(
    'Secure Org requires two-step verification for Owners and Admins. As an Admin',
  );
  await expectAccessible(page);
  await page.getByRole('link', { name: 'Set up two-step verification' }).click();
  await expect(page).toHaveURL(/\/account#two-step-heading$/);
  await expect(page.getByRole('region', { name: 'Two-step verification' })).toContainText('Off');

  // Once it is on, the organization opens again; the explanation page sends them back in.
  const adminKey = await enableMfaViaApi(admin.token);
  await signInWithCode(page, admin.email, adminKey);
  await page.goto(`/two-step-required?org=${orgId}`);
  await expect(page).toHaveURL(`/orgs/${orgId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Secure Org' })).toBeVisible();
  await signOut(page);

  // Other roles are not affected.
  await signIn(page, manager.email);
  await page.goto(`/orgs/${orgId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Secure Org' })).toBeVisible();
});

test('Owners see who uses two-step verification before and after requiring it', async ({
  page,
}) => {
  const owner = await verifiedAccount('team-mfa-owner');
  const orgId = await createOrgViaApi(owner.token, 'Posture Org');
  const admin = await joinAs(owner.token, orgId, 'team-mfa-admin', 'admin');
  const viewer = await joinAs(owner.token, orgId, 'team-mfa-viewer', 'viewer');
  const ownerKey = await enableMfaViaApi(owner.token);
  await signInWithCode(page, owner.email, ownerKey);

  await page.goto(`/orgs/${orgId}/team`);
  const members = page.getByRole('table', { name: 'Members' });
  await expect(members.getByRole('columnheader', { name: 'Two-step' })).toBeVisible();
  const row = (email: string) => members.getByRole('row').filter({ hasText: email });
  await expect(row(owner.email)).toContainText('On');
  await expect(row(admin.email)).toContainText('Off');
  await expect(row(viewer.email)).toContainText('Off');
  await expect(page.getByRole('main')).toContainText(
    `1 Owner or Admin doesn’t use two-step verification yet: ${admin.email}.`,
  );
  await expectAccessible(page);

  await page.getByRole('link', { name: 'require it' }).click();
  const security = page.getByRole('region', { name: 'Security', exact: true });
  await expect(security).toContainText('1 Owner or Admin doesn’t use two-step verification yet.');
  await security
    .getByRole('checkbox', { name: 'Require two-step verification for Owners and Admins' })
    .check();
  await security.getByRole('button', { name: 'Save security settings' }).click();
  await expect(
    page.getByText('Two-step verification is now required for Owners and Admins.'),
  ).toBeVisible();

  // Owners are told by email who changed it (ADR-0026).
  const notice = await mailMessage(owner.email, 'organization_security_changed');
  expect(notice.subject).toBe(
    'Posture Org now requires two-step verification for Owners and Admins',
  );
  expect(notice.text).toContain(`${owner.email} turned on`);

  await security.getByRole('link', { name: 'See who on the Team page' }).click();
  await expect(row(admin.email)).toContainText('Needed');

  // ADR-0031: remind them. The reminder goes out once a day at most.
  await row(admin.email)
    .getByRole('button', { name: `Remind ${admin.email} to turn on two-step verification` })
    .click();
  await expect(row(admin.email)).toContainText('Reminded today');
  const reminder = await mailMessage(admin.email, 'two_step_reminder');
  expect(reminder.subject).toBe('Posture Org: please turn on two-step verification');
  expect(reminder.text).toContain(`${owner.email} asks you to turn on two-step verification`);
  expect(reminder.text).toContain("until it is on, you can't open");
  await page.reload();
  await expect(row(admin.email)).toContainText('Reminded today');
  await expect(row(admin.email).getByRole('button', { name: /^Remind / })).toHaveCount(0);
  // People who already use it, and yourself, get no button.
  await expect(row(owner.email).getByRole('button', { name: /^Remind / })).toHaveCount(0);
  // The viewer is not covered by the requirement.
  await expect(row(viewer.email)).toContainText('Off');
  await expect(page.getByRole('main')).toContainText(
    `1 Owner or Admin can’t open this organization until they set up two-step verification: ${admin.email}.`,
  );
  await expectAccessible(page);
});
