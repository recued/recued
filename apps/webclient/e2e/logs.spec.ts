import type { ActiveExecutionEntry, ExecutionListQuery, RunAnchorStatus, RunFeedRow, RunYield } from '@recued/contracts';
import { expect, test, type Page } from '@playwright/test';
import {
  HARNESS_URL, LIVE_CONTROL_RUN_CONTROL, LIVE_CONTROL_TOGGLE,
  SHARED_PROVENANCE, SHARED_PROVENANCE_DETAIL, SHARED_PROVENANCE_PRIMARY,
  installFullAppHooks,
} from './helpers/full-app.js';

/** Logs and shared live-control journeys, including Chat and reconnect recovery. */
const LOGS_DETAIL_HEADING = 'data-recued-logs-detail-heading';
const LOGS_LOAD_MORE = 'data-recued-logs-load-more';
const LOGS_ROW = 'data-recued-logs-row';
const LOGS_ACTION = 'data-recued-logs-action';
const LOGS_ACTIVE_ROW = 'data-recued-logs-active-row';
const LOGS_PASS_ROW = 'data-recued-logs-pass-row';
const LOGS_ERROR = 'data-recued-logs-error';

installFullAppHooks();

declare global {
  interface Window {
    __connectionsFixture?: (method: string, args: unknown) => Promise<{ result?: unknown; error?: { code: string; message: string } } | undefined>;
    __logsManagementQueries?: ExecutionListQuery[];
    __logsManagementFailList?: boolean;
  }
}

const installManagementFixture = async (page: Page, options: { queueId?: string | null } = {}): Promise<void> => {
  const now = 1_700_000_000_000;
  const tally = (failed: number, total = 12, stopped_at: string | null = null): RunYield =>
    ({ steps_run: 2, steps_skipped: 0, items_total: total, items_failed: failed, stopped_at });
  const cases: Array<{ id: string; name: string; status: RunAnchorStatus; yield?: RunYield }> = [
    { id: 'finished', name: 'Completed import', status: 'succeeded', yield: tally(0) },
    { id: 'partial', name: 'Partially completed import', status: 'succeeded', yield: tally(3) },
    { id: 'refused', name: 'Refused import items', status: 'succeeded', yield: tally(12) },
    { id: 'stopped', name: 'Recipe stop condition', status: 'succeeded', yield: tally(0, 0, 'nothing_new') },
    { id: 'approval', name: 'Owner approval hold', status: 'awaiting_approval' },
    { id: 'peer', name: 'Peer reply hold', status: 'awaiting_peer' },
    { id: 'unknown', name: 'Uncertain external change', status: 'in_doubt', yield: tally(3) },
    { id: 'failed', name: 'Failed import', status: 'failed' },
    { id: 'cancelled', name: 'Cancelled import', status: 'cancelled' },
    { id: 'killed', name: 'Stopped by owner', status: 'killed' },
    { id: 'legacy', name: 'Older recorded run', status: 'succeeded' },
    { id: 'zero', name: 'Run without counted items', status: 'succeeded', yield: tally(0, 0) },
  ];
  const rows: RunFeedRow[] = cases.map((entry, index) => ({
    run_id: `history-${entry.id}`, recipe_id: 'fixture/run-management', name: entry.name,
    started_at: now - 4_000 - index * 1_000, finished_at: now - 2_000 - index * 1_000, duration_ms: 2_000,
    origin: { actor: 'user_self', label: 'user_self', channel: 'user' }, status: entry.status,
    policy_result: entry.status === 'awaiting_approval' ? 'approval-requested' : entry.status === 'failed' ? 'denied' : 'allowed',
    links: [], ...(entry.yield === undefined ? {} : { run_yield: entry.yield }),
  }));
  const run: ActiveExecutionEntry = {
    entry_kind: 'run', run_id: 'management-running', recipe_id: 'fixture/run-management', step_id: 'import',
    lane: 'local-heavy', state: 'running', origin: 'attended', source: { channel: 'user', actor: 'user_self', user_id: 'fixture-owner', client_token_id: 'fixture-client' },
    started_at: now - 30_000, slot_acquired_at: now - 15_000, intent: 'Import reviewed contacts',
    progress: { contract: 'silent', stalled: false }, kill: { mechanism: 'abandon_await', run_id: 'management-running' },
  };
  const entries: ActiveExecutionEntry[] = [run,
    { ...run, entry_kind: 'queued-call', run_id: 'management-queued',
      ...(options.queueId === null ? {} : { queued_call_id: options.queueId ?? 'management-call' }),
      state: 'waiting_slot', intent: 'Wait for import capacity' },
    { ...run, entry_kind: 'detached-job', run_id: 'management-detached', state: 'detached', intent: 'Watch for a recorded result', progress: { contract: 'silent', stalled: true } },
  ];
  await page.addInitScript(({ history, active }) => {
    let current = [...active];
    window.__logsManagementQueries = [];
    window.__connectionsFixture = async (method, raw) => {
      const args = (raw ?? {}) as ExecutionListQuery & { run_id?: string; queued_call_id?: string };
      if (method === 'execution.list') {
        window.__logsManagementQueries!.push(args);
        if (window.__logsManagementFailList) {
          window.__logsManagementFailList = false;
          return { error: { code: 'UNAVAILABLE', message: 'History could not be refreshed.' } };
        }
        const filtered = history.filter(row => (args.status === undefined || args.status.includes(row.status))
          && (args.origin === undefined || args.origin.includes(row.origin.actor))
          && (args.recipe_id === undefined || args.recipe_id === row.recipe_id)
          && (args.since === undefined || row.started_at >= args.since));
        const offset = args.cursor === undefined ? 0 : filtered.findIndex(row => row.run_id === args.cursor?.last_run_id) + 1;
        const runs = filtered.slice(offset, offset + 4);
        const last = runs.at(-1);
        return { result: { runs, ...(last === undefined || offset + runs.length >= filtered.length ? {} : {
          next_cursor: { last_run_id: last.run_id, last_started_at: last.started_at },
        }) } };
      }
      if (method === 'recipe.list') return { result: { recipes: [{ recipe_id: 'fixture/run-management', name: 'Run management fixture' }] } };
      if (method === 'execution.get') {
        const row = history.find(row => row.run_id === args.run_id);
        if (!row) return { result: { run: null } };
        return { result: { run: {
          audit: { ...row, recipe_hash: 'fixture-hash', trigger_source: 'manual', instance_id: 'fixture-server', errors: [] },
          approvals: { checkpoints: [] }, errors: [], links: [], gateway: { policy_result: row.policy_result, per_call_trace: [] },
        } } };
      }
      if (method === 'execution.active') return { result: { entries: current,
        lanes: [{ lane: 'local-heavy', capacity: 1, in_use: current.some(row => row.state === 'running') ? 1 : 0,
          queued: current.filter(row => row.entry_kind === 'queued-call').length, oldest_wait_ms: 3_000 }],
      } };
      if (method === 'execution.kill') {
        current = current.filter(row => row.run_id !== args.run_id);
        return { result: { status: 'killed' } };
      }
      if (method === 'execution.cancel') {
        current = current.filter(row => row.queued_call_id !== args.queued_call_id);
        return { result: { status: 'cancelled_before_dispatch' } };
      }
      if (method === 'execution.promote') return { result: { status: 'promoted' } };
      return undefined;
    };
  }, { history: rows, active: entries });
};

const RUN_SUMMARY = '[data-recued-logs-run-summary]';
const RUN_SUMMARY_STATUS = '[data-recued-logs-run-summary-status]';
const refreshLogsHistory = async (page: Page, cursor = 400): Promise<void> => {
  const before = await page.evaluate(() => window.__app.rpcCallCount('execution.list'));
  await page.evaluate(nextCursor => window.__app.fireMessage({
    type: 'server_event', event: { kind: 'session_lifecycle', session_id: 'session-verification',
      state: 'closed', prev_state: 'active', cursor: nextCursor },
  }), cursor);
  await page.waitForFunction(previous => window.__app.rpcCallCount('execution.list') > previous, before);
  await expect(page.locator('[data-recued-logs-route]')).toHaveAttribute('data-recued-logs-history-loading', 'false');
};

declare global {
  interface Window {
    __logsSummaryCopy?: { texts: string[]; resolve?: () => void; reject?: () => void };
  }
}
const deferRunSummaryClipboard = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const state = window.__logsSummaryCopy = { texts: [] } as NonNullable<Window['__logsSummaryCopy']>;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: (text: string) => {
        state.texts.push(text);
        return new Promise<void>((resolve, reject) => {
          state.resolve = resolve;
          state.reject = () => reject(new Error('private clipboard denial'));
        });
      },
    } });
  });
};

