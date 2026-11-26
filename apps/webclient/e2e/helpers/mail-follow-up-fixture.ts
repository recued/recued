import { createAuditLogStore, createInMemoryCollection, type AuditEntry, type ActivityEntry } from '@recued/storage';
import { createMailFollowUpAlertRuntime, createMailFollowUpAlertStore } from '../../../../backend/server/src/mail-follow-up-alerts.js';
import { createMailFollowUpReplyAlertRuntime, createMailFollowUpReplyAlertStore } from '../../../../backend/server/src/mail-follow-up-reply-alerts.js';
import type { CanonicalMessage } from '../../../../backend/server/src/collections/mail/provider.js';
import { createSQLiteCollection } from '../../../../backend/server/src/sqlite-collection.js';
import type { Page } from '@playwright/test';
import { parseAddress } from '@recued/contracts';
import type { ServerEvent, CollectionListQuery, MailMessageRef, MailConversationRequest, ServerRpcRegistry } from '@recued/contracts';
import { getMailMessage } from '../../../../backend/server/src/collections/mail/message-read.js';
import { getMailConversation } from '../../../../backend/server/src/collections/mail/conversation-read.js';
import { makeMailFollowUpHandlers } from '../../../../backend/server/src/mail-follow-up-rpc-handler.js';
import { createMailFollowUpFixture } from '../../../../backend/server/src/__tests__/fixtures/mail-follow-up-fixture.js';
import { createMailComposeFollowUpFixture } from '../../../../backend/server/src/__tests__/fixtures/mail-compose-follow-up-fixture.js';
import { createMailFollowUpTaskFixture } from '../../../../backend/server/src/__tests__/fixtures/mail-follow-up-task-fixture.js';

/** Real owner handlers, encrypted watches/drafts and retained collection tables.
 * Only transport faults and provider sync progress are controlled. */
