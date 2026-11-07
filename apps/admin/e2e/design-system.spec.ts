import { expect, type Page } from '@playwright/test';
import {
  createEventViaApi,
  createOrgViaApi,
  expectAccessible,
  joinAs,
  signIn,
  test,
  verifiedAccount,
} from './support';

/** A signed-in Owner with an organization, an event and a teammate, so every screen has data. */
async function workspace(page: Page) {
  const owner = await verifiedAccount('ds-owner');
  const orgId = await createOrgViaApi(owner.token, 'Design Org');
  const eventId = await createEventViaApi(owner.token, orgId);
  await joinAs(owner.token, orgId, 'ds-mate', 'viewer');
  await signIn(page, owner.email);
  return {
    owner,
    screens: [
      '/',
      `/orgs/${orgId}`,
      `/orgs/${orgId}/events/${eventId}`,
      `/orgs/${orgId}/team`,
      `/orgs/${orgId}/settings`,
      `/orgs/${orgId}/audit`,
      '/account',
      '/design-system',
    ],
  };
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    wide: [...document.querySelectorAll<HTMLElement>('main *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right > document.documentElement.clientWidth + 1;
      })
      .filter((el) => !el.closest('.dialog, .tabs__list, .preview'))
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}`),
  }));
  expect(overflow, label).toEqual({ doc: 0, wide: [] });
}

test('every major screen passes WCAG checks in light and dark mode', async ({ page }) => {
  test.setTimeout(120_000);
  const { screens } = await workspace(page);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const path of screens) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectAccessible(page);
    }
  }
  // Signed-out pages too.
  await page.context().clearCookies();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const path of ['/login', '/signup', '/forgot-password']) {
      await page.goto(path);
      await expectAccessible(page);
    }
  }
});

test('dark mode follows the system and can be chosen in Account', async ({ page }) => {
  await workspace(page);
  const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/account');
  expect(await bodyBg()).toBe('rgb(0, 0, 0)');

  await page.emulateMedia({ colorScheme: 'light' });
  expect(await bodyBg()).toBe('rgb(245, 245, 247)');
  await page.getByRole('radio', { name: 'Dark' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await bodyBg()).toBe('rgb(0, 0, 0)');
  // Remembered on the server-rendered first paint.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked();
  await page.getByRole('radio', { name: 'Automatic' }).check();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  expect(await bodyBg()).toBe('rgb(245, 245, 247)');
});

for (const width of [360, 430, 768, 1024, 1280, 1440]) {
  test(`nothing scrolls sideways at ${width}px`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    const { screens } = await workspace(page);
    for (const path of screens) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoHorizontalOverflow(page, `${path} at ${width}px`);
    }
  });
}

test('the sidebar collapses to a rail, remembers it, and keeps labels for everyone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await workspace(page);
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
  const toggle = page.getByRole('button', { name: 'Sidebar', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const wide = (await sidebar.boundingBox())!.width;

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(wide / 2);
  // Labels stay in the accessibility tree; a tooltip shows them on focus.
  const account = sidebar.getByRole('link', { name: 'Account' });
  await account.focus();
  await expect(sidebar.locator('.tooltip__bubble', { hasText: 'Account' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sidebar.locator('.tooltip__bubble', { hasText: 'Account' })).toBeHidden();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Sidebar', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await page.getByRole('button', { name: 'Sidebar', exact: true }).click();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(wide);
});

test('on a phone the navigation is a drawer that traps nothing and closes with Escape', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await workspace(page);
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
  await expect(sidebar).toBeHidden();
  const open = page.getByRole('button', { name: 'Open navigation' });
  await open.click();
  await expect(sidebar).toBeVisible();
  await expect(open).toHaveAttribute('aria-expanded', 'true');
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await expect(sidebar).toBeHidden();
  await expect(open).toBeFocused();

  // Following a link closes the drawer.
  await open.click();
  await sidebar.getByRole('link', { name: 'Design Org' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Design Org' })).toBeVisible();
  await expect(sidebar).toBeHidden();
  // Touch targets: compact top-bar controls are 32px, above the 24px minimum (WCAG 2.5.8).
  const height = (await page.getByRole('button', { name: 'Open navigation' }).boundingBox())!
    .height;
  expect(height).toBeGreaterThanOrEqual(32);
});

test('menus, tabs and dialogs work from the keyboard', async ({ page }) => {
  const { owner } = await workspace(page);
  await page.goto('/design-system');

  // Account menu (menu button pattern). Its name starts with the visible email (WCAG 2.5.3).
  const menuButton = page.getByRole('button', { name: /account menu$/ });
  await expect(menuButton).toHaveAccessibleName(`${owner.email} – account menu`);
  await menuButton.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Account settings' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Account settings' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(menuButton).toBeFocused();

  // Tabs (arrow keys move and select).
  const first = page.getByRole('tab', { name: 'Overview' });
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Schedule' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Schedule' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('Schedule content.')).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Settings' })).toBeFocused();

  // Dialog: opens with focus inside, Escape closes and returns focus.
  const trigger = page.getByRole('button', { name: 'Open dialog' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Archive this event?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  // Slide-over panel.
  await page.getByRole('button', { name: 'Open slide-over' }).click();
  const sheet = page.getByRole('dialog', { name: 'New event' });
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  expect(box.x + box.width).toBeGreaterThan((page.viewportSize()?.width ?? 0) - 2);
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toBeHidden();

  // Toast: announced politely and dismissible.
  await page.getByRole('button', { name: 'Show a toast' }).click();
  await expect(page.locator('.toast')).toContainText('Settings saved (1).');
  await page.locator('.toast').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.locator('.toast')).toHaveCount(0);
});

test('reduced motion turns transitions off', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await workspace(page);
  await page.goto('/design-system');
  await page.getByRole('button', { name: 'Open dialog' }).click();
  const duration = await page
    .getByRole('dialog', { name: 'Archive this event?' })
    .evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
  expect(duration).toBeLessThan(0.001);
});

test('the builder pattern reorders, hides, duplicates, undoes and previews sizes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await workspace(page);
  await page.goto('/design-system');
  const builder = page.locator('.builder');
  const sectionNames = () =>
    builder.locator('.section-item__select').evaluateAll((els) => els.map((e) => e.textContent));
  const preview = builder.getByRole('region', { name: 'Preview' });

  expect(await sectionNames()).toEqual(['Hero', 'About', 'Agenda', 'Speakers', 'Registration']);
  await builder.getByRole('button', { name: 'Move About: Why attend down' }).click();
  expect(await sectionNames()).toEqual(['Hero', 'Agenda', 'About', 'Speakers', 'Registration']);
  await expect(builder.getByRole('status')).toHaveText('About moved down');

  await builder.getByRole('button', { name: 'Hide Speakers: Speakers' }).click();
  await expect(preview.getByRole('region', { name: 'Speakers' })).toHaveCount(0);
  await builder.getByRole('button', { name: 'Undo' }).click();
  await expect(preview.getByRole('region', { name: 'Speakers' })).toHaveCount(1);
  await builder.getByRole('button', { name: 'Redo' }).click();
  await expect(preview.getByRole('region', { name: 'Speakers' })).toHaveCount(0);

  await builder.getByRole('button', { name: 'Duplicate Agenda: Agenda' }).click();
  expect(await sectionNames()).toEqual([
    'Hero',
    'Agenda',
    'Agenda',
    'About',
    'Speakers (hidden)',
    'Registration',
  ]);

  // Configure the selected section; the preview follows.
  await builder.getByRole('button', { name: 'Hero', exact: true }).click();
  await builder.getByLabel('Heading').fill('Systematic Elegance Summit');
  await builder.getByLabel('Text').click();
  await expect(preview.getByRole('heading', { name: 'Systematic Elegance Summit' })).toBeVisible();

  // Responsive preview.
  await builder.getByRole('button', { name: 'Phone preview' }).click();
  await expect(builder.getByRole('button', { name: 'Phone preview' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect
    .poll(async () => (await builder.locator('.preview').boundingBox())!.width)
    .toBeLessThanOrEqual(390);
  // Saving needs the page API; the buttons say so instead of pretending.
  await expect(builder.getByRole('button', { name: 'Publish' })).toBeDisabled();
});
