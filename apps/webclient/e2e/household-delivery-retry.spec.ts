import { expect, test, type Locator, type Page } from '@playwright/test';

const panel = (page: Page) => page.locator('[data-household-delivery]');
const retry = (page: Page) => page.getByRole('button', { name: 'Retry household delivery', exact: true });
const confirmationRetry = (page: Page) => page.getByRole('button', { name: 'Retry checking saved settings', exact: true });
const notice = (page: Page) => page.locator('[data-household-read-status]');
const outside = (page: Page) => page.getByRole('button', { name: 'Outside panel', exact: true });
const group = (page: Page) => panel(page).getByLabel('Household group', { exact: true });
const members = (page: Page) => panel(page).getByLabel('Other member user IDs', { exact: true });
const entity = (page: Page) => panel(page).getByLabel('To-do entity ID', { exact: true });
const save = (page: Page, kind: 'telegram' | 'home_assistant') => panel(page).getByRole('button', {
  name: kind === 'telegram' ? 'Save household Telegram' : 'Save household list', exact: true,
});
const press = async (target: Locator) => { await target.focus(); await target.press('Enter'); };
const reads = (page: Page) => page.evaluate(() => window.__householdDelivery.calls.filter(call => call.kind === 'read').length);
const writes = (page: Page) => page.evaluate(() => window.__householdDelivery.calls.filter(call => call.kind === 'save'));
const release = (page: Page, kind: 'read' | 'save', index = 0,
  outcome: 'success' | 'error' | 'applied_error' | 'unsupported' | 'without_home_assistant' | 'malformed_telegram' | 'malformed_home_assistant' = 'success') =>
  page.evaluate(({ kind, index, outcome }) => window.__householdDelivery.release(kind, index, outcome), { kind, index, outcome });
const guards = (page: Page) => page.evaluate(() => ({
  work: window.__householdDelivery.hasInFlightWork(), dirty: window.__householdDelivery.hasUnsavedChanges(),
}));
const open = async (page: Page, width: number, failed = true) => {
  await page.setViewportSize({ width, height: 900 }); await page.goto('/household-delivery-retry-harness.html');
  await page.waitForFunction(() => window.__householdDelivery?.calls.filter(call => call.kind === 'read').length === 1);
  await expect(panel(page)).toContainText('Loading household delivery…');
  if (failed) { await release(page, 'read', 0, 'error'); await expect(retry(page)).toBeVisible(); }
};
const failedConfirmation = async (page: Page, width: number, kind: 'telegram' | 'home_assistant', moveOutside = false) => {
  await open(page, width, false); await release(page, 'read');
  await members(page).fill('3003'); await entity(page).fill('todo.edited');
  const originalMembers = await members(page).elementHandle(), originalEntity = await entity(page).elementHandle();
  await press(save(page, kind)); if (moveOutside) await outside(page).focus();
  await release(page, 'save'); await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1, 'error');
  await expect(panel(page).locator('[data-household-status]')).toHaveAttribute('role', 'alert');
  return { originalMembers, originalEntity };
};
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

