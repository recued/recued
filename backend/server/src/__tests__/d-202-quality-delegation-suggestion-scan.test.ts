/** D-202 Slice 1 — the reject-driven quality LEARNER end-to-end through the REAL
 *  contract substrate (real better-sqlite3 + the `quality_delegation_signal` /
 *  `quality_delegation_suggestion` value-shape validation): seed verdict signals →
 *  run the `quality-delegation-suggestion-scan` housekeeping task → assert the
 *  upserted suggestion. Also proves the signal-store round-trip + the
 *  quality-delegation suppression join (live + revoked). Spec §2 / §6 / §8. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  D165_CONTRACT_SCHEMA,
  qualityDelegationSignalKey,
  qualityDelegationSuggestionKeyHash,
  type ContractScope,
  type HousekeepingCursor,
  type QualityDelegationSignal,
} from '@recued/contracts';

import { buildQualityDelegationSuggestionScanTask } from '../housekeeping/tasks/quality-delegation-suggestion-scan.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import {
  createContractDefinitionStore,
  type ContractDefinitionStore,
} from '../storage/contract-definition-store.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import {
  createQualityDelegationSignalStore,
  type QualityDelegationSignalStore,
} from '../storage/quality-delegation-signal-store.js';
import {
  createQualityDelegationSuggestionStore,
  type QualityDelegationSuggestionStore,
} from '../storage/quality-delegation-suggestion-store.js';

const NOW = 1_800_100_000_000;

let db: Database.Database;
let store: ContractStore;
let defStore: ContractDefinitionStore;
let signalStore: QualityDelegationSignalStore;
let suggestionStore: QualityDelegationSuggestionStore;
let idSeq: number;

const makeSeqId = (): string => {
  idSeq += 1;
  return `ct_${idSeq}`;
};

/** The (recipe, op) every signal below shares — no op (coarse whole-ingredient). */
const KEY = { recipe_id: 'recipe-1', recipe_hash: 'recipe-hash-1', ingredient_id: 'mail.send' };
const KEY_HASH = qualityDelegationSuggestionKeyHash(KEY);

let sigSeq = 0;
const appendSignal = (
  reason: QualityDelegationSignal['reason'],
  at: number,
  channel_session_id: string,
): QualityDelegationSignal => {
  sigSeq += 1;
  const signal: QualityDelegationSignal = {
    signal_id: `sig_${sigSeq}`,
    ...KEY,
    channel_session_id,
    reason,
    at,
    audit_ref: `run_${sigSeq}`,
  };
  signalStore.append(signal);
  return signal;
};

const approveAcrossSessions = (n: number): void => {
  for (let i = 0; i < n; i += 1) {
    appendSignal('quality_good', NOW - (n - i) * 1_000, `session-${i}`);
  }
};

/** Mint a real quality delegation on KEY (no op axis, matching the signal key). */
const scope = (): ContractScope => ({ actors: ['user_self'], ingredient_ids: ['mail.send'] });
const mintDelegationOnKey = () =>
  defStore.mintQualityDelegation({
    minted_by: 'owner:user-1',
    display_name: 'Auto-accept',
    scope: scope(),
    bound_recipe: { recipe_id: 'recipe-1', recipe_hash: 'recipe-hash-1' },
    approved_action_ref: 'accepted-suggestion',
  });

const taskCtx = (): HousekeepingContext =>
  ({ db, now: () => NOW, emitAuditRow: () => undefined } as unknown as HousekeepingContext);

const runScan = (cursor: HousekeepingCursor = { kind: 'time', last_seen_at: 0 }, budget_ms = 1_000) =>
  buildQualityDelegationSuggestionScanTask({ signalStore, definitionStore: defStore, suggestionStore }).step(
    taskCtx(),
    cursor,
    budget_ms,
  );

beforeEach(() => {
  db = new Database(':memory:');
  idSeq = 0;
  sigSeq = 0;
  store = createContractStore(db, { now: () => NOW });
  store.seedSchema(D165_CONTRACT_SCHEMA);
  defStore = createContractDefinitionStore(store, { now: () => NOW, newId: makeSeqId });
  signalStore = createQualityDelegationSignalStore(store);
  suggestionStore = createQualityDelegationSuggestionStore(store, { now: () => NOW });
});

afterEach(() => {
  db.close();
});

describe('quality-delegation-signal-store round-trip', () => {
  it('appends and lists a verdict verbatim through the real value_shape', () => {
    const s = appendSignal('quality_good', NOW - 1_000, 'session-x');
    expect(signalStore.list()).toEqual([s]);
    // Key projection agrees with the shared KEY.
    expect(qualityDelegationSignalKey(s)).toEqual(KEY);
  });

  it('keys by signal_id — a re-append of the same id overwrites, never duplicates', () => {
    appendSignal('quality_good', NOW - 1_000, 'session-x'); // sig_1
    sigSeq = 0; // force the next append to reuse sig_1
    appendSignal('quality_good', NOW - 500, 'session-y');
    expect(signalStore.list()).toHaveLength(1);
  });
});

