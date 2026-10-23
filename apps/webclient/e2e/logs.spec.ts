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

const RUN_SUMMARY = '[data-recued-logs-run-summary]';
const RUN_SUMMARY_STATUS = '[data-recued-logs-run-summary-status]';
const refreshLogsHistory = async (page: Page, cursor = 400): Promise<void> => {
  const before = await page.evaluate(() => window.__app.rpcCallCount('execution.list'));
  await page.evaluate(nextCursor => window.__app.fireMessage({
    type: 'server_event', event: { kind: 'session_lifecycle', session_id: 'session-verification',
      state: 'closed', prev_state: 'active', cursor: nextCursor },
  }), cursor);
  await page.waitForFunction(previous => window.__app.rpcCallCount('execution.list') > previous, before);
  await expect(page.locator(`[${LOGS_ACTION}="apply-filters"]`)).not.toHaveAttribute('aria-busy');
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
    await summary.getByRole('button', { name: 'Copy run summary', exact: true }).click();
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
  const status = page.locator('[data-recued-logs-filter="status"]');
  await status.focus();
  await page.evaluate(() => window.__logsSummaryCopy?.reject?.());
  await expect(summary.locator(RUN_SUMMARY_STATUS)).toContainText('Recued could not copy it.');
  await expect(summary.getByRole('textbox', { name: 'Run summary text' })).toBeVisible();
  await expect(status).toBeFocused();
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
  await expect(heading).toHaveText(longRecipeId);
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
  await expect(heading).toHaveText('calendar/schedule-review');
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
  await expect(heading).toHaveText('calendar/schedule-review');
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

  await expect(opener).toHaveAccessibleName(
    'Opening run detail for Schedule customer review (run-verify)',
  );
  await expect(opener).toHaveAttribute('aria-disabled', 'true');
  await expect(opener).toHaveAttribute('aria-busy', 'true');
  await expect(opener).not.toHaveAttribute('disabled');
  await expect(opener).toBeFocused();
  await opener.dispatchEvent('click');
  await opener.dispatchEvent('click');
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount('execution.get'),
  )).toBe(1);

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
  await expect(heading).toHaveText('calendar/schedule-review');
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

test('Logs keeps an exact run open when its filtered history is cleared', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?journey=verification&logs_filters=1#logs/run-verify`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const detail = page.locator('[data-recued-logs-detail="run-verify"]');
  await expect(detail).toBeVisible();
  const getCalls = await page.evaluate(() => window.__app.rpcCallCount('execution.get'));
  await page.locator('[data-recued-logs-filter="status"]').selectOption('failed');
  await page.locator(`[${LOGS_ACTION}="apply-filters"]`).click();
  await expect(page.getByText('No runs match these filters.', { exact: true })).toBeVisible();
  await page.locator(`[${LOGS_ACTION}="clear-filters"]`).click();
  await expect(page.locator(`[${LOGS_ROW}="run-verify"]`)).toBeVisible();
  await expect(detail).toBeVisible();
  await expect(page).toHaveURL(/#logs\/run-verify$/);
  expect(await page.evaluate(() => window.__app.rpcCallCount('execution.get'))).toBe(getCalls);
});

for (const entry of ['history', 'deep-link'] as const) {
  test(`Logs keeps Clear filters focused when a pending ${entry} run detail arrives`, async ({ page }) => {
    const hash = entry === 'history' ? '#logs' : '#logs/run-verify';
    await page.goto(`${HARNESS_URL}?journey=verification&logs_filters=1&hold_rpc=execution.get${hash}`);
    await page.waitForFunction(() => window.__app?.ready === true);
    if (entry === 'history') {
      await page.locator(`[${LOGS_ROW}="run-verify"] [${LOGS_ACTION}="open-detail"]`).click();
    }
    await expect(page.locator('[data-recued-logs-detail]')).toContainText('Loading run-verify');
    const clear = page.locator(`[${LOGS_ACTION}="clear-filters"]`);
    await expect(clear).not.toHaveAttribute('aria-busy');
    await clear.click();
    await expect(clear).not.toHaveAttribute('aria-busy');
    await expect(clear).toBeFocused();
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('execution.get'))).toBe(1);
    await expect(page.locator('[data-recued-logs-detail="run-verify"]')).toBeVisible();
    await expect(clear).toBeFocused();
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
  const detail = page.getByRole('complementary', {
    name: 'Run detail',
  });
  await expect(detail).toBeVisible();
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
  await expect(activeRefresh).toHaveText('Refresh');
  await expect(activeRefresh).toBeFocused();

  const passesRefresh = page.locator(`[${LOGS_ACTION}="refresh-passes"]`);
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
  await expect(passesRefresh).toHaveText('Refresh');
  await expect(passesRefresh).toBeFocused();
});
