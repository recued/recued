import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailAdapterError, type MailMessageStateChange } from '@recued/contracts';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createBlobStore } from '../../../storage/blob-store.js';
import { createMailCollection } from '../mail-collection.js';
import { createCollectionRegistry } from '../../registry.js';
import { createInstanceStore } from '../../instance-store.js';
import { makeCollectionHandlers } from '../../collection-handler.js';
import { getMailMessage } from '../message-read.js';
import { getMailConversation } from '../conversation-read.js';
import { readMailMessageState, updateMailMessageState } from '../message-state.js';
import type { CanonicalMessage, MailProvider } from '../provider.js';
import type { WsClient } from '../../../ws-server.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
const fixture = async (writable = true) => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-triage-')), db = new Database(':memory:');
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const message: CanonicalMessage = { source_id: '7@INBOX', rfc_message_id: '<question@example.test>',
    from: 'sender@example.test', to: ['owner@example.test'], cc: [], subject: 'Friday delivery',
    thread_id: 'thread-1', folder_or_label: 'INBOX', direction: 'inbound', is_read: false, is_flagged: false,
    has_attachments: false, received_at: 1_700_000_000_000, body_text: 'Please confirm the delivery date.' };
  let incarnation = 'enrollment-1';
  let writeClock = Date.now() - 10_000;
  const result = () => ({ source_id: message.source_id, is_read: message.is_read,
    is_flagged: message.is_flagged === true, folder_or_label: message.folder_or_label });
  const fetch = vi.fn(async () => structuredClone(message));
  const mark = vi.fn(async ({ read }: { source_id: string; read: boolean }) => { message.is_read = read; return result(); });
  const flag = vi.fn(async ({ flagged }: { source_id: string; flagged: boolean }) => { message.is_flagged = flagged; return result(); });
  const provider: MailProvider = { kind: 'imap', slug: 'work', accountEmail: 'owner@example.test',
    sendCapable: false, mutationCapable: writable,
    async connect() {}, async initialScan(options) { await options.onMessage(message); },
    async startSync() { return async () => {}; }, async close() {},
    health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
    fetchMessage: fetch, markMessage: mark, flagMessage: flag };
  const collection = createMailCollection({ db, blobs: createBlobStore(join(dir, 'cas')),
    gate: createStorageGate({ quota: 1_000_000, reservePct: 0, surface: 'triage-test' }),
    bus: createWarehouseEventBus(), slug: 'work', provider, now: () => ++writeClock,
    config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1_000_000 }) });
  await collection.sync.start(); await collection.sync.stop();
  const registry = createCollectionRegistry(); registry.register(collection);
  const record = collection.list({ platform: 'mail', slug: 'work' })[0]!;
  const ref = { slug: 'work', record_id: record.record_id,
    conversation: { thread_id: 'thread-1', incarnation: 'enrollment-1' } };
  const deps = { registry, getCollection: (slug: string) => slug === 'work' ? collection : undefined,
    getIncarnation: () => incarnation,
    deleteLocalRecord: async () => { throw new Error('A state change must not delete mail'); },
    listMailInstances: async () => ({ instances: [] }) };
  const state = (await readMailMessageState(deps, ref)).state;
  fetch.mockClear();
  const request = (kind: 'read' | 'star', value: boolean): MailMessageStateChange => ({
    ...ref, expected_identity: state.identity!, change: { kind, value } });
  return { db, deps, ref, record, collection, message, provider, fetch, mark, flag, request,
    replace() { incarnation = 'enrollment-2'; } };
};

