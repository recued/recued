/** D-157 Part C — Held-action idempotency.
 *
 *  Parts A/B (`2e5a978d` + `9b7ba0b8`) made a preflight-HELD run a clean
 *  third-state to agents — a model is TOLD the action is queued for
 *  approval and to NOT resend (`docs/chat-prompt-optimization-log.md`,
 *  2026-06-08). Part C makes a resend HARMLESS for a weaker / local model
 *  that resends anyway: an identical action already held awaiting approval
 *  in the SAME channel session COLLAPSES onto the live hold instead of
 *  minting a SECOND checkpoint + approval ask + pending write. The
 *  qwen3.7-plus loop — re-emitting a held `chat.send` until the turn
 *  timed out — is the empirical anchor.
 *
 *  This is the substrate-support sibling of the projection (clearer
 *  feedback reduces resends; idempotency makes the residual resends from
 *  inferior models safe). The two are paired: a held result reads as a
 *  clean third-state, and a re-issued one is absorbed rather than
 *  duplicated.
 *
 *  ── Scope (why only chat + mcp) ───────────────────────────────────────
 *  The dedup fires ONLY for the two agent-resend surfaces named in the
 *  log — the chat tool-loop (`chat`) and MCP recipe paths (`mcp`). On
 *  those channels the agent's intent rides in `config` (the flat tool
 *  args), so (channel_session_id, recipe_id, recipe_hash, config_snapshot)
 *  fully captures the action. System / event channels are deliberately
 *  EXCLUDED: a `reactive` / `schedule` / `webhook` / `reception` dispatch
 *  keeps a STABLE channel_session_id across distinct fires while its
 *  per-fire input lives in `context.event.payload` (not `config`), so
 *  keying on config alone would wrongly collapse two different events onto
 *  one hold. (`handleExecute` adds a second belt — it also requires
 *  `internal.run_id === undefined`, which the reception-workflow dispatcher
 *  and the resumer both set — and skips the dedup when the caller supplied
 *  a per-intent `context` / `vault` the key does not cover.)
 *
 *  ── Identity ──────────────────────────────────────────────────────────
 *  (channel_session_id, recipe_id, recipe_hash, config_snapshot):
 *   - `channel_session_id` scopes the dedup to one conversation / token
 *     (`chat:<conversation>`, `mcp:<token>`) so two distinct conversations
 *     with coincidentally-identical args never collide.
 *   - `recipe_id` + `recipe_hash` pin the exact recipe AND its shape — two
 *     different inline recipes sharing a recipe_id, or a recipe edited
 *     mid-session, do not collapse (`recipe_hash` is `hashRecipe(recipe)`,
 *     exactly what the engine stamps on the anchor).
 *   - `config_snapshot` is `{...recipe.variables, ...request.config}`,
 *     matching what `handleExecute` persists.
 *
 *  A twin counts only when it is LIVE — `commit_status ===
 *  'awaiting_approval'` AND its checkpoint still resolves. An awaiting
 *  anchor whose checkpoint was reaped is drift (the boot sweep will
 *  force-fail it), never a hold: collapsing onto it would tell the agent
 *  "queued" when nothing is queued. The liveness check is what keeps the
 *  dedup honest.
 *
 *  Best-effort: a lookup failure proceeds with a normal run.
 */

import { canonicalArgHash, projectResolvedArgs } from '@recued/contracts';
import type { ExecutionSource } from '@recued/contracts';
import { extractVariableDefault } from '@recued/engine';
import type { AuditEntry, AuditLogStore, CheckpointStore } from '@recued/storage';

import type { ExecuteResponse } from './types.js';

/** The agent-resend surfaces the held-action dedup applies to — the chat
 *  tool-loop + MCP recipe paths, the two surfaces the prompt-opt log
 *  names. On these, intent rides in `config`, so the dedup identity is
 *  complete. System / event channels (`reactive`, `schedule`, `webhook`,
 *  `reception`, …) are excluded — their per-fire input lives in
 *  `context.event.payload`, outside the key. */
export const HELD_DEDUP_CHANNELS: ReadonlySet<ExecutionSource['channel']> =
  new Set(['chat', 'mcp']);

/** Recent-window scan bound for the channel-session twin lookup. A held
 *  action is recent by nature (the user has not approved it yet) and a
 *  resend loop re-fires immediately, so a live twin is among the most
 *  recent rows of its channel session. Bounds the scan on a long-lived
 *  chat conversation / MCP token. */
export const HELD_TWIN_SCAN_LIMIT = 50;

/** The content identity of an action that, if held, dedups against a
 *  prior live hold of the same identity in the same channel session. */
export interface HeldActionIdentity {
  /** `deriveChannelSessionId(execution_source)` — the channel-owned
   *  boundary (conversation / token). */
  channel_session_id: string;
  recipe_id: string;
  /** `hashRecipe(recipe)` — pins the recipe SHAPE so two inline recipes
   *  sharing a recipe_id (or a mid-session edit) do not collapse. */
  recipe_hash: string;
  /** The effective config the run resolves `{{config.*}}` against, exactly
   *  as the audit anchor persists it — built via `buildHeldConfigSnapshot`
   *  (each variable resolved to its default, then request overrides on top).
   *  Resolving the defaults is REQUIRED: the engine normalizes
   *  `recipe.variables` to defaults during the run, so the anchor stores
   *  resolved values; a raw schema-form snapshot would never match. */
  config_snapshot: Record<string, unknown>;
}

