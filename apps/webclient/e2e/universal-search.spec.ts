import { expect, test, type Page } from '@playwright/test';

const input = (page: Page) => page.getByRole('searchbox', { name: 'Search everything' });
const calls = (page: Page, kind: string) => page.evaluate(kind =>
  window.__universalSearch.calls.filter(call => call.kind === kind).map(call => call.query), kind);
const release = (page: Page, kind: 'records' | 'recipes' | 'packs' | 'marketplace' | 'work' | 'work-page', index = 0, outcome: 'empty' | 'match' | 'error' = 'empty') =>
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
    await expect(page.getByRole('alert')).toContainText('Installed recipes could not be searched');
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
  await expect(page.getByText(/No matches in the searched sources/)).toHaveCount(0);
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
  await expect(page.getByText('Type to search saved data on this server.')).toBeVisible();
  await release(page, 'records', 0, 'error');
  await release(page, 'recipes', 0, 'match');
  await release(page, 'packs');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(input(page)).toHaveValue('');
  await expect(input(page)).toBeFocused();
  await expect(page.getByText('Type to search saved data on this server.')).toBeVisible();
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

test('native work results page, open the right kind, and return from edits to the same search', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/universal-search-harness.html?native=1');
  await page.waitForFunction(() => window.__universalSearch?.ready === true);
  await input(page).fill('kestrel');
  const group = (kind: string) => page.locator(`[data-work-search-group="${kind}"]`);
  const result = (kind: string, id: string) => group(kind).locator(`[data-search-work-id="${id}"]`);
  for (const name of ['Tasks', 'Notes', 'Projects', 'Commitments']) await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(group('note').getByText('may be out of date')).toBeVisible();
  await expect(group('note').locator('img')).toHaveCount(0);
  await release(page, 'records', 0, 'match'); await release(page, 'recipes'); await release(page, 'packs');
  await expect(page.getByRole('button', { name: /Record for kestrel/ })).toBeVisible();
  await page.getByRole('button', { name: 'More notes', exact: true }).focus();
  await page.evaluate(() => {
    for (let count = 0; count < 2; count++) document.querySelector<HTMLButtonElement>('[data-search-work-kind="note"][data-recued-data-action="universal-search-more-work"]')?.click();
  });
  await expect(group('note').locator('[data-search-work-id]')).toHaveCount(11);
  await expect(result('note', 'note-4')).toBeFocused();
  expect(await page.evaluate(() => window.__universalSearch.workRequests.filter(request => request.kind === 'note' && request.offset === 5).length)).toBe(1);
  await result('task', 'shared-id').click();
  const task = page.getByRole('dialog', { name: 'Edit Task', exact: true });
  await expect(task.getByLabel('Title')).toHaveValue('Kestrel task');
  await task.getByLabel('Title').fill('Kestrel task updated'); await task.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(input(page)).toHaveValue('kestrel');
  await expect(result('task', 'shared-id')).toContainText('Kestrel task updated');
  await expect(result('task', 'shared-id')).toBeFocused();
  expect(await page.evaluate(() => window.__universalSearch.workWrites)).toEqual([{ kind: 'task', id: 'shared-id', title: 'Kestrel task updated' }]);
  await result('note', 'note-9').scrollIntoViewIfNeeded();
  const readingPosition = await page.evaluate(() => document.scrollingElement?.scrollTop);
  await result('note', 'note-9').click();
  const reader = page.locator('.work-entity-note-reader');
  await expect(reader.getByRole('heading', { name: 'Kestrel note 9', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#data\/note\/note-9$/);
  await reader.getByRole('button', { name: 'Back to search', exact: true }).click();
  await expect(result('note', 'note-9')).toBeFocused();
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop)).toBe(readingPosition);
  await expect(group('note').locator('[data-search-work-id]')).toHaveCount(11);
  await result('note', 'note-9').click(); await reader.getByRole('button', { name: 'Edit', exact: true }).click();
  const editedNote = page.getByRole('dialog', { name: 'Edit Note', exact: true });
  await editedNote.getByLabel('Title').fill('Renamed note'); await editedNote.getByLabel('Note text').fill('New wording without the former search term.');
  await editedNote.getByRole('button', { name: 'Save', exact: true }).click();
  await reader.getByRole('button', { name: 'Back to search', exact: true }).click();
  await expect(group('note').locator('[data-search-work-id]')).toHaveCount(10);
  await expect(input(page)).toBeFocused(); await expect(input(page)).toBeInViewport();
  await result('note', 'shared-id').click();
  await expect(reader.locator('[data-note-body] img')).toHaveCount(0);
  await reader.getByRole('button', { name: 'Edit', exact: true }).click();
  const note = page.getByRole('dialog', { name: 'Edit Note', exact: true });
  await note.getByLabel('Title').fill('Unsaved title'); await note.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(reader.getByRole('heading', { name: 'Kestrel note', exact: true })).toBeVisible();
  await reader.getByRole('button', { name: 'Back to search', exact: true }).click();
  await result('project', 'project-one').click();
  const overview = page.locator('[data-project-overview="project-one"]');
  await expect(overview.getByRole('heading', { name: 'Kestrel project', exact: true })).toBeVisible();
  await overview.getByRole('button', { name: 'Edit project', exact: true }).click();
  await page.getByRole('dialog', { name: 'Edit Project', exact: true }).getByRole('button', { name: 'Back to project', exact: true }).click();
  await expect(overview).toBeVisible();
  await overview.getByRole('button', { name: 'Back to search', exact: true }).click();
  await expect(result('project', 'project-one')).toBeFocused();
  for (const [kind, id, name] of [['commitment', 'promise-one', 'Edit Commitment']] as const) {
    await result(kind, id).click();
    const dialog = page.getByRole('dialog', { name, exact: true });
    await expect(dialog).toBeVisible(); await dialog.getByRole('button', { name: 'Back to search', exact: true }).click();
    await expect(result(kind, id)).toBeFocused();
  }
  await expect(input(page)).toHaveValue('kestrel');
  expect(await calls(page, 'marketplace')).toEqual([]);
});

