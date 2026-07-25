/** D-172 P3 — REAL-FUNNEL CAPSTONE (drop_link drain through PRODUCTION wiring).
 *
 *  The non-negotiable end-to-end test (the D-173 lesson). The lane's
 *  processor test drives `drainOnce` directly; the composition tests
 *  (`wire-reception-substrate`, `serve-compose-ingress-rpc-context`) compose
 *  the substrate but DON'T provide the drop deps — so the PRODUCTION WIRING
 *  path is otherwise untested: does `composeReceptionSubstrate` actually
 *  REGISTER the drop processor (the dep-threading guard) and does the drain
 *  INVOKE it end-to-end?
 *
 *  This capstone closes that gap with NO workarounds for the materialize
 *  seam: it composes the REAL `composeReceptionSubstrate` with real drop
 *  deps (a real `PublicEndpointRegistryStore` carrying a live `drop_link`
 *  endpoint, a real CAS-backed `DropBlobStore`, a real `InboundFileCollection`,
 *  the real `attachFile` link writer over a real `AnnotationStore`, a real
 *  `ContactStore`). The substrate registers the drop processor + fires the
 *  boot drain sweep (`registerReceptionDrain` → `runner.tick()`); the capstone
 *  awaits that in-flight sweep via the registered timer's `stop` hook, then
 *  asserts the visitor file MATERIALIZED: a `data.file.received` record + an
 *  `attachment` link onto the PRE-BOUND contact + the blob row flipped
 *  processed. The only stand-in is `backgroundServices` (the timer scheduler
 *  — and we use its real `stop` hook to await the drain).
 *
 *  Non-match-gated drop (require_contact_email_match: false) so the drop-PII
 *  decrypt is never reached — `drop-pii` is mocked at module scope (like the
 *  sibling `wire-reception-substrate` test) purely to keep the substrate's
 *  key-derivation graph clean; `openDropBlobPiiField` is never called.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import type { DropLinkConfig } from '@recued/contracts';

// Mock the reception key-derivation modules (mirrors wire-reception-substrate
// test) so `composeReceptionSubstrate` derives fixed keys without a real
// FileVault. `drop-pii` keeps a stub `openDropBlobPiiField` — never called by
// the non-match-gated drop, but present so the processor's import resolves.
const derivationMocks = vi.hoisted(() => ({
  deriveReceptionPepperFromSubDek: vi.fn(),
  deriveFormSubmissionPiiKeyFromSubDek: vi.fn(),
  deriveDropBlobPiiKeyFromSubDek: vi.fn(),
  deriveApprovalIntentPiiKeyFromSubDek: vi.fn(),
}));
vi.mock('../ports/reception/server-secret-pepper.js', () => ({
  deriveReceptionPepperFromSubDek: derivationMocks.deriveReceptionPepperFromSubDek,
}));
vi.mock('../ports/reception/form-pii.js', () => ({
  deriveFormSubmissionPiiKeyFromSubDek: derivationMocks.deriveFormSubmissionPiiKeyFromSubDek,
  openFormSubmissionField: vi.fn(),
}));
vi.mock('../ports/reception/drop-pii.js', () => ({
  deriveDropBlobPiiKeyFromSubDek: derivationMocks.deriveDropBlobPiiKeyFromSubDek,
  openDropBlobPiiField: vi.fn(),
}));
vi.mock('../ports/reception/approval-pii.js', () => ({
  deriveApprovalIntentPiiKeyFromSubDek: derivationMocks.deriveApprovalIntentPiiKeyFromSubDek,
}));

import { composeReceptionSubstrate } from '../composition/bin/wire-reception-substrate.js';
import { createBlobStore, type BlobStore } from '../storage/blob-store.js';
import { createAnnotationStore, type AnnotationStore } from '../storage/annotation-store.js';
import type { AnnotationRpcDeps } from '../annotation-handler.js';
import {
  createInboundFileCollection,
  inboundFileRecordId,
  type InboundFileCollection,
} from '../collections/file/inbound-file-collection.js';
import { createCollectionRegistry, type CollectionRegistry } from '../collections/registry.js';
import { ATTACHMENT_LINK_ROLE } from '../collections/file/attach-file.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import {
  createReceptionDropBlobStore,
  type DropBlobStore,
} from '../storage/reception-drop-store.js';
import {
  createPublicEndpointRegistryStore,
  type PublicEndpointRegistryStore,
} from '../storage/public-endpoint-registry-store.js';
import { createContactStore, type ContactStore } from '../storage/contact-store.js';
import type { FireReceptionWorkflow } from '../ports/reception/reception-drain.js';

const NOW = 1_700_000_000_000;
const ENDPOINT_ID = 'ep-drop-capstone';
const IKM = Buffer.alloc(32, 0x11);

const makeKeys = () => {
  const receptionKeyProvider = vi.fn(() => IKM);
  const keyProvider = vi.fn(() => receptionKeyProvider);
  return { keyProvider };
};

interface Harness {
  root: string;
  db: Database.Database;
  blobs: BlobStore;
  store: AnnotationStore;
  registry: CollectionRegistry;
  collection: InboundFileCollection;
  dropStore: DropBlobStore;
  registryStore: PublicEndpointRegistryStore;
  contactStore: ContactStore;
}

let h: Harness;

const makeHarness = (): Harness => {
  const root = mkdtempSync(join(tmpdir(), 'd172-p3-capstone-'));
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  ensureReceptionSchema(db);
  const blobs = createBlobStore(join(root, 'blobs'));
  let counter = 0;
  const store = createAnnotationStore({
    db,
    blobs,
    now: () => NOW + ++counter,
    newId: () => `link-${counter}`,
  });
  const registry = createCollectionRegistry();
  const collection = createInboundFileCollection({
    db,
    blobs,
    gate: createStorageGate({ quota: 100 * 1024 * 1024, reservePct: 10, surface: 'collection:file:received' }),
    bus: createWarehouseEventBus(),
    slug: 'received',
    now: () => NOW,
  });
  registry.register(collection);
  return {
    root, db, blobs, store, registry, collection,
    dropStore: createReceptionDropBlobStore(db),
    registryStore: createPublicEndpointRegistryStore(db),
    contactStore: createContactStore(db, { now: () => NOW }),
  };
};

/** Seed a contact via upsertManual → its assigned stable contact_id. */
const seedContact = (email: string, name?: string): string => {
  const id = h.contactStore.upsertManual({ email, ...(name ? { name } : {}) }, NOW).contact_id;
  if (!id) throw new Error('seedContact: no contact_id assigned');
  return id;
};

