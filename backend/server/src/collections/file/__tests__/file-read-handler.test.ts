import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import {
  createCommitStore,
  createInMemoryCollection,
  type AuditLogStore,
} from '@recued/storage';
import { createKernelAdapter } from '@recued/ingredients';
import {
  PreflightDeniedError,
  wrapWithCommitGateway,
  type CommitRunIdentity,
  type GatewayInner,
} from '@recued/gateway';
import type { AdmissionDecision, Commit, ExecutionSource } from '@recued/contracts';

import { createBlobStore, type BlobStore } from '../../../storage/blob-store.js';
import { createCollectionRegistry, type CollectionRegistry } from '../../registry.js';
import {
  createInboundFileCollection,
  type InboundFileCollection,
} from '../inbound-file-collection.js';
import {
  DATA_FILE_READ_INGREDIENT_SLUG,
  handleFileRead,
  type FileReadResponse,
} from '../file-read-handler.js';
import type { RemoteFileByteResolver, RemoteFileReadDeps } from '../remote-file-byte-resolver.js';
import { remoteFileRecordId } from '../../../file-view-resolver.js';
import type { FileMetaProjection } from '@recued/contracts';
import type { FileMetaRow, FileMetaStore } from '../../../storage/file-meta-store.js';
import type { FileConnectionCredential, FileConnectionResolver } from '../../../file-source-adapters/index.js';
import { createReviewedFileAccess, describeFileContent } from '../file-snapshot.js';

const sha256 = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

const source = (): ExecutionSource => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
});

const identity = (): CommitRunIdentity => ({
  request_id: 'request-1',
  source: source(),
  channel_session_id: 'chat:chat-1',
  correlation_id: 'corr-1',
  dispatch_depth: 0,
});

const fakeAudit = (): AuditLogStore & { calls: Array<unknown> } => {
  const calls: Array<unknown> = [];
  return {
    logActivity: async (input: unknown) => {
      calls.push(input);
      return undefined;
    },
    listActivity: async () => [],
    listAgentAccess: async () => [],
    listProvenanceLinks: async () => [],
    timeline: async () => [],
    bumpInsightSnapshotIfDifferent: async () => null,
    queryRecipeInsight: async () => null,
    calls,
  } as unknown as AuditLogStore & { calls: Array<unknown> };
};

interface Harness {
  root: string;
  db: Database.Database;
  blobs: BlobStore;
  registry: CollectionRegistry;
  collection: InboundFileCollection;
  audit: AuditLogStore & { calls: Array<unknown> };
}

let h: Harness;

const makeHarness = (): Harness => {
  const root = mkdtempSync(join(tmpdir(), 'd172-file-read-'));
  const db = new Database(':memory:');
  const blobs = createBlobStore(join(root, 'blobs'));
  const gate = createStorageGate({
    quota: 100 * 1024 * 1024,
    reservePct: 10,
    surface: 'collection:file:received',
  });
  const registry = createCollectionRegistry();
  const collection = createInboundFileCollection({
    db,
    blobs,
    gate,
    bus: createWarehouseEventBus(),
    slug: 'received',
    now: () => 1_000,
  });
  registry.register(collection);
  return { root, db, blobs, registry, collection, audit: fakeAudit() };
};

beforeEach(() => {
  h = makeHarness();
});

afterEach(async () => {
  await h.collection.close();
  h.db.close();
  rmSync(h.root, { recursive: true, force: true });
});

const ingestPdf = async () => {
  const bytes = Buffer.from('%PDF-1.7\nfile content');
  const record = await h.collection.ingest({
    bytes,
    filename: 'contract.pdf',
    mime_type: 'application/pdf',
    origin: 'reception_drop',
    source_id: 'drop-1',
    now: 1_111,
  });
  return { bytes, record };
};

