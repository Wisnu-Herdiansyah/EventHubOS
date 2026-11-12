import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, type Browser } from '@playwright/test';
import {
  API_URL,
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

/** A person on the public site: an ordinary browser, so their page loads count as views. */
const PERSON_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

async function visitor(browser: Browser) {
  const context = await browser.newContext({
    userAgent: PERSON_UA,
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
  await v.page.getByRole('button', { name: 'Yes, cancel my place' }).click();
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

  // Add to calendar (ADR-0048): from the ticket, the event page and the email, the same file.
  const readIcs = async (click: () => Promise<void>) => {
    const [download] = await Promise.all([v.page.waitForEvent('download'), click()]);
    expect(download.suggestedFilename()).toMatch(/^[a-z0-9-]+\.ics$/);
    return (await readFile(await download.path(), 'utf8')).replace(/\r\n /g, '');
  };
  const fromTicket = await readIcs(() =>
    v.page.getByRole('link', { name: 'Add to calendar' }).click(),
  );
  expect(fromTicket).toMatch(/^BEGIN:VCALENDAR\r\n/);
  expect(fromTicket).toContain('\r\nSUMMARY:Private Summit\r\n');
  expect(fromTicket).toMatch(/\r\nUID:[0-9a-f]{32}@eventhub\r\n/);
  expect(fromTicket).toContain(`\r\nURL:${t.url}\r\n`);
  expect(fromTicket).not.toContain(t.eventId);
  await v.page.goto(t.url);
  const fromPage = await readIcs(() =>
    v.page.getByRole('link', { name: 'Add to calendar' }).click(),
  );
  const stable = (ics: string) => ics.replace(/\r\nDTSTAMP:\S+/, '');
  expect(stable(fromPage)).toBe(stable(fromTicket));
  const mailed = (await mailMessage(attendees[0]!.email, 'registration_confirmed')).text;
  expect(mailed).toContain(`Add it to your calendar: ${t.url}/calendar.ics`);
  // Served as a calendar file that browsers will not treat as a page.
  const headers = await v.page.evaluate(async () => {
    const res = await fetch(`${location.pathname}/calendar.ics`);
    return {
      status: res.status,
      type: res.headers.get('content-type'),
      sniff: res.headers.get('x-content-type-options'),
    };
  });
  expect(headers).toEqual({
    status: 200,
    type: 'text/calendar; charset=utf-8',
    sniff: 'nosniff',
  });
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
  // The visitor loaded the public page twice (ADR-0044); counting happens just after each load.
  await expect(async () => {
    await page.reload();
    await expect(
      page.getByRole('table', { name: 'Page views by day' }).getByRole('row').last(),
    ).toContainText('2', { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(main).not.toContainText('Report Person');
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath('report-light.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath('report-dark.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });

  // ADR-0032: the organization's Reports page, from the sidebar.
  await page.getByRole('navigation').getByRole('link', { name: 'Reports' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
  await expect(main.getByText('0 cancelled')).toBeVisible();
  await expect(main.getByText('Across all events')).toBeVisible();
  await expect(main.getByText('Known once an event with registrations ends')).toBeVisible();
  const events = page.getByRole('table', { name: 'Events' });
  const row = events.getByRole('row').filter({ hasText: 'Private Summit' });
  await expect(row.getByRole('cell').nth(1)).toHaveText('2');
  await expect(row.getByRole('cell').nth(2)).toHaveText('1');
  await expect(row.getByRole('cell').nth(3)).toHaveText('–');
  await expect(page.getByRole('table', { name: 'Sign-ups by month' }).getByRole('row')).toHaveCount(
    13,
  );
  await expect(main).not.toContainText('Report Person');
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath('org-report.png'), fullPage: true });

  // ADR-0034: periods. Last year has no events, and nothing to download.
  const periods = page.getByRole('navigation', { name: 'Report period' });
  await periods.getByRole('link', { name: 'Last year' }).click();
  await expect(periods.getByRole('link', { name: 'Last year' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(main.getByText('No events in this period')).toBeVisible();
  await expect(main.getByText('Across events in this period')).toBeVisible();
  await expect(main.getByRole('link', { name: 'Download CSV' })).toHaveCount(0);

  // A custom period around the event's start day selects it.
  const ev = await apiCall<{ startsAt: string }>(
    'GET',
    `/v1/organizations/${t.orgId}/events/${t.eventId}`,
    undefined,
    t.owner.token,
  );
  const day = (offset: number) =>
    new Date(Date.parse(ev.startsAt) + offset * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel('From', { exact: true }).fill(day(-1));
  await page.getByLabel('To', { exact: true }).fill(day(1));
  await page.getByRole('button', { name: 'Show custom period' }).click();
  await expect(page).toHaveURL(new RegExp(`period=custom&from=${day(-1)}&to=${day(1)}`));
  await expect(row.getByRole('cell').nth(1)).toHaveText('2');
  await expect(page.getByLabel('From', { exact: true })).toHaveValue(day(-1));
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath('org-report-period.png'), fullPage: true });

  // The CSV has the same rows, counts only.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    main.getByRole('link', { name: 'Download CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`events-report-${day(-1)}-to-${day(1)}.csv`);
  const csv = await readFile(await download.path(), 'utf8');
  const lines = csv
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\r\n');
  expect(lines[0]).toBe(
    'Event,Starts,Status,Registered,Capacity,Cancelled,Checked in,Attendance %,Page views',
  );
  expect(lines).toHaveLength(2);
  expect(lines[1]).toMatch(
    /^Private Summit,\d{4}-\d{2}-\d{2} \d{2}:\d{2},[A-Z][a-z]+,2,\d*,0,1,,2$/,
  );
  expect(csv).not.toContain('Report Person');
  expect(csv).not.toContain('@');

  // A reversed period is refused: the page says so and shows all time.
  await page.goto(`/orgs/${t.orgId}/reports?period=custom&from=${day(1)}&to=${day(-1)}`);
  await expect(main.getByText('That period was not valid')).toBeVisible();
  await expect(periods.getByRole('link', { name: 'All time' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const refused = await page.request.get(
    `/orgs/${t.orgId}/reports/export?period=custom&from=${day(1)}&to=${day(-1)}`,
    { maxRedirects: 0 },
  );
  expect(refused.status()).toBe(303);

  await page.goto(`/orgs/${t.orgId}/reports`);
  await events.getByRole('link', { name: 'Private Summit' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Report' })).toBeVisible();

  // Viewers have no report.
  const viewer = await joinAs(t.owner.token, t.orgId, 'report-viewer', 'viewer');
  await signOut(page);
  await signIn(page, viewer.email);
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}/report`);
  await expect(page.getByRole('main')).toContainText('can see reports');
  // ...and no download: the API refuses, so the handler sends them back to the page.
  const denied = await page.request.get(`/orgs/${t.orgId}/reports/export`, { maxRedirects: 0 });
  expect(denied.status()).toBe(303);
  expect(denied.headers()['location']).toContain(`/orgs/${t.orgId}/reports`);
  expect(denied.headers()['content-type'] ?? '').not.toContain('text/csv');
});

test('a full event takes a waitlist; freed seats go to people in the order they joined', async ({
  page,
  browser,
}) => {
  const t = await publishedEvent('waitlist', { capacity: 1 });
  const people = {
    seated: uniqueEmail('wl-seated'),
    first: uniqueEmail('wl-first'),
    second: uniqueEmail('wl-second'),
    leaver: uniqueEmail('wl-leaver'),
  };

  // The organizer turns the waitlist on; it needs a capacity.
  await signIn(page, t.owner.email);
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  const waitlistBox = page.getByRole('checkbox', {
    name: 'Take a waitlist when the event is full',
  });
  await page.getByLabel('Capacity', { exact: true }).fill('');
  await waitlistBox.check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Set a capacity to use a waitlist.')).toBeVisible();
  await expect(waitlistBox).toBeChecked();
  await page.getByLabel('Capacity', { exact: true }).fill('1');
  // ADR-0038: at most three people waiting.
  await page.getByLabel('Waitlist limit', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await expect(waitlistBox).toBeChecked();
  await expect(page.getByLabel('Waitlist limit', { exact: true })).toHaveValue('3');

  // One seat, then a waitlist on the public page, in joining order.
  const v = await visitor(browser);
  const signUp = async (name: string, email: string, button: string) => {
    await v.page.goto(t.url);
    const form = v.page.getByRole('region', { name: 'Save your seat' });
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel('Email', { exact: true }).fill(email);
    await form.getByRole('checkbox').check();
    await form.getByRole('button', { name: button }).click();
    await expect(form.getByRole('status').last()).toContainText('Check your email');
  };
  await signUp('Seated Person', people.seated, 'Save my seat');
  await v.page.reload();
  await expect(v.page.getByText('This event is full. Join the waitlist')).toBeVisible();
  await axeScan(v.page);
  await signUp('First Waiting', people.first, 'Join the waitlist');
  await signUp('Second Waiting', people.second, 'Join the waitlist');
  await signUp('Changed Mind', people.leaver, 'Join the waitlist');
  // The waitlist is at its limit, so the event is simply full.
  await v.page.goto(t.url);
  await expect(v.page.getByText('This event is full.', { exact: true })).toBeVisible();
  await expect(v.page.getByRole('button', { name: 'Join the waitlist' })).toHaveCount(0);
  const waitMail = await mailMessage(people.first, 'registration_waitlisted');
  expect(waitMail.subject).toMatch(/^You're on the waitlist: /);
  expect(waitMail.text).not.toContain('/ticket#id=');
  // No calendar entry until there is a seat (ADR-0048).
  expect(waitMail.text).not.toContain('/calendar.ics');

  // Someone leaves the waitlist with their emailed link.
  await v.page.goto(await mailLink(people.leaver, 'registration_waitlisted'));
  await v.page.getByRole('button', { name: 'Yes, cancel my place' }).click();
  await expect(v.page.getByRole('status')).toContainText('You’ve left the waitlist for');
  // A place on the waitlist is free again.
  await v.page.goto(t.url);
  await expect(v.page.getByRole('button', { name: 'Join the waitlist' })).toBeVisible();
  await v.context.close();

  // The organizer sees the waitlist in order.
  const base = `/orgs/${t.orgId}/events/${t.eventId}/registrations`;
  await page.goto(base);
  const main = page.getByRole('main');
  await expect(main.getByText('Registration full, waitlist open')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Filter registrations' })
    .getByRole('link', { name: 'Waitlist' })
    .click();
  const attendees = page.getByRole('region', { name: 'Attendees' });
  const rows = attendees.getByRole('row');
  await expect(rows.nth(1)).toContainText('First Waiting');
  await expect(rows.nth(2)).toContainText('Second Waiting');
  await expect(rows).toHaveCount(3);
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath('waitlist.png'), fullPage: true });

  // Cancelling the seat gives it to the first person waiting, who is emailed a ticket.
  await page.getByRole('link', { name: 'Registered', exact: true }).click();
  await page.getByRole('button', { name: /^Cancel the registration of Seated Person/ }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Cancel registration', exact: true })
    .click();
  await expect(page.locator('.toast')).toContainText('Registration cancelled.');
  const promoted = await mailMessage(people.first, 'registration_promoted');
  expect(promoted.subject).toMatch(/^A seat opened up: you're registered for /);
  expect(promoted.text).toContain('/ticket#id=');
  await page.goto(`${base}?status=confirmed`);
  await expect(attendees.getByRole('row').filter({ hasText: 'First Waiting' })).toContainText(
    'Registered from waitlist',
  );

  // The organizer squeezes the second person in, over capacity, knowingly.
  await page.goto(`${base}?status=waitlisted`);
  await attendees.getByRole('button', { name: /^Give a seat to Second Waiting/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Give Second Waiting a seat?' });
  await expect(dialog).toContainText('this goes over capacity');
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Give a seat over capacity' }).click();
  await expect(page.locator('.toast')).toContainText('They have a seat now');
  await expect(main.getByText('Nobody is waiting')).toBeVisible();
  await mailMessage(people.second, 'registration_promoted');
});

test('an organizer emails an announcement to everyone registered (ADR-0037)', async ({
  page,
  browser,
}) => {
  const t = await publishedEvent('announce');
  const attendee = uniqueEmail('announce-attendee');
  const v = await visitor(browser);
  await v.page.goto(t.url);
  const form = v.page.getByRole('region', { name: 'Save your seat' });
  await form.getByLabel('Name', { exact: true }).fill('Annie Attendee');
  await form.getByLabel('Email', { exact: true }).fill(attendee);
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Save my seat' }).click();
  await expect(form.getByRole('status')).toContainText('Check your email');
  await v.context.close();

  await signIn(page, t.owner.email);
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}`);
  await page.getByRole('link', { name: 'Announcements' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Announcements' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Everyone registered (1 person)' })).toBeChecked();
  await expect(page.getByText('Nothing sent yet.')).toBeVisible();
  await expectAccessible(page);

  // Nothing is sent without a subject.
  await page.getByLabel('Message').fill('Doors open at 08:00.\nBring your ticket.');
  await page.getByRole('button', { name: 'Send…' }).click();
  await page
    .getByRole('dialog', { name: 'Send this announcement now?' })
    .getByRole('button', { name: 'Send now' })
    .click();
  await expect(page.getByText('Enter a subject.')).toBeVisible();
  await expect(page.getByLabel('Message')).toHaveValue('Doors open at 08:00.\nBring your ticket.');

  await page.getByLabel('Subject').fill('Doors open early');
  await page.getByRole('button', { name: 'Send…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send this announcement now?' });
  await expect(dialog).toContainText('can’t be taken back');
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Send now' }).click();
  await expect(page.locator('.toast')).toContainText('Announcement sent.');

  const mail = await mailMessage(attendee, 'event_announcement');
  expect(mail.subject).toBe('Private Summit: Doors open early');
  expect(mail.text).toContain('Hello Annie Attendee,');
  expect(mail.text).toContain('Doors open at 08:00.\nBring your ticket.');
  expect(mail.text).toContain('to people who signed up for Private Summit');

  const sent = page.getByRole('list', { name: 'Sent announcements' });
  await expect(sent).toContainText('Doors open early');
  await expect(async () => {
    await page.reload();
    await expect(sent.getByText('Delivered to 1')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await expect(sent).toContainText(`by ${t.owner.email}`);
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath('announcements.png'), fullPage: true });

  // Registration managers see attendees but cannot email them all.
  const manager = await joinAs(t.owner.token, t.orgId, 'announce-regman', 'registration_manager');
  await signOut(page);
  await signIn(page, manager.email);
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}`);
  await expect(page.getByRole('link', { name: 'Announcements' })).toHaveCount(0);
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}/announcements`);
  await expect(page.getByRole('main')).toContainText('can send announcements');
});

test('an organizer asks registration questions and reads the answers (ADR-0041)', async ({
  page,
  browser,
}) => {
  const t = await publishedEvent('questions');
  await signIn(page, t.owner.email);
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  const card = page.getByRole('region', { name: 'Registration questions' });
  await card.getByRole('button', { name: 'Add question' }).click();
  await card.getByLabel('Question 1', { exact: true }).fill('Company');
  await card.getByRole('checkbox', { name: 'Required (question 1)' }).check();
  await card.getByRole('button', { name: 'Add question' }).click();
  await card.getByLabel('Question 2', { exact: true }).fill('Lunch');
  await card.getByLabel('Answer type (question 2)').selectOption('choice');
  await card.getByLabel('Options (question 2)').fill('Regular\nVegan');
  await card.getByRole('checkbox', { name: 'Required (question 2)' }).check();
  // A choice with one option is refused, and the message names the question.
  await card.getByRole('button', { name: 'Add question' }).click();
  await card.getByLabel('Question 3', { exact: true }).fill('Size');
  await card.getByLabel('Answer type (question 3)').selectOption('choice');
  await card.getByLabel('Options (question 3)').fill('Only one');
  await card.getByRole('button', { name: 'Save questions' }).click();
  await expect(card.getByText('Question 3 · Options: Give at least two options.')).toBeVisible();
  await card.getByRole('button', { name: 'Remove question 3' }).click();
  await card.getByRole('button', { name: 'Save questions' }).click();
  await expect(card.getByText('Questions saved.')).toBeVisible();
  await expectAccessible(page);

  // Saving the other settings keeps the questions.
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(card.getByLabel('Question 2', { exact: true })).toHaveValue('Lunch');

  // The visitor answers them; a missing required answer is explained, and what was typed stays.
  const v = await visitor(browser);
  await v.page.goto(t.url);
  const form = v.page.getByRole('region', { name: 'Save your seat' });
  const attendee = uniqueEmail('asked');
  await form.getByLabel('Name', { exact: true }).fill('Ana Answer');
  await form.getByLabel('Email', { exact: true }).fill(attendee);
  await form.getByRole('radio', { name: 'Vegan' }).check();
  await form.getByRole('checkbox').check();
  await axeScan(v.page);
  // The browser would stop an empty required field; send it anyway, as a script could.
  await form
    .getByLabel('Company', { exact: true })
    .evaluate((el) => el.removeAttribute('required'));
  await form.getByRole('button', { name: 'Save my seat' }).click();
  await expect(form.getByText('This question needs an answer.')).toBeVisible();
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Ana Answer');
  await expect(form.getByRole('radio', { name: 'Vegan' })).toBeChecked();
  await form.getByLabel('Company', { exact: true }).fill('Acme, Inc.');
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Save my seat' }).click();
  await expect(form.getByRole('status')).toContainText('Check your email');
  await v.context.close();

  // The organizer reads the answers in the list and the download.
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}/registrations`);
  const row = page
    .getByRole('region', { name: 'Attendees' })
    .getByRole('row')
    .filter({ hasText: 'Ana Answer' });
  await row.getByText('2 of 2').click();
  await expect(row.getByText('Acme, Inc.')).toBeVisible();
  await expect(row.getByText('Vegan')).toBeVisible();
  await expectAccessible(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download CSV' }).click(),
  ]);
  const csv = await readFile(await download.path(), 'utf8');
  expect(csv).toContain(',Company,Lunch');
  expect(csv).toContain(`Ana Answer,${attendee},Registered,`);
  expect(csv).toContain(',"Acme, Inc.",Vegan');
});

/** A delivery of the email provider's webhook (ADR-0043), signed like Standard Webhooks. */
async function providerReports(type: 'email.bounced' | 'email.delivered', to: string) {
  const secret = process.env.E2E_EMAIL_WEBHOOK_SECRET ?? '';
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const id = `msg_${randomBytes(8).toString('hex')}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    type,
    created_at: new Date().toISOString(),
    data: { email_id: `email-${id}`, to: [to], from: 'x@example.test', subject: 's' },
  });
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  const res = await fetch(`${API_URL}/v1/webhooks/email-feedback`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
    body,
  });
  expect(res.status).toBe(204);
}

test('organizers see which attendees email does not reach (ADR-0043)', async ({
  page,
  browser,
}) => {
  const t = await publishedEvent('bounce');
  const v = await visitor(browser);
  await v.page.goto(t.url);
  const form = v.page.getByRole('region', { name: 'Save your seat' });
  const attendee = uniqueEmail('mailbox');
  await form.getByLabel('Name', { exact: true }).fill('Rina Mailbox');
  await form.getByLabel('Email', { exact: true }).fill(attendee);
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Save my seat' }).click();
  await expect(form.getByRole('status')).toContainText('Check your email');
  await v.context.close();

  // The provider reports that the mailbox does not exist.
  await providerReports('email.bounced', attendee);

  await signIn(page, t.owner.email);
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}/registrations`);
  const attendees = page.getByRole('region', { name: 'Attendees' });
  const row = attendees.getByRole('row').filter({ hasText: attendee });
  await expect(row.getByText('Email not delivered')).toBeVisible();
  await expect(attendees).toContainText('Email to 1 attendee is not being delivered');
  // The reason (bounce or complaint) is not shown to organizers.
  await expect(attendees).not.toContainText(/bounce|complain|spam/i);
  await axeScan(page);

  // A later delivery to that address clears it.
  await providerReports('email.delivered', attendee);
  await page.reload();
  await expect(row.getByText('Email not delivered')).toHaveCount(0);
  await expect(attendees).not.toContainText('is not being delivered');
});