/** The narrow store surface the twin lookup needs. */
export interface HeldTwinLookupDeps {
  auditLog: Pick<AuditLogStore, 'listByChannelSession'>;
  checkpointStore: Pick<CheckpointStore, 'get'>;
}

/** D-177 P1b (N.7) — the run-level canonical identity hash. One
 *  canonicalization across the codebase: the same `canonicalArgHash`
 *  primitive the commit Gateway stamps call-level action identity with,
 *  here over the run's config snapshot (this replaced the module's
 *  ad-hoc `stableStringify`). The wire projection first
 *  (`projectResolvedArgs`): a default-less recipe variable resolves to
 *  `undefined`, and the persisted anchor's `config_snapshot` drops it on
 *  the JSON round-trip — projecting makes the fresh identity hash equal
 *  the stored anchor's, so the dedup fires where the sentinel-based
 *  stringify silently never matched. THROWS (`canonicalArgHash`
 *  fail-closed) on a snapshot with no unambiguous canonical form
 *  (non-finite numbers, Dates, …) — callers degrade to "no dedup",
 *  the module's best-effort posture. */
const snapshotHash = (snapshot: Record<string, unknown>): string =>
  canonicalArgHash(projectResolvedArgs(snapshot)).canonical_payload_hash;

/** Two config snapshots are the same intent iff their canonical identity
 *  hashes are equal (key-order-independent; arrays keep order — a reorder
 *  is a different intent). A snapshot that cannot be canonicalized
 *  matches nothing — the resend runs normally instead of collapsing onto
 *  a hold whose identity we cannot establish. */
export const configSnapshotsEqual = (
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean => {
  try {
    return snapshotHash(a) === snapshotHash(b);
  } catch {
    return false;
  }
};

/** Build the effective config snapshot for the held-action identity,
 *  matching what `handleExecute` persists on the audit anchor: each recipe
 *  variable resolved to its default via the engine's canonical
 *  `extractVariableDefault` (schema-form `{label,type,default}` / `[shorthand]`
 *  → value, plain value → itself), then the request's config overrides applied
 *  on top (an override wins, mirroring the engine's `if (!config[key])` rule).
 *
 *  Resolving the defaults is LOAD-BEARING. The engine normalizes
 *  `recipe.variables` to their defaults while running, so the anchor's
 *  `config_snapshot` carries resolved VALUES — but this guard runs BEFORE the
 *  engine, where `recipe.variables` is still the SCHEMA form. Keying on the raw
 *  schema would never equal the anchor's resolved form, so the dedup would
 *  silently never fire for any recipe with a variable default. Reusing the
 *  engine's extractor (not a copy) keeps the two in lockstep. */
export const buildHeldConfigSnapshot = (
  variables: Record<string, unknown> | undefined,
  config: Record<string, unknown>,
): Record<string, unknown> => {
  const resolved: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(variables ?? {})) {
    resolved[key] = extractVariableDefault(val);
  }
  return { ...resolved, ...config };
};

/** Find a LIVE held twin of `identity` in the same channel session, or
 *  `null`. Live = an `awaiting_approval` anchor whose `recipe_id` +
 *  `recipe_hash` + `config_snapshot` match AND whose `checkpoint_id` still
 *  resolves to a persisted `Checkpoint`. The most-recent matching hold
 *  wins (the channel-session list is newest-first); any live identical
 *  twin is an equally-correct collapse target. Throws only on `auditLog`/
 *  `checkpointStore` I/O failure — the caller treats a throw as "no twin"
 *  and proceeds with a normal run. */
export const findLiveHeldTwin = async (
  deps: HeldTwinLookupDeps,
  identity: HeldActionIdentity,
): Promise<AuditEntry | null> => {
  const recent = await deps.auditLog.listByChannelSession(
    identity.channel_session_id,
    HELD_TWIN_SCAN_LIMIT,
  );
  for (const anchor of recent) {
    if (anchor.commit_status !== 'awaiting_approval') continue;
    if (anchor.checkpoint_id === undefined) continue;
    if (anchor.recipe_id !== identity.recipe_id) continue;
    if (anchor.recipe_hash !== identity.recipe_hash) continue;
    if (!configSnapshotsEqual(anchor.config_snapshot, identity.config_snapshot)) {
      continue;
    }
    // Liveness — an awaiting anchor whose checkpoint was reaped is drift,
    // not a hold; never collapse onto a dead approval.
    const checkpoint = await deps.checkpointStore.get(anchor.checkpoint_id);
    if (checkpoint === null) continue;
    return anchor;
  }
  return null;
};

