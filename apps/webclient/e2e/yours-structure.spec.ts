import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

declare global { interface Window {
  __assetRelationshipWrites: import('@recued/contracts').YoursCommand[];
  __assetSetAttributes(id: string, attributes: import('@recued/contracts').Asset['attributes']): void;
} }

installFullAppHooks();

test('Refresh restores its keyboard focus without taking focus from a control chosen while the read is pending', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]');
  await expect(route.getByRole('heading', { name: 'Ana’s passport', exact: true })).toBeVisible();
  const refresh = route.getByRole('button', { name: 'Refresh', exact: true }); const edit = route.getByRole('button', { name: 'Edit asset', exact: true });
  for (const moveFocus of [false, true]) {
    await page.evaluate(() => window.__app.holdRpcResponses?.('yours.read'));
    await refresh.focus(); await page.keyboard.press('Enter'); await expect(route).toHaveAttribute('aria-busy', 'true');
    if (moveFocus) await edit.focus();
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('yours.read'))).toBe(1);
    await expect(route).toHaveAttribute('aria-busy', 'false'); await expect(moveFocus ? edit : refresh).toBeFocused();
  }
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/asset/passport/view/overview/reading/odometer`);
  const reading = route.locator('[data-yours-reading="odometer"]'); await expect(reading).toBeFocused();
  const release = await holdMenuRefresh(page); await release(); await expect(reading).toBeFocused();
});

const holdMenuRefresh = async (page: Page) => {
  const before = await page.evaluate(() => window.__app.rpcCallCount('yours.read'));
  await page.evaluate(() => {
    window.__app.holdRpcResponses?.('yours.read');
    window.__app.fireMessage({ type: 'server_event', event: { kind: 'warehouse', collection: 'mail', op: 'insert', id: 'menu-refresh', cursor: Date.now() } });
  });
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('yours.read'))).toBe(before + 1);
  await expect(page.locator('[data-recued-yours]')).toHaveAttribute('aria-busy', 'true');
  return async () => {
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('yours.read'))).toBe(1);
    await expect(page.locator('[data-recued-yours]')).toHaveAttribute('aria-busy', 'false');
  };
};

const proposalRaces = async (page: Page, extra = '') => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields&yours_asset_filter_pages&yours_focus_corrections${extra}#yours/proposals`);
  await expect(page.locator('[data-recued-yours]').getByRole('heading', { name: 'LG television', exact: true })).toBeVisible();
};
const proposalCard = (page: Page, title: string) => page.locator('[data-recued-yours]').getByRole('article')
  .filter({ has: page.getByRole('heading', { name: title, exact: true }) }).last();
const holdProposalEditor = async (page: Page, title = 'Review renewal reminders', action: 'Review change' | 'That’s wrong' = 'Review change') => {
  const before = await page.evaluate(() => window.__app.rpcCallCount('yours.read'));
  await page.evaluate(() => window.__app.holdRpcResponses?.('yours.read'));
  const card = proposalCard(page, title);
  if (action === 'That’s wrong') await card.getByLabel(`More actions for ${title}`, { exact: true }).click();
  await card.getByRole('button', { name: action, exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('yours.read'))).toBe(before + 1);
};
const releaseProposalRead = async (page: Page, index = 0) => {
  expect(await page.evaluate(at => window.__app.releaseRpcResponses?.('yours.read', at), index)).toBe(1);
  // Let the released RPC and its editor continuation settle before asserting
  // that a stale response has left the current page alone.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
};

