import { expect, test, type Page } from '@playwright/test';
import { TIER1_TOOL_GUIDE, type CatalogIngredientView, type OverrideView } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

/** Contracts browser journeys against the deterministic full-app harness. */
const CONTRACTS_DETAIL_HEADING = 'data-recued-contracts-detail-heading';
const CONTRACTS_DETAIL_TAB = 'data-recued-contracts-tab';
const CONTRACTS_DETAIL_TAB_BODY = 'data-recued-contracts-tab-body';
const CONTRACTS_LIST_TAB = 'data-recued-contracts-list-tab';

installFullAppHooks();

for (const width of [390]) {
  test(`Contracts keeps the key on Connect and grant filters through access repaints at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${HARNESS_URL}?contracts=paged#contracts/door_paged_01/connect`);
    await page.waitForFunction(() => window.__app?.ready === true);
    // D-327 — Connect holds this agreement's key; the rules for every agreement
    // moved to the list page.
    await expect(page.locator('[data-recued-contract-key]')).toBeVisible();
    await expect(page.locator('[data-recued-permissions-create-actor]')).toHaveCount(0);

    await page.locator(`[${CONTRACTS_DETAIL_TAB}][data-tab="ops"]`).click();
    const filter = page.locator('[data-recued-contract-grants-op-filter]');
    await filter.fill('core.ai');
    await expect(page.locator('[data-recued-contract-grants-cell]').first()).toBeVisible();
    const reads = await page.evaluate(() => window.__app.rpcCallCount('contract.grant.read'));
    const tools = page.getByRole('checkbox', { name: 'MCP tools', exact: true });
    await tools.focus(); await page.keyboard.press('Space');
    await expect(tools).not.toBeChecked(); await expect(tools).toBeFocused();
    await expect(filter).toHaveValue('core.ai');

    await page.locator('[data-recued-contracts-revoke]').click();
    await page.locator('[data-recued-contracts-revoke-cancel]').click();
    await expect(page.locator('[data-recued-contracts-revoke-confirm]')).toHaveCount(0);
    await expect(filter).toHaveValue('core.ai');
    expect(await page.evaluate(() => window.__app.rpcCallCount('contract.grant.read'))).toBe(reads);
    expect(await page.evaluate(() => window.__app.rpcCallCount('collection.contract.revokeContract'))).toBe(0);
    expect(await page.evaluate(() => window.__app.rpcCallCount('contract.grant.write'))).toBe(0);

    await page.locator(`[${CONTRACTS_DETAIL_TAB}][data-tab="connect"]`).click();
    await expect(page.locator('[data-recued-contract-key]')).toBeVisible();
    await page.locator(`[${CONTRACTS_DETAIL_TAB}][data-tab="ops"]`).click();
    await expect(filter).toHaveValue('core.ai');
  });
}

test('Contracts moves focus from an inventory row into its exact detail', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?journey=bounded-verification`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#contracts'));

  const owner = page.locator(
    '[data-recued-contracts-row][data-contract-id="user_self"]',
  );
  await expect(owner).toBeVisible();
  await owner.focus();
  await page.keyboard.press('Enter');

  const heading = page.locator(
    `[${CONTRACTS_DETAIL_HEADING}="user_self"]`,
  );
  await expect(page).toHaveURL(/#contracts\/user_self$/);
  await expect(heading).toHaveText('Owner (you)');
  await expect(heading).toHaveAttribute('tabindex', '-1');
  await expect(heading).toBeFocused();
});

test('Contracts restores the exact inventory row after Back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?journey=bounded-verification`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#contracts'));

  const owner = page.locator(
    '[data-recued-contracts-row][data-contract-id="user_self"]',
  );
  await expect(owner).toBeVisible();
  await owner.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(
    `[${CONTRACTS_DETAIL_HEADING}="user_self"]`,
  )).toBeFocused();

  const back = page.locator('[data-recued-contracts-back]');
  await back.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-recued-contracts-list]')).toBeVisible();
  await expect(owner).toBeFocused();
});