const makeGateway = (
  decision: AdmissionDecision,
  handler: (input: { record_id: string }) => Promise<FileReadResponse>,
) => {
  const commitStore = createCommitStore(createInMemoryCollection<Commit>());
  const adapter = createKernelAdapter({
    dataFileRead: handler,
  });
  const inner: GatewayInner = async (slug, input) =>
    adapter({
      slug,
      risk_tier: 'read',
      input,
      output: {},
    });
  const executor = wrapWithCommitGateway(inner, {
    commitStore,
    identity: identity(),
    getIngredientCategory: () => 'data',
    evaluateAdmission: () => decision,
    genCommitId: () => 'commit-1',
    genIdempotencyKey: () => 'idem-1',
    now: (() => {
      const values = [2_000, 2_100];
      return () => values.shift() ?? 2_100;
    })(),
  });
  return { executor, commitStore };
};

describe('file.read content handler', () => {
  it.each([false, true])('leases reviewed bytes independently of a deleted source and releases on read failure=%s', async fail => {
    const { bytes, record } = await ingestPdf();
    const snapshot = describeFileContent(record)!;
    h.collection.delete(record.record_id);
    expect(h.collection.get(record.record_id)).toBeNull();
    const read = h.blobs.get.bind(h.blobs);
    vi.spyOn(h.blobs, 'get').mockImplementation(async blobHash => {
      expect(h.db.prepare('SELECT source_id, blob_hash FROM collection_file_attachment_leases').all())
        .toEqual([{ source_id: record.record_id, blob_hash: snapshot.blob_hash }]);
      if (fail) throw new Error('fixture read failure');
      return read(blobHash);
    });
    const validate = vi.fn(async () => {});
    const access = createReviewedFileAccess(snapshot, validate);
    const pending = handleFileRead({ registry: h.registry, blobs: h.blobs }, { record_id: record.record_id }, access);
    if (fail) await expect(pending).rejects.toThrow('fixture read failure');
    else await expect(pending).resolves.toMatchObject({ bytes_b64: bytes.toString('base64'), blob_hash: snapshot.blob_hash });
    expect(validate).toHaveBeenCalledTimes(fail ? 1 : 2);
    expect(h.db.prepare('SELECT * FROM collection_file_attachment_leases').all()).toEqual([]);
    await expect(handleFileRead({ registry: h.registry, blobs: h.blobs }, { record_id: record.record_id }))
      .rejects.toMatchObject({ code: 'file_not_found' });
  });

  it('rejects a fabricated reviewed snapshot before leasing or reading bytes', async () => {
    const { record } = await ingestPdf();
    const read = vi.spyOn(h.blobs, 'get');
    await expect(handleFileRead({ registry: h.registry, blobs: h.blobs }, { record_id: record.record_id }, {}))
      .rejects.toMatchObject({ code: 'preapproval_stale' });
    expect(read).not.toHaveBeenCalled();
    expect(h.db.prepare('SELECT * FROM collection_file_attachment_leases').all()).toEqual([]);
  });

  it('protects the library deletion boundary while reading a reviewed attachment version', async () => {
    const { bytes, record } = await ingestPdf();
    const lifecycle = h.collection.attachmentLifecycle;
    if (!lifecycle) throw new Error('The received-file fixture must provide attachment lifecycle support.');
    const prepared = lifecycle.prepare([{ file_id: record.record_id, media_class: 'document' }]);
    lifecycle.bind('message', 'retained-message', 'retained-session', prepared);
    const versionId = prepared.files[0]!.attachment.file_id;
    const snapshot = describeFileContent(h.collection.get(versionId)!)!;
    const read = h.blobs.get.bind(h.blobs);
    vi.spyOn(h.blobs, 'get').mockImplementation(async blobHash => {
      const impact = lifecycle.preview(record.record_id);
      expect(impact.in_use).toBe(true);
      expect(() => lifecycle.mutate(record.record_id, 'delete', impact.revision, id => h.collection.delete(id)))
        .toThrow('currently in use');
      return read(blobHash);
    });
    await expect(handleFileRead({ registry: h.registry, blobs: h.blobs }, { record_id: versionId },
      createReviewedFileAccess(snapshot, async () => {})))
      .resolves.toMatchObject({ bytes_b64: bytes.toString('base64') });
    expect(lifecycle.preview(record.record_id).in_use).toBe(false);
  });

  it('materializes CAS bytes and audits the content read', async () => {
    const { bytes, record } = await ingestPdf();

    const result = await handleFileRead(
      {
        registry: h.registry,
        blobs: h.blobs,
        auditLog: h.audit,
        now: () => 2_222,
      },
      { record_id: record.record_id },
    );

    expect(result).toEqual({
      record_id: record.record_id,
      bytes_b64: bytes.toString('base64'),
      mime_type: 'application/pdf',
      filename: 'contract.pdf',
      size_bytes: bytes.length,
      blob_hash: sha256(bytes),
    });
    expect(h.audit.calls).toHaveLength(1);
    expect(h.audit.calls[0]).toMatchObject({
      timestamp: 2_222,
      action: 'file_content_read',
      target: record.record_id,
    });
  });

  it('returns a typed not-found error for missing records', async () => {
    await expect(
      handleFileRead(
        { registry: h.registry, blobs: h.blobs },
        { record_id: 'file:missing' },
      ),
    ).rejects.toMatchObject({
      code: 'file_not_found',
      status: 404,
    });
  });

  it('rejects CAS bytes that no longer match the record content address', async () => {
    const { record } = await ingestPdf();
    const corruptBlobs: BlobStore = {
      ...h.blobs,
      get: async () => Buffer.from('different bytes'),
    };

    await expect(handleFileRead(
      { registry: h.registry, blobs: corruptBlobs },
      { record_id: record.record_id },
    )).rejects.toMatchObject({
      code: 'file_blob_hash_mismatch',
      status: 500,
    });
  });
});

