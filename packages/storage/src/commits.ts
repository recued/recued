/** D-145 engine-wiring slice 3a — the commit store.
 *
 *  The persistence substrate for the D-153 atomic commit log: one
 *  boundary-crossing tool call = one `Commit` row. The Gateway (D-145
 *  engine-wiring slice 3b) is the only writer; this file ships the
 *  store + its crash-safe write protocol, substrate-only — no Gateway,
 *  no engine wiring yet.
 *
 *  Crash-safe write protocol (spec § Dispatch-outbox + crash-recovery):
 *
 *    1. `writePending(commit)` persists a `'pending'` row BEFORE the
 *       Gateway crosses the boundary. The durable pending row is the
 *       marker that an external side-effect was about to happen,
 *       regardless of whether the call completes.
 *    2. `recordOutcome(commit_id, outcome)` transitions the row in
 *       place to a terminal status once the per-kind primitive returns,
 *       attaching `output` + completion timing (+ `cached` / `detail`
 *       when present).
 *    3. On the next boot, `sweepPendingToInDoubt()` marks every commit
 *       still non-terminal as `'in_doubt'` — a crash left its outcome
 *       unobserved. No automatic resume, ever (spec: trust transparency
 *       over throughput; Recued does not query external systems to
 *       attribute outcomes during recovery).
 *
 *  Built on the generic `Collection<Commit>` primitive — the same shape
 *  `AuditLogStore` is built on — so an in-memory collection backs tests
 *  and a SQLite collection backs the server with no store-code change.
 *  The collection is keyed by `commit_id`.
 *
 *  Spec: D-153 § Commit substrate (atomic) / § Dispatch-
 *  outbox + crash-recovery.
 */

import type { Collection } from './types.js';
import { isTerminalCommitStatus } from '@recued/contracts';
import type { Commit, CommitStatus } from '@recued/contracts';

/** The fields the Gateway supplies when persisting a pre-dispatch
 *  pending commit. `status` is set to `'pending'` by the store; the
 *  outcome fields (`output` / `completed_at` / `duration_ms` / `cached`
 *  / `detail`) are absent until `recordOutcome` captures them.
 *  `request_id` IS supplied here — the execution-request anchor exists
 *  before dispatch, so the FK is known at pending-write time. */
export type PendingCommitInput = Omit<
  Commit,
  'status' | 'output' | 'completed_at' | 'duration_ms' | 'cached' | 'detail'
>;

/** The terminal status subset a `recordOutcome` call may set — the
 *  non-terminal `'pending'` / `'running'` values are unreachable
 *  through outcome capture. `'in_doubt'` IS reachable here: the Gateway
 *  sets it directly when the primitive returns an ambiguous result
 *  (timeout, connection drop) rather than a confirmed success/failure
 *  — distinct from the crash-recovery sweep's `'in_doubt'`. */
export type CommitOutcomeStatus = Exclude<CommitStatus, 'pending' | 'running'>;

/** The outcome the Gateway records once the per-kind primitive returns
 *  — or once a grace-window cancel resolves. `duration_ms` is derived
 *  by the store as `completed_at − dispatched_at`; the caller supplies
 *  only the wall-clock completion stamp. */
export interface CommitOutcome {
  /** Terminal lifecycle state — `'succeeded'` / `'failed'` /
   *  `'cancelled'` / `'in_doubt'`. */
  status: CommitOutcomeStatus;
  /** The tool's return value. Omit when the primitive produced none —
   *  the store leaves the commit's `output` key absent. */
  output?: unknown;
  /** Outcome-capture unix-ms. */
  completed_at: number;
  /** D-145 slice 3b.0 — `true` when the Gateway served `output` from
   *  the L1 / L2 cache instead of crossing the boundary. Omit when the
   *  call really dispatched; the store never writes `cached: false`. */
  cached?: true;
  /** D-145 slice 3b.0 — optional per-kind facet metadata (connection
   *  transport bytes, mail `message_id`, …) that is neither `args` nor
   *  `output`. Omit when the call carries no extra facets. */
  detail?: Record<string, unknown>;
}

