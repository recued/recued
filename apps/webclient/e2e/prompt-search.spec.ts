import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installPromptRecoveryFixture, PROMPT_RECOVERY_NOW as NOW } from './helpers/prompt-recovery-fixture.js';
import type { PromptSchedule, ServerSchedule } from '@recued/contracts';

installFullAppHooks();
test.use({ timezoneId: 'America/New_York' });
const panel = (page: Page) => page.locator('[data-prompt-schedules]');
const card = (page: Page, id: string) => panel(page).locator(`[data-schedule-id="${id}"]`);
const found = (page: Page) => page.getByRole('region', { name: 'Scheduled prompt search results', exact: true });
const choice = (page: Page, id: string) => found(page).locator(`[data-search-prompt-id="${id}"]`);
const searchbox = (page: Page) => page.getByRole('searchbox', { name: 'Search everything', exact: true });
const type = (page: Page) => page.getByRole('combobox', { name: 'Result type', exact: true });
const hash = (page: Page, value: string) => page.evaluate(value => window.__app.setHash(value), value);
const detailHash = (row: PromptSchedule) => '#automation/schedules/prompt/' + encodeURIComponent(row.schedule_id);
const go = async (page: Page, address = '#automation/schedules') => {
  await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed&server_profiles=multiple&chat=session${address}`);
  await page.waitForFunction(() => window.__app?.ready === true);
};
const prepare = async (page: Page) => { await page.clock.setFixedTime(new Date(NOW)); return installPromptRecoveryFixture(page); };
const search = async (page: Page, query: string) => {
  await hash(page, '#data/search'); await searchbox(page).fill(query);
  await expect(found(page)).toHaveAttribute('aria-busy', 'false');
};
const mutations = (f: Awaited<ReturnType<typeof prepare>>) => f.calls.filter(call => /^chat\.schedule\.(create|update|pause|resume|remove|run_now)$/.test(call.method));
const coming = (page: Page) => page.locator('[data-recued-automation-coming-up]');
const comingDetails = (page: Page, id: string) => coming(page).locator(`[data-coming-up-prompt="${id}"]`);
const comingNotice = (page: Page) => page.locator('[data-coming-up-prompt-error]');
const scrollAt = (page: Page, id: string) => comingDetails(page, id).evaluate(el => {
  for (let node = el.parentElement; node; node = node.parentElement)
    if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY))return node.scrollTop;
  return document.scrollingElement?.scrollTop ?? 0;
});

for (const width of [390, 1440]) {
  test(`Coming up opens the exact schedule, returns to its scroll and focus, and keeps a separate conversation link at ${width}px`, async ({ page }, info) => {
    const f = await prepare(page);
    const recipes = coming(page).getByRole('link', { name: 'Open recipe for agenda-recipe', exact: true });
    try {
      const saved = await f.seed({ title: 'Shared <briefing>', prompt: 'Read this exact saved request.', cron_expression: '15 9 * * 2,4', time_zone: 'Asia/Tokyo' });
      f.overlay(saved.schedule_id, { next_run_at: NOW + 2 * 86_400_000, skip_state: undefined });
      for (let i = 0; i < (width === 390 ? 18 : 2); i++) {
        const other = await f.seed({ title: 'Shared <briefing>', prompt: 'Another request.' });
        f.overlay(other.schedule_id, { next_run_at: NOW + (i + 1) * 3_600_000, skip_state: undefined });
      }
      await page.setViewportSize({ width, height: 900 });
      if (width === 390) {
        await go(page, '#automation/coming-up');
      } else {
        const schedules: ServerSchedule[] = Array.from({ length: 24 }, (_, i) => ({
          schedule_id: `agenda-recipe-${i}`, recipe_id: 'agenda-recipe', publisher_id: 'core',
          cron_expression: '0 9 * * *', enabled: true, created_at: NOW, last_run_at: null,
          last_status: null, last_error: null, next_run_at: NOW + (i + 3) * 3_600_000,
        }));
        await page.goto(`${HARNESS_URL}?automation=rules&chat=session&review_clock=browser#chat`);
        await page.waitForFunction(() => window.__app?.ready === true);
        await page.evaluate(schedules => {
          const readPromptFixture = window.__connectionsFixture;
          window.__connectionsFixture = async (method, args) => method === 'schedules.list'
            ? { result: { schedules } } : readPromptFixture?.(method, args);
        }, schedules);
        await hash(page, '#automation/coming-up');
        await expect(recipes).toHaveCount(24);
      }
      const link = comingDetails(page, saved.schedule_id);
      await expect(link).toHaveAccessibleName('Schedule details for Shared <briefing>');
      await expect(link).toHaveAttribute('href', detailHash(saved));
      const row = link.locator('xpath=ancestor::li[1]');
      await expect(row).toContainText('Tuesday, Thursday at 09:15');
      await expect(row).toContainText('Asia/Tokyo');
      const conversation = row.getByRole('link', { name: 'Open conversation for Shared <briefing>', exact: true });
      await expect(conversation).toHaveAttribute('href', '#chat/session/' + saved.session_id);
      await link.scrollIntoViewIfNeeded();
      await link.focus();
      const top = await scrollAt(page, saved.schedule_id);
      expect(top).toBeGreaterThan(0);
      if (width === 390) {
        await page.screenshot({ path: info.outputPath('coming-up-prompt-phone.png'), fullPage: true, animations: 'disabled' });
      }
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(detailHash(saved) + '$'));
      await expect(card(page, saved.schedule_id).getByRole('heading', { name: saved.title, exact: true })).toBeFocused();
      await expect(panel(page).getByRole('article')).toHaveCount(1);
      await expect(panel(page)).toContainText(saved.prompt);
      if (width === 390) {
        await page.getByRole('button', { name: 'Back to Coming up', exact: true }).click();
      } else {
        await page.evaluate(() => window.__app.holdRpcResponses!('schedules.list'));
        await page.goBack();
        await expect(link).toBeFocused();
        await expect(recipes).toHaveCount(0);
        expect(await scrollAt(page, saved.schedule_id)).toBeLessThan(top);
        expect(await page.evaluate(() => window.__app.releaseRpcResponses!('schedules.list'))).toBeGreaterThan(0);
        await expect(recipes).toHaveCount(24);
      }
      await expect(link).toBeFocused();
      await expect.poll(async () => Math.abs(await scrollAt(page, saved.schedule_id) - top)).toBeLessThanOrEqual(2);
      await conversation.click();
      await expect(page).toHaveURL(new RegExp('#chat/session/' + saved.session_id + '$'));
      expect(mutations(f)).toEqual([]);
      expect(f.runs()).toBe(0);
    } finally { f.dispose(); }
  });
}