test('Chat stays usable when the platform getter is restricted', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      get() { throw new Error('private browser policy detail'); },
    });
  });
  await page.goto(`${HARNESS_URL}?chat=session#chat/new`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const find = page.getByRole('button', { name: 'Find', exact: true });
  await expect(find).toBeVisible();
  await expect(find).toHaveAttribute('title', 'Search everything on this server (Ctrl /)');
  await expect(page.getByRole('button', { name: 'Run a Recipe', exact: true }).first())
    .toHaveAttribute('title', 'Run a Recipe (Ctrl K)');
  await find.click();
  await expect(page).toHaveURL(/#data\/search$/);
  await expect(page.locator('body')).not.toContainText('private browser policy detail');
});

for (const blocked of ['navigator', 'locks', 'request']) {
  test(`Chat starts when Web Locks access throws at ${blocked}`, async ({ page }) => {
    await page.addInitScript(property => {
      const denied = (): never => { throw new Error('private browser policy detail'); };
      if (property === 'navigator') {
        Object.defineProperty(window, 'navigator', { configurable: true, get: denied });
      } else {
        Object.defineProperty(navigator, 'locks', {
          configurable: true,
          ...(property === 'locks' ? { get: denied }
            : { value: Object.defineProperty({}, 'request', { get: denied }) }),
        });
      }
    }, blocked);
    await page.goto(`${HARNESS_URL}?chat=session#chat/new`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await expect(page.getByRole('textbox', { name: 'Message to Recued' })).toBeVisible();
    await page.getByRole('button', { name: 'Find', exact: true }).click();
    await expect(page).toHaveURL(/#data\/search$/);
    await expect(page.locator('body')).not.toContainText('private browser policy detail');
  });
}

for (const blocked of ['getUserMedia', 'codec getter', 'codec probe']) {
  test(`Chat starts when voice capability discovery throws at ${blocked}`, async ({ page }) => {
    await page.addInitScript(property => {
      const denied = (): never => { throw new Error('private browser policy detail'); };
      if (property === 'getUserMedia') {
        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { get: denied });
      } else {
        Object.defineProperty(MediaRecorder, 'isTypeSupported',
          property === 'codec getter' ? { get: denied } : { value: denied });
      }
    }, blocked);
    await page.goto(`${HARNESS_URL}?chat=session#chat/new`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const message = page.getByRole('textbox', { name: 'Message to Recued' });
    await expect(message).toBeVisible();
    await message.fill('Keep this draft');
    await expect(message).toHaveValue('Keep this draft');
    await expect(page.getByRole('button', { name: 'Record a voice note', exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('private browser policy detail');
  });
}

for (const width of [375, 1280]) {
  test(`Logs copies recorded run metadata by keyboard at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${HARNESS_URL}?journey=verification&logs_summary=1#logs/run-verify`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    const summary = page.locator(RUN_SUMMARY);
    const copy = summary.getByRole('button', { name: 'Copy run summary', exact: true });
    await copy.focus(); await page.keyboard.press('Enter');
    await expect(summary.locator(RUN_SUMMARY_STATUS)).toHaveText('Run summary copied.');
    await expect(copy).toBeFocused();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    await summary.getByText('View run summary', { exact: true }).click();
    const field = summary.getByRole('textbox', { name: 'Run summary text' });
    expect(text).toBe(await field.inputValue());
    expect(text).toContain('Recipe: calendar/schedule-review\nRecipe hash: hash-verification-run\nRun ID: run-verify');
    expect(text).toContain('Recorded status: in_doubt\nPolicy result: released-after-approval');
    expect(text).toContain('Duration: 2000 ms\nSteps run: 4\nSteps skipped: 1\nItems attempted: 12\nFailed items: 3');
    expect(text).toContain('Error codes: BAD_INPUT');
    expect(text).not.toMatch(/private|server-verification|event-1/);
    await expect(field).toHaveAttribute('readonly', '');
    expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(width === 375 ? 44 : 36);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await summary.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('logs-run-summary.png') });
  });
}

for (const mode of ['missing', 'denied', 'throwing-getter', 'throwing-write-getter']) {
  test(`Logs offers selectable summary text when clipboard access is ${mode}`, async ({ page }) => {
    const configureClipboard = (clipboardMode: string): void => {
      Object.defineProperty(navigator, 'clipboard', clipboardMode === 'throwing-getter'
        ? { configurable: true, get() { throw new Error('private clipboard detail'); } }
        : { configurable: true, value: clipboardMode === 'missing' ? undefined
          : clipboardMode === 'throwing-write-getter'
            ? Object.defineProperty({}, 'writeText', { get() { throw new Error('private clipboard detail'); } })
            : { writeText: () => Promise.reject(new Error('private clipboard detail')) } });
    };
    await page.addInitScript(configureClipboard, mode);
    await page.goto(`${HARNESS_URL}?journey=verification&logs_summary=1#logs/run-verify`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const summary = page.locator(RUN_SUMMARY);
    await summary.getByRole('button', { name: 'Copy run summary', exact: true }).focus();
    await page.keyboard.press('Enter');
    const field = summary.getByRole('textbox', { name: 'Run summary text' });
    await expect(field).toBeVisible(); await expect(field).toBeFocused();
    expect(await field.evaluate((node: HTMLTextAreaElement) => node.selectionStart === 0 && node.selectionEnd === node.value.length)).toBe(true);
    await expect(summary.locator(RUN_SUMMARY_STATUS)).toHaveText('Recued could not copy it. Copy the summary below.');
    await expect(summary).not.toContainText('private clipboard detail');
    if (mode === 'denied') {
      await field.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 10, 'backward'));
      await refreshLogsHistory(page);
      await expect(field).toBeFocused();
      expect(await field.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection]))
        .toEqual([2, 10, 'backward']);
      await expect(summary.locator('details')).toHaveAttribute('open', '');
      await summary.getByText('View run summary', { exact: true }).click();
      await refreshLogsHistory(page, 401);
      await expect(summary.locator('details')).not.toHaveAttribute('open', '');
    }
  });
}

test('Logs keeps summary copy single-flight and keyboard-owned through a background repaint', async ({ page }) => {
  await deferRunSummaryClipboard(page);
  await page.goto(`${HARNESS_URL}?journey=verification#logs/run-verify`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const summary = page.locator(RUN_SUMMARY);
  const copy = summary.getByRole('button', { name: 'Copy run summary', exact: true });
  await copy.focus(); await page.keyboard.press('Enter');
  await expect(copy).toHaveAttribute('aria-busy', 'true');
  await refreshLogsHistory(page);
  await expect(copy).toHaveAttribute('aria-disabled', 'true');
  await expect(copy).not.toHaveAttribute('disabled');
  await expect(copy).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__logsSummaryCopy?.texts.length)).toBe(1);
  await page.evaluate(() => window.__logsSummaryCopy?.resolve?.());
  await expect(summary.locator(RUN_SUMMARY_STATUS)).toHaveText('Run summary copied.');
  await expect(copy).toBeFocused();
  await expect(copy).not.toHaveAttribute('aria-busy');
  expect(await summary.locator('textarea').inputValue()).toContain('Yield: Not recorded');
});

for (const width of [375, 1280]) {
  test(`Logs preserves summary reading position and size through a refresh at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${HARNESS_URL}?journey=verification&logs_summary=1#logs/run-verify`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const summary = page.locator(RUN_SUMMARY);
    const disclosure = summary.getByText('View run summary', { exact: true });
    await disclosure.click();
    const field = summary.getByRole('textbox', { name: 'Run summary text' });
    const before = await field.evaluate((node: HTMLTextAreaElement) => {
      node.style.height = '240px';
      node.scrollTop = node.scrollHeight;
      return { height: node.getBoundingClientRect().height, scrollTop: node.scrollTop };
    });
    expect(before.scrollTop).toBeGreaterThan(0);
    await expect(disclosure).toBeFocused();
    await refreshLogsHistory(page);
    await expect(disclosure).toBeFocused();
    expect(await field.evaluate((node: HTMLTextAreaElement) => ({
      height: node.getBoundingClientRect().height, scrollTop: node.scrollTop,
    }))).toEqual(before);
  });
}