test('Contracts category tabs form one arrow-key keyboard stop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?contracts=paged#contracts/view/others`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const tabs = page.locator(`[${CONTRACTS_LIST_TAB}]`);
  const builtIn = page.locator(
    `[${CONTRACTS_LIST_TAB}][data-tab="built-in"]`,
  );
  const customer = page.locator(
    `[${CONTRACTS_LIST_TAB}][data-tab="customer"]`,
  );
  const others = page.locator(
    `[${CONTRACTS_LIST_TAB}][data-tab="others"]`,
  );
  await expect(tabs).toHaveCount(3);
  await expect(others).toHaveAttribute('aria-selected', 'true');
  await expect(others).toHaveAttribute('tabindex', '0');
  await expect(page.locator(
    `[${CONTRACTS_LIST_TAB}][tabindex="0"]`,
  )).toHaveCount(1);

  await others.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/#contracts\/view\/built-in$/);
  await expect(builtIn).toHaveAttribute('aria-selected', 'true');
  await expect(builtIn).toHaveAttribute('tabindex', '0');
  await expect(builtIn).toBeFocused();
  await expect(page.locator('[data-recued-contracts-page-status]')).toHaveText(
    'No contracts you look after on this page',
  );

  await page.keyboard.press('End');
  await expect(page).toHaveURL(/#contracts\/view\/others$/);
  await expect(others).toBeFocused();

  await page.keyboard.press('Home');
  await expect(page).toHaveURL(/#contracts\/view\/built-in$/);
  await expect(builtIn).toBeFocused();

  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/#contracts\/view\/customer$/);
  await expect(customer).toHaveAttribute('aria-selected', 'true');
  await expect(customer).toBeFocused();
  await expect(page.locator(
    `[${CONTRACTS_LIST_TAB}][tabindex="0"]`,
  )).toHaveCount(1);
});

test('Contracts keeps new-contract disclosure and slow creation keyboard-owned', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?contracts=paged&contracts_mint_response=slow#contracts/view/others`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const opener = page.locator('[data-recued-contracts-new]');
  await expect(opener).toHaveText('+ New contract');
  await expect(opener).toHaveAttribute('aria-expanded', 'false');
  await expect(opener).toHaveAttribute(
    'aria-controls',
    'recued-contracts-new-contract-form',
  );
  await opener.focus();
  await page.keyboard.press('Enter');

  const form = page.getByRole('group', { name: 'New contract' });
  const name = form.getByRole('textbox', { name: 'Contract name' });
  await expect(form).toBeVisible();
  await expect(opener).toHaveText('Cancel new contract');
  await expect(opener).toHaveAttribute('aria-expanded', 'true');
  await expect(name).toBeFocused();
  await name.fill('Browser-created contract');

  const submit = form.locator('[data-recued-contracts-new-submit]');
  await submit.focus();
  await page.keyboard.press('Enter');
  await expect(submit).toHaveText('Creating…');
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await expect(submit).toHaveAttribute('aria-busy', 'true');
  await expect(submit).not.toHaveAttribute('disabled');
  await expect(submit).toBeFocused();
  await expect(opener).toHaveAttribute('aria-disabled', 'true');

  await submit.dispatchEvent('click');
  await submit.dispatchEvent('click');
  await opener.dispatchEvent('click');
  await expect(form).toBeVisible();
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('collection.contract.mintContract'),
    ),
  ).toBe(1);

  await expect(page).toHaveURL(/#contracts\/door_paged_new\/connect$/);
  await expect(page.locator(
    `[${CONTRACTS_DETAIL_HEADING}="door_paged_new"]`,
  )).toHaveText('Browser-created contract');
});

test('Contracts contains creation failures and preserves the form retry', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?contracts=paged`
      + '&contracts_mint_response=fail-once-slow-retry'
      + '&hold_rpc=collection.contract.mintContract'
      + '#contracts/view/others',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator('[data-recued-contracts-route]');
  const opener = page.locator('[data-recued-contracts-new]');
  await opener.click();
  const form = page.locator('[data-recued-contracts-new-form]');
  const name = form.getByRole('textbox', { name: 'Contract name' });
  await name.fill('Retry contract');
  const submit = form.locator('[data-recued-contracts-new-submit]');
  await submit.focus();
  await page.keyboard.press('Enter');

  await expect(submit).toHaveText('Creating…');
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await expect(submit).toHaveAttribute('aria-busy', 'true');
  await expect(submit).toBeFocused();
  await expect(opener).toHaveAttribute('aria-disabled', 'true');
  await submit.dispatchEvent('click');
  await submit.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('collection.contract.mintContract'),
    ),
  ).toBe(1);

  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.(
    'collection.contract.mintContract',
  ))).toBe(1);
  const failureId = `mint_${'M'.repeat(220)}`;
  const error = form.locator('[data-recued-contracts-new-error]');
  await expect(error).toHaveText(
    `Contract mint unavailable for request ${failureId}. `
      + 'Check limits and retry.',
  );
  await expect(name).toHaveValue('Retry contract');
  await expect(submit).toHaveText('Create contract');
  await expect(submit).not.toHaveAttribute('aria-disabled');
  await expect(submit).not.toHaveAttribute('aria-busy');
  await expect(submit).toBeFocused();
  await expect(opener).not.toHaveAttribute('aria-disabled');
  for (const owner of [error, form, route]) {
    expect(await owner.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    )).toBe(true);
  }

  await submit.focus();
  await page.keyboard.press('Enter');
  await expect(submit).toHaveText('Creating…');
  await expect(submit).toBeFocused();
  await submit.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('collection.contract.mintContract'),
    ),
  ).toBe(2);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.(
    'collection.contract.mintContract',
  ))).toBe(1);
  await expect(page).toHaveURL(/#contracts\/door_paged_new\/connect$/);
  await expect(page.locator(
    `[${CONTRACTS_DETAIL_HEADING}="door_paged_new"]`,
  )).toHaveText('Retry contract');
  await expect(page.locator(
    `[${CONTRACTS_DETAIL_HEADING}="door_paged_new"]`,
  )).toBeFocused();
});

test('Contracts contains a long created identity across detail and inventory', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(`${HARNESS_URL}?contracts=paged#contracts/view/others`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const contractName = `Contract${'N'.repeat(240)}`;
  await page.locator('[data-recued-contracts-new]').click();
  await page.getByRole('textbox', { name: 'Contract name' }).fill(contractName);
  await page.locator('[data-recued-contracts-new-submit]').click();

  const route = page.locator('[data-recued-contracts-route]');
  const body = route.locator('[data-recued-contracts-body]');
  const detail = body.locator('[data-recued-contracts-detail]');
  const heading = detail.locator(
    `[${CONTRACTS_DETAIL_HEADING}="door_paged_new"]`,
  );
  await expect(heading).toHaveText(contractName);
  const detailOwners = detail.locator(
    ':scope, .contracts-detail-head, .contracts-detail-name, '
    + '.contracts-detail-limits, .contracts-tabs, '
    + '[data-recued-contracts-tab-body], [data-recued-contracts-connect], '
    + '.contracts-snippet-grid, [data-recued-contracts-snippet], '
    + '[data-recued-contract-key]',
  );
  expect(await detailOwners.evaluateAll((elements) => elements.every(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  ))).toBe(true);
  for (const owner of [body, route]) {
    expect(await owner.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    )).toBe(true);
  }

  await detail.locator('[data-recued-contracts-back]').click();
  const list = body.locator('[data-recued-contracts-list]');
  const row = list.locator(
    '[data-recued-contracts-row][data-contract-id="door_paged_new"]',
  );
  await expect(row.locator('.contracts-row-name')).toHaveText(contractName);
  const listOwners = body.locator(
    '[data-recued-contracts-list-panel], [data-recued-contracts-list], '
    + '[data-recued-contracts-list] > li, '
    + '[data-recued-contracts-row][data-contract-id="door_paged_new"], '
    + '[data-recued-contracts-row][data-contract-id="door_paged_new"] > *',
  );
  expect(await listOwners.evaluateAll((elements) => elements.every(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  ))).toBe(true);
  for (const owner of [body, route]) {
    expect(await owner.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    )).toBe(true);
  }
});

