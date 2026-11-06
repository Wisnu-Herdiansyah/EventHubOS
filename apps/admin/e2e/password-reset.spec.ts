import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import {
  expectAccessible,
  mailLink,
  signIn,
  test,
  testClientIp,
  uniqueEmail,
  verifiedAccount,
} from './support';

const NEW_PASSWORD = 'Precision and grace 2028'; // pragma: allowlist secret (synthetic)

test('a user resets a forgotten password and every session ends', async ({ page, browser }) => {
  const user = await verifiedAccount('reset');
  // Another browser stays signed in during the reset; its session must end too.
  const other = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL,
    extraHTTPHeaders: { 'x-forwarded-for': testClientIp() },
  });
  const otherPage = await other.newPage();
  await signIn(otherPage, user.email);
  await expect(otherPage.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();

  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Forgot your password?' }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel('Email').fill(user.email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText('If an account uses this address')).toBeVisible();

  const link = await mailLink(user.email, 'password_reset');
  expect(link).toContain('/reset-password#token=');
  await page.goto(link);
  await expect(page.getByLabel('New password')).toBeVisible();
  expect(new URL(page.url()).hash).toBe(''); // token removed from the address bar
  await expectAccessible(page);

  // The policy is enforced inline and the link still works afterwards.
  await page.getByLabel('New password').fill('too short');
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByLabel('New password')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('New password')).toHaveValue(''); // passwords are never echoed

  await page.getByLabel('New password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByText('Your password has been changed')).toBeVisible();
  await expectAccessible(page);

  // Old password no longer works; the new one does.
  await page.getByRole('link', { name: 'Sign in' }).last().click();
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill('Systematic elegance 2027!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'Email or password is incorrect.',
  );
  await page.getByLabel('Password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();

  // The other browser's session was revoked by the reset.
  await otherPage.reload();
  await expect(otherPage).toHaveURL(/\/login/);
  await other.close();

  // The same link cannot be used twice; it leads to a new one.
  await page.goto(link);
  await page.getByLabel('New password').fill('Another fine passphrase 3');
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'This password reset link is invalid, used, or has expired.',
  );
  await expect(page.getByLabel('New password')).toHaveCount(0);
  await page.getByRole('link', { name: 'Request a new link' }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
});

test('an unknown address gets the same answer and no email', async ({ page }) => {
  const unknown = uniqueEmail('nobody');
  await page.goto('/forgot-password');
  await page.getByLabel('Email').fill(unknown);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText('If an account uses this address')).toBeVisible();
  await new Promise((r) => setTimeout(r, 1500)); // give the worker time to (not) send
  const dir = process.env.E2E_MAIL_DIR!;
  const recipients = await Promise.all(
    (await readdir(dir)).map(async (f) => {
      try {
        return (JSON.parse(await readFile(join(dir, f), 'utf8')) as { to: string }).to;
      } catch {
        return '';
      }
    }),
  );
  expect(recipients).not.toContain(unknown);
});

test('an incomplete link explains itself', async ({ page }) => {
  await page.goto('/reset-password');
  await expect(page.getByText('This reset link is incomplete.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Request a new link' })).toBeVisible();
  await expectAccessible(page);
});
