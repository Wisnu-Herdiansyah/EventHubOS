import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { expect, type Locator } from '@playwright/test';
import {
  apiCall,
  axeScan,
  createEventViaApi,
  createOrgViaApi,
  expectAccessible,
  signIn,
  test,
  verifiedAccount,
} from './support';

const TEMPLATE = process.env.E2E_SITE_URL_TEMPLATE ?? '';

/** A small, valid PNG of one colour (no image library needed in the test runner). */
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => rgb[i % 3]!)]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A published event whose page has an (empty) v3 speakers section, set up through the API. */
async function publishedEvent(label: string) {
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
          ctaLabel: '',
        },
        {
          id: 'speakers',
          type: 'speakers',
          version: 3,
          visible: true,
          heading: 'Speakers',
          items: [],
        },
      ],
    },
    owner.token,
  );
  await apiCall('POST', `${evtUrl}/page/publish`, { expectedVersion: 1 }, owner.token);
  const handle = `img-${randomBytes(4).toString('hex')}`;
  await apiCall(
    'PATCH',
    `/v1/organizations/${orgId}`,
    { expectedVersion: 1, publicHandle: handle },
    owner.token,
  );
  await apiCall(
    'POST',
    `${evtUrl}/transitions`,
    { to: 'published', expectedVersion: scheduled.version },
    owner.token,
  );
  return { owner, orgId, eventId, origin: TEMPLATE.replace('{handle}', handle), slug: evt.slug };
}

/** The image actually decoded in the browser (not a broken-image icon). */
async function expectLoaded(img: Locator) {
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
    .toBe(true);
}

