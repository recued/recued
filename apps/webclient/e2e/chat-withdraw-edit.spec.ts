import { test, expect, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createQueueFixture as CreateQueueFixture } from './harness/chat-queue-backend.js';

const setup = async (browser: Browser) => {
  const target = resolve(`node_modules/.cache/d265-e2e/withdraw-${crypto.randomUUID()}.mjs`);
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
  let legacy = false; let delayAck: Promise<void> | undefined; let delayRequest: Promise<void> | undefined; let loseAck = false;
  const contexts = [await browser.newContext(), await browser.newContext()];
  for (const context of contexts) {
    await context.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON(); calls.push({ method, args });
      try {
        if (method === 'chat.turn.withdraw') await delayRequest;
        const result = await fixture.rpc(method, args);
        if (legacy && method === 'chat.turns.list') for (const turn of (result as { turns: Array<Record<string, unknown>> }).turns) delete turn.withdraw_to_edit_available;
        if (method === 'chat.turn.withdraw') {
          await delayAck;
          if (loseAck) { loseAck = false; throw new Error('lost withdrawal acknowledgement'); }
        }
        await route.fulfill({ json: { result } });
      } catch (error) { await route.fulfill({ json: { error: String(error) } }); }
    });
    const page = await context.newPage(); pages.push(page);
    await page.goto('/chat-queue-harness.html');
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  }
  return { fixture, calls, pages: pages as [Page, Page],
    legacy: () => { legacy = true; }, loseAck: () => { loseAck = true; },
    holdRequest: (promise: Promise<void>) => { delayRequest = promise; }, holdAck: (promise: Promise<void>) => { delayAck = promise; },
    close: async () => {
      fixture.release(); for (const context of contexts) await context.close().catch(() => {});
      fixture.close(); await rm(target, { force: true });
    },
  };
};
const input = (page: Page) => page.locator('[data-recued-chat-route-input]');
const row = (page: Page, id: string) => page.locator(`[data-chat-queued-turn="${id}"]`);
const send = async (page: Page, text: string) => {
  await input(page).fill(text); await page.locator('[data-recued-chat-route-send]').click();
  await expect(input(page)).toHaveValue('');
};

test('withdraws a quoted message across two browsers and sends the edited text at the queue tail', async ({ browser }) => {
  const f = await setup(browser); const [a, b] = f.pages;
  try {
    await send(a, 'first');
    await b.locator('[data-chat-reply-action="question-2"]').click();
    await send(b, 'Original queued text');
    await send(a, 'next');
    const original = (await f.fixture.snapshot()).turns[1]!;
    await row(b, original.turn_id).getByRole('button', { name: 'Withdraw to edit', exact: true }).click();
    await expect(input(b)).toHaveValue('Original queued text'); await expect(input(b)).toBeFocused();
    await expect(b.locator('[data-chat-reply-draft="question-2"]')).toContainText('Second question');
    for (const page of f.pages) await expect(row(page, original.turn_id)).toHaveAttribute('data-chat-turn-status', 'withdrawn');
    await expect(a.locator('[data-chat-turn-status="running"] [data-chat-withdraw]')).toHaveCount(0);
    await send(b, 'Edited queued text');
    f.fixture.release();
    await expect.poll(() => f.fixture.executions).toEqual(['first', 'next', 'Edited queued text']);
    await expect.poll(async () => (await f.fixture.snapshot()).turns.map(turn => turn.status))
      .toEqual(['completed', 'withdrawn', 'completed', 'completed']);
    for (const page of f.pages) await expect.poll(() => page.evaluate(() => (window as unknown as { queueTestHasInFlight(): boolean }).queueTestHasInFlight())).toBe(false);
    expect(f.calls.filter(call => call.method === 'chat.send').at(-1)?.args.reply_to_message_id).toBe('question-2');
    expect((await f.fixture.messages()).filter(message => message.role === 'user').map(message => message.content))
      .toEqual(['first', 'next', 'Edited queued text']);
  } finally { await f.close(); }
});

test('recovers a lost withdrawal acknowledgement after reload without rejoining the withdrawn turn', async ({ browser }) => {
  const f = await setup(browser); const [a, b] = f.pages;
  try {
    await send(a, 'first'); await send(a, 'Recover me');
    const original = (await f.fixture.snapshot()).turns[1]!;
    f.loseAck();
    await row(a, original.turn_id).getByRole('button', { name: 'Withdraw to edit', exact: true }).click();
    await expect(a.locator('[data-recued-chat-turn-queue] [role="alert"]')).toContainText('Could not confirm withdrawal');
    await expect(input(a)).toHaveValue(''); await expect(input(b)).toHaveValue('');
    await a.reload(); await expect(a.locator('body')).toHaveAttribute('data-ready', 'true');
    await row(a, original.turn_id).getByRole('button', { name: 'Restore withdrawn draft', exact: true }).click();
    await expect(input(a)).toHaveValue('Recover me');
    await a.locator('[data-recued-chat-route-send]').click();
    await expect.poll(async () => (await f.fixture.snapshot()).turns.length).toBe(3);
    expect((await f.fixture.snapshot()).turns[2]).toMatchObject({ message: 'Recover me', status: 'queued' });
    f.fixture.release(); await expect.poll(() => f.fixture.executions).toEqual(['first', 'Recover me']);
  } finally { await f.close(); }
});

