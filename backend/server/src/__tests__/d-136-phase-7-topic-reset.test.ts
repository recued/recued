/** D-136 P7 — `housekeeping.topic.reset` rpc tests.
 *
 *  Two-step dry-run-then-confirm pattern per §A.12:
 *    1. First call (no `confirmation_token`) returns impact summary +
 *       freshly-minted token.
 *    2. Second call with that token tombstones every non-pinned chain-
 *       head row matching `(topic, scope_filter?)`, drops sidecars
 *       synchronously per audit §10.2, sets `lifecycle_action_pending
 *       = 'recompute'` so the next housekeeping cycle re-derives.
 *    3. When `reset_psi_baselines === true` (default for emits_confidence
 *       topics), `confidence_drift_signal` rows are dropped.
 *    4. Confirm path emits an audit row through `auditLog.logActivity`.
 *
 *  Token semantics:
 *    - Single-use: re-applying with the same token rejects.
 *    - TTL-bound: expired tokens reject.
 *    - Bound to (topic, scope_filter, reset_psi_baselines, voted_by_client_id):
 *      arg-tamper between dry-run + confirm rejects.
 *    - Cross-paired-client confirm rejects. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcError } from '@recued/contracts';

import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import {
  _test_clearTopicResetTokenStore,
  handleHousekeepingTopicReset,
} from '../housekeeping-handler.js';
import type { HousekeepingRpcDeps } from '../housekeeping-handler.js';

const NOW_BASE = 1_750_000_000_000;

/** §A.12 P7.B Codex review #1 — handler now requires a registered
 *  paired client. The helper builds the canonical caller shape for
 *  the happy-path tests; bypass-tests construct their own. */
const exec = (instance_id: string) =>
  ({ instance_id });

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;
let now: () => number;
let nowSetter: (delta: number) => void;
let auditEntries: Array<{ action: string; target: string; detail: string }>;
let deps: HousekeepingRpcDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-p7-reset-'));
  db = new Database(join(dir, 'test.db'));
  let nowOffset = 0;
  now = (): number => NOW_BASE + nowOffset;
  nowSetter = (delta: number) => {
    nowOffset = delta;
  };
  store = createEnrichmentStore(db, { now });
  auditEntries = [];
  deps = {
    config: undefined as never,
    state: undefined as never,
    registry: () => [],
    runOnce: async () => ({ duration_ms: 0, tasks_stepped: [], yield_reasons: [] } as never),
    enrichmentStore: store,
    auditLog: {
      logActivity: async (entry: { action: string; target?: string; detail?: string }) => {
        auditEntries.push({
          action: entry.action,
          target: entry.target ?? '',
          detail: entry.detail ?? '',
        });
      },
    } as never,
    now,
  };
  _test_clearTopicResetTokenStore();
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  _test_clearTopicResetTokenStore();
});

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const writePurposeRows = (count: number, scope = 'mail' as const) => {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = store.upsert({
      topic: 'purpose',
      scope,
      target_id: `${scope}_${i}`,
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.7 },
      event_at: NOW_BASE - 60_000,
    });
    ids.push(r._id);
  }
  return ids;
};

const writePinnedRow = (target_id: string) =>
  store.upsert({
    topic: 'purpose',
    scope: 'mail',
    target_id,
    authored_by: `system.user_correction.vote_pinned_${target_id}`,
    value: { purpose: 'demo_request', confidence: 1 },
    event_at: NOW_BASE - 30_000,
    mode: 'pinned',
  });

const writeDriftBaseline = (source_topic: string) =>
  store.upsert({
    topic: 'confidence_drift_signal',
    derived_entity_id: source_topic,
    authored_by: 'system.housekeeping.confidence_drift_signal',
    value: {
      source_topic,
      severity: 'none',
      psi: 0.05,
      baseline_window: {
        start_at: NOW_BASE - 30 * 86_400_000,
        end_at: NOW_BASE - 7 * 86_400_000,
        sample_count: 200,
      },
      recent_window: {
        start_at: NOW_BASE - 7 * 86_400_000,
        end_at: NOW_BASE - 12_000,
        sample_count: 100,
      },
      baseline_distribution: [0.5, 0.5],
      recent_distribution: [0.5, 0.5],
      computed_at: NOW_BASE - 12_000,
    },
    as_of: NOW_BASE - 12_000,
    event_at: NOW_BASE - 12_000,
  });

// ────────────────────────────────────────────────────────────────
// 1. Dry-run path
// ────────────────────────────────────────────────────────────────

