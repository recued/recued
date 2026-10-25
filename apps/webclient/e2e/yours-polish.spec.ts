import { expect, test, type Locator } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();

const withinViewport = async (node: Locator) => {
  const bounds = await node.boundingBox(); expect(bounds).not.toBeNull();
  const height = await node.page().evaluate(() => innerHeight);
  expect(bounds!.y).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
};

test('Creating classes keeps independent identities and fields through a nested rule draft', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/assets/classes`);
  const route = page.locator('[data-recued-yours]');
  await route.getByRole('button', { name: 'Create class', exact: true }).click();
  const form = route.locator('[data-yours-editor]');
  await form.getByLabel('Name', { exact: true }).fill('First template');
  const firstId = await form.getByLabel('Class id', { exact: true }).inputValue();
  await form.getByRole('button', { name: 'Add date field', exact: true }).click();
  await form.getByLabel('Date field name', { exact: true }).fill('Warranty expiry');
  await form.getByRole('button', { name: 'Add preset rule', exact: true }).click();
  await form.getByLabel('Title', { exact: true }).fill('Renew warranty');
  await form.getByLabel('Asset date', { exact: true }).selectOption('warranty_expiry');
  await form.getByRole('button', { name: 'Keep rule in draft', exact: true }).click();
  await expect(form.getByLabel('Class id', { exact: true })).toHaveValue(firstId);
  await expect(form.getByLabel('Date field name', { exact: true })).toHaveAttribute('readonly', '');
  await expect(form.getByRole('button', { name: 'Remove date field', exact: true })).toBeDisabled();
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(route.getByRole('heading', { name: 'First template · v1', exact: true })).toBeVisible();
  await route.getByRole('button', { name: 'Create class', exact: true }).click();
  await form.getByLabel('Name', { exact: true }).fill('Second template');
  expect(await form.getByLabel('Class id', { exact: true }).inputValue()).not.toBe(firstId);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(route.getByRole('heading', { name: 'First template · v1', exact: true })).toBeVisible();
  await expect(route.getByRole('heading', { name: 'Second template · v1', exact: true })).toBeVisible();
  const writes = await page.evaluate(() => window.__assetRuleWrites.filter(row => row.action === 'class.save'));
  expect(writes).toHaveLength(2);
  expect(writes[0]).toMatchObject({ action: 'class.save', create: true, preset: { fields: { dates: { warranty_expiry: null } }, rules: [{ when: { field: 'warranty_expiry' } }] } });
  expect(writes[1]).toMatchObject({ action: 'class.save', create: true, preset: { fields: { dates: {} } } });
});

test('A class-key collision stays local and focuses the identity without making a write', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/assets/classes`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Create class', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await form.getByLabel('Name', { exact: true }).fill('My passport');
  await form.getByText('Advanced identity', { exact: true }).click(); const id = form.getByLabel('Class id', { exact: true }); await id.fill('passport');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(id).toHaveAttribute('aria-invalid', 'true'); await expect(id).toBeFocused();
  await expect(form.getByRole('alert')).toContainText('already exists'); await withinViewport(id);
  expect(await page.evaluate(() => window.__assetRuleWrites)).toEqual([]);
});

test('Friendly fact names preserve exact values and duplicate names identify the field', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_provenance#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); const form = route.locator('[data-yours-editor]');
  await route.getByRole('button', { name: 'Add fact', exact: true }).click();
  await form.getByLabel('Fact name', { exact: true }).fill('Hose length'); const exact = '  25 meters\nabout this long  ';
  await form.getByLabel('Value', { exact: true }).fill(exact); await form.getByRole('button', { name: 'Save fact', exact: true }).click();
  const fact = route.locator('[data-yours-fact="attributes.hose_length"]');
  await expect(fact).toBeVisible(); expect(await fact.evaluate(node => node.firstChild?.textContent)).toBe(exact);
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([{ action: 'asset.update', id: 'passport', patch: { attributes: { hose_length: exact } } }]);
  await route.getByRole('button', { name: 'Add fact', exact: true }).click(); const name = form.getByLabel('Fact name', { exact: true });
  await name.fill('Hose-length'); await form.getByLabel('Value', { exact: true }).fill('different'); await form.getByRole('button', { name: 'Save fact', exact: true }).click();
  await expect(name).toBeFocused(); await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(form.getByRole('alert')).toContainText('already exists');
  expect(await page.evaluate(() => window.__assetFactWrites)).toHaveLength(1);
});

