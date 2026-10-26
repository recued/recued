import { expect, test, type Locator, type Page } from '@playwright/test';

const panel = (page: Page) => page.locator('[data-household-delivery]');
const retry = (page: Page) => page.getByRole('button', { name: 'Retry household delivery', exact: true });
const confirmationRetry = (page: Page) => page.getByRole('button', { name: 'Retry checking saved settings', exact: true });
const notice = (page: Page) => page.locator('[data-household-read-status]');
const outside = (page: Page) => page.getByRole('button', { name: 'Outside panel', exact: true });
const group = (page: Page) => panel(page).getByLabel('Household group', { exact: true });
const entity = (page: Page) => panel(page).getByLabel('To-do list ID', { exact: true });
const save = (page: Page, kind: 'telegram' | 'home_assistant') => panel(page).getByRole('button', {
  name: kind === 'telegram' ? 'Save household Telegram' : 'Save to-do list', exact: true,
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
// The Telegram block's one draft (D-325 §15.7, 2026-10-24: the group only reads, so
// there are no members to type): Off chosen in place of the saved group.
const draftOff = async (page: Page) => { await group(page).focus(); await group(page).selectOption(''); };
const failedConfirmation = async (page: Page, width: number, kind: 'telegram' | 'home_assistant', moveOutside = false) => {
  await open(page, width, false); await release(page, 'read');
  await draftOff(page); await entity(page).fill('todo.edited');
  const originalGroup = await group(page).elementHandle(), originalEntity = await entity(page).elementHandle();
  await press(save(page, kind)); if (moveOutside) await outside(page).focus();
  await release(page, 'save'); await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1, 'error');
  await expect(panel(page).locator('[data-household-status]')).toHaveAttribute('role', 'alert');
  return { originalGroup, originalEntity };
};
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

test('Household says the group only reads, and saves the group chosen with nobody to answer there', async ({ page }) => {
  await open(page, 1280, false); await release(page, 'read');
  const telegram = panel(page).locator('[data-household-telegram]');
  await expect(telegram.locator('.hd-hint').first()).toHaveText('They are posted as messages in the group you choose, for everyone there to read. '
    + 'Nobody answers them there: you mark them done in Recued.');
  // D-325 §15.7 (2026-10-24) — nobody is added, invited or asked to join.
  await expect(telegram.getByRole('button')).toHaveText(['Save household Telegram']); await expect(telegram.locator('input')).toHaveCount(0);
  await page.evaluate(() => { window.__householdDelivery.addGroup(); window.__householdDelivery.refresh(); });
  await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1);
  await group(page).selectOption('1'); expect(await guards(page)).toEqual({ work: false, dirty: true });
  await press(save(page, 'telegram')); await release(page, 'save');
  await expect.poll(() => reads(page)).toBe(3); await release(page, 'read', 2);
  await expect(notice(page)).toHaveText('Household Telegram saved.'); await expect(group(page)).toHaveValue('1');
  expect((await writes(page)).map(call => call.input)).toEqual([{ action: 'household.telegram', connection_name: 'Cousins', connection_enrolled_at: 150 }]);
  expect(await guards(page)).toEqual({ work: false, dirty: false });
});

test('Household hides the list ID while Home Assistant is Off, and a choice put back is no draft', async ({ page }) => {
  await open(page, 1280, false); await release(page, 'read');
  await expect(entity(page)).toBeVisible(); await group(page).selectOption('');
  const ha = panel(page).getByLabel('Home Assistant connection', { exact: true });
  await ha.selectOption(''); await expect(entity(page)).toBeHidden();
  expect(await guards(page)).toEqual({ work: false, dirty: true });
  await group(page).selectOption('0'); await ha.selectOption('0'); await expect(entity(page)).toHaveValue('todo.household');
  expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toEqual([]);
});