test('an organizer uploads a speaker photo and visitors see it once published', async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const t = await publishedEvent('images');
  await signIn(page, t.owner.email);

  // The library, from the sidebar.
  await page.goto(`/orgs/${t.orgId}`);
  await page.getByRole('link', { name: 'Images', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Images' })).toBeVisible();
  await expect(page.getByText('No images yet')).toBeVisible();
  await expectAccessible(page);

  // Something that only claims to be an image is refused, with the reason at the field.
  const upload = page.getByRole('region', { name: 'Upload' });
  await upload.getByLabel('Image').setInputFiles({
    name: 'not-really.png',
    mimeType: 'image/png',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  });
  await upload.getByRole('button', { name: 'Upload image' }).click();
  await expect(upload.getByText('Upload a JPEG, PNG or WebP image.')).toBeVisible();

  // A real image, named after its file.
  await upload.getByLabel('Image').setInputFiles({
    name: 'Ade portrait.png',
    mimeType: 'image/png',
    buffer: png(320, 320, [31, 58, 95]),
  });
  await upload.getByLabel('Text alternative').fill('Ade smiling');
  await upload.getByRole('button', { name: 'Upload image' }).click();
  await expect(page.getByText('Image uploaded.')).toBeVisible();
  const library = page.getByRole('list', { name: 'Image library' });
  const card = library.getByRole('listitem').filter({ hasText: 'Ade portrait' });
  await expect(card).toContainText('Text: Ade smiling');
  await expect(card).toContainText('320 × 320');
  await expectLoaded(card.locator('img'));

  // Rename it.
  await card.getByRole('button', { name: 'Edit Ade portrait' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit image' });
  await edit.getByLabel('Name').fill('Ade Wisnu');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit.getByText('Image updated.')).toBeVisible();
  await edit.getByRole('button', { name: 'Cancel' }).click();
  await expect(library).toContainText('Ade Wisnu');
  await axeScan(page);

  // Give a speaker that photo; the preview shows it at once.
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}/page`);
  const editor = page.locator('.builder');
  await editor
    .locator('.builder__panel')
    .first()
    .getByRole('button', { name: /^Speakers/ })
    .click();
  await editor.getByRole('button', { name: 'Add speaker' }).click();
  await editor.getByLabel('Name (speaker 1)').fill('Ade Wisnu');
  await editor.getByLabel('Photo (speaker 1)').selectOption({ label: 'Ade Wisnu' });
  await expectLoaded(editor.locator('.site-speaker img'));
  await expectLoaded(editor.locator('.photo-picker img'));
  await editor.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved (version 2).')).toBeVisible();

  // Still a draft: the public site does not serve the image yet.
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await visitor.goto(`${t.origin}/${t.slug}`);
  await expect(visitor.locator('.site-speaker')).toHaveCount(0);

  await editor.getByRole('button', { name: 'Publish…' }).click();
  await page.getByRole('button', { name: 'Publish revision 2' }).click();
  await expect(page.getByText('Published as revision 2.')).toBeVisible();

  // Visitors see the photo, served from the event site's own address as WebP.
  await visitor.reload();
  const speaker = visitor.locator('.site-speaker').filter({ hasText: 'Ade Wisnu' });
  const photo = speaker.locator('img');
  await expectLoaded(photo);
  await expect(photo).toHaveAttribute('alt', '');
  const src = await photo.getAttribute('src');
  expect(src).toMatch(/^\/images\/[0-9a-f-]{36}\/small\.webp$/);
  // Fetched from the page itself: the test runner cannot resolve *.localhost hosts.
  const fetched = (path: string) =>
    visitor.evaluate(async (p) => {
      const r = await fetch(p);
      return {
        status: r.status,
        type: r.headers.get('content-type'),
        nosniff: r.headers.get('x-content-type-options'),
      };
    }, path);
  expect(await fetched(src!)).toEqual({ status: 200, type: 'image/webp', nosniff: 'nosniff' });
  // An image ID the published page does not use is simply not found.
  expect((await fetched('/images/00000000-0000-4000-8000-000000000000/small.webp')).status).toBe(
    404,
  );
  await axeScan(visitor);
  await visitorContext.close();

  // An image in use cannot be deleted; the dialog says where it is used.
  await page.goto(`/orgs/${t.orgId}/images`);
  await page.getByRole('button', { name: 'Delete Ade Wisnu' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete this image?' });
  await confirm.getByRole('button', { name: 'Delete image' }).click();
  await expect(confirm.getByText(/This image is used on/)).toBeVisible();
});

test('the library is in the sidebar for its organization, and closed to strangers', async ({
  page,
}) => {
  const owner = await verifiedAccount('images-viewer-owner');
  const orgId = await createOrgViaApi(owner.token, 'Viewer Org');
  await signIn(page, owner.email);
  await page.goto(`/orgs/${orgId}`);
  await expect(page.getByRole('link', { name: 'Images', exact: true })).toBeVisible();
  const stranger = await verifiedAccount('images-stranger');
  await page.context().clearCookies();
  await signIn(page, stranger.email);
  expect((await page.goto(`/orgs/${orgId}/images`))?.status()).toBe(404);
});

test('an organizer picks page colours and a sharing image (ADR-0046)', async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const t = await publishedEvent('theme');
  await signIn(page, t.owner.email);

  // An image in the library first.
  await page.goto(`/orgs/${t.orgId}/images`);
  const upload = page.getByRole('region', { name: 'Upload' });
  await upload.getByLabel('Image').setInputFiles({
    name: 'Share card.png',
    mimeType: 'image/png',
    buffer: png(1200, 630, [31, 107, 74]),
  });
  await upload.getByRole('button', { name: 'Upload image' }).click();
  await expect(page.getByText('Image uploaded.')).toBeVisible();

  // Event settings: colours and sharing image.
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  const settings = page.getByRole('region', { name: 'Settings' });
  await settings.getByLabel('Page colours').selectOption({ label: 'Forest' });
  await settings.getByLabel('Sharing image').selectOption({ label: 'Share card' });
  await settings.getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByText(/saved/i).first()).toBeVisible();
  await expect(settings.getByLabel('Page colours')).toHaveValue('forest');
  await axeScan(page);

  // The editor preview uses the colours too.
  await page.goto(`/orgs/${t.orgId}/events/${t.eventId}/page`);
  await expect(page.locator('.builder .site')).toHaveAttribute('data-brand', 'forest');

  // Visitors see the colours, and link previews get the image from the event's own address.
  const context = await browser.newContext();
  const visitor = await context.newPage();
  await visitor.goto(`${t.origin}/${t.slug}`);
  await expect(visitor.locator('.site')).toHaveAttribute('data-brand', 'forest');
  const og = await visitor.locator('meta[property="og:image"]').getAttribute('content');
  expect(og).toMatch(
    new RegExp(
      `^${t.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/images/[0-9a-f-]{36}/large\\.webp$`,
    ),
  );
  await expect(visitor.locator('meta[name="twitter:card"]')).toHaveAttribute(
    'content',
    'summary_large_image',
  );
  const status = await visitor.evaluate(async (u) => (await fetch(u)).status, og!);
  expect(status).toBe(200);
  await axeScan(visitor);
  await context.close();
});
