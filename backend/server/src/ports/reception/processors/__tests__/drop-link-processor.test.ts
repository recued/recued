/** D-172 P3 § A.5 / D-173 P5 § A.7 / D-210 Phase C — reception `drop_link`
 *  drain processor tests.
 *
 *  ⚠ D-210 Phase C RE-AIMED THIS SUITE. It used to lead with the AUTO-ACCEPT
 *  suite (the original D-172 P3 behavior: straight-through ingest + pre-bound
 *  contact/project attach, `on_upload.auto_accept: true` as the `baseConfig`
 *  default), with review-by-default as a separate describe. `auto_accept` is
 *  now retired on all three reception kinds (owner ruling, 2026-07-18), so the
 *  twelve auto-accept tests went with their subject — the drain never
 *  inline-attaches, and the attach happens on approve through the projection.
 *
 *  Kept from that suite: the corrupt-config failure case, which is pre-branch.
 *  Re-homed onto the review path: re-drain idempotency and revoked-endpoint
 *  enumeration, which were only ever incidental to auto-accept.
 *
 *  Exercises the real stack end-to-end: a CAS-backed drop blob (bytes in
 *  the warehouse `BlobStore`, metadata in `reception_drop_blob_metadata`,
 *  visitor PII sealed via `drop-pii.ts`) drains into a real
 *  `InboundFileCollection` + a real `AnnotationStore` (the `attachFile`
 *  link writer) + a real `ContactStore` (the pre-bound contact resolver).
 *
 *  Asserts the spec invariants:
 *    (i)   a `data.file.received` record with the right filename / mime /
 *          origin / scan_status + a CAS storage_ref;
 *    (ii)  an `attachment` link from the PRE-BOUND contact to the file;
 *    (iii) the blob row flipped `processed` with `data_file_entity_id`;
 *    (iv)  re-drain is idempotent (no dup file record / no dup link);
 *    (v)   visitor PII never enters the data.file record;
 *    (vi)  a locked vault leaves a match-gated row PENDING (not failed);
 *    (vii) `create_data_file_entity: false` → no ingest, still processed;
 *    (viii) `auto_attach_to_contact: false` → ingested, not attached;
 *    + the require_contact_email_match gate (match attaches; mismatch
 *      withholds the contact edge but still ingests + processes);
 *    + the MUTATION check: the link is anchored to the bound contact's
 *      canonical email, NOT the visitor email — attaching to the visitor
 *      email would NOT satisfy the inline `…links.attachment` surface the
 *      consumer relies on. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import type { DropLinkConfig } from '@recued/contracts';

import { createBlobStore, type BlobStore } from '../../../../storage/blob-store.js';
import {
  createAnnotationStore,
  type AnnotationStore,
} from '../../../../storage/annotation-store.js';
import type { AnnotationRpcDeps } from '../../../../annotation-handler.js';
import {
  createInboundFileCollection,
  inboundFileRecordId,
  type InboundFileCollection,
} from '../../../../collections/file/inbound-file-collection.js';
import {
  createCollectionRegistry,
  type CollectionRegistry,
} from '../../../../collections/registry.js';
import {
  attachFile,
  ATTACHMENT_LINK_ROLE,
} from '../../../../collections/file/attach-file.js';
import { ensureReceptionSchema } from '../../../../storage/reception-store.js';
import {
  createReceptionDropBlobStore,
  type DropBlobStore,
} from '../../../../storage/reception-drop-store.js';
import {
  createPublicEndpointRegistryStore,
  type PublicEndpointRegistryStore,
} from '../../../../storage/public-endpoint-registry-store.js';
import {
  createContactStore,
  type ContactStore,
} from '../../../../storage/contact-store.js';
import {
  deriveDropBlobPiiKeyFromSubDek,
  sealDropBlobPiiField,
} from '../../drop-pii.js';
import { createDropLinkSubmissionProcessor } from '../drop-link-processor.js';
import type {
  FireReceptionWorkflow,
  ReceptionWorkflowDispatch,
} from '../../reception-drain.js';

const NOW = 1_700_000_000_000;
const ENDPOINT_ID = 'ep-drop-1';
const SUB_DEK = new Uint8Array(32).fill(7);

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
  attachDeps: { annotationDeps: AnnotationRpcDeps; registry: CollectionRegistry };
}

let h: Harness;

const makeHarness = (): Harness => {
  const root = mkdtempSync(join(tmpdir(), 'd172-p3-drop-'));
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
  const gate = createStorageGate({
    quota: 100 * 1024 * 1024,
    reservePct: 10,
    surface: 'collection:file:received',
  });
  const collection = createInboundFileCollection({
    db,
    blobs,
    gate,
    bus: createWarehouseEventBus(),
    slug: 'received',
    now: () => NOW,
  });
  registry.register(collection);
  const dropStore = createReceptionDropBlobStore(db);
  const registryStore = createPublicEndpointRegistryStore(db);
  const contactStore = createContactStore(db, { now: () => NOW });
  const attachDeps = { annotationDeps: { store } as AnnotationRpcDeps, registry };
  return {
    root,
    db,
    blobs,
    store,
    registry,
    collection,
    dropStore,
    registryStore,
    contactStore,
    attachDeps,
  };
};

const baseConfig = (overrides?: {
  contact_scoping?: DropLinkConfig['contact_scoping'];
  on_upload?: Partial<DropLinkConfig['on_upload']>;
}): DropLinkConfig => ({
  display_name: 'Mary',
  link_kind: 'repeated',
  ...(overrides?.contact_scoping !== undefined
    ? { contact_scoping: overrides.contact_scoping }
    : {}),
  size_cap_bytes: 1024 * 1024,
  allowed_mime_types: ['application/pdf'],
  expiry_days: 7,
  max_uploads_per_endpoint_per_day: 50,
  required_visitor_fields: { name: 'optional', email: 'optional', description: 'optional' },
  on_upload: {
    create_data_file_entity: true,
    auto_attach_to_contact: false,
    // Default to AUTO-ACCEPT for the legacy suite below (the production default
    // is REVIEW — the P5 suite overrides this to exercise the review path).
    ...overrides?.on_upload,
  },
});

/** Register a drop_link endpoint carrying the given config (enabled). */
const registerEndpoint = (config: DropLinkConfig): void => {
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

/** Seal + insert a CAS-backed drop blob (a real PDF). Returns the blob_id
 *  + the CAS blob_hash + the deterministic data.file record_id. */
const sealDropBlob = async (opts?: {
  blob_id?: string;
  visitor_email?: string | null;
  visitor_name?: string | null;
  visitor_description?: string | null;
  scan_status?: 'unscanned' | 'pending' | 'clean' | 'flagged';
  filename?: string;
}): Promise<{ blob_id: string; blob_hash: string; record_id: string; bytes: Buffer }> => {
  const blob_id = opts?.blob_id ?? 'blob-1';
  // A minimal valid PDF (magic `%PDF-`).
  const bytes = Buffer.from(`%PDF-1.4\n%fixture-${blob_id}\n`, 'utf8');
  const blob_hash = await h.blobs.put(bytes);
  const key = deriveDropBlobPiiKeyFromSubDek(SUB_DEK);
  const seal = (field: 'visitor_email' | 'visitor_name' | 'visitor_description', plaintext: string | null | undefined) =>
    sealDropBlobPiiField({ key, endpoint_id: ENDPOINT_ID, blob_id, field, plaintext: plaintext ?? null });
  const visitor_email_encrypted = await seal('visitor_email', opts?.visitor_email);
  const visitor_name_encrypted = await seal('visitor_name', opts?.visitor_name);
  const visitor_description_encrypted = await seal('visitor_description', opts?.visitor_description);
  h.dropStore.insert({
    blob_id,
    endpoint_id: ENDPOINT_ID,
    uploaded_at: NOW,
    source_ip_hash: null,
    visitor_email_encrypted,
    visitor_name_encrypted,
    visitor_description_encrypted,
    filename_sanitized: opts?.filename ?? 'contract.pdf',
    mime_type_reported: 'application/pdf',
    mime_type_detected: 'application/pdf',
    size_bytes: bytes.length,
    content_hash: blob_hash,
    storage_path: blob_hash, // CAS hash post-A.1 sink-swap
    scan_status: opts?.scan_status ?? 'unscanned',
    processing_outcome: 'pending',
  });
  return {
    blob_id,
    blob_hash,
    record_id: inboundFileRecordId('reception_drop', blob_id),
    bytes,
  };
};

/** Seed a contact via upsertManual + return its assigned stable contact_id. */
const seedContact = (email: string, name?: string): string => {
  const rec = h.contactStore.upsertManual({ email, ...(name ? { name } : {}) }, NOW);
  // upsertManual always assigns a stable contact_id (schema backfill +
  // INSERT-time assignment); the type is `string | undefined` for the
  // forward-looking PK migration.
  if (!rec.contact_id) throw new Error('seedContact: no contact_id assigned');
  return rec.contact_id;
};

/** Build the processor with the real deps. `getDropBlobPiiKey` defaults to
 *  the real key; pass `lockedVault: true` to simulate a locked vault. */
const makeProcessor = (opts?: {
  lockedVault?: boolean;
  withContactResolver?: boolean;
  notify?: (n: unknown) => void;
  runRecipe?: (t: unknown) => void;
  fire?: FireReceptionWorkflow;
}) =>
  createDropLinkSubmissionProcessor({
    registryStore: h.registryStore,
    dropBlobStore: h.dropStore,
    getDropBlobPiiKey: () => {
      if (opts?.lockedVault) {
        throw new Error('not_configured: FileVault locked');
      }
      return deriveDropBlobPiiKeyFromSubDek(SUB_DEK);
    },
    fileIngestor: h.collection,
    attach: attachFile,
    attachDeps: h.attachDeps,
    ...(opts?.withContactResolver !== false ? { contactResolver: h.contactStore } : {}),
    now: () => NOW,
    ...(opts?.notify ? { notify: opts.notify as never } : {}),
    ...(opts?.runRecipe ? { runRecipe: opts.runRecipe as never } : {}),
    ...(opts?.fire ? { fireReceptionWorkflow: opts.fire } : {}),
  });

/** A capturing `fireReceptionWorkflow` fake — records each review dispatch +
 *  returns the configured `dispatched` flag. */
const fakeFire = (
  result: { dispatched: boolean } = { dispatched: true },
): { fn: FireReceptionWorkflow; calls: ReceptionWorkflowDispatch[] } => {
  const calls: ReceptionWorkflowDispatch[] = [];
  return {
    calls,
    fn: async (dispatch) => {
      calls.push(dispatch);
      return result;
    },
  };
};

beforeEach(() => {
  h = makeHarness();
});

afterEach(async () => {
  await h.collection.close();
  h.db.close();
  rmSync(h.root, { recursive: true, force: true });
});

describe('createDropLinkSubmissionProcessor (D-172 P3)', () => {
  it('marks a row failed on a corrupt config (never retried forever)', async () => {
    // Register the endpoint with a structurally invalid config blob (the
    // store accepts arbitrary metadata; parseDropLinkConfig returns null).
    h.registryStore.create({
      endpoint_id: ENDPOINT_ID,
      kind: 'drop_link',
      packet_declaration: {
        packet_kind: 'drop_link_packet',
        source_query_ref: { kind: 'reception_drop_config', drop_config_id: 'cfg-bad' },
      } as unknown as Parameters<PublicEndpointRegistryStore['create']>[0]['packet_declaration'],
      bearer_secret_hmac: Buffer.alloc(32, 1),
      created_at: NOW - 1000,
      created_by_client_id: 'inst-1',
      expires_at: null,
      long_lived_acknowledged_at: NOW - 1000,
      metadata: { display_name: '' } as Record<string, unknown>, // fails validation
    });
    h.registryStore.enable(ENDPOINT_ID, NOW);
    const { blob_id } = await sealDropBlob();

    const result = await makeProcessor().drainOnce({ now: NOW, limit: 50 });
    expect(result).toEqual({ processed: 0, failed: 1 });
    expect(h.dropStore.findById(blob_id)!.processing_outcome).toBe('failed');
  });

});

describe('D-173 P5 — drop review-by-default (A.7)', () => {
  /** D-210 Phase C — review is the only path; kept as a named alias so the
   *  review describe below reads intentionally. */
  const reviewConfig = (over?: Partial<DropLinkConfig['on_upload']>): DropLinkConfig =>
    baseConfig({ on_upload: { ...over } });

  it('ingests the file + dispatches a task+file_id review payload (never inline-attaches)', async () => {
    // A bound contact + auto_attach_to_contact proves the review path does NOT
    // inline-attach — the attach happens on approve, through the projection.
    const contactId = seedContact('jane@x.com');
    registerEndpoint(
      baseConfig({
        contact_scoping: { contact_id: contactId, require_contact_email_match: false },
        on_upload: { auto_attach_to_contact: true },
      }),
    );
    const { blob_id, record_id } = await sealDropBlob({
      visitor_name: 'Alex',
      visitor_description: 'Signed contract attached',
    });

    const fire = fakeFire();
    const result = await makeProcessor({ fire: fire.fn }).drainOnce({ now: NOW, limit: 50 });
    expect(result).toEqual({ processed: 1, failed: 0 });

    // The file WAS ingested (review needs the data.file record to attach later).
    expect(h.collection.get(record_id)).not.toBeNull();
    // Dispatched a task+file review payload — never inline-attached.
    expect(fire.calls).toHaveLength(1);
    const call = fire.calls[0]!;
    expect(call.kind).toBe('drop_link');
    expect(call.source_ref).toBe(blob_id);
    expect(call.endpoint_id).toBe(ENDPOINT_ID);
    expect(call.payload).toMatchObject({
      top_tier_kind: 'task',
      id: `reception_${blob_id}`,
      title: 'contract.pdf',
      file_id: record_id,
      body: 'From Alex: Signed contract attached',
    });
    expect((call.payload.metadata as Record<string, unknown>).reception_visitor_name).toBe('Alex');
    // The row flipped processed (handed off), recording the ingested file id.
    const drained = h.dropStore.findById(blob_id);
    expect(drained!.processing_outcome).toBe('processed');
    expect(drained!.data_file_entity_id).toBe(record_id);
    // NO inline contact attach — the review path defers it to the projection.
    expect(await h.store.outboundLinks('contact', 'jane@x.com')).toHaveLength(0);
  });

  it('the dispatched payload never carries the visitor email (sealed)', async () => {
    registerEndpoint(reviewConfig());
    await sealDropBlob({ visitor_email: 'leak@evil.com', visitor_description: 'hi' });
    const fire = fakeFire();
    await makeProcessor({ fire: fire.fn }).drainOnce({ now: NOW, limit: 50 });
    expect(JSON.stringify(fire.calls[0]!.payload)).not.toContain('leak@evil.com');
  });

  it('no dispatch seam → leaves the blob pending + does NOT ingest (no inline materialize, I-1)', async () => {
    registerEndpoint(reviewConfig());
    const { blob_id, record_id } = await sealDropBlob();
    // No `fire` seam.
    const result = await makeProcessor().drainOnce({ now: NOW, limit: 50 });
    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(h.dropStore.findById(blob_id)!.processing_outcome).toBe('pending');
    // Never inline-materialized the file (the review path skips ingest with no seam).
    expect(h.collection.get(record_id)).toBeNull();
  });

  it('seam reports dispatched:false → leaves the blob pending', async () => {
    registerEndpoint(reviewConfig());
    const { blob_id } = await sealDropBlob();
    const fire = fakeFire({ dispatched: false });
    const result = await makeProcessor({ fire: fire.fn }).drainOnce({ now: NOW, limit: 50 });
    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(fire.calls).toHaveLength(1);
    expect(h.dropStore.findById(blob_id)!.processing_outcome).toBe('pending');
  });

  it('re-drain is idempotent — a processed blob is not re-ingested or re-dispatched', async () => {
    // D-210 Phase C — re-homed from the deleted auto-accept suite. The drain
    // loop's idempotency never depended on what a row became, and a second
    // dispatch would put the same upload in the inbox twice.
    registerEndpoint(reviewConfig());
    const { blob_id } = await sealDropBlob();
    const fire = fakeFire();
    const first = await makeProcessor({ fire: fire.fn }).drainOnce({ now: NOW, limit: 50 });
    expect(first).toEqual({ processed: 1, failed: 0 });
    expect(fire.calls).toHaveLength(1);

    const second = await makeProcessor({ fire: fire.fn }).drainOnce({ now: NOW, limit: 50 });
    expect(second).toEqual({ processed: 0, failed: 0 });
    expect(fire.calls).toHaveLength(1);
    expect(h.dropStore.findById(blob_id)!.processing_outcome).toBe('processed');
  });

  it('enumerates REVOKED endpoints — a blob accepted while live still reaches review', async () => {
    // D-210 Phase C — re-homed from the deleted auto-accept suite. Revoking a
    // link must not strand uploads the visitor already made under it; they are
    // the owner's to review either way.
    registerEndpoint(reviewConfig());
    const { blob_id } = await sealDropBlob();
    h.registryStore.revoke({ endpoint_id: ENDPOINT_ID, now: NOW, reason: null });
    const fire = fakeFire();

    const result = await makeProcessor({ fire: fire.fn }).drainOnce({ now: NOW, limit: 50 });

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(fire.calls).toHaveLength(1);
    expect(h.dropStore.findById(blob_id)!.processing_outcome).toBe('processed');
  });

  it('a locked vault leaves a review blob pending (does not lose it)', async () => {
    registerEndpoint(reviewConfig());
    const { blob_id } = await sealDropBlob({ visitor_description: 'secret-ish' });
    const fire = fakeFire();
    const result = await makeProcessor({ fire: fire.fn, lockedVault: true }).drainOnce({ now: NOW, limit: 50 });
    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(fire.calls).toHaveLength(0);
    expect(h.dropStore.findById(blob_id)!.processing_outcome).toBe('pending');
  });
});
