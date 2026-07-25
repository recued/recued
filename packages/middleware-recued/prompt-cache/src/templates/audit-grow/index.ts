/** D-164 P4h — `templates/audit-grow/` public surface.
 *
 *  Aggregates the user-grown template substrate. The audit-grow
 *  family parallels `bundle/` (recued.com-distributed) — both end
 *  up as `TemplatePool` instances the library aggregates, but
 *  audit-grown templates start life as user-promoted shapes drawn
 *  from past successful executions in the action history.
 *
 *  P4h is sliced like P4g:
 *    - **P4h-1 promotion counter** — `./promotion.ts` tracks N-repeat
 *      shape candidates so the Kitchen UI knows when to surface a
 *      "save this as a template?" suggestion.
 *    - **P4h-2/3 replayability** — `./replayability/{structural,diff}.ts`
 *      determine whether a candidate is render-template-eligible
 *      (deterministic step shape, stable LLM I/O) or structural-
 *      plan-only.
 *    - **P4h-4 validator + in-memory pool** — `./validate.ts` enforces
 *      `render_template ⇒ deterministic-only` at registration (the
 *      gate referenced by P4h-2's module header);
 *      `createAuditGrowPool({entries})` builds an in-memory pool
 *      from a static entry list (used at construction time + by
 *      tests that don't need persistence).
 *    - **P4h-4b/5 store + adapter** (this slice) — `./store.ts`
 *      gives a per-pair atomic-write FS store (`AuditGrowStore`)
 *      with `current` / `put` / `subscribe`; this barrel adds
 *      `createStoreBackedAuditGrowFactory({store, onPoolError?})`
 *      which builds a live `TemplatePool` whose `list()` reflects
 *      the store's latest snapshot. Unlike bundle's
 *      `createStoreBackedFetcher` (which feeds a one-shot
 *      `createBundlePool`), the audit-grow adapter swaps the pool's
 *      backing entry list on every store update so user-promoted
 *      templates appear in the gate without library / boot
 *      rebuilds. Live-rebuild validation failures flow through
 *      `onPoolError`; the prior frozen list is preserved.
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md
 *  § 1 templates/audit-grow / O-6 (user-promoted only). */

import type { RegisteredTemplate, TemplatePool } from '../library.js';
import type { RenderTemplate, StructuralPlan } from '../../types.js';

import {
  validateAuditGrowEntry,
  type AuditGrowEntryInput,
  type AuditGrowInvalidReason,
} from './validate.js';
import type { AuditGrowSnapshot, AuditGrowStore } from './store.js';

export {
  composePromotionKey,
  createPromotionTracker,
  DEFAULT_PROMOTION_THRESHOLD,
  type CreatePromotionTrackerOptions,
  type PromotionKeyInput,
  type PromotionTracker,
} from './promotion.js';

export {
  classifyReplayability,
  DETERMINISTIC_STEP_KINDS,
  isDeterministicStepKind,
  type ClassifyReplayabilityInput,
  type DeterministicStepKind,
  type ReplayabilityClassification,
} from './replayability/structural.js';

export {
  classifyReplayDiff,
  DEFAULT_NOVEL_TOKEN_MIN_LENGTH,
  type ClassifyDiffInput,
  type DiffClassification,
  type DiffKind,
} from './replayability/diff.js';

export {
  validateAuditGrowEntry,
  type AuditGrowEntryAccepted,
  type AuditGrowEntryInput,
  type AuditGrowInvalidReason,
  type AuditGrowValidation,
} from './validate.js';

export {
  AuditGrowStoreError,
  createFileAuditGrowStore,
  parseAuditGrowSnapshot,
  type AuditGrowSnapshot,
  type AuditGrowStore,
  type AuditGrowStoreErrorReason,
  type AuditGrowStoreListener,
  type CreateFileAuditGrowStoreOptions,
} from './store.js';

// Adapter + lifecycle types defined later in this file; re-exported here
// alongside the underlying store surface so the barrel reads top-down.
// (Definitions live below `createAuditGrowPool`.)

