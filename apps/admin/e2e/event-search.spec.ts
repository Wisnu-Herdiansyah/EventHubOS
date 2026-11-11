import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import {
  apiCall,
  createOrgViaApi,
  expectAccessible,
  signIn,
  test,
  verifiedAccount,
} from './support';

/** Creates an event through the API; `daysFromNow` may be negative (already over). */
async function event(token: string, orgId: string, name: string, daysFromNow: number) {
  const start = new Date(Date.now() + daysFromNow * 86_400_000);
  await apiCall(
    'POST',
    `/v1/organizations/${orgId}/events`,
    {
      name,
      slug: `ev-${randomUUID().slice(0, 8)}`,
      timezone: 'Asia/Jakarta',
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
      primaryLanguage: 'en',
      venueMode: 'in_person',
    },
    token,
  );
}

test('the events list can be searched, filtered and paged', async ({ page }) => {
  const owner = await verifiedAccount('search-owner');
  const orgId = await createOrgViaApi(owner.token, 'Search Org');
  await event(owner.token, orgId, 'Jakarta Summit 2026', -30);
  await event(owner.token, orgId, 'Jakarta Summit 2027', 60);
  await event(owner.token, orgId, 'Bandung Meetup', 20);
  for (let i = 0; i < 26; i++) await event(owner.token, orgId, `Weekly Session ${i + 1}`, 90 + i);

  await signIn(page, owner.email);
  await page.goto(`/orgs/${orgId}`);
  const events = page.getByRole('table', { name: 'Events', exact: true });
  const rows = events.getByRole('row');
  // 29 events: the first page shows 25, with a link to the next.
  await expect(rows).toHaveCount(26); // header + 25
  await expectAccessible(page);

  const search = page.getByRole('searchbox', { name: 'Search events' });
  await search.fill('jakarta');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(page).toHaveURL(/\?q=jakarta/);
  await expect(rows).toHaveCount(3);
  await expect(events).toContainText('Jakarta Summit 2026');
  await expect(events).toContainText('Jakarta Summit 2027');

  // Only the one already over.
  await page.getByLabel('When', { exact: true }).selectOption('past');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(events).toContainText('Jakarta Summit 2026');
  await expect(search).toHaveValue('jakarta');
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath('event-search.png'), fullPage: true });

  // Nothing matches: a clear message instead of an empty table.
  await page.getByLabel('Status', { exact: true }).selectOption('live');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(page.getByText('No events match')).toBeVisible();
  await page.getByRole('link', { name: 'Clear' }).click();
  await expect(rows).toHaveCount(26);
  await expect(search).toHaveValue('');

  // Paging through a filtered list: 26 weekly sessions over two pages, none twice.
  await search.fill('weekly');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(rows).toHaveCount(26);
  const firstPage = await events.getByRole('link').allTextContents();
  const pager = page.getByRole('navigation', { name: 'Event pages' });
  await pager.getByRole('link', { name: 'Next page' }).click();
  await expect(rows).toHaveCount(2); // header + 1
  const secondPage = await events.getByRole('link').allTextContents();
  expect(new Set([...firstPage, ...secondPage]).size).toBe(26);
  await expect(pager.getByRole('link', { name: 'Next page' })).toHaveCount(0);
  await pager.getByRole('link', { name: 'First page' }).click();
  await expect(rows).toHaveCount(26);
  await expect(search).toHaveValue('weekly');

  // A hand-edited link is shown as far as it is valid, and says so.
  await page.goto(`/orgs/${orgId}?status=deleted&q=bandung`);
  await expect(page.getByText('Some filters in the link were not valid')).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect(events).toContainText('Bandung Meetup');
});
