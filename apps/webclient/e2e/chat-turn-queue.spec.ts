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
    // The latest turn did not finish, so the strip offers to try it again.
    await b.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect.poll(() => executions).toEqual(['A', 'B']);
    for (const page of pages) {
      await expect(page.locator('[data-role="user"] .chat-message-content')).toHaveText(['A', 'B']);
    }
    await a.reload();
    // A turn that simply finished is not news: its answer is in the thread,
    // so nothing is left on the strip to push Send below the window.
    await expect(a.locator('[data-role="user"] .chat-message-content')).toHaveText(['A', 'B']);
    await expect(a.locator('[data-recued-chat-turn-queue]')).toHaveCount(0);
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

/** The owner's flow: the landing, a first message, a model that takes a few
 *  seconds. ⛔ The queue acknowledged the send as QUEUED, before the turn
 *  started, and the pending bubble opened only for a turn acknowledged as
 *  running — so the conversation showed the message and then nothing until
 *  the answer landed. And the turn's strip sat above both panes, pushing Send
 *  below the window. */
test('a first message shows its turn working in the chat and its row, with Send in view', async ({ browser }) => {
  const target = resolve('node_modules/.cache/d265-e2e/first-message-backend.mjs');
  await mkdir(resolve(target, '..'), { recursive: true });
  await build({ entryPoints: [new URL('./harness/chat-queue-backend.ts', import.meta.url).pathname],
    outfile: target, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    resolveExtensions: ['.ts', '.js', '.json'], logLevel: 'silent' });
  const { createQueueFixture } = await import(pathToFileURL(target).href) as { createQueueFixture: typeof CreateQueueFixture };
  let page: Page | undefined;
  const fixture = createQueueFixture({ emit: event => {
    void page?.evaluate(event => {
      (window as unknown as { queueTestEvent(e: unknown): void }).queueTestEvent?.(event);
    }, { ...event, cursor: Date.now() }).catch(() => {});
  } }, false, false, { holdInModel: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    await context.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON();
      try { await route.fulfill({ json: { result: await fixture.rpc(method, args) } }); }
      catch (error) { await route.fulfill({ json: { error: String(error) } }); }
    });
    page = await context.newPage();
    await page.goto('/chat-queue-harness.html?start');
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    // The app bar the real shell puts above the route.
    await page.evaluate(() => document.body.insertAdjacentHTML('afterbegin', '<div style="height:60px"></div>'));
    const sendInView = () => page!.locator('[data-recued-chat-route-send]')
      .evaluate((el) => el.getBoundingClientRect().bottom <= window.innerHeight);

    await page.locator('[data-recued-chat-route-input]').fill('What should I focus on today?');
    await page.locator('[data-recued-chat-route-send]').click();

    // While the model is out: the message, then the answer being prepared.
    await expect(page.locator('[data-role="user"] .chat-message-content'))
      .toHaveText(['What should I focus on today?']);
    const waiting = page.locator('[data-recued-chat-answer-waiting]');
    await expect(waiting).toHaveText('Preparing your answer…');
    // The chat it went into says it is busy, with the bubble's pulse.
    const working = page.locator('[data-recued-chat-route-session-status="working"]');
    await expect(working).toHaveText('Working…');
    // A box that pulses — an inline pseudo-element would take the animation
    // and no size, and draw nothing.
    expect(await working.evaluate((el) => {
      const dot = getComputedStyle(el, '::before');
      return { display: dot.display, animation: dot.animationName };
    })).toEqual({ display: 'inline-block', animation: 'recued-chat-answer-pulse' });
    // The turn's strip is on screen — inside the chat, not above it.
    await expect(page.locator('[data-recued-chat-route-thread] [data-recued-chat-turn-queue]'))
      .toContainText('Working: What should I focus on today?');
    expect(await sendInView()).toBe(true);

    fixture.release();
    await expect(waiting).toHaveCount(0);
    await expect(page.locator('[data-role="assistant"] .chat-message-content').last())
      .toHaveText('Start with the proposal due Friday.');
    await expect(working).toHaveCount(0);
    // A turn that simply finished leaves nothing on the strip.
    await expect(page.locator('[data-recued-chat-turn-queue]')).toHaveCount(0);
    expect(await sendInView()).toBe(true);
  } finally {
    fixture.release();
    await context.close().catch(() => {});
    fixture.close(); await rm(target, { force: true });
  }
});

