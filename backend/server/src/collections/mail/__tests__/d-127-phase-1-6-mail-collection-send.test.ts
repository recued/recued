/** D-127 Phase 1.6 — MailCollection.send + collection.mail.send rpc tests.
 *
 *  Pins the wire shape:
 *    - Capability gating (provider.sendCapable false → MAIL_SEND_NOT_CAPABLE).
 *    - Sender ≠ `to` self-loop guard at the collection layer (spec § A.8).
 *      cc / bcc self-references are allowed (archival pattern).
 *    - Address extraction is case-insensitive + handles both bare
 *      `alice@example.com` and `Alice <alice@example.com>` forms.
 *    - Empty `accountEmail` short-circuits the guard so providers
 *      that haven't loaded their profile don't reject every send.
 *    - send() returns canonical-record fields `_id` (null until next
 *      delta picks the Sent record up) + `_collection: 'data.mail'`.
 *    - rpc dispatch via `handleCollectionMailSend` validates input,
 *      resolves the collection by slug, propagates `IngredientError`
 *      back to the caller as expected.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { IngredientError } from '@recued/ingredients';
import { RpcError } from '@recued/contracts';
import { createStorageGate, type StorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus, type WarehouseEventBus } from '@recued/warehouse-events';

import { createBlobStore, type BlobStore } from '../../../storage/blob-store.js';
import {
  createMailCollection,
  type MailCollection,
  type MailCollectionConfig,
} from '../mail-collection.js';
import type {
  MailProvider,
  OutgoingMessage,
  ProviderHealth,
  SentMessageMeta,
} from '../provider.js';
import { handleCollectionMailSend } from '../../collection-handler.js';
import type { CollectionRegistry } from '../../registry.js';

// ────────────────────────────────────────────────────────────────
// Stub provider — controllable sendCapable + accountEmail + send
// ────────────────────────────────────────────────────────────────

interface StubSendHooks {
  sendCapable?: boolean;
  accountEmail?: string;
  /** Returned by `send`; defaults to a fixed valid meta. */
  sendResult?: SentMessageMeta;
  /** When set, `send` throws this error instead of returning. */
  sendThrows?: Error;
}

interface StubHandle {
  provider: MailProvider;
  sendCalls: OutgoingMessage[];
}

const makeStubProvider = (slug: string, hooks: StubSendHooks = {}): StubHandle => {
  const sendCalls: OutgoingMessage[] = [];
  const sendCapable = hooks.sendCapable ?? false;
  const sendImpl = async (msg: OutgoingMessage): Promise<SentMessageMeta> => {
    sendCalls.push(msg);
    if (hooks.sendThrows) throw hooks.sendThrows;
    return hooks.sendResult ?? {
      source_id: 'srcid-1',
      message_id: '<msgid-1@example.com>',
      sent_at: 1_700_000_000_000,
      thread_id: 'thread-1',
    };
  };
  const provider: MailProvider = {
    kind: 'imap',
    slug,
    sendCapable,
    accountEmail: hooks.accountEmail ?? '',
    async connect() { /* no-op */ },
    async initialScan() { /* no-op */ },
    async startSync() { return async () => {}; },
    async close() { /* no-op */ },
    health(): ProviderHealth {
      return { last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 };
    },
    ...(sendCapable ? { send: sendImpl } : {}),
  };
  return { provider, sendCalls };
};

// ────────────────────────────────────────────────────────────────
// Harness — real MailCollection over a tmp SQLite DB
// ────────────────────────────────────────────────────────────────

const BIG_QUOTA = 100 * 1024 * 1024;

interface Harness {
  dir: string;
  db: Database.Database;
  gate: StorageGate;
  blobs: BlobStore;
  bus: WarehouseEventBus;
  collection: MailCollection;
  stub: StubHandle;
  close(): void;
}

