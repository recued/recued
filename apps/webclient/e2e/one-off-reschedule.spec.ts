import { expect, test, type Page } from '@playwright/test';
import type { ServerSchedule } from '@recued/contracts';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';

declare global {
  interface Window {
    __oneOffFixture: {
      schedule: ServerSchedule; calls: Array<{ method: string; args: unknown }>;
      outcome: 'ok' | 'refuse' | 'lost' | 'hold' | 'hold_reply' | 'ignore'; failReads: number;
      hold?: (outcome: 'ok' | 'refuse') => void; cursor: number;
      holdNextRead: boolean; releaseRead?: () => void; releaseReply?: () => void;
    };
  }
}
const editor = (page: Page) => page.locator('[data-recued-one-off-reschedule]');
const input = (page: Page) => editor(page).getByLabel('New date and time', { exact: false });
const calls = (page: Page, method = 'schedules.reschedule') => page.evaluate(name => window.__oneOffFixture.calls.filter(call => call.method === name), method);
const picked = '2030-01-04T12:00';
const pickedAt = Date.UTC(2030, 0, 4, 20); // Browser keeps Los Angeles time; server keeps Hong Kong time.
test.use({ timezoneId: 'America/Los_Angeles' });

const open = async (page: Page, options: { paused?: boolean; supported?: boolean; reviewed?: boolean; recurring?: boolean } = {}) => {
  await page.addInitScript(opts => {
    const runAt = Date.UTC(2030, 0, 1, 1);
    const schedule: ServerSchedule = {
      schedule_id: 'one-off-report', recipe_id: 'daily-brief', publisher_id: 'recued-core', dish_id: 'dish-e2e-1',
      mode: opts.recurring ? 'recurring' : 'one_shot', run_at: runAt, cron_expression: '0 9 1 1 *', time_zone: 'Asia/Hong_Kong',
      enabled: !opts.paused, created_at: runAt - 86_400_000, last_run_at: null, prev_run_at: null,
      next_run_at: runAt, last_status: null, last_error: null, config_overlay: { destination: 'saved@example.test' },
      ...(opts.supported === false || opts.recurring ? {} : { reschedule_revision: 'saved-incarnation:1', reschedule_identity: 'saved-incarnation' }),
      ...(opts.reviewed ? { preapproval: { proposal_id: 'reviewed-old-time', future_execution_ref: 'future-old-time', execution_status: 'active' as const } } : {}),
    };
    const state: Window['__oneOffFixture'] = window.__oneOffFixture = { schedule, calls: [], outcome: 'ok', failReads: 0, cursor: 10_000, holdNextRead: false };
    window.__connectionsFixture = async (method, raw) => {
      state.calls.push({ method, args: raw });
      if (method === 'server.timezone.get') return { result: { setting: { mode: 'fixed', zone: 'Asia/Hong_Kong', updated_at: 1 }, resolved_zone: 'Asia/Hong_Kong', host_zone: 'Asia/Hong_Kong' } };
      if (method === 'schedules.list') {
        if (state.failReads > 0) { state.failReads--; return { error: { code: 'fixture_read', message: 'Current schedule unavailable.' } }; }
        const snapshot = structuredClone(state.schedule);
        if (state.holdNextRead) {
          state.holdNextRead = false;
          await new Promise<void>(resolve => { state.releaseRead = resolve; });
        }
        return { result: { schedules: [snapshot] } };
      }
      if (method !== 'schedules.reschedule') return undefined;
      const args = raw as { schedule_id: string; run_at: number; expected_revision: string };
      let outcome: string = state.outcome;
      if (outcome === 'hold') outcome = await new Promise<'ok' | 'refuse'>(resolve => { state.hold = resolve; });
      if (outcome === 'refuse') return { error: { code: 'conflict', message: 'This run already started.' } };
      if (args.expected_revision !== state.schedule.reschedule_revision) return { error: { code: 'conflict', message: 'This schedule changed.' } };
      if (outcome !== 'ignore') state.schedule = { ...state.schedule, run_at: args.run_at, next_run_at: args.run_at,
        reschedule_revision: state.schedule.reschedule_revision + ':next',
        ...(state.schedule.preapproval ? { enabled: false, preapproval: { ...state.schedule.preapproval, execution_status: 'invalidated' } } : {}) };
      if (outcome === 'lost') return { error: { code: 'connection_lost', message: 'The reply was lost.' } };
      const reply = structuredClone(state.schedule);
      if (outcome === 'hold_reply') await new Promise<void>(resolve => { state.releaseReply = resolve; });
      return { result: { schedule: reply } };
    };
  }, options);
  await page.goto(HARNESS_ORIGIN + '/full-app-harness.html?automation=dishes#automation/schedules/one-off-report');
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator('[data-recued-automation-detail="one-off-report"]')).toBeVisible();
  if (options.supported !== false && !options.recurring) {
    await page.getByRole('button', { name: 'Reschedule', exact: true }).click();
    await expect(editor(page)).toBeVisible();
  }
};
const refresh = async (page: Page) => {
  const before = (await calls(page, 'schedules.list')).length;
  await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: {
    kind: 'schedule', op: 'updated', cursor: ++window.__oneOffFixture.cursor,
  } }));
  await expect.poll(async () => (await calls(page, 'schedules.list')).length).toBeGreaterThan(before);
};
let errors: string[] = [], dialogs: string[] = [];
test.beforeEach(({ page }) => {
  errors = []; dialogs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
});
test.afterEach(() => { expect(errors).toEqual([]); expect(dialogs).toEqual([]); });