/** The commit store — persistence + the crash-safe write protocol for
 *  the D-153 commit log. The Gateway (slice 3b) is the sole writer;
 *  the read methods back the Activity surface, the tier-scoped audit
 *  queries, and save-as-Recipe. */
export interface CommitStore {
  /** Persist a pre-dispatch `'pending'` commit. The durable row is the
   *  crash-safety marker — written BEFORE the Gateway crosses the
   *  boundary. The stored row is canonical-pending: `status` is forced
   *  to `'pending'` and the outcome fields (`output` / `completed_at` /
   *  `duration_ms` / `cached` / `detail`) are stripped — the store, not
   *  the caller, owns the shape of a pending row. Throws when a commit
   *  with the same
   *  `commit_id` already exists: the pending write is once-only per
   *  commit (the Gateway mints a fresh `commit_id` per call). */
  writePending(commit: PendingCommitInput): Promise<void>;

  /** Transition a non-terminal commit in place to a terminal status,
   *  attaching `output` + `completed_at` + the derived `duration_ms`.
   *  Throws when `commit_id` is unknown, or when the commit is already
   *  terminal — outcome capture is once-only. */
  recordOutcome(commit_id: string, outcome: CommitOutcome): Promise<void>;

  /** Crash recovery — mark every commit still non-terminal
   *  (`'pending'` / `'running'`) as `'in_doubt'`. Called once at boot;
   *  no auto-resume. The outcome fields (`output` / `completed_at` /
   *  `duration_ms` / `cached` / `detail`) are stripped from the swept
   *  rows — a crash means the outcome, and its timing, were never
   *  observed; the substrate does
   *  not fabricate a duration that would span the downtime. Returns the
   *  swept commits (already updated) so the caller can surface them on
   *  the Activity surface for user reconciliation. Idempotent — a
   *  second call finds nothing to sweep. */
  sweepPendingToInDoubt(): Promise<Commit[]>;

  /** One commit by id, or null when unknown. */
  get(commit_id: string): Promise<Commit | null>;

  /** Every non-terminal commit currently in the store, oldest dispatch
   *  first. */
  listPending(): Promise<Commit[]>;

  /** Commits sharing a `correlation_id` — the ~1-min intent burst; the
   *  unit save-as-Recipe operates on. Newest dispatch first; capped at
   *  `limit` when provided. Empty result for an empty `correlation_id`. */
  listByCorrelation(correlation_id: string, limit?: number): Promise<Commit[]>;

  /** Commits belonging to one recipe run. The Gateway stamps the run's
   *  `run_id` into each commit's `request_id`; newest dispatch first,
   *  capped at `limit` when provided. Empty result for an empty
   *  `run_id`. */
  listByRun(run_id: string, limit?: number): Promise<Commit[]>;

  /** Commits sharing a `channel_session_id` — "what happened in this
   *  channel session ever?". Newest dispatch first; capped at `limit`. */
  listByChannelSession(
    channel_session_id: string,
    limit?: number,
  ): Promise<Commit[]>;

  /** Commits sharing a `cognition_session_id` — "what did this
   *  cognition arc do?". Newest dispatch first; capped at `limit`. */
  listByCognitionSession(
    cognition_session_id: string,
    limit?: number,
  ): Promise<Commit[]>;

  /** Total commit count. */
  size(): Promise<number>;
}

/** Drop the five outcome-only fields (`output` / `completed_at` /
 *  `duration_ms` / `cached` / `detail`) from a row in place. Keeps a
 *  freshly-`'pending'` row (`writePending`) and a swept-`'in_doubt'`
 *  row (`sweepPendingToInDoubt`) canonical: the store is authoritative
 *  about row shape, so neither a stray field on a wider caller-supplied
 *  object nor a partially-populated non-terminal row can leave outcome
 *  data on a commit that has no observed outcome. */
const stripOutcomeFields = (row: Commit): void => {
  delete row.output;
  delete row.completed_at;
  delete row.duration_ms;
  delete row.cached;
  delete row.detail;
};

