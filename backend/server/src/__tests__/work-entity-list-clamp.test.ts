/** The LIST long-text clamp, derived per result instead of fixed per entity.
 *
 *  ⛔ WHY IT CHANGED. The clamp is per-ENTITY but the cost is per-RESULT, so one
 *  constant had to be sized for the worst case and was then punishing in the
 *  common one. Measured 2026-09-05, one `work.search` result in est-tokens:
 *
 *      clamp | 1 hit | 20 hits | 100 hits
 *        280 |   275 |   5,510 |   27,550
 *      5,000 | 2,635 |  52,710 |  263,550
 *
 *  Every per-ring lookup in that day's live drives returned exactly ONE row and
 *  was still cut to 280 characters — 11% of a 2,584-char note — so essentially
 *  every record cost a second round-trip through `work.read`. */

import type {
  ChatDispatchContext,
  ChatDispatchResult,
  IngredientManifest,
} from '@recued/contracts';
import { RECUED_BUILTIN_SOURCE_ID } from '@recued/contracts';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import {
  listLongTextClamp,
  runWorkEntitySearchTool,
  type WorkEntityReadToolsDeps,
  type WorkEntityToolItem,
} from '../work-entity-read-tools.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import type { KernelWorkEntitySourceDeclaration } from '../work-entity-source-boot.js';
import type { WorkEntityTargetedReadDeps } from '../work-entity-write-executor.js';

const OLD_FIXED_CLAMP = 280;

describe('listLongTextClamp — a per-result budget', () => {
  it('🔑 a ONE-ROW result carries real text, not 280 characters', () => {
    expect(listLongTextClamp(1)).toBe(4_000);
    // …and that is cheap: one row at 4,000 chars is ~2.1k est-tokens, against
    // the 27.5k a 100-row result costs at the OLD constant.
  });

  it('the clamp shrinks as the result grows — backwards from a fixed constant', () => {
    const widths = [1, 3, 10, 20, 50, 100].map(listLongTextClamp);
    // Monotonically non-increasing: more rows, less text each.
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]!).toBeLessThanOrEqual(widths[i - 1]!);
    }
    expect(listLongTextClamp(20)).toBe(600);
  });

  it('⛔ NEVER WORSE THAN THE OLD CONSTANT, at any row count', () => {
    // The floor is the whole safety argument: a result big enough to divide
    // below 280 gets exactly what it got before, byte for byte. Without this a
    // "better" clamp would silently REGRESS every large result.
    for (let n = 1; n <= 200; n += 1) {
      expect(listLongTextClamp(n), `row count ${n} regressed below the old clamp`)
        .toBeGreaterThanOrEqual(OLD_FIXED_CLAMP);
    }
  });

  it('⛔ and never unbounded — one row cannot licence dumping a whole body', () => {
    // `work.read` is the full-text door. A LIST preview generous enough to
    // answer from is the goal; a LIST that replaces `work.read` is not.
    expect(listLongTextClamp(1)).toBeLessThanOrEqual(4_000);
    expect(listLongTextClamp(0)).toBe(OLD_FIXED_CLAMP);
    expect(listLongTextClamp(-5)).toBe(OLD_FIXED_CLAMP);
  });

  it('the crossover is where the division meets the floor', () => {
    // Below ~43 rows the budget wins and text grows; at and above it the floor
    // wins and behaviour is identical to before. Pinned so a budget change
    // makes the crossover move visibly rather than silently.
    expect(listLongTextClamp(42)).toBeGreaterThan(OLD_FIXED_CLAMP);
    expect(listLongTextClamp(43)).toBe(OLD_FIXED_CLAMP);
    expect(listLongTextClamp(100)).toBe(OLD_FIXED_CLAMP);
  });

  it('the whole result stays bounded — the property the old constant bought', () => {
    // What actually matters is rows x clamp, and it must not blow up anywhere.
    for (const n of [1, 2, 5, 20, 43, 100]) {
      expect(n * listLongTextClamp(n)).toBeLessThanOrEqual(28_000);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// The clamp reaches LIVE rows too
// ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const OWNER_CTX: ChatDispatchContext = { channel: 'internal_function_call' };
const RT_SOURCE = 'peer.acme.note';
const RT_CATALOG = 'peer-catalog';

let db: Database.Database;
let store: WorkEntityStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
  store.registerSource({
    id: RT_SOURCE, top_tier_kind: 'note', source_kind: 'connection',
    source_label: 'Peer notes', write_capable: false, registered_at: NOW,
    sync_posture: 'read_through',
  });
  store.registerSource({
    id: RECUED_BUILTIN_SOURCE_ID('note'), top_tier_kind: 'note', source_kind: 'builtin',
    source_label: 'notes', write_capable: true, registered_at: NOW,
  });
});
afterEach(() => { db.close(); });

const rtDeclaration = {
  kind: 'note', source_id_template: RT_SOURCE, source_label_template: 'Peer notes',
  source_kind: 'connection',
  remote: { entity: 'note', id: 'id', version: { kind: 'updated_at', field: 'updated_at' },
            hash_fields: ['title', 'body', 'updated_at'] },
  ops: { list: 'note.list' },
  sync: { posture: 'read_through', mode: 'read_only', depth: 'meta' },
  read_resolution: { default: 'source', wild_query: { remote_fanout: 'bounded_targeted',
    max_sources: 3, max_remote_records: 10, on_exceeds_cap: 'ask_to_narrow' } },
  projection: { canonical: { title: 'title' },
                preview: { body: { field: 'body', max_chars: 20_000 } },
                extension: { detail_fidelity: 'preview' } },
} as unknown as KernelWorkEntitySourceDeclaration;

const rtManifest = {
  slug: RT_CATALOG, name: 'Peer catalog', description: 'read-through notes',
  author: 'recued', kind: 'connection', category: 'data', risk_tier: 'read',
  input: {}, output: {},
  operations: { 'note.list': { operation_id: 'note.list', risk_tier: 'read', result_path: 'records' } },
} as unknown as IngredientManifest;

const rtDeps = (records: Array<Record<string, unknown>>): WorkEntityReadToolsDeps => ({
  isCollectionReadGranted: () => true,
  isVerbOpGranted: () => true,
  getResolver: () => createWorkEntityResolver(store, {}),
  getTargetedReadDeps: () => ({
    fetchDeps: {
      profiles: { get: () => ({ allowed_operations: ['note.list'], catalog_slug: RT_CATALOG }) },
      executorConfig: { manifests: { get: () => rtManifest } },
    },
    resolveDeclaration: () => ({
      declaration: rtDeclaration, connection_name: 'acme', connection_config: {},
    }),
    runOperation: async () => ({ ok: true, raw: { result: { records } } }),
  } as unknown as WorkEntityTargetedReadDeps),
  now: () => NOW,
});

const ok = (r: ChatDispatchResult): { entities: WorkEntityToolItem[]; total: number } => {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.result as { entities: WorkEntityToolItem[]; total: number };
};

describe('the clamp applies to LIVE read-through rows, on the same rule', () => {
  const rows = (n: number, bodyLen: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `r${i}`, title: `Peer note ${i}`, body: 'L'.repeat(bodyLen), updated_at: NOW,
    }));

  it('⛔ a live row is clamped by the RESULT COUNT, not left whole', async () => {
    // Read-through items are projected one at a time while the fetch runs, so
    // the row count does not exist yet — they are projected UNCLAMPED and
    // clamped once at page assembly. Skip that and a live Source's rows come
    // back full-size while local rows are trimmed: one tool, two behaviours,
    // and no test between them.
    //
    // ⚠ TEN rows on purpose. The LIST clamp only BINDS when its share is below
    // the projector's own preview cap (2,000 chars, WORK_ENTITY_PREVIEW_HARD_MAX_CHARS);
    // at two rows the share is 4,000 and the projector's cap is what shows,
    // which is a test of the wrong layer.
    const res = ok(await runWorkEntitySearchTool(
      rtDeps(rows(10, 1_900)), { kind: 'note', limit: 20 }, OWNER_CTX,
    ));
    expect(res.total).toBe(10);
    expect(listLongTextClamp(10)).toBe(1_200);
    for (const e of res.entities) {
      expect(e.long_text?.text.length).toBe(1_200);
      expect(e.long_text?.truncated).toBe(true);
    }
  });

  it('a live row SHORTER than its share is not marked truncated', async () => {
    const res = ok(await runWorkEntitySearchTool(
      rtDeps([{ id: 'r1', title: 'Peer note one', body: 'short body', updated_at: NOW }]),
      { kind: 'note', limit: 20 }, OWNER_CTX,
    ));
    expect(res.entities[0]?.long_text?.text).toBe('short body');
    expect(res.entities[0]?.long_text?.truncated).toBeUndefined();
  });

  it('the projector cap and the LIST clamp are DIFFERENT layers, and the tighter wins', async () => {
    // A live row can never carry more than the projector's 2,000-char preview
    // cap however generous the LIST share is. Pinned so a future change to
    // either constant cannot silently make one of them dead.
    const res = ok(await runWorkEntitySearchTool(
      rtDeps(rows(1, 9_000)), { kind: 'note', limit: 20 }, OWNER_CTX,
    ));
    expect(listLongTextClamp(1)).toBe(4_000);          // the LIST share is generous…
    expect(res.entities[0]?.long_text?.text.length).toBe(2_000);  // …the projector's cap is not
  });
});

