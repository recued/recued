import { expect, test, type Page } from '@playwright/test';

type Platform = 'mail' | 'calendar' | 'file';
const calls = (page: Page, kind: 'instances' | 'list' | 'get') => page.evaluate(kind =>
  window.__universalSearch.calls.filter(call => call.kind === kind).map(call => call.query), kind);
const release = (page: Page, kind: 'instances' | 'list' | 'get', index = 0, outcome: 'empty' | 'error' = 'empty') =>
  page.evaluate(({ kind, index, outcome }) => window.__universalSearch.release(kind, index, outcome), { kind, index, outcome });
const source = (page: Page, slug: string) => page.locator(`[data-collection-slug="${slug}"]`);
const row = (page: Page, slug: string) => page.locator(`[data-collection-record="${slug}-1"]`);
const TAB_NAMES: Readonly<Record<string, string>> = {
  contact: 'Contacts', mail: 'Mail', calendar: 'Calendar', files: 'Files', search: 'Search',
};
const tab = (page: Page, name: string) => page.getByRole('tab', {
  name: TAB_NAMES[name] ?? name,
  exact: true,
});
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const open = async (page: Page, platform: Platform = 'mail') => {
  await page.goto(`/universal-search-harness.html?navigation=${platform}`);
  await page.waitForFunction(() => window.__universalSearch?.ready === true);
  await page.getByRole('searchbox', { name: 'Search everything' }).fill('kestrel');
  await expect(page.getByRole('button', { name: 'More in work', exact: true })).toBeVisible();
};

const errors: string[] = [];
test.beforeEach(({ page }) => {
  errors.length = 0;
  page.on('pageerror', error => errors.push(error.message));
});
test.afterEach(() => expect(errors).toEqual([]));