test('Household re-reads quietly on return, leaving a draft alone, and once more for a return mid-read', async ({ page }) => {
  await open(page, 1280, false); await release(page, 'read');
  await draftOff(page); await page.evaluate(() => window.__householdDelivery.refreshQuietly());
  expect(await reads(page)).toBe(1); await expect(group(page)).toHaveValue('');
  await group(page).selectOption('0'); await group(page).focus();
  const card = await panel(page).locator('[data-household-telegram]').elementHandle();
  await page.evaluate(() => {
    window.__householdDelivery.refreshQuietly(); window.__householdDelivery.setNewerServer(); window.__householdDelivery.refreshQuietly();
  });
  await expect.poll(() => reads(page)).toBe(2);
  // While the read is out, the card stays as it is: no "Loading" swap to lose focus in.
  expect(await card!.evaluate(node => node.isConnected)).toBe(true); await expect(panel(page)).not.toContainText('Loading household delivery…');
  await release(page, 'read', 1);
  await expect.poll(() => reads(page)).toBe(3); await release(page, 'read', 2);
  await expect(group(page)).toHaveValue('1'); await expect(group(page)).toBeFocused();
  expect(await writes(page)).toEqual([]); expect(await guards(page)).toEqual({ work: false, dirty: false });
});

test('Household drops a quiet read that a save overtook', async ({ page }) => {
  await open(page, 1280, false); await release(page, 'read');
  await page.evaluate(() => window.__householdDelivery.refreshQuietly()); await expect.poll(() => reads(page)).toBe(2);
  await draftOff(page); await press(save(page, 'telegram')); await release(page, 'save');
  await expect.poll(() => reads(page)).toBe(3); await release(page, 'read', 2); await expect(group(page)).toHaveValue('');
  // The quiet read went out before the save, so its older reply changes nothing.
  await release(page, 'read', 1);
  await expect(group(page)).toHaveValue(''); expect(await guards(page)).toEqual({ work: false, dirty: false });
});

test('Household names each group as Connections does, telling two of one name apart', async ({ page }) => {
  await open(page, 1280, false); await release(page, 'read');
  const choices = group(page).locator('option');
  await expect(choices).toHaveText(['Off', 'Family chat']);
  await page.evaluate(() => { window.__householdDelivery.addGroup('Family chat'); window.__householdDelivery.refresh(); });
  await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1);
  await expect(choices).toHaveText(['Off', 'Family chat · -10001', 'Family chat · -10002']);
});

