/** D-172 P2 (Attachments-v2) — MailCollection.send attachment resolve path.
 *
 *  The keystone lane test: end-to-end through a real `MailCollection`
 *  over a real SQLite DB + a real `InboundFileCollection` (CAS-backed):
 *
 *    1. Resolve path — `attachments: [<data.file record-id>]` resolves
 *       through the Gateway-gated `file.read` (`handleFileRead`, the ONE
 *       audited byte-egress path — I-4) into an `OutgoingAttachment`
 *       (filename + mime + base64 bytes + size) handed to `provider.send`.
 *    2. Audited egress (I-4) — every resolved attachment emits a
 *       `file_content_read` audit row.
 *    3. Over-size warn (I-6) — a file above the Half-A cap is DROPPED
 *       from the payload + surfaced as a `MAIL_SEND_ATTACHMENT_OVERSIZE`
 *       warning (never silently dropped).
 *    4. Unresolvable ref → `MAIL_SEND_ATTACHMENT_UNRESOLVABLE` (refuse the
 *       whole send rather than ship a mail missing files — I-6).
 *    5. No `fileReadDeps` wired + attachment present → same hard error.
 *    6. MUTATION GUARD — asserts the resolved attachment actually reaches
 *       `provider.send`; this test fails if attachments are dropped before
 *       the provider call.
 */

import { allocateRunScratchDir, cleanupRunScratch } from '../../../execution/run-scratch.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { MAIL_SEND_CLAIMS_TABLE } from '../../../storage/mail-send-claim-store.js';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { IngredientError } from '@recued/ingredients';
import type { ActivityEntry } from '@recued/storage';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { createBlobStore, type BlobStore } from '../../../storage/blob-store.js';
import {
  createMailCollection,
  MAIL_SEND_ATTACHMENT_MAX_BYTES,
  MAIL_SEND_ATTACHMENT_OVERSIZE_WARNING,
  type MailCollection,
  type MailCollectionConfig,
} from '../mail-collection.js';
import type {
  MailProvider,
  OutgoingMessage,
  ProviderHealth,
  SentMessageMeta,
} from '../provider.js';
import {
  createInboundFileCollection,
  type InboundFileCollection,
} from '../../file/inbound-file-collection.js';
import { createCollectionRegistry, type CollectionRegistry } from '../../registry.js';
import type { FileReadDeps } from '../../file/file-read-handler.js';

const BIG_QUOTA = 100 * 1024 * 1024;

interface StubHandle {
  provider: MailProvider;
  sendCalls: OutgoingMessage[];
}

const makeStubProvider = (): StubHandle => {
  const sendCalls: OutgoingMessage[] = [];
  const sendImpl = async (msg: OutgoingMessage): Promise<SentMessageMeta> => {
    sendCalls.push(msg);
    return {
      source_id: 'srcid-1',
      message_id: '<msgid-1@example.com>',
      sent_at: 1_700_000_000_000,
      thread_id: 'thread-1',
    };
  };
  const provider: MailProvider = {
    kind: 'imap',
    slug: 'work',
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
    send: sendImpl,
  };
  return { provider, sendCalls };
};

interface Harness {
  dir: string;
  db: Database.Database;
  blobs: BlobStore;
  collection: MailCollection;
  fileColl: InboundFileCollection;
  registry: CollectionRegistry;
  stub: StubHandle;
  auditRows: ActivityEntry[];
  /** Ingest a file into data.file.received → returns its record_id. */
  ingestFile(bytes: Buffer, filename: string, mime: string, sourceId: string): Promise<string>;
  close(): void;
}

