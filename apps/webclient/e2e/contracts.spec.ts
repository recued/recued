import { expect, test, type Page } from '@playwright/test';
import { TIER1_TOOL_GUIDE, type CatalogIngredientView, type ContractDefinitionView, type ContractListRequest, type OverrideView, type PermissionWorkbenchView } from '@recued/contracts';
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
  await expect(heading).toHaveText('Self (you)');
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

const installPreviewInventory = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const contracts: ContractDefinitionView[] = Array.from({ length: 50 }, (_, index) => {
      const number = index + 1;
      return {
        contract_id: `door_preview_${number}`,
        display_name: `App contract ${number}`,
        minted_at: 1_790_000_000_000,
        minted_by: 'user',
        scope: {},
        grant_kind: 'standing',
        lifecycle_state: number === 43 ? 'expired' : 'active',
        door_types: number % 2 === 0 ? ['mcp'] : ['llm_gateway'],
        max_uses: 5,
        uses_remaining: 3,
        use_period: 'day',
        expiry_at: number === 43 ? 1_790_100_000_000 : 1_900_000_000_000,
      };
    });
    window.__connectionsFixture = async (method, args) => {
      if (method !== 'collection.contract.listContracts') return undefined;
      const request = args as ContractListRequest;
      if (request.contract_id) {
        const row = contracts.find((contract) => contract.contract_id === request.contract_id);
        return row ? { result: { contracts: [row] } } : undefined;
      }
      if (!request.exclude_derived_doors) return undefined;
      const offset = request.cursor === 'preview-page-two' ? 25 : 0;
      return { result: {
        contracts: contracts.slice(offset, offset + 25),
        total: contracts.length,
        next_cursor: offset === 0 ? 'preview-page-two' : null,
      } };
    };
  });
};

