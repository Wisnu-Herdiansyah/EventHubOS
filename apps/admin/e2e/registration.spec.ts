import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, type Browser } from '@playwright/test';
import {
  apiCall,
  axeScan,
  createEventViaApi,
  createOrgViaApi,
  expectAccessible,
  joinAs,
  mailLink,
  mailMessage,
  signIn,
  signOut,
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

test('door staff find attendees, check them in once, and undo a mistake', async ({
  page,
  browser,
}) => {
  const t = await publishedEvent('checkin');
  const staff = await joinAs(t.owner.token, t.orgId, 'checkin-staff', 'registration_manager');
  const v = await visitor(browser);
  for (const name of ['Ade Wisnu', 'Budi Santoso']) {
    await v.page.goto(t.url);
    const form = v.page.getByRole('region', { name: 'Save your seat' });
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel('Email', { exact: true }).fill(uniqueEmail('door'));
    await form.getByRole('checkbox').check();
    await form.getByRole('button', { name: 'Save my seat' }).click();
    await expect(form.getByRole('status')).toContainText('Check your email');
  }
  await v.context.close();

  await signIn(page, staff.email);
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}/registrations`);
  await page.getByRole('link', { name: 'Open check-in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check-in' })).toBeVisible();
  await expect(page.getByText('0 of 2')).toBeVisible();
  // The search box is ready for typing as soon as the page opens.
  const search = page.getByRole('searchbox', { name: 'Find an attendee' });
  await expect(search).toBeFocused();
  await expectAccessible(page);

  await search.fill('budi');
  await page.getByRole('button', { name: 'Find' }).click();
  const results = page.getByRole('list', { name: 'Search results' });
  await expect(results.getByRole('listitem')).toHaveCount(1);
  // Names typed at the door stay out of the address bar.
  expect(page.url()).not.toContain('budi');

  await results.getByRole('button', { name: 'Check in Budi Santoso' }).click();
  await expect(results.getByRole('listitem')).toContainText(/Checked in \d{2}:\d{2}/);
  await expect(page.getByText('1 of 2')).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Budi Santoso checked in.' }),
  ).toBeAttached();
  await expectAccessible(page);

  // A mistake is undone.
  await results.getByRole('button', { name: 'Undo check-in of Budi Santoso' }).click();
  await expect(results.getByRole('button', { name: 'Check in Budi Santoso' })).toBeVisible();
  await expect(page.getByText('0 of 2')).toBeVisible();

  // Another door already checked Ade in: this desk says so and shows the current state.
  await search.fill('ade');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(results.getByRole('button', { name: 'Check in Ade Wisnu' })).toBeVisible();
  const registrations = await apiCall<{ data: Array<{ id: string; name: string }> }>(
    'GET',
    `/v1/organizations/${t.orgId}/events/${t.eventId}/registrations`,
    undefined,
    t.owner.token,
  );
  const ade = registrations.data.find((r) => r.name === 'Ade Wisnu')!;
  await apiCall(
    'POST',
    `/v1/organizations/${t.orgId}/events/${t.eventId}/registrations/${ade.id}/check-in`,
    {},
    t.owner.token,
  );
  await results.getByRole('button', { name: 'Check in Ade Wisnu' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'This attendee is already checked in.',
  );
  await expect(results.getByRole('listitem')).toContainText(/Checked in \d{2}:\d{2}/);

  // Door staff often use phones: the desk fits without sideways scrolling.
  await page.setViewportSize({ width: 375, height: 740 });
  await page.reload();
  await expect(results.getByRole('listitem').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: test.info().outputPath('check-in-phone.png') });
  await page.setViewportSize({ width: 1280, height: 800 });

  // The organizer sees the count.
  await signOut(page);
  await signIn(page, t.owner.email);
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}/registrations`);
  await expect(page.getByRole('main')).toContainText('of 2 registered');
});

