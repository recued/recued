import { expect, test, type Page } from '@playwright/test';
import type { CollectionListQuery, MailDraft, MailMessageSnapshot, MailMessageStateChange, MailMessageAttachmentsSnapshot } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installSearchEverywhereFixture } from './helpers/search-everywhere-fixture.js';
import type { MailRecoveryEntry } from '../src/mail/compose-recovery.js';

installFullAppHooks();
const field = (page: Page, name: string) => page.locator(`[data-form-field="${name}"]`);
const brief = (page: Page) => page.locator('[data-mail-compose-ai-brief]');
const dialog = (page: Page) => page.getByRole('dialog', { name: /Reply|Forward|New mail/ });

const boot = async (page: Page, opts: { sending?: boolean; thread?: boolean; historyFails?: boolean; messageCount?: number; group?: boolean; forwarding?: boolean; triage?: 'writable' | 'read_only'; attachments?: boolean; durableProfile?: boolean; inbox?: boolean } = {}): Promise<void> => {
  const { sending = true, thread = false, historyFails = false, messageCount = 3, group = false, forwarding = true, attachments = false } = opts;
  await page.addInitScript(({ sending, thread, historyFails, messageCount, group, forwarding, triage, attachments, inbox }) => {
    let canSend = sending, held = false, fail = false, sendHeld = false;
    let groupReply = group, copyRecipient = 'copy@example.test', replyMailbox = 'owner@example.test';
    let senderMailbox = 'owner@example.test';
    let sendOutcome: 'held' | 'sent' | 'lost' | 'incomplete' = 'held';
    let forwardAvailable = forwarding, partialBody = false, originalAttachments = attachments;
    let originalBody = 'Please review the revised scope. Can you confirm the delivery date?';
    const recipients = () => groupReply ? ['owner@example.test', 'colleague@example.test', 'DESK@example.test'] : ['owner@example.test'];
    const copies = () => groupReply ? [copyRecipient, 'COLLEAGUE@example.test', 'OWNER@example.test'] : ['copy@example.test'];
    let release: (() => void) | undefined;
    let releaseSend: (() => void) | undefined;
    let holdMailbox = false, mailboxReplies = 0, releaseMailbox: (() => void) | undefined;
    let saved: MailDraft | null = null;
    const executions: Array<{ recipe_id: string; config: Record<string, unknown> }> = [];
    const stateChanges: MailMessageStateChange[] = [];
    const remoteFlags = new Map<string, { is_read: boolean; is_flagged: boolean }>();
    const confirmedFlags = new Map<string, { is_read: boolean; is_flagged: boolean }>();
    const messageAccess = new Map<string, { mark: boolean; star: boolean }>();
    const messageIdentities = new Map<string, string>();
    let stateReadFails = false, loseStateResponse = false, holdState = false;
    let releaseState: (() => void) | undefined;
    const flags = (id: string) => remoteFlags.get(id) ?? { is_read: false, is_flagged: false };
    const messageState = (id: string) => {
      if (!stateReadFails) confirmedFlags.set(id, { ...flags(id) });
      return { identity: messageIdentities.get(id) ?? 'a'.repeat(64), ...(confirmedFlags.get(id) ?? { is_read: false, is_flagged: false }),
        verified: !stateReadFails, can_mark: triage === 'writable' && !stateReadFails && (messageAccess.get(id)?.mark ?? true),
        can_flag: triage === 'writable' && !stateReadFails && (messageAccess.get(id)?.star ?? true),
        ...(triage === 'read_only' ? { unavailable_reason: 'This mailbox is read-only. Mail editing access can be changed in Connections.' }
          : stateReadFails ? { unavailable_reason: 'Email status could not be checked. Refresh this email before changing it.' } : {}) };
    };
    const anchorSnapshot = (): MailMessageSnapshot => ({ slug: 'work', record_id: 'mail-1',
      from: 'lead@example.test', to: recipients(), cc: copies(), subject: 'Delivery date',
      received_at: 1_700_000_000_000,
      body: originalBody, body_truncated: partialBody, read: 'provider',
      reply: canSend ? { original_source_id: 'work', ...(groupReply ? { mailbox_address: replyMailbox } : {}), original_message: {
        id: '<request@example.test>', from: 'lead@example.test', subject: 'Delivery date',
        reply_to: ['desk@example.test'], references: ['<root@example.test>'],
        ...(groupReply ? { to: recipients(), cc: copies() } : {}),
        body: originalBody,
      } } : null,
      ...(!canSend ? { reply_unavailable_reason: 'Sending is unavailable for this mailbox. Enable sending in Connections to reply.' } : {}),
    });
    const snapshot = (id = 'mail-1'): MailMessageSnapshot => {
      const base = anchorSnapshot();
      const sent = id === 'mail-2';
      const body = sent ? 'I have reviewed the scope and sent a proposed date.' : id === 'mail-0' ? 'Original conversation context.' : Number(id.slice(5)) >= 4 ? `Update from message ${id.slice(5)}.` : 'The revised date is Friday. Please confirm.';
      let selected: MailMessageSnapshot = id === 'mail-1' ? base : { ...base, record_id: id, body, received_at: base.received_at + (id === 'mail-0' ? -1 : Number(id.slice(5))),
        from: sent ? 'owner@example.test' : id === 'mail-0' ? 'Customer operations and project delivery <delivery-coordination@example.test>' : 'lead@example.test',
        subject: id === 'mail-0' ? 'Delivery date and review of the revised scope, dependencies, and final confirmation for Friday' : base.subject, to: sent ? ['lead@example.test'] : ['owner@example.test'],
        reply: sent || !canSend ? null : { original_source_id: 'work', original_message: {
          id: `<${id}@example.test>`, from: 'lead@example.test', subject: 'Delivery date', body,
          reply_to: ['lead@example.test'], references: ['<request@example.test>'],
        } }, ...(sent ? { reply_unavailable_reason: 'Reply is available on received email.' } : {}),
      };
      if (inbox) selected = { ...selected, subject: `Inbox message ${Number(id.slice(5))}`,
        received_at: base.received_at + Math.floor(Number(id.slice(5)) / 4) };
      return { ...selected, ...(triage ? { state: messageState(id) } : {}), ...(forwardAvailable ? {
        forward: canSend && !partialBody ? { original_source_id: 'work', mailbox_address: replyMailbox,
          original_message: { from: selected.from, to: selected.to, cc: selected.cc, subject: selected.subject,
            received_at: selected.received_at, body: selected.body!, body_truncated: false, has_attachments: originalAttachments },
        } : null,
        ...(!canSend ? { forward_unavailable_reason: 'Sending is unavailable for this mailbox.' }
          : partialBody ? { forward_unavailable_reason: 'Forward requires the full email text. This long email is only partially loaded.' } : {}),
      } : {}) };
    };
    const record = { record_id: 'mail-1', source_id: 'provider-mail-1', received_at: 1_700_000_000_000,
      modified_at: 1_700_000_000_000, size_bytes: 80, body_inline: snapshot().body,
      hot_fields: { subject: 'Delivery date', from: 'lead@example.test', to: ['owner@example.test'], cc: [],
        direction: 'inbound', folder: 'INBOX', is_read: true, has_attachments: attachments, message_id: 'provider-mail-1', rfc_message_id: 'request@example.test' } };
    const records = inbox ? Array.from({ length: 65 }, (_, index) => {
      const n = index + 1, id = `mail-${n}`;
      const flags = { is_read: n % 3 === 0, is_flagged: n % 7 === 0 };
      remoteFlags.set(id, flags); confirmedFlags.set(id, flags);
      return { ...record, record_id: id, source_id: `provider-${id}`,
        received_at: record.received_at + Math.floor(n / 4), hot_fields: { ...record.hot_fields, ...flags,
          subject: `Inbox message ${n}`, direction: n % 5 === 0 ? 'outbound' : 'inbound', has_attachments: n % 4 === 0 } };
    }) : [record, ...(thread ? [...Array.from({ length: messageCount - 1 }, (_, index) => `mail-${index + 2}`), 'mail-0'].map(id => {
      const message = snapshot(id);
      return { ...record, record_id: id, source_id: `provider-${id}`, received_at: message.received_at,
        body_inline: message.body, hot_fields: { ...record.hot_fields, from: message.from, to: message.to, subject: message.subject,
          direction: id === 'mail-2' ? 'outbound' : 'inbound', folder: id === 'mail-2' ? 'Sent' : 'INBOX',
          thread_id: 'delivery-thread', is_read: id !== 'mail-3' } };
    }) : [])];
    const listRequests: CollectionListQuery[] = [];
    let listFail = false, listHold = false, ignoredPaging = false;
    let releaseList: (() => void) | undefined;
    Object.assign(window, { __mailInbox: { requests: listRequests,
      failNext() { listFail = true; }, holdNext() { listHold = true; }, ignorePaging() { ignoredPaging = true; },
      pending() { return releaseList !== undefined; },
      release() { if (!releaseList) throw new Error('No list is waiting'); const done = releaseList; releaseList = undefined; done(); },
    } });
    const reads: Array<{ record_id: string; conversation?: unknown }> = [];
    const heldReads = new Set<string>();
    const releases = new Map<string, () => void>();
    let failOlder = false, historyFailure = historyFails, holdConversation = false;
    let releaseConversation: (() => void) | undefined;
    const recordWithFlags = (row: typeof record) => triage ? { ...row,
      hot_fields: { ...row.hot_fields, ...(confirmedFlags.get(row.record_id) ?? { is_read: false, is_flagged: false }) } } : row;
    const conversationItem = (row: typeof record) => ({ ...row, ...recordWithFlags(row).hot_fields, snippet: row.body_inline?.slice(0, 160) ?? '', has_attachments: inbox ? row.hot_fields.has_attachments : attachments && row.record_id === 'mail-1' });
    const attachmentReads: string[] = [], previewReads: string[] = [];
    let attachmentHold = false, attachmentRelease: (() => void) | undefined, attachmentFailure = false, attachmentName = 'Invoice.txt', attachmentIncarnation = 'work-v1';
    const primaryFile = 'file:' + '1'.repeat(32), officeFile = 'file:' + '2'.repeat(32), missingFile = 'file:' + '3'.repeat(32), laterFile = 'file:' + '4'.repeat(32);
    const content = (id: string) => id === officeFile ? 'Office document.' : id === laterFile ? 'Later message attachment.' : 'Invoice INV-42\nTotal: 25 EUR';
    const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const attachmentControls = { reads: attachmentReads, previewReads,
      holdNext() { attachmentHold = true; }, pending() { return attachmentRelease !== undefined; },
      release() { if (!attachmentRelease) throw new Error('No attachment read is waiting.'); const done = attachmentRelease; attachmentRelease = undefined; done(); },
      fail(value: boolean) { attachmentFailure = value; }, rename() { attachmentName = 'Revised.txt'; }, replaceMailbox() { attachmentIncarnation = 'work-v2'; },
    };
    Object.assign(window, { __mailAttachments: attachmentControls, __mailCompose: { executions, reads, stateChanges,
      failStateRead(value: boolean) { stateReadFails = value; },
      setMessageAccess(id: string, value: { mark: boolean; star: boolean }) { messageAccess.set(id, value); },
      setMessageIdentity(id: string, value: string) { messageIdentities.set(id, value); },
      setRemoteFlags(id: string, value: { is_read: boolean; is_flagged: boolean }) { remoteFlags.set(id, value); },
      loseStateResponse() { loseStateResponse = true; },
      holdState() { holdState = true; },
      releaseState() { if (!releaseState) throw new Error('No email change is waiting.'); const done = releaseState; releaseState = undefined; done(); },
      holdMessage(id: string) { heldReads.add(id); },
      releaseMessage(id: string) { const done = releases.get(id); if (!done) throw new Error('No email read is waiting.'); releases.delete(id); done(); },
      failOlder() { failOlder = true; },
      recoverHistory() { historyFailure = false; },
      holdConversation() { holdConversation = true; },
      releaseConversation() { if (!releaseConversation) throw new Error('No conversation read is waiting.'); const done = releaseConversation; releaseConversation = undefined; done(); },
      setSending(value: boolean) { canSend = value; },
      setGroup(value: boolean) { groupReply = value; },
      setCopyRecipient(value: string) { copyRecipient = value; },
      setReplyMailbox(value: string) { replyMailbox = value; },
      setSenderMailbox(value: string) { senderMailbox = value; },
      setSendOutcome(value: typeof sendOutcome) { sendOutcome = value; },
      reviseSaved() { if (!saved) throw new Error('No saved draft'); saved.revision++; saved.content.body = 'A newer server edit.'; },
      setForwarding(value: boolean) { forwardAvailable = value; },
      setPartialBody(value: boolean) { partialBody = value; },
      setOriginalBody(value: string) { originalBody = value; },
      setOriginalAttachments(value: boolean) { originalAttachments = value; },
      holdAI() { held = true; },
      holdSend() { sendHeld = true; },
      holdMailbox() { holdMailbox = true; }, mailboxPending: () => releaseMailbox !== undefined,
      mailboxReplies: () => mailboxReplies,
      releaseMailbox() { const done = releaseMailbox; releaseMailbox = undefined; done?.(); },
      releaseSend() { if (!releaseSend) throw new Error('No send is waiting.'); const done = releaseSend; releaseSend = undefined; done(); },
      releaseAI() { if (!release) throw new Error('No AI call is waiting.'); const done = release; release = undefined; done(); },
      failAI() { fail = true; }, saved: () => structuredClone(saved),
    }, __connectionsFixture: async (method: string, raw: unknown) => {
      const args = raw as Record<string, unknown> | undefined;
      if (method === 'collection.listInstances') return { result: { instances: [{ platform: 'mail', slug: 'work',
        adapter_type: 'gmail', auth_state: 'healthy', caps: {}, last_synced_at: 1_700_000_000_000 },
        ...(inbox ? [{ platform: 'mail', slug: 'other', adapter_type: 'gmail', auth_state: 'healthy', caps: {}, last_synced_at: 1_700_000_000_000 }] : [])] } };
      if (method === 'collection.list' && args?.platform === 'mail') {
        const query = structuredClone(args) as unknown as CollectionListQuery; listRequests.push(query);
        const before = ignoredPaging ? undefined : query.before;
        const rows = records.filter(row => row.record_id !== 'mail-0').map(recordWithFlags)
          .filter(row => Object.entries(query.filters ?? {}).every(([key, value]) => row.hot_fields[key as keyof typeof row.hot_fields] === value))
          .filter(row => !before || row.received_at < before.received_at || row.received_at === before.received_at && row.record_id < before.record_id)
          .sort((a, b) => b.received_at - a.received_at || (a.record_id < b.record_id ? 1 : -1))
          .slice(0, query.limit);
        if (listHold) { listHold = false; await new Promise<void>(done => { releaseList = done; }); }
        if (listFail) { listFail = false; return { error: { code: 'unavailable', message: 'Mail list is temporarily unavailable.' } }; }
        return { result: { records: structuredClone(rows) } };
      }
      if (method === 'collection.get' && args?.platform === 'mail') {
        const row = records.find(row => row.record_id === args.record_id);
        return { result: { record: row ? structuredClone(recordWithFlags(row)) : null } };
      }
      if (method === 'collection.mail.message.attachments') {
        const id = String(args?.record_id); attachmentReads.push(id);
        if (args?.expected_incarnation && args.expected_incarnation !== attachmentIncarnation) return { error: { code: 'resource_changed', message: 'This email or mailbox changed. Reopen it from Mail.' } };
        const item = async (file_id: string, filename: string, mime_type: string) => ({ file_id, filename, mime_type,
          size: new TextEncoder().encode(content(file_id)).length, content_hash: await digest(content(file_id)),
          selection_revision: (filename === 'Revised.txt' ? 'c' : 'b').repeat(64) });
        const value: MailMessageAttachmentsSnapshot = { slug: 'work', record_id: id, incarnation: attachmentIncarnation, warnings: [], truncated: false,
          items: !attachments ? [] : id === 'mail-1' ? [await item(primaryFile, attachmentName, 'text/plain'),
            await item(officeFile, 'Terms.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
            { file_id: missingFile, filename: 'Missing.pdf', mime_type: 'application/pdf', size: null, unavailable_reason: 'This linked attachment is no longer retained.' }]
            : [await item(laterFile, 'Later.txt', 'text/plain')] };
        if (attachmentHold) { attachmentHold = false; await new Promise<void>(done => { attachmentRelease = done; }); }
        if (attachmentFailure) return { error: { code: 'unavailable', message: 'Saved attachments are temporarily unavailable.' } };
        return { result: value };
      }
      if (method === 'data.file.attachments.preview' || method === 'data.file.read') {
        const id = String(args?.record_id); previewReads.push(id);
        const data = content(id), filename = id === officeFile ? 'Terms.docx' : id === laterFile ? 'Later.txt' : attachmentName;
        const mime_type = id === officeFile ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/plain';
        if (method === 'data.file.read') return { result: { record_id: id, filename, mime_type, bytes_b64: btoa(data), size_bytes: data.length, blob_hash: await digest(data) } };
        return { result: { record_id: id, filename, mime_type, transient: false, can_download: true, size_bytes: data.length,
          ...(id === officeFile ? { unavailable_reason: 'This file format has no preview yet. You can download it.' }
            : { content: { kind: 'text', bytes_b64: btoa(data) } }) } };
      }
      if (method === 'collection.mail.message.updateState') {
        const input = structuredClone(args) as unknown as MailMessageStateChange;
        stateChanges.push(input);
        if (input.expected_identity !== (messageIdentities.get(input.record_id) ?? 'a'.repeat(64))) return { error: { code: 'resource_changed', message: 'This mailbox changed.' } };
        if (triage !== 'writable' || !(input.change.kind === 'read' ? messageAccess.get(input.record_id)?.mark ?? true : messageAccess.get(input.record_id)?.star ?? true)) return { error: { code: 'forbidden', message: 'This mailbox is read-only.' } };
        if (holdState) { holdState = false; await new Promise<void>(done => { releaseState = done; }); }
        remoteFlags.set(input.record_id, { ...flags(input.record_id), [input.change.kind === 'read' ? 'is_read' : 'is_flagged']: input.change.value });
        if (loseStateResponse) { loseStateResponse = false; return { error: { code: 'upstream_error', message: 'The response was lost. The change may have been applied.' } }; }
        confirmedFlags.set(input.record_id, { ...flags(input.record_id) });
        const row = records.find(row => row.record_id === input.record_id)!;
        return { result: { slug: input.slug, record_id: input.record_id, state: messageState(input.record_id), record: recordWithFlags(row) } };
      }
      if (method === 'collection.mail.conversation.get') {
        if (historyFailure) return { error: { code: 'unavailable', message: 'Conversation history is temporarily unavailable.' } };
        if (holdConversation) { holdConversation = false; await new Promise<void>(done => { releaseConversation = done; }); }
        const anchor = records.find(row => row.record_id === args?.record_id)!;
        if (args?.before && failOlder) { failOlder = false; return { error: { code: 'unavailable', message: 'Earlier mail is temporarily unavailable. Try again.' } }; }
        return { result: { slug: 'work', anchor: conversationItem(anchor), thread_id: thread ? 'delivery-thread' : null,
          incarnation: 'work-v1', mailbox_address: 'owner@example.test',
          messages: records.filter(row => inbox ? row.record_id === args?.record_id : args?.before ? row.record_id === 'mail-0' : row.record_id !== 'mail-0').map(conversationItem),
          ...(thread && !args?.before ? { next_before: { received_at: record.received_at, record_id: 'mail-1' } } : {}),
        } };
      }
      if (method === 'collection.mail.message.get') {
        const id = args?.record_id as string; reads.push(structuredClone(args) as { record_id: string });
        if (heldReads.delete(id)) await new Promise<void>(done => { releases.set(id, done); });
        return { result: snapshot(id) };
      }
      if (method === 'collection.mail.list') {
        if (holdMailbox) { holdMailbox = false; await new Promise<void>(done => { releaseMailbox = done; }); }
        mailboxReplies++;
        return { result: { instances: [
        { slug: 'work', adapter_type: 'gmail', account_email: senderMailbox, send_capable: canSend,
          draft_capable: true, receive_capable: true, sent_lookup_capable: true, auth_state: 'healthy', caps: {} },
        { slug: 'other', adapter_type: 'smtp', account_email: 'other@example.test', send_capable: true,
          draft_capable: false, receive_capable: false, sent_lookup_capable: false, auth_state: 'healthy', caps: {} },
      ] } }; }
      if (method === 'mail_fact.email.get') return { result: { fact_count: 0, security_notice: false } };
      if (method === 'data.timeline') return { result: { entries: [] } };
      if (method === 'mail.drafts.list') return { result: { drafts: saved ? [{ ...saved,
        subject: saved.content.subject, sender_mail_instance: saved.content.sender_mail_instance }] : [], next_cursor: null } };
      if (method === 'mail.drafts.create' || method === 'mail.drafts.update') {
        saved = { draft_id: 'mad_00000000-0000-4000-8000-000000000001', incarnation: 'draft-incarnation',
          revision: (saved?.revision ?? 0) + 1, content: structuredClone(args?.content) as MailDraft['content'],
          origin_contract_id: null, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_001 };
        return { result: structuredClone(saved) };
      }
      if (method === 'mail.drafts.get') return { result: structuredClone(saved) };
      if (method === 'data.mirror.search' && args?.kind === 'files') return { result: { results: [
        { entity_id: 'file:file:' + '1'.repeat(32), label: 'Scope notes.txt' },
      ] } };
      if (method === 'execute') {
        const request = structuredClone(args) as { recipe_id: string; config: Record<string, unknown> };
        executions.push(request);
        if (request.recipe_id === 'send-composed-mail') {
          if (sendHeld) { sendHeld = false; await new Promise<void>(done => { releaseSend = done; }); }
          if (sendOutcome === 'lost') return { error: { code: 'unavailable', message: 'The send response was lost.' } };
          if (sendOutcome === 'sent') return { result: { success: true } };
          if (sendOutcome === 'incomplete') return { result: { success: false } };
          return { result: { success: false, awaiting_approval: true } };
        }
        if (held) { held = false; await new Promise<void>(done => { release = done; }); }
        if (fail) { fail = false; return { error: { code: 'unavailable', message: 'The AI model is unavailable.' } }; }
        const body = request.recipe_id === 'draft-composed-mail' ? 'I will review the revised scope before confirming a delivery date.' : 'Polished draft body.';
        return { result: { success: true, output: { render: [{ type: 'text', data: body }] } } };
      }
      return undefined;
    } });
  }, { sending, thread, historyFails, messageCount, group, forwarding, triage: opts.triage, attachments, inbox: opts.inbox });
  await page.goto(`${HARNESS_URL}?connection=source-answer&recipes=installed${opts.durableProfile ? '&server_profiles=multiple' : ''}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/mail'));
  if (opts.inbox) {
    await page.locator('[data-collection-slug="work"]').click();
    await expect(page.locator('[data-mail-inbox-status]')).toContainText('30 saved messages'); return;
  }
  await page.locator('[data-collection-record="mail-1"]').click();
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Can you confirm the delivery date?');
};

test.describe('Bulk inbox triage', () => {
  const selection = (page: Page) => page.getByRole('region', { name: 'Email selection', exact: true });
  const results = (page: Page) => page.getByRole('region', { name: 'Email batch results', exact: true });
  const choose = async (page: Page, ids: string[]) => {
    for (const id of ids) await page.locator(`[data-mail-bulk-id="${id}"]`).check();
    await expect(selection(page).getByRole('button', { name: 'Mark read', exact: true })).toBeEnabled();
  };

  test('Select shown marks only the displayed unread page and keeps results after those rows leave the filter', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 }); await boot(page, { inbox: true, triage: 'writable' });
    await page.getByLabel('Message status', { exact: true }).selectOption('unread');
    await expect(page.locator('[data-mail-inbox-status]')).toContainText('30 saved messages');
    await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click();
    await expect(selection(page).getByRole('button', { name: 'Mark read', exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('bulk-triage-phone.png'), animations: 'disabled' });
    const chosen = await page.locator('[data-mail-bulk-id]:checked').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-mail-bulk-id')));
    expect(chosen).toHaveLength(30);
    await selection(page).getByRole('button', { name: 'Mark read', exact: true }).click();
    await expect(results(page).getByRole('status')).toHaveText('30 confirmed · 0 failed · 0 unconfirmed');
    await expect(page.locator('[data-collection-record]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__mailCompose.stateChanges.map(input => input.record_id))).toEqual(chosen);
    expect(await page.evaluate(() => window.__mailCompose.stateChanges.every(input => input.change.kind === 'read' && input.change.value === true))).toBe(true);
    await page.getByRole('button', { name: 'Refresh messages', exact: true }).click();
    await expect(page.locator('[data-mail-inbox-status]')).toContainText('14 saved messages');
    await expect(page.locator('[data-mail-bulk-id]:checked')).toHaveCount(0);
  });

  test('sets read, unread, star and unstar for checked rows without opening the reader', async ({ page }, testInfo) => {
    await boot(page, { inbox: true, triage: 'writable' });
    const ids = ['mail-65', 'mail-64'];
    for (const action of ['Mark read', 'Mark unread', 'Star', 'Remove stars']) {
      await choose(page, ids);
      if (action === 'Mark read') await page.screenshot({ path: testInfo.outputPath('bulk-triage-desktop.png'), animations: 'disabled' });
      await selection(page).getByRole('button', { name: action, exact: true }).click();
      await expect(results(page).getByRole('status')).toHaveText('2 confirmed · 0 failed · 0 unconfirmed');
      await results(page).getByRole('button', { name: 'Start another selection' }).click();
    }
    expect(await page.evaluate(() => window.__mailCompose.stateChanges.map(input => ({ id: input.record_id, ...input.change })))).toEqual([
      ...ids.map(id => ({ id, kind: 'read', value: true })), ...ids.map(id => ({ id, kind: 'read', value: false })),
      ...ids.map(id => ({ id, kind: 'star', value: true })), ...ids.map(id => ({ id, kind: 'star', value: false })),
    ]);
    await expect(page.getByRole('article', { name: 'Email message', exact: true })).toHaveCount(0);
  });

  test('checks a lost response without replaying its write', async ({ page }) => {
    await boot(page, { inbox: true, triage: 'writable' }); await choose(page, ['mail-65', 'mail-64']);
    await page.evaluate(() => window.__mailCompose.loseStateResponse());
    await selection(page).getByRole('button', { name: 'Star', exact: true }).click();
    await expect(results(page).getByRole('status')).toHaveText('1 confirmed · 0 failed · 1 unconfirmed');
    await expect(results(page).getByRole('button', { name: 'Retry failed' })).toHaveCount(0);
    await results(page).getByRole('button', { name: 'Check unconfirmed' }).click();
    await expect(results(page).getByRole('status')).toHaveText('2 confirmed · 0 failed · 0 unconfirmed');
    expect(await page.evaluate(() => window.__mailCompose.stateChanges.map(input => input.record_id))).toEqual(['mail-65', 'mail-64']);
    await expect(results(page)).toBeFocused();
    await expect(page.locator('[data-collection-record="mail-65"]')).toContainText('Starred');
  });

  test('rechecks withdrawn permission and retries only the failed email', async ({ page }) => {
    await boot(page, { inbox: true, triage: 'writable' }); await choose(page, ['mail-65', 'mail-64']);
    await page.evaluate(() => window.__mailCompose.setMessageAccess('mail-65', { mark: false, star: true }));
    await selection(page).getByRole('button', { name: 'Mark read', exact: true }).click();
    await expect(results(page).getByRole('status')).toHaveText('1 confirmed · 1 failed · 0 unconfirmed');
    expect(await page.evaluate(() => window.__mailCompose.stateChanges.map(input => input.record_id))).toEqual(['mail-64']);
    await page.evaluate(() => window.__mailCompose.setMessageAccess('mail-65', { mark: true, star: true }));
    await results(page).getByRole('button', { name: 'Retry failed' }).click();
    await expect(results(page).getByRole('status')).toHaveText('2 confirmed · 0 failed · 0 unconfirmed');
    expect(await page.evaluate(() => window.__mailCompose.stateChanges.map(input => input.record_id))).toEqual(['mail-64', 'mail-65']);
  });

  test('blocks browsing during a write and stops before the next email', async ({ page }) => {
    await boot(page, { inbox: true, triage: 'writable' }); await choose(page, ['mail-65', 'mail-64']);
    await page.evaluate(() => window.__mailCompose.holdState());
    await selection(page).getByRole('button', { name: 'Mark read', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__mailCompose.stateChanges.length)).toBe(1);
    await expect(page.getByLabel('Message status', { exact: true })).toBeDisabled();
    await expect(page.locator('[data-collection-slug="other"]')).toBeDisabled();
    await expect(page.locator('[data-collection-record="mail-64"]')).toBeDisabled();
    await results(page).getByRole('button', { name: 'Stop after current email' }).click();
    await page.evaluate(() => window.__mailCompose.releaseState());
    await expect(results(page).getByRole('status')).toHaveText('1 confirmed · 1 failed · 0 unconfirmed');
    expect(await page.evaluate(() => window.__mailCompose.stateChanges.length)).toBe(1);
    await results(page).getByRole('button', { name: 'Retry failed' }).click();
    await expect(results(page).getByRole('status')).toHaveText('2 confirmed · 0 failed · 0 unconfirmed');
  });

  test('rejects a changed mailbox identity until the owner starts a new selection', async ({ page }) => {
    await boot(page, { inbox: true, triage: 'writable' }); await choose(page, ['mail-65']);
    await page.evaluate(() => window.__mailCompose.setMessageIdentity('mail-65', 'b'.repeat(64)));
    await selection(page).getByRole('button', { name: 'Mark read', exact: true }).click();
    await expect(results(page).getByRole('status')).toHaveText('0 confirmed · 1 failed · 0 unconfirmed');
    await expect(results(page)).toContainText('Clear this selection');
    await results(page).getByRole('button', { name: 'Retry failed' }).click();
    await expect(results(page).getByRole('status')).toHaveText('0 confirmed · 1 failed · 0 unconfirmed');
    expect(await page.evaluate(() => window.__mailCompose.stateChanges.length)).toBe(0);
    await results(page).getByRole('button', { name: 'Start another selection' }).click();
    await choose(page, ['mail-65']); await selection(page).getByRole('button', { name: 'Mark read', exact: true }).click();
    await expect(results(page).getByRole('status')).toHaveText('1 confirmed · 0 failed · 0 unconfirmed');
    expect(await page.evaluate(() => window.__mailCompose.stateChanges[0]?.expected_identity)).toBe('b'.repeat(64));
  });

  test('retires a late readiness check when the mailbox changes', async ({ page }) => {
    await boot(page, { inbox: true, triage: 'writable' });
    await page.evaluate(() => window.__mailCompose.holdMessage('mail-65'));
    await page.locator('[data-mail-bulk-id="mail-65"]').check();
    await expect(selection(page).getByRole('status')).toContainText('1 checking');
    await page.locator('[data-collection-slug="other"]').click();
    await page.evaluate(() => window.__mailCompose.releaseMessage('mail-65'));
    await expect(selection(page).getByRole('status')).toHaveText('Tidy mail together');
    await expect(page.locator('[data-mail-bulk-id]:checked')).toHaveCount(0);
    expect(await page.evaluate(() => window.__mailCompose.stateChanges.length)).toBe(0);
  });

  test('explains read-only email access and disables unsupported actions', async ({ page }) => {
    await boot(page, { inbox: true, triage: 'read_only' });
    await page.locator('[data-mail-bulk-id="mail-65"]').check();
    await expect(selection(page).getByRole('status')).toContainText('1 unavailable');
    for (const action of ['Mark read', 'Mark unread', 'Star', 'Remove stars']) await expect(selection(page).getByRole('button', { name: action, exact: true })).toBeDisabled();
    await selection(page).getByRole('button', { name: 'Review selected', exact: true }).click();
    await expect(selection(page)).toContainText('This mailbox is read-only');
    expect(await page.evaluate(() => window.__mailCompose.stateChanges.length)).toBe(0);
  });
});

test.describe('Find in the Mail reader', () => {
  const email = (page: Page) => page.getByRole('article', { name: 'Email message', exact: true });
  const text = (page: Page) => email(page).locator('[data-mail-message-body]');
  const finder = (page: Page) => page.getByRole('search', { name: 'Find in this email', exact: true });
  const query = (page: Page) => finder(page).getByRole('searchbox', { name: 'Find in this email', exact: true });
  const status = (page: Page) => finder(page).getByRole('status');
  const refreshBody = async (page: Page, body: string) => {
    await page.evaluate(body => window.__mailCompose.setOriginalBody(body), body);
    await email(page).getByRole('button', { name: 'Refresh email', exact: true }).click();
    await expect(text(page)).toHaveText(body || '(Empty message)');
  };

  for (const width of [390, 1280]) test(`finds literal Unicode text, moves through a long email, and returns focus on close at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 }); await boot(page, { thread: true });
    const body = '\n  Café 😀 [a.*] first\n\n' + 'A paragraph to read through.\n'.repeat(150)
      + 'CAFÉ 😀 [A.*] last\n<img src=x onerror="throw Error(\'unsafe\')">';
    await refreshBody(page, body);
    expect(await text(page).textContent()).toBe(body);
    const reads = await page.evaluate(() => window.__mailCompose.reads.length), url = page.url();
    await email(page).getByRole('button', { name: 'Find in email', exact: true }).click();
    await expect(query(page)).toBeFocused(); await expect(finder(page).getByRole('button', { name: 'Previous match', exact: true })).toBeDisabled();
    await query(page).fill('[a.*]'); await expect(status(page)).toHaveText('1 of 2 matches.');
    await query(page).press('Enter'); await expect(status(page)).toHaveText('2 of 2 matches.');
    await expect(text(page).locator('[data-mail-find-current]')).toHaveText('[A.*]'); await expect(text(page).locator('[data-mail-find-current]')).toBeInViewport();
    await expect(query(page)).toBeInViewport(); await expect(query(page)).toBeFocused();
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`mail-find-${width}.png`) });
    await finder(page).getByRole('button', { name: 'Next match', exact: true }).click(); await expect(status(page)).toHaveText('1 of 2 matches.');
    await finder(page).getByRole('button', { name: 'Previous match', exact: true }).click(); await expect(status(page)).toHaveText('2 of 2 matches.');
    await query(page).focus(); await query(page).press('Shift+Enter'); await expect(status(page)).toHaveText('1 of 2 matches.');
    await query(page).fill('café'); await expect(status(page)).toHaveText('1 of 2 matches.');
    await expect(text(page).locator('[data-mail-find-match]')).toHaveText(['Café', 'CAFÉ']);
    await query(page).fill('😀'); await expect(text(page).locator('[data-mail-find-match]')).toHaveText(['😀', '😀']);
    await query(page).fill('<img'); await expect(status(page)).toHaveText('1 of 1 matches.'); await expect(text(page).locator('img,script')).toHaveCount(0);
    expect(await text(page).textContent()).toBe(body);
    expect(await page.evaluate(() => window.__mailCompose.reads.length)).toBe(reads);
    expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
    expect(await query(page).evaluate(element => ['Escape', 'Enter'].map(key => element.dispatchEvent(new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true }))))).toEqual([true, true]);
    await expect(status(page)).toHaveText('1 of 1 matches.'); await query(page).press('Escape');
    await expect(finder(page)).toHaveCount(0); await expect(email(page).getByRole('button', { name: 'Find in email', exact: true })).toBeFocused();
    await expect(text(page).locator('mark')).toHaveCount(0); expect(page.url()).toBe(url); expect(await text(page).textContent()).toBe(body);
    for (const key of ['Control+f', 'Meta+f']) {
      await text(page).focus(); await text(page).press(key); await expect(query(page)).toBeFocused();
      await expect(query(page)).toHaveValue('<img'); await query(page).press('Escape');
    }
  });

  test('keeps query, caret and match selection through a status reply and refresh, while isolating newer message selections', async ({ page }) => {
    await boot(page, { thread: true, triage: 'writable' }); await refreshBody(page, 'needle one\nneedle two\nneedle three');
    await email(page).getByRole('button', { name: 'Find in email', exact: true }).click(); await query(page).fill('needle'); await query(page).press('Enter');
    await page.evaluate(() => window.__mailCompose.holdState()); await email(page).getByRole('button', { name: 'More', exact: true }).click();
    await email(page).getByRole('button', { name: 'Star email', exact: true }).click();
    await query(page).focus(); await query(page).evaluate((element: HTMLInputElement) => element.setSelectionRange(1, 4, 'backward'));
    await page.evaluate(() => window.__mailCompose.releaseState()); await expect(email(page)).toContainText('Email starred.');
    await expect(query(page)).toBeFocused(); expect(await query(page).evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd, element.selectionDirection])).toEqual([1, 4, 'backward']);
    await expect(status(page)).toHaveText('2 of 3 matches.'); await refreshBody(page, 'needle refreshed');
    await expect(query(page)).toHaveValue('needle'); await expect(status(page)).toHaveText('1 of 1 matches.');
    const index = page.getByRole('navigation', { name: 'Messages in this conversation', exact: true });
    await page.evaluate(() => window.__mailCompose.holdMessage('mail-3'));
    await index.locator('[data-mail-record="mail-3"]').click(); await index.locator('[data-mail-record="mail-2"]').click();
    await expect(text(page)).toContainText('I have reviewed the scope'); await expect(finder(page)).toHaveCount(0);
    await email(page).getByRole('button', { name: 'Find in email', exact: true }).click(); await expect(query(page)).toHaveValue('');
    await query(page).fill('proposed date'); await expect(status(page)).toHaveText('1 of 1 matches.');
    await page.evaluate(() => window.__mailCompose.releaseMessage('mail-3'));
    await expect(query(page)).toHaveValue('proposed date'); await expect(status(page)).toHaveText('1 of 1 matches.'); await expect(text(page)).toContainText('I have reviewed the scope');
    await page.locator('.data-mail-conversation-toggle[data-mail-record="mail-2"]').click(); await expect(finder(page)).toHaveCount(0);
    await expect(text(page)).toHaveCount(0);
  });

  test('bounds highlights in a partial message and keeps the scope honest when history is unavailable or the body becomes empty', async ({ page }) => {
    await boot(page, { historyFails: true }); await page.evaluate(() => window.__mailCompose.setPartialBody(true));
    await refreshBody(page, 'needle '.repeat(1001)); await email(page).getByRole('button', { name: 'Find in email', exact: true }).click();
    await query(page).fill('needle'); await expect(status(page)).toHaveText('1 of 1,000+ matches. Narrow your search to see more.');
    await expect(text(page).locator('[data-mail-find-match]')).toHaveCount(1000);
    await expect(finder(page)).toContainText('Only the displayed part of this email is searched.');
    await query(page).fill('absent'); await expect(status(page)).toHaveText('No matches in the displayed text.');
    await refreshBody(page, ''); await expect(status(page)).toHaveText('No text in the displayed part of this email.');
    await expect(email(page).getByRole('button', { name: 'Find in email', exact: true })).toBeDisabled();
    await expect(finder(page).getByRole('button', { name: 'Next match', exact: true })).toBeDisabled(); await expect(text(page).locator('mark')).toHaveCount(0);
  });

  test('broadens the literal query into Universal Search only on request and remembers that search', async ({ page }) => {
    await boot(page, { durableProfile: true }); await installSearchEverywhereFixture(page);
    await email(page).getByRole('button', { name: 'Find in email', exact: true }).click();
    const everywhere = finder(page).getByRole('button', { name: 'Search everywhere', exact: true }); await expect(everywhere).toBeDisabled();
    const value = 'Café & <renewal> [a.*]'; await query(page).fill(`  ${value}  `); await expect(status(page)).toHaveText('No matches.');
    expect(await page.evaluate(() => window.__searchEverywhereFixture.calls)).toEqual([]);
    await finder(page).getByRole('button', { name: `Search everywhere for ${value}`, exact: true }).click();
    const global = page.getByRole('searchbox', { name: 'Search everything', exact: true }); await expect(global).toHaveValue(value); await expect(global).toBeFocused();
    await expect(page.locator('[data-search-record]')).toContainText(`Global result for ${value}`);
    expect(await page.evaluate(() => window.__searchEverywhereFixture.calls.filter(call => call.method === 'collection.searchAll'))).toEqual([{ method: 'collection.searchAll', args: { query: value } }]);
    await global.fill(''); await expect(page.getByRole('region', { name: 'Recent searches', exact: true }).locator('.rq-recent-run')).toHaveText([value]);
    expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
  });

  test('keeps forwarded original text unmarked and leaves editor keyboard shortcuts to the compose dialog', async ({ page }) => {
    await boot(page); const body = 'A literal [a.*] and <img src=x>\nCafé 🧾'; await refreshBody(page, body);
    await email(page).getByRole('button', { name: 'Find in email', exact: true }).click(); await query(page).fill('[a.*]');
    await email(page).getByRole('button', { name: 'Forward', exact: true }).click();
    await expect(dialog(page)).toBeVisible();
    const original = await field(page, 'body').inputValue(); expect(original).toContain('[a.*]'); expect(original).toContain('<img src=x>'); expect(original).not.toContain('<mark');
    await field(page, 'body').fill('Keep my reply draft');
    expect(await field(page, 'body').evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })))).toBe(true);
    await expect(field(page, 'body')).toHaveValue('Keep my reply draft'); await expect(field(page, 'body')).toBeFocused(); await expect(query(page)).toHaveValue('[a.*]');
  });
});

