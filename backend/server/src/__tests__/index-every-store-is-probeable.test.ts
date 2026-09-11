import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';

import {
  CHAT_INDEX_STORES,
  chatIndexProbeTool,
  chatIndexProbeLabel,
  CHAT_INDEX_PROBE_ARGS,
  CHAT_INDEX_TOO_COMMON_CAP,
} from '../chat-index-context.js';
import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createMailCollection } from '../collections/mail/mail-collection.js';
import { createFileCollection } from '../collections/file/file-collection.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createContactStore } from '../storage/contact-store.js';
import { scoreFileNeedle } from '../file-view-resolver.js';

/** ⛔⛔ A STORE CAN BE LISTED IN `CHAT_INDEX_STORES` AND ANSWER NOTHING, FOREVER,
 *  WITH NOTHING RED. That is not hypothetical — `file.search` shipped that way.
 *  It defaults to `scope: 'session'` (files attached to THIS conversation) and
 *  the probe sent only `{query, limit}`, so it returned
 *  `files: [], hint: "no conversation files are readable here"` for every term
 *  on every turn. It was in the list, so it read as covered.
 *
 *  🔑 AND THAT IS THE FEATURE'S OWN WORST FAILURE MODE. An INCOMPLETE index is
 *  worse than none: naming a subset makes the unnamed read as ABSENT, measured
 *  at 16/23 -> 0/10 for a store the line could not name. So "is every listed
 *  store actually reachable?" is a ratchet, not a nicety.
 *
 *  ⚠ Covers the REGISTRY-backed stores here. `recall.search` and `memory.search`
 *  need their own stores and are exercised by `recall-neighbours` and
 *  `d-198-memory-search-recall`; `contact.search` needs a ContactStore. Extend
 *  this file rather than trusting the list when one of those changes shape. */
const REGISTRY_BACKED = ['mail.search', 'file.search'] as const;

