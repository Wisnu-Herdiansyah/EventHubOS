import { expect, type Page } from '@playwright/test';
import {
  acceptInvitationViaApi,
  createOrgViaApi,
  expectAccessible,
  joinAs,
  signIn,
  signOut,
  test,
  uniqueEmail,
  verifiedAccount,
} from './support';

async function openTeam(page: Page, orgName: string) {
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: orgName, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: orgName, exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Team', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Team', exact: true })).toBeVisible();
}

const memberItem = (page: Page, email: string) =>
  page
    .getByRole('region', { name: /Members/ })
    .getByRole('row')
    .filter({ hasText: email });

/** The invite form lives in a slide-over panel opened from the page header. */
async function openInvite(page: Page) {
  await page.getByRole('button', { name: 'Invite teammate' }).click();
  await expect(page.getByRole('dialog', { name: 'Invite a teammate' })).toBeVisible();
}

test('an Owner invites, re-roles and removes a teammate, and revokes an invitation', async ({
  page,
}) => {
  const owner = await verifiedAccount('team-owner');
  await createOrgViaApi(owner.token, 'Team Org');
  await signIn(page, owner.email);
  await openTeam(page, 'Team Org');
  await expect(memberItem(page, owner.email)).toContainText('(you)');
  await expectAccessible(page);

  // Invite through the UI. The invitee accepts from their own account.
  const teammate = await verifiedAccount('team-mate');
  await openInvite(page);
  await expectAccessible(page);
  await page.getByLabel('Email address').fill(teammate.email);
  await page.getByLabel('Role', { exact: true }).selectOption('event_manager');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText(`Invitation sent to ${teammate.email}.`)).toBeVisible();
  const pendingList = page.getByRole('region', { name: /Pending invitations/ });
  await expect(pendingList).toContainText(teammate.email);

  await acceptInvitationViaApi(teammate.email, teammate.token);
  await page.reload();
  await expect(memberItem(page, teammate.email)).toContainText('Event manager');
  await expect(pendingList).not.toContainText(teammate.email);
  await expect(page.getByRole('region', { name: 'Recent invitations' })).toContainText('Accepted');

  // Change the role.
  const row = memberItem(page, teammate.email);
  await row.getByLabel(`Role for ${teammate.email}`).selectOption('viewer');
  await row.getByRole('button', { name: 'Change role' }).click();
  await expect(page.getByText(`Role updated for ${teammate.email}.`)).toBeVisible();
  await expect(row.getByLabel(`Role for ${teammate.email}`)).toHaveValue('viewer');

  // Removing takes two deliberate steps: the button opens a confirmation dialog.
  await memberItem(page, teammate.email)
    .getByRole('button', { name: new RegExp(`^Remove ${teammate.email} …$`) })
    .click();
  const confirm = page.getByRole('dialog', { name: `Remove ${teammate.email}?` });
  await expect(confirm).toBeVisible();
  await expectAccessible(page);
  // Cancel closes it without changes; Escape works too.
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await memberItem(page, teammate.email)
    .getByRole('button', { name: new RegExp(`^Remove ${teammate.email} …$`) })
    .click();
  await confirm.getByRole('button', { name: `Remove ${teammate.email}`, exact: true }).click();
  await expect(page.getByText('Member removed. Their access has ended.')).toBeVisible();
  await expect(memberItem(page, teammate.email)).toHaveCount(0);

  // Revoke a pending invitation.
  const invitee = uniqueEmail('revoked');
  await openInvite(page);
  await page.getByLabel('Email address').fill(invitee);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(pendingList).toContainText(invitee);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await pendingList
    .getByRole('row')
    .filter({ hasText: invitee })
    .getByRole('button', { name: /^Revoke invitation for .* …$/ })
    .click();
  await page
    .getByRole('dialog', { name: 'Revoke this invitation?' })
    .getByRole('button', { name: `Revoke invitation for ${invitee}`, exact: true })
    .click();
  await expect(page.getByText('Invitation revoked. Its link no longer works.')).toBeVisible();
  await expect(pendingList).not.toContainText(invitee);
  await expect(page.getByRole('region', { name: 'Recent invitations' })).toContainText('Revoked');
});

