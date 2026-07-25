/** D-161 P2 — producer provenance-filter in the housekeeping harness.
 *
 *  The per-producer input-provenance gate: `buildEnrichmentProducerTask`
 *  skips a source row whose P1 `origin_actor` write-actor isn't in the
 *  producer's accepted set — *filtered for this producer*, never *excluded
 *  from the warehouse* (I-7). Undeclared producers fall back to the
 *  conservative `user_self` + `system` default (TR-7 / N.9 MUST), so an
 *  attacker-controllable `anonymous` Reception row is never silently fed to
 *  an undeclared producer's `ai-extract`. The axis is independent of
 *  D-132's per-topic `enrichment_trust` (I-8) — this gate is per-row inside
 *  the harness step, not a topic-eligibility decision.
 *
 *  Mirrors the d-123-phase-4 harness test setup (stub walker + real
 *  enrichment store on a temp SQLite). `origin_acceptance` is monkeypatched
 *  onto the `purpose` registry entry (no real topic declares it yet) with a
 *  finally-restore so the global registry is left untouched. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type Actor,
  type CollectionRecord,
} from '@recued/contracts';

import {
  buildEnrichmentProducerTask,
} from '../housekeeping/enrichment-producer.js';
import type { HousekeepingEnrichmentProducer } from '../housekeeping/enrichment-producer.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type {
  SourceCollectionWalker,
  SourceRecord,
} from '../housekeeping/source-walkers.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;
const now = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-161-p2-filter-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createEnrichmentStore(db);
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const stubCtx = (): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: store,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
});

/** A source-collection record carrying a P1 `origin_actor` write-actor. */
const mailWithOrigin = (record_id: string, origin_actor: Actor): CollectionRecord => ({
  record_id,
  received_at: now,
  modified_at: now,
  hot_fields: {},
  size_bytes: 100,
  source_id: record_id,
  origin_actor,
});

const sourceRecord = (id: string, origin_actor: Actor): SourceRecord => ({
  target_id: id,
  data: mailWithOrigin(id, origin_actor),
  cursor_token: id,
});

const stubWalker = (records: SourceRecord[]): SourceCollectionWalker => ({
  *walkAfter(cursor_token: string, batch_size: number) {
    let yielded = 0;
    for (const record of records) {
      if (record.cursor_token <= cursor_token) continue;
      if (yielded >= batch_size) return;
      yield record;
      yielded += 1;
    }
  },
  hashOf(record) {
    return `v1:${record.target_id}`;
  },
  fetchOne(target_id) {
    return records.find((r) => r.target_id === target_id) ?? null;
  },
});

const STUB_SCOPE_READ_DECLARATION = [
  { collection: 'data.mail', sample_field_paths: ['subject'] },
] as const;

/** `purpose` — a dependent / mail / housekeeping topic with a permissive
 *  schema (same one d-123-phase-4 uses for harness-shape tests). */
const purposeProducer = (): HousekeepingEnrichmentProducer => ({
  topic: 'purpose',
  source_scope: 'mail',
  scope_read_declaration: STUB_SCOPE_READ_DECLARATION,
  estimate_per_record_tokens: () => 0,
  async produce(_ctx, record) {
    return { value: { sample: record.target_id } };
  },
});

/** Run one full step (stale-sweep + forward-walk) from an empty cursor. */
const runStep = async (producer: HousekeepingEnrichmentProducer, records: SourceRecord[]) => {
  const task = buildEnrichmentProducerTask({ producer, walker: stubWalker(records) });
  await task.step(stubCtx(), { kind: 'complete' }, 60_000);
};

/** Monkeypatch the `purpose` topic's `origin_acceptance`, run `fn`,
 *  restore. The registry isn't runtime-frozen; forks isolation keeps the
 *  mutation file-local. */
const withPurposeAcceptance = async (
  acceptance: readonly Actor[] | undefined,
  fn: () => void | Promise<void>,
): Promise<void> => {
  const reg = ENRICHMENT_REGISTRY as unknown as Record<string, { origin_acceptance?: readonly Actor[] }>;
  const had = Object.prototype.hasOwnProperty.call(reg.purpose, 'origin_acceptance');
  const prev = reg.purpose.origin_acceptance;
  if (acceptance === undefined) delete reg.purpose.origin_acceptance;
  else reg.purpose.origin_acceptance = acceptance;
  try {
    await fn();
  } finally {
    if (had) reg.purpose.origin_acceptance = prev;
    else delete reg.purpose.origin_acceptance;
  }
};

