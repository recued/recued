import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL } from './helpers/full-app.js';

/** D-341 slice B2b — "What it may do without asking" where the owner meets each trigger: a webhook's
 *  card under Connections, a schedule's and an event trigger's page under Automation. The panel and
 *  its mounts are the real ones; its owner rpcs answer from `harness/trigger-preapproval.ts`. */

const WEBHOOK = 'whi_browserdemo0123456789abcdef012345';
const WEBHOOK_DETAIL = `#connections/webhooks/webhook/${WEBHOOK}`;
const PANEL = '[data-recued-trigger-preapproval-panel]';
const SUMMARY = 'What it may do without asking';

const open = async (page: Page, query: string): Promise<string[]> => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${HARNESS_URL}?${query}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  return errors;
};

const widthOf = (locator: ReturnType<Page['locator']>) => locator.evaluate((element) => element.getBoundingClientRect().width);

const calls = (page: Page, method: string) => page.evaluate((name) =>
  ((JSON.parse(sessionStorage.getItem('recued-test-trigger-preapproval') ?? 'null')?.calls ?? []) as
    Array<{ method: string; args: Record<string, unknown> }>)
    .filter((call) => call.method === `collection.contract.${name}`).map((call) => call.args), method);

test('a webhook\'s card grants what its recipe may do without asking, and ends it', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const errors = await open(page, 'connection=webhooks&trigger_preapproval=1#connections/webhooks');
  const card = page.locator(`[data-recued-webhooks-card="${WEBHOOK}"]`);
  await card.getByText(SUMMARY, { exact: true }).click();
  const panel = card.locator(PANEL);
  await expect(panel.getByRole('heading', { name: 'Receive Apple Health readings' })).toBeVisible();
  await expect(panel).toContainText('Let these happen without asking when this webhook runs it:');
  const save = panel.getByLabel('Save up to 100 daily readings in one transaction, all or none');
  await expect(save).toBeChecked();
  await expect(panel).toContainText('Always asks: Delete one daily reading. It deletes or can\'t be undone.');
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  // Its own styles, over the webhooks panel's every-`input` and every-`label` rules.
  expect(await widthOf(save)).toBeLessThan(40);
  expect(await widthOf(panel.getByLabel('Times a run'))).toBeLessThan(130);
  // No end date and no use cap to set (ruling 10): it stays on until it is ended.
  await expect(panel.getByLabel('Uses')).toHaveCount(0);
  await expect(panel.getByLabel('Days')).toHaveCount(0);
  await expect(panel).toContainText('It stays on until you end it.');

  await panel.getByLabel('Times a run').fill('2');
  const allow = panel.getByRole('button', { name: 'Allow without asking' });
  await allow.click();
  await expect(panel).toContainText('Without asking: Save up to 100 daily readings in one transaction, all or none');
  await expect(panel).toContainText('Up to 2 times a run · not used yet · until you end it');
  // It covers the only write on offer: nothing is left to allow, and focus waits on the panel.
  await expect(allow).toHaveCount(0);
  await expect(panel).toBeFocused();
  expect(await calls(page, 'grantTriggerPreapproval')).toEqual([{
    trigger: { kind: 'webhook', ingress_id: WEBHOOK }, recipe_id: 'receive-body-metrics-apple-health',
    writes: ['recued-core.body-signals.daily_metric.batch'], max_per_run: 2,
  }]);

  await panel.getByRole('button', { name: 'End it' }).click();
  await expect(panel).toContainText('It asks again from now on.');
  const confirm = panel.locator('[data-recued-trigger-preapproval-confirm]');
  await expect(confirm).toBeFocused();
  await confirm.click();
  await expect(panel).not.toContainText('Without asking:');
  await expect(panel.getByRole('button', { name: 'Allow without asking' })).toBeVisible();
  expect(await calls(page, 'revokeTriggerPreapproval')).toEqual([{ id: 'tpa_e2e_1' }]);
  expect(errors).toEqual([]);
});