test('Contracts keeps paging controls reachable at a cursor boundary', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?contracts=paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#contracts/view/others'));

  const status = page.locator('[data-recued-contracts-page-status]');
  const next = page.locator('[data-recued-contracts-page-next]');
  const previous = page.locator('[data-recued-contracts-page-previous]');
  await expect(status).toHaveText('Showing 1–25 of 26');
  expect((await next.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  expect((await previous.boundingBox())?.height).toBeGreaterThanOrEqual(36);

  await next.focus();
  await page.keyboard.press('Enter');
  await expect(status).toHaveText('Showing 26–26 of 26');
  await expect(previous).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(status).toHaveText('Showing 1–25 of 26');
  await expect(next).toBeFocused();
});

test('Contracts keeps slow paging focused, visible, and single-flight', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?contracts=paged&contracts_page_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#contracts/view/others'));

  const status = page.locator('[data-recued-contracts-page-status]');
  const next = page.locator('[data-recued-contracts-page-next]');
  const previous = page.locator('[data-recued-contracts-page-previous]');
  await expect(status).toHaveText('Showing 1–25 of 26');
  const readsBefore = await page.evaluate(
    () => window.__app.rpcCallCount('collection.contract.listContracts.cursor'),
  );

  await next.focus();
  await page.keyboard.press('Enter');
  await expect(next).toHaveText('Loading…');
  await expect(next).toHaveAttribute('aria-label', 'Loading next page');
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  await expect(next).toHaveAttribute('aria-busy', 'true');
  await expect(next).not.toHaveAttribute('disabled');
  await expect(next).toBeFocused();
  await next.dispatchEvent('click');
  await next.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('collection.contract.listContracts.cursor'),
    ),
  ).toBe(readsBefore + 1);

  await expect(status).toHaveText('Showing 26–26 of 26');
  await expect(previous).toBeFocused();
});