test('moves the same one-off run with visible browser and server clocks, preserving settings and history', async ({ page }) => {
  await open(page);
  const before = await page.evaluate(() => structuredClone(window.__oneOffFixture.schedule));
  await expect(page.getByText('Scheduled local writes', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Rehearsal and reviewed activation', { exact: true })).toHaveCount(0);
  await expect(input(page)).toHaveAccessibleName('New date and time (America/Los_Angeles)');
  await expect(editor(page).getByRole('button', { name: 'Save time', exact: true })).toBeDisabled();
  await input(page).fill(picked);
  await expect(editor(page)).toContainText('on the server (Asia/Hong_Kong)');
  await editor(page).getByRole('button', { name: 'Save time', exact: true }).click();
  await expect(editor(page).getByRole('status')).toContainText('Scheduled for');
  const after = await page.evaluate(() => window.__oneOffFixture.schedule);
  expect(after).toEqual({ ...before, run_at: pickedAt, next_run_at: pickedAt, reschedule_revision: 'saved-incarnation:1:next' });
  expect((await calls(page))[0]?.args).toEqual({ schedule_id: before.schedule_id, run_at: pickedAt, expected_revision: 'saved-incarnation:1' });
  for (const method of ['schedules.create', 'schedules.update', 'schedules.delete']) expect(await calls(page, method)).toHaveLength(0);
  await editor(page).getByRole('button', { name: 'Done' }).click();
  await expect(editor(page)).toHaveCount(0);
});

test('moving a paused run keeps it paused and does not re-arm old reviewed authority', async ({ page }) => {
  await open(page, { paused: true, reviewed: true });
  await expect(editor(page)).toContainText('Review the new time before enabling it.');
  await input(page).fill(picked);
  await editor(page).getByRole('button', { name: 'Save time' }).click();
  await expect(editor(page).getByRole('status')).toContainText('This run is paused.');
  expect(await page.evaluate(() => window.__oneOffFixture.schedule.preapproval?.execution_status)).toBe('invalidated');
  expect(await calls(page, 'schedules.update')).toHaveLength(0);
});

test('invalid dates, past dates and a daylight-saving gap issue no mutation; Cancel keeps the saved time', async ({ page }) => {
  await open(page);
  for (const value of ['', '2020-01-01T12:00', '2030-03-10T02:30']) {
    await input(page).fill(value);
    await editor(page).getByRole('button', { name: 'Save time' }).click();
    await expect(editor(page).getByRole('alert')).toContainText('valid future date and time');
  }
  expect(await calls(page)).toHaveLength(0);
  await editor(page).getByRole('button', { name: 'Cancel' }).click();
  expect(await page.evaluate(() => window.__oneOffFixture.schedule.run_at)).toBe(Date.UTC(2030, 0, 1, 1));
});

test('refreshes preserve the draft; a competing edit requires a fresh version before Save', async ({ page }) => {
  await open(page); await input(page).fill(picked);
  await refresh(page);
  await expect(input(page)).toHaveValue(picked);
  await page.evaluate(() => { window.__oneOffFixture.schedule.reschedule_revision = 'saved-incarnation:2'; });
  await refresh(page);
  await expect(editor(page)).toContainText('changed while you were editing');
  await expect(input(page)).toHaveValue(picked);
  await expect(editor(page).getByRole('button', { name: 'Save time' })).toHaveCount(0);
  await editor(page).getByRole('button', { name: 'Reload schedule' }).click();
  await expect(editor(page).getByRole('button', { name: 'Save time' })).toBeEnabled();
  await expect(input(page)).toHaveValue(picked);
  await editor(page).getByRole('button', { name: 'Save time' }).click();
  await expect(editor(page).getByRole('status')).toContainText('Scheduled for');
  expect((await calls(page))[0]?.args).toMatchObject({ expected_revision: 'saved-incarnation:2' });
});

test('a run that starts during the save is refused, while one pending command owns the controls', async ({ page }) => {
  await open(page); await input(page).fill(picked);
  await page.evaluate(() => { window.__oneOffFixture.outcome = 'hold'; });
  await editor(page).getByRole('button', { name: 'Save time' }).click();
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  await expect(editor(page).getByRole('button', { name: 'Saving…' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
  await page.evaluate(() => {
    const state = window.__oneOffFixture;
    delete state.schedule.reschedule_revision; state.schedule.last_run_at = state.schedule.run_at!;
    state.hold!('refuse');
  });
  await expect(editor(page).getByRole('alert')).toContainText('already started');
  await expect(input(page)).toHaveValue(picked);
  await expect(editor(page).getByRole('button', { name: 'Save time' })).toHaveCount(0);
  expect(await calls(page)).toHaveLength(1);
});

test('a lost reply is reconciled by reading the changed time without replaying the write', async ({ page }) => {
  await open(page); await input(page).fill(picked);
  await page.evaluate(() => { window.__oneOffFixture.outcome = 'lost'; });
  const before = (await calls(page, 'schedules.list')).length;
  await editor(page).getByRole('button', { name: 'Save time' }).click();
  await expect(editor(page).getByRole('status')).toContainText('Scheduled for');
  expect(await calls(page)).toHaveLength(1);
  expect(await calls(page, 'schedules.list')).toHaveLength(before + 1);
});

test('when save and reconciliation replies fail, Check saved time remains read-only and recovers', async ({ page }) => {
  await open(page); await input(page).fill(picked);
  await page.evaluate(() => { window.__oneOffFixture.outcome = 'lost'; window.__oneOffFixture.failReads = 1; });
  await editor(page).getByRole('button', { name: 'Save time' }).click();
  await expect(editor(page).getByRole('alert')).toContainText('could not be confirmed');
  await expect(input(page)).toHaveValue(picked);
  await expect(editor(page).getByRole('button', { name: 'Save time' })).toHaveCount(0);
  await editor(page).getByRole('button', { name: 'Check saved time' }).click();
  await expect(editor(page).getByRole('status')).toContainText('Scheduled for');
  expect(await calls(page)).toHaveLength(1);
});

test('an unconfirmed acknowledgement cannot claim that the time changed; an older server offers no editor', async ({ page }) => {
  await open(page); await input(page).fill(picked);
  await page.evaluate(() => { window.__oneOffFixture.outcome = 'ignore'; });
  await editor(page).getByRole('button', { name: 'Save time' }).click();
  await expect(editor(page).getByRole('alert')).toContainText('did not confirm');
  await expect(editor(page).getByRole('status')).toHaveCount(0);
  await expect(input(page)).toHaveValue(picked);
  await page.evaluate(() => { delete window.__oneOffFixture.schedule.reschedule_revision; });
  await editor(page).getByRole('button', { name: 'Cancel' }).click();
  await refresh(page);
  await expect(page.getByRole('button', { name: 'Reschedule', exact: true })).toHaveCount(0);
  expect(await calls(page)).toHaveLength(1);
});


test('a list requested before Save cannot overwrite its acknowledged new time', async ({ page }) => {
  await open(page); await input(page).fill(picked);
  await page.evaluate(() => { window.__oneOffFixture.holdNextRead = true; });
  await refresh(page);
  await page.waitForFunction(() => !!window.__oneOffFixture.releaseRead);
  await editor(page).getByRole('button', { name: 'Save time' }).click();
  await expect(editor(page).getByRole('status')).toContainText('Scheduled for');
  const cadence = page.locator('[data-recued-automation-detail] .automation-detail-grid');
  const newTiming = await cadence.textContent();
  await page.evaluate(async () => {
    window.__oneOffFixture.releaseRead!();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect(cadence).toHaveText(newTiming!);
  await expect(editor(page).getByRole('status')).toContainText('Scheduled for');
  expect(await calls(page)).toHaveLength(1);
});


test('reconciliation reports a run that already started instead of calling its disabled state paused', async ({ page }) => {
  await open(page); await input(page).fill(picked);
  await page.evaluate(() => { window.__oneOffFixture.outcome = 'lost'; window.__oneOffFixture.failReads = 1; });
  await editor(page).getByRole('button', { name: 'Save time' }).click();
  await expect(editor(page).getByRole('button', { name: 'Check saved time' })).toBeVisible();
  await page.evaluate(() => {
    const schedule = window.__oneOffFixture.schedule;
    schedule.last_run_at = schedule.run_at!; schedule.enabled = false; delete schedule.reschedule_revision;
  });
  await editor(page).getByRole('button', { name: 'Check saved time' }).click();
  await expect(editor(page).getByRole('status')).toContainText('already started');
  await expect(editor(page).getByRole('status')).not.toContainText('paused');
  expect(await calls(page)).toHaveLength(1);
});


test('a confirmed time follows a later pause and withdraws its confirmation after a different time is saved', async ({ page }) => {
  await open(page); await input(page).fill(picked);
  await editor(page).getByRole('button', { name: 'Save time' }).click();
  await expect(editor(page).getByRole('status')).toContainText('Scheduled for');
  await page.evaluate(() => { window.__oneOffFixture.schedule.enabled = false; window.__oneOffFixture.schedule.reschedule_revision += ':paused'; });
  await refresh(page);
  await expect(editor(page).getByRole('status')).toContainText('This run is paused.');
  await page.evaluate(() => {
    const s = window.__oneOffFixture.schedule; s.run_at = Date.UTC(2030,0,6,20); s.next_run_at = s.run_at;
    s.reschedule_revision += ':moved';
  });
  await refresh(page);
  await expect(editor(page).getByRole('status')).not.toContainText('Scheduled for');
  await expect(editor(page)).toContainText('changed after');
  await expect(editor(page)).toContainText('Jan 6, 2030');
  await expect(editor(page).getByRole('button', { name: 'Reload schedule' })).toBeVisible();
  expect(await calls(page)).toHaveLength(1);
});

test('a late saved-time read cannot overwrite a newer schedule broadcast', async ({ page }) => {
  await open(page); await input(page).fill(picked);
  await page.evaluate(() => { window.__oneOffFixture.outcome = 'lost'; window.__oneOffFixture.failReads = 1; });
  await editor(page).getByRole('button', { name: 'Save time' }).click();
  await expect(editor(page).getByRole('button', { name: 'Check saved time' })).toBeVisible();
  await page.evaluate(() => { window.__oneOffFixture.holdNextRead = true; });
  await editor(page).getByRole('button', { name: 'Check saved time' }).click();
  await page.waitForFunction(() => !!window.__oneOffFixture.releaseRead);
  await page.evaluate(() => {
    const s = window.__oneOffFixture.schedule; s.run_at = Date.UTC(2030,0,6,20); s.next_run_at = s.run_at;
    s.reschedule_revision += ':newer';
  });
  await refresh(page);
  await expect(editor(page)).toContainText('Jan 6, 2030');
  await page.evaluate(() => { window.__oneOffFixture.releaseRead!(); });
  await expect(editor(page).getByRole('alert')).toContainText('changed while');
  await expect(editor(page).getByRole('button', { name: 'Check saved time' })).toBeEnabled();
  await expect(page.locator('[data-recued-automation-detail] .automation-detail-grid')).toContainText('Jan 6, 2030');
  expect(await calls(page)).toHaveLength(1);
});


test('reconciliation cannot confirm a replacement with the same ID and requested time', async ({ page }) => {
  await open(page); await input(page).fill(picked);
  await page.evaluate(() => { window.__oneOffFixture.outcome = 'hold'; });
  await editor(page).getByRole('button', { name: 'Save time' }).click();
  await page.waitForFunction(() => !!window.__oneOffFixture.hold);
  await page.evaluate(() => {
    const state = window.__oneOffFixture;
    state.schedule = { ...state.schedule, run_at: Date.UTC(2030,0,4,20), next_run_at: Date.UTC(2030,0,4,20), reschedule_revision: 'replacement:1' };
    state.schedule.reschedule_identity = 'replacement';
    state.hold!('refuse');
  });
  await expect(editor(page).getByRole('alert')).toContainText('replaced');
  await expect(editor(page).getByRole('status')).toHaveCount(0);
  await expect(editor(page).getByRole('button', { name: 'Save time' })).toHaveCount(0);
  expect(await calls(page)).toHaveLength(1);
});


test('a late save acknowledgement checks the current run instead of replacing a newer time', async ({ page }) => {
  await open(page); await input(page).fill(picked);
  await page.evaluate(() => { window.__oneOffFixture.outcome = 'hold_reply'; });
  await editor(page).getByRole('button', { name: 'Save time' }).click();
  await page.waitForFunction(() => !!window.__oneOffFixture.releaseReply);
  await page.evaluate(() => {
    const s = window.__oneOffFixture.schedule; s.run_at = Date.UTC(2030,0,6,20); s.next_run_at = s.run_at; s.reschedule_revision += ':newer';
  });
  await refresh(page);
  await expect(editor(page)).toContainText('Jan 6, 2030');
  await page.evaluate(() => { window.__oneOffFixture.releaseReply!(); });
  await expect(editor(page).getByRole('alert')).toContainText('changed before the save was confirmed');
  await expect(page.locator('[data-recued-automation-detail] .automation-detail-grid')).toContainText('Jan 6, 2030');
  await expect(input(page)).toHaveValue(picked);
  await expect(editor(page).getByRole('button', { name: 'Reload schedule' })).toBeEnabled();
  expect(await calls(page)).toHaveLength(1);
});


test('recurring schedules retain their rehearsal and local-write tools', async ({ page }) => {
  await open(page, { recurring: true });
  await expect(page.getByRole('button', { name: 'Reschedule', exact: true })).toHaveCount(0);
  await expect(page.getByText('Scheduled local writes', { exact: true })).toBeVisible();
  await expect(page.getByText('Rehearsal and reviewed activation', { exact: true })).toBeVisible();
});
