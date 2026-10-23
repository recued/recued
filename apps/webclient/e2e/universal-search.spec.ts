import { expect, test, type Page } from '@playwright/test';

const input = (page: Page) => page.getByRole('searchbox', { name: 'Search everything' });
const calls = (page: Page, kind: string) => page.evaluate(kind =>
  window.__universalSearch.calls.filter(call => call.kind === kind).map(call => call.query), kind);
const release = (page: Page, kind: 'records' | 'recipes' | 'packs' | 'marketplace', index = 0, outcome: 'empty' | 'match' | 'error' = 'empty') =>
  page.evaluate(({ kind, index, outcome }) => window.__universalSearch.release(kind, index, outcome), { kind, index, outcome });
const localEmpty = async (page: Page, index = 0) => {
  await release(page, 'records', index);
  await release(page, 'recipes', index);
  await release(page, 'packs', index);
  await expect(page.getByRole('button', { name: /Look for .+ in the marketplace/ })).toBeVisible();
};

const pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/universal-search-harness.html');
  await page.waitForFunction(() => window.__universalSearch?.ready === true);
});
test.afterEach(() => expect(pageErrors).toEqual([]));

for (const width of [390, 1280]) {
  test(`records arrive before slow capabilities and keep the caret at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await input(page).fill('kestrel');
    await expect.poll(() => calls(page, 'records')).toEqual(['kestrel']);
    await expect.poll(() => calls(page, 'recipes')).toEqual(['kestrel']);
    await expect.poll(() => calls(page, 'packs')).toEqual(['kestrel']);
    await input(page).evaluate((node: HTMLInputElement) => node.setSelectionRange(2, 4, 'backward'));
    await release(page, 'records', 0, 'match');
    await expect(page.getByRole('button', { name: /Record for kestrel/ })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Searching installed recipes and packs' })).toBeVisible();
    await expect(input(page)).toBeFocused();
    expect(await input(page).evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([2, 4, 'backward']);
    await release(page, 'recipes', 0, 'error');
    await release(page, 'packs');
    await expect(page.getByRole('status').filter({ hasText: 'Searching installed recipes and packs' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Record for kestrel/ })).toBeVisible();
    await expect(input(page)).toBeFocused();
    expect(await input(page).evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([2, 4, 'backward']);
    expect(await calls(page, 'marketplace')).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('capability hits appear while records are pending, with no premature empty claim or cloud offer', async ({ page }) => {
  await input(page).fill('project');
  await expect.poll(() => calls(page, 'recipes')).toEqual(['project']);
  await expect.poll(() => calls(page, 'packs')).toEqual(['project']);
  await release(page, 'recipes', 0, 'match');
  await release(page, 'packs');
  await expect(page.getByRole('button', { name: /Recipe for project/ })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Searching records' })).toBeVisible();
  await expect(page.getByText(/Nothing on this server matches/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Look for/ })).toHaveCount(0);
  await release(page, 'records');
  await expect(page.getByRole('status').filter({ hasText: 'Searching records' })).toHaveCount(0);
  expect(await calls(page, 'marketplace')).toEqual([]);
});

for (const outcome of ['match', 'error'] as const) {
  test(`an old marketplace ${outcome} cannot replace the next query or finish its pending request`, async ({ page }) => {
    await input(page).fill('alpha');
    await expect.poll(() => calls(page, 'records')).toEqual(['alpha']);
    await localEmpty(page);
    await page.getByRole('button', { name: /Look for/ }).click();
    await expect.poll(() => calls(page, 'marketplace')).toEqual(['alpha']);
    await input(page).fill('beta');
    await expect.poll(() => calls(page, 'records')).toEqual(['alpha', 'beta']);
    await localEmpty(page, 1);
    await page.getByRole('button', { name: /Look for/ }).click();
    await expect.poll(() => calls(page, 'marketplace')).toEqual(['alpha', 'beta']);
    await input(page).focus();
    await release(page, 'marketplace', 0, outcome);
    await expect(page.getByRole('status')).toHaveText('Asking the marketplace…');
    await expect(page.getByText(/Marketplace for alpha|Failed marketplace for alpha/)).toHaveCount(0);
    await release(page, 'marketplace', 1, 'match');
    await expect(page.getByRole('button', { name: /Marketplace for beta/ })).toBeVisible();
    await expect(input(page)).toHaveValue('beta');
    await expect(input(page)).toBeFocused();
  });
}

test('editing away and back invalidates a pending reply before the debounce fires', async ({ page }) => {
  await page.clock.install();
  await input(page).fill('alpha');
  await page.clock.runFor(200);
  expect(await calls(page, 'records')).toEqual(['alpha']);
  await input(page).fill('beta');
  await input(page).fill('alpha');
  await release(page, 'records', 0, 'match');
  await release(page, 'recipes', 0, 'match');
  await release(page, 'packs');
  await page.clock.runFor(1);
  await expect(page.getByRole('button', { name: /Record for alpha|Recipe for alpha/ })).toHaveCount(0);
  await page.clock.runFor(200);
  expect(await calls(page, 'records')).toEqual(['alpha', 'alpha']);
  await localEmpty(page, 1);
});

test('clearing the query retires all pending reads and restores the prompt', async ({ page }) => {
  await input(page).fill('alpha');
  await expect.poll(() => calls(page, 'records')).toEqual(['alpha']);
  await input(page).fill('');
  await expect(page.getByText('Type to search across everything on this server.')).toBeVisible();
  await release(page, 'records', 0, 'error');
  await release(page, 'recipes', 0, 'match');
  await release(page, 'packs');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(input(page)).toHaveValue('');
  await expect(input(page)).toBeFocused();
  await expect(page.getByText('Type to search across everything on this server.')).toBeVisible();
  expect(await calls(page, 'marketplace')).toEqual([]);
});

test('leaving Search retires a pending marketplace request and allows another explicit search on return', async ({ page }) => {
  await input(page).fill('alpha');
  await expect.poll(() => calls(page, 'records')).toEqual(['alpha']);
  await localEmpty(page);
  await page.getByRole('button', { name: /Look for/ }).click();
  await expect.poll(() => calls(page, 'marketplace')).toEqual(['alpha']);
  await page.evaluate(() => window.__universalSearch.selectTab('contact'));
  await release(page, 'marketplace', 0, 'error');
  await page.evaluate(() => { void window.__universalSearch.selectTab('search'); });
  await expect.poll(() => calls(page, 'records')).toEqual(['alpha', 'alpha']);
  await localEmpty(page, 1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: /Look for/ }).click();
  await expect.poll(() => calls(page, 'marketplace')).toEqual(['alpha', 'alpha']);
  await release(page, 'marketplace', 1, 'match');
  await expect(page.getByRole('button', { name: /Marketplace for alpha/ })).toBeVisible();
});

test('an outdated marketplace offer cannot send the newly typed query during the debounce', async ({ page }) => {
  await page.clock.install();
  await input(page).fill('alpha');
  await page.clock.runFor(200);
  await localEmpty(page);
  await input(page).fill('beta');
  await page.getByRole('button', { name: 'Look for “alpha” in the marketplace' }).click();
  expect(await calls(page, 'marketplace')).toEqual([]);
  await page.clock.runFor(200);
  await localEmpty(page, 1);
  await page.getByRole('button', { name: 'Look for “beta” in the marketplace' }).click();
  expect(await calls(page, 'marketplace')).toEqual(['beta']);
  await release(page, 'marketplace', 0, 'match');
  await expect(page.getByRole('button', { name: /Marketplace for beta/ })).toBeVisible();
});

test('editing away and back also retires a marketplace reply for those same words', async ({ page }) => {
  await page.clock.install();
  await input(page).fill('alpha');
  await page.clock.runFor(200);
  await localEmpty(page);
  await page.getByRole('button', { name: /Look for/ }).click();
  await input(page).fill('beta');
  await input(page).fill('alpha');
  await release(page, 'marketplace', 0, 'match');
  await page.clock.runFor(1);
  await expect(page.getByRole('button', { name: /Marketplace for alpha/ })).toHaveCount(0);
  await page.clock.runFor(200);
  await localEmpty(page, 1);
  expect(await calls(page, 'marketplace')).toEqual(['alpha']);
});

for (const phase of ['local', 'marketplace'] as const) {
  test(`late ${phase} replies cannot repaint a disposed route`, async ({ page }) => {
    await input(page).fill('alpha');
    await expect.poll(() => calls(page, 'records')).toEqual(['alpha']);
    if (phase === 'marketplace') {
      await localEmpty(page);
      await page.getByRole('button', { name: /Look for/ }).click();
      await expect.poll(() => calls(page, 'marketplace')).toEqual(['alpha']);
    }
    await page.evaluate(() => window.__universalSearch.dispose());
    if (phase === 'local') {
      await release(page, 'records', 0, 'error');
      await release(page, 'recipes', 0, 'match');
      await release(page, 'packs');
    } else await release(page, 'marketplace', 0, 'error');
    await expect(page.locator('#root')).toBeEmpty();
  });
}
