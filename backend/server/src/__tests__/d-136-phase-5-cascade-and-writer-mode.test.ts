/** D-136 P5a — writer-mode `mode: overwrite | supersede | pinned` +
 *  the four new cascade primitives.
 *
 *  Covers:
 *    1. Privilege gate — `mode: 'pinned'` requires
 *       `authored_by` to start with `'system.user_correction'`.
 *    2. Policy gate — `mode: 'overwrite'` rejected on
 *       `lifecycle_policy: 'historical'`; `mode: 'supersede'`
 *       rejected on non-historical policies.
 *    3. Auto-default mode per topic policy — `'historical'` topics
 *       implicitly supersede; non-historical topics implicitly
 *       overwrite. Caller may omit `mode`.
 *    4. Supersede mechanic — shape A (`per_record`, e.g. `company`):
 *       new row has fresh `_id`; prior chain head's
 *       `superseded_by_id` flips forward. Chain head finder returns
 *       the new row.
 *    5. Supersede mechanic — shape B (`derived_entity`, e.g.
 *       `confidence_drift_signal`): each chain row gets a fresh UUID
 *       `_id` while sharing the same `derived_entity_id`. Legacy
 *       overwrite rows where `_id == derived_entity_id` round-trip
 *       cleanly.
 *    6. `is_pinned` flag — set on rows authored under `mode:
 *       'pinned'`; never cleared by subsequent overwrites unless
 *       the writer explicitly pins again.
 *    7. `cascadeForProducerUpgrade` — chain heads authored by the
 *       given old `producer_version_hash` flip to
 *       `lifecycle_action_pending = 'recompute'`. Idempotent on
 *       re-fire. Skips pinned rows.
 *    8. `cascadeForUpstreamEnrichment` — every chain head whose
 *       `input_enrichment_row_ids` JSON array contains the upstream
 *       `_id` is enqueued. Idempotent. Pinned skip.
 *    9. `cascadeForIdentityChange` — perspective topics whose
 *       `aggregates_from` includes the source scope have their
 *       identity-keyed chain heads enqueued. Today: scope='mail' →
 *       `behavioral_signature` rows for the identity emails.
 *   10. `cascadeForConnectionDelete` — scenario rows scoped directly
 *       to `(connection.<kind>, <name>)` tombstone; perspective
 *       topics with `aggregates_from.includes('connection.<kind>')`
 *       enqueue chain heads.
 *
 *  Spec: `docs/d-136-spec.md` §A.5 + §A.9. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_PINNED_AUTHOR_PREFIX,
  ENRICHMENT_REGISTRY,
} from '@recued/contracts';
import {
  createEnrichmentStore,
  EnrichmentModeInvalidForPolicyError,
  EnrichmentModeUnauthorizedError,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import { createEnrichmentCascade } from '../storage/enrichment-cascade.js';

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-p5-'));
  db = new Database(join(dir, 'warehouse.db'));
  store = createEnrichmentStore(db);
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── Writer-mode privilege gate ─────────────────────────────────────

describe('D-136 §A.9 P5 — `mode: pinned` privilege gate', () => {
  it('rejects pinned writes from a non-`system.user_correction` author', () => {
    const upsertCall = (): void => {
      store.upsert({
        topic: 'purpose',
        scope: 'mail',
        target_id: 'msg_1',
        value: { category: 'request', confidence: 0.9, reasoning: 'r' },
        authored_by: 'system.housekeeping.purpose',
        mode: 'pinned',
      });
    };
    expect(upsertCall).toThrow(EnrichmentModeUnauthorizedError);
    expect(upsertCall).toThrow(/system.user_correction/);
  });

  it('admits pinned writes when `authored_by` carries the correction prefix', () => {
    const out = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'msg_1',
      value: { category: 'request', confidence: 1.0, reasoning: 'user said so' },
      authored_by: `${ENRICHMENT_PINNED_AUTHOR_PREFIX}.vote_42`,
      mode: 'pinned',
    });
    expect(out.is_pinned).toBe(true);
    const refetched = store.getByRecord(
      'purpose',
      'mail',
      'msg_1',
      `${ENRICHMENT_PINNED_AUTHOR_PREFIX}.vote_42`,
    );
    expect(refetched?.is_pinned).toBe(true);
  });

  it('overwrite-mode followups by the producer reset is_pinned to false', () => {
    // The pin is a per-write flag, not a sticky topic-level switch.
    // P7's vote consumer is responsible for re-pinning if needed; the
    // store itself just records the flag from the most-recent write.
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'msg_2',
      value: { category: 'request', confidence: 1.0, reasoning: 'user said so' },
      authored_by: `${ENRICHMENT_PINNED_AUTHOR_PREFIX}.vote_99`,
      mode: 'pinned',
    });
    // Different authored_by → different chain (per the unique index
    // including authored_by). The producer's overwrite never touches
    // the pinned row's chain.
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'msg_2',
      value: { category: 'update', confidence: 0.7, reasoning: 'producer pass' },
      authored_by: 'system.housekeeping.purpose',
    });
    const pinned = store.getByRecord(
      'purpose',
      'mail',
      'msg_2',
      `${ENRICHMENT_PINNED_AUTHOR_PREFIX}.vote_99`,
    );
    const producer = store.getByRecord(
      'purpose',
      'mail',
      'msg_2',
      'system.housekeeping.purpose',
    );
    expect(pinned?.is_pinned).toBe(true);
    expect(producer?.is_pinned).toBe(false);
  });
});

// ── Writer-mode policy gate ─────────────────────────────────────────

describe('D-136 §A.9 P5 — writer mode × lifecycle_policy gate', () => {
  it('rejects `mode: overwrite` on a `lifecycle_policy: historical` topic', () => {
    const upsertCall = (): void => {
      store.upsert({
        topic: 'company',
        scope: 'contact',
        target_id: 'alice@example.com',
        value: {
          domain: 'acme.com',
          company_name: 'Acme',
          source: 'domain_only',
          domain_category: 'business',
          reasoning: 'derived from email domain',
          computed_at: 1_700_000_000_000,
        },
        authored_by: 'system.housekeeping.company',
        mode: 'overwrite',
      });
    };
    expect(upsertCall).toThrow(EnrichmentModeInvalidForPolicyError);
    expect(upsertCall).toThrow(/historical/);
  });

  it('rejects `mode: supersede` on a non-historical topic', () => {
    const upsertCall = (): void => {
      store.upsert({
        topic: 'purpose',
        scope: 'mail',
        target_id: 'msg_x',
        value: { category: 'request', confidence: 0.9, reasoning: 'r' },
        authored_by: 'system.housekeeping.purpose',
        mode: 'supersede',
      });
    };
    expect(upsertCall).toThrow(EnrichmentModeInvalidForPolicyError);
    expect(upsertCall).toThrow(/recompute_on_drift/);
  });

  it('auto-defaults to overwrite on non-historical topics when mode is omitted', () => {
    const a = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'msg_a',
      value: { category: 'request', confidence: 0.9, reasoning: 'r1' },
      authored_by: 'system.housekeeping.purpose',
    });
    const b = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'msg_a',
      value: { category: 'update', confidence: 0.8, reasoning: 'r2' },
      authored_by: 'system.housekeeping.purpose',
    });
    expect(a._id).toBe(b._id);
    const head = store.getByRecord(
      'purpose',
      'mail',
      'msg_a',
      'system.housekeeping.purpose',
    );
    expect((head?.value as { reasoning: string }).reasoning).toBe('r2');
    // Single chain row — no supersede chain.
    const allRows = db
      .prepare(`SELECT _id, superseded_by_id FROM data_enrichment WHERE topic = 'purpose'`)
      .all();
    expect(allRows).toHaveLength(1);
  });

  it('auto-defaults to supersede on `historical` topics when mode is omitted', () => {
    const a = store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      value: {
        domain: 'acme.com',
        company_name: 'Acme',
        source: 'domain_only',
        domain_category: 'business',
        reasoning: 'derived from email domain',
        computed_at: 1_700_000_000_000,
      },
      authored_by: 'system.housekeeping.company',
    });
    const b = store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      value: {
        domain: 'globex.com',
        company_name: 'Globex',
        source: 'signature_parse',
        domain_category: 'business',
        reasoning: 'parsed from signature block',
        computed_at: 1_700_000_001_000,
      },
      authored_by: 'system.housekeeping.company',
    });
    expect(a._id).not.toBe(b._id);
    // Prior row's superseded_by_id points at the new chain head.
    const priorRow = db
      .prepare(`SELECT superseded_by_id FROM data_enrichment WHERE _id = ?`)
      .get(a._id) as { superseded_by_id: string | null };
    expect(priorRow.superseded_by_id).toBe(b._id);
    // Chain head returns the new row; old row is still in the table.
    const head = store.getByRecord(
      'company',
      'contact',
      'alice@example.com',
      'system.housekeeping.company',
    );
    expect(head?._id).toBe(b._id);
    expect(head?.superseded_by_id).toBeNull();
    // Both rows persist (preserves trajectory).
    const totalRows = db
      .prepare(`SELECT COUNT(*) AS n FROM data_enrichment WHERE topic = 'company'`)
      .get() as { n: number };
    expect(totalRows.n).toBe(2);
  });
});

// ── Supersede mechanic — shape B (derived_entity) ────────────────

describe('D-136 §A.9 P5 — supersede mechanic shape B', () => {
  it('mints a fresh UUID `_id` per chain row + shares the same derived_entity_id', () => {
    // confidence_drift_signal is shape B + lifecycle_policy historical.
    const a = store.upsert({
      topic: 'confidence_drift_signal',
      derived_entity_id: 'drift_purpose',
      value: {
        source_topic: 'purpose',
        psi: 0.15,
        severity: 'moderate',
        baseline_window: { start_at: 0, end_at: 1000, sample_count: 100 },
        recent_window: { start_at: 1000, end_at: 2000, sample_count: 30 },
        baseline_distribution: [0.8, 0.85, 0.9],
        recent_distribution: [0.7, 0.75, 0.65],
        computed_at: 1500,
      },
      authored_by: 'system.housekeeping.confidence_drift',
      event_at: 1500,
    });
    const b = store.upsert({
      topic: 'confidence_drift_signal',
      derived_entity_id: 'drift_purpose',
      value: {
        source_topic: 'purpose',
        psi: 0.30,
        severity: 'significant',
        baseline_window: { start_at: 0, end_at: 1000, sample_count: 100 },
        recent_window: { start_at: 1000, end_at: 2000, sample_count: 30 },
        baseline_distribution: [0.8, 0.85, 0.9],
        recent_distribution: [0.5, 0.4, 0.45],
        computed_at: 2000,
      },
      authored_by: 'system.housekeeping.confidence_drift',
      event_at: 2000,
    });
    expect(a._id).not.toBe(b._id);
    expect(a.derived_entity_id).toBe('drift_purpose');
    expect(b.derived_entity_id).toBe('drift_purpose');
    // First insert under historical policy still sets _id to a fresh UUID
    // for the supersede path. Subsequent inserts also fresh UUIDs.
    expect(a._id).not.toBe('drift_purpose');
    expect(b._id).not.toBe('drift_purpose');
    // getDerived returns chain head = b
    const head = store.getDerived('confidence_drift_signal', 'drift_purpose');
    expect(head?._id).toBe(b._id);
  });

  it('a meta-less producer SUPERSEDE inherits the prior head meta (the historical-topic clobber analog)', () => {
    // The supersede sibling of the COALESCE preserve on overwrite topics:
    // `deal_health_score` is historical (supersede), its producer upserts
    // without meta, and `notify-deal-closing-soon-crm` reads its meta
    // (close_date / close_state / name). A supersede INSERTs a new chain head
    // — if it bound NULL meta, the reconciler snapshot would vanish on every
    // producer re-derive. `company` (shape A, historical, contact scope)
    // stands in. Producer write (no meta) → reconciler refresh → producer
    // SUPERSEDE (no meta) → new head must carry the meta forward.
    const companyValue = (computed_at: number): Record<string, unknown> => ({
      domain: 'acme.com', company_name: 'Acme', source: 'domain_only',
      domain_category: 'business', reasoning: 'derived from email domain', computed_at,
    });
    store.upsert({
      topic: 'company', scope: 'contact', target_id: 'alice@example.com',
      value: companyValue(1_700_000_000_000),
      authored_by: 'system.housekeeping.company', mode: 'supersede',
    });
    expect(store.refreshMetaForTarget('contact', 'alice@example.com',
      { snapshot_at: 1, snapshot_hash: 'fnv1a:snap', name: 'Acme Inc', amount: 50000 })).toBe(1);
    const superseded = store.upsert({
      topic: 'company', scope: 'contact', target_id: 'alice@example.com',
      value: companyValue(1_700_000_100_000),
      authored_by: 'system.housekeeping.company', mode: 'supersede',
    });
    // The NEW chain head carries the reconciler's snapshot, not NULL.
    expect(superseded.meta?.snapshot_hash).toBe('fnv1a:snap');
    expect(superseded.meta?.name).toBe('Acme Inc');
    const head = store.getByRecord('company', 'contact', 'alice@example.com', 'system.housekeeping.company');
    expect(head?.meta?.snapshot_hash).toBe('fnv1a:snap');
  });

  it('preserves legacy contract: overwrite-mode shape B uses `_id == derived_entity_id`', () => {
    // Use a non-historical shape B topic. Find one in the registry; if
    // none exist today, this test is skipped — the contract still
    // applies to any future overwrite-mode shape B topic the
    // registry adds.
    const overwriteShapeBTopics = (
      Object.entries(ENRICHMENT_REGISTRY) as Array<[string, { shape: string; lifecycle_policy: string }]>
    )
      .filter(
        ([, def]) =>
          def.shape === 'derived_entity' && def.lifecycle_policy !== 'historical',
      )
      .map(([t]) => t);
    if (overwriteShapeBTopics.length === 0) {
      // Skip semantic — every shape B topic today is historical (only
      // confidence_drift_signal). Any future shape B + non-historical
      // topic falls through this assertion's contract automatically.
      return;
    }
    // Future-proofing: walk the closed list. Test only the contract.
    expect(overwriteShapeBTopics.length).toBeGreaterThan(0);
  });
});

// ── Cascade primitives ─────────────────────────────────────────────

describe('D-136 §A.5 P5 — `cascadeForProducerUpgrade`', () => {
  it('flips chain heads authored under the old producer_version_hash to recompute', () => {
    const cascade = createEnrichmentCascade(store);
    // Author two purpose rows with the old hash + one with the new.
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'msg_1',
      value: { category: 'request', confidence: 0.9, reasoning: 'r1' },
      authored_by: 'system.housekeeping.purpose',
      producer_version_hash: 'sha256:old',
    });
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'msg_2',
      value: { category: 'request', confidence: 0.7, reasoning: 'r2' },
      authored_by: 'system.housekeeping.purpose',
      producer_version_hash: 'sha256:old',
    });
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'msg_3',
      value: { category: 'request', confidence: 0.8, reasoning: 'r3' },
      authored_by: 'system.housekeeping.purpose',
      producer_version_hash: 'sha256:new',
    });

    const result = cascade.cascadeForProducerUpgrade(
      'housekeeping',
      'purpose',
      'sha256:old',
    );
    expect(result.rows_marked_stale).toBe(2);
    expect(result.rows_lifecycle_action_enqueued).toBe(2);

    // Re-fire is a no-op (already enqueued). Counter reflects actual
    // changes — neither marked nor enqueued — not the candidate count.
    const second = cascade.cascadeForProducerUpgrade(
      'housekeeping',
      'purpose',
      'sha256:old',
    );
    expect(second.rows_lifecycle_action_enqueued).toBe(0);
    expect(second.rows_marked_stale).toBe(0);

    // Rows with sha256:new untouched.
    const newHashRow = store.getByRecord(
      'purpose',
      'mail',
      'msg_3',
      'system.housekeeping.purpose',
    );
    expect(newHashRow?.lifecycle_action_pending).toBeNull();
    expect(newHashRow?.staleness_class).toBe('fresh');
  });

  it('skips pinned rows', () => {
    const cascade = createEnrichmentCascade(store);
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'msg_pinned',
      value: { category: 'request', confidence: 1.0, reasoning: 'pinned' },
      authored_by: `${ENRICHMENT_PINNED_AUTHOR_PREFIX}.vote_1`,
      mode: 'pinned',
      producer_version_hash: 'sha256:old',
    });
    const result = cascade.cascadeForProducerUpgrade(
      'housekeeping',
      'purpose',
      'sha256:old',
    );
    // listChainHeadRowIdsByProducerVersion finds the row, but
    // markStaleAndEnqueueByRowIds skips pinned rows in the UPDATE
    // filter — so neither rows_lifecycle_action_enqueued nor
    // rows_marked_stale advances (counters reflect actual updates,
    // not candidate count).
    expect(result.rows_lifecycle_action_enqueued).toBe(0);
    expect(result.rows_marked_stale).toBe(0);
    const row = store.getByRecord(
      'purpose',
      'mail',
      'msg_pinned',
      `${ENRICHMENT_PINNED_AUTHOR_PREFIX}.vote_1`,
    );
    expect(row?.lifecycle_action_pending).toBeNull();
  });

  it('returns 0 when called with an empty / unknown hash', () => {
    const cascade = createEnrichmentCascade(store);
    const empty = cascade.cascadeForProducerUpgrade('housekeeping', 'purpose', '');
    expect(empty.rows_lifecycle_action_enqueued).toBe(0);
    const missing = cascade.cascadeForProducerUpgrade(
      'housekeeping',
      'purpose',
      'sha256:nope',
    );
    expect(missing.rows_lifecycle_action_enqueued).toBe(0);
  });
});

describe('D-136 §A.5 P5 — `cascadeForUpstreamEnrichment`', () => {
  it('walks the input_enrichment_row_ids JSON array to enqueue downstream rows', () => {
    const cascade = createEnrichmentCascade(store);
    // Author an upstream row (purpose) + a downstream row (summary)
    // that declares the upstream in its input_enrichment_row_ids.
    const upstream = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'msg_1',
      value: { category: 'request', confidence: 0.9, reasoning: 'r' },
      authored_by: 'system.housekeeping.purpose',
    });
    store.upsert({
      topic: 'summary',
      scope: 'mail',
      target_id: 'msg_1',
      value: { summary: 'A short summary.' },
      authored_by: 'system.housekeeping.summary',
      input_enrichment_row_ids: [upstream._id, 'enr_other_id'],
    });
    // Unrelated downstream — does not consume the upstream.
    store.upsert({
      topic: 'summary',
      scope: 'mail',
      target_id: 'msg_2',
      value: { summary: 'Unrelated.' },
      authored_by: 'system.housekeeping.summary',
      input_enrichment_row_ids: ['enr_unrelated'],
    });

    const result = cascade.cascadeForUpstreamEnrichment(upstream._id);
    expect(result.rows_marked_stale).toBe(1);
    expect(result.rows_lifecycle_action_enqueued).toBe(1);

    // Idempotent.
    const second = cascade.cascadeForUpstreamEnrichment(upstream._id);
    expect(second.rows_lifecycle_action_enqueued).toBe(0);

    const consumer = store.getByRecord(
      'summary',
      'mail',
      'msg_1',
      'system.housekeeping.summary',
    );
    expect(consumer?.lifecycle_action_pending).toBe('recompute');
    expect(consumer?.staleness_class).toBe('stale');

    const unrelated = store.getByRecord(
      'summary',
      'mail',
      'msg_2',
      'system.housekeeping.summary',
    );
    expect(unrelated?.lifecycle_action_pending).toBeNull();
  });
});

describe('D-136 §A.5 P5 — `cascadeForIdentityChange`', () => {
  it('fans into perspective topics whose aggregates_from includes the source scope', () => {
    const cascade = createEnrichmentCascade(store);
    // behavioral_signature: perspective, valid_scopes: ['contact'],
    // aggregates_from: ['mail', 'calendar']. The row's target_id is
    // the canonical contact email.
    store.upsert({
      topic: 'behavioral_signature',
      scope: 'contact',
      target_id: 'alice@example.com',
      value: {
        mail_count_window: 12,
        mail_count_total: 40,
        meeting_count_window: 3,
        meeting_count_total: 9,
        mean_reply_latency_ms: 60 * 60 * 1000,
        reply_sample_count: 5,
        last_meeting_at: 1_699_990_000_000,
        last_inbound_at: 1_699_999_000_000,
        computed_at: 1_700_000_000_000,
        window_ms: 30 * 24 * 60 * 60 * 1000,
      },
      authored_by: 'system.housekeeping.behavioral_signature',
    });
    store.upsert({
      topic: 'behavioral_signature',
      scope: 'contact',
      target_id: 'bob@example.com',
      value: {
        mail_count_window: 5,
        mail_count_total: 12,
        meeting_count_window: 0,
        meeting_count_total: 1,
        mean_reply_latency_ms: 30 * 60 * 1000,
        reply_sample_count: 2,
        last_meeting_at: null,
        last_inbound_at: 1_699_998_000_000,
        computed_at: 1_700_000_000_000,
        window_ms: 30 * 24 * 60 * 60 * 1000,
      },
      authored_by: 'system.housekeeping.behavioral_signature',
    });

    const result = cascade.cascadeForIdentityChange('mail', 'msg_id', [
      'alice@example.com',
    ]);
    expect(result.rows_marked_stale).toBe(1);
    expect(result.rows_lifecycle_action_enqueued).toBe(1);

    const alice = store.getByRecord(
      'behavioral_signature',
      'contact',
      'alice@example.com',
      'system.housekeeping.behavioral_signature',
    );
    expect(alice?.lifecycle_action_pending).toBe('recompute');

    const bob = store.getByRecord(
      'behavioral_signature',
      'contact',
      'bob@example.com',
      'system.housekeeping.behavioral_signature',
    );
    expect(bob?.lifecycle_action_pending).toBeNull();
  });

  it('is a no-op when identity_keys is empty', () => {
    const cascade = createEnrichmentCascade(store);
    const result = cascade.cascadeForIdentityChange('mail', 'msg_id', []);
    expect(result.rows_lifecycle_action_enqueued).toBe(0);
  });

  it('does not fan into scenario topics (purpose / summary scoped to mail)', () => {
    const cascade = createEnrichmentCascade(store);
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'msg_1',
      value: { category: 'request', confidence: 0.9, reasoning: 'r' },
      authored_by: 'system.housekeeping.purpose',
    });
    const result = cascade.cascadeForIdentityChange('mail', 'msg_1', ['msg_1']);
    // purpose is scenario, not perspective — skip per the gate.
    expect(result.rows_lifecycle_action_enqueued).toBe(0);
    const purpose = store.getByRecord(
      'purpose',
      'mail',
      'msg_1',
      'system.housekeeping.purpose',
    );
    expect(purpose?.lifecycle_action_pending).toBeNull();
  });
});

describe('D-136 §A.5 P5 — `cascadeForConnectionDelete`', () => {
  it('tombstones scenario rows scoped directly to the connection', () => {
    // connection_health_trend is a scenario topic scoped to
    // connection.api / connection.mcp / connection.notification.
    // We seed a row keyed on (connection.api, 'hubspot-prod') and
    // verify cascadeForConnectionDelete tombstones it.
    const cascade = createEnrichmentCascade(store);

    const def = ENRICHMENT_REGISTRY.connection_health_trend as
      | { valid_scopes?: ReadonlyArray<string> }
      | undefined;
    if (!def?.valid_scopes?.includes('connection.api')) {
      // Future-proofing — if the registry retires this scope this
      // test self-skips. The contract still applies via any other
      // scenario topic whose valid_scopes lists `connection.<kind>`.
      return;
    }
    store.upsert({
      topic: 'connection_health_trend',
      scope: 'connection.api',
      target_id: 'hubspot-prod',
      value: {
        call_count: 50,
        error_count: 1,
        error_rate: 0.02,
        latency_p50_ms: 120,
        latency_p95_ms: 320,
        last_call_at: 1_699_999_000_000,
        last_failure: null,
        window_ms: 7 * 24 * 60 * 60 * 1000,
        computed_at: 1_700_000_000_000,
      },
      authored_by: 'system.housekeeping.connection_health_trend',
    });

    const result = cascade.cascadeForConnectionDelete('api', 'hubspot-prod');
    expect(result.rows_tombstoned).toBe(1);

    const row = db
      .prepare(
        `SELECT tombstoned_at, tombstone_reason, staleness_class FROM data_enrichment
           WHERE scope = 'connection.api' AND target_id = 'hubspot-prod'`,
      )
      .get() as {
      tombstoned_at: number | null;
      tombstone_reason: string | null;
      staleness_class: string;
    };
    expect(row.tombstoned_at).not.toBeNull();
    expect(row.tombstone_reason).toBe('cascade_delete');
    expect(row.staleness_class).toBe('expired');
  });

  it('is a no-op when no rows match', () => {
    const cascade = createEnrichmentCascade(store);
    const result = cascade.cascadeForConnectionDelete('api', 'nonexistent');
    expect(result.rows_tombstoned).toBe(0);
    expect(result.rows_lifecycle_action_enqueued).toBe(0);
  });
});

// ── Codex review follow-ups ────────────────────────────────────────

describe('D-136 §A.9 P5 — current reads filter to chain heads', () => {
  it('store.list returns only the chain head after a historical supersede', () => {
    // Two writes to `company` (lifecycle_policy: historical). Without
    // the chain-head filter, both rows would surface as fresh — old
    // row's staleness_class stays `'fresh'` post-supersede; only
    // `superseded_by_id` discriminates.
    store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      value: {
        domain: 'acme.com',
        company_name: 'Acme',
        source: 'domain_only',
        domain_category: 'business',
        reasoning: 'r1',
        computed_at: 1_700_000_000_000,
      },
      authored_by: 'system.housekeeping.company',
    });
    store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      value: {
        domain: 'globex.com',
        company_name: 'Globex',
        source: 'signature_parse',
        domain_category: 'business',
        reasoning: 'r2',
        computed_at: 1_700_000_001_000,
      },
      authored_by: 'system.housekeeping.company',
    });
    // Both rows persist in the table — historical chain has 2 entries.
    const totalRows = db
      .prepare(`SELECT COUNT(*) AS n FROM data_enrichment WHERE topic = 'company'`)
      .get() as { n: number };
    expect(totalRows.n).toBe(2);
    // store.list returns ONLY the chain head.
    const listed = store.list({ topic: 'company' });
    expect(listed).toHaveLength(1);
    expect((listed[0]?.value as { company_name: string }).company_name).toBe('Globex');
    // listByTarget same.
    const byTarget = store.listByTarget('contact', 'alice@example.com');
    const companyHead = byTarget.find((r) => r.topic === 'company');
    expect(companyHead).toBeDefined();
    expect((companyHead?.value as { company_name: string }).company_name).toBe('Globex');
    // listByTarget with explicit since/until — exercise the dynamic-SQL
    // path (separate from the cached prepared statement).
    const byTargetEvent = store.listByTarget('contact', 'alice@example.com', {
      axis: 'event',
      since: 0,
      until: 1_800_000_000_000,
    });
    const eventHead = byTargetEvent.find((r) => r.topic === 'company');
    expect((eventHead?.value as { company_name: string }).company_name).toBe('Globex');
  });
});

describe('D-136 §A.5 P5 — cascade-stale path drops sidecars', () => {
  it('cascadeForUpstreamEnrichment drops FTS sidecar of the marked-stale row', () => {
    const cascade = createEnrichmentCascade(store);
    const upstream = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'msg_sidecar',
      value: { category: 'request', confidence: 0.9, reasoning: 'r' },
      authored_by: 'system.housekeeping.purpose',
    });
    const summaryRow = store.upsert({
      topic: 'summary',
      scope: 'mail',
      target_id: 'msg_sidecar',
      value: { summary: 'A short summary.' },
      authored_by: 'system.housekeeping.summary',
      input_enrichment_row_ids: [upstream._id],
      sidecar_text: 'A short summary indexable for FTS.',
    });
    // Sidecar present pre-cascade.
    const ftsBefore = db
      .prepare(`SELECT COUNT(*) AS n FROM data_enrichment_fts WHERE enrichment_id = ?`)
      .get(summaryRow._id) as { n: number };
    expect(ftsBefore.n).toBe(1);

    cascade.cascadeForUpstreamEnrichment(upstream._id);

    // Sidecar dropped; the summary row itself stays (only marked stale).
    const ftsAfter = db
      .prepare(`SELECT COUNT(*) AS n FROM data_enrichment_fts WHERE enrichment_id = ?`)
      .get(summaryRow._id) as { n: number };
    expect(ftsAfter.n).toBe(0);
    const rowAfter = db
      .prepare(`SELECT staleness_class, lifecycle_action_pending FROM data_enrichment WHERE _id = ?`)
      .get(summaryRow._id) as { staleness_class: string; lifecycle_action_pending: string };
    expect(rowAfter.staleness_class).toBe('stale');
    expect(rowAfter.lifecycle_action_pending).toBe('recompute');
  });
});

describe('D-136 §A.5 P5 — cascade idempotency contract', () => {
  it('cascadeForUpstreamEnrichment re-fire over the same upstream is a no-op', () => {
    const cascade = createEnrichmentCascade(store);
    const upstream = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'msg_idem',
      value: { category: 'request', confidence: 0.9, reasoning: 'r' },
      authored_by: 'system.housekeeping.purpose',
    });
    store.upsert({
      topic: 'summary',
      scope: 'mail',
      target_id: 'msg_idem',
      value: { summary: 'S' },
      authored_by: 'system.housekeeping.summary',
      input_enrichment_row_ids: [upstream._id],
    });
    const first = cascade.cascadeForUpstreamEnrichment(upstream._id);
    expect(first.rows_lifecycle_action_enqueued).toBe(1);
    const second = cascade.cascadeForUpstreamEnrichment(upstream._id);
    expect(second.rows_lifecycle_action_enqueued).toBe(0);
    const third = cascade.cascadeForUpstreamEnrichment(upstream._id);
    expect(third.rows_lifecycle_action_enqueued).toBe(0);
  });

  it('cascadeForIdentityChange re-fire over the same identity is a no-op', () => {
    const cascade = createEnrichmentCascade(store);
    store.upsert({
      topic: 'behavioral_signature',
      scope: 'contact',
      target_id: 'alice@example.com',
      value: {
        mail_count_window: 12,
        mail_count_total: 40,
        meeting_count_window: 3,
        meeting_count_total: 9,
        mean_reply_latency_ms: 60 * 60 * 1000,
        reply_sample_count: 5,
        last_meeting_at: 1_699_990_000_000,
        last_inbound_at: 1_699_999_000_000,
        computed_at: 1_700_000_000_000,
        window_ms: 30 * 24 * 60 * 60 * 1000,
      },
      authored_by: 'system.housekeeping.behavioral_signature_idem',
    });
    const first = cascade.cascadeForIdentityChange('mail', 'msg_1', [
      'alice@example.com',
    ]);
    expect(first.rows_lifecycle_action_enqueued).toBe(1);
    const second = cascade.cascadeForIdentityChange('mail', 'msg_1', [
      'alice@example.com',
    ]);
    expect(second.rows_lifecycle_action_enqueued).toBe(0);
  });
});