test('desktop Other contracts previews read-only summaries and restores the second page from detail', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installPreviewInventory(page);
  await page.goto(`${HARNESS_URL}?contracts=paged#contracts/view/others`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const preview = page.getByRole('region', { name: 'Contract preview', exact: true });
  const list = page.locator('[data-recued-contracts-list]');
  const row = list.getByRole('link', { name: /^App contract 42\b/ });
  const otherRow = list.getByRole('link', { name: /^App contract 43\b/ });
  const pageStatus = page.locator('[data-recued-contracts-page-status]');
  const otherContracts = /#contracts\/view\/others$/;
  await page.locator('[data-recued-contracts-page-next]').press('Enter');
  await expect(pageStatus).toHaveText('Showing 26–50 of 50');

  const detailReads = () => page.evaluate(() => ({
    keys: window.__app.rpcCallCount('chat.inbound_token.list'),
    grants: window.__app.rpcCallCount('contract.grant.read'),
  }));
  const reads = await detailReads();
  await otherRow.click();
  await expect(preview).toContainText('Expired');
  await expect(preview).toContainText('None enabled');
  await row.press('Space');
  await expect(preview.getByRole('heading', { name: 'App contract 42', exact: true })).toBeFocused();
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(preview).toContainText('MCP tools');
  await expect(preview).toContainText(/3 of 5 uses left.*expires/);
  await expect(page).toHaveURL(otherContracts);
  expect(await detailReads()).toEqual(reads);
  await page.keyboard.press('Escape');
  await expect(row).toBeFocused();
  await expect(preview.getByRole('link', { name: 'Open contract', exact: true })).toHaveCount(0);

  await row.scrollIntoViewIfNeeded();
  await row.press('Space');
  const open = preview.getByRole('link', { name: 'Open contract', exact: true });
  await open.focus();
  const top = await list.evaluate((node) => node.scrollTop);
  expect(top).toBeGreaterThan(0);
  await open.press('Enter');
  const heading = page.locator(`[${CONTRACTS_DETAIL_HEADING}="door_preview_42"]`);
  await expect(heading).toBeFocused();
  await page.getByRole('tab', { name: 'Ops', exact: true }).click();
  await expect(page).toHaveURL(/#contracts\/door_preview_42\/ops$/);
  const aiDoor = page.getByRole('checkbox', { name: 'The AI door', exact: true });
  await aiDoor.press('Space');
  await expect(aiDoor).toBeChecked();
  await expect(aiDoor).toBeEnabled();

  await page.goBack();
  await expect(page).toHaveURL(otherContracts);
  await expect(pageStatus).toHaveText('Showing 26–50 of 50');
  await expect(row).toBeFocused();
  await expect(preview).toContainText('MCP tools, The AI door');
  expect(await list.evaluate((node) => node.scrollTop)).toBe(top);

  await page.locator('[data-recued-contracts-page-previous]').press('Enter');
  await expect(pageStatus).toHaveText('Showing 1–25 of 50');
  await page.goForward();
  await expect(heading).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Ops', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.locator('[data-recued-contracts-back]').click();
  await expect(page).toHaveURL(otherContracts);
  await expect(pageStatus).toHaveText('Showing 26–50 of 50');
  await expect(row).toBeFocused();
  expect(await list.evaluate((node) => node.scrollTop)).toBe(top);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(preview).toBeHidden();
  await row.click();
  await expect(heading).toBeFocused();
  await expect(page).toHaveURL(/#contracts\/door_preview_42$/);
});

test('desktop Built-in contracts pins Self and restores page two from Self and a generated contract', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(() => {
    const contracts: ContractDefinitionView[] = Array.from({ length: 50 }, (_, index) => {
      const number = index + 1;
      const channel = number % 2 === 0 ? 'webhook' : 'reception';
      return {
        contract_id: `door_builtin_${number}`,
        display_name: channel === 'webhook' ? `Delivery ${number}` : `Public form ${number}`,
        minted_at: 1_790_000_000_000,
        minted_by: 'user',
        scope: { channels: [channel], actors: ['anonymous'] },
        grant_kind: 'standing',
        lifecycle_state: number === 43 ? 'revoked' : 'active',
        door_types: [channel],
      };
    });
    window.__connectionsFixture = async (method, args) => {
      if (method !== 'collection.contract.listContracts') return undefined;
      const request = args as ContractListRequest;
      if (request.contract_id) {
        return { result: { contracts: contracts.filter((row) => row.contract_id === request.contract_id) } };
      }
      if (!request.derived_doors_only) return undefined;
      const offset = request.cursor === 'built-in-page-two' ? 25 : 0;
      return { result: {
        contracts: contracts.slice(offset, offset + 25),
        total: contracts.length,
        next_cursor: offset === 0 ? 'built-in-page-two' : null,
      } };
    };
  });
  await page.goto(`${HARNESS_URL}?contracts=paged#contracts`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const preview = page.getByRole('region', { name: 'Contract preview', exact: true });
  const pinned = page.getByRole('list', { name: 'Your contract', exact: true });
  const self = pinned.getByRole('link', { name: /^Self \(you\)/ });
  const list = page.locator('[data-recued-contracts-list]');
  const form = list.getByRole('link', { name: /^Public form 43\b/ });
  const webhook = list.getByRole('link', { name: /^Delivery 42\b/ });
  const pageStatus = page.locator('[data-recued-contracts-page-status]');
  const open = preview.getByRole('link', { name: 'Open contract', exact: true });
  const back = page.locator('[data-recued-contracts-back]');
  const grantReads = () => page.evaluate(() => window.__app.rpcCallCount('contract.grant.read'));

  await expect(pageStatus).toHaveText('Showing 1–25 of 50 contracts you look after');
  const reads = await grantReads();
  await self.click();
  await expect(preview.getByRole('heading', { name: 'Self (you)', exact: true })).toBeFocused();
  await expect(preview).toContainText('Your Recued account');
  await page.locator('[data-recued-contracts-page-next]').press('Enter');
  await expect(pageStatus).toHaveText('Showing 26–50 of 50 contracts you look after');
  await expect(self).toHaveAttribute('aria-current', 'true');
  const selfTop = await self.evaluate((node) => node.getBoundingClientRect().top);

  await form.click();
  await expect(preview).toContainText('Revoked');
  await expect(preview.getByRole('link', { name: 'Reception endpoints' })).toHaveAttribute('href', '#reception/endpoints');
  await webhook.scrollIntoViewIfNeeded();
  await webhook.press('Space');
  await expect(preview.getByRole('heading', { name: 'Delivery 42', exact: true })).toBeFocused();
  await expect(preview).toContainText('Active');
  await expect(preview.getByRole('link', { name: 'Connections → Webhooks' })).toHaveAttribute('href', '#connections/webhooks');
  await expect(page).toHaveURL(/#contracts$/);
  expect(await grantReads()).toBe(reads);
  await expect(self).toBeInViewport();
  expect(await self.evaluate((node) => node.getBoundingClientRect().top)).toBe(selfTop);

  await open.focus();
  const top = await list.evaluate((node) => node.scrollTop);
  expect(top).toBeGreaterThan(0);
  await open.press('Enter');
  const webhookHeading = page.locator(`[${CONTRACTS_DETAIL_HEADING}="door_builtin_42"]`);
  await expect(webhookHeading).toBeFocused();
  await page.getByRole('tab', { name: 'Entities', exact: true }).click();
  await expect(page).toHaveURL(/#contracts\/door_builtin_42\/entities$/);
  await page.goBack();
  await expect(page).toHaveURL(/#contracts$/);
  await expect(pageStatus).toHaveText('Showing 26–50 of 50 contracts you look after');
  await expect(webhook).toBeFocused();
  await expect(webhook).toHaveAttribute('aria-current', 'true');
  expect(await list.evaluate((node) => node.scrollTop)).toBe(top);
  await page.goForward();
  await expect(webhookHeading).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Entities', exact: true })).toHaveAttribute('aria-selected', 'true');
  await back.press('Enter');
  await expect(webhook).toBeFocused();
  expect(await list.evaluate((node) => node.scrollTop)).toBe(top);

  await self.press('Space');
  await open.press('Enter');
  const selfHeading = page.locator(`[${CONTRACTS_DETAIL_HEADING}="user_self"]`);
  await expect(selfHeading).toBeFocused();
  await page.goBack();
  await expect(self).toBeFocused();
  expect(await list.evaluate((node) => node.scrollTop)).toBe(top);
  await page.goForward();
  await expect(selfHeading).toBeFocused();
  await page.goBack();
  await expect(self).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(preview).toBeHidden();
  const mobileSelf = list.getByRole('link', { name: /^Self \(you\)/ });
  await expect(mobileSelf).toBeFocused();
  await mobileSelf.click();
  await expect(selfHeading).toBeFocused();
  await expect(page).toHaveURL(/#contracts\/user_self$/);
});

test('desktop Customer contracts previews templates and restores the exact template on page two', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(() => {
    const templates: ContractDefinitionView[] = Array.from({ length: 50 }, (_, index) => ({
      contract_id: `ct_template_${index + 1}`,
      display_name: `Access template ${index + 1}`,
      minted_at: 1_790_000_000_000,
      minted_by: 'user',
      scope: {},
      grant_kind: 'customer_template',
      lifecycle_state: 'active',
    }));
    window.__connectionsFixture = async (method, args) => {
      if (method !== 'collection.contract.listContracts') return undefined;
      const request = args as ContractListRequest;
      if (request.contract_id) {
        return { result: { contracts: templates.filter((row) => row.contract_id === request.contract_id) } };
      }
      if (request.grant_kind !== 'customer_template') return undefined;
      const offset = request.cursor === 'template-page-two' ? 25 : 0;
      return { result: {
        contracts: templates.slice(offset, offset + 25),
        total: templates.length,
        next_cursor: offset === 0 ? 'template-page-two' : null,
      } };
    };
  });
  await page.goto(`${HARNESS_URL}?contracts=paged&settle_reads=1#contracts/view/customer`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const preview = page.getByRole('region', { name: 'Contract preview', exact: true });
  const list = page.locator('[data-recued-contracts-list]');
  const row = list.getByRole('link', { name: /^Access template 42\b/ });
  const pageStatus = page.locator('[data-recued-contracts-page-status]');
  const seller = page.getByRole('link', { name: /^Open Seller/ });
  const customerList = /#contracts\/view\/customer$/;
  await expect(seller).toHaveAttribute('href', '#settings/seller');
  await page.locator('[data-recued-contracts-page-next]').press('Enter');
  await expect(pageStatus).toHaveText('Showing 26–50 of 50');

  const grantReads = () => page.evaluate(() => window.__app.rpcCallCount('contract.grant.read'));
  const reads = await grantReads();
  await row.scrollIntoViewIfNeeded();
  await row.press('Space');
  await expect(preview.getByRole('heading', { name: 'Access template 42', exact: true })).toBeFocused();
  await expect(preview).toContainText('Active');
  await expect(preview).toContainText('copies this template’s Ops and Entities permissions');
  await expect(page).toHaveURL(customerList);
  expect(await grantReads()).toBe(reads);
  const open = preview.getByRole('link', { name: 'Open template', exact: true });
  await expect(open).toHaveAttribute('href', '#contracts/ct_template_42');
  await open.focus();
  const top = await list.evaluate((node) => node.scrollTop);
  expect(top).toBeGreaterThan(0);

  await open.press('Enter');
  const heading = page.locator(`[${CONTRACTS_DETAIL_HEADING}="ct_template_42"]`);
  const entities = page.getByRole('tab', { name: 'Entities', exact: true });
  const back = page.locator('[data-recued-contracts-back]');
  await expect(heading).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Ops', exact: true })).toHaveAttribute('aria-selected', 'true');
  await entities.click();
  await expect(page).toHaveURL(/#contracts\/ct_template_42\/entities$/);
  await page.goBack();
  await expect(page).toHaveURL(customerList);
  await expect(pageStatus).toHaveText('Showing 26–50 of 50');
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute('aria-current', 'true');
  expect(await list.evaluate((node) => node.scrollTop)).toBe(top);
  await page.goForward();
  await expect(heading).toBeFocused();
  await expect(entities).toHaveAttribute('aria-selected', 'true');
  await back.press('Enter');
  await expect(row).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(preview).toBeHidden();
  await row.click();
  await expect(heading).toBeFocused();
  await back.click();
  await expect(page).toHaveURL(customerList);
  await seller.click();
  await expect(page).toHaveURL(/#settings\/seller$/);
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

test('desktop contract creation preserves the roster, preview, and draft through retry', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 620 });
  await installPreviewInventory(page);
  await page.goto(
    `${HARNESS_URL}?contracts=paged`
      + '&contracts_mint_response=fail-once-slow-retry'
      + '&hold_rpc=collection.contract.mintContract'
      + '#contracts/view/others',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const opener = page.locator('[data-recued-contracts-new]');
  const list = page.locator('[data-recued-contracts-list]');
  const shell = page.locator('[data-recued-webclient-content]');
  const previous = page.locator('[data-recued-contracts-page-previous]');
  const pageStatus = page.locator('[data-recued-contracts-page-status]');
  await page.locator('[data-recued-contracts-page-next]').press('Enter');
  await expect(pageStatus).toHaveText('Showing 26–50 of 50');
  const row = list.getByRole('link', { name: /^App contract 42\b/ });
  await row.scrollIntoViewIfNeeded();
  await row.press('Space');
  const preview = page.locator('[data-recued-contracts-preview]');
  const title = preview.getByRole('heading', { name: 'App contract 42', exact: true });
  await expect(title).toBeFocused();
  const listTop = await list.evaluate(node => node.scrollTop);
  const pageTop = await shell.evaluate(node => {
    node.scrollTop = 28;
    return node.scrollTop;
  });
  expect(listTop).toBeGreaterThan(0);
  expect(pageTop).toBeGreaterThan(0);

  await opener.press('Enter');
  const editor = page.getByRole('group', { name: 'New contract', exact: true });
  const name = editor.getByRole('textbox', { name: 'Contract name' });
  const submit = editor.getByRole('button', { name: 'Create contract', exact: true });
  await expect(name).toBeFocused();
  await expect(preview).toBeHidden();
  await expect(row).toBeInViewport({ ratio: 1 });
  await expect(previous).toBeInViewport({ ratio: 1 });
  await expect(submit).toBeInViewport({ ratio: 1 });
  await opener.press('Enter');
  await expect(editor).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(title).toBeVisible();
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(pageStatus).toHaveText('Showing 26–50 of 50');
  expect(await list.evaluate(node => node.scrollTop)).toBe(listTop);
  expect(await shell.evaluate(node => node.scrollTop)).toBe(pageTop);

  await opener.press('Enter');
  await name.fill('Desktop retry contract');
  const cap = editor.getByRole('spinbutton', { name: 'Use limit, if you want one' });
  const refill = editor.getByRole('combobox', { name: 'Refill period' });
  const expiry = editor.getByLabel('Expiry (optional)');
  await cap.fill('24');
  await refill.selectOption('day');
  await expiry.fill('2030-04-12T12:30');
  await expiry.focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(expiry).toBeFocused();
  await expect(expiry).toBeInViewport({ ratio: 1 });
  await page.setViewportSize({ width: 1280, height: 620 });
  await expect(expiry).toBeInViewport({ ratio: 1 });

  const mintCount = () => page.evaluate(() => window.__app.rpcCallCount('collection.contract.mintContract'));
  const releaseMint = () => page.evaluate(() => window.__app.releaseRpcResponses?.('collection.contract.mintContract'));
  await submit.press('Enter');
  const creating = editor.getByRole('button', { name: 'Creating…', exact: true });
  await expect(creating).toBeFocused();
  await expect(previous).toHaveAttribute('aria-disabled', 'true');
  await previous.dispatchEvent('click');
  await creating.dispatchEvent('click');
  await expect.poll(mintCount).toBe(1);
  expect(await releaseMint()).toBe(1);
  await expect(editor.getByRole('alert')).toContainText('Check limits and retry.');
  await expect(submit).toBeFocused();
  await expect(submit).toBeInViewport({ ratio: 1 });
  await expect(previous).not.toHaveAttribute('aria-disabled');
  await expect(pageStatus).toHaveText('Showing 26–50 of 50');
  await expect(name).toHaveValue('Desktop retry contract');
  await expect(cap).toHaveValue('24');
  await expect(refill).toHaveValue('day');
  await expect(expiry).toHaveValue('2030-04-12T12:30');

  await submit.press('Enter');
  await expect.poll(mintCount).toBe(2);
  expect(await releaseMint()).toBe(1);
  await expect(page).toHaveURL(/#contracts\/door_paged_new\/connect$/);
  const heading = page.locator(`[${CONTRACTS_DETAIL_HEADING}="door_paged_new"]`);
  await expect(heading).toHaveText('Desktop retry contract');
  await expect(heading).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Connect', exact: true })).toHaveAttribute('aria-selected', 'true');
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
    "Codex plugin, on the server's computer",
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
  await expect(page.locator('[data-recued-contracts-rules-open]')).toBeHidden();
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

test('Contracts Ops jumps to grant sections and shows new matches from a deep scroll', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto(`${HARNESS_URL}?contracts=paged&hold_rpc=contract.grant.write#contracts/door_paged_01/ops`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const ops = page.locator('[data-recued-contract-grants][data-grant-view="ops"]');
  const jumps = ops.getByRole('navigation', { name: 'Jump to grant section' });
  const search = ops.getByRole('searchbox', { name: 'Find an operation' });
  const collections = jumps.getByRole('button', { name: 'Collections', exact: true });
  await expect(ops.locator('[data-recued-contract-grants-cell]').first()).toBeInViewport({ ratio: 1 });
  await expect(collections).toBeInViewport({ ratio: 1 });
  await jumps.getByRole('button', { name: 'AI tools', exact: true }).press('Enter');
  await expect(ops.getByRole('heading', { name: 'AI tools', exact: true })).toBeFocused();
  await collections.press('Enter');
  const heading = ops.getByRole('heading', { name: 'Collections', exact: true });
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport({ ratio: 1 });
  await expect(search).toBeInViewport({ ratio: 1 });
  await expect(page).toHaveURL(/#contracts\/door_paged_01\/ops$/);

  const toggle = ops.locator('[data-recued-contract-grants-kind][data-kind="collection"]')
    .getByRole('checkbox').first();
  const wasChecked = await toggle.isChecked();
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-busy', 'true');
  await expect(toggle).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('contract.grant.write'))).toBe(1);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('contract.grant.write'))).toBe(1);
  await expect(toggle).toBeChecked({ checked: !wasChecked });
  await expect(toggle).toBeFocused();

  await search.fill('core.ai');
  await expect(jumps.getByRole('button', { name: 'AI tools', exact: true })).toBeHidden();
  await expect(ops.locator('[data-recued-contract-grants-cell][data-entry="core.ai.classify"]'))
    .toBeInViewport({ ratio: 1 });
  await expect(search).toBeFocused();
  await expect(collections).toBeVisible();
  await jumps.getByRole('button', { name: 'Operations', exact: true }).press('Enter');
  await expect(ops.locator('[data-recued-contract-grants-kind][data-kind="op"]').getByRole('heading').first())
    .toBeFocused();

  await search.clear();
  await expect(jumps.getByRole('button', { name: 'AI tools', exact: true })).toBeVisible();
  await ops.evaluate((root) => {
    const input = root.querySelector<HTMLInputElement>('[data-recued-contract-grants-op-filter]')!;
    const operations = [...root.querySelectorAll<HTMLButtonElement>('nav button')]
      .find((button) => button.textContent === 'Operations')!;
    input.focus();
    input.value = 'core.contact.engagements.read';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // Jump before the filter's debounced repaint.
    operations.click();
  });
  const contacts = ops.getByRole('heading', { name: 'Contacts', exact: true });
  await expect(contacts).toBeFocused();
  await expect(contacts).toBeInViewport({ ratio: 1 });
});

test('desktop Permission tests returns to the filtered grant list and restores its scroll', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 620 });
  await page.addInitScript(() => {
    window.__connectionsFixture = async (method, raw) => {
      if (method !== 'contract.regression.get') return undefined;
      return { result: {
        contract_id: (raw as { contract_id: string }).contract_id,
        supported: true, revision: 0, live_digest: 'fixture-grants', grants: [],
        credentials: [], catalog: [], catalog_truncated: false, draft: null,
        drafts: [], history: [], qualification: null,
      } satisfies PermissionWorkbenchView };
    };
  });
  await page.goto(`${HARNESS_URL}?contracts=paged#contracts/door_paged_01/ops`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const launcher = page.getByRole('button', { name: 'Permission tests', exact: true });
  const editor = page.locator('[data-permission-workbench]');
  const search = page.getByRole('searchbox', { name: 'Find an operation' });
  const shell = page.locator('[data-recued-webclient-content]');
  const permissionReads = () => page.evaluate(() => window.__app.rpcCallCount('contract.regression.get'));

  await expect(launcher).toBeInViewport({ ratio: 1 });
  expect(await permissionReads()).toBe(0);
  await search.fill('core.ai');
  await expect(page.locator('[data-recued-contract-grants-cell][data-entry="core.ai.classify"]')).toBeVisible();
  await expect(page.locator('[data-recued-contract-grants-cell][data-entry="primitive.account.search"]')).toHaveCount(0);
  const before = await shell.evaluate((element) => {
    element.scrollTop = 280;
    return element.scrollTop;
  });
  expect(before).toBeGreaterThan(0);

  await launcher.press('Enter');
  await expect(editor.getByRole('heading', { name: 'Permission tests and reviewed grants' })).toBeFocused();
  await expect(search).toBeHidden();
  const title = editor.getByLabel('Test suite title');
  await expect(title).toBeInViewport({ ratio: 1 });
  await title.fill('Working contract test');
  await shell.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const back = page.getByRole('button', { name: 'Back to Ops', exact: true });
  await expect(back).toBeInViewport({ ratio: 1 });
  await back.press('Enter');

  await expect(launcher).toBeFocused();
  await expect(editor).toBeHidden();
  await expect(search).toHaveValue('core.ai');
  await expect(page.getByRole('tab', { name: 'Ops', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/#contracts\/door_paged_01\/ops$/);
  expect(await shell.evaluate((element) => element.scrollTop)).toBe(before);
  await launcher.press('Enter');
  await expect(title).toHaveValue('Working contract test');
  await title.focus();
  await page.setViewportSize({ width: 1279, height: 620 });
  await expect(page.locator('summary').filter({ hasText: /^Permission tests and reviewed grants$/ })).toBeVisible();
  await expect(title).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 620 });
  await expect(title).toHaveValue('Working contract test');
  await back.press('Enter');
  await expect(launcher).toBeFocused();
  expect(await permissionReads()).toBe(1);
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

const prepareRuleRecovery = async (page: Page): Promise<void> => {
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
    const inventoryFixture = window.__connectionsFixture;
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
        return inventoryFixture?.(method, raw);
      },
    });
  });
};

const bootRuleRecovery = async (page: Page): Promise<void> => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareRuleRecovery(page);
  const rules = page.locator('[data-recued-contracts-rules]');
  await rules.locator('summary').click();
  await expect(rules.locator('[data-recued-permissions-catalog-retry]')).toBeVisible();
};

test('desktop rules workspace preserves the draft, removal review, and exact inventory return', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 620 });
  await installPreviewInventory(page);
  await prepareRuleRecovery(page);
  const launcher = page.locator('[data-recued-contracts-rules-open]');
  const rules = page.locator('[data-recued-contracts-rules]');
  const list = page.locator('[data-recued-contracts-list]');
  const shell = page.locator('[data-recued-webclient-content]');
  const preview = page.getByRole('region', { name: 'Contract preview', exact: true });
  const row = list.getByRole('link', { name: /^App contract 42\b/ });
  const status = page.locator('[data-recued-contracts-page-status]');
  const readActivity = () => page.evaluate(() => ({
    inventory: window.__contractRuleRecovery.inventoryReads,
    upserts: window.__contractRuleRecovery.upserts.length,
    deletes: window.__contractRuleRecovery.deletes,
  }));

  await expect(launcher).toBeInViewport({ ratio: 1 });
  expect(await readActivity()).toEqual({ inventory: 0, upserts: 0, deletes: 0 });
  await page.locator('[data-recued-contracts-page-next]').press('Enter');
  await expect(status).toHaveText('Showing 26–50 of 50');
  await row.scrollIntoViewIfNeeded();
  await row.press('Space');
  const previewTitle = preview.getByRole('heading', { name: 'App contract 42', exact: true });
  await expect(previewTitle).toBeFocused();
  const rosterTop = await list.evaluate((node) => node.scrollTop);
  const pageTop = await shell.evaluate((node) => {
    node.scrollTop = 32;
    return node.scrollTop;
  });
  expect(rosterTop).toBeGreaterThan(0);
  expect(pageTop).toBeGreaterThan(0);

  await launcher.press('Enter');
  await expect(rules.getByRole('heading', { name: 'Rules for every contract' })).toBeFocused();
  await expect(list).toBeHidden();
  const actor = rules.locator('[data-recued-permissions-create-actor]');
  const approval = rules.locator('[data-recued-permissions-create-approval]');
  const ingredient = rules.locator('[data-recued-permissions-create-ingredient]');
  await expect(ingredient).toBeDisabled();
  await actor.selectOption('user_self');
  await approval.selectOption('always');
  await page.evaluate(() => { window.__contractRuleRecovery.mode = 'hold'; });
  await rules.locator('[data-recued-permissions-catalog-retry]').press('Enter');
  await expect.poll(() => page.evaluate(() => window.__contractRuleRecovery.pending)).toBe(1);

  const existing = rules.locator('[data-recued-permissions-row]');
  const deleteRule = existing.getByRole('button', { name: 'Delete', exact: true });
  await deleteRule.press('Enter');
  const confirm = existing.getByRole('button', { name: 'Confirm', exact: true });
  await confirm.focus();
  await page.evaluate(() => window.__contractRuleRecovery.release(0));
  await expect(ingredient).toBeEnabled();
  await expect(rules.locator('[data-recued-permissions-create-save]')).toBeInViewport({ ratio: 1 });
  await expect(confirm).toBeFocused();
  await expect(existing).toContainText('Remove this rule?');
  await existing.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
  await expect(deleteRule).toBeVisible();
  await expect(actor).toHaveValue('user_self');
  await expect(approval).toHaveValue('always');

  await rules.getByRole('button', { name: 'Back to inventory' }).press('Enter');
  await expect(launcher).toBeFocused();
  await expect(launcher).toHaveAttribute('aria-expanded', 'false');
  await expect(rules).toBeHidden();
  await expect(page).toHaveURL(/#contracts\/view\/others$/);
  await expect(page.getByRole('tab', { name: 'Others' })).toHaveAttribute('aria-selected', 'true');
  await expect(status).toHaveText('Showing 26–50 of 50');
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(previewTitle).toBeVisible();
  expect(await list.evaluate((node) => node.scrollTop)).toBe(rosterTop);
  expect(await shell.evaluate((node) => node.scrollTop)).toBe(pageTop);

  await launcher.press('Enter');
  await expect(approval).toHaveValue('always');
  await actor.focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rules.locator('summary')).toBeVisible();
  await expect(actor).toBeFocused();
  await expect(actor).toBeInViewport({ ratio: 1 });
  await page.setViewportSize({ width: 1280, height: 620 });
  await expect(actor).toBeInViewport({ ratio: 1 });
  await expect(actor).toHaveValue('user_self');
  expect(await readActivity()).toEqual({ inventory: 1, upserts: 0, deletes: 0 });
});

test('Contracts retries its rule catalog without losing the draft or writing permissions', async ({ page }) => {
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
