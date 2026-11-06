import { randomBytes } from 'node:crypto';
import { expect } from '@playwright/test';
import {
  PASSWORD,
  expectAccessible,
  mailLink,
  mailLinks,
  signIn,
  test,
  unverifiedAccount,
  verifiedAccount,
} from './support';

test('an unverified user requests a new link from the home page and verifies with it', async ({
  page,
}) => {
  const user = await unverifiedAccount('resend');
  await mailLink(user.email, 'verify_email'); // the sign-up email arrived

  await signIn(page, user.email);
  await expect(page.getByText(`Verify your email address (${user.email})`)).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Send a new verification email' }).click();
  await expect(page.getByText('A new verification email is on its way.')).toBeVisible();
  // One send per page: the button is replaced, so repeated clicks cannot flood the inbox.
  await expect(page.getByRole('button', { name: 'Send a new verification email' })).toHaveCount(0);

  const links = await mailLinks(user.email, 'verify_email', 2);
  expect(new Set(links).size).toBe(2);

  // The new link verifies the address (and signs out other sessions, as designed).
  const newest = links.find((l) => l !== links[0]) ?? links[1]!;
  await page.goto(newest);
  await page.getByRole('button', { name: 'Verify my email' }).click();
  await expect(page.getByText('Your email address is verified.')).toBeVisible();
  await signIn(page, user.email);
  await expect(page.getByRole('button', { name: 'Create organization' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send a new verification email' })).toHaveCount(0);
});

test('a used or expired link explains itself and leads to a new one', async ({ page }) => {
  await page.goto(`/verify-email#token=${randomBytes(32).toString('base64url')}`);
  await page.getByRole('button', { name: 'Verify my email' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'This verification link is invalid or has expired.',
  );
  await expect(page.getByRole('button', { name: 'Verify my email' })).toHaveCount(0);
  await expectAccessible(page);
  await page.getByRole('link', { name: 'Get a new verification link' }).click();
  // Signed out: sign in first, then the home page offers the resend button.
  await expect(page).toHaveURL(/\/login$/);
  const user = await unverifiedAccount('expired-link');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Send a new verification email' })).toBeVisible();
});

test('sign-up tells people what to do if the email does not come', async ({ page }) => {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(`signup-hint-${randomBytes(4).toString('hex')}@example.test`);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('No email after a few minutes?')).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('verified users are not offered a resend', async ({ page }) => {
  const user = await verifiedAccount('already-verified');
  await signIn(page, user.email);
  await expect(page.getByRole('button', { name: 'Create organization' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send a new verification email' })).toHaveCount(0);
});
