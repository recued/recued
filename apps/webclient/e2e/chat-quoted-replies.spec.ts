import { test, expect, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createQueueFixture as CreateQueueFixture } from './harness/chat-queue-backend.js';
import { openChatHistory } from './helpers/chat-history.js';

const setup = async (browser: Browser) => {
  const target = resolve(`node_modules/.cache/d265-e2e/quoted-${crypto.randomUUID()}.mjs`);
  await mkdir(resolve(target, '..'), { recursive: true });
  await build({ entryPoints: [new URL('./harness/chat-queue-backend.ts', import.meta.url).pathname], outfile: target,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', resolveExtensions: ['.ts', '.js', '.json'], logLevel: 'silent' });
  const { createQueueFixture } = await import(pathToFileURL(target).href) as { createQueueFixture: typeof CreateQueueFixture };
  const pages: Page[] = [];
  const fixture = createQueueFixture({ emit: event => {
    for (const page of pages) void page.evaluate(event => {
      (window as unknown as { queueTestEvent(e: unknown): void }).queueTestEvent?.(event);
    }, { ...event, cursor: Date.now() }).catch(() => {});
  } });
  await fixture.seedReplyHistory();
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  let legacy = false; let delayAck: Promise<void> | undefined;
  const contexts = [await browser.newContext(), await browser.newContext()];
  for (const context of contexts) {
    await context.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON(); calls.push({ method, args });
      try {
        const result = await fixture.rpc(method, args);
        if (legacy && method === 'chat.session.get') delete (result as Record<string, unknown>).quoted_replies_available;
        if (method === 'chat.send') await delayAck;
        await route.fulfill({ json: { result } });
      } catch (error) { await route.fulfill({ json: { error: String(error) } }); }
    });
    const page = await context.newPage(); pages.push(page);
    await page.goto('/chat-queue-harness.html');
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  }
  return { fixture, calls, pages: pages as [Page, Page],
    legacy: () => { legacy = true; }, holdAck: (promise: Promise<void>) => { delayAck = promise; },
    close: async () => {
      fixture.release(); for (const context of contexts) await context.close().catch(() => {});
      fixture.close(); await rm(target, { force: true });
    },
  };
};
const row = (page: Page, id: string) => page.locator(`[data-recued-chat-route-message="${id}"]`);
const input = (page: Page) => page.locator('[data-recued-chat-route-input]');
const send = async (page: Page, text: string) => {
  await input(page).fill(text); await page.locator('[data-recued-chat-route-send]').click();
};

test('two browsers retain different reply targets for identical text and reopen exact older messages', async ({ browser }) => {
  const f = await setup(browser); const [a, b] = f.pages;
  try {
    await expect(row(a, 'question-1')).toHaveCount(0);
    await expect(row(a, 'linked').locator('[data-chat-quote]')).toContainText('<img src=x onerror=alert(1)> Original question');
    await expect(row(a, 'linked').locator('[data-chat-quote] img')).toHaveCount(0);
    await row(a, 'linked').locator('[data-chat-quote-target="question-1"]').click();
    await expect(row(a, 'question-1')).toHaveAttribute('data-recued-chat-route-return-target', '');
    expect(f.calls.some(call => call.method === 'chat.session.get' && call.args.around_message_id === 'question-1')).toBe(true);
    await a.locator('[data-chat-reply-action="question-1"]').click();
    await expect(input(a)).toBeFocused();
    await expect(a.locator('[data-chat-reply-draft="question-1"]')).toContainText('Original question');
    await send(a, 'yes');
    await b.locator('[data-chat-reply-action="question-2"]').click();
    await send(b, 'yes');
    await expect.poll(async () => (await f.fixture.snapshot()).turns.length).toBe(2);
    expect(f.calls.filter(call => call.method === 'chat.send').map(call => call.args.reply_to_message_id)).toEqual(['question-1', 'question-2']);
    f.fixture.release();
    await expect.poll(async () => (await f.fixture.snapshot()).turns.every(turn => turn.status === 'completed')).toBe(true);
    const replies = (await f.fixture.messages()).filter(message => message.role === 'user');
    expect(replies.map(message => message.reply_to && 'message_id' in message.reply_to ? message.reply_to.message_id : null))
      .toEqual(['question-1', 'question-2']);
    for (const page of f.pages) {
      await page.reload();
      for (const [i, reply] of replies.entries()) await expect(row(page, reply.id).locator('[data-chat-quote]'))
        .toContainText(i === 0 ? 'Original question' : 'Second question');
    }
    await row(b, replies[0]!.id).locator('[data-chat-quote]').click();
    await expect(row(b, 'question-1')).toHaveAttribute('data-recued-chat-route-return-target', '');
  } finally { await f.close(); }
});