test('A stale proposal load cannot replace a newer typed editor', async ({ page }) => {
  await proposalRaces(page); await holdProposalEditor(page);
  await proposalCard(page, 'LG television').getByRole('button', { name: 'Review change', exact: true }).click();
  const form = page.locator('[data-yours-editor]'); const name = form.getByLabel('Name', { exact: true });
  await name.fill('My television draft'); await name.focus();
  await releaseProposalRead(page);
  await expect(name).toHaveValue('My television draft'); await expect(name).toBeFocused();
  await expect(page.locator('[data-recued-yours]').getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(0);
});

test('A stale correction load cannot reopen an editor after a newer Cancel', async ({ page }) => {
  await proposalRaces(page); await holdProposalEditor(page, 'Review passport', 'That’s wrong');
  const action = proposalCard(page, 'LG television').getByRole('button', { name: 'Review change', exact: true }); await action.click();
  const form = page.locator('[data-yours-editor]'); await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(form).toHaveCount(0); await expect(action).toBeFocused();
  await releaseProposalRead(page);
  await expect(form).toHaveCount(0); await expect(action).toBeFocused();
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(0);
});

for (const order of ['older first', 'newer first'] as const) test(`The latest proposal editor request wins when reads finish ${order}`, async ({ page }) => {
  await proposalRaces(page); await holdProposalEditor(page, 'Review issue-date check'); await holdProposalEditor(page);
  const form = page.locator('[data-yours-editor]');
  if (order === 'older first') {
    await releaseProposalRead(page); await expect(form).toHaveCount(0); await releaseProposalRead(page);
  } else {
    await releaseProposalRead(page, 1);
    await expect(form.getByLabel('Title', { exact: true })).toHaveValue('Renew');
    const cancel = form.getByRole('button', { name: 'Cancel', exact: true }); await cancel.focus();
    await releaseProposalRead(page); await expect(cancel).toBeFocused();
  }
  await expect(form.getByLabel('Title', { exact: true })).toHaveValue('Renew');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(proposalCard(page, 'Review renewal reminders').getByRole('button', { name: 'Review change', exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(0);
});

test('An obsolete proposal load error cannot disturb a newer draft', async ({ page }) => {
  await proposalRaces(page, '&yours_missing_rule'); await holdProposalEditor(page);
  await proposalCard(page, 'LG television').getByRole('button', { name: 'Review change', exact: true }).click();
  const name = page.locator('[data-yours-editor]').getByLabel('Name', { exact: true }); await name.fill('Uninterrupted draft'); await name.focus();
  await releaseProposalRead(page);
  await expect(name).toHaveValue('Uninterrupted draft'); await expect(name).toBeFocused();
  await expect(page.locator('[data-recued-yours]').getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(0);
});

test('The current proposal load still reports its error', async ({ page }) => {
  await proposalRaces(page, '&yours_missing_rule'); await holdProposalEditor(page); await releaseProposalRead(page);
  await expect(page.locator('[data-recued-yours]').getByRole('alert')).toContainText('Rule not found. Refresh this proposal.');
  await expect(page.locator('[data-yours-editor]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(0);
});

test('A newer proposal dismissal invalidates an older editor load', async ({ page }) => {
  await proposalRaces(page); await holdProposalEditor(page);
  const before = await page.evaluate(() => window.__app.rpcCallCount('yours.read'));
  await proposalCard(page, 'Review renewal reminders').getByRole('button', { name: 'Not now', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('yours.read'))).toBe(before + 1);
  await releaseProposalRead(page, 1);
  await expect(proposalCard(page, 'Review renewal reminders')).toHaveCount(0);
  await releaseProposalRead(page); await expect(page.locator('[data-yours-editor]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(1);
});

test('Rule editor returns focus to the initiating row after Cancel Save and refresh', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields#yours/asset/passport/view/rules`);
  const route = page.locator('[data-recued-yours]');
  const row = (title: string) => route.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  const action = row('Service by distance').getByRole('button', { name: 'Edit rule', exact: true });
  await action.focus(); await page.keyboard.press('Enter');
  const form = route.locator('[data-yours-editor]'); await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(action).toBeFocused();
  await action.click(); await form.getByLabel('Title', { exact: true }).fill('Mileage service');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = row('Mileage service').getByRole('button', { name: 'Edit rule', exact: true });
  await expect(saved).toBeFocused();
  await (await holdMenuRefresh(page))(); await expect(saved).toBeFocused();
  expect(await page.evaluate(() => window.__assetRuleWrites)).toMatchObject([{ action: 'rule.save', rule: { id: 'meter_service', title: 'Mileage service' } }]);
});

test('Class editor keeps its entity origin through nested preset rule steps', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/assets/classes`);
  const route = page.locator('[data-recued-yours]'); const form = route.locator('[data-yours-editor]');
  for (const [source, name, id] of [['Passport', 'Travel document', 'travel_document'], ['Warranty-bearing purchase', 'Equipment', 'equipment']] as const) {
    const card = route.getByRole('article').filter({ has: page.getByRole('heading', { name: `${source} · v1`, exact: true }) });
    await card.getByRole('button', { name: 'Make my own copy', exact: true }).click();
    await form.getByLabel('Name', { exact: true }).fill(name); await form.getByText('Advanced identity', { exact: true }).click(); await form.getByLabel('Class id', { exact: true }).fill(id);
    await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form).toHaveCount(0);
  }
  const card = route.getByRole('article').filter({ has: page.getByRole('heading', { name: /^Equipment · v\d+$/u }) });
  const action = card.getByRole('button', { name: 'Edit class', exact: true });
  await action.click(); await form.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(action).toBeFocused();
  await action.click();
  await form.getByLabel('Search keywords', { exact: true }).fill('Travel, trip, travel');
  const addRule = form.getByRole('button', { name: 'Add preset rule', exact: true });
  for (const title of ['Review equipment warranty', 'Inspect equipment']) {
    await addRule.click(); await form.getByLabel('Title', { exact: true }).fill(title);
    await form.getByLabel('Asset date', { exact: true }).selectOption('warranty_ends_on');
    await form.getByRole('button', { name: 'Keep rule in draft', exact: true }).click(); await expect(addRule).toBeFocused();
    await expect(form.getByLabel('Search keywords', { exact: true })).toHaveValue('travel, trip');
  }
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(action).toBeFocused(); await expect(card).toContainText('Review equipment warranty');
  await action.click();
  await expect(form.getByLabel('Search keywords', { exact: true })).toHaveValue('travel, trip');
  const presetRule = (title: string) => form.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
    .getByRole('button', { name: 'Edit preset rule', exact: true });
  await presetRule('Inspect equipment').click(); await form.getByLabel('Title', { exact: true }).fill('Inspect annually');
  await form.getByRole('button', { name: 'Keep rule in draft', exact: true }).click(); await expect(presetRule('Inspect annually')).toBeFocused();
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(action).toBeFocused();
  await action.click(); await presetRule('Inspect annually').click();
  await form.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(presetRule('Inspect annually')).toBeFocused();
  await form.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(action).toBeFocused();
});

test('Occasion and habit editors return to their own repeated actions', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&contact_history&occasion_history#yours/occasions`);
  const route = page.locator('[data-recued-yours]'); const form = route.locator('[data-yours-editor]');
  await route.getByRole('button', { name: 'Create occasion', exact: true }).click();
  await form.getByLabel('Name', { exact: true }).fill('Annual picnic');
  await form.getByLabel('Annual date (MM-DD)', { exact: true }).fill('07-04');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  const card = route.getByRole('article').filter({ has: page.getByRole('button', { name: 'Edit occasion', exact: true }) })
    .filter({ has: page.getByRole('heading', { name: 'Annual picnic', exact: true }) });
  const action = card.getByRole('button', { name: 'Edit occasion', exact: true });
  await action.click(); await form.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(action).toBeFocused();
  const habit = card.getByRole('button', { name: 'Edit occasion rule', exact: true });
  await habit.click(); await form.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(habit).toBeFocused();
  await habit.click(); await form.getByLabel('Title', { exact: true }).fill('Picnic planning');
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(habit).toBeFocused();
});

test('A delayed proposal editor retains the activation origin when focus moves during its read', async ({ page }) => {
  // The paged assets keep this proposal's passport outside the list snapshot.
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields&yours_asset_filter_pages#yours/proposals`);
  const route = page.locator('[data-recued-yours]');
  const card = route.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Review renewal reminders', exact: true }) });
  const action = card.getByRole('button', { name: 'Review change', exact: true });
  const before = await page.evaluate(() => window.__app.rpcCallCount('yours.read'));
  await page.evaluate(() => window.__app.holdRpcResponses?.('yours.read'));
  await action.click();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('yours.read'))).toBe(before + 1);
  await route.getByLabel('Proposal kind', { exact: true }).focus();
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('yours.read'))).toBe(1);
  const form = route.locator('[data-yours-editor]'); await expect(form).toBeVisible();
  await form.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(action).toBeFocused();
  expect(await page.evaluate(() => window.__assetRuleWrites)).toEqual([]);
});

test('A saved correction cannot transfer focus to a namesake proposal after removing its origin', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_focus_corrections#yours/proposals`);
  const route = page.locator('[data-recued-yours]');
  const cards = route.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Review passport', exact: true }) });
  await expect(cards).toHaveCount(2);
  const target = cards.nth(1); await target.getByLabel('More actions for Review passport', { exact: true }).click();
  await target.getByRole('button', { name: 'That’s wrong', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await form.getByLabel('Name', { exact: true }).fill('Corrected passport');
  const before = await page.evaluate(() => window.__app.rpcCallCount('yours.change'));
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toHaveCount(0); await expect(cards).toHaveCount(1);
  await expect(route.locator('[data-yours-heading]')).toBeFocused();
  await expect(cards.locator('[data-yours-menu]')).toHaveJSProperty('open', false);
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.change'))).toBe(before + 1);
});

test('A pending fact action survives a background refresh and uses the current value', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_provenance=1#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]');
  const row = route.locator('[data-yours-fact="attributes.cover"]').locator('..');
  const summary = row.getByLabel('More actions for cover', { exact: true });
  await summary.click();
  await page.evaluate(() => window.__assetSetAttributes('passport', { cover: 'Green' }));
  const release = await holdMenuRefresh(page);
  const action = row.getByRole('button', { name: 'Record as a reading', exact: true });
  // Only the old node is disabled. A real pending click must retry on the
  // enabled replacement while its menu stays open, as during a slow repaint.
  await action.evaluate((node: HTMLButtonElement) => { node.disabled = true; });
  const clicking = action.click({ timeout: 10_000 });
  await release(); await clicking;
  const form = route.locator('[data-yours-editor]');
  await expect(form.locator('blockquote')).toHaveText('Green');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(action).toBeFocused(); await expect(row.locator('details')).toHaveJSProperty('open', true);
  // A subsequent refresh respects the owner's outside-pointer dismissal.
  await route.getByRole('heading', { name: 'Ana’s passport', exact: true }).click();
  await expect(row.locator('details')).toHaveJSProperty('open', false);
  await (await holdMenuRefresh(page))();
  await expect(row.locator('details')).toHaveJSProperty('open', false);
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
  expect(await page.evaluate(() => window.__assetRelationshipWrites)).toEqual([]);
});

test('Menu refresh preserves keyboard focus by full field identity and respects Escape', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_provenance=1#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]');
  await page.evaluate(() => window.__assetSetAttributes('passport', { radius_km: 'about five', cover: 'Blue' }));
  await (await holdMenuRefresh(page))();
  const attribute = route.locator('[data-yours-fact="attributes.radius_km"]').locator('..');
  const setting = route.locator('[data-yours-fact="settings.radius_km"]').locator('..');
  const summary = attribute.getByLabel('More actions for radius km', { exact: true });
  await summary.click();
  const action = attribute.getByRole('button', { name: 'Edit fact', exact: true }); await action.focus();
  await page.evaluate(() => window.__assetSetAttributes('passport', { cover: 'Green', radius_km: 'still about five' }));
  await (await holdMenuRefresh(page))();
  await expect(attribute.locator('details')).toHaveJSProperty('open', true);
  await expect(setting.locator('details')).toHaveJSProperty('open', false);
  await expect(action).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(summary).toBeFocused(); await expect(attribute.locator('details')).toHaveJSProperty('open', false);
  await (await holdMenuRefresh(page))();
  await expect(summary).toBeFocused(); await expect(attribute.locator('details')).toHaveJSProperty('open', false);
  await expect(setting.locator('details')).toHaveJSProperty('open', false);
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
});

test('A removed field cannot transfer its open menu or focus to a namesake', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_provenance=1#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]');
  await page.evaluate(() => window.__assetSetAttributes('passport', { radius_km: 'about five' }));
  await (await holdMenuRefresh(page))();
  const attribute = route.locator('[data-yours-fact="attributes.radius_km"]').locator('..');
  await attribute.getByLabel('More actions for radius km', { exact: true }).click();
  await attribute.getByRole('button', { name: 'Edit fact', exact: true }).focus();
  await page.evaluate(() => window.__assetSetAttributes('passport', {}));
  await (await holdMenuRefresh(page))();
  await expect(attribute).toHaveCount(0);
  await expect(route.locator('[data-yours-fact="settings.radius_km"]').locator('..').locator('details')).toHaveJSProperty('open', false);
  await expect(route.locator('[data-yours-heading]')).toBeFocused();
  await expect(route.locator('[data-yours-editor]')).toHaveCount(0);
  await page.evaluate(() => window.__assetSetAttributes('passport', { radius_km: 'back again' }));
  await (await holdMenuRefresh(page))();
  await expect(attribute.locator('details')).toHaveJSProperty('open', false);
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
});

