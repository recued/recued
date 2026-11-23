import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installProjectWorkSearchFixture } from './helpers/project-work-search-fixture.js';

installFullAppHooks();
const overview = (page: Page) => page.locator('[data-project-overview="launch"]');
const section = (page: Page, kind: 'task' | 'note' | 'commitment') => overview(page).locator(`[data-project-section="${kind}"]`);
const rows = (page: Page, kind: 'task' | 'note' | 'commitment') => section(page, kind).locator('[data-project-item-id]');
const query = (page: Page) => overview(page).getByRole('searchbox', { name: 'Search this project', exact: true });
const search = async (page: Page, value = 'école_100%') => { await query(page).fill(value); await query(page).press('Enter'); };
const boot = async (page: Page) => {
  const fixture = await installProjectWorkSearchFixture(page);
  await page.goto(`${HARNESS_URL}?data=today#data/project`); await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-entity-id="launch"]').click(); await expect(rows(page, 'task')).toHaveCount(10);
  return fixture;
};

test('searches the complete linked project with matching passages, safe highlights and status-aware counts', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 }); const fixture = await boot(page);
  try {
    await search(page);
    await expect(section(page, 'task').locator('[data-project-match-count]')).toHaveText('Showing 10 of 25 matching tasks.');
    await expect(section(page, 'note').locator('[data-project-match-count]')).toHaveText('Showing 10 of 25 matching notes.');
    await expect(section(page, 'commitment').locator('[data-project-match-count]')).toHaveText('Showing 10 of 20 matching commitments · outstanding only.');
    await expect(overview(page)).toContainText('Matching tasks: 20 open · 5 completed tasks');
    for (const kind of ['task', 'note', 'commitment'] as const) {
      await expect(rows(page, kind).first().locator('mark')).toHaveText(['ÉCOLE', '100']);
      await expect(rows(page, kind).first()).toContainText('<img src=x'); await expect(section(page, kind).locator('img,script')).toHaveCount(0);
    }
    await expect(overview(page)).not.toContainText('Unlinked matching note'); await expect(overview(page)).not.toContainText('Other matching task');
    await section(page, 'task').getByRole('button', { name: 'Completed', exact: true }).click(); await expect(rows(page, 'task')).toHaveCount(5);
    await expect(section(page, 'task').locator('[data-project-match-count]')).toHaveText('Showing 5 of 5 matching tasks · completed only.');
    await section(page, 'commitment').getByRole('button', { name: 'All', exact: true }).click();
    await expect(section(page, 'commitment').locator('[data-project-match-count]')).toHaveText('Showing 10 of 25 matching commitments.');
    await query(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('project-search-phone.png'), fullPage: true });
    expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

test('keeps an unapplied search draft and its caret through a reply, then retires an older query', async ({ page }) => {
  const fixture = await boot(page);
  try {
    fixture.hold('task', 'école_100%'); await search(page); await expect.poll(fixture.pending).toBe(true);
    await query(page).fill('Unapplied words'); await query(page).evaluate((node: HTMLInputElement) => node.setSelectionRange(3, 3));
    fixture.release(); await expect(rows(page, 'task')).toHaveCount(10); await expect(query(page)).toHaveValue('Unapplied words');
    await expect(query(page)).toBeFocused(); expect(await query(page).evaluate((node: HTMLInputElement) => node.selectionStart)).toBe(3);
    await expect(overview(page).locator('#project-search-status')).toContainText('Results for “école_100%”');
    await search(page, 'Launch task'); await expect(section(page, 'task').locator('[data-project-match-count]')).toContainText('of 35 matching tasks');
    fixture.hold('task', 'école_100%'); await search(page); await expect.poll(fixture.pending).toBe(true);
    await search(page, 'missing phrase'); await expect(rows(page, 'task')).toHaveCount(0);
    await expect(section(page, 'task').locator('[data-project-match-count]')).toContainText('of 0 matching tasks');
    fixture.release(); await expect(query(page)).toHaveValue('missing phrase'); await expect(rows(page, 'task')).toHaveCount(0);
    await expect(section(page, 'note')).toContainText('No matching notes with these filters.'); expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

test('retains loaded matches after a failed next page, retries its offset and rejects an older server’s unfiltered results', async ({ page }) => {
  const fixture = await boot(page);
  try {
    await search(page); await expect(rows(page, 'note')).toHaveCount(10);
    fixture.fail({ kind: 'note', offset: 10 }); await section(page, 'note').getByRole('button', { name: 'More notes', exact: true }).click();
    await expect(section(page, 'note').getByRole('alert')).toContainText('note search was interrupted'); await expect(rows(page, 'note')).toHaveCount(10);
    fixture.fail(null); await section(page, 'note').getByRole('button', { name: 'Try notes again', exact: true }).click();
    await expect(rows(page, 'note')).toHaveCount(20);
    expect(fixture.reads.filter(args => args.kind === 'note').slice(-2).map(args => ({ query: args.query, offset: args.offset })))
      .toEqual([{ query: 'école_100%', offset: 10 }, { query: 'école_100%', offset: 10 }]);
    fixture.legacy(true); await search(page, 'should not match anything');
    for (const kind of ['task', 'note', 'commitment'] as const) {
      await expect(section(page, kind).getByRole('alert')).toContainText('Update your Recued server to search'); await expect(rows(page, kind)).toHaveCount(0);
    }
    await overview(page).getByRole('button', { name: 'Clear search', exact: true }).click();
    await expect(query(page)).toHaveValue(''); await expect(rows(page, 'note')).toHaveCount(10); expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

test('returns from the exact note with its project query, status filters, loaded results and scroll intact', async ({ page }) => {
  const fixture = await boot(page);
  try {
    await search(page); await section(page, 'task').getByRole('button', { name: 'Completed', exact: true }).click();
    await expect(rows(page, 'task')).toHaveCount(5);
    await section(page, 'note').getByRole('button', { name: 'More notes', exact: true }).click(); await expect(rows(page, 'note')).toHaveCount(20);
    const chosen = rows(page, 'note').last(), id = await chosen.getAttribute('data-project-item-id'), title = await chosen.locator('.project-work-item-title').innerText();
    await chosen.scrollIntoViewIfNeeded(); const host = page.locator('[data-recued-webclient-content]'), scroll = await host.evaluate(node => node.scrollTop);
    await chosen.click(); const reader = page.locator('.work-entity-note-reader');
    await expect(reader.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await reader.getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(overview(page).locator('[data-project-section][aria-busy="false"]')).toHaveCount(3);
    await expect(query(page)).toHaveValue('école_100%'); await expect(rows(page, 'note')).toHaveCount(20);
    await expect(section(page, 'task').getByRole('button', { name: 'Completed', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const returned = section(page, 'note').locator(`[data-project-item-id="${id}"]`);
    await expect(returned).toBeFocused(); await expect(returned).toBeInViewport();
    expect(Math.abs(await host.evaluate(node => node.scrollTop) - scroll)).toBeLessThanOrEqual(1); expect(fixture.writes).toEqual([]);
    await returned.click(); await expect(reader).toBeVisible(); await page.goBack();
    await expect(query(page)).toHaveValue('école_100%'); await expect(rows(page, 'note')).toHaveCount(20);
    await expect(section(page, 'task').getByRole('button', { name: 'Completed', exact: true })).toHaveAttribute('aria-pressed', 'true');
  } finally { fixture.dispose(); }
});