/** Stable pool-name string the library exposes in its iteration order
 *  diagnostics. Exported so callers (boot wiring, tests) can match on
 *  the literal rather than re-typing the string. Mirrors
 *  `BUNDLE_POOL_NAME` from the bundle pool. */
export const AUDIT_GROW_POOL_NAME = 'audit-grown';

/** Reasons surfaced via `AuditGrowPoolError.failures`. Includes every
 *  `AuditGrowInvalidReason` plus the pool-factory-owned
 *  `entry_unprocessable` for unexpected validator throws. Mirrors
 *  `BundlePoolFailureReason`. */
export type AuditGrowPoolFailureReason =
  | AuditGrowInvalidReason
  | 'entry_unprocessable';

/** Per-entry failure record carried in the aggregate error. The
 *  ordinal `index` is the entry's position in the caller's input
 *  array so the caller can correlate failures back to source data
 *  without re-running the validator. Mirrors
 *  `BundlePoolEntryFailure`. */
export interface AuditGrowPoolEntryFailure {
  readonly index: number;
  readonly reason: AuditGrowPoolFailureReason;
  readonly detail: string;
}

/** Thrown by `createAuditGrowPool` when one or more entries fail
 *  validation. Carries every failure; the caller decides how to
 *  surface (boot log, structured trace, Kitchen UI list). The
 *  free-form `message` is a per-failure summary capped at
 *  `MESSAGE_MAX_FAILURES` rendered rows so unbounded failure lists
 *  don't blow log lines. Mirrors `BundlePoolError`. */
export class AuditGrowPoolError extends Error {
  readonly failures: ReadonlyArray<AuditGrowPoolEntryFailure>;

  constructor(failures: ReadonlyArray<AuditGrowPoolEntryFailure>) {
    super(buildAuditGrowPoolErrorMessage(failures));
    this.name = 'AuditGrowPoolError';
    this.failures = failures;
  }
}

/** Max per-failure rows rendered into the human message. Failures
 *  beyond this count get a trailing `... and N more` summary; the
 *  full list always lives on `error.failures`. Mirrors bundle. */
const MESSAGE_MAX_FAILURES = 10;

const buildAuditGrowPoolErrorMessage = (
  failures: ReadonlyArray<AuditGrowPoolEntryFailure>,
): string => {
  const shown = failures.slice(0, MESSAGE_MAX_FAILURES);
  const lines = shown.map(
    (f) => `  [${f.index}] ${f.reason}: ${JSON.stringify(f.detail)}`,
  );
  const overflow = failures.length - shown.length;
  if (overflow > 0) lines.push(`  ... and ${overflow} more`);
  const header = `audit-grow pool: ${failures.length} invalid entr${
    failures.length === 1 ? 'y' : 'ies'
  }`;
  return `${header}\n${lines.join('\n')}`;
};

export interface CreateAuditGrowPoolOptions {
  readonly entries: ReadonlyArray<AuditGrowEntryInput>;
}

/** Deep-freeze an accepted entry — entry object → template → template's
 *  `slot_grammar`. The library + gate receive a fully-immutable
 *  snapshot. Mirrors the bundle pool's freeze helper. */
const freezeEntry = (
  template: RenderTemplate | StructuralPlan,
  locale: string,
): RegisteredTemplate => {
  const grammarCopy: ReadonlyArray<(typeof template.slot_grammar)[number]> =
    Object.freeze([...template.slot_grammar]);
  const frozenTemplate = Object.freeze({
    ...template,
    slot_grammar: grammarCopy,
  });
  return Object.freeze({ template: frozenTemplate, locale });
};