describe('handleHousekeepingTopicReset — dry-run', () => {
  it('mints a confirmation token + reports impact summary; no side effects', async () => {
    writePurposeRows(3);

    const out = await handleHousekeepingTopicReset(
      deps,
      { topic: 'purpose', scope_filter: 'mail' },
      exec('inst-laptop'),
    );

    expect(out.applied).toBe(false);
    expect(out.confirmation_token).toMatch(/^reset_/);
    expect(out.expires_at).toBeGreaterThan(NOW_BASE);
    expect(out.topic).toBe('purpose');
    expect(out.scope_filter).toBe('mail');
    expect(out.impact.rows_to_tombstone).toBe(3);
    expect(out.impact.pinned_protected).toBe(0);
    expect(out.impact.estimated_recompute_tokens).toBe(3 * 200);

    // No side effects: rows stay fresh + LAP-null.
    const rows = store.list({ topic: 'purpose', limit: 10 });
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.staleness_class).toBe('fresh');
      expect(r.lifecycle_action_pending).toBeNull();
      expect(r.tombstoned_at).toBeNull();
    }
  });

  it('reports pinned_protected separately; pinned rows excluded from rows_to_tombstone', async () => {
    writePurposeRows(3);
    writePinnedRow('mail_pinned_a');
    writePinnedRow('mail_pinned_b');

    const out = await handleHousekeepingTopicReset(
      deps,
      { topic: 'purpose', scope_filter: 'mail' },
      exec('inst-laptop'),
    );

    expect(out.impact.rows_to_tombstone).toBe(3);
    expect(out.impact.pinned_protected).toBe(2);
  });

  it('reports psi_baselines_to_drop when reset_psi_baselines defaults true (emits_confidence)', async () => {
    writePurposeRows(2);
    // `purpose` emits_confidence per the registry.
    writeDriftBaseline('purpose');
    writeDriftBaseline('purpose'); // historical chain — both rows visible to count

    const out = await handleHousekeepingTopicReset(
      deps,
      { topic: 'purpose', scope_filter: 'mail' },
      exec('inst-laptop'),
    );

    expect(out.reset_psi_baselines).toBe(true);
    expect(out.impact.psi_baselines_to_drop).toBeGreaterThanOrEqual(1);
  });

  it('explicit reset_psi_baselines=false suppresses the baseline drop', async () => {
    writePurposeRows(2);
    writeDriftBaseline('purpose');

    const out = await handleHousekeepingTopicReset(
      deps,
      { topic: 'purpose', scope_filter: 'mail', reset_psi_baselines: false },
      exec('inst-laptop'),
    );

    expect(out.reset_psi_baselines).toBe(false);
    expect(out.impact.psi_baselines_to_drop).toBe(0);
  });

  it('rejects unknown topic with bad_request', async () => {
    await expect(
      handleHousekeepingTopicReset(
        deps,
        { topic: 'this_topic_does_not_exist' },
        exec('inst-laptop'),
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects invalid scope_filter with bad_request', async () => {
    await expect(
      handleHousekeepingTopicReset(
        deps,
        { topic: 'purpose', scope_filter: 'invalid_scope' as never },
        exec('inst-laptop'),
      ),
    ).rejects.toThrow(/invalid scope_filter/);
  });

  it('rejects when enrichment store is not wired (deps.enrichmentStore undefined)', async () => {
    const noStoreDeps: HousekeepingRpcDeps = { ...deps, enrichmentStore: undefined };
    await expect(
      handleHousekeepingTopicReset(
        noStoreDeps,
        { topic: 'purpose' },
        exec('inst-laptop'),
      ),
    ).rejects.toThrow(/enrichment store not wired/);
  });
});

// ────────────────────────────────────────────────────────────────
// 1b. §A.12 P7.B Codex review #1 — paired-client + write-tier gate
// ────────────────────────────────────────────────────────────────