describe('owner message state', () => {
  it('requires a paired webclient before resolving any message or provider', async () => {
    const slice = makeCollectionHandlers({ registry: createCollectionRegistry() })!;
    const client: WsClient = { ws: null, realm: 'test', instance_id: null, display_name: 'test', connected_at: 0 };
    for (const actor of [client, { ...client, instance_id: 'paired-app', client_kind: 'bridge' as const }]) {
      await expect(slice.handlers['collection.mail.message.updateState']({} as MailMessageStateChange, actor))
        .rejects.toMatchObject({ code: 'unauthorized' });
    }
  });

  it('checks writable mail independently of sending and never marks a viewed message read', async () => {
    const f = await fixture();
    const reflected = vi.spyOn(f.collection, 'applyVerifiedMutation');
    const read = await getMailMessage(f.deps, f.ref);
    expect(read).toMatchObject({ reply: null, state: { verified: true, can_mark: true, can_flag: true, is_read: false, is_flagged: false } });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.mark).not.toHaveBeenCalled(); expect(f.flag).not.toHaveBeenCalled();
    expect(f.collection.get(f.record.record_id)?.hot_fields.is_read).toBe(false);
    expect(reflected).not.toHaveBeenCalled();
    const reply = await getMailMessage({ ...f.deps, listMailInstances: async () => ({ instances: [
      { slug: 'work', send_capable: true, auth_state: 'healthy' },
    ] }) }, f.ref);
    expect(reply.reply).not.toBeNull();
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it('wires a paired owner action through the collection RPC to the real mutation dispatcher', async () => {
    const f = await fixture();
    const mailEnroll = { instances: { ...createInstanceStore({ db: f.db }), getIncarnation: f.deps.getIncarnation },
      accountStore: { get: async () => null, set: async () => {}, delete: async () => {} } };
    const slice = makeCollectionHandlers({ registry: f.deps.registry, mailEnroll })!;
    const client: WsClient = { ws: null, realm: 'test', instance_id: 'owner', client_kind: 'webclient', display_name: 'owner', connected_at: 0 };
    const result = await slice.handlers['collection.mail.message.updateState'](f.request('read', true), client);
    expect(result.record.hot_fields.is_read).toBe(true);
    expect(f.mark).toHaveBeenCalledExactlyOnceWith({ source_id: f.record.source_id, read: true });
  });

  it('does not offer a late verified status after an unscoped mailbox read changes enrollment', async () => {
    const f = await fixture();
    const { conversation, ...ref } = f.ref;
    await expect(getMailMessage({ ...f.deps, listMailInstances: async () => {
      f.replace(); return { instances: [] };
    } }, ref)).rejects.toMatchObject({ code: 'resource_changed' });
    expect(f.mark).not.toHaveBeenCalled();
  });

  it('reflects both actions, preserves the message bytes and identity, and returns flags to conversation readers', async () => {
    const f = await fixture();
    const read = await updateMailMessageState(f.deps, f.request('read', true));
    const star = await updateMailMessageState(f.deps, f.request('star', true));
    expect(read.state).toMatchObject({ verified: true, is_read: true, is_flagged: false });
    expect(star.state).toMatchObject({ verified: true, is_read: true, is_flagged: true });
    expect(star.record).toMatchObject({ record_id: f.record.record_id, source_id: f.record.source_id,
      body_inline: f.record.body_inline, size_bytes: f.record.size_bytes,
      hot_fields: { is_read: true, is_flagged: true } });
    expect(star.record.blob_hash).toBe(f.record.blob_hash);
    expect(getMailConversation(f.deps, f.ref).anchor).toMatchObject({ is_read: true, is_flagged: true });
    expect((await updateMailMessageState(f.deps, f.request('read', false))).state.is_read).toBe(false);
    expect((await updateMailMessageState(f.deps, f.request('star', false))).state.is_flagged).toBe(false);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('refuses read-only mail and explains access without using sending as a proxy', async () => {
    const f = await fixture(false);
    expect((await getMailMessage(f.deps, f.ref)).state).toMatchObject({ verified: false, can_mark: false,
      can_flag: false, unavailable_reason: expect.stringContaining('read-only') });
    await expect(updateMailMessageState(f.deps, f.request('read', true))).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.mark).not.toHaveBeenCalled();
  });

  it('rejects a stale enrollment and a malformed action before the provider is called', async () => {
    const f = await fixture();
    await expect(updateMailMessageState(f.deps, { ...f.request('read', true), expected_identity: '0'.repeat(64) }))
      .rejects.toMatchObject({ code: 'resource_changed' });
    await expect(updateMailMessageState(f.deps, { ...f.request('read', true), change: { kind: 'read', value: 'true' } } as unknown as MailMessageStateChange))
      .rejects.toMatchObject({ code: 'invalid_args' });
    f.replace();
    await expect(updateMailMessageState(f.deps, f.request('read', true))).rejects.toMatchObject({ code: 'resource_changed' });
    expect(f.mark).not.toHaveBeenCalled();
  });

  it('does not reflect a late response into a replaced mailbox', async () => {
    const f = await fixture();
    f.mark.mockImplementationOnce(async ({ read }) => {
      f.message.is_read = read; f.replace();
      return { source_id: f.message.source_id, is_read: read, is_flagged: false, folder_or_label: 'INBOX' };
    });
    await expect(updateMailMessageState(f.deps, f.request('read', true))).rejects.toMatchObject({ code: 'resource_changed' });
    expect(f.collection.get(f.record.record_id)?.hot_fields.is_read).toBe(false);
  });

  it('keeps the mirror unchanged on a lost response and a fresh provider read reveals the applied change', async () => {
    const f = await fixture();
    f.flag.mockImplementationOnce(async ({ flagged }) => {
      f.message.is_flagged = flagged; throw new MailAdapterError('io_error', 'Response was lost');
    });
    await expect(updateMailMessageState(f.deps, f.request('star', true))).rejects.toMatchObject({ code: 'upstream_error' });
    expect(f.collection.get(f.record.record_id)?.hot_fields.is_flagged).toBe(false);
    const checked = await getMailMessage(f.deps, f.ref);
    expect(checked.state).toMatchObject({ verified: true, is_flagged: true, can_flag: true });
    expect(f.collection.get(f.record.record_id)?.hot_fields.is_flagged).toBe(true);
    expect(f.flag).toHaveBeenCalledTimes(1);
  });

  it('disables changes when the provider read fails or verifies a different message', async () => {
    const f = await fixture();
    f.fetch.mockRejectedValueOnce(new Error('Offline'));
    expect((await getMailMessage(f.deps, f.ref)).state).toMatchObject({ verified: false, can_mark: false, can_flag: false });
    f.message.rfc_message_id = '<different@example.test>';
    expect((await getMailMessage(f.deps, f.ref)).state).toMatchObject({ verified: false, can_mark: false, can_flag: false });
    expect(f.mark).not.toHaveBeenCalled(); expect(f.flag).not.toHaveBeenCalled();
  });

  it('does not overwrite a newer confirmed action with a late provider read', async () => {
    const f = await fixture();
    let release!: () => void;
    const waiting = new Promise<void>(done => { release = done; });
    const older = { ...f.message, is_flagged: true };
    f.fetch.mockImplementationOnce(async () => { await waiting; return older; });
    const pending = readMailMessageState(f.deps, f.ref);
    await updateMailMessageState(f.deps, f.request('star', false));
    release();
    const checked = await pending;
    expect(f.collection.get(f.record.record_id)?.hot_fields.is_flagged).toBe(false);
    expect(checked.state).toMatchObject({ verified: false, can_flag: false, is_flagged: false });
  });

  it('uses one provider attempt when a writable mailbox cannot be checked for replying', async () => {
    const f = await fixture(); f.fetch.mockRejectedValueOnce(new Error('Offline'));
    const checked = await getMailMessage({ ...f.deps, listMailInstances: async () => ({ instances: [
      { slug: 'work', send_capable: true, auth_state: 'healthy' },
    ] }) }, f.ref);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(checked).toMatchObject({ reply: null, forward: null, state: { verified: false, can_mark: false, can_flag: false } });
  });

  it('keeps verified reply and forward available when flag metadata cannot be checked', async () => {
    const f = await fixture(); Reflect.deleteProperty(f.message, 'is_flagged');
    const checked = await getMailMessage({ ...f.deps, listMailInstances: async () => ({ instances: [
      { slug: 'work', send_capable: true, auth_state: 'healthy' },
    ] }) }, f.ref);
    expect(checked.reply).not.toBeNull(); expect(checked.forward).not.toBeNull();
    expect(checked.state).toMatchObject({ verified: false, can_mark: false, can_flag: false });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
});
