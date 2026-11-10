import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, type Browser } from '@playwright/test';
import {
  apiCall,
  axeScan,
  createEventViaApi,
  createOrgViaApi,
  expectAccessible,
  mailLink,
  signIn,
  test,
  uniqueEmail,
  verifiedAccount,
} from './support';

const TEMPLATE = process.env.E2E_SITE_URL_TEMPLATE ?? '';

/** A published event with a public page and a registration section, set up through the API. */
async function publishedEvent(label: string, registration: Record<string, unknown> = {}) {
  const owner = await verifiedAccount(label);
  const orgId = await createOrgViaApi(owner.token, `${label} Org`);
  const eventId = await createEventViaApi(owner.token, orgId);
  const evtUrl = `/v1/organizations/${orgId}/events/${eventId}`;
  const evt = await apiCall<{ version: number; slug: string }>(
    'PATCH',
    evtUrl,
    {
      expectedVersion: 1,
      settings: {
        visibility: 'public',
        sharing: { title: 'Jakarta Summit 2027', description: 'Two days.' },
        legal: { privacyPolicyUrl: 'https://example.com/privacy' },
        registration,
      },
    },
    owner.token,
  );
  const scheduled = await apiCall<{ version: number }>(
    'POST',
    `${evtUrl}/transitions`,
    {
      to: 'scheduled',
      expectedVersion: evt.version,
      acknowledgedWarnings: ['contact.details', 'registration.window', 'legal.terms'],
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
          heading: 'Jakarta Summit',
          body: 'Two days.',
          ctaLabel: 'Save my seat',
        },
        {
          id: 'register',
          type: 'register',
          version: 1,
          visible: true,
          heading: 'Save your seat',
          body: 'Free to attend.',
          ctaLabel: 'Save my seat',
        },
      ],
    },
    owner.token,
  );
  await apiCall('POST', `${evtUrl}/page/publish`, { expectedVersion: 1 }, owner.token);
  const handle = `reg-${randomBytes(4).toString('hex')}`;
  const org = await apiCall<{ version: number }>(
    'PATCH',
    `/v1/organizations/${orgId}`,
    {
      expectedVersion: 1,
      publicHandle: handle,
    },
    owner.token,
  );
  void org;
  await apiCall(
    'POST',
    `${evtUrl}/transitions`,
    { to: 'published', expectedVersion: scheduled.version },
    owner.token,
  );
  return {
    owner,
    orgId,
    eventId,
    url: `${TEMPLATE.replace('{handle}', handle)}/${evt.slug}`,
  };
}

async function visitor(browser: Browser) {
  const context = await browser.newContext({
    extraHTTPHeaders: { 'x-forwarded-for': `198.18.${randomBytes(1)[0]}.${randomBytes(1)[0]}` },
  });
  return { context, page: await context.newPage() };
}

test('a visitor registers, gets an email, cancels with its link; the organizer sees it all', async ({
  page,
  browser,
}) => {
  const t = await publishedEvent('register');
  const v = await visitor(browser);
  await v.page.goto(t.url);
  const form = v.page.getByRole('region', { name: 'Save your seat' });
  await expect(form.getByLabel('Name', { exact: true })).toBeVisible();
  await axeScan(v.page);

  // Consent is required.
  const attendee = uniqueEmail('attendee');
  await form.getByLabel('Name', { exact: true }).fill('Ade Wisnu');
  await form.getByLabel('Email', { exact: true }).fill(attendee);
  await form.getByRole('button', { name: 'Save my seat' }).click();
  await expect(form.getByRole('alert')).toContainText('Check the highlighted fields.');
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Ade Wisnu');
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Save my seat' }).click();
  await expect(form.getByRole('status')).toContainText('Check your email for your confirmation.');

  // The organizer sees the attendee.
  await signIn(page, t.owner.email);
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}`);
  await expect(page.getByRole('region', { name: 'Registrations' })).toContainText('1 registered');
  await page.getByRole('link', { name: 'Registrations' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Registrations' })).toBeVisible();
  const attendees = page.getByRole('region', { name: 'Attendees' });
  await expect(attendees).toContainText('Ade Wisnu');
  await expect(attendees).toContainText(attendee);
  await expectAccessible(page);

  // The organizer downloads the list (ADR-0027).
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    attendees.getByRole('button', { name: 'Download CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^[a-z0-9-]+-registrations-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await readFile(await download.path(), 'utf8');
  expect(csv).toContain('Name,Email,Status,Registered at (Asia/Jakarta)');
  expect(csv).toContain(`Ade Wisnu,${attendee},Registered,`);
  // Still on the page; the export is in the audit log, without the attendee's details.
  await expect(page.getByRole('heading', { level: 1, name: 'Registrations' })).toBeVisible();
  await page.goto(`/orgs/${t.orgId}/audit`);
  await expect(page.getByRole('main')).toContainText('Downloaded the attendee list of');
  await expect(page.getByRole('main')).not.toContainText(attendee);
  // A cross-site form post with the organizer's cookies is refused.
  const forged = await page.request.post(
    `/orgs/${t.orgId}/events/${t.eventId}/registrations/export`,
    { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, form: {} },
  );
  expect(forged.status()).toBe(403);
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}/registrations`);

  // The attendee cancels with the emailed link.
  const link = await mailLink(attendee, 'registration_confirmed');
  expect(link).toContain('/cancel-registration#token=');
  await v.page.goto(link);
  await v.page.getByRole('button', { name: 'Cancel my registration' }).click();
  await expect(v.page.getByRole('status')).toContainText('is cancelled');
  expect(new URL(v.page.url()).hash).toBe('');
  await axeScan(v.page);

  await page.reload();
  await expect(attendees.getByRole('row').filter({ hasText: 'Ade Wisnu' })).toContainText(
    'Cancelled',
  );
  await page.getByRole('link', { name: 'Registered', exact: true }).click();
  await expect(attendees).not.toContainText('Ade Wisnu');
  await v.context.close();
});

test('the organizer cancels a registration; a full event stops taking sign-ups', async ({
  page,
  browser,
}) => {
  const t = await publishedEvent('capacity', { capacity: 1 });
  const v = await visitor(browser);
  await v.page.goto(t.url);
  const form = v.page.getByRole('region', { name: 'Save your seat' });
  await form.getByLabel('Name', { exact: true }).fill('Only Seat');
  await form.getByLabel('Email', { exact: true }).fill(uniqueEmail('seat'));
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Save my seat' }).click();
  await expect(form.getByRole('status')).toContainText('Check your email');

  await v.page.reload();
  await expect(v.page.getByText('This event is full.')).toBeVisible();
  await expect(v.page.getByLabel('Name', { exact: true })).toHaveCount(0);

  await signIn(page, t.owner.email);
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}/registrations`);
  await expect(page.getByRole('region', { name: 'Attendees' })).toContainText('Only Seat');
  await page.getByRole('button', { name: /^Cancel the registration of Only Seat/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel Only Seat’s registration?' });
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Cancel registration', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('Registration cancelled.');

  // The seat is free again.
  await v.page.reload();
  await expect(v.page.getByLabel('Name', { exact: true })).toBeVisible();
  await v.context.close();
});