describe('handleHousekeepingTopicReset — caller permission gate', () => {
  it('rejects unregistered (instance_id null) callers with permission_denied', async () => {
    writePurposeRows(1);
    await expect(
      handleHousekeepingTopicReset(
        deps,
        { topic: 'purpose', scope_filter: 'mail' },
        { instance_id: null },
      ),
    ).rejects.toThrow(/requires a paired client/);
  });

  it('rejects undefined caller (no client envelope) with permission_denied', async () => {
    writePurposeRows(1);
    await expect(
      handleHousekeepingTopicReset(
        deps,
        { topic: 'purpose', scope_filter: 'mail' },
        undefined,
      ),
    ).rejects.toThrow(/requires a paired client/);
  });

  it('paired-client gate fires before topic resolution', async () => {
    // The gate should fire even when the topic is invalid — caller
    // identity is checked first so an unregistered call doesn't
    // leak the topic-validation error code.
    await expect(
      handleHousekeepingTopicReset(
        deps,
        { topic: 'definitely_not_a_real_topic' },
        { instance_id: null },
      ),
    ).rejects.toThrow(/requires a paired client/);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. Confirm path
// ────────────────────────────────────────────────────────────────

describe('handleHousekeepingTopicReset — confirm', () => {
  it('valid token tombstones rows + enqueues recompute + drops PSI baselines + emits audit', async () => {
    const ids = writePurposeRows(3);
    writeDriftBaseline('purpose');

    const dry = await handleHousekeepingTopicReset(
      deps,
      { topic: 'purpose', scope_filter: 'mail' },
      exec('inst-laptop'),
    );

    const confirm = await handleHousekeepingTopicReset(
      deps,
      {
        topic: 'purpose',
        scope_filter: 'mail',
        confirmation_token: dry.confirmation_token!,
      },
      exec('inst-laptop'),
    );

    expect(confirm.applied).toBe(true);
    expect(confirm.confirmation_token).toBeNull();
    expect(confirm.expires_at).toBeNull();
    expect(confirm.applied_summary.rows_tombstoned).toBe(3);
    expect(confirm.applied_summary.rows_recompute_enqueued).toBe(3);
    expect(confirm.applied_summary.psi_baselines_dropped).toBeGreaterThanOrEqual(1);
    expect(confirm.applied_summary.pinned_skipped).toBe(0);

    // Each row tombstoned + LAP=recompute set.
    for (const id of ids) {
      const row = store.getById(id)!;
      expect(row.tombstoned_at).toBe(NOW_BASE);
      expect(row.tombstone_reason).toBe('user_discarded');
      expect(row.staleness_class).toBe('expired');
      expect(row.lifecycle_action_pending).toBe('recompute');
      expect(row.value).toBeNull();
    }

    // Audit row landed.
    expect(auditEntries.length).toBe(1);
    expect(auditEntries[0]!.action).toBe('housekeeping_topic_reset');
    expect(auditEntries[0]!.target).toBe('purpose');
    expect(auditEntries[0]!.detail).toContain('tombstoned=3');
  });

  it('pinned rows are skipped; pinned_skipped counter populated', async () => {
    writePurposeRows(2);
    const pinned = writePinnedRow('mail_pinned');

    const dry = await handleHousekeepingTopicReset(
      deps,
      { topic: 'purpose', scope_filter: 'mail' },
      exec('inst-laptop'),
    );
    const confirm = await handleHousekeepingTopicReset(
      deps,
      {
        topic: 'purpose',
        scope_filter: 'mail',
        confirmation_token: dry.confirmation_token!,
      },
      exec('inst-laptop'),
    );

    expect(confirm.applied_summary.rows_tombstoned).toBe(2);
    expect(confirm.applied_summary.pinned_skipped).toBe(1);

    const stillPinned = store.getById(pinned._id)!;
    expect(stillPinned.tombstoned_at).toBeNull();
    expect(stillPinned.is_pinned).toBe(true);
    expect(stillPinned.lifecycle_action_pending).toBeNull();
  });

  it('reset_psi_baselines=false leaves drift baselines intact', async () => {
    writePurposeRows(2);
    const baseline = writeDriftBaseline('purpose');

    const dry = await handleHousekeepingTopicReset(
      deps,
      { topic: 'purpose', reset_psi_baselines: false },
      exec('inst-laptop'),
    );
    const confirm = await handleHousekeepingTopicReset(
      deps,
      {
        topic: 'purpose',
        reset_psi_baselines: false,
        confirmation_token: dry.confirmation_token!,
      },
      exec('inst-laptop'),
    );

    expect(confirm.applied_summary.psi_baselines_dropped).toBe(0);
    const stillThere = store.getById(baseline._id);
    expect(stillThere).toBeTruthy();
  });

  it('omitting scope_filter resets every scope', async () => {
    writePurposeRows(2, 'mail');
    // `purpose` is per_record on `mail` only — but a bare reset
    // covers every chain head regardless of scope.
    const dry = await handleHousekeepingTopicReset(
      deps,
      { topic: 'purpose' },
      exec('inst-laptop'),
    );
    expect(dry.scope_filter).toBeNull();
    expect(dry.impact.rows_to_tombstone).toBe(2);

    const confirm = await handleHousekeepingTopicReset(
      deps,
      { topic: 'purpose', confirmation_token: dry.confirmation_token! },
      exec('inst-laptop'),
    );
    expect(confirm.applied).toBe(true);
    expect(confirm.applied_summary.rows_tombstoned).toBe(2);
  });

  it('idempotent on re-run after confirm — second dry-run sees zero matches', async () => {
    writePurposeRows(2);
    const dry1 = await handleHousekeepingTopicReset(
      deps,
      { topic: 'purpose', scope_filter: 'mail' },
      exec('inst-laptop'),
    );
    await handleHousekeepingTopicReset(
      deps,
      {
        topic: 'purpose',
        scope_filter: 'mail',
        confirmation_token: dry1.confirmation_token!,
      },
      exec('inst-laptop'),
    );
    // Now everything is tombstoned; a fresh dry-run should report zero
    // rows to tombstone.
    const dry2 = await handleHousekeepingTopicReset(
      deps,
      { topic: 'purpose', scope_filter: 'mail' },
      exec('inst-laptop'),
    );
    expect(dry2.impact.rows_to_tombstone).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. Token semantics
// ────────────────────────────────────────────────────────────────

describe('handleHousekeepingTopicReset — token semantics', () => {
  it('reusing a token rejects (single-use)', async () => {
    writePurposeRows(1);
    const dry = await handleHousekeepingTopicReset(
      deps,
      { topic: 'purpose', scope_filter: 'mail' },
      exec('inst-laptop'),
    );
    await handleHousekeepingTopicReset(
      deps,
      {
        topic: 'purpose',
        scope_filter: 'mail',
        confirmation_token: dry.confirmation_token!,
      },
      exec('inst-laptop'),
    );
    await expect(
      handleHousekeepingTopicReset(
        deps,
        {
          topic: 'purpose',
          scope_filter: 'mail',
          confirmation_token: dry.confirmation_token!,
        },
        exec('inst-laptop'),
      ),
    ).rejects.toThrow(/unknown or expired/);
  });

  it('expired token rejects', async () => {
    writePurposeRows(1);
    const dry = await handleHousekeepingTopicReset(
      deps,
      { topic: 'purpose', scope_filter: 'mail' },
      exec('inst-laptop'),
    );
    // Push the clock past the TTL window (5 minutes default).
    nowSetter(6 * 60_000);

    await expect(
      handleHousekeepingTopicReset(
        deps,
        {
          topic: 'purpose',
          scope_filter: 'mail',
          confirmation_token: dry.confirmation_token!,
        },
        exec('inst-laptop'),
      ),
    ).rejects.toThrow(/unknown or expired/);
  });

  it('arg-tamper on confirm rejects (topic / scope / psi differ from dry-run)', async () => {
    writePurposeRows(1);
    const dry = await handleHousekeepingTopicReset(
      deps,
      { topic: 'purpose', scope_filter: 'mail' },
      exec('inst-laptop'),
    );

    // Try to confirm with a different scope_filter.
    await expect(
      handleHousekeepingTopicReset(
        deps,
        {
          topic: 'purpose',
          // scope_filter omitted on confirm — different from dry-run
          confirmation_token: dry.confirmation_token!,
        },
        exec('inst-laptop'),
      ),
    ).rejects.toThrow(/arg mismatch/);
  });

  it('cross-paired-client confirm rejects', async () => {
    writePurposeRows(1);
    const dry = await handleHousekeepingTopicReset(
      deps,
      { topic: 'purpose', scope_filter: 'mail' },
      exec('inst-laptop'),
    );

    await expect(
      handleHousekeepingTopicReset(
        deps,
        {
          topic: 'purpose',
          scope_filter: 'mail',
          confirmation_token: dry.confirmation_token!,
        },
        exec('inst-phone'),
      ),
    ).rejects.toThrow(/different paired client/);
  });

  it('unknown token (never minted) rejects with unknown_or_expired', async () => {
    await expect(
      handleHousekeepingTopicReset(
        deps,
        {
          topic: 'purpose',
          confirmation_token: 'reset_invented_for_test',
        },
        exec('inst-laptop'),
      ),
    ).rejects.toThrow(/unknown or expired/);
  });
});