/** The running note: nothing shown when nothing is carried, one closed line
 *  when something is, and read again after each reply. ⛔ The empty panel
 *  printed "Nothing carried yet" over a caveat that then read as a caption
 *  for the conversation; the panel read the note only when a chat was OPENED,
 *  so a chat started from the landing showed it hours later, if ever; and
 *  placed between the title and the messages it took the grid row the message
 *  list scrolls in. */
test('the running note shows only what is carried, closed to one line, fresh after each reply', async ({ browser }) => {
  const target = resolve('node_modules/.cache/d265-e2e/running-note-backend.mjs');
  await mkdir(resolve(target, '..'), { recursive: true });
  await build({ entryPoints: [new URL('./harness/chat-queue-backend.ts', import.meta.url).pathname],
    outfile: target, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    resolveExtensions: ['.ts', '.js', '.json'], logLevel: 'silent' });
  const { createQueueFixture } = await import(pathToFileURL(target).href) as { createQueueFixture: typeof CreateQueueFixture };
  let page: Page | undefined;
  const fixture = createQueueFixture({ emit: event => {
    void page?.evaluate(event => {
      (window as unknown as { queueTestEvent(e: unknown): void }).queueTestEvent?.(event);
    }, { ...event, cursor: Date.now() }).catch(() => {});
  } }, false, false, { holdInModel: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    await context.route('**/d265-rpc', async route => {
      const { method, args } = route.request().postDataJSON();
      try { await route.fulfill({ json: { result: await fixture.rpc(method, args) } }); }
      catch (error) { await route.fulfill({ json: { error: String(error) } }); }
    });
    page = await context.newPage();
    await page.goto('/chat-queue-harness.html?start');
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    await page.evaluate(() => document.body.insertAdjacentHTML('afterbegin', '<div style="height:60px"></div>'));
    const panel = page.locator('[data-recued-chat-route-carry]');
    const send = async (text: string) => {
      await page!.locator('[data-recued-chat-route-input]').fill(text);
      await page!.locator('[data-recued-chat-route-send]').click();
    };

    await send('Plan my week');
    await expect(page.locator('[data-recued-chat-answer-waiting]')).toHaveText('Preparing your answer…');
    // Nothing carried: nothing shown — no heading, no caveat over the chat.
    await expect(panel).toHaveCount(0);
    await expect(page.getByText('Nothing carried yet')).toHaveCount(0);

    // A fold writes the note during the turn; the reply brings it to screen.
    const sessions = await fixture.rpc('chat.sessions.list', {}) as { sessions: Array<{ id: string }> };
    const chat = sessions.sessions.find(s => s.id !== 's')!.id;
    await fixture.writeBrief(chat, {
      intent: 'Plan the week',
      constraints: ['Keep Fridays free'],
      findings: ['Two meetings moved to Tuesday'],
      pending: ['Book the dentist'],
    });
    fixture.release();
    await expect(page.locator('[data-role="assistant"] .chat-message-content').last())
      .toHaveText('Start with the proposal due Friday.');
    await expect(panel).toHaveCount(1);
    await expect(panel.locator('summary')).toHaveText("Chat's running note · 4 notes");
    // One closed line — not the grid row the conversation scrolls in.
    await expect(panel).not.toHaveAttribute('open', '');
    expect((await panel.boundingBox())!.height).toBeLessThan(60);
    expect(await page.locator('[data-recued-chat-route-send]')
      .evaluate((el) => el.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);

    // Open: the notes, the owner's marked, the caveat, and Clear.
    await panel.locator('summary').click();
    await expect(panel).toHaveAttribute('open', '');
    await expect(panel).toContainText('Working on: Plan the week');
    await expect(panel.locator('[data-from-owner]')).toHaveText('From you: Keep Fridays free');
    await expect(panel).toContainText("This is Chat's running note for this chat, in its own words.");
    // It stays open through the re-render of the next reply.
    await send('And the week after?');
    await expect(page.locator('[data-role="assistant"] .chat-message-content')).toHaveCount(2);
    await expect(panel).toHaveAttribute('open', '');

    await panel.getByRole('button', { name: 'Clear the running note', exact: true }).click();
    await expect(panel).toHaveCount(0);
    expect(await fixture.rpc('chat.session.brief.get', { session_id: chat })).toEqual({ brief: null });
  } finally {
    fixture.release();
    await context.close().catch(() => {});
    fixture.close(); await rm(target, { force: true });
  }
});
