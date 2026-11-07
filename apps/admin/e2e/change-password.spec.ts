import { expect } from '@playwright/test';
import {
  expectAccessible,
  PASSWORD,
  signIn,
  signOut,
  test,
  testClientIp,
  verifiedAccount,
} from './support';

const NEW_PASSWORD = 'Precision and grace 2028'; // pragma: allowlist secret (synthetic)

test('a signed-in user changes their password; other sessions end, this one stays', async ({
  page,
  browser,
}) => {
  const user = await verifiedAccount('change');
  const other = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL,
    extraHTTPHeaders: { 'x-forwarded-for': testClientIp() },
  });
  const otherPage = await other.newPage();
  await signIn(otherPage, user.email);
  await expect(otherPage.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();

  await signIn(page, user.email);
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
  await expect(page.getByText(`Signed in as ${user.email}`).last()).toBeVisible();
  await expectAccessible(page);

  // Wrong current password: inline error, nothing changes, nothing is echoed.
  await page.getByLabel('Current password').fill('not my password at all');
  await page.getByLabel('New password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByLabel('Current password')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Your current password is incorrect.')).toBeVisible();
  await expect(page.getByLabel('Current password')).toHaveValue('');
  await expect(page.getByLabel('New password')).toHaveValue('');

  // Same as the current password is refused.
  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByLabel('New password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Choose a password different from your current one.')).toBeVisible();

  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByLabel('New password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  // Two other sessions: the second browser and the fixture's own API sign-in.
  await expect(
    page.getByText(
      'Your password has been changed. You stay signed in here; 2 other sessions were signed out.',
    ),
  ).toBeVisible();

  // This browser is still signed in; the other one is not.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
  await otherPage.reload();
  await expect(otherPage).toHaveURL(/\/login/);
  await other.close();

  // The new password is the one that works.
  await signOut(page);
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'Email or password is incorrect.',
  );
  await page.getByLabel('Password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
});

test('the account page needs a session', async ({ page }) => {
  await page.goto('/account');
  await expect(page).toHaveURL(/\/login\?next=%2Faccount$/);
});