// ── D-192 remote byte-fetch branch (Slice 2) ─────────────────────
const REMOTE_SCOPE = 'notion.myconn.file';
const remoteId = remoteFileRecordId(REMOTE_SCOPE, 'block-1');
const remoteMeta = (over: Partial<FileMetaProjection> = {}): FileMetaProjection => ({
  filename: 'mirrored.pdf', provider: 'notion', remote_id: 'block-1', ...over,
});
const remoteRow = (m: FileMetaProjection): FileMetaRow => ({
  scope: REMOTE_SCOPE, target_id: 'block-1', meta: { ...m, snapshot_hash: 'h', snapshot_at: 1 },
});
const metaStoreWith = (row: FileMetaRow): FileMetaStore =>
  ({ get: (scope: string, target: string) => (row.scope === scope && row.target_id === target ? row : null) }) as unknown as FileMetaStore;
const cred: FileConnectionCredential = { auth: { type: 'bearer', token: 't' } as never, config: {} };
const resolveConnection: FileConnectionResolver = async () => cred;
const remoteDeps = (resolver: RemoteFileByteResolver, m: FileMetaProjection = remoteMeta()): RemoteFileReadDeps => ({
  fileMetaStore: metaStoreWith(remoteRow(m)),
  resolveConnection,
  byteResolvers: { notion: resolver },
});

