import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { ConfidenceDriftSignal, EnrichmentTrustRow } from '@recued/contracts';
import { FIXED_NOW, HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

/**
 * Housekeeping browser journeys against the deterministic full-app harness.
 * Shares the app boot and uncaught-page-error gates with full-app.spec.ts.
 * Included in e2e:webclient:full and the standard webclient Playwright config.
 */
installFullAppHooks();

test('Settings Housekeeping identifies repeated producer actions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?housekeeping=ready`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/housekeeping'));

  const summaryRun = page.locator(
    '[data-action="housekeeping-run-now-open"]'
      + '[data-task-id="enrichment.summary"]',
  );
  const signalsRun = page.locator(
    '[data-action="housekeeping-run-now-open"]'
      + '[data-task-id="enrichment.thread_signals"]',
  );
  await expect(summaryRun).toHaveAccessibleName('Run enrichment.summary now');
  await expect(signalsRun).toHaveAccessibleName(
    'Run enrichment.thread_signals now',
  );
  await expect(page.getByRole('button', {
    name: 'Expand summary details',
  })).toBeVisible();
  await expect(page.getByRole('button', {
    name: 'Expand thread_signals details',
  })).toBeVisible();
  const filterHeights = await page
    .locator('.housekeeping-producer-cost-segment')
    .evaluateAll((segments) =>
      segments.map((segment) => segment.getBoundingClientRect().height)
  );
  expect(Math.min(...filterHeights)).toBeGreaterThanOrEqual(44);
});

test('Settings Housekeeping keeps every mobile control full-size and in bounds', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?housekeeping=ready&settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/housekeeping'));

  await expect(page.getByRole('heading', {
    name: 'Housekeeping',
    level: 2,
  })).toBeVisible();

  const assertTargets = async (): Promise<void> => {
    const panel = page.locator('[data-recued-housekeeping-panel-host]');
    const targets = panel.locator([
      'a:visible',
      'button:visible',
      'input:not([type="checkbox"]):not([type="radio"]):visible',
      'select:visible',
      'textarea:visible',
      'summary:visible',
      'label:visible:has(input[type="checkbox"])',
      'label:visible:has(input[type="radio"])',
    ].join(', '));
    const dimensions = await targets.evaluateAll((elements) => elements.map(
      (element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      },
    ));
    expect(dimensions.length).toBeGreaterThan(0);
    expect(Math.min(...dimensions.map(({ width }) => width)))
      .toBeGreaterThanOrEqual(44);
    expect(Math.min(...dimensions.map(({ height }) => height)))
      .toBeGreaterThanOrEqual(44);
    expect(await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    )).toBe(true);
  };

  await expect(page.getByRole('button', {
    name: 'Expand summary details',
  })).toBeVisible();
  await assertTargets();

  await page.getByRole('button', { name: 'Expand summary details' }).click();
  await expect(page.getByRole('link', {
    name: 'Manage read access in Contracts →',
  })).toBeVisible();
  await assertTargets();

  await page.getByRole('button', { name: 'Reset topic…' }).click();
  await expect(page.getByRole('dialog', {
    name: 'Reset enrichment topic summary',
  })).toBeVisible();
  await assertTargets();
});

test('Settings Housekeeping Run-now dialog owns keyboard focus', async ({ page, browserName }) => {
  const next = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  const previous = browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?housekeeping=ready&settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/housekeeping'));

  const trigger = page.getByRole('button', {
    name: 'Run enrichment.summary now',
  });
  await trigger.click();

  const dialog = page.getByRole('dialog', {
    name: 'Run "Mail summary digest"?',
  });
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  const confirm = dialog.getByRole('button', { name: 'Run now' });
  await expect(dialog).toBeVisible();
  await expect(cancel).toBeFocused();
  await page.keyboard.press(next);
  await expect(confirm).toBeFocused();
  await page.keyboard.press(next);
  await expect(cancel).toBeFocused();
  await page.keyboard.press(previous);
  await expect(confirm).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(cancel).toBeFocused();
  await page.keyboard.press(next);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('housekeeping.task.run_now'))).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Settings Housekeeping Reset dialog owns keyboard focus', async ({ page, browserName }) => {
  const next = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  const previous = browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?housekeeping=ready&settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/housekeeping'));

  await page.getByRole('button', { name: 'Expand summary details' }).click();
  const trigger = page.getByRole('button', { name: 'Reset topic…' });
  await trigger.click();

  const dialog = page.getByRole('dialog', {
    name: 'Reset enrichment topic summary',
  });
  const toggle = dialog.getByRole('checkbox', {
    name: 'Also drop confidence-drift baselines for this topic',
  });
  const confirm = dialog.getByRole('button', { name: 'Confirm reset' });
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  await expect(dialog).toHaveAttribute('data-phase', 'preview');
  await expect(cancel).toBeFocused();
  await page.keyboard.press(next);
  await expect(toggle).toBeFocused();
  await page.keyboard.press(next);
  await expect(confirm).toBeFocused();
  await page.keyboard.press(next);
  await expect(cancel).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(dialog).toHaveAttribute('data-phase', 'preview');
  await expect(cancel).toBeFocused();
  await page.keyboard.press(previous);
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveAttribute('data-phase', 'applied');
  const done = dialog.getByRole('button', { name: 'Done' });
  await expect(done).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('housekeeping.topic.reset'))).toBe(3);
});

const scheduleWriteRpc = 'housekeeping.config.write';
const openHousekeepingSchedule = async (page: Page, query = '') => {
  await page.goto(`${HARNESS_URL}?housekeeping=ready&settle_reads=1&hold_rpc=${scheduleWriteRpc}&${query}#settings/housekeeping`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const panel = page.locator('[data-recued-housekeeping-panel-host]');
  const schedule = panel.getByRole('region', { name: 'Idle schedule', exact: true });
  return {
    panel, schedule,
    preset: (value: string) => schedule.locator(`[data-action="housekeeping-preset-pick"][value="${value}"]`),
    budget: schedule.locator('[data-action="housekeeping-custom-budget"]'),
    interval: schedule.locator('[data-action="housekeeping-custom-interval"]'),
    start: schedule.locator('[data-action="housekeeping-custom-start"]'),
    end: schedule.locator('[data-action="housekeeping-custom-end"]'),
    save: schedule.locator('[data-action="housekeeping-save"]'),
    search: panel.locator('[data-action="housekeeping-producer-search"]'),
  };
};
const fillCustomSchedule = async (page: Page, fields: Awaited<ReturnType<typeof openHousekeepingSchedule>>) => {
  await fields.preset('custom').focus();
  await page.keyboard.press('Space');
  await fields.budget.fill('065000');
  await fields.interval.fill('27');
  await fields.start.selectOption('8');
  await fields.end.selectOption('19');
};
const refreshScheduleStatus = async (page: Page) => {
  const before = await page.evaluate(() => window.__app.rpcCallCount('housekeeping.status.read'));
  const event = {
    kind: 'housekeeping_cycle', at: FIXED_NOW, duration_ms: 5,
    tasks_complete: 1, tasks_yielded: 0, tasks_errored: 0,
    per_task: [{ task_id: 'llm-result-cache-gc', status: 'complete', duration_ms: 5 }],
    cursor: before + 100,
  };
  await page.evaluate((event) => window.__app.fireMessage({ type: 'server_event', event }), event);
  // Both Housekeeping and Maintenance listen to this event.
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.status.read'))).toBeGreaterThan(before);
};
const releaseScheduleWrite = async (page: Page) => {
  expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, scheduleWriteRpc)).toBe(1);
};
const expectSavedCustomSchedule = async (fields: Awaited<ReturnType<typeof openHousekeepingSchedule>>) => {
  await expect(fields.preset('custom')).toBeChecked();
  await expect(fields.budget).toHaveValue('65000');
  await expect(fields.interval).toHaveValue('27');
  await expect(fields.start).toHaveValue('8');
  await expect(fields.end).toHaveValue('19');
  await expect(fields.save).toHaveAttribute('aria-disabled', 'true');
};

const openHousekeepingBiasHints = async (page: Page, query = '') => {
  const fields = await openHousekeepingSchedule(page, `housekeeping_bias_hints=ready&${query}`);
  await fields.panel.getByRole('button', { name: 'Expand summary details', exact: true }).click();
  const drawer = fields.panel.getByRole('region', { name: 'Detail drawer for summary', exact: true });
  const disclosure = drawer.locator('details.housekeeping-drawer-coverage-bias');
  const summary = disclosure.locator('summary');
  await expect(summary).toHaveText('Prompt bias hints (1)');
  return { ...fields, drawer, disclosure, summary };
};

const openHousekeepingRunNowRefresh = async (page: Page, query = '') => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fields = await openHousekeepingSchedule(page, query);
  const trigger = fields.panel.getByRole('button', {
    name: 'Run enrichment.summary now', exact: true,
  });
  await expect(trigger).toBeVisible();
  const before = await page.evaluate(() => window.__app.rpcCallCount('housekeeping.status.read'));
  await page.evaluate(() => window.__app.holdRpcResponses?.('housekeeping.status.read'));
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Run "Mail summary digest"?', exact: true });
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Run now', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.task.run_now'))).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.status.read'))).toBeGreaterThan(before);
  return { ...fields, trigger, errors };
};
const releaseHousekeepingStatus = async (page: Page, index?: number) => {
  // Held replies are delivered synchronously. Let their promise continuations
  // finish before checking focus, including failures that leave the DOM intact.
  return page.evaluate((index) => {
    const released = window.__app.releaseRpcResponses?.('housekeeping.status.read', index) ?? 0;
    return new Promise<number>((resolve) => setTimeout(() => resolve(released), 0));
  }, index);
};

const openHousekeepingResetPreview = async (page: Page, query = '') => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fields = await openHousekeepingSchedule(page,
    `housekeeping_reset=tracked&hold_rpc=housekeeping.topic.reset&${query}`);
  await fields.panel.getByRole('button', { name: 'Expand summary details', exact: true }).focus();
  await page.keyboard.press('Enter');
  const trigger = fields.panel.getByRole('button', { name: 'Reset topic…', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Reset enrichment topic summary', exact: true });
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  const toggle = dialog.getByRole('checkbox', {
    name: 'Also drop confidence-drift baselines for this topic', exact: true,
  });
  const confirm = dialog.getByRole('button', { name: 'Confirm reset', exact: true });
  const done = dialog.getByRole('button', { name: 'Done', exact: true });
  const open = async () => {
    const before = await page.evaluate(() => window.__app.rpcCallCount('housekeeping.topic.reset'));
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveAttribute('data-phase', 'previewing');
    await expect(cancel).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.topic.reset'))).toBe(before + 1);
  };
  await open();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await open();
  return { ...fields, trigger, dialog, cancel, toggle, confirm, done, errors };
};
const releaseResetPreview = async (page: Page, index: number) => {
  // Drain the delivered reply's continuations before inspecting an unchanged
  // dialog; a stale failure must be ignored just as a stale success is.
  expect(await page.evaluate((index) => {
    const count = window.__app.releaseRpcResponses?.('housekeeping.topic.reset', index) ?? 0;
    return new Promise<number>((resolve) => setTimeout(() => resolve(count), 0));
  }, index)).toBe(1);
};

const housekeepingBannerCases = [
  { name: 'Promote', action: 'housekeeping-promotion-promote', other: 'housekeeping-promotion-dismiss', rpc: 'housekeeping.trust.write', banner: 'housekeeping-promotion-banner', topicAttribute: 'data-topic' },
  { name: 'Don’t ask again', action: 'housekeeping-promotion-dismiss', other: 'housekeeping-promotion-promote', rpc: 'housekeeping.trust.dismiss_promotion', banner: 'housekeeping-promotion-banner', topicAttribute: 'data-topic' },
  { name: 'Drift Dismiss', action: 'housekeeping-drift-dismiss', other: 'housekeeping-drift-review', rpc: 'housekeeping.drift.dismiss', banner: 'housekeeping-drift-banner', topicAttribute: 'data-source-topic' },
] as const;
type HousekeepingBannerCase = typeof housekeepingBannerCases[number];
const openHousekeepingBannerWrite = async (page: Page, operation: HousekeepingBannerCase, query = '') => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fields = await openHousekeepingSchedule(page,
    `housekeeping_banners=ready&housekeeping_trust=tracked&hold_rpc=${operation.rpc}&${query}`);
  const banner = fields.panel.locator(`.${operation.banner}[${operation.topicAttribute}="summary"]`);
  const target = banner.locator(`[data-action="${operation.action}"]`);
  const other = banner.locator(`[data-action="${operation.other}"]`);
  const details = fields.panel.locator('[data-action="housekeeping-drawer-toggle"][data-topic="summary"]');
  await expect(target).toBeVisible();
  await target.focus();
  await expect(target).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate((rpc) => window.__app.rpcCallCount(rpc), operation.rpc)).toBe(1);
  return { ...fields, banner, target, other, details, errors };
};
const releaseHousekeepingBannerWrite = async (page: Page, operation: HousekeepingBannerCase) => {
  expect(await page.evaluate((rpc) => {
    const count = window.__app.releaseRpcResponses?.(rpc) ?? 0;
    return new Promise<number>((resolve) => setTimeout(() => resolve(count), 0));
  }, operation.rpc)).toBe(1);
};

