import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChatDeliverySnapshot } from '@recued/contracts';
import type { createQueueFixture as CreateQueueFixture } from './harness/chat-queue-backend.js';

test('delivery history reaches old sent/skipped messages and jumps to the exact message without losing a draft', async ({ page }) => {
  const target = resolve('node_modules/.cache/d265-e2e/history-backend.mjs');
  await mkdir(resolve(target, '..'), { recursive: true });
  await build({ entryPoints: [new URL('./harness/chat-queue-backend.ts', import.meta.url).pathname], outfile: target,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', resolveExtensions: ['.ts', '.js', '.json'], logLevel: 'silent' });
  const { createQueueFixture } = await import(pathToFileURL(target).href) as { createQueueFixture: typeof CreateQueueFixture };
  const fixture = createQueueFixture({ emit: () => {} }, true);
  let staleLookup = false; let staleUsed = false;
  const lookups: unknown[] = [];
  try {
    await fixture.seedDeliveryHistory(125);
    await page.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON();
      try {
        let result = await fixture.rpc(method, args);
        if (method === 'chat.session.get') lookups.push(args);
        if (method === 'chat.deliveries.list' && args.view === 'messages' && staleLookup) {
          const reply = result as ChatDeliverySnapshot;
          result = { ...reply, revision: 0, deliveries: reply.deliveries.map(item => ({ ...item, state: 'failed', error: 'auth' })) };
          staleUsed = true; staleLookup = false;
        }
        await route.fulfill({ json: { result } });
      } catch (error) { await route.fulfill({ json: { error: String(error) } }); }
    });
    await page.goto('/chat-queue-harness.html');
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('[data-chat-message-delivery="history-0"]')).toHaveCount(0);
    const input = page.locator('[data-recued-chat-route-input]'); await input.fill('Keep my draft while browsing delivery history');
    await page.getByRole('button', { name: 'Delivery history', exact: true }).click();
    const history = page.locator('[data-delivery-history]');
    await expect(history).toContainText('page 1 · newest first');
    await expect(history.locator('[data-delivery-id]')).toHaveCount(25);
    for (let i = 2; i <= 5; i++) {
      await history.getByRole('button', { name: 'Older deliveries' }).click();
      await expect(history).toContainText(`page ${i} · newest first`);
    }
    await expect(history.getByRole('button', { name: 'Older deliveries' })).toHaveCount(0);
    await expect(history.locator('[data-delivery-state="skipped"]')).toContainText('Retained answer 1');
    await history.getByRole('button', { name: 'Assistant: Retained answer 0', exact: true }).click();
    const message = page.locator('[data-chat-message-delivery="history-0"]');
    await expect(message.locator('summary')).toHaveText('Messenger · Delivered');
    await expect(page.locator('[data-recued-chat-route-message="history-0"]')).toHaveAttribute('data-recued-chat-route-return-target', '');
    expect(lookups).toContainEqual(expect.objectContaining({ session_id: 's', around_message_id: 'history-0' }));
    await expect(input).toHaveValue('Keep my draft while browsing delivery history');
    // The focused message sits outside the recent overview. An older lookup
    // cannot replace the newer receipt already displayed beside that message.
    staleLookup = true;
    await page.evaluate(() => (window as unknown as { queueTestEvent(e: unknown): void }).queueTestEvent({
      kind: 'chat.session_changed', session_id: 's', field: 'delivery', value: true, cursor: Date.now(),
    }));
    await expect.poll(() => staleUsed).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(message.locator('summary')).toHaveText('Messenger · Delivered');
    await history.getByRole('button', { name: 'Newer deliveries' }).click();
    await expect(history).toContainText('page 4 · newest first');
    await history.getByRole('button', { name: 'Latest deliveries' }).click();
    await expect(history).toContainText('page 1 · newest first');
    await page.reload();
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('[data-delivery-history]')).toHaveCount(0);
    expect(fixture.deliveryCount()).toBe(0);
  } finally { fixture.release(); fixture.close(); await rm(target, { force: true }); }
});