for (const success of [true, false]) {
  test(`Logs ignores late clipboard ${success ? 'success' : 'denial'} after selecting another run`, async ({ page }) => {
    await deferRunSummaryClipboard(page);
    await page.goto(`${HARNESS_URL}?journey=verification&logs=paged#logs/run-verify`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const summary = page.locator(RUN_SUMMARY);
    const copy = summary.getByRole('button', { name: 'Copy run summary', exact: true });
    await copy.click(); await expect(copy).toHaveAttribute('aria-busy', 'true');
    await page.getByRole('link', { name: 'Back to history' }).click();
    await page.locator(`[${LOGS_ACTION}="load-more"]`).click();
    await page.locator(`[${LOGS_ROW}="run-verify-older"] [${LOGS_ACTION}="open-detail"]`).click();
    await expect(summary).toHaveAttribute('data-recued-logs-run-summary', 'run-verify-older');
    await expect(copy).not.toHaveAttribute('aria-busy');
    await copy.focus();
    await page.evaluate(ok => ok ? window.__logsSummaryCopy?.resolve?.() : window.__logsSummaryCopy?.reject?.(), success);
    await expect(summary.locator(RUN_SUMMARY_STATUS)).toBeEmpty();
    await expect(summary.locator('details')).not.toHaveAttribute('open', '');
    await expect(copy).toBeFocused();
    expect(await summary.locator('textarea').inputValue()).toContain('Run ID: run-verify-older');
  });
}

test('Logs does not move a newer focus when a delayed clipboard denial arrives', async ({ page }) => {
  await deferRunSummaryClipboard(page);
  await page.goto(`${HARNESS_URL}?journey=verification#logs/run-verify`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const summary = page.locator(RUN_SUMMARY);
  await summary.getByRole('button', { name: 'Copy run summary', exact: true }).click();
  const back = page.getByRole('link', { name: 'Back to history' });
  await back.focus();
  await page.evaluate(() => window.__logsSummaryCopy?.reject?.());
  await expect(summary.locator(RUN_SUMMARY_STATUS)).toContainText('Recued could not copy it.');
  await expect(summary.getByRole('textbox', { name: 'Run summary text' })).toBeVisible();
  await expect(back).toBeFocused();
});

test('Logs ignores a pending summary copy after leaving the route', async ({ page }) => {
  await deferRunSummaryClipboard(page);
  await page.goto(`${HARNESS_URL}?journey=verification#logs/run-verify`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator(RUN_SUMMARY).getByRole('button', { name: 'Copy run summary', exact: true }).click();
  await page.evaluate(() => window.__app.setHash('#recipes'));
  await page.waitForFunction(() => window.__app.activeRoute() === 'recipes');
  await page.evaluate(() => window.__logsSummaryCopy?.reject?.());
  await expect(page.locator(RUN_SUMMARY)).toHaveCount(0);
  await expect(page).toHaveURL(/#recipes$/);
});

test('Logs offers a summary only after the exact run detail arrives', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?journey=verification&hold_rpc=execution.get#logs/run-verify`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator('[data-recued-logs-detail]')).toContainText('Loading run-verify');
  await expect(page.locator(RUN_SUMMARY)).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('execution.get'))).toBe(1);
  await expect(page.locator(RUN_SUMMARY)).toBeVisible();
});

test('Logs contains long run identifiers in mobile history and detail', async ({ page }) => {
  const longName = `Run${'N'.repeat(240)}`;
  const longRecipeId = `calendar/${'recipe'.repeat(40)}`;
  await page.setViewportSize({ width: 280, height: 480 });
  await page.goto(
    `${HARNESS_URL}?journey=verification&logs_text=long#logs`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const row = page.locator(`[${LOGS_ROW}="run-verify"]`);
  await expect(row.locator('.logs-cell-title')).toHaveText(longName);
  await expect(row.locator('.logs-cell-sub')).toHaveText(longRecipeId);
  const historyGeometry = await row.evaluate((node) => {
    const route = node.closest<HTMLElement>('[data-recued-logs-route]');
    const selectors = [
      'td[data-label="Run"]',
      '.logs-cell-title',
      '.logs-cell-sub',
    ];
    const elements = [
      node,
      ...selectors.map((selector) => node.querySelector<HTMLElement>(selector)),
    ].filter((element): element is HTMLElement => element !== null);
    return {
      elements: elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      }),
      routeScrollWidth: route?.scrollWidth ?? 0,
      routeClientWidth: route?.clientWidth ?? 0,
    };
  });
  for (const bounds of historyGeometry.elements) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  }
  expect(historyGeometry.routeScrollWidth)
    .toBeLessThanOrEqual(historyGeometry.routeClientWidth);

  await row.locator(`[${LOGS_ACTION}="open-detail"]`).click();
  const heading = page.locator(`[${LOGS_DETAIL_HEADING}="run-verify"]`);
  await expect(heading).toHaveText(longName);
  const detail = page.locator('[data-recued-logs-detail="run-verify"]');
  const detailGeometry = await detail.evaluate((node) => {
    const route = node.closest<HTMLElement>('[data-recued-logs-route]');
    const elements = [
      node,
      node.querySelector<HTMLElement>('[data-recued-logs-detail-heading]'),
      node.querySelector<HTMLElement>('.logs-detail-meta'),
      ...node.querySelectorAll<HTMLElement>('.logs-detail-meta > span'),
      ...node.querySelectorAll<HTMLElement>('.logs-detail-row'),
      ...node.querySelectorAll<HTMLElement>('.logs-row-links a'),
    ].filter((element): element is HTMLElement => element !== null);
    return {
      elements: elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      }),
      routeScrollWidth: route?.scrollWidth ?? 0,
      routeClientWidth: route?.clientWidth ?? 0,
    };
  });
  for (const bounds of detailGeometry.elements) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  }
  expect(detailGeometry.routeScrollWidth)
    .toBeLessThanOrEqual(detailGeometry.routeClientWidth);
});

test('Logs preserves outside-actor run provenance from history through detail', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?journey=verification&reference_provenance=1#logs`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const row = page.locator(`[${LOGS_ROW}="run-verify"]`);
  const rowProvenance = row.locator(`[${SHARED_PROVENANCE}]`);
  await expect(rowProvenance.locator(`[${SHARED_PROVENANCE_PRIMARY}]`))
    .toHaveText('Connected agent');
  await expect(rowProvenance.locator(`[${SHARED_PROVENANCE_DETAIL}]`)).toHaveText(
    'agent browser-agent, under contract browser-contract, asserted this',
  );

  await row.locator(`[${LOGS_ACTION}="open-detail"]`).click();
  const detail = page.locator('[data-recued-logs-detail="run-verify"]');
  const detailProvenance = detail.locator(`[${SHARED_PROVENANCE}]`);
  await expect(detailProvenance.locator(`[${SHARED_PROVENANCE_PRIMARY}]`))
    .toHaveText('Connected agent');
  await expect(detailProvenance.locator(`[${SHARED_PROVENANCE_DETAIL}]`)).toHaveText(
    'agent browser-agent, under contract browser-contract, asserted this',
  );
});

test('Logs contains long live-run and pass labels on a narrow phone', async ({ page }) => {
  const recipeId = `recipe-${'R'.repeat(240)}`;
  const stepId = `step-${'S'.repeat(240)}`;
  const passName = `Pass${'P'.repeat(240)}`;
  await page.setViewportSize({ width: 280, height: 480 });
  await page.goto(
    `${HARNESS_URL}?live=running&logs_passes=active&logs_text=long#logs`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const peekTitle = page.locator('.logs-peek-title').first();
  await expect(peekTitle).toHaveText(`${recipeId} · ${stepId}`);
  const peekGeometry = await page.locator('[data-recued-logs-route]').evaluate(
    (route) => ({
      routeScrollWidth: route.scrollWidth,
      routeClientWidth: route.clientWidth,
      elements: [
        ...route.querySelectorAll<HTMLElement>(
          '.logs-peek-title, .logs-peek-sub',
        ),
      ].map((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        right: element.getBoundingClientRect().right,
      })),
    }),
  );
  expect(peekGeometry.routeScrollWidth)
    .toBeLessThanOrEqual(peekGeometry.routeClientWidth);
  for (const bounds of peekGeometry.elements) {
    expect(bounds.right).toBeLessThanOrEqual(280.5);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  }

  await page.evaluate(() => window.__app.setHash('#logs/active'));
  const activeRow = page.locator(`[${LOGS_ACTIVE_ROW}]`).first();
  const passRow = page.locator(`[${LOGS_PASS_ROW}]`).first();
  await expect(activeRow.locator('.logs-active-title'))
    .toHaveText(`${recipeId} · ${stepId}`);
  await expect(passRow.locator('.logs-active-title')).toHaveText(passName);
  await expect(activeRow.locator('.logs-active-meta')).toContainText(
    `lane-${'L'.repeat(240)}`,
  );
  await expect(passRow.locator('.logs-active-meta')).toContainText(
    `operation.${'O'.repeat(240)}`,
  );
  const activeGeometry = await page.locator(
    '[data-recued-logs-route]',
  ).evaluate((route) => {
    const elements = [
      ...route.querySelectorAll<HTMLElement>(
        '[data-recued-logs-active-row], '
        + '[data-recued-logs-pass-row], '
        + '.logs-active-title, '
        + '.logs-active-meta, '
        + '.logs-active-meta > span, '
        + '.logs-active-controls',
      ),
    ];
    return {
      routeScrollWidth: route.scrollWidth,
      routeClientWidth: route.clientWidth,
      elements: elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      }),
    };
  });
  expect(activeGeometry.routeScrollWidth)
    .toBeLessThanOrEqual(activeGeometry.routeClientWidth);
  for (const bounds of activeGeometry.elements) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  }
});

