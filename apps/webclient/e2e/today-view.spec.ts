import { expect, test, type Page } from '@playwright/test';

test.use({ timezoneId: 'America/Los_Angeles', viewport: { width: 390, height: 844 } });
const base = 'http://127.0.0.1:4319/full-app-harness.html?data=today';
const boot = async (page: Page, extra = ''): Promise<void> => {
  await page.clock.install({ time: new Date('2026-09-08T12:00:00-07:00') });
  await page.goto(`${base}${extra}#data/today`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator('[data-today-view]')).toHaveAttribute('aria-busy', 'false');
};

test('Today merges all kinds, exposes source freshness, and renders within a mobile viewport', async ({ page }) => {
  await boot(page);
  // ⛔ D-290 — Today is its own route, so there is no tab to be selected. What
  // replaced the claim is the surface itself being the one on screen.
  await expect(page.locator('[data-today-view]')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Today', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-today-group="overdue"]')).toContainText('Send the proposal');
  const today = page.locator('[data-today-group="today"]');
  await expect(today).toContainText('Review the brief');
  await expect(today).toContainText('Deliver the draft to Maya');
  await expect(today).toContainText('Design review');
  await expect(today).toContainText('All day · In progress');
  await expect(today).toContainText('Out of date');
  await expect(today).toContainText('work-calendar');
  await expect(page.locator('[data-today-group="next"]')).toContainText('Prepare the demo');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('[data-today-view]').screenshot({ path: '/tmp/recued-today-mobile.png' });
});

const mutations = (page: Page): Promise<unknown[]> => page.evaluate(() =>
  JSON.parse(sessionStorage.getItem('recued-test-today-mutations') ?? '[]') as unknown[]);

test('completes the original task in Today and keeps the confirmed result through refresh and reopening', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Complete Send the proposal', exact: true }).click();
  await expect(page.locator('[data-today-task-notice]')).toHaveText('Completed “Send the proposal”.');
  await expect(page.locator('[data-today-task-notice]')).toBeFocused();
  await expect(page.getByRole('link', { name: 'Send the proposal', exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/#data\/today$/);
  expect(await mutations(page)).toEqual([{ method: 'work_entity.task.mark_done', args: { id: 'late/task', done: true } }]);
  await page.locator('.today-refresh').click();
  await expect(page.locator('[data-today-view]')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('link', { name: 'Send the proposal', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-today-view]')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('link', { name: 'Send the proposal', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Design review', exact: true })).toBeVisible();
});

test('reschedules only the task due date, keeping its draft and focus through background refresh', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Reschedule Send the proposal', exact: true }).click();
  const due = page.getByLabel('New due date and time', { exact: true });
  await expect(due).toBeFocused();
  await due.fill('2026-09-10T09:30');
  // A programmatic refresh does not take the keyboard owner's focus.
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('.today-refresh')?.click());
  await expect(page.locator('[data-today-view]')).toHaveAttribute('aria-busy', 'false');
  await expect(due).toHaveValue('2026-09-10T09:30');
  await expect(due).toBeFocused();
  // ⚠ COVERAGE DROPPED HERE, DELIBERATELY. These two lines used to re-select
  // the Today tab and the Data lens — both no-ops — to pin that navigating to
  // where you already are does not discard the draft. D-290 made Today a route,
  // so neither control exists and the property has nothing to act on. The
  // draft-through-refresh claim above is unaffected.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Save due date', exact: true }).click();
  await expect(page.locator('[data-today-task-notice]')).toHaveText('Rescheduled “Send the proposal”.');
  await expect(page.locator('[data-today-task-notice]')).toBeFocused();
  await expect(page.locator('[data-today-group="next"]')).toContainText('Send the proposal');
  await expect(page.locator('[data-today-group="overdue"]')).not.toContainText('Send the proposal');
  expect(await mutations(page)).toEqual([{ method: 'work_entity.upsert', args: {
    kind: 'task', id: 'late/task', due_at: Date.parse('2026-09-10T09:30:00-07:00'),
  } }]);
});

