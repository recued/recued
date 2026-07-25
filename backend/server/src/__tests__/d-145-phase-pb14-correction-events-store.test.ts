/** D-145 PB14 — `CorrectionEventsStore` SQLite-backed store tests.
 *
 *  Covers the schema bootstrap, record + listRecent + listByPlan +
 *  listByExtractionEvent + clearAll + pruneOlderThan + count, the
 *  durable-kind compaction exception, the idempotency invariant on
 *  the schema-install path, and the collision + validation error
 *  classes.
 *
 *  Spec: D-145 § B.14.2 + § B.14.4. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CORRECTION_EVENT_RETENTION_MS,
  CorrectionEventValidationError,
  type CorrectionEventRow,
} from '@recued/contracts';

import {
  CORRECTION_EVENTS_TABLE,
  CorrectionEventIdCollisionError,
  createCorrectionEventsStore,
} from '../storage/correction-events-store.js';

const NOW = 1_715_000_000_000;

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pb14-store-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let rowSeq = 0;
const buildRow = (
  patch: Partial<CorrectionEventRow> & { kind: CorrectionEventRow['kind'] },
): CorrectionEventRow => {
  rowSeq += 1;
  return {
    id: `correction-${rowSeq}`,
    ts: NOW,
    event_at: NOW,
    payload_blob: { extraction_event_id: `evt-${rowSeq}` },
    scope: 'global',
    ...patch,
  };
};

// ── Schema bootstrap ───────────────────────────────────────────────

describe('PB14 store — schema bootstrap', () => {
  it('creates the correction_events table on first construct', () => {
    createCorrectionEventsStore(db);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .all(CORRECTION_EVENTS_TABLE) as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  it('idempotent — second construct does not throw', () => {
    createCorrectionEventsStore(db);
    expect(() => createCorrectionEventsStore(db)).not.toThrow();
  });

  it('creates all three documented indexes', () => {
    createCorrectionEventsStore(db);
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ?`)
      .all(CORRECTION_EVENTS_TABLE) as Array<{ name: string }>;
    const names = new Set(indexes.map((i) => i.name));
    expect(names.has('idx_correction_kind_time')).toBe(true);
    expect(names.has('idx_correction_plan')).toBe(true);
    expect(names.has('idx_correction_extraction')).toBe(true);
  });
});

// ── record + listRecent ─────────────────────────────────────────────

describe('PB14 store — record + listRecent', () => {
  it('records a row + listRecent returns it', () => {
    const store = createCorrectionEventsStore(db);
    store.record(buildRow({ kind: 'extraction_undone' }));
    const rows = store.listRecent();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('extraction_undone');
  });

  it('listRecent orders by event_at DESC', () => {
    const store = createCorrectionEventsStore(db);
    store.record(buildRow({ kind: 'extraction_undone', id: 'older', event_at: NOW - 1000 }));
    store.record(buildRow({ kind: 'extraction_undone', id: 'newer', event_at: NOW }));
    const rows = store.listRecent();
    expect(rows.map((r) => r.id)).toEqual(['newer', 'older']);
  });

  it('listRecent honors limit', () => {
    const store = createCorrectionEventsStore(db);
    for (let i = 0; i < 10; i++) {
      store.record(
        buildRow({ kind: 'extraction_undone', id: `r-${i}`, event_at: NOW - i }),
      );
    }
    expect(store.listRecent({ limit: 3 })).toHaveLength(3);
  });

  it('listRecent filters by kind', () => {
    const store = createCorrectionEventsStore(db);
    store.record(buildRow({ kind: 'extraction_undone' }));
    store.record(
      buildRow({
        kind: 'plan_outcome_corrected',
        payload_blob: { plan_id: 'p1', user_feedback: 'too_chatty' },
      }),
    );
    const rows = store.listRecent({ kind: 'plan_outcome_corrected' });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('plan_outcome_corrected');
  });

  it('listRecent filters by scope', () => {
    const store = createCorrectionEventsStore(db);
    store.record(buildRow({ kind: 'extraction_undone', scope: 'global' }));
    store.record(
      buildRow({
        kind: 'context_marked_omit',
        scope: 'this_contact',
        payload_blob: {
          source_ref: 'data.social.x',
          for_scope: 'this_contact',
          contact_id: 'c-bob',
        },
      }),
    );
    const rows = store.listRecent({ scope: 'this_contact' });
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe('this_contact');
  });

  it('listRecent filters by kind + scope (intersection)', () => {
    const store = createCorrectionEventsStore(db);
    store.record(buildRow({ kind: 'extraction_undone', scope: 'global' }));
    store.record(buildRow({ kind: 'rejected_extraction', scope: 'global' }));
    store.record(
      buildRow({
        kind: 'context_marked_omit',
        scope: 'this_contact',
        payload_blob: {
          source_ref: 'data.social.x',
          for_scope: 'this_contact',
          contact_id: 'c-bob',
        },
      }),
    );
    const rows = store.listRecent({ kind: 'extraction_undone', scope: 'global' });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('extraction_undone');
  });

  it('listRecent round-trips payload_blob unchanged', () => {
    const store = createCorrectionEventsStore(db);
    store.record(
      buildRow({
        kind: 'extraction_edited',
        payload_blob: {
          extraction_event_id: 'evt-1',
          corrected_args: { amount: 50, currency: 'USD' },
        },
      }),
    );
    const rows = store.listRecent();
    expect(rows[0].payload_blob).toEqual({
      extraction_event_id: 'evt-1',
      corrected_args: { amount: 50, currency: 'USD' },
    });
  });
});

// ── Validation gate ─────────────────────────────────────────────────

describe('PB14 store — validation gate', () => {
  it('rejects unknown kind on insert', () => {
    const store = createCorrectionEventsStore(db);
    expect(() =>
      store.record({
        id: 'bad',
        ts: NOW,
        event_at: NOW,
        kind: 'not_a_kind' as CorrectionEventRow['kind'],
        payload_blob: {},
        scope: 'global',
      }),
    ).toThrow(CorrectionEventValidationError);
  });

  it('rejects unknown scope on insert', () => {
    const store = createCorrectionEventsStore(db);
    expect(() =>
      store.record({
        id: 'bad',
        ts: NOW,
        event_at: NOW,
        kind: 'extraction_undone',
        payload_blob: { extraction_event_id: 'evt-1' },
        scope: 'mystery' as CorrectionEventRow['scope'],
      }),
    ).toThrow(CorrectionEventValidationError);
  });

  it('rejects context_marked_omit this_contact without contact_id', () => {
    const store = createCorrectionEventsStore(db);
    expect(() =>
      store.record(
        buildRow({
          kind: 'context_marked_omit',
          scope: 'this_contact',
          payload_blob: { source_ref: 'data.social.x', for_scope: 'this_contact' },
        }),
      ),
    ).toThrow(CorrectionEventValidationError);
  });
});

// ── Collision class ─────────────────────────────────────────────────

describe('PB14 store — id collision', () => {
  it('CorrectionEventIdCollisionError on duplicate id', () => {
    const store = createCorrectionEventsStore(db);
    store.record(buildRow({ id: 'duplicate', kind: 'extraction_undone' }));
    expect(() =>
      store.record(buildRow({ id: 'duplicate', kind: 'extraction_undone' })),
    ).toThrow(CorrectionEventIdCollisionError);
  });
});

// ── Codex P2 fold — correlation column derivation ──────────────────

describe('PB14 store — Codex P2 fold: payload-derived correlation columns', () => {
  it('plan_outcome_corrected with only payload.plan_id is discoverable via listByPlan', () => {
    const store = createCorrectionEventsStore(db);
    store.record(
      buildRow({
        kind: 'plan_outcome_corrected',
        // source_plan_id deliberately OMITTED — substrate derives from
        // payload at insert time.
        payload_blob: { plan_id: 'plan-from-payload', user_feedback: 'too_chatty' },
      }),
    );
    const rows = store.listByPlan('plan-from-payload');
    expect(rows).toHaveLength(1);
    expect(rows[0].source_plan_id).toBe('plan-from-payload');
  });

  it('extraction_undone with only payload.extraction_event_id is discoverable via listByExtractionEvent', () => {
    const store = createCorrectionEventsStore(db);
    store.record(
      buildRow({
        kind: 'extraction_undone',
        // source_extraction_event_id deliberately OMITTED — derived from payload.
        payload_blob: { extraction_event_id: 'evt-from-payload' },
      }),
    );
    const rows = store.listByExtractionEvent('evt-from-payload');
    expect(rows).toHaveLength(1);
    expect(rows[0].source_extraction_event_id).toBe('evt-from-payload');
  });

  it('extraction_edited derives source_extraction_event_id from payload', () => {
    const store = createCorrectionEventsStore(db);
    store.record(
      buildRow({
        kind: 'extraction_edited',
        payload_blob: {
          extraction_event_id: 'evt-edit',
          corrected_args: { amount: 42 },
        },
      }),
    );
    expect(store.listByExtractionEvent('evt-edit')).toHaveLength(1);
  });

  it('rejected_extraction derives source_extraction_event_id from payload', () => {
    const store = createCorrectionEventsStore(db);
    store.record(
      buildRow({
        kind: 'rejected_extraction',
        payload_blob: { extraction_event_id: 'evt-rej' },
      }),
    );
    expect(store.listByExtractionEvent('evt-rej')).toHaveLength(1);
  });

  it('explicit source_plan_id wins over payload.plan_id (caller-supplied takes precedence)', () => {
    const store = createCorrectionEventsStore(db);
    store.record(
      buildRow({
        kind: 'plan_outcome_corrected',
        source_plan_id: 'explicit-plan',
        payload_blob: { plan_id: 'payload-plan', user_feedback: 'too_chatty' },
      }),
    );
    expect(store.listByPlan('explicit-plan')).toHaveLength(1);
    expect(store.listByPlan('payload-plan')).toHaveLength(0);
  });
});

// ── listByPlan + listByExtractionEvent ─────────────────────────────

describe('PB14 store — correlation queries', () => {
  it('listByPlan returns only rows with matching source_plan_id', () => {
    const store = createCorrectionEventsStore(db);
    store.record(
      buildRow({
        kind: 'plan_outcome_corrected',
        source_plan_id: 'plan-1',
        payload_blob: { plan_id: 'plan-1', user_feedback: 'too_chatty' },
      }),
    );
    store.record(
      buildRow({
        kind: 'plan_outcome_corrected',
        source_plan_id: 'plan-2',
        payload_blob: { plan_id: 'plan-2', user_feedback: 'wrong_tone' },
      }),
    );
    const rows = store.listByPlan('plan-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].source_plan_id).toBe('plan-1');
  });

  it('listByExtractionEvent returns rows linked by source_extraction_event_id', () => {
    const store = createCorrectionEventsStore(db);
    store.record(
      buildRow({
        kind: 'extraction_undone',
        source_extraction_event_id: 'evt-1',
      }),
    );
    store.record(
      buildRow({
        kind: 'extraction_undone',
        source_extraction_event_id: 'evt-2',
      }),
    );
    const rows = store.listByExtractionEvent('evt-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].source_extraction_event_id).toBe('evt-1');
  });
});

// ── clearAll ────────────────────────────────────────────────────────

describe('PB14 store — clearAll', () => {
  it('removes every row + count returns 0', () => {
    const store = createCorrectionEventsStore(db);
    store.record(buildRow({ kind: 'extraction_undone' }));
    store.record(
      buildRow({
        kind: 'plan_outcome_corrected',
        payload_blob: { plan_id: 'p1', user_feedback: 'too_chatty' },
      }),
    );
    expect(store.count()).toBe(2);
    expect(store.clearAll()).toBe(2);
    expect(store.count()).toBe(0);
    expect(store.listRecent()).toEqual([]);
  });
});

// ── pruneOlderThan + durable-kind exception ─────────────────────────

describe('PB14 store — pruneOlderThan (compaction)', () => {
  it('removes rows older than 1y EXCEPT durable kinds', () => {
    const store = createCorrectionEventsStore(db);
    const oneYearOne = NOW - CORRECTION_EVENT_RETENTION_MS - 1;
    // Non-durable, aged → should prune
    store.record(
      buildRow({
        id: 'aged-undone',
        kind: 'extraction_undone',
        event_at: oneYearOne,
      }),
    );
    // Durable (contact_merged), aged → must retain
    store.record(
      buildRow({
        id: 'aged-merged',
        kind: 'contact_merged',
        event_at: oneYearOne,
        payload_blob: {
          loser_contact_id: 'c1',
          survivor_contact_id: 'c2',
          via: 'd138_auto',
        },
      }),
    );
    // Durable (standing_instruction_added), aged → must retain
    store.record(
      buildRow({
        id: 'aged-si',
        kind: 'standing_instruction_added',
        event_at: oneYearOne,
        payload_blob: { instruction_id: 'si-1' },
      }),
    );
    // Non-durable, recent → must retain
    store.record(
      buildRow({
        id: 'recent-undone',
        kind: 'extraction_undone',
        event_at: NOW,
      }),
    );
    const removed = store.pruneOlderThan(NOW);
    expect(removed).toBe(1);
    const remaining = store.listRecent().map((r) => r.id).sort();
    expect(remaining).toEqual(['aged-merged', 'aged-si', 'recent-undone']);
  });

  it('returns 0 when no rows are prunable', () => {
    const store = createCorrectionEventsStore(db);
    store.record(buildRow({ kind: 'extraction_undone', event_at: NOW }));
    expect(store.pruneOlderThan(NOW)).toBe(0);
    expect(store.count()).toBe(1);
  });

  it('exactly at the boundary (event_at === cutoff) retains', () => {
    const store = createCorrectionEventsStore(db);
    const cutoff = NOW - CORRECTION_EVENT_RETENTION_MS;
    store.record(
      buildRow({
        id: 'boundary',
        kind: 'extraction_undone',
        event_at: cutoff,
      }),
    );
    // pruner uses strict less-than (`event_at < cutoff`) — boundary
    // retains.
    expect(store.pruneOlderThan(NOW)).toBe(0);
    expect(store.count()).toBe(1);
  });
});

// ── count ──────────────────────────────────────────────────────────

describe('PB14 store — count', () => {
  it('returns the row count', () => {
    const store = createCorrectionEventsStore(db);
    expect(store.count()).toBe(0);
    store.record(buildRow({ kind: 'extraction_undone' }));
    expect(store.count()).toBe(1);
    store.record(buildRow({ kind: 'extraction_undone' }));
    expect(store.count()).toBe(2);
  });
});

// ── clear-history → engine reverts to defaults (substrate level) ──

describe('PB14 store — clear-history reverts engine defaults', () => {
  it('after clearAll the engine reads no corrections, so all hooks read defaults', async () => {
    const engine = await import('@recued/middleware-recued');
    const { buildCorrectionSummary, computeContextShapingBiases, computeExtractionThresholdAdjustment } =
      engine.correctionLearning;
    const store = createCorrectionEventsStore(db);
    store.record(
      buildRow({
        kind: 'plan_outcome_corrected',
        payload_blob: { plan_id: 'p1', user_feedback: 'too_chatty' },
      }),
    );
    store.record(
      buildRow({
        kind: 'context_marked_omit',
        payload_blob: { source_ref: 'data.social.facebook', for_scope: 'global' },
      }),
    );
    // Before clear — corrections present.
    expect(store.listRecent()).toHaveLength(2);
    expect(
      computeContextShapingBiases({ rows: store.listRecent() }),
    ).toHaveLength(1);
    expect(
      buildCorrectionSummary({ rows: store.listRecent(), now: NOW })[
        'tone_too_chatty_recent_corrections'
      ],
    ).toBe(1);
    // After clear — engine reverts to defaults.
    store.clearAll();
    expect(store.listRecent()).toEqual([]);
    expect(computeContextShapingBiases({ rows: store.listRecent() })).toEqual([]);
    expect(buildCorrectionSummary({ rows: store.listRecent(), now: NOW })).toEqual({});
    expect(
      computeExtractionThresholdAdjustment({
        rows: store.listRecent(),
        fact_type: 'extraction.commitment',
        now: NOW,
      }),
    ).toBe(0.85);
  });
});
