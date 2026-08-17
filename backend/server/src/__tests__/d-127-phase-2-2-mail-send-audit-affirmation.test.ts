/** D-127 Phase 2.2 — affirmation that the kernel `mail-send` ingredient
 *  inherits the rpc-layer `mail_send` audit row from P1.7, with no
 *  separate emission at the kernel layer.
 *
 *  This wires the same chain a recipe step exercises in production:
 *
 *    kernel adapter (slug='mail-send')
 *      → KernelDispatchers.mailSend
 *        → handleCollectionMailSend rpc handler (collection-handler.ts)
 *          → MailCollection.send
 *            → emitAudit (P1.7 — appends one mail_send ActivityEntry)
 *
 *  Pinned: exactly one audit row per kernel call (no double-emission
 *  at the kernel + collection layers), `target = mail:<slug>` carries
 *  the sender instance, and the detail blob contains the canonical
 *  per-call fields (`subject`, `message_id`, `recipient_count`,
 *  `body_bytes`, `success`).
 *
 *  D-127 follow-on (2026-04-29) closed the previous P2.2 gap: when the
 *  kernel adapter receives a `ResolvedCall` with engine-supplied
 *  `stepMeta` (the path `createIngredientExecutor` builds during a
 *  recipe run), `recipe_id` + `step_id` thread through the dispatcher
 *  → `handleCollectionMailSend` → `MailCollection.send` and land on the
 *  `mail_send` audit detail. Direct adapter callers (tests calling the
 *  kernel adapter with a hand-built `ResolvedCall`, MCP agent, Settings
 *  → Connections probe) leave `stepMeta` absent and the audit row
 *  simply omits both fields — the legacy invariant pinned by the first
 *  test in this file.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createKernelAdapter, type KernelDispatchers } from '@recued/ingredients';
import type {
  ActivityEntry,
  AppendOptions,
  AuditEntry,
  AuditLogStore,
} from '@recued/storage';
import type { MailSendAuditDetail } from '@recued/contracts';
import { createStorageGate, type StorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus, type WarehouseEventBus } from '@recued/warehouse-events';

import { createBlobStore, type BlobStore } from '../storage/blob-store.js';
import {
  createMailCollection,
  type MailCollection,
  type MailCollectionConfig,
} from '../collections/mail/mail-collection.js';
import type {
  MailProvider,
  OutgoingMessage,
  ProviderHealth,
  SentMessageMeta,
} from '../collections/mail/provider.js';
import { handleCollectionMailSend } from '../collections/collection-handler.js';
import type { CollectionRegistry } from '../collections/registry.js';

// ────────────────────────────────────────────────────────────────
// Stubs
// ────────────────────────────────────────────────────────────────

const mkProvider = (slug: string): { provider: MailProvider; sendCalls: OutgoingMessage[] } => {
  const sendCalls: OutgoingMessage[] = [];
  const provider: MailProvider = {
    kind: 'imap',
    slug,
    sendCapable: true,
    mutationCapable: false,
    accountEmail: 'alice@example.com',
    async connect() { /* no-op */ },
    async initialScan() { /* no-op */ },
    async startSync() { return async () => {}; },
    async close() { /* no-op */ },
    health(): ProviderHealth {
      return { last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 };
    },
    async send(msg: OutgoingMessage): Promise<SentMessageMeta> {
      sendCalls.push(msg);
      return {
        source_id: 'srcid-1',
        message_id: '<msgid-1@example.com>',
        sent_at: 1_700_000_000_000,
        thread_id: 'thread-1',
      };
    },
  };
  return { provider, sendCalls };
};

const mkAuditLog = (): { log: AuditLogStore; rows: ActivityEntry[] } => {
  const rows: ActivityEntry[] = [];
  const log: AuditLogStore = {
    append: async (_entry: AuditEntry, _opts?: AppendOptions) => {},
    listWindow: async () => [],
    listPendingExchangeRefs: async () => [],
    listInboundContractIds: async () => [],
    listRecent: async () => [],
    listByRecipe: async () => [],
    listByChannelSession: async () => [],
    listByCognitionSession: async () => [],
    listByCorrelation: async () => [],
    listByExchangeRef: async () => [],
    listByPeerContract: async () => [],
    listByDish: async () => [],
    latestByDishes: async () => new Map(),
    get: async () => null,
    clearOlderThan: async () => 0,
    clearByRecipe: async () => 0,
    exportAll: async () => [],
    size: async () => 0,
    clearAll: async () => {},
    logActivity: async (entry: ActivityEntry) => {
      rows.push(entry);
    },
    listActivities: async () => [],
    exportActivities: async () => [],
    clearOldestActivities: async () => 0,
    clearOldestEntries: async () => 0,
    countReserveEntries: async () => 0,
    countReserveActivities: async () => 0,
    lastSuccessfulBridgeDispatch: async () => null,
  };
  return { log, rows };
};

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

