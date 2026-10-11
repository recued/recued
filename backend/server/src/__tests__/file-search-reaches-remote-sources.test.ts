import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { composeFileStack } from '../collections/file/compose.js';
import { createInboundFileCollection } from '../collections/file/inbound-file-collection.js';
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
 *  path); chat simply never called it. This pins that it now does.
 *
 *  Since 2026-10-10 there is a third space: a folder Recued watches on the
 *  owner's machine (`watched-folder-collection.ts`). Until then this test's
 *  "local" file was a stand-in collection nothing in production created. */
const SCOPE = 'src_dropbox_1';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const buildWorld = async () => {
  const db = new Database(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'remote-'));
  const bus = createWarehouseEventBus();
  const registry = createCollectionRegistry();

  // A file someone sent: the received store, listable without a query.
  const received = createInboundFileCollection({
    db,
    blobs: createBlobStore(join(dir, 'cas')),
    gate: createStorageGate({ quota: 10 * 1024 * 1024, reservePct: 10, surface: 'collection:file:received' }),
    bus,
    slug: 'received',
  });
  registry.register(received);
  await received.ingest({
    bytes: Buffer.from('a brief'), filename: 'brief.pdf', mime_type: 'application/pdf',
    origin: 'webclient_upload', source_id: 'upload-1',
  });

  // A folder the owner has Recued watch, filed by client like the remote one.
  const folder = join(dir, 'Clients');
  mkdirSync(join(folder, 'Sandhurst'), { recursive: true });
  writeFileSync(join(folder, 'Sandhurst', 'kickoff-notes.md'), 'kickoff');
  const stack = composeFileStack(db);
  stack.attachWatchedFolders({
    registry,
    bus,
    gates: {
      get: (slug) => createStorageGate({ quota: 1 << 26, reservePct: 1, surface: `collection:file:${slug}` }),
      release: () => {},
    },
  });
  stack.instances.upsert({
    platform: 'file', slug: 'clients', adapter_type: 'fs', config: { path: folder },
    caps: { read: 'yes', write: 'yes', delete: 'yes', watch: 'none', mirror: 'optional', auth: 'none', path_style: 'posix' },
    auth_state: 'healthy', last_synced_at: null,
  });
  await stack.startAll();

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

  cleanups.push(async () => {
    await stack.disposeAll();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

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
  const raw = async (args: Record<string, unknown>) => {
    const h = (handlers as Record<string, (a: unknown, c: unknown) => Promise<unknown>>)['file.search'];
    return await h({ limit: 20, ...args }, ctx) as {
      result?: {
        files?: Array<{
          file_id: string; filename: string; path?: string; posture?: string; provider?: string;
          folder?: string; origin?: string; media_class?: string;
        }>;
        source_freshness?: Array<{ collection_slug: string; stale: boolean }>;
      };
    };
  };
  const search = async (args: Record<string, unknown>) => (await raw(args)).result?.files ?? [];
  return { search, raw };
};

describe('file.search reaches DECLARED REMOTE SOURCES, not just the CAS collection', () => {
  it('returns a mirrored remote file, labelled with its posture and provider', async () => {
    const { search } = await buildWorld();
    const hits = await search({ query: 'invoice 10823', scope: 'all' });
    const remote = hits.find((f) => f.filename === 'invoice-10823.pdf');
    expect(remote, 'the remote mirror must be reachable from chat at all').toBeDefined();
    expect(
      remote?.posture,
      'and be LABELLED remote — "you have it" and "Dropbox has it" are different answers',
    ).toBe('remote');
    expect(remote?.provider).toBe('dropbox');
  });

  it('MERGES the spaces for one query — the owner filed both under one folder', async () => {
    const { search } = await buildWorld();
    const names = (await search({ query: 'Sandhurst', scope: 'all' })).map((f) => f.filename);
    expect(names, 'the file in her watched folder').toContain('kickoff-notes.md');
    expect(names, 'and the remote one, from a single search').toContain('invoice-10823.pdf');
  });

  it('labels a watched folder’s file as hers, local, and names its folder', async () => {
    const { search } = await buildWorld();
    const local = (await search({ query: 'kickoff', scope: 'all' }))
      .find((f) => f.filename === 'kickoff-notes.md');
    expect(local).toMatchObject({
      path: 'Sandhurst/kickoff-notes.md',
      posture: 'local',
      folder: 'clients',
      origin: 'watched_folder',
      media_class: 'document',
    });
    expect(local?.file_id).toMatch(/^file:local:/);
    expect(local).not.toHaveProperty('provider');
  });

  it('gives the folder its own freshness verdict when its files can be in the answer', async () => {
    // Per instance, as for mail and calendar: a row from a folder is as current
    // as that folder's index, not as the received files' store.
    const { raw } = await buildWorld();
    const slugs = async (args: Record<string, unknown>) =>
      ((await raw(args)).result?.source_freshness ?? []).map((f) => f.collection_slug);
    expect(await slugs({ query: 'kickoff', scope: 'all' })).toEqual(['received', 'clients']);
    // No folder row can be in these answers, so no folder verdict either.
    expect(await slugs({ scope: 'all' })).toEqual(['received']);
    expect(await slugs({ query: 'kickoff' })).toEqual(['received']);
  });

  it('⚠ session scope is UNCHANGED — the safe default does not silently widen', async () => {
    const { search } = await buildWorld();
    // No chat store wired ⇒ session scope states its reason and returns empty.
    // The point is that it does NOT fall through to the owner-wide space.
    expect(await search({ query: 'invoice 10823' })).toHaveLength(0);
    expect(await search({ query: 'kickoff' })).toHaveLength(0);
  });

  it('⚠ a BLANK query lists files held in Recued only, and that is a substrate property', async () => {
    // `searchAll` is cross-scope but needle-driven (blank ⇒ []), and the mirror
    // has no cross-scope LIST — so "list everything" cannot span Sources today.
    // A watched folder is reached the same way, by a query. Asserted rather
    // than left to be discovered, and stated in the tool schema.
    const { search } = await buildWorld();
    const names = (await search({ scope: 'all' })).map((f) => f.filename);
    expect(names).toContain('brief.pdf');
    expect(names, 'no remote row without a needle').not.toContain('invoice-10823.pdf');
    expect(names, 'no watched-folder row without a needle').not.toContain('kickoff-notes.md');
  });
});