test('an attendee shows the ticket from their email; the door scans it in once', async ({
  page,
  browser,
}) => {
  const t = await publishedEvent('ticket');
  const v = await visitor(browser);
  const attendees: Array<{ name: string; email: string }> = [
    { name: 'Ticket Holder', email: uniqueEmail('ticket') },
    { name: 'Gone Holder', email: uniqueEmail('gone') },
  ];
  for (const a of attendees) {
    await v.page.goto(t.url);
    const form = v.page.getByRole('region', { name: 'Save your seat' });
    await form.getByLabel('Name', { exact: true }).fill(a.name);
    await form.getByLabel('Email', { exact: true }).fill(a.email);
    await form.getByRole('checkbox').check();
    await form.getByRole('button', { name: 'Save my seat' }).click();
    await expect(form.getByRole('status')).toContainText('Check your email');
  }
  const ticketLink = async (to: string) =>
    /https?:\/\/\S+\/ticket#id=[0-9a-f-]{36}/.exec(
      (await mailMessage(to, 'registration_confirmed')).text,
    )![0];
  const holderLink = await ticketLink(attendees[0]!.email);
  const goneLink = await ticketLink(attendees[1]!.email);

  // The ticket page draws the QR code in the browser; the ID never reaches the server.
  await v.page.goto(holderLink);
  await expect(v.page.getByRole('heading', { level: 1, name: 'Private Summit' })).toBeVisible();
  const qr = v.page.getByRole('img', { name: /^Ticket QR code [0-9A-F]{4}-[0-9A-F]{4}$/ });
  await expect(qr).toBeVisible();
  await axeScan(v.page);
  await v.context.close();

  // The organizer cancels one registration.
  const regs = await apiCall<{ data: Array<{ id: string; name: string }> }>(
    'GET',
    `/v1/organizations/${t.orgId}/events/${t.eventId}/registrations`,
    undefined,
    t.owner.token,
  );
  const gone = regs.data.find((r) => r.name === 'Gone Holder')!;
  await apiCall(
    'POST',
    `/v1/organizations/${t.orgId}/events/${t.eventId}/registrations/${gone.id}/cancel`,
    {},
    t.owner.token,
  );

  await signIn(page, t.owner.email);
  const res = await page.goto(`/orgs/${t.orgId}/events/${t.eventId}/check-in`);
  expect(res?.headers()['permissions-policy']).toContain('camera=(self)');
  const search = page.getByRole('searchbox', { name: 'Find an attendee' });
  const main = page.getByRole('main');

  // A handheld scanner types the code and presses Enter; a pasted ticket link works too.
  const holderId = holderLink.split('#id=')[1]!;
  await search.fill(holderId);
  await search.press('Enter');
  await expect(
    main.getByRole('status').filter({ hasText: 'Ticket Holder checked in.' }).first(),
  ).toBeVisible();
  await expect(page.getByText('1 of 1')).toBeVisible();
  await expect(search).toHaveValue('');

  await search.fill(holderLink);
  await search.press('Enter');
  await expect(main.getByRole('alert')).toContainText(
    /Ticket Holder was already checked in at \d{2}:\d{2}\./,
  );

  await search.fill(goneLink.split('#id=')[1]!);
  await search.press('Enter');
  await expect(main.getByRole('alert')).toContainText('Gone Holder’s registration was cancelled.');

  await search.fill('00000000-0000-4000-8000-000000000000');
  await search.press('Enter');
  await expect(main.getByRole('alert')).toContainText('This ticket is not for this event.');
  await expectAccessible(page);

  // Without a usable camera, the scanner says so and the desk keeps working.
  await page.getByRole('button', { name: 'Scan ticket' }).click();
  await expect(main.getByRole('alert').filter({ hasText: /camera/i })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scan ticket' })).toBeVisible();
});

test('the event report shows sign-ups and attendance, and no attendee details', async ({
  page,
  browser,
}) => {
  const t = await publishedEvent('report');
  const analyst = await joinAs(t.owner.token, t.orgId, 'report-analyst', 'analyst');
  const v = await visitor(browser);
  for (const name of ['Report Person One', 'Report Person Two']) {
    await v.page.goto(t.url);
    const form = v.page.getByRole('region', { name: 'Save your seat' });
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel('Email', { exact: true }).fill(uniqueEmail('report'));
    await form.getByRole('checkbox').check();
    await form.getByRole('button', { name: 'Save my seat' }).click();
    await expect(form.getByRole('status')).toContainText('Check your email');
  }
  await v.context.close();
  const regs = await apiCall<{ data: Array<{ id: string }> }>(
    'GET',
    `/v1/organizations/${t.orgId}/events/${t.eventId}/registrations`,
    undefined,
    t.owner.token,
  );
  await apiCall(
    'POST',
    `/v1/organizations/${t.orgId}/events/${t.eventId}/registrations/${regs.data[0]!.id}/check-in`,
    {},
    t.owner.token,
  );

  // An Analyst reads the report from the event page; attendee details stay hidden.
  await signIn(page, analyst.email);
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}`);
  await page.getByRole('link', { name: 'Report', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Report' })).toBeVisible();
  const main = page.getByRole('main');
  await expect(main.getByText('50% of registered')).toBeVisible();
  await expect(main.getByText('Known once the event ends')).toBeVisible();
  const signUps = page.getByRole('table', { name: 'Sign-ups by day' });
  await expect(signUps.getByRole('row').last()).toContainText('2');
  const checkIns = page.getByRole('table', { name: 'Check-ins by hour' });
  await expect(checkIns.getByRole('row')).toHaveCount(2); // header + one hour
  await expect(main).not.toContainText('Report Person');
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath('report-light.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath('report-dark.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });

  // Viewers have no report.
  const viewer = await joinAs(t.owner.token, t.orgId, 'report-viewer', 'viewer');
  await signOut(page);
  await signIn(page, viewer.email);
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}/report`);
  await expect(page.getByRole('main')).toContainText('can see reports');
});