describe('every probed store can actually answer a probe', () => {
  it('names each registry-backed store for a term it holds', async () => {
    const db = new Database(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'probeable-'));
    try {
      const blobs = createBlobStore(dir);
      const gate = { addUsed: () => {}, getUsed: () => 0 } as never;
      const bus = createWarehouseEventBus();

      const mail = createMailCollection({
        db, blobs, gate, bus, slug: 'inbox',
        provider: { start: async () => {}, stop: async () => {} } as never,
        config: () => ({ backfill_days: 3650, retention_days: 3650, quota_bytes: 1 << 26 }),
      });
      mail.upsert({
        record_id: 'mail:z0',
        hot_fields: {
          subject: 'Zephyrine renewal terms', from: 'a@e.com', to: ['b@e.com'],
          cc: [], thread_id: 'T',
        },
        received_at: 1, modified_at: 1,
        body_inline: 'agreed at 83 days', size_bytes: 20, source_id: 'inbox',
      } as never);

      const files = createFileCollection({
        db, blobs, gate, bus, slug: 'received',
        config: () => ({ path: dir, quota_bytes: 1 << 26 }),
      } as never);
      files.upsert({
        record_id: 'file:z0',
        hot_fields: {
          filename: 'Zephyrine-renewal-terms.pdf', path: `${dir}/Zephyrine-renewal-terms.pdf`,
          mtime: 1, size_bytes: 10,
        },
        received_at: 1, modified_at: 1, body_inline: '', size_bytes: 10, source_id: 'received',
      } as never);

      const registry = createCollectionRegistry();
      registry.register(mail as never);
      registry.register(files as never);
      const handlers = buildChatTier1Handlers({
        getContactStore: () => undefined,
        getCollectionRegistry: () => registry,
        getAuditLog: () => undefined,
        getEnrichmentStore: () => undefined,
        getRecipeStore: () => ({
          ids: () => [], get: () => null, getStored: () => null, listStored: () => [],
        }) as never,
        getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
        getExecuteRecipe: () => undefined,
      } as never);
      const ctx = {
        channel: 'internal_function_call', session_id: 'S', turn_id: 'T',
      } as never;

      for (const store of REGISTRY_BACKED) {
        const entry = CHAT_INDEX_STORES.find(([s]) => s === store);
        expect(entry, `${store} must still be a probed store`).toBeDefined();
        const hitField = entry![1];
        const h = (handlers as Record<string, (a: unknown, c: unknown) => Promise<unknown>>)[store];
        expect(h, `${store} must have a handler`).toBeTypeOf('function');
        // EXACTLY the shape the composition root probes with, probe args included.
        const res = await h(
          {
            query: 'zephyrine',
            limit: CHAT_INDEX_TOO_COMMON_CAP + 1,
            ...(CHAT_INDEX_PROBE_ARGS[store] ?? {}),
          },
          ctx,
        ) as { ok: boolean; result?: Record<string, unknown> };
        const hits = res.result?.[hitField];
        expect(
          Array.isArray(hits) && hits.length > 0,
          `${store} holds the term and MUST answer the probe — a listed store `
          + `that answers nothing makes the index name a subset, which is worse `
          + `than no index at all. Got: ${JSON.stringify(res).slice(0, 200)}`,
        ).toBe(true);
      }
    } finally { db.close(); }
  });

  it('file.search specifically needs its probe arg — without it the answer is invisible', async () => {
    // The regression itself, pinned: same world, same handler, only the probe
    // args differ. Delete `CHAT_INDEX_PROBE_ARGS['file.search']` and this fails.
    const db = new Database(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'probeable2-'));
    try {
      const files = createFileCollection({
        db, blobs: createBlobStore(dir),
        gate: { addUsed: () => {}, getUsed: () => 0 } as never,
        bus: createWarehouseEventBus(), slug: 'received',
        config: () => ({ path: dir, quota_bytes: 1 << 26 }),
      } as never);
      files.upsert({
        record_id: 'file:z0',
        hot_fields: {
          filename: 'Zephyrine-renewal-terms.pdf', path: `${dir}/x.pdf`, mtime: 1, size_bytes: 10,
        },
        received_at: 1, modified_at: 1, body_inline: '', size_bytes: 10, source_id: 'received',
      } as never);
      const registry = createCollectionRegistry();
      registry.register(files as never);
      const handlers = buildChatTier1Handlers({
        getContactStore: () => undefined,
        getCollectionRegistry: () => registry,
        getAuditLog: () => undefined,
        getEnrichmentStore: () => undefined,
        getRecipeStore: () => ({
          ids: () => [], get: () => null, getStored: () => null, listStored: () => [],
        }) as never,
        getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
        getExecuteRecipe: () => undefined,
      } as never);
      const ctx = { channel: 'internal_function_call', session_id: 'S', turn_id: 'T' } as never;
      const h = (handlers as Record<string, (a: unknown, c: unknown) => Promise<unknown>>)['file.search'];

      const narrow = await h({ query: 'zephyrine', limit: 51 }, ctx) as
        { result?: { files?: unknown[] } };
      expect(
        narrow.result?.files ?? [],
        'the session scope is why this was invisible — kept as the contrast',
      ).toHaveLength(0);

      const probed = await h(
        { query: 'zephyrine', limit: 51, ...CHAT_INDEX_PROBE_ARGS['file.search'] }, ctx,
      ) as { result?: { files?: unknown[] } };
      expect(
        (probed.result?.files ?? []).length,
        'the probe args are what make the store answerable at all',
      ).toBeGreaterThan(0);
    } finally { db.close(); }
  });
});