test('preserves a draft typed while withdrawal is awaiting confirmation', async ({ browser }, testInfo) => {
  const f = await setup(browser); const [a] = f.pages; let releaseAck!: () => void;
  f.holdAck(new Promise<void>(resolve => { releaseAck = resolve; }));
  try {
    await send(a, 'first'); await send(a, 'Withdraw this');
    const original = (await f.fixture.snapshot()).turns[1]!;
    await row(a, original.turn_id).getByRole('button', { name: 'Withdraw to edit', exact: true }).click();
    await expect.poll(async () => (await f.fixture.snapshot()).turns[1]?.status).toBe('withdrawn');
    await input(a).fill('Keep my newer draft'); releaseAck();
    await expect(a.locator('[data-recued-chat-turn-queue] [role="alert"]')).toContainText('Send or clear your current draft');
    await expect(input(a)).toHaveValue('Keep my newer draft');
    await input(a).fill('');
    await row(a, original.turn_id).getByRole('button', { name: 'Restore withdrawn draft', exact: true }).click();
    await expect(input(a)).toHaveValue('Withdraw this');
    await a.setViewportSize({ width: 390, height: 844 });
    const queue = a.locator('[data-recued-chat-turn-queue]');
    expect(await queue.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await queue.screenshot({ path: testInfo.outputPath('withdraw-queue-mobile.png') });
    expect(f.fixture.executions).toEqual(['first']);
  } finally { releaseAck(); await f.close(); }
});

test('a worker that wins the race leaves the original immutable and the composer unchanged', async ({ browser }) => {
  const f = await setup(browser); const [a] = f.pages; let releaseRequest!: () => void;
  f.holdRequest(new Promise<void>(resolve => { releaseRequest = resolve; }));
  try {
    await send(a, 'first'); await send(a, 'Already processed');
    const original = (await f.fixture.snapshot()).turns[1]!;
    await row(a, original.turn_id).getByRole('button', { name: 'Withdraw to edit', exact: true }).click();
    await expect.poll(() => f.calls.some(call => call.method === 'chat.turn.withdraw')).toBe(true);
    f.fixture.release();
    await expect.poll(async () => (await f.fixture.snapshot()).turns[1]?.status).toBe('completed');
    releaseRequest();
    await expect(a.locator('[data-recued-chat-turn-queue] [role="alert"]')).toContainText('Only queued messages');
    await expect(input(a)).toHaveValue(''); await expect(a.locator('[data-chat-withdraw]')).toHaveCount(0);
    expect(f.fixture.executions).toEqual(['first', 'Already processed']);
  } finally { releaseRequest(); await f.close(); }
});

test('restores attachment-only input without uploading again and protects it during navigation', async ({ browser }) => {
  const f = await setup(browser); const [a] = f.pages;
  try {
    await send(a, 'first');
    const attachments = [{ file_id: 'file:existing-image', media_class: 'image' }];
    await f.fixture.rpc('chat.send', { session_id: 's', message: '', submission_id: 'attachment-original',
      picker_state: { current: 'self' }, attachments, reply_to_message_id: 'question-2' });
    const original = (await f.fixture.snapshot()).turns[1]!;
    await row(a, original.turn_id).getByRole('button', { name: 'Withdraw to edit', exact: true }).click();
    await expect(a.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(1);
    await expect(a.locator('[data-chat-reply-draft="question-2"]')).toBeVisible();
    await a.getByRole('button', { name: 'Remove reply', exact: true }).click();
    await a.getByRole('button', { name: /Another conversation.*0 messages/ }).click();
    await expect(a.locator('[data-recued-chat-route-history-draft-guard]')).toBeVisible();
    await a.getByRole('button', { name: 'Keep writing', exact: true }).click();
    await a.evaluate(() => (window as unknown as { queueTestRePair(): Promise<void> }).queueTestRePair());
    await expect(a.locator('[data-recued-chat-route-attachment="attached"]')).toHaveCount(1);
    await expect(a.locator('[data-recued-chat-route-send]')).toBeEnabled();
    await a.locator('[data-recued-chat-route-send]').click();
    await expect.poll(() => f.calls.filter(call => call.method === 'chat.send').length).toBe(2);
    expect(f.calls.filter(call => call.method === 'chat.send').at(-1)?.args.attachments).toEqual(attachments);
    expect(f.calls.some(call => call.method.startsWith('upload.'))).toBe(false);
    await expect(a.locator('[data-recued-chat-route-attachment]')).toHaveCount(0);
  } finally { await f.close(); }
});

test('older queue servers omit withdrawal without breaking normal queue controls', async ({ browser }) => {
  const f = await setup(browser); const [a] = f.pages;
  try {
    f.legacy(); await send(a, 'first'); await send(a, 'queued');
    await a.reload(); await expect(a.locator('body')).toHaveAttribute('data-ready', 'true');
    await expect(a.getByRole('button', { name: 'Cancel queued message', exact: true })).toBeVisible();
    await expect(a.locator('[data-chat-withdraw]')).toHaveCount(0);
  } finally { await f.close(); }
});
