import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';

import {
  buildChatIndexContext, CHAT_INDEX_TOO_COMMON_CAP, CHAT_INDEX_PROBE_ARGS,
} from '../chat-index-context.js';
import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createFileCollection } from '../collections/file/file-collection.js';
import { createBlobStore } from '../storage/blob-store.js';
import {
  createFileMetaStore, buildFileMetaSnapshot, ensureFileMetaSchema,
} from '../storage/file-meta-store.js';
import { createFileViewResolverFromRegistry } from '../file-view-resolver.js';

/** ⛔ THE COMBINATION SPACE IS CHEAP AND THE LIVE MODEL IS NOT, so this exhausts
 *  it here and spends no run on what a seed can already answer. Owner's framing,
 *  and it is the right order: a live drive should buy only what the substrate
 *  CANNOT — model behaviour — never facts a fixture already fixes.
 *
 *  Two postures, four files, one folder shared across both:
 *
 *    L1  local   Sandhurst/kickoff-notes.md
 *    L2  local   renewal-notice-83-days.pdf        (root — no folder)
 *    R1  remote  Sandhurst/invoice-10823.pdf       (D-192 dropbox mirror)
 *    R2  remote  Northwind/invoice-99001.pdf       (the cross-folder decoy)
 */
const world = () => {
  const db = new Database(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'fmx-'));
  ensureFileMetaSchema(db);
  const files = createFileCollection({
    db, blobs: createBlobStore(dir),
    gate: { addUsed: () => {}, getUsed: () => 0 } as never,
    bus: createWarehouseEventBus(), slug: 'received',
    config: () => ({ path: dir, quota_bytes: 1 << 26 }),
  } as never);
  const put = (id: string, filename: string, path: string): void => {
    files.upsert({
      record_id: id, hot_fields: { filename, path, size: 10 },
      received_at: 5, modified_at: 5, body_inline: '', size_bytes: 10,
      source_id: 'received',
    } as never);
  };
  put('file:L1', 'kickoff-notes.md', 'Sandhurst/kickoff-notes.md');
  put('file:L2', 'renewal-notice-83-days.pdf', 'renewal-notice-83-days.pdf');

  const meta = createFileMetaStore(db);
  const mirror = (tid: string, filename: string, path: string): void => {
    meta.upsert({
      scope: 'src_dropbox', target_id: tid,
      meta: buildFileMetaSnapshot({
        filename, path, provider: 'dropbox', remote_id: tid,
        mime_type: 'application/pdf', mtime: 9000,
      }, 9000),
      now: 9000,
    });
  };
  mirror('id:R1', 'invoice-10823.pdf', 'Sandhurst/invoice-10823.pdf');
  mirror('id:R2', 'invoice-99001.pdf', 'Northwind/invoice-99001.pdf');

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
  const call = (name: string) =>
    (handlers as Record<string, (a: unknown, c: unknown) => Promise<unknown>>)[name];

  const raw = async (query: string) => await call('file.search')(
    { query, limit: 20, scope: 'all' }, ctx,
  ) as { result?: { files?: unknown[]; partial_term_matches?: number; no_match_reason?: string } };
  const hits = async (query: string): Promise<string[]> => {
    const r = await call('file.search')({ query, limit: 20, scope: 'all' }, ctx) as
      { result?: { files?: Array<{ file_id: string; posture?: string }> } };
    return (r.result?.files ?? []).map((f) => (f.posture === 'remote' ? 'REMOTE' : 'LOCAL'));
  };
  const line = async (message: string): Promise<string> => {
    const probe = async (store: string, term: string, pc: never) => {
      const fn = call(store);
      if (fn === undefined) return { ok: false, reason: 'not_implemented' } as never;
      return fn({
        query: term, limit: CHAT_INDEX_TOO_COMMON_CAP + 1,
        ...(CHAT_INDEX_PROBE_ARGS[store] ?? {}),
      }, pc) as never;
    };
    return String(await buildChatIndexContext(message, ctx, probe as never) ?? '');
  };
  return { db, hits, line, raw };
};