const newHarness = (hooks: StubSendHooks = {}): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-collection-send-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'test.db'));
  db.pragma('journal_mode = WAL');
  const gate = createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:mail:work' });
  const blobs = createBlobStore(join(dataDir, 'blobs'));
  const bus = createWarehouseEventBus();
  const stub = makeStubProvider('work', hooks);
  const config: MailCollectionConfig = {
    backfill_days: 30, retention_days: 365, quota_bytes: BIG_QUOTA,
  };
  const collection = createMailCollection({
    db, blobs, gate, bus, slug: 'work',
    provider: stub.provider,
    config: () => config,
  });
  return {
    dir, db, gate, blobs, bus, collection, stub,
    close() {
      void collection.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

let harnessRefs: Harness[] = [];
const withHarness = (hooks: StubSendHooks = {}): Harness => {
  const h = newHarness(hooks);
  harnessRefs.push(h);
  return h;
};
afterEach(() => {
  for (const h of harnessRefs) {
    try { h.close(); } catch { /* swallow */ }
  }
  harnessRefs = [];
});

const baseInput = {
  to: ['bob@example.com'],
  subject: 'hello',
  body_text: 'world',
};

// ────────────────────────────────────────────────────────────────
// 1. Capability gate
// ────────────────────────────────────────────────────────────────

describe('D-127 P1.6 — MailCollection.sendCapable + accountEmail mirroring', () => {
  it('mirrors sendCapable + accountEmail from the underlying provider', () => {
    const cap = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    expect(cap.collection.sendCapable).toBe(true);
    expect(cap.collection.accountEmail).toBe('alice@example.com');

    const notCap = withHarness({ sendCapable: false });
    expect(notCap.collection.sendCapable).toBe(false);
    expect(notCap.collection.accountEmail).toBe('');
  });

  it('rejects send() with MAIL_SEND_NOT_CAPABLE when underlying provider is not send-capable', async () => {
    const h = withHarness({ sendCapable: false });
    try {
      await h.collection.send(baseInput);
      expect.fail('expected MAIL_SEND_NOT_CAPABLE');
    } catch (err) {
      expect(err).toBeInstanceOf(IngredientError);
      expect((err as IngredientError).code).toBe('MAIL_SEND_NOT_CAPABLE');
      expect((err as IngredientError).details).toMatchObject({ kind: 'imap', slug: 'work' });
    }
    expect(h.stub.sendCalls).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. Sender ≠ to self-loop guard (spec § A.8)
// ────────────────────────────────────────────────────────────────

describe('D-127 P1.6 — sender ≠ to self-loop guard', () => {
  it('throws MAIL_SEND_SELF_LOOP_TO when to contains the sender address', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    try {
      await h.collection.send({ ...baseInput, to: ['alice@example.com'] });
      expect.fail('expected MAIL_SEND_SELF_LOOP_TO');
    } catch (err) {
      expect((err as IngredientError).code).toBe('MAIL_SEND_SELF_LOOP_TO');
      expect((err as IngredientError).details).toMatchObject({
        offending: 'alice@example.com',
        account_email: 'alice@example.com',
      });
    }
    expect(h.stub.sendCalls).toHaveLength(0);
  });

  it('matches case-insensitively (Alice <ALICE@example.com> vs alice@example.com)', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    try {
      await h.collection.send({ ...baseInput, to: ['Alice <ALICE@Example.COM>'] });
      expect.fail('expected MAIL_SEND_SELF_LOOP_TO');
    } catch (err) {
      expect((err as IngredientError).code).toBe('MAIL_SEND_SELF_LOOP_TO');
    }
  });

  it('extracts the bare address from "Display Name <addr>" form', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    try {
      await h.collection.send({ ...baseInput, to: ['Alice Smith <alice@example.com>'] });
      expect.fail('expected MAIL_SEND_SELF_LOOP_TO');
    } catch (err) {
      expect((err as IngredientError).code).toBe('MAIL_SEND_SELF_LOOP_TO');
    }
  });

  it('cc/bcc self-references are ALLOWED (archival pattern)', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    const result = await h.collection.send({
      ...baseInput,
      to: ['bob@example.com'],
      cc: ['alice@example.com'],
      bcc: ['alice@example.com'],
    });
    expect(result.message_id).toBe('<msgid-1@example.com>');
    expect(h.stub.sendCalls).toHaveLength(1);
    expect(h.stub.sendCalls[0]?.cc).toEqual(['alice@example.com']);
    expect(h.stub.sendCalls[0]?.bcc).toEqual(['alice@example.com']);
  });

  it('empty accountEmail short-circuits the guard (provider hasn\'t loaded profile)', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: '' });
    const result = await h.collection.send({ ...baseInput, to: ['anyone@example.com'] });
    expect(result.message_id).toBe('<msgid-1@example.com>');
  });
});

