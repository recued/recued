// D-181 Slice 2 — Long-op execution lanes + static op-kind classification.
//
// The long-op governor bounds the heavy *call* (not the recipe, not the step —
// the only granularity that survives `[fast, fast, slow, slow]` in one
// `Promise.all`). A call is classified statically by its ingredient `kind`
// (the same deterministic walk the publish gate runs over the manifest op-set),
// into one of two concurrency **lanes** — or bypassed entirely when it is
// provably cheap. See D-181 §3b/§4.

import type { IngredientKind } from './ingredient.js';

/** The two scarce-resource lanes a heavy call can occupy.
 *  - `local-heavy`  — cli/`service` subprocess work; scarce resource is local
 *    CPU + **RAM** (3 ML pipelines OOM before they saturate CPU), so `N` is
 *    small (≈ cores−1, capped by RAM headroom).
 *  - `external-io`  — http / mcp / connection / dom / chat; scarce resource is
 *    the external rate-limit / token budget, mostly *waiting* locally, so `N`
 *    is high. */
export type ExecutionLane = 'local-heavy' | 'external-io';

/** Closed set of every valid `ExecutionLane`, in canonical order. */
export const EXECUTION_LANES: readonly ExecutionLane[] = ['local-heavy', 'external-io'] as const;

/** A call's governance class: the two lanes, the provably-cheap bypass, and the
 *  AI hand-off.
 *  - `fast-path`   — local warehouse reads + transforms/guards (no external IO /
 *    AI / subprocess); bypasses the semaphore entirely. Default-gated otherwise,
 *    so a misclassification fails *safe* (gated, never wrongly bypassed).
 *  - `ai-governor` — `ai` ops route to their own free-pool/BYOK governor (D-079);
 *    they take no lane slot here (double-counting would be wrong). */
export type CallClass = ExecutionLane | 'fast-path' | 'ai-governor';

/** Static op-kind → call-class. Mirrors the publish-gate manifest walk; the
 *  switch is exhaustive over `IngredientKind` (the compiler enforces coverage,
 *  so adding a kind forces a decision here).
 *
 *  `transform` / `guard` steps carry no ingredient and are `fast-path` by
 *  construction — they never reach this function. An *unknown* kind (no manifest
 *  resolvable, e.g. a dbless test with no `manifestGetter`) is the caller's
 *  concern; this function only classifies a known kind. */
export const callClassForKind = (kind: IngredientKind): CallClass => {
  switch (kind) {
    case 'service':
    case 'cli':
      // D-182 — a cli op is a local subprocess (whisper / docling / ffmpeg /
      // imagemagick); RAM-sized local-heavy lane, same as a service.
      return 'local-heavy';
    case 'ai':
      return 'ai-governor'; // own free-pool/BYOK bound; never double-counted
    case 'http':
    case 'mcp':
    case 'connection':
    case 'dom':
    case 'chat':
      return 'external-io';
    case 'storage':
      return 'fast-path'; // local warehouse only
  }
};

/** Whether a call class actually contends for a lane slot. `fast-path` and
 *  `ai-governor` bypass the semaphore; only the two lanes acquire. */
export const isGatedCallClass = (c: CallClass): c is ExecutionLane =>
  c === 'local-heavy' || c === 'external-io';

/** D-181 §10 — the simple, default-gated duration refinement of the static
 *  op-kind classification. An op (manifest slug) that has only ever completed
 *  quickly is demoted to the `fast-path` bypass; an unknown or once-slow op
 *  stays gated by its kind. This is a precaution, NOT a precise cost model:
 *  over-gating a fast op is harmless (the lane drains fast), so the default is
 *  always to gate. The implementation's state is per-process + in-memory — a
 *  restart re-gates every op until it re-proves itself fast (the safe direction).
 *  Lane *sizing* stays hardware-derived (auto-detect); this only refines the
 *  per-op gate/bypass decision. */
export interface OpDurationClassifier {
  /** The op's WORST observed successful-call duration (ms), or undefined when it
   *  has never completed successfully. Sticky-max: once an op runs at/over the
   *  threshold it stays gated even after a later fast run. */
  recordedMaxMs(slug: string): number | undefined;
  /** Record a SUCCESSFULLY-completed call's duration (keeps the per-slug max).
   *  The engine calls this only on a clean settle — a failed / killed call's
   *  (possibly truncated) duration is never recorded, so a slow op that never
   *  succeeds fast stays gated. */
  record(slug: string, durationMs: number): void;
}

/** D-181 §10 — an op whose worst successful-call duration is strictly under this
 *  earns the fast lane (bypasses the governor). A deliberately conservative span:
 *  the point is to skip the lane only for trivially-cheap ops and gate the rest.
 *  A chosen constant, not a value harvested from data. */
export const FAST_LANE_MAX_DURATION_MS = 5_000;

/** The classifier the engine falls back to when none is injected: records
 *  nothing + never demotes, so every call stays kind-classified — behaviour
 *  identical to the pre-§10 path (dbless tests / client contexts). */
export const NO_OP_OP_DURATION_CLASSIFIER: OpDurationClassifier = {
  recordedMaxMs: () => undefined,
  record: () => {
    /* no-op */
  },
};

/** Per-tool progress signal the stall detector can observe (D-181 §6, slice 3).
 *  Declared here so the lane vocabulary lives in one module; the monitor that
 *  consumes it lands in slice 3.
 *  - `heartbeat`      — stdout line cadence (cli with progress output)
 *  - `file-growth`    — output-file mtime+size polling (docling/ffmpeg)
 *  - `provider-event` — http/streaming chunk arrival
 *  - `silent`         — no signal; bounded only by a generous hard cap (progress
 *    detection does not apply).
 *  - `resource`       — D-274: forward progress inferred from OS accounting of
 *    the process tree (CPU time + RSS). Needs NO cooperation from the tool, so
 *    it is the implicit default for a cli binding that declares nothing.
 *    ⛔ HOST-ASSIGNED, NEVER AUTHORED — see `AuthorableProgressContract`. */
export type ProgressContract = 'heartbeat' | 'file-growth' | 'provider-event' | 'silent' | 'resource';

/** Closed set of every progress contract the RUNTIME can evaluate, in canonical
 *  order. ⚠ This is NOT the set a manifest may declare — see
 *  `AUTHORABLE_PROGRESS_CONTRACTS`. Deriving an accept-set from this list is
 *  what makes `resource` authorable by accident (D-274 § 6a). */
export const PROGRESS_CONTRACTS: readonly ProgressContract[] = [
  'heartbeat',
  'file-growth',
  'provider-event',
  'silent',
  'resource',
] as const;

/** D-274 § 6a — what a MANIFEST may declare. Deliberately excludes `resource`:
 *  that contract is assigned by the host when a binding declares nothing, it
 *  carries no `stall_ms`, and the separately-deployed cloud publish gate
 *  (`publish-pack.ts`) has no knowledge of it. A server accepting it locally
 *  while the door refuses the publish is the failure this split prevents —
 *  self-hosted means there is no deploy order to rely on.
 *
 *  ⇒ Admitting `resource` here is a CLOUD change, not a contracts change. */
export type AuthorableProgressContract = Exclude<ProgressContract, 'resource'>;

/** Closed set of every AUTHORABLE progress contract, in canonical order. */
export const AUTHORABLE_PROGRESS_CONTRACTS: readonly AuthorableProgressContract[] = [
  'heartbeat',
  'file-growth',
  'provider-event',
  'silent',
] as const;
