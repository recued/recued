import { expect, test, type Locator, type Page } from '@playwright/test';
import { HARNESS_URL, SHELL_SEARCH_TRIGGER, SHELL_CONTENT, installFullAppHooks } from './helpers/full-app.js';
import { installTaskReaderFixture } from './helpers/task-reader-fixture.js';
import { openRunSearch, runQuery, runType, runOutcome, runTime, runHit } from './helpers/run-search-fixture.js';

installFullAppHooks();
const query = (page: Page) => page.getByRole('searchbox', { name: 'Search everything', exact: true });
const type = (page: Page) => page.getByRole('combobox', { name: 'Result type', exact: true });
const sources = (page: Page) => page.locator('.rq-sources');
const hit = (page: Page, id: string) => page.locator(`[data-search-work-id="${id}"]`);
const visibleFocus = async (page: Page) => {
  await expect.poll(() => page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { visible: false, target: el?.tagName };
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2));
    const top = document.elementFromPoint(x, y);
    const details = { visible: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth
      && !!top && (el === top || el.contains(top)), target: el.outerHTML.slice(0, 250), rect: { top: r.top, bottom: r.bottom }, hit: top?.outerHTML.slice(0, 150) };
    return details.visible ? '' : JSON.stringify(details);
  })).toBe('');
};
const pinnedActions = async (dialog: Locator) => {
  for (const control of [dialog.getByRole('button', { name: 'Cancel', exact: true }), dialog.locator('.work-entity-dialog-submit,.data-button--primary,.run-modal-button--primary').last()]) {
    await expect(control).toBeVisible();
    expect(await control.evaluate(el => {
      const r = el.getBoundingClientRect(), top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && !!top && (el === top || el.contains(top));
    })).toBe(true);
  }
};