test('A removed menu action returns focus to its own summary', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_provenance=1#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]');
  const row = route.locator('[data-yours-fact="attributes.cover"]').locator('..');
  const summary = row.getByLabel('More actions for cover', { exact: true }); await summary.click();
  const action = row.getByRole('button', { name: 'Record as a reading', exact: true }); await action.focus();
  await page.evaluate(() => window.__assetSetAttributes('passport', { cover: 25 }));
  await (await holdMenuRefresh(page))();
  await expect(action).toHaveCount(0); await expect(summary).toBeFocused();
  await expect(row.locator('details')).toHaveJSProperty('open', true);
  expect(await page.evaluate(() => window.__assetFactWrites)).toEqual([]);
});

test('Recording text as a reading confirms value unit and time and keeps the note independent', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?yours=demo#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]');
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.context'))).toBe(0);
  await route.getByRole('button', { name: 'Add fact', exact: true }).click();
  await route.getByLabel('Fact name', { exact: true }).fill('length'); await route.getByLabel('Value', { exact: true }).fill('about 25 meters');
  await route.getByRole('button', { name: 'Save fact', exact: true }).click();
  await route.getByLabel('More actions for length', { exact: true }).click(); await route.getByRole('button', { name: 'Record as a reading', exact: true }).click();
  const form = route.locator('[data-yours-editor]');
  await expect(form.locator('blockquote')).toHaveText('about 25 meters');
  await expect(form.getByLabel('Value', { exact: true })).toHaveValue(''); await expect(form.getByLabel('Unit', { exact: true })).toHaveValue('');
  await expect(form.getByLabel('Observed at', { exact: true })).toHaveValue('');
  await expect(form.getByLabel('Field name', { exact: true })).toHaveValue('length');
  await form.getByLabel('Value', { exact: true }).fill('25'); await form.getByLabel('Unit', { exact: true }).fill('m');
  await form.getByRole('button', { name: 'Observed now', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('confirm-reading-phone.png'), fullPage: true });
  await form.getByRole('button', { name: 'Record reading', exact: true }).click(); await expect(form).toHaveCount(0);
  await expect(route.locator('[data-yours-fact="attributes.length"]')).toContainText('about 25 meters');
  await expect(route.locator('[data-yours-reading="length"]')).toContainText('25 m');
  const writes = await page.evaluate(() => window.__assetFactWrites); expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({ action: 'asset.record_attribute_reading', attribute: 'length', field: 'length', reading: { value: 25, unit: 'm' }, expected_target: { exists: false, value: null, source: null } });
  const actions = route.getByRole('group', { name: 'Actions for length', exact: true });
  if (!await actions.isVisible()) await route.getByLabel('More actions for length', { exact: true }).click();
  await actions.getByRole('button', { name: 'Edit fact', exact: true }).click();
  await route.getByLabel('Value', { exact: true }).fill('26 meters'); await route.getByRole('button', { name: 'Save fact', exact: true }).click();
  await expect(route.locator('[data-yours-reading="length"]')).toContainText('25 m');
  expect(await page.evaluate(() => window.__app.rpcCallCount('yours.context'))).toBe(0);
});