test('Contracts contains page failures and preserves the exact retry', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?contracts=paged`
      + '&contracts_page_response=fail-once-slow-retry'
      + '#contracts/view/others',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator('[data-recued-contracts-route]');
  const body = route.locator('[data-recued-contracts-body]');
  const panel = body.locator('[data-recued-contracts-list-panel]');
  const status = panel.locator('[data-recued-contracts-page-status]');
  const next = panel.locator('[data-recued-contracts-page-next]');
  const previous = panel.locator('[data-recued-contracts-page-previous]');
  await expect(status).toHaveText('Showing 1–25 of 26');
  const readsBefore = await page.evaluate(
    () => window.__app.rpcCallCount('collection.contract.listContracts'),
  );

  await next.click();
  await expect(next).toHaveText('Loading…');
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  await expect(next).toHaveAttribute('aria-busy', 'true');
  await expect(next).toBeFocused();
  await next.dispatchEvent('click');
  await next.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('collection.contract.listContracts'),
    ),
  ).toBe(readsBefore + 1);

  const failureId = `page_${'P'.repeat(220)}`;
  const error = body.locator('[data-recued-contracts-error]');
  await expect(error).toHaveText(
    `Recued could not load some of your contracts: Contract page unavailable for cursor `
      + `${failureId}. Retry this page.`,
  );
  await expect(status).toHaveText('Showing 1–25 of 26');
  await expect(panel.locator('[data-recued-contracts-row]')).toHaveCount(25);
  await expect(next).toHaveText('Next');
  await expect(next).toBeFocused();
  for (const owner of [error, panel, body, route]) {
    expect(await owner.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    )).toBe(true);
  }

  const readsBeforeRetry = await page.evaluate(
    () => window.__app.rpcCallCount('collection.contract.listContracts'),
  );
  await next.click();
  await expect(next).toHaveText('Loading…');
  await expect(next).toBeFocused();
  await expect(error).toBeVisible();
  await next.dispatchEvent('click');
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('collection.contract.listContracts'),
  )).toBe(readsBeforeRetry + 1);
  await expect(status).toHaveText('Showing 26–26 of 26');
  await expect(error).toHaveCount(0);
  await expect(previous).toBeFocused();
});

test('Contracts keeps revoke confirmation keyboard-owned', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?contracts=paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash(
    '#contracts/door_paged_01',
  ));

  const revoke = page.locator('[data-recued-contracts-revoke]');
  await expect(revoke).toHaveText('Revoke');
  await revoke.focus();
  await page.keyboard.press('Enter');

  const confirm = page.locator('[data-recued-contracts-revoke-confirm]');
  await expect(confirm).toBeFocused();
  const cancel = page.locator('[data-recued-contracts-revoke-cancel]');
  expect((await confirm.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  expect((await cancel.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(revoke).toHaveText('Revoke');
  await expect(revoke).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator(
    `[${CONTRACTS_DETAIL_HEADING}="door_paged_01"]`,
  )).toBeFocused();
  await expect(revoke).toHaveCount(0);
  await expect(page.locator('[data-recued-contracts-detail]')).toContainText(
    'Revoked',
  );
  expect(await page.evaluate(() => window.__app.rpcCallCount(
    'collection.contract.revokeContract',
  ))).toBe(1);
});

test('Contracts contains revoke failures and preserves a safe retry', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?contracts=paged`
      + '&contracts_revoke_response=fail-once-slow-retry'
      + '#contracts/door_paged_01',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator('[data-recued-contracts-route]');
  const detail = page.locator('[data-recued-contracts-detail]');
  const heading = detail.locator(
    `[${CONTRACTS_DETAIL_HEADING}="door_paged_01"]`,
  );
  const revoke = detail.locator('[data-recued-contracts-revoke]');
  await revoke.click();
  let confirm = detail.locator('[data-recued-contracts-revoke-confirm]');
  await confirm.click();

  await expect(revoke).toHaveText('Revoking…');
  await expect(revoke).toHaveAttribute('aria-disabled', 'true');
  await expect(revoke).toHaveAttribute('aria-busy', 'true');
  await expect(revoke).toBeFocused();
  await revoke.dispatchEvent('click');
  await revoke.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('collection.contract.revokeContract'),
    ),
  ).toBe(1);

  const failureId = `revoke_${'E'.repeat(220)}`;
  const error = detail.locator('[data-recued-contracts-head-error]');
  await expect(error).toHaveText(
    `Recued could not turn it off: Contract revoke unavailable for request ${failureId}. `
      + 'Retry from this contract.',
  );
  await expect(revoke).toHaveText('Revoke');
  await expect(revoke).toBeFocused();
  for (const owner of [error, detail.locator('.contracts-detail-head'), detail, route]) {
    expect(await owner.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    )).toBe(true);
  }

  await revoke.click();
  confirm = detail.locator('[data-recued-contracts-revoke-confirm]');
  await expect(confirm).toBeFocused();
  await confirm.click();
  await expect(revoke).toHaveText('Revoking…');
  await expect(revoke).toBeFocused();
  await revoke.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('collection.contract.revokeContract'),
    ),
  ).toBe(2);

  await expect(error).toHaveCount(0);
  await expect(revoke).toHaveCount(0);
  await expect(detail).toContainText('Revoked');
  await expect(heading).toBeFocused();
});

test('Contracts preserves a door toggle through its write repaint', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?contracts=paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash(
    '#contracts/door_paged_01',
  ));

  const toggle = page.getByRole('checkbox', { name: 'MCP tools' });
  await expect(toggle).toBeChecked();
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeFocused();
  expect(await page.evaluate(() => window.__app.rpcCallCount(
    'collection.contract.setDoorTypes',
  ))).toBe(1);
});