const targetIds = (): string[] =>
  store.list({ topic: 'purpose', fresh_only: false }).map((r) => r.target_id ?? '').sort();

describe('D-161 P2 — producer provenance-filter (forward walk)', () => {
  it('undeclared producer produces user_self + system rows, skips anonymous + contracted_user (TR-7 default)', async () => {
    await runStep(purposeProducer(), [
      sourceRecord('a-system', 'system'),
      sourceRecord('b-user', 'user_self'),
      sourceRecord('c-anon', 'anonymous'),
      sourceRecord('d-agent', 'contracted_user'),
    ]);
    // Only the conservatively-accepted origins produced enrichment rows;
    // the outside-actor rows were filtered FOR THIS PRODUCER.
    expect(targetIds()).toEqual(['a-system', 'b-user']);
  });

  it('a declared producer that opts into anonymous DOES process the anonymous row', async () => {
    await withPurposeAcceptance(['user_self', 'system', 'anonymous'], async () => {
      await runStep(purposeProducer(), [
        sourceRecord('c-anon', 'anonymous'),
        sourceRecord('d-agent', 'contracted_user'),
      ]);
      // anonymous now accepted (opted in); contracted_user still rejected.
      expect(targetIds()).toEqual(['c-anon']);
    });
  });

  it('treatment-not-exclusion (I-7): the filtered source row is left intact + still walkable; the harness writes no output for it', async () => {
    const records = [sourceRecord('c-anon', 'anonymous')];
    const walker = stubWalker(records);
    const task = buildEnrichmentProducerTask({ producer: purposeProducer(), walker });
    await task.step(stubCtx(), { kind: 'complete' }, 60_000);
    // No enrichment row written for the skipped origin...
    expect(store.list({ topic: 'purpose', fresh_only: false })).toHaveLength(0);
    // ...and the SOURCE row is untouched — the walker still yields it, so
    // another producer (or a later opted-in run) can still process it. The
    // facet never excludes a row from the warehouse.
    expect([...walker.walkAfter('', 10)].map((r) => r.target_id)).toEqual(['c-anon']);
  });
});

describe('D-161 P2 — origin_acceptance validation', () => {
  it('buildEnrichmentProducerTask throws on a declared-empty origin_acceptance', async () => {
    await withPurposeAcceptance([], () => {
      expect(() =>
        buildEnrichmentProducerTask({ producer: purposeProducer(), walker: stubWalker([]) }),
      ).toThrow(/enrichment_origin_acceptance_empty/);
    });
  });

  it('an undeclared (omitted) origin_acceptance does NOT throw — the conservative default applies', () => {
    expect(() =>
      buildEnrichmentProducerTask({ producer: purposeProducer(), walker: stubWalker([]) }),
    ).not.toThrow();
  });
});

describe('D-161 P2 — stale-sweep orphan cleanup (anti-starvation)', () => {
  it('deletes the producer-owned orphan when acceptance narrows below a stale row, and still re-derives accepted stale rows', async () => {
    // Produce two rows under the default (both accepted).
    await runStep(purposeProducer(), [
      sourceRecord('a-system', 'system'),
      sourceRecord('b-user', 'user_self'),
    ]);
    expect(targetIds()).toEqual(['a-system', 'b-user']);

    // Narrow acceptance to user_self-only: 'a-system' is now an orphan; mark
    // both rows stale and run the sweep.
    await withPurposeAcceptance(['user_self'], async () => {
      db.prepare(`UPDATE data_enrichment SET staleness_class = 'stale' WHERE topic = 'purpose'`).run();
      await runStep(purposeProducer(), [
        sourceRecord('a-system', 'system'),
        sourceRecord('b-user', 'user_self'),
      ]);
    });

    // The orphan was DELETED (not skip-and-left, which would re-fetch +
    // re-skip every cycle and starve 'b'); 'b-user' was re-derived to fresh.
    const rows = store.list({ topic: 'purpose', fresh_only: false });
    expect(rows.map((r) => r.target_id)).toEqual(['b-user']);
    expect(rows[0]?.staleness_class).toBe('fresh');
  });
});