describe('the file combination matrix, exhausted without a live model', () => {
  it('finds a term wherever it lives — folder, leaf name, either posture', async () => {
    const { db, hits } = world();
    try {
      expect(await hits('kickoff'), 'local leaf name').toEqual(['LOCAL']);
      expect(await hits('10823'), 'remote leaf name').toEqual(['REMOTE']);
      // `sandhurst` is a FOLDER shared by one local and one remote file — the
      // merge across both spaces in a single answer.
      expect((await hits('sandhurst')).sort()).toEqual(['LOCAL', 'REMOTE']);
      expect(await hits('nothinghere')).toEqual([]);
    } finally { db.close(); }
  });

  it('ANDs across folder and leaf, and across the posture boundary', async () => {
    const { db, hits } = world();
    try {
      // folder(remote) + leaf(remote) — the owner's filing pattern.
      expect(await hits('sandhurst invoice')).toEqual(['REMOTE']);
      expect(await hits('northwind invoice')).toEqual(['REMOTE']);
      expect(await hits('kickoff notes')).toEqual(['LOCAL']);
      // ⛔ THE CONTROLS THAT MATTER: terms that live in DIFFERENT files must not
      // match, or the AND has quietly become an OR across the merged space.
      expect(await hits('sandhurst renewal'), 'L1 folder + L2 leaf').toEqual([]);
      expect(await hits('northwind kickoff'), 'R2 folder + L1 leaf').toEqual([]);
      expect(await hits('sandhurst 99001'), 'L1/R1 folder + R2 leaf').toEqual([]);
    } finally { db.close(); }
  });

  it('COLLAPSES the index line only when one file holds every term', async () => {
    // 🔑 THIS IS THE DISTINCTION THE `'terms'` AND-MODE BUYS. While `file.search`
    // was `'none'` it was never asked the co-occurrence question, so the line
    // could only ever render the separate form — and a reader could not tell
    // "one file has both" from "two files each have one".
    const { db, line } = world();
    try {
      // Co-occurring ⇒ ONE entry naming the phrase.
      for (const q of ['sandhurst invoice', 'kickoff notes', 'renewal notice']) {
        expect(await line(q), `${q} co-occurs in one file`).toBe(`${q}: file.search`);
      }
      // NOT co-occurring ⇒ separate entries. Each word IS in the store, so
      // naming it per-term is honest; what must not happen is a collapsed entry
      // claiming one file holds the whole phrase.
      for (const q of ['sandhurst renewal', 'northwind kickoff']) {
        const rendered = await line(q);
        expect(rendered, `${q} must NOT collapse`).not.toBe(`${q}: file.search`);
        expect(rendered, `${q} still names the store per term`).toContain('file.search');
        expect(rendered.split(';').length, `${q} renders as separate entries`).toBeGreaterThan(1);
      }
    } finally { db.close(); }
  });

  it('says nothing when the store holds nothing — no fail-open line', async () => {
    const { db, line } = world();
    try {
      expect(await line('nothinghere at all'), 'no hit anywhere ⇒ no line').toBe('');
    } finally { db.close(); }
  });
});

describe('an empty file page NAMES ITS CAUSE', () => {
  it('discloses a partial-term count instead of a flat absence', async () => {
    // ⛔⛔ MEASURED AGAINST A LIVE MODEL, 7 RUNS OUT OF 7. The index line read
    // `renewal: file.search; sandhurst: file.search` — two entries, two
    // DIFFERENT files. The model asked `file.search("Sandhurst renewal")`,
    // matched nothing (correctly — no one file is both), and reported "no
    // Sandhurst renewal document" WITHOUT ever surfacing the two plainly
    // relevant files. Not one run invented the intersection, which was the risk
    // worth checking; every run hid the parts.
    //
    // ⚠ A DISCLOSURE, NOT PARTIAL RESULTS: a COUNT, and none of the rows.
    // Handing the weak rows over is the `RECUED_PARTIAL_SLOTS` widening, which
    // was measured on the FTS stores to have a structural ceiling and ships OFF.
    // A partial row presented as a hit is worse than a stated absence; a stated
    // absence WITH its cause is better than either.
    const { db, raw } = world();
    try {
      const r = await raw('Sandhurst renewal');
      expect(r.result?.files ?? [], 'no single file is both — that stays true').toHaveLength(0);
      // L1 and R1 both sit under `Sandhurst/`, L2 carries `renewal` in its
      // name — THREE, across both postures. ⚠ I first wrote 2 here, from the
      // bench fixture's two files rather than this world's four; the count is
      // the union over terms, and it spans the CAS and remote spaces.
      expect(r.result?.partial_term_matches, 'L1 + R1 by folder, L2 by name').toBe(3);
      expect(r.result?.no_match_reason ?? '').toContain('match some of those words');
      expect(
        r.result?.no_match_reason ?? '',
        'and it must steer, not just describe',
      ).toContain('do not report');
    } finally { db.close(); }
  });

  it('stays SILENT when the absence is genuine — no misleading hint', async () => {
    // The control. A disclosure that fires on every empty page teaches the model
    // to doubt every absence, which is the opposite of the point.
    const { db, raw } = world();
    try {
      const none = await raw('totally unrelated words');
      expect(none.result?.files ?? []).toHaveLength(0);
      expect(none.result?.partial_term_matches ?? 0, 'nothing matched any term').toBe(0);
      expect(none.result?.no_match_reason, 'so there is nothing to disclose').toBeUndefined();
      // And a query that DID match must not carry it either.
      const hit = await raw('sandhurst');
      expect((hit.result?.files ?? []).length).toBeGreaterThan(0);
      expect(hit.result?.no_match_reason).toBeUndefined();
    } finally { db.close(); }
  });
});