describe('file.read remote byte-fetch branch (D-192)', () => {
  it('a file:remote:* id with NO remote dep wired → file_remote_unsupported (501), the pre-byte-fetch posture', async () => {
    await expect(
      handleFileRead({ registry: h.registry, blobs: h.blobs }, { record_id: remoteId }),
    ).rejects.toMatchObject({ code: 'file_remote_unsupported', status: 501 });
  });

  it('a file:remote:* id WITH a wired resolver → fetches bytes lazily, returns them + audits posture:remote', async () => {
    const resolver: RemoteFileByteResolver = async () => ({ bytes: Buffer.from('remote-bytes'), mime_type: 'application/pdf' });
    const result = await handleFileRead(
      { registry: h.registry, blobs: h.blobs, auditLog: h.audit, now: () => 3_333, remote: remoteDeps(resolver, remoteMeta({ filename: 'q3.pdf' })) },
      { record_id: remoteId },
    );
    expect(result).toEqual({
      record_id: remoteId,
      bytes_b64: Buffer.from('remote-bytes').toString('base64'),
      mime_type: 'application/pdf',
      filename: 'q3.pdf',
      size_bytes: 'remote-bytes'.length,
      blob_hash: '', // uncached stream-through — no CAS blob backs a remote read
    });
    expect(h.audit.calls).toHaveLength(1);
    expect(h.audit.calls[0]).toMatchObject({
      timestamp: 3_333, action: 'file_content_read', target: remoteId,
      detail: JSON.stringify({ collection: 'file_meta_ref', posture: 'remote', mime_type: 'application/pdf', size_bytes: 12 }),
    });
  });

  it('a resolver failure surfaces as a typed error (remote_fetch_failed), never CAS-404', async () => {
    const boom: RemoteFileByteResolver = async () => { throw new Error('vendor 500'); };
    await expect(
      handleFileRead(
        { registry: h.registry, blobs: h.blobs, remote: remoteDeps(boom) },
        { record_id: remoteId },
      ),
    ).rejects.toMatchObject({ code: 'remote_fetch_failed' });
  });

  it('a CAS id still routes to the CAS path even when a remote dep is wired (id-space disjoint)', async () => {
    const { bytes, record } = await ingestPdf();
    const neverCalled: RemoteFileByteResolver = async () => { throw new Error('must not run for a CAS id'); };
    const result = await handleFileRead(
      { registry: h.registry, blobs: h.blobs, auditLog: h.audit, remote: remoteDeps(neverCalled) },
      { record_id: record.record_id },
    );
    expect(result.bytes_b64).toBe(bytes.toString('base64'));
    expect(result.blob_hash).toBe(sha256(bytes));
  });
});

describe('file.read Gateway boundary', () => {
  it('denies before the handler can read bytes or audit content', async () => {
    const { record } = await ingestPdf();
    let called = false;
    const { executor, commitStore } = makeGateway(
      {
        verdict: 'deny',
        code: 'op_risk_denied',
        detail: 'mcp contracted user cannot read file content',
      },
      async (input) => {
        called = true;
        return handleFileRead(
          { registry: h.registry, blobs: h.blobs, auditLog: h.audit },
          input,
        );
      },
    );

    await expect(
      executor(DATA_FILE_READ_INGREDIENT_SLUG, { record_id: record.record_id }),
    ).rejects.toBeInstanceOf(PreflightDeniedError);
    expect(called).toBe(false);
    expect(h.audit.calls).toHaveLength(0);
    await expect(commitStore.size()).resolves.toBe(0);
  });

  it('allows through the Gateway and records both commit and D-120 audit rows', async () => {
    const { bytes, record } = await ingestPdf();
    const { executor, commitStore } = makeGateway(
      { verdict: 'admit' },
      (input) =>
        handleFileRead(
          {
            registry: h.registry,
            blobs: h.blobs,
            auditLog: h.audit,
            now: () => 2_050,
          },
          input,
        ),
    );

    const result = await executor(DATA_FILE_READ_INGREDIENT_SLUG, {
      record_id: record.record_id,
    }) as { bytes_b64: string };
    expect(result.bytes_b64).toBe(bytes.toString('base64'));
    const commits = await commitStore.listByCorrelation('corr-1');
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      commit_id: 'commit-1',
      status: 'succeeded',
      ingredient: DATA_FILE_READ_INGREDIENT_SLUG,
      tool: DATA_FILE_READ_INGREDIENT_SLUG,
    });
    expect(h.audit.calls).toHaveLength(1);
    expect(h.audit.calls[0]).toMatchObject({
      timestamp: 2_050,
      action: 'file_content_read',
      target: record.record_id,
    });
  });
});
