import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL } from './helpers/full-app.js';
import { TRIAL_ANSWER_KEY, TRIAL_RUN_ID, TRIAL_TRIES_KEY } from './fixtures/kitchen-import.js';

/** D-402 slice C5 — "Try it" in Kitchen, through the real app: a draft with settings asks for this
 *  trial's first, its browser setting a choice of the owner's browsers by name; held at a change, the
 *  trial is followed to its end once the owner answers elsewhere, and says whether it is the recipe's
 *  saved test. The server's answers are `fixtures/kitchen-import.ts` (`trial`); what the server does is
 *  `backend/server/src/__tests__/d-402-trial-run.test.ts`. */
const url = `${HARNESS_URL}?kitchen_import=trial&settle_reads=1#kitchen/import/import-fixture`;
const status = (page: Page) => page.locator('[data-recued-recipe-trial-status]');
const captureLine = (page: Page) => page.locator('[data-recued-recipe-trial-capture]');
const tries = (page: Page) => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? '[]') as
  Array<{ recipe: { recipe_id: string }; config: Record<string, unknown> }>, TRIAL_TRIES_KEY);
const HELD = 'It waits for your answer in your approvals. Its result shows here once you answer.';
/** The owner answers in their approvals, on another device; the server broadcasts the run's event. */
const answerElsewhere = async (page: Page, answer: 'approved' | 'denied', op: 'complete' | 'action_changed') => {
  await page.evaluate(({ key, answer, op, run_id }) => {
    sessionStorage.setItem(key, answer);
    window.__app.fireMessage({ type: 'server_event',
      event: { kind: 'execution', recipe_id: 'shop-search-draft', run_id, op, cursor: 9_000 } });
  }, { key: TRIAL_ANSWER_KEY, answer, op, run_id: TRIAL_RUN_ID });
};
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

const pageErrors = new Map<Page, Error[]>();
test.beforeEach(({ page }) => {
  const seen: Error[] = [];
  pageErrors.set(page, seen);
  page.on('pageerror', (error) => seen.push(error));
});
test.afterEach(({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

test('a draft with settings asks for this trial\'s, then shows the held trial\'s result once it is approved elsewhere', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-recued-recipe-editor-try]').click();

  const form = page.getByRole('dialog');
  await expect(form.getByRole('heading', { name: 'Try “Shop search”' })).toBeVisible();
  await expect(form).toContainText('Settings for this trial only. They do not change the recipe.');
  const query = form.getByRole('textbox', { name: 'Search for' });
  await expect(query).toHaveValue('Grace Hopper');
  await query.fill('Ada Lovelace');
  // The browser the job ran in, offered by the names the owner gave their browsers.
  const browser = form.getByRole('combobox', { name: 'Browser' });
  await expect(browser.locator('option:checked')).toHaveText('Home');
  await expect(browser.locator('option')).toHaveText(['Home', 'Work']);
  await browser.selectOption({ label: 'Work' });
  expect(await fits(page)).toBe(true);
  await form.getByRole('button', { name: 'Try it' }).click();
  await expect(form).toBeHidden();

  await expect(status(page)).toHaveText(HELD);
  expect((await tries(page)).map((one) => [one.recipe.recipe_id, one.config]))
    .toEqual([['shop-search-draft', { query: 'Ada Lovelace', browser: 'b-work' }]]);
  await expect(captureLine(page)).toHaveText('Kept for its saved test as it goes, while it waits for you.');

  await answerElsewhere(page, 'approved', 'complete');
  await expect(status(page)).toHaveText('It worked.');
  await expect(captureLine(page))
    .toHaveText('Kept as this recipe\'s saved test for 10 minutes: save the recipe, then keep it under Captured runs on its page.');
  expect(await fits(page)).toBe(true);

  // The next trial starts from the settings this one ran with.
  await page.locator('[data-recued-recipe-editor-try]').click();
  await expect(form.getByRole('textbox', { name: 'Search for' })).toHaveValue('Ada Lovelace');
  await expect(form.getByRole('combobox', { name: 'Browser' }).locator('option:checked')).toHaveText('Work');
});

test('declined elsewhere, the trial says so and that it is no saved test, on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-recued-recipe-editor-try]').click();
  const form = page.getByRole('dialog');
  await expect(form.getByRole('heading', { name: 'Try “Shop search”' })).toBeVisible();
  expect(await fits(page)).toBe(true);
  await form.getByRole('button', { name: 'Try it' }).click();
  await expect(status(page)).toHaveText(HELD);
  expect((await tries(page)).map((one) => one.config)).toEqual([{}]);

  await answerElsewhere(page, 'denied', 'action_changed');
  await expect(status(page)).toHaveText('It stopped.');
  await expect(page.locator('[data-recued-recipe-trial-error]')).toHaveText('You declined this, so it did not go ahead.');
  await expect(captureLine(page))
    .toHaveText('No saved test from this run: The trial did not finish, so it is no saved test. Try the recipe again once it works.');
  expect(await fits(page)).toBe(true);
});
