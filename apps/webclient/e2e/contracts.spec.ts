import { expect, test } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

/** Contracts browser journeys against the deterministic full-app harness. */
const CONTRACTS_DETAIL_HEADING = 'data-recued-contracts-detail-heading';
const CONTRACTS_DETAIL_TAB = 'data-recued-contracts-tab';
const CONTRACTS_DETAIL_TAB_BODY = 'data-recued-contracts-tab-body';
const CONTRACTS_LIST_TAB = 'data-recued-contracts-list-tab';

installFullAppHooks();

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
    'No agreements you look after on this page',
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
  await submit.click();

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

  await submit.click();
  await expect(submit).toHaveText('Creating…');
  await expect(submit).toBeFocused();
  await submit.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('collection.contract.mintContract'),
    ),
  ).toBe(2);
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
    + '[data-recued-permissions-panel]',
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
    `Recued could not load some of your agreements: Contract page unavailable for cursor `
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
    'Claude Desktop',
    'Cursor',
    'Codex',
    'Another AI app',
  ]);

  const form = page.locator('[data-recued-permissions-create]');
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

  const doorTargets = page.locator('[data-recued-contracts-door-toggle]');
  expect(await doorTargets.count()).toBe(3);
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
        + '.cg-cell-name, .cg-also-reads, .cg-source',
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
