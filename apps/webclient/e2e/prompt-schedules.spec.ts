import { test, expect, type Route } from '@playwright/test';
import { build } from 'esbuild';
import type { Dish, PromptSchedule, PromptScheduleInput, ServerSchedule } from '@recued/contracts';

let harnessScript: string;
const manualScheduleFixture = (scope: string): PromptSchedule => ({ schedule_id: 'audit-manual', session_id: 'scheduled-session',
  title: 'Audit briefing', prompt: 'Summarize my work mail.', mode: 'recurring', time_zone: 'UTC', cron_expression: '0 9 * * *',
  enabled: true, revision: 1, created_at: 1, next_run_at: Date.now() + 86400000, last_run_at: Date.now() - 3600000,
  last_turn_id: 'last-turn', last_status: 'completed', last_outcome: { status: 'finished', message_id: 'last-answer' },
  run_now_available: true, run_request_scope: scope });
const overviewFixtures = () => {
  const first = Date.now() + 3600000, base = manualScheduleFixture('overview');
  const rows: PromptSchedule[] = [
    { ...base, schedule_id: 'morning', session_id: 'morning-chat', title: 'Morning briefing', next_run_at: first },
    { ...base, schedule_id: 'approval', session_id: 'approval-chat', title: 'Waiting approval', enabled: false, next_run_at: null,
      pending_approvals: { count: 1, plan_id: 'approve-1' }, run_now_available: false },
    { ...base, schedule_id: 'failed', session_id: 'failed-chat', title: 'Failed briefing', next_run_at: first + 7200000,
      last_status: 'failed', last_outcome: { status: 'failed', reason: 'turn_failed', message_id: 'failed-answer' } },
    { ...base, schedule_id: 'finished', session_id: 'finished-chat', title: 'Finished one-off', enabled: false,
      mode: 'one_shot', run_at: first - 7200000, next_run_at: null },
  ];
  const recipe: ServerSchedule = { schedule_id: 'recipe-later', recipe_id: 'fixture-later', publisher_id: 'core',
    dish_id: 'recipe-instance',
    cron_expression: '0 11 * * *', enabled: true, created_at: 1, last_run_at: null, last_status: null, last_error: null,
    next_run_at: first + 3600000 };
  const dish: Dish = { dish_id: 'recipe-instance', recipe_id: recipe.recipe_id, publisher_id: 'core', name: '',
    is_default: true, config_overlay: {}, enabled: true, created_at: 1 };
  return { rows, recipe, dish };
};
test.beforeAll(async () => {
  const built = await build({ entryPoints: ['apps/webclient/e2e/harness/prompt-schedules-harness.ts'], bundle: true, write: false,
    platform: 'browser', format: 'esm', target: 'es2022', resolveExtensions: ['.ts', '.tsx', '.js', '.json'],
    tsconfig: 'apps/webclient/tsconfig.json', logLevel: 'silent' });
  harnessScript = built.outputFiles[0]!.text;
});
test.beforeEach(async ({ context }) => {
  await context.route('**/prompt-harness.js', route => route.fulfill({ contentType: 'text/javascript', body: harnessScript }));
  await context.route('**/prompt-harness.html*', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}#app{height:100dvh}</style></head><body><main id="app"></main><script type="module" src="/prompt-harness.js"></script></body></html>' }));
});