// ────────────────────────────────────────────────────────────────
// Harness — kernel adapter wired the same way bin.ts does it
// ────────────────────────────────────────────────────────────────

interface Harness {
  dir: string;
  db: Database.Database;
  gate: StorageGate;
  blobs: BlobStore;
  bus: WarehouseEventBus;
  collection: MailCollection;
  registry: CollectionRegistry;
  audit: ReturnType<typeof mkAuditLog>;
  kernel: ReturnType<typeof createKernelAdapter>;
  close(): void;
}

const newHarness = (): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'd-127-p2-2-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'test.db'));
  db.pragma('journal_mode = WAL');
  const gate = createStorageGate({
    quota: 100 * 1024 * 1024,
    reservePct: 10,
    surface: 'collection:mail:work',
  });
  const blobs = createBlobStore(join(dataDir, 'blobs'));
  const bus = createWarehouseEventBus();
  const audit = mkAuditLog();
  const { provider } = mkProvider('work');
  const config: MailCollectionConfig = {
    backfill_days: 30,
    retention_days: 365,
    quota_bytes: 100 * 1024 * 1024,
  };
  const collection = createMailCollection({
    db, blobs, gate, bus, slug: 'work',
    provider,
    config: () => config,
    auditLog: audit.log,
  });
  const registry = stubRegistry(collection);
  // Mirror bin.ts: the kernel `mailSend` dispatcher delegates to
  // `handleCollectionMailSend` over the live collectionRegistry, so
  // kernel-driven calls and wire-side rpc calls walk the same path.
  const dispatchers: KernelDispatchers = {
    mailSend: async (input) => handleCollectionMailSend({ registry }, input),
  };
  const kernel = createKernelAdapter(dispatchers);
  return {
    dir, db, gate, blobs, bus, collection, registry, audit, kernel,
    close() {
      void collection.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

let harnessRefs: Harness[] = [];
const withHarness = (): Harness => {
  const h = newHarness();
  harnessRefs.push(h);
  return h;
};
afterEach(() => {
  for (const h of harnessRefs) {
    try { h.close(); } catch { /* swallow */ }
  }
  harnessRefs = [];
});

const mkCall = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'write' as const,
  input,
  output: {},
  manifest_version: 1,
});

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('D-127 P2.2 — kernel mail-send inherits the P1.7 audit row', () => {
  it('emits exactly one mail_send activity row per kernel dispatch (no double emission)', async () => {
    const h = withHarness();
    const out = await h.kernel(mkCall('mail-send', {
      sender_mail_instance: 'work',
      to: ['bob@example.com'],
      subject: 'follow-up draft',
      body: 'hello',
      body_format: 'text',
    }));
    // The dispatch chain returned a real result.
    expect((out as { _collection: string })._collection).toBe('data.mail');
    expect((out as { message_id: string }).message_id).toBe('<msgid-1@example.com>');
    // Exactly one mail_send row from the chain — no duplicates from
    // the kernel layer also emitting (P2.2 invariant: kernel inherits,
    // doesn't re-emit).
    const mailSendRows = h.audit.rows.filter((r) => r.action === 'mail_send');
    expect(mailSendRows).toHaveLength(1);
    const row = mailSendRows[0]!;
    expect(row.target).toBe('mail:work');
    const detail = JSON.parse(row.detail!) as MailSendAuditDetail;
    expect(detail).toMatchObject({
      success: true,
      recipient_count: 1,
      subject: 'follow-up draft',
      message_id: '<msgid-1@example.com>',
    });
    expect(detail.recipients).toEqual(['bob@example.com']);
    // Body content stays excluded all the way through the kernel chain.
    expect(row.detail!).not.toContain('hello');
    // No engine context attached → audit row carries no recipe / step id.
    // (The follow-on plumbing test below pins the populated path.)
    expect(detail.recipe_id).toBeUndefined();
    expect(detail.step_id).toBeUndefined();
  });

  it('threads ResolvedCall.stepMeta into recipe_id + step_id on the audit detail (D-127 follow-on)', async () => {
    const h = withHarness();
    // Simulate the path createIngredientExecutor builds during a recipe
    // run: a ResolvedCall with stepMeta carrying engine identity. The
    // kernel adapter copies these onto the dispatcher input, the rpc
    // handler forwards them to MailCollection.send, and emitAudit
    // surfaces them on the audit detail.
    const out = await h.kernel({
      ...mkCall('mail-send', {
        sender_mail_instance: 'work',
        to: ['bob@example.com'],
        subject: 'attributed send',
        body: 'hello',
        body_format: 'text',
      }),
      stepMeta: {
        step_id: 'send_followup',
        recipe_id: 'detect-deal-risk-hubspot',
      },
    });
    expect((out as { _collection: string })._collection).toBe('data.mail');
    const mailSendRows = h.audit.rows.filter((r) => r.action === 'mail_send');
    expect(mailSendRows).toHaveLength(1);
    const detail = JSON.parse(mailSendRows[0]!.detail!) as MailSendAuditDetail;
    expect(detail.recipe_id).toBe('detect-deal-risk-hubspot');
    expect(detail.step_id).toBe('send_followup');
    // Other invariants still hold.
    expect(detail.success).toBe(true);
    expect(detail.subject).toBe('attributed send');
  });

  it('threads recipe_id + step_id onto failure-path audit rows too', async () => {
    // Sender == to fires the self-loop guard in MailCollection.send.
    // The guard emits a non-success audit row before throwing; the
    // engine identity must still attribute that row to the originating
    // recipe + step so failure audits remain greppable.
    const h = withHarness();
    await expect(
      h.kernel({
        ...mkCall('mail-send', {
          sender_mail_instance: 'work',
          // Sender (alice@example.com) appearing in `to` triggers
          // MAIL_SEND_SELF_LOOP_TO before the provider is called.
          to: ['alice@example.com'],
          subject: 'self loop',
          body: 'never sent',
          body_format: 'text',
        }),
        stepMeta: {
          step_id: 'send_followup',
          recipe_id: 'detect-deal-risk-hubspot',
        },
      }),
    ).rejects.toMatchObject({ code: 'MAIL_SEND_SELF_LOOP_TO' });
    const mailSendRows = h.audit.rows.filter((r) => r.action === 'mail_send');
    expect(mailSendRows).toHaveLength(1);
    const detail = JSON.parse(mailSendRows[0]!.detail!) as MailSendAuditDetail;
    expect(detail.success).toBe(false);
    expect(detail.recipe_id).toBe('detect-deal-risk-hubspot');
    expect(detail.step_id).toBe('send_followup');
    expect(detail.error?.code).toBe('MAIL_SEND_SELF_LOOP_TO');
  });
});