/** Construct the in-memory audit-grow pool. Validates every entry;
 *  throws `AuditGrowPoolError` on any failure. Successful return → a
 *  deep-frozen list of `RegisteredTemplate` exposed via the
 *  `TemplatePool` contract. Mirrors `createBundlePool`.
 *
 *  **Aggregate validation.** The factory runs `validateAuditGrowEntry`
 *  over every entry and collects ALL failures before deciding. If any
 *  entry is invalid, it throws `AuditGrowPoolError` carrying the full
 *  per-entry failure list — registration surfaces every problem at
 *  once instead of fail-on-first. Unexpected throws from the
 *  validator (programming bugs) are caught per-entry + surfaced as
 *  `entry_unprocessable` so one bad entry can't abort the iteration
 *  and hide later failures.
 *
 *  **Empty entries is valid.** An audit-grow pool with no entries
 *  returns `[]` from `list()`; the library iterates and returns
 *  `null` from `match()` for any query the bundle pool also misses.
 *  Useful at first boot when the user hasn't promoted anything yet.
 *
 *  Why throw at construction time vs returning a result type: pool
 *  construction is a server-boot step (post-P4 wiring), not a
 *  per-request operation. Boot failures should crash loudly so the
 *  operator sees the bad row immediately; returning a result type
 *  would let the runtime silently start with an empty pool + no
 *  signal that templates went missing. */