test('rescheduling a task below the fold reveals its editor and Cancel returns to the task', async ({ page }) => {
  await boot(page);
  const reschedule = page.getByRole('button', { name: 'Reschedule Prepare the demo', exact: true });
  await reschedule.scrollIntoViewIfNeeded();
  await reschedule.click();
  const due = page.getByLabel('New due date and time', { exact: true });
  await expect(due).toBeFocused();
  await expect(due).toBeInViewport();
  const row = page.locator('[data-today-item]').filter({ has: page.getByRole('link', { name: 'Prepare the demo', exact: true }) });
  await expect(row.locator('[data-today-task-editor]')).toBeVisible();
  await expect(due).toHaveAccessibleDescription('Changes this task’s due date. Times use your device’s time zone.');
  await row.screenshot({ path: '/tmp/recued-today-inline-editor.png' });
  await page.locator('[data-today-task-editor]').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(reschedule).toBeFocused();
  await expect(reschedule).toBeInViewport();
  expect(await mutations(page)).toEqual([]);
});

test('keeps a reschedule draft when another task action is attempted and supports Escape', async ({ page }) => {
  await boot(page);
  const original = page.getByRole('button', { name: 'Reschedule Review the brief', exact: true });
  await original.click();
  const due = page.getByLabel('New due date and time', { exact: true });
  await due.fill('2026-09-12T14:15');
  const other = page.getByRole('button', { name: 'Complete Send the proposal', exact: true });
  await expect(other).toBeDisabled();
  await other.evaluate(button => (button as HTMLButtonElement).click());
  await expect(due).toHaveValue('2026-09-12T14:15');
  await expect(due).toBeFocused();
  expect(await mutations(page)).toEqual([]);
  await due.press('Escape');
  await expect(page.locator('[data-today-task-editor]')).toHaveCount(0);
  await expect(original).toBeFocused();
});

test('offers a direct retry for a failed task completion', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { document.documentElement.dataset.todayWriteFailure = '1'; });
  await page.getByRole('button', { name: 'Complete Send the proposal', exact: true }).click();
  await expect(page.locator('[data-today-task-error]')).toBeFocused();
  await expect(page.getByRole('link', { name: 'Send the proposal', exact: true })).toBeVisible();
  await page.evaluate(() => { delete document.documentElement.dataset.todayWriteFailure; });
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('[data-today-task-notice]')).toContainText('Completed');
  await expect(page.getByRole('link', { name: 'Send the proposal', exact: true })).toHaveCount(0);
  expect(await mutations(page)).toHaveLength(2);
});

test('invalid dates and failed writes preserve the reschedule draft for correction and retry', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Reschedule Review the brief', exact: true }).click();
  const due = page.getByLabel('New due date and time', { exact: true });
  await due.fill('');
  await page.getByRole('button', { name: 'Save due date', exact: true }).click();
  await expect(page.locator('[data-today-task-error]')).toContainText('Pick a valid due date');
  expect(await mutations(page)).toEqual([]);
  await due.fill('2026-09-09T10:00');
  await page.evaluate(() => { document.documentElement.dataset.todayWriteFailure = '1'; });
  await due.press('Enter');
  await expect(page.locator('[data-today-task-error]')).toContainText('Task source rejected the change');
  await expect(page.locator('[data-today-task-error]')).toBeFocused();
  await expect(due).toHaveValue('2026-09-09T10:00');
  await expect(page.locator('[data-today-group="today"]')).toContainText('Review the brief');
  await page.evaluate(() => { delete document.documentElement.dataset.todayWriteFailure; });
  await page.getByRole('button', { name: 'Save due date', exact: true }).click();
  await expect(page.locator('[data-today-task-notice]')).toHaveText('Rescheduled “Review the brief”.');
  await expect(page.locator('[data-today-group="next"]')).toContainText('Review the brief');
  expect(await mutations(page)).toHaveLength(2);
});