test('Contracts Connect renders a full-size mobile credential editor', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?contracts=paged#contracts/door_paged_01/connect`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  await expect(page.locator(
    '[data-recued-contracts-connect]',
  ).getByRole('heading', { level: 3 })).toHaveText([
    'Key',
    "Claude Desktop, on the server's computer",
    'Claude Code',
    'Cursor',
    'Cline',
    'Codex',
    'OpenClaw',
    'Another AI app',
  ]);

  // D-327 — the agreement's own key, not a server-wide door panel.
  const key = page.locator('[data-recued-contract-key]');
  await expect(key).toContainText('This contract has a key');
  const turnOff = key.locator('[data-recued-contract-key-turn-off]');
  await expect(turnOff).toHaveText('Turn off this key');
  expect((await turnOff.boundingBox())?.height).toBeGreaterThanOrEqual(36);

  const doorTargets = page.locator('[data-recued-contracts-door-toggle]');
  expect(await doorTargets.count()).toBe(2);
  const doorHeights = await doorTargets.evaluateAll((targets) => targets.map(
    (target) => target.getBoundingClientRect().height,
  ));
  expect(Math.min(...doorHeights)).toBeGreaterThanOrEqual(36);

  const detail = page.locator('[data-recued-contracts-detail]');
  const tabs = detail.locator(`[${CONTRACTS_DETAIL_TAB}]`);
  const tabHeights = await tabs.evaluateAll((targets) => targets.map(
    (target) => target.getBoundingClientRect().height,
  ));
  expect(Math.min(...tabHeights)).toBeGreaterThanOrEqual(36);
  expect((await detail.locator(
    '[data-recued-contracts-revoke]',
  ).boundingBox())?.height).toBeGreaterThanOrEqual(36);

  expect(await detail.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);

  for (const link of [
    detail.locator('[data-recued-contracts-back]'),
    detail.locator('[data-recued-contracts-activity-link]'),
  ]) {
    expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  }
});

test('Contracts list keeps the rules for every agreement full-size on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?contracts=paged#contracts/view/others`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const rules = page.locator('[data-recued-contracts-rules]');
  await rules.locator('summary').click();
  const form = rules.locator('[data-recued-permissions-create]');
  const save = form.locator('[data-recued-permissions-create-save]');
  await expect(save).toHaveText('Add the rule');
  expect(await form.evaluate(
    (element) => getComputedStyle(element).flexDirection,
  )).toBe('column');
  expect((await save.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  const denyTarget = form.locator(
    'label:has([data-recued-permissions-create-denied])',
  );
  expect((await denyTarget.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  expect(await rules.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
});

test('Contracts grants contain long operation labels and keep full mobile targets', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?contracts=paged#contracts/door_paged_01/ops`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const assertGrantTargets = async (): Promise<void> => {
    const route = page.locator('[data-recued-contracts-route]');
    const detail = page.locator('[data-recued-contracts-detail]');
    const tabBody = page.locator('[data-recued-contracts-tab-body]');
    const panel = page.locator('[data-recued-contract-grants]');
    const targets = page.locator('[data-recued-contract-grants-cell]');
    await expect(targets.first()).toBeVisible();
    const heights = await targets.evaluateAll((labels) => labels.map(
      (label) => label.getBoundingClientRect().height,
    ));
    expect(heights.length).toBeGreaterThan(0);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(36);
    const owners = panel.locator(
      ':scope, .cg-filter-results, .cg-kind, .cg-op-ingredient, .cg-cell, '
        + '.cg-cell-name, .cg-cell-text, .cg-cell-title, .cg-also-reads, .cg-source, '
        + '.cg-ai-tools-note, .cg-needs, .cg-need',
    );
    expect(await owners.evaluateAll((elements) => elements.every(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ))).toBe(true);
    for (const owner of [tabBody, detail, route]) {
      expect(await owner.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      )).toBe(true);
    }
  };

  await assertGrantTargets();
  const longOperation = page.locator(
    '[data-recued-contract-grants-cell]'
      + '[data-entry="core.contact.engagements.read"]',
  );
  await expect(longOperation).toBeVisible();
  await expect(longOperation.locator('.cg-cell-name')).toHaveText(
    'core.contact.engagements.read',
  );
  await expect(longOperation.locator('.cg-source')).toHaveText('default');
  await expect(page.locator(
    '[data-recued-contract-grants-cell][data-entry="data.file"]',
  )).toBeVisible();
  await page.locator(
    `[${CONTRACTS_DETAIL_TAB}][data-tab="entities"]`,
  ).click();
  await expect(page.locator(
    '[data-recued-contract-grants-cell][data-entry="enrichment.summary"]',
  )).toBeVisible();
  await assertGrantTargets();

});

/** D-327 follow-on — the owner could not tell that `work.create` alone adds nothing
 *  on an agreement that grants nothing by default. Ops now opens with the AI tools,
 *  and under each one the other switches it needs, which the owner can press there. */
test('Contracts opens Ops with the AI tools, each saying what else it needs', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(`${HARNESS_URL}?contracts=paged#contracts/door_paged_01/ops`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const panel = page.locator('[data-recued-contract-grants]');
  await expect(panel.locator('.cg-op-ingredient-name').first()).toHaveText('AI tools');
  await expect(panel.locator('[data-recued-contract-grants-ai-tools-note]')).toBeVisible();

  // The owner's words beside the id, and the join on hover.
  const task = panel.locator('[data-recued-contract-grants-cell][data-entry="core.work-entity.task.create"]');
  await expect(task.locator('[data-recued-contract-grants-title]')).toHaveText('Create a task');
  await expect(task).toHaveAttribute('title', /AI tools that need this: work\.create \(to add tasks\)/);

  const needs = panel.locator('[data-recued-contract-grants-needs][data-entry="primitive.work.create"]');
  await expect(needs).toBeVisible();
  const buttons = needs.locator('[data-recued-contract-grants-need]');
  // One button per switch the tool needs, counted from the guide the panel draws from. A
  // literal 4 went stale when `work.create` gained things you own (`0088062d8`).
  await expect(buttons).toHaveCount(TIER1_TOOL_GUIDE['work.create'].needs.length);
  const heights = await buttons.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(24);
  expect(await panel.locator('.cg-needs, .cg-need, .cg-cell-title, .cg-ai-tools-note').evaluateAll(
    (els) => els.every((el) => el.scrollWidth <= el.clientWidth + 1),
  )).toBe(true);

  // Pressing a need switches that switch: the same one as its own row.
  const need = needs.locator('[data-entry="core.work-entity.task.create"]');
  const before = await task.getAttribute('data-effective');
  const after = before === 'on' ? 'off' : 'on';
  await need.click();
  await expect(need).toHaveAttribute('data-effective', after);
  await expect(task).toHaveAttribute('data-effective', after);
});

test('Contracts detail tabs form one arrow-key keyboard stop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?journey=bounded-verification`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#contracts/user_self'));

  const tabs = page.locator(`[${CONTRACTS_DETAIL_TAB}]`);
  const ops = page.locator(`[${CONTRACTS_DETAIL_TAB}][data-tab="ops"]`);
  const entities = page.locator(
    `[${CONTRACTS_DETAIL_TAB}][data-tab="entities"]`,
  );
  const recipes = page.locator(
    `[${CONTRACTS_DETAIL_TAB}][data-tab="recipes"]`,
  );
  const panel = page.locator(`[${CONTRACTS_DETAIL_TAB_BODY}]`);
  await expect(tabs).toHaveText(['Ops', 'Entities', 'Recipes']);
  await expect(ops).toHaveAttribute('tabindex', '0');
  await expect(entities).toHaveAttribute('tabindex', '-1');
  expect(await tabs.evaluateAll((nodes) => nodes.filter(
    (node) => node.getAttribute('tabindex') === '0',
  ).length)).toBe(1);

  await ops.focus();
  await page.keyboard.press('ArrowRight');
  await expect(entities).toHaveAttribute('aria-selected', 'true');
  await expect(entities).toHaveAttribute('tabindex', '0');
  await expect(entities).toBeFocused();
  await expect(panel).toHaveAttribute('role', 'tabpanel');
  await expect(panel).toHaveAttribute(
    'aria-labelledby',
    'recued-contracts-detail-tab-entities',
  );

  await page.keyboard.press('ArrowRight');
  await expect(recipes).toHaveAttribute('aria-selected', 'true');
  await expect(recipes).toHaveAttribute('tabindex', '0');
  await expect(recipes).toBeFocused();
  await expect(panel).toHaveAttribute(
    'aria-labelledby',
    'recued-contracts-detail-tab-recipes',
  );
  expect(await tabs.evaluateAll((nodes) => nodes.filter(
    (node) => node.getAttribute('tabindex') === '0',
  ).length)).toBe(1);

  await page.keyboard.press('ArrowRight');
  await expect(ops).toHaveAttribute('aria-selected', 'true');
  await expect(ops).toBeFocused();
});

