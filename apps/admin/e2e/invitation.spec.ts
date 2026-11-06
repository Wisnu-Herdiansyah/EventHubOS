import { expect } from '@playwright/test';
import {
  createOrgViaApi,
  expectAccessible,
  inviteViaApi,
  mailLink,
  signIn,
  verifiedAccount,
  test,
} from './support';

test('an invited teammate signs in from the invitation link and joins the organization', async ({
  page,
}) => {
  const owner = await verifiedAccount('owner');
  const orgId = await createOrgViaApi(owner.token, 'Invitation Test Org');
  const teammate = await verifiedAccount('teammate');
  await inviteViaApi(owner.token, orgId, teammate.email, 'registration_manager');

  // Signed out: the link asks the visitor to sign in and keeps the token for this tab only.
  await page.goto(await mailLink(teammate.email, 'organization_invitation'));
  await expect(page.getByRole('link', { name: 'Sign in' }).last()).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await expectAccessible(page);

  await page.getByRole('main').getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Faccept-invitation/);
  await signIn(page, teammate.email, '/accept-invitation');

  await expect(page).toHaveURL(/\/accept-invitation$/);
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page).toHaveURL(new RegExp(`/orgs/${orgId}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Invitation Test Org' })).toBeVisible();

  // The pending token was cleared once used.
  expect(
    await page.evaluate(() => sessionStorage.getItem('eventhub.pendingInvitation')),
  ).toBeNull();
});
