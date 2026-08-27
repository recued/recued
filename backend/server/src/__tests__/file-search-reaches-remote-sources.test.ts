import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';

import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createFileCollection } from '../collections/file/file-collection.js';
import { createBlobStore } from '../storage/blob-store.js';
import {
  createFileMetaStore, buildFileMetaSnapshot, ensureFileMetaSchema,
} from '../storage/file-meta-store.js';
import { createFileViewResolverFromRegistry } from '../file-view-resolver.js';

/** ⛔⛔ `file.search` READ ONE COLLECTION AND SAW NO REMOTE SOURCE AT ALL.
 *  It resolved `registry.get('file', 'received')` directly — alone among the
 *  search tools, where `mail` and `calendar` both fan out across their platform
 *  — and D-192 remote files live in `file_meta_ref`, which is not a collection,
 *  so no amount of fan-out would have reached them either.
 *
 *  The unified `FileViewResolver` that merges both spaces already existed and
 *  was composed in production twice (the timeline loader and the ingress rpc
 *  path); chat simply never called it. This pins that it now does. */
const SCOPE = 'src_dropbox_1';

const buildWorld = () => {
  const db = new Database(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'remote-'));
  const files = createFileCollection({
    db, blobs: createBlobStore(dir),
    gate: { addUsed: () => {}, getUsed: () => 0 } as never,
    bus: createWarehouseEventBus(), slug: 'received',
    config: () => ({ path: dir, quota_bytes: 1 << 26 }),
  } as never);
  // A LOCAL file, so the merge is exercised rather than a remote-only read.
  files.upsert({
    record_id: 'file:local0',
    hot_fields: {
      filename: 'kickoff-notes.md', path: 'Sandhurst/kickoff-notes.md', size: 10,
    },
    received_at: 5, modified_at: 5, body_inline: '', size_bytes: 10, source_id: 'received',
  } as never);

  // ⚠ The factory only prepares statements — the schema is explicit.
  ensureFileMetaSchema(db);
  const meta = createFileMetaStore(db);
  meta.upsert({
    scope: SCOPE,
    target_id: 'id:remote-1',
    meta: buildFileMetaSnapshot({
      filename: 'invoice-10823.pdf',
      path: 'Sandhurst/invoice-10823.pdf',
      provider: 'dropbox',
      remote_id: 'id:remote-1',
      mime_type: 'application/pdf',
      mtime: 9_000,
    }, 9_000),
    now: 9_000,
  });

  const registry = createCollectionRegistry();
  registry.register(files as never);
  const resolver = createFileViewResolverFromRegistry(registry, meta);
  const handlers = buildChatTier1Handlers({
    getContactStore: () => undefined,
    getCollectionRegistry: () => registry,
    getFileViewResolver: () => resolver,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () => ({
      ids: () => [], get: () => null, getStored: () => null, listStored: () => [],
    }) as never,
    getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
    getExecuteRecipe: () => undefined,
  } as never);
  const ctx = { channel: 'internal_function_call', session_id: 'S', turn_id: 'T' } as never;
  const search = async (args: Record<string, unknown>) => {
    const h = (handlers as Record<string, (a: unknown, c: unknown) => Promise<unknown>>)['file.search'];
    const r = await h({ limit: 20, ...args }, ctx) as {
      result?: { files?: Array<{ file_id: string; filename: string; posture?: string; provider?: string }> };
    };
    return r.result?.files ?? [];
  };
  return { db, search };
};

describe('file.search reaches DECLARED REMOTE SOURCES, not just the CAS collection', () => {
  it('returns a mirrored remote file, labelled with its posture and provider', async () => {
    const { db, search } = buildWorld();
    try {
      const hits = await search({ query: 'invoice 10823', scope: 'all' });
      const remote = hits.find((f) => f.filename === 'invoice-10823.pdf');
      expect(remote, 'the remote mirror must be reachable from chat at all').toBeDefined();
      expect(
        remote?.posture,
        'and be LABELLED remote — "you have it" and "Dropbox has it" are different answers',
      ).toBe('remote');
      expect(remote?.provider).toBe('dropbox');
    } finally { db.close(); }
  });

  it('MERGES the two spaces for one query — the owner filed both under one folder', async () => {
    const { db, search } = buildWorld();
    try {
      const names = (await search({ query: 'Sandhurst', scope: 'all' })).map((f) => f.filename);
      expect(names, 'the local file').toContain('kickoff-notes.md');
      expect(names, 'and the remote one, from a single search').toContain('invoice-10823.pdf');
    } finally { db.close(); }
  });

  it('⚠ session scope is UNCHANGED — the safe default does not silently widen', async () => {
    const { db, search } = buildWorld();
    try {
      // No chat store wired ⇒ session scope states its reason and returns empty.
      // The point is that it does NOT fall through to the owner-wide space.
      expect(await search({ query: 'invoice 10823' })).toHaveLength(0);
    } finally { db.close(); }
  });

  it('⚠ a BLANK query lists LOCAL files only, and that is a substrate property', async () => {
    // `searchAll` is cross-scope but needle-driven (blank ⇒ []), and the mirror
    // has no cross-scope LIST — so "list everything" cannot span Sources today.
    // Asserted rather than left to be discovered, and stated in the tool schema.
    const { db, search } = buildWorld();
    try {
      const names = (await search({ scope: 'all' })).map((f) => f.filename);
      expect(names).toContain('kickoff-notes.md');
      expect(names, 'no remote row without a needle').not.toContain('invoice-10823.pdf');
    } finally { db.close(); }
  });
});