test('Logs moves focus into an opened run detail and preserves it through a feed repaint', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?journey=verification`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#logs'));

  const openRun = page.getByRole('button', {
    name: 'Open run detail for Schedule customer review (run-verify)',
    exact: true,
  });
  await expect(openRun).toBeVisible();
  await openRun.focus();
  await page.keyboard.press('Enter');

  const heading = page.locator(`[${LOGS_DETAIL_HEADING}="run-verify"]`);
  await expect(page).toHaveURL(/#logs\/run-verify$/);
  await expect(heading).toHaveText('Schedule customer review');
  await expect(heading).toHaveAttribute('tabindex', '-1');
  await expect(heading).toBeFocused();

  const listCalls = await page.evaluate(
    () => window.__app.rpcCallCount('execution.list'),
  );
  await page.evaluate(() => {
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'session_lifecycle',
        session_id: 'session-verification',
        state: 'closed',
        prev_state: 'active',
        cursor: 20,
      },
    });
  });
  await page.waitForFunction(
    (previous) => window.__app.rpcCallCount('execution.list') > previous,
    listCalls,
  );
  await expect(heading).toBeFocused();
});

test('Logs renders bare History after opening an in-page run detail', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?journey=verification`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#logs'));

  const openRun = page.getByRole('button', {
    name: 'Open run detail for Schedule customer review (run-verify)',
    exact: true,
  });
  await openRun.click();
  const heading = page.locator(`[${LOGS_DETAIL_HEADING}="run-verify"]`);
  await expect(heading).toHaveText('Schedule customer review');
  await expect(page).toHaveURL(/#logs\/run-verify$/);

  // The detail was selected through History (which emits no hashchange). A
  // later navigation to the prior hash must render the unselected History view.
  await page.evaluate(() => window.__app.setHash('#logs'));
  await expect(page).toHaveURL(/#logs$/);
  await expect(heading).toHaveCount(0);
  await expect(openRun).toBeVisible();
});

test('Logs keeps failed run-detail recovery keyboard-owned and single-flight', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?journey=verification&logs_detail_response=fail-once-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#logs'));

  const opener = page.locator(
    `[${LOGS_ROW}="run-verify"] [${LOGS_ACTION}="open-detail"]`,
  );
  await opener.focus();
  await page.keyboard.press('Enter');

  await expect(opener).toHaveCount(0);
  const loadingHeading = page.locator(`[${LOGS_DETAIL_HEADING}="run-verify"]`);
  await expect(loadingHeading).toBeFocused();
  await expect(page.locator('[data-recued-logs-detail]')).toHaveAttribute('aria-busy', 'true');
  expect(await page.evaluate(() => window.__app.rpcCallCount('execution.get'))).toBe(1);

  await expect(page.getByRole('alert')).toHaveText('Run detail unavailable.');
  const retry = page.locator(`[${LOGS_ACTION}="retry-detail"]`);
  await expect(retry).toHaveText('Retry');
  await expect(retry).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.dispatchEvent('click');
  await retry.dispatchEvent('click');
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount('execution.get'),
  )).toBe(2);

  const heading = page.locator(`[${LOGS_DETAIL_HEADING}="run-verify"]`);
  await expect(heading).toHaveText('Schedule customer review');
  await expect(heading).toBeFocused();
  await expect(retry).toHaveCount(0);
});

for (const width of [375, 1280]) {
  test(`Logs clears all filters and the recipe URL scope by keyboard at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${HARNESS_URL}?journey=verification&logs_filters=1#logs/recipe/calendar%2Fschedule-review`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const status = page.locator('[data-recued-logs-filter="status"]');
    const origin = page.locator('[data-recued-logs-filter="origin"]');
    const time = page.locator('[data-recued-logs-filter="time_range"]');
    const recipe = page.getByRole('combobox', { name: 'Show only one Recipe' });
    await expect(page.locator(`[${LOGS_ROW}="run-verify"]`)).toBeVisible();
    await status.selectOption('failed');
    await origin.selectOption('contracted_user');
    await time.selectOption('7d');
    await page.locator(`[${LOGS_ACTION}="apply-filters"]`).click();
    await expect(page.getByText('No runs match these filters.', { exact: true })).toBeVisible();
    const before = await page.evaluate(() => window.__app.rpcCallCount('execution.list'));
    await page.evaluate(() => window.__app.holdRpcResponses?.('execution.list'));
    const clear = page.locator(`[${LOGS_ACTION}="clear-filters"]`);
    await clear.focus();
    await page.keyboard.press('Enter');
    await expect(clear).toHaveText('Clearing…');
    await expect(clear).toHaveAttribute('aria-disabled', 'true');
    await expect(clear).toHaveAttribute('aria-busy', 'true');
    await expect(clear).not.toHaveAttribute('disabled');
    await expect(clear).toBeFocused();
    await page.keyboard.press('Enter');
    await clear.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    expect(await page.evaluate(() => window.__app.rpcCallCount('execution.list'))).toBe(before + 1);
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('execution.list'))).toBe(1);
    await expect(clear).toHaveText('Clear filters');
    await expect(clear).not.toHaveAttribute('aria-busy');
    await expect(clear).not.toHaveAttribute('aria-disabled');
    await expect(clear).toBeFocused();
    await expect(status).toHaveValue('all');
    await expect(origin).toHaveValue('all');
    await expect(time).toHaveValue('all');
    await expect(recipe).toHaveValue('');
    await expect(page).toHaveURL(/#logs$/);
    await expect(page.locator(`[${LOGS_ROW}="run-verify"]`)).toBeVisible();
    expect((await clear.boundingBox())!.height).toBeGreaterThanOrEqual(width === 375 ? 44 : 36);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await clear.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('logs-clear-filters.png') });
    await page.reload();
    await page.waitForFunction(() => window.__app?.ready === true);
    await expect(recipe).toHaveValue('');
    await expect(page.locator(`[${LOGS_ROW}="run-verify"]`)).toBeVisible();
    await expect(page).toHaveURL(/#logs$/);
  });
}

test('Logs keeps a newer filter draft and its focus when a clear request completes', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?journey=verification&logs_filters=1#logs`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const status = page.locator('[data-recued-logs-filter="status"]');
  const clear = page.locator(`[${LOGS_ACTION}="clear-filters"]`);
  await expect(clear).not.toHaveAttribute('aria-busy');
  await page.evaluate(() => window.__app.holdRpcResponses?.('execution.list'));
  await clear.click();
  await expect(clear).toHaveText('Clearing…');
  await status.focus();
  await status.selectOption('failed');
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('execution.list'))).toBe(1);
  await expect(clear).toHaveText('Clear filters');
  await expect(status).toBeFocused();
  await expect(status).toHaveValue('failed');
});

test('Logs keeps history controls out of a directly addressed run workspace', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?journey=verification&logs_filters=1#logs/run-verify`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator('[data-recued-logs-detail="run-verify"]')).toBeVisible();
  await expect(page.locator(`[${LOGS_ROW}]`)).toHaveCount(0);
  await expect(page.locator('[data-recued-logs-filter]')).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to history' }).click();
  await expect(page).toHaveURL(/#logs$/);
  await expect(page.locator(`[${LOGS_ROW}="run-verify"]`)).toBeVisible();
  await expect(page.locator('[data-recued-logs-detail]')).toHaveCount(0);
});

for (const entry of ['history', 'deep-link'] as const) {
  test(`Logs ignores a pending ${entry} detail after returning to history`, async ({ page }) => {
    const hash = entry === 'history' ? '#logs' : '#logs/run-verify';
    await page.goto(`${HARNESS_URL}?journey=verification&logs_filters=1&hold_rpc=execution.get${hash}`);
    await page.waitForFunction(() => window.__app?.ready === true);
    if (entry === 'history') {
      await page.locator(`[${LOGS_ROW}="run-verify"] [${LOGS_ACTION}="open-detail"]`).click();
    }
    await expect(page.locator('[data-recued-logs-detail]')).toContainText('Loading run-verify');
    await page.getByRole('link', { name: 'Back to history' }).click();
    const clear = page.locator(`[${LOGS_ACTION}="clear-filters"]`);
    await clear.focus();
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('execution.get'))).toBe(1);
    await expect(page.locator('[data-recued-logs-detail]')).toHaveCount(0);
    await expect(clear).toBeFocused();
    await expect(page).toHaveURL(/#logs$/);
  });
}