test('Chat and Automation manage the same scheduled prompt and preserve edits during refresh', async ({ context, page, browserName }) => {
  let schedule: PromptSchedule | undefined;
  let hasRun = false;
  const writes: string[] = [];
  const session = { id: 'scheduled-session', title: 'Morning mail', archived: false, created_at: 1, last_active_at: 2,
    picker_state: { current: 'self' }, model_routing: { current: 'byok', provider: 'local', model_id: 'fixture', overridden: false } };
  await context.route('**/prompt-rpc', async route => {
    const { method, args } = route.request().postDataJSON();
    let result: unknown = {};
    if (method === 'recipe.list') result = { recipes: [] };
    if (method === 'chat.schedules.list') result = schedule ? [schedule] : [];
    if (method === 'chat.schedule.preview') {
      const next = Date.UTC(new Date().getUTCFullYear() + 1, 0, 20, 17);
      result = { mode: args.mode, time_zone: args.time_zone, calculated_at: Date.now(),
        next_runs: args.mode === 'one_shot' ? [Date.parse(args.run_at)] : [next, next + 86400000, next + 172800000] };
    }
    if (method === 'chat.schedule.create') {
      const input = args as PromptScheduleInput;
      schedule = { ...input, run_at: undefined, schedule_id: 'prompt-1', session_id: session.id, enabled: true, revision: 1,
        created_at: Date.now(), next_run_at: Date.now() + 3600000, last_run_at: null, last_turn_id: null, last_status: null };
      result = schedule; writes.push(method);
    }
    if (schedule && ['chat.schedule.pause', 'chat.schedule.resume', 'chat.schedule.update', 'chat.schedule.remove'].includes(method)) {
      if (args.expected_revision !== schedule.revision) { await route.fulfill({ json: { error: 'The schedule changed. Reload it before editing.' } }); return; }
      writes.push(method);
      if (method === 'chat.schedule.remove') { schedule = undefined; result = null; }
      else { schedule = { ...schedule, ...args, revision: schedule.revision + 1,
        last_status: method === 'chat.schedule.pause' ? 'running' : schedule.last_status,
        enabled: method === 'chat.schedule.pause' ? false : method === 'chat.schedule.resume' ? true : schedule.enabled }; result = schedule; }
    }
    if (method === 'chat.sessions.list') result = { sessions: [{ ...session, message_count: 1 }] };
    if (method === 'chat.session.get') result = { ...session, plans: [], messages: hasRun ? [{ id: 'm1', session_id: session.id,
      role: 'assistant', contributor: 'model', content: 'Your saved summary.', target_server: 'self', ts: 1,
      picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: 'fixture', instance_id: 'schedule' } },
      model_used: { provider: 'local', model_id: 'fixture' } }] : [] };
    if (method === 'chat.turns.list') result = { generation: 'g', revision: 1, turns: [] };
    if (method === 'chat.default_model_pref.get') result = { source_id: null, updated_at: 1 };
    if (method === 'server.getLLMConfig') result = { config: { slot_1: { provider: 'anthropic', model: 'fixture', has_key: true } } };
    if (method === 'prefs.get') result = { prefs: {} };
    await route.fulfill({ json: { result } });
  });
  await page.goto('/prompt-harness.html?automation');
  const automation = page.locator('[data-prompt-schedules]');
  await page.getByRole('button', { name: 'Add schedule', exact: true }).click();
  await page.getByLabel('Schedule type', { exact: true }).selectOption('prompt');
  await automation.getByLabel('Title', { exact: true }).fill('Morning mail');
  await automation.getByLabel('Request to run').fill('Summarize unread work mail.');
  await automation.getByLabel('Run', { exact: true }).selectOption('recurring');
  await automation.getByLabel('Recurring timezone').fill('America/Los_Angeles');
  await automation.getByRole('button', { name: 'Create schedule' }).click();
  await expect(automation.getByRole('link', { name: 'Open conversation' })).toHaveAttribute('href', '#chat/session/scheduled-session');
  expect(schedule?.cron_expression).toBe('0 9 * * *');
  const chat = await context.newPage(); await chat.goto('/prompt-harness.html');
  const panel = chat.locator('[data-prompt-schedules]');
  await panel.locator('summary').click();
  await expect(panel.getByRole('article', { name: 'Morning mail' }).getByText('Active', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(panel.getByRole('article', { name: 'Morning mail' }).getByText('Paused', { exact: true })).toBeVisible();
  const refresh = automation.getByRole('button', { name: 'Refresh', exact: true });
  await refresh.press('Enter');
  await expect(automation.getByRole('article', { name: 'Morning mail' }).getByText('Paused', { exact: true })).toBeVisible();
  await expect(refresh).toBeFocused();
  hasRun = true; await chat.reload(); await panel.locator('summary').click();
  await panel.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Schedule preview' }).getByRole('heading')).toContainText('Next runs if resumed');
  await panel.getByLabel('Request to run').fill('Summarize unread work mail and flag urgent items.');
  await chat.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Save or cancel this schedule draft');
  await expect(panel.getByLabel('Request to run')).toHaveValue('Summarize unread work mail and flag urgent items.');
  await panel.getByLabel('Request to run').focus();
  await chat.evaluate(() => (window as unknown as { promptEvent(event: unknown): void }).promptEvent({ kind: 'chat.session_changed', session_id: 'scheduled-session', field: 'queue', value: true }));
  await expect(panel.getByLabel('Request to run')).toHaveValue('Summarize unread work mail and flag urgent items.');
  await expect(panel.getByLabel('Request to run')).toBeFocused();
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(panel.getByRole('article', { name: 'Morning mail' }).getByText('Paused', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(panel.getByRole('article', { name: 'Morning mail' }).getByText('Active', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(panel).toContainText('Its conversation stays.');
  await chat.evaluate(() => (window as unknown as { promptEvent(event: unknown): void }).promptEvent({ kind: 'chat.session_changed', session_id: 'scheduled-session', field: 'queue', value: true }));
  await expect(panel.getByRole('button', { name: 'Keep schedule', exact: true })).toBeFocused();
  await chat.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
  await expect(panel.getByRole('button', { name: 'Remove schedule', exact: true })).toBeFocused();
  await chat.keyboard.press('Enter');
  await expect(panel).toContainText('No scheduled prompt is linked');
  await expect(panel.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused();
  await expect(chat.getByText('Your saved summary.')).toBeVisible();
  expect(writes).toEqual(['chat.schedule.create', 'chat.schedule.pause', 'chat.schedule.update', 'chat.schedule.resume', 'chat.schedule.remove']);
  await chat.close();
});

test('Automation offers alarm, prompt and recipe, and keeps an alarm draft through refresh and a failed save', async ({ context, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const creates: Array<{ text: string; at: number; creation_id: string }> = [];
  let complete!: () => void;
  const saving = new Promise<void>(resolve => { complete = resolve; });
  await context.route('**/prompt-rpc', async route => {
    const { method, args } = route.request().postDataJSON();
    let result: unknown = {};
    if (method === 'chat.schedules.list') result = [];
    if (method === 'recipe.list') {
      await route.fulfill({ json: { error: 'Recipes are temporarily unavailable.' } }); return;
    }
    if (method === 'reminder.create') {
      creates.push(args);
      if (creates.length === 1) {
        await route.fulfill({ json: { error: 'Could not save this alarm.' } }); return;
      }
      await saving;
      result = { reminder: { reminder_id: 'alarm-1', text: args.text, at: args.at, state: 'pending', time_zone: 'America/New_York', delivered_at: null },
        when: '9:00 AM', confirmation: '9:00 AM. Quiet hours delay delivery until 10:00 AM.' };
    }
    await route.fulfill({ json: { result } });
  });
  await page.goto('/prompt-harness.html?automation');
  const add = page.getByRole('button', { name: 'Add schedule', exact: true });
  await add.click();
  const kind = page.getByLabel('Schedule type', { exact: true });
  await expect(kind.locator('option')).toHaveText(['Choose what to schedule…', 'Alarm — send a reminder', 'Prompt — run an AI request', 'Recipe — run an installed recipe']);
  await kind.selectOption('alarm');
  await page.getByLabel('Alarm message', { exact: true }).fill('Discard this draft');
  await page.locator('[data-automation-alarm-form]').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(add).toBeFocused();
  await add.click(); await kind.selectOption('alarm');
  const message = page.getByLabel('Alarm message', { exact: true });
  await expect(message).toHaveValue('');
  await message.fill('Call the dentist');
  const time = page.getByLabel('Date and time (America/New_York)', { exact: true });
  const year = new Date().getUTCFullYear() + 1;
  await time.fill(`${year}-01-20T09:00`);
  await message.focus();
  await page.evaluate(() => (window as unknown as { promptEvent(event: unknown): void }).promptEvent({ kind: 'automation_rule_changed', mechanism: 'schedule', cursor: 2 }));
  await expect(message).toHaveValue('Call the dentist');
  await expect(message).toBeFocused();
  const save = page.locator('[data-automation-alarm-form] button[type="submit"]');
  await save.click();
  await expect(page.locator('[data-automation-alarm-form]').getByRole('alert')).toContainText('Could not save this alarm.');
  await expect(message).toHaveValue('Call the dentist');
  await expect(time).toHaveValue(`${year}-01-20T09:00`);
  await save.click();
  try {
    await expect(save).toBeDisabled();
    await expect(save).toHaveText('Creating alarm…');
    await expect.poll(() => creates.length).toBe(2);
    await page.locator('[data-automation-alarm-form]').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(creates.map(({ text, at }) => ({ text, at }))).toEqual([{ text: 'Call the dentist', at: Date.UTC(year, 0, 20, 14) }, { text: 'Call the dentist', at: Date.UTC(year, 0, 20, 14) }]);
    expect(creates[0]?.creation_id).toBeTruthy();
    expect(creates[1]?.creation_id).toBe(creates[0]?.creation_id);
  } finally { complete(); }
  await expect(page.locator('.automation-alarm-notice')).toContainText('Quiet hours delay delivery until 10:00 AM.');
  await expect(page.getByRole('link', { name: 'View or change alarms' })).toHaveAttribute('href', '#data/reminder');
  await expect(add).toBeFocused();
  expect(await page.locator('[data-recued-automation-route]').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('editing a one-off prompt preserves its clock and exact instant, and a late pause does not steal focus', async ({ context, page }) => {
  const at = Date.UTC(new Date().getUTCFullYear() + 1, 0, 20, 14, 0, 27);
  let schedule: PromptSchedule = { schedule_id: 'once', session_id: 'scheduled-session', title: 'One-off review', prompt: 'Review my mail.',
    mode: 'one_shot', time_zone: 'America/New_York', run_at: at, enabled: true, revision: 1,
    created_at: Date.now(), next_run_at: at, last_run_at: null, last_turn_id: null, last_status: null };
  let update: Record<string, unknown> | undefined;
  let previewArgs: Record<string, unknown> | undefined;
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  await context.route('**/prompt-rpc', async route => {
    const { method, args } = route.request().postDataJSON();
    let result: unknown = {};
    if (method === 'recipe.list') result = { recipes: [] };
    if (method === 'chat.schedules.list') result = [schedule];
    if (method === 'chat.schedule.preview') {
      previewArgs = args; result = { mode: args.mode, time_zone: args.time_zone, calculated_at: Date.now(), next_runs: [Date.parse(args.run_at)] };
    }
    if (method === 'chat.schedule.update') {
      update = args; schedule = { ...schedule, prompt: args.prompt, revision: 2 }; result = schedule;
    }
    if (method === 'chat.schedule.pause') {
      await pending; schedule = { ...schedule, enabled: false, revision: 3, next_run_at: null }; result = schedule;
    }
    await route.fulfill({ json: { result } });
  });
  await page.goto('/prompt-harness.html?automation');
  const panel = page.locator('[data-prompt-schedules]');
  await panel.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(panel.getByLabel('Date and time (America/New_York)', { exact: true })).toHaveValue(`${new Date(at).getUTCFullYear()}-01-20T09:00`);
  const preview = panel.getByRole('region', { name: 'Schedule preview' });
  await expect(preview.locator('time')).toHaveAttribute('datetime', new Date(at).toISOString());
  expect(previewArgs).toEqual({ mode: 'one_shot', time_zone: 'America/New_York', run_at: new Date(at).toISOString() });
  await expect(preview.locator('time')).toContainText('00:27');
  await panel.getByLabel('Request to run').fill('Review unread mail only.');
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  expect(update).toMatchObject({ run_at: new Date(at).toISOString(), time_zone: 'America/New_York', prompt: 'Review unread mail only.' });
  await panel.getByRole('button', { name: 'Pause', exact: true }).click();
  const add = page.getByRole('button', { name: 'Add schedule', exact: true });
  await add.focus(); complete();
  await expect(panel.getByRole('article', { name: 'One-off review' }).getByText('Paused', { exact: true })).toBeVisible();
  await expect(add).toBeFocused();
});

test('Automation separates scheduling from outcomes and keeps older approvals linked until they are resolved', async ({ context, page }) => {
  const base: PromptSchedule = { schedule_id: 'briefing', session_id: 'scheduled-session', title: 'Morning briefing',
    prompt: 'Summarize my work mail.', mode: 'recurring', time_zone: 'UTC', cron_expression: '0 9 * * *',
    enabled: true, revision: 1, created_at: 1, next_run_at: Date.now() + 3600000,
    last_run_at: Date.now() - 3600000, last_turn_id: 'latest-turn', last_status: 'completed',
    last_outcome: { status: 'finished', message_id: 'latest/answer' },
    pending_approvals: { count: 2, plan_id: 'older/approval', message_id: 'older/answer' } };
  let schedule = base;
  const failed: PromptSchedule = { ...base, schedule_id: 'failed', session_id: 'failed-session', title: 'Failed lookup',
    enabled: false, pending_approvals: null, last_outcome: { status: 'failed', reason: 'tool_failed', message_id: 'failed-answer' } };
  const interrupted: PromptSchedule = { ...base, schedule_id: 'interrupted', session_id: 'interrupted-session', title: 'Interrupted request',
    mode: 'one_shot', run_at: Date.now() - 3600000, enabled: false, next_run_at: null, pending_approvals: null,
    last_outcome: { status: 'interrupted', reason: 'outcome_unknown', message_id: 'interrupted-answer' } };
  const methods: string[] = [];
  await context.route('**/prompt-rpc', async route => {
    const { method } = route.request().postDataJSON(); methods.push(method);
    await route.fulfill({ json: { result: method === 'recipe.list' ? { recipes: [] }
      : method === 'chat.schedules.list' ? [schedule, failed, interrupted] : {} } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/prompt-harness.html?automation');
  const card = page.getByRole('article', { name: 'Morning briefing', exact: true });
  await expect(card.getByText('Active', { exact: true })).toBeVisible();
  await expect(card.locator('dl')).toContainText('Finished');
  await expect(card).toContainText('2 actions need your approval.');
  const review = card.getByRole('link', { name: 'Review approval' });
  await expect(review).toHaveAttribute('href', '#chat/session/scheduled-session/plan/older%2Fapproval/answer/older%2Fanswer');
  await review.focus();
  schedule = { ...schedule, pending_approvals: { count: 1, plan_id: 'remaining' } };
  await page.evaluate(() => (window as unknown as { promptEvent(event: unknown): void }).promptEvent({
    kind: 'chat.plan_resolved', session_id: 'scheduled-session' }));
  await expect(card).toContainText('1 action needs your approval.');
  await expect(review).toBeFocused();
  schedule = { ...schedule, pending_approvals: null };
  await page.evaluate(() => (window as unknown as { promptEvent(event: unknown): void }).promptEvent({
    kind: 'chat.message_complete', session_id: 'scheduled-session' }));
  await expect(card.getByRole('link', { name: 'View last run' })).toHaveAttribute('href', '#chat/session/scheduled-session/answer/latest%2Fanswer');
  await expect(card).not.toContainText('needs your approval');
  schedule = { ...schedule, pending_work: { status: 'running', plan_id: 'older-running-action' }, run_now_available: false };
  await page.evaluate(() => (window as unknown as { promptEvent(event: unknown): void }).promptEvent({
    kind: 'chat.tool_call_completed', session_id: 'scheduled-session' }));
  await expect(card.getByRole('link', { name: 'View waiting run' })).toHaveAttribute('href', '#chat/session/scheduled-session/plan/older-running-action');
  await expect(card).toContainText('An action is still running.');
  await expect(card.locator('dl')).toContainText('Finished');
  await expect(card.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
  const failedCard = page.getByRole('article', { name: 'Failed lookup', exact: true });
  await expect(failedCard.getByText('Paused', { exact: true })).toBeVisible();
  await expect(failedCard.locator('dl')).toContainText('Failed');
  await expect(failedCard).toContainText('An action or lookup reported an error.');
  const interruptedCard = page.getByRole('article', { name: 'Interrupted request', exact: true });
  await expect(interruptedCard.getByText('No future runs', { exact: true })).toBeVisible();
  await expect(interruptedCard.locator('dl')).toContainText('Interrupted');
  await expect(interruptedCard).toContainText('Check what completed before running it again.');
  expect(methods.every(method => ['recipe.list', 'dishes.list', 'schedules.list', 'chat.schedules.list'].includes(method))).toBe(true);
});

test('Chat preserves drafts through outcome changes and runs the saved request without sending the composer', async ({ context, page }) => {
  let schedule: PromptSchedule = { schedule_id: 'draft-outcome', session_id: 'scheduled-session', title: 'Mail review',
    prompt: 'Review my mail.', mode: 'recurring', time_zone: 'UTC', cron_expression: '0 9 * * *',
    enabled: true, revision: 1, created_at: 1, next_run_at: Date.now() + 3600000,
    last_run_at: Date.now() - 3600000, last_turn_id: 'turn', last_status: 'completed',
    last_outcome: { status: 'needs_approval', plan_id: 'mail-approval', message_id: 'review-answer' },
    pending_approvals: { count: 1, plan_id: 'mail-approval', message_id: 'review-answer' } };
  const session = { id: schedule.session_id, title: schedule.title, archived: false, created_at: 1, last_active_at: 2,
    picker_state: { current: 'self' }, model_routing: { current: 'byok', provider: 'local', model_id: 'fixture', overridden: false } };
  let reads = 0;
  const methods: string[] = [], runs: Array<Record<string, unknown>> = [];
  await context.route('**/prompt-rpc', async route => {
    const { method, args } = route.request().postDataJSON(); methods.push(method); let result: unknown = {};
    if (method === 'chat.schedule.run_now') {
      runs.push(args); schedule = { ...schedule, last_status: 'queued', last_outcome: { status: 'queued' }, run_now_available: false };
      result = { turn_id: 'manual-turn', status: 'queued', disposition: 'accepted' };
    }
    if (method === 'chat.schedules.list') { ++reads; result = [schedule]; }
    if (method === 'chat.sessions.list') result = { sessions: [{ ...session, message_count: 0 }] };
    if (method === 'chat.session.get') result = { ...session, plans: [], messages: [] };
    if (method === 'chat.turns.list') result = { generation: 'g', revision: 1, turns: [] };
    if (method === 'chat.default_model_pref.get') result = { source_id: null, updated_at: 1 };
    if (method === 'server.getLLMConfig') result = { config: { slot_1: { provider: 'anthropic', model: 'fixture', has_key: true } } };
    if (method === 'prefs.get') result = { prefs: {} };
    await route.fulfill({ json: { result } });
  });
  await page.goto('/prompt-harness.html');
  const panel = page.locator('[data-prompt-schedules]'); await panel.locator('summary').click();
  await expect(panel.locator('dl')).toContainText('Needs approval');
  await expect(panel.getByRole('link', { name: 'Review approval' })).toHaveAttribute('href', '#chat/session/scheduled-session/plan/mail-approval/answer/review-answer');
  await panel.getByRole('button', { name: 'Edit', exact: true }).click();
  await panel.getByLabel('Request to run').fill('Review only urgent mail.');
  const before = reads;
  schedule = { ...schedule, pending_approvals: null, last_outcome: { status: 'finished', message_id: 'sent-answer' }, run_now_available: true };
  await page.evaluate(() => (window as unknown as { promptEvent(event: unknown): void }).promptEvent({
    kind: 'chat.tool_call_completed', session_id: 'scheduled-session' }));
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(panel.getByLabel('Request to run')).toHaveValue('Review only urgent mail.');
  await expect(panel.getByLabel('Request to run')).toBeFocused();
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(panel.locator('dl')).toContainText('Finished');
  await expect(panel.getByRole('link', { name: 'View last run' })).toHaveAttribute('href', '#chat/session/scheduled-session/answer/sent-answer');
  const composer = page.locator('[data-recued-chat-route-input]');
  await composer.fill('Keep this separate unsent question.');
  await panel.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
  await expect(panel.locator('dl')).toContainText('Queued');
  await expect(composer).toHaveValue('Keep this separate unsent question.');
  expect(runs).toEqual([{ schedule_id: schedule.schedule_id, expected_revision: 1, submission_id: expect.any(String) }]);
  expect(methods).not.toContain('chat.send');
});

test('Run now keeps a paused schedule unchanged and recovers a lost reply across reload with the same request', async ({ context, page }) => {
  let schedule: PromptSchedule = { schedule_id: 'manual-ui', session_id: 'scheduled-session', title: 'Paused briefing',
    prompt: 'Summarize my work mail.', mode: 'recurring', time_zone: 'America/Los_Angeles', cron_expression: '0 9 * * 1-5',
    enabled: false, revision: 3, created_at: 1, next_run_at: null, last_run_at: null, last_turn_id: null, last_status: null,
    run_now_available: true };
  const requests: Array<Record<string, unknown>> = [], admitted = new Map<string, string>();
  let release!: () => void; const lostReply = new Promise<void>(resolve => { release = resolve; });
  await context.route('**/prompt-rpc', async route => {
    const { method, args } = route.request().postDataJSON(); let result: unknown = {};
    if (method === 'recipe.list') result = { recipes: [] };
    if (method === 'chat.schedules.list') result = [schedule];
    if (method === 'chat.schedule.run_now') {
      requests.push(args);
      const replay = admitted.get(args.submission_id);
      const turn = replay ?? `manual-${admitted.size + 1}`;
      if (!replay) {
        admitted.set(args.submission_id, turn);
        schedule = { ...schedule, last_run_at: Date.now(), last_turn_id: turn, last_status: 'queued',
          last_outcome: { status: 'queued' }, run_now_available: false };
      }
      if (requests.length === 1) { await lostReply; await route.abort('failed'); return; }
      result = { turn_id: turn, status: 'queued', disposition: replay ? 'replayed' : 'accepted' };
    }
    await route.fulfill({ json: { result } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/prompt-harness.html?automation');
  const card = page.getByRole('article', { name: 'Paused briefing', exact: true });
  await card.getByRole('button', { name: 'Run now', exact: true }).click();
  try {
    const busy = card.getByRole('button', { name: 'Retry Run now', exact: true });
    await expect(busy).toBeDisabled();
    await expect.poll(() => requests.length).toBe(1);
    await busy.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(requests).toHaveLength(1);
  } finally { release(); }
  await expect(page.locator('[data-prompt-schedules]').getByRole('alert')).toContainText('Retry Run now will use the same request.');
  await expect(card.getByRole('button', { name: 'Retry Run now', exact: true })).toBeEnabled();
  await page.reload();
  await card.getByRole('button', { name: 'Retry Run now', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
  await expect(card.getByText('Paused', { exact: true })).toBeVisible();
  await expect(card.locator('dl')).toContainText('Queued');
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(admitted.size).toBe(1);
  expect(schedule).toMatchObject({ enabled: false, revision: 3, next_run_at: null, cron_expression: '0 9 * * 1-5' });
  schedule = { ...schedule, last_status: 'completed', last_outcome: { status: 'finished', message_id: 'manual-result' }, run_now_available: true };
  await page.evaluate(() => (window as unknown as { promptEvent(event: unknown): void }).promptEvent({
    kind: 'chat.message_complete', session_id: 'scheduled-session' }));
  await expect(card.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled();
  await card.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2]!.submission_id).not.toBe(requests[0]!.submission_id); expect(admitted.size).toBe(2);
  await expect(card.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
});

test('timing previews use the selected timezone and ignore an older reply without sending the request text', async ({ context, page }) => {
  let release!: () => void; const late = new Promise<void>(resolve => { release = resolve; });
  const previews: Array<Record<string, unknown>> = [], methods: string[] = [];
  await context.route('**/prompt-rpc', async route => {
    const { method, args } = route.request().postDataJSON(); methods.push(method); let result: unknown = {};
    if (method === 'recipe.list') result = { recipes: [] };
    if (method === 'chat.schedules.list') result = [];
    if (method === 'chat.schedule.preview') {
      previews.push(args);
      if (args.time_zone === 'Bad/Zone') { await route.fulfill({ json: { error: 'Choose a valid IANA timezone.' } }); return; }
      if (args.mode === 'one_shot') result = { mode: args.mode, time_zone: args.time_zone, calculated_at: Date.now(), next_runs: [Date.parse(args.run_at)] };
      else {
        if (args.time_zone === 'America/New_York') await late;
        const times = args.time_zone === 'America/New_York'
          ? ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', '2026-11-02T06:30:00Z']
          : ['2026-11-01T08:30:00Z', '2026-11-01T09:30:00Z', '2026-11-02T09:30:00Z'];
        result = { mode: args.mode, time_zone: args.time_zone, calculated_at: Date.parse('2026-11-01T04:00:00Z'), next_runs: times.map(time => Date.parse(time)) };
      }
    }
    await route.fulfill({ json: { result } });
  });
  await page.goto('/prompt-harness.html?automation');
  await page.getByRole('button', { name: 'Add schedule', exact: true }).click();
  await page.getByLabel('Schedule type', { exact: true }).selectOption('prompt');
  const panel = page.locator('[data-prompt-schedules]');
  await panel.getByLabel('Title', { exact: true }).fill('Keep my briefing draft');
  await panel.getByLabel('Request to run').fill('Private request text stays out of timing previews.');
  await panel.getByLabel('Run', { exact: true }).selectOption('recurring');
  await panel.getByLabel('Time', { exact: true }).fill('01:30');
  await panel.getByLabel('Recurring timezone').fill('America/New_York');
  await expect.poll(() => previews.some(args => args.time_zone === 'America/New_York')).toBe(true);
  await panel.getByLabel('Recurring timezone').fill('America/Los_Angeles');
  const preview = panel.getByRole('region', { name: 'Schedule preview' });
  await expect(preview.getByRole('heading')).toContainText('America/Los_Angeles');
  await expect(preview.locator('time').first()).toHaveAttribute('datetime', '2026-11-01T08:30:00.000Z');
  await expect(preview).toContainText('GMT-7'); await expect(preview).toContainText('GMT-8');
  const lateResponse = page.waitForResponse(response => response.url().endsWith('/prompt-rpc')
    && response.request().postDataJSON().args?.time_zone === 'America/New_York');
  release(); await (await lateResponse).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect(preview.getByRole('heading')).toContainText('America/Los_Angeles');
  await expect(preview.locator('time').first()).toHaveAttribute('datetime', '2026-11-01T08:30:00.000Z');
  await expect(panel.getByLabel('Title', { exact: true })).toHaveValue('Keep my briefing draft');
  await expect(panel.getByLabel('Recurring timezone')).toBeFocused();
  await expect(panel.getByLabel('Request to run')).toHaveValue('Private request text stays out of timing previews.');
  expect(previews.every(args => !('prompt' in args) && !('title' in args))).toBe(true);
  await panel.getByLabel('Recurring timezone').fill('Bad/Zone');
  await expect(preview).toContainText('Choose a valid IANA timezone.');
  await expect(preview.locator('time')).toHaveCount(0);
  expect(methods.every(method => ['recipe.list', 'dishes.list', 'schedules.list', 'chat.schedules.list', 'chat.schedule.preview'].includes(method))).toBe(true);
});

test('one-off previews reject a nonexistent local time and recover a failed preview without losing the draft', async ({ context, page }) => {
  const year = new Date().getUTCFullYear() + 1;
  const day = 8 + (7 - new Date(Date.UTC(year, 2, 1)).getUTCDay()) % 7;
  const wallClock = `${year}-03-${String(day).padStart(2, '0')}`;
  const at = Date.UTC(year, 0, 20, 14);
  const expected = new Date(Date.UTC(year, 2, day, 7, 30)).toISOString();
  let schedule: PromptSchedule = { schedule_id: 'preview-one-off', session_id: 'scheduled-session', title: 'One-off briefing',
    prompt: 'Review my mail.', mode: 'one_shot', time_zone: 'America/New_York', run_at: at,
    enabled: true, revision: 1, created_at: 1, next_run_at: at, last_run_at: null, last_turn_id: null, last_status: null };
  const previews: Array<Record<string, unknown>> = [], updates: Array<Record<string, unknown>> = [];
  let chosenTimePreviews = 0;
  await context.route('**/prompt-rpc', async route => {
    const { method, args } = route.request().postDataJSON(); let result: unknown = {};
    if (method === 'recipe.list') result = { recipes: [] };
    if (method === 'chat.schedules.list') result = [schedule];
    if (method === 'chat.schedule.preview') {
      previews.push(args);
      if (args.run_at === expected && ++chosenTimePreviews === 1) { await route.fulfill({ json: { error: 'Timing preview is temporarily unavailable.' } }); return; }
      result = { mode: args.mode, time_zone: args.time_zone, calculated_at: Date.now(), next_runs: [Date.parse(args.run_at)] };
    }
    if (method === 'chat.schedule.update') { updates.push(args); schedule = { ...schedule, prompt: args.prompt, run_at: Date.parse(args.run_at), revision: 2 }; result = schedule; }
    await route.fulfill({ json: { result } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/prompt-harness.html?automation');
  const panel = page.locator('[data-prompt-schedules]'); await panel.getByRole('button', { name: 'Edit', exact: true }).click();
  await panel.getByLabel('Date and time (America/New_York)', { exact: true }).fill(`${wallClock}T02:30`);
  const preview = panel.getByRole('region', { name: 'Schedule preview' });
  await expect(preview).toContainText('Choose a valid local date and time.');
  expect(previews.some(args => args.run_at === expected)).toBe(false);
  await expect(preview.locator('time')).toHaveCount(0);
  await panel.getByLabel('Request to run').fill('Preserve this edited request.');
  await panel.getByLabel('Date and time (America/New_York)', { exact: true }).fill(`${wallClock}T03:30`);
  await expect(preview).toContainText('Timing preview is temporarily unavailable.');
  await expect(panel.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
  await preview.getByRole('button', { name: 'Retry preview', exact: true }).click();
  await expect(preview.locator('time')).toHaveAttribute('datetime', expected);
  await expect(preview).toContainText('including after downtime');
  await expect(panel.getByLabel('Request to run')).toHaveValue('Preserve this edited request.');
  expect(updates).toHaveLength(0);
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  expect(updates).toEqual([expect.objectContaining({ run_at: expected, time_zone: 'America/New_York', prompt: 'Preserve this edited request.' })]);
});

test('a server without timing previews still saves the schedule without exposing the internal RPC error', async ({ context, page }) => {
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (typeof init?.body === 'string' && JSON.parse(init.body).method === 'chat.schedule.preview') {
        return Promise.reject(Object.assign(new Error('Unknown RPC method chat.schedule.preview'), { code: 'unknown_method' }));
      }
      return fetch(input, init);
    };
  });
  let schedule: PromptSchedule | undefined; const creates: Array<Record<string, unknown>> = [];
  await context.route('**/prompt-rpc', async route => {
    const { method, args } = route.request().postDataJSON(); let result: unknown = {};
    if (method === 'recipe.list') result = { recipes: [] };
    if (method === 'chat.schedules.list') result = schedule ? [schedule] : [];
    if (method === 'chat.schedule.create') {
      creates.push(args); schedule = { ...args, run_at: Date.parse(args.run_at), schedule_id: 'older-server-schedule',
        session_id: 'scheduled-session', enabled: true, revision: 1, created_at: Date.now(), next_run_at: Date.parse(args.run_at),
        last_run_at: null, last_turn_id: null, last_status: null }; result = schedule;
    }
    await route.fulfill({ json: { result } });
  });
  await page.goto('/prompt-harness.html?automation');
  await page.getByRole('button', { name: 'Add schedule', exact: true }).click();
  await page.getByLabel('Schedule type', { exact: true }).selectOption('prompt');
  const panel = page.locator('[data-prompt-schedules]');
  await panel.getByLabel('Title', { exact: true }).fill('Compatible briefing');
  await panel.getByLabel('Request to run').fill('Summarize unread work mail.');
  const preview = panel.getByRole('region', { name: 'Schedule preview' });
  await expect(preview).toContainText('Preview unavailable. You can still save this schedule.');
  await expect(preview).not.toContainText('chat.schedule.preview');
  await panel.getByRole('button', { name: 'Create schedule', exact: true }).click();
  await expect(panel.getByRole('article', { name: 'Compatible briefing' })).toBeVisible();
  expect(creates).toEqual([expect.objectContaining({ title: 'Compatible briefing', prompt: 'Summarize unread work mail.' })]);
});

test('a confirmed Run now refusal clears the retry request and opens the waiting action', async ({ context, page }) => {
  await page.addInitScript(() => {
    const state = window as unknown as { refuseManualRun: boolean }; state.refuseManualRun = true;
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => typeof init?.body === 'string' && JSON.parse(init.body).method === 'chat.schedule.run_now' && state.refuseManualRun
      ? Promise.reject(Object.assign(new Error('This schedule already has a run waiting.'), { code: 'conflict' })) : fetch(input, init);
  });
  let schedule = manualScheduleFixture('first-server'); const runs: unknown[] = [];
  await context.route('**/prompt-rpc', async route => {
    const { method, args } = route.request().postDataJSON(); let result: unknown = {};
    if (method === 'recipe.list') result = { recipes: [] };
    if (method === 'chat.schedules.list') result = [schedule];
    if (method === 'chat.schedule.run_now') {
      runs.push(args); schedule = { ...schedule, run_now_available: false, last_status: 'queued', last_outcome: { status: 'queued' } };
      result = { turn_id: 'accepted-after-review', status: 'queued' };
    }
    await route.fulfill({ json: { result } });
  });
  await page.goto('/prompt-harness.html?automation'); const panel = page.locator('[data-prompt-schedules]');
  await expect(panel.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled();
  schedule = { ...schedule, run_now_available: false, pending_work: { status: 'running', plan_id: 'waiting-action' } };
  await panel.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Retry Run now', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('link', { name: 'View waiting run' })).toHaveAttribute('href', '#chat/session/scheduled-session/plan/waiting-action');
  expect(runs).toHaveLength(0); await page.reload();
  await expect(panel.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
  schedule = { ...schedule, pending_work: null, run_now_available: true };
  await page.evaluate(() => { (window as unknown as { refuseManualRun: boolean }).refuseManualRun = false;
    (window as unknown as { promptEvent(event: unknown): void }).promptEvent({ kind: 'chat.tool_call_completed', session_id: 'scheduled-session' }); });
  await expect(panel.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect.poll(() => runs.length).toBe(1);
});

test('unanswered Run now requests stay with their server when schedule IDs are shared', async ({ context, page }) => {
  let server = 'first-server'; const states = new Map(['first-server', 'second-server'].map(scope => [scope, manualScheduleFixture(scope)]));
  const requests: Array<{ server: string; id: string }> = [], admitted = new Map<string, string>();
  await context.route('**/prompt-rpc', async route => {
    const { method, args } = route.request().postDataJSON(); let result: unknown = {};
    if (method === 'recipe.list') result = { recipes: [] };
    if (method === 'chat.schedules.list') result = [states.get(server)];
    if (method === 'chat.schedule.run_now') {
      requests.push({ server, id: args.submission_id }); const prior = admitted.get(server), turn = prior ?? `${server}-turn`;
      admitted.set(server, turn); states.set(server, { ...states.get(server)!, run_now_available: false,
        last_status: 'queued', last_outcome: { status: 'queued' } });
      if (server === 'first-server' && requests.filter(request => request.server === server).length === 1) { await route.abort('failed'); return; }
      result = { turn_id: turn, status: 'queued', disposition: prior ? 'replayed' : 'accepted' };
    }
    await route.fulfill({ json: { result } });
  });
  await page.goto('/prompt-harness.html?automation'); const panel = page.locator('[data-prompt-schedules]');
  await panel.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Retry Run now', exact: true })).toBeEnabled();
  server = 'second-server'; await page.reload();
  await expect(panel.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
  expect(requests).toHaveLength(2); expect(requests[1]!.id).not.toBe(requests[0]!.id);
  server = 'first-server'; await page.reload();
  await panel.getByRole('button', { name: 'Retry Run now', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
  expect(requests).toEqual([{ server: 'first-server', id: requests[0]!.id },
    { server: 'second-server', id: requests[1]!.id }, { server: 'first-server', id: requests[0]!.id }]);
  expect(admitted.size).toBe(2);
});

test('editing a finished one-off preserves its past time and leaves future runs off', async ({ context, page }) => {
  const at = Math.floor(Date.now() / 60000) * 60000 - 3600000 + 27000;
  let schedule: PromptSchedule = { ...manualScheduleFixture('first-server'), mode: 'one_shot', time_zone: 'UTC', run_at: at,
    enabled: false, next_run_at: null }; const updates: Array<Record<string, unknown>> = [];
  await context.route('**/prompt-rpc', async route => {
    const { method, args } = route.request().postDataJSON(); let result: unknown = {};
    if (method === 'recipe.list') result = { recipes: [] };
    if (method === 'chat.schedules.list') result = [schedule];
    if (method === 'chat.schedule.preview') result = { mode: 'one_shot', time_zone: 'UTC', calculated_at: Date.now(), next_runs: [], past_run_at: Date.parse(args.run_at) };
    if (method === 'chat.schedule.update') { updates.push(args); schedule = { ...schedule, prompt: args.prompt, revision: 2 }; result = schedule; }
    await route.fulfill({ json: { result } });
  });
  await page.goto('/prompt-harness.html?automation'); const panel = page.locator('[data-prompt-schedules]');
  await panel.getByRole('button', { name: 'Edit', exact: true }).click();
  const preview = panel.getByRole('region', { name: 'Schedule preview' });
  await expect(preview.getByRole('heading')).toContainText('Saved time');
  await expect(preview).toContainText('Saving keeps them off');
  await expect(preview.locator('time')).toHaveAttribute('datetime', new Date(at).toISOString());
  await panel.getByLabel('Request to run').fill('Review urgent mail only.');
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(panel.getByText('No future runs', { exact: true })).toBeVisible();
  expect(updates).toEqual([expect.objectContaining({ run_at: new Date(at).toISOString(), prompt: 'Review urgent mail only.' })]);
  await expect(panel.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled();
});

test('Overview includes prompt attention and failures, and Coming up sorts prompts with recipe runs', async ({ context, page }) => {
  const { rows, recipe, dish } = overviewFixtures();
  await context.route('**/prompt-rpc', async route => {
    const { method } = route.request().postDataJSON(); let result: unknown = {};
    if (method === 'recipe.list') result = { recipes: [] };
    if (method === 'schedules.list') result = { schedules: [recipe] };
    if (method === 'dishes.list') result = { dishes: [dish] };
    if (method === 'chat.schedules.list') result = rows;
    await route.fulfill({ json: { result } });
  });
  await page.goto('/prompt-harness.html?automation');
  await expect(page.getByRole('tab', { name: /^Overview\s+5$/ })).toBeVisible();
  await expect(page.getByText('Nothing runs on its own yet.', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'On 2', exact: true })).toBeVisible();
  for (const label of ['Off', 'Needs you', 'Failing']) await expect(page.getByRole('button', { name: `${label} 1`, exact: true })).toBeVisible();
  const prompts = page.locator('[data-prompt-schedules]');
  await page.getByRole('button', { name: 'Needs you 1', exact: true }).click();
  await expect(prompts.getByRole('article')).toHaveCount(1);
  await expect(prompts.getByRole('article', { name: 'Waiting approval' })).toContainText('Paused');
  await expect(prompts.getByRole('link', { name: 'Review approval' })).toHaveAttribute('href', '#chat/session/approval-chat/plan/approve-1');
  await page.getByRole('button', { name: 'Failing 1', exact: true }).click();
  await expect(prompts.getByRole('article')).toHaveCount(1);
  await expect(prompts.getByRole('article', { name: 'Failed briefing' })).toBeVisible();
  await page.getByRole('button', { name: 'Off 1', exact: true }).click();
  await expect(prompts.getByRole('article')).toHaveCount(1);
  await expect(prompts.getByRole('article', { name: 'Finished one-off' })).toContainText('No future runs');
  await page.getByRole('tab', { name: /^Coming up\s+3$/ }).click();
  const coming = page.locator('[data-recued-automation-coming-up]');
  await expect(coming.locator('li')).toHaveCount(3);
  await expect(coming.getByRole('link')).toHaveText(['Morning briefing', 'fixture-later', 'Failed briefing']);
  await expect(coming.getByRole('link', { name: 'Morning briefing' })).toHaveAttribute('href', '#chat/session/morning-chat');
  await expect(coming.locator('li').first()).toContainText('Prompt');
  await expect(coming.locator('li').first()).toContainText('UTC');
  const picker = page.getByRole('combobox', { name: 'Show only one Recipe' });
  await picker.fill('fixture-later');
  await page.getByRole('option', { name: 'fixture-later', exact: true }).click();
  await expect(coming.getByRole('link')).toHaveText(['fixture-later']);
  await expect(page.getByRole('tab', { name: /^Coming up\s+1$/ })).toBeVisible();
  await page.getByRole('tab', { name: /^Overview/ }).click();
  await expect(prompts).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await expect(prompts.getByRole('article', { name: 'Finished one-off' })).toBeVisible();
});

test('Coming up reports pending and failed prompt reads and ignores an older list reply after recovery', async ({ context, page }) => {
  const { rows } = overviewFixtures(); let mode: 'initial' | 'ready' | 'hold' = 'initial';
  let initial: Route | undefined, older: Route | undefined;
  await context.route('**/prompt-rpc', async route => {
    const { method } = route.request().postDataJSON(); let result: unknown = {};
    if (method === 'recipe.list') result = { recipes: [] };
    if (method === 'chat.schedules.list') {
      if (mode === 'initial') { initial = route; return; }
      if (mode === 'hold') { older = route; mode = 'ready'; return; }
      result = [rows[0]];
    }
    await route.fulfill({ json: { result } });
  });
  await page.goto('/prompt-harness.html?automation');
  await page.getByRole('tab', { name: 'Coming up', exact: true }).click();
  await expect(page.getByText('Loading upcoming runs…')).toBeVisible();
  await expect(page.getByText('Nothing is due to run on its own.')).toHaveCount(0);
  await expect.poll(() => !!initial).toBe(true);
  await initial!.fulfill({ json: { error: 'Temporary prompt read failure.' } });
  await expect(page.getByRole('alert')).toContainText('Could not refresh prompt schedules.');
  await expect(page.getByRole('tab', { name: 'Coming up', exact: true })).toBeVisible();
  mode = 'ready'; await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('tab', { name: /^Coming up\s+1$/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Morning briefing' })).toBeVisible();
  mode = 'hold';
  const changed = () => page.evaluate(() => (window as unknown as { promptEvent(event: unknown): void }).promptEvent({ kind: 'chat.session_changed', session_id: 'morning-chat', field: 'queue', value: true }));
  await changed(); await expect.poll(() => !!older).toBe(true);
  rows[0] = { ...rows[0]!, next_run_at: rows[0]!.next_run_at! + 86400000 };
  await changed();
  const time = page.locator('[data-recued-automation-coming-up] time');
  await expect(time).toHaveAttribute('datetime', new Date(rows[0].next_run_at!).toISOString());
  await older!.fulfill({ json: { result: [] } });
  await expect(page.getByRole('tab', { name: /^Coming up\s+1$/ })).toBeVisible();
  await expect(time).toHaveAttribute('datetime', new Date(rows[0].next_run_at!).toISOString());
  await expect(page.getByRole('link', { name: 'Morning briefing' })).toBeVisible();
});

test('prompt drafts survive attention filters, recipe filters, tab changes and background outcome refreshes', async ({ context, page }) => {
  const { rows, recipe, dish } = overviewFixtures();
  await context.route('**/prompt-rpc', async route => {
    const { method, args } = route.request().postDataJSON(); let result: unknown = {};
    if (method === 'recipe.list') result = { recipes: [] };
    if (method === 'schedules.list') result = { schedules: [recipe] };
    if (method === 'dishes.list') result = { dishes: [dish] };
    if (method === 'chat.schedules.list') result = rows;
    if (method === 'chat.schedule.preview') result = { mode: args.mode, time_zone: args.time_zone,
      calculated_at: Date.now(), next_runs: [Date.now() + 86400000] };
    await route.fulfill({ json: { result } });
  });
  await page.goto('/prompt-harness.html?automation');
  const prompts = page.locator('[data-prompt-schedules]');
  await prompts.getByRole('article', { name: 'Morning briefing' }).getByRole('button', { name: 'Edit', exact: true }).click();
  const request = prompts.getByLabel('Request to run'); await request.fill('Only summarize urgent work mail.');
  await page.getByRole('button', { name: 'Needs you 1', exact: true }).click();
  await expect(request).toHaveValue('Only summarize urgent work mail.');
  const picker = page.getByRole('combobox', { name: 'Show only one Recipe' });
  await picker.fill('fixture-later'); await page.getByRole('option', { name: 'fixture-later', exact: true }).click();
  await expect(request).toHaveValue('Only summarize urgent work mail.');
  await request.focus(); rows[1] = { ...rows[1]!, pending_approvals: null };
  await page.evaluate(() => (window as unknown as { promptEvent(event: unknown): void }).promptEvent({ kind: 'chat.plan_resolved', session_id: 'approval-chat' }));
  await expect(request).toHaveValue('Only summarize urgent work mail.'); await expect(request).toBeFocused();
  await page.getByRole('tab', { name: /^Coming up\s+1$/ }).click();
  await page.getByRole('tab', { name: /^Overview/ }).click();
  await expect(request).toHaveValue('Only summarize urgent work mail.');
  await prompts.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(prompts).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await expect(page.getByRole('button', { name: 'Needs you 0', exact: true })).toBeVisible();
  await expect(page.getByText('Nothing here right now.', { exact: true })).toBeVisible();
  await picker.press('Escape');
  await page.getByRole('button', { name: 'Needs you 0', exact: true }).click();
  await expect(prompts.getByRole('article')).toHaveCount(4);
});

test('creating a prompt clears recipe and attention filters so the saved schedule stays visible', async ({ context, page }) => {
  const { rows, recipe, dish } = overviewFixtures(); let creates = 0;
  await context.route('**/prompt-rpc', async route => {
    const { method, args } = route.request().postDataJSON(); let result: unknown = {};
    if (method === 'recipe.list') result = { recipes: [] };
    if (method === 'schedules.list') result = { schedules: [recipe] };
    if (method === 'dishes.list') result = { dishes: [dish] };
    if (method === 'chat.schedules.list') result = rows;
    if (method === 'chat.schedule.preview') result = { mode: args.mode, time_zone: args.time_zone,
      calculated_at: Date.now(), next_runs: [Date.parse(args.run_at)] };
    if (method === 'chat.schedule.create') {
      creates += 1;
      const row: PromptSchedule = { ...args, run_at: Date.parse(args.run_at), schedule_id: 'new-prompt',
        session_id: 'new-chat', enabled: true, revision: 1, created_at: Date.now(), next_run_at: Date.parse(args.run_at),
        last_run_at: null, last_turn_id: null, last_status: null };
      rows.push(row); result = row;
    }
    await route.fulfill({ json: { result } });
  });
  await page.goto('/prompt-harness.html?automation');
  await page.getByRole('button', { name: 'Needs you 1', exact: true }).click();
  const picker = page.getByRole('combobox', { name: 'Show only one Recipe' });
  await picker.fill('fixture-later'); await page.getByRole('option', { name: 'fixture-later', exact: true }).click();
  await page.getByRole('button', { name: 'Add schedule', exact: true }).click();
  await page.getByLabel('Schedule type', { exact: true }).selectOption('prompt');
  const prompts = page.locator('[data-prompt-schedules]');
  await expect(prompts.getByLabel('Title', { exact: true })).toBeVisible();
  expect({ recipe: await picker.inputValue(),
    needsYouSelected: await page.getByRole('button', { name: 'Needs you 1', exact: true }).getAttribute('aria-pressed'),
  }).toEqual({ recipe: '', needsYouSelected: 'false' });
  await prompts.getByLabel('Title', { exact: true }).fill('New briefing');
  await prompts.getByLabel('Request to run').fill('Summarize urgent work mail.');
  await prompts.getByRole('button', { name: 'Create schedule', exact: true }).click();
  await expect(prompts.getByRole('article', { name: 'New briefing' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'On 3', exact: true })).toBeVisible();
  expect(creates).toBe(1);
});

test('pausing a filtered prompt and removing the last prompt leave focus on a visible control', async ({ context, page }) => {
  let rows = [overviewFixtures().rows[0]!];
  await context.route('**/prompt-rpc', async route => {
    const { method } = route.request().postDataJSON(); let result: unknown = {};
    if (method === 'recipe.list') result = { recipes: [] };
    if (method === 'chat.schedules.list') result = rows;
    if (method === 'chat.schedule.pause') {
      rows = [{ ...rows[0]!, enabled: false, next_run_at: null, revision: rows[0]!.revision + 1 }];
      result = rows[0];
    }
    if (method === 'chat.schedule.remove') { rows = []; result = null; }
    await route.fulfill({ json: { result } });
  });
  await page.goto('/prompt-harness.html?automation');
  const prompts = page.locator('[data-prompt-schedules]');
  await page.getByRole('button', { name: 'On 1', exact: true }).click();
  const pause = prompts.getByRole('button', { name: 'Pause', exact: true });
  await pause.focus(); await expect(pause).toBeFocused(); await pause.press('Enter');
  await expect(prompts).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'On 0', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'On 0', exact: true }).click();
  await prompts.getByRole('button', { name: 'Remove', exact: true }).click();
  await prompts.getByRole('button', { name: 'Remove schedule', exact: true }).press('Enter');
  await expect(prompts).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add schedule', exact: true })).toBeFocused();
});

test('an unconfirmed queued run appears in Failing and clears after admission is confirmed', async ({ context, page }) => {
  let schedule: PromptSchedule = { ...manualScheduleFixture('queue-issue'),
    scheduling_issue: { code: 'queue_unconfirmed', since_at: Date.now() } };
  await context.route('**/prompt-rpc', async route => {
    const { method } = route.request().postDataJSON(); let result: unknown = {};
    if (method === 'recipe.list') result = { recipes: [] };
    if (method === 'chat.schedules.list') result = [schedule];
    await route.fulfill({ json: { result } });
  });
  await page.goto('/prompt-harness.html?automation');
  await page.getByRole('button', { name: 'Failing 1', exact: true }).click();
  const card = page.getByRole('article', { name: schedule.title });
  await expect(card).toContainText('could not confirm this run was queued');
  await expect(card.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  schedule = { ...schedule, scheduling_issue: null };
  await page.evaluate(() => (window as unknown as { promptEvent(event: unknown): void }).promptEvent({
    kind: 'chat.session_changed', session_id: 'scheduled-session', field: 'queue', value: true }));
  await expect(page.getByRole('button', { name: 'Failing 0', exact: true })).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: 'Failing 0', exact: true }).click();
  await expect(card).toBeVisible();
  await expect(card).not.toContainText('Scheduling delayed');
});
