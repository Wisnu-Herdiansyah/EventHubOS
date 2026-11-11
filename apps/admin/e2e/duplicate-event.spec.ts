import { expect } from '@playwright/test';
import {
  apiCall,
  createEventViaApi,
  createOrgViaApi,
  expectAccessible,
  joinAs,
  signIn,
  signOut,
  test,
  verifiedAccount,
} from './support';

/** ADR-0036: an organizer copies an event into a new draft with new dates. */
test('an organizer duplicates an event into a draft for next year', async ({ page }) => {
  const owner = await verifiedAccount('dup-owner');
  const orgId = await createOrgViaApi(owner.token, 'Duplicate Org');
  const eventId = await createEventViaApi(owner.token, orgId);
  const evtUrl = `/v1/organizations/${orgId}/events/${eventId}`;
  const source = await apiCall<{ slug: string }>(
    'PATCH',
    evtUrl,
    {
      expectedVersion: 1,
      settings: {
        registration: { opensAt: '2027-01-01T01:00:00Z', capacity: 80 },
        sharing: { title: 'Private Summit', description: 'Two days.' },
      },
    },
    owner.token,
  );
  await apiCall(
    'POST',
    `${evtUrl}/page/draft`,
    {
      expectedVersion: 0,
      sections: [
        {
          id: 'hero',
          type: 'hero',
          version: 1,
          visible: true,
          heading: 'Copied heading',
          body: 'From last year.',
          ctaLabel: 'Register',
        },
      ],
    },
    owner.token,
  );

  await signIn(page, owner.email);
  await page.goto(`/orgs/${orgId}/events/${eventId}`);
  await page.getByRole('button', { name: 'Duplicate…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Duplicate this event' });
  // Suggested: a copy name, a new address and the same local time a year later.
  await expect(dialog.getByLabel('New event name')).toHaveValue('Private Summit (copy)');
  await expect(dialog.getByLabel('URL slug')).toHaveValue(`${source.slug}-copy`);
  await expect(dialog.getByLabel('Starts')).toHaveValue('2028-03-01T09:00');
  await expectAccessible(page);

  // An address already in use is refused, and the dialog keeps what was typed.
  await dialog.getByLabel('URL slug').fill(source.slug);
  await dialog.getByLabel('New event name').fill('Private Summit 2028');
  await dialog.getByRole('button', { name: 'Create draft copy' }).click();
  await expect(dialog.getByText('Already in use.')).toBeVisible();
  await expect(dialog.getByLabel('New event name')).toHaveValue('Private Summit 2028');

  await dialog.getByLabel('URL slug').fill(`${source.slug}-2028`);
  await dialog.getByRole('button', { name: 'Create draft copy' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Private Summit 2028' })).toBeVisible();
  await expect(page.locator('.toast')).toContainText('Event duplicated. This copy is a draft');
  const copyId = /\/events\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  expect(copyId).not.toBe(eventId);
  const main = page.getByRole('main');
  await expect(main.getByText('1 Mar 2028, 09:00', { exact: false }).first()).toBeVisible();
  await expect(main.getByText('Draft', { exact: true }).first()).toBeVisible();
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath('duplicated.png'), fullPage: true });

  // Settings came along. Registration still opens 59 days before the event: the event moved by
  // 366 days (2028 is a leap year), so the window did too, from 1 Jan 2027 to 2 Jan 2028.
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByLabel('Capacity', { exact: true })).toHaveValue('80');
  await expect(page.getByLabel('Opens', { exact: true })).toHaveValue('2028-01-02T08:00');
  // The draft page came along; nothing was published.
  const copyPage = await apiCall<{
    draft: { sections: Array<{ heading?: string }>; version: number };
    published: unknown;
  }>('GET', `/v1/organizations/${orgId}/events/${copyId}/page`, undefined, owner.token);
  expect(copyPage.draft.sections[0]!.heading).toBe('Copied heading');
  expect(copyPage.draft.version).toBe(1);
  expect(copyPage.published).toBeNull();

  // Viewers cannot duplicate.
  const viewer = await joinAs(owner.token, orgId, 'dup-viewer', 'viewer');
  await signOut(page);
  await signIn(page, viewer.email);
  await page.goto(`/orgs/${orgId}/events/${eventId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Private Summit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Duplicate…' })).toHaveCount(0);
});