test('A rejected reading copy preserves the reviewed note and complete observation draft', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_provenance=1&yours_copy_conflict=1#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); await route.getByLabel('More actions for cover', { exact: true }).click();
  await route.getByRole('button', { name: 'Record as a reading', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await form.getByLabel('Value', { exact: true }).fill('25'); await form.getByLabel('Unit', { exact: true }).fill('m');
  await form.getByRole('button', { name: 'Observed now', exact: true }).click(); const time = await form.getByLabel('Observed at', { exact: true }).inputValue();
  await form.getByRole('button', { name: 'Record reading', exact: true }).click();
  await expect(route.getByRole('alert')).toContainText('changed'); await expect(form.locator('blockquote')).toHaveText('Blue');
  await expect(form.getByLabel('Value', { exact: true })).toHaveValue('25'); await expect(form.getByLabel('Unit', { exact: true })).toHaveValue('m');
  await expect(form.getByLabel('Observed at', { exact: true })).toHaveValue(time);
});

test('A rule context request uses the narrow reader and a late response cannot reopen a closed inspector', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo#yours/asset/passport/view/rules`);
  const route = page.locator('[data-recued-yours]');
  const reads = await page.evaluate(() => window.__app.rpcCallCount('yours.read'));
  await route.getByRole('button', { name: 'Explain this rule', exact: true }).click();
  const context = route.locator('[data-yours-context]'); await expect(context.getByRole('link', { name: 'Open rule on asset', exact: true })).toBeVisible();
  await expect(context).toContainText('2027-04-17'); expect(await page.evaluate(() => window.__app.rpcCallCount('yours.read'))).toBe(reads);
  await context.getByRole('button', { name: 'Close context', exact: true }).click();
  await expect(route.getByRole('button', { name: 'Explain this rule', exact: true })).toBeFocused();
  await page.evaluate(() => window.__app.holdRpcResponses?.('yours.context'));
  await route.getByRole('button', { name: 'Explain this rule', exact: true }).click(); await expect(context).toContainText('Loading context');
  await context.getByRole('button', { name: 'Close context', exact: true }).click();
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('yours.context'))).toBe(1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(context).toHaveCount(0); await expect(route.getByRole('heading', { name: 'Ana’s passport', exact: true })).toBeVisible();
});