// ────────────────────────────────────────────────────────────────
// 3. Output canonical-record fields
// ────────────────────────────────────────────────────────────────

describe('D-127 P1.6 — send() output canonical-record fields', () => {
  it('returns _id: null + _collection: data.mail when Sent record not yet ingested', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    const result = await h.collection.send(baseInput);
    expect(result).toMatchObject({
      source_id: 'srcid-1',
      message_id: '<msgid-1@example.com>',
      thread_id: 'thread-1',
      _id: null,
      _collection: 'data.mail',
    });
  });

  it('propagates provider.warnings (e.g. MAIL_SEND_APPEND_FAILED) through the rpc shape', async () => {
    const h = withHarness({
      sendCapable: true,
      accountEmail: 'alice@example.com',
      sendResult: {
        source_id: 'srcid-2',
        message_id: '<msgid-2@example.com>',
        sent_at: 1_700_000_000_000,
        warnings: [{ code: 'MAIL_SEND_APPEND_FAILED', message: 'IMAP APPEND failed' }],
      },
    });
    const result = await h.collection.send(baseInput);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0].code).toBe('MAIL_SEND_APPEND_FAILED');
  });
});

// ────────────────────────────────────────────────────────────────
// 4. rpc handler — handleCollectionMailSend
// ────────────────────────────────────────────────────────────────

const stubRegistry = (mailCollection: MailCollection): CollectionRegistry => ({
  register() { /* no-op */ },
  get(platform: string, slug: string) {
    if (platform === 'mail' && slug === mailCollection.slug) return mailCollection;
    return null;
  },
  list() { return [mailCollection]; },
  unregister() { return false; },
  dispose: async () => { /* no-op */ },
} as unknown as CollectionRegistry);

