import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL } from './helpers/full-app.js';

/** D-402 slice F4d (§7.9) — what your chats and AI apps run without asking, and ending it, where the
 *  owner meets it: Contracts, an AI app's page and a recipe's page. The panel and its mounts are the
 *  real ones; the owner rpcs answer from `harness/caller-preapproval.ts`. */

const PANEL = '[data-recued-caller-preapproval-panel]';
const ROW = '[data-recued-caller-preapproval-row]';
const NOTE = '[data-recued-caller-preapproval-note]';
const CLAUDE = { kind: 'ai_app', contract_id: 'k-claude' };

const open = async (page: Page, query: string, hash: string): Promise<string[]> => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`${HARNESS_URL}?${query}${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  return errors;
};

/** What each "Stop allowing" asked to end, in order. */
const ended = (page: Page) => page.evaluate(() =>
  ((JSON.parse(sessionStorage.getItem('recued-test-caller-preapprovals') ?? 'null')?.calls ?? []) as
    Array<{ method: string; args: unknown }>)
    .filter((call) => call.method === 'collection.contract.stopAllowing').map((call) => call.args));

const fits = (locator: ReturnType<Page['locator']>) => locator.evaluate((element) => element.scrollWidth <= element.clientWidth);

test('Contracts lists what your chats and AI apps run without asking; "End it" asks once more, then ends one', async ({ page }) => {
  const errors = await open(page, 'caller_preapprovals=1', '#contracts');
  const panel = page.locator(PANEL);
  await expect(panel.getByRole('heading', { name: 'Recipes that run without asking', level: 2 })).toBeVisible();
  const cards = panel.locator(ROW);
  await expect(cards).toHaveCount(4);
  const mine = panel.locator(`${ROW.slice(0, -1)}="owner_chat|autorun-live-1"]`);
  await expect(mine).toContainText('Watch pipeline');
  await expect(mine).toContainText('Your chats run it without asking');
  await expect(mine).toContainText('Every time, until you end it · used 2 times');
  await expect(panel.locator(`${ROW.slice(0, -1)}="owner_chat|file-bill"]`)).toContainText('This run only: it ends with the run');
  await expect(panel.locator(`${ROW.slice(0, -1)}="ai_app:k-claude|file-bill"]`)).toContainText('Claude Desktop runs it without asking');
  // An ended one is gone from the owner's view.
  await expect(panel).not.toContainText('Old report');
  expect(await fits(panel)).toBe(true);

  await mine.getByRole('button', { name: 'End it' }).click();
  await expect(mine).toContainText('It asks again from now on.');
  await expect(mine.getByRole('button', { name: 'End it' })).toBeFocused();
  expect(await ended(page)).toEqual([]);
  await mine.getByRole('button', { name: 'End it' }).click();
  await expect(panel.locator(NOTE)).toHaveText('Ended 1 standing approval. It asks again from now on.');
  await expect(mine).toHaveCount(0);
  await expect(cards).toHaveCount(3);
  expect(await ended(page)).toEqual([{ caller: { kind: 'owner_chat' }, recipe_id: 'autorun-live-1' }]);
  expect(errors).toEqual([]);
});

test('an AI app\'s page lists each recipe it runs without asking; "End all" ends every one', async ({ page }) => {
  const errors = await open(page, 'caller_preapprovals=1', '#contracts/k-claude');
  const section = page.locator('[data-recued-contracts-app-preapprovals]');
  await expect(section.getByRole('heading', { name: 'Runs without asking' })).toBeVisible();
  const cards = section.locator(ROW);
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('Watch pipeline');
  await expect(cards.nth(0)).toContainText('Every time, until you end it · used 5 times');
  await expect(cards.nth(1)).toContainText('File the water bill');
  // Only this app's: your chats' are on Contracts, not here.
  await expect(section).not.toContainText('Your chats');
  expect(await fits(section)).toBe(true);

  await section.getByRole('button', { name: 'End all' }).click();
  await expect(section).toContainText('Each of these asks again from now on.');
  expect(await ended(page)).toEqual([]);
  await section.getByRole('button', { name: 'End all' }).click();
  await expect(section.locator(NOTE)).toHaveText('Ended 2 standing approvals and 1 site pass. They ask again from now on.');
  await expect(cards).toHaveCount(0);
  expect(await ended(page)).toEqual([
    { caller: CLAUDE, recipe_id: 'autorun-live-1' }, { caller: CLAUDE, recipe_id: 'file-bill' }]);
  expect(errors).toEqual([]);
});

test('a recipe\'s page says who runs it without asking, after its runs and automation', async ({ page }) => {
  const errors = await open(page, 'recipes=installed&caller_preapprovals=1', '#recipes/autorun-live-1');
  const section = page.locator('[data-recued-recipe-preapprovals]');
  await expect(section.getByRole('heading', { name: 'Runs without asking', level: 2 })).toBeVisible();
  expect(await section.evaluate((element) => element.previousElementSibling?.querySelector('h2')?.textContent ?? null))
    .toBe('Runs & automation');
  const cards = section.locator(ROW);
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('Your chats');
  await expect(cards.nth(1)).toContainText('Claude Desktop');
  // Another recipe's are not this page's.
  await expect(section).not.toContainText('File the water bill');
  expect(await fits(section)).toBe(true);

  const claude = section.locator(`${ROW.slice(0, -1)}="ai_app:k-claude|autorun-live-1"]`);
  await claude.getByRole('button', { name: 'End it' }).click();
  await claude.getByRole('button', { name: 'End it' }).click();
  await expect(section.locator(NOTE)).toHaveText('Ended 1 standing approval. It asks again from now on.');
  await expect(cards).toHaveCount(1);
  expect(await ended(page)).toEqual([{ caller: CLAUDE, recipe_id: 'autorun-live-1' }]);

  // The page is drawn again on the way back: the one section returns in its place, read again.
  await page.evaluate(() => { window.__app?.setHash('#recipes'); });
  await expect(section).toHaveCount(0);
  await page.evaluate(() => { window.__app?.setHash('#recipes/autorun-live-1'); });
  await expect(section).toHaveCount(1);
  await expect(cards).toHaveCount(1);
  await expect(cards.nth(0)).toContainText('Your chats');
  expect(await section.evaluate((element) => element.previousElementSibling?.querySelector('h2')?.textContent ?? null))
    .toBe('Runs & automation');
  expect(errors).toEqual([]);
});

test('a refused end says why and keeps the card; a server from before these shows nothing', async ({ page }) => {
  const errors = await open(page, 'caller_preapprovals=fail', '#contracts');
  const panel = page.locator(PANEL);
  const mine = panel.locator(`${ROW.slice(0, -1)}="owner_chat|autorun-live-1"]`);
  await mine.getByRole('button', { name: 'End it' }).click();
  await mine.getByRole('button', { name: 'End it' }).click();
  await expect(mine.getByRole('alert')).toHaveText('Recued could not end it: Recued is busy, try again in a moment');
  await expect(panel.locator(NOTE)).toHaveCount(0);
  // Still there, to try again from where the owner was.
  await expect(mine.getByRole('button', { name: 'End it' })).toBeFocused();
  await mine.getByRole('button', { name: 'End it' }).click();
  await expect(panel.locator(NOTE)).toHaveText('Ended 1 standing approval. It asks again from now on.');
  expect(errors).toEqual([]);

  const older = await page.context().newPage();
  const olderErrors = await open(older, 'recipes=installed&caller_preapprovals=older', '#recipes/autorun-live-1');
  await expect(older.getByRole('heading', { name: 'Runs & automation' })).toBeVisible();
  await expect(older.locator(PANEL)).toHaveCount(0);
  await older.evaluate(() => { window.__app?.setHash('#contracts'); });
  await expect(older.getByRole('heading', { name: 'Recipes that run without asking' })).toHaveCount(0);
  expect(olderErrors).toEqual([]);
});

test('a run\'s page in Logs names an "Always" that let it through, and "Stop allowing" ends it there', async ({ page }) => {
  const errors = await open(page, 'journey=verification&caller_preapprovals=1', '#logs/run-verify');
  const always = page.locator('[data-run-preapproved-always="ai_app:k-claude|file-bill"]');
  await expect(always).toContainText('Ran without asking, as you allowed “Always” for Claude Desktop:');
  await expect(page.locator('[data-run-preapproved-this-run]')).toContainText('Ran without asking, as you approved this run before it started:');
  await expect(page.locator('[data-run-preapproved-this-run]')).not.toContainText('stays on');
  expect(await fits(page.locator('[data-run-preapproved-always]'))).toBe(true);

  await always.getByRole('button', { name: 'Stop allowing' }).click();
  await expect(always).toContainText('It asks again from now on.');
  await expect(always.getByRole('button', { name: 'Stop allowing' })).toBeFocused();
  expect(await ended(page)).toEqual([]);
  await always.getByRole('button', { name: 'Stop allowing' }).click();
  const note = always.getByRole('status');
  await expect(note).toHaveText('Ended 1 standing approval and 1 site pass. It asks again from now on.');
  await expect(note).toBeFocused();
  expect(await ended(page)).toEqual([{ caller: CLAUDE, recipe_id: 'file-bill' }]);
  expect(errors).toEqual([]);
});