describe('omitted_chars — the size of what was cut', () => {
  it('🔑 a truncation reports HOW MUCH it removed', async () => {
    // `truncated: true` alone cannot distinguish 100 missing characters from
    // 8,979, so every truncation reads as equally worth a `work.read`. Under a
    // trim that read is the FIRST thing evicted (measured 2026-09-05: 12/12
    // work.read results elided), so an unnecessary one can cost the model the
    // data it already had.
    const res = ok(await runWorkEntitySearchTool(
      rtDeps(Array.from({ length: 10 }, (_, i) => ({
        id: `r${i}`, title: `Peer note ${i}`, body: 'L'.repeat(1_900), updated_at: NOW,
      }))),
      { kind: 'note', limit: 20 }, OWNER_CTX,
    ));
    const lt = res.entities[0]?.long_text;
    expect(lt?.truncated).toBe(true);
    expect(lt?.text.length).toBe(1_200);
    // 1,900 chars survived the projector's 2,000 cap; the LIST clamp took 700.
    expect(lt?.omitted_chars).toBe(700);
  });

  it('⛔ an UNtruncated row carries no count — absence is the signal', () => {
    // A zero would read as "truncated by nothing", which is not a state; the
    // field is absent exactly when `truncated` is.
    const item = { long_text: { field: 'body', text: 'short', fidelity: 'complete' as const } };
    expect('omitted_chars' in item.long_text).toBe(false);
  });

  it('the count is the REMAINDER, not the original length', async () => {
    const res = ok(await runWorkEntitySearchTool(
      rtDeps([{ id: 'r1', title: 'One', body: 'L'.repeat(2_000), updated_at: NOW }]),
      { kind: 'note', limit: 20 }, OWNER_CTX,
    ));
    const lt = res.entities[0]?.long_text;
    // One row: LIST share 4,000, projector cap 2,000 → 2,000 chars, nothing cut.
    expect(lt?.text.length).toBe(2_000);
    expect(lt?.truncated).toBeUndefined();
    expect(lt?.omitted_chars).toBeUndefined();
  });
});
