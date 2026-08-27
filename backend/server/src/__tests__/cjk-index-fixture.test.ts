import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';

import {
  buildChatIndexContext, CHAT_INDEX_TOO_COMMON_CAP, distinctiveTerms,
} from '../chat-index-context.js';
import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createMailCollection } from '../collections/mail/mail-collection.js';
import { createBlobStore } from '../storage/blob-store.js';

/** A CJK mailbox, driven through the REAL mail collection, the REAL Tier-1
 *  handlers and the REAL `buildChatIndexContext` — no fake probe.
 *
 *  ⛔ WHY IT HAD TO BE REAL. The index's own unit harness models each store with
 *  a double that splits on `/\W+/`, where every CJK character is a separator, so
 *  a Han document tokenises to nothing there. The question this file asks — what
 *  does the line actually SAY for a CJK owner — cannot be asked of that double. */
const CORPUS: ReadonlyArray<readonly [string, string]> = [
  ['续约通知期的确认', '关于桑德赫斯特的续约，我们商定的通知期是九十天。请确认。'],
  ['付款条件变更', '请问付款条件是否需要调整？目前是三十天，建议改为六十天。'],
  ['合同附件', '合同的附件已经发送，请查收。如有问题请告诉我们。'],
  ['更新通知期間について', '更新の通知期間は九十日で合意しました。ご確認ください。'],
  ['請求書の送付', '請求書を送付しました。ご確認をお願いします。'],
  ['会議の日程', '来週の会議の日程について、ご都合をお知らせください。'],
];

const buildWorld = () => {
  const db = new Database(':memory:');
  const blobsDir = mkdtempSync(join(tmpdir(), 'cjk-index-'));
  const mail = createMailCollection({
    db,
    blobs: createBlobStore(blobsDir),
    gate: { addUsed: () => {}, getUsed: () => 0 } as never,
    bus: createWarehouseEventBus(),
    slug: 'inbox',
    provider: { start: async () => {}, stop: async () => {} } as never,
    config: () => ({ backfill_days: 3650, retention_days: 3650, quota_bytes: 64 * 1024 * 1024 }),
  });
  CORPUS.forEach(([subject, body], i) => {
    mail.upsert({
      record_id: `mail:cjk${i}`,
      hot_fields: {
        subject, from: 'a@example.com', to: ['me@example.com'], cc: [], thread_id: `T${i}`,
      },
      received_at: 1_780_000_000_000 + i * 1000,
      modified_at: 1_780_000_000_000 + i * 1000,
      body_inline: body,
      size_bytes: body.length,
      source_id: 'inbox',
    } as never);
  });
  const registry = createCollectionRegistry();
  registry.register(mail as never);
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
  const probe = async (store: string, term: string, pc: never) => {
    const h = (handlers as Record<string, unknown>)[store] as
      | ((a: unknown, c: unknown) => Promise<unknown>) | undefined;
    if (h === undefined) return { ok: false, reason: 'not_implemented' } as never;
    return h({ query: term, limit: CHAT_INDEX_TOO_COMMON_CAP + 1 }, pc) as never;
  };
  return { db, mail, ctx, probe };
};

describe('the pre-seed index over a CJK mailbox', () => {
  it('RENDERS for a CJK message — the refusal is lifted, the cause is fixed', async () => {
    // For one day this returned nothing, because `unicode61` matched a CJK term
    // only where it BEGAN a run and a partial line is this feature's own harm
    // mode. `FTS_CONTENT_FORMAT` 2 fixed the stored side instead.
    const { db, ctx, probe } = buildWorld();
    try {
      const line = await buildChatIndexContext('续约的通知期我们商定了多久', ctx, probe as never);
      expect(line, 'a CJK owner gets a line again').toBeDefined();
      expect(String(line)).toContain('mail.search');
    } finally { db.close(); }
  });

  it('…and the capability it refuses is REAL — the terms and the store both resolve', async () => {
    // 🔑 THE JUSTIFICATION FOR THE REFUSAL, ASSERTED. Segmentation works and the
    // store answers: `续约` is extracted and `mail.search` returns a match for
    // it. If this test ever goes red, the refusal above has become a cover for
    // an actual break and the comment on it has become a lie.
    const { db, ctx, probe } = buildWorld();
    try {
      expect(distinctiveTerms('续约的通知期我们商定了多久')).toContain('续约');
      const r = await probe('mail.search', '续约', ctx) as {
        result?: { matches?: unknown[] };
      };
      expect((r.result?.matches ?? []).length, 'the store really does hold it').toBeGreaterThan(0);
    } finally { db.close(); }
  });

  it('reaches a MID-RUN term — the exact thing that was broken', async () => {
    // 通知 sits at position 2 of `续约通知期的确认`. Under format 1 the whole
    // unspaced run was ONE token and this returned nothing, so the line named
    // `mail` for `续约` and stayed silent about `通知` in the very same record.
    // Format 2 space-separates per grapheme, so it matches as an adjacent
    // phrase. Same document, same query path, 0 -> 1.
    const { db, mail, ctx, probe } = buildWorld();
    try {
      const hit = async (t: string) => {
        const r = await probe('mail.search', t, ctx) as {
          result?: { matches?: unknown[] };
        };
        return (r.result?.matches ?? []).length > 0;
      };
      expect(await hit('续约'), 'run-INITIAL still reaches mail').toBe(true);
      expect(await hit('通知'), 'and MID-RUN now reaches it too').toBe(true);
      expect(await hit('商定'), 'deep inside the body as well').toBe(true);
      expect(mail.get('mail:cjk0')).not.toBeNull();
    } finally { db.close(); }
  });

  it('⚠ the lift BUYS BACK NOISE, and the cap is what holds it', async () => {
    // Per-grapheme tokens make ANY substring of a run matchable, so Japanese
    // auxiliary tails (`しま` out of `しました`) now match real documents where
    // before they matched nothing. That is the cost of the fix, asserted rather
    // than discovered later.
    //
    // 🔑 `CHAT_INDEX_TOO_COMMON_CAP` is the answer and it is a CORPUS-SIZE
    // answer: in a real Japanese mailbox such fragments are everywhere and die
    // on their own frequency. In a small corpus — like this one — they sit under
    // the cap and can reach the line. A line with a useless entry is a strictly
    // better failure than a line that hides a store, which is what it replaced.
    const { db, ctx, probe } = buildWorld();
    try {
      expect(distinctiveTerms('更新通知期間は何日で合意しましたか')).toContain('しま');
      const r = await probe('mail.search', 'しま', ctx) as {
        result?: { matches?: unknown[] };
      };
      expect(
        (r.result?.matches ?? []).length,
        'the fragment now MATCHES — this is the noise the cap exists to bound',
      ).toBeGreaterThan(0);
    } finally { db.close(); }
  });

});