/** The agent-facing held third-state for a COLLAPSED run — shaped so
 *  `projectRunResultForAgent` keys on `awaiting_approval: true` and emits the
 *  clean "queued for approval — do not resend" guidance, with no contradictory
 *  `success: false` / errors leaking to the agent. `recipe_id` / `recipe_hash`
 *  mirror the held action the agent already raised; NO new run, audit row,
 *  checkpoint, or ask is written. */
export const buildHeldResponseForRecipe = (
  recipe_id: string,
  recipe_hash: string,
): ExecuteResponse => ({
  recipe_id,
  recipe_hash,
  success: false,
  output: { render: [], sidebar: [] },
  steps: [],
  errors: [],
  duration_ms: 0,
  awaiting_approval: true,
});

/** The collapse response for a run deduped onto an existing live (durable)
 *  hold — mirrors the twin's `recipe_id` / `recipe_hash`. */
export const buildHeldTwinResponse = (twin: AuditEntry): ExecuteResponse =>
  buildHeldResponseForRecipe(twin.recipe_id, twin.recipe_hash);

// ── Concurrent TOCTOU backstop ────────────────────────────────────────────
//
// `findLiveHeldTwin` is a CHECK at the top of `handleExecute`; it collapses a
// SEQUENTIAL resend (the first hold's anchor is durable before the resend
// runs). It CANNOT see a CONCURRENT identical send whose hold is not yet
// durable — two parallel `handleExecute` calls both pass the entry check, both
// run to the gate, and both would create a hold + ask. (Reachable only via
// parallel identical MCP requests: chat's `recipe.run` is
// `concurrency_safe:false`, so a chat batch dispatches sequentially and the
// entry check already covers it.)
//
// This module-private registry records, per identity key, a LEADER's
// hold-creation IN PROGRESS as a promise of its OUTCOME. A second concurrent
// send (a follower) finds the leader's promise and AWAITS it: `'durable'` (the
// leader's audit anchor is written → collapse) or `'failed'` (the hold was NOT
// created → the follower re-attempts). Awaiting the outcome — rather than
// collapsing on the bare presence of a claim — is what prevents a FALSE
// "queued": a leader can still fail to create the hold (e.g. a checkpoint-store
// write error), and a follower must not report a hold that never materialised.
// The claim is taken synchronously (no `await` between `has` and `set`, so two
// callers cannot both lead) and settled exactly once when the leader's run
// finishes. In-process only — a hold can't span a restart, and post-restart
// dedup is the durable anchor's job.

/** The leader's hold-creation outcome a follower awaits: `'durable'` (the
 *  audit anchor was written and `findLiveHeldTwin` will see it → collapse) or
 *  `'failed'` (the hold was not created → re-attempt). */
export type HoldOutcome = 'durable' | 'failed';

/** A leader's claim handle. `settle` MUST be called EXACTLY ONCE — with
 *  `'durable'` once the hold's audit anchor is durable, or `'failed'` if the
 *  hold was not created — to release every follower awaiting this hold. */
export interface InflightHoldClaim {
  settle: (outcome: HoldOutcome) => void;
}

const inflightHolds = new Map<string, Promise<HoldOutcome>>();

/** Stable identity key for the in-flight registry — the same four facets
 *  `findLiveHeldTwin` matches on, collapsed to the D-177 canonical identity
 *  hash (N.7: one canonicalization, two consumers). `null` when the
 *  identity's config snapshot cannot be canonicalized (`canonicalArgHash`
 *  fail-closed) — the caller skips the in-flight dedup for that run, the
 *  same "proceed with a normal run" degradation as a lookup failure. */
export const computeHeldActionKey = (
  identity: HeldActionIdentity,
): string | null => {
  try {
    return canonicalArgHash(
      projectResolvedArgs({
        channel_session_id: identity.channel_session_id,
        recipe_id: identity.recipe_id,
        recipe_hash: identity.recipe_hash,
        config_snapshot: identity.config_snapshot,
      }),
    ).canonical_payload_hash;
  } catch {
    return null;
  }
};

/** If a concurrent leader is creating an identical hold, the promise of its
 *  outcome — `await` it: `'durable'` ⇒ collapse, `'failed'` ⇒ re-attempt.
 *  `null` when no leader is in flight (proceed to claim). */
export const awaitInflightHold = (key: string): Promise<HoldOutcome> | null =>
  inflightHolds.get(key) ?? null;

/** Atomically claim the in-flight hold-creation for `key`. Returns a claim
 *  handle (THIS call is the leader — create the hold, then `settle`), or
 *  `null` if a concurrent leader already holds it. Sync — no `await` between
 *  the `has` and the `set`, so two concurrent callers cannot both lead. */
export const claimInflightHold = (key: string): InflightHoldClaim | null => {
  if (inflightHolds.has(key)) return null;
  let settle!: (outcome: HoldOutcome) => void;
  const outcome = new Promise<HoldOutcome>((resolve) => {
    settle = resolve;
  });
  inflightHolds.set(key, outcome);
  let settled = false;
  return {
    settle: (result) => {
      if (settled) return;
      settled = true;
      // Remove the slot BEFORE resolving so a follower woken by the resolve
      // re-checks against a registry that no longer lists this (finished)
      // leader.
      inflightHolds.delete(key);
      settle(result);
    },
  };
};
