import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { PreparePreapproval, PreapprovalResult } from '@recued/contracts';
import { createMailScheduledFollowUpFixture } from '../../../backend/server/src/__tests__/fixtures/mail-scheduled-follow-up-fixture.js';
import { canonicalizeGmail } from '../../../backend/server/src/collections/mail/gmail-provider.js';
import { buildRecord } from '../../../backend/server/src/collections/mail/mail-collection.js';
import { deliveryReportMime } from '../../../backend/server/src/__tests__/fixtures/mail-delivery-report-fixture.js';
import { makeMailFollowUpHandlers } from '../../../backend/server/src/mail-follow-up-rpc-handler.js';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC' });
const editor = (page: Page) => page.getByRole('dialog', { name: 'New mail', exact: true });
const manager = (page: Page) => page.locator('dialog[data-mail-reply-watches]');
const review = (page: Page) => page.locator('[data-recued-preapproval-route]');
const boot = async (page: Page, support = true) => {
  const f = await createMailScheduledFollowUpFixture({ tasks: true }); if (!f.taskFixture) throw Error('Missing task fixture');
  let source = await f.service.start({ ...f.requestMail(), waiting_for: { address: 'alex@example.test', recipients: ['alex@example.test', 'copy@example.test'] } }, f.token.token_id);
  source = await f.service.setTask({ id: source.id, expected_revision: source.revision, request_id: randomUUID(), task_id: f.taskFixture.task.id }, f.principal.validate);
  const msg = await canonicalizeGmail({ id: 'failure', threadId: 'report-thread', labelIds: ['INBOX'], raw: deliveryReportMime({ at: f.now() }).toString('base64url') });
  const { record } = buildRecord(msg, f.now, 'owner@example.test'); f.tables.get('work')!.upsert(record); source = await f.service.check(source.id);
  const requests: PreparePreapproval[] = [], prepared: PreapprovalResult[] = [];
  await page.clock.setFixedTime(new Date(f.now()));
  await page.exposeFunction('__scheduledReplacementRpc', async (method: string, args: unknown) => {
    try {
      if (method === 'events.subscribe') return { result: { cursor: 0 } };
      if (method === 'collection.mail.list') return { result: { instances: [{ slug: 'work', adapter_type: 'imap', send_capable: true, draft_capable: true, auth_state: 'healthy', account_email: 'owner@example.test' }] } };
      if (method === 'server.timezone.get') return { result: { resolved_zone: 'UTC' } };
      const watches = makeMailFollowUpHandlers({ service: f.service, send: f.send(), authorize: () => f.token.token_id })!.handlers;
      const handlers = { ...f.handlers, ...watches } as unknown as Record<string, (args: never, client: typeof f.client) => Promise<unknown>>;
      if (!Object.hasOwn(handlers, method)) return undefined;
      const result = await handlers[method]!(args as never, f.client);
      if (method === 'mail.follow_up.send.capabilities' && !support) return { result: { ...(result as object), scheduled_replacement_task: false } };
      if (method === 'preapproval.prepare') { requests.push(args as PreparePreapproval); prepared.push(result as PreapprovalResult); }
      return { result };
    } catch (cause) { return { error: { code: String((cause as { code?: string }).code ?? 'unavailable'), message: cause instanceof Error ? cause.message : String(cause) } }; }
  });
  await page.addInitScript(() => Object.assign(window, { __connectionsFixture: (method: string, args: unknown) =>
    (window as unknown as { __scheduledReplacementRpc(method: string, args: unknown): Promise<unknown> }).__scheduledReplacementRpc(method, args) }));
  await page.goto(`${HARNESS_URL}?journey=verification&review_clock=browser&server_profiles=multiple#mail/reply-watch/${source.id}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await manager(page).getByRole('button', { name: 'Draft replacement', exact: true }).click();
  await editor(page).locator('[data-form-array-item="to"]').fill('new-alex@example.test');
  await editor(page).getByRole('checkbox', { name: 'Watch for a reply', exact: true }).check();
  await editor(page).getByRole('checkbox', { name: 'Keep tracking “Get revised estimate”', exact: true }).check();
  return { ...f, taskFixture: f.taskFixture, source, report: record, requests, prepared };
};
const schedule = async (page: Page) => {
  await editor(page).getByRole('button', { name: 'Schedule…', exact: true }).click();
  await editor(page).locator('[data-mail-draft-time]').fill('2026-11-24T10:00');
  await editor(page).getByRole('button', { name: 'Review scheduled send', exact: true }).click();
  await expect(editor(page)).toHaveCount(0); await expect(review(page)).toContainText('Keep tracking “Get revised estimate”');
};

test('schedules the reviewed replacement and transfers its task only after the delayed confirmed send and exact Sent sync', async ({ page }) => {
  const f = await boot(page);
  try {
    await schedule(page); await expect(review(page)).toContainText('task stays linked to the original failure');
    expect(f.deliveries).toEqual([]); expect(f.sendStore.activeIds()).toEqual([]);
    await review(page).getByRole('button', { name: 'Say yes and schedule it', exact: true }).click(); await expect(review(page)).toContainText('Execution: active');
    const activation = f.requests[0]!.activation; if (activation.kind !== 'one_shot') throw Error('Expected one-off schedule');
    f.time(activation.run_at + 300000); await f.tick(); expect(f.deliveries).toHaveLength(1); expect(f.deliveries[0]!.message.to).toEqual(['new-alex@example.test']);
    expect((await f.service.getTask({ id: f.source.id })).watch.task_ref).toEqual(f.source.task_ref);
    const [id] = f.sendStore.activeIds(); expect((await f.send().get(id))!.state).toBe('awaiting_sync');
    f.restartSend(); f.syncSent(); await f.send().sweep(); expect((await f.send().get(id))!.state).toBe('armed');
    expect((await f.service.getTask({ id })).watch).toMatchObject({ task_ref: f.source.task_ref, check_at: f.deliveries[0]!.result.sent_at + 172800000 });
    expect((await f.service.getTask({ id: f.source.id })).watch).toMatchObject({ state: 'delivery_failed' });
    expect((await f.service.getTask({ id: f.source.id })).watch.task_ref).toBeUndefined(); expect(f.taskFixture.currentTask()!.done).toBe(false);
    await f.tick(); await f.send().sweep(); expect(f.deliveries).toHaveLength(1);
  } finally { f.dispose(); }
});

test('taking back schedule approval preserves the original task and failure without sending', async ({ page }) => {
  const f = await boot(page);
  try {
    await schedule(page); await review(page).getByRole('button', { name: 'Say yes and schedule it', exact: true }).click(); await expect(review(page)).toContainText('Execution: active');
    await review(page).getByRole('button', { name: 'Take back this yes', exact: true }).click(); await expect(review(page)).toContainText('Execution: cancelled');
    const activation = f.requests[0]!.activation; if (activation.kind !== 'one_shot') throw Error('Expected schedule');
    f.time(activation.run_at); await f.tick(); expect(f.deliveries).toEqual([]); expect(f.sendStore.activeIds()).toEqual([]);
    expect((await f.service.getTask({ id: f.source.id })).watch.task_ref).toEqual(f.source.task_ref); expect(f.taskFixture.currentTask()!.done).toBe(false);
  } finally { f.dispose(); }
});

test('a report changed after scheduling holds task tracking for review after the approved email is sent', async ({ page }) => {
  const f = await boot(page);
  try {
    await schedule(page); await expect(review(page)).toContainText('approved email still follows this schedule');
    await review(page).getByRole('button', { name: 'Say yes and schedule it', exact: true }).click(); await expect(review(page)).toContainText('Execution: active');
    f.tables.get('work')!.delete(f.report.record_id);
    const activation = f.requests[0]!.activation; if (activation.kind !== 'one_shot') throw Error('Expected schedule');
    f.time(activation.run_at); await f.tick(); f.syncSent(); await f.send().sweep();
    await page.evaluate(() => window.__app.setHash('#mail')); await page.getByRole('button', { name: 'Reply watches', exact: true }).click();
    await manager(page).getByRole('button', { name: 'Manage pending watch', exact: true }).click();
    await expect(manager(page)).toContainText('Needs attention'); await expect(manager(page)).toContainText('task tracking changed');
    expect((await f.service.getTask({ id: f.source.id })).watch.task_ref).toEqual(f.source.task_ref); expect(f.taskFixture.currentTask()!.done).toBe(false);
    f.tables.get('work')!.upsert(f.report); f.restartSend(); await f.send().sweep();
    expect((await f.service.list()).watches).toHaveLength(1); expect(f.deliveries).toHaveLength(1);
  } finally { f.dispose(); }
});

test('an older server keeps the selected task and draft intact when scheduled replacement tracking is unavailable', async ({ page }) => {
  const f = await boot(page, false);
  try {
    const body = editor(page).getByRole('textbox', { name: 'Body', exact: true }); await body.fill('Keep these unfinished replacement edits.');
    await editor(page).getByRole('button', { name: 'Schedule…', exact: true }).click();
    await expect(editor(page).getByRole('alert')).toContainText('Turn off task tracking before scheduling');
    await expect(editor(page).getByRole('checkbox', { name: 'Keep tracking “Get revised estimate”', exact: true })).toBeChecked();
    await expect(body).toHaveValue('Keep these unfinished replacement edits.'); expect(f.requests).toEqual([]); expect(f.deliveries).toEqual([]);
  } finally { f.dispose(); }
});
