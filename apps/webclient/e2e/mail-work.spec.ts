import { test, expect, type Browser } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createMailWorkFixture as Factory } from './harness/mail-work-backend.js';

let createFixture: typeof Factory;
const target = resolve(`node_modules/.cache/mail-work-e2e-${crypto.randomUUID()}.mjs`);
test.beforeAll(async () => {
  await mkdir(resolve(target, '..'), { recursive: true });
  await build({ entryPoints: [new URL('./harness/mail-work-backend.ts', import.meta.url).pathname], outfile: target,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', resolveExtensions: ['.ts', '.js', '.json'], logLevel: 'silent' });
  createFixture = (await import(pathToFileURL(target).href) as { createMailWorkFixture: typeof Factory }).createMailWorkFixture;
});
test.afterAll(async () => { await rm(target, { force: true }); });
const setup = async (browser: Browser) => {
  const context = await browser.newContext(); const page = await context.newPage();
  const fixture = createFixture(); const calls: string[] = []; const errors: string[] = [];
  const requests: Array<{ method: string; args: Record<string, unknown> }> = [];
  const intercept: { rpc?: (method: string, args: Record<string, unknown>) => Promise<void> } = {};
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  await context.route('**/mail-work-rpc', async route => {
    const { method, args } = route.request().postDataJSON(); calls.push(method); requests.push({ method, args });
    try { await intercept.rpc?.(method, args); await route.fulfill({ json: { result: await fixture.rpc(method, args) } }); }
    catch (error) { await route.fulfill({ json: { error: String(error) } }).catch(() => {}); }
  });
  await page.goto('/mail-work-harness.html#data/mail/record/work/seed');
  await expect(page.getByRole('link', { name: 'Follow this work', exact: true })).toBeVisible();
  return { context, page, fixture, calls, requests, errors, intercept,
    async follow(stayInChat = false) {
      await page.getByRole('link', { name: 'Follow this work', exact: true }).click();
      await expect.poll(() => requests.filter(call => call.method === 'chat.send').length).toBe(1);
      const id = (await fixture.service.list()).works[0]!.id;
      const detail = await fixture.service.get(id);
      await expect(page).toHaveURL(new RegExp(`#chat/session/${detail.chat_session_id}$`));
      if (!stayInChat) {
        await page.goto(`/mail-work-harness.html#mail/work/${id}`);
        await expect(page.getByRole('heading', { name: 'Acme revised offer', exact: true })).toBeVisible();
      }
      return id;
    },
    async close() { await context.close(); fixture.close(); },
  };
};

test('selected email → saved work → evidence review → related conversation → resolution and reopening', async ({ browser }) => {
  const f = await setup(browser);
  try {
    const id = await f.follow();
    await f.page.getByRole('button', { name: 'Review with AI', exact: true }).click();
    await expect(f.page.getByText('The client requested a revised offer.', { exact: false })).toBeVisible();
    const evidence = f.page.locator('.work-evidence a').first();
    await expect(evidence).toHaveAttribute('href', '#data/mail/record/work/seed');
    await f.page.getByRole('button', { name: 'Acme pricing', exact: true }).click();
    await f.page.getByRole('button', { name: 'Link conversation', exact: true }).click();
    await expect.poll(async () => (await f.fixture.service.get(id)).work.threads.length).toBe(2);
    await f.page.getByText('Your outcome and context', { exact: true }).click();
    await f.page.getByLabel('Your context, corrections and offline decisions').fill('Client accepted the scope by phone.');
    await f.page.getByRole('button', { name: 'Save context', exact: true }).click();
    await f.page.reload();
    await expect(f.page.getByLabel('Your context, corrections and offline decisions')).toHaveValue('Client accepted the scope by phone.');
    await f.page.getByLabel('How was this resolved, or what changed?').fill('Revised offer accepted by phone.');
    await f.page.getByRole('button', { name: 'Mark resolved', exact: true }).click();
    await expect(f.page.getByRole('button', { name: 'Reopen work', exact: true })).toBeVisible();
    expect((await f.fixture.service.get(id)).work.status).toBe('resolved');
    await f.page.getByRole('button', { name: 'Reopen work', exact: true }).click();
    await expect(f.page.getByRole('button', { name: 'Mark resolved', exact: true })).toBeVisible();
    expect(f.calls).not.toContain('execute'); expect(f.calls.filter(call => call === 'chat.send')).toHaveLength(1); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('following starts one saved investigation; reload and Open investigation only resume it', async ({ browser }) => {
  const f = await setup(browser);
  try {
    const id = await f.follow(true);
    const detail = await f.fixture.service.get(id);
    const sent = f.requests.find(call => call.method === 'chat.send')!;
    expect(sent.args.session_id).toBe(detail.chat_session_id);
    expect(sent.args.message).toContain('first contact');
    expect(sent.args.message).toContain('in progress');
    expect(sent.args.message).toContain('apparently done');
    expect(sent.args.message).toContain('"seed_record_id": "seed"');
    await f.page.reload();
    await expect(f.page.locator('[data-recued-chat-route-input]')).toBeVisible();
    await f.page.goto(`/mail-work-harness.html#mail/work/${id}`);
    await f.page.getByRole('button', { name: 'Open investigation', exact: true }).click();
    await expect(f.page).toHaveURL(new RegExp(`#chat/session/${detail.chat_session_id}$`));
    await expect(f.page.locator('[data-recued-chat-route-input]')).toHaveValue('');
    expect(f.requests.filter(call => call.method === 'chat.send')).toHaveLength(1);
    expect(f.calls).not.toContain('mail.work.review'); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('revisiting resolved work sends current intent and history without reopening the workbook', async ({ browser }) => {
  const f = await setup(browser);
  try {
    const id = await f.follow();
    const before = (await f.fixture.service.get(id)).work;
    const resolved = await f.fixture.service.update({ id, expected_revision: before.revision,
      status: 'resolved', resolution_note: 'Offer withdrawn. The client chose a different supplier.' });
    await f.page.getByLabel('What would help now?').selectOption('revisit');
    await f.page.getByRole('button', { name: 'Investigate in Chat', exact: true }).click();
    await expect.poll(() => f.requests.filter(call => call.method === 'chat.send').length).toBe(2);
    const sent = f.requests.filter(call => call.method === 'chat.send').at(-1)!;
    expect(sent.args.message).toContain('What I want now: Revisit the work');
    expect(sent.args.message).toContain('"workbook_status": "resolved"');
    expect(sent.args.message).toContain('Offer withdrawn. The client chose a different supplier.');
    expect((await f.fixture.service.get(id)).work).toEqual(resolved.work);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('failed Chat creation leaves saved work reachable and retries the same conversation', async ({ browser }) => {
  const f = await setup(browser);
  try {
    let fail = true;
    f.intercept.rpc = async method => {
      if (method === 'chat.session.create' && fail) { fail = false; throw new Error('Temporary connection failure.'); }
    };
    const following = f.follow(true);
    await expect(f.page.getByRole('alert')).toContainText('Temporary connection failure');
    await expect(f.page.getByRole('link', { name: 'Acme revised offer', exact: true })).toBeVisible();
    await f.page.getByRole('button', { name: 'Try again', exact: true }).click();
    await following;
    expect((await f.fixture.service.list()).works).toHaveLength(1);
    const opens = f.requests.filter(call => call.method === 'chat.session.create');
    expect(opens).toHaveLength(2); expect(opens[0]!.args.creation_id).toBe(opens[1]!.args.creation_id);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('a second click resumes the same Chat without another investigation turn', async ({ browser }) => {
  const f = await setup(browser);
  try {
    const id = await f.follow(true);
    const detail = await f.fixture.service.get(id);
    await f.page.goto('/mail-work-harness.html#data/mail/record/work/seed');
    await f.page.getByRole('link', { name: 'Follow this work', exact: true }).click();
    await expect(f.page).toHaveURL(new RegExp(`#chat/session/${detail.chat_session_id}$`));
    await expect(f.page.locator('[data-recued-chat-route-input]')).toBeVisible();
    expect((await f.fixture.service.list()).works).toHaveLength(1);
    expect(f.requests.filter(call => call.method === 'chat.send')).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('Back from the opened Chat returns to the email without handing over again', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.follow(true);
    await f.page.goBack();
    await expect(f.page).toHaveURL(/#data\/mail\/record\/work\/seed$/u);
    await expect(f.page.getByRole('link', { name: 'Follow this work', exact: true })).toBeVisible();
    expect(f.requests.filter(call => call.method === 'chat.session.create')).toHaveLength(1);
    expect(f.requests.filter(call => call.method === 'chat.send')).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('multiple associated investigations offer a choice and permit a separate Chat', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.fixture.service.create({ request_id: crypto.randomUUID(), email: { slug: 'work', record_id: 'seed' }, title: 'Delivery', separate: true });
    await f.fixture.service.create({ request_id: crypto.randomUUID(), email: { slug: 'work', record_id: 'seed' }, title: 'Billing', separate: true });
    await f.page.getByRole('link', { name: 'Follow this work', exact: true }).click();
    await expect(f.page.getByRole('heading', { name: 'Choose an investigation' })).toBeVisible();
    expect(f.requests.filter(call => call.method === 'chat.send')).toHaveLength(0);
    await f.page.getByRole('button', { name: 'Start a separate investigation', exact: true }).click();
    await expect.poll(() => f.requests.filter(call => call.method === 'chat.send').length).toBe(1);
    expect((await f.fixture.service.list()).works).toHaveLength(3);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('owner corrections arriving during Chat creation are included in the submitted investigation', async ({ browser }) => {
  const f = await setup(browser); let release!: () => void;
  try {
    const id = await f.follow();
    f.intercept.rpc = async method => {
      if (method === 'chat.session.create') await new Promise<void>(done => { release = done; });
    };
    await f.page.getByRole('button', { name: 'Investigate in Chat', exact: true }).click();
    await expect.poll(() => typeof release).toBe('function');
    const before = (await f.fixture.service.get(id)).work;
    await f.fixture.service.update({ id, expected_revision: before.revision, owner_notes: 'Delivered already; help prepare the final report.' });
    release();
    await expect.poll(() => f.requests.filter(call => call.method === 'chat.send').length).toBe(2);
    expect(f.requests.filter(call => call.method === 'chat.send').at(-1)!.args.message).toContain('Delivered already; help prepare the final report.');
    expect(f.errors).toEqual([]);
  } finally { release?.(); await f.close(); }
});

test('new mail is flagged, unsaved context survives polling, and investigation submits the saved correction', async ({ browser }) => {
  const f = await setup(browser);
  try {
    await f.follow();
    await f.page.getByRole('button', { name: 'Review with AI', exact: true }).click();
    await expect(f.page.locator('[data-work-updates]')).toContainText('matches the last review');
    await f.page.clock.install();
    // Re-mount after installing the clock so the real polling interval is controlled.
    await f.page.reload();
    await f.page.getByText('Your outcome and context', { exact: true }).click();
    await f.page.getByLabel('Your context, corrections and offline decisions').fill('Keep this offline decision.');
    f.fixture.addMail('new', 'client', 'Can we revise the delivery date?');
    await f.page.clock.fastForward(31_000);
    await expect(f.page.locator('[data-work-updates]')).toContainText('has changed');
    await expect(f.page.getByLabel('Your context, corrections and offline decisions')).toHaveValue('Keep this offline decision.');
    await f.page.getByRole('button', { name: 'Investigate in Chat', exact: true }).click();
    await expect.poll(() => f.requests.filter(call => call.method === 'chat.send').length).toBe(2);
    const sends = f.requests.filter(call => call.method === 'chat.send');
    expect(sends[1]!.args.message).toContain('Keep this offline decision');
    expect(sends[1]!.args.session_id).toBe(sends[0]!.args.session_id);
    expect(f.calls).not.toContain('execute'); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('a source change during review preserves the previous brief and exposes a retryable error', async ({ browser }) => {
  const f = await setup(browser); let release!: () => void;
  try {
    const id = await f.follow();
    await f.page.getByRole('button', { name: 'Review with AI', exact: true }).click();
    await expect(f.page.locator('[data-work-updates]')).toContainText('matches the last review');
    const saved = (await f.fixture.service.get(id)).work;
    f.fixture.delayReview(() => new Promise<void>(done => { release = done; }));
    await f.page.getByRole('button', { name: 'Review with AI', exact: true }).click();
    await expect.poll(() => typeof release).toBe('function');
    f.fixture.addMail('new', 'client', 'Different requirements.'); release();
    await expect(f.page.getByRole('alert')).toContainText('changed');
    expect((await f.fixture.service.get(id)).work).toEqual(saved);
    f.fixture.delayReview();
    await f.page.getByRole('button', { name: 'Review with AI', exact: true }).click();
    await expect(f.page.locator('[data-work-updates]')).toContainText('matches the last review');
    expect(f.errors).toEqual([]);
  } finally { release?.(); await f.close(); }
});

test('Delete asks on the page, removes the work, returns to the list and keeps the Chat', async ({ browser }) => {
  const f = await setup(browser); const dialogs: string[] = [];
  try {
    f.page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    const id = await f.follow();
    const chat = (await f.fixture.service.get(id)).chat_session_id;
    await f.page.getByRole('button', { name: 'Delete followed work', exact: true }).click();
    await expect(f.page.getByText('Delete this followed work? Its notes and AI review are removed. The Chat stays; delete it in Chat if you want.', { exact: true })).toBeVisible();
    await expect(f.page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await f.page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(f.page.getByRole('button', { name: 'Delete followed work', exact: true })).toBeFocused();
    expect((await f.fixture.service.list()).works).toHaveLength(1);
    await f.page.getByRole('button', { name: 'Delete followed work', exact: true }).click();
    await f.page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(f.page).toHaveURL(/#mail\/work$/);
    await expect(f.page.getByRole('heading', { name: 'Work you’re following', exact: true })).toBeVisible();
    await expect(f.page.getByText('No work is being followed yet.', { exact: true })).toBeVisible();
    expect((await f.fixture.service.list()).works).toEqual([]);
    await expect(f.fixture.rpc('chat.session.get', { session_id: chat })).resolves.toMatchObject({ id: chat, archived: false });
    expect(f.calls.filter(call => call === 'mail.work.delete')).toHaveLength(1);
    expect(dialogs).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('Chat handoff rereads an owner correction made in another tab', async ({ browser }) => {
  const f = await setup(browser);
  try {
    const id = await f.follow();
    await f.page.getByRole('button', { name: 'Review with AI', exact: true }).click();
    await expect(f.page.locator('[data-work-updates]')).toContainText('matches the last review');
    const saved = (await f.fixture.service.get(id)).work;
    await f.fixture.service.update({ id, expected_revision: saved.revision,
      owner_notes: 'Client cancelled by phone; do not make an offer.' });
    await f.page.getByRole('button', { name: 'Investigate in Chat', exact: true }).click();
    await expect.poll(() => f.requests.filter(call => call.method === 'chat.send').length).toBe(2);
    const sent = f.requests.filter(call => call.method === 'chat.send').at(-1)!;
    expect(sent.args.message).toContain('Client cancelled by phone; do not make an offer');
    expect(sent.args.message).toContain('Recheck before relying on it');
    expect(f.calls).not.toContain('execute'); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