test('server-side validation and the last-Owner guard are shown clearly', async ({ page }) => {
  const owner = await verifiedAccount('solo-owner');
  await createOrgViaApi(owner.token, 'Solo Org');
  await signIn(page, owner.email);
  await openTeam(page, 'Solo Org');

  await openInvite(page);
  await page.getByLabel('Email address').fill('not-an-email');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByLabel('Email address')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Email address')).toHaveValue('not-an-email');
  await page.keyboard.press('Escape');

  const ownRow = memberItem(page, owner.email);
  await ownRow.getByRole('button', { name: /^Leave organization …$/ }).click();
  const leave = page.getByRole('dialog', { name: 'Leave this organization?' });
  await leave.getByRole('button', { name: 'Leave organization', exact: true }).click();
  await expect(leave.getByRole('alert')).toContainText('The last Owner cannot be removed');
  await expect(page.getByRole('heading', { level: 1, name: 'Team', exact: true })).toBeVisible();

  // Only known notice codes are shown; anything else in the URL is ignored, never echoed.
  await page.goto(`${new URL(page.url()).pathname}?notice=${encodeURIComponent('<b>pwned</b>')}`);
  await expect(page.locator('.toast')).toHaveCount(0);
  await expect(page.getByText('pwned')).toHaveCount(0);
});

test('an Admin cannot grant or manage Owner, and other roles see no team controls', async ({
  page,
}) => {
  const owner = await verifiedAccount('ceiling-owner');
  const orgId = await createOrgViaApi(owner.token, 'Ceiling Org');
  const admin = await joinAs(owner.token, orgId, 'ceiling-admin', 'admin');
  const viewer = await joinAs(owner.token, orgId, 'ceiling-viewer', 'viewer');

  await signIn(page, admin.email);
  await openTeam(page, 'Ceiling Org');
  const roleChoices = await page
    .getByLabel('Role', { exact: true })
    .locator('option')
    .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value));
  expect(roleChoices).not.toContain('owner');
  expect(roleChoices).toContain('admin');
  // The Owner's row has no management controls for an Admin; the Viewer's row does. A reminder
  // to turn on two-step verification is not management, so it is offered (ADR-0031).
  await expect(
    memberItem(page, owner.email).getByRole('button', { name: 'Change role' }),
  ).toHaveCount(0);
  await expect(
    memberItem(page, owner.email).getByRole('button', {
      name: `Remind ${owner.email} to turn on two-step verification`,
    }),
  ).toBeVisible();
  await expect(memberItem(page, owner.email).getByRole('button', { name: /^Remove/ })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: 'Invite teammate' })).toBeVisible();
  await expect(
    memberItem(page, viewer.email).getByRole('button', { name: 'Change role' }),
  ).toBeVisible();

  await signOut(page);
  await signIn(page, viewer.email);
  await page.getByRole('main').getByRole('link', { name: 'Ceiling Org', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ceiling Org' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Team', exact: true })).toHaveCount(0);
  await page.goto(`/orgs/${orgId}/team`);
  await expect(page.getByText('Only Owners and Admins can see and manage the team.')).toBeVisible();
  await expect(page.getByText(owner.email)).toHaveCount(0);
});

test("another organization's team page is not found", async ({ page }) => {
  const owner = await verifiedAccount('team-tenant-a');
  const orgId = await createOrgViaApi(owner.token, 'Team Tenant A');
  const outsider = await verifiedAccount('team-tenant-b');
  await signIn(page, outsider.email);
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
  const response = await page.goto(`/orgs/${orgId}/team`);
  expect(response?.status()).toBe(404);
  await expect(page.getByText(owner.email)).toHaveCount(0);
});