test('Contracts keeps an operation grant toggle focused and single-flight', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?contracts=paged&hold_rpc=contract.grant.write#contracts/door_paged_01/ops`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const toggle = page.locator(
    '[data-recued-contract-grants-cell-toggle]',
  ).first();
  await expect(toggle).toBeVisible();
  const startedChecked = await toggle.isChecked();
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
  });
  await toggle.focus();
  await page.keyboard.press('Space');

  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await expect(toggle).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => window.__app.setHash('#data'));
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Something is still happening. Leave anyway?',
  );
  await expect(page).toHaveURL(/#contracts\/door_paged_01\/ops$/);
  await expect(toggle).not.toHaveAttribute('disabled');
  await expect(toggle).toBeFocused();
  await toggle.dispatchEvent('change');
  await toggle.dispatchEvent('change');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('contract.grant.write')),
  ).toBe(1);
  expect(await page.evaluate(
    () => window.__app.releaseRpcResponses?.('contract.grant.write'),
  )).toBe(1);

  await expect(toggle).not.toHaveAttribute('aria-disabled');
  await expect(toggle).not.toHaveAttribute('aria-busy');
  await expect(toggle).toBeFocused();
  expect(await toggle.isChecked()).toBe(!startedChecked);
  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(page).toHaveURL(/#data$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

interface ContractRuleRecoveryFixture {
  mode: 'error' | 'hold' | 'ready';
  replacementCatalog: boolean;
  catalogReads: number;
  inventoryReads: number;
  upserts: unknown[];
  deletes: number;
  pending: number;
  confirmations: number;
  release(index: number): void;
}
declare global { interface Window { __contractRuleRecovery: ContractRuleRecoveryFixture } }

const bootRuleRecovery = async (page: Page): Promise<void> => {
  await page.goto(`${HARNESS_URL}?contracts=paged#contracts/view/others`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => {
    const catalog: CatalogIngredientView[] = ['deals', 'contacts'].map(name => ({
      ingredient_id: `hubspot.${name}`, name: `HubSpot ${name === 'deals' ? 'Deals' : 'Contacts'}`,
      operations: [{ operation_id: `hubspot.${name}.read`, operation_key: 'read', risk_tier: 'read', groups: ['crm'] }],
    }));
    const existing: OverrideView = {
      actor: 'user_self', ingredient_id: 'hubspot.contacts', operation_id: null,
      policy: { approval: 'always' }, written_at: 1,
    };
    let rows = [existing];
    type CatalogReply = { result: { ingredients: CatalogIngredientView[] } };
    const pending: Array<{ resolve(reply: CatalogReply): void; reply: CatalogReply; released: boolean }> = [];
    const fixture: ContractRuleRecoveryFixture = {
      mode: 'error', replacementCatalog: false, catalogReads: 0, inventoryReads: 0,
      upserts: [], deletes: 0, pending: 0, confirmations: 0,
      release(index) {
        const item = pending[index];
        if (!item || item.released) throw new Error(`No pending catalog read ${index}`);
        item.released = true; item.resolve(item.reply);
      },
    };
    Object.assign(window, {
      __contractRuleRecovery: fixture,
      __connectionsFixture: async (method: string, raw: unknown) => {
        if (method === 'collection.contract.listOverrides') {
          fixture.inventoryReads++;
          return { result: { overrides: rows } };
        }
        if (method === 'collection.contract.listCatalogOperations') {
          fixture.catalogReads++;
          if (fixture.mode === 'error') return { error: { code: 'unavailable', message: 'Connection was interrupted' } };
          const reply = { result: { ingredients: fixture.replacementCatalog ? catalog.slice(1) : catalog } };
          if (fixture.mode === 'ready') return reply;
          fixture.pending++;
          return new Promise<CatalogReply>(resolve => { pending.push({ resolve, reply, released: false }); });
        }
        if (method === 'collection.contract.upsertOverride') {
          fixture.upserts.push(raw);
          const created: OverrideView = {
            actor: 'contracted_user', ingredient_id: 'hubspot.deals', operation_id: 'hubspot.deals.read',
            policy: { denied: true, approval: 'always', max_risk_without_approval: 'write' }, written_at: 2,
          };
          rows = [existing, created];
          return { result: created };
        }
        if (method === 'collection.contract.deleteOverride') {
          fixture.deletes++;
          return { error: { code: 'unexpected_write', message: 'Catalog recovery must not delete rules.' } };
        }
        return undefined;
      },
    });
  });
  const rules = page.locator('[data-recued-contracts-rules]');
  await rules.locator('summary').click();
  await expect(rules.locator('[data-recued-permissions-catalog-retry]')).toBeVisible();
};

test('Contracts retries its rule catalog without losing the draft or writing permissions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await bootRuleRecovery(page);
  const rules = page.locator('[data-recued-contracts-rules]');
  const actor = rules.locator('[data-recued-permissions-create-actor]');
  const ingredient = rules.locator('[data-recued-permissions-create-ingredient]');
  const approval = rules.locator('[data-recued-permissions-create-approval]');
  const retry = rules.locator('[data-recued-permissions-catalog-retry]');
  await expect(ingredient).toBeDisabled();
  await expect(rules.locator('[data-recued-permissions-create-save]')).toBeDisabled();
  await expect(rules.locator('[data-recued-permissions-catalog-error]')).toContainText('Couldn’t load Ingredients.');
  await actor.selectOption('user_self');
  await rules.locator('[data-recued-permissions-create-denied]').check();
  await rules.locator('[data-recued-permissions-create-maxrisk]').selectOption('write');
  await page.evaluate(() => { window.__contractRuleRecovery.mode = 'hold'; });
  await retry.click();
  await expect.poll(() => page.evaluate(() => window.__contractRuleRecovery.pending)).toBe(1);
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(rules.locator('[data-recued-permissions-create-save]')).toBeDisabled();
  await expect(retry).toBeFocused();
  await retry.evaluate(button => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await actor.selectOption('contracted_user');
  await approval.focus();
  await approval.selectOption('always');
  await expect(approval).toBeFocused();
  expect(await page.evaluate(() => ({
    reads: window.__contractRuleRecovery.catalogReads,
    inventory: window.__contractRuleRecovery.inventoryReads,
    writes: window.__contractRuleRecovery.upserts.length,
    deletes: window.__contractRuleRecovery.deletes,
  }))).toEqual({ reads: 2, inventory: 1, writes: 0, deletes: 0 });
  await expect(rules.locator('[data-recued-permissions-row]')).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('rule-catalog-retry-mobile.png'), fullPage: true });
  await page.evaluate(() => window.__contractRuleRecovery.release(0));
  await expect(rules.locator('[data-recued-permissions-catalog-recovery]')).toBeHidden();
  await expect(ingredient).toBeEnabled();
  await expect(actor).toHaveValue('contracted_user');
  await expect(approval).toHaveValue('always');
  await expect(approval).toBeFocused();
  await expect(rules.locator('[data-recued-permissions-create-denied]')).toBeChecked();
  await expect(rules.locator('[data-recued-permissions-create-maxrisk]')).toHaveValue('write');
  expect(await page.evaluate(() => window.__contractRuleRecovery.upserts)).toEqual([]);
  expect(await page.evaluate(() => window.__contractRuleRecovery.inventoryReads)).toBe(1);
  await ingredient.selectOption('hubspot.deals');
  await rules.locator('[data-recued-permissions-create-operation]').selectOption('hubspot.deals.read');
  await rules.locator('[data-recued-permissions-create-save]').click();
  await expect(rules.locator('[data-recued-permissions-row]')).toHaveCount(2);
  expect(await page.evaluate(() => window.__contractRuleRecovery.upserts)).toEqual([{
    actor: 'contracted_user', ingredient_id: 'hubspot.deals', operation_id: 'hubspot.deals.read',
    policy: { denied: true, approval: 'always', max_risk_without_approval: 'write' },
  }]);
});

