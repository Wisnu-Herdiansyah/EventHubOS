import { expect } from '@playwright/test';
import {
  PASSWORD,
  expectAccessible,
  lastActiveMinutesAgo,
  signIn,
  test,
  verifiedAccount,
} from './support';

test('an idle session ends; signing in again returns to the same page', async ({ page }) => {
  const user = await verifiedAccount('idle');
  await signIn(page, user.email);
  await page.goto('/account');
  await expect(
    page.getByText(
      'For your security, a session ends after 1 hour without activity, or 12 hours after signing in.',
    ),
  ).toBeVisible();

  // Still active within the hour.
  await lastActiveMinutesAgo(user.email, 50);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();

  // Idle for longer than the timeout.
  await lastActiveMinutesAgo(user.email, 61);
  await page.reload();
  await expect(page).toHaveURL(/\/login\?next=%2Faccount&ended=1$/);
  await expect(page.getByRole('main').getByRole('status')).toContainText('Your session has ended');
  await expectAccessible(page);

  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
});
