import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL } from './helpers/full-app.js';

/** D-333 — Kitchen's work in progress in a real browser: Kitchen lists it, an item opens
 *  straight into its editor and is kept as it is typed, and it leaves Kitchen once it is
 *  saved as the real thing or discarded. The server side is `fixtures/kitchen-import.ts`. */
const url = (mode: string, hash = '#kitchen/import/import-fixture') =>
  `${HARNESS_URL}?kitchen_import=${mode}&settle_reads=1${hash}`;
const calls = (page: Page, method: string): Promise<number> =>
  page.evaluate((name) => window.__app.rpcCallCount(name), method);
const hash = (page: Page): string => new URL(page.url()).hash;

const work = (page: Page) => page.locator('[data-recued-kitchen-work]');
const workHeader = (page: Page) => work(page).locator('header');
const recipeEditor = (page: Page) => page.locator('[data-recued-recipe-editor-route]');
const recipeName = (page: Page) => page.getByRole('textbox', { name: 'Recipe name', exact: true });
const home = (page: Page) => page.locator('[data-recued-kitchen-home]');

const pageErrors = new Map<Page, Error[]>();
test.beforeEach(({ page }) => {
  const seen: Error[] = [];
  pageErrors.set(page, seen);
  page.on('pageerror', (error) => seen.push(error));
});
test.afterEach(({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

test('Kitchen lists work an AI app handed over and opens it straight in the recipe editor', async ({ page }) => {
  await page.goto(url('recipe', '#kitchen'));
  await expect(home(page).getByRole('heading', { name: 'In progress', exact: true })).toBeVisible();
  await expect(page.locator('[data-recued-kitchen-route-label]')).toHaveAttribute('aria-current', 'page');
  const row = home(page).locator('[data-recued-kitchen-home-item="work:import-fixture"]');
  await expect(row).toContainText('Send a composed email');
  await expect(row).toContainText('From VS Code · edited 2 min ago');
  await expect(row).toContainText('Ready to save');

  await row.getByRole('link', { name: 'Continue', exact: true }).click();
  await expect(recipeEditor(page)).toBeVisible();
  expect(hash(page)).toBe('#kitchen/import/import-fixture');
  await expect(recipeName(page)).toHaveValue('Send a composed email');
  await expect(workHeader(page).getByRole('heading', { level: 1 })).toHaveText('Send a composed email');
  await expect(workHeader(page).getByRole('status')).toHaveText('Kept as you type');
  // Its tab is the current one and links to the item, not to a fresh start.
  const recipeTab = page.locator('[data-recued-kitchen-route-tab="recipe"]');
  await expect(recipeTab).toHaveAttribute('aria-current', 'page');
  await expect(recipeTab).toHaveAttribute('href', '#kitchen/import/import-fixture');
  await expect(page.locator('[data-recued-kitchen-route-label]')).not.toHaveAttribute('aria-current', 'page');
  expect(await calls(page, 'kitchen.draft.update')).toBe(0);
});

test('an item is kept as it is typed, and leaves Kitchen once it is saved as a recipe', async ({ page }) => {
  await page.goto(url('recipe'));
  await expect(recipeName(page)).toHaveValue('Send a composed email');
  await recipeName(page).fill('Send a composed email today');
  await expect.poll(() => calls(page, 'kitchen.draft.update')).toBe(1);
  await expect(workHeader(page).getByRole('status')).toHaveText('Kept as you type');
  await expect(workHeader(page).getByRole('heading', { level: 1 })).toHaveText('Send a composed email today');

  await page.locator('[data-recued-recipe-editor-save]').click();
  await expect.poll(() => hash(page)).toBe('#kitchen/recipe/send-composed-mail');
  await expect.poll(() => calls(page, 'kitchen.draft.discard')).toBe(1);
  expect(await calls(page, 'recipe.save')).toBe(1);
  expect(await calls(page, 'ingredient.install')).toBe(0);
});

test('an item nobody changed is never rewritten (Windows line endings stay as handed over)', async ({ page }) => {
  await page.clock.install();
  await page.goto(url('crlf'));
  await expect(recipeName(page)).toHaveValue('Send a composed email');
  await page.clock.runFor(5_000);
  expect(await calls(page, 'kitchen.draft.update')).toBe(0);
  // The same clock does write an edit, so the zero above is not a stopped clock.
  await recipeName(page).fill('Send a composed email today');
  await page.clock.runFor(5_000);
  await expect.poll(() => calls(page, 'kitchen.draft.update')).toBe(1);
});

test('a new recipe becomes an item at its first change and keeps that address', async ({ page }) => {
  await page.goto(url('new', '#kitchen'));
  await expect(home(page).getByRole('status')).toHaveText('Nothing in progress.');
  await home(page).getByRole('link', { name: 'New recipe', exact: true }).click();
  await expect(recipeEditor(page)).toBeVisible();
  expect(hash(page)).toBe('#kitchen/new/recipe');
  await expect(workHeader(page).getByRole('heading', { level: 1 })).toHaveText('New recipe');
  await expect(workHeader(page).getByRole('button', { name: 'Discard', exact: true })).toBeDisabled();

  await recipeName(page).fill('Morning briefing');
  await expect.poll(() => hash(page)).toBe('#kitchen/import/work-new');
  expect(await calls(page, 'kitchen.draft.create')).toBe(1);
  // The same editor carries on: the address changed, the page did not reload.
  await expect(recipeName(page)).toHaveValue('Morning briefing');
  await expect(recipeName(page)).toBeFocused();
  await expect(workHeader(page).getByRole('heading', { level: 1 })).toHaveText('Morning briefing');
  await expect(workHeader(page).getByRole('button', { name: 'Discard', exact: true })).toBeEnabled();
  await expect(page.locator('[data-recued-kitchen-route-tab="recipe"]')).toHaveAttribute('href', '#kitchen/import/work-new');
});

test('a pack opens in the pack builder, which keeps its own work', async ({ page }) => {
  await page.goto(url('pack'));
  await expect(page.locator('[data-recued-ingredient-builder-route]')).toBeVisible();
  await expect(workHeader(page)).toContainText('Pack in progress');
  await expect(workHeader(page).getByRole('status')).toHaveText('Save to keep your changes');
  await expect(page.locator('[data-recued-kitchen-route-tab="pack"]')).toHaveAttribute('aria-current', 'page');
  expect(await calls(page, 'ingredient.install')).toBe(0);
});

test('source that is not JSON yet stays editable, is kept as typed, and opens once it parses', async ({ page }) => {
  await page.goto(url('invalid'));
  const source = work(page).getByRole('textbox', { name: 'Source', exact: true });
  await expect(source).toHaveValue('{"recipe_id":');
  const open = work(page).getByRole('button', { name: 'Open in editor', exact: true });
  await expect(open).toBeDisabled();
  await source.fill(JSON.stringify({
    recipe_id: 'fixed-recipe', version: 1, ttl: 300,
    metadata: { name: 'Fixed recipe', description: '', author: '', supported_platforms: [] },
    variables: {}, prefetch_steps: [], steps: [], output: { render: [] },
  }));
  await expect(open).toBeEnabled();
  await expect.poll(() => calls(page, 'kitchen.draft.update')).toBe(1);
  await open.click();
  await expect(recipeName(page)).toHaveValue('Fixed recipe');
});

test('when it changed elsewhere, keeping stops and leaving asks first', async ({ page }) => {
  await page.goto(url('conflict'));
  await recipeName(page).fill('Edited here as well');
  await expect(workHeader(page).getByRole('status')).toContainText('changed somewhere else');
  const asked = page.waitForEvent('dialog');
  await page.evaluate(() => { window.location.hash = '#recipes'; });
  const dialog = await asked;
  expect(dialog.type()).toBe('confirm');
  await dialog.dismiss();
  await expect(recipeName(page)).toHaveValue('Edited here as well');
  await expect.poll(() => hash(page)).toBe('#kitchen/import/import-fixture');
});

test('Discard on the item removes it and goes back to Kitchen', async ({ page }) => {
  await page.goto(url('recipe'));
  await expect(recipeEditor(page)).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await workHeader(page).getByRole('button', { name: 'Discard', exact: true }).click();
  await expect.poll(() => hash(page)).toBe('#kitchen');
  await expect(home(page).getByRole('status')).toHaveText('Nothing in progress.');
  expect(await calls(page, 'kitchen.draft.discard')).toBe(1);
});

test('Discard in the Kitchen list removes the item after asking', async ({ page }) => {
  await page.goto(url('recipe', '#kitchen'));
  const row = home(page).locator('[data-recued-kitchen-home-item="work:import-fixture"]');
  await expect(row).toBeVisible();
  // `confirm` blocks the click until it is answered, so answer it from the handler.
  let asked = '';
  page.once('dialog', (dialog) => { asked = dialog.message(); void dialog.accept(); });
  await row.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(asked).toBe('Discard "Send a composed email"? It is removed from Kitchen and cannot be brought back.');
  await expect(home(page).getByRole('status')).toHaveText('Nothing in progress.');
});

test('changes to a saved recipe are kept in Kitchen, listed there, and gone once discarded', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?recipes=installed&kitchen_import=saved-recipe&settle_reads=1#kitchen/recipe/autorun-live-1`);
  const changes = page.locator('[data-recued-recipe-changes=""]');
  await expect(recipeName(page)).toBeVisible();
  const saved = await recipeName(page).inputValue();
  await expect(changes).toBeHidden();
  await recipeName(page).fill(`${saved}, changed`);
  await expect.poll(() => calls(page, 'kitchen.draft.create')).toBe(1);
  await expect(changes).toBeVisible();
  await expect(changes.getByRole('status')).toHaveText('Kept as you type');

  // Kept, so leaving asks nothing; Kitchen lists the changes and continues them on the recipe.
  await page.locator('[data-recued-kitchen-route-label]').click();
  const row = home(page).locator('[data-recued-kitchen-home-item="work:work-new"]');
  await expect(row).toContainText('Changes to your recipe');
  await row.getByRole('link', { name: 'Continue', exact: true }).click();
  await expect.poll(() => hash(page)).toBe('#kitchen/recipe/autorun-live-1');
  await expect(recipeName(page)).toHaveValue(`${saved}, changed`);
  await expect(changes).toBeVisible();

  page.once('dialog', (dialog) => void dialog.accept());
  await changes.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(recipeName(page)).toHaveValue(saved);
  await expect(changes).toBeHidden();
  expect(await calls(page, 'kitchen.draft.discard')).toBe(1);
});

test('a pack made in Kitchen opens there again from its page in Packs, as changes to it', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?kitchen_import=kitchen-pack&settle_reads=1#packs/acme-crm`);
  const edit = page.locator('[data-recued-packs-detail-kitchen-edit="acme-crm"]');
  await expect(edit).toHaveText('Edit in Kitchen');
  await edit.click();
  await expect.poll(() => hash(page)).toBe('#kitchen/pack/pack-changes');
  expect(await calls(page, 'ingredient.draft.edit')).toBe(1);

  // Installing replaces the pack, so the builder keeps its slug and publisher.
  await page.locator('[data-recued-ingredient-builder-section-nav="publish"]').click();
  const packSlug = page.locator('[data-recued-ingredient-builder-pack-slug]');
  const publisher = page.locator('[data-recued-ingredient-builder-publisher]');
  await expect(packSlug).toHaveValue('acme-crm');
  await expect(packSlug).not.toBeEditable();
  await expect(publisher).toHaveValue('dana');
  await expect(publisher).not.toBeEditable();
  await expect(page.locator('[data-recued-ingredient-builder-base-pack="acme-crm"]'))
    .toHaveText('These are changes to Acme CRM, which is installed. Installing them replaces it, so its slug and publisher stay.');

  // Kitchen lists them as changes to the pack.
  await page.locator('[data-recued-kitchen-route-label]').click();
  await expect(home(page).locator('[data-recued-kitchen-home-item="pack:pack-changes"]')).toContainText('Changes to your pack');
});

test('another author\'s pack opens in Kitchen as a copy of your own, beside the original', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?kitchen_import=kitchen-pack&settle_reads=1#packs/acme-market`);
  await expect(page.locator('[data-recued-packs-detail-recipe-reference="acme-inc.acme-market"]'))
    .toHaveText('Recipes use it as acme-inc.acme-market');
  const copy = page.locator('[data-recued-packs-detail-kitchen-copy="acme-market"]');
  await expect(copy).toHaveText('Edit a copy in Kitchen');
  await expect(page.getByText("Your copy takes this pack's operations and data fields. Its recipes stay with this pack.")).toBeVisible();
  await expect(page.locator('[data-recued-packs-detail-kitchen-edit]')).toHaveCount(0);
  await copy.click();
  await expect.poll(() => hash(page)).toBe('#kitchen/pack/copy-1');
  expect(await calls(page, 'ingredient.draft.save')).toBe(1);

  // Its own names, so it installs beside the original; nothing here is fixed. Recipes reach
  // it as `local-authoring.acme-market-copy`, written into their own source.
  await expect(page.locator('[data-recued-ingredient-builder-title]')).toHaveValue('Copy of Acme Market');
  await expect(page.locator('[data-recued-ingredient-builder-slug]')).toHaveValue('acme-market-catalog-copy');
  await page.locator('[data-recued-ingredient-builder-section-nav="publish"]').click();
  const packSlug = page.locator('[data-recued-ingredient-builder-pack-slug]');
  await expect(packSlug).toHaveValue('acme-market-copy');
  await expect(packSlug).toBeEditable();
  await expect(page.locator('[data-recued-ingredient-builder-publisher]')).toHaveValue('local-authoring');
  await expect(page.locator('[data-recued-ingredient-builder-base-pack]')).toHaveCount(0);
});

test('a recipe switches to your copy of its pack with one button, as a recipe of your own', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?kitchen_import=kitchen-pack&settle_reads=1#kitchen/recipe/acme-daily-deals`);
  const toCopy = page.locator('[data-recued-recipe-editor-pack-switch="acme-inc.acme-market"]');
  await expect(toCopy).toHaveText('Use my copy');
  await toCopy.click();
  const field = (key: string) => page.locator(`[data-recued-recipe-editor-field="${key}"]`);
  await expect(field('depends_on')).toHaveValue('local-authoring.acme-market-copy');
  await expect(field('op')).toHaveValue('local-authoring.acme-market-copy.deal.read');
  // The marketplace recipe stays as it is: this is your own copy of it.
  await expect(page.locator('[data-recued-recipe-editor-recipe-id]')).toHaveValue('acme-daily-deals-copy');
  await expect(recipeName(page)).toHaveValue('Copy of Daily deals');
  await expect(page.locator('[data-recued-recipe-editor-pack-switch="local-authoring.acme-market-copy"]'))
    .toHaveText('Use the original');
});