/** D-210 code audit, finding 3b — the sealed recipient must not reach the audit row.
 *
 *  `notify-booking-visitor` opens a visitor address sealed in
 *  `reception_form_submission` and hands it to this send path. The recipient
 *  threshold is a NOISE rule (a 200-address blast is unreadable), never a PII
 *  rule — and a one-recipient booking notice always fell under it, so the
 *  address was written verbatim into a durable `audit_activities.detail` that
 *  travels with `server.archive.export`, while the kernel manifest told the
 *  model it "is never surfaced in any branch".
 *
 *  ⚠ The pre-existing notify test could not see this: it stubs `mailSend` with
 *  `vi.fn()`, mocking the exact component that leaked. These drive the REAL
 *  collection + audit store. ⇒ [[a_green_test_over_a_hollow_seam]] */
describe('D-210 finding 3b — sealed-recipient audit redaction', () => {
  const detailOf = (h: Harness): MailSendAuditDetail => {
    const rows = h.audit.rows.filter((r) => r.action === 'mail_send');
    expect(rows).toHaveLength(1);
    return JSON.parse(rows[0]!.detail!) as MailSendAuditDetail;
  };

  it('omits the recipient list on the TRUSTED internal flag, and keeps the count', async () => {
    const h = withHarness();
    await handleCollectionMailSend(
      { registry: h.registry },
      { instance: 'work', to: ['visitor@example.com'], subject: 's', body_text: 'b' },
      { redact_audit_recipients: true },
    );
    const detail = detailOf(h);
    // The owner still sees that a notice went out, and to how many.
    expect(detail.recipient_count).toBe(1);
    // ⛔ Absence, proven as absence — `toMatchObject` cannot show a missing key.
    expect(Object.hasOwn(detail, 'recipients')).toBe(false);
    // Belt and braces: the address is nowhere in the serialized row.
    const rows = h.audit.rows.filter((r) => r.action === 'mail_send');
    expect(rows[0]!.detail!).not.toContain('visitor@example.com');
  });

  it('IGNORES the flag arriving as untrusted WIRE input — audit-evasion is unreachable', async () => {
    // 🔑 The reason the flag is a separate parameter rather than a field on
    // `args`. If a wire caller (the rpc method, an MCP agent, a recipe step)
    // could set it, any caller could suppress the recipient list on its own
    // audit row — a worse defect than the leak this closes.
    const h = withHarness();
    await handleCollectionMailSend(
      { registry: h.registry },
      {
        instance: 'work',
        to: ['bob@example.com'],
        subject: 's',
        body_text: 'b',
        // Not in the wire vocabulary at all — the cast is the point.
        redact_audit_recipients: true,
      } as Parameters<typeof handleCollectionMailSend>[1],
    );
    const detail = detailOf(h);
    expect(detail.recipients).toEqual(['bob@example.com']);
  });
});
