import { expect, test, type Page } from '@playwright/test';
import type { MailDraft, MailMessageSnapshot, MailMessageStateChange, MailMessageAttachmentsSnapshot } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
const field = (page: Page, name: string) => page.locator(`[data-form-field="${name}"]`);
const brief = (page: Page) => page.locator('[data-mail-compose-ai-brief]');
const dialog = (page: Page) => page.getByRole('dialog', { name: /Reply|Forward|New mail/ });

const boot = async (page: Page, opts: { sending?: boolean; thread?: boolean; historyFails?: boolean; messageCount?: number; group?: boolean; forwarding?: boolean; triage?: 'writable' | 'read_only'; attachments?: boolean } = {}): Promise<void> => {
  const { sending = true, thread = false, historyFails = false, messageCount = 3, group = false, forwarding = true, attachments = false } = opts;
  await page.addInitScript(({ sending, thread, historyFails, messageCount, group, forwarding, triage, attachments }) => {
    let canSend = sending, held = false, fail = false, sendHeld = false;
    let groupReply = group, copyRecipient = 'copy@example.test', replyMailbox = 'owner@example.test';
    let senderMailbox = 'owner@example.test';
    let forwardAvailable = forwarding, partialBody = false, originalAttachments = attachments;
    let originalBody = 'Please review the revised scope. Can you confirm the delivery date?';
    const recipients = () => groupReply ? ['owner@example.test', 'colleague@example.test', 'DESK@example.test'] : ['owner@example.test'];
    const copies = () => groupReply ? [copyRecipient, 'COLLEAGUE@example.test', 'OWNER@example.test'] : ['copy@example.test'];
    let release: (() => void) | undefined;
    let releaseSend: (() => void) | undefined;
    let saved: MailDraft | null = null;
    const executions: Array<{ recipe_id: string; config: Record<string, unknown> }> = [];
    const stateChanges: MailMessageStateChange[] = [];
    const remoteFlags = new Map<string, { is_read: boolean; is_flagged: boolean }>();
    const confirmedFlags = new Map<string, { is_read: boolean; is_flagged: boolean }>();
    let stateReadFails = false, loseStateResponse = false, holdState = false;
    let releaseState: (() => void) | undefined;
    const flags = (id: string) => remoteFlags.get(id) ?? { is_read: false, is_flagged: false };
    const messageState = (id: string) => {
      if (!stateReadFails) confirmedFlags.set(id, { ...flags(id) });
      return { identity: 'a'.repeat(64), ...(confirmedFlags.get(id) ?? { is_read: false, is_flagged: false }),
        verified: !stateReadFails, can_mark: triage === 'writable' && !stateReadFails,
        can_flag: triage === 'writable' && !stateReadFails,
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
      const selected: MailMessageSnapshot = id === 'mail-1' ? base : { ...base, record_id: id, body, received_at: base.received_at + (id === 'mail-0' ? -1 : Number(id.slice(5))),
        from: sent ? 'owner@example.test' : id === 'mail-0' ? 'Customer operations and project delivery <delivery-coordination@example.test>' : 'lead@example.test',
        subject: id === 'mail-0' ? 'Delivery date and review of the revised scope, dependencies, and final confirmation for Friday' : base.subject, to: sent ? ['lead@example.test'] : ['owner@example.test'],
        reply: sent || !canSend ? null : { original_source_id: 'work', original_message: {
          id: `<${id}@example.test>`, from: 'lead@example.test', subject: 'Delivery date', body,
          reply_to: ['lead@example.test'], references: ['<request@example.test>'],
        } }, ...(sent ? { reply_unavailable_reason: 'Reply is available on received email.' } : {}),
      };
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
    const records = [record, ...(thread ? [...Array.from({ length: messageCount - 1 }, (_, index) => `mail-${index + 2}`), 'mail-0'].map(id => {
      const message = snapshot(id);
      return { ...record, record_id: id, source_id: `provider-${id}`, received_at: message.received_at,
        body_inline: message.body, hot_fields: { ...record.hot_fields, from: message.from, to: message.to, subject: message.subject,
          direction: id === 'mail-2' ? 'outbound' : 'inbound', folder: id === 'mail-2' ? 'Sent' : 'INBOX',
          thread_id: 'delivery-thread', is_read: id !== 'mail-3' } };
    }) : [])];
    const reads: Array<{ record_id: string; conversation?: unknown }> = [];
    const heldReads = new Set<string>();
    const releases = new Map<string, () => void>();
    let failOlder = false, historyFailure = historyFails, holdConversation = false;
    let releaseConversation: (() => void) | undefined;
    const recordWithFlags = (row: typeof record) => triage ? { ...row,
      hot_fields: { ...row.hot_fields, ...(confirmedFlags.get(row.record_id) ?? { is_read: false, is_flagged: false }) } } : row;
    const conversationItem = (row: typeof record) => ({ ...row, ...recordWithFlags(row).hot_fields, snippet: row.body_inline?.slice(0, 160) ?? '', has_attachments: attachments && row.record_id === 'mail-1' });
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
      setForwarding(value: boolean) { forwardAvailable = value; },
      setPartialBody(value: boolean) { partialBody = value; },
      setOriginalBody(value: string) { originalBody = value; },
      setOriginalAttachments(value: boolean) { originalAttachments = value; },
      holdAI() { held = true; },
      holdSend() { sendHeld = true; },
      releaseSend() { if (!releaseSend) throw new Error('No send is waiting.'); const done = releaseSend; releaseSend = undefined; done(); },
      releaseAI() { if (!release) throw new Error('No AI call is waiting.'); const done = release; release = undefined; done(); },
      failAI() { fail = true; }, saved: () => structuredClone(saved),
    }, __connectionsFixture: async (method: string, raw: unknown) => {
      const args = raw as Record<string, unknown> | undefined;
      if (method === 'collection.listInstances') return { result: { instances: [{ platform: 'mail', slug: 'work',
        adapter_type: 'gmail', auth_state: 'healthy', caps: {}, last_synced_at: 1_700_000_000_000 }] } };
      if (method === 'collection.list' && args?.platform === 'mail') return { result: { records: structuredClone(records.filter(row => row.record_id !== 'mail-0').map(recordWithFlags)) } };
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
        if (triage !== 'writable') return { error: { code: 'forbidden', message: 'This mailbox is read-only.' } };
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
          messages: records.filter(row => args?.before ? row.record_id === 'mail-0' : row.record_id !== 'mail-0').map(conversationItem),
          ...(thread && !args?.before ? { next_before: { received_at: record.received_at, record_id: 'mail-1' } } : {}),
        } };
      }
      if (method === 'collection.mail.message.get') {
        const id = args?.record_id as string; reads.push(structuredClone(args) as { record_id: string });
        if (heldReads.delete(id)) await new Promise<void>(done => { releases.set(id, done); });
        return { result: snapshot(id) };
      }
      if (method === 'collection.mail.list') return { result: { instances: [
        { slug: 'work', adapter_type: 'gmail', account_email: senderMailbox, send_capable: canSend,
          draft_capable: true, receive_capable: true, sent_lookup_capable: true, auth_state: 'healthy', caps: {} },
        { slug: 'other', adapter_type: 'smtp', account_email: 'other@example.test', send_capable: true,
          draft_capable: false, receive_capable: false, sent_lookup_capable: false, auth_state: 'healthy', caps: {} },
      ] } };
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
      if (method === 'execute') {
        const request = structuredClone(args) as { recipe_id: string; config: Record<string, unknown> };
        executions.push(request);
        if (request.recipe_id === 'send-composed-mail') {
          if (sendHeld) { sendHeld = false; await new Promise<void>(done => { releaseSend = done; }); }
          return { result: { success: false, awaiting_approval: true } };
        }
        if (held) { held = false; await new Promise<void>(done => { release = done; }); }
        if (fail) { fail = false; return { error: { code: 'unavailable', message: 'The AI model is unavailable.' } }; }
        const body = request.recipe_id === 'draft-composed-mail' ? 'I will review the revised scope before confirming a delivery date.' : 'Polished draft body.';
        return { result: { success: true, output: { render: [{ type: 'text', data: body }] } } };
      }
      return undefined;
    } });
  }, { sending, thread, historyFails, messageCount, group, forwarding, triage: opts.triage, attachments });
  await page.goto(`${HARNESS_URL}?connection=source-answer&recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/mail'));
  await page.locator('[data-collection-record="mail-1"]').click();
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Can you confirm the delivery date?');
};

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
  await expect(page.getByRole('button', { name: 'Polish', exact: true })).toBeFocused();
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

declare global { interface Window { __mailCompose: {
  executions: Array<{ recipe_id: string; config: Record<string, unknown> }>;
  setSending(value: boolean): void; holdAI(): void; releaseAI(): void; failAI(): void; saved(): MailDraft | null;
  setGroup(value: boolean): void; setCopyRecipient(value: string): void; setReplyMailbox(value: string): void;
  setSenderMailbox(value: string): void;
  setForwarding(value: boolean): void; setPartialBody(value: boolean): void;
  setOriginalBody(value: string): void; setOriginalAttachments(value: boolean): void;
  holdSend(): void; releaseSend(): void;
  reads: Array<{ record_id: string; conversation?: unknown }>;
  stateChanges: MailMessageStateChange[];
  setRemoteFlags(id: string, value: { is_read: boolean; is_flagged: boolean }): void;
  failStateRead(value: boolean): void; loseStateResponse(): void; holdState(): void; releaseState(): void;
  holdMessage(id: string): void; releaseMessage(id: string): void; failOlder(): void;
  recoverHistory(): void; holdConversation(): void; releaseConversation(): void;
} } }

declare global { interface Window { __mailAttachments: {
  reads: string[]; previewReads: string[]; holdNext(): void; pending(): boolean; release(): void;
  fail(value: boolean): void; rename(): void; replaceMailbox(): void;
} } }