describe('contact.search answers a probe, and only for terms it holds', () => {
  it('discriminates — a real name hits, a term it does not hold does not', async () => {
    // ⛔ DRIVEN AGAINST THE REAL STORE. A stubbed ContactStore returned scored
    // candidates for EVERY query including nonsense, which would have made the
    // index name `contact.search` on every line forever — the fail-open shape
    // `hasHit` exists to prevent. The stub was wrong, not the handler; that is
    // exactly why this drives the real one.
    const db = new Database(':memory:');
    try {
      const store = createContactStore(db);
      store.upsertManual({ email: 'z@northwind.test', name: 'Zephyrine Aldridge' }, 1000);
      store.upsertManual({ email: 'p@acme.test', name: 'Pat Okoro' }, 1000);
      const handlers = buildChatTier1Handlers({
        getContactStore: () => store,
        getCollectionRegistry: () => undefined,
        getAuditLog: () => undefined,
        getEnrichmentStore: () => undefined,
        getRecipeStore: () => ({
          ids: () => [], get: () => null, getStored: () => null, listStored: () => [],
        }) as never,
        getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
        getExecuteRecipe: () => undefined,
      } as never);
      const ctx = { channel: 'internal_function_call', session_id: 'S', turn_id: 'T' } as never;
      const h = (handlers as Record<string, (a: unknown, c: unknown) => Promise<unknown>>)['contact.search'];
      const hits = async (q: string): Promise<number> => {
        const r = await h(
          { query: q, limit: CHAT_INDEX_TOO_COMMON_CAP + 1, ...(CHAT_INDEX_PROBE_ARGS['contact.search'] ?? {}) },
          ctx,
        ) as { result?: { candidates?: unknown[] } };
        return (r.result?.candidates ?? []).length;
      };
      expect(await hits('zephyrine'), 'a held name must answer').toBeGreaterThan(0);
      expect(await hits('okoro'), 'a held surname must answer').toBeGreaterThan(0);
      expect(await hits('qqzzxx'), 'nonsense must NOT answer').toBe(0);
      expect(
        await hits('renewal'),
        'a term no contact holds must not answer — otherwise the index names contact on every line',
      ).toBe(0);
    } finally { db.close(); }
  });
});

describe('file.search matches the PATH, not only the leaf name', () => {
  it('finds a file whose subject appears only in its folder', async () => {
    // A file at `Clients/Sandhurst/2026/terms.pdf` is ABOUT Sandhurst and says
    // so nowhere in its leaf name. Filename-only matching answered nothing for
    // the one term a person would actually search on. `path` is already in
    // `hot_fields` locally and is mirrored from `FileMetaProjection.path` for a
    // D-192 remote source, so this costs no new storage and no new read.
    const db = new Database(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'fpath-'));
    try {
      const files = createFileCollection({
        db, blobs: createBlobStore(dir),
        gate: { addUsed: () => {}, getUsed: () => 0 } as never,
        bus: createWarehouseEventBus(), slug: 'received',
        config: () => ({ path: dir, quota_bytes: 1 << 26 }),
      } as never);
      files.upsert({
        record_id: 'file:p0',
        hot_fields: {
          filename: 'renewal-notice-83-days.pdf',
          path: 'Clients/Sandhurst/2026/renewal-notice-83-days.pdf',
          mtime: 1, size: 10,
        },
        received_at: 1, modified_at: 1, body_inline: '', size_bytes: 10, source_id: 'received',
      } as never);
      const registry = createCollectionRegistry();
      registry.register(files as never);
      const handlers = buildChatTier1Handlers({
        getContactStore: () => undefined,
        getCollectionRegistry: () => registry,
        getAuditLog: () => undefined,
        getEnrichmentStore: () => undefined,
        getRecipeStore: () => ({
          ids: () => [], get: () => null, getStored: () => null, listStored: () => [],
        }) as never,
        getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
        getExecuteRecipe: () => undefined,
      } as never);
      const ctx = { channel: 'internal_function_call', session_id: 'S', turn_id: 'T' } as never;
      const h = (handlers as Record<string, (a: unknown, c: unknown) => Promise<unknown>>)['file.search'];
      const res = async (q: string) => await h(
        { query: q, limit: 51, ...CHAT_INDEX_PROBE_ARGS['file.search'] }, ctx,
      ) as { result?: { files?: Array<{ filename: string; path?: string }> } };

      const byFolder = await res('sandhurst');
      expect(
        (byFolder.result?.files ?? []).length,
        'the folder names the subject — a filename-only match loses it',
      ).toBe(1);
      expect(
        byFolder.result?.files?.[0]?.path,
        'and the path is PROJECTED, so the model can see why it matched',
      ).toContain('Sandhurst');
      expect((await res('renewal')).result?.files ?? [], 'the leaf name still matches').toHaveLength(1);
      expect((await res('nothinghere')).result?.files ?? [], 'and it does not fail open').toHaveLength(0);

      // ⛔⛔ THE WHOLE QUERY USED TO BE ONE LITERAL SUBSTRING, so a multi-word
      // query missed almost everything. Measured against a live model: the index
      // named `file.search` for `sandhurst`, `renewal` and `notice` separately,
      // the model asked for "Sandhurst renewal notice" as a phrase, and got ZERO
      // from a file named `renewal-notice-83-days.pdf` under
      // `Clients/Sandhurst/2026/`. Every term present; the phrase absent.
      // Every TERM must match now — the same implicit AND the FTS stores get.
      expect(
        (await res('Sandhurst renewal notice')).result?.files ?? [],
        'a multi-word query must match on TERMS, not as one literal phrase',
      ).toHaveLength(1);
      expect(
        (await res('sandhurst invoice')).result?.files ?? [],
        'and all terms must match — a term-splitting rule must not fail OPEN',
      ).toHaveLength(0);
    } finally { db.close(); }
  });
});