test('does not claim rescheduling succeeded when the source kept its previous due date', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { document.documentElement.dataset.todayVendorWon = '1'; });
  await page.getByRole('button', { name: 'Reschedule Review the brief', exact: true }).click();
  const due = page.getByLabel('New due date and time', { exact: true });
  await due.fill('2026-09-11T10:00');
  await page.getByRole('button', { name: 'Save due date', exact: true }).click();
  await expect(page.locator('[data-today-task-error]')).toContainText('The server did not confirm the change');
  await expect(page.locator('[data-today-task-notice]')).toHaveCount(0);
  await expect(due).toHaveValue('2026-09-11T10:00');
  await expect(page.locator('[data-today-group="today"]')).toContainText('Review the brief');
});

test('keeps a pending completion explicit when the locally changed row disappears on refresh', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { document.documentElement.dataset.todayAwaitingVerify = '1'; });
  await page.getByRole('button', { name: 'Complete Send the proposal', exact: true }).click();
  await expect(page.locator('[data-today-task-error]')).toContainText('the source has not confirmed it yet');
  await expect(page.locator('[data-today-task-notice]')).toHaveCount(0);
  await page.locator('.today-refresh').click();
  await expect(page.locator('[data-today-view]')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('link', { name: 'Send the proposal', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-today-task-editor]')).toBeVisible();
  await expect(page.locator('[data-today-task-error]')).toContainText('the source has not confirmed it yet');
  expect(await mutations(page)).toHaveLength(1);
});

for (const unavailable of ['today_readonly', 'today_source_failure']) {
  test(`hides task actions when the source cannot confirm writes (${unavailable})`, async ({ page }) => {
    await boot(page, `&${unavailable}=1`);
    await expect(page.getByRole('link', { name: 'Review the brief', exact: true })).toBeVisible();
    await expect(page.locator('.today-task-actions')).toHaveCount(0);
    expect(await mutations(page)).toEqual([]);
  });
}

