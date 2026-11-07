import { expect } from '@playwright/test';
import {
  expectAccessible,
  mailLink,
  PASSWORD,
  signIn,
  signOut,
  test,
  uniqueEmail,
} from './support';

test('an organizer signs up, verifies, creates an organization and runs an event lifecycle', async ({
  page,
}) => {
  const email = uniqueEmail('organizer');

  // Sign up through the UI.
  await page.goto('/signup');
  await expectAccessible(page);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('status')).toContainText('Open the link in that email');

  // Verify with the emailed link. The single-use token is removed from the address bar.
  await page.goto(await mailLink(email, 'verify_email'));
  await expect(page.getByRole('button', { name: 'Verify my email' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await page.getByRole('button', { name: 'Verify my email' }).click();
  await expect(page.getByRole('status')).toContainText('verified');

  await signIn(page, email);
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  await expectAccessible(page);

  // Create an organization.
  await page.getByLabel('Organization name').fill('Systematic Elegance Events');
  await page.getByLabel('Time zone').selectOption('Asia/Jakarta');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Systematic Elegance Events' }),
  ).toBeVisible();
  await expectAccessible(page);

  // Server-side validation errors are tied to their fields.
  await page.getByLabel('Event name').fill('Jakarta Summit 2027');
  await page.getByLabel('URL slug').fill('Not A Slug!');
  await page.getByLabel('Starts').fill('2027-03-01T09:00');
  await page.getByLabel('Ends').fill('2027-03-01T17:00');
  await page.getByRole('button', { name: 'Create event' }).click();
  await expect(page.getByLabel('URL slug')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    /Check the highlighted fields/,
  );

  // What the organizer typed survives the failed submit.
  await expect(page.getByLabel('Event name')).toHaveValue('Jakarta Summit 2027');
  await expect(page.getByLabel('Starts')).toHaveValue('2027-03-01T09:00');
  await page.getByLabel('URL slug').fill('jakarta-summit-2027');
  await page.getByRole('button', { name: 'Create event' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Jakarta Summit 2027' })).toBeVisible();
  // Times entered in the event time zone (Asia/Jakarta, UTC+7) are shown back unchanged.
  await expect(
    page.getByRole('region', { name: 'Details' }).getByText(/1 Mar 2027.*09:00|Mar 1, 2027.*09:00/),
  ).toBeVisible();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  await expect(page.getByText('Complete the required checklist items')).toBeVisible();
  await expectAccessible(page);

  // Settings: sharing text and a privacy policy are required before scheduling.
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/#settings$/);
  await page.getByLabel('Sharing title').fill('Jakarta Summit 2027');
  await page.getByLabel('Sharing description').fill('Two days of operations and branding.');
  await page.getByLabel('Privacy policy URL').fill('https://example.com/privacy');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();

  // Scheduling asks the organizer to acknowledge each skipped recommendation. The tab survives
  // a reload (it is in the URL fragment).
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Settings' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Overview' }).click();
  const schedule = page.getByRole('button', { name: 'Schedule event' });
  await expect(schedule).toBeVisible();
  const acknowledgements = page.getByRole('checkbox');
  for (const box of await acknowledgements.all()) await box.check();
  await schedule.click();
  await expect(page.getByText('Scheduled', { exact: true })).toBeVisible();

  // Archive (read-only) and restore.
  await page.getByRole('button', { name: 'Archive event' }).click();
  await expect(page.getByText('Archived events are read-only.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save settings' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Restore event' }).click();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();

  // Sign out ends the session; protected pages send the visitor to sign in.
  await signOut(page);
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});