export const installMailFollowUpFixture = async (page: Page, options: { verifyMessages?: boolean; compose?: boolean; tasks?: boolean } = {}) => {
  const taskFixture = options.tasks ? await createMailFollowUpTaskFixture() : undefined;
  const f = taskFixture ?? createMailFollowUpFixture();
  const compose = options.compose ? createMailComposeFollowUpFixture(f) : undefined;
  const activities = createSQLiteCollection<ActivityEntry>(f.db, 'reply_alert_browser_activities');
  const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), activities);
  const frames: ServerEvent[] = []; let cursor = 1000, quiet = false;
  const store = createMailFollowUpAlertStore(f.db);
  const makeAlerts = () => createMailFollowUpAlertRuntime({ store, service: f.service, now: f.now,
    auditLog, isQuiet: () => quiet, validateDraft: async watch => {
      await f.drafts.get({ draft_id: watch.draft_id }, f.principal); return () => f.principal.validate();
    },
    notifier: { notify: async (message, _channels, extras) => { frames.push({ kind: 'notification.notify', title: message.title,
      text: message.text, link_url: extras?.ui_link_url ?? message.link_url, activity_id: extras?.persisted_activity_id, cursor: ++cursor }); } },
    update: (message, activity_id, hash) => { frames.push({ kind: 'notification.notify', title: message.title,
      text: message.text, link_url: hash, activity_id, replace_existing: true, cursor: ++cursor }); },
  });
  const alerts = makeAlerts();
  const replyStore = createMailFollowUpReplyAlertStore(f.db);
  const makeReplyAlerts = () => createMailFollowUpReplyAlertRuntime({ store: replyStore, service: f.service, now: f.now,
    auditLog, isQuiet: () => quiet, validateOwner: async () => { f.principal.validate(); return () => f.principal.validate(); },
    notifier: { notify: async (message, _channels, extras) => { frames.push({ kind: 'notification.notify', title: message.title,
      text: message.text, link_url: extras?.ui_link_url ?? message.link_url, activity_id: extras?.persisted_activity_id, cursor: ++cursor }); } },
    update: (message, activity_id, hash) => { frames.push({ kind: 'notification.notify', title: message.title,
      text: message.text, link_url: hash, activity_id, replace_existing: true, cursor: ++cursor }); },
  });
  const replyAlerts = makeReplyAlerts();
  const calls: { method: string; args: unknown }[] = [];
  let lost = false, lostTime = false, lostExecute = false, lostTaskLink = false, lostTaskCreate = false, composeAvailable = true, hold = '', release: (() => void) | undefined, listFailure = false;
  let heldSettled = true;
  let composeCapability: Promise<void> | undefined, releaseComposeCapability: (() => void) | undefined;
  const handlers = makeMailFollowUpHandlers({ service: f.service, ...(compose ? { send: compose.send() } : {}), authorize: () => 'paired-owner' })!.handlers;
  const mailboxes = () => ({ instances: f.instances.list('mail').map(instance => ({ slug: instance.slug,
    adapter_type: 'imap', send_capable: true, draft_capable: true, account_email: 'owner@example.test', auth_state: 'healthy' })) });
  await page.clock.setFixedTime(new Date(f.now()));
  await page.exposeFunction('__replyWatchRpc', async (method: string, raw: unknown) => {
    calls.push({ method, args: structuredClone(raw) });
    const held = method === hold;
    try {
      if (held) { heldSettled = false; hold = ''; await new Promise<void>(done => { release = done; }); }
      const args = (raw ?? {}) as Record<string, unknown>;
      if (method === 'events.subscribe') return { result: { cursor: 0 } };
      if (Object.hasOwn(handlers, method)) {
        if (method === 'mail.follow_up.send.capabilities') await composeCapability;
        if (method === 'mail.follow_up.send.capabilities' && !composeAvailable) return { result: { available: false } };
        if (method === 'mail.follow_up.list' && listFailure) throw new Error('Reply watches are temporarily unavailable.');
        const handler = handlers[method as keyof typeof handlers] as (args: never, client: never) => Promise<unknown>;
        const result = await handler(raw as never, {} as never);
        // This fixture exercises one-off sends; scheduled sends use their
        // own real reviewed-execution fixture and advertise that separately.
        if (method === 'mail.follow_up.send.capabilities') return { result: { ...(result as object), scheduled: false } };
        if (method === 'mail.follow_up.start' && lost) { lost = false; throw new Error('The save response was lost.'); }
        if (method === 'mail.follow_up.reschedule' && lostTime) { lostTime = false; throw new Error('The time change response was lost.'); }
        if (method === 'mail.follow_up.task.set' && lostTaskLink) { lostTaskLink = false; throw new Error('The task link response was lost.'); }
        if (method === 'mail.follow_up.task.create' && lostTaskCreate) { lostTaskCreate = false; throw new Error('The task creation response was lost.'); }
        return { result };
      }
      if (taskFixture && Object.hasOwn(taskFixture.workHandlers, method)) {
        const handler = taskFixture.workHandlers[method as keyof typeof taskFixture.workHandlers] as (args: never, client: never) => Promise<unknown>;
        return { result: await handler(raw as never, taskFixture.client as never) };
      }
      if (taskFixture && method === 'work_entity.source.list') return { result: { sources: taskFixture.taskStore.listSources() } };
      if (method === 'notification.recent') return { result: { notifications: (await activities.list()).map(row => ({
        id: row.activity_id, fired_at: row.timestamp, ...JSON.parse(row.detail!) })) } };
      if (method === 'server.timezone.get') return { result: { resolved_zone: 'America/Los_Angeles' } };
      if (method === 'collection.listInstances') return { result: { instances: f.instances.list('mail') } };
      if (method === 'collection.list') return { result: { records: f.tables.get(String(args.slug))?.list(raw as CollectionListQuery) ?? [] } };
      if (method === 'collection.get') return { result: { record: f.tables.get(String(args.slug))?.get(String(args.record_id)) ?? null } };
      if (method === 'collection.mail.list') return { result: mailboxes() };
      if (method === 'collection.mail.conversation.get') return { result: getMailConversation({ getCollection: f.mailbox,
        getIncarnation: slug => f.instances.getIncarnation!('mail', slug) }, raw as MailConversationRequest) };
      if (method === 'collection.mail.message.get') {
        const mailbox = f.mailbox(String(args.slug));
        const collection = mailbox ? { ...mailbox, provider: options.verifyMessages ? {
          fetchMessage: async (sourceId: string): Promise<CanonicalMessage | null> => {
            const row = mailbox.list({ platform: 'mail', slug: String(args.slug), limit: 100 }).find(item => item.source_id === sourceId);
            if (!row) return null;
            const hot = row.hot_fields;
            return { source_id: row.source_id, rfc_message_id: String(hot.rfc_message_id),
              from: parseAddress(String(hot.from))?.email ?? '', to: hot.to as string[], cc: hot.cc as string[],
              subject: String(hot.subject), body_text: row.body_inline ?? '', thread_id: String(hot.thread_id),
              folder_or_label: String(hot.folder), direction: hot.direction as 'inbound' | 'outbound', is_read: true, is_flagged: false,
              has_attachments: false, received_at: row.received_at, headers: { references: '<sent-1@example.test>' } };
          },
        } : {} } : undefined;
        return { result: await getMailMessage({ getCollection: () => collection,
          getIncarnation: slug => f.instances.getIncarnation!('mail', slug), listMailInstances: async () => mailboxes(),
        }, raw as MailMessageRef) };
      }
      if (method === 'collection.mail.message.attachments') return { result: { slug: args.slug, record_id: args.record_id,
        incarnation: f.instances.getIncarnation!('mail', String(args.slug)), items: [], warnings: [], truncated: false } };
      if (method === 'mail.drafts.get') return { result: await f.drafts.get(raw, f.principal) };
      if (method === 'mail.drafts.list') return { result: await f.drafts.list(raw, f.principal) };
      if (method === 'mail.drafts.update') return { result: await f.drafts.update(raw, f.principal) };
      if (method === 'mail.drafts.delete') return { result: f.drafts.delete(raw, f.principal) };
      if (method === 'mail.drafts.create') return { result: await f.drafts.create(raw, f.principal) };
      if (method === 'execute') {
        if (!compose) throw new Error('This journey must not send an email.');
        const result = await compose.execute(raw as ServerRpcRegistry['execute']['request']);
        if (lostExecute) { lostExecute = false; throw new Error('The execution response was lost.'); }
        return { result };
      }
      return undefined;
    } catch (error) {
      return { error: { code: String((error as { code?: string }).code ?? 'unavailable'), message: error instanceof Error ? error.message : String(error) } };
    } finally {
      if (held) heldSettled = true;
    }
  });
  await page.addInitScript(() => Object.assign(window, { __connectionsFixture: (method: string, args: ServerRpcRegistry[keyof ServerRpcRegistry]['request']) =>
    (window as unknown as { __replyWatchRpc(method: string, args: unknown): Promise<unknown> }).__replyWatchRpc(method, args) }));
  return { ...f, calls, compose, taskFixture, alerts, makeAlerts, replyAlerts, makeReplyAlerts, frames, activities,
    loseTaskLinkReply: () => { lostTaskLink = true; },
    loseTaskCreateReply: () => { lostTaskCreate = true; },
    loseExecuteReply: () => { lostExecute = true; }, composeAvailable: (value: boolean) => { composeAvailable = value; },
    holdComposeCapability: () => { composeCapability = new Promise<void>(done => { releaseComposeCapability = done; }); },
    releaseComposeCapability: () => { composeCapability = undefined; releaseComposeCapability?.(); releaseComposeCapability = undefined; },
    quiet: (value: boolean) => { quiet = value; },
    flushAlerts: async () => { const queued = frames.splice(0); await page.evaluate(events => {
      for (const event of events) window.__app.fireMessage({ type: 'server_event', event });
    }, queued); }, loseStartReply: () => { lost = true; }, loseTimeReply: () => { lostTime = true; }, hold: (method: string) => { hold = method; },
    isHeld: () => release !== undefined,
    heldSettled: () => heldSettled,
    release: () => { const done = release; release = undefined; done?.(); },
    failList: (value: boolean) => { listFailure = value; },
    dispose: () => { release?.(); void alerts.stop(); void replyAlerts.stop(); f.dispose(); },
  };
};