test('Logs preserves Apply focus through a filtered feed repaint', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?journey=verification&logs_feed_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#logs'));

  const status = page.locator('[data-recued-logs-filter="status"]');
  await expect(status).toBeVisible();
  await status.selectOption('in_doubt');

  const apply = page.locator(`[${LOGS_ACTION}="apply-filters"]`);
  const listCalls = await page.evaluate(
    () => window.__app.rpcCallCount('execution.list'),
  );
  await apply.focus();
  await page.keyboard.press('Enter');

  await expect(apply).toHaveText('Applying…');
  await expect(apply).toHaveAttribute('aria-disabled', 'true');
  await expect(apply).toHaveAttribute('aria-busy', 'true');
  await expect(apply).not.toHaveAttribute('disabled');
  await expect(apply).toBeFocused();
  await apply.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('execution.list')),
  ).toBe(listCalls + 1);

  await expect(apply).toHaveText('Apply');
  await expect(apply).not.toHaveAttribute('aria-disabled');
  await expect(apply).not.toHaveAttribute('aria-busy');
  await expect(status).toHaveValue('in_doubt');
  await expect(apply).toBeFocused();
});

test('Logs preserves filter focus and caret through feed repaints', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?journey=verification`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#logs'));

  const refreshFeed = async (cursor: number): Promise<void> => {
    const before = await page.evaluate(
      () => window.__app.rpcCallCount('execution.list'),
    );
    await page.evaluate((nextCursor) => {
      window.__app.fireMessage({
        type: 'server_event',
        event: {
          kind: 'session_lifecycle',
          session_id: 'session-verification',
          state: 'closed',
          prev_state: 'active',
          cursor: nextCursor,
        },
      });
    }, cursor);
    await page.waitForFunction(
      (previous) => window.__app.rpcCallCount('execution.list') > previous,
      before,
    );
  };

  const status = page.locator('[data-recued-logs-filter="status"]');
  await status.focus();
  await status.selectOption('in_doubt');
  await expect(status).toBeFocused();
  await refreshFeed(41);
  await expect(status).toHaveValue('in_doubt');
  await expect(status).toBeFocused();

  const picker = page.getByRole('combobox', { name: 'Show only one Recipe' });
  await picker.fill('calendar');
  await picker.evaluate((input) => {
    (input as HTMLInputElement).setSelectionRange(3, 3);
  });
  await refreshFeed(42);
  await expect(picker).toHaveValue('calendar');
  await expect(picker).toBeFocused();
  expect(await picker.evaluate((input) =>
    (input as HTMLInputElement).selectionStart)).toBe(3);
});

test('Logs gives history, detail, and live controls full mobile targets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const expectFullTargets = async (): Promise<void> => {
    const route = page.locator('[data-recued-logs-route]');
    const dimensions = await route.locator(
      'a:visible, button:visible, input:visible, select:visible, textarea:visible',
    ).evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }));
    expect(dimensions.length).toBeGreaterThan(0);
    expect(Math.min(...dimensions.map(({ width }) => width)))
      .toBeGreaterThanOrEqual(36);
    expect(Math.min(...dimensions.map(({ height }) => height)))
      .toBeGreaterThanOrEqual(36);
    expect(await route.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    )).toBe(true);
  };

  await page.goto(`${HARNESS_URL}?journey=verification&logs=paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#logs'));
  await expect(page.locator(`[${LOGS_ROW}="run-verify"]`)).toBeVisible();
  expect(await page.locator(
    `[${LOGS_ROW}="run-verify"] .logs-cell-status, `
      + `[${LOGS_ROW}="run-verify"] .logs-cell-policy`,
  ).evaluateAll((cells) => cells.map((cell) => {
    const style = getComputedStyle(cell);
    return { display: style.display, columnGap: style.columnGap };
  }))).toEqual([
    { display: 'flex', columnGap: '8px' },
    { display: 'flex', columnGap: '8px' },
  ]);
  const detail = page.getByRole('region', {
    name: 'Run detail',
  });
  await expect(detail).toHaveCount(0);
  await expectFullTargets();

  await page.locator(
    `[${LOGS_ROW}="run-verify"] [${LOGS_ACTION}="open-detail"]`,
  ).click();
  await expect(page.locator(`[${LOGS_DETAIL_HEADING}="run-verify"]`))
    .toBeVisible();
  await expect(detail).toBeVisible();
  await expectFullTargets();

  await page.goto(`${HARNESS_URL}?live=running&logs_passes=active`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#logs/active'));
  await expect(page.locator(`[${LOGS_ACTIVE_ROW}]`)).toHaveCount(2);
  await expect(page.locator(`[${LOGS_PASS_ROW}]`)).toHaveCount(2);
  await expectFullTargets();
});

test('Logs guards pagination and focuses the first appended run', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?journey=verification&logs=paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#logs'));

  const loadMore = page.locator(`[${LOGS_LOAD_MORE}]`);
  await expect(loadMore).toBeVisible();
  await loadMore.focus();
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('execution.list'),
  );
  await page.evaluate((attr) => {
    document.querySelector<HTMLElement>(`[${attr}]`)?.click();
    document.querySelector<HTMLElement>(`[${attr}]`)?.click();
  }, LOGS_LOAD_MORE);

  const appended = page.locator(`[${LOGS_ROW}="run-verify-older"]`);
  await expect(appended).toBeVisible();
  await expect(loadMore).toHaveCount(0);
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('execution.list'),
    ),
  ).toBe(before + 1);
  await expect(
    appended.getByRole('button', {
      name: 'Open run detail for Sync customer account (run-verify-older)',
      exact: true,
    }),
  ).toBeFocused();
  await expect(page.getByRole('button', {
    name: 'Open run detail for Schedule customer review (run-verify)',
    exact: true,
  })).toHaveCount(1);
});

test('Tool progress refreshes live control without polling the chat session list', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?live=interrupted&chat=session#chat/session/chat_1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('chat.session.get'))).toBeGreaterThan(0);
  const lists = await page.evaluate(() => window.__app.rpcCallCount('chat.sessions.list'));
  const active = await page.evaluate(() => window.__app.rpcCallCount('execution.active'));
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event', event: { kind: 'chat.session_changed', session_id: 'chat_1',
      field: 'tool_call', cursor: 100,
      value: { message_id: 'call-streaming', session_id: 'chat_1', turn_id: 'turn-streaming',
        tool_name: 'recipe.run', run_id: 'run-streaming', state: 'running',
        started_at: 1_000, updated_at: 2_000, last_signal_at: 2_000 },
    },
  }));
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('execution.active'))).toBeGreaterThan(active);
  expect(await page.evaluate(() => window.__app.rpcCallCount('chat.sessions.list'))).toBe(lists);
});

test('Live bubble restores interrupted calls on load and reconnect without restarting work', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(`${HARNESS_URL}?live=interrupted&chat=session`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const toggle = page.locator(`[${LIVE_CONTROL_TOGGLE}]`);
  await expect(toggle).toHaveText('◉ 1');
  await toggle.click();
  const row = page.locator('[data-recued-live-control-tool-row="tool-recovered"]');
  await expect(row).toContainText('Stopped part-way. Recued does not know what happened');
  await expect(row).toContainText('last progress');
  await expect(row.locator(`[${LIVE_CONTROL_RUN_CONTROL}]`)).toHaveCount(0);
  await expect(row.getByRole('link', { name: 'Open chat' })).toHaveAttribute('href', '#chat/session/chat_1');
  const reviewBounds = await row.getByRole('button', { name: /Mark as looked at/ }).boundingBox();
  expect(reviewBounds).not.toBeNull();
  expect(reviewBounds!.x).toBeGreaterThanOrEqual(0);
  expect(reviewBounds!.x + reviewBounds!.width).toBeLessThanOrEqual(320);
  await row.getByRole('link', { name: 'Open chat' }).focus();
  const before = await page.evaluate(() => window.__app.rpcCallCount('execution.active'));
  await page.evaluate(() => { window.__app.fireState('reconnecting'); window.__app.fireState('connected'); });
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('execution.active'))).toBeGreaterThan(before);
  await expect(row).toContainText('Stopped part-way. Recued does not know what happened');
  await expect(row.getByRole('link', { name: 'Open chat' })).toBeFocused();
  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(toggle).toHaveText('◉ 1');
  await toggle.click();
  await row.getByRole('button', { name: /Mark as looked at/ }).click();
  await expect(toggle).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('execution.tool_call.dismiss'))).toBe(1);
  expect(await page.evaluate(() => window.__app.rpcCallCount('execution.kill'))).toBe(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0);
});

