import { describe, expect, it, vi } from 'vitest';
import type { CollectionRecord } from '@recued/contracts';
import type { CanonicalMessage } from '../provider.js';
import { getMailMessage, type MailMessageReadDeps } from '../message-read.js';
import { makeCollectionHandlers } from '../../collection-handler.js';
import { createCollectionRegistry } from '../../registry.js';
import type { WsClient } from '../../../ws-server.js';

const fixture = () => {
  const record: CollectionRecord = { record_id: 'mail:1', source_id: 'uid-1@INBOX', received_at: 1,
    modified_at: 1, size_bytes: 20, body_inline: 'Stored email', hot_fields: {
      from: 'sender@example.test', to: ['owner@example.test'], cc: [], subject: 'A request',
      direction: 'inbound', rfc_message_id: 'request@example.test', thread_id: 'opaque-provider-thread',
    } };
  const message: CanonicalMessage = { source_id: record.source_id, rfc_message_id: '<request@example.test>',
    from: 'sender@example.test', to: ['owner@example.test'], cc: ['copy@example.test'], subject: 'A request',
    thread_id: 'opaque-provider-thread', folder_or_label: 'INBOX', direction: 'inbound', is_read: false,
    is_flagged: false, has_attachments: false, received_at: 1, body_text: 'Please confirm the date.',
    headers: { 'reply-to': '"Reply desk" <reply@example.test>', references: '<root@example.test> <parent@example.test>' } };
  const fetch = vi.fn(async (): Promise<CanonicalMessage | null> => message);
  let present = true, sending = true;
  const collection = { get: (id: string) => present && id === record.record_id ? record : null,
    accountEmail: 'owner@example.test', provider: { fetchMessage: fetch } };
  const deps: MailMessageReadDeps = { getCollection: slug => slug === 'work' ? collection : undefined,
    listMailInstances: async () => ({ instances: [
      { slug: 'other', send_capable: true, auth_state: 'healthy' },
      { slug: 'work', send_capable: sending, auth_state: 'healthy' },
    ] }) };
  return { deps, record, message, fetch, setSending(value: boolean) { sending = value; }, remove() { present = false; } };
};
const ref = { slug: 'work', record_id: 'mail:1' };

describe('owner message read and reply context', () => {
  it('requires a paired owner at the wire handler before reading any mail', async () => {
    const slice = makeCollectionHandlers({ registry: createCollectionRegistry() })!;
    const client: WsClient = { ws: null, realm: 'test', instance_id: null, display_name: 'test', connected_at: 1 };
    await expect(slice.handlers['collection.mail.message.get'](ref, client)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(slice.handlers['collection.mail.conversation.get'](ref, client)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(slice.handlers['collection.mail.message.get'](ref, { ...client, instance_id: 'owner' }))
      .rejects.toMatchObject({ code: 'not_found' });
  });
  it('binds Reply-To, RFC headers and the full source body to the receiving mailbox', async () => {
    const f = fixture();
    const read = await getMailMessage(f.deps, ref);
    expect(read).toMatchObject({ ...ref, read: 'provider', body: f.message.body_text, body_truncated: false,
      reply: { original_source_id: 'work', original_message: { id: '<request@example.test>',
        reply_to: ['reply@example.test'], references: ['<root@example.test>', '<parent@example.test>'], body: f.message.body_text } } });
    expect(f.fetch).toHaveBeenCalledWith(f.record.source_id);
    expect(JSON.stringify(read.reply)).not.toContain('opaque-provider-thread');
    expect(JSON.stringify(read.reply)).not.toContain('uid-1@INBOX');
  });

  it('does not borrow another mailbox’s sending capability or fetch reply details for non-received mail', async () => {
    const f = fixture(); f.setSending(false);
    expect(await getMailMessage(f.deps, ref)).toMatchObject({ body: 'Stored email', reply: null,
      reply_unavailable_reason: expect.stringContaining('Sending is unavailable') });
    expect(f.fetch).not.toHaveBeenCalled();
    f.setSending(true); f.record.hot_fields.direction = 'outbound';
    expect((await getMailMessage(f.deps, ref)).reply).toBeNull();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(['message-replaced', 'missing-id', 'provider-id', 'control-id', 'self-reply-to', 'read-failed'] as const)(
    'keeps the stored reader and refuses an unverifiable reply: %s', async mode => {
      const f = fixture();
      if (mode === 'message-replaced') f.message.rfc_message_id = '<other@example.test>';
      if (mode === 'missing-id') delete f.record.hot_fields.rfc_message_id;
      if (mode === 'provider-id') f.message.rfc_message_id = 'gmail-provider-id';
      if (mode === 'control-id') { f.record.hot_fields.rfc_message_id = 'request\u0000@example.test'; f.message.rfc_message_id = '<request\u0000@example.test>'; }
      if (mode === 'self-reply-to') f.message.headers = { 'reply-to': 'owner@example.test' };
      if (mode === 'read-failed') f.fetch.mockRejectedValueOnce(new Error('offline'));
      const read = await getMailMessage(f.deps, ref);
      expect(read).toMatchObject({ body: 'Stored email', read: 'stored', reply: null });
      expect(read.reply_unavailable_reason).toEqual(expect.any(String));
    });

  it.each(['disconnect', 'revoke-send', 'disconnect-during-capability-check'] as const)('fences a provider read that outlives %s', async mode => {
    const f = fixture();
    if (mode === 'disconnect-during-capability-check') {
      const list = f.deps.listMailInstances; let reads = 0;
      f.deps.listMailInstances = async () => { if (++reads === 2) f.remove(); return list(); };
    }
    let release!: (message: CanonicalMessage) => void;
    f.fetch.mockImplementationOnce(() => new Promise(done => { release = done; }));
    const pending = getMailMessage(f.deps, ref);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalled());
    if (mode === 'disconnect') f.remove();
    if (mode === 'revoke-send') f.setSending(false);
    release(f.message);
    expect((await pending).reply).toBeNull();
  });

  it('binds lazy body reads to the same conversation and mailbox incarnation across asynchronous reads', async () => {
    const f = fixture(); let incarnation = 'v1';
    f.deps.getIncarnation = () => incarnation;
    const selected = { ...ref, conversation: { thread_id: 'opaque-provider-thread', incarnation: 'v1' } };
    await expect(getMailMessage(f.deps, { ...selected, conversation: { ...selected.conversation, thread_id: 'another-thread' } }))
      .rejects.toMatchObject({ code: 'resource_changed' });
    expect(f.fetch).not.toHaveBeenCalled();
    let release!: (message: CanonicalMessage) => void;
    f.fetch.mockImplementationOnce(() => new Promise(done => { release = done; }));
    const pending = getMailMessage(f.deps, selected);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'resource_changed' });
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalled());
    incarnation = 'v2'; release(f.message);
    await rejected;
    incarnation = 'v1'; f.setSending(false);
    expect((await getMailMessage(f.deps, selected)).body).toBe('Stored email');
  });

  it('shows bounded source text with an explicit partial-context marker', async () => {
    const f = fixture(); f.message.body_text = 'x'.repeat(65_537);
    const read = await getMailMessage(f.deps, ref);
    expect(read.body).toHaveLength(65_536);
    expect(read.body_truncated).toBe(true);
    expect(read.reply?.original_message.body_truncated).toBe(true);
  });
});
