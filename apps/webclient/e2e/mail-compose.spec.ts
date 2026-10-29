import { expect, test, type Page } from '@playwright/test';
import type { MailDraft, MailMessageSnapshot } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

installFullAppHooks();
const field = (page: Page, name: string) => page.locator(`[data-form-field="${name}"]`);
const brief = (page: Page) => page.locator('[data-mail-compose-ai-brief]');
const dialog = (page: Page) => page.getByRole('dialog', { name: /Reply|New mail/ });

const boot = async (page: Page, opts: { sending?: boolean; thread?: boolean; historyFails?: boolean; messageCount?: number } = {}): Promise<void> => {
  const { sending = true, thread = false, historyFails = false, messageCount = 3 } = opts;
  await page.addInitScript(({ sending, thread, historyFails, messageCount }) => {
    let canSend = sending, held = false, fail = false, sendHeld = false;
    let release: (() => void) | undefined;
    let releaseSend: (() => void) | undefined;
    let saved: MailDraft | null = null;
    const executions: Array<{ recipe_id: string; config: Record<string, unknown> }> = [];
    const anchorSnapshot = (): MailMessageSnapshot => ({ slug: 'work', record_id: 'mail-1',
      from: 'lead@example.test', to: ['owner@example.test'], cc: ['copy@example.test'], subject: 'Delivery date',
      received_at: 1_700_000_000_000,
      body: 'Please review the revised scope. Can you confirm the delivery date?', body_truncated: false, read: 'provider',
      reply: canSend ? { original_source_id: 'work', original_message: {
        id: '<request@example.test>', from: 'lead@example.test', subject: 'Delivery date',
        reply_to: ['desk@example.test'], references: ['<root@example.test>'],
        body: 'Please review the revised scope. Can you confirm the delivery date?',
      } } : null,
      ...(!canSend ? { reply_unavailable_reason: 'Sending is unavailable for this mailbox. Enable sending in Connections to reply.' } : {}),
    });
    const snapshot = (id = 'mail-1'): MailMessageSnapshot => {
      const base = anchorSnapshot();
      if (id === 'mail-1') return base;
      const sent = id === 'mail-2';
      const body = sent ? 'I have reviewed the scope and sent a proposed date.' : id === 'mail-0' ? 'Original conversation context.' : Number(id.slice(5)) >= 4 ? `Update from message ${id.slice(5)}.` : 'The revised date is Friday. Please confirm.';
      return { ...base, record_id: id, body, received_at: base.received_at + (id === 'mail-0' ? -1 : Number(id.slice(5))),
        from: sent ? 'owner@example.test' : id === 'mail-0' ? 'Customer operations and project delivery <delivery-coordination@example.test>' : 'lead@example.test',
        subject: id === 'mail-0' ? 'Delivery date and review of the revised scope, dependencies, and final confirmation for Friday' : base.subject, to: sent ? ['lead@example.test'] : ['owner@example.test'],
        reply: sent || !canSend ? null : { original_source_id: 'work', original_message: {
          id: `<${id}@example.test>`, from: 'lead@example.test', subject: 'Delivery date', body,
          reply_to: ['lead@example.test'], references: ['<request@example.test>'],
        } }, ...(sent ? { reply_unavailable_reason: 'Reply is available on received email.' } : {}),
      };
    };
    const record = { record_id: 'mail-1', source_id: 'provider-mail-1', received_at: 1_700_000_000_000,
      modified_at: 1_700_000_000_000, size_bytes: 80, body_inline: snapshot().body,
      hot_fields: { subject: 'Delivery date', from: 'lead@example.test', to: ['owner@example.test'], cc: [],
        direction: 'inbound', folder: 'INBOX', is_read: true, message_id: 'provider-mail-1', rfc_message_id: 'request@example.test' } };
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
    const conversationItem = (row: typeof record) => ({ ...row, ...row.hot_fields, snippet: row.body_inline?.slice(0, 160) ?? '', has_attachments: false });
    Object.assign(window, { __mailCompose: { executions, reads,
      holdMessage(id: string) { heldReads.add(id); },
      releaseMessage(id: string) { const done = releases.get(id); if (!done) throw new Error('No email read is waiting.'); releases.delete(id); done(); },
      failOlder() { failOlder = true; },
      recoverHistory() { historyFailure = false; },
      holdConversation() { holdConversation = true; },
      releaseConversation() { if (!releaseConversation) throw new Error('No conversation read is waiting.'); const done = releaseConversation; releaseConversation = undefined; done(); },
      setSending(value: boolean) { canSend = value; },
      holdAI() { held = true; },
      holdSend() { sendHeld = true; },
      releaseSend() { if (!releaseSend) throw new Error('No send is waiting.'); const done = releaseSend; releaseSend = undefined; done(); },
      releaseAI() { if (!release) throw new Error('No AI call is waiting.'); const done = release; release = undefined; done(); },
      failAI() { fail = true; }, saved: () => structuredClone(saved),
    }, __connectionsFixture: async (method: string, raw: unknown) => {
      const args = raw as Record<string, unknown> | undefined;
      if (method === 'collection.listInstances') return { result: { instances: [{ platform: 'mail', slug: 'work',
        adapter_type: 'gmail', auth_state: 'healthy', caps: {}, last_synced_at: 1_700_000_000_000 }] } };
      if (method === 'collection.list' && args?.platform === 'mail') return { result: { records: structuredClone(records.filter(row => row.record_id !== 'mail-0')) } };
      if (method === 'collection.get' && args?.platform === 'mail') return { result: { record: structuredClone(records.find(row => row.record_id === args.record_id) ?? null) } };
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
        { slug: 'work', adapter_type: 'gmail', account_email: 'owner@example.test', send_capable: canSend,
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
  }, { sending, thread, historyFails, messageCount });
  await page.goto(`${HARNESS_URL}?connection=source-answer&recipes=installed`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#data/mail'));
  await page.locator('[data-collection-record="mail-1"]').click();
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Can you confirm the delivery date?');
};

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
  await card('mail-3').click();
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('revised date is Friday');
  await page.evaluate(() => window.__mailCompose.releaseMessage('mail-2'));
  await expect(page.getByRole('article', { name: 'Email message' })).not.toContainText('sent a proposed date');
  await expect(card('mail-3')).toBeFocused();
  await card('mail-3').click();
  await expect(page.getByRole('article', { name: 'Email message' })).toHaveCount(0);
  await card('mail-3').click();
  await page.evaluate(() => window.__mailCompose.failOlder());
  await page.getByRole('button', { name: 'Load older messages', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Earlier mail is temporarily unavailable');
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('revised date is Friday');
  await page.getByRole('button', { name: 'Load older messages', exact: true }).click();
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
  await page.getByRole('button', { name: 'Retry conversation', exact: true }).click();
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
  await current.click();
  await expect(page.getByRole('article', { name: 'Email message' })).toContainText('Update from message 30.');
  await expect(current).toBeFocused();
  await expect(current).toBeInViewport();
  await page.evaluate(() => window.__mailCompose.holdMessage('mail-30'));
  const refresh = page.getByRole('button', { name: 'Refresh email', exact: true });
  await refresh.click();
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

declare global { interface Window { __mailCompose: {
  executions: Array<{ recipe_id: string; config: Record<string, unknown> }>;
  setSending(value: boolean): void; holdAI(): void; releaseAI(): void; failAI(): void; saved(): MailDraft | null;
  holdSend(): void; releaseSend(): void;
  reads: Array<{ record_id: string; conversation?: unknown }>;
  holdMessage(id: string): void; releaseMessage(id: string): void; failOlder(): void;
  recoverHistory(): void; holdConversation(): void; releaseConversation(): void;
} } }