describe('D-127 P1.6 — collection.mail.send rpc handler', () => {
  it('dispatches through MailCollection.send and returns rpc response shape', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    const registry = stubRegistry(h.collection);
    const result = await handleCollectionMailSend(
      { registry },
      {
        instance: 'work',
        to: ['bob@example.com'],
        subject: 'hi',
        body_text: 'hello',
      },
    );
    expect(result).toMatchObject({
      source_id: 'srcid-1',
      message_id: '<msgid-1@example.com>',
      _id: null,
      _collection: 'data.mail',
    });
  });

  it('propagates IngredientError(MAIL_SEND_SELF_LOOP_TO) through the rpc dispatch', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    const registry = stubRegistry(h.collection);
    try {
      await handleCollectionMailSend(
        { registry },
        {
          instance: 'work',
          to: ['alice@example.com'],
          subject: 's',
          body_text: 'b',
        },
      );
      expect.fail('expected MAIL_SEND_SELF_LOOP_TO');
    } catch (err) {
      expect(err).toBeInstanceOf(IngredientError);
      expect((err as IngredientError).code).toBe('MAIL_SEND_SELF_LOOP_TO');
    }
  });

  it('throws RpcError(not_found) when the slug isn\'t registered', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    const registry = stubRegistry(h.collection);
    try {
      await handleCollectionMailSend(
        { registry },
        { instance: 'unknown-slug', to: ['x@y.com'], subject: 's', body_text: 'b' },
      );
      expect.fail('expected RpcError(not_found)');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe('not_found');
    }
  });

  it('rejects bad input shapes with RpcError(bad_request)', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    const registry = stubRegistry(h.collection);
    const cases: Array<{ args: Record<string, unknown>; reason: string }> = [
      { args: { to: ['x@y.com'], subject: 's', body_text: 'b' }, reason: 'instance required' },
      { args: { instance: 'work', subject: 's', body_text: 'b' }, reason: 'to required' },
      { args: { instance: 'work', to: [], subject: 's', body_text: 'b' }, reason: 'to non-empty' },
      { args: { instance: 'work', to: ['x@y.com'], body_text: 'b' }, reason: 'subject required' },
      { args: { instance: 'work', to: ['x@y.com'], subject: 's' }, reason: 'body_text required' },
      { args: { instance: 'work', to: 'not-an-array', subject: 's', body_text: 'b' }, reason: 'to must be array' },
      { args: { instance: 'work', to: ['x@y.com'], subject: 's', body_text: 'b', reconciliation_id: 'bad id' }, reason: 'reconciliation id must be a header token' },
    ];
    for (const c of cases) {
      try {
        await handleCollectionMailSend({ registry }, c.args);
        expect.fail(`expected RpcError(bad_request) for ${c.reason}`);
      } catch (err) {
        expect(err, c.reason).toBeInstanceOf(RpcError);
        expect((err as RpcError).code, c.reason).toBe('bad_request');
      }
    }
  });

  it('passes optional cc / bcc / threading headers through to provider.send', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    const registry = stubRegistry(h.collection);
    await handleCollectionMailSend(
      { registry },
      {
        instance: 'work',
        to: ['bob@example.com'],
        cc: ['c@example.com'],
        bcc: ['d@example.com'],
        subject: 're',
        body_text: 'thx',
        body_html: '<p>thx</p>',
        in_reply_to: '<parent@example.com>',
        references: ['<gp@example.com>', '<parent@example.com>'],
        reply_to: 'r@example.com',
      },
    );
    const call = h.stub.sendCalls[0];
    expect(call).toBeDefined();
    expect(call?.cc).toEqual(['c@example.com']);
    expect(call?.bcc).toEqual(['d@example.com']);
    expect(call?.body_html).toBe('<p>thx</p>');
    expect(call?.in_reply_to).toBe('<parent@example.com>');
    expect(call?.references).toEqual(['<gp@example.com>', '<parent@example.com>']);
    expect(call?.reply_to).toBe('r@example.com');
  });

  /** Split out of the cc/bcc case above, which used to carry a `reconciliation_id`
   *  alongside them. D-207 slice 3d (`848040972`) made that combination illegal on
   *  purpose: the reconciliation query matches ONE recipient envelope, so a fan-out
   *  send cannot be PROVEN by it, and mail-send refuses rather than claim on `to[0]`
   *  and call the result reconciled. The refusal itself is pinned in
   *  `d-207-slice3d-mail-send-claim-wiring.test.ts` ("⛔ REFUSES a reconciliation_id
   *  on a cc alongside the to"); what belongs HERE is the wire shape — that the id
   *  reaches the provider on the single-recipient send where it is legal. */
  it('passes reconciliation_id through to provider.send on a single-recipient send', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    const registry = stubRegistry(h.collection);
    await handleCollectionMailSend(
      { registry },
      {
        instance: 'work',
        to: ['bob@example.com'],
        subject: 're',
        body_text: 'thx',
        reconciliation_id: `d200-${'a'.repeat(64)}`,
      },
    );
    const call = h.stub.sendCalls[0];
    expect(call).toBeDefined();
    expect(call?.reconciliation_id).toBe(`d200-${'a'.repeat(64)}`);
  });
});

// silence unused-import warning when vi is not referenced in this module
void vi;