describe('file matching is TIERED, not binary', () => {
  it('scores a verbatim hit above an every-term hit', () => {
    // 🔑 A file whose text carries the needle VERBATIM is a better answer than
    // one that merely contains each word somewhere, and flattening the two
    // throws that away — leaving recency alone to decide, which is the eviction
    // the recency FLOOR exists to bound on the FTS stores.
    const t = (f: string, p: string, q: string) => scoreFileNeedle(f, p, q);

    // ⛔ SEPARATOR FOLDING IS WHAT MAKES TIER 2 REACHABLE AT ALL. Files are
    // named with hyphens, people type spaces. Measured before folding:
    // "renewal notice" scored 1 against `renewal-notice-83.pdf` — its own best
    // case — so the phrase tier was dead code that looked implemented.
    expect(t('renewal-notice-83.pdf', 'Sandhurst/renewal-notice-83.pdf', 'renewal notice')).toBe(2);
    // The owner's filing pattern — folder per client, doc type in the name —
    // reads as an ADJACENT phrase once folded, which is the strongest signal
    // the shape can produce.
    expect(t('invoice-10823.pdf', 'Sandhurst/invoice-10823.pdf', 'Sandhurst invoice')).toBe(2);
    expect(t('invoice-10823.pdf', 'Sandhurst/invoice-10823.pdf', 'invoice 10823')).toBe(2);
    // Terms present but scattered across folder and name — a real hit, ranked below.
    expect(t('notice.pdf', 'Renewal/2026/notice.pdf', 'renewal notice')).toBe(1);
    // And it does NOT fail open: 99001 lives under a different client.
    expect(t('invoice-99001.pdf', 'Northwind/invoice-99001.pdf', 'Sandhurst invoice')).toBe(0);
    expect(t('anything.pdf', 'Any/where.pdf', '   ')).toBe(0);
  });

  it('ranks a tier-2 hit above a NEWER tier-1 hit, and only sorts by recency without a query', async () => {
    const db = new Database(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'ftier-'));
    try {
      const files = createFileCollection({
        db, blobs: createBlobStore(dir),
        gate: { addUsed: () => {}, getUsed: () => 0 } as never,
        bus: createWarehouseEventBus(), slug: 'received',
        config: () => ({ path: dir, quota_bytes: 1 << 26 }),
      } as never);
      const put = (id: string, filename: string, path: string, at: number): void => {
        files.upsert({
          record_id: id, hot_fields: { filename, path, size: 10 },
          received_at: at, modified_at: at, body_inline: '', size_bytes: 10,
          source_id: 'received',
        } as never);
      };
      put('file:OLD-phrase', 'renewal-notice-83.pdf', 'Sandhurst/renewal-notice-83.pdf', 1);
      put('file:NEW-terms', 'notice.pdf', 'Renewal/2026/notice.pdf', 9999);

      const registry = createCollectionRegistry();
      registry.register(files as never);
      const handlers = buildChatTier1Handlers({
        getContactStore: () => undefined,
        getCollectionRegistry: () => registry,
        getAuditLog: () => undefined,
        getEnrichmentStore: () => undefined,
        getRecipeStore: () => ({
          ids: () => [], get: () => null, getStored: () => null, listStored: () => [],
        }) as never,
        getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
        getExecuteRecipe: () => undefined,
      } as never);
      const ctx = { channel: 'internal_function_call', session_id: 'S', turn_id: 'T' } as never;
      const h = (handlers as Record<string, (a: unknown, c: unknown) => Promise<unknown>>)['file.search'];
      const ids = async (args: Record<string, unknown>): Promise<string[]> => {
        const r = await h({ ...args, limit: 20, scope: 'all' }, ctx) as
          { result?: { files?: Array<{ file_id: string }> } };
        return (r.result?.files ?? []).map((f) => f.file_id);
      };

      expect(
        await ids({ query: 'renewal notice' }),
        'the phrase hit must lead, though it is 9998 ticks older',
      ).toEqual(['file:OLD-phrase', 'file:NEW-terms']);

      expect(
        await ids({}),
        'with NO query there is nothing to rank, so recency stands',
      ).toEqual(['file:NEW-terms', 'file:OLD-phrase']);
    } finally { db.close(); }
  });
});