test('Contracts returns a completed catalog retry to its Ingredient picker', async ({ page }) => {
  await bootRuleRecovery(page);
  const rules = page.locator('[data-recued-contracts-rules]');
  await page.evaluate(() => { window.__contractRuleRecovery.mode = 'hold'; });
  const retry = rules.locator('[data-recued-permissions-catalog-retry]');
  await retry.click();
  await expect.poll(() => page.evaluate(() => window.__contractRuleRecovery.pending)).toBe(1);
  await expect(retry).toBeFocused();
  await page.evaluate(() => window.__contractRuleRecovery.release(0));
  const ingredient = rules.locator('[data-recued-permissions-create-ingredient]');
  await expect(ingredient).toBeEnabled();
  await expect(ingredient).toBeFocused();
  await expect(rules.locator('[data-recued-permissions-catalog-recovery]')).toBeHidden();
  expect(await page.evaluate(() => window.__contractRuleRecovery.upserts)).toEqual([]);
});

test('Contracts keeps an existing rule confirmation in place while its catalog recovers', async ({ page }) => {
  await bootRuleRecovery(page);
  const rules = page.locator('[data-recued-contracts-rules]');
  await page.evaluate(() => { window.__contractRuleRecovery.mode = 'hold'; });
  await rules.locator('[data-recued-permissions-catalog-retry]').click();
  await expect.poll(() => page.evaluate(() => window.__contractRuleRecovery.pending)).toBe(1);
  const existing = rules.locator('[data-recued-permissions-row]');
  await existing.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirm = existing.getByRole('button', { name: 'Confirm', exact: true });
  await confirm.focus();
  await expect(confirm).toBeFocused();
  await page.evaluate(() => window.__contractRuleRecovery.release(0));
  await expect(rules.locator('[data-recued-permissions-catalog-recovery]')).toBeHidden();
  await expect(confirm).toBeFocused();
  await expect(existing).toContainText('Remove this rule?');
  await existing.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(existing.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  expect(await page.evaluate(() => ({
    reads: window.__contractRuleRecovery.catalogReads,
    inventory: window.__contractRuleRecovery.inventoryReads,
    writes: window.__contractRuleRecovery.upserts.length,
    deletes: window.__contractRuleRecovery.deletes,
  }))).toEqual({ reads: 2, inventory: 1, writes: 0, deletes: 0 });
});

test('Contracts discards a late catalog retry after leaving and reopening the rules', async ({ page }) => {
  await bootRuleRecovery(page);
  const rules = page.locator('[data-recued-contracts-rules]');
  await page.evaluate(() => {
    window.__contractRuleRecovery.mode = 'hold';
    window.confirm = () => { window.__contractRuleRecovery.confirmations++; return true; };
  });
  await rules.locator('[data-recued-permissions-catalog-retry]').click();
  await expect.poll(() => page.evaluate(() => window.__contractRuleRecovery.pending)).toBe(1);
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(rules).toHaveCount(0);
  await page.evaluate(() => {
    window.__contractRuleRecovery.mode = 'ready';
    window.__contractRuleRecovery.replacementCatalog = true;
    window.__app.setHash('#contracts/view/others');
  });
  await rules.locator('summary').click();
  const ingredient = rules.locator('[data-recued-permissions-create-ingredient]');
  const approval = rules.locator('[data-recued-permissions-create-approval]');
  await expect(ingredient).toBeEnabled();
  await rules.locator('[data-recued-permissions-create-actor]').selectOption('user_self');
  await ingredient.selectOption('hubspot.contacts');
  await approval.focus();
  await approval.selectOption('ask');
  await page.evaluate(() => window.__contractRuleRecovery.release(0));
  await expect(ingredient.locator('option[value="hubspot.deals"]')).toHaveCount(0);
  await expect(ingredient).toHaveValue('hubspot.contacts');
  await expect(approval).toHaveValue('ask');
  await expect(approval).toBeFocused();
  await expect(rules.locator('[data-recued-permissions-catalog-recovery]')).toBeHidden();
  expect(await page.evaluate(() => ({
    confirmations: window.__contractRuleRecovery.confirmations,
    writes: window.__contractRuleRecovery.upserts.length,
    deletes: window.__contractRuleRecovery.deletes,
  }))).toEqual({ confirmations: 0, writes: 0, deletes: 0 });
});