/** A live drop_link endpoint bound to a contact.
 *
 *  ⚠ D-210 Phase C — `on_upload.auto_accept` is RETIRED, so this capstone no
 *  longer pins a straight-through materialize. It exercises the same thing it
 *  always did — the drop processor's REGISTRATION + drain INVOKE through
 *  PRODUCTION wiring — but the observable outcome is now the review handoff:
 *  the blob is ingested into `data.file.received` and DISPATCHED to
 *  `review-then-approve`, and the contact attach happens on approve through the
 *  projection, never inline (I-1). */
const registerEndpoint = (contact_id: string): void => {
  const config: DropLinkConfig = {
    display_name: 'Drop here',
    link_kind: 'repeated',
    contact_scoping: { contact_id, require_contact_email_match: false },
    size_cap_bytes: 1024 * 1024,
    allowed_mime_types: ['application/pdf'],
    expiry_days: 7,
    max_uploads_per_endpoint_per_day: 50,
    required_visitor_fields: { name: 'optional', email: 'optional', description: 'optional' },
    on_upload: {
      create_data_file_entity: true,
      auto_attach_to_contact: true,
    },
  };
  h.registryStore.create({
    endpoint_id: ENDPOINT_ID,
    kind: 'drop_link',
    packet_declaration: {
      packet_kind: 'drop_link_packet',
      source_query_ref: { kind: 'reception_drop_config', drop_config_id: 'cfg-1' },
    } as unknown as Parameters<PublicEndpointRegistryStore['create']>[0]['packet_declaration'],
    bearer_secret_hmac: Buffer.alloc(32, 1),
    created_at: NOW - 1000,
    created_by_client_id: 'inst-1',
    expires_at: null,
    long_lived_acknowledged_at: NOW - 1000,
    metadata: config as unknown as Record<string, unknown>,
  });
  h.registryStore.enable(ENDPOINT_ID, NOW);
};

/** A CAS-backed drop blob (bytes in the warehouse BlobStore; metadata row
 *  pending). No visitor PII sealed — the non-match-gated drop never reads it. */