for (const size of [
  { name: 'desktop', viewport: { width: 1280, height: 900 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
]) {
  for (const operation of housekeepingBannerCases) {
    for (const outcome of ['success', 'failure']) {
      test(`Settings Housekeeping banner focus ${size.name} keeps ${operation.name} through pending ${outcome}`, async ({ page, browserName }) => {
        await page.setViewportSize(size.viewport);
        const fields = await openHousekeepingBannerWrite(page, operation,
          outcome === 'failure' ? 'housekeeping_banner_response=fail-first' : '');
        await expect(fields.target).toBeFocused();
        await expect(fields.target).toHaveAttribute('aria-disabled', 'true');
        await expect(fields.target).toHaveAttribute('aria-busy', 'true');
        expect(await fields.target.evaluate((element) => (element as HTMLButtonElement).disabled)).toBe(false);
        await page.keyboard.press('Enter');
        await page.keyboard.press('Space');
        await expect(fields.target).toBeFocused();
        // A forced click is still a native pointer event and checks the host's
        // repeat guard even though Playwright treats aria-disabled as unavailable.
        await fields.other.click({ force: true });
        await fields.target.focus();
        expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), operation.rpc)).toBe(1);
        if (operation.action === 'housekeeping-drift-dismiss') {
          await expect(fields.panel.getByRole('region', { name: 'Detail drawer for summary', exact: true })).toHaveCount(0);
        } else {
          const otherRpc = operation.action === 'housekeeping-promotion-promote'
            ? 'housekeeping.trust.dismiss_promotion' : 'housekeeping.trust.write';
          expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), otherRpc)).toBe(0);
        }
        await refreshScheduleStatus(page);
        await expect(fields.target).toBeFocused();
        await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
        await expect(fields.target).not.toBeFocused();
        expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
        await fields.target.focus();
        await releaseHousekeepingBannerWrite(page, operation);
        if (outcome === 'failure') {
          await expect(fields.target).toBeFocused();
          await expect(fields.target).not.toHaveAttribute('aria-disabled');
          await expect(fields.banner).toContainText('Banner save unavailable.');
          await page.keyboard.press('Enter');
          await expect.poll(() => page.evaluate((rpc) => window.__app.rpcCallCount(rpc), operation.rpc)).toBe(2);
          await expect(fields.target).toBeFocused();
          await releaseHousekeepingBannerWrite(page, operation);
        }
        await expect(fields.banner).toHaveCount(0);
        await expect(fields.details).toBeFocused();
        await expect(fields.details).toBeInViewport();
        if (operation.action === 'housekeeping-promotion-promote') {
          await expect(fields.panel.locator('[data-action="housekeeping-trust-state-pick"][data-topic="summary"][value="auto"]')).toBeChecked();
        }
        // Persisted fixture state survives disposal and a fresh panel mount.
        await page.evaluate(() => window.__app.setHash('#data'));
        await expect(fields.panel).toHaveCount(0);
        await page.evaluate(() => window.__app.setHash('#settings/housekeeping'));
        await expect(fields.panel.getByRole('region', { name: 'Idle schedule', exact: true })).toBeVisible();
        await expect(fields.banner).toHaveCount(0);
        expect(fields.errors).toEqual([]);
      });

      for (const owner of ['search', 'header']) {
        test(`Settings Housekeeping banner focus ${size.name} preserves ${owner} after ${operation.name} ${outcome}`, async ({ page }) => {
          await page.setViewportSize(size.viewport);
          const fields = await openHousekeepingBannerWrite(page, operation,
            outcome === 'failure' ? 'housekeeping_banner_response=fail-first' : '');
          const target = owner === 'search'
            ? fields.panel.locator(`[data-action="housekeeping-producer-search"]`)
            : page.getByRole('button', { name: 'Run a Recipe', exact: true });
          if (owner === 'search') await target.fill('summary');
          await target.focus();
          if (owner === 'search') await target.evaluate((element) => (element as HTMLInputElement).setSelectionRange(2, 5, 'backward'));
          await releaseHousekeepingBannerWrite(page, operation);
          await expect(target).toBeFocused();
          if (owner === 'search') {
            expect(await target.evaluate((element) => {
              const input = element as HTMLInputElement;
              return [input.selectionStart, input.selectionEnd, input.selectionDirection];
            })).toEqual([2, 5, 'backward']);
          }
          if (outcome === 'failure') await expect(fields.banner).toContainText('Banner save unavailable.');
          else await expect(fields.banner).toHaveCount(0);
          expect(fields.errors).toEqual([]);
        });
      }
    }

    test(`Settings Housekeeping banner focus ${size.name} respects a newer dialog after ${operation.name}`, async ({ page }) => {
      await page.setViewportSize(size.viewport);
      const fields = await openHousekeepingBannerWrite(page, operation);
      const trigger = fields.panel.getByRole('button', { name: 'Run enrichment.summary now', exact: true });
      await trigger.focus();
      await page.keyboard.press('Enter');
      const cancel = fields.panel.locator('[data-action="housekeeping-run-now-cancel"]');
      await expect(cancel).toBeFocused();
      await releaseHousekeepingBannerWrite(page, operation);
      await expect(cancel).toBeFocused();
      expect(fields.errors).toEqual([]);
    });

    test(`Settings Housekeeping banner focus ${size.name} leaves native Contracts navigation alone during ${operation.name}`, async ({ page }) => {
      await page.setViewportSize(size.viewport);
      const fields = await openHousekeepingBannerWrite(page, operation);
      await fields.details.focus();
      await page.keyboard.press('Enter');
      const link = fields.panel.getByRole('link', { name: 'Manage read access in Contracts →', exact: true });
      await link.focus();
      await page.keyboard.press('Enter');
      await expect(fields.panel).toHaveCount(0);
      await expect(page).toHaveURL(/#contracts$/);
      const focusBefore = await page.evaluateHandle(() => document.activeElement);
      await releaseHousekeepingBannerWrite(page, operation);
      await expect(fields.panel).toHaveCount(0);
      await expect(page).toHaveURL(/#contracts$/);
      // The disposed panel's reply cannot move focus back into Housekeeping.
      expect(await page.evaluate((active) => document.activeElement === active, focusBefore)).toBe(true);
      expect(fields.errors).toEqual([]);
    });

    test(`Settings Housekeeping banner focus ${size.name} keeps another topic's banner after ${operation.name}`, async ({ page }) => {
      await page.setViewportSize(size.viewport);
      const fields = await openHousekeepingBannerWrite(page, operation);
      const otherTopic = fields.panel.locator(`.${operation.banner}[${operation.topicAttribute}="thread_signals"] [data-action="${operation.action}"]`);
      await otherTopic.focus();
      await releaseHousekeepingBannerWrite(page, operation);
      await expect(otherTopic).toBeFocused();
      expect(fields.errors).toEqual([]);
    });

    test(`Settings Housekeeping banner focus ${size.name} returns to search when ${operation.name}'s topic is filtered out`, async ({ page }) => {
      await page.setViewportSize(size.viewport);
      const fields = await openHousekeepingBannerWrite(page, operation);
      const search = fields.panel.locator(`[data-action="housekeeping-producer-search"]`);
      await search.fill('no-matching-producer');
      await expect(fields.details).toHaveCount(0);
      await fields.target.focus();
      await releaseHousekeepingBannerWrite(page, operation);
      await expect(search).toBeFocused();
      await expect(search).toBeInViewport();
      expect(fields.errors).toEqual([]);
    });
  }
}