test('native work failures and late replies preserve other results without sending the query to the marketplace', async ({ page }) => {
  await page.goto('/universal-search-harness.html?native=manual');
  await page.waitForFunction(() => window.__universalSearch?.ready === true);
  await input(page).fill('kestrel'); await expect.poll(() => calls(page, 'work')).toEqual(['kestrel']);
  await input(page).fill('project'); await expect.poll(() => calls(page, 'work')).toEqual(['kestrel', 'project']);
  await release(page, 'records', 1, 'match');
  const collectionResult = page.getByRole('button', { name: /Record for project/ });
  await expect(collectionResult).toBeVisible(); await collectionResult.focus();
  await release(page, 'work', 1, 'match');
  await expect(page.locator('[data-work-search-group="project"]')).toBeVisible();
  await expect(collectionResult).toBeFocused();
  await release(page, 'work', 0, 'match');
  await expect(page.locator('[data-work-search-group="task"]')).toHaveCount(0);
  await page.evaluate(() => window.__universalSearch.failWorkKind('note'));
  await input(page).fill('kestrel'); await expect.poll(() => calls(page, 'work')).toEqual(['kestrel', 'project', 'kestrel']);
  await release(page, 'work', 2, 'match'); await release(page, 'records', 2, 'match');
  await release(page, 'recipes', 2); await release(page, 'packs', 2);
  await expect(page.locator('[data-work-search-group="note"]').getByRole('alert')).toContainText('could not be searched');
  await expect(page.locator('[data-work-search-group="task"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /Record for kestrel/ })).toBeVisible();
  await page.evaluate(() => window.__universalSearch.failWorkKind());
  await page.getByRole('button', { name: 'Try Notes again', exact: true }).click();
  await expect.poll(() => calls(page, 'work-page')).toEqual(['kestrel']); await release(page, 'work-page');
  await expect(page.locator('[data-work-search-group="note"] [data-search-work-id]')).toHaveCount(5);
  await input(page).fill('no matches'); await expect.poll(() => calls(page, 'work')).toHaveLength(4);
  await release(page, 'work', 3, 'error'); await release(page, 'records', 3, 'match');
  await release(page, 'recipes', 3); await release(page, 'packs', 3);
  await expect(page.getByRole('button', { name: /Record for no matches/ })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('commitments could not be searched');
  await expect(page.getByRole('button', { name: /Look for/ })).toHaveCount(0);
  await input(page).fill('unfindable'); await expect.poll(() => calls(page, 'work')).toHaveLength(5);
  await release(page, 'work', 4); await release(page, 'records', 4);
  await release(page, 'recipes', 4, 'error'); await release(page, 'packs', 4, 'error');
  await expect(page.getByRole('alert')).toContainText('Installed recipes could not be searched.');
  await expect(page.getByRole('alert')).toContainText('Installed packs could not be searched.');
  await expect(page.locator('.rq-empty')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Look for/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect.poll(() => calls(page, 'work')).toHaveLength(6);
  await release(page, 'work', 5); await release(page, 'records', 5);
  await release(page, 'recipes', 5); await release(page, 'packs', 5);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.rq-empty')).toContainText('No matches in the searched sources');
  await expect(page.getByRole('button', { name: /Look for/ })).toBeVisible();
  expect(await calls(page, 'marketplace')).toEqual([]);
});