test('unavailable originals stay explicit, removed draft targets fail clearly, and old servers hide Reply', async ({ browser }) => {
  const f = await setup(browser); const [a] = f.pages;
  try {
    await expect(row(a, 'native-missing').locator('[data-chat-quote]')).toHaveText('The Messenger message being replied to is not in this chat.');
    await expect(row(a, 'removed').locator('[data-chat-quote]')).toHaveText('The message being replied to is gone.');
    await expect(row(a, 'removed').locator('button[data-chat-quote]')).toHaveCount(0);
    await a.locator('[data-chat-reply-action="question-2"]').click();
    f.fixture.removeMessage('question-2');
    await send(a, 'Keep my draft');
    await expect(a.locator('[data-recued-chat-route-error]')).toContainText('Clear the reply or choose another message');
    await expect(input(a)).toHaveValue('Keep my draft');
    await expect(a.locator('[data-chat-reply-draft="question-2"]')).toBeVisible();
    expect((await f.fixture.snapshot()).turns).toEqual([]);
    await a.getByRole('button', { name: 'Remove reply', exact: true }).click();
    await expect(input(a)).toBeFocused(); await expect(input(a)).toHaveValue('Keep my draft');
    await expect(a.locator('[data-chat-reply-draft]')).toHaveCount(0);
    f.legacy(); await a.reload();
    await expect(a.locator('body')).toHaveAttribute('data-ready', 'true');
    await expect(a.locator('[data-chat-reply-action]')).toHaveCount(0);
  } finally { await f.close(); }
});

test('an acknowledgement preserves a newly selected reply and its draft', async ({ browser }) => {
  const f = await setup(browser); const [a] = f.pages;
  let releaseAck!: () => void;
  f.holdAck(new Promise<void>(resolve => { releaseAck = resolve; }));
  try {
    await a.locator('[data-chat-reply-action="question-2"]').click();
    await send(a, 'yes');
    await expect.poll(() => f.calls.filter(call => call.method === 'chat.send').length).toBe(1);
    await a.locator('[data-chat-reply-action="linked"]').click();
    await input(a).fill('Next reply');
    releaseAck();
    await expect(a.locator('[data-chat-reply-draft="linked"]')).toBeVisible();
    await expect(input(a)).toHaveValue('Next reply');
    await a.getByRole('button', { name: 'Remove reply', exact: true }).focus();
    await a.evaluate(() => (window as unknown as { queueTestRefresh(): Promise<void> }).queueTestRefresh());
    await expect(a.getByRole('button', { name: 'Remove reply', exact: true })).toBeFocused();
    await expect(input(a)).toHaveValue('Next reply');
    f.fixture.release();
    await expect.poll(async () => (await f.fixture.snapshot()).turns[0]?.status).toBe('completed');
  } finally { releaseAck(); await f.close(); }
});

test('a quote-only draft is protected during navigation and fits a narrow composer', async ({ browser }, testInfo) => {
  const f = await setup(browser); const [a] = f.pages;
  try {
    await a.setViewportSize({ width: 390, height: 844 });
    await a.emulateMedia({ colorScheme: 'dark' });
    await a.locator('[data-chat-reply-action="question-2"]').click();
    // A phone shows the conversation list as its own pane.
    await openChatHistory(a);
    await a.getByRole('button', { name: /Another conversation.*0 messages/ }).click();
    await expect(a.locator('[data-recued-chat-route-history-draft-guard]')).toContainText('What you were writing will be lost');
    await a.getByRole('button', { name: 'Keep writing', exact: true }).click();
    await expect(a.locator('[data-chat-reply-draft="question-2"]')).toBeVisible();
    await expect(input(a)).toBeFocused(); await expect(input(a)).toHaveValue('');
    expect(await a.locator('[data-chat-reply-draft]').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await a.locator('.chat-composer').screenshot({ path: testInfo.outputPath('quoted-reply-mobile.png') });
    await openChatHistory(a);
    await a.getByRole('button', { name: /Another conversation.*0 messages/ }).click();
    await a.getByRole('button', { name: 'Throw it away and open', exact: true }).click();
    await expect(a.locator('[data-chat-reply-draft]')).toHaveCount(0);
    await expect(row(a, 'question-2')).toHaveCount(0);
  } finally { await f.close(); }
});