const insertDropBlob = async (blob_id: string): Promise<{ record_id: string; bytes: Buffer }> => {
  const bytes = Buffer.from(`%PDF-1.4\n%capstone-${blob_id}\n`, 'utf8');
  const blob_hash = await h.blobs.put(bytes);
  h.dropStore.insert({
    blob_id,
    endpoint_id: ENDPOINT_ID,
    uploaded_at: NOW,
    source_ip_hash: null,
    visitor_email_encrypted: null,
    visitor_name_encrypted: null,
    visitor_description_encrypted: null,
    filename_sanitized: 'signed-contract.pdf',
    mime_type_reported: 'application/pdf',
    mime_type_detected: 'application/pdf',
    size_bytes: bytes.length,
    content_hash: blob_hash,
    storage_path: blob_hash, // CAS hash post-A.1 sink-swap
    scan_status: 'unscanned',
    processing_outcome: 'pending',
  });
  return { record_id: inboundFileRecordId('reception_drop', blob_id), bytes };
};

/** Substrate deps: real drop-relevant handles + kind-stubs for the rest
 *  (mirrors wire-reception-substrate test). `backgroundServices.register`
 *  captures the reception-drain timer so we can await its boot sweep. */
const makeSubstrateDeps = (
  registerSpy: ReturnType<typeof vi.fn>,
  fireReceptionWorkflow: FireReceptionWorkflow = async () => ({ dispatched: true }),
) => ({
  // D-210 Phase C — review is the only path, so the capstone must supply the
  // dispatch seam production supplies; without it the drop would sit PENDING
  // and this capstone would assert nothing.
  fireReceptionWorkflow,
  publicEndpointRegistryStore: h.registryStore,
  dropBlobStore: h.dropStore,
  blobStore: h.blobs,
  // D-172 P3 — the real drop file-substrate deps (the seam under test).
  inboundFileCollection: h.collection,
  attachFileDeps: { annotationDeps: { store: h.store } as AnnotationRpcDeps, registry: h.registry },
  contactStore: h.contactStore,
  // Non-drop reception handles — kind-stubs (composeReceptionSubstrate
  // tolerates them; the drop processor never touches them).
  receptionRegistryCache: { invalidate: vi.fn(), flush: vi.fn() },
  receptionRateLimiter: { snapshot: vi.fn() },
  previewHashStore: { kind: 'preview-store' },
  auditLog: { logActivity: vi.fn() },
  keys: makeKeys(),
  eventBus: { emit: vi.fn() },
  dbPath: join(h.root, 'server.db'),
  backgroundServices: { register: registerSpy, registerInterval: vi.fn() },
  approvalIntentStore: undefined,
  statusProjectionStore: { kind: 'status-projection-store' },
  ipBlockStore: { kind: 'ip-block-store' },
  // ⚠ D-210 A.8 slice 4b-ii — the scheduling drain is gated on (and reads) the
  // MERGED store now, so this stub is what keeps the reception drain registered
  schedulingFormNonceStore: { kind: 'scheduling-form-nonce-store' },
  intakeFormSubmissionStore: { kind: 'form-submission-store' },
  intakeFormNonceStore: { kind: 'intake-form-nonce-store' },
  dropLinkNonceStore: { kind: 'drop-link-nonce-store' },
  approvalLinkNonceStore: { kind: 'approval-link-nonce-store' },
});