test('Coming up refreshes a changed selection and focuses its explanation before allowing a new selection', async ({ page }) => {
  const f = await prepare(page);
  try {
    const saved = await f.seed({ time_zone: 'Asia/Tokyo' });await f.seed();await go(page, '#automation/coming-up');await expect(comingDetails(page, saved.schedule_id)).toBeVisible();
    await f.update({ schedule_id: saved.schedule_id, expected_revision: saved.revision, time_zone: 'Europe/Paris' });await comingDetails(page, saved.schedule_id).focus();await page.keyboard.press('Enter');
    await expect(comingNotice(page)).toContainText('changed');await expect(comingNotice(page)).toBeFocused();expect(new URL(page.url()).hash).toBe('#automation/coming-up');await expect(comingDetails(page, saved.schedule_id).locator('xpath=ancestor::li[1]')).toContainText('Europe/Paris');
    await comingDetails(page, saved.schedule_id).click();await expect(card(page, saved.schedule_id)).toBeVisible();await expect(panel(page)).toContainText('Europe/Paris');expect(mutations(f)).toEqual([]);expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('Coming up never substitutes a same-title prompt for a removed selection', async ({ page }) => {
  const f = await prepare(page);
  try {
    const saved = await f.seed(), other = await f.seed();await go(page, '#automation/coming-up');await expect(comingDetails(page, saved.schedule_id)).toBeVisible();await f.remove(saved.schedule_id);
    await comingDetails(page, saved.schedule_id).click();await expect(comingNotice(page)).toContainText('removed');await expect(comingNotice(page)).toBeFocused();await expect(comingDetails(page, saved.schedule_id)).toHaveCount(0);await expect(comingDetails(page, other.schedule_id)).toBeVisible();expect(new URL(page.url()).hash).toBe('#automation/coming-up');expect(mutations(f)).toEqual([]);expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('a failed Coming up confirmation stays in place and can be retried without changing a schedule', async ({ page }) => {
  const f = await prepare(page);
  try {
    const saved = await f.seed();await go(page, '#automation/coming-up');await expect(comingDetails(page, saved.schedule_id)).toBeVisible();f.failNextList();await comingDetails(page, saved.schedule_id).click();
    await expect(comingNotice(page)).toBeFocused();expect(new URL(page.url()).hash).toBe('#automation/coming-up');await expect(comingDetails(page, saved.schedule_id)).toBeVisible();await comingDetails(page, saved.schedule_id).click();await expect(card(page, saved.schedule_id)).toBeVisible();expect(mutations(f)).toEqual([]);expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('a delayed Coming up check cannot navigate after the owner moves to Overview', async ({ page }) => {
  const f = await prepare(page);
  try {
    const saved = await f.seed();await go(page, '#automation/coming-up');await expect(comingDetails(page, saved.schedule_id)).toBeVisible();f.holdNextList();await comingDetails(page, saved.schedule_id).click();await expect.poll(f.listPending).toBe(true);
    const overview = page.getByRole('tab', { name: /^Overview/ });await overview.click();await expect(overview).toBeFocused();f.releaseList();await expect(page.getByRole('tab', { name: /^Overview/ })).toHaveAttribute('aria-selected', 'true');await expect(panel(page)).toBeVisible();await expect(page.getByRole('button', { name: 'Back to Coming up', exact: true })).toHaveCount(0);expect(mutations(f)).toEqual([]);expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('arrival checks reject a prompt changed after the Coming up confirmation', async ({ page }) => {
  const f = await prepare(page);
  try {
    const saved = await f.seed();await go(page, '#automation/coming-up');await expect(comingDetails(page, saved.schedule_id)).toBeVisible();f.afterNextList(() => f.update({ schedule_id: saved.schedule_id, expected_revision: saved.revision, prompt: 'Changed elsewhere after confirmation.' }));await comingDetails(page, saved.schedule_id).click();
    await expect(page).toHaveURL(new RegExp(detailHash(saved) + '$'));await expect(panel(page).getByRole('alert')).toContainText('changed');await expect(panel(page).getByRole('alert')).toBeFocused();await expect(panel(page).getByRole('article')).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to Coming up', exact: true }).click();await expect(comingDetails(page, saved.schedule_id)).toBeFocused();expect(mutations(f)).toEqual([]);expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('a delayed Coming up check preserves focus after the owner tabs to the conversation link', async ({ page, browserName }) => {
  const f = await prepare(page);
  try {
    const saved = await f.seed();await go(page, '#automation/coming-up');const details = comingDetails(page, saved.schedule_id);await expect(details).toBeVisible();f.holdNextList();await details.focus();await page.keyboard.press('Enter');await expect.poll(f.listPending).toBe(true);await expect(details).toBeFocused();await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    const conversation = coming(page).locator(`[data-coming-up-conversation="${saved.schedule_id}"]`);await expect(conversation).toBeFocused();f.releaseList();await expect(page.getByText('Checking this scheduled prompt…', { exact: true })).toHaveCount(0);await expect(conversation).toBeFocused();expect(new URL(page.url()).hash).toBe('#automation/coming-up');expect(mutations(f)).toEqual([]);expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('an arrival error preserves focus after the owner moves to Back to Coming up', async ({ page }) => {
  const f = await prepare(page);
  try {
    const saved = await f.seed();await go(page, '#automation/coming-up');await expect(comingDetails(page, saved.schedule_id)).toBeVisible();f.afterNextList(() => f.update({ schedule_id: saved.schedule_id, expected_revision: saved.revision, prompt: 'Changed after confirmation.' }));f.holdNextList();await comingDetails(page, saved.schedule_id).click();await expect.poll(f.listPending).toBe(true);
    f.releaseList();f.holdNextList();await expect(page).toHaveURL(new RegExp(detailHash(saved) + '$'));await expect.poll(f.listPending).toBe(true);const back = page.getByRole('button', { name: 'Back to Coming up', exact: true });await back.focus();await page.keyboard.press('ArrowRight');f.releaseList();
    await expect(panel(page).getByRole('alert')).toContainText('changed');await expect(back).toBeFocused();await expect(panel(page).getByRole('article')).toHaveCount(0);await back.click();await expect(comingDetails(page, saved.schedule_id)).toBeFocused();expect(mutations(f)).toEqual([]);expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('returning to Coming up explains when the selected prompt no longer has an upcoming run', async ({ page }) => {
  const f = await prepare(page);
  try {
    const saved = await f.seed();await go(page, '#automation/coming-up');await comingDetails(page, saved.schedule_id).click();await expect(card(page, saved.schedule_id)).toBeVisible();await f.pause(saved.schedule_id);await page.getByRole('button', { name: 'Back to Coming up', exact: true }).click();
    await expect(comingNotice(page)).toContainText('no longer in Coming up');await expect(comingNotice(page)).toBeFocused();await expect(comingDetails(page, saved.schedule_id)).toHaveCount(0);expect(new URL(page.url()).hash).toBe('#automation/coming-up');expect(mutations(f)).toEqual([]);expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('Automation finds saved weekdays, monthly dates and timezone cities and highlights the matching details', async ({ page }, info) => {
  const f = await prepare(page);
  try {
    const selected = await f.seed({ title: 'Shared briefing', prompt: 'Review the account notes.', cron_expression: '15 9 * * 2,4', time_zone: 'Asia/Tokyo' });
    const monthly = await f.seed({ title: 'Shared briefing', prompt: 'Review the account notes.', cron_expression: '0 9 31 * *', time_zone: 'America/New_York' });
    await f.seed({ title: 'Shared briefing', prompt: 'Review the account notes.', cron_expression: '0 9 1 1 *', time_zone: 'America/New_York' });await go(page);
    const input = panel(page).getByRole('searchbox', { name: 'Search scheduled prompts', exact: true });await input.fill('Thursday Tokyo 09:15');
    await expect(panel(page).getByRole('article')).toHaveCount(1);await expect(card(page, selected.schedule_id)).toBeVisible();
    for (const term of ['Thursday', 'Tokyo', '09'])await expect(card(page, selected.schedule_id).locator('.prompt-schedule-cadence mark').filter({ hasText: term })).toBeVisible();await expect(card(page, selected.schedule_id).locator('.prompt-schedule-cadence')).toContainText('09:15');
    await input.fill('monthly 31 New York');await expect(panel(page).getByRole('article')).toHaveCount(1);await expect(card(page, monthly.schedule_id)).toBeVisible();await expect(card(page, monthly.schedule_id).locator('.prompt-schedule-cadence')).toContainText('Monthly');
    await page.setViewportSize({ width: 390, height: 900 });await card(page, monthly.schedule_id).scrollIntoViewIfNeeded();await page.screenshot({ path: info.outputPath('schedule-timing-search-phone.png'), fullPage: true, animations: 'disabled' });
    expect(mutations(f)).toEqual([]);expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('Universal Search uses the same timing matches and restores the exact metadata query after opening details', async ({ page }) => {
  const f = await prepare(page);
  try {
    const saved = await f.seed({ title: 'Shared briefing', prompt: 'Review account notes.', cron_expression: '15 9 * * 2,4', time_zone: 'Asia/Tokyo' });
    await f.seed({ title: 'Shared briefing', prompt: 'Review account notes.', cron_expression: '15 9 * * 1', time_zone: 'Asia/Tokyo' });await go(page);await search(page, 'Thursday Tokyo 09:15');await type(page).selectOption('scheduled_prompt');
    await expect(found(page).locator('[data-search-prompt-id]')).toHaveCount(1);
    await expect(choice(page, saved.schedule_id)).toHaveAccessibleDescription(/Thursday.*Tokyo/);
    for (const term of ['Thursday', 'Tokyo', '09'])await expect(choice(page, saved.schedule_id).locator('.rq-row-cadence mark').filter({ hasText: term })).toBeVisible();await expect(choice(page, saved.schedule_id).locator('.rq-row-cadence')).toContainText('09:15');
    await choice(page, saved.schedule_id).focus();await page.keyboard.press('Enter');await expect(page).toHaveURL(new RegExp(detailHash(saved) + '$'));await expect(card(page, saved.schedule_id)).toBeVisible();
    await page.getByRole('button', { name: 'Back to search', exact: true }).click();await expect(searchbox(page)).toHaveValue('Thursday Tokyo 09:15');await expect(type(page)).toHaveValue('scheduled_prompt');await expect(choice(page, saved.schedule_id)).toBeFocused();
    await searchbox(page).fill('monthly 31 Tokyo');await expect(found(page).locator('[data-search-prompt-id]')).toHaveCount(0);expect(mutations(f)).toEqual([]);expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('a timezone change invalidates a metadata-only selection without opening another matching prompt', async ({ page }) => {
  const f = await prepare(page);
  try {
    const saved = await f.seed({ title: 'Shared briefing', prompt: 'Review notes.', cron_expression: '0 9 * * 4', time_zone: 'Asia/Tokyo' });
    const other = await f.seed({ title: 'Shared briefing', prompt: 'Review notes.', cron_expression: '0 9 * * 4', time_zone: 'Asia/Tokyo' });await go(page);await search(page, 'Thursday Tokyo');await type(page).selectOption('scheduled_prompt');await expect(found(page).locator('[data-search-prompt-id]')).toHaveCount(2);
    await f.update({ schedule_id: saved.schedule_id, expected_revision: saved.revision, time_zone: 'Europe/Paris' });await choice(page, saved.schedule_id).focus();await page.keyboard.press('Enter');
    await expect(found(page).getByRole('alert')).toContainText('changed');await expect(found(page).getByRole('alert')).toBeFocused();expect(new URL(page.url()).hash).toBe('#data/search');await expect(choice(page, saved.schedule_id)).toHaveCount(0);await expect(choice(page, other.schedule_id)).toBeVisible();expect(mutations(f)).toEqual([]);expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('one-off weekday searches use the saved local date and ignore a leftover recurring expression', async ({ page }) => {
  const f = await prepare(page);
  try {
    const saved = await f.seed({ title: 'Review', prompt: 'Read account notes.', mode: 'one_shot', run_at: '2026-11-05T00:30:42.123Z', cron_expression: undefined, time_zone: 'America/Los_Angeles' });
    f.overlay(saved.schedule_id, { cron_expression: '0 9 * * 4' });await go(page);
    const input = panel(page).getByRole('searchbox', { name: 'Search scheduled prompts', exact: true });await input.fill('Wednesday Los Angeles');await expect(card(page, saved.schedule_id)).toBeVisible();await input.fill('Thursday Los Angeles');await expect(panel(page).getByRole('article')).toHaveCount(0);
    await search(page, 'Wednesday Los Angeles 16:30');await type(page).selectOption('scheduled_prompt');await expect(choice(page, saved.schedule_id)).toBeVisible();await expect(choice(page, saved.schedule_id).locator('.rq-row-cadence')).toContainText('Wednesday');await expect(choice(page, saved.schedule_id).locator('.rq-row-cadence')).toContainText('November 4');
    await choice(page, saved.schedule_id).click();await expect(page).toHaveURL(new RegExp(detailHash(saved) + '$'));expect(mutations(f)).toEqual([]);expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('Automation searches saved titles and requests together with status, preserving native typing and the exact local return', async ({ page }) => {
  const f = await prepare(page);
  try {
    const active = await f.seed({ title: 'Café renewal', prompt: 'Customer context for the active request.' });
    const paused = await f.seed({ title: 'Café renewal', prompt: 'Customer context for the paused request.' }); await f.pause(paused.schedule_id);
    await f.seed({ title: 'Other schedule', prompt: 'Unrelated request.' }); await go(page);
    const input = panel(page).getByRole('searchbox', { name: 'Search scheduled prompts', exact: true });
    await input.fill('CAFE\u0301 context'); await expect(panel(page).getByRole('article')).toHaveCount(2); await expect(input).toBeFocused();
    await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('off');
    await expect(card(page, paused.schedule_id)).toBeVisible(); await expect(card(page, active.schedule_id)).toHaveCount(0);
    await input.focus(); await input.press('Home'); await input.press('ArrowRight');
    await panel(page).getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(input).toHaveValue('CAFE\u0301 context');
    const details = card(page, paused.schedule_id).getByRole('link', { name: 'Details', exact: true });
    await details.focus(); await page.keyboard.press('Enter');
    await expect(card(page, paused.schedule_id).getByRole('heading', { name: 'Café renewal', exact: true })).toBeFocused();
    await expect(panel(page).getByRole('article')).toHaveCount(1); await expect(card(page, paused.schedule_id)).toContainText('paused request.');
    expect(new URL(page.url()).hash).toBe(detailHash(paused));
    await page.getByRole('button', { name: 'Back to schedules', exact: true }).click();
    await expect(input).toHaveValue('CAFE\u0301 context');
    await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toHaveValue('off');
    await expect(card(page, paused.schedule_id).getByRole('link', { name: 'Details', exact: true })).toBeFocused();
    await input.fill('no matching request'); await expect(panel(page)).toContainText('No saved scheduled prompts match this search and filter.');
    await input.clear(); await expect(card(page, paused.schedule_id)).toBeVisible(); expect(mutations(f)).toEqual([]); expect(f.runs()).toBe(0);
    await input.fill('context'); await hash(page, '#chat/session/chat_1');
    await expect(page.locator('[data-recued-chat-route-input]')).toBeVisible(); await hash(page, '#automation/schedules');
    await expect(input).toHaveValue(''); await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toHaveValue('all');
  } finally { f.dispose(); }
});

test('Universal Search finds request text once per visit, opens the exact saved details and restores query, type and focus with fresh status', async ({ page }, info) => {
  const f = await prepare(page);
  try {
    const saved = await f.seed({ title: 'Kestrel <briefing>', prompt: '  Review Café 😀\nCustomer renewal <img src=x> & preserve the exact context.  ',
      model_source_id: 'slot_2', notify_on_done: true });
    await f.seed({ title: 'Kestrel <briefing>', prompt: 'Different customer request.' });
    f.overlay(saved.schedule_id, { last_run_at: NOW - 1000, last_status: 'failed', last_outcome: { status: 'failed', reason: 'tool_failed', message_id: 'answer-1' } });
    await go(page, '#data/search'); const before = f.calls.filter(call => call.method === 'chat.schedules.list').length;
    await searchbox(page).fill('renewal'); await expect(choice(page, saved.schedule_id)).toBeVisible();
    await searchbox(page).fill('CAFÉ preserve'); await expect(found(page).locator('[data-search-prompt-id]')).toHaveCount(1);
    await expect(found(page)).toHaveAttribute('aria-busy', 'false');
    expect(f.calls.filter(call => call.method === 'chat.schedules.list')).toHaveLength(before + 1);
    await expect(choice(page, saved.schedule_id)).toContainText('Active · Last run needs attention');
    await expect(choice(page, saved.schedule_id)).toContainText('Next run'); await expect(choice(page, saved.schedule_id)).toContainText('America/New_York');
    await expect(choice(page, saved.schedule_id).locator('img')).toHaveCount(0);
    await type(page).selectOption('scheduled_prompt'); await choice(page, saved.schedule_id).focus(); await page.keyboard.press('Enter');
    await expect(card(page, saved.schedule_id).getByRole('heading', { name: saved.title, exact: true })).toBeFocused();
    await expect(panel(page).getByRole('article')).toHaveCount(1); await expect(card(page, saved.schedule_id)).toContainText('Customer renewal <img src=x> & preserve the exact context.');
    await expect(card(page, saved.schedule_id)).toContainText('Slot 2'); await expect(card(page, saved.schedule_id)).toContainText('Notifies you');
    await expect(card(page, saved.schedule_id).getByRole('link', { name: 'View last run', exact: true })).toHaveAttribute('href', /answer-1/);
    await expect(card(page, saved.schedule_id).getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    await expect(card(page, saved.schedule_id).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    expect(mutations(f)).toEqual([]); expect(f.runs()).toBe(0);
    await page.setViewportSize({ width: 390, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ fullPage: true, animations: 'disabled', path: info.outputPath('saved-prompt-details-phone.png') });
    await f.pause(saved.schedule_id);
    await page.getByRole('button', { name: 'Back to search', exact: true }).click();
    await expect(searchbox(page)).toHaveValue('CAFÉ preserve'); await expect(type(page)).toHaveValue('scheduled_prompt');
    await expect(choice(page, saved.schedule_id)).toBeFocused(); await expect(choice(page, saved.schedule_id)).toContainText('Paused');
  } finally { f.dispose(); }
});

test('browses saved prompts under an empty type filter and returns to that exact result', async ({ page }) => {
  const f = await prepare(page);
  try {
    const saved = await f.seed(); await go(page, '#data/search'); await type(page).selectOption('scheduled_prompt');
    await expect(choice(page, saved.schedule_id)).toBeVisible(); await choice(page, saved.schedule_id).click();
    await expect(card(page, saved.schedule_id)).toBeVisible(); await page.getByRole('button', { name: 'Back to search', exact: true }).click();
    await expect(searchbox(page)).toHaveValue(''); await expect(type(page)).toHaveValue('scheduled_prompt'); await expect(choice(page, saved.schedule_id)).toBeFocused();
  } finally { f.dispose(); }
});

test('finds the last of all 200 saved prompts by its request instead of searching a visible first page', async ({ page }) => {
  const f = await prepare(page);
  try {
    let saved!: PromptSchedule;
    for (let n = 0; n < 200; n++) saved = await f.seed({ title: 'Briefing ' + n, prompt: n === 199 ? 'Review the zebra renewal.' : 'Ordinary briefing.' });
    await go(page, '#data/search'); await searchbox(page).fill('zebra');
    await expect(found(page).locator('[data-search-prompt-id]')).toHaveCount(1); await expect(choice(page, saved.schedule_id)).toBeVisible();
    expect(mutations(f)).toEqual([]); expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('a saved Scheduled prompts view opens the exact item and returns to that saved view', async ({ page }) => {
  const f = await prepare(page), id = 'view_00000000-0000-4000-8000-000000000001';
  try {
    const saved = await f.seed();
    await page.addInitScript(id => sessionStorage.setItem('recued-test-saved-data-views', JSON.stringify([{
      id, name: 'Kestrel schedules', revision: 1, created_at: 1, updated_at: 1,
      definition: { tab: 'search', query: 'Kestrel', result_type: 'scheduled_prompt' },
    }])), id);
    await go(page, '#views/' + id); await expect(type(page)).toHaveValue('scheduled_prompt');
    await expect(choice(page, saved.schedule_id)).toBeVisible(); await choice(page, saved.schedule_id).click();
    await expect(card(page, saved.schedule_id)).toBeVisible(); await page.getByRole('button', { name: 'Back to search', exact: true }).click();
    await expect(searchbox(page)).toHaveValue('Kestrel'); await expect(type(page)).toHaveValue('scheduled_prompt');
    await expect(choice(page, saved.schedule_id)).toBeFocused(); expect(new URL(page.url()).hash).toBe('#views/' + id); expect(mutations(f)).toEqual([]);
  } finally { f.dispose(); }
});

test('changed and removed Search selections stay in Search, update results and focus their explanation', async ({ page }) => {
  const f = await prepare(page);
  try {
    const saved = await f.seed(), other = await f.seed({ title: 'Other Kestrel briefing' }); await go(page); await search(page, 'Kestrel');
    await f.update({ schedule_id: saved.schedule_id, expected_revision: saved.revision, title: 'Kestrel changed briefing' });
    await choice(page, saved.schedule_id).focus(); await page.keyboard.press('Enter');
    await expect(found(page).getByRole('alert')).toContainText('changed'); await expect(found(page).getByRole('alert')).toBeFocused();
    expect(new URL(page.url()).hash).toBe('#data/search'); await expect(choice(page, saved.schedule_id)).toContainText('changed briefing');
    await found(page).getByRole('button', { name: 'Refresh scheduled prompts', exact: true }).click();
    await expect(found(page)).toHaveAttribute('aria-busy', 'false'); await f.remove(saved.schedule_id);
    await choice(page, saved.schedule_id).click(); await expect(found(page).getByRole('alert')).toContainText('removed');
    await expect(choice(page, saved.schedule_id)).toHaveCount(0); await expect(choice(page, other.schedule_id)).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#data/search'); expect(mutations(f)).toEqual([]);
  } finally { f.dispose(); }
});

test('rechecks on arrival and only shows a changed selection after an explicit Refresh', async ({ page }) => {
  const f = await prepare(page);
  try {
    const saved = await f.seed(); await go(page); await search(page, 'Kestrel');
    f.afterNextList(() => f.update({ schedule_id: saved.schedule_id, expected_revision: saved.revision, title: 'Changed on arrival' }));
    await choice(page, saved.schedule_id).click(); await expect(panel(page).getByRole('alert')).toContainText('changed');
    await expect(panel(page).getByRole('article')).toHaveCount(0); expect(new URL(page.url()).hash).toBe(detailHash(saved));
    await panel(page).getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(card(page, saved.schedule_id)).toContainText('Changed on arrival'); expect(mutations(f)).toEqual([]);
  } finally { f.dispose(); }
});

test('names missing direct links without falling back to another saved prompt and keeps management explicit', async ({ page }) => {
  const f = await prepare(page);
  try {
    const saved = await f.seed(); await go(page, detailHash(saved));
    await expect(card(page, saved.schedule_id)).toBeVisible(); expect(mutations(f)).toEqual([]);
    await card(page, saved.schedule_id).getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('button', { name: 'Back to schedules', exact: true }).click();
    await expect(panel(page).getByRole('alert')).toContainText('Save, keep for later, or cancel');
    await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await card(page, saved.schedule_id).getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(card(page, saved.schedule_id).getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
    expect(mutations(f)).toEqual([{ method: 'chat.schedule.pause', args: { schedule_id: saved.schedule_id, expected_revision: saved.revision } }]);
    await hash(page, '#automation/schedules/prompt/missing-prompt');
    await expect(panel(page).getByRole('alert')).toContainText('no longer exists'); await expect(panel(page).getByRole('article')).toHaveCount(0); expect(f.runs()).toBe(0);
  } finally { f.dispose(); }
});

test('keeps confirmed results on refresh failure, retries, and distinguishes unsupported and malformed lists from empty', async ({ page }) => {
  const f = await prepare(page);
  try {
    const saved = await f.seed(); await go(page); await search(page, 'Kestrel'); await type(page).selectOption('scheduled_prompt');
    f.failNextList(); await found(page).getByRole('button', { name: 'Refresh scheduled prompts', exact: true }).click();
    await expect(found(page).getByRole('alert')).toContainText('interrupted'); await expect(choice(page, saved.schedule_id)).toBeVisible();
    f.listMode('unsupported'); await found(page).getByRole('button', { name: 'Refresh scheduled prompts', exact: true }).click();
    await expect(found(page)).toContainText('unavailable on this server'); await expect(found(page)).not.toContainText('No saved scheduled prompts match');
    f.listMode('malformed'); await found(page).getByRole('button', { name: 'Refresh scheduled prompts', exact: true }).click();
    await expect(found(page).getByRole('alert')).toContainText('could not be confirmed');
    f.listMode('normal'); await found(page).getByRole('button', { name: 'Refresh scheduled prompts', exact: true }).click();
    await expect(found(page).getByRole('alert')).toHaveCount(0); await expect(choice(page, saved.schedule_id)).toBeVisible();
    await searchbox(page).fill('absent request'); await expect(found(page)).toContainText('No saved scheduled prompts match this search.');
  } finally { f.dispose(); }
});

test('a delayed list uses the latest query and a delayed selection cannot override a newer query or navigation', async ({ page }) => {
  const f = await prepare(page);
  try {
    const saved = await f.seed(), other = await f.seed({ title: 'Zebra briefing' }); await go(page, '#data/search'); f.holdNextList();
    await searchbox(page).fill('Kestrel'); await expect.poll(f.listPending).toBe(true);
    await searchbox(page).fill('Zebra'); f.releaseList();
    await expect(choice(page, other.schedule_id)).toBeVisible(); await expect(choice(page, saved.schedule_id)).toHaveCount(0);
    f.holdNextList(); await choice(page, other.schedule_id).click(); await expect.poll(f.listPending).toBe(true);
    await searchbox(page).fill('Kestrel'); f.releaseList();
    await expect(choice(page, saved.schedule_id)).toBeVisible(); expect(new URL(page.url()).hash).toBe('#data/search');
    f.holdNextList(); await choice(page, saved.schedule_id).click(); await expect.poll(f.listPending).toBe(true);
    await hash(page, '#automation/schedules'); await expect(panel(page)).toBeVisible(); f.releaseList();
    await expect(panel(page).getByRole('searchbox', { name: 'Search scheduled prompts', exact: true })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#automation/schedules'); expect(mutations(f)).toEqual([]);
  } finally { f.dispose(); }
});
