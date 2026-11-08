import { expect, type Page } from '@playwright/test';
import {
  createEventViaApi,
  createOrgViaApi,
  expectAccessible,
  joinAs,
  signIn,
  signOut,
  test,
  verifiedAccount,
} from './support';

async function openMicrosite(page: Page, orgId: string, eventId: string) {
  await page.goto(`/orgs/${orgId}/events/${eventId}`);
  await page.getByRole('link', { name: /microsite$/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Microsite' })).toBeVisible();
}

test('an organizer edits, saves and publishes the event microsite', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const owner = await verifiedAccount('site-owner');
  const orgId = await createOrgViaApi(owner.token, 'Microsite Org');
  const eventId = await createEventViaApi(owner.token, orgId);
  await signIn(page, owner.email);
  await openMicrosite(page, orgId, eventId);
  await expect(page.getByText('This is a starting outline.')).toBeVisible();
  await expect(page.getByText('Not saved yet · not published')).toBeVisible();
  await expectAccessible(page);

  const editor = page.locator('.builder');
  const preview = editor.getByRole('region', { name: 'Preview' });
  // Edit the hero.
  await editor.getByRole('button', { name: /^Private Summit/ }).click();
  await editor.getByLabel('Heading').fill('Systematic Elegance Summit');
  await editor.getByLabel('Button label').fill('Reserve a place');
  await expect(preview.getByRole('heading', { name: 'Systematic Elegance Summit' })).toBeVisible();
  // Add agenda items.
  await editor.getByRole('button', { name: /^Agenda/ }).click();
  await editor.getByRole('button', { name: 'Add item' }).click();
  await editor.getByLabel('Item 1 time').fill('09:30');
  await editor.getByLabel('Item 1 title').fill('Opening keynote');
  await expect(preview.getByText('Opening keynote')).toBeVisible();
  // Markup is just text.
  await editor.getByRole('button', { name: /^About/ }).click();
  await editor.getByLabel('Text', { exact: true }).fill('<img src=x onerror=alert(1)> stays text');
  await expect(preview.getByText('<img src=x onerror=alert(1)> stays text')).toBeVisible();
  await expect(preview.locator('img')).toHaveCount(0);

  await expect(editor.getByText(/^Unsaved changes/)).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Publish…' })).toBeDisabled();
  await editor.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved (version 1).')).toBeVisible();
  await expect(editor.getByText('Saved · version 1 · not published')).toBeVisible();

  // Saved for real.
  await page.reload();
  await expect(preview.getByRole('heading', { name: 'Systematic Elegance Summit' })).toBeVisible();
  await expect(preview.getByText('Opening keynote')).toBeVisible();
  await expect(page.getByText('This is a starting outline.')).toHaveCount(0);

  // Publish with confirmation.
  await editor.getByRole('button', { name: 'Publish…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Publish revision 1?' });
  await expect(confirm).toBeVisible();
  await expectAccessible(page);
  await confirm.getByRole('button', { name: 'Publish revision 1' }).click();
  await expect(page.getByText('Published as revision 1.')).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Publish…' })).toBeDisabled();
  const revisions = page.getByRole('region', { name: 'Published revisions' });
  await expect(revisions).toContainText('Revision 1');
  await expect(revisions).toContainText('You');

  // New edits are a draft until published again.
  await editor.getByRole('button', { name: 'Hide Speakers' }).click();
  await editor.getByRole('button', { name: 'Save draft' }).click();
  await expect(
    editor.getByText('Saved · version 2 · published revision 1, newer changes not published'),
  ).toBeVisible();

  // The audit log tells the story without the content.
  await page.goto(`/orgs/${orgId}/audit`);
  await expect(page.getByText('Published the microsite of Private Summit')).toBeVisible();
  await expect(page.getByText('Saved the microsite draft of Private Summit').first()).toBeVisible();
});

test('invalid content is explained per section and nothing is saved', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const owner = await verifiedAccount('site-invalid');
  const orgId = await createOrgViaApi(owner.token, 'Invalid Org');
  const eventId = await createEventViaApi(owner.token, orgId);
  await signIn(page, owner.email);
  await openMicrosite(page, orgId, eventId);
  const editor = page.locator('.builder');
  await editor.getByRole('button', { name: /^About/ }).click();
  await editor.getByLabel('Heading').fill('   ');
  await editor.getByRole('button', { name: 'Save draft' }).click();
  const alert = page.getByRole('main').getByRole('alert');
  await expect(alert).toContainText('Some sections need attention before saving.');
  await expect(alert).toContainText('Heading: Add a heading.');
  await expect(editor.getByText('Text · needs attention')).toBeVisible();
  await page.reload();
  await expect(editor.getByText('Not saved yet · not published')).toBeVisible();
});

test('Content editors save but cannot publish; Viewers only look', async ({ page }) => {
  const owner = await verifiedAccount('site-roles');
  const orgId = await createOrgViaApi(owner.token, 'Roles Site Org');
  const eventId = await createEventViaApi(owner.token, orgId);
  const editorUser = await joinAs(owner.token, orgId, 'site-editor', 'content_editor');
  const viewer = await joinAs(owner.token, orgId, 'site-viewer', 'viewer');

  await signIn(page, editorUser.email);
  await openMicrosite(page, orgId, eventId);
  const editor = page.locator('.builder');
  await editor.getByRole('button', { name: 'Hide Speakers' }).click();
  await editor.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved (version 1).')).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Publish…' })).toHaveCount(0);
  await signOut(page);

  await signIn(page, viewer.email);
  await page.goto(`/orgs/${orgId}/events/${eventId}`);
  await page.getByRole('link', { name: 'View microsite' }).click();
  await expect(editor.getByText(/^View only/)).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
  await expect(editor.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
  await expectAccessible(page);
});

test("another organization's microsite is not found", async ({ page }) => {
  const owner = await verifiedAccount('site-tenant-a');
  const orgId = await createOrgViaApi(owner.token, 'Site Tenant A');
  const eventId = await createEventViaApi(owner.token, orgId);
  const outsider = await verifiedAccount('site-tenant-b');
  await signIn(page, outsider.email);
  const res = await page.goto(`/orgs/${orgId}/events/${eventId}/page`);
  expect(res?.status()).toBe(404);
  await expect(page.getByText('Private Summit')).toHaveCount(0);
});