test('top-bar Search puts three loaded matches on the first phone screen and Back retains query, type and row focus', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await installTaskReaderFixture(page, { reminders: true });
  for (let i = 0; i < 3; i++) f.seedTask('passport-' + i, { title: 'Passport renewal ' + i, body: 'Check the renewal documents.' });
  try {
    await page.goto(`${HARNESS_URL}?settle_reads=1&journey=verification#chat`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await page.locator(`[${SHELL_SEARCH_TRIGGER}]`).click(); await expect(query(page)).toBeFocused();
    await query(page).fill('passport'); await expect(page.locator('[data-search-work-id]')).toHaveCount(3);
    await expect(sources(page)).toHaveJSProperty('open', false);
    await expect(hit(page, 'passport-0')).toBeInViewport({ ratio: 1 });
    expect(await page.locator(`[${SHELL_CONTENT}]`).evaluate(el => el.scrollTop)).toBe(0);
    await info.attach('search-phone-geometry.json', { body: JSON.stringify({ result: await hit(page, 'passport-0').boundingBox(), viewport: page.viewportSize(), scrollTop: await page.locator(`[${SHELL_CONTENT}]`).evaluate(el => el.scrollTop) }), contentType: 'application/json' });
    const track = await type(page).boundingBox();
    await type(page).selectOption('task'); await expect(hit(page, 'passport-0')).toBeInViewport({ ratio: 1 });
    const narrowed = await type(page).boundingBox(); expect(narrowed?.x).toBe(track?.x); expect(narrowed?.width).toBe(track?.width);
    for (const browserBack of [true, false]) {
      await sources(page).locator('summary').click(); await expect(sources(page)).toHaveJSProperty('open', true);
      await hit(page, 'passport-0').focus(); await page.keyboard.press('Enter');
      const reader = page.locator('.work-entity-task-reader'); await expect(reader).toBeVisible();
      if (browserBack) await page.goBack(); else await reader.getByRole('button', { name: 'Back to search', exact: true }).click();
      await expect(query(page)).toHaveValue('passport'); await expect(type(page)).toHaveValue('task');
      await expect(sources(page)).toHaveJSProperty('open', true);
      await expect(hit(page, 'passport-0')).toBeFocused(); await visibleFocus(page);
      await sources(page).locator('summary').click(); await hit(page, 'passport-0').focus();
    }
    await page.screenshot({ path: info.outputPath('search-phone-light.png'), animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: info.outputPath('search-phone-dark.png'), animations: 'disabled' });
    expect(f.writes).toEqual([]); expect(f.reminderRequests).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { f.dispose(); }
});

test('compact source warnings retain retry and disclosure focus without hiding loaded work or searching file contents', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await installTaskReaderFixture(page, { reminders: true }); f.seedTask('passport-0', { title: 'Passport renewal' });
  let fail = true, retries = 0, contents = 0;
  f.fixtureCaller(method => {
    if (method === 'collection.searchAll') { retries++; return fail ? { error: { code: 'unavailable', message: 'Mail source interrupted.' } } : { result: { groups: [] } }; }
    if (method === 'collection.file.document.search') { contents++; return undefined; }
    return undefined;
  });
  try {
    await page.goto(`${HARNESS_URL}?settle_reads=1&journey=verification#data/search`); await page.waitForFunction(() => window.__app?.ready === true);
    await query(page).fill('passport'); await expect(hit(page, 'passport-0')).toBeInViewport({ ratio: 1 });
    await expect(sources(page).locator('summary')).toContainText('Some sources unavailable');
    await expect(page.getByText(/No matches in the searched sources/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Look for .*marketplace/ })).toHaveCount(0);
    await sources(page).locator('summary').click(); await expect(sources(page).getByRole('alert').filter({ hasText: 'Mail source interrupted' })).toBeVisible();
    fail = false; await sources(page).getByRole('button', { name: 'Try again', exact: true }).click();
    await expect.poll(() => retries).toBe(2); await expect(sources(page).getByRole('alert').filter({ hasText: 'Mail source interrupted' })).toHaveCount(0);
    await expect(sources(page)).toHaveJSProperty('open', true);
    await sources(page).locator('summary').focus(); await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: { kind: 'warehouse', collection: 'task', op: 'update', id: 'passport-0', cursor: Date.now() + 1000 } }));
    await expect(sources(page).locator('summary')).toBeFocused();
    await sources(page).locator('summary').press('Enter'); await expect(sources(page)).toHaveJSProperty('open', false);
    await expect(page.getByRole('button', { name: 'Search file contents', exact: true })).toBeVisible(); expect(contents).toBe(0);
    await type(page).selectOption('reminder'); await expect(page.getByRole('combobox', { name: 'Reminder status', exact: true })).toBeVisible();
    await type(page).selectOption('all'); await expect(page.getByRole('combobox', { name: 'Reminder status', exact: true })).toHaveCount(0);
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('run filters appear on Runs and survive switching types and Back from the exact run', async ({ page }) => {
  await openRunSearch(page, { width: 390 }); await page.setViewportSize({ width: 390, height: 844 });
  await runQuery(page).fill('follow-up'); await expect(runHit(page, 'run-0')).toBeVisible();
  await expect(runOutcome(page)).toHaveCount(0); await expect(runTime(page)).toHaveCount(0);
  await runType(page).selectOption('run'); await runOutcome(page).selectOption('failed'); await runTime(page).selectOption('7d');
  await runType(page).selectOption('all'); await expect(runOutcome(page)).toHaveCount(0);
  await expect(page.locator('[data-search-run-results]')).toContainText('Choose Runs to change filters');
  await runType(page).selectOption('run'); await expect(runOutcome(page)).toHaveValue('failed'); await expect(runTime(page)).toHaveValue('7d');
  const chosen = page.locator('[data-search-run-id]').first(); const id = await chosen.getAttribute('data-search-run-id');
  await chosen.focus(); await page.keyboard.press('Enter'); await expect(page).toHaveURL(/#logs\/run-/);
  await page.goBack(); await expect(runQuery(page)).toHaveValue('follow-up'); await expect(runType(page)).toHaveValue('run');
  await expect(runOutcome(page)).toHaveValue('failed'); await expect(runTime(page)).toHaveValue('7d'); await expect(runHit(page, id!)).toBeFocused(); await visibleFocus(page);
});

test('Today puts overdue and due-today work ahead of empty reminders and retains source warnings', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.setFixedTime(new Date('2026-09-08T12:00:00-07:00'));
  await page.goto(`${HARNESS_URL}?data=today#today`); await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator('[data-today-view]')).toHaveAttribute('aria-busy', 'false');
  const overdue = page.locator('[data-today-group="overdue"]'), today = page.locator('[data-today-group="today"]'), reminders = page.locator('[data-today-reminders]');
  await expect(overdue.getByRole('link', { name: 'Send the proposal', exact: true })).toBeInViewport({ ratio: 1 });
  const overdueBounds = (await overdue.boundingBox())!;
  const todayBounds = (await today.boundingBox())!;
  const reminderBounds = (await reminders.boundingBox())!;
  expect(overdueBounds.y + overdueBounds.height).toBeLessThanOrEqual(todayBounds.y);
  expect(todayBounds.y + todayBounds.height).toBeLessThanOrEqual(reminderBounds.y);
  await expect(page.locator('.today-notice')).toBeVisible(); await expect(page.locator('.today-sources summary')).toContainText('need attention');
  await expect(reminders).toContainText('No one-off reminders waiting');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-today-mutations') ?? '[]'))).toEqual([]);
  await page.screenshot({ path: info.outputPath('today-phone.png'), animations: 'disabled' });
});