test('a webhook card\'s panel stays as the owner left it when the webhooks list repaints its cards', async ({ page }) => {
  const errors = await open(page, `connection=webhooks&trigger_preapproval=1${WEBHOOK_DETAIL}`);
  const card = page.locator(`[data-recued-webhooks-card="${WEBHOOK}"]`);
  await card.getByText(SUMMARY, { exact: true }).click();
  const uses = card.locator(PANEL).getByLabel('Times a run');
  await uses.fill('12');
  await expect(uses).toBeFocused();
  await card.evaluate((element) => { element.setAttribute('data-e2e-before-repaint', ''); });
  // Searching repaints every card. Drive it without taking focus from the panel.
  await page.evaluate(() => {
    const search = document.querySelector<HTMLInputElement>('[data-webhook-filter="query"]')!;
    search.value = 'Signed';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(card).not.toHaveAttribute('data-e2e-before-repaint');
  await expect(card.locator('details', { has: page.locator(PANEL) })).toHaveJSProperty('open', true);
  await expect(uses).toHaveValue('12');
  await expect(uses).toBeFocused();
  // The page's one question (does the server offer pre-approvals?), then the panel's own read: the
  // repaints read nothing more.
  expect(await calls(page, 'triggerPreapprovalChoices')).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('a schedule\'s page grants what the owner ticks, with their bounds, and says why one is refused', async ({ page }) => {
  const errors = await open(page, 'automation=rules&trigger_preapproval=fail-grant#automation/schedules/schedule-e2e-1');
  await page.getByText(SUMMARY, { exact: true }).click();
  const panel = page.locator(PANEL);
  await expect(panel.getByRole('heading', { name: 'Daily brief' })).toBeVisible();
  await expect(panel).toContainText('Let these happen without asking when this schedule runs it:');
  // The route's style bundle carries the panel's own rules.
  expect(await panel.evaluate((element) => getComputedStyle(element).display)).toBe('grid');
  expect(await widthOf(panel.getByLabel('Times a run'))).toBeLessThan(130);
  await panel.getByLabel('Send an email').uncheck();
  await panel.getByLabel('Times a run').fill('3');
  const allow = panel.getByRole('button', { name: 'Allow without asking' });
  await allow.click();
  // Refused: in the server's words without its method's name, the form as the owner set it.
  await expect(panel.getByRole('alert')).toHaveText('Daily brief changed since you opened this');
  await expect(allow).toBeFocused();
  await expect(panel.getByLabel('Send an email')).not.toBeChecked();
  await expect(panel.getByLabel('Times a run')).toHaveValue('3');
  await allow.click();
  await expect(panel).toContainText('Without asking: Post a note to the team');
  await expect(panel).toContainText('Up to 3 times a run · not used yet · until you end it');
  // The email is still on offer, unticked, and focus stays on the button the owner pressed.
  await expect(panel).toContainText('Also let these happen without asking when this schedule runs it:');
  await expect(panel.getByLabel('Send an email')).not.toBeChecked();
  await expect(allow).toBeFocused();
  const granted = await calls(page, 'grantTriggerPreapproval');
  expect(granted).toHaveLength(2);
  expect(granted[1]).toEqual({ trigger: { kind: 'schedule', schedule_id: 'schedule-e2e-1' }, recipe_id: 'daily-brief',
    writes: ['post-note'], max_per_run: 3 });
  expect(errors).toEqual([]);
});

test('D-402 ruling 5: a schedule\'s page from a server that grants the whole recipe lists its changes and allows them all', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const errors = await open(page, 'automation=rules&trigger_preapproval=whole#automation/schedules/schedule-e2e-1');
  await page.getByText(SUMMARY, { exact: true }).click();
  const panel = page.locator(PANEL);
  await expect(panel.getByRole('heading', { name: 'Daily brief' })).toBeVisible();
  await expect(panel).toContainText('Let these happen without asking when this schedule runs it:');
  // Its changes, listed: none to tick, and no times a run.
  await expect(panel.locator('[data-recued-trigger-preapproval-write]')).toHaveText(['Post a note to the team', 'Send an email']);
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await expect(panel.getByLabel('Times a run')).toHaveCount(0);
  await expect(panel).toContainText('Every time it runs, until you end it. A change to the recipe asks you again.');
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const allow = panel.getByRole('button', { name: 'Allow without asking' });
  await allow.click();
  await expect(panel).toContainText('Without asking: Post a note to the team; Send an email');
  await expect(panel).toContainText('Every time it runs · not used yet · until you end it');
  await expect(allow).toHaveCount(0);
  expect(await calls(page, 'grantTriggerPreapproval')).toEqual([{ trigger: { kind: 'schedule', schedule_id: 'schedule-e2e-1' },
    recipe_id: 'daily-brief', writes: ['*'] }]);
  expect(errors).toEqual([]);
});

test('a schedule page\'s panel stays as the owner left it when the route repaints', async ({ page }) => {
  const errors = await open(page, 'automation=rules&trigger_preapproval=1#automation/schedules/schedule-e2e-1');
  await page.getByText(SUMMARY, { exact: true }).click();
  const uses = page.locator(PANEL).getByLabel('Times a run');
  await uses.fill('12');
  await expect(uses).toBeFocused();
  const detail = page.locator('[data-recued-automation-detail]');
  await detail.evaluate((element) => { element.setAttribute('data-e2e-before-repaint', ''); });
  const lists = await page.evaluate(() => window.__app.rpcCallCount('schedules.list'));
  // A schedule changed on the server: the route reads its lists again and repaints.
  await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: {
    kind: 'schedule', op: 'updated', cursor: 1_000_000,
  } }));
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('schedules.list'))).toBeGreaterThan(lists);
  await expect(detail).not.toHaveAttribute('data-e2e-before-repaint');
  await expect(page.locator('details', { has: page.locator(PANEL) })).toHaveJSProperty('open', true);
  await expect(uses).toHaveValue('12');
  await expect(uses).toBeFocused();
  // The page's one question, then the panel's own read: the repaints read nothing more.
  expect(await calls(page, 'triggerPreapprovalChoices')).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('an auto-run\'s page grants what it may do without asking when it runs on its own (B1b)', async ({ page }) => {
  const errors = await open(page, 'automation=rules&trigger_preapproval=1#automation/auto-run/dsh_e2e_timer');
  await page.getByText(SUMMARY, { exact: true }).click();
  const panel = page.locator(PANEL);
  await expect(panel.getByRole('heading', { name: 'Watch pipeline' })).toBeVisible();
  await expect(panel).toContainText('Let these happen without asking when it runs on its own:');
  await panel.getByRole('button', { name: 'Allow without asking' }).click();
  await expect(panel).toContainText('Without asking: Add a task');
  await expect(panel).toContainText('Once a run · not used yet · until you end it');
  expect(await calls(page, 'grantTriggerPreapproval')).toEqual([{ trigger: { kind: 'auto_run', dish_id: 'dsh_e2e_timer' },
    recipe_id: 'autorun-live-1', writes: ['work-entity-task-create'], max_per_run: 1 }]);
  expect(errors).toEqual([]);
});