test('Repeated class fields identify the duplicate and do not make a write', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/assets/classes`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Create class', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await form.getByLabel('Name', { exact: true }).fill('Warranty');
  for (const name of ['Warranty expiry', 'Warranty-expiry']) { await form.getByRole('button', { name: 'Add date field', exact: true }).click(); await form.getByLabel('Date field name', { exact: true }).last().fill(name); }
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form.getByLabel('Date field name', { exact: true }).last()).toBeFocused();
  await expect(form.getByRole('alert')).toContainText('own key');
  expect(await page.evaluate(() => window.__assetRuleWrites)).toEqual([]);
});

test('Proposal cards expose affected records, triggers and reminder changes without extra reads', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/proposals`);
  const route = page.locator('[data-recued-yours]'); const preview = route.locator('[data-yours-proposal-preview="rule-review"]');
  await expect(preview).toContainText('Ana’s passport'); await expect(preview).toContainText('issued on');
  await expect(preview).toContainText('Proposed reminders: on the day');
  const timing = route.locator('[data-yours-proposal-preview="schedule-review"]');
  await expect(timing).toContainText('Current reminders:'); await expect(timing).toContainText('Proposed reminders: 2 weeks before; on the day');
  const reads = await page.evaluate(() => window.__app.rpcCallCount('yours.read'));
  await route.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(route).toHaveAttribute('aria-busy', 'false');
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.read'))).toBe(reads + 1);
  expect(await page.evaluate(() => window.__assetRuleWrites)).toEqual([]);
});

test('Unsupported filters retain a visible reset without reporting an unverified result count', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=summaries&yours_asset_spheres&yours_without_asset_sphere#yours/assets/sphere/professional`);
  const route = page.locator('[data-recued-yours]'); await expect(route.locator('[data-yours-asset-count]')).toHaveCount(0);
  await expect(route.getByRole('button', { name: 'Clear filters', exact: true })).toBeVisible();
  await route.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(route.locator('[data-yours-asset-count]')).toHaveText('6 assets');
});

