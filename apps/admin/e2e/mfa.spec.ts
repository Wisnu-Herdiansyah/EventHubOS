import { expect, type Page } from '@playwright/test';
import { PASSWORD, expectAccessible, signOut, test, totpFromKey, verifiedAccount } from './support';

async function passwordStep(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('a user turns on two-step verification, signs in with it, and turns it off', async ({
  page,
}) => {
  const user = await verifiedAccount('mfa-ui');
  await passwordStep(page, user.email);
  await page.waitForURL((u) => u.pathname === '/');
  await page.goto('/account');
  const card = page.getByRole('region', { name: 'Two-step verification' });
  await expect(card).toContainText('Off');

  // Turn on: password, then scan, then confirm, then recovery codes.
  await card.getByRole('button', { name: 'Turn on two-step verification…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Turn on two-step verification' });
  await sheet.getByLabel('Current password').fill('not my password');
  await sheet.getByRole('button', { name: 'Continue' }).click();
  await expect(sheet.getByText('Your current password is incorrect.')).toBeVisible();
  await sheet.getByLabel('Current password').fill(PASSWORD);
  await sheet.getByRole('button', { name: 'Continue' }).click();
  await expect(
    sheet.getByRole('img', { name: 'QR code for adding EventHub OS to your authenticator app' }),
  ).toBeVisible();
  const key = (await sheet.locator('.text-mono').first().textContent()) ?? '';
  expect(key.replace(/\s/g, '')).toMatch(/^[A-Z2-7]{32}$/);
  await expectAccessible(page);

  await sheet.getByLabel('Code from your app').fill('000000');
  await sheet.getByRole('button', { name: 'Turn on' }).click();
  await expect(sheet.getByText('That code is incorrect or was already used.')).toBeVisible();
  await sheet.getByLabel('Code from your app').fill(totpFromKey(key));
  await sheet.getByRole('button', { name: 'Turn on' }).click();
  const codes = sheet.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem');
  await expect(codes).toHaveCount(10);
  const recovery = await codes.allTextContents();
  await expectAccessible(page);
  await sheet.getByRole('button', { name: 'I have saved them' }).click();
  await expect(sheet).toBeHidden();
  await expect(card).toContainText('On');
  await expect(card).toContainText('10 of 10 recovery codes left.');

  // Signing in now asks for a code. The confirmation code's step is spent, so use the next one.
  await signOut(page);
  await passwordStep(page, user.email);
  await expect(page).toHaveURL(/\/login\/verify$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Two-step verification' }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel('Verification code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByLabel('Verification code')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Verification code').fill(totpFromKey(key, 1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();

  // A recovery code works too, once.
  await signOut(page);
  await passwordStep(page, user.email);
  await page.getByRole('link', { name: 'Can’t use your app? Use a recovery code' }).click();
  await page.getByLabel('Recovery code').fill(recovery[0]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
  await page.goto('/account');
  await expect(card).toContainText('9 of 10 recovery codes left.');

  // Turn off with the password and a recovery code.
  await card.getByRole('button', { name: 'Turn off…' }).click();
  const off = page.getByRole('dialog', { name: 'Turn off two-step verification?' });
  await off.getByLabel('Current password').fill(PASSWORD);
  await off.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await off.getByLabel('Recovery code').fill(recovery[1]!);
  await off.getByRole('button', { name: 'Turn off two-step verification' }).click();
  await expect(card).toContainText('Off');

  // Password-only again.
  await signOut(page);
  await passwordStep(page, user.email);
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
});

test('the second step cannot be reached without a fresh password step', async ({ page }) => {
  await page.goto('/login/verify');
  await expect(page.getByText('This sign-in has expired')).toBeVisible();
  await expect(page.getByLabel('Verification code')).toHaveCount(0);
  await expectAccessible(page);
});