for (const width of [390, 1280]) {
  test(`Household an unchanged Home Assistant save still needs a complete recovery read at ${width}px`, async ({ page }) => {
    await open(page, width, false); await release(page, 'read'); await press(save(page, 'home_assistant'));
    await release(page, 'save', 0, 'error'); await expect(notice(page)).toHaveAttribute('role', 'alert');
    expect(await guards(page)).toEqual({ work: false, dirty: true });
    await page.evaluate(() => window.__householdDelivery.refresh()); await expect.poll(() => reads(page)).toBe(2);
    await release(page, 'read', 1, 'without_home_assistant'); await expect(retry(page)).toBeVisible();
    expect(await guards(page)).toEqual({ work: false, dirty: true });
    await press(retry(page)); await release(page, 'read', 2); await expect(entity(page)).toHaveValue('todo.household');
    expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toHaveLength(1); expect(await reads(page)).toBe(3);
  });

  for (const kind of ['telegram', 'home_assistant'] as const) {
    const initial = kind === 'telegram' ? '1002' : 'todo.household';
    const edited = kind === 'telegram' ? '3003' : 'todo.edited';
    const field = (page: Page) => kind === 'telegram' ? members(page) : entity(page);
    const choice = (page: Page) => kind === 'telegram' ? group(page) : panel(page).getByLabel('Home Assistant connection', { exact: true });

    test(`Household reverted ${kind} form refreshes confirmed settings at ${width}px`, async ({ page }) => {
      await open(page, width, false); await release(page, 'read'); const original = await field(page).elementHandle();
      await field(page).fill(edited); expect(await guards(page)).toEqual({ work: false, dirty: true });
      await field(page).fill(initial); expect(await guards(page)).toEqual({ work: false, dirty: false });
      await expect(field(page)).toBeFocused(); expect(await original!.evaluate(node => node.isConnected)).toBe(true);
      await outside(page).focus(); await page.evaluate(kind => { window.__householdDelivery.setNewerServer(kind); window.__householdDelivery.refresh(); }, kind);
      await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1);
      await expect(field(page)).toHaveValue(kind === 'telegram' ? '2002' : 'todo.server'); await expect(outside(page)).toBeFocused();
      expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toEqual([]);
    });

    test(`Household reverting ${kind} retains the other form until it is restored at ${width}px`, async ({ page }) => {
      await open(page, width, false); await release(page, 'read'); await members(page).fill('3003'); await entity(page).fill('todo.edited');
      await field(page).fill(initial); expect(await guards(page)).toEqual({ work: false, dirty: true });
      await page.evaluate(() => window.__householdDelivery.refresh()); expect(await reads(page)).toBe(1);
      const other = kind === 'telegram' ? entity(page) : members(page);
      await expect(other).toHaveValue(kind === 'telegram' ? 'todo.edited' : '3003');
      await other.fill(kind === 'telegram' ? 'todo.household' : '1002'); expect(await guards(page)).toEqual({ work: false, dirty: false });
      expect(await writes(page)).toEqual([]);
    });

    test(`Household ${kind} reverts use the newly confirmed save at ${width}px`, async ({ page }) => {
      await open(page, width, false); await release(page, 'read'); await field(page).fill(edited); await press(save(page, kind));
      await release(page, 'save'); await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1);
      expect(await guards(page)).toEqual({ work: false, dirty: false }); await field(page).fill(initial);
      expect(await guards(page)).toEqual({ work: false, dirty: true }); await field(page).fill(edited);
      expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toHaveLength(1); expect(await reads(page)).toBe(2);
    });

    for (const outcome of ['error', 'applied_error'] as const) {
      test(`Household reverted ${kind} stays guarded after ${outcome} until a fresh read at ${width}px`, async ({ page }) => {
        await open(page, width, false); await release(page, 'read'); await field(page).fill(edited); await press(save(page, kind));
        await release(page, 'save', 0, outcome); await expect(notice(page)).toHaveAttribute('role', 'alert');
        await field(page).fill(initial); expect(await guards(page)).toEqual({ work: false, dirty: true }); await outside(page).focus();
        await page.evaluate(() => window.__householdDelivery.refresh()); await expect.poll(() => reads(page)).toBe(2);
        await release(page, 'read', 1, 'error'); await expect(retry(page)).toBeVisible();
        expect(await guards(page)).toEqual({ work: false, dirty: true }); await expect(outside(page)).toBeFocused();
        await press(retry(page)); await release(page, 'read', 2); await expect(field(page)).toHaveValue(initial);
        expect(await guards(page)).toEqual({ work: false, dirty: outcome === 'applied_error' });
        if (outcome === 'applied_error') { await field(page).fill(edited); expect(await guards(page)).toEqual({ work: false, dirty: false }); }
        expect(await writes(page)).toHaveLength(1); expect(await reads(page)).toBe(3);
      });
    }

    test(`Household ${kind} retains an uncertain save after an unsupported recovery read at ${width}px`, async ({ page }) => {
      await open(page, width, false); await release(page, 'read'); await field(page).fill(edited); await press(save(page, kind));
      await release(page, 'save', 0, 'applied_error'); await expect(notice(page)).toHaveAttribute('role', 'alert');
      await field(page).fill(initial); await outside(page).focus(); await page.evaluate(() => window.__householdDelivery.refresh());
      await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1, 'unsupported');
      expect(await guards(page)).toEqual({ work: false, dirty: true }); await expect(panel(page)).toHaveCount(1);
      await expect(retry(page)).toBeVisible(); await expect(outside(page)).toBeFocused(); expect(await writes(page)).toHaveLength(1);
      await press(retry(page)); await release(page, 'read', 2); await expect(field(page)).toHaveValue(initial);
      expect(await guards(page)).toEqual({ work: false, dirty: true }); await field(page).fill(edited);
      expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toHaveLength(1); expect(await reads(page)).toBe(3);
    });

    test(`Household ${kind} reverts preserve the enrollment identity across another form save at ${width}px`, async ({ page }) => {
      await open(page, width, false); await release(page, 'read'); await members(page).fill('3003'); await entity(page).fill('todo.edited');
      const other = kind === 'telegram' ? 'home_assistant' : 'telegram'; await press(save(page, other));
      await page.evaluate(kind => { window.__householdDelivery.reenroll(kind); window.__householdDelivery.release('save'); }, kind);
      await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1); await expect(choice(page)).toHaveValue('missing');
      await field(page).fill(initial); expect(await guards(page)).toEqual({ work: false, dirty: true });
      await choice(page).selectOption('0'); expect(await guards(page)).toEqual({ work: false, dirty: false });
      await expect(field(page)).toHaveValue(initial); expect(await writes(page)).toHaveLength(1);
    });
  }

  for (const kind of ['telegram', 'home_assistant'] as const) {
    for (const outcome of ['without_home_assistant', 'malformed_telegram', 'malformed_home_assistant'] as const) {
      test(`Household keeps both drafts for ${kind} after ${outcome} confirmation at ${width}px`, async ({ page }) => {
        await open(page, width, false); await release(page, 'read');
        await members(page).fill('3003'); await entity(page).fill('todo.edited');
        const originalMembers = await members(page).elementHandle(), originalEntity = await entity(page).elementHandle();
        await press(save(page, kind)); await release(page, 'save');
        await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1, outcome);
        expect(await confirmationRetry(page).count()).toBe(1);
        await expect(notice(page)).toContainText('was saved'); await expect(notice(page)).toContainText('could not read the current household settings');
        await expect(confirmationRetry(page)).toBeFocused();
        await expect(members(page)).toHaveValue('3003'); await expect(entity(page)).toHaveValue('todo.edited');
        expect(await originalMembers!.evaluate(node => node.isConnected)).toBe(true);
        expect(await originalEntity!.evaluate(node => node.isConnected)).toBe(true);
        expect(await guards(page)).toEqual({ work: false, dirty: true });
        await press(confirmationRetry(page)); await release(page, 'read', 2);
        await expect(save(page, kind)).toBeFocused(); await expect(confirmationRetry(page)).toHaveCount(0);
        await expect(members(page)).toHaveValue('3003'); await expect(entity(page)).toHaveValue('todo.edited');
        expect(await guards(page)).toEqual({ work: false, dirty: true });
        expect(await writes(page)).toHaveLength(1); expect(await reads(page)).toBe(3);
        const other = kind === 'telegram' ? 'home_assistant' : 'telegram';
        await press(save(page, other)); await release(page, 'save', 1);
        await expect.poll(() => reads(page)).toBe(4); await release(page, 'read', 3);
        expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toHaveLength(2);
      });
    }

    test(`Household retries only the confirmation read for ${kind} at ${width}px`, async ({ page }) => {
      const { originalMembers, originalEntity } = await failedConfirmation(page, width, kind);
      expect(await confirmationRetry(page).count()).toBe(1);
      await expect(notice(page)).toContainText('was saved'); await expect(notice(page)).toContainText('could not check');
      await expect(confirmationRetry(page)).toBeFocused();
      await expect(confirmationRetry(page)).toBeInViewport();
      await expect(members(page)).toHaveValue('3003'); await expect(entity(page)).toHaveValue('todo.edited');
      for (const field of [members(page), entity(page), save(page, 'telegram'), save(page, 'home_assistant')]) await expect(field).toBeDisabled();
      expect(await guards(page)).toEqual({ work: false, dirty: true });
      if (kind === 'telegram') await page.screenshot({ path: test.info().outputPath('confirmation-read-error.png'), fullPage: true });
      const originalRetry = await confirmationRetry(page).elementHandle();
      await press(confirmationRetry(page));
      await expect(confirmationRetry(page)).toBeFocused(); await expect(confirmationRetry(page)).not.toHaveAttribute('disabled');
      await expect(confirmationRetry(page)).toHaveAttribute('aria-disabled', 'true');
      await expect(confirmationRetry(page)).toHaveAttribute('aria-busy', 'true');
      await expect(notice(page)).toContainText('Saved. Checking');
      expect(await guards(page)).toEqual({ work: true, dirty: true });
      await confirmationRetry(page).press('Space');
      await confirmationRetry(page).evaluate((node: HTMLButtonElement) => { node.click(); node.click(); });
      expect(await page.evaluate(() => window.__householdDelivery.refreshPair())).toBe(true);
      await page.evaluate(() => { for (const form of document.querySelectorAll('#panel form')) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
      expect(await reads(page)).toBe(3); expect(await writes(page)).toHaveLength(1);
      if (kind === 'telegram') await page.screenshot({ path: test.info().outputPath('confirmation-read-pending.png'), fullPage: true });
      await release(page, 'read', 2, 'error'); await expect(confirmationRetry(page)).toBeFocused();
      await expect(confirmationRetry(page)).toHaveAttribute('aria-disabled', 'false');
      await expect(confirmationRetry(page)).toHaveAttribute('aria-busy', 'false');
      expect(await originalRetry!.evaluate(node => node.isConnected && node === document.querySelector('[data-household-retry]'))).toBe(true);
      expect(await originalMembers!.evaluate(node => node.isConnected)).toBe(true);
      expect(await originalEntity!.evaluate(node => node.isConnected)).toBe(true);
      await page.evaluate(kind => window.__householdDelivery.setNewerServer(kind), kind);
      await confirmationRetry(page).press('Space'); await release(page, 'read', 3);
      await expect(confirmationRetry(page)).toHaveCount(0); await expect(save(page, kind)).toBeFocused();
      await expect(save(page, kind)).toBeInViewport();
      await expect(members(page)).toHaveValue(kind === 'telegram' ? '2002' : '3003');
      await expect(entity(page)).toHaveValue(kind === 'home_assistant' ? 'todo.server' : 'todo.edited');
      expect(await guards(page)).toEqual({ work: false, dirty: true });
      await originalRetry!.evaluate((node: HTMLButtonElement) => node.click());
      expect(await reads(page)).toBe(4); expect(await writes(page)).toHaveLength(1);
      if (kind === 'telegram') await page.screenshot({ path: test.info().outputPath('confirmation-read-recovered.png'), fullPage: true });
      const other = kind === 'telegram' ? 'home_assistant' : 'telegram';
      await press(save(page, other)); await release(page, 'save', 1); await expect.poll(() => reads(page)).toBe(5); await release(page, 'read', 4);
      expect(await guards(page)).toEqual({ work: false, dirty: false });
      expect((await writes(page)).map(call => call.input!.action)).toEqual([`household.${kind}`, `household.${other}`]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });

    for (const outcome of ['success', 'error'] as const) {
      test(`Household ${kind} confirmation retry ${outcome} preserves outside focus at ${width}px`, async ({ page }) => {
        await failedConfirmation(page, width, kind, true); await expect(outside(page)).toBeFocused();
        await press(confirmationRetry(page)); await outside(page).focus(); await release(page, 'read', 2, outcome);
        await expect(outside(page)).toBeFocused();
        if (outcome === 'success') { await expect(confirmationRetry(page)).toHaveCount(0); await expect(save(page, kind)).toBeEnabled(); }
        else { await expect(confirmationRetry(page)).toHaveAttribute('aria-disabled', 'false'); await expect(save(page, kind)).toBeDisabled(); }
        expect(await reads(page)).toBe(3); expect(await writes(page)).toHaveLength(1);
        expect(await guards(page)).toEqual({ work: false, dirty: true });
      });

      test(`Household ignores a disposed ${kind} confirmation ${outcome} after remount at ${width}px`, async ({ page }) => {
        await failedConfirmation(page, width, kind); const old = await confirmationRetry(page).elementHandle();
        await press(confirmationRetry(page)); await outside(page).focus(); await page.evaluate(() => window.__householdDelivery.remount());
        await expect.poll(() => reads(page)).toBe(4); await release(page, 'read', 3);
        await members(page).fill('4004'); const fresh = await members(page).elementHandle(); await outside(page).focus();
        await old!.evaluate((node: HTMLButtonElement) => node.click()); await release(page, 'read', 2, outcome);
        await expect(members(page)).toHaveValue('4004'); await expect(entity(page)).toHaveValue(kind === 'home_assistant' ? 'todo.edited' : 'todo.household');
        await expect(outside(page)).toBeFocused(); await expect(panel(page)).toHaveCount(1);
        expect(await fresh!.evaluate(node => node.isConnected && node === document.querySelector('[name="members"]'))).toBe(true);
        expect(await reads(page)).toBe(4); expect(await writes(page)).toHaveLength(1);
        expect(await guards(page)).toEqual({ work: false, dirty: true });
      });
    }

    test(`Household retains an accepted ${kind} save if confirmation becomes unsupported at ${width}px`, async ({ page }) => {
      await failedConfirmation(page, width, kind); await press(confirmationRetry(page)); await release(page, 'read', 2, 'unsupported');
      await expect(panel(page)).toHaveCount(1); await expect(notice(page)).toContainText('was saved');
      await expect(confirmationRetry(page)).toBeFocused(); await expect(confirmationRetry(page)).toHaveAttribute('aria-disabled', 'false');
      await expect(members(page)).toHaveValue('3003'); await expect(entity(page)).toHaveValue('todo.edited');
      await press(confirmationRetry(page)); await release(page, 'read', 3); await expect(save(page, kind)).toBeFocused();
      expect(await guards(page)).toEqual({ work: false, dirty: true }); expect(await writes(page)).toHaveLength(1);
    });

    test(`Household ${kind} write rejection keeps drafts and outside focus at ${width}px`, async ({ page }) => {
      await open(page, width, false); await release(page, 'read');
      await members(page).fill('3003'); await entity(page).fill('todo.edited');
      await press(save(page, kind)); await outside(page).focus(); await release(page, 'save', 0, 'error');
      await expect(notice(page)).toHaveAttribute('role', 'alert'); await expect(outside(page)).toBeFocused();
      await expect(members(page)).toHaveValue('3003'); await expect(entity(page)).toHaveValue('todo.edited');
      await expect(save(page, kind)).toBeEnabled(); await expect(confirmationRetry(page)).toHaveCount(0);
      expect(await guards(page)).toEqual({ work: false, dirty: true }); expect(await reads(page)).toBe(1); expect(await writes(page)).toHaveLength(1);
    });

    test(`Household ${kind} confirmation recovers focus to the field that submitted with Enter at ${width}px`, async ({ page }) => {
      await open(page, width, false); await release(page, 'read');
      const input = kind === 'telegram' ? members(page) : entity(page);
      await input.fill(kind === 'telegram' ? '3003' : 'todo.edited'); await input.press('Enter');
      await release(page, 'save'); await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1, 'error');
      await expect(confirmationRetry(page)).toBeFocused(); await press(confirmationRetry(page)); await release(page, 'read', 2);
      await expect(input).toBeFocused(); await expect(input).toBeInViewport();
      expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toHaveLength(1);
    });
  }

  test(`Household Retry keeps its focused control through failures and recovery at ${width}px`, async ({ page }) => {
    await open(page, width); const original = await retry(page).elementHandle();
    await press(retry(page)); await expect(retry(page)).toBeFocused();
    await expect(notice(page)).toHaveText('Retrying household delivery…');
    await expect(notice(page)).toHaveAttribute('role', 'status');
    await expect(notice(page)).toHaveAttribute('aria-atomic', 'true');
    await expect(retry(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(retry(page)).toHaveAttribute('aria-busy', 'true');
    await expect(retry(page)).not.toHaveAttribute('disabled');
    await retry(page).press('Enter'); await retry(page).press('Space');
    await retry(page).evaluate((node: HTMLButtonElement) => { node.click(); node.click(); });
    expect(await page.evaluate(() => window.__householdDelivery.refreshPair())).toBe(true);
    expect(await reads(page)).toBe(2); expect(await writes(page)).toEqual([]);
    expect(await guards(page)).toEqual({ work: false, dirty: false });
    await page.screenshot({ path: test.info().outputPath('household-retry-pending.png'), fullPage: true });
    await release(page, 'read', 1, 'error');
    await expect(retry(page)).toBeFocused(); await expect(notice(page)).toHaveAttribute('role', 'alert');
    await expect(retry(page)).toHaveAttribute('aria-disabled', 'false');
    await expect(retry(page)).toHaveAttribute('aria-busy', 'false');
    expect(await original!.evaluate(node => node.isConnected && node === document.querySelector('[data-household-retry]'))).toBe(true);
    await page.screenshot({ path: test.info().outputPath('household-retry-error.png'), fullPage: true });
    await retry(page).press('Space'); await release(page, 'read', 2);
    await expect(group(page)).toBeFocused(); await expect(group(page)).toHaveValue('0');
    await expect(members(page)).toHaveValue('1002'); await expect(entity(page)).toHaveValue('todo.household');
    await expect(retry(page)).toHaveCount(0); await original!.evaluate((node: HTMLButtonElement) => node.click());
    expect(await reads(page)).toBe(3); expect(await writes(page)).toEqual([]);
    expect(await guards(page)).toEqual({ work: false, dirty: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('household-retry-recovered.png'), fullPage: true });
  });

  for (const outcome of ['success', 'error'] as const) {
    test(`Household Retry ${outcome} preserves outside focus at ${width}px`, async ({ page }) => {
      await open(page, width); await press(retry(page)); await outside(page).focus();
      await release(page, 'read', 1, outcome); await expect(outside(page)).toBeFocused();
      if (outcome === 'success') await expect(group(page)).toBeVisible();
      else await expect(retry(page)).toHaveAttribute('aria-disabled', 'false');
      expect(await reads(page)).toBe(2); expect(await writes(page)).toEqual([]);
    });

    test(`Household ignores a disposed retry ${outcome} after remount at ${width}px`, async ({ page }) => {
      await open(page, width); const old = await retry(page).elementHandle(); await press(retry(page));
      await outside(page).focus(); await page.evaluate(() => window.__householdDelivery.remount());
      await expect.poll(() => reads(page)).toBe(3); await release(page, 'read', 2);
      const original = await members(page).elementHandle(); await members(page).fill('3003');
      await outside(page).focus(); await old!.evaluate((node: HTMLButtonElement) => node.click());
      await release(page, 'read', 1, outcome); await expect(outside(page)).toBeFocused();
      await expect(members(page)).toHaveValue('3003'); await expect(panel(page)).toHaveCount(1);
      expect(await original!.evaluate(node => node.isConnected && node === document.querySelector('[name="members"]'))).toBe(true);
      expect(await reads(page)).toBe(3); expect(await writes(page)).toEqual([]);
      expect(await guards(page)).toEqual({ work: false, dirty: true });
    });
  }

  test(`Household coalesces concurrent reads and adopts a later explicit refresh at ${width}px`, async ({ page }) => {
    await open(page, width, false); await outside(page).focus();
    expect(await page.evaluate(() => { window.__householdDelivery.setNewerServer(); return window.__householdDelivery.refreshPair(); })).toBe(true);
    expect(await reads(page)).toBe(1); await release(page, 'read');
    await expect(members(page)).toHaveValue('1002'); await expect(outside(page)).toBeFocused();
    expect(await page.evaluate(() => window.__householdDelivery.refreshPair())).toBe(true);
    await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1);
    await expect(members(page)).toHaveValue('2002'); await expect(outside(page)).toBeFocused();
    expect(await writes(page)).toEqual([]); expect(await guards(page)).toEqual({ work: false, dirty: false });
  });

  for (const kind of ['telegram', 'home_assistant'] as const) {
    test(`Household preserves both drafts and pending ${kind} write guards through refresh attempts at ${width}px`, async ({ page }) => {
      await open(page, width, false); await release(page, 'read');
      await members(page).fill('3003, 3003'); await entity(page).fill('todo.edited');
      await members(page).focus(); await members(page).evaluate((node: HTMLInputElement) => node.setSelectionRange(1, 4));
      const original = await members(page).elementHandle(); await page.evaluate(() => window.__householdDelivery.refresh());
      expect(await reads(page)).toBe(1); await expect(members(page)).toBeFocused();
      expect(await original!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      expect(await members(page).evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd])).toEqual([1, 4]);
      expect(await guards(page)).toEqual({ work: false, dirty: true });
      await press(save(page, kind));
      const attempt = () => page.evaluate(() => {
        for (const form of document.querySelectorAll('#panel form')) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        window.__householdDelivery.refresh();
      });
      await attempt(); expect(await writes(page)).toHaveLength(1); expect(await reads(page)).toBe(1);
      expect(await guards(page)).toEqual({ work: true, dirty: true });
      await expect(members(page)).toBeDisabled(); await expect(entity(page)).toBeDisabled();
      await release(page, 'save'); await expect.poll(() => reads(page)).toBe(2); await attempt();
      expect(await writes(page)).toHaveLength(1); expect(await reads(page)).toBe(2);
      expect(await guards(page)).toEqual({ work: true, dirty: true });
      await release(page, 'read', 1); await expect(save(page, kind)).toBeFocused();
      await expect(entity(page)).toHaveValue('todo.edited');
      await expect(members(page)).toHaveValue(kind === 'telegram' ? '3003' : '3003, 3003');
      expect(await guards(page)).toEqual({ work: false, dirty: true });
      const other = kind === 'telegram' ? 'home_assistant' : 'telegram';
      await press(save(page, other)); await release(page, 'save', 1);
      await expect.poll(() => reads(page)).toBe(3); await release(page, 'read', 2);
      expect(await guards(page)).toEqual({ work: false, dirty: false });
      const changes = await writes(page); expect(changes.map(change => change.input!.action)).toEqual([`household.${kind}`, `household.${other}`]);
      expect(changes.find(change => change.input!.action === 'household.telegram')!.input).toEqual({
        action: 'household.telegram', connection_name: 'Household group', connection_enrolled_at: 100, members: ['1001', '3003'],
      });
      expect(changes.find(change => change.input!.action === 'household.home_assistant')!.input).toEqual({
        action: 'household.home_assistant', connection_name: 'Household server', connection_enrolled_at: 300, entity_id: 'todo.edited',
      });
    });
  }

  test(`Household detached Retry cannot re-read or replay a write after recovery at ${width}px`, async ({ page }) => {
    await open(page, width); const old = await retry(page).elementHandle(); await press(retry(page)); await release(page, 'read', 1);
    await members(page).fill('3003'); await press(save(page, 'telegram'));
    await old!.evaluate((node: HTMLButtonElement) => node.click()); await page.evaluate(() => window.__householdDelivery.refresh());
    expect(await reads(page)).toBe(2); expect(await writes(page)).toHaveLength(1);
    expect(await guards(page)).toEqual({ work: true, dirty: true });
    await release(page, 'save', 0, 'error'); await expect(panel(page).locator('[data-household-status]')).toHaveAttribute('role', 'alert');
    await expect(members(page)).toHaveValue('3003'); await expect(save(page, 'telegram')).toBeFocused();
    await old!.evaluate((node: HTMLButtonElement) => node.click());
    expect(await reads(page)).toBe(2); expect(await writes(page)).toHaveLength(1);
    expect(await guards(page)).toEqual({ work: false, dirty: true }); await expect(retry(page)).toHaveCount(0);
  });

  test(`Household ignores detached and disposed forms after a read refresh at ${width}px`, async ({ page }) => {
    await open(page, width, false); await release(page, 'read');
    const oldForms = await panel(page).locator('form').elementHandles();
    const submit = async () => {
      for (const form of oldForms) await form.evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    };
    await page.evaluate(() => window.__householdDelivery.refresh()); await expect.poll(() => reads(page)).toBe(2);
    await submit(); expect(await writes(page)).toEqual([]);
    await release(page, 'read', 1); await expect(group(page)).toBeVisible();
    await submit(); expect(await writes(page)).toEqual([]);
    const currentForms = await panel(page).locator('form').elementHandles();
    await outside(page).focus(); await page.evaluate(() => window.__householdDelivery.dispose());
    for (const form of currentForms) await form.evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(await writes(page)).toEqual([]); expect(await reads(page)).toBe(2);
    await expect(panel(page)).toHaveCount(0); await expect(outside(page)).toBeFocused();
  });

  test(`Household ignores late draft events from replaced forms at ${width}px`, async ({ page }) => {
    await open(page, width, false); await release(page, 'read');
    const oldInputs = [await members(page).elementHandle(), await entity(page).elementHandle()];
    const lateEdits = async (inputs: typeof oldInputs) => {
      for (const input of inputs) await input!.evaluate((node: HTMLInputElement) => {
        node.value = node.name === 'members' ? '9999' : 'todo.stale';
        for (const type of ['input', 'change']) node.dispatchEvent(new Event(type, { bubbles: true }));
      });
    };
    await page.evaluate(() => { window.__householdDelivery.setNewerServer(); window.__householdDelivery.refresh(); });
    await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1);
    await expect(members(page)).toHaveValue('2002'); await outside(page).focus();
    await lateEdits(oldInputs);
    expect(await guards(page)).toEqual({ work: false, dirty: false });
    await expect(members(page)).toHaveValue('2002'); await expect(entity(page)).toHaveValue('todo.household');
    await expect(outside(page)).toBeFocused();
    await members(page).fill('3003'); await press(save(page, 'telegram')); await release(page, 'save');
    await expect.poll(() => reads(page)).toBe(3); await release(page, 'read', 2);
    await expect(entity(page)).toHaveValue('todo.household');
    expect(await guards(page)).toEqual({ work: false, dirty: false });
    const replacedInputs = [await members(page).elementHandle(), await entity(page).elementHandle()];
    await page.evaluate(() => window.__householdDelivery.refresh()); await expect.poll(() => reads(page)).toBe(4);
    await lateEdits(replacedInputs); await release(page, 'read', 3);
    await expect(members(page)).toHaveValue('3003'); await expect(entity(page)).toHaveValue('todo.household');
    const disposedInputs = [await members(page).elementHandle(), await entity(page).elementHandle()];
    await outside(page).focus(); await page.evaluate(() => window.__householdDelivery.dispose()); await lateEdits(disposedInputs);
    expect(await guards(page)).toEqual({ work: false, dirty: false });
    await expect(outside(page)).toBeFocused(); await expect(panel(page)).toHaveCount(0);
    expect(await reads(page)).toBe(4); expect(await writes(page)).toEqual([{ kind: 'save', input: {
      action: 'household.telegram', connection_name: 'Household group', connection_enrolled_at: 100, members: ['1001', '3003'],
    } }]);
  });

  test(`Household omits an unsupported panel and ignores later refresh at ${width}px`, async ({ page }) => {
    await open(page, width, false); await outside(page).focus(); await release(page, 'read', 0, 'unsupported');
    await expect(panel(page)).toHaveCount(0); await page.evaluate(() => window.__householdDelivery.refresh());
    await expect(outside(page)).toBeFocused(); expect(await reads(page)).toBe(1); expect(await writes(page)).toEqual([]);
  });
}