describe('every entry in CHAT_INDEX_STORES resolves to a real tool', () => {
  /** ⛔⛔ THE RATCHET ABOVE ITERATES A HARDCODED LIST, so an entry added to
   *  `CHAT_INDEX_STORES` is not covered by it — which is exactly how the five
   *  `work.search:<kind>` probes were added and the suite stayed green.
   *
   *  🔑 A probe key that does not resolve to a tool name is DENIED at
   *  `admitTier1` or missing from `tier1Handlers`, and a denied probe reads
   *  EXACTLY like an empty store. That is this feature's own measured harm mode
   *  — and the reason work entities were invisible in the first place: the
   *  index reported `ring: memory.search` while twelve "Kestrel ring NN" notes
   *  sat in a store it never asked. */
  it('the tool name is what admitTier1 and tier1Handlers will see', () => {
    for (const [probeKey] of CHAT_INDEX_STORES) {
      const tool = chatIndexProbeTool(probeKey);
      expect(tool, `${probeKey} must resolve to a tool name`).not.toContain(':');
      expect(tool.length, `${probeKey} must not resolve to empty`).toBeGreaterThan(0);
    }
  });

  it('every discriminated key carries the args its tool needs', () => {
    // `work.search` takes one `kind` per call; a key without it probes nothing.
    for (const [probeKey] of CHAT_INDEX_STORES) {
      if (!probeKey.includes(':')) continue;
      const args = CHAT_INDEX_PROBE_ARGS[probeKey];
      expect(args, `${probeKey} must have probe args`).toBeDefined();
      expect(Object.keys(args ?? {}).length,
        `${probeKey} args must not be empty`).toBeGreaterThan(0);
    }
  });

  it('🔑 work entities are probed — the blind spot that caused a wrong pointer', () => {
    const kinds = CHAT_INDEX_STORES
      .map(([k]) => k)
      .filter((k) => chatIndexProbeTool(k) === 'work.search')
      .map((k) => (CHAT_INDEX_PROBE_ARGS[k] as { kind?: string } | undefined)?.kind);
    // All five work-entity kinds, not just `note`: a partial list leaves the
    // same failure shape for a term that lives in a task or a booking.
    expect(new Set(kinds)).toEqual(
      new Set(['task', 'note', 'commitment', 'project', 'booking']),
    );
  });
});

describe('the rendered line never names a probe key', () => {
  /** ⛔ MEASURED LIVE (task 343, run `2026-09-07T13-45-02-144Z`). The
   *  co-occurrence path pushed PROBE KEYS where the per-term path pushed
   *  LABELS, producing:
   *    "ring note read checkpoint cost: work.search:note; ring: memory.search,
   *     work.search; note: memory.search, work.search; ..."
   *  Two defects in one line: `work.search:note` is a tool name the model
   *  CANNOT call, and the collapse silently failed — `collapsed.has(label)` is
   *  false when the set holds a key — so the terms it should have removed are
   *  listed right beside the phrase.
   */
  it('every probe key labels to something a model could actually call', () => {
    for (const [probeKey] of CHAT_INDEX_STORES) {
      const label = chatIndexProbeLabel(probeKey);
      expect(label, `${probeKey} label must not carry a discriminator`)
        .not.toContain(':');
    }
  });

  it('🔑 the label is what the collapse compares on, for every store', () => {
    // If these two ever disagree, the collapse stops removing single-term
    // entries and the line double-reports — silently, since both halves look
    // plausible on their own.
    for (const [probeKey] of CHAT_INDEX_STORES) {
      expect(chatIndexProbeLabel(probeKey)).toBe(chatIndexProbeTool(probeKey));
    }
  });
});