beforeEach(() => {
  vi.clearAllMocks();
  derivationMocks.deriveReceptionPepperFromSubDek.mockReturnValue(Buffer.alloc(32, 0x21));
  derivationMocks.deriveFormSubmissionPiiKeyFromSubDek.mockReturnValue(Buffer.alloc(32, 0x23));
  derivationMocks.deriveDropBlobPiiKeyFromSubDek.mockReturnValue(Buffer.alloc(32, 0x24));
  derivationMocks.deriveApprovalIntentPiiKeyFromSubDek.mockReturnValue(Buffer.alloc(32, 0x25));
  h = makeHarness();
});
afterEach(() => {
  try { h.db.close(); } catch { /* ignore */ }
  try { rmSync(h.root, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Await the reception-drain boot sweep via the registered timer's stop hook
 *  (`registerReceptionDrain` fires `runner.tick()` at registration; `stop`
 *  awaits the in-flight tick). */
const awaitBootDrain = async (registerSpy: ReturnType<typeof vi.fn>): Promise<void> => {
  const drainReg = registerSpy.mock.calls
    .map((c) => c[0] as { name?: string; stop?: () => Promise<void> })
    .find((s) => s?.name === 'reception-drain');
  expect(drainReg).toBeDefined(); // ≥1 reception processor registered → the shared drain timer exists
  await drainReg!.stop!();
};

describe('D-172 P3 CAPSTONE — drop_link drain materializes through composeReceptionSubstrate', () => {
  it('composes the substrate → registers the drop processor → the boot drain ingests + DISPATCHES a real blob', async () => {
    const contact_id = seedContact('mary.client@example.com', 'Mary');
    registerEndpoint(contact_id);
    const { record_id, bytes } = await insertDropBlob('blob-capstone-1');

    const registerSpy = vi.fn();
    const fired: unknown[] = [];
    const bundle = await composeReceptionSubstrate(makeSubstrateDeps(registerSpy, async (d) => {
      fired.push(d);
      return { dispatched: true };
    }) as never);
    expect(bundle).toBeDefined(); // the substrate composed (drop deps present)

    await awaitBootDrain(registerSpy);

    // (i) the visitor file MATERIALIZED as a data.file.received record, bytes
    //     resolved from the CAS, server-detected MIME, reception_drop origin.
    const fileRecord = h.collection.get(record_id);
    expect(fileRecord).not.toBeNull();
    expect(fileRecord!.hot_fields.filename).toBe('signed-contract.pdf');
    expect(fileRecord!.hot_fields.mime_type).toBe('application/pdf');
    expect(fileRecord!.hot_fields.origin).toBe('reception_drop');
    expect(fileRecord!.hot_fields.content_hash).toBe(await h.blobs.put(bytes)); // same CAS hash
    expect(fileRecord!.storage_ref.kind).toBe('cas');

    // (ii) ⛔ D-210 Phase C — NO inline attach. The contact edge is written on
    //     APPROVE, through the projection's attach seam. The drain writing it
    //     here would be an ambient warehouse write on a visitor's say-so (I-1),
    //     which is exactly what retiring auto-accept removed.
    const links = await h.store.outboundLinks('contact', 'mary.client@example.com');
    const attach = links.filter(
      (l) => l.role === ATTACHMENT_LINK_ROLE && l.to_collection === 'file' && l.to_id === record_id,
    );
    expect(attach).toHaveLength(0);

    // (ii-b) instead, the blob was DISPATCHED to review-then-approve, carrying
    //        the ingested file id so the approve leg can attach it.
    expect(fired).toHaveLength(1);
    const dispatch = fired[0] as { kind: string; payload: Record<string, unknown> };
    expect(dispatch.kind).toBe('drop_link');
    expect(dispatch.payload.file_id).toBe(record_id);

    // (iii) the drop blob row flipped processed, carrying the data.file id.
    const row = h.dropStore.findById('blob-capstone-1');
    expect(row?.processing_outcome).toBe('processed');
    expect(row?.data_file_entity_id).toBe(record_id);
  });

  it('does NOT register the drop processor when the file-substrate deps are absent (the guard)', async () => {
    // Same substrate, but no inboundFileCollection / attachFileDeps → the drop
    // processor must NOT join the drain (the production gate the threading
    // relies on). D-173: the `reception-drain` timer is now SHARED across every
    // reception kind — it still registers for the OTHER processors (the
    // scheduling processor here), so the drop guard is proven by the drop blob
    // surviving the full boot drain UNTOUCHED, not by the timer's absence.
    const contact_id = seedContact('mary.client@example.com');
    registerEndpoint(contact_id);
    await insertDropBlob('blob-capstone-2');

    const registerSpy = vi.fn();
    const deps = makeSubstrateDeps(registerSpy) as Record<string, unknown>;
    delete deps.inboundFileCollection;
    delete deps.attachFileDeps;
    const bundle = await composeReceptionSubstrate(deps as never);
    expect(bundle).toBeDefined();

    // Run the boot drain to completion (the scheduling processor no-ops — there
    // are no scheduling endpoints, so it returns before touching its stub
    // store). The drop processor is absent, so the pending drop blob is never
    // ingested / attached / flipped: it stays pending with NO data.file record
    // (the substrate degraded to a drop no-op, not a crash).
    await awaitBootDrain(registerSpy);
    const row = h.dropStore.findById('blob-capstone-2');
    expect(row?.processing_outcome).toBe('pending');
    expect(row?.data_file_entity_id ?? null).toBeNull();
    expect(
      h.collection.get(inboundFileRecordId('reception_drop', 'blob-capstone-2')),
    ).toBeNull();
  });
});