for (const changed of ['readonly', 'deleted'] as const) {
  test(`rechecks a task that became ${changed} after the Today read`, async ({ page }) => {
    await boot(page);
    await page.evaluate((posture) => {
      if (posture === 'readonly') document.documentElement.dataset.todayReadonly = '1';
      else document.documentElement.dataset.todayHideTask = 'late/task';
    }, changed);
    await page.getByRole('button', { name: 'Complete Send the proposal', exact: true }).click();
    await expect(page.locator('[data-today-task-error]')).toContainText('This task cannot be changed here now');
    expect(await mutations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Complete Send the proposal', exact: true })).toBeFocused();
  });
}

test('guards duplicate writes and confirms completion while an unrelated calendar read is still pending', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-08T12:00:00-07:00') });
  await page.goto(`${base}&hold_rpc=collection.list&hold_rpc=work_entity.task.mark_done#data/today`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const complete = page.getByRole('button', { name: 'Complete Send the proposal', exact: true });
  await complete.click();
  await expect(page.locator('[data-today-task-editor]')).toHaveAttribute('aria-busy', 'true');
  await expect(complete).toHaveAttribute('aria-disabled', 'true');
  await complete.evaluate(button => (button as HTMLButtonElement).click());
  // ⚠ COVERAGE DROPPED HERE, DELIBERATELY — and it is NOT the same property
  // moved elsewhere. Pre-D-290 the Data route DISABLED ITS OWN TAB STRIP while
  // a Today write was in flight (`renderTabs(..., todayTaskEdit?.busy)`), and
  // this asserted that. Today is a route now: it has no tab strip, and the
  // shell does NOT disable drawer seats — it reads `hasInFlightWork()` into a
  // `workState` and offers a return affordance instead. Driving a seat here
  // would assert something the shell never promises. The shell's own machinery
  // is covered by `server-switcher.test.ts` and
  // `shell/__tests__/address-change-convergence.test.ts`; what is genuinely
  // uncovered now is the END-TO-END claim that an owner cannot walk away from
  // an in-flight Today write and lose it.
  expect(await mutations(page)).toHaveLength(1);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('work_entity.task.mark_done'))).toBe(1);
  await expect(page.locator('[data-today-task-notice]')).toHaveText('Completed “Send the proposal”.');
  await expect(page.getByRole('link', { name: 'Send the proposal', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Review the brief', exact: true })).toBeVisible();
  await expect(page.locator('[data-today-view]')).toContainText('Still reading your sources');
  expect(await mutations(page)).toHaveLength(1);
});

test('original task, commitment, and source-qualified calendar details return to Today with browser Back', async ({ page }) => {
  await boot(page);
  for (const [title, hash] of [
    ['Send the proposal', '#data/task/late%2Ftask'],
    ['Deliver the draft to Maya', '#data/commitment/promise'],
    ['Design review', '#data/calendar/record/work-calendar/cal%3Aevent%2Fone'],
  ] as const) {
    const link = page.locator('[data-today-view]').getByRole('link', { name: title, exact: true });
    await expect(link).toHaveAttribute('href', hash);
    await link.click();
    await expect(page).toHaveURL(new RegExp(hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
    if (title === 'Design review') await expect(page.locator('[data-recued-collection-detail-heading]')).toContainText(title);
    else await expect(page.getByRole('dialog')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/#data\/today$/);
    await expect(page.locator('[data-today-view]')).toHaveAttribute('aria-busy', 'false');
  }
});

test('Refresh and the minute clock advance deadlines without losing keyboard focus', async ({ page }) => {
  await boot(page);
  const refresh = page.locator('.today-refresh');
  await refresh.click();
  await expect(refresh).toHaveAttribute('aria-disabled', 'false');
  await expect(refresh).toBeFocused();
  const link = page.getByRole('link', { name: 'Review the brief', exact: true });
  await link.focus();
  await page.clock.setSystemTime(new Date('2026-09-09T00:01:00-07:00'));
  await page.evaluate(() => {
    const heartbeat = (): void => window.__app.fireMessage({ type: 'server_heartbeat', ts: Date.now() });
    heartbeat();
    setInterval(heartbeat, 10_000);
  });
  await page.clock.runFor(60_001);
  await expect(page.locator('[data-today-group="overdue"]')).toContainText('Review the brief');
  await expect(page.locator('[data-today-group="today"]')).toContainText('Prepare the demo');
  await expect(link).toBeFocused();
  await expect(page.getByRole('link', { name: 'Design review', exact: true })).toHaveCount(0);
});

test('a failed calendar still shows tasks and commitments, with an explicit partial result', async ({ page }) => {
  await boot(page, '&today_failure=1');
  await expect(page.locator('[data-today-view]')).toContainText('Results below may be incomplete');
  await expect(page.getByRole('link', { name: 'Review the brief', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Deliver the draft to Maya', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Design review', exact: true })).toHaveCount(0);
});

test('refresh keeps keyboard focus in Today when the focused record disappears', async ({ page }) => {
  await boot(page);
  await page.getByRole('link', { name: 'Review the brief', exact: true }).focus();
  await page.evaluate(() => {
    document.documentElement.dataset.todayHideTask = 'task-today';
    document.querySelector<HTMLButtonElement>('.today-refresh')!.click();
  });
  await expect(page.getByRole('link', { name: 'Review the brief', exact: true })).toHaveCount(0);
  await expect(page.locator('.today-refresh')).toBeFocused();
});

/** ⛔ "Today can be saved and reopens the relative view after reload" WAS HERE.
 *
 *  Deleted, not skipped, and not a coverage loss: the saved view it exercised
 *  stored `{ tab: 'today' }` and NOTHING else — no date, no filter. It was a
 *  bookmark, and D-290 gave Today its own URL plus a drawer seat, so the thing
 *  it saved is now one click away by two routes. Owner's call, 2026-09-22.
 *
 *  ⚠ The pre-D-290 ROWS still exist and are handled rather than retired — see
 *  `src/data/__tests__/d-290-legacy-today-view.test.ts`. Dropping the
 *  vocabulary member would throw on `list` and take an owner's whole saved-view
 *  set down over one row. */
test('a SLOW calendar still shows tasks and commitments, and claims nothing while it waits', async ({ page }) => {
  // ⛔ THE DISTINCTION IS THE POINT. `today_failure=1` (above) covers a source
  // that ERRORS, which `loadToday` already handled. This covers a source that
  // is merely SLOW — held, never answered — which used to blank the entire
  // view behind a bare "Loading Today…" even though tasks and commitments had
  // already returned. Measured before the fix: 0 rows, 0 groups.
  await page.clock.install({ time: new Date('2026-09-08T12:00:00-07:00') });
  await page.goto(`${base}&hold_rpc=collection.list#data/today`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const view = page.locator('[data-today-view]');
  await expect(page.getByRole('link', { name: 'Review the brief', exact: true })).toBeVisible();
  await expect(view).not.toContainText('Loading Today');

  // ⛔ AND IT MAKES NO FINISHED-READ CLAIM WHILE A SOURCE IS STILL OUT. "No
  // overdue tasks" and "Nothing due in the next seven days" are statements
  // about a COMPLETED read; asserting them here would be a lie told to a fresh
  // install whose sources have not answered.
  await expect(view).toContainText('Still reading your sources');
  await expect(view).not.toContainText('Nothing due in the next seven days');
  await expect(view).toHaveAttribute('aria-busy', 'true');

  // The calendar event is not invented while its source is silent.
  await expect(page.getByRole('link', { name: 'Design review', exact: true })).toHaveCount(0);
});

test('a fresh install says so on a FINISHED read, and its capture offer opens the shared Create overlay', async ({ page }) => {
  // ⛔ THE ZERO STATE IS THE ONE A NEW OWNER ACTUALLY SEES, AND IT HAD NO
  // BROWSER COVERAGE. The unit suite asserts `renderToday(...)` returns a string
  // containing `data-today-empty` — which is true of markup nobody can reach and
  // of a button wired to nothing. `canCreate` is `opts.openCreateOverlay !==
  // undefined`, so whether the offer renders at all is a property of the COMPOSED
  // app, not of the renderer the unit test calls directly.
  //
  // ⛔ AND EMPTY IS NOT PENDING. `?data=today-empty` answers every Today read
  // with a real, RESOLVED, empty result. Leaving those reads unstubbed would sit
  // on "Loading Today…" forever and every assertion below would pass as absent
  // rather than as pending — a false negative shaped exactly like a missing
  // feature. The `aria-busy=false` + "not Still reading your sources" pair is
  // what pins this to a COMPLETED read: the claim "nothing is due" is only
  // honest once every source has answered.
  await page.clock.install({ time: new Date('2026-09-08T12:00:00-07:00') });
  await page.goto('http://127.0.0.1:4319/full-app-harness.html?data=today-empty#data/today');
  await page.waitForFunction(() => window.__app?.ready === true);

  const view = page.locator('[data-today-view]');
  await expect(view).toHaveAttribute('aria-busy', 'false');
  await expect(view).not.toContainText('Loading Today');
  await expect(view).not.toContainText('Still reading your sources');

  await expect(view.locator('[data-today-empty]')).toBeVisible();
  await expect(view).toContainText('Nothing is due in the next seven days.');
  await expect(view).not.toContainText('Results below may be incomplete');

  // The offer is REACHABLE, not merely rendered — one modal, one commit path, so
  // a capture made from Today is indistinguishable from one made anywhere else.
  await view.getByRole('button', { name: 'Capture something', exact: true }).click();
  await expect(page.locator('[data-recued-create-overlay]')).toBeVisible();
});
