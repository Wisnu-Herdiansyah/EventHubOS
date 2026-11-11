import { randomBytes } from 'node:crypto';
import { expect } from '@playwright/test';
import {
  axeScan,
  createEventViaApi,
  createOrgViaApi,
  enableMfaViaApi,
  expectAccessible,
  signIn,
  signInWithCode,
  test,
  verifiedAccount,
} from './support';

/** Makes an account platform staff, as the operator command does (test database only). */
async function makeStaff(email: string): Promise<void> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: process.env.E2E_FIXTURE_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO eventhub.platform_staff (user_id)
       SELECT id FROM eventhub.app_user WHERE email = $1`,
      [email],
    );
  } finally {
    await client.end();
  }
}

test('an Owner lets EventHub support look at the organization, then turns it off (ADR-0045)', async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const owner = await verifiedAccount('support-owner');
  // Unique per run: the Platform page lists every organization.
  const name = `Support Org ${randomBytes(3).toString('hex')}`;
  const orgId = await createOrgViaApi(owner.token, name);
  await createEventViaApi(owner.token, orgId);
  const staff = await verifiedAccount('support-staff');
  await makeStaff(staff.email);

  // Staff without two-step verification see the Platform page but not its tools.
  const staffContext = await browser.newContext();
  const sp = await staffContext.newPage();
  await sp.setViewportSize({ width: 1440, height: 900 });
  await signIn(sp, staff.email);
  await sp.getByRole('link', { name: 'Platform' }).click();
  await expect(sp.getByText('Platform tools need two-step verification.')).toBeVisible();

  // With it, they see the organization, but cannot open it yet.
  const key = await enableMfaViaApi(staff.token);
  await signInWithCode(sp, staff.email, key);
  await sp.goto('/platform');
  const orgs = sp.getByRole('table', { name: 'Organizations' });
  const row = orgs.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('Not granted');
  await expect(row.getByRole('link')).toHaveCount(0);
  expect((await sp.goto(`/orgs/${orgId}`))?.status()).toBe(404);
  await sp.goto('/platform');
  await expectAccessible(sp);

  // The Owner turns support access on for 8 hours.
  await signIn(page, owner.email);
  await page.goto(`/orgs/${orgId}/settings`);
  const card = page.getByRole('region', { name: 'Support access' });
  await expect(card).toContainText('cannot change anything or see attendee details');
  await card.getByLabel('For how long').selectOption('8');
  await card.getByRole('button', { name: 'Turn on support access' }).click();
  await expect(card.getByText(/^On/)).toBeVisible();
  await axeScan(page);

  // Staff open it, read-only, with the banner on every page.
  await sp.goto('/platform');
  await row.getByRole('link', { name }).click();
  await expect(
    sp.getByText(`You are viewing ${name} as EventHub support`, { exact: false }),
  ).toBeVisible();
  await expect(sp.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(sp.getByRole('button', { name: /New event|Create event/ })).toHaveCount(0);
  await axeScan(sp);

  // The Owner sees the visit in the audit log.
  await page.goto(`/orgs/${orgId}/audit`);
  await expect(page.getByRole('main')).toContainText(/support/i);

  // The Owner turns it off; staff are out.
  await page.goto(`/orgs/${orgId}/settings`);
  await card.getByRole('button', { name: 'Turn off support access' }).click();
  await page
    .getByRole('dialog', { name: 'Turn off support access?' })
    .getByRole('button', { name: 'Turn off' })
    .click();
  await expect(card.getByRole('button', { name: 'Turn on support access' })).toBeVisible();
  expect((await sp.goto(`/orgs/${orgId}`))?.status()).toBe(404);
  await staffContext.close();
});

test('people who are not staff have no Platform link and no Platform page', async ({ page }) => {
  const someone = await verifiedAccount('not-staff');
  await signIn(page, someone.email);
  await expect(page.getByRole('link', { name: 'Platform' })).toHaveCount(0);
  expect((await page.goto('/platform'))?.status()).toBe(404);
});