test('Refresh and a pending editor give feedback while another selection can still win', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields&yours_asset_filter_pages#yours/proposals`);
  const route = page.locator('[data-recued-yours]'); await expect(route).toHaveAttribute('aria-busy', 'false');
  await page.evaluate(() => window.__app.holdRpcResponses?.('yours.read'));
  await route.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(route.getByRole('button', { name: 'Refreshing…', exact: true })).toBeDisabled();
  await expect(route.getByRole('status')).toHaveText('Refreshing Yours…');
  await page.evaluate(() => window.__app.releaseRpcResponses?.('yours.read')); await expect(route).toHaveAttribute('aria-busy', 'false');
  const card = route.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Review renewal reminders', exact: true }) });
  await card.getByRole('button', { name: 'Review change', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Opening…', exact: true })).toBeDisabled(); await expect(route).toHaveAttribute('aria-busy', 'true');
  const television = route.getByRole('article').filter({ has: page.getByRole('heading', { name: 'LG television', exact: true }) });
  await television.getByRole('button', { name: 'Review change', exact: true }).click();
  const name = route.locator('[data-yours-editor]').getByLabel('Name', { exact: true }); await name.fill('My TV');
  await page.evaluate(() => window.__app.releaseRpcResponses?.('yours.read')); await expect(name).toHaveValue('My TV');
});

test('Episode history leads with its full span, people and inspectable evidence', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&contact_history&occasion_history#yours/episodes`);
  const route = page.locator('[data-recued-yours]'); const episode = route.locator('[data-yours-episode="museum"]');
  await expect(episode).toContainText('2025'); await expect(episode).toContainText(' – '); await expect(episode).toContainText('With Ana');
  await expect(episode.getByRole('link', { name: 'Open source record', exact: true })).toHaveAttribute('href', /personal.*flowers/u);
  expect(await route.evaluate(root => {
    const episode = root.querySelector('[data-yours-episode]')!; const management = [...root.querySelectorAll('section')].find(section => section.querySelector('h3')?.textContent === 'Memory settings')!;
    return !!(episode.compareDocumentPosition(management) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
});

test.describe('Phone usability', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('Useful content and long-form actions fit the first viewport, with large fact targets', async ({ page }, info) => {
    await page.goto(`${HARNESS_URL}?yours=summaries#yours/assets`);
    const route = page.locator('[data-recued-yours]'); const first = route.locator('[data-yours-asset] h3').first(); await expect(first).toBeVisible();
    expect((await first.boundingBox())!.y).toBeLessThan(550); await page.screenshot({ path: info.outputPath('assets-phone.png') });
    await page.goto(`${HARNESS_URL}?yours=demo&yours_provenance&yours_rule_fields#yours/asset/passport`);
    const facts = route.getByRole('heading', { name: 'Facts and settings', exact: true }); await expect(facts).toBeVisible();
    expect((await facts.boundingBox())!.y).toBeLessThan(600);
    expect((await route.getByLabel('More actions for cover', { exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await route.locator('[data-yours-sphere]>summary').first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await route.getByLabel('More actions for cover', { exact: true }).click();
    expect((await route.getByRole('button', { name: 'Edit fact', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await route.getByLabel('More actions for cover', { exact: true }).click();
    await route.getByRole('button', { name: 'Edit asset', exact: true }).click(); const save = route.locator('[data-yours-editor]').getByRole('button', { name: 'Save', exact: true });
    await withinViewport(save); await page.screenshot({ path: info.outputPath('editor-phone.png') });
  });
  test('A narrow navigation rail reveals Episodes after a real selection', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 }); await page.goto(`${HARNESS_URL}?yours=demo#yours/assets`);
    const nav = page.locator('[data-recued-yours]').getByRole('navigation', { name: 'Yours', exact: true });
    await nav.getByRole('link', { name: 'Episodes', exact: true }).click();
    const active = nav.locator('[aria-current]'); await expect(active).toHaveText('Episodes');
    await expect.poll(async () => { const rail = (await nav.boundingBox())!, tab = (await active.boundingBox())!; return tab.x >= rail.x - 1 && tab.x + tab.width <= rail.x + rail.width + 1; }).toBe(true);
    const refresh = page.locator('[data-recued-yours]').getByRole('button', { name: 'Refresh', exact: true });
    expect((await refresh.boundingBox())!.height).toBeLessThan(60);
  });
  test('A rejected reading copy keeps the draft and presents its conflict beside the actions', async ({ page }) => {
    await page.goto(`${HARNESS_URL}?yours=demo&yours_provenance&yours_copy_conflict=1#yours/asset/passport`);
    const route = page.locator('[data-recued-yours]'); await route.getByLabel('More actions for cover', { exact: true }).click(); await route.getByRole('button', { name: 'Record as a reading', exact: true }).click();
    const form = route.locator('[data-yours-editor]'); await form.getByLabel('Value', { exact: true }).fill('25'); await form.getByLabel('Unit', { exact: true }).fill('m'); await form.getByRole('button', { name: 'Observed now', exact: true }).click();
    await form.getByRole('button', { name: 'Record reading', exact: true }).click(); const error = form.getByRole('alert'); await expect(error).toContainText('changed'); await withinViewport(error);
    await expect(form.getByLabel('Value', { exact: true })).toHaveValue('25');
  });
});
