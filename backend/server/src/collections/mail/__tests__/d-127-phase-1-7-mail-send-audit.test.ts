/** D-127 Phase 1.7 — `mail_send` audit emission tests.
 *
 *  Pins the audit-row contract emitted from `MailCollection.send`:
 *
 *    1. Successful send → one `mail_send` activity row, success: true,
 *       target = `mail:<slug>`, detail carries recipient_count, subject,
 *       message_id, body_bytes.
 *    2. Failure (capability gate / sender guard / provider throw) →
 *       one row, success: false, error: { code, message }.
 *    3. Body content NOT included in the audit detail (privacy).
 *    4. Recipient list redacted to count-only when total recipients
 *       exceeds MAIL_SEND_AUDIT_RECIPIENT_REDACTION_THRESHOLD.
 *    5. Provider warnings (e.g. MAIL_SEND_APPEND_FAILED) attach to
 *       the audit detail.
 *    6. Sender's own address excluded from the recipients list (cc/bcc
 *       self is archival noise — sender is already in `target`).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { IngredientError } from '@recued/ingredients';
import {
  MAIL_SEND_AUDIT_RECIPIENT_REDACTION_THRESHOLD,
  type MailSendAuditDetail,
} from '@recued/contracts';
import type {
  ActivityEntry,
  AppendOptions,
  AuditEntry,
  AuditLogStore,
} from '@recued/storage';
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

// ────────────────────────────────────────────────────────────────
// Stub provider — controllable sendCapable + accountEmail + send
// ────────────────────────────────────────────────────────────────

interface StubSendHooks {
  sendCapable?: boolean;
  accountEmail?: string;
  sendResult?: SentMessageMeta;
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
// In-memory audit log capturing rows for assertion
// ────────────────────────────────────────────────────────────────

interface AuditSink {
  log: AuditLogStore;
  rows: ActivityEntry[];
}

const mkAuditLog = (): AuditSink => {
  const rows: ActivityEntry[] = [];
  const log: AuditLogStore = {
    append: async (_entry: AuditEntry, _opts?: AppendOptions) => {},
    listRecent: async () => [],
    listByRecipe: async () => [],
    listByChannelSession: async () => [],
    listByCognitionSession: async () => [],
    listByCorrelation: async () => [],
    listByDish: async () => [],
    latestByDishes: async () => new Map(),
    get: async () => null,
    clearOlderThan: async () => 0,
    clearByRecipe: async () => 0,
    exportAll: async () => [],
    size: async () => 0,
    clearAll: async () => {},
    logActivity: async (entry: ActivityEntry, _opts?: AppendOptions) => {
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

// ────────────────────────────────────────────────────────────────
// Harness — real MailCollection wired with the audit sink
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
  audit: AuditSink;
  close(): void;
}

const newHarness = (hooks: StubSendHooks = {}): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-send-audit-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'test.db'));
  db.pragma('journal_mode = WAL');
  const gate = createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:mail:work' });
  const blobs = createBlobStore(join(dataDir, 'blobs'));
  const bus = createWarehouseEventBus();
  const stub = makeStubProvider('work', hooks);
  const audit = mkAuditLog();
  const config: MailCollectionConfig = {
    backfill_days: 30, retention_days: 365, quota_bytes: BIG_QUOTA,
  };
  const collection = createMailCollection({
    db, blobs, gate, bus, slug: 'work',
    provider: stub.provider,
    config: () => config,
    auditLog: audit.log,
  });
  return {
    dir, db, gate, blobs, bus, collection, stub, audit,
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

const parseDetail = (entry: ActivityEntry): MailSendAuditDetail => {
  expect(entry.detail).toBeDefined();
  return JSON.parse(entry.detail!) as MailSendAuditDetail;
};

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('D-127 P1.7 — mail_send audit emission (success path)', () => {
  it('emits exactly one mail_send row on a successful send with the canonical detail shape', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    await h.collection.send({
      to: ['bob@example.com'],
      subject: 'hello',
      body_text: 'world',
    });
    expect(h.audit.rows).toHaveLength(1);
    const row = h.audit.rows[0]!;
    expect(row.action).toBe('mail_send');
    expect(row.target).toBe('mail:work');
    expect(typeof row.activity_id).toBe('string');
    expect(typeof row.timestamp).toBe('number');
    const detail = parseDetail(row);
    expect(detail).toMatchObject({
      recipient_count: 1,
      subject: 'hello',
      message_id: '<msgid-1@example.com>',
      body_bytes: 5,
      success: true,
    });
    expect(detail.recipients).toEqual(['bob@example.com']);
    expect(detail.error).toBeUndefined();
    expect(detail.warnings).toBeUndefined();
  });

  it('does NOT include body content in the audit detail (privacy)', async () => {
    const secret = 'TOP_SECRET_BODY_CONTENT_DO_NOT_LOG';
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    await h.collection.send({
      to: ['bob@example.com'],
      subject: 'hi',
      body_text: secret,
      body_html: `<p>${secret}</p>`,
    });
    expect(h.audit.rows).toHaveLength(1);
    const detail = parseDetail(h.audit.rows[0]!);
    expect(detail.body_bytes).toBe(Buffer.byteLength(secret, 'utf8'));
    // The serialized detail string must not contain the body anywhere.
    expect(h.audit.rows[0]!.detail!).not.toContain(secret);
  });

  it('attaches provider warnings (e.g. MAIL_SEND_APPEND_FAILED) to the audit detail', async () => {
    const h = withHarness({
      sendCapable: true,
      accountEmail: 'alice@example.com',
      sendResult: {
        source_id: 'srcid-2',
        message_id: '<msgid-2@example.com>',
        sent_at: 1_700_000_000_000,
        warnings: [
          { code: 'MAIL_SEND_APPEND_FAILED', message: 'IMAP APPEND failed: NO Cannot create folder' },
        ],
      },
    });
    await h.collection.send({
      to: ['bob@example.com'],
      subject: 's',
      body_text: 'b',
    });
    const detail = parseDetail(h.audit.rows[0]!);
    expect(detail.success).toBe(true);
    expect(detail.warnings).toEqual([
      { code: 'MAIL_SEND_APPEND_FAILED', message: 'IMAP APPEND failed: NO Cannot create folder' },
    ]);
  });

  it('excludes the sender\'s own address from the recipients list when cc/bcc-self is set', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    await h.collection.send({
      to: ['bob@example.com'],
      cc: ['alice@example.com'],
      bcc: ['Alice <ALICE@Example.COM>'],
      subject: 's',
      body_text: 'b',
    });
    const detail = parseDetail(h.audit.rows[0]!);
    // recipient_count counts everything; recipients list excludes sender.
    expect(detail.recipient_count).toBe(3);
    expect(detail.recipients).toEqual(['bob@example.com']);
  });
});

describe('D-127 P1.7 — mail_send audit redaction by recipient count', () => {
  it('redacts the recipients list when count > MAIL_SEND_AUDIT_RECIPIENT_REDACTION_THRESHOLD', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    const many = Array.from(
      { length: MAIL_SEND_AUDIT_RECIPIENT_REDACTION_THRESHOLD + 1 },
      (_, i) => `user${i}@example.com`,
    );
    await h.collection.send({
      to: many,
      subject: 'fanout',
      body_text: 'b',
    });
    const detail = parseDetail(h.audit.rows[0]!);
    expect(detail.recipient_count).toBe(MAIL_SEND_AUDIT_RECIPIENT_REDACTION_THRESHOLD + 1);
    expect(detail.recipients).toBeUndefined();
  });

  it('attaches the recipients list when count <= threshold', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    const some = Array.from(
      { length: MAIL_SEND_AUDIT_RECIPIENT_REDACTION_THRESHOLD },
      (_, i) => `user${i}@example.com`,
    );
    await h.collection.send({
      to: some,
      subject: 'small',
      body_text: 'b',
    });
    const detail = parseDetail(h.audit.rows[0]!);
    expect(detail.recipient_count).toBe(MAIL_SEND_AUDIT_RECIPIENT_REDACTION_THRESHOLD);
    expect(detail.recipients).toEqual(some);
  });
});

describe('D-127 P1.7 — mail_send audit emission (failure paths)', () => {
  it('emits a failure row with error.code = MAIL_SEND_NOT_CAPABLE when capability gate trips', async () => {
    const h = withHarness({ sendCapable: false });
    try {
      await h.collection.send({ to: ['bob@example.com'], subject: 's', body_text: 'b' });
      expect.fail('expected MAIL_SEND_NOT_CAPABLE');
    } catch (err) {
      expect((err as IngredientError).code).toBe('MAIL_SEND_NOT_CAPABLE');
    }
    expect(h.audit.rows).toHaveLength(1);
    const detail = parseDetail(h.audit.rows[0]!);
    expect(detail).toMatchObject({
      success: false,
      message_id: '',
      recipient_count: 1,
    });
    expect(detail.error?.code).toBe('MAIL_SEND_NOT_CAPABLE');
    expect(typeof detail.error?.message).toBe('string');
  });

  it('emits a failure row when the sender ≠ to guard rejects the call', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    try {
      await h.collection.send({
        to: ['alice@example.com'],
        subject: 's',
        body_text: 'b',
      });
      expect.fail('expected MAIL_SEND_SELF_LOOP_TO');
    } catch {
      /* expected */
    }
    expect(h.audit.rows).toHaveLength(1);
    const detail = parseDetail(h.audit.rows[0]!);
    expect(detail.success).toBe(false);
    expect(detail.error?.code).toBe('MAIL_SEND_SELF_LOOP_TO');
  });

  it('emits a failure row when provider.send throws', async () => {
    const h = withHarness({
      sendCapable: true,
      accountEmail: 'alice@example.com',
      sendThrows: new IngredientError(
        'MAIL_SEND_NETWORK_FAILED',
        'SMTP connection refused',
        { kind: 'imap', slug: 'work' },
      ),
    });
    try {
      await h.collection.send({ to: ['bob@example.com'], subject: 's', body_text: 'b' });
      expect.fail('expected MAIL_SEND_NETWORK_FAILED');
    } catch {
      /* expected */
    }
    expect(h.audit.rows).toHaveLength(1);
    const detail = parseDetail(h.audit.rows[0]!);
    expect(detail.success).toBe(false);
    expect(detail.error?.code).toBe('MAIL_SEND_NETWORK_FAILED');
    expect(detail.error?.message).toContain('SMTP connection refused');
  });
});