const newHarness = (opts: { wireFileReadDeps?: boolean } = {}): Harness => {
  const wireFileReadDeps = opts.wireFileReadDeps ?? true;
  const dir = mkdtempSync(join(tmpdir(), 'mail-attach-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'test.db'));
  db.pragma('journal_mode = WAL');
  const blobs = createBlobStore(join(dataDir, 'blobs'));
  const bus = createWarehouseEventBus();
  const auditRows: ActivityEntry[] = [];
  const auditLog = {
    async logActivity(entry: ActivityEntry) { auditRows.push(entry); },
  } as unknown as import('@recued/storage').AuditLogStore;

  const registry = createCollectionRegistry();
  const fileColl = createInboundFileCollection({
    db,
    blobs,
    gate: createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:file:received' }),
    bus,
    slug: 'received',
    auditLog,
  });
  registry.register(fileColl);

  const stub = makeStubProvider();
  const config: MailCollectionConfig = { backfill_days: 30, retention_days: 365, quota_bytes: BIG_QUOTA };
  const fileReadDeps = (): FileReadDeps => ({ registry, blobs, auditLog });
  const collection = createMailCollection({
    db,
    blobs,
    gate: createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:mail:work' }),
    bus,
    slug: 'work',
    provider: stub.provider,
    config: () => config,
    auditLog,
    ...(wireFileReadDeps ? { fileReadDeps } : {}),
  });

  return {
    dir, db, blobs, collection, fileColl, registry, stub, auditRows,
    async ingestFile(bytes, filename, mime, sourceId) {
      const rec = await fileColl.ingest({
        bytes, filename, mime_type: mime, origin: 'mail_attachment', source_id: sourceId,
      });
      return rec.record_id;
    },
    close() {
      void collection.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

let harnessRefs: Harness[] = [];
const withHarness = (opts: { wireFileReadDeps?: boolean } = {}): Harness => {
  const h = newHarness(opts);
  harnessRefs.push(h);
  return h;
};
afterEach(() => {
  for (const h of harnessRefs) {
    try { h.close(); } catch { /* swallow */ }
  }
  harnessRefs = [];
});

const baseInput = { to: ['bob@example.com'], subject: 'hello', body_text: 'world' };

// ────────────────────────────────────────────────────────────────
// 1. Resolve path — ref → handleFileRead → OutgoingAttachment
// ────────────────────────────────────────────────────────────────

describe('D-172 P2 — MailCollection.send resolves attachment refs to bytes', () => {
  it('resolves a data.file ref into an OutgoingAttachment handed to provider.send', async () => {
    const h = withHarness();
    const bytes = Buffer.from('%PDF-1.4 signed contract');
    const ref = await h.ingestFile(bytes, 'contract.pdf', 'application/pdf', 'drop-1');

    const result = await h.collection.send({ ...baseInput, attachments: [ref] });

    // MUTATION GUARD — the resolved attachment must reach provider.send.
    expect(h.stub.sendCalls).toHaveLength(1);
    const sent = h.stub.sendCalls[0];
    expect(sent.attachments).toBeDefined();
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments?.[0]).toMatchObject({
      filename: 'contract.pdf',
      mime_type: 'application/pdf',
      size_bytes: bytes.length,
    });
    // base64 round-trips back to the original plaintext bytes.
    const decoded = Buffer.from(sent.attachments![0].bytes_b64, 'base64');
    expect(decoded.equals(bytes)).toBe(true);
    // No warnings on the happy path.
    expect(result.warnings).toBeUndefined();
  });

  it('resolves multiple refs in input order', async () => {
    const h = withHarness();
    const a = await h.ingestFile(Buffer.from('aaa'), 'a.txt', 'text/plain', 's-a');
    const b = await h.ingestFile(Buffer.from('bbbb'), 'b.txt', 'text/plain', 's-b');
    await h.collection.send({ ...baseInput, attachments: [a, b] });
    const sent = h.stub.sendCalls[0];
    expect(sent.attachments?.map((x) => x.filename)).toEqual(['a.txt', 'b.txt']);
  });

  it('no attachments field → provider.send receives no attachments (legacy shape unchanged)', async () => {
    const h = withHarness();
    await h.collection.send(baseInput);
    expect(h.stub.sendCalls[0].attachments).toBeUndefined();
  });

  it('empty attachments array → provider.send receives no attachments', async () => {
    const h = withHarness();
    await h.collection.send({ ...baseInput, attachments: [] });
    expect(h.stub.sendCalls[0].attachments).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// 2. Audited egress (I-4)
// ────────────────────────────────────────────────────────────────

describe('D-172 P2 — attachment bytes leave only through the audited file.read (I-4)', () => {
  it('emits a file_content_read audit row per resolved attachment', async () => {
    const h = withHarness();
    const ref = await h.ingestFile(Buffer.from('x'), 'x.txt', 'text/plain', 's-x');
    await h.collection.send({ ...baseInput, attachments: [ref] });
    const reads = h.auditRows.filter((r) => r.action === 'file_content_read');
    expect(reads).toHaveLength(1);
    expect(reads[0].target).toBe(ref);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. Over-size warn (I-6 — drop + warn, never silent)
// ────────────────────────────────────────────────────────────────

describe('D-172 P2 — over-cap attachment is dropped + warned (I-6)', () => {
  it('drops an over-cap file from the payload and surfaces a warning', async () => {
    const h = withHarness();
    const bigBytes = Buffer.alloc(MAIL_SEND_ATTACHMENT_MAX_BYTES + 1, 0x61);
    const ref = await h.ingestFile(bigBytes, 'huge.bin', 'application/octet-stream', 's-big');

    const result = await h.collection.send({ ...baseInput, attachments: [ref] });

    // Mail still sent; attachment omitted from the provider payload.
    expect(h.stub.sendCalls).toHaveLength(1);
    expect(h.stub.sendCalls[0].attachments).toBeUndefined();
    // Warning surfaced on the rpc response (never silently dropped).
    expect(result.warnings).toBeDefined();
    const oversize = result.warnings?.find((w) => w.code === MAIL_SEND_ATTACHMENT_OVERSIZE_WARNING);
    expect(oversize).toBeDefined();
    expect(oversize?.message).toContain('huge.bin');
  });

  it('keeps the in-cap files and warns only on the over-cap one (mixed batch)', async () => {
    const h = withHarness();
    const small = await h.ingestFile(Buffer.from('small'), 'small.txt', 'text/plain', 's-small');
    const big = await h.ingestFile(
      Buffer.alloc(MAIL_SEND_ATTACHMENT_MAX_BYTES + 1, 0x62),
      'big.bin', 'application/octet-stream', 's-big2',
    );
    const result = await h.collection.send({ ...baseInput, attachments: [small, big] });
    const sent = h.stub.sendCalls[0];
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments?.[0].filename).toBe('small.txt');
    expect(result.warnings?.some((w) => w.code === MAIL_SEND_ATTACHMENT_OVERSIZE_WARNING)).toBe(true);
  });

  it('over-size warning rides alongside the provider warnings on the audit + response', async () => {
    // A single oversize attachment → mail sent with only the resolve warning.
    const h = withHarness();
    const big = await h.ingestFile(
      Buffer.alloc(MAIL_SEND_ATTACHMENT_MAX_BYTES + 10, 0x63),
      'over.bin', 'application/octet-stream', 's-over',
    );
    await h.collection.send({ ...baseInput, attachments: [big] });
    const sendRows = h.auditRows.filter((r) => r.action === 'mail_send');
    expect(sendRows).toHaveLength(1);
    const detail = JSON.parse(sendRows[0].detail ?? '{}') as { warnings?: Array<{ code: string }> };
    expect(detail.warnings?.some((w) => w.code === MAIL_SEND_ATTACHMENT_OVERSIZE_WARNING)).toBe(true);
  });

  // review F3 — an over-cap ref is DROPPED from the metadata size preflight
  // BEFORE its bytes are ever read. The prior loop read + base64'd every ref
  // (hundreds of MB for a near-quota file) only to discard the over-cap one;
  // the preflight reads `data.file.received.hot_fields.size` (ungated
  // metadata) first.
  it('drops an over-cap attachment WITHOUT reading its blob bytes (F3 preflight)', async () => {
    const h = withHarness();
    const bigBytes = Buffer.alloc(MAIL_SEND_ATTACHMENT_MAX_BYTES + 1, 0x64);
    const big = await h.ingestFile(bigBytes, 'huge.bin', 'application/octet-stream', 's-big-pf');
    // Spy AFTER ingest so the ingest's own blob write is not counted; only
    // a SEND-path read would land here.
    const blobGetSpy = vi.spyOn(h.blobs, 'get');

    const result = await h.collection.send({ ...baseInput, attachments: [big] });

    // The blob was NEVER read on the send path — no decode, no base64 alloc.
    expect(blobGetSpy).not.toHaveBeenCalled();
    // And the audited byte-egress row (`handleFileRead`'s `file_content_read`)
    // was likewise never emitted for the over-cap ref.
    expect(h.auditRows.filter((r) => r.action === 'file_content_read')).toHaveLength(0);
    // Yet the drop is still surfaced (I-6 — visible, never silent).
    const oversize = result.warnings?.find((w) => w.code === MAIL_SEND_ATTACHMENT_OVERSIZE_WARNING);
    expect(oversize).toBeDefined();
    expect(oversize?.message).toContain('huge.bin');
    // Mail still sent, attachment omitted.
    expect(h.stub.sendCalls).toHaveLength(1);
    expect(h.stub.sendCalls[0].attachments).toBeUndefined();
    blobGetSpy.mockRestore();
  });

  // review F3 — in a mixed batch the over-cap ref is skipped at preflight
  // (no blob read) while the in-cap ref is read exactly once.
  it('reads only the in-cap blob in a mixed batch (over-cap skipped at preflight)', async () => {
    const h = withHarness();
    const small = await h.ingestFile(Buffer.from('keep me'), 'keep.txt', 'text/plain', 's-keep');
    const big = await h.ingestFile(
      Buffer.alloc(MAIL_SEND_ATTACHMENT_MAX_BYTES + 1, 0x65),
      'drop.bin', 'application/octet-stream', 's-drop',
    );
    const blobGetSpy = vi.spyOn(h.blobs, 'get');

    await h.collection.send({ ...baseInput, attachments: [small, big] });

    // Exactly one byte read — the in-cap file. The over-cap file is dropped
    // at the metadata preflight, never reaching `blobs.get`.
    expect(blobGetSpy).toHaveBeenCalledTimes(1);
    const sent = h.stub.sendCalls[0];
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments?.[0].filename).toBe('keep.txt');
    blobGetSpy.mockRestore();
  });
});

// ────────────────────────────────────────────────────────────────
// 4. Unresolvable ref → hard error (refuse the whole send)
// ────────────────────────────────────────────────────────────────

describe('D-172 P2 — unresolvable attachment ref refuses the send (I-6)', () => {
  it('throws MAIL_SEND_ATTACHMENT_UNRESOLVABLE for a ref that does not resolve', async () => {
    const h = withHarness();
    try {
      await h.collection.send({ ...baseInput, attachments: ['file:deadbeefdeadbeefdeadbeefdeadbeef'] });
      expect.fail('expected MAIL_SEND_ATTACHMENT_UNRESOLVABLE');
    } catch (err) {
      expect(err).toBeInstanceOf(IngredientError);
      expect((err as IngredientError).code).toBe('MAIL_SEND_ATTACHMENT_UNRESOLVABLE');
    }
    // Refused before the provider was called.
    expect(h.stub.sendCalls).toHaveLength(0);
  });

  it('throws MAIL_SEND_ATTACHMENT_UNRESOLVABLE when no fileReadDeps are wired', async () => {
    const h = withHarness({ wireFileReadDeps: false });
    // Ingest a real file so the only failing factor is the missing deps.
    const ref = await h.ingestFile(Buffer.from('present'), 'p.txt', 'text/plain', 's-p');
    try {
      await h.collection.send({ ...baseInput, attachments: [ref] });
      expect.fail('expected MAIL_SEND_ATTACHMENT_UNRESOLVABLE');
    } catch (err) {
      expect((err as IngredientError).code).toBe('MAIL_SEND_ATTACHMENT_UNRESOLVABLE');
    }
    expect(h.stub.sendCalls).toHaveLength(0);
  });

  it('emits a failure mail_send audit row when an attachment is unresolvable', async () => {
    const h = withHarness();
    await h.collection.send({ ...baseInput, attachments: ['file:deadbeefdeadbeefdeadbeefdeadbeef'] })
      .catch(() => { /* expected */ });
    const sendRows = h.auditRows.filter((r) => r.action === 'mail_send');
    expect(sendRows).toHaveLength(1);
    const detail = JSON.parse(sendRows[0].detail ?? '{}') as { success: boolean; error?: { code: string } };
    expect(detail.success).toBe(false);
    expect(detail.error?.code).toBe('MAIL_SEND_ATTACHMENT_UNRESOLVABLE');
  });
});

// ────────────────────────────────────────────────────────────────
// Run-scoped temp attachments — send the bytes, keep nothing
// ────────────────────────────────────────────────────────────────

describe('⛔⛔ A TEMP ATTACHMENT IS SENT AND NOTHING DURABLE IS CREATED', () => {
  /** The lifecycle rides the TYPE. A `data.file` record id names something the
   *  owner KEEPS — sent, never touched. A `TempFileRef` names bytes the caller
   *  produced in THIS run in order to send them, so there is nothing to delete
   *  afterwards and no destructive authority on this path at all.
   *
   *  ⛔ WHY NOT A `{ file, cleanup_after }` FLAG, which is the obvious design:
   *  `file-list` takes a CALLER-SUPPLIED slug, so a recipe can enumerate the
   *  owner's whole `received` warehouse and would then be able to name any file
   *  of theirs as disposable — destroying it under this op's `write` risk tier
   *  instead of `destructive`'s `always` approval floor. A temp ref cannot be
   *  forged into that, and the last test here is what says so. */
  const tempFile = (run_id: string, name: string, bytes: Buffer) => {
    const dir = allocateRunScratchDir(run_id);
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return { backing: 'temp' as const, path, mime_type: 'image/jpeg', filename: name,
             size_bytes: bytes.length };
  };

  it('the bytes reach provider.send, byte-identical', async () => {
    const h = withHarness();
    const run_id = `run-temp-${Date.now()}`;
    const bytes = Buffer.from('\xff\xd8\xff a photograph', 'binary');
    const ref = tempFile(run_id, 'd-group.jpg', bytes);

    const result = await h.collection.send({ ...baseInput, attachments: [ref], run_id });

    expect(h.stub.sendCalls).toHaveLength(1);
    const sent = h.stub.sendCalls[0];
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments?.[0]).toMatchObject({
      filename: 'd-group.jpg', mime_type: 'image/jpeg', size_bytes: bytes.length,
    });
    expect(Buffer.from(sent.attachments![0].bytes_b64, 'base64').equals(bytes)).toBe(true);
    expect(result.warnings).toBeUndefined();
    cleanupRunScratch(run_id);
  });

  it('⛔⛔ THE RECONCILIATION PROOF IS THE SAME AS A PERSISTED COPY WOULD GIVE', async () => {
    // ⛔ THE PROPERTY THAT MAKES "DON'T PERSIST" SAFE RATHER THAN MERELY CHEAP.
    // The D-207 claim stores `attachment_sha256` so a reconciler can later find
    // the message in the Sent folder. That proof is built from the resolved
    // attachment's `blob_hash` — and for a temp ref we compute the sha256 over
    // the same bytes `handleFilePersist` would have hashed. So a send whose
    // attachment was never kept reconciles exactly as one whose was.
    //
    // ⚠ Asserted on the CLAIM ROW, not on the provider payload: `blob_hash` is
    // internal and never reaches `OutgoingAttachment`. Asserting it there passed
    // `undefined` to `toBe` and would have proven nothing about reconciliation.
    const h = withHarness();
    const run_id = `run-hash-${Date.now()}`;
    const bytes = Buffer.from('the same bytes either way');
    const reconciliation_id = `recon-${Date.now()}`;
    await h.collection.send({
      ...baseInput, attachments: [tempFile(run_id, 'x.jpg', bytes)], run_id,
      reconciliation_id,
    });
    const row = h.db.prepare(
      `SELECT attachment_sha256, attachment_size_bytes, attachment_filename
         FROM ${MAIL_SEND_CLAIMS_TABLE} WHERE reconciliation_id = ?`,
    ).get(reconciliation_id) as { attachment_sha256: string | null;
                                  attachment_size_bytes: number | null;
                                  attachment_filename: string | null } | undefined;
    expect(row, 'a claim was written for the send').toBeDefined();
    expect(row!.attachment_sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(row!.attachment_size_bytes).toBe(bytes.length);
    expect(row!.attachment_filename).toBe('x.jpg');
    cleanupRunScratch(run_id);
  });

  it('mixes with a durable record id in one message, in input order', async () => {
    const h = withHarness();
    const run_id = `run-mix-${Date.now()}`;
    const kept = await h.ingestFile(Buffer.from('kept'), 'kept.txt', 'text/plain', 'mix-1');
    const temp = tempFile(run_id, 'temp.jpg', Buffer.from('temp'));
    await h.collection.send({ ...baseInput, attachments: [kept, temp], run_id });
    expect(h.stub.sendCalls[0].attachments?.map((x) => x.filename))
      .toEqual(['kept.txt', 'temp.jpg']);
    cleanupRunScratch(run_id);
  });

  it('an over-cap temp file is DROPPED with a warning, like a record', async () => {
    const h = withHarness();
    const run_id = `run-big-${Date.now()}`;
    const big = Buffer.alloc(MAIL_SEND_ATTACHMENT_MAX_BYTES + 1, 0x41);
    await h.collection.send({
      ...baseInput, attachments: [tempFile(run_id, 'big.jpg', big)], run_id,
    });
    // The message still goes; the picture does not, and it says so.
    expect(h.stub.sendCalls).toHaveLength(1);
    expect(h.stub.sendCalls[0].attachments ?? []).toHaveLength(0);
    cleanupRunScratch(run_id);
  });

  it('⛔⛔ THE AUDIT ROW NAMES WHAT LEFT — for a temp attachment too', async () => {
    // ⛔ THE GAP THIS CLOSES, which the temp-ref path itself created. D-172's
    // I-4 made `handleFileRead` the ONE audited byte-egress path, so a
    // record-id attachment left a `file_content_read` row naming it. A temp ref
    // never touches that path, and `MailSendAuditDetail` had NO attachment
    // field — so bytes crossed the machine boundary with no trace of WHAT.
    const h = withHarness();
    const run_id = `run-audit-${Date.now()}`;
    const bytes = Buffer.from('a photograph that left the building');
    const kept = await h.ingestFile(Buffer.from('kept doc'), 'kept.pdf', 'application/pdf', 'aud-1');
    await h.collection.send({
      ...baseInput, attachments: [kept, tempFile(run_id, 'sent.jpg', bytes)], run_id,
    });

    const row = h.auditRows.find((r) => r.action === 'mail_send');
    expect(row, 'a mail_send row was written').toBeDefined();
    const detail = JSON.parse(String(row!.detail)) as {
      attachments?: Array<{ filename: string; size_bytes: number; sha256: string; carrier: string }>;
    };
    expect(detail.attachments, 'the row names the attachments').toHaveLength(2);
    // ⛔ AND IT DISTINGUISHES THE CARRIERS. "two attachments" would be true of a
    // row that could not tell the owner's document from a throwaway copy.
    expect(detail.attachments!.map((a) => [a.filename, a.carrier])).toEqual([
      ['kept.pdf', 'record'],
      ['sent.jpg', 'run_scoped'],
    ]);
    // the hash identifies the bytes later, without keeping them
    expect(detail.attachments![1]!.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(detail.attachments![1]!.size_bytes).toBe(bytes.length);
    cleanupRunScratch(run_id);
  });

  it('⛔ refuses a temp ref with NO run scope', async () => {
    const h = withHarness();
    const run_id = `run-noscope-${Date.now()}`;
    const ref = tempFile(run_id, 'x.jpg', Buffer.from('x'));
    await expect(h.collection.send({ ...baseInput, attachments: [ref] }))
      .rejects.toThrow(/run scope/i);
    expect(h.stub.sendCalls, 'nothing was sent').toHaveLength(0);
    cleanupRunScratch(run_id);
  });

  it('⛔⛔ REFUSES A TEMP REF BELONGING TO A DIFFERENT RUN — the confinement IS the authorization', async () => {
    // THE TEST THE WHOLE DESIGN RESTS ON. If a caller could name a path outside
    // its own run, a temp ref would be exactly as forgeable as a `cleanup_after`
    // flag and none of the reasoning above would hold.
    const h = withHarness();
    const mine = `run-mine-${Date.now()}`;
    const theirs = `run-theirs-${Date.now()}`;
    // ⛔⛔ `mine` MUST HAVE A SCRATCH ROOT OF ITS OWN, and the first version of
    // this test did not give it one. `assertPathUnderRunScratch` fails EARLY
    // when the reader's own root does not resolve ("no run-scratch root for
    // run …"), so the send was refused before the containment comparison ever
    // ran — delete that comparison entirely and this test still passed. It named
    // one guard and was decided by another.
    tempFile(mine, 'mine.jpg', Buffer.from('mine'));
    const strangersFile = tempFile(theirs, 'not-mine.jpg', Buffer.from('not mine'));

    await expect(h.collection.send({
      ...baseInput, attachments: [strangersFile], run_id: mine,
    })).rejects.toThrow(/escapes the run-scratch root/i);   // the containment check, by name
    expect(h.stub.sendCalls, 'nothing was sent').toHaveLength(0);
    cleanupRunScratch(mine);
    cleanupRunScratch(theirs);
  });
});
