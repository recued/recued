import { expect, test, type Locator, type Page } from '@playwright/test';
import type { CollectionListQuery, MailConversationRequest, MailMessageRef, PreparePreapproval } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { createMailScheduledFollowUpFixture, prepareLinkedFollowUpDraft } from '../../../backend/server/src/__tests__/fixtures/mail-scheduled-follow-up-fixture.js';
import { makeMailFollowUpHandlers } from '../../../backend/server/src/mail-follow-up-rpc-handler.js';
import { getMailMessage } from '../../../backend/server/src/collections/mail/message-read.js';
import { getMailConversation } from '../../../backend/server/src/collections/mail/conversation-read.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC' });
const editor = (page: Page) => page.getByRole('dialog', { name: 'New mail', exact: true });
const replyEditor = (page: Page) => page.getByRole('dialog', { name: 'Reply', exact: true });
const manager = (page: Page) => page.locator('dialog[data-mail-reply-watches]');
const review = (page: Page) => page.locator('[data-recued-preapproval-route]');
const boot = async (page: Page, options: { linkedTask?: boolean; replacementOnly?: boolean } = {}) => {
  const f = await createMailScheduledFollowUpFixture({ tasks: options.linkedTask });
  const linked = options.linkedTask ? await prepareLinkedFollowUpDraft(f) : undefined;
  const requests: PreparePreapproval[] = [];
  const mailboxes = () => ({ instances: [{ slug: 'work', adapter_type: 'imap' as const, send_capable: true, draft_capable: true,
    auth_state: 'healthy' as const, account_email: 'owner@example.test' }] });
  await page.clock.setFixedTime(new Date(f.now()));
  await page.exposeFunction('__scheduledWatchRpc', async (method: string, args: unknown) => {
    try {
      if (method === 'events.subscribe') return { result: { cursor: 0 } };
      if (method === 'collection.mail.list') return { result: mailboxes() };
      if (method === 'collection.listInstances') return { result: { instances: f.instances.list('mail') } };
      if (method === 'collection.list' && (args as CollectionListQuery).platform === 'mail')
        return { result: { records: f.tables.get((args as CollectionListQuery).slug)?.list(args as CollectionListQuery) ?? [] } };
      if (method === 'collection.get') {
        const { slug, record_id } = args as MailMessageRef;
        const record = f.tables.get(slug)?.get(record_id);
        if (record) return { result: { record } };
      }
      const getIncarnation = (slug: string) => f.instances.getIncarnation!('mail', slug);
      if (method === 'collection.mail.conversation.get')
        return { result: getMailConversation({ getCollection: f.mailbox, getIncarnation }, args as MailConversationRequest) };
      if (method === 'collection.mail.message.get') {
        const input = args as MailMessageRef;
        const box = f.mailbox(input.slug);
        const collection = box ? { ...box, provider: {} } : undefined;
        return { result: await getMailMessage({ getCollection: () => collection, getIncarnation, listMailInstances: async () => mailboxes() }, input) };
      }
      if (method === 'server.timezone.get') return { result: { resolved_zone: 'UTC' } };
      const watches = makeMailFollowUpHandlers({ service: f.service, send: f.send(), authorize: () => f.token.token_id })!.handlers;
      const handlers = { ...f.handlers, ...watches } as unknown as Record<string, (args: never, client: typeof f.client) => Promise<unknown>>;
      if (Object.hasOwn(handlers, method)) {
        if (method === 'mail.follow_up.send.capabilities' && options.replacementOnly)
          return { result: { available: true, scheduled: true, waiting_for: true, scheduled_replacement_task: true } };
        if (method === 'preapproval.prepare') requests.push(args as PreparePreapproval);
        return { result: await handlers[method]!(args as never, f.client) };
      }
      return undefined;
    } catch (cause) { return { error: { code: String((cause as { code?: string }).code ?? 'unavailable'), message: cause instanceof Error ? cause.message : String(cause) } }; }
  });
  await page.addInitScript(() => Object.assign(window, { __connectionsFixture: (method: string, args: unknown) =>
    (window as unknown as { __scheduledWatchRpc(method: string, args: unknown): Promise<unknown> }).__scheduledWatchRpc(method, args) }));
  const hash = linked ? '#mail/reply-watch/' + linked.watch.id : '#mail';
  await page.goto(`${HARNESS_URL}?journey=verification&review_clock=browser&server_profiles=multiple${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  if (linked) {
    await manager(page).getByRole('button', { name: 'Open saved draft', exact: true }).click();
    await replyEditor(page).getByRole('checkbox', { name: 'Watch for a reply', exact: true }).check();
  }
  return { ...f, linked, requests };
};
const reviewSchedule = async (dialog: Locator) => {
  await dialog.getByRole('button', { name: 'Schedule…', exact: true }).click();
  await dialog.locator('[data-mail-draft-time]').fill('2026-11-24T10:00');
  await dialog.getByRole('button', { name: 'Review scheduled send', exact: true }).click();
  await expect(dialog).toHaveCount(0);
};
const schedule = async (page: Page) => {
  await page.getByRole('button', { name: 'New mail', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Add To', exact: true }).click();
  await editor(page).locator('[data-form-array-item="to"]').first().fill('alex@example.test');
  await editor(page).locator('[data-form-field="subject"]').fill('Scheduled renewal');
  await editor(page).getByRole('textbox', { name: 'Body', exact: true }).fill('Please confirm the revised renewal.');
  await editor(page).getByRole('checkbox', { name: 'Watch for a reply', exact: true }).check();
  await editor(page).getByRole('combobox', { name: 'Reply check interval', exact: true }).selectOption('172800000');
  await editor(page).getByRole('checkbox', { name: 'Notify me when a reply arrives', exact: true }).check();
  await reviewSchedule(editor(page));
  await expect(review(page)).toContainText('48 hours after this email is actually sent');
};

test('the scheduled composer keeps its message, delivery choices and focus through desktop and phone layouts', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  const f = await boot(page);
  try {
    await page.getByRole('button', { name: 'New mail', exact: true }).click();
    const dialog = editor(page);
    const recipient = (name: 'to' | 'cc' | 'bcc') => dialog.locator(`[data-form-array-item="${name}"]`).first();
    const subject = dialog.locator('[data-form-field="subject"]');
    const body = dialog.getByRole('textbox', { name: 'Body', exact: true });
    const watch = dialog.getByRole('checkbox', { name: 'Watch for a reply', exact: true });
    const interval = dialog.getByRole('combobox', { name: 'Reply check interval', exact: true });
    const notify = dialog.getByRole('checkbox', { name: 'Notify me when a reply arrives', exact: true });
    await dialog.getByRole('button', { name: 'Add To', exact: true }).click();
    await recipient('to').fill('alex@example.test');
    await dialog.getByText('Cc and Bcc', { exact: true }).click();
    await dialog.getByRole('button', { name: 'Add Cc', exact: true }).click();
    await recipient('cc').fill('colleague@example.test');
    await dialog.getByRole('button', { name: 'Add Bcc', exact: true }).click();
    await recipient('bcc').fill('private@example.test');
    await subject.fill('Scheduled renewal');
    await body.fill('Please confirm the revised renewal.');
    await watch.check();
    await interval.selectOption('3600000');
    await notify.check();

    await dialog.getByRole('button', { name: 'Schedule…', exact: true }).click();
    const sendAt = dialog.locator('[data-mail-draft-time]');
    await sendAt.fill('2026-11-24T10:00');
    await interval.focus();
    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 800 }]) {
      await page.setViewportSize(viewport);
      await expect(interval).toBeFocused();
      await expect(sendAt).toHaveValue('2026-11-24T10:00');
      await expect(recipient('to')).toHaveValue('alex@example.test');
      await expect(recipient('cc')).toHaveValue('colleague@example.test');
      await expect(recipient('bcc')).toHaveValue('private@example.test');
      await expect(subject).toHaveValue('Scheduled renewal');
      await expect(body).toHaveValue('Please confirm the revised renewal.');
      await expect(watch).toBeChecked();
      await expect(interval).toHaveValue('3600000');
      await expect(notify).toBeChecked();
    }

    await dialog.getByRole('button', { name: 'Back to message', exact: true }).press('Enter');
    await expect(dialog.getByRole('button', { name: 'Schedule…', exact: true })).toBeFocused();
    await expect(body).toHaveValue('Please confirm the revised renewal.');
    await expect(watch).toBeChecked();
    expect(f.requests).toEqual([]);
    expect(f.deliveries).toEqual([]);
  } finally { f.dispose(); }
});

test('reviews a scheduled follow-up and counts from the delayed confirmed send through Sent sync and restart', async ({ page }) => {
  const f = await boot(page);
  try {
    await schedule(page); await expect(review(page)).toContainText('Notify you when a recipient replies');
    expect(f.sendStore.activeIds()).toEqual([]); expect(f.deliveries).toEqual([]);
    await review(page).getByRole('button', { name: 'Say yes and schedule it', exact: true }).click(); await expect(review(page)).toContainText('Execution: active');
    const activation = f.requests[0]!.activation; if (activation.kind !== 'one_shot') throw Error('Missing one-off schedule');
    f.time(activation.run_at + 5 * 60000); await page.clock.setFixedTime(new Date(f.now())); await f.tick();
    expect(f.deliveries).toHaveLength(1); expect((await f.service.list()).watches).toEqual([]);
    await page.evaluate(() => window.__app.setHash('#mail')); await page.getByRole('button', { name: 'Reply watches', exact: true }).click();
    const dialog = page.locator('dialog[data-mail-reply-watches]'); await dialog.getByRole('button', { name: 'Manage pending watch', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('Waiting for Sent sync');
    f.restartSend(); f.syncSent(); await dialog.getByRole('button', { name: 'Refresh reply watch request', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('Waiting for a reply');
    const [watch] = (await f.service.list()).watches; expect(watch!.check_at).toBe(f.deliveries[0]!.result.sent_at + 172800000);
    await f.tick(); await f.send().sweep(); expect(f.deliveries).toHaveLength(1); expect((await f.service.list()).watches).toHaveLength(1);
  } finally { f.dispose(); }
});

test('taking back approval for a scheduled watched email leaves no delivery or active watch', async ({ page }) => {
  const f = await boot(page);
  try {
    await schedule(page); await review(page).getByRole('button', { name: 'Say yes and schedule it', exact: true }).click(); await expect(review(page)).toContainText('Execution: active');
    await review(page).getByRole('button', { name: 'Take back this yes', exact: true }).click(); await expect(review(page)).toContainText('Execution: cancelled');
    const activation = f.requests[0]!.activation; if (activation.kind !== 'one_shot') throw Error('Missing one-off schedule');
    f.time(activation.run_at); await f.tick(); expect(f.deliveries).toEqual([]); expect(f.sendStore.activeIds()).toEqual([]); expect((await f.service.list()).watches).toEqual([]);
  } finally { f.dispose(); }
});

test('schedules the saved follow-up and moves its selected task after Sent sync in the same conversation', async ({ page }) => {
  const f = await boot(page, { linkedTask: true });
  try {
    const { watch, draft } = f.linked!;
    const task = f.taskFixture!.currentTask();
    const keepTask = replyEditor(page).getByRole('checkbox', { name: 'Keep tracking “Get revised estimate”', exact: true });
    await expect(keepTask).not.toBeChecked();
    await keepTask.check();
    await reviewSchedule(replyEditor(page));
    await expect(review(page)).toContainText(/even if someone replies first[\s\S]*Watch for a reply[\s\S]*Keep tracking “Get revised estimate”/);
    await expect(review(page)).toContainText('the task stays linked to its current reply watch');
    await review(page).getByRole('button', { name: 'Say yes and schedule it', exact: true }).click();
    await expect(review(page)).toContainText('Execution: active');
    const request = f.requests[0]!;
    expect(request.subject).toMatchObject({ kind: 'mail_draft', draft_id: draft.draft_id });
    if (request.activation.kind !== 'one_shot') throw new Error('Missing one-off schedule');
    expect(request.activation.run_at).toBe(Date.parse('2026-11-24T10:00:00Z'));
    f.time(request.activation.run_at - 1);
    await f.tick();
    expect(f.deliveries).toEqual([]);
    expect((await f.service.getTask({ id: watch.id })).watch.task_ref).toEqual(watch.task_ref);

    f.time(request.activation.run_at + 300000);
    await f.tick();
    expect(f.deliveries).toHaveLength(1);
    expect(f.deliveries[0]!.message.in_reply_to).toBe(f.seed.hot_fields.rfc_message_id);
    const [id] = f.sendStore.activeIds();
    expect((await f.send().get(id))?.state).toBe('awaiting_sync');
    expect((await f.service.getTask({ id: watch.id })).watch.task_ref).toEqual(watch.task_ref);
    f.restartSend();
    f.syncSent(0, String(f.seed.hot_fields.thread_id));
    await f.send().sweep();
    expect((await f.send().get(id))?.state).toBe('armed');
    const original = (await f.service.getTask({ id: watch.id })).watch;
    expect(original).toMatchObject({ state: 'superseded', draft_id: draft.draft_id });
    expect(original.task_ref).toBeUndefined();
    expect((await f.service.taskLinks({ tasks: [watch.task_ref!] })).links).toMatchObject([{
      watch: { id, state: 'waiting', check_at: f.deliveries[0]!.result.sent_at + 172800000 },
    }]);
    expect(f.taskFixture!.currentTask()).toEqual(task);
  } finally { f.dispose(); }
});

test('an older server with replacement scheduling keeps ordinary task consent and edits if Schedule is unavailable', async ({ page }) => {
  const f = await boot(page, { linkedTask: true, replacementOnly: true });
  try {
    const dialog = replyEditor(page);
    const keepTask = dialog.getByRole('checkbox', { name: 'Keep tracking “Get revised estimate”', exact: true });
    const body = dialog.getByRole('textbox', { name: 'Body', exact: true });
    await keepTask.check();
    await body.fill('Follow up on the revised estimate.');
    await dialog.getByRole('button', { name: 'Schedule…', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Turn off task tracking before scheduling');
    await expect(keepTask).toBeChecked();
    await expect(body).toHaveValue('Follow up on the revised estimate.');
    expect(f.requests).toEqual([]);
    await keepTask.uncheck();
    await dialog.getByRole('button', { name: 'Schedule…', exact: true }).click();
    await expect(dialog.locator('[data-mail-draft-time]')).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: 'Skip if they’ve replied', exact: true })).toHaveCount(0);
  } finally { f.dispose(); }
});

test('reviews each send stage by keyboard on a short phone and opens the reply that skipped the send', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 500 });
  const nextControl = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
  const f = await boot(page, { linkedTask: true });
  try {
    const { watch } = f.linked!;
    const dialog = replyEditor(page);
    const scheduleButton = dialog.getByRole('button', { name: 'Schedule…', exact: true });
    const sendTime = dialog.getByRole('group', { name: 'Before sending', exact: true }).getByLabel('Send at', { exact: true });
    const skip = dialog.getByRole('group', { name: 'Before sending', exact: true })
      .getByRole('checkbox', { name: 'Skip if they’ve replied', exact: true });
    const after = dialog.getByRole('group', { name: 'After sending', exact: true });
    const watchChoice = after.getByRole('checkbox', { name: 'Watch for a reply', exact: true });
    const notify = after.getByRole('checkbox', { name: 'Notify me when a reply arrives', exact: true });
    const keepTask = dialog.getByRole('group', { name: 'After Sent verification', exact: true })
      .getByRole('checkbox', { name: 'Keep tracking “Get revised estimate”', exact: true });
    const reviewButton = dialog.getByRole('button', { name: 'Review scheduled send', exact: true });
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    const back = dialog.getByRole('button', { name: 'Back to message', exact: true });
    await expect(skip).toHaveCount(0);
    await expect(watchChoice).toBeChecked();

    await scheduleButton.focus();
    await page.keyboard.press('Enter');
    await expect(sendTime).toBeFocused();
    await expect(sendTime).toBeInViewport({ ratio: 1 });
    await expect(skip).not.toBeChecked();
    await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
    await reviewButton.focus();
    await page.keyboard.press('Enter');
    const invalidTime = dialog.getByRole('alert').filter({ hasText: 'Choose a future send time.' });
    await expect(invalidTime).toBeInViewport({ ratio: 1 });
    await expect(reviewButton).toBeFocused();
    await sendTime.fill('2026-11-24T10:00');
    await skip.focus();
    await page.keyboard.press('Space');
    await expect(skip).toBeChecked();
    await page.keyboard.press(nextControl);
    await expect(watchChoice).toBeFocused();
    await expect(watchChoice).toBeInViewport({ ratio: 1 });
    await expect(after.getByRole('combobox', { name: 'Reply check interval', exact: true })).toHaveValue('172800000');
    await expect(after.getByRole('combobox', { name: 'Waiting for', exact: true })).toHaveValue('');

    await notify.focus();
    await page.keyboard.press('Space');
    await expect(notify).toBeChecked();
    await expect(notify).toBeFocused();
    await expect(notify).toBeInViewport({ ratio: 1 });
    await page.keyboard.press(nextControl);
    await expect(keepTask).toBeFocused();
    await page.keyboard.press('Space');
    await expect(keepTask).toBeChecked();
    await expect(keepTask).toBeFocused();
    await expect(keepTask).toBeInViewport({ ratio: 1 });
    await expect(cancel).toBeInViewport({ ratio: 1 });
    await expect(reviewButton).toBeInViewport({ ratio: 1 });

    await back.focus();
    await page.keyboard.press('Enter');
    await expect(scheduleButton).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await page.keyboard.press('Enter');
    await expect(sendTime).toHaveValue('2026-11-24T10:00');
    await expect(skip).toBeChecked();
    await expect(keepTask).toBeChecked();
    await back.focus();
    await page.keyboard.press(nextControl);
    await expect(cancel).toBeFocused();
    await page.keyboard.press(nextControl);
    await expect(reviewButton).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.subject).toMatchObject({ send_if_no_reply: true });
    await expect(review(page)).toContainText(/Skip if they’ve replied[\s\S]*Watch for a reply[\s\S]*Keep tracking “Get revised estimate”/);
    await expect(review(page)).toContainText('Notify you when a recipient replies.');
    await review(page).getByRole('button', { name: 'Say yes and schedule it', exact: true }).click();
    await expect(review(page)).toContainText('Execution: active');
    const activation = f.requests[0]!.activation;
    if (activation.kind !== 'one_shot') throw new Error('Missing one-off schedule');
    f.time(activation.run_at - 60_000);
    f.add({ body_inline: 'We received the estimate and can proceed.', hot_fields: { subject: 'Estimate accepted' } });
    f.time(activation.run_at);
    await f.tick();
    await review(page).getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(review(page)).toContainText('Execution: Skipped');
    await expect(review(page)).toContainText('Skipped because a recipient replied');
    expect(f.deliveries).toEqual([]);
    expect((await f.service.getTask({ id: watch.id })).watch.task_ref).toEqual(watch.task_ref);
    await review(page).getByRole('button', { name: 'Open received reply', exact: true }).click();
    await expect(page).toHaveURL(/#data\/mail\/record\/work\/reply-1$/);
    await expect(page.getByRole('article', { name: 'Email message', exact: true })).toContainText('We received the estimate and can proceed.');
  } finally { f.dispose(); }
});