test('opens and downloads retained attachments from the email and explains missing files', async ({ page }, testInfo) => {
  await boot(page, { attachments: true, sending: false });
  const panel = page.getByRole('region', { name: 'Email attachments', exact: true });
  await expect(panel).toContainText('Invoice.txt');
  await expect(panel).toContainText('no longer retained');
  const invoice = panel.locator('li').filter({ hasText: 'Invoice.txt' });
  await invoice.getByRole('button', { name: 'Open', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: 'File preview', exact: true });
  await expect(viewer).toContainText('Invoice INV-42');
  await viewer.getByRole('button', { name: 'Close preview', exact: true }).click();
  await expect(invoice.getByRole('button', { name: 'Open', exact: true })).toBeFocused();
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Can you confirm the delivery date?');
  await panel.screenshot({ path: testInfo.outputPath('mail-attachments-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
  await panel.screenshot({ path: testInfo.outputPath('mail-attachments-phone-dark.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const office = panel.locator('li').filter({ hasText: 'Terms.docx' });
  await office.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(viewer).toContainText('no preview yet');
  const completed = page.waitForEvent('download'); await viewer.getByRole('button', { name: 'Download file', exact: true }).click();
  expect((await completed).suggestedFilename()).toBe('Terms.docx');
  await viewer.getByRole('button', { name: 'Close preview', exact: true }).click();
  const direct = page.waitForEvent('download'); await invoice.getByRole('button', { name: 'Download', exact: true }).click();
  expect((await direct).suggestedFilename()).toBe('Invoice.txt');
  expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
});

test('keeps email and a reply draft usable while attachment metadata loads or fails', async ({ page }) => {
  await boot(page, { attachments: true });
  const panel = page.getByRole('region', { name: 'Email attachments', exact: true });
  await expect(panel).toContainText('Invoice.txt');
  await page.evaluate(() => window.__mailAttachments.holdNext());
  await panel.getByRole('button', { name: 'Refresh attachments', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mailAttachments.pending())).toBe(true);
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await field(page, 'body').fill('Keep these reply notes.');
  await page.evaluate(() => window.__mailAttachments.release());
  await expect(field(page, 'body')).toHaveValue('Keep these reply notes.');
  await expect(dialog(page)).toBeVisible();
  expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
});

test('retires attachment lists and pending opens after selecting another message', async ({ page }) => {
  await boot(page, { attachments: true, thread: true });
  const panel = page.getByRole('region', { name: 'Email attachments', exact: true });
  const index = page.getByRole('navigation', { name: 'Messages in this conversation' });
  await expect(panel).toContainText('Invoice.txt');
  await page.evaluate(() => window.__mailAttachments.holdNext());
  await panel.getByRole('button', { name: 'Refresh attachments', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mailAttachments.pending())).toBe(true);
  await index.locator('[data-mail-record="mail-2"]').click();
  await expect(panel).toContainText('Later.txt');
  await page.evaluate(() => window.__mailAttachments.release());
  await expect(panel).not.toContainText('Invoice.txt');
  await page.evaluate(() => window.__mailAttachments.holdNext());
  await panel.locator('li').filter({ hasText: 'Later.txt' }).getByRole('button', { name: 'Open', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mailAttachments.pending())).toBe(true);
  await index.locator('[data-mail-record="mail-1"]').click();
  await expect(panel).toContainText('Invoice.txt');
  await page.evaluate(() => window.__mailAttachments.release());
  await expect(page.getByRole('dialog', { name: 'File preview', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__mailAttachments.previewReads)).toEqual([]);
});

test('recovers attachment failures and requires a new selection after rename or mailbox replacement', async ({ page }) => {
  await boot(page, { attachments: true });
  const panel = page.getByRole('region', { name: 'Email attachments', exact: true });
  await expect(panel).toContainText('Invoice.txt');
  await page.evaluate(() => window.__mailAttachments.fail(true));
  await panel.getByRole('button', { name: 'Refresh attachments', exact: true }).click();
  await expect(panel).toContainText('temporarily unavailable');
  await expect(page.getByRole('button', { name: 'Reply', exact: true })).toBeEnabled();
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Can you confirm the delivery date?');
  await page.evaluate(() => window.__mailAttachments.fail(false));
  await panel.getByRole('button', { name: 'Retry attachments', exact: true }).click();
  await expect(panel).toContainText('Invoice.txt');
  await page.evaluate(() => window.__mailAttachments.rename());
  await panel.locator('li').filter({ hasText: 'Invoice.txt' }).getByRole('button', { name: 'Open', exact: true }).click();
  await expect(panel).toContainText('choose it again');
  await expect(panel).toContainText('Revised.txt');
  expect(await page.evaluate(() => window.__mailAttachments.previewReads)).toEqual([]);
  await page.evaluate(() => window.__mailAttachments.replaceMailbox());
  await panel.locator('li').filter({ hasText: 'Revised.txt' }).getByRole('button', { name: 'Download', exact: true }).click();
  await expect(panel).toContainText('mailbox changed');
  expect(await page.evaluate(() => window.__mailAttachments.previewReads)).toEqual([]);
});

test('a newer email refresh retires a pending attachment open before its old response arrives', async ({ page }) => {
  await boot(page, { attachments: true, sending: false });
  const panel = page.getByRole('region', { name: 'Email attachments', exact: true });
  await expect(panel).toContainText('Invoice.txt');
  await page.evaluate(() => window.__mailAttachments.holdNext());
  await panel.locator('li').filter({ hasText: 'Invoice.txt' }).getByRole('button', { name: 'Open', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mailAttachments.pending())).toBe(true);
  await expect(panel).toContainText('Checking attachment…');
  await page.evaluate(() => window.__mailAttachments.rename());
  await page.getByRole('button', { name: 'Refresh email', exact: true }).click();
  await expect(panel).toContainText('Revised.txt');
  await page.evaluate(() => window.__mailAttachments.release());
  await expect(panel).not.toContainText('Invoice.txt');
  await expect(page.getByRole('dialog', { name: 'File preview', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__mailAttachments.previewReads)).toEqual([]);
  await panel.locator('li').filter({ hasText: 'Revised.txt' }).getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'File preview', exact: true })).toContainText('Invoice INV-42');
});

test('Reply all checks fresh participants and carries the reviewed To/Cc through draft storage and approval on a phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, { group: true });
  const all = page.getByRole('button', { name: 'Reply all', exact: true });
  await expect(all).toBeVisible();
  await page.evaluate(() => window.__mailCompose.setCopyRecipient('fresh-copy@example.test'));
  await all.click();
  await expect(page.getByRole('dialog', { name: 'Reply all', exact: true })).toBeVisible();
  const to = page.locator('[data-form-array-item="to"]');
  await expect(to).toHaveCount(2);
  await expect(to.nth(0)).toHaveValue('desk@example.test');
  await expect(to.nth(1)).toHaveValue('colleague@example.test');
  const copies = page.locator('[data-mail-compose-copy-recipients]');
  await expect(copies).toHaveAttribute('open', '');
  await expect(copies.locator('[data-form-array-item="cc"]')).toHaveValue('fresh-copy@example.test');
  await expect(copies.locator('[data-form-array-item="bcc"]')).toHaveCount(0);
  await expect(page.locator('[data-action="select-mail-compose-sender"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('reply-all-mobile.png'), fullPage: true });
  await field(page, 'body').fill('Friday works for the whole group.');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.locator('[data-mail-draft-status]')).toContainText('Draft saved.');
  const expected = { sender_mail_instance: 'work', to: ['desk@example.test', 'colleague@example.test'],
    cc: ['fresh-copy@example.test'], in_reply_to: '<request@example.test>',
    references: ['<root@example.test>', '<request@example.test>'] };
  expect(await page.evaluate(() => window.__mailCompose.saved()?.content)).toMatchObject(expected);
  expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('waiting for approval');
  const sent = await page.evaluate(() => window.__mailCompose.executions.at(-1));
  expect(sent).toMatchObject({ recipe_id: 'send-composed-mail', config: expected });
  expect(sent?.config.bcc ?? []).toEqual([]);
  await page.evaluate(() => window.__app.setHash('#mail'));
  await page.getByRole('button', { name: 'Re: Delivery date', exact: true }).click();
  await expect(to).toHaveCount(2);
  await expect(to.nth(0)).toHaveValue('desk@example.test');
  await expect(to.nth(1)).toHaveValue('colleague@example.test');
  await expect(copies.locator('[data-form-array-item="cc"]')).toHaveValue('fresh-copy@example.test');
  await expect(field(page, 'body')).toHaveValue('Friday works for the whole group.');
});

for (const change of ['participants', 'sending capability', 'mailbox identity'] as const) {
  test(`Reply all refuses a fresh read with changed ${change} without falling back to Reply`, async ({ page }) => {
    await boot(page, { group: true });
    const all = page.getByRole('button', { name: 'Reply all', exact: true });
    await expect(all).toBeVisible();
    if (change === 'participants') await page.evaluate(() => window.__mailCompose.setGroup(false));
    else if (change === 'sending capability') await page.evaluate(() => window.__mailCompose.setSending(false));
    else await page.evaluate(() => window.__mailCompose.setReplyMailbox('new-owner@example.test'));
    await all.click();
    await expect(page.getByRole('article', { name: 'Email message' }).getByRole('alert')).toContainText(
      change === 'participants' ? 'Reply all is no longer available' : 'Sending is unavailable for this mailbox');
    await expect(dialog(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
  });
}

test('ordinary Reply keeps only Reply-To even when Reply all is available', async ({ page }) => {
  await boot(page, { group: true });
  await expect(page.getByRole('button', { name: 'Reply all', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Reply', exact: true })).toBeVisible();
  await expect(page.locator('[data-form-array-item="to"]')).toHaveValue('desk@example.test');
  await page.locator('[data-mail-compose-copy-recipients] summary').click();
  await expect(page.locator('[data-form-array-item="cc"]')).toHaveCount(0);
  await expect(page.locator('[data-form-array-item="bcc"]')).toHaveCount(0);
});

test('older message metadata keeps ordinary Reply without offering an unverified Reply all', async ({ page }) => {
  await boot(page, { forwarding: false });
  await expect(page.getByRole('button', { name: 'Reply all', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Forward', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Reply', exact: true })).toBeVisible();
  await expect(page.locator('[data-form-array-item="to"]')).toHaveValue('desk@example.test');
});

test('Forward quotes fresh original text, keeps recipients empty and carries reviewed edits through storage and approval on a phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, { group: true });
  await page.evaluate(() => {
    window.__mailCompose.setOriginalBody('The revised delivery is Friday.\nPlease review <literal text>.');
    window.__mailCompose.setCopyRecipient('fresh-copy@example.test');
    window.__mailCompose.setOriginalAttachments(true);
  });
  await page.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Forward', exact: true })).toBeVisible();
  await expect(page.locator('[data-form-array-item="to"]')).toHaveCount(0);
  await expect(page.locator('[data-form-array-item="cc"]')).toHaveCount(0);
  await expect(page.locator('[data-form-array-item="bcc"]')).toHaveCount(0);
  await expect(page.locator('[data-action="select-mail-compose-sender"]')).toHaveValue('work');
  await expect(field(page, 'subject')).toHaveValue('Fwd: Delivery date');
  const quoted = await field(page, 'body').inputValue();
  expect(quoted).toContain('From: lead@example.test');
  expect(quoted).toContain('To: owner@example.test, colleague@example.test, DESK@example.test');
  expect(quoted).toContain('Cc: fresh-copy@example.test');
  expect(quoted).toContain('The revised delivery is Friday.\nPlease review <literal text>.');
  await expect(dialog(page)).toContainText('Original attachments are not added automatically.');
  await page.locator('[data-form-array-add="to"]').click();
  await page.locator('[data-form-array-item="to"]').fill('reviewer@example.test');
  await field(page, 'body').fill(`For your review.${quoted}`);
  await page.screenshot({ path: testInfo.outputPath('forward-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.locator('[data-mail-draft-status]')).toContainText('Draft saved.');
  const content = await page.evaluate(() => window.__mailCompose.saved()?.content);
  expect(content).toMatchObject({ sender_mail_instance: 'work', to: ['reviewer@example.test'],
    subject: 'Fwd: Delivery date', body: `For your review.${quoted}` });
  expect(content?.cc ?? []).toEqual([]);
  expect(content?.bcc ?? []).toEqual([]);
  expect(content?.attachments ?? []).toEqual([]);
  expect(content).not.toHaveProperty('in_reply_to');
  expect(content).not.toHaveProperty('references');
  expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Forward is waiting for approval.');
  const sent = await page.evaluate(() => window.__mailCompose.executions.at(-1));
  expect(sent).toMatchObject({ recipe_id: 'send-composed-mail', config: { sender_mail_instance: 'work',
    to: ['reviewer@example.test'], subject: 'Fwd: Delivery date', body: `For your review.${quoted}` } });
  expect(sent?.config).not.toHaveProperty('in_reply_to');
  expect(sent?.config).not.toHaveProperty('references');
  expect(sent?.config.bcc ?? []).toEqual([]);
  await page.evaluate(() => window.__app.setHash('#mail'));
  await page.getByRole('button', { name: 'Fwd: Delivery date', exact: true }).click();
  await expect(field(page, 'body')).toHaveValue(`For your review.${quoted}`);
  await expect(page.locator('[data-form-array-item="to"]')).toHaveValue('reviewer@example.test');
});

test('Forward uses the selected sent email and lets the owner explicitly choose another sender', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await boot(page, { thread: true });
  await page.getByRole('navigation', { name: 'Messages in this conversation' }).locator('[data-mail-record="mail-2"]').click();
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('sent a proposed date');
  await expect(page.getByRole('button', { name: 'Reply', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Forward', exact: true })).toBeVisible();
  const quoted = await field(page, 'body').inputValue();
  expect(quoted).toContain('From: owner@example.test');
  expect(quoted).toContain('To: lead@example.test');
  expect(quoted).toContain('I have reviewed the scope and sent a proposed date.');
  expect(quoted).not.toContain('Can you confirm the delivery date?');
  await expect(dialog(page)).not.toContainText('Original attachments are not added automatically.');
  await page.locator('[data-action="select-mail-compose-sender"]').selectOption('other');
  await page.locator('[data-form-array-add="to"]').click();
  await page.locator('[data-form-array-item="to"]').fill('reviewer@example.test');
  await page.screenshot({ path: testInfo.outputPath('forward-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  const sent = await page.evaluate(() => window.__mailCompose.executions.at(-1));
  expect(sent?.config.sender_mail_instance).toBe('other');
  expect(sent?.config.body).toBe(quoted.trim());
  expect(sent?.config).not.toHaveProperty('in_reply_to');
  expect(sent?.config).not.toHaveProperty('references');
});

for (const change of ['metadata', 'partial body', 'sending capability', 'mailbox identity'] as const) {
  test(`Forward refuses a fresh read with changed ${change}`, async ({ page }) => {
    await boot(page);
    const forward = page.getByRole('button', { name: 'Forward', exact: true });
    await expect(forward).toBeVisible();
    if (change === 'metadata') await page.evaluate(() => window.__mailCompose.setForwarding(false));
    else if (change === 'partial body') await page.evaluate(() => window.__mailCompose.setPartialBody(true));
    else if (change === 'sending capability') await page.evaluate(() => window.__mailCompose.setSending(false));
    else await page.evaluate(() => window.__mailCompose.setReplyMailbox('replacement@example.test'));
    await forward.click();
    await expect(page.getByRole('article', { name: 'Email message' }).getByRole('alert')).toContainText(
      change === 'metadata' ? 'Forward is no longer available' : change === 'partial body' ? 'full email text' : 'Sending is unavailable');
    await expect(dialog(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
  });
}

test('Forward remains unavailable with an explanation for a partial original', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__mailCompose.setPartialBody(true));
  await page.getByRole('button', { name: 'Refresh email', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Forward requires the full email text.');
  await expect(page.getByRole('button', { name: 'Forward', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reply', exact: true })).toBeVisible();
});

test('closing the reader cancels a pending Forward check', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__mailCompose.holdMessage('mail-1'));
  await page.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Checking email…', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Email message' })).toHaveCount(0);
  await page.evaluate(() => window.__mailCompose.releaseMessage('mail-1'));
  await page.evaluate(() => window.__app.setHash('#mail'));
  await page.getByRole('button', { name: 'New mail', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New mail', exact: true })).toBeVisible();
  await expect(field(page, 'subject')).toHaveValue('');
  await expect(page.getByRole('dialog', { name: 'Forward', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
});

for (const mode of ['Reply all', 'Forward'] as const) {
  for (const action of ['Send', 'Save to mailbox', 'Schedule'] as const) {
    test(`${mode} refuses ${action} after the sending mailbox changes`, async ({ page }) => {
      await boot(page, { group: true });
      await page.getByRole('button', { name: mode, exact: true }).click();
      if (mode === 'Forward') {
        await page.locator('[data-form-array-add="to"]').click();
        await page.locator('[data-form-array-item="to"]').fill('reviewer@example.test');
      }
      await field(page, 'body').fill('Keep this reviewed message.');
      await page.evaluate(() => window.__mailCompose.setSenderMailbox('replacement@example.test'));
      if (action === 'Schedule') {
        await page.getByRole('button', { name: 'Schedule…', exact: true }).click();
        await page.locator('[data-mail-draft-time]').fill('2099-12-01T12:00');
        await page.getByRole('button', { name: 'Review scheduled send', exact: true }).click();
      } else await page.getByRole('button', { name: action, exact: true }).click();
      await expect(dialog(page).getByRole('alert')).toContainText('sending mailbox changed');
      await expect(field(page, 'body')).toHaveValue('Keep this reviewed message.');
      expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
    });
  }
}

test('Mail action glyphs keep their names and native clicks on SVG paths reach the intended controls', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, { group: true });
  const clickGlyph = async (name: string): Promise<void> => {
    const control = page.getByRole('button', { name, exact: true });
    await control.scrollIntoViewIfNeeded();
    const point = await control.locator('svg path').first().evaluate(element => {
      const path = element as SVGPathElement;
      const point = path.getPointAtLength(path.getTotalLength() * 0.37);
      const matrix = path.getScreenCTM();
      if (!matrix) throw new Error('The action glyph is not rendered.');
      const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
      return { x: screen.x, y: screen.y };
    });
    await page.mouse.click(point.x, point.y);
  };
  const refresh = page.getByRole('button', { name: 'Refresh email', exact: true });
  await expect(refresh).toHaveAttribute('title', 'Refresh email');
  await expect(refresh.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await page.evaluate(() => window.__mailCompose.setOriginalBody('Refreshed original text.'));
  await clickGlyph('Refresh email');
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Refreshed original text.');
  await page.screenshot({ path: testInfo.outputPath('mail-actions-mobile.png'), fullPage: true });
  await clickGlyph('Reply all');
  await expect(page.getByRole('dialog', { name: 'Reply all', exact: true })).toBeVisible();
  await clickGlyph('Close');
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await clickGlyph('Forward');
  await expect(page.getByRole('dialog', { name: 'Forward', exact: true })).toBeVisible();
  expect(await field(page, 'body').inputValue()).toContain('Refreshed original text.');
  expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
});

test('drafts and refines a reply, preserves its mailbox and RFC headers in storage and approval, then returns to the email', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(brief(page)).toBeFocused();
  await expect(field(page, 'subject')).toHaveValue('Re: Delivery date');
  await expect(page.locator('[data-form-array-item="to"]')).toHaveValue('desk@example.test');
  await expect(page.locator('[data-action="select-mail-compose-sender"]')).toHaveCount(0);
  const copies = page.locator('[data-mail-compose-copy-recipients]');
  await copies.locator('summary').click();
  await copies.locator('[data-form-array-add="cc"]').click();
  await copies.locator('[data-form-array-item="cc"]').fill('copy@example.test');
  await copies.locator('[data-form-array-add="bcc"]').click();
  await copies.locator('[data-form-array-item="bcc"]').fill('private@example.test');
  await copies.locator('summary').click();
  await brief(page).fill('Say I will review the scope before confirming the date.');
  await page.getByRole('button', { name: 'Draft with AI', exact: true }).click();
  await expect(field(page, 'body')).toHaveValue('I will review the revised scope before confirming a delivery date.');
  expect(await page.evaluate(() => window.__mailCompose.executions.map(call => call.recipe_id))).toEqual(['draft-composed-mail']);
  const ai = await page.evaluate(() => window.__mailCompose.executions[0]!.config);
  expect(ai.original_body).toContain('Can you confirm the delivery date?');
  expect(ai.cc).toEqual(['copy@example.test']);
  expect(ai.bcc).toEqual(['private@example.test']);
  expect(ai).not.toHaveProperty('in_reply_to');
  await page.getByRole('button', { name: 'Polish', exact: true }).click();
  await expect(field(page, 'body')).toHaveValue('Polished draft body.');
  await page.getByRole('button', { name: 'Undo last AI change', exact: true }).click();
  await expect(field(page, 'body')).toHaveValue('I will review the revised scope before confirming a delivery date.');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.locator('[data-mail-draft-status]')).toContainText('Draft saved.');
  expect(await page.evaluate(() => window.__mailCompose.saved()?.content)).toMatchObject({
    sender_mail_instance: 'work', to: ['desk@example.test'], in_reply_to: '<request@example.test>',
    references: ['<root@example.test>', '<request@example.test>'],
    cc: ['copy@example.test'], bcc: ['private@example.test'],
  });
  await page.evaluate(() => window.__mailCompose.holdSend());
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(field(page, 'subject')).toBeDisabled();
  await expect(field(page, 'body')).toBeDisabled();
  await expect(page.locator('[data-form-array-item="to"]')).toBeDisabled();
  await expect(brief(page)).toBeDisabled();
  await page.evaluate(() => window.__mailCompose.releaseSend());
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('waiting for approval');
  const sent = await page.evaluate(() => window.__mailCompose.executions.at(-1));
  expect(sent).toMatchObject({ recipe_id: 'send-composed-mail', config: {
    sender_mail_instance: 'work', in_reply_to: '<request@example.test>', references: ['<root@example.test>', '<request@example.test>'],
  } });
  await page.evaluate(() => window.__app.setHash('#mail'));
  await page.getByRole('button', { name: 'Re: Delivery date', exact: true }).click();
  await expect(field(page, 'body')).toBeFocused();
  await expect(copies.locator('[data-form-array-item="cc"]')).toBeVisible();
  await expect(copies.locator('[data-form-array-item="bcc"]')).toHaveValue('private@example.test');
  await expect(page.getByRole('button', { name: 'Draft with AI', exact: true })).toBeDisabled();
  await expect(field(page, 'body')).toHaveValue('I will review the revised scope before confirming a delivery date.');
});

test('drafts new mail from a brief and preserves newer typing and undo boundaries during delayed or failed AI calls', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__app.setHash('#mail'));
  await page.getByRole('button', { name: 'New mail', exact: true }).click();
  await brief(page).fill('Ask for the revised scope.');
  await field(page, 'subject').fill('Scope question');
  await field(page, 'subject').press('Enter');
  await expect(brief(page)).toHaveValue('Ask for the revised scope.');
  await page.evaluate(() => window.__mailCompose.holdAI());
  await page.getByRole('button', { name: 'Draft with AI', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Drafting…', exact: true })).toBeVisible();
  await field(page, 'body').fill('My newer words.');
  await page.evaluate(() => window.__mailCompose.releaseAI());
  await expect(page.getByRole('alert')).toContainText('newer text untouched');
  await expect(field(page, 'body')).toHaveValue('My newer words.');
  await page.getByRole('button', { name: 'Draft with AI', exact: true }).click();
  await expect(field(page, 'body')).toHaveValue('I will review the revised scope before confirming a delivery date.');
  expect(await page.evaluate(() => window.__mailCompose.executions[0]!.config.original_body)).toBe('');
  await field(page, 'body').fill('My edited draft.');
  await page.getByRole('button', { name: 'Undo last AI change', exact: true }).click();
  await expect(field(page, 'body')).toHaveValue('My edited draft.');
  await expect(page.getByRole('alert')).toContainText('message changed');
  await page.evaluate(() => window.__mailCompose.failAI());
  await page.getByRole('button', { name: 'Draft with AI', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('unavailable');
  await expect(field(page, 'body')).toHaveValue('My edited draft.');
  await expect(brief(page)).toHaveValue('Ask for the revised scope.');
  await page.evaluate(() => window.__mailCompose.holdAI());
  await page.getByRole('button', { name: 'Draft with AI', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Drafting…', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await page.getByRole('button', { name: 'New mail', exact: true }).click();
  await page.evaluate(() => window.__mailCompose.releaseAI());
  await expect(field(page, 'body')).toHaveValue('');
  await expect(brief(page)).toHaveValue('');
});

test('requires the original mailbox to send, rechecks before opening and sending, and keeps the draft after revocation', async ({ page }) => {
  await boot(page, { sending: false });
  await expect(page.getByRole('button', { name: 'Reply', exact: true })).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Sending is unavailable');
  await page.evaluate(() => window.__mailCompose.setSending(true));
  await page.getByRole('button', { name: 'Refresh email', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reply', exact: true })).toBeEnabled();
  await page.evaluate(() => window.__mailCompose.setSending(false));
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Sending is unavailable');
  await page.evaluate(() => window.__mailCompose.setSending(true));
  await page.getByRole('button', { name: 'Refresh email', exact: true }).click();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await field(page, 'body').fill('Manually written reply.');
  await page.evaluate(() => window.__mailCompose.setSending(false));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(field(page, 'body')).toHaveValue('Manually written reply.');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
});

test('keeps a phone reply inside the dialog, guards unsaved instructions, and returns keyboard focus to the email', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await brief(page).fill('Ask for more detail.');
  await page.getByRole('button', { name: 'Close', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  const send = dialog(page).getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeFocused();
  await expect(send).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(brief(page)).toHaveValue('Ask for more detail.');
  await brief(page).focus(); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reply', exact: true })).toBeFocused();
});

test('browses received and sent conversation messages on desktop and replies to the selected email', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await boot(page, { thread: true });
  const conversation = page.getByRole('region', { name: 'Email conversation', exact: true });
  const index = page.getByRole('navigation', { name: 'Messages in this conversation' });
  await expect(conversation).toContainText('3 loaded messages');
  expect(await page.evaluate(() => window.__mailCompose.reads.map(read => read.record_id))).toEqual(['mail-1']);
  await index.locator('[data-mail-record="mail-2"]').click();
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('sent a proposed date');
  await expect(page.getByRole('button', { name: 'Reply', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Follow this work' })).toHaveAttribute('href', /mail-2/);
  await index.locator('[data-mail-record="mail-3"]').click();
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('revised date is Friday');
  await expect(page.getByRole('link', { name: 'Follow this work' })).toHaveAttribute('href', /mail-3/);
  await page.screenshot({ path: testInfo.outputPath('conversation-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await brief(page).fill('Confirm Friday.');
  await page.getByRole('button', { name: 'Draft with AI', exact: true }).click();
  expect(await page.evaluate(() => window.__mailCompose.executions.at(-1)?.config.original_body)).toContain('revised date is Friday');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.locator('[data-mail-draft-status]')).toContainText('Draft saved.');
  expect(await page.evaluate(() => window.__mailCompose.saved()?.content)).toMatchObject({
    sender_mail_instance: 'work', in_reply_to: '<mail-3@example.test>', references: ['<request@example.test>', '<mail-3@example.test>'],
  });
  expect(await page.evaluate(() => window.__mailCompose.reads.at(-1)?.conversation)).toEqual({ thread_id: 'delivery-thread', incarnation: 'work-v1' });
});

test('keeps phone conversation selection correct through delayed reads and retrying older messages', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, { thread: true });
  const card = (id: string) => page.locator(`.data-mail-conversation-toggle[data-mail-record="${id}"]`);
  await page.evaluate(() => window.__mailCompose.holdMessage('mail-2'));
  await card('mail-2').click();
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Reading email');
  // Start with keyboard focus so the assertion checks retention across the read.
  await card('mail-3').focus();
  await card('mail-3').press('Enter');
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('revised date is Friday');
  await page.evaluate(() => window.__mailCompose.releaseMessage('mail-2'));
  await expect(page.getByRole('article', { name: 'Email message' })).not.toContainText('sent a proposed date');
  await expect(card('mail-3')).toBeFocused();
  await card('mail-3').click();
  await expect(page.getByRole('article', { name: 'Email message' })).toHaveCount(0);
  await card('mail-3').click();
  await page.evaluate(() => window.__mailCompose.failOlder());
  await page.getByRole('button', { name: 'Load older messages', exact: true }).focus();
  await page.getByRole('button', { name: 'Load older messages', exact: true }).press('Enter');
  await expect(page.getByRole('alert')).toContainText('Earlier mail is temporarily unavailable');
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('revised date is Friday');
  await page.getByRole('button', { name: 'Load older messages', exact: true }).press('Enter');
  await expect(card('mail-0')).toBeVisible();
  await expect(page.getByText('All available synced messages are loaded.', { exact: true })).toBeFocused();
  await page.evaluate(() => window.__mailCompose.holdConversation());
  await page.getByRole('button', { name: 'Refresh conversation', exact: true }).click();
  await card('mail-0').click();
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Original conversation context');
  await page.evaluate(() => window.__mailCompose.releaseConversation());
  await expect(page.getByRole('button', { name: 'Refresh conversation', exact: true })).toBeEnabled();
  await expect(card('mail-0')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Original conversation context');
  await expect(page.getByRole('link', { name: 'Follow this work' })).toHaveAttribute('href', /mail-0/);
  await page.getByRole('button', { name: 'Refresh conversation', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Original conversation context');
  await page.screenshot({ path: testInfo.outputPath('conversation-mobile.png'), fullPage: true });
});

test('keeps the email readable and replyable when conversation history fails, then retries history', async ({ page }) => {
  await boot(page, { thread: true, historyFails: true });
  await expect(page.getByRole('alert')).toContainText('Conversation history is temporarily unavailable');
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator('[data-form-array-item="to"]')).toHaveValue('desk@example.test');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await page.evaluate(() => window.__mailCompose.recoverHistory());
  await page.getByRole('button', { name: 'Retry conversation', exact: true }).focus();
  await page.getByRole('button', { name: 'Retry conversation', exact: true }).press('Enter');
  await expect(page.getByRole('region', { name: 'Email conversation', exact: true })).toContainText('3 loaded messages');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh conversation', exact: true })).toBeFocused();
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Can you confirm the delivery date?');
});

test('keeps the current message visible in a long conversation index while reading and refreshing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await boot(page, { thread: true, messageCount: 30 });
  const index = page.getByRole('navigation', { name: 'Messages in this conversation' });
  const current = index.locator('[data-mail-record="mail-30"]');
  await current.focus();
  await current.press('Enter');
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Update from message 30.');
  await expect(current).toBeFocused();
  await expect(current).toBeInViewport();
  await page.evaluate(() => window.__mailCompose.holdMessage('mail-30'));
  const refresh = page.getByRole('button', { name: 'Refresh email', exact: true });
  await refresh.focus();
  await refresh.press('Enter');
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Reading email');
  await expect(current).toBeInViewport();
  await page.evaluate(() => window.__mailCompose.releaseMessage('mail-30'));
  await expect(page.getByRole('article', { name: 'Email message' })).not.toContainText('Reading email');
  await expect(refresh).toBeFocused();
  await expect(current).toBeInViewport();
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await page.locator('[data-collection-record="mail-1"]').click();
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Can you confirm the delivery date?');
  await expect(index.locator('[data-mail-record="mail-1"]')).toBeInViewport();
});

test('mail triage changes read and star status without sending access, on desktop and phone', async ({ page }, testInfo) => {
  await boot(page, { thread: true, sending: false, triage: 'writable' });
  const article = page.getByRole('article', { name: 'Email message' });
  const status = article.getByLabel('Email status', { exact: true });
  const more = article.getByRole('button', { name: 'More', exact: true });
  const index = page.getByRole('navigation', { name: 'Messages in this conversation' }).locator('[data-mail-record="mail-1"]');
  await expect(status).toHaveText('Unread');
  expect(await page.evaluate(() => window.__mailCompose.stateChanges)).toEqual([]);
  await more.click();
  await article.screenshot({ path: testInfo.outputPath('mail-actions-desktop.png') });
  await article.getByRole('button', { name: 'Mark as read', exact: true }).click();
  await expect(status).toHaveText('Read'); await expect(index).not.toContainText('Unread');
  await more.click(); await article.getByRole('button', { name: 'Mark as unread', exact: true }).click();
  await expect(status).toHaveText('Unread'); await expect(index).toContainText('Unread');
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
  await more.click();
  await page.screenshot({ path: testInfo.outputPath('mail-actions-phone-dark.png'), fullPage: true });
  await article.getByRole('button', { name: 'Star email', exact: true }).click();
  await expect(status).toHaveText('Unread · Starred');
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await page.locator('[data-collection-record="mail-1"]').click();
  await expect(status).toHaveText('Unread · Starred');
  await more.click(); await article.getByRole('button', { name: 'Remove star', exact: true }).click();
  await expect(status).toHaveText('Unread');
  const actions = await page.evaluate(() => window.__mailCompose.stateChanges);
  expect(actions.map(input => input.change)).toEqual([{ kind: 'read', value: true }, { kind: 'read', value: false },
    { kind: 'star', value: true }, { kind: 'star', value: false }]);
  expect(actions.every(input => input.slug === 'work' && input.record_id === 'mail-1'
    && input.conversation?.incarnation === 'work-v1')).toBe(true);
  expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
});

test('mail triage holds navigation and duplicate actions until the provider confirms', async ({ page }) => {
  await boot(page, { thread: true, triage: 'writable' });
  const article = page.getByRole('article', { name: 'Email message' });
  await page.evaluate(() => window.__mailCompose.holdState());
  await article.getByRole('button', { name: 'More', exact: true }).click();
  await article.getByRole('button', { name: 'Mark as read', exact: true }).click();
  await expect(article).toContainText('Updating email…');
  await expect(article.getByLabel('Email status', { exact: true })).toHaveText('Unread');
  await article.getByRole('button', { name: 'More', exact: true }).click({ force: true });
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await expect(article).toBeVisible();
  expect(await page.evaluate(() => window.__mailCompose.stateChanges.length)).toBe(1);
  await page.evaluate(() => window.__mailCompose.releaseState());
  await expect(article.getByLabel('Email status', { exact: true })).toHaveText('Read');
});

test('mail triage requires a successful check after a lost response and reconciles the conversation', async ({ page }) => {
  await boot(page, { thread: true, triage: 'writable' });
  const article = page.getByRole('article', { name: 'Email message' });
  const more = article.getByRole('button', { name: 'More', exact: true });
  await page.evaluate(() => window.__mailCompose.loseStateResponse());
  await more.click(); await article.getByRole('button', { name: 'Star email', exact: true }).click();
  await expect(article.getByRole('alert')).toContainText('Refresh this email before trying another change.');
  await more.click(); await expect(article.getByRole('button', { name: 'Star email', exact: true })).toBeDisabled();
  await page.evaluate(() => window.__mailCompose.failStateRead(true));
  await article.getByRole('button', { name: 'Refresh email', exact: true }).click();
  await expect(article.getByRole('button', { name: 'Star email', exact: true })).toBeDisabled();
  await page.evaluate(() => window.__mailCompose.failStateRead(false));
  await article.getByRole('button', { name: 'Refresh email', exact: true }).click();
  await expect(article.getByRole('button', { name: 'Remove star', exact: true })).toBeEnabled();
  await expect(page.getByRole('navigation', { name: 'Messages in this conversation' }).locator('[data-mail-record="mail-1"]')).toContainText('Starred');
  expect(await page.evaluate(() => window.__mailCompose.stateChanges.length)).toBe(1);
});

test('mail triage checks keep the mailbox list current when conversation history is unavailable', async ({ page }) => {
  await boot(page, { sending: false, historyFails: true, triage: 'writable' });
  const article = page.getByRole('article', { name: 'Email message' });
  const status = article.getByLabel('Email status', { exact: true });
  const more = article.getByRole('button', { name: 'More', exact: true });
  await more.click(); await article.getByRole('button', { name: 'Mark as read', exact: true }).click();
  await expect(article).toContainText('Marked as read.');
  await page.evaluate(() => window.__mailCompose.setRemoteFlags('mail-1', { is_read: false, is_flagged: false }));
  await article.getByRole('button', { name: 'Refresh email', exact: true }).click();
  await expect(status).toHaveText('Unread');
  await expect(article).not.toContainText('Marked as read.');
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await expect(page.locator('[data-collection-record="mail-1"] .col-explorer-mail-status')).toContainText('Unread');
  await page.locator('[data-collection-record="mail-1"]').click();
  await expect(article).not.toContainText('Marked as read.');
  await page.evaluate(() => window.__mailCompose.loseStateResponse());
  await more.click(); await article.getByRole('button', { name: 'Mark as read', exact: true }).click();
  await expect(article.getByRole('alert')).toContainText('Refresh this email');
  await expect(status).toHaveText('Last confirmed: Unread');
  await article.getByRole('button', { name: 'Refresh email', exact: true }).click();
  await expect(status).toHaveText('Read');
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await expect(page.locator('[data-collection-record="mail-1"] .col-explorer-mail-status')).not.toContainText('Unread');
});

test('mail triage explains a read-only mailbox without offering an executable action', async ({ page }) => {
  await boot(page, { triage: 'read_only' });
  const article = page.getByRole('article', { name: 'Email message' });
  await article.getByRole('button', { name: 'More', exact: true }).click();
  await expect(article.getByRole('button', { name: 'Mark as read', exact: true })).toBeDisabled();
  await expect(article.getByRole('button', { name: 'Star email', exact: true })).toBeDisabled();
  await expect(article.getByRole('group', { name: 'Email actions' })).toContainText('This mailbox is read-only.');
  expect(await page.evaluate(() => window.__mailCompose.stateChanges)).toEqual([]);
});

const recoveries = (page: Page) => page.locator('[data-mail-compose-recoveries]');
const recoveryEntries = (page: Page) => page.evaluate(() => Object.keys(sessionStorage)
  .filter(key => key.startsWith('recued.mail.compose-recovery.v1:'))
  .flatMap(key => JSON.parse(sessionStorage.getItem(key)!) as MailRecoveryEntry[]));
const reopenMail = async (page: Page, reload = false): Promise<void> => {
  if (reload) {
    const accept = (prompt: import('@playwright/test').Dialog) => { void prompt.accept(); };
    page.on('dialog', accept);
    await page.reload();
    page.off('dialog', accept);
    await page.waitForFunction(() => window.__app?.ready === true);
  }
  await page.evaluate(() => { window.confirm = () => true; window.__app.setHash('#mail'); });
  await expect(recoveries(page).getByRole('heading', { name: 'Unfinished messages in this tab' })).toBeVisible();
};

test('recovery restores incomplete reply fields, instructions, attachments and RFC context after reload', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, { group: true, durableProfile: true });
  await page.getByRole('button', { name: 'Reply all', exact: true }).click();
  await page.locator('[data-form-array-item="to"]').first().fill('  unfinished@');
  await page.locator('[data-form-array-add="to"]').click();
  const copies = page.locator('[data-mail-compose-copy-recipients]');
  if (!(await copies.evaluate(node => (node as HTMLDetailsElement).open))) await copies.locator('summary').click();
  await page.locator('[data-form-array-add="bcc"]').click();
  await page.locator('[data-form-array-item="bcc"]').fill('private@');
  await field(page, 'subject').fill('Unfinished scope question');
  await field(page, 'body').fill('My reply 👋\nStill in progress.\n');
  await brief(page).fill('Ask about the revised scope.');
  await page.getByRole('button', { name: 'Attach a file', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Attach files', exact: true });
  await picker.getByRole('checkbox', { name: 'Scope notes.txt' }).check();
  await picker.getByRole('button', { name: 'Attach', exact: true }).click();
  await reopenMail(page, true);
  expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
  await recoveries(page).getByRole('button', { name: 'Restore message', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Reply all', exact: true })).toBeVisible();
  await expect(field(page, 'body')).toBeFocused();
  await expect(field(page, 'subject')).toHaveValue('Unfinished scope question');
  await expect(field(page, 'body')).toHaveValue('My reply 👋\nStill in progress.\n');
  await expect(brief(page)).toHaveValue('Ask about the revised scope.');
  expect(await page.locator('[data-form-array-item="to"]').evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value)))
    .toEqual(['  unfinished@', 'colleague@example.test', '']);
  await expect(page.locator('[data-form-array-item="cc"]')).toHaveValue('copy@example.test');
  await expect(page.locator('[data-form-array-item="bcc"]')).toHaveValue('private@');
  await expect(dialog(page)).toContainText('Scope notes.txt');
  await expect(page.locator('[data-action="select-mail-compose-sender"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
  await page.locator('[data-form-array-item="to"]').first().fill('desk@example.test');
  await page.locator('[data-form-array-item="bcc"]').fill('private@example.test');
  await page.getByRole('button', { name: 'Draft with AI', exact: true }).click();
  await expect(field(page, 'body')).toHaveValue('I will review the revised scope before confirming a delivery date.');
  expect(await page.evaluate(() => window.__mailCompose.executions[0]!.config.original_body)).toContain('Can you confirm the delivery date?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__mailCompose.executions.at(-1)?.config)).toMatchObject({
    sender_mail_instance: 'work', in_reply_to: '<request@example.test>', references: ['<root@example.test>', '<request@example.test>'],
    attachments: ['file:' + '1'.repeat(32)], to: ['desk@example.test', 'colleague@example.test'], bcc: ['private@example.test'],
  });
  await expect(recoveries(page)).toContainText('Waiting for your approval');
  await recoveries(page).getByRole('button', { name: 'View submitted message', exact: true }).click();
  await expect(field(page, 'body')).toBeDisabled();
});

test('recovery preserves native typing undo, survives leaving Mail, and respects explicit discard', async ({ page }) => {
  await boot(page, { durableProfile: true });
  await page.evaluate(() => window.__app.setHash('#mail'));
  await page.getByRole('button', { name: 'New mail', exact: true }).click();
  await field(page, 'body').focus(); await field(page, 'body').press('x');
  await expect.poll(async () => (await recoveryEntries(page))[0]?.dialog.values.body).toBe('x');
  await expect(field(page, 'body')).toBeFocused();
  await field(page, 'body').press('ControlOrMeta+z'); await expect(field(page, 'body')).toHaveValue('');
  await field(page, 'body').fill('Before');
  await page.evaluate(() => { window.confirm = () => true; window.__app.setHash('#chat'); });
  await reopenMail(page);
  await recoveries(page).getByRole('button', { name: 'Restore message', exact: true }).click();
  await expect(field(page, 'body')).toHaveValue('Before');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(field(page, 'body')).toHaveValue('Before');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0); expect(await recoveryEntries(page)).toEqual([]);
});

test('recovery rechecks the original mailbox account instead of choosing another available sender', async ({ page }) => {
  await boot(page, { durableProfile: true }); await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await field(page, 'body').fill('For my original account.');
  await reopenMail(page);
  await page.evaluate(() => window.__mailCompose.setSenderMailbox('replacement@example.test'));
  await recoveries(page).getByRole('button', { name: 'Restore message', exact: true }).click();
  await expect(recoveries(page).getByRole('alert')).toContainText('Reconnect the original mailbox');
  await expect(recoveries(page).getByRole('button', { name: 'Restore message', exact: true })).toBeFocused();
  await expect(dialog(page)).toHaveCount(0); expect(await recoveryEntries(page)).toHaveLength(1);
  expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
  await page.evaluate(() => window.__mailCompose.setSenderMailbox('owner@example.test'));
  await recoveries(page).getByRole('button', { name: 'Restore message', exact: true }).click();
  await expect(field(page, 'body')).toHaveValue('For my original account.');
});

test('recovery after a reload during Send is readonly and cannot submit a second copy', async ({ page }) => {
  await boot(page, { durableProfile: true }); await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await field(page, 'body').fill('One submitted copy.'); await page.evaluate(() => window.__mailCompose.holdSend());
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await recoveryEntries(page))[0]?.status).toBe('pending');
  await reopenMail(page, true);
  await recoveries(page).getByRole('button', { name: 'View submitted message', exact: true }).click();
  await expect(field(page, 'body')).toHaveValue('One submitted copy.');
  await expect(field(page, 'body')).toBeDisabled(); await expect(brief(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await expect(dialog(page)).toContainText('Send outcome not confirmed');
  await expect(dialog(page).getByRole('link', { name: 'Open Approvals' })).toHaveAttribute('href', '#approvals');
  await page.locator('[data-action="submit-mail-compose"]').dispatchEvent('click');
  expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await recoveries(page).getByRole('button', { name: 'Discard recovery', exact: true }).click();
  await expect(recoveries(page).getByRole('button', { name: 'Keep recovery', exact: true })).toBeFocused();
  await expect(recoveries(page)).toContainText('does not cancel any submitted mail run');
  await recoveries(page).getByRole('button', { name: 'Keep recovery', exact: true }).click();
  await expect(recoveries(page).getByRole('button', { name: 'Discard recovery', exact: true })).toBeFocused();
  expect(await recoveryEntries(page)).toHaveLength(1);
  await recoveries(page).getByRole('button', { name: 'Discard recovery', exact: true }).click();
  await recoveries(page).getByRole('button', { name: 'Remove recovery copy', exact: true }).click();
  expect(await recoveryEntries(page)).toEqual([]);
  await expect(page.getByRole('button', { name: 'New mail', exact: true })).toBeFocused();
});

for (const response of ['lost', 'incomplete'] as const) {
  test(`recovery locks a ${response} send response until the owner checks its outcome`, async ({ page }) => {
    await boot(page, { durableProfile: true }); await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await field(page, 'body').fill('Outcome must be checked.'); await page.evaluate(value => window.__mailCompose.setSendOutcome(value), response);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(dialog(page)).toContainText('Send outcome not confirmed');
    await page.locator('[data-action="submit-mail-compose"]').dispatchEvent('click');
    expect(await page.evaluate(() => window.__mailCompose.executions.length)).toBe(1);
    await reopenMail(page, true);
    await recoveries(page).getByRole('button', { name: 'View submitted message', exact: true }).click();
    await expect(field(page, 'body')).toBeDisabled();
    expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
  });
}

test('recovery settles a late accepted send after leaving Data without removing a newer draft', async ({ page }) => {
  await boot(page, { durableProfile: true }); await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await field(page, 'body').fill('Earlier send.');
  await page.evaluate(() => { window.__mailCompose.setSendOutcome('sent'); window.__mailCompose.holdSend(); });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await recoveryEntries(page))[0]?.status).toBe('pending');
  await reopenMail(page);
  await page.getByRole('button', { name: 'New mail', exact: true }).click();
  await field(page, 'body').fill('A different unfinished message.');
  await expect.poll(async () => (await recoveryEntries(page)).length).toBe(2);
  await page.evaluate(() => window.__mailCompose.releaseSend());
  await expect.poll(async () => (await recoveryEntries(page)).length).toBe(1);
  expect((await recoveryEntries(page))[0]?.dialog.values.body).toBe('A different unfinished message.');
  expect(await page.evaluate(() => window.__mailCompose.executions.length)).toBe(1);
});

test('recovery copies edits to a new draft when the saved revision changed elsewhere', async ({ page }) => {
  await boot(page, { durableProfile: true }); await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await field(page, 'body').fill('First saved version.'); await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.locator('[data-mail-draft-status]')).toContainText('Draft saved.');
  await field(page, 'body').fill('My newer unfinished version.'); await reopenMail(page);
  await page.evaluate(() => window.__mailCompose.reviseSaved());
  await recoveries(page).getByRole('button', { name: 'Restore message', exact: true }).click();
  await expect(field(page, 'body')).toHaveValue('My newer unfinished version.');
  await expect(dialog(page)).toContainText('opened as a new draft');
  expect(await page.evaluate(() => window.__mailCompose.saved()?.content.body)).toBe('A newer server edit.');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.locator('[data-mail-draft-status]')).toContainText('Draft saved.');
  expect(await page.evaluate(() => window.__app.rpcCallCount('mail.drafts.update'))).toBe(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('mail.drafts.create'))).toBe(2);
});

test('recovery also keeps unfinished mail created from Chat', async ({ page }) => {
  await boot(page, { durableProfile: true });
  await page.goto(`${HARNESS_URL}?recipes=installed&server_profiles=multiple&chat=session#chat/session/chat_1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.getByRole('button', { name: 'New mail', exact: true }).click();
  await field(page, 'body').fill('Started from Chat.'); await brief(page).fill('An unfinished Chat instruction.');
  await reopenMail(page, true);
  await recoveries(page).getByRole('button', { name: 'Restore message', exact: true }).click();
  await expect(field(page, 'body')).toHaveValue('Started from Chat.');
  await expect(brief(page)).toHaveValue('An unfinished Chat instruction.');
  expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
});

test('recovery reports blocked storage, keeps typed work and prevents an untracked send', async ({ page }) => {
  await boot(page, { durableProfile: true }); await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await field(page, 'body').fill('Preserve these exact edits.');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('recued.mail.compose-recovery.v1:')) throw new DOMException('Full', 'QuotaExceededError');
      return original.call(this, key, value);
    };
    window.dispatchEvent(new Event('pagehide'));
  });
  await expect(dialog(page)).toContainText('Latest edits could not be kept in this tab');
  await expect(field(page, 'body')).toHaveValue('Preserve these exact edits.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('send status could not be kept');
  expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
  await expect(field(page, 'body')).toHaveValue('Preserve these exact edits.');
  await expect(field(page, 'body')).toBeEnabled();
});

test('recovery binds a new message to its chosen account and permits an explicit From change', async ({ page }) => {
  await boot(page, { durableProfile: true }); await page.evaluate(() => window.__app.setHash('#mail'));
  await page.getByRole('button', { name: 'New mail', exact: true }).click();
  await page.locator('[data-form-array-add="to"]').click();
  await page.locator('[data-form-array-item="to"]').fill('lead@example.test');
  await field(page, 'subject').fill('Account choice'); await field(page, 'body').fill('My chosen sender matters.');
  await page.evaluate(() => window.__mailCompose.setSenderMailbox('replacement@example.test'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('mailbox changed');
  expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
  await page.locator('[data-action="select-mail-compose-sender"]').selectOption('other');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__mailCompose.executions.at(-1)?.config.sender_mail_instance)).toBe('other');
});

const inboxRows = (page: Page) => page.locator('.col-explorer-mail-row');
const inboxIds = (page: Page) => inboxRows(page).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-collection-record')));

test('inbox filters combine on the server, show stars, and reset to all saved messages on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await boot(page, { inbox: true, triage: 'writable' });
  await page.getByLabel('Message status', { exact: true }).selectOption('unread');
  await page.getByLabel('Mail direction', { exact: true }).selectOption('received');
  await page.getByRole('checkbox', { name: 'Has attachments', exact: true }).check();
  await expect(inboxRows(page)).toHaveCount(9);
  expect(await inboxIds(page)).toEqual(['mail-64', 'mail-56', 'mail-52', 'mail-44', 'mail-32', 'mail-28', 'mail-16', 'mail-8', 'mail-4']);
  expect(await page.evaluate(() => window.__mailInbox.requests.at(-1))).toMatchObject({ platform: 'mail', slug: 'work',
    filters: { is_read: false, direction: 'inbound', has_attachments: true }, limit: 31 });
  await page.getByLabel('Message status', { exact: true }).selectOption('starred');
  await page.getByLabel('Mail direction', { exact: true }).selectOption('sent');
  await expect(inboxRows(page)).toHaveCount(0); await expect(page.locator('.col-explorer-empty')).toContainText('No saved messages match these filters');
  await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
  await expect(inboxRows(page)).toHaveCount(30); await expect(page.getByRole('checkbox', { name: 'Has attachments', exact: true })).not.toBeChecked();
  await page.getByLabel('Message status', { exact: true }).selectOption('starred');
  await expect(inboxRows(page)).toHaveCount(9); await expect(inboxRows(page).first()).toContainText('Starred');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
});

test('inbox paging crosses timestamp ties, retries the same failed page and blocks duplicate loads', async ({ page }) => {
  await boot(page, { inbox: true });
  const initial = await inboxIds(page), boundary = initial.at(-1);
  await page.evaluate(() => { window.__mailInbox.holdNext(); window.__mailInbox.failNext(); });
  await page.getByRole('button', { name: 'Load more messages', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mailInbox.pending())).toBe(true);
  const pendingCount = await page.evaluate(() => window.__mailInbox.requests.length);
  await page.locator('[data-recued-data-action="mail-inbox-more"]').dispatchEvent('click');
  expect(await page.evaluate(() => window.__mailInbox.requests.length)).toBe(pendingCount);
  await page.evaluate(() => window.__mailInbox.release());
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable'); expect(await inboxIds(page)).toEqual(initial);
  await expect(page.getByRole('button', { name: 'Retry messages', exact: true })).toBeFocused();
  const failed = await page.evaluate(() => window.__mailInbox.requests.at(-1)); expect(failed?.before?.record_id).toBe(boundary);
  await page.getByRole('button', { name: 'Retry messages', exact: true }).click();
  await expect(inboxRows(page)).toHaveCount(60); expect(await page.evaluate(() => window.__mailInbox.requests.at(-1))).toEqual(failed);
  await page.getByRole('button', { name: 'Load more messages', exact: true }).click();
  await expect(inboxRows(page)).toHaveCount(65); await expect(page.getByRole('button', { name: 'Load more messages', exact: true })).toHaveCount(0);
  const ids = await inboxIds(page); expect(new Set(ids).size).toBe(65);
  expect([...ids].sort()).toEqual(Array.from({ length: 65 }, (_, index) => `mail-${index + 1}`).sort());
});

test('inbox return keeps filters, loaded pages, scroll and focus through Back and browser history', async ({ page }) => {
  await boot(page, { inbox: true, triage: 'writable' });
  await page.getByLabel('Message status', { exact: true }).selectOption('unread');
  await expect(inboxRows(page)).toHaveCount(30); await page.getByRole('button', { name: 'Load more messages', exact: true }).click();
  await expect(inboxRows(page)).toHaveCount(44);
  const row = page.locator('[data-collection-record="mail-7"]'), scroll = page.locator('[data-recued-webclient-content]');
  await row.scrollIntoViewIfNeeded(); const position = await scroll.evaluate(node => node.scrollTop); expect(position).toBeGreaterThan(0);
  await row.click(); await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Update from message 7');
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await expect(row).toBeFocused(); await expect(inboxRows(page)).toHaveCount(44);
  await expect(page.getByLabel('Message status', { exact: true })).toHaveValue('unread');
  expect(await scroll.evaluate(node => node.scrollTop)).toBe(position);
  await row.click(); await expect(page.getByRole('article', { name: 'Email message' })).toBeVisible();
  await page.goBack(); await expect(row).toBeFocused(); await expect(inboxRows(page)).toHaveCount(44);
  expect(await scroll.evaluate(node => node.scrollTop)).toBe(position);
  await page.goForward(); await expect(page.getByRole('article', { name: 'Email message' })).toBeVisible();
  await page.goBack(); await expect(row).toBeFocused(); await expect(inboxRows(page)).toHaveCount(44);
  await expect(page.getByLabel('Message status', { exact: true })).toHaveValue('unread');
  expect(await scroll.evaluate(node => node.scrollTop)).toBe(position);
});

test('inbox returning after marking a message read removes it from Unread and focuses the next result', async ({ page }) => {
  await boot(page, { inbox: true, triage: 'writable' });
  await page.getByLabel('Message status', { exact: true }).selectOption('unread');
  await page.getByLabel('Mail direction', { exact: true }).selectOption('received');
  await page.getByRole('checkbox', { name: 'Has attachments', exact: true }).check(); await expect(inboxRows(page)).toHaveCount(9);
  await page.locator('[data-collection-record="mail-64"]').click();
  const article = page.getByRole('article', { name: 'Email message' });
  await article.getByRole('button', { name: 'More', exact: true }).click();
  await article.getByRole('button', { name: 'Mark as read', exact: true }).click();
  await expect(article.getByLabel('Email status', { exact: true })).toHaveText('Read');
  await page.getByRole('button', { name: '← Back', exact: true }).click();
  await expect(inboxRows(page)).toHaveCount(8); await expect(page.locator('[data-collection-record="mail-64"]')).toHaveCount(0);
  await expect(page.locator('[data-collection-record="mail-56"]')).toBeFocused();
  await expect(page.getByLabel('Message status', { exact: true })).toHaveValue('unread');
  expect(await page.evaluate(() => window.__mailCompose.stateChanges.map(change => change.change))).toEqual([{ kind: 'read', value: true }]);
});

test('inbox retires old filter and mailbox reads while keeping each mailbox’s own filters', async ({ page }) => {
  await boot(page, { inbox: true }); await page.evaluate(() => window.__mailInbox.holdNext());
  await page.getByLabel('Message status', { exact: true }).selectOption('unread');
  await expect.poll(() => page.evaluate(() => window.__mailInbox.pending())).toBe(true);
  await page.getByLabel('Message status', { exact: true }).selectOption('starred'); await expect(inboxRows(page)).toHaveCount(9);
  await page.evaluate(() => window.__mailInbox.release()); await expect(page.getByLabel('Message status', { exact: true })).toHaveValue('starred');
  await expect(inboxRows(page)).toHaveCount(9);
  await page.evaluate(() => window.__mailInbox.holdNext());
  await page.getByLabel('Mail direction', { exact: true }).selectOption('sent');
  await expect.poll(() => page.evaluate(() => window.__mailInbox.pending())).toBe(true);
  await page.locator('[data-collection-slug="other"]').click(); await expect(inboxRows(page)).toHaveCount(30);
  await page.evaluate(() => window.__mailInbox.release());
  await expect(page.getByLabel('Message status', { exact: true })).toHaveValue('all');
  await page.locator('[data-collection-slug="work"]').click();
  await expect(page.getByLabel('Message status', { exact: true })).toHaveValue('starred');
  await expect(page.getByLabel('Mail direction', { exact: true })).toHaveValue('sent');
  expect(await inboxIds(page)).toEqual(['mail-35']);
});

test('inbox rejects a server that ignores paging and retains the confirmed page', async ({ page }) => {
  await boot(page, { inbox: true }); const before = await inboxIds(page);
  await page.evaluate(() => window.__mailInbox.ignorePaging()); await page.getByRole('button', { name: 'Load more messages', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('page did not advance'); expect(await inboxIds(page)).toEqual(before);
  expect(await page.evaluate(() => window.__mailInbox.requests.length)).toBe(2);
});

test.describe('Mail reader navigation', () => {
  const readingInbox = (page: Page) => page.getByRole('complementary', { name: 'Inbox messages', exact: true });
  const navigation = (page: Page) => page.getByRole('navigation', { name: 'Browse inbox emails', exact: true });
  const next = (page: Page) => navigation(page).getByRole('button', { name: 'Next email', exact: true });
  const previous = (page: Page) => navigation(page).getByRole('button', { name: 'Previous email', exact: true });
  const opened = async (page: Page, id: string) => {
    await expect(page.getByRole('heading', { name: `Inbox message ${id.slice(5)}`, exact: true })).toBeVisible();
    await expect(page.getByRole('article', { name: 'Email message', exact: true })).toHaveAttribute('aria-busy', 'false');
  };
  const filtered = async (page: Page) => {
    await page.getByLabel('Message status', { exact: true }).selectOption('unread');
    await page.getByLabel('Mail direction', { exact: true }).selectOption('received');
    await page.getByRole('checkbox', { name: 'Has attachments', exact: true }).check();
    await expect(inboxRows(page)).toHaveCount(9);
  };

  test('switches directly between filtered messages while keeping the desktop inbox in place', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 800 });
    await boot(page, { inbox: true, triage: 'writable' });
    await filtered(page);
    const ids = await inboxIds(page), first = ids[0]!, later = ids[7]!;
    const origin = page.locator(`[data-collection-record="${first}"]`);
    const content = page.locator('[data-recued-webclient-content]');
    await origin.scrollIntoViewIfNeeded();
    const inboxPosition = await content.evaluate(node => node.scrollTop);
    await origin.press('Enter');
    await opened(page, first);

    const inbox = readingInbox(page);
    await expect(inbox.getByRole('heading')).toHaveText('Inbox work');
    await expect(inbox).toContainText('Unread · Received · Has attachments');
    await expect(inbox.locator('[data-collection-record]')).toHaveCount(ids.length);
    const selected = inbox.locator(`[data-collection-record="${first}"]`);
    await expect(selected).toHaveAttribute('aria-current', 'true');
    await expect(inbox.locator('[data-collection-record][tabindex="0"]')).toHaveCount(1);
    const target = inbox.locator(`[data-collection-record="${later}"]`);
    const scroll = inbox.locator('[data-mail-reader-inbox-scroll]');
    await selected.press('End');
    await page.keyboard.press('ArrowUp');
    await expect(target).toBeFocused();
    const position = await scroll.evaluate(node => node.scrollTop);
    expect(position).toBeGreaterThan(0);
    await page.keyboard.press('Enter');
    await opened(page, later);
    await expect(page).toHaveURL(new RegExp(`#data/mail/record/work/${later}$`));
    await expect(target).toHaveAttribute('aria-current', 'true');
    await expect(target).toBeFocused();
    expect(await scroll.evaluate(node => node.scrollTop)).toBe(position);

    await page.setViewportSize({ width: 1279, height: 800 });
    await expect(inbox).toHaveCount(0);
    await expect(next(page)).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(target).toHaveAttribute('aria-current', 'true');
    expect(await scroll.evaluate(node => node.scrollTop)).toBe(position);

    await page.goBack();
    await expect(origin).toBeFocused();
    expect(await inboxIds(page)).toEqual(ids);
    expect(await content.evaluate(node => node.scrollTop)).toBe(inboxPosition);
    await expect(page.getByLabel('Message status', { exact: true })).toHaveValue('unread');
    await page.goForward();
    await opened(page, later);
    await expect(inbox).toHaveCount(0);
  });

  test('steps through the filtered inbox from the keyboard and returns to the same list position', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page, { inbox: true, triage: 'writable' }); await filtered(page);
    const ids = await inboxIds(page), anchor = ids[3]!;
    const row = page.locator(`[data-collection-record="${anchor}"]`), scroll = page.locator('[data-recued-webclient-content]');
    await row.scrollIntoViewIfNeeded(); const position = await scroll.evaluate(node => node.scrollTop);
    await row.click(); await opened(page, anchor);
    await next(page).focus(); await next(page).press('Enter'); await opened(page, ids[4]!);
    await expect(next(page)).toBeFocused();
    await previous(page).press('Enter'); await opened(page, anchor); await expect(previous(page)).toBeFocused();
    expect(await page.evaluate(() => window.__mailCompose.reads.at(-1)?.record_id)).toBe(anchor);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('mail-reader-navigation-phone-dark.png') });

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.goBack();
    await expect(row).toBeFocused(); expect(await inboxIds(page)).toEqual(ids);
    expect(await scroll.evaluate(node => node.scrollTop)).toBe(position);
    await expect(page.getByLabel('Message status', { exact: true })).toHaveValue('unread');
    await expect(page.getByLabel('Mail direction', { exact: true })).toHaveValue('received');
    await expect(page.getByRole('checkbox', { name: 'Has attachments', exact: true })).toBeChecked();
    expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
    expect(await page.evaluate(() => window.__mailCompose.stateChanges)).toEqual([]);
  });

  test('loads the next inbox page once, retries a failed cursor, and keeps loaded pages on return', async ({ page }) => {
    await boot(page, { inbox: true });
    await page.locator('[data-collection-record="mail-36"]').click(); await opened(page, 'mail-36');
    await page.evaluate(() => { window.__mailInbox.holdNext(); window.__mailInbox.failNext(); });
    await next(page).click(); await expect.poll(() => page.evaluate(() => window.__mailInbox.pending())).toBe(true);
    await expect(next(page)).toHaveAttribute('aria-disabled', 'true');
    const count = await page.evaluate(() => window.__mailInbox.requests.length);
    await next(page).dispatchEvent('click'); expect(await page.evaluate(() => window.__mailInbox.requests.length)).toBe(count);
    await page.evaluate(() => window.__mailInbox.release());
    await expect(navigation(page).getByRole('alert')).toContainText('temporarily unavailable'); await opened(page, 'mail-36');
    const failed = await page.evaluate(() => window.__mailInbox.requests.at(-1));
    expect(failed?.before?.record_id).toBe('mail-36');
    await next(page).click(); await opened(page, 'mail-35'); await expect(next(page)).toBeFocused();
    expect(await page.evaluate(() => window.__mailInbox.requests.at(-1))).toEqual(failed);
    await expect(readingInbox(page).locator('[data-collection-record]')).toHaveCount(60);
    await page.getByRole('button', { name: '← Back', exact: true }).click();
    await expect(inboxRows(page)).toHaveCount(60); await expect(page.locator('[data-collection-record="mail-36"]')).toBeFocused();
  });

  test('keeps navigating after the current email leaves Unread and holds navigation during a status write', async ({ page }) => {
    await boot(page, { inbox: true, triage: 'writable' }); await filtered(page);
    await page.locator('[data-collection-record="mail-64"]').click(); await opened(page, 'mail-64');
    await page.evaluate(() => window.__mailCompose.holdState());
    const article = page.getByRole('article', { name: 'Email message', exact: true });
    await article.getByRole('button', { name: 'More', exact: true }).click();
    await article.getByRole('button', { name: 'Mark as read', exact: true }).click();
    await expect(next(page)).toHaveAttribute('aria-disabled', 'true');
    await next(page).dispatchEvent('click'); await opened(page, 'mail-64');
    await page.evaluate(() => window.__mailCompose.releaseState());
    await expect(article.getByLabel('Email status', { exact: true })).toHaveText('Read');
    await expect(readingInbox(page).getByRole('status')).toHaveText('The open message is outside this inbox view.');
    await expect(readingInbox(page).locator('[data-collection-record="mail-64"]')).toHaveCount(0);
    await next(page).click(); await opened(page, 'mail-56');
    await previous(page).click(); await opened(page, 'mail-64');
    await next(page).click(); await opened(page, 'mail-56');
    await page.getByRole('button', { name: '← Back', exact: true }).click();
    await expect(inboxRows(page)).toHaveCount(8); await expect(page.locator('[data-collection-record="mail-56"]')).toBeFocused();
    expect(await page.evaluate(() => window.__mailCompose.stateChanges.map(change => change.change))).toEqual([{ kind: 'read', value: true }]);
  });

  test('keeps an unfinished reply and its source email until the owner closes the draft', async ({ page }) => {
    await boot(page, { inbox: true });
    await page.locator('[data-collection-record="mail-64"]').click(); await opened(page, 'mail-64');
    await page.getByRole('article', { name: 'Email message', exact: true }).getByRole('button', { name: 'Reply', exact: true }).click();
    await field(page, 'body').fill('Keep this unfinished reply.');
    // The modal owns pointer/keyboard input; the route also guards a dispatched navigation action.
    await next(page).dispatchEvent('click');
    await readingInbox(page).locator('[data-collection-record="mail-63"]').dispatchEvent('click');
    await expect(field(page, 'body')).toHaveValue('Keep this unfinished reply.'); await opened(page, 'mail-64');
    await dialog(page).getByRole('button', { name: 'Close', exact: true }).click();
    await dialog(page).getByRole('button', { name: 'Discard draft', exact: true }).click();
    await next(page).click(); await opened(page, 'mail-63');
    expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
  });

  test('retires an in-flight next page when returning to the list and choosing another mailbox', async ({ page }) => {
    await boot(page, { inbox: true });
    await page.locator('[data-collection-record="mail-36"]').click(); await opened(page, 'mail-36');
    await page.evaluate(() => window.__mailInbox.holdNext()); await next(page).click();
    await expect.poll(() => page.evaluate(() => window.__mailInbox.pending())).toBe(true);
    await page.getByRole('button', { name: '← Back', exact: true }).click();
    await page.locator('[data-collection-slug="other"]').click(); await expect(inboxRows(page)).toHaveCount(30);
    await page.evaluate(() => window.__mailInbox.release());
    await expect(navigation(page)).toHaveCount(0); await expect(inboxRows(page)).toHaveCount(30);
    await expect(page.locator('[data-collection-slug="other"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('article', { name: 'Email message', exact: true })).toHaveCount(0);
  });

  test('respects the sphere filter over loaded rows and leaves direct email links outside an inbox visit', async ({ page }) => {
    await boot(page, { inbox: true });
    await page.evaluate(() => {
      const original = window.__connectionsFixture;
      window.__connectionsFixture = async (method, raw) => {
        if (method === 'yours.spheres') {
          const refs = (raw as { refs: { collection: string; id: string }[] }).refs;
          return { result: { placements: refs.map(ref => ({ ref, sphere: Number(ref.id.split('mail-')[1]) % 2 ? 'professional' : 'personal', origin: 'manual' })) } };
        }
        return original?.(method, raw);
      };
    });
    await page.getByLabel('Data sphere', { exact: true }).selectOption('professional');
    await expect(inboxRows(page)).toHaveCount(15);
    await page.locator('[data-collection-record="mail-37"]').click(); await opened(page, 'mail-37');
    await expect(next(page)).toBeDisabled();
    await previous(page).click(); await opened(page, 'mail-39');
    expect(await page.evaluate(() => window.__mailInbox.requests.length)).toBe(1);
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await opened(page, 'mail-39'); await expect(navigation(page)).toHaveCount(0);
  });
});

declare global { interface Window { __mailInbox: {
  requests: CollectionListQuery[]; failNext(): void; holdNext(): void; pending(): boolean; release(): void; ignorePaging(): void;
} } }

declare global { interface Window { __mailCompose: {
  executions: Array<{ recipe_id: string; config: Record<string, unknown> }>;
  setSending(value: boolean): void; holdAI(): void; releaseAI(): void; failAI(): void; saved(): MailDraft | null;
  setGroup(value: boolean): void; setCopyRecipient(value: string): void; setReplyMailbox(value: string): void;
  setSenderMailbox(value: string): void;
  setSendOutcome(value: 'held' | 'sent' | 'lost' | 'incomplete'): void; reviseSaved(): void;
  setForwarding(value: boolean): void; setPartialBody(value: boolean): void;
  setOriginalBody(value: string): void; setOriginalAttachments(value: boolean): void;
  holdSend(): void; releaseSend(): void;
  holdMailbox(): void; mailboxPending(): boolean; mailboxReplies(): number; releaseMailbox(): void;
  reads: Array<{ record_id: string; conversation?: unknown }>;
  stateChanges: MailMessageStateChange[];
  setMessageAccess(id: string, value: { mark: boolean; star: boolean }): void;
  setMessageIdentity(id: string, value: string): void;
  setRemoteFlags(id: string, value: { is_read: boolean; is_flagged: boolean }): void;
  failStateRead(value: boolean): void; loseStateResponse(): void; holdState(): void; releaseState(): void;
  holdMessage(id: string): void; releaseMessage(id: string): void; failOlder(): void;
  recoverHistory(): void; holdConversation(): void; releaseConversation(): void;
} } }

declare global { interface Window { __mailAttachments: {
  reads: string[]; previewReads: string[]; holdNext(): void; pending(): boolean; release(): void;
  fail(value: boolean): void; rename(): void; replaceMailbox(): void;
} } }

test.describe('Keep and find unfinished mail', () => {
  const leave = (page: Page) => page.getByRole('alertdialog', { name: 'Keep this email for later?', exact: true });
  const later = (page: Page) => page.getByRole('button', { name: 'Keep draft for later', exact: true });
  const found = (page: Page) => page.getByRole('region', { name: 'Unfinished work search results', exact: true });
  const search = async (page: Page, query: string, type: 'all' | 'draft' = 'all') => {
    await page.evaluate(() => window.__app.setHash('#data/search'));
    const input = page.getByRole('searchbox', { name: 'Search everything', exact: true });
    await input.fill(query);
    if (type !== 'all') await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption(type);
    await expect(found(page)).toHaveAttribute('aria-busy', 'false');
    return input;
  };
  const result = (page: Page) => found(page).locator('[data-recovery-draft-key]');
  const releaseMailbox = async (page: Page) => {
    const replies = await page.evaluate(() => window.__mailCompose.mailboxReplies());
    await page.evaluate(() => window.__mailCompose.releaseMailbox());
    await expect.poll(() => page.evaluate(() => window.__mailCompose.mailboxReplies())).toBe(replies + 1);
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  };
  const newMail = async (page: Page, subject: string) => {
    await page.evaluate(() => window.__app.setHash('#mail')); await page.getByRole('button', { name: 'New mail', exact: true }).click();
    await field(page, 'subject').fill(subject); await page.locator('[data-form-array-add="to"]').click();
    await page.locator('[data-form-array-item="to"]').fill('alex@example.test');
    await field(page, 'body').fill('Kestrel unfinished body.');
  };
  const keep = async (page: Page) => {
    await page.getByRole('button', { name: 'Close', exact: true }).click(); await later(page).click(); await expect(dialog(page)).toHaveCount(0);
  };
  const rewriteCopy = (page: Page, body: string) => page.evaluate(body => {
    const key = Object.keys(sessionStorage).find(key => key.startsWith('recued.mail.compose-recovery.v1:'))!;
    const entries = JSON.parse(sessionStorage.getItem(key)!) as MailRecoveryEntry[];
    entries[0]!.dialog.values.body = body; sessionStorage.setItem(key, JSON.stringify(entries));
  }, body);

  test('keeps a reply with unfinished recipients, files, AI instructions and RFC context, traverses every leave choice and resumes from search', async ({ page }) => {
    await boot(page, { group: true, durableProfile: true }); await page.getByRole('button', { name: 'Reply all', exact: true }).click();
    await page.locator('[data-form-array-item="to"]').first().fill('  unfinished@');
    await page.locator('[data-form-array-add="to"]').click();
    const copies = page.locator('[data-mail-compose-copy-recipients]');
    if (!(await copies.evaluate(node => (node as HTMLDetailsElement).open))) await copies.locator('summary').click();
    await page.locator('[data-form-array-add="bcc"]').click(); await page.locator('[data-form-array-item="bcc"]').fill('private@');
    await field(page, 'subject').fill('Kestrel reply'); await field(page, 'body').fill('Café 👋\nLatest reply notes.\n');
    await brief(page).fill('Kestrel AI instructions'); await page.getByRole('button', { name: 'Attach a file', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Attach files', exact: true });
    await picker.getByRole('checkbox', { name: 'Scope notes.txt' }).check(); await picker.getByRole('button', { name: 'Attach', exact: true }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    const editing = leave(page).getByRole('button', { name: 'Keep editing', exact: true }), discard = leave(page).getByRole('button', { name: 'Discard draft', exact: true });
    await expect(editing).toBeFocused(); await page.keyboard.press('Tab'); await expect(later(page)).toBeFocused();
    await page.keyboard.press('Tab'); await expect(discard).toBeFocused(); await page.keyboard.press('Tab'); await expect(editing).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(discard).toBeFocused(); await page.keyboard.press('Escape'); await expect(brief(page)).toBeFocused();
    await keep(page); const entry = (await recoveryEntries(page))[0]!;
    expect(entry.dialog.values).toMatchObject({ to: ['  unfinished@', 'colleague@example.test', ''], cc: ['copy@example.test'], bcc: ['private@'],
      in_reply_to: '<request@example.test>', references: ['<root@example.test>', '<request@example.test>'], attachments: ['file:' + '1'.repeat(32)] });
    const input = await search(page, 'Kestrel AI instructions'); await result(page).press('Enter');
    await expect(page.getByRole('dialog', { name: 'Reply all', exact: true })).toBeVisible(); await expect(field(page, 'body')).toHaveValue(entry.dialog.values.body);
    await expect(brief(page)).toHaveValue(entry.brief); await expect(dialog(page)).toContainText('Scope notes.txt');
    await expect(page.locator('[data-form-array-item="to"]').first()).toHaveValue('  unfinished@');
    await expect(page.locator('[data-form-array-item="bcc"]')).toHaveValue('private@'); expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
    await page.locator('[data-form-array-item="to"]').first().fill('desk@example.test'); await page.locator('[data-form-array-item="bcc"]').fill('private@example.test');
    await page.getByRole('button', { name: 'Draft with AI', exact: true }).click(); await expect(field(page, 'body')).toHaveValue('I will review the revised scope before confirming a delivery date.');
    expect(await page.evaluate(() => window.__mailCompose.executions[0]?.config.original_body)).toContain('Can you confirm the delivery date?');
    await keep(page); await expect(input).toHaveValue('Kestrel AI instructions'); await expect(result(page)).toBeFocused();
  });

  test('keeps a new message on a phone, finds local and saved drafts together and preserves the saved revision while editing', async ({ page }, info) => {
    await boot(page, { durableProfile: true }); await newMail(page, 'Kestrel saved edits');
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(leave(page)).toBeVisible(); await page.screenshot({ path: info.outputPath('keep-mail-phone.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await later(page).click();
    await expect(dialog(page)).toHaveCount(0); await page.setViewportSize({ width: 1280, height: 900 });
    const input = await search(page, 'Kestrel'); await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('draft');
    await result(page).click(); await expect(field(page, 'subject')).toHaveValue('Kestrel saved edits');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click(); await expect(page.locator('[data-mail-draft-status]')).toContainText('Draft saved.');
    await field(page, 'body').fill('Kestrel newer local edits.'); await keep(page);
    await expect(result(page)).toBeFocused(); const local = (await recoveryEntries(page))[0]!; expect(local.saved?.revision).toBe(1);
    await expect(page.getByRole('region', { name: 'Saved draft search results', exact: true })).toContainText('Kestrel saved edits');
    await result(page).click(); await expect(field(page, 'body')).toHaveValue('Kestrel newer local edits.');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click(); await expect(page.locator('[data-mail-draft-status]')).toContainText('Draft saved.');
    expect(await page.evaluate(() => window.__mailCompose.saved()?.revision)).toBe(2);
    await page.getByRole('button', { name: 'Close', exact: true }).click(); await expect(input).toHaveValue('Kestrel'); expect(await recoveryEntries(page)).toEqual([]);
    expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
  });

  test('keeps a forward with its quoted original and attachment warning without sending or copying original recipients', async ({ page }) => {
    await boot(page, { durableProfile: true, attachments: true }); await page.getByRole('button', { name: 'Forward', exact: true }).click();
    await field(page, 'subject').fill('Kestrel forwarded context'); const body = await field(page, 'body').inputValue(); await keep(page);
    await search(page, 'Kestrel'); await result(page).click(); await expect(page.getByRole('dialog', { name: 'Forward', exact: true })).toBeVisible();
    await expect(field(page, 'body')).toHaveValue(body); await expect(dialog(page)).toContainText('Original attachments are not added automatically');
    await expect(page.locator('[data-form-array-item="to"]')).toHaveCount(0);
    const entry = (await recoveryEntries(page))[0]!; expect(entry.dialog.values.in_reply_to).toBeNull(); expect(entry.dialog.values.attachments).toEqual([]);
    expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
  });

  test('stays open after failed persistence or read-back and exposes unreadable mail recovery in search', async ({ page }) => {
    await page.addInitScript(() => {
      const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
      Storage.prototype.getItem = function(key) { if (key.startsWith('recued.mail.compose-recovery.v1:') && document.documentElement.dataset.mailReadBlocked === '1') throw new DOMException('Unavailable', 'SecurityError'); return get.call(this, key); };
      Storage.prototype.setItem = function(key, value) { if (key.startsWith('recued.mail.compose-recovery.v1:') && document.documentElement.dataset.mailWriteBlocked === '1') throw new DOMException('Full', 'QuotaExceededError'); set.call(this, key, value); };
    });
    await boot(page, { durableProfile: true }); await newMail(page, 'Kestrel blocked storage');
    await page.evaluate(() => { document.documentElement.dataset.mailWriteBlocked = '1'; }); await field(page, 'body').fill('Kestrel latest blocked details.');
    await page.getByRole('button', { name: 'Close', exact: true }).click(); await later(page).click(); await expect(leave(page).getByRole('alert')).toContainText('could not be confirmed');
    await page.evaluate(() => { document.documentElement.dataset.mailWriteBlocked = '0'; }); await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(field(page, 'body')).toHaveValue('Kestrel latest blocked details.'); await expect(page.locator('[data-mail-compose-recovery-status]')).toHaveText('Changes kept in this tab.');
    await page.evaluate(() => { document.documentElement.dataset.mailReadBlocked = '1'; }); await page.getByRole('button', { name: 'Close', exact: true }).click(); await later(page).click();
    await expect(leave(page).getByRole('alert')).toContainText('could not be confirmed');
    await page.evaluate(() => { document.documentElement.dataset.mailReadBlocked = '0'; }); await later(page).click(); await expect(dialog(page)).toHaveCount(0);
    await page.evaluate(() => { document.documentElement.dataset.mailReadBlocked = '1'; }); await search(page, 'Kestrel', 'draft');
    await expect(found(page).getByRole('alert')).toContainText('Email recovery copies could not be read');
    await page.evaluate(() => { document.documentElement.dataset.mailReadBlocked = '0'; }); await found(page).getByRole('button', { name: 'Refresh drafts', exact: true }).click();
    await result(page).click(); await expect(field(page, 'body')).toHaveValue('Kestrel latest blocked details.'); expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
  });

  for (const outcome of ['held', 'lost'] as const) test(`reviews a ${outcome} send from search without permitting another submission`, async ({ page }) => {
    await boot(page, { durableProfile: true }); await newMail(page, 'Kestrel send status');
    await page.evaluate(outcome => window.__mailCompose.setSendOutcome(outcome), outcome); await page.getByRole('button', { name: 'Send', exact: true }).click();
    if (outcome === 'lost') { await expect(field(page, 'body')).toBeDisabled(); await page.getByRole('button', { name: 'Close', exact: true }).click(); }
    await expect(dialog(page)).toHaveCount(0); const before = await recoveryEntries(page);
    await search(page, 'Kestrel'); await expect(found(page)).toContainText(outcome === 'held' ? 'Waiting for your approval' : 'Send outcome not confirmed');
    await result(page).click(); await expect(field(page, 'body')).toBeDisabled(); await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await page.locator('[data-action="submit-mail-compose"]').evaluate(element => (element as HTMLElement).click());
    expect(await page.evaluate(() => window.__mailCompose.executions)).toHaveLength(1);
    await page.getByRole('button', { name: 'Close', exact: true }).click(); await expect(result(page)).toBeFocused(); expect(await recoveryEntries(page)).toEqual(before);
  });

  test('rejects changed recovery content and mailbox identity during a pending search open', async ({ page }) => {
    await boot(page, { durableProfile: true }); await newMail(page, 'Kestrel changing copy'); await keep(page); await search(page, 'Kestrel');
    await page.evaluate(() => window.__mailCompose.holdMailbox()); await result(page).click(); await expect.poll(() => page.evaluate(() => window.__mailCompose.mailboxPending())).toBe(true);
    await rewriteCopy(page, 'Kestrel newer same-timestamp text'); await releaseMailbox(page);
    await expect(found(page).getByRole('alert')).toContainText('recovery changed'); await expect(dialog(page)).toHaveCount(0);
    await found(page).getByRole('button', { name: 'Refresh drafts', exact: true }).click();
    await page.evaluate(() => window.__mailCompose.setSenderMailbox('replacement@example.test')); await result(page).click();
    await expect(found(page).getByRole('alert')).toContainText('Reconnect the original mailbox'); await expect(dialog(page)).toHaveCount(0);
    await page.evaluate(() => window.__mailCompose.setSenderMailbox('owner@example.test')); await found(page).getByRole('button', { name: 'Refresh drafts', exact: true }).click(); await result(page).click();
    await expect(field(page, 'body')).toHaveValue('Kestrel newer same-timestamp text'); expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
  });

  test('cancels an old open at a query or result-type change and protects a newer open from its late mailbox reply', async ({ page }) => {
    await boot(page, { durableProfile: true }); await newMail(page, 'Kestrel cancelled open'); await keep(page); const input = await search(page, 'Kestrel');
    await page.evaluate(() => window.__mailCompose.holdMailbox()); await result(page).click(); await expect.poll(() => page.evaluate(() => window.__mailCompose.mailboxPending())).toBe(true);
    await input.fill('No such unfinished mail'); await input.fill('Kestrel'); await expect(result(page)).toBeVisible();
    await result(page).click(); await expect(field(page, 'subject')).toHaveValue('Kestrel cancelled open'); await field(page, 'body').fill('Kestrel typed in the newer open');
    await releaseMailbox(page); await expect(field(page, 'body')).toHaveValue('Kestrel typed in the newer open'); await keep(page);
    await page.evaluate(() => window.__mailCompose.holdMailbox()); await result(page).click(); await expect.poll(() => page.evaluate(() => window.__mailCompose.mailboxPending())).toBe(true);
    await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('mail'); await releaseMailbox(page);
    await expect(dialog(page)).toHaveCount(0); await page.getByRole('combobox', { name: 'Result type', exact: true }).selectOption('draft');
    await result(page).click(); await expect(field(page, 'body')).toHaveValue('Kestrel typed in the newer open'); expect(await page.evaluate(() => window.__mailCompose.executions)).toEqual([]);
  });
});