test('Rule context identifies a retired asset while keeping its recorded relationships readable', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_retired_context#yours/asset/passport/view/rules`);
  const route = page.locator('[data-recued-yours]'); await route.getByRole('button', { name: 'Explain this rule', exact: true }).click();
  const context = route.locator('[data-yours-context]');
  await expect(context).toContainText('This asset is retired. These are its recorded relationships.');
  await expect(context.getByRole('link', { name: 'Open rule on asset', exact: true })).toBeVisible();
});

test('A reading opens its own rule and writer flows without surrendering the manual entry', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields&yours_handoff_writer#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); const reading = route.locator('[data-yours-reading="odometer"]');
  await reading.getByRole('button', { name: 'Update reading', exact: true }).click();
  await route.getByLabel('Value', { exact: true }).fill('9500'); await route.getByRole('button', { name: 'Save reading', exact: true }).click();
  await reading.getByLabel('More actions for Odometer reading', { exact: true }).click(); await reading.getByRole('button', { name: 'Use in a rule', exact: true }).click();
  const form = route.locator('[data-yours-editor]');
  await expect(form.getByLabel('When', { exact: true })).toHaveValue('objective'); await expect(form.getByLabel('Asset reading', { exact: true })).toHaveValue('odometer');
  await expect(form.getByLabel('Reading unit', { exact: true })).toHaveValue('km'); await expect(form.getByLabel('Target', { exact: true })).toHaveValue('');
  await form.getByLabel('Target', { exact: true }).fill('10000'); await form.getByRole('button', { name: 'Save', exact: true }).click();
  expect(await page.evaluate(() => window.__assetRuleWrites)).toMatchObject([{ action: 'rule.save', rule: { when: { kind: 'objective', field: 'odometer', target: 10000, unit: 'km' } } }]);
  const more = reading.getByRole('group', { name: 'Actions for Odometer reading', exact: true });
  if (!await more.isVisible()) await reading.getByLabel('More actions for Odometer reading', { exact: true }).click();
  await more.getByRole('button', { name: 'Keep updated from a source', exact: true }).click();
  await form.getByLabel('Installed observation recipe', { exact: true }).selectOption('health');
  await expect(form.getByLabel('Odometer · reading', { exact: true })).toBeChecked(); await expect(form.getByLabel('Damage · condition', { exact: true })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('writer-review-phone.png'), fullPage: true });
  await form.getByRole('button', { name: 'Enroll writer', exact: true }).click();
  expect(await page.evaluate(() => window.__assetRelationshipWrites)).toEqual([{ action: 'binding.save', asset_id: 'passport', recipe_id: 'health', expected_recipe_hash: 'fixture', fields: ['readings.odometer', 'observations.damage'] }]);
  await expect(reading).toContainText('9500 km'); await expect(reading).toContainText('Your entry takes priority');
  expect(await page.evaluate(() => window.__assetHandoffWrites)).toEqual([]);
  await route.getByRole('navigation', { name: 'Asset sections', exact: true }).getByRole('link', { name: 'Rules', exact: true }).click();
  await route.locator('[data-yours-disclosure="Observation writers"]>summary').click(); await route.getByRole('button', { name: 'Disable writer', exact: true }).click();
  await route.getByRole('navigation', { name: 'Asset sections', exact: true }).getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(reading).toContainText('9500 km'); await expect(reading).toContainText('Recorded by you');
});