describe('D-127 follow-on — mail_send audit detail carries engine step identity', () => {
  it('attaches recipe_id + step_id to the audit detail when MailSendInput supplies them', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    await h.collection.send({
      to: ['bob@example.com'],
      subject: 'attributed',
      body_text: 'b',
      recipe_id: 'detect-deal-risk-hubspot',
      step_id: 'send_followup',
    });
    const detail = parseDetail(h.audit.rows[0]!);
    expect(detail.recipe_id).toBe('detect-deal-risk-hubspot');
    expect(detail.step_id).toBe('send_followup');
    // Other fields unchanged.
    expect(detail.success).toBe(true);
    expect(detail.recipient_count).toBe(1);
  });

  it('omits recipe_id + step_id when the MailSendInput leaves them blank (direct caller)', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    await h.collection.send({
      to: ['bob@example.com'],
      subject: 's',
      body_text: 'b',
    });
    const detail = parseDetail(h.audit.rows[0]!);
    expect(detail.recipe_id).toBeUndefined();
    expect(detail.step_id).toBeUndefined();
  });

  it('treats empty strings as absent (direct rpc clients that pass blanks defensively)', async () => {
    const h = withHarness({ sendCapable: true, accountEmail: 'alice@example.com' });
    await h.collection.send({
      to: ['bob@example.com'],
      subject: 's',
      body_text: 'b',
      recipe_id: '',
      step_id: '',
    });
    const detail = parseDetail(h.audit.rows[0]!);
    expect(detail.recipe_id).toBeUndefined();
    expect(detail.step_id).toBeUndefined();
  });

  it('still attaches recipe_id + step_id on failure-path audit rows', async () => {
    // Capability gate trips before the provider is even called; the
    // audit row must still attribute back to the originating step.
    const h = withHarness({ sendCapable: false });
    try {
      await h.collection.send({
        to: ['bob@example.com'],
        subject: 's',
        body_text: 'b',
        recipe_id: 'detect-deal-risk-hubspot',
        step_id: 'send_followup',
      });
      expect.fail('expected MAIL_SEND_NOT_CAPABLE');
    } catch (err) {
      expect((err as IngredientError).code).toBe('MAIL_SEND_NOT_CAPABLE');
    }
    const detail = parseDetail(h.audit.rows[0]!);
    expect(detail.success).toBe(false);
    expect(detail.recipe_id).toBe('detect-deal-risk-hubspot');
    expect(detail.step_id).toBe('send_followup');
  });
});