for (const kind of ['commitment', 'contact'] as const) test(`long ${kind} editor keeps actions and keyboard focus visible on a short screen`, async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 460 });
  const f = await installTaskReaderFixture(page);
  try {
  await page.goto(`${HARNESS_URL}?settle_reads=1&journey=verification#data/${kind}`); await page.waitForFunction(() => window.__app?.ready === true);
  await page.getByRole('button', { name: new RegExp(`New ${kind}$`, 'i') }).click();
  const dialog = page.getByRole('dialog', { name: new RegExp(`New ${kind}$`, 'i') });
  await pinnedActions(dialog);
  const body = dialog.locator(kind === 'contact' ? '.data-dialog-body' : '.work-entity-dialog-body');
  expect(await body.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  // Native Tab must scroll each focused field into this body without moving the footer.
  for (let i = 0; i < 18; i++) { await visibleFocus(page); await pinnedActions(dialog); await page.keyboard.press('Tab'); }
  await page.screenshot({ path: info.outputPath(`${kind}-short-screen.png`), animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('Run, Schedule and Trigger use one scrolling body with persistent Cancel and primary actions', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 460 });
  await page.goto(`${HARNESS_URL}?recipes=installed#recipes`); await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-recued-recipes-run-button]').first().click(); const dialog = page.getByRole('dialog', { name: 'Run a Recipe', exact: true });
  await pinnedActions(dialog); await dialog.locator('[data-recued-run-modal-config]').focus(); await visibleFocus(page);
  for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); await visibleFocus(page); await pinnedActions(dialog); }
  await page.screenshot({ path: info.outputPath('run-short-screen.png'), animations: 'disabled' });
  await dialog.getByRole('tab', { name: 'Schedule', exact: true }).click(); await pinnedActions(dialog);
  await dialog.getByRole('checkbox', { name: 'Repeat', exact: true }).focus(); await visibleFocus(page);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await page.goto(`${HARNESS_URL}?automation=rules#automation/triggers`); await page.waitForFunction(() => window.__app?.ready === true);
  await page.getByRole('button', { name: 'Add trigger', exact: true }).click();
  await page.getByRole('combobox', { name: 'Choose a recipe to automate', exact: true }).fill('Watch pipeline');
  await page.getByRole('option', { name: /Watch pipeline/ }).click();
  await expect(dialog.getByRole('tab', { name: 'Trigger', exact: true })).toHaveAttribute('aria-selected', 'true'); await pinnedActions(dialog);
  await dialog.getByRole('button', { name: 'A mail fact', exact: true }).click(); await pinnedActions(dialog);
  for (let i = 0; i < 10; i++) { await page.keyboard.press('Tab'); await visibleFocus(page); await pinnedActions(dialog); }

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(dialog).toHaveCount(0);
});