test('Adding supporting evidence preserves the value and the explicit automatic-update handoff', async ({ page }, testInfo) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields&yours_handoff_writer&yours_file_details=ready#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); const reading = route.locator('[data-yours-reading="odometer"]');
  await reading.getByRole('button', { name: 'Update reading', exact: true }).click(); await route.getByLabel('Value', { exact: true }).fill('9500');
  await route.getByRole('button', { name: 'Save reading', exact: true }).click(); await reading.getByRole('button', { name: 'Allow automatic updates', exact: true }).click();
  await reading.getByLabel('More actions for Odometer reading', { exact: true }).click(); await reading.getByRole('button', { name: 'Add evidence', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); await form.getByLabel('Supporting file', { exact: true }).selectOption({ label: 'Passport receipt.txt' });
  await page.screenshot({ path: testInfo.outputPath('supporting-evidence.png'), fullPage: true });
  await form.getByRole('button', { name: 'Add evidence', exact: true }).click();
  await expect(reading).toContainText('9500 km'); await expect(reading).toContainText('Automatic updates allowed.'); await expect(reading).toContainText('Recorded by you');
  await expect(reading.getByRole('button', { name: 'Open evidence', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__app.rpcCallCount('data.file.read'))).toBe(0);
  expect(await page.evaluate(() => window.__assetRelationshipWrites)).toMatchObject([{ action: 'asset.add_evidence', path: 'readings.odometer', evidence: { collection: 'file', id: expect.any(String) } }]);
});

for (const mode of ['retry', 'mismatch']) test(`Evidence cannot cite a file before its identity is confirmed: ${mode}`, async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields&yours_file_details=${mode}#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); const reading = route.locator('[data-yours-reading="odometer"]');
  await reading.getByLabel('More actions for Odometer reading', { exact: true }).click();
  await reading.getByRole('button', { name: 'Add evidence', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); const choice = form.getByLabel('Supporting file', { exact: true });
  await expect(form.getByRole('button', { name: 'Retry file name', exact: true })).toBeVisible();
  await expect(choice.locator('option').last()).toHaveJSProperty('disabled', true);
  await expect(form).not.toContainText('Unrelated private file.txt');
  expect(await page.evaluate(() => window.__assetRelationshipWrites)).toEqual([]);
  if (mode === 'retry') {
    await form.getByRole('button', { name: 'Retry file name', exact: true }).click();
    await choice.selectOption({ label: 'Passport receipt.txt' });
    await form.getByRole('button', { name: 'Add evidence', exact: true }).click();
    await expect(form).toHaveCount(0);
    expect(await page.evaluate(() => window.__assetRelationshipWrites)).toHaveLength(1);
  }
  expect(await page.evaluate(() => window.__app.rpcCallCount('data.file.read'))).toBe(0);
});

test('Switching observation recipes preserves the field choices reviewed for each one', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?yours=demo&yours_rule_fields&yours_handoff_writer&yours_multiple_writers#yours/asset/passport`);
  const route = page.locator('[data-recued-yours]'); const reading = route.locator('[data-yours-reading="odometer"]');
  await reading.getByLabel('More actions for Odometer reading', { exact: true }).click();
  await reading.getByRole('button', { name: 'Keep updated from a source', exact: true }).click();
  const form = route.locator('[data-yours-editor]'); const recipe = form.getByLabel('Installed observation recipe', { exact: true });
  await recipe.selectOption('health');
  const odometer = form.getByRole('checkbox', { name: 'Odometer · reading', exact: true });
  const damage = form.getByRole('checkbox', { name: 'Damage · condition', exact: true });
  await expect(odometer).toBeChecked(); await damage.uncheck();
  await recipe.selectOption('second'); await recipe.selectOption('health');
  await expect(odometer).toBeChecked(); await expect(damage).not.toBeChecked();
  await form.getByRole('button', { name: 'Enroll writer', exact: true }).click();
  expect(await page.evaluate(() => window.__assetRelationshipWrites)).toMatchObject([{ action: 'binding.save', recipe_id: 'health', expected_recipe_hash: 'fixture', fields: ['readings.odometer'] }]);
});