test('Logs gives repeated live controls exact accessible owners', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?live=running&logs_passes=active`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#logs/active'));

  const names = [
    'Refresh active runs',
    'Refresh active passes',
    'Kill daily-brief · summarize (run-live-control-1)',
    'Kill weekly-review · collect (run-live-control-2)',
    'Revoke Send reviewed mail (pass-live-control-1)',
    'Revoke Update reviewed contact (pass-live-control-2)',
  ];
  for (const name of names) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
  }
});

test('Logs keeps a kill action focused until its run retires', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?live=running&logs_control_response=slow`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#logs/active'));

  const firstRow = page.locator(
    `[${LOGS_ACTIVE_ROW}="run-live-control-1"]`,
  );
  const firstKill = firstRow.locator(`[${LOGS_ACTION}="kill-run"]`);
  const nextKill = page.locator(
    `[${LOGS_ACTIVE_ROW}="run-live-control-2"] `
    + `[${LOGS_ACTION}="kill-run"]`,
  );
  await expect(firstKill).toBeVisible();
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
  await page.evaluate(() => window.__app.holdRpcResponses?.('execution.kill'));
  await firstKill.focus();
  await page.keyboard.press('Enter');

  await expect(firstKill).toHaveText('Killing…');
  await expect(firstKill).toHaveAccessibleName(
    'Killing… daily-brief · summarize (run-live-control-1)',
  );
  await page.evaluate(() => window.__app.setHash('#data'));
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'A run action is still in progress. Leave Logs anyway?',
  );
  await expect(page).toHaveURL(/#logs\/active$/);
  await expect(firstKill).toBeFocused();
  await expect(firstKill).not.toHaveAttribute('disabled');
  await expect(firstKill).toHaveAttribute('aria-disabled', 'true');
  await expect(firstKill).toHaveAttribute('aria-busy', 'true');
  await firstKill.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount('execution.kill'),
  )).toBe(1);

  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('execution.kill'))).toBe(1);
  await expect(firstRow).toHaveCount(0);
  await expect(nextKill).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(page).toHaveURL(/#data$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Logs keeps an acknowledged kill retired when active reconciliation fails', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?live=running&logs_control_followup_response=fail`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#logs/active'));

  const firstRow = page.locator(
    `[${LOGS_ACTIVE_ROW}="run-live-control-1"]`,
  );
  const firstKill = firstRow.locator(`[${LOGS_ACTION}="kill-run"]`);
  const nextKill = page.locator(
    `[${LOGS_ACTIVE_ROW}="run-live-control-2"] `
    + `[${LOGS_ACTION}="kill-run"]`,
  );
  const activeReadsBefore = await page.evaluate(
    () => window.__app.rpcCallCount('execution.active'),
  );
  await firstKill.focus();
  await page.keyboard.press('Enter');

  await expect(firstRow).toHaveCount(0);
  await expect(nextKill).toBeFocused();
  await expect(page.locator(`[${LOGS_ERROR}]`)).toContainText(
    'Active runs could not be refreshed.',
  );
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('execution.active')),
  ).toBe(activeReadsBefore + 1);
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('execution.kill')),
  ).toBe(1);
});

test('Logs keeps a pass revocation focused until its row retires', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?live=running&logs_passes=active`
    + '&logs_control_response=slow',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#logs/active'));

  const firstRow = page.locator(
    `[${LOGS_PASS_ROW}="pass-live-control-1"]`,
  );
  const firstRevoke = firstRow.locator(`[${LOGS_ACTION}="revoke-grant"]`);
  const nextRevoke = page.locator(
    `[${LOGS_PASS_ROW}="pass-live-control-2"] `
    + `[${LOGS_ACTION}="revoke-grant"]`,
  );
  await expect(firstRevoke).toBeVisible();
  await page.evaluate(() => window.__app.holdRpcResponses?.('collection.contract.session_grant.revoke'));
  await firstRevoke.focus();
  await page.keyboard.press('Enter');

  await expect(firstRevoke).toHaveText('Revoking…');
  await expect(firstRevoke).toHaveAccessibleName(
    'Revoking… Send reviewed mail (pass-live-control-1)',
  );
  await expect(firstRevoke).toBeFocused();
  await expect(firstRevoke).not.toHaveAttribute('disabled');
  await expect(firstRevoke).toHaveAttribute('aria-disabled', 'true');
  await expect(firstRevoke).toHaveAttribute('aria-busy', 'true');
  await firstRevoke.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount(
      'collection.contract.session_grant.revoke',
    ),
  )).toBe(1);

  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('collection.contract.session_grant.revoke'))).toBe(1);
  await expect(firstRow).toHaveCount(0);
  await expect(nextRevoke).toBeFocused();
});

test('Logs keeps manual refreshes focused, visible, and single-flight', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?live=running&logs_passes=active`
    + '&logs_refresh_response=slow',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#logs/active'));
  await expect(page.locator(
    `[${LOGS_ACTIVE_ROW}="run-live-control-1"]`,
  )).toBeVisible();
  await expect(page.locator(
    `[${LOGS_PASS_ROW}="pass-live-control-1"]`,
  )).toBeVisible();

  const activeRefresh = page.locator(`[${LOGS_ACTION}="refresh-active"]`);
  await expect(activeRefresh).not.toHaveAttribute('aria-busy');
  await page.evaluate(() => window.__app.holdRpcResponses?.('execution.active'));
  const activeBefore = await page.evaluate(() =>
    window.__app.rpcCallCount('execution.active'));
  await activeRefresh.focus();
  await page.keyboard.press('Enter');
  await expect(activeRefresh).toHaveText('Refreshing…');
  await expect(activeRefresh).toHaveAccessibleName('Refreshing… active runs');
  await expect(activeRefresh).toHaveAttribute('aria-disabled', 'true');
  await expect(activeRefresh).toHaveAttribute('aria-busy', 'true');
  await expect(activeRefresh).not.toHaveAttribute('disabled');
  await expect(activeRefresh).toBeFocused();
  await activeRefresh.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('execution.active'))).toBe(activeBefore + 1);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('execution.active'))).toBe(1);
  await expect(activeRefresh).toHaveText('Refresh');
  await expect(activeRefresh).toBeFocused();

  const passesRefresh = page.locator(`[${LOGS_ACTION}="refresh-passes"]`);
  await expect(passesRefresh).not.toHaveAttribute('aria-busy');
  await page.evaluate(() => window.__app.holdRpcResponses?.('collection.contract.session_grant.list'));
  const passesBefore = await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.session_grant.list'));
  await passesRefresh.focus();
  await page.keyboard.press('Enter');
  await expect(passesRefresh).toHaveText('Refreshing…');
  await expect(passesRefresh).toHaveAccessibleName(
    'Refreshing… active passes',
  );
  await expect(passesRefresh).toHaveAttribute('aria-disabled', 'true');
  await expect(passesRefresh).toHaveAttribute('aria-busy', 'true');
  await expect(passesRefresh).not.toHaveAttribute('disabled');
  await expect(passesRefresh).toBeFocused();
  await passesRefresh.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount(
      'collection.contract.session_grant.list',
    ))).toBe(passesBefore + 1);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('collection.contract.session_grant.list'))).toBe(1);
  await expect(passesRefresh).toHaveText('Refresh');
  await expect(passesRefresh).toBeFocused();
});