test('an event trigger whose recipe asks an AI is offered its writes, and says its AI decides (ruling 8)', async ({ page }) => {
  const errors = await open(page, 'automation=rules&trigger_preapproval=1#automation/triggers/trg-e2e-ai');
  await page.getByText(SUMMARY, { exact: true }).click();
  const panel = page.locator(PANEL);
  await expect(panel.getByRole('heading', { name: 'Summarize new mail' })).toBeVisible();
  await expect(panel.locator('[data-recued-trigger-preapproval-ai]')).toHaveText('Its AI decides what it writes.');
  await panel.getByRole('button', { name: 'Allow without asking' }).click();
  await expect(panel).toContainText('Without asking: Post a note to the team');
  // The page's one question, the panel's read, and its read again after the grant.
  expect(await calls(page, 'triggerPreapprovalChoices')).toEqual([
    { trigger: { kind: 'event_trigger', trigger_id: 'trg-e2e-ai' } }, { trigger: { kind: 'event_trigger', trigger_id: 'trg-e2e-ai' } },
    { trigger: { kind: 'event_trigger', trigger_id: 'trg-e2e-ai' } },
  ]);
  expect(await calls(page, 'grantTriggerPreapproval')).toEqual([{ trigger: { kind: 'event_trigger', trigger_id: 'trg-e2e-ai' },
    recipe_id: 'summarize-inbox', writes: ['post-note'], max_per_run: 1 }]);
  // Granted, its AI note stays, beside what it may do.
  await expect(panel.locator('[data-recued-trigger-preapproval-ai]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

// D-341 slice B4 — a reception form: its pair page, and its held submission in the inbox. A form's
// endpoint id is base64url, so it may start with `-`.
const FORM_ENDPOINT = '-ep_e2e';

test('a form\'s page grants what its intake may do without asking, in the panel\'s own styles at 320 px (B4)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const errors = await open(page, `trigger_preapproval=form#reception/endpoints/pair/${FORM_ENDPOINT}`);
  await page.getByText(SUMMARY, { exact: true }).click();
  const panel = page.locator(PANEL);
  await expect(panel.getByRole('heading', { name: 'Book a table' })).toBeVisible();
  await expect(panel).toContainText('Let these happen without asking when this form runs it:');
  await expect(panel.locator('[data-recued-trigger-preapproval-ai]')).toHaveText('Its AI decides what it writes.');
  // Its styles ship with the reception page's: only the panel's own CSS makes it a grid.
  expect(await panel.evaluate((element) => getComputedStyle(element).display)).toBe('grid');
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const add = panel.getByLabel('Add a task');
  await expect(add).toBeChecked();
  expect(await widthOf(add)).toBeLessThan(40);
  expect(await widthOf(panel.getByLabel('Times a run'))).toBeLessThan(130);

  await panel.getByRole('button', { name: 'Allow without asking' }).click();
  await expect(panel).toContainText('Without asking: Add a task');
  await expect(panel).toContainText('Once a run · not used yet · until you end it');
  expect(await calls(page, 'triggerPreapprovalChoices')).toContainEqual({ trigger: { kind: 'reception', endpoint_id: FORM_ENDPOINT } });
  expect(await calls(page, 'grantTriggerPreapproval')).toEqual([{ trigger: { kind: 'reception', endpoint_id: FORM_ENDPOINT },
    recipe_id: 'intake-book-table', writes: ['work-entity-task-create'], max_per_run: 1 }]);
  expect(errors).toEqual([]);
});

test('a form\'s held submission offers "Say yes, and always allow this form", sent as allow (B4)', async ({ page }) => {
  const errors = await open(page, 'reception=pending&reception_always_allow=1&trigger_preapproval=form');
  await page.evaluate(() => window.__app.setHash('#reception'));
  const row = page.locator('[data-recued-reception-inbox-row="hold-reception-1"]');
  await row.focus();
  await page.keyboard.press('Enter');
  const always = page.getByRole('button', { name: 'Say yes, and always allow this form', exact: true });
  await expect(always).toBeVisible();
  // It replaced the session's offer: no "from now on (…)" bounds beside it.
  await expect(page.getByRole('button', { name: /allow this form from now on/u })).toHaveCount(0);
  await always.click();
  await expect(row).toHaveCount(0);
  const approved = await page.evaluate(() =>
    ((JSON.parse(sessionStorage.getItem('recued-test-trigger-preapproval') ?? 'null')?.calls ?? []) as
      Array<{ method: string; args: Record<string, unknown> }>).filter((call) => call.method === 'reception.inbox.approve')
      .map((call) => call.args));
  expect(approved).toEqual([{ hold_id: 'hold-reception-1', allow: true, edits: {} }]);
  // The other hold's ask offers nothing of the kind.
  await page.locator('[data-recued-reception-inbox-row="hold-reception-2"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Say yes, and always allow this form', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

// D-341 slice B3 — a scheduled prompt's card under Automation: its pre-approvals, and how to allow a
// change from its ask (its changes are its AI's, so none is offered here).
test('a scheduled prompt\'s card lists what it may do without asking, and how to allow more from an ask (B3)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const errors = await open(page, 'automation=rules&trigger_preapproval=prompt#automation/schedules');
  const card = page.locator('article[data-schedule-id="ps_e2e_morning"]');
  await expect(card.getByRole('heading', { name: 'Morning bills' })).toBeVisible();
  await card.getByText(SUMMARY, { exact: true }).click();
  const panel = card.locator(PANEL);
  await expect(panel.locator('[data-recued-trigger-preapproval-ai]')).toHaveText('Its AI decides what it writes.');
  await expect(panel).toContainText('Without asking: Add a task');
  await expect(panel).toContainText('Once a run · used 2 times · until you end it');
  await expect(panel).toContainText('Its other changes still ask you. To stop asking about one, answer “Always allow for this'
    + ' scheduled prompt” on its ask.');
  await expect(panel.getByRole('button', { name: 'Allow without asking' })).toHaveCount(0);
  // Its own styles, inside the prompt card's every-`p` and every-`button` rules.
  expect(await panel.evaluate((element) => getComputedStyle(element).display)).toBe('grid');
  expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  // The page's one question, then the panel's own read.
  expect(await calls(page, 'triggerPreapprovalChoices')).toEqual([{ trigger: { kind: 'prompt_schedule', schedule_id: 'ps_e2e_morning' } },
    { trigger: { kind: 'prompt_schedule', schedule_id: 'ps_e2e_morning' } }]);

  // The prompt list renders every card again: the section is moved into the new card, still open.
  await card.evaluate((element) => { element.setAttribute('data-e2e-before-render', ''); });
  await page.locator('[data-prompt-schedules]').getByRole('button', { name: 'Refresh' }).click();
  await expect(card).not.toHaveAttribute('data-e2e-before-render');
  await expect(card.locator('details[data-prompt-schedule-preapprovals]')).toHaveJSProperty('open', true);
  await expect(panel).toContainText('Without asking: Add a task');
  // Still the page's one question and the panel's one read: the new card read nothing.
  expect(await calls(page, 'triggerPreapprovalChoices')).toHaveLength(2);

  await panel.getByRole('button', { name: 'End it' }).click();
  await panel.locator('[data-recued-trigger-preapproval-confirm]').click();
  await expect(panel).toContainText('Its changes ask you. To stop asking about one, answer “Always allow for this scheduled prompt”'
    + ' on its ask.');
  expect(await calls(page, 'revokeTriggerPreapproval')).toEqual([{ id: 'tpa_e2e_prompt' }]);
  expect(errors).toEqual([]);
});

test('a server from before pre-approvals shows no "What it may do without asking" on any page', async ({ page }) => {
  // A webhook's card, a schedule's, an event trigger's and an auto-run's page, a scheduled prompt's card:
  // each panel of sections asks once as it shows one (a page can hold two: a schedule's page also lists
  // the scheduled prompts), and takes them away when the server knows no such method.
  const pages: ReadonlyArray<readonly [string, string | null]> = [
    [`connection=webhooks&trigger_preapproval=older${WEBHOOK_DETAIL}`, `[data-recued-webhooks-card="${WEBHOOK}"]`],
    ['automation=rules&trigger_preapproval=older#automation/schedules/schedule-e2e-1', null],
    ['automation=rules&trigger_preapproval=older#automation/triggers/trg-e2e-ai', null],
    ['automation=rules&trigger_preapproval=older#automation/auto-run/dsh_e2e_timer', null],
    ['automation=rules&trigger_preapproval=older#automation/schedules', 'article[data-schedule-id="ps_e2e_morning"]'],
  ];
  for (const [query, scope] of pages) {
    // A tab of its own: the calls it records are this page's.
    const tab = await page.context().newPage();
    const errors = await open(tab, query);
    if (scope !== null) await expect(tab.locator(scope)).toBeVisible();
    // It made the section, since it asked: a hidden section and a missing one would look alike.
    await expect.poll(async () => (await calls(tab, 'triggerPreapprovalChoices')).length, { message: query }).toBeGreaterThan(0);
    await expect(tab.getByText(SUMMARY, { exact: true }), query).toBeHidden();
    await expect(tab.getByText('Recued could not load what this may do without asking', { exact: false }), query).toHaveCount(0);
    expect(errors, query).toEqual([]);
    await tab.close();
  }
});


/** D-402 — a pre-approval granted, used or ended anywhere (its ask answered on another device, a run, Contracts)
 *  arrives as `contract.preapproval_changed`, and each place that lists triggers' pre-approvals reads them again:
 *  the four pages a trigger has, and Contracts. A caller's use is no change of theirs. */
test('D-402: every page listing triggers\' pre-approvals reads them again when one changes anywhere', async ({ page }) => {
  let cursor = 9_000;
  const changed = (holder: 'trigger' | 'caller', change: 'granted' | 'used' | 'ended') => page.evaluate((event) =>
    window.__app.fireMessage({ type: 'server_event', event }),
  { kind: 'contract.preapproval_changed', change, id: 'tpa_elsewhere', holder, cursor: (cursor += 1) });
  const reads = async (method: string) => (await calls(page, method)).length;
  // What a page read on opening (its first read, the support check) is over before counting from it.
  const settled = async (method: string) => {
    let last = -1;
    await expect.poll(async () => { const now = await reads(method); const same = now === last; last = now; return same; },
      { intervals: [400] }).toBe(true);
    return last;
  };
  const readsAgain = async (method: string) => {
    const before = await settled(method);
    // A caller's use first: it reads nothing, so the count moves by one, for the trigger's change.
    await changed('caller', 'used');
    await changed('trigger', 'granted');
    await expect.poll(() => reads(method)).toBe(before + 1);
    await page.waitForTimeout(600);
    expect(await reads(method)).toBe(before + 1);
  };
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const openPanel = async (query: string, within = page.locator('body')) => {
    await page.goto(`${HARNESS_URL}?${query}`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await within.getByText(SUMMARY, { exact: true }).first().click();
    await expect.poll(() => reads('triggerPreapprovalChoices')).toBeGreaterThan(0);
    await expect(page.locator(PANEL).locator('h4').first()).toBeVisible();
  };

  await openPanel(`connection=webhooks&trigger_preapproval=1${WEBHOOK_DETAIL}`, page.locator(`[data-recued-webhooks-card="${WEBHOOK}"]`));
  await readsAgain('triggerPreapprovalChoices');
  await openPanel('automation=rules&trigger_preapproval=1#automation/schedules/schedule-e2e-1');
  await readsAgain('triggerPreapprovalChoices');
  await openPanel(`trigger_preapproval=form#reception/endpoints/pair/${FORM_ENDPOINT}`);
  await readsAgain('triggerPreapprovalChoices');
  await openPanel('automation=rules&trigger_preapproval=prompt#automation/schedules', page.locator('article[data-schedule-id="ps_e2e_morning"]'));
  await readsAgain('triggerPreapprovalChoices');

  // Contracts lists them among what happens without asking; a caller's ended reads it too ("Stop allowing").
  // (Its agreements answer from the caller pre-approvals fixture, as Contracts needs them to load.)
  await page.goto(`${HARNESS_URL}?trigger_preapproval=1&caller_preapprovals=1#contracts`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect.poll(() => reads('listTriggerPreapprovals')).toBeGreaterThan(0);
  await readsAgain('listTriggerPreapprovals');
  const before = await settled('listTriggerPreapprovals');
  await changed('caller', 'ended');
  await expect.poll(() => reads('listTriggerPreapprovals')).toBe(before + 1);
  expect(errors).toEqual([]);
});
