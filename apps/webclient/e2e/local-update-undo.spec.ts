import { expect, test } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { CONTINUATION_PARENT } from './harness/preapproval-continuation.js';

installFullAppHooks();
for (const width of [280, 1280]) {
  for (const surface of ['chat', 'approvals', 'runs'] as const) {
    test(`${surface} reviews undo and requires a separate keyboard approval at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const address = surface === 'chat' ? '?chat=session&local_mutation_receipt=1#chat/session/chat_1'
        : surface === 'approvals' ? `?preapproval=continuation&local_receipt=1#approvals/preapproval/${CONTINUATION_PARENT}`
          : '?journey=verification&local_mutation_receipt=1#logs/run-verify';
      await page.goto(HARNESS_URL + address); await page.waitForFunction(() => window.__app?.ready === true);
      const host = page.locator('[data-local-update-undo]').first();
      await host.getByRole('button', { name: 'Review undo', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(host.locator('[data-local-update-undo-preview]')).toContainText(surface === 'chat' ? 'Original meeting' : 'First row');
      await expect(host.getByRole('heading', { name: 'Review reverse changes' })).toBeFocused();
      if (surface === 'runs') {
        const listCalls = await page.evaluate(() => window.__app.rpcCallCount('execution.list'));
        await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: {
          kind: 'session_lifecycle', session_id: 'session-verification',
          state: 'closed', prev_state: 'active', cursor: 210,
        } }));
        await page.waitForFunction(count => window.__app.rpcCallCount('execution.list') > count, listCalls);
        await expect(page.locator('[data-recued-logs-route]')).toHaveAttribute('data-recued-logs-history-loading', 'false');
        await expect(host.locator('[data-local-update-undo-preview]')).toContainText('First row');
        await expect(host.getByRole('heading', { name: 'Review reverse changes' })).toBeFocused();
      }
      expect(await page.evaluate(() => window.__app.rpcCallCount('local_undo.decide'))).toBe(0);
      await host.getByRole('button', { name: 'Approve undo', exact: true }).focus(); await page.keyboard.press('Enter');
      await expect(host).toContainText('Undo confirmed. Original receipt: lmr_77777777');
      await expect(host).toContainText('Undo receipt: lmr_99999999');
      await expect(host.getByRole('status')).toBeFocused();
      expect(await page.evaluate(() => window.__app.rpcCallCount('local_undo.decide'))).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
  test(`runs reviews undo without leaving while its decision is pending at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(HARNESS_URL + '?journey=verification&local_mutation_receipt=1#logs/run-verify');
    await page.waitForFunction(() => window.__app?.ready === true);
    const host = page.locator('[data-local-update-undo]').first();
    const review = host.getByRole('button', { name: 'Review undo', exact: true });
    await expect(review).toBeVisible();
    const appearance = await review.evaluate(node => ({
      height: node.getBoundingClientRect().height,
      background: getComputedStyle(node).backgroundColor,
      surface: getComputedStyle(node.closest('[data-recued-logs-detail]')!).backgroundColor,
      color: getComputedStyle(node).color,
    }));
    expect(appearance.height).toBeGreaterThanOrEqual(44);
    expect(appearance.background).toBe(appearance.surface);
    await review.focus(); await page.keyboard.press('Enter');
    await expect(host.locator('[data-local-update-undo-preview]')).toBeVisible();
    await page.evaluate(() => {
      window.__app.holdRpcResponses?.('local_undo.decide');
      document.documentElement.setAttribute('data-undo-leave-prompts', '0');
      window.confirm = message => {
        document.documentElement.setAttribute('data-undo-leave-message', message ?? '');
        const count = Number(document.documentElement.getAttribute('data-undo-leave-prompts'));
        document.documentElement.setAttribute('data-undo-leave-prompts', String(count + 1));
        return false;
      };
    });
    await host.getByRole('button', { name: 'Approve undo', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(host.getByRole('status')).toHaveText('Applying the reviewed undo…');
    await page.getByRole('link', { name: 'Back to history' }).click();
    await expect(page).toHaveURL(/#logs\/run-verify$/);
    await expect(page.locator('html')).toHaveAttribute('data-undo-leave-message', 'An undo action is still in progress. Leave Logs anyway?');
    await expect(host.locator('[data-local-update-undo-preview]')).toBeVisible();
    await page.evaluate(() => window.__app.setHash('#recipes'));
    await expect(page).toHaveURL(/#logs\/run-verify$/);
    await expect(page.locator('html')).toHaveAttribute('data-undo-leave-prompts', '2');
    expect(await page.evaluate(() => window.__app.rpcCallCount('local_undo.decide'))).toBe(1);
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('local_undo.decide'))).toBe(1);
    await expect(host.getByRole('status')).toContainText('Undo confirmed.');
    await page.getByRole('link', { name: 'Back to history' }).click();
    await expect(page).toHaveURL(/#logs$/);
  });
  test(`declining undo preserves the original action at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(HARNESS_URL + '?chat=session&local_mutation_receipt=1#chat/session/chat_1');
    const host = page.locator('[data-local-update-undo]').first();
    await host.getByRole('button', { name: 'Review undo', exact: true }).click();
    await host.getByRole('button', { name: 'Decline undo', exact: true }).click();
    await expect(host).toContainText('Undo declined. The original change remains.');
    const attempts = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-local-update-undo') ?? '[]'));
    expect(attempts).toHaveLength(1); expect(attempts[0].decision).toBe('deny');
  });
  test(`a lost undo response checks its receipt without another decision at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(HARNESS_URL + '?chat=session&local_mutation_receipt=1&undo=lost#chat/session/chat_1');
    const host = page.locator('[data-local-update-undo]').first();
    await host.getByRole('button', { name: 'Review undo', exact: true }).click();
    await host.getByRole('button', { name: 'Approve undo', exact: true }).click();
    await expect(host).toContainText('Undo response was lost.');
    await host.getByRole('button', { name: 'Check undo result' }).click();
    await expect(host).toContainText('Undo confirmed.');
    const attempts = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-test-local-update-undo') ?? '[]'));
    expect(attempts).toHaveLength(1);
  });
  test(`a completed undo survives reload after a lost response at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(HARNESS_URL + '?chat=session&local_mutation_receipt=1&undo=lost#chat/session/chat_1');
    const host = page.locator('[data-local-update-undo]').first();
    await host.getByRole('button', { name: 'Review undo', exact: true }).click();
    await host.getByRole('button', { name: 'Approve undo', exact: true }).click();
    await expect(host).toContainText('Undo response was lost.');
    await page.reload();
    await host.getByRole('button', { name: 'Review undo', exact: true }).click();
    await expect(host).toContainText('Undo receipt: lmr_99999999');
    await expect(host.locator('[data-local-update-undo-preview]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__app.rpcCallCount('local_undo.review'))).toBe(0);
    expect(await page.evaluate(() => window.__app.rpcCallCount('local_undo.decide'))).toBe(0);
  });
  test(`an undelivered decision requires a new review at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(HARNESS_URL + '?chat=session&local_mutation_receipt=1&undo=not_received#chat/session/chat_1');
    const host = page.locator('[data-local-update-undo]').first();
    await host.getByRole('button', { name: 'Review undo', exact: true }).click();
    await host.getByRole('button', { name: 'Approve undo', exact: true }).click();
    await expect(host).toContainText('Undo request was not delivered.');
    await host.getByRole('button', { name: 'Check undo result' }).click();
    await expect(host).toContainText('No undo decision has been recorded.');
    expect(await page.evaluate(() => window.__app.rpcCallCount('local_undo.decide'))).toBe(1);
    await host.getByRole('button', { name: 'Review undo', exact: true }).click();
    await expect(host.getByRole('button', { name: 'Approve undo', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__app.rpcCallCount('local_undo.decide'))).toBe(1);
  });
  test(`a version conflict explains why the undo stopped at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(HARNESS_URL + '?chat=session&local_mutation_receipt=1&undo=conflict#chat/session/chat_1');
    const host = page.locator('[data-local-update-undo]').first();
    await host.getByRole('button', { name: 'Review undo', exact: true }).click();
    await host.getByRole('button', { name: 'Approve undo', exact: true }).click();
    await expect(host).toContainText('The record changed after review. No undo was applied.');
    await expect(host).not.toContainText('Undo confirmed.');
  });
}