for (const navigation of ['workspace Back', 'browser Back'] as const) {
  test(`Run workspace restores filters, loaded pages, focus and scroll with ${navigation}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(`${HARNESS_URL}?journey=verification&logs=paged&logs_filters=1#logs`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const status = page.locator('[data-recued-logs-filter="status"]');
    await page.locator('[data-recued-logs-filter="origin"]').selectOption('user_self');
    await page.locator(`[${LOGS_ACTION}="apply-filters"]`).click();
    await expect(page.locator(`[${LOGS_ACTION}="apply-filters"]`)).not.toHaveAttribute('aria-busy');
    await page.locator(`[${LOGS_ACTION}="load-more"]`).click();
    const opener = page.locator(`[${LOGS_ROW}="run-verify-older"] [${LOGS_ACTION}="open-detail"]`);
    await expect(opener).toBeFocused();
    // Keep a draft distinct from the submitted query and record a real scroll.
    await status.selectOption('failed');
    await opener.focus();
    const scroll = await page.locator('[data-recued-webclient-content]').evaluate(node => {
      node.scrollTop = node.scrollHeight;
      return node.scrollTop;
    });
    expect(scroll).toBeGreaterThan(0);
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-recued-logs-detail="run-verify-older"]')).toBeVisible();
    await expect(status).toHaveCount(0);
    if (navigation === 'browser Back') await page.goBack();
    else await page.getByRole('link', { name: 'Back to history' }).click();
    await expect(page).toHaveURL(/#logs$/);
    await expect(status).toHaveValue('failed');
    await expect(page.locator(`[${LOGS_ROW}]`)).toHaveCount(2);
    await expect(opener).toBeFocused();
    await expect(page.locator(`[${LOGS_ACTION}="load-more"]`)).toHaveCount(0);
    await expect.poll(() => page.locator('[data-recued-webclient-content]').evaluate(node => node.scrollTop)).toBe(scroll);
    await refreshLogsHistory(page);
    await expect(status).toHaveValue('failed');
    await expect(page.locator(`[${LOGS_ROW}]`)).toHaveCount(2);
    await page.goForward();
    await expect(page.locator('[data-recued-logs-detail="run-verify-older"]')).toBeVisible();
    await page.getByRole('link', { name: 'Back to history' }).click();
    await expect(status).toHaveValue('failed');
    await expect(page.locator(`[${LOGS_ROW}]`)).toHaveCount(2);
    await expect(opener).toBeFocused();
  });
}

for (const width of [390, 768, 1280]) {
  for (const theme of ['light', 'dark']) {
    test(`Run workspace is readable at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${HARNESS_URL}?settle_reads=1&journey=verification&logs_summary=1#logs/run-verify`);
      await page.waitForFunction(() => window.__app?.ready === true);
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      const detail = page.locator('[data-recued-logs-detail="run-verify"]');
      await expect(detail).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Approvals and decisions' })).toBeVisible();
      await expect(detail.locator('.logs-run-context')).toContainText('Trigger source');
      await expect(page.locator(`[${LOGS_ROW}]`)).toHaveCount(0);
      const technical = detail.locator('[data-recued-logs-technical]');
      await expect(technical).not.toHaveAttribute('open');
      await expect(page.getByRole('link', { name: 'Run link', exact: true })).not.toBeVisible();
      await expect(detail.locator('[data-recued-logs-yield]')).not.toContainText('finished without an error');
      const actionFont = await detail.locator('.logs-affected-action').evaluate(node => ({
        action: getComputedStyle(node).fontFamily,
        context: getComputedStyle(node.closest('[data-recued-logs-detail]')!).fontFamily,
      }));
      expect(actionFont.action).toBe(actionFont.context);
      const disclosure = technical.locator('summary');
      await disclosure.focus();
      await page.keyboard.press('Enter');
      await expect(technical).toHaveAttribute('open', '');
      await refreshLogsHistory(page);
      await expect(technical).toHaveAttribute('open', '');
      await expect(disclosure).toBeFocused();
      const geometry = await detail.evaluate(node => ({
        width: node.getBoundingClientRect().width,
        routeWidth: node.parentElement!.getBoundingClientRect().width,
        textWidth: node.querySelector('.logs-affected-title')?.getBoundingClientRect().width ?? 0,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      expect(geometry.width).toBeGreaterThan(geometry.routeWidth * 0.85);
      expect(geometry.textWidth).toBeGreaterThan(width === 390 ? 200 : 260);
      expect(geometry.overflow).toBe(false);
      await disclosure.click();
      await page.locator('[data-recued-webclient-content]').evaluate(node => { node.scrollTop = 0; });
      await page.screenshot({ path: test.info().outputPath(`run-workspace-${width}-${theme}.png`) });
    });
  }
}

test('Run workspace explains a missing run and retains a way back', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?journey=verification#logs/no-such-run`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.getByRole('alert')).toContainText('Run not found.');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeFocused();
  await expect(page.locator(RUN_SUMMARY)).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to history' }).click();
  await expect(page.locator(`[${LOGS_ROW}="run-verify"]`)).toBeVisible();
});


test('Run workspace returns to the originating recipe-scoped history', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?journey=verification&logs_filters=1#logs/recipe/calendar%2Fschedule-review`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const opener = page.locator(`[${LOGS_ROW}="run-verify"] [${LOGS_ACTION}="open-detail"]`);
  await opener.click();
  const back = page.getByRole('link', { name: 'Back to history' });
  await expect(back).toHaveAttribute('href', '#logs/recipe/calendar%2Fschedule-review');
  await back.click();
  await expect(page).toHaveURL(/#logs\/recipe\/calendar%2Fschedule-review$/);
  await expect(opener).toBeFocused();
  await expect(page.getByRole('combobox', { name: 'Show only one Recipe' })).not.toHaveValue('');
});


for (const width of [390, 1280]) {
  test(`Run workspace follows the native keyboard order at ${width}px`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${HARNESS_URL}?settle_reads=1&journey=verification#logs/run-verify`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await expect(page.locator('[data-recued-logs-outcome]')).toBeFocused();
    const back = page.getByRole('link', { name: 'Back to history' });
    await back.focus();
    const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
    await page.keyboard.press(tab);
    const verify = page.locator('[data-recued-logs-affected-items]').getByRole('link', { name: 'Check before running it again' });
    await expect(verify).toBeFocused();
    let reachedTechnical = false;
    let reachedCopy = false;
    for (let count = 0; count < 16; count += 1) {
      await page.keyboard.press(tab);
      const focused = await page.evaluate(() => ({
        technical: document.activeElement?.hasAttribute('data-recued-logs-technical-toggle') === true,
        copy: document.activeElement?.getAttribute('data-recued-logs-action') === 'copy-run-summary',
      }));
      reachedCopy ||= focused.copy;
      if (focused.technical) { reachedTechnical = true; break; }
    }
    expect(reachedCopy).toBe(true);
    expect(reachedTechnical).toBe(true);
    const technical = page.locator('[data-recued-logs-technical]');
    await page.keyboard.press('Enter');
    await expect(technical).toHaveAttribute('open', '');
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab');
    await expect(page.getByText('View run summary', { exact: true })).toBeFocused();
  });
}