test('Household names the assets it covers, each linked, and says how to share one when none is', async ({ page }) => {
  const shared = panel(page).locator('[data-household-shared]');
  const reread = async (state: unknown, at: number) => {
    await page.evaluate(value => { window.__householdDelivery.share(value ?? undefined); window.__householdDelivery.refresh(); }, state);
    await expect.poll(() => reads(page)).toBe(at + 1); await release(page, 'read', at);
  };
  await open(page, 390, false); await release(page, 'read');
  await expect(panel(page).locator('h3')).toHaveText('Reminders for shared assets');
  // Home Assistant says what reaches it, and that it is a list, not a message.
  await expect(panel(page).locator('[data-household-home-assistant] h4')).toHaveText('Show their tasks on a Home Assistant to-do list');
  await expect(panel(page).locator('[data-household-home-assistant] .hd-hint').first()).toHaveText('Open tasks for shared assets, like “Service boiler”, '
    + 'show on the to-do list you choose, for your household to see. It sends no messages, and ticking a task off there doesn’t change it in Recued: '
    + 'you mark it done in Recued.');
  await expect(shared).toHaveText('Shared now: Boiler and Car. To change one, edit it in your assets.');
  await expect(shared.getByRole('link')).toHaveText(['Boiler', 'Car', 'your assets']);
  expect(await shared.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href'))))
    .toEqual(['#yours/asset/boiler', '#yours/asset/car', '#yours/assets']);
  // Settings names the first few the server sends and counts the rest.
  await reread({ assets: ['A', 'B', 'C', 'D', 'E', 'F'].map(name => ({ id: name.toLowerCase(), name })), total: 9 }, 1);
  await expect(shared).toHaveText('Shared now: A, B, C, D, E, F and 3 more. To change one, edit it in your assets.');
  const howTo = 'edit it in your assets and set Who sees its reminders to Me and my household.';
  await reread({ assets: [], total: 0 }, 2);
  await expect(shared).toHaveText(`No asset is shared yet. To share one, ${howTo}`);
  // A server before the list, and a malformed one, both leave the card working and say how.
  await reread(null, 3);
  await expect(shared).toHaveText(`To share an asset, ${howTo}`);
  await reread({ assets: 'Boiler', total: 1 }, 4);
  await expect(shared).toHaveText(`To share an asset, ${howTo}`); await expect(group(page)).toHaveValue('0');
  // A count with no names would read "Shared now: and 3 more".
  await reread({ assets: [], total: 3 }, 5);
  await expect(shared).toHaveText(`To share an asset, ${howTo}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Household offers Home Assistant’s to-do lists by name, and saves the one picked', async ({ page }) => {
  await open(page, 390, false);
  await page.evaluate(() => window.__householdDelivery.lists([
    { entity_id: 'todo.garden', name: 'Garden', usable: true },
    { entity_id: 'todo.household', name: 'Household', usable: true },
    { entity_id: 'todo.shopping_list', name: 'Shopping List', usable: false, reason: 'can’t keep the note Recued adds to each item' },
  ]));
  await release(page, 'read');
  const menu = panel(page).getByLabel('To-do list', { exact: true });
  await expect(menu.locator('option')).toHaveText(['Choose a list', 'Garden', 'Household',
    'Shopping List (can’t keep the note Recued adds to each item)']);
  // The saved list is chosen, one Recued cannot use cannot be picked, and typing is tucked away.
  await expect(menu).toHaveValue('todo.household'); await expect(menu.locator('option[value="todo.shopping_list"]')).toHaveJSProperty('disabled', true);
  await expect(entity(page)).toBeHidden();
  expect(await page.evaluate(() => window.__householdDelivery.listCalls)).toEqual([{ connection_name: 'Household server', connection_enrolled_at: 300 }]);
  await menu.selectOption('todo.garden'); await press(save(page, 'home_assistant')); await release(page, 'save');
  expect((await writes(page)).at(-1)?.input).toEqual({ action: 'household.home_assistant', connection_name: 'Household server',
    connection_enrolled_at: 300, entity_id: 'todo.garden' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Household keeps the typed list ID in view when Home Assistant’s lists cannot be read', async ({ page }) => {
  await open(page, 1280, false); await page.evaluate(() => window.__householdDelivery.lists('error')); await release(page, 'read');
  await expect(panel(page).locator('[data-household-list-status]'))
    .toHaveText('Recued couldn’t read its to-do lists: Home Assistant is unreachable. Type the list’s ID below.');
  await expect(panel(page).getByLabel('To-do list', { exact: true })).toBeHidden(); await expect(entity(page)).toHaveValue('todo.household');
  // A server without the menu says nothing, and the typed field is simply there.
  await page.evaluate(() => window.__householdDelivery.lists('unsupported')); await page.evaluate(() => window.__householdDelivery.refresh());
  await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1);
  await expect(panel(page).locator('[data-household-list-status]')).toBeHidden(); await expect(entity(page)).toBeVisible();
});

test('Household says where to connect a destination when none is connected', async ({ page }) => {
  await open(page, 390, false); await page.evaluate(() => window.__householdDelivery.disconnect()); await release(page, 'read');
  await page.evaluate(() => window.__householdDelivery.refresh()); await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1);
  await expect(group(page)).toHaveValue(''); await expect(entity(page)).toBeHidden();
  for (const text of ['No Telegram group is connected yet.', 'If you use Home Assistant at home, open tasks for shared assets can also show on one of its to-do lists.']) {
    const hint = panel(page).locator('.hd-hint', { hasText: text });
    await expect(hint).toBeVisible(); await expect(hint.getByRole('link', { name: 'Connections', exact: true })).toHaveAttribute('href', '#connections');
  }
  // Without Home Assistant there is nothing to choose and nothing to save.
  await expect(panel(page).locator('[data-household-home-assistant] form')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [390]) {
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
    // Telegram's one control is its group (Off is the draft); Home Assistant's is the typed list ID.
    const initial = kind === 'telegram' ? '0' : 'todo.household';
    const edited = kind === 'telegram' ? '' : 'todo.edited';
    const field = (page: Page) => kind === 'telegram' ? group(page) : entity(page);
    const fill = async (page: Page, value: string) => {
      if (kind === 'telegram') { await group(page).focus(); await group(page).selectOption(value); } else await entity(page).fill(value);
    };
    // The newer server: another group, or another to-do list.
    const expectNewerServer = async (page: Page) => {
      if (kind === 'telegram') await expect(group(page)).toHaveValue('1'); else await expect(entity(page)).toHaveValue('todo.server');
    };

    test(`Household reverted ${kind} form refreshes confirmed settings at ${width}px`, async ({ page }) => {
      await open(page, width, false); await release(page, 'read');
      const original = await field(page).elementHandle();
      await fill(page, edited); expect(await guards(page)).toEqual({ work: false, dirty: true });
      await fill(page, initial); expect(await guards(page)).toEqual({ work: false, dirty: false });
      await expect(field(page)).toBeFocused(); expect(await original!.evaluate(node => node.isConnected)).toBe(true);
      await outside(page).focus(); await page.evaluate(kind => { window.__householdDelivery.setNewerServer(kind); window.__householdDelivery.refresh(); }, kind);
      await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1);
      await expectNewerServer(page); await expect(outside(page)).toBeFocused();
      expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toEqual([]);
    });

    test(`Household reverting ${kind} retains the other form until it is restored at ${width}px`, async ({ page }) => {
      await open(page, width, false); await release(page, 'read'); await draftOff(page); await entity(page).fill('todo.edited');
      await fill(page, initial); expect(await guards(page)).toEqual({ work: false, dirty: true });
      await page.evaluate(() => window.__householdDelivery.refresh()); expect(await reads(page)).toBe(1);
      if (kind === 'telegram') { await expect(entity(page)).toHaveValue('todo.edited'); await entity(page).fill('todo.household'); }
      else { await expect(group(page)).toHaveValue(''); await group(page).selectOption('0'); }
      expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toEqual([]);
    });

    test(`Household ${kind} reverts use the newly confirmed save at ${width}px`, async ({ page }) => {
      await open(page, width, false); await release(page, 'read'); await fill(page, edited); await press(save(page, kind));
      await release(page, 'save'); await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1);
      expect(await guards(page)).toEqual({ work: false, dirty: false });
      // The confirmed save is the baseline: choosing the old value again is now the change.
      await expect(field(page)).toHaveValue(edited);
      await fill(page, initial); expect(await guards(page)).toEqual({ work: false, dirty: true }); await fill(page, edited);
      expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toHaveLength(1); expect(await reads(page)).toBe(2);
    });

    for (const outcome of ['error', 'applied_error'] as const) {
      test(`Household reverted ${kind} stays guarded after ${outcome} until a fresh read at ${width}px`, async ({ page }) => {
        await open(page, width, false); await release(page, 'read'); await fill(page, edited); await press(save(page, kind));
        await release(page, 'save', 0, outcome); await expect(notice(page)).toHaveAttribute('role', 'alert');
        await fill(page, initial); expect(await guards(page)).toEqual({ work: false, dirty: true }); await outside(page).focus();
        await page.evaluate(() => window.__householdDelivery.refresh()); await expect.poll(() => reads(page)).toBe(2);
        await release(page, 'read', 1, 'error'); await expect(retry(page)).toBeVisible();
        expect(await guards(page)).toEqual({ work: false, dirty: true }); await expect(outside(page)).toBeFocused();
        await press(retry(page)); await release(page, 'read', 2); await expect(field(page)).toHaveValue(initial);
        // An applied save leaves the restored value unlike the server's.
        const differs = outcome === 'applied_error';
        expect(await guards(page)).toEqual({ work: false, dirty: differs });
        if (differs) { await fill(page, edited); expect(await guards(page)).toEqual({ work: false, dirty: false }); }
        expect(await writes(page)).toHaveLength(1); expect(await reads(page)).toBe(3);
      });
    }

    test(`Household ${kind} retains an uncertain save after an unsupported recovery read at ${width}px`, async ({ page }) => {
      await open(page, width, false); await release(page, 'read'); await fill(page, edited); await press(save(page, kind));
      await release(page, 'save', 0, 'applied_error'); await expect(notice(page)).toHaveAttribute('role', 'alert');
      await fill(page, initial); await outside(page).focus(); await page.evaluate(() => window.__householdDelivery.refresh());
      await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1, 'unsupported');
      expect(await guards(page)).toEqual({ work: false, dirty: true }); await expect(panel(page)).toHaveCount(1);
      await expect(retry(page)).toBeVisible(); await expect(outside(page)).toBeFocused(); expect(await writes(page)).toHaveLength(1);
      await press(retry(page)); await release(page, 'read', 2); await expect(field(page)).toHaveValue(initial);
      expect(await guards(page)).toEqual({ work: false, dirty: true }); await fill(page, edited);
      expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toHaveLength(1); expect(await reads(page)).toBe(3);
    });
  }

  // Home Assistant only: Telegram has no second control whose draft could outlive a re-enrollment.
  test(`Household home_assistant reverts preserve the enrollment identity across another form save at ${width}px`, async ({ page }) => {
    await open(page, width, false); await release(page, 'read'); await draftOff(page); await entity(page).fill('todo.edited');
    const choice = panel(page).getByLabel('Home Assistant connection', { exact: true }); await press(save(page, 'telegram'));
    await page.evaluate(() => { window.__householdDelivery.reenroll('home_assistant'); window.__householdDelivery.release('save'); });
    await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1); await expect(choice).toHaveValue('missing');
    await entity(page).fill('todo.household'); expect(await guards(page)).toEqual({ work: false, dirty: true });
    await choice.selectOption('0'); expect(await guards(page)).toEqual({ work: false, dirty: false });
    await expect(entity(page)).toHaveValue('todo.household'); expect(await writes(page)).toHaveLength(1);
  });

  for (const kind of ['telegram', 'home_assistant'] as const) {
    // The Telegram draft is Off: its own confirmed save makes Off the saved group, and
    // any other confirmed save leaves the draft in place. Either way the menu shows Off.
    for (const outcome of ['without_home_assistant', 'malformed_telegram', 'malformed_home_assistant'] as const) {
      test(`Household keeps both drafts for ${kind} after ${outcome} confirmation at ${width}px`, async ({ page }) => {
        await open(page, width, false); await release(page, 'read');
        await draftOff(page); await entity(page).fill('todo.edited');
        const originalGroup = await group(page).elementHandle(), originalEntity = await entity(page).elementHandle();
        await press(save(page, kind)); await release(page, 'save');
        await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1, outcome);
        expect(await confirmationRetry(page).count()).toBe(1);
        await expect(notice(page)).toContainText('was saved'); await expect(notice(page)).toContainText('could not read the current household settings');
        await expect(confirmationRetry(page)).toBeFocused();
        await expect(group(page)).toHaveValue(''); await expect(entity(page)).toHaveValue('todo.edited');
        expect(await originalGroup!.evaluate(node => node.isConnected)).toBe(true);
        expect(await originalEntity!.evaluate(node => node.isConnected)).toBe(true);
        expect(await guards(page)).toEqual({ work: false, dirty: true });
        await press(confirmationRetry(page)); await release(page, 'read', 2);
        await expect(save(page, kind)).toBeFocused(); await expect(confirmationRetry(page)).toHaveCount(0);
        await expect(group(page)).toHaveValue(''); await expect(entity(page)).toHaveValue('todo.edited');
        expect(await guards(page)).toEqual({ work: false, dirty: true });
        expect(await writes(page)).toHaveLength(1); expect(await reads(page)).toBe(3);
        const other = kind === 'telegram' ? 'home_assistant' : 'telegram';
        await press(save(page, other)); await release(page, 'save', 1);
        await expect.poll(() => reads(page)).toBe(4); await release(page, 'read', 3);
        expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toHaveLength(2);
      });
    }

    test(`Household retries only the confirmation read for ${kind} at ${width}px`, async ({ page }) => {
      const { originalGroup, originalEntity } = await failedConfirmation(page, width, kind);
      expect(await confirmationRetry(page).count()).toBe(1);
      await expect(notice(page)).toContainText('was saved'); await expect(notice(page)).toContainText('could not check');
      await expect(confirmationRetry(page)).toBeFocused();
      await expect(confirmationRetry(page)).toBeInViewport();
      await expect(group(page)).toHaveValue(''); await expect(entity(page)).toHaveValue('todo.edited');
      for (const field of [group(page), entity(page), save(page, 'telegram'), save(page, 'home_assistant')]) await expect(field).toBeDisabled();
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
      expect(await originalGroup!.evaluate(node => node.isConnected)).toBe(true);
      expect(await originalEntity!.evaluate(node => node.isConnected)).toBe(true);
      await page.evaluate(kind => window.__householdDelivery.setNewerServer(kind), kind);
      await confirmationRetry(page).press('Space'); await release(page, 'read', 3);
      await expect(confirmationRetry(page)).toHaveCount(0); await expect(save(page, kind)).toBeFocused();
      await expect(save(page, kind)).toBeInViewport();
      // The Telegram save is confirmed by a newer server's group; a Home Assistant save leaves the Off draft.
      await expect(group(page)).toHaveValue(kind === 'telegram' ? '1' : '');
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
        await entity(page).fill('todo.fresh'); const fresh = await entity(page).elementHandle(); await outside(page).focus();
        await old!.evaluate((node: HTMLButtonElement) => node.click()); await release(page, 'read', 2, outcome);
        await expect(entity(page)).toHaveValue('todo.fresh');
        await expect(outside(page)).toBeFocused(); await expect(panel(page)).toHaveCount(1);
        expect(await fresh!.evaluate(node => node.isConnected && node === document.querySelector('[name="ha_entity"]'))).toBe(true);
        expect(await reads(page)).toBe(4); expect(await writes(page)).toHaveLength(1);
        expect(await guards(page)).toEqual({ work: false, dirty: true });
      });
    }

    test(`Household retains an accepted ${kind} save if confirmation becomes unsupported at ${width}px`, async ({ page }) => {
      await failedConfirmation(page, width, kind); await press(confirmationRetry(page)); await release(page, 'read', 2, 'unsupported');
      await expect(panel(page)).toHaveCount(1); await expect(notice(page)).toContainText('was saved');
      await expect(confirmationRetry(page)).toBeFocused(); await expect(confirmationRetry(page)).toHaveAttribute('aria-disabled', 'false');
      await expect(group(page)).toHaveValue(''); await expect(entity(page)).toHaveValue('todo.edited');
      await press(confirmationRetry(page)); await release(page, 'read', 3); await expect(save(page, kind)).toBeFocused();
      expect(await guards(page)).toEqual({ work: false, dirty: true }); expect(await writes(page)).toHaveLength(1);
    });

    test(`Household ${kind} write rejection keeps drafts and outside focus at ${width}px`, async ({ page }) => {
      await open(page, width, false); await release(page, 'read');
      await draftOff(page); await entity(page).fill('todo.edited');
      await press(save(page, kind)); await outside(page).focus(); await release(page, 'save', 0, 'error');
      await expect(notice(page)).toHaveAttribute('role', 'alert'); await expect(outside(page)).toBeFocused();
      await expect(group(page)).toHaveValue(''); await expect(entity(page)).toHaveValue('todo.edited');
      await expect(save(page, kind)).toBeEnabled(); await expect(confirmationRetry(page)).toHaveCount(0);
      expect(await guards(page)).toEqual({ work: false, dirty: true }); expect(await reads(page)).toBe(1); expect(await writes(page)).toHaveLength(1);
    });
  }

  // Home Assistant only: Enter in a text field submits its form, and a menu has none.
  test(`Household home_assistant confirmation recovers focus to the field that submitted with Enter at ${width}px`, async ({ page }) => {
    await open(page, width, false); await release(page, 'read');
    await entity(page).fill('todo.edited'); await entity(page).press('Enter');
    await release(page, 'save'); await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1, 'error');
    await expect(confirmationRetry(page)).toBeFocused(); await press(confirmationRetry(page)); await release(page, 'read', 2);
    await expect(entity(page)).toBeFocused(); await expect(entity(page)).toBeInViewport();
    expect(await guards(page)).toEqual({ work: false, dirty: false }); expect(await writes(page)).toHaveLength(1);
  });

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
    await expect(entity(page)).toHaveValue('todo.household');
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
      await entity(page).fill('todo.fresh'); const original = await entity(page).elementHandle();
      await outside(page).focus(); await old!.evaluate((node: HTMLButtonElement) => node.click());
      await release(page, 'read', 1, outcome); await expect(outside(page)).toBeFocused();
      await expect(entity(page)).toHaveValue('todo.fresh'); await expect(panel(page)).toHaveCount(1);
      expect(await original!.evaluate(node => node.isConnected && node === document.querySelector('[name="ha_entity"]'))).toBe(true);
      expect(await reads(page)).toBe(3); expect(await writes(page)).toEqual([]);
      expect(await guards(page)).toEqual({ work: false, dirty: true });
    });
  }

  test(`Household coalesces concurrent reads and adopts a later explicit refresh at ${width}px`, async ({ page }) => {
    await open(page, width, false); await outside(page).focus();
    expect(await page.evaluate(() => { window.__householdDelivery.setNewerServer(); return window.__householdDelivery.refreshPair(); })).toBe(true);
    expect(await reads(page)).toBe(1); await release(page, 'read');
    await expect(group(page)).toHaveValue('0'); await expect(outside(page)).toBeFocused();
    expect(await page.evaluate(() => window.__householdDelivery.refreshPair())).toBe(true);
    await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1);
    await expect(group(page)).toHaveValue('1'); await expect(outside(page)).toBeFocused();
    expect(await writes(page)).toEqual([]); expect(await guards(page)).toEqual({ work: false, dirty: false });
  });

  for (const kind of ['telegram', 'home_assistant'] as const) {
    test(`Household preserves both drafts and pending ${kind} write guards through refresh attempts at ${width}px`, async ({ page }) => {
      await open(page, width, false); await release(page, 'read');
      await draftOff(page); await entity(page).fill('todo.edited');
      await entity(page).focus(); await entity(page).evaluate((node: HTMLInputElement) => node.setSelectionRange(1, 4));
      const original = await entity(page).elementHandle(); await page.evaluate(() => window.__householdDelivery.refresh());
      expect(await reads(page)).toBe(1); await expect(entity(page)).toBeFocused();
      expect(await original!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      expect(await entity(page).evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd])).toEqual([1, 4]);
      expect(await guards(page)).toEqual({ work: false, dirty: true });
      await press(save(page, kind));
      const attempt = () => page.evaluate(() => {
        for (const form of document.querySelectorAll('#panel form')) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        window.__householdDelivery.refresh();
      });
      await attempt(); expect(await writes(page)).toHaveLength(1); expect(await reads(page)).toBe(1);
      expect(await guards(page)).toEqual({ work: true, dirty: true });
      await expect(group(page)).toBeDisabled(); await expect(entity(page)).toBeDisabled();
      await release(page, 'save'); await expect.poll(() => reads(page)).toBe(2); await attempt();
      expect(await writes(page)).toHaveLength(1); expect(await reads(page)).toBe(2);
      expect(await guards(page)).toEqual({ work: true, dirty: true });
      await release(page, 'read', 1); await expect(save(page, kind)).toBeFocused();
      await expect(entity(page)).toHaveValue('todo.edited'); await expect(group(page)).toHaveValue('');
      expect(await guards(page)).toEqual({ work: false, dirty: true });
      const other = kind === 'telegram' ? 'home_assistant' : 'telegram';
      await press(save(page, other)); await release(page, 'save', 1);
      await expect.poll(() => reads(page)).toBe(3); await release(page, 'read', 2);
      expect(await guards(page)).toEqual({ work: false, dirty: false });
      const changes = await writes(page); expect(changes.map(change => change.input!.action)).toEqual([`household.${kind}`, `household.${other}`]);
      expect(changes.find(change => change.input!.action === 'household.telegram')!.input).toEqual({ action: 'household.telegram', connection_name: null });
      expect(changes.find(change => change.input!.action === 'household.home_assistant')!.input).toEqual({
        action: 'household.home_assistant', connection_name: 'Household server', connection_enrolled_at: 300, entity_id: 'todo.edited',
      });
    });
  }

  test(`Household detached Retry cannot re-read or replay a write after recovery at ${width}px`, async ({ page }) => {
    await open(page, width); const old = await retry(page).elementHandle(); await press(retry(page)); await release(page, 'read', 1);
    await draftOff(page); await press(save(page, 'telegram'));
    await old!.evaluate((node: HTMLButtonElement) => node.click()); await page.evaluate(() => window.__householdDelivery.refresh());
    expect(await reads(page)).toBe(2); expect(await writes(page)).toHaveLength(1);
    expect(await guards(page)).toEqual({ work: true, dirty: true });
    await release(page, 'save', 0, 'error'); await expect(panel(page).locator('[data-household-status]')).toHaveAttribute('role', 'alert');
    await expect(group(page)).toHaveValue(''); await expect(save(page, 'telegram')).toBeFocused();
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
    const oldInputs = [await group(page).elementHandle(), await entity(page).elementHandle()];
    const lateEdits = async (inputs: typeof oldInputs) => {
      for (const input of inputs) await input!.evaluate((node: HTMLInputElement | HTMLSelectElement) => {
        node.value = node.name === 'group' ? '' : 'todo.stale';
        for (const type of ['input', 'change']) node.dispatchEvent(new Event(type, { bubbles: true }));
      });
    };
    await page.evaluate(() => { window.__householdDelivery.setNewerServer(); window.__householdDelivery.refresh(); });
    await expect.poll(() => reads(page)).toBe(2); await release(page, 'read', 1);
    await expect(group(page)).toHaveValue('1'); await outside(page).focus();
    await lateEdits(oldInputs);
    expect(await guards(page)).toEqual({ work: false, dirty: false });
    await expect(group(page)).toHaveValue('1'); await expect(entity(page)).toHaveValue('todo.household');
    await expect(outside(page)).toBeFocused();
    await draftOff(page); await press(save(page, 'telegram')); await release(page, 'save');
    await expect.poll(() => reads(page)).toBe(3); await release(page, 'read', 2);
    await expect(entity(page)).toHaveValue('todo.household');
    expect(await guards(page)).toEqual({ work: false, dirty: false });
    const replacedInputs = [await group(page).elementHandle(), await entity(page).elementHandle()];
    await page.evaluate(() => window.__householdDelivery.refresh()); await expect.poll(() => reads(page)).toBe(4);
    await lateEdits(replacedInputs); await release(page, 'read', 3);
    await expect(group(page)).toHaveValue(''); await expect(entity(page)).toHaveValue('todo.household');
    const disposedInputs = [await group(page).elementHandle(), await entity(page).elementHandle()];
    await outside(page).focus(); await page.evaluate(() => window.__householdDelivery.dispose()); await lateEdits(disposedInputs);
    expect(await guards(page)).toEqual({ work: false, dirty: false });
    await expect(outside(page)).toBeFocused(); await expect(panel(page)).toHaveCount(0);
    expect(await reads(page)).toBe(4); expect(await writes(page)).toEqual([{ kind: 'save', input: { action: 'household.telegram', connection_name: null } }]);
  });

  test(`Household omits an unsupported panel and ignores later refresh at ${width}px`, async ({ page }) => {
    await open(page, width, false); await outside(page).focus(); await release(page, 'read', 0, 'unsupported');
    await expect(panel(page)).toHaveCount(0); await page.evaluate(() => window.__householdDelivery.refresh());
    await expect(outside(page)).toBeFocused(); expect(await reads(page)).toBe(1); expect(await writes(page)).toEqual([]);
  });
}
