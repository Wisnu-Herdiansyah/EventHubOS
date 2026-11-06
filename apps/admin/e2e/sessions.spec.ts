import { expect } from '@playwright/test';
import { expectAccessible, signIn, test, testClientIp, verifiedAccount } from './support';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';

test('a user reviews their sessions and signs out another device, then all others', async ({
  page,
  browser,
}) => {
  const user = await verifiedAccount('sessions'); // the fixture also signs in once via the API
  const phone = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL,
    userAgent: IPHONE_SAFARI,
    extraHTTPHeaders: { 'x-forwarded-for': testClientIp() },
  });
  const phonePage = await phone.newPage();
  await signIn(phonePage, user.email);
  await expect(phonePage.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();

  await signIn(page, user.email);
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  const list = page.getByRole('region', { name: 'Signed-in sessions' }).getByRole('listitem');
  await expect(list).toHaveCount(3);
  await expect(list.filter({ hasText: 'This device' })).toHaveCount(1);
  // The admin app forwards the real browser's user-agent, so the phone is named correctly.
  const phoneRow = list.filter({ hasText: 'Safari on iPhone' });
  await expect(phoneRow).toHaveCount(1);
  await expect(phoneRow).toContainText('Last active just now');
  await expect(list.filter({ hasText: 'This device' }).getByRole('button')).toHaveCount(0);
  await expectAccessible(page);

  // Sign out the phone.
  await page.getByRole('button', { name: 'Sign out Safari on iPhone' }).click();
  await expect(page.getByText('That session was signed out.')).toBeVisible();
  await expect(list).toHaveCount(2);
  await phonePage.reload();
  await expect(phonePage).toHaveURL(/\/login/);
  await phone.close();

  // Sign out everything else (the fixture's API session).
  await page.getByRole('button', { name: 'Sign out all other sessions' }).click();
  await expect(
    page.getByText('All other sessions were signed out. This one stays signed in.'),
  ).toBeVisible();
  await expect(list).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Sign out all other sessions' })).toHaveCount(0);

  // This device is still signed in.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
});