const newerDriftSignal = (dismissed = false): ConfidenceDriftSignal => {
  const baseline = Array<number>(10).fill(0.1);
  const recent = [0.18, 0.15, 0.12, 0.11, 0.1, 0.09, 0.08, 0.07, 0.055, 0.045];
  return {
    source_topic: 'summary', computed_at: FIXED_NOW + 1, severity: 'moderate',
    psi: recent.reduce((total, value, index) => total + (value - baseline[index]!) * Math.log(value / baseline[index]!), 0),
    baseline_window: { start_at: FIXED_NOW - 60000, end_at: FIXED_NOW - 30000, sample_count: 30 },
    recent_window: { start_at: FIXED_NOW - 30000, end_at: FIXED_NOW, sample_count: 30 },
    baseline_distribution: baseline, recent_distribution: recent,
    ...(dismissed ? { dismissed_at: FIXED_NOW + 2 } : {}),
  };
};
const publishNewerDriftSignal = async (page: Page, dismissed = false) => {
  const row = newerDriftSignal(dismissed);
  const reads = await page.evaluate(() => window.__app.rpcCallCount('housekeeping.drift.read'));
  expect(await page.evaluate(() => typeof window.__app.setHousekeepingDriftSignal)).toBe('function');
  await page.evaluate((row) => {
    // The fixture server owns the complete stored row before emitting the
    // narrow broadcast, so a later read and a fresh mount see the same verdict.
    window.__app.setHousekeepingDriftSignal?.(row);
    window.__app.fireMessage({ type: 'server_event', event: {
      kind: 'enrichment_drift_detected', source_topic: row.source_topic,
      psi: row.psi, severity: row.severity, computed_at: row.computed_at, cursor: 100,
    } });
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }, row);
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.drift.read'))).toBeGreaterThan(reads);
};
const remountDriftPanel = async (page: Page, panel: Locator) => {
  const reads = await page.evaluate(() => window.__app.rpcCallCount('housekeeping.drift.read'));
  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(panel).toHaveCount(0);
  await page.evaluate(() => window.__app.setHash('#settings/housekeeping'));
  await expect(panel.getByRole('region', { name: 'Idle schedule', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.drift.read'))).toBeGreaterThan(reads);
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
};

const releaseDriftRead = async (page: Page) => {
  expect(await page.evaluate(() => {
    const count = window.__app.releaseRpcResponses?.('housekeeping.drift.read') ?? 0;
    return new Promise<number>((resolve) => setTimeout(() => resolve(count), 0));
  })).toBe(1);
};
const openDriftEventPanel = async (page: Page) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fields = await openHousekeepingSchedule(page,
    'housekeeping_banners=ready&housekeeping_trust=tracked&hold_rpc=housekeeping.drift.read');
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.drift.read'))).toBe(1);
  await releaseDriftRead(page);
  const banner = fields.panel.locator('.housekeeping-drift-banner[data-source-topic="summary"]');
  await expect(banner).toHaveAttribute('data-severity', 'significant');
  return { ...fields, banner, errors,
    details: fields.panel.locator('[data-action="housekeeping-drawer-toggle"][data-topic="summary"]'),
    chart: fields.panel.locator('.housekeeping-drawer-drift[data-source-topic="summary"]'),
    dismiss: banner.locator('[data-action="housekeeping-drift-dismiss"]'),
  };
};

for (const size of [
  { name: 'desktop', viewport: { width: 1280, height: 900 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
]) {
  for (const scenario of ['visible-replay', 'dismissed-replay', 'older-computation']) {
    for (const owner of ['details', 'search', 'dialog']) {
      test(`Settings Housekeeping drift event ${size.name} preserves ${owner} for ${scenario} before and after the read`, async ({ page }) => {
        await page.setViewportSize(size.viewport);
        const fields = await openDriftEventPanel(page);
        if (scenario === 'dismissed-replay') {
          await fields.dismiss.focus();
          await page.keyboard.press('Enter');
          await expect(fields.banner).toHaveCount(0);
          expect(await page.evaluate(() => window.__app.rpcCallCount('housekeeping.drift.dismiss'))).toBe(1);
        } else if (scenario === 'older-computation') {
          await publishNewerDriftSignal(page);
          await releaseDriftRead(page);
          await expect(fields.banner).toHaveAttribute('data-severity', 'moderate');
        }
        await fields.details.focus();
        await page.keyboard.press('Enter');
        const severity = scenario === 'older-computation' ? 'moderate' : 'significant';
        await expect(fields.chart).toHaveAttribute('data-severity', severity);
        const analysis = await fields.chart.innerHTML();
        let target = fields.details;
        if (owner === 'search') {
          target = fields.search;
          await target.fill('summary');
          await target.evaluate((element) => (element as HTMLInputElement).setSelectionRange(2, 5, 'backward'));
        } else if (owner === 'dialog') {
          await fields.panel.getByRole('button', { name: 'Run enrichment.summary now', exact: true }).focus();
          await page.keyboard.press('Enter');
          target = fields.panel.locator('[data-action="housekeeping-run-now-cancel"]');
        }
        await target.focus();
        const reads = await page.evaluate(() => window.__app.rpcCallCount('housekeeping.drift.read'));
        await page.evaluate((computedAt) => window.__app.fireMessage({ type: 'server_event', event: {
          kind: 'enrichment_drift_detected', source_topic: 'summary',
          computed_at: computedAt, severity: 'significant', psi: 0.31, cursor: 101,
        } }), FIXED_NOW);
        await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.drift.read'))).toBe(reads + 1);
        const expectPreserved = async () => {
          await expect(fields.chart).toHaveAttribute('data-severity', severity);
          expect(await fields.chart.innerHTML()).toBe(analysis);
          if (scenario === 'dismissed-replay') await expect(fields.banner).toHaveCount(0);
          else await expect(fields.banner).toHaveAttribute('data-severity', severity);
          await expect(target).toBeFocused();
          if (owner === 'search') expect(await target.evaluate((element) => {
            const input = element as HTMLInputElement;
            return [input.selectionStart, input.selectionEnd, input.selectionDirection];
          })).toEqual([2, 5, 'backward']);
          await expect(fields.panel.locator('.housekeeping-drift-banner[data-source-topic="thread_signals"]')).toBeVisible();
        };
        await expectPreserved();
        await releaseDriftRead(page);
        await expectPreserved();
        expect(fields.errors).toEqual([]);
      });
    }
  }

  for (const dismissed of [false, true]) {
    test(`Settings Housekeeping drift event ${size.name} re-arms a newer computation after a ${dismissed ? 'dismissed' : 'visible'} result`, async ({ page }) => {
      await page.setViewportSize(size.viewport);
      const fields = await openDriftEventPanel(page);
      if (dismissed) {
        await fields.dismiss.focus();
        await page.keyboard.press('Enter');
        await expect(fields.banner).toHaveCount(0);
      }
      await fields.details.focus();
      await page.keyboard.press('Enter');
      await expect(fields.chart).toHaveAttribute('data-severity', 'significant');
      await fields.search.fill('summary');
      await fields.search.evaluate((element) => (element as HTMLInputElement).setSelectionRange(2, 5, 'backward'));
      await publishNewerDriftSignal(page);
      await expect(fields.banner).toBeVisible();
      await expect(fields.banner).toHaveAttribute('data-severity', 'moderate');
      await expect(fields.chart).toHaveCount(0);
      await expect(fields.search).toBeFocused();
      await releaseDriftRead(page);
      await expect(fields.banner).toHaveAttribute('data-severity', 'moderate');
      await expect(fields.chart).toHaveAttribute('data-severity', 'moderate');
      await expect(fields.search).toBeFocused();
      expect(await fields.search.evaluate((element) => {
        const input = element as HTMLInputElement;
        return [input.selectionStart, input.selectionEnd, input.selectionDirection];
      })).toEqual([2, 5, 'backward']);
      expect(fields.errors).toEqual([]);
    });
  }
}

for (const size of [
  { name: 'desktop', viewport: { width: 1280, height: 900 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
]) {
  for (const outcome of ['success', 'failure']) {
    for (const dismissed of [false, true]) {
      test(`Settings Housekeeping drift reply ${size.name} keeps the newer ${dismissed ? 'dismissed' : 'visible'} alert after an old ${outcome}`, async ({ page }) => {
        await page.setViewportSize(size.viewport);
        const operation = housekeepingBannerCases[2];
        const fields = await openHousekeepingBannerWrite(page, operation,
          outcome === 'failure' ? 'housekeeping_banner_response=fail-first' : '');
        await publishNewerDriftSignal(page, dismissed);
        await expect(fields.banner).toHaveAttribute('data-severity', 'moderate');
        await expect(fields.target).toBeFocused();
        await page.keyboard.press('Enter');
        expect(await page.evaluate(() => window.__app.rpcCallCount('housekeeping.drift.dismiss'))).toBe(1);
        await releaseHousekeepingBannerWrite(page, operation);
        await expect(fields.panel).not.toContainText('Banner save unavailable.');
        if (dismissed) {
          await expect(fields.banner).toHaveCount(0);
          await expect(fields.details).toBeFocused();
        } else {
          await expect(fields.banner).toBeVisible();
          await expect(fields.banner).toHaveAttribute('data-severity', 'moderate');
          await expect(fields.target).toBeFocused();
          await expect(fields.target).not.toHaveAttribute('aria-disabled');
          await expect(fields.target).not.toHaveAttribute('aria-busy');
        }
        // A settled dismissal can hide the banner, but the drawer must still
        // describe the newer stored computation rather than the old reply.
        await fields.details.focus();
        await page.keyboard.press('Enter');
        await expect(fields.panel.locator('.housekeeping-drawer-drift[data-source-topic="summary"]'))
          .toHaveAttribute('data-severity', 'moderate');
        await remountDriftPanel(page, fields.panel);
        if (dismissed) await expect(fields.banner).toHaveCount(0);
        else {
          await expect(fields.banner).toHaveAttribute('data-severity', 'moderate');
          await fields.target.focus();
          await page.keyboard.press('Enter');
          await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.drift.dismiss'))).toBe(2);
          await releaseHousekeepingBannerWrite(page, operation);
          await expect(fields.banner).toHaveCount(0);
          await expect(fields.details).toBeFocused();
          await remountDriftPanel(page, fields.panel);
          await expect(fields.banner).toHaveCount(0);
        }
        expect(fields.errors).toEqual([]);
      });
    }

    for (const owner of ['search', 'header', 'dialog', 'other-alert']) {
      test(`Settings Housekeeping drift reply ${size.name} preserves ${owner} after an old ${outcome}`, async ({ page }) => {
        await page.setViewportSize(size.viewport);
        const operation = housekeepingBannerCases[2];
        const fields = await openHousekeepingBannerWrite(page, operation,
          outcome === 'failure' ? 'housekeeping_banner_response=fail-first' : '');
        await publishNewerDriftSignal(page);
        let target: Locator;
        if (owner === 'search') {
          target = fields.search;
          await target.fill('summary');
          await target.evaluate((element) => (element as HTMLInputElement).setSelectionRange(2, 5, 'backward'));
        } else if (owner === 'header') {
          target = page.getByRole('button', { name: 'Run a Recipe', exact: true });
        } else if (owner === 'dialog') {
          await fields.panel.getByRole('button', { name: 'Run enrichment.summary now', exact: true }).focus();
          await page.keyboard.press('Enter');
          target = fields.panel.locator('[data-action="housekeeping-run-now-cancel"]');
        } else {
          target = fields.panel.locator('.housekeeping-drift-banner[data-source-topic="thread_signals"] [data-action="housekeeping-drift-review"]');
        }
        await target.focus();
        await releaseHousekeepingBannerWrite(page, operation);
        await expect(target).toBeFocused();
        await expect(fields.banner).toHaveAttribute('data-severity', 'moderate');
        await expect(fields.panel).not.toContainText('Banner save unavailable.');
        if (owner === 'search') expect(await target.evaluate((element) => {
          const input = element as HTMLInputElement;
          return [input.selectionStart, input.selectionEnd, input.selectionDirection];
        })).toEqual([2, 5, 'backward']);
        expect(fields.errors).toEqual([]);
      });
    }
  }
}

const topicTrustOperations = [
  { name: 'Run policy', action: 'housekeeping-trust-state-pick', value: 'off', rpc: 'housekeeping.trust.write', key: 'Space' },
  { name: 'Model pool', action: 'housekeeping-pool-policy-pick', value: 'free_only', rpc: 'housekeeping.trust.write', key: 'Space' },
  { name: 'Promote', action: 'housekeeping-promotion-promote', rpc: 'housekeeping.trust.write', key: 'Enter' },
  { name: 'Don’t ask again', action: 'housekeeping-promotion-dismiss', rpc: 'housekeeping.trust.dismiss_promotion', key: 'Enter' },
] as const;
type TopicTrustOperation = typeof topicTrustOperations[number];
const topicTrustControl = (panel: Locator, operation: TopicTrustOperation, topic = 'summary') => panel.locator(
  `[data-action="${operation.action}"][data-topic="${topic}"]${'value' in operation ? `[value="${operation.value}"]` : ''}`);
const topicTrustValues = (page: Page, topic = 'summary') => page.evaluate((topic) => ({
  run: document.querySelector<HTMLInputElement>(`[data-action="housekeeping-trust-state-pick"][data-topic="${topic}"]:checked`)?.value,
  pool: document.querySelector<HTMLInputElement>(`[data-action="housekeeping-pool-policy-pick"][data-topic="${topic}"]:checked`)?.value,
}), topic);
const topicTrustCounts = (page: Page) => page.evaluate(() => ({
  write: window.__app.rpcCallCount('housekeeping.trust.write'),
  dismiss: window.__app.rpcCallCount('housekeeping.trust.dismiss_promotion'),
}));
const releaseTopicTrustWrite = async (page: Page, method: string, index?: number) => {
  expect(await page.evaluate(({ method, index }) => {
    const count = window.__app.releaseRpcResponses?.(method, index) ?? 0;
    return new Promise<number>((resolve) => setTimeout(() => resolve(count), 0));
  }, { method, index })).toBe(1);
};
const openTopicTrustWrite = async (page: Page, operation: TopicTrustOperation, query = '') => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fields = await openHousekeepingSchedule(page,
    `housekeeping_banners=ready&housekeeping_trust=tracked&hold_rpc=housekeeping.trust.write&hold_rpc=housekeeping.trust.dismiss_promotion&${query}`);
  const details = fields.panel.locator('[data-action="housekeeping-drawer-toggle"][data-topic="summary"]');
  await details.focus();
  await page.keyboard.press('Enter');
  const target = topicTrustControl(fields.panel, operation);
  await expect.poll(() => topicTrustValues(page)).toEqual({ run: 'manual', pool: 'free_then_byok' });
  await target.focus();
  await page.keyboard.press(operation.key);
  await expect.poll(() => page.evaluate((rpc) => window.__app.rpcCallCount(rpc), operation.rpc)).toBe(1);
  return { ...fields, target, details, errors };
};
const topicTrustExpected = (operation: TopicTrustOperation) => ({
  run: operation.name === 'Run policy' ? 'off' : operation.name === 'Promote' ? 'auto' : 'manual',
  pool: operation.name === 'Model pool' ? 'free_only' : 'free_then_byok',
});

const publishPromotionEstimate = async (page: Page) => {
  await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: {
    kind: 'enrichment_promotion_suggested', topic: 'summary', manual_run_count: 3,
    estimated_idle_cycle_cost_tokens: 30_000, cursor: 100,
  } }));
};

const promotionServerRow = (choice: 'auto' | 'dismissed' | 'eligible'): EnrichmentTrustRow => ({
  topic: 'summary', trust_state: choice === 'auto' ? 'auto' : 'manual',
  pool_policy: 'free_then_byok', manual_run_count: choice === 'eligible' ? 4 : 3,
  promotion_suggested_at: choice === 'eligible' ? FIXED_NOW + 1 : FIXED_NOW,
  promotion_dismissed_at: choice === 'dismissed' ? FIXED_NOW : null,
  updated_at: FIXED_NOW + 2,
});
const firePromotionEvent = async (page: Page) => {
  const reads = await page.evaluate(() => window.__app.rpcCallCount('housekeeping.trust.read'));
  await page.evaluate((event) => {
    window.__app.fireMessage({ type: 'server_event', event });
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }, { kind: 'enrichment_promotion_suggested', topic: 'summary', manual_run_count: 4,
    estimated_idle_cycle_cost_tokens: 30_000, cursor: 101 });
  return reads;
};
const openPromotionEventPanel = async (page: Page, choice: 'auto' | 'dismissed') => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fields = await openHousekeepingSchedule(page, 'housekeeping_banners=ready&housekeeping_trust=tracked');
  const banner = fields.panel.locator('.housekeeping-promotion-banner[data-topic="summary"]');
  const details = fields.panel.locator('[data-action="housekeeping-drawer-toggle"][data-topic="summary"]');
  await expect(banner).toBeVisible();
  await banner.locator(`[data-action="housekeeping-promotion-${choice === 'auto' ? 'promote' : 'dismiss'}"]`).focus();
  await page.keyboard.press('Enter');
  await expect(banner).toHaveCount(0);
  await details.focus();
  await page.keyboard.press('Enter');
  const selected = fields.panel.locator(`[data-action="housekeeping-trust-state-pick"][data-topic="summary"][value="${choice === 'auto' ? 'auto' : 'manual'}"]`);
  await expect(selected).toBeChecked();
  await page.evaluate(() => window.__app.holdRpcResponses?.('housekeeping.trust.read'));
  return { ...fields, banner, details, selected, errors };
};
const promotionEventOwner = async (page: Page, fields: Awaited<ReturnType<typeof openPromotionEventPanel>>, owner: string) => {
  let target = fields.search;
  if (owner === 'search') {
    await target.fill('summary');
    await target.evaluate((element) => (element as HTMLInputElement).setSelectionRange(2, 5, 'backward'));
  } else {
    await fields.panel.getByRole('button', { name: 'Run enrichment.summary now', exact: true }).focus();
    await page.keyboard.press('Enter');
    target = fields.panel.locator('[data-action="housekeeping-run-now-cancel"]');
  }
  await target.focus();
  return target;
};

const openPendingPromotionPanel = async (page: Page, fail = false) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fields = await openHousekeepingSchedule(page,
    `housekeeping_banners=ready&housekeeping_trust=tracked&${fail ? 'housekeeping_trust_response=fail-first' : ''}`);
  const banner = fields.panel.locator('.housekeeping-promotion-banner[data-topic="summary"]');
  await expect(banner).toBeVisible();
  await page.evaluate((row) => window.__app.setHousekeepingTrustRow?.(row), promotionServerRow('auto'));
  await firePromotionEvent(page);
  await expect(banner).toHaveCount(0);
  const details = fields.panel.locator('[data-action="housekeeping-drawer-toggle"][data-topic="summary"]');
  await details.focus();
  await page.keyboard.press('Enter');
  const selected = fields.panel.locator('[data-action="housekeeping-trust-state-pick"][data-topic="summary"][value="auto"]');
  const manual = fields.panel.locator('[data-action="housekeeping-trust-state-pick"][data-topic="summary"][value="manual"]');
  await expect(selected).toBeChecked();
  await page.evaluate(() => window.__app.holdRpcResponses?.('housekeeping.trust.write'));
  await manual.focus();
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.trust.write'))).toBe(1);
  await expect(manual).toHaveAttribute('aria-disabled', 'true');
  return { ...fields, banner, details, selected, manual, errors };
};
const publishPendingPromotionEstimates = async (page: Page) => {
  const reads = await firePromotionEvent(page);
  await page.evaluate(() => {
    window.__app.fireMessage({ type: 'server_event', event: {
      kind: 'enrichment_promotion_suggested', topic: 'summary', manual_run_count: 5,
      estimated_idle_cycle_cost_tokens: 60_000, cursor: 102,
    } });
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  expect(await page.evaluate(() => window.__app.rpcCallCount('housekeeping.trust.read'))).toBe(reads);
  return reads;
};

for (const size of [
  { name: 'desktop', viewport: { width: 1280, height: 900 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
]) {
  for (const owner of ['search', 'dialog']) {
    test(`Settings Housekeeping promotion pending ${size.name} retains the latest Manual estimate with ${owner} focus`, async ({ page }) => {
      await page.setViewportSize(size.viewport);
      const fields = await openPendingPromotionPanel(page);
      const target = await promotionEventOwner(page, fields, owner);
      const other = fields.panel.locator('.housekeeping-promotion-banner[data-topic="thread_signals"]');
      const beforeOther = await other.innerText();
      const reads = await publishPendingPromotionEstimates(page);
      await expect(fields.banner).toHaveCount(0);
      await expect(fields.selected).toBeChecked();
      await expect(target).toBeFocused();
      await releaseTopicTrustWrite(page, 'housekeeping.trust.write');
      await expect(fields.manual).toBeChecked();
      await expect(fields.manual).not.toHaveAttribute('aria-disabled');
      await expect(fields.banner).toBeVisible();
      await expect(fields.banner).toContainText('60,000 tokens');
      await expect(other).toHaveText(beforeOther);
      await expect(target).toBeFocused();
      if (owner === 'search') expect(await target.evaluate((element) => {
        const input = element as HTMLInputElement;
        return [input.selectionStart, input.selectionEnd, input.selectionDirection];
      })).toEqual([2, 5, 'backward']);
      expect(await page.evaluate(() => window.__app.rpcCallCount('housekeeping.trust.read'))).toBe(reads);
      expect(await topicTrustCounts(page)).toEqual({ write: 1, dismiss: 0 });
      if (owner === 'dialog') await page.keyboard.press('Enter');
      await remountDriftPanel(page, fields.panel);
      await expect(fields.banner).toContainText('no estimate available');
      expect(fields.errors).toEqual([]);
    });
  }

  test(`Settings Housekeeping promotion pending ${size.name} discards the failed save hint before explicit retry`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openPendingPromotionPanel(page, true);
    const target = await promotionEventOwner(page, fields, 'search');
    const reads = await publishPendingPromotionEstimates(page);
    await releaseTopicTrustWrite(page, 'housekeeping.trust.write');
    await expect(fields.selected).toBeChecked();
    await expect(fields.banner).toHaveCount(0);
    await expect(fields.panel).toContainText('Banner save unavailable.');
    await expect(target).toBeFocused();
    expect(await topicTrustCounts(page)).toEqual({ write: 1, dismiss: 0 });
    await fields.manual.focus();
    await page.keyboard.press('Space');
    await expect.poll(() => topicTrustCounts(page)).toEqual({ write: 2, dismiss: 0 });
    await releaseTopicTrustWrite(page, 'housekeeping.trust.write');
    await expect(fields.manual).toBeChecked();
    await expect(fields.banner).toContainText('no estimate available');
    await expect(fields.manual).toBeFocused();
    expect(await page.evaluate(() => window.__app.rpcCallCount('housekeeping.trust.read'))).toBe(reads);
    expect(fields.errors).toEqual([]);
  });

  for (const choice of ['auto', 'dismissed'] as const) {
    for (const owner of ['search', 'dialog']) {
      for (const genuine of [false, true]) {
        test(`Settings Housekeeping promotion event ${size.name} ${genuine ? 'accepts a genuine suggestion' : `keeps ${choice} hidden`} after ${choice} with ${owner} focus`, async ({ page }) => {
          await page.setViewportSize(size.viewport);
          const fields = await openPromotionEventPanel(page, choice);
          const target = await promotionEventOwner(page, fields, owner);
          if (genuine) {
            expect(await page.evaluate(() => typeof window.__app.setHousekeepingTrustRow)).toBe('function');
            await page.evaluate((row) => window.__app.setHousekeepingTrustRow?.(row), promotionServerRow('eligible'));
          }
          const reads = await firePromotionEvent(page);
          await expect(fields.banner).toHaveCount(0);
          await expect(fields.selected).toBeChecked();
          await expect(target).toBeFocused();
          await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.trust.read'))).toBe(reads + 1);
          await releaseTopicTrustWrite(page, 'housekeeping.trust.read');
          if (genuine) {
            await expect(fields.banner).toBeVisible();
            await expect(fields.banner).toContainText('30,000 tokens');
            await expect(fields.panel.locator('[data-action="housekeeping-trust-state-pick"][data-topic="summary"][value="manual"]')).toBeChecked();
          } else {
            await expect(fields.banner).toHaveCount(0);
            await expect(fields.selected).toBeChecked();
          }
          await expect(target).toBeFocused();
          if (owner === 'search') expect(await target.evaluate((element) => {
            const input = element as HTMLInputElement;
            return [input.selectionStart, input.selectionEnd, input.selectionDirection];
          })).toEqual([2, 5, 'backward']);
          await expect(fields.panel.locator('.housekeeping-promotion-banner[data-topic="thread_signals"]')).toBeVisible();
          if (owner === 'dialog') await page.keyboard.press('Enter');
          const beforeRemount = await page.evaluate(() => window.__app.rpcCallCount('housekeeping.trust.read'));
          await page.evaluate(() => window.__app.setHash('#data'));
          await expect(fields.panel).toHaveCount(0);
          await page.evaluate(() => window.__app.setHash('#settings/housekeeping'));
          await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.trust.read'))).toBe(beforeRemount + 1);
          await releaseTopicTrustWrite(page, 'housekeeping.trust.read');
          await expect(fields.schedule).toBeVisible();
          if (genuine) await expect(fields.banner).toBeVisible();
          else await expect(fields.banner).toHaveCount(0);
          expect(fields.errors).toEqual([]);
        });
      }
    }
  }

  for (const remote of ['auto', 'dismissed'] as const) {
    test(`Settings Housekeeping promotion event ${size.name} withdraws a hint after remote ${remote}`, async ({ page }) => {
      await page.setViewportSize(size.viewport);
      const fields = await openHousekeepingSchedule(page, 'housekeeping_banners=ready&housekeeping_trust=tracked');
      const banner = fields.panel.locator('.housekeeping-promotion-banner[data-topic="summary"]');
      const details = fields.panel.locator('[data-action="housekeeping-drawer-toggle"][data-topic="summary"]');
      const target = banner.locator('[data-action="housekeeping-promotion-promote"]');
      await expect(target).toBeVisible();
      await page.evaluate(() => window.__app.holdRpcResponses?.('housekeeping.trust.read'));
      await page.evaluate((row) => window.__app.setHousekeepingTrustRow?.(row), promotionServerRow(remote));
      await target.focus();
      const reads = await firePromotionEvent(page);
      await expect(banner).toContainText('30,000 tokens');
      await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.trust.read'))).toBe(reads + 1);
      await releaseTopicTrustWrite(page, 'housekeeping.trust.read');
      await expect(banner).toHaveCount(0);
      await expect(details).toBeFocused();
      await details.focus();
      await page.keyboard.press('Enter');
      await expect(fields.panel.locator(`[data-action="housekeeping-trust-state-pick"][data-topic="summary"][value="${remote === 'auto' ? 'auto' : 'manual'}"]`)).toBeChecked();
      expect(await topicTrustCounts(page)).toEqual({ write: 0, dismiss: 0 });
    });
  }
}

for (const size of [
  { name: 'desktop', viewport: { width: 1280, height: 900 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
]) {
  for (const outcome of ['success', 'failure']) {
    for (const owner of ['radio', 'banner', 'search', 'header', 'dialog']) {
      test(`Settings Housekeeping promotion continuity ${size.name} saves Auto with ${owner} focus after ${outcome}`, async ({ page }) => {
        await page.setViewportSize(size.viewport);
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const fields = await openHousekeepingSchedule(page,
          `housekeeping_banners=ready&housekeeping_trust=tracked&hold_rpc=housekeeping.trust.write&${outcome === 'failure' ? 'housekeeping_trust_response=fail-first' : ''}`);
        const banner = fields.panel.locator('.housekeeping-promotion-banner[data-topic="summary"]');
        const otherBanner = fields.panel.locator('.housekeeping-promotion-banner[data-topic="thread_signals"]');
        const details = fields.panel.locator('[data-action="housekeeping-drawer-toggle"][data-topic="summary"]');
        const auto = fields.panel.locator('[data-action="housekeeping-trust-state-pick"][data-topic="summary"][value="auto"]');
        const manual = fields.panel.locator('[data-action="housekeeping-trust-state-pick"][data-topic="summary"][value="manual"]');
        await expect(banner).toBeVisible();
        await details.focus();
        await page.keyboard.press('Enter');
        await expect(manual).toBeChecked();
        await publishPromotionEstimate(page);
        await expect(banner).toContainText('30,000 tokens');
        const moveFocus = async (): Promise<Locator> => {
          let target: Locator;
          if (owner === 'radio') target = auto;
          else if (owner === 'banner') target = banner.locator('[data-action="housekeeping-promotion-promote"]');
          else if (owner === 'search') {
            target = fields.search;
            await target.fill('summary');
            await target.evaluate((element) => (element as HTMLInputElement).setSelectionRange(2, 5, 'backward'));
          } else if (owner === 'header') target = page.getByRole('button', { name: 'Run a Recipe', exact: true });
          else {
            await fields.panel.getByRole('button', { name: 'Run enrichment.summary now', exact: true }).focus();
            await page.keyboard.press('Enter');
            target = fields.panel.locator('[data-action="housekeeping-run-now-cancel"]');
          }
          await target.focus();
          return target;
        };
        await auto.focus();
        await page.keyboard.press('Space');
        await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.trust.write'))).toBe(1);
        await expect(auto).toHaveAttribute('aria-disabled', 'true');
        await expect(manual).toBeChecked();
        await expect(banner).toContainText('30,000 tokens');
        let target = await moveFocus();
        await releaseTopicTrustWrite(page, 'housekeeping.trust.write');
        if (outcome === 'failure') {
          await expect(manual).toBeChecked();
          await expect(banner).toBeVisible();
          await expect(banner).toContainText('30,000 tokens');
          await expect(banner.locator('[data-action="housekeeping-promotion-promote"]')).not.toHaveAttribute('aria-disabled');
          await expect(auto).not.toHaveAttribute('aria-disabled');
          await expect(target).toBeFocused();
          await expect(fields.panel).toContainText('Banner save unavailable.');
          expect(await page.evaluate(() => window.__app.rpcCallCount('housekeeping.trust.write'))).toBe(1);
          if (owner === 'dialog') await page.keyboard.press('Enter');
          await auto.focus();
          await page.keyboard.press('Space');
          await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.trust.write'))).toBe(2);
          target = await moveFocus();
          await releaseTopicTrustWrite(page, 'housekeeping.trust.write');
        }
        await expect(auto).toBeChecked();
        await expect(auto).not.toHaveAttribute('aria-disabled');
        await expect(banner).toHaveCount(0);
        await expect(otherBanner).toBeVisible();
        await expect(owner === 'banner' ? details : target).toBeFocused();
        await expect(fields.panel).not.toContainText('Banner save unavailable.');
        if (owner === 'search') expect(await target.evaluate((element) => {
          const input = element as HTMLInputElement;
          return [input.selectionStart, input.selectionEnd, input.selectionDirection];
        })).toEqual([2, 5, 'backward']);
        if (owner === 'dialog') await page.keyboard.press('Enter');
        await remountDriftPanel(page, fields.panel);
        await expect(banner).toHaveCount(0);
        await expect(otherBanner).toBeVisible();
        await details.focus();
        await page.keyboard.press('Enter');
        await expect(auto).toBeChecked();
        expect(await page.evaluate(() => window.__app.rpcCallCount('housekeeping.trust.write'))).toBe(outcome === 'failure' ? 2 : 1);
        expect(errors).toEqual([]);
      });
    }
  }

  for (const operation of topicTrustOperations.slice(0, 2)) {
    test(`Settings Housekeeping promotion continuity ${size.name} keeps the estimate after ${operation.name}`, async ({ page }) => {
      await page.setViewportSize(size.viewport);
      const fields = await openTopicTrustWrite(page, operation);
      const banner = fields.panel.locator('.housekeeping-promotion-banner[data-topic="summary"]');
      await publishPromotionEstimate(page);
      await expect(banner).toContainText('30,000 tokens');
      await fields.target.focus();
      await releaseTopicTrustWrite(page, operation.rpc);
      await expect.poll(() => topicTrustValues(page)).toEqual(topicTrustExpected(operation));
      await expect(banner).toBeVisible();
      await expect(banner).toContainText('30,000 tokens');
      await expect(fields.target).toBeFocused();
      expect(fields.errors).toEqual([]);
    });
  }
}

for (const size of [
  { name: 'desktop', viewport: { width: 1280, height: 900 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
]) {
  for (const operation of topicTrustOperations) {
    for (const outcome of ['success', 'failure']) {
      test(`Settings Housekeeping topic writes ${size.name} serializes ${operation.name} through ${outcome} and explicit followup`, async ({ page, browserName }) => {
        await page.setViewportSize(size.viewport);
        const fields = await openTopicTrustWrite(page, operation,
          outcome === 'failure' ? 'housekeeping_banner_response=fail-first' : '');
        await expect(fields.target).toBeFocused();
        const initialCounts = operation.rpc === 'housekeeping.trust.write' ? { write: 1, dismiss: 0 } : { write: 0, dismiss: 1 };
        for (const blocked of topicTrustOperations) {
          const control = topicTrustControl(fields.panel, blocked);
          await expect(control).toHaveAttribute('aria-disabled', 'true');
          expect(await control.evaluate((element) => (element as HTMLInputElement | HTMLButtonElement).disabled)).toBe(false);
          await control.focus();
          await page.keyboard.press(blocked.key);
          await expect(control).toBeFocused();
          if ('value' in blocked) {
            for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) await page.keyboard.press(key);
            await control.locator('..').click({ force: true });
          } else await control.click({ force: true });
          expect(await topicTrustCounts(page)).toEqual(initialCounts);
          await expect.poll(() => topicTrustValues(page)).toEqual({ run: 'manual', pool: 'free_then_byok' });
        }
        await fields.target.focus();
        await refreshScheduleStatus(page);
        await expect(fields.target).toBeFocused();
        await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
        await expect(fields.target).not.toBeFocused();
        expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
        await fields.target.focus();
        await releaseTopicTrustWrite(page, operation.rpc);
        if (outcome === 'failure') {
          await expect(fields.target).toBeFocused();
          await expect(fields.panel).toContainText('Banner save unavailable.');
          for (const available of topicTrustOperations) await expect(topicTrustControl(fields.panel, available)).not.toHaveAttribute('aria-disabled');
          await page.keyboard.press(operation.key);
          await expect.poll(() => page.evaluate((rpc) => window.__app.rpcCallCount(rpc), operation.rpc)).toBe(2);
          await expect(fields.target).toBeFocused();
          await releaseTopicTrustWrite(page, operation.rpc);
        }
        let expected = topicTrustExpected(operation);
        await expect.poll(() => topicTrustValues(page)).toEqual(expected);
        if ('value' in operation) await expect(fields.target).toBeFocused();
        else await expect(fields.details).toBeFocused();
        await expect(fields.panel.locator('[data-action="housekeeping-trust-state-pick"][data-topic="summary"][aria-disabled="true"], [data-action="housekeeping-pool-policy-pick"][data-topic="summary"][aria-disabled="true"]')).toHaveCount(0);
        const settledCounts = { ...initialCounts, ...(outcome === 'failure' ? operation.rpc === 'housekeeping.trust.write' ? { write: 2 } : { dismiss: 2 } : {}) };
        expect(await topicTrustCounts(page)).toEqual(settledCounts);
        if (outcome === 'success') {
          const followup = 'value' in operation ? topicTrustOperations[2] : topicTrustOperations[1];
          const control = topicTrustControl(fields.panel, followup);
          await control.focus();
          await page.keyboard.press(followup.key);
          await expect.poll(() => topicTrustCounts(page)).toEqual({ ...settledCounts, write: settledCounts.write + 1 });
          await releaseTopicTrustWrite(page, followup.rpc);
          expected = 'value' in operation ? { ...expected, run: 'auto' } : { ...expected, pool: 'free_only' };
          await expect.poll(() => topicTrustValues(page)).toEqual(expected);
        }
        // The second command is explicit, and fresh reads retain both saved fields.
        await page.evaluate(() => window.__app.setHash('#data'));
        await expect(fields.panel).toHaveCount(0);
        await page.evaluate(() => window.__app.setHash('#settings/housekeeping'));
        await expect(fields.details).toBeVisible();
        await fields.details.focus();
        await page.keyboard.press('Enter');
        await expect.poll(() => topicTrustValues(page)).toEqual(expected);
        expect(fields.errors).toEqual([]);
      });
    }
  }

  for (const operation of topicTrustOperations.slice(2)) {
    test(`Settings Housekeeping topic writes ${size.name} keeps another topic independent during ${operation.name}`, async ({ page }) => {
      await page.setViewportSize(size.viewport);
      const fields = await openTopicTrustWrite(page, operation);
      const otherDetails = fields.panel.locator('[data-action="housekeeping-drawer-toggle"][data-topic="thread_signals"]');
      await otherDetails.focus();
      await page.keyboard.press('Enter');
      const otherPool = topicTrustControl(fields.panel, topicTrustOperations[1], 'thread_signals');
      await expect(otherPool).not.toHaveAttribute('aria-disabled');
      await otherPool.focus();
      await page.keyboard.press('Space');
      await expect.poll(() => topicTrustCounts(page)).toEqual(operation.rpc === 'housekeeping.trust.write'
        ? { write: 2, dismiss: 0 } : { write: 1, dismiss: 1 });
      // Complete the newer, other-topic write first while the original stays held.
      await releaseTopicTrustWrite(page, 'housekeeping.trust.write', operation.rpc === 'housekeeping.trust.write' ? 1 : 0);
      await expect.poll(() => topicTrustValues(page, 'thread_signals')).toEqual({ run: 'manual', pool: 'free_only' });
      await expect(otherPool).toBeFocused();
      await releaseTopicTrustWrite(page, operation.rpc, 0);
      await expect(otherPool).toBeFocused();
      await expect.poll(() => topicTrustValues(page, 'thread_signals')).toEqual({ run: 'manual', pool: 'free_only' });
      await page.evaluate(() => window.__app.setHash('#data'));
      await expect(fields.panel).toHaveCount(0);
      await page.evaluate(() => window.__app.setHash('#settings/housekeeping'));
      await expect(otherDetails).toBeVisible();
      await otherDetails.focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => topicTrustValues(page, 'thread_signals')).toEqual({ run: 'manual', pool: 'free_only' });
      expect(fields.errors).toEqual([]);
    });
  }
}

const openHousekeepingTrustWrite = async (page: Page, control: string, query = '') => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fields = await openHousekeepingSchedule(page,
    `housekeeping_trust=tracked&hold_rpc=housekeeping.trust.write&${query}`);
  await fields.panel.getByRole('button', { name: 'Expand summary details', exact: true }).focus();
  await page.keyboard.press('Enter');
  const action = control === 'run-policy' ? 'housekeeping-trust-state-pick' : 'housekeeping-pool-policy-pick';
  const group = fields.panel.locator(control === 'run-policy'
    ? 'fieldset.housekeeping-producer-runpolicy[data-topic="summary"]'
    : 'fieldset[data-group="housekeeping-pool"][data-topic="summary"]');
  const option = (value: string) => group.locator(`[type="radio"][value="${value}"]`);
  const target = option(control === 'run-policy' ? 'manual' : 'free_only');
  const saved = option(control === 'run-policy' ? 'auto' : 'free_then_byok');
  const other = option(control === 'run-policy' ? 'off' : 'byok_only');
  await target.focus();
  await expect(target).toBeFocused();
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.trust.write'))).toBe(1);
  return { ...fields, action, group, option, target, saved, other, errors };
};
const releaseTrustWrite = async (page: Page) => {
  expect(await page.evaluate(() => {
    const count = window.__app.releaseRpcResponses?.('housekeeping.trust.write') ?? 0;
    return new Promise<number>((resolve) => setTimeout(() => resolve(count), 0));
  })).toBe(1);
};

for (const size of [
  { name: 'desktop', viewport: { width: 1280, height: 900 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
]) {
  for (const control of ['run-policy', 'model-pool']) {
    for (const outcome of ['success', 'failure']) {
      test(`Settings Housekeeping trust focus ${size.name} keeps ${control} focus through pending ${outcome}`, async ({ page, browserName }) => {
        await page.setViewportSize(size.viewport);
        const fields = await openHousekeepingTrustWrite(page, control,
          outcome === 'failure' ? 'housekeeping_trust_response=fail-first' : '');
        await expect(fields.target).toBeFocused();
        await expect(fields.target).toHaveAttribute('aria-disabled', 'true');
        await expect(fields.group).toHaveAttribute('aria-busy', 'true');
        expect(await fields.target.evaluate((element) => (element as HTMLInputElement).disabled)).toBe(false);
        // Both settings share the topic's write lock. Arrow keys and Space
        // must leave the saved choices intact and send no additional request.
        for (const key of ['Space', 'Enter', 'ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End']) {
          await page.keyboard.press(key);
          await expect(fields.target).toBeFocused();
        }
        await expect(fields.saved).toBeChecked();
        // Force a native pointer attempt: actionability correctly treats
        // aria-disabled inputs as unavailable, but the host must block it too.
        await fields.other.locator('..').click({ force: true });
        await expect(fields.saved).toBeChecked();
        const otherAction = control === 'run-policy' ? 'housekeeping-pool-policy-pick' : 'housekeeping-trust-state-pick';
        const otherValue = control === 'run-policy' ? 'byok_only' : 'off';
        const otherControl = fields.panel.locator(`[data-action="${otherAction}"][data-topic="summary"][value="${otherValue}"]`);
        await otherControl.locator('..').click({ force: true });
        await expect(otherControl).not.toBeChecked();
        await fields.target.focus();
        await refreshScheduleStatus(page);
        await expect(fields.target).toBeFocused();
        await expect(fields.group).toHaveAttribute('aria-busy', 'true');
        await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
        await expect(fields.target).not.toBeFocused();
        expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
        await fields.target.focus();
        expect(await page.evaluate(() => window.__app.rpcCallCount('housekeeping.trust.write'))).toBe(1);
        await releaseTrustWrite(page);
        await expect(fields.target).toBeFocused();
        await expect(fields.target).not.toHaveAttribute('aria-disabled');
        await expect(fields.group).not.toHaveAttribute('aria-busy');
        if (outcome === 'failure') {
          await expect(fields.target).not.toBeChecked();
          await expect(fields.saved).toBeChecked();
          await expect(fields.panel).toContainText('Run policy or model pool save unavailable.');
          await page.keyboard.press('Space');
          await expect(fields.target).toBeFocused();
          await expect(fields.group).toHaveAttribute('aria-busy', 'true');
          await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.trust.write'))).toBe(2);
          await releaseTrustWrite(page);
          await expect(fields.target).toBeFocused();
          await expect(fields.panel).not.toContainText('Run policy or model pool save unavailable.');
        }
        await expect(fields.target).toBeChecked();
        await page.evaluate(() => window.__app.setHash('#data'));
        await expect(fields.panel).toHaveCount(0);
        await page.evaluate(() => window.__app.setHash('#settings/housekeeping'));
        if (control === 'model-pool') await fields.panel.getByRole('button', { name: 'Expand summary details', exact: true }).click();
        await expect(fields.target).toBeChecked();
        expect(fields.errors).toEqual([]);
      });

      for (const owner of ['search', 'header']) {
        test(`Settings Housekeeping trust focus ${size.name} preserves ${owner} after ${control} ${outcome}`, async ({ page }) => {
          await page.setViewportSize(size.viewport);
          const fields = await openHousekeepingTrustWrite(page, control,
            outcome === 'failure' ? 'housekeeping_trust_response=fail-first' : '');
          const target = owner === 'search' ? fields.search
            : page.getByRole('button', { name: 'Run a Recipe', exact: true });
          await target.focus();
          if (owner === 'search') {
            await page.keyboard.type('summary');
            await page.keyboard.press('ArrowLeft');
            await page.keyboard.press('Shift+ArrowLeft');
          }
          await releaseTrustWrite(page);
          await expect(target).toBeFocused();
          if (owner === 'search') {
            await expect(target).toHaveValue('summary');
            expect(await target.evaluate((element) => {
              const input = element as HTMLInputElement;
              return [input.selectionStart, input.selectionEnd, input.selectionDirection];
            })).toEqual([5, 6, 'backward']);
          }
          expect(fields.errors).toEqual([]);
        });
      }
    }

    test(`Settings Housekeeping trust focus ${size.name} respects a newer dialog after ${control} completes`, async ({ page }) => {
      await page.setViewportSize(size.viewport);
      const fields = await openHousekeepingTrustWrite(page, control);
      const trigger = fields.panel.getByRole('button', { name: 'Run enrichment.summary now', exact: true });
      await trigger.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Run "Mail summary digest"?', exact: true });
      const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
      await expect(cancel).toBeFocused();
      await releaseTrustWrite(page);
      await expect(cancel).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(fields.errors).toEqual([]);
    });

    test(`Settings Housekeeping trust focus ${size.name} leaves native Contracts navigation alone during ${control}`, async ({ page }) => {
      await page.setViewportSize(size.viewport);
      const fields = await openHousekeepingTrustWrite(page, control);
      await fields.panel.getByRole('link', { name: 'Manage read access in Contracts →', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/#contracts$/);
      await expect(fields.panel).toHaveCount(0);
      const active = await page.evaluateHandle(() => document.activeElement);
      await releaseTrustWrite(page);
      await expect(page).toHaveURL(/#contracts$/);
      await expect(fields.panel).toHaveCount(0);
      expect(await page.evaluate((active) => document.activeElement === active, active)).toBe(true);
      expect(fields.errors).toEqual([]);
    });
  }

  for (const outcome of ['success', 'failure']) {
    for (const phase of ['waiting', 'preview', 'confirming', 'applied']) {
      test(`Settings Housekeeping Reset preview ${size.name} keeps the newer ${phase} after an old ${outcome}`, async ({ page }) => {
        await page.setViewportSize(size.viewport);
        const fields = await openHousekeepingResetPreview(page,
          outcome === 'failure' ? 'housekeeping_reset_fail_at=1' : '');
        if (phase === 'waiting') {
          await releaseResetPreview(page, 0);
          await expect(fields.dialog).toHaveAttribute('data-phase', 'previewing');
          await expect(fields.cancel).toBeFocused();
          await expect(fields.confirm).toHaveCount(0);
          expect(await page.evaluate(() => window.__app.rpcCallCount('housekeeping.topic.reset'))).toBe(2);
          await releaseResetPreview(page, 0);
          await expect(fields.dialog).toHaveAttribute('data-phase', 'preview');
          await expect(fields.toggle).toBeChecked();
          await expect(fields.cancel).toBeFocused();
        } else {
          await releaseResetPreview(page, 1);
          await expect(fields.toggle).toBeChecked();
          await fields.toggle.focus();
          await page.keyboard.press('Space');
          await expect(fields.dialog).toHaveAttribute('data-phase', 'previewing');
          await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.topic.reset'))).toBe(3);
          await releaseResetPreview(page, 1);
          await expect(fields.toggle).not.toBeChecked();
          if (phase === 'preview') {
            await fields.toggle.focus();
          } else {
            await fields.confirm.focus();
            await page.keyboard.press('Enter');
            await expect(fields.dialog).toHaveAttribute('data-phase', 'confirming');
            await expect(fields.dialog).toBeFocused();
            await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.topic.reset'))).toBe(4);
            if (phase === 'applied') {
              await releaseResetPreview(page, 1);
              await expect(fields.done).toBeFocused();
            }
          }
          await releaseResetPreview(page, 0);
          await expect(fields.dialog).toHaveAttribute('data-phase', phase);
          if (phase === 'preview') {
            await expect(fields.toggle).not.toBeChecked();
            await expect(fields.toggle).toBeFocused();
            await fields.confirm.focus();
            await page.keyboard.press('Enter');
          } else if (phase === 'confirming') {
            await expect(fields.dialog).toBeFocused();
            await expect(fields.dialog.getByRole('button', { name: 'Applying…', exact: true })).toBeDisabled();
            await page.keyboard.press('Escape');
            await expect(fields.dialog).toHaveAttribute('data-phase', 'confirming');
          }
          if (phase !== 'applied') await releaseResetPreview(page, 0);
          await expect(fields.dialog).toHaveAttribute('data-phase', 'applied');
          await expect(fields.done).toBeFocused();
          // The tracked fixture accepts only the token minted for this choice.
          await expect(fields.dialog.locator('.housekeeping-reset-applied dd').nth(2)).toHaveText('0');
          expect(await page.evaluate(() => window.__app.rpcCallCount('housekeeping.topic.reset'))).toBe(4);
          await page.keyboard.press('Enter');
          await expect(fields.dialog).toHaveCount(0);
          await expect(fields.trigger).toBeFocused();
        }
        expect(fields.errors).toEqual([]);
      });
    }
  }

  test(`Settings Housekeeping Reset preview ${size.name} keeps a current failure and retries with a fresh token`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openHousekeepingResetPreview(page, 'housekeeping_reset_fail_at=2');
    await releaseResetPreview(page, 1);
    const retry = fields.dialog.getByRole('button', { name: 'Retry', exact: true });
    await expect(fields.dialog).toHaveAttribute('data-phase', 'error');
    await expect(retry).toBeFocused();
    await releaseResetPreview(page, 0);
    await expect(fields.dialog).toHaveAttribute('data-phase', 'error');
    await expect(retry).toBeFocused();
    await expect(fields.confirm).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(fields.dialog).toHaveAttribute('data-phase', 'previewing');
    await expect(fields.cancel).toBeFocused();
    await releaseResetPreview(page, 0);
    await expect(fields.dialog).toHaveAttribute('data-phase', 'preview');
    await fields.confirm.focus();
    await page.keyboard.press('Enter');
    await releaseResetPreview(page, 0);
    await expect(fields.dialog).toHaveAttribute('data-phase', 'applied');
    await expect(fields.done).toBeFocused();
    expect(await page.evaluate(() => window.__app.rpcCallCount('housekeeping.topic.reset'))).toBe(4);
    expect(fields.errors).toEqual([]);
  });

  test(`Settings Housekeeping Reset preview ${size.name} ignores a reply for a different topic`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openHousekeepingResetPreview(page);
    await page.keyboard.press('Escape');
    await expect(fields.dialog).toHaveCount(0);
    await fields.panel.getByRole('button', { name: 'Collapse summary details', exact: true }).focus();
    await page.keyboard.press('Enter');
    await fields.panel.getByRole('button', { name: 'Expand thread_signals details', exact: true }).focus();
    await page.keyboard.press('Enter');
    await fields.trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Reset enrichment topic thread_signals', exact: true });
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    await expect(dialog).toHaveAttribute('data-phase', 'previewing');
    // Two closed summary previews remain ahead of the new topic's reply.
    await releaseResetPreview(page, 0);
    await releaseResetPreview(page, 0);
    await expect(dialog).toHaveAttribute('data-phase', 'previewing');
    await expect(cancel).toBeFocused();
    await releaseResetPreview(page, 0);
    await expect(dialog).toHaveAttribute('data-phase', 'preview');
    await expect(cancel).toBeFocused();
    expect(await page.evaluate(() => window.__app.rpcCallCount('housekeeping.topic.reset'))).toBe(3);
    expect(fields.errors).toEqual([]);
  });

  for (const outcome of ['success', 'failure']) {
    for (const owner of ['search', 'header']) {
      test(`Settings Housekeeping Run-now refresh ${size.name} preserves ${owner} focus after ${outcome}`, async ({ page }) => {
        await page.setViewportSize(size.viewport);
        const fields = await openHousekeepingRunNowRefresh(page,
          outcome === 'failure' ? 'housekeeping_status=fail-after-run' : '');
        const target = owner === 'search' ? fields.search
          : page.getByRole('button', { name: 'Run a Recipe', exact: true });
        await target.focus();
        if (owner === 'search') {
          await page.keyboard.type('summary');
          await page.keyboard.press('ArrowLeft');
          await page.keyboard.press('Shift+ArrowLeft');
        }
        await expect(target).toBeFocused();
        expect(await releaseHousekeepingStatus(page)).toBe(1);
        await expect(target).toBeFocused();
        await expect(fields.trigger).toBeVisible();
        if (owner === 'search') {
          await expect(target).toHaveValue('summary');
          expect(await target.evaluate((element) => {
            const input = element as HTMLInputElement;
            return [input.selectionStart, input.selectionEnd, input.selectionDirection];
          })).toEqual([5, 6, 'backward']);
          await page.keyboard.type('X');
          await expect(target).toHaveValue('summaXy');
        }
        expect(fields.errors).toEqual([]);
      });
    }
  }

  test(`Settings Housekeeping Run-now refresh ${size.name} preserves the drawer link and its native navigation`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openHousekeepingRunNowRefresh(page);
    await fields.panel.getByRole('button', { name: 'Expand summary details', exact: true }).focus();
    await page.keyboard.press('Enter');
    const link = fields.panel.getByRole('link', { name: 'Manage read access in Contracts →', exact: true });
    await link.focus();
    expect(await releaseHousekeepingStatus(page)).toBe(1);
    await expect(link).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#contracts$/);
    await expect(fields.panel).toHaveCount(0);
    expect(fields.errors).toEqual([]);
  });

  test(`Settings Housekeeping Run-now refresh ${size.name} respects a newer producer dialog`, async ({ page, browserName }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openHousekeepingRunNowRefresh(page);
    const trigger = fields.panel.getByRole('button', { name: 'Run enrichment.thread_signals now', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Run "Thread relationship signals"?', exact: true });
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    await expect(cancel).toBeFocused();
    expect(await releaseHousekeepingStatus(page)).toBe(1);
    await expect(cancel).toBeFocused();
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    await expect(dialog.getByRole('button', { name: 'Run now', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => window.__app.rpcCallCount('housekeeping.task.run_now'))).toBe(1);
    expect(fields.errors).toEqual([]);
  });

  test(`Settings Housekeeping Run-now refresh ${size.name} leaves a remounted panel's focus alone`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openHousekeepingRunNowRefresh(page);
    await page.evaluate(() => window.__app.setHash('#data'));
    await expect(fields.panel).toHaveCount(0);
    const before = await page.evaluate(() => window.__app.rpcCallCount('housekeeping.status.read'));
    await page.evaluate(() => window.__app.setHash('#settings/housekeeping'));
    await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('housekeeping.status.read'))).toBe(before + 2);
    // The old reply is first; release the new mount's initial reads separately.
    expect(await releaseHousekeepingStatus(page, 1)).toBe(1);
    expect(await releaseHousekeepingStatus(page, 1)).toBe(1);
    await expect(fields.trigger).toBeVisible();
    await fields.search.focus();
    await page.keyboard.type('summary');
    expect(await releaseHousekeepingStatus(page)).toBe(1);
    await expect(fields.search).toBeFocused();
    await expect(fields.search).toHaveValue('summary');
    expect(fields.errors).toEqual([]);
  });

  test(`Settings Housekeeping Run-now refresh ${size.name} ignores a reply superseded by a newer cycle`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openHousekeepingRunNowRefresh(page);
    await fields.search.focus();
    await page.keyboard.type('summary');
    await refreshScheduleStatus(page);
    // The original Run-now status read precedes the two cycle listeners.
    expect(await releaseHousekeepingStatus(page, 1)).toBe(1);
    expect(await releaseHousekeepingStatus(page, 1)).toBe(1);
    await expect(fields.search).toBeFocused();
    expect(await releaseHousekeepingStatus(page)).toBe(1);
    await expect(fields.search).toBeFocused();
    await expect(fields.search).toHaveValue('summary');
    expect(fields.errors).toEqual([]);
  });

  test(`Settings Housekeeping Run-now refresh ${size.name} retains the original return focus when the user stays there`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openHousekeepingRunNowRefresh(page);
    expect(await releaseHousekeepingStatus(page)).toBe(1);
    await expect(fields.trigger).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Run "Mail summary digest"?', exact: true });
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(fields.trigger).toBeFocused();
    expect(fields.errors).toEqual([]);
  });

  test(`Settings Housekeeping schedule focus ${size.name} follows the exact preset through keyboard picks`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openHousekeepingSchedule(page);
    for (const preset of ['light', 'balanced', 'aggressive', 'custom']) {
      const radio = fields.preset(preset);
      await radio.focus();
      await page.keyboard.press('Space');
      await expect(radio).toBeChecked();
      await expect(radio).toBeFocused();
      await refreshScheduleStatus(page);
      await expect(radio).toBeFocused();
    }
    await page.keyboard.press('ArrowLeft');
    await expect(fields.preset('aggressive')).toBeChecked();
    await expect(fields.preset('aggressive')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(fields.preset('custom')).toBeFocused();
    await expect(fields.preset('custom')).toBeChecked();
    await fields.preset('balanced').focus();
    await page.keyboard.press('Space');
    await fields.save.focus();
    await page.keyboard.press('Enter');
    await expect(fields.save).toBeFocused();
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), scheduleWriteRpc)).toBe(0);
  });

  test(`Settings Housekeeping schedule focus ${size.name} preserves unblurred number text and its native caret`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openHousekeepingSchedule(page);
    await fields.preset('custom').focus();
    await page.keyboard.press('Space');
    await fields.budget.fill('6500');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    const original = await fields.budget.elementHandle();
    await refreshScheduleStatus(page);
    await expect(fields.budget).toBeFocused();
    expect(await fields.budget.evaluate((element, original) => element === original, original)).toBe(true);
    await expect(fields.budget).toHaveValue('6500');
    await page.keyboard.type('9');
    await expect(fields.budget).toHaveValue('65900');
    await fields.interval.fill('');
    await refreshScheduleStatus(page);
    await expect(fields.interval).toHaveValue('');
    await expect(fields.interval).toBeFocused();
    await page.keyboard.type('-');
    await refreshScheduleStatus(page);
    await expect(fields.interval).toBeFocused();
    await page.keyboard.type('2');
    await expect(fields.interval).toHaveValue('-2');
    await fields.interval.fill('');
    await fields.save.focus();
    await page.keyboard.press('Enter');
    await expect(fields.schedule).toContainText('Enter a cycle budget and interval before saving.');
    await expect(fields.save).toBeFocused();
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), scheduleWriteRpc)).toBe(0);
  });

  test(`Settings Housekeeping schedule focus ${size.name} retains hour selects and allows Tab out of changed numbers`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openHousekeepingSchedule(page);
    await fields.preset('custom').focus();
    await page.keyboard.press('Space');
    for (const [control, value] of [[fields.start, '8'], [fields.end, '19']] as const) {
      await control.focus();
      await control.selectOption(value);
      await expect(control).toBeFocused();
      await refreshScheduleStatus(page);
      await expect(control).toBeFocused();
      await expect(control).toHaveValue(value);
    }
    await fields.budget.fill('72000');
    await page.keyboard.press('Tab');
    await expect(fields.interval).toBeFocused();
    await expect(fields.budget).toHaveValue('72000');
    await fields.interval.fill('31');
    await page.keyboard.press('Tab');
    await expect(fields.start).toBeFocused();
    await expect(fields.interval).toHaveValue('31');
  });

  test(`Settings Housekeeping schedule focus ${size.name} owns a busy Save and persists all custom fields`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openHousekeepingSchedule(page);
    await fillCustomSchedule(page, fields);
    await fields.save.focus();
    await page.keyboard.press('Enter');
    await expect(fields.save).toHaveText('Saving…');
    await expect(fields.save).toBeFocused();
    await expect(fields.save).toHaveAttribute('aria-disabled', 'true');
    await expect(fields.save).toHaveAttribute('aria-busy', 'true');
    await expect(fields.save).not.toHaveAttribute('disabled');
    await expect(fields.budget).toBeDisabled();
    await expect(fields.interval).toBeDisabled();
    await expect(fields.start).toBeDisabled();
    await expect(fields.end).toBeDisabled();
    await page.keyboard.press('Space');
    await fields.save.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await refreshScheduleStatus(page);
    await expect(fields.save).toBeFocused();
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), scheduleWriteRpc)).toBe(1);
    await releaseScheduleWrite(page);
    await expect(fields.save).toHaveText('Save');
    await expect(fields.save).toBeFocused();
    await expect(fields.save).not.toHaveAttribute('aria-busy');
    await expectSavedCustomSchedule(fields);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await fields.save.evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), scheduleWriteRpc)).toBe(1);
    await page.evaluate(() => window.__app.setHash('#data'));
    await expect(page).toHaveURL(/#data$/);
    await page.evaluate(() => window.__app.setHash('#settings/housekeeping'));
    await expectSavedCustomSchedule(fields);
  });

  test(`Settings Housekeeping schedule focus ${size.name} keeps a failed draft and accepts an explicit retry`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openHousekeepingSchedule(page, 'housekeeping_save=fail-first');
    await fillCustomSchedule(page, fields);
    await fields.save.focus();
    await page.keyboard.press('Enter');
    await expect(fields.save).toHaveText('Saving…');
    await releaseScheduleWrite(page);
    await expect(fields.schedule).toContainText('Schedule save unavailable.');
    await expect(fields.save).toBeFocused();
    await expect(fields.save).not.toHaveAttribute('aria-busy');
    await expect(fields.save).not.toHaveAttribute('aria-disabled');
    await expect(fields.budget).toHaveValue('065000');
    await expect(fields.interval).toHaveValue('27');
    await expect(fields.start).toHaveValue('8');
    await expect(fields.end).toHaveValue('19');
    await expect(fields.schedule).toContainText('Currently balanced');
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), scheduleWriteRpc)).toBe(1);
    await page.keyboard.press('Enter');
    await expect(fields.save).toHaveText('Saving…');
    await releaseScheduleWrite(page);
    await expectSavedCustomSchedule(fields);
    await expect(fields.save).toBeFocused();
    await expect(fields.schedule).not.toContainText('Schedule save unavailable.');
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), scheduleWriteRpc)).toBe(2);
  });

  for (const outcome of ['success', 'failure']) {
    test(`Settings Housekeeping drawer link ${size.name} preserves focus after ${outcome}`, async ({ page, browserName }) => {
      await page.setViewportSize(size.viewport);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const fields = await openHousekeepingSchedule(page, outcome === 'failure' ? 'housekeeping_save=fail-first' : '');
      const next = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
      const previous = browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab';
      await fields.panel.getByRole('button', { name: 'Expand summary details', exact: true }).click();
      const drawer = fields.panel.getByRole('region', { name: 'Detail drawer for summary', exact: true });
      const link = drawer.getByRole('link', { name: 'Manage read access in Contracts →', exact: true });
      const reset = drawer.getByRole('button', { name: 'Reset topic…', exact: true });
      await reset.focus();
      await page.keyboard.press(previous);
      await expect(link).toBeFocused();
      await refreshScheduleStatus(page);
      await expect(link).toBeFocused();

      await fields.preset('light').focus();
      await page.keyboard.press('Space');
      await fields.save.focus();
      await page.keyboard.press('Enter');
      await expect(fields.save).toHaveText('Saving…');
      await reset.focus();
      await page.keyboard.press(previous);
      await expect(link).toBeFocused();
      await refreshScheduleStatus(page);
      await expect(link).toBeFocused();
      await releaseScheduleWrite(page);
      await expect(fields.save).toHaveText('Save');
      await expect(link).toBeFocused();
      if (outcome === 'failure') await expect(fields.schedule).toContainText('Schedule save unavailable.');
      else await expect(fields.schedule).toContainText('Currently light');
      await page.keyboard.press(next);
      await expect(reset).toBeFocused();
      expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), scheduleWriteRpc)).toBe(1);
      expect(errors).toEqual([]);
    });

    test(`Settings Housekeeping drawer link ${size.name} respects Contracts navigation during ${outcome}`, async ({ page }) => {
      await page.setViewportSize(size.viewport);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const fields = await openHousekeepingSchedule(page, outcome === 'failure' ? 'housekeeping_save=fail-first' : '');
      await fields.preset('light').focus();
      await page.keyboard.press('Space');
      await fields.save.focus();
      await page.keyboard.press('Enter');
      await expect(fields.save).toHaveText('Saving…');
      await fields.panel.getByRole('button', { name: 'Expand summary details', exact: true }).click();
      const link = fields.panel.getByRole('link', { name: 'Manage read access in Contracts →', exact: true });
      await expect(link).toHaveAttribute('href', '#contracts');
      await link.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/#contracts$/);
      const contracts = page.locator('[data-recued-contracts-route]');
      await expect(contracts).toBeVisible();
      const outside = page.getByRole('button', { name: 'Run a Recipe', exact: true });
      await outside.focus();
      await releaseScheduleWrite(page);
      await expect(contracts).toBeVisible();
      await expect(page).toHaveURL(/#contracts$/);
      await expect(outside).toBeFocused();
      await page.evaluate(() => window.__app.setHash('#settings/housekeeping'));
      await expect(fields.schedule).toContainText(outcome === 'failure' ? 'Currently balanced' : 'Currently light');
      expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), scheduleWriteRpc)).toBe(1);
      expect(errors).toEqual([]);
    });

    for (const owner of ['search', 'outside']) {
      test(`Settings Housekeeping schedule focus ${size.name} preserves ${owner} ownership after ${outcome}`, async ({ page }) => {
        await page.setViewportSize(size.viewport);
        const fields = await openHousekeepingSchedule(page, outcome === 'failure' ? 'housekeeping_save=fail-first' : '');
        await fillCustomSchedule(page, fields);
        await fields.save.focus();
        await page.keyboard.press('Enter');
        await expect(fields.save).toHaveText('Saving…');
        const target = owner === 'search' ? fields.search : page.getByRole('button', { name: 'Run a Recipe', exact: true });
        if (owner === 'search') {
          await fields.search.fill('summary');
          await fields.search.evaluate((input: HTMLInputElement) => input.setSelectionRange(2, 4, 'backward'));
        } else await target.focus();
        await refreshScheduleStatus(page);
        await expect(target).toBeFocused();
        await releaseScheduleWrite(page);
        await expect(fields.save).toHaveText('Save');
        await expect(target).toBeFocused();
        if (owner === 'search') {
          await expect(fields.search).toHaveValue('summary');
          expect(await fields.search.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection])).toEqual([2, 4, 'backward']);
        }
        if (outcome === 'failure') await expect(fields.schedule).toContainText('Schedule save unavailable.');
        else await expectSavedCustomSchedule(fields);
        expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), scheduleWriteRpc)).toBe(1);
      });
    }
  }

  test(`Settings Housekeeping schedule focus ${size.name} respects an open Run-now dialog when Save completes`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openHousekeepingSchedule(page);
    await fields.preset('light').focus();
    await page.keyboard.press('Space');
    await fields.save.focus();
    await page.keyboard.press('Enter');
    await expect(fields.save).toHaveText('Saving…');
    const trigger = page.getByRole('button', { name: 'Run enrichment.summary now', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Run "Mail summary digest"?' });
    const cancel = dialog.getByRole('button', { name: 'Cancel' });
    await expect(cancel).toBeFocused();
    await releaseScheduleWrite(page);
    await expect(fields.schedule).toContainText('Currently light');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
}

for (const size of [
  { name: 'desktop', viewport: { width: 1280, height: 900 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
]) {
  for (const outcome of ['success', 'failure']) {
    test(`Settings Housekeeping prompt bias ${size.name} keeps open state and focus after ${outcome}`, async ({ page, browserName }) => {
      await page.setViewportSize(size.viewport);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const fields = await openHousekeepingBiasHints(page, outcome === 'failure' ? 'housekeeping_save=fail-first' : '');
      const next = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
      const previous = browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab';
      await fields.summary.focus();
      await page.keyboard.press('Enter');
      await expect(fields.disclosure).toHaveAttribute('open');
      await refreshScheduleStatus(page);
      await expect(fields.disclosure).toHaveAttribute('open');
      await expect(fields.summary).toBeFocused();
      const pool = fields.drawer.locator('input[type="radio"]:checked');
      await page.keyboard.press(next);
      await expect(pool).toBeFocused();
      await page.keyboard.press(previous);
      await expect(fields.summary).toBeFocused();

      await fields.preset('light').focus();
      await page.keyboard.press('Space');
      await expect(fields.disclosure).toHaveAttribute('open');
      await expect(fields.preset('light')).toBeFocused();
      await fields.save.focus();
      await page.keyboard.press('Enter');
      await expect(fields.save).toHaveText('Saving…');
      await expect(fields.disclosure).toHaveAttribute('open');
      await expect(fields.save).toBeFocused();
      await fields.summary.focus();
      await refreshScheduleStatus(page);
      await expect(fields.disclosure).toHaveAttribute('open');
      await expect(fields.summary).toBeFocused();
      await releaseScheduleWrite(page);
      await expect(fields.save).toHaveText('Save');
      await expect(fields.disclosure).toHaveAttribute('open');
      await expect(fields.summary).toBeFocused();
      if (outcome === 'failure') await expect(fields.schedule).toContainText('Schedule save unavailable.');
      else await expect(fields.schedule).toContainText('Currently light');
      await page.keyboard.press('Space');
      await expect(fields.disclosure).not.toHaveAttribute('open');
      await refreshScheduleStatus(page);
      await expect(fields.disclosure).not.toHaveAttribute('open');
      await expect(fields.summary).toBeFocused();
      expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), scheduleWriteRpc)).toBe(1);
      expect(errors).toEqual([]);
    });

    for (const owner of ['read-access', 'outside']) {
      test(`Settings Housekeeping prompt bias ${size.name} preserves ${owner} focus after ${outcome}`, async ({ page }) => {
        await page.setViewportSize(size.viewport);
        const fields = await openHousekeepingBiasHints(page, outcome === 'failure' ? 'housekeeping_save=fail-first' : '');
        await fields.preset('light').focus();
        await page.keyboard.press('Space');
        await fields.summary.focus();
        await page.keyboard.press('Enter');
        await fields.save.focus();
        await page.keyboard.press('Enter');
        await expect(fields.save).toHaveText('Saving…');
        await expect(fields.disclosure).toHaveAttribute('open');
        const target = owner === 'read-access'
          ? fields.drawer.getByRole('link', { name: 'Manage read access in Contracts →', exact: true })
          : page.getByRole('button', { name: 'Run a Recipe', exact: true });
        await target.focus();
        await refreshScheduleStatus(page);
        await expect(fields.disclosure).toHaveAttribute('open');
        await expect(target).toBeFocused();
        await releaseScheduleWrite(page);
        await expect(fields.save).toHaveText('Save');
        await expect(fields.disclosure).toHaveAttribute('open');
        await expect(target).toBeFocused();
        if (outcome === 'failure') await expect(fields.schedule).toContainText('Schedule save unavailable.');
        else await expect(fields.schedule).toContainText('Currently light');
        await fields.summary.focus();
        await page.keyboard.press('Space');
        await target.focus();
        await refreshScheduleStatus(page);
        await expect(fields.disclosure).not.toHaveAttribute('open');
        await expect(target).toBeFocused();
        expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), scheduleWriteRpc)).toBe(1);
      });
    }
  }

  test(`Settings Housekeeping prompt bias ${size.name} remembers each topic through collapse and filtering`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openHousekeepingBiasHints(page);
    await fields.summary.focus();
    await page.keyboard.press('Enter');
    await fields.panel.getByRole('button', { name: 'Collapse summary details', exact: true }).click();
    await fields.panel.getByRole('button', { name: 'Expand thread_signals details', exact: true }).click();
    const thread = fields.panel.getByRole('region', { name: 'Detail drawer for thread_signals', exact: true });
    const threadDisclosure = thread.locator('details.housekeeping-drawer-coverage-bias');
    await expect(threadDisclosure).not.toHaveAttribute('open');
    await threadDisclosure.locator('summary').focus();
    await page.keyboard.press('Enter');
    await fields.panel.getByRole('button', { name: 'Collapse thread_signals details', exact: true }).click();
    await fields.panel.getByRole('button', { name: 'Expand summary details', exact: true }).click();
    await expect(fields.disclosure).toHaveAttribute('open');
    await fields.summary.focus();
    await page.keyboard.press('Space');
    await fields.panel.getByRole('button', { name: 'Collapse summary details', exact: true }).click();
    await fields.panel.getByRole('button', { name: 'Expand thread_signals details', exact: true }).click();
    await expect(threadDisclosure).toHaveAttribute('open');
    await fields.panel.getByRole('button', { name: 'Collapse thread_signals details', exact: true }).click();
    await fields.panel.getByRole('button', { name: 'Expand summary details', exact: true }).click();
    await expect(fields.disclosure).not.toHaveAttribute('open');
    await fields.summary.focus();
    await page.keyboard.press('Enter');
    await fields.search.fill('thread');
    await expect(fields.drawer).toHaveCount(0);
    await fields.search.fill('');
    await expect(fields.disclosure).toHaveAttribute('open');
    await expect(fields.search).toBeFocused();
    await page.evaluate(() => window.__app.setHash('#data'));
    await expect(fields.panel).toHaveCount(0);
    await page.evaluate(() => window.__app.setHash('#settings/housekeeping'));
    await fields.panel.getByRole('button', { name: 'Expand summary details', exact: true }).click();
    await expect(fields.disclosure).not.toHaveAttribute('open');
  });

  for (const modal of ['run-now', 'reset']) {
    test(`Settings Housekeeping prompt bias ${size.name} respects the ${modal} dialog during Save completion`, async ({ page }) => {
      await page.setViewportSize(size.viewport);
      const fields = await openHousekeepingBiasHints(page);
      await fields.summary.focus();
      await page.keyboard.press('Enter');
      await fields.preset('light').focus();
      await page.keyboard.press('Space');
      await fields.save.focus();
      await page.keyboard.press('Enter');
      await expect(fields.save).toHaveText('Saving…');
      const trigger = modal === 'run-now'
        ? fields.panel.getByRole('button', { name: 'Run enrichment.summary now', exact: true })
        : fields.drawer.getByRole('button', { name: 'Reset topic…', exact: true });
      await trigger.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: modal === 'run-now' ? 'Run "Mail summary digest"?' : 'Reset enrichment topic summary', exact: true });
      const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
      await expect(cancel).toBeFocused();
      await refreshScheduleStatus(page);
      await expect(fields.disclosure).toHaveAttribute('open');
      await expect(cancel).toBeFocused();
      await releaseScheduleWrite(page);
      await expect(fields.schedule).toContainText('Currently light');
      await expect(fields.disclosure).toHaveAttribute('open');
      await expect(cancel).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(fields.disclosure).toHaveAttribute('open');
    });
  }
}