for (const width of [390, 768, 1280]) {
  for (const theme of ['light', 'dark']) {
    test(`Run management presents distinct outcomes and active groups at ${width}px in ${theme}`, async ({ page }) => {
      await installManagementFixture(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${HARNESS_URL}?settle_reads=1&journey=verification&logs_passes=active#logs`);
      await page.waitForFunction(() => window.__app?.ready === true);
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      const navigation = page.getByRole('navigation', { name: 'Log views' });
      await expect(navigation.getByRole('link', { name: 'History', exact: true })).toHaveAttribute('aria-current', 'page');
      const more = page.locator(`[${LOGS_ACTION}="load-more"]`);
      if (width === 390) {
        expect((await page.getByRole('button', { name: 'Refresh history', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      await more.click(); await expect(page.locator(`[${LOGS_ROW}]`)).toHaveCount(8);
      await more.click(); await expect(page.locator(`[${LOGS_ROW}]`)).toHaveCount(12);
      const expected = { partial: 'Partial result', refused: 'All items failed', stopped: 'Stopped early', approval: 'Awaiting approval', peer: 'Waiting on a peer', unknown: 'Needs checking', failed: 'Failed', cancelled: 'Cancelled', killed: 'Stopped by owner' };
      for (const [id, label] of Object.entries(expected)) {
        await expect(page.locator(`[${LOGS_ROW}="history-${id}"] .logs-cell-status`)).toContainText(label);
      }
      await expect(page.locator(`[${LOGS_ROW}="history-legacy"]`)).toContainText('Item results were not recorded.');
      await expect(page.locator(`[${LOGS_ROW}="history-zero"]`)).not.toContainText('Item results were not recorded.');
      await expect(page.locator('.logs-history-count')).toHaveText('12 loaded runs · newest first');
      expect(await page.evaluate(() => window.__app.rpcCallCount('execution.get'))).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 1280) {
        const columns = await page.locator('.logs-table').evaluate(table => {
          const headings = Array.from(table.querySelectorAll('thead th'));
          const cells = Array.from(table.querySelectorAll('tbody tr:first-child td'));
          return cells.map((cell, index) => ({ display: getComputedStyle(cell).display,
            left: cell.getBoundingClientRect().left, headingLeft: headings[index]!.getBoundingClientRect().left }));
        });
        expect(columns).toHaveLength(7);
        for (const column of columns) {
          expect(column.display).toBe('table-cell');
          expect(Math.abs(column.left - column.headingLeft)).toBeLessThan(1);
        }
      }
      await page.locator('[data-recued-webclient-content]').evaluate(node => { node.scrollTop = 0; });
      await page.screenshot({ path: test.info().outputPath(`history-${width}-${theme}.png`) });
      await navigation.getByRole('link', { name: 'Active', exact: true }).click();
      await expect(navigation.getByRole('link', { name: 'Active', exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('[data-recued-logs-work-group="in-progress"] [data-recued-logs-active-row]')).toHaveCount(2);
      const queued = page.locator('[data-recued-logs-work-group="queued"]');
      await expect(queued.locator('[data-recued-logs-active-row]')).toHaveCount(1);
      await expect(queued.getByRole('button', { name: /Promote/ })).toBeVisible();
      await expect(queued.getByRole('button', { name: /Cancel/ })).toBeVisible();
      await expect(queued.getByRole('button', { name: /Kill/ })).toHaveCount(0);
      const refreshStyle = await page.locator('[data-recued-logs-action="refresh-active"]').evaluate(node => ({
        background: getComputedStyle(node).backgroundColor,
        surface: getComputedStyle(node.closest('[data-recued-logs-active]')!).backgroundColor,
      }));
      expect(refreshStyle.background).toBe(refreshStyle.surface);
      if (width === 390) {
        const readable = await queued.locator('[data-recued-logs-active-row]').evaluate(row => ({
          copy: row.firstElementChild!.getBoundingClientRect().width,
          row: row.getBoundingClientRect().width,
        }));
        expect(readable.copy).toBeGreaterThan(readable.row * 0.8);
      }
      await expect(page.locator('[data-recued-logs-active-row="management-detached"]')).toContainText('No recent progress');
      await expect(page.locator('[data-recued-logs-passes]')).toContainText('Revoking a pass changes future authorization.');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`active-${width}-${theme}.png`) });
    });
  }
}

for (const scope of ['#logs', '#logs/recipe/fixture%2Frun-management']) {
  test(`Run management returns to the same draft and loaded history from Active via ${scope}`, async ({ page }) => {
    await installManagementFixture(page);
    await page.goto(`${HARNESS_URL}?journey=verification${scope}`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const origin = page.locator('[data-recued-logs-filter="origin"]');
    const status = page.locator('[data-recued-logs-filter="status"]');
    await origin.selectOption('user_self');
    await page.locator(`[${LOGS_ACTION}="apply-filters"]`).click();
    await expect(page.locator(`[${LOGS_ACTION}="apply-filters"]`)).not.toHaveAttribute('aria-busy');
    await page.locator(`[${LOGS_ACTION}="load-more"]`).click();
    await expect(page.locator(`[${LOGS_ROW}]`)).toHaveCount(8);
    await status.selectOption('failed');
    await expect(page.locator('[data-recued-logs-filter-draft]')).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Log views' });
    await nav.getByRole('link', { name: 'Active', exact: true }).click();
    await expect(nav.getByRole('link', { name: 'History', exact: true })).toHaveAttribute('href', scope);
    await nav.getByRole('link', { name: 'History', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(scope.replaceAll('/', '\\/') + '$'));
    await expect(origin).toHaveValue('user_self'); await expect(status).toHaveValue('failed');
    await expect(page.locator(`[${LOGS_ROW}]`)).toHaveCount(8);
    await expect(page.locator('[data-recued-logs-filter-draft]')).toBeVisible();
    const queries = await page.evaluate(() => window.__logsManagementQueries!);
    expect(queries.at(-1)?.origin).toEqual(['user_self']);
    expect(queries.at(-1)?.status).toBeUndefined();
  });
}

test('Run management refresh preserves the applied query, pages and newer draft', async ({ page }) => {
  await installManagementFixture(page);
  await page.goto(`${HARNESS_URL}?journey=verification#logs`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator(`[${LOGS_ACTION}="load-more"]`).click();
  await expect(page.locator(`[${LOGS_ROW}]`)).toHaveCount(8);
  const status = page.locator('[data-recued-logs-filter="status"]');
  await status.selectOption('failed');
  const refresh = page.locator(`[${LOGS_ACTION}="refresh-history"]`).first();
  const before = await page.evaluate(() => window.__app.rpcCallCount('execution.list'));
  await page.evaluate(() => window.__app.holdRpcResponses?.('execution.list'));
  await refresh.focus(); await page.keyboard.press('Enter');
  await expect(refresh).toHaveAttribute('aria-busy', 'true');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__app.rpcCallCount('execution.list'))).toBe(before + 1);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('execution.list'))).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('execution.list'))).toBe(before + 2);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('execution.list'))).toBe(1);
  await expect(page.getByRole('button', { name: 'Refresh history', exact: true })).toBeFocused();
  await expect(page.locator(`[${LOGS_ROW}]`)).toHaveCount(8);
  await expect(status).toHaveValue('failed');
  expect(await page.evaluate(() => window.__logsManagementQueries!.slice(-2).every(query => query.status === undefined))).toBe(true);
});

test('Run management coalesces an event behind an explicit filter submission', async ({ page }) => {
  await installManagementFixture(page);
  await page.goto(`${HARNESS_URL}?journey=verification#logs`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-recued-logs-filter="status"]').selectOption('failed');
  const before = await page.evaluate(() => window.__app.rpcCallCount('execution.list'));
  await page.evaluate(() => window.__app.holdRpcResponses?.('execution.list'));
  await page.locator(`[${LOGS_ACTION}="apply-filters"]`).click();
  await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: {
    kind: 'session_lifecycle', session_id: 'fixture-session', state: 'closed', prev_state: 'active', cursor: 999,
  } }));
  expect(await page.evaluate(() => window.__app.rpcCallCount('execution.list'))).toBe(before + 1);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('execution.list'))).toBe(1);
  await expect(page.locator(`[${LOGS_ROW}]`)).toHaveCount(1);
  await expect(page.locator(`[${LOGS_ROW}="history-failed"]`)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('execution.list'))).toBe(before + 2);
  expect(await page.evaluate(() => window.__logsManagementQueries!.slice(-2).map(query => query.status))).toEqual([['failed'], ['failed']]);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('execution.list'))).toBe(1);
  await expect(page.locator('[data-recued-logs-route]')).toHaveAttribute('data-recued-logs-history-loading', 'false');
  await expect(page.locator('[data-recued-logs-filter-draft]')).not.toBeVisible();
});

test('Run management retains loaded history and recovers a failed refresh', async ({ page }) => {
  await installManagementFixture(page);
  await page.goto(`${HARNESS_URL}?journey=verification#logs`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => { window.__logsManagementFailList = true; });
  await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('History could not be refreshed.');
  await expect(page.locator(`[${LOGS_ROW}]`)).toHaveCount(4);
  await expect(page.getByText('Showing the last loaded runs.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry history', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator(`[${LOGS_ROW}]`)).toHaveCount(4);
});


test('Run management retains item outcomes when opening the full review', async ({ page }) => {
  await installManagementFixture(page);
  await page.goto(`${HARNESS_URL}?journey=verification#logs`);
  await page.waitForFunction(() => window.__app?.ready === true);
  for (const [id, label] of [['partial', 'Partial result'], ['refused', 'All items failed'], ['stopped', 'Stopped early']]) {
    await page.locator(`[${LOGS_ROW}="history-${id}"] [${LOGS_ACTION}="open-detail"]`).click();
    const outcome = page.getByRole('region', { name: 'Run outcome' });
    await expect(outcome.getByRole('heading', { name: label, exact: true })).toBeVisible();
    await expect(outcome).not.toContainText('and it worked');
    await page.getByRole('link', { name: 'Back to history' }).click();
    await expect(page.locator(`[${LOGS_ROW}="history-${id}"] .logs-cell-status`)).toContainText(label);
  }
});

for (const queueId of [null, '']) {
  test(`Run management keeps a queued call read-only without its queue identity (${queueId === null ? 'missing' : 'empty'})`, async ({ page }) => {
    await installManagementFixture(page, { queueId });
    await page.goto(`${HARNESS_URL}?journey=verification#logs/active`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const queued = page.locator('[data-recued-logs-work-group="queued"]');
    await expect(queued.locator(`[${LOGS_ACTIVE_ROW}]`)).toHaveCount(1);
    await expect(queued.getByRole('button')).toHaveCount(0);
    await expect(page.locator(`[${LOGS_ACTIVE_ROW}="management-running"]`).getByRole('button', { name: /Kill/ })).toBeVisible();
    for (const method of ['execution.kill', 'execution.cancel', 'execution.promote']) {
      expect(await page.evaluate(name => window.__app.rpcCallCount(name), method)).toBe(0);
    }
  });
}
