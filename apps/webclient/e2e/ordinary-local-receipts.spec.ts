import { expect, test } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
for (const width of [280, 1280]) {
  test(`Chat retains a confirmed local change through stale events and reload at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${HARNESS_URL}?chat=session&local_mutation_receipt=1#chat/session/chat_1`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const card = page.locator('[data-recued-chat-route-plan-card][data-plan-id="plan_local_confirmed"]');
    await expect(card.locator('[data-local-mutation-receipt]')).toContainText('Change confirmed');
    await expect(card).toContainText('Calendar saved this change');
    await expect(card).toContainText("The caller's result was not confirmed");
    await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: {
      kind: 'chat.tool_call_completed', session_id: 'chat_1', turn_id: 'execution_local', tool_name: 'calendar.update',
      plan_id: 'plan_local_confirmed', tier: 1, status: 'error', reason: 'execution_error', cursor: 100,
    } }));
    await expect(card.locator('[data-local-mutation-receipt]')).toContainText('Change confirmed');
    await expect(card.locator('[data-recued-chat-route-plan-retry]')).toHaveCount(0);
    await expect(card.locator('[data-recued-chat-route-plan-approve]')).toHaveCount(0);
    await expect(card.locator('[data-recued-chat-route-plan-continue]')).toHaveCount(0);
    await page.reload();
    await expect(card.locator('[data-local-mutation-receipt]')).toContainText('Change confirmed');
    expect(await page.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0);
    expect(await page.evaluate(() => window.__app.rpcCallCount('chat.plan.approve'))).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`Chat receives a live confirmation despite a caller failure at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${HARNESS_URL}?chat=session&local_mutation_receipt=live#chat/session/chat_1`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const card = page.locator('[data-recued-chat-route-plan-card][data-plan-id="plan_local_confirmed"]');
    await expect(card).toContainText('Somebody needs to check what happened');
    await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: {
      kind: 'chat.tool_call_completed', session_id: 'chat_1', turn_id: 'execution_local', tool_name: 'calendar.update',
      plan_id: 'plan_local_confirmed', tier: 1, status: 'error', reason: 'execution_error', cursor: 100,
      plan_execution: { status: 'completed', turn_id: 'execution_local', result_ref: 'local-mutation:lmr_77777777-7777-4777-8777-777777777777',
        recovered_from: 'failed', local_receipt: { receipt_id: 'lmr_77777777-7777-4777-8777-777777777777',
          kind: 'local_calendar', committed_at: 1_700_000_000_000 } },
    } }));
    await expect(card.locator('[data-local-mutation-receipt]')).toContainText('Change confirmed');
    await expect(card).toContainText('The caller reported a failure after this change committed');
    await expect(card.locator('[data-recued-chat-route-plan-retry]')).toHaveCount(0);
    await expect(card.locator('[data-recued-chat-route-plan-approve]')).toHaveCount(0);
    await expect(card.locator('[data-recued-chat-route-plan-continue]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