for (const platform of ['mail', 'calendar', 'file'] as const) {
  for (const action of ['group', 'record'] as const) {
    for (const width of [390, 1280]) {
      test(`${platform} ${action} handoff waits for its source at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await open(page, platform);
        const button = page.getByRole('button', { name: action === 'group' ? 'More in work' : /Search work/, exact: action === 'group' });
        await button.focus();
        await page.keyboard.press('Enter');
        await expect.poll(() => calls(page, 'instances')).toEqual([platform]);
        await expect(page.getByRole('status').filter({ hasText: 'Loading sources…' })).toBeVisible();
        expect(await calls(page, 'list')).toEqual([]);
        await release(page, 'instances');
        await expect.poll(() => calls(page, 'list')).toEqual([`${platform}/work`]);
        await expect(source(page, 'work')).toHaveAttribute('aria-pressed', 'true');
        await release(page, 'list');
        if (action === 'record') {
          await expect.poll(() => calls(page, 'get')).toEqual([`${platform}/work/work-1`]);
          await release(page, 'get');
          await expect(page.locator('[data-recued-collection-detail-heading]'))
            .toHaveText(platform === 'file' ? 'work-file.txt' : 'work record');
        } else {
          await expect(row(page, 'work')).toBeVisible();
          const destination = width === 390
            ? page.getByRole('combobox', { name: 'Collection', exact: true })
            : tab(page, platform === 'file' ? 'files' : platform);
          await expect(destination).toBeFocused();
          expect(await calls(page, 'get')).toEqual([]);
        }
        await expect(page.getByText(/Nothing connected for .+ yet/)).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      });
    }
  }
}

test('changing accounts while a record handoff waits cannot open that record in the new account', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: /Search work/ }).click();
  await expect.poll(() => calls(page, 'instances')).toEqual(['mail']);
  await release(page, 'instances');
  await expect.poll(() => calls(page, 'list')).toEqual(['mail/work']);
  await source(page, 'personal').click();
  await expect.poll(() => calls(page, 'list')).toEqual(['mail/work', 'mail/personal']);
  await release(page, 'list', 1);
  await row(page, 'personal').click();
  await expect.poll(() => calls(page, 'get')).toEqual(['mail/personal/personal-1']);
  await release(page, 'list', 0);
  await settle(page);
  expect(await calls(page, 'get')).toEqual(['mail/personal/personal-1']);
  await release(page, 'get');
  await expect(page.locator('[data-recued-collection-detail-heading]')).toHaveText('personal record');
});

test('leaving and returning to the same tab retires the earlier record handoff', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: /Search work/ }).click();
  await expect.poll(() => calls(page, 'instances')).toEqual(['mail']);
  await tab(page, 'contact').click();
  await tab(page, 'mail').click();
  await expect.poll(() => calls(page, 'instances')).toEqual(['mail', 'mail']);
  await release(page, 'instances', 0);
  await settle(page);
  expect(await calls(page, 'list')).toEqual([]);
  await release(page, 'instances', 1);
  await expect(page.getByText('Choose an instance above to browse its records.')).toBeVisible();
  expect(await calls(page, 'get')).toEqual([]);
});

test('a newer result selection finishes before the older source list responds', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'More in work', exact: true }).click();
  await expect.poll(() => calls(page, 'instances')).toEqual(['mail']);
  await tab(page, 'search').click();
  await page.getByRole('button', { name: 'More in personal', exact: true }).click();
  await expect.poll(() => calls(page, 'instances')).toEqual(['mail', 'mail']);
  await release(page, 'instances', 1);
  await expect.poll(() => calls(page, 'list')).toEqual(['mail/personal']);
  await release(page, 'list');
  await expect(row(page, 'personal')).toBeVisible();
  await release(page, 'instances', 0);
  await settle(page);
  await expect(source(page, 'personal')).toHaveAttribute('aria-pressed', 'true');
  expect(await calls(page, 'list')).toEqual(['mail/personal']);
});

test('a source removed after search is named as missing and another account stays selectable', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__universalSearch.removeSource('work'));
  await page.getByRole('button', { name: 'More in work', exact: true }).click();
  await expect.poll(() => calls(page, 'instances')).toEqual(['mail']);
  await release(page, 'instances');
  await expect(page.getByRole('alert')).toHaveText('The source this record came from is gone.');
  expect(await calls(page, 'list')).toEqual([]);
  expect(await calls(page, 'get')).toEqual([]);
  await source(page, 'personal').click();
  await expect.poll(() => calls(page, 'list')).toEqual(['mail/personal']);
  await release(page, 'list');
  await expect(row(page, 'personal')).toBeVisible();
});

test('retrying a failed source list preserves the source chosen from Search', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'More in work', exact: true }).click();
  await expect.poll(() => calls(page, 'instances')).toEqual(['mail']);
  await release(page, 'instances', 0, 'error');
  await expect(page.getByRole('alert')).toContainText('Failed instances');
  expect(await calls(page, 'list')).toEqual([]);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => calls(page, 'instances')).toEqual(['mail', 'mail']);
  await release(page, 'instances', 1);
  await expect.poll(() => calls(page, 'list')).toEqual(['mail/work']);
  await release(page, 'list');
  await expect(row(page, 'work')).toBeVisible();
  await expect(source(page, 'work')).toHaveAttribute('aria-pressed', 'true');
});

for (const phase of ['instances', 'list'] as const) {
  test(`Back retires a record handoff while ${phase} is pending`, async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: /Search work/ }).click();
    await expect.poll(() => calls(page, 'instances')).toEqual(['mail']);
    if (phase === 'list') {
      await release(page, 'instances');
      await expect.poll(() => calls(page, 'list')).toEqual(['mail/work']);
    }
    await page.goBack();
    await expect(tab(page, 'contact')).toHaveAttribute('aria-selected', 'true');
    await release(page, phase);
    await settle(page);
    await expect(tab(page, 'contact')).toHaveAttribute('aria-selected', 'true');
    expect(await calls(page, 'get')).toEqual([]);
    expect(await calls(page, 'list')).toEqual(phase === 'list' ? ['mail/work'] : []);
  });
}