describe('quality-delegation-suggestion-scan — reject-driven learner', () => {
  it('upserts a suggestion once THRESHOLD default-reason approves span THRESHOLD sessions', async () => {
    approveAcrossSessions(3);
    const result = await runScan();
    expect(result.status).toBe('complete');

    const row = suggestionStore.get(KEY_HASH);
    expect(row).not.toBeNull();
    expect(row?.state).toBe('open');
    expect(row?.snapshot).toEqual(KEY);
    expect(row?.evidence.approve_count).toBe(3);
    expect(row?.evidence.distinct_session_count).toBe(3);
    // newest-first, audit_ref preferred (at NOW-1000 → run_3, then NOW-2000, NOW-3000).
    expect(row?.evidence.sample_refs).toEqual(['run_3', 'run_2', 'run_1']);
  });

  it('does not suggest below the threshold', async () => {
    approveAcrossSessions(2);
    await runScan();
    expect(suggestionStore.get(KEY_HASH)).toBeNull();
  });

  it('does not suggest when the newest verdict is a reject (knockdown)', async () => {
    approveAcrossSessions(3);
    appendSignal('quality_bad', NOW - 100, 'session-r'); // newest → knocks down
    await runScan();
    expect(suggestionStore.get(KEY_HASH)).toBeNull();
  });

  it('is idempotent — a second run leaves the open row unchanged', async () => {
    approveAcrossSessions(3);
    await runScan();
    const first = suggestionStore.get(KEY_HASH);
    expect(first).not.toBeNull();
    await runScan();
    // updated_at unchanged (upsertOpen returned 'unchanged' — same snapshot+evidence).
    expect(suggestionStore.get(KEY_HASH)?.updated_at).toBe(first?.updated_at);
  });

  it('suppresses the suggestion when a LIVE quality delegation already owns the key', async () => {
    approveAcrossSessions(3);
    mintDelegationOnKey(); // already operating — a suggestion would be noise
    await runScan();
    expect(suggestionStore.get(KEY_HASH)).toBeNull();
  });

  it('suppresses the suggestion when a REVOKED quality delegation owns the key (durable distrust)', async () => {
    approveAcrossSessions(3);
    const minted = mintDelegationOnKey();
    defStore.revoke(minted.contract_id, 'owner turned it off');
    await runScan();
    expect(suggestionStore.get(KEY_HASH)).toBeNull();
  });

  it('does NOT over-suppress: a delegation on a DIFFERENT key leaves this suggestion intact', async () => {
    approveAcrossSessions(3); // qualifies KEY (recipe-1)
    // A live quality delegation on an unrelated recipe must not touch this key.
    defStore.mintQualityDelegation({
      minted_by: 'owner:user-1',
      display_name: 'Auto-accept (other recipe)',
      scope: scope(),
      bound_recipe: { recipe_id: 'recipe-2', recipe_hash: 'recipe-hash-2' },
      approved_action_ref: 'other-accept',
    });
    await runScan();
    expect(suggestionStore.get(KEY_HASH)).not.toBeNull();
  });

  it('completes cleanly with no signals', async () => {
    const result = await runScan();
    expect(result.status).toBe('complete');
    expect(suggestionStore.list()).toEqual([]);
  });

  it('yields on an exhausted budget and resumes to cover every group', async () => {
    // Two qualifying (recipe, op) groups.
    approveAcrossSessions(3); // recipe-1 (KEY)
    const KEY2 = { recipe_id: 'recipe-2', recipe_hash: 'recipe-hash-2', ingredient_id: 'mail.send' };
    const KEY2_HASH = qualityDelegationSuggestionKeyHash(KEY2);
    for (let i = 0; i < 3; i += 1) {
      signalStore.append({
        signal_id: `sig2_${i}`,
        ...KEY2,
        channel_session_id: `k2-session-${i}`,
        reason: 'quality_good',
        at: NOW - (3 - i) * 1_000,
      });
    }

    // A moving clock so the per-group budget check trips after the FIRST group:
    // start=NOW; iter1 now=NOW+100 (Δ100<150 → process 1st); iter2 now=NOW+200
    // (Δ200≥150 → yield). Absolute value stays ≈ NOW so the lookback window holds.
    let clock = NOW;
    const movingCtx = (): HousekeepingContext =>
      ({
        db,
        now: () => {
          const t = clock;
          clock += 100;
          return t;
        },
        emitAuditRow: () => undefined,
      } as unknown as HousekeepingContext);
    const task = buildQualityDelegationSuggestionScanTask({
      signalStore,
      definitionStore: defStore,
      suggestionStore,
    });

    const first = await task.step(movingCtx(), { kind: 'time', last_seen_at: 0 }, 150);
    expect(first.status).toBe('yield');
    // Exactly one of the two groups upserted so far (the budget stopped the walk).
    const madeAfterFirst = [KEY_HASH, KEY2_HASH].filter((h) => suggestionStore.get(h) !== null);
    expect(madeAfterFirst).toHaveLength(1);

    // Resume from the yield cursor (a `topic` cursor carrying the last hash) with a
    // generous budget — it skips the already-processed head group and covers the rest.
    clock = NOW;
    const second = await task.step(movingCtx(), first.cursor, 100_000);
    expect(second.status).toBe('complete');
    expect(suggestionStore.get(KEY_HASH)).not.toBeNull();
    expect(suggestionStore.get(KEY2_HASH)).not.toBeNull();
  });
});
