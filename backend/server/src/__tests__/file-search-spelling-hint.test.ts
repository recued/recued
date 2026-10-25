/** `file.search` names the closest word on file when a term is in no file name
 *  or folder.
 *
 *  ⛔ NOT FROM THE CONTENT INDEX: this search matches a term as a substring of a
 *  file's name and path, so "absent" is asked of the search itself and a
 *  suggestion is a word in a name or folder it can return. Through the real
 *  file spaces — a received file, a watched folder on disk, a mirrored remote
 *  file — and the real resolver and handler. */

import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import { composeFileStack } from '../collections/file/compose.js';
import { createInboundFileCollection } from '../collections/file/inbound-file-collection.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createFileViewResolverFromRegistry } from '../file-view-resolver.js';
import { createBlobStore } from '../storage/blob-store.js';
import { buildFileMetaSnapshot, createFileMetaStore, ensureFileMetaSchema } from '../storage/file-meta-store.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const done of cleanups.splice(0).reverse()) await done(); });

interface FileResult {
  files: Array<{ filename: string; file_id: string }>;
  no_match_reason?: string;
  partial_term_matches?: number;
}

const world = async () => {
  const db = new Database(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'file-spelling-'));
  const bus = createWarehouseEventBus();
  const registry = createCollectionRegistry();
  const received = createInboundFileCollection({
    db, blobs: createBlobStore(join(dir, 'cas')),
    gate: createStorageGate({ quota: 10 * 1024 * 1024, reservePct: 10, surface: 'collection:file:received' }),
    bus, slug: 'received',
  });
  registry.register(received);
  const lease = await received.ingest({
    bytes: Buffer.from('lease'), filename: 'Castellanos lease.pdf', mime_type: 'application/pdf',
    origin: 'webclient_upload', source_id: 'upload-1',
  });
  // Two real names one edit apart.
  for (const filename of ['Marta notes.pdf', 'Martha plan.pdf']) {
    await received.ingest({
      bytes: Buffer.from(filename), filename, mime_type: 'application/pdf',
      origin: 'webclient_upload', source_id: `upload-${filename}`,
    });
  }
  // A watched folder, filed by client.
  const folder = join(dir, 'Clients');
  mkdirSync(join(folder, 'Okonkwo'), { recursive: true });
  writeFileSync(join(folder, 'Okonkwo', 'storage-contract.md'), 'storage');
  const stack = composeFileStack(db);
  stack.attachWatchedFolders({
    registry, bus,
    gates: { get: (slug) => createStorageGate({ quota: 1 << 26, reservePct: 1, surface: `collection:file:${slug}` }), release: () => {} },
  });
  stack.instances.upsert({
    platform: 'file', slug: 'clients', adapter_type: 'fs', config: { path: folder },
    caps: { read: 'yes', write: 'yes', delete: 'yes', watch: 'none', mirror: 'optional', auth: 'none', path_style: 'posix' },
    auth_state: 'healthy', last_synced_at: null,
  });
  await stack.startAll();
  // A mirrored remote file.
  ensureFileMetaSchema(db);
  const meta = createFileMetaStore(db);
  meta.upsert({
    scope: 'src_dropbox_1', target_id: 'id:remote-1',
    meta: buildFileMetaSnapshot({
      filename: 'allotment-renewal.pdf', path: 'Thornbury/allotment-renewal.pdf', provider: 'dropbox',
      remote_id: 'id:remote-1', mime_type: 'application/pdf', mtime: 9_000,
    }, 9_000),
    now: 9_000,
  });
  cleanups.push(async () => { await stack.disposeAll(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const resolver = createFileViewResolverFromRegistry(registry, meta);
  const handlers = buildChatTier1Handlers({
    getContactStore: () => undefined,
    getCollectionRegistry: () => registry,
    getFileViewResolver: () => resolver,
    // This conversation carries the lease as an attachment.
    getChatStore: () => ({ listMessages: async () => [{ attachments: [{ file_id: lease.record_id }] }] }),
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () => ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
    getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
    getExecuteRecipe: () => undefined,
  } as never) as Record<string, (a: unknown, c: unknown) => Promise<unknown>>;
  const ctx = { channel: 'internal_function_call', session_id: 'S', turn_id: 'T' } as never;
  return async (args: Record<string, unknown>): Promise<FileResult> =>
    ((await handlers['file.search']!({ limit: 20, ...args }, ctx)) as { result: FileResult }).result;
};

describe('file.search — a term in no file name or folder', () => {
  it('⛔ names the spelling of a received file\'s name', async () => {
    const search = await world();
    const result = await search({ query: 'Castelanos', scope: 'all' });
    expect(result.files).toEqual([]);
    expect(result.no_match_reason).toBe('No file name or folder holds "Castelanos", but "Castellanos" '
      + 'is in 1 file. If that is who or what the owner meant, search again for "Castellanos", and begin '
      + 'your answer by telling the owner you read "Castelanos" as "Castellanos": it may be a different name.');
  });

  it('reaches a watched folder\'s path and a mirrored remote file\'s folder', async () => {
    const search = await world();
    expect((await search({ query: 'Okonkow', scope: 'all' })).no_match_reason)
      .toMatch(/^No file name or folder holds "Okonkow", but "Okonkwo" is in 1 file\./u);
    expect((await search({ query: 'Thornbry', scope: 'all' })).no_match_reason)
      .toMatch(/^No file name or folder holds "Thornbry", but "Thornbury" is in 1 file\./u);
  });

  it('finds a typo at the front of a word through the word\'s end', async () => {
    const search = await world();
    expect((await search({ query: 'Csatellanos', scope: 'all' })).no_match_reason)
      .toMatch(/^No file name or folder holds "Csatellanos", but "Castellanos" is in 1 file\./u);
  });

  it('puts the spelling before the some-of-the-words note when both apply', async () => {
    const search = await world();
    const result = await search({ query: 'Castelanos lease', scope: 'all' });
    expect(result.files).toEqual([]);
    expect(result.partial_term_matches).toBe(1);
    // Exactly one correction: "lease" is on file, so it is neither checked nor "corrected".
    expect(result.no_match_reason).toBe('No file name or folder holds "Castelanos", but "Castellanos" '
      + 'is in 1 file. If that is who or what the owner meant, search again for "Castellanos", and begin '
      + 'your answer by telling the owner you read "Castelanos" as "Castellanos": it may be a different '
      + 'name. No file matches ALL of "castelanos lease", but 1 file(s) match some of those words. Search '
      + 'a single distinctive word to see them — do not report that the owner has nothing on this.');
  });

  it('says nothing when the term is on file, or when nothing is close', async () => {
    const search = await world();
    const found = await search({ query: 'Castellanos', scope: 'all' });
    expect(found.files.map((f) => f.filename)).toEqual(['Castellanos lease.pdf']);
    expect(found.no_match_reason).toBeUndefined();
    expect((await search({ query: 'Zylberstein', scope: 'all' })).no_match_reason).toBeUndefined();
  });

  it('⛔ never "corrects" a word some file name holds, though a close one is on file too', async () => {
    const search = await world();
    // No file holds both words, so the page is empty — but "Marta" is a name on file.
    const result = await search({ query: 'Marta budget', scope: 'all' });
    expect(result.files).toEqual([]);
    expect(result.no_match_reason ?? '').not.toContain('Martha');
  });

  it('works on a conversation\'s own files, the narrow default scope', async () => {
    const search = await world();
    const result = await search({ query: 'Castelanos' });
    expect(result.files).toEqual([]);
    expect(result.no_match_reason).toMatch(/^No file name or folder holds "Castelanos", but "Castellanos" is in 1 file\./u);
    // A file outside this conversation is no suggestion here.
    expect((await search({ query: 'Okonkow' })).no_match_reason).toBeUndefined();
  });
});
