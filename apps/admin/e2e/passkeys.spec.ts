import { expect } from '@playwright/test';
import {
  PASSWORD,
  enableMfaViaApi,
  expectAccessible,
  mailMessage,
  signIn,
  signInWithCode,
  signOut,
  test,
  verifiedAccount,
} from './support';

/**
 * Passkeys as the second step (ADR-0033), with Chromium's virtual authenticator standing in for
 * Touch ID or a security key: the real browser ceremony, verified by the real API.
 */
test('add a passkey, sign in with it instead of a code, and remove it', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  const user = await verifiedAccount('passkey');
  const key = await enableMfaViaApi(user.token);
  await signInWithCode(page, user.email, key);
  await page.goto('/account');
  const card = page.getByRole('region', { name: 'Two-step verification' });
  await expect(card.getByRole('heading', { name: 'Passkeys' })).toBeVisible();

  // Add one.
  await card.getByRole('button', { name: 'Add a passkey…' }).click();
  const add = page.getByRole('dialog', { name: 'Add a passkey' });
  await add.getByLabel('Name').fill('Work laptop');
  await add.getByLabel('Current password').fill(PASSWORD);
  await expectAccessible(page);
  await add.getByRole('button', { name: 'Add passkey' }).click();
  await expect(add).toBeHidden();
  const list = card.getByRole('list', { name: 'Your passkeys' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list).toContainText('Work laptop');
  await expect(list).toContainText('not used yet');
  await card.screenshot({ path: test.info().outputPath('passkeys-account.png') });
  const added = await mailMessage(user.email, 'mfa_passkey_added');
  expect(added.subject).toBe('A passkey was added to your EventHub OS account');
  await expectAccessible(page);

  // Sign in with it: password, then the passkey instead of a code.
  await signOut(page);
  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login\/verify\?pk=1$/);
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath('passkeys-verify.png') });
  await page.getByRole('button', { name: 'Use your passkey' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();

  // Remove it.
  await page.goto('/account');
  await expect(list).toContainText('last used');
  await list.getByRole('button', { name: /^Remove passkey Work laptop/ }).click();
  const remove = page.getByRole('dialog', { name: 'Remove “Work laptop”?' });
  await remove.getByLabel('Current password').fill(PASSWORD);
  await remove.getByRole('button', { name: 'Remove passkey' }).click();
  await expect(remove).toBeHidden();
  await expect(card.getByRole('list', { name: 'Your passkeys' })).toHaveCount(0);

  // Without a passkey, the second step asks for a code only.
  await signOut(page);
  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login\/verify$/);
  await expect(page.getByRole('button', { name: 'Use your passkey' })).toHaveCount(0);
});

test('passkeys are offered only once two-step verification is on', async ({ page }) => {
  const user = await verifiedAccount('passkey-off');
  await signIn(page, user.email);
  await page.goto('/account');
  const card = page.getByRole('region', { name: 'Two-step verification' });
  await expect(card).toContainText('Once two-step verification is on, you can add a passkey');
  await expect(card.getByRole('button', { name: 'Add a passkey…' })).toHaveCount(0);
});
