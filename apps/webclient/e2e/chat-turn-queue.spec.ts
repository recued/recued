import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createQueueFixture as CreateQueueFixture } from './harness/chat-queue-backend.js';

test('both clients recover a blocked attachment and a lost file receipt without reposting its text', async ({ browser }) => {
  const target = resolve('node_modules/.cache/d265-e2e/attachment-backend.mjs');
  await mkdir(resolve(target, '..'), { recursive: true });
  await build({ entryPoints: [new URL('./harness/chat-queue-backend.ts', import.meta.url).pathname], outfile: target,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', resolveExtensions: ['.ts', '.js', '.json'], logLevel: 'silent' });
  const { createQueueFixture } = await import(pathToFileURL(target).href) as { createQueueFixture: typeof CreateQueueFixture };
  const pages: Page[] = [];
  const fixture = createQueueFixture({ emit: event => {
    for (const page of pages) void page.evaluate(event => {
      (window as unknown as { queueTestEvent(e: unknown): void }).queueTestEvent?.(event);
    }, { ...event, cursor: Date.now() }).catch(() => {});
  } }, true, true);
  const contexts = [await browser.newContext(), await browser.newContext()];
  let rejectFirstRetry = true;
  const retrySubmissions: Array<{ submission_id: string; accept_unknown?: boolean }> = [];
  try {
    for (const context of contexts) {
      await context.route('**/d265-rpc', async route => {
        const { method, args } = route.request().postDataJSON();
        try {
          if (method === 'chat.delivery.retry') {
            retrySubmissions.push(args);
            if (rejectFirstRetry) { rejectFirstRetry = false; throw new Error('Request interrupted before submission'); }
          }
          await route.fulfill({ json: { result: await fixture.rpc(method, args) } });
        }
        catch (error) { await route.fulfill({ json: { error: String(error) } }); }
      });
      const page = await context.newPage(); pages.push(page);
      await page.goto('/chat-queue-harness.html');
      await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    }
    await fixture.addBlockedAttachment();
    for (const page of pages) {
      await page.reload();
      await expect(page.locator('[data-chat-delivery]')).toContainText('the file is being checked, or was flagged');
      await page.locator('[data-chat-message-delivery="file-message"] summary').click();
      await expect(page.locator('[data-chat-message-delivery="file-message"]')).toContainText('Attachment.pdf · Delivery failed');
    }
    expect(fixture.deliveryCount()).toBe(0); expect(fixture.uploads).toEqual([]);
    fixture.allowAttachment();
    await pages[0]!.locator('[data-chat-message-delivery="file-message"]').getByRole('button', { name: 'Retry delivery', exact: true }).click();
    await expect(pages[0]!.locator('[data-chat-message-delivery="file-message"]')).toContainText(/could not confirm/i);
    await pages[0]!.locator('[data-chat-message-delivery="file-message"]').getByRole('button', { name: 'Retry delivery', exact: true }).click();
    for (const page of pages) await expect(page.locator('[data-chat-delivery]')).toContainText('Partially delivered (1/2) · Recued does not know if it arrived');
    await pages[1]!.reload();
    await pages[1]!.locator('[data-chat-message-delivery="file-message"] summary').click();
    await expect(pages[1]!.locator('[data-chat-message-delivery="file-message"]')).toContainText('Text: 1/1 parts delivered.');
    await expect(pages[1]!.locator('[data-chat-message-delivery="file-message"]')).toContainText('Attachment.pdf · Recued does not know if it arrived');
    await pages[0]!.locator('[data-recued-chat-route-input]').fill('Keep this unsent draft');
    await pages[0]!.locator('[data-recued-chat-route-input]').focus();
    await pages[1]!.locator('[data-chat-message-delivery="file-message"]').getByRole('button', { name: 'Send again. It may arrive twice' }).click();
    for (const page of pages) await expect(page.locator('[data-chat-delivery]')).toContainText(/Delivery caught up\.|All sent\./);
    for (const page of pages) await expect(page.locator('[data-chat-message-delivery="file-message"] summary')).toHaveText('Messenger · Delivered');
    await expect(pages[1]!.locator('[data-chat-message-delivery="file-message"] summary')).toBeFocused();
    for (const page of pages) await expect(page.locator('[data-chat-message-delivery="file-message"] details')).toHaveJSProperty('open', true);
    await expect(pages[0]!.locator('[data-recued-chat-route-input]')).toHaveValue('Keep this unsent draft');
    await expect(pages[0]!.locator('[data-recued-chat-route-input]')).toBeFocused();
    expect(fixture.deliveryCount()).toBe(1);
    expect(fixture.uploads).toEqual([Buffer.from('%PDF-original-file'), Buffer.from('%PDF-original-file')]);
    expect(fixture.executions).toEqual([]);
    expect(retrySubmissions[0]!.submission_id).toBe(retrySubmissions[1]!.submission_id);
    expect(retrySubmissions[2]!.accept_unknown).toBe(true);
  } finally {
    fixture.release(); for (const context of contexts) await context.close().catch(() => {});
    fixture.close(); await rm(target, { force: true });
  }
});

test('two independent webclients share the durable FIFO, deduplication, Cancel and Run again', async ({ browser }) => {
  // Bundle our real backend composition so Node's ESM JSON rules match the
  // production build; packages (including native SQLite) remain external.
  const target = resolve('node_modules/.cache/d265-e2e/queue-backend.mjs');
  await mkdir(resolve(target, '..'), { recursive: true });
  await build({ entryPoints: [new URL('./harness/chat-queue-backend.ts', import.meta.url).pathname],
    outfile: target, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    resolveExtensions: ['.ts', '.js', '.json'], logLevel: 'silent' });
  const { createQueueFixture } = await import(pathToFileURL(target).href) as { createQueueFixture: typeof CreateQueueFixture };
  const pages: Page[] = [];
  const fixture = createQueueFixture({ emit: event => {
    for (const page of pages) void page.evaluate(event => {
      (window as unknown as { queueTestEvent(e: unknown): void }).queueTestEvent?.(event);
    }, { ...event, cursor: Date.now() }).catch(() => {});
  } });
  const { release, executions } = fixture;
  const contexts = [await browser.newContext(), await browser.newContext()];
  try {
    for (const context of contexts) {
      await context.route('**/d265-rpc', async route => {
        const { method, args } = route.request().postDataJSON();
        let result: unknown = {};
        try {
          result = await fixture.rpc(method, args);
          await route.fulfill({ json: { result } });
        } catch (error) { await route.fulfill({ json: { error: String(error) } }); }
      });
      const page = await context.newPage(); pages.push(page);
      await page.goto('/chat-queue-harness.html');
      await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    }
    const [a, b] = pages as [Page, Page];
    const send = async (page: Page, text: string) => {
      await page.locator('[data-recued-chat-route-input]').fill(text);
      await expect(page.locator('[data-recued-chat-route-send]')).toBeEnabled();
      await page.locator('[data-recued-chat-route-send]').click();
    };
    await send(a, 'A');
    await expect(b.locator('[data-chat-turn-status="running"]')).toContainText('A');
    await send(b, 'A');
    await expect(a.locator('[data-recued-chat-turn-queue]')).toContainText('1 repeated message');
    await send(b, 'B');
    await expect(a.locator('[data-chat-turn-status="queued"]')).toContainText('B');
    await a.getByRole('button', { name: 'Cancel queued message' }).click();
    expect(executions).toEqual(['A']);
    release();
    await expect.poll(async () => (await fixture.snapshot()).turns.map(t => t.status)).toEqual(['completed', 'cancelled']);
    await b.getByRole('button', { name: 'Run last message again' }).click();
    await expect.poll(() => executions).toEqual(['A', 'B']);
    for (const page of pages) {
      await expect(page.locator('[data-role="user"] .chat-message-content')).toHaveText(['A', 'B']);
    }
    await a.reload();
    await expect(a.locator('[data-recued-chat-turn-queue]')).toContainText('Completed: B');
  } finally {
    release();
    for (const context of contexts) await context.close().catch(() => {});
    fixture.close(); await rm(target, { force: true });
  }
});


test('both webclients show unknown Messenger delivery and retry the same answer without a new AI turn', async ({ browser }) => {
  const target = resolve('node_modules/.cache/d265-e2e/delivery-backend.mjs');
  await mkdir(resolve(target, '..'), { recursive: true });
  await build({ entryPoints: [new URL('./harness/chat-queue-backend.ts', import.meta.url).pathname], outfile: target,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', resolveExtensions: ['.ts', '.js', '.json'], logLevel: 'silent' });
  const { createQueueFixture } = await import(pathToFileURL(target).href) as { createQueueFixture: typeof CreateQueueFixture };
  const pages: Page[] = [];
  const fixture = createQueueFixture({ emit: event => {
    for (const page of pages) void page.evaluate(event => {
      (window as unknown as { queueTestEvent(e: unknown): void }).queueTestEvent?.(event);
    }, { ...event, cursor: Date.now() }).catch(() => {});
  } }, true);
  const contexts = [await browser.newContext(), await browser.newContext()];
  let statusUnavailable = false;
  try {
    for (const context of contexts) {
      await context.route('**/d265-rpc', async route => {
        const { method, args } = route.request().postDataJSON();
        try {
          if (method === 'chat.deliveries.list' && statusUnavailable) throw new Error('Status unavailable');
          await route.fulfill({ json: { result: await fixture.rpc(method, args) } });
        }
        catch (error) { await route.fulfill({ json: { error: String(error) } }); }
      });
      const page = await context.newPage(); pages.push(page);
      await page.goto('/chat-queue-harness.html');
      await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    }
    const [a, b] = pages as [Page, Page]; fixture.release();
    const message = '  Keep this exact message\n';
    await a.locator('[data-recued-chat-route-input]').fill(message);
    await a.locator('[data-recued-chat-route-send]').click();
    for (const page of pages) await expect(page.locator('[data-delivery-state="unknown"]')).toContainText('Recued does not know if it arrived');
    await b.reload();
    await expect(b.locator('[data-chat-delivery]')).toContainText('New messages sync to slack · C123');
    await b.getByRole('button', { name: 'Send again. It may arrive twice' }).click();
    for (const page of pages) await expect(page.locator('[data-chat-delivery]')).toContainText(/Delivery caught up\.|All sent\./);
    expect(fixture.executions).toEqual([message]);
    expect(fixture.deliveryCount()).toBe(2);
    statusUnavailable = true;
    await b.evaluate(() => (window as unknown as { queueTestEvent(e: unknown): void }).queueTestEvent({
      kind: 'chat.session_changed', session_id: 's', field: 'delivery', value: true, cursor: Date.now(),
    }));
    await expect(b.locator('[data-chat-delivery]')).toContainText('Recued cannot tell you where this got to.');
    await expect(b.locator('[data-chat-delivery]')).not.toContainText(/Delivery caught up\.|All sent\./);
    statusUnavailable = false;
    await b.getByRole('button', { name: 'Refresh delivery status' }).click();
    await expect(b.locator('[data-chat-delivery]')).toContainText(/Delivery caught up\.|All sent\./);
  } finally {
    fixture.release(); for (const context of contexts) await context.close().catch(() => {});
    fixture.close(); await rm(target, { force: true });
  }
});