/** Build a `CommitStore` over a backing `Collection<Commit>`. The
 *  collection is keyed by `commit_id` — pass an in-memory collection in
 *  tests, a SQLite collection on the server. */
export const createCommitStore = (
  backing: Collection<Commit>,
): CommitStore => {
  /** Newest-dispatch-first — the read order for every tier query. */
  const byDispatchedDesc = (a: Commit, b: Commit): number =>
    b.dispatched_at - a.dispatched_at;
  /** Oldest-dispatch-first — `listPending` + the sweep walk in
   *  dispatch (admission) order. */
  const byDispatchedAsc = (a: Commit, b: Commit): number =>
    a.dispatched_at - b.dispatched_at;

  /** Shared tier-scope query: filter by one indexed session field,
   *  sort newest-dispatch-first, slice to `limit`. Mirrors
   *  `AuditLogStore.listBy*`. */
  const tierQuery = async (
    field:
      | 'correlation_id'
      | 'request_id'
      | 'channel_session_id'
      | 'cognition_session_id',
    id: string,
    limit?: number,
  ): Promise<Commit[]> => {
    if (id === '') return [];
    const all = await backing.list();
    const matched = all
      .filter((c) => c[field] === id)
      .sort(byDispatchedDesc);
    return limit !== undefined && limit >= 0 ? matched.slice(0, limit) : matched;
  };

  return {
    async writePending(commit) {
      if (await backing.has(commit.commit_id)) {
        throw new Error(
          `CommitStore: commit_id "${commit.commit_id}" already written `
            + `(pending-write is once-only per commit)`,
        );
      }
      const row: Commit = { ...commit, status: 'pending' };
      stripOutcomeFields(row);
      await backing.set(commit.commit_id, row);
    },

    async recordOutcome(commit_id, outcome) {
      const existing = await backing.get(commit_id);
      if (!existing) {
        throw new Error(`CommitStore: commit_id "${commit_id}" not found`);
      }
      if (isTerminalCommitStatus(existing.status)) {
        throw new Error(
          `CommitStore: commit_id "${commit_id}" is already terminal `
            + `(${existing.status}); outcome capture is once-only`,
        );
      }
      const updated: Commit = {
        ...existing,
        status: outcome.status,
        completed_at: outcome.completed_at,
        duration_ms: outcome.completed_at - existing.dispatched_at,
      };
      // Conditional — a tool that returned no value leaves `output`
      // absent rather than explicitly `undefined`; `cached` is set only
      // on a real cache hit, `detail` only when the call carries extra
      // facets (matches the conditional-spread convention used across
      // the audit substrate).
      if (outcome.output !== undefined) updated.output = outcome.output;
      if (outcome.cached === true) updated.cached = true;
      if (outcome.detail !== undefined) updated.detail = outcome.detail;
      await backing.set(commit_id, updated);
    },

    async sweepPendingToInDoubt() {
      const all = await backing.list();
      const stranded = all
        .filter((c) => !isTerminalCommitStatus(c.status))
        .sort(byDispatchedAsc);
      const swept: Commit[] = [];
      for (const c of stranded) {
        const updated: Commit = { ...c, status: 'in_doubt' };
        stripOutcomeFields(updated);
        await backing.set(c.commit_id, updated);
        swept.push(updated);
      }
      return swept;
    },

    get(commit_id) {
      return backing.get(commit_id);
    },

    async listPending() {
      const all = await backing.list();
      return all
        .filter((c) => !isTerminalCommitStatus(c.status))
        .sort(byDispatchedAsc);
    },

    listByCorrelation(correlation_id, limit) {
      return tierQuery('correlation_id', correlation_id, limit);
    },

    listByRun(run_id, limit) {
      return tierQuery('request_id', run_id, limit);
    },

    listByChannelSession(channel_session_id, limit) {
      return tierQuery('channel_session_id', channel_session_id, limit);
    },

    listByCognitionSession(cognition_session_id, limit) {
      return tierQuery('cognition_session_id', cognition_session_id, limit);
    },

    size() {
      return backing.size();
    },
  };
};