export const createAuditGrowPool = (
  options: CreateAuditGrowPoolOptions,
): TemplatePool => {
  const accepted: RegisteredTemplate[] = [];
  const failures: AuditGrowPoolEntryFailure[] = [];

  options.entries.forEach((entry, index) => {
    let result;
    try {
      result = validateAuditGrowEntry(entry);
    } catch (err) {
      failures.push({
        index,
        reason: 'entry_unprocessable',
        detail: `validator threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    if (result.kind === 'invalid') {
      failures.push({ index, reason: result.reason, detail: result.detail });
      return;
    }
    accepted.push(freezeEntry(result.entry.template, result.entry.locale));
  });

  if (failures.length > 0) throw new AuditGrowPoolError(failures);

  const frozen = Object.freeze([...accepted]);
  return {
    name: AUDIT_GROW_POOL_NAME,
    list: () => frozen,
  };
};

/** Live-rebuild error signature. The adapter invokes this hook every
 *  time it tries (and fails) to rebuild the in-memory pool from a
 *  fresh store snapshot. The hook receives the underlying error so a
 *  caller can route it to the Kitchen UI or operator log; the
 *  adapter keeps the prior frozen list as the live one (tearing
 *  down a running pool because one promoted row regressed would be
 *  worse than serving stale entries until the user re-promotes).
 *  Mirrors the bundle poller's `onError(err: unknown)` philosophy:
 *  observable, never fatal.
 *
 *  Typed `unknown` rather than `AuditGrowPoolError` because *unexpected*
 *  errors (a future validator refactor throwing a non-pool class, a
 *  programming bug in the freeze chain) also flow through here —
 *  silently swallowing them would hide the failure entirely. Consumers
 *  that only care about the validation case `instanceof
 *  AuditGrowPoolError` and read `.failures`; consumers that log
 *  everything take the error as-is. */
export type AuditGrowRebuildErrorListener = (error: unknown) => void;

export interface CreateStoreBackedAuditGrowFactoryOptions {
  /** Per-pair persistence layer; the factory reads `current()` at
   *  construction + subscribes for future updates. */
  readonly store: AuditGrowStore;
  /** Optional hook fired when a *live* rebuild fails (a store
   *  update produces an entry the validator rejects, or any other
   *  error escapes `createAuditGrowPool`). Not fired on
   *  construction-time failures — those throw directly so the boot
   *  path crashes loudly. */
  readonly onRebuildError?: AuditGrowRebuildErrorListener;
}

export interface StoreBackedAuditGrowFactory {
  /** Live pool whose `list()` returns the latest frozen entry array.
   *  Stable across store updates — the underlying entry list swaps,
   *  the pool object identity does not. */
  readonly pool: TemplatePool;
  /** Unsubscribe from the store. Idempotent; subsequent puts have
   *  no effect on the pool. */
  stop(): void;
}

/** Build a live `TemplatePool` whose entries reflect the store's
 *  latest persisted snapshot.
 *
 *  Construction:
 *    - Reads `store.current()`. `null` (cold boot) is valid → the
 *      pool starts empty.
 *    - If the existing snapshot has invalid entries,
 *      `createAuditGrowPool` throws `AuditGrowPoolError` and the
 *      throw escapes the factory so the boot path crashes loudly.
 *      This matches `loadBundlePool`'s posture: bad on-disk state
 *      should be operator-visible, not silently dropped.
 *
 *  Live updates:
 *    - On every `store.put`, the factory rebuilds the in-memory
 *      entry list from the new snapshot.
 *    - Validation failures during live rebuild flow through
 *      `onPoolError`; the prior frozen list is preserved as the
 *      live one. The pool never tears down mid-run.
 *
 *  Lifecycle:
 *    - `stop()` unsubscribes from the store. Idempotent. After
 *      stop, the pool's `list()` returns the last successfully
 *      rebuilt entry list — callers who want a true "stop reading"
 *      semantic should also drop the pool reference.
 *
 *  Why the audit-grow adapter differs from
 *  `createStoreBackedFetcher`. The bundle's adapter wraps a store
 *  as a `BundleFetcher` so `loadBundlePool` (a one-shot construction
 *  helper) builds the pool once. The bundle pool is then frozen for
 *  its lifetime; subsequent store updates do NOT change the live
 *  pool until the caller rebuilds explicitly. For bundles that's
 *  fine — recued.com manifest updates are rare + the poller drives
 *  cache refresh, not live pool refresh.
 *
 *  For audit-grow, that posture is wrong: user promotions are an
 *  *interactive* event that MUST take effect without a server
 *  restart or library rebuild. So this adapter holds the entry list
 *  in a closure variable that swaps on every successful store put,
 *  and exposes a `TemplatePool` whose `list()` reads that variable.
 *  The library calls `pool.list()` per match (see `library.ts`'s
 *  `match` — no memoisation), so the swap is observed immediately. */
export const createStoreBackedAuditGrowFactory = (
  options: CreateStoreBackedAuditGrowFactoryOptions,
): StoreBackedAuditGrowFactory => {
  const { store, onRebuildError } = options;

  /** Build the frozen entry list for a snapshot. Returns the
   *  accepted list on success, or throws `AuditGrowPoolError` on
   *  any validation failure (delegated to `createAuditGrowPool`).
   *  The returned list is structurally the same as the one
   *  `createAuditGrowPool` builds — we go through that path so the
   *  failure-aggregation + freeze invariants stay in one place. */
  const buildEntries = (
    snapshot: AuditGrowSnapshot | null,
  ): ReadonlyArray<RegisteredTemplate> => {
    const entries = snapshot?.entries ?? [];
    // Reuse the canonical pool factory so the per-entry validation
    // + deep-freeze invariants are identical to the static-entries
    // construction path. We extract `list()` rather than carrying
    // the whole `TemplatePool` because the adapter exposes its own
    // long-lived `pool` object (stable identity) backed by the
    // mutable `live` ref below.
    return createAuditGrowPool({ entries }).list();
  };

  let live: ReadonlyArray<RegisteredTemplate> = buildEntries(store.current());

  const livePool: TemplatePool = {
    name: AUDIT_GROW_POOL_NAME,
    list: () => live,
  };

  const safeInvokeError = (error: unknown): void => {
    if (onRebuildError === undefined) return;
    try {
      onRebuildError(error);
    } catch {
      // Listener faults must not tear down the store fan-out path.
      // The listener runs inside `AuditGrowStore.subscribe`'s
      // try/catch already, but the local belt-and-suspenders keeps
      // the intent close to the call site.
    }
  };

  const unsubscribe = store.subscribe((snapshot) => {
    try {
      live = buildEntries(snapshot);
    } catch (err) {
      // Every rebuild-time error flows through `onRebuildError` — both
      // the expected `AuditGrowPoolError` (validator-rejected
      // promotion) and any unexpected throw (a programming bug in the
      // validator / freeze chain). Re-throwing the latter back into
      // `AuditGrowStore.subscribe` would be swallowed by the store's
      // listener try/catch, hiding the failure entirely; routing
      // through `onRebuildError` preserves the prior frozen list AND
      // keeps the failure observable.
      safeInvokeError(err);
    }
  });

  let stopped = false;

  return {
    pool: livePool,
    stop(): void {
      if (stopped) return;
      stopped = true;
      unsubscribe();
    },
  };
};
