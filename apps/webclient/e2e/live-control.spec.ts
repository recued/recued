import { expect, test } from '@playwright/test';
import {
  HARNESS_URL, LIVE_CONTROL_RUN_CONTROL, LIVE_CONTROL_TOGGLE, installFullAppHooks,
} from './helpers/full-app.js';

/** Live control browser journeys against the deterministic full-app harness. */
const LIVE_CONTROL_PANEL = 'data-recued-live-control-panel';
const LIVE_CONTROL_CLOSE = 'data-recued-live-control-close';

installFullAppHooks();

test('live control moves focus into its panel and back to its trigger', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?live=running`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const toggle = page.locator(`[${LIVE_CONTROL_TOGGLE}]`);
  await expect(toggle).toBeVisible();
  await toggle.focus();
  await page.keyboard.press('Enter');

  const panel = page.locator(`[${LIVE_CONTROL_PANEL}]`);
  const close = page.locator(`[${LIVE_CONTROL_CLOSE}]`);
  await expect(panel).toBeVisible();
  await expect(close).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(panel).toHaveCount(0);
  await expect(toggle).toBeFocused();
});

test('live control stays on-screen with usable actions at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(`${HARNESS_URL}?live=running`);
  await page.waitForFunction(() => window.__app?.ready === true);

  await page.locator(`[${LIVE_CONTROL_TOGGLE}]`).click();
  const panel = page.locator(`[${LIVE_CONTROL_PANEL}]`);
  await expect(panel).toBeVisible();
  const geometry = await panel.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 0.5);

  const actionSizes = await page.locator(
    `[data-recued-live-control-bubble] button:visible`,
  ).evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  expect(actionSizes).toHaveLength(4);
  expect(Math.min(...actionSizes.map(({ width }) => width)))
    .toBeGreaterThanOrEqual(36);
  expect(Math.min(...actionSizes.map(({ height }) => height)))
    .toBeGreaterThanOrEqual(36);
});

test('live control gives repeated actions exact accessible owners', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?live=running&logs_passes=active`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator(`[${LIVE_CONTROL_TOGGLE}]`).click();

  const names = [
    'Kill daily-brief · summarize (run-live-control-1)',
    'Kill weekly-review · collect (run-live-control-2)',
    'Revoke Send reviewed mail (pass-live-control-1)',
    'Revoke Update reviewed contact (pass-live-control-2)',
  ];
  for (const name of names) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
  }
});

test('live control preserves exact action focus through a running refresh', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?live=running`);
  await page.waitForFunction(() => window.__app?.ready === true);

  await page.locator(`[${LIVE_CONTROL_TOGGLE}]`).click();
  const kill = page.locator(
    `[${LIVE_CONTROL_RUN_CONTROL}="kill"][data-id="run-live-control-1"]`,
  );
  await expect(kill).toBeVisible();
  await kill.focus();
  const activeCalls = await page.evaluate(
    () => window.__app.rpcCallCount('execution.active'),
  );

  await page.evaluate(() => {
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'execution',
        recipe_id: 'daily-brief',
        run_id: 'run-live-control-1',
        op: 'start',
        cursor: 31,
      },
    });
  });
  await page.waitForFunction(
    (before) => window.__app.rpcCallCount('execution.active') > before,
    activeCalls,
  );

  await expect(kill).toBeFocused();
});

test('live control advances focus after a running action retires', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?live=running&logs_control_response=slow`);
  await page.waitForFunction(() => window.__app?.ready === true);

  await page.locator(`[${LIVE_CONTROL_TOGGLE}]`).click();
  const firstKill = page.locator(
    `[${LIVE_CONTROL_RUN_CONTROL}="kill"][data-id="run-live-control-1"]`,
  );
  const nextKill = page.locator(
    `[${LIVE_CONTROL_RUN_CONTROL}="kill"][data-id="run-live-control-2"]`,
  );
  await expect(firstKill).toBeVisible();
  await expect(nextKill).toBeVisible();
  await firstKill.focus();
  await page.keyboard.press('Enter');

  await expect(firstKill).toHaveText('Killing…');
  await expect(firstKill).toHaveAccessibleName(
    'Killing… daily-brief · summarize (run-live-control-1)',
  );
  await expect(firstKill).toHaveAttribute('aria-disabled', 'true');
  await expect(firstKill).toHaveAttribute('aria-busy', 'true');
  await expect(firstKill).not.toHaveAttribute('disabled');
  await expect(firstKill).toBeFocused();
  await firstKill.dispatchEvent('click');
  await firstKill.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('execution.kill'),
    ),
  ).toBe(1);
  await expect(firstKill).toHaveCount(0);
  await expect(nextKill).toBeFocused();
});
