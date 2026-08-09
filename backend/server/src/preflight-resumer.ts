/** D-157 server-wiring — `PreflightResumer` implementation.
 *
 *  The `@recued/gateway` preflight leaf (D-157 P1 slice 4) defines a
 *  `PreflightResumer` interface with two callbacks:
 *
 *    - `resumeRun(checkpoint, context)` — re-instantiate a fresh
 *      execution from the consumed checkpoint, continuing PAST the
 *      gate (D-157 § A.2 step 5 / I-6).
 *    - `denyRun(checkpoint, context)` — record a `RECIPE_POLICY_DENIED`
 *      audit row pinned to the paused anchor's `run_id`, transitioning
 *      the run-anchor from `'awaiting_approval'` to `'failed'` (§ A.3).
 *
 *  The gateway leaf can't reach `recued-server`'s recipe store, audit
 *  log, or `handleExecute` — those live behind the public-boundary rule
 *  (`packages/` MUST NOT import `backend/`). This module is the host
 *  side of the seam: it composes the leaf's interface against the
 *  server-resident concrete dependencies.
 *
 *  Idempotency. The notification block's `on_answer` is at-least-once;
 *  if a crash interrupts the resume / deny path between
 *  `resumer.<call>(...)` and the `CheckpointStore.delete` that consumes
 *  the checkpoint, the boot sweep re-dispatches the same answer
 *  (D-158 N.3). Both callbacks defend against double-execution by
 *  inspecting the paused anchor's `commit_status` at entry:
 *
 *    - `'succeeded'` / `'failed'` (terminal)  → no-op return (the run
 *      already completed on a prior attempt; let the leaf consume the
 *      checkpoint).
 *    - `'awaiting_approval'` with a DIFFERENT `checkpoint_id` than the
 *      one this answer is for → no-op return (a later resume already
 *      wrote a newer awaiting state; the older checkpoint is stale).
 *    - `'awaiting_approval'` with the matching checkpoint id          → proceed.
 *
 *  Transient failures (`executeDeps` unavailable, `handleExecute`
 *  throws, deny audit-append throws) re-throw so the notification
 *  block leaves the ask `'answered'` and the next boot's sweep
 *  retries. The guard above makes a successful retry idempotent.
 *
 *  Spec: D-157 § A.2 / A.3 / I-6 / TR-5; the gateway-side
 *  contract is `packages/gateway/src/preflight-reconciliation.ts`.
 */

import { COMPENSATION_RECIPE_ID_PREFIX, hashRecipe } from '@recued/recipes';
import type { Checkpoint, RecipeDefinition, RecipeError } from '@recued/contracts';
import {
  MCP_INGREDIENT_TOOL_PREFIX,
  executionSourceHasContract,
  isEphemeralDishId,
} from '@recued/contracts';
import type { PreflightAskContext, PreflightResumer } from '@recued/gateway';
import {
  buildAuditEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import { handleExecute } from './execute-handler.js';
import { captureQualityDelegationSignal } from './quality-delegation-signal-capture.js';
import {
  denyRawOp,
  resumeRawOp,
  type RawOpResumeOutcome,
} from './raw-op-dispatch.js';
import { projectRunResultForAgent } from './run-result-agent-projection.js';
import type { McpActionStore } from './mcp-action-store.js';
import { RUN_INGREDIENT_RECIPE } from './run-ingredient-recipe.js';
import type { QualityDelegationSignalStore } from './storage/quality-delegation-signal-store.js';
import type { ExecuteRequest, ExecuteResponse } from './types.js';

/** What this implementation needs from the surrounding server. The
 *  three dependencies are wired by `bin.ts` after `executeDeps` exists. */
export interface CreatePreflightResumerDeps {
  /** Lazy accessor for `executeDeps`. The resumer is constructed
   *  BEFORE `executeDeps` is built (because the notification block,
   *  which threads as `executeDeps.preflightNotifier`, takes the
   *  resumer's handler at registration time). A thunk breaks the
   *  cycle — the resumer doesn't dereference until an answer actually
   *  arrives, well after bootstrap. */
  getExecuteDeps: () => ExecuteHandlerDeps | undefined;
  /** Read the paused run's audit row by `run_id` so the resume can
   *  recover `execution_source` + `contract_snapshot` + the original
   *  `trigger_source` / `config_snapshot`. Also gates the idempotency
   *  guard — a row in terminal state means the run already completed
   *  on a prior attempt; the resumer no-ops. */
  auditLog: AuditLogStore;
  /** Storage is available before executeDeps is late-bound, so denial can
   * settle a continuation even during boot recovery. */
  mcpActionStore?: McpActionStore;
  /** D-202 Slice 1b — the durable quality VERDICT store. When wired, a resolved
   *  QUALITY-relevant ask (`Checkpoint.quality_relevant`) records one
   *  `QualityDelegationSignal` (approve → `quality_good`, deny → `quality_bad`)
   *  for the reject-driven learner. Best-effort + never load-bearing for the
   *  resume/deny — absent (dbless harness / no contract store) ⇒ no signal is
   *  recorded and the approve/deny path is byte-identical to pre-1b. */
  qualityDelegationSignalStore?: QualityDelegationSignalStore;
}

/** Async-action persistence must never change whether an approved effect runs.
 * A failed continuation receipt is observable degradation, not dispatch
 * authority, so every write is best-effort and loudly logged. */
const updateMcpAction = async (
  store: McpActionStore | undefined,
  runId: string,
  operation: (store: McpActionStore) => Promise<unknown>,
): Promise<void> => {
  if (store === undefined) return;
  try {
    await operation(store);
  } catch (error) {
    console.warn(
      `[preflight-resumer] MCP action update failed for run_id=${runId}: `
        + (error instanceof Error ? error.message : String(error)),
    );
  }
};

const settleRawMcpAction = async (
  store: McpActionStore | undefined,
  checkpoint: Checkpoint,
  outcome: RawOpResumeOutcome,
): Promise<void> => {
  await updateMcpAction(store, checkpoint.run_id, async (actions) => {
    switch (outcome.kind) {
      case 'completed':
        await actions.finish(checkpoint.run_id, {
          status: 'completed',
          status_message: 'The approved operation completed.',
          result: outcome.result,
        });
        return;
      case 'failed':
        await actions.finish(checkpoint.run_id, {
          status: 'failed',
          status_message: outcome.message,
          result: {
            status: 'failed',
            code: outcome.code,
            message: outcome.message,
          },
        });
        return;
      case 'in_doubt':
        await actions.finish(checkpoint.run_id, {
          status: 'in_doubt',
          status_message: outcome.message,
          result: {
            status: 'in_doubt',
            code: outcome.code,
            message: outcome.message,
          },
        });
        return;
      case 'skipped':
        // A concurrent winner owns settlement. A consumed checkpoint with no
        // terminal receipt means a prior process may have crossed the provider
        // boundary and crashed before recording the outcome: never call it safe
        // to retry.
        if (outcome.reason === 'resume_already_in_flight') return;
        await actions.finish(checkpoint.run_id, {
          status: 'in_doubt',
          status_message:
            'The approval checkpoint was already consumed, but no final result was retained. Inspect Recued Logs before retrying.',
          result: {
            status: 'in_doubt',
            code: outcome.reason,
            message:
              'The approval checkpoint was already consumed, but the final provider outcome is unavailable.',
          },
        });
    }
  });
};

const settleRecipeMcpAction = async (
  store: McpActionStore | undefined,
  auditLog: AuditLogStore,
  checkpoint: Checkpoint,
  response: ExecuteResponse,
): Promise<void> => {
  await updateMcpAction(store, checkpoint.run_id, async (actions) => {
    if (response.awaiting_approval === true) {
      const anchor = await auditLog.get(checkpoint.run_id);
      await actions.markAwaiting(
        checkpoint.run_id,
        anchor?.commit_status === 'awaiting_approval'
          ? anchor.checkpoint_id
          : undefined,
        'The resumed action reached another owner-approval gate.',
      );
      return;
    }
    const projected = projectRunResultForAgent(response);
    if (response.run_terminated !== undefined) {
      await actions.finish(checkpoint.run_id, {
        status: 'cancelled',
        status_message: 'The owner cancelled the resumed action.',
        result: projected,
      });
      return;
    }
    await actions.finish(checkpoint.run_id, {
      status: response.success ? 'completed' : 'failed',
      status_message: response.success
        ? 'The approved action completed.'
        : 'The approved action resumed but did not complete successfully.',
      result: projected,
    });
  });
};

/** Internal: a terminal `commit_status` value means the run finished.
 *  The resumer / deny path treats this as the idempotency signal — a
 *  retry from a stale checkpoint walks away without re-running the
 *  gated side-effect. */
const TERMINAL_RUN_ANCHOR_STATUSES = new Set<AuditEntry['commit_status']>([
  'succeeded',
  'failed',
  'cancelled',
  'in_doubt',
]);

/** Decision encoded by the at-entry idempotency guard. */
type IdempotencyDecision =
  | { kind: 'proceed'; anchor: AuditEntry }
  | { kind: 'skip'; reason: string };

/** D-173 N.5 §4 — one changed arg's old→new pair. `old` is the gated
 *  step's authored/prefilled value (or `undefined` for an override that
 *  ADDS a key absent from the authored args); `new` is the override the
 *  admin applied at approve time. */
export interface ArgEditDiff {
  key: string;
  old: unknown;
  new: unknown;
}

/** Reconstruct the live bearer grant(s) that can currently authorize this
 * recipe on the surface that created the hold. The checkpoint does not get to
 * assert that grant: installed publisher metadata + the approved ingredient
 * identity are evidence used to name the current token-store lookup.
 *
 * llm_gateway exposes Tier-2 recipes only, so its exact
 * `<publisher>/<recipe_id>` grant is required. Direct MCP can authorize the
 * same recipe through its exact Tier-2 entry, the generic runRecipe surface,
 * or — for the inline kernel `run-ingredient` recipe only — the exact
 * direct-ingredient wire tool. The fresh snapshot independently proves recipe
 * dependencies; a dependency grant never substitutes for top-level recipe
 * authority. */
const requiredResumeBearerToolNames = (
  checkpoint: Checkpoint,
  anchor: AuditEntry,
  executeDeps: ExecuteHandlerDeps,
): ReadonlyArray<string> | undefined => {
  const source = anchor.execution_source;
  if (!source) return undefined;

  const recipeId = checkpoint.recipe_id ?? anchor.recipe_id;
  const inlineRecipe = checkpoint.recipe_snapshot !== undefined;
  const recipe = checkpoint.recipe_snapshot ?? executeDeps.recipeStore.get(recipeId);
  const stored = inlineRecipe
    ? undefined
    : executeDeps.recipeStore.getStored?.(recipeId);
  const publisher =
    stored?.publisher_id
    ?? (recipe as { metadata?: { author?: unknown } } | null | undefined)
      ?.metadata?.author;
  const qualified =
    typeof publisher === 'string' && publisher.length > 0
      ? `${publisher}/${recipeId}`
      : undefined;

  if (
    source.channel === 'chat'
    && source.actor === 'contracted_user'
    && source.chat_session_id.startsWith('llm_gateway:')
  ) {
    // The LLM gateway exposes only pinned, store-resident Tier-2 recipes. An
    // inline snapshot cannot borrow a publisher-qualified grant merely by
    // claiming matching metadata.
    return !inlineRecipe && qualified ? [qualified] : [];
  }
  if (source.channel === 'mcp') {
    // ── D-232 § 20.19 — A RECORDED GRANT IS AN EXACT REQUIREMENT ──
    // Hoisted above BOTH arms below. When the anchor says this run's steps rode
    // a specific recipe grant, that grant — not a substitute — must still be
    // held. Without the hoist a door holding both `recued-core/X` and the
    // generic `recipe.run` could have `recued-core/X` revoked mid-ask and still
    // resume, because the Tier-2 arm accepts ANY of its names and the umbrella
    // would stand in. Strictly tightening: a run whose coverage came from
    // `recued-core/X` alone required that name already.
    const grantedBy = anchor.granted_by_recipe;
    if (typeof grantedBy === 'string' && grantedBy.length > 0) return [grantedBy];
    // The inline kernel run-ingredient recipe is reachable ONLY through the
    // exact per-ingredient wire tool. A generic recipe-run grant cannot load it
    // from RecipeStore, and a bare ingredient dependency grant is snapshot
    // authority rather than top-level call authority. Keep this arm exact so a
    // revoked `recued_ingredient_<slug>` cannot be substituted by either.
    if (recipeId === 'run-ingredient' && inlineRecipe) {
      if (hashRecipe(recipe) !== hashRecipe(RUN_INGREDIENT_RECIPE)) return [];
      // ── D-232 § 20.19 — A HOST-DISPATCHED CARRIER IS NOT A WIRE CALL ──
      //
      // The arm below is correct for what it was written for: a door that
      // called `run-ingredient` ITSELF, over the wire, to dispatch one
      // ingredient. That door must still hold the exact per-ingredient grant.
      //
      // An exchange fire's carrier is the other thing wearing the same recipe
      // id. The door never called it — the HOST dispatched it to carry a
      // granted recipe's own `output.exchange`, and no door can hold a grant on
      // `run-ingredient` because it is kernel plumbing, absent from the
      // marketplace and from `installRegistry`. Requiring the per-ingredient
      // wire grant here denied every approved answer at resume:
      // `bearer_grant_revoked` for a grant that was never grantable.
      //
      // ⛔ THIS IS NOT A DOWNGRADE TO "REQUIRE NOTHING". It substitutes the
      // grant that ACTUALLY justified the run — the declaring recipe's wire
      // name, recorded on the anchor at dispatch — so revoking THAT grant while
      // the ask is outstanding still denies the resume. The kill-switch keeps
      // its full strength; it just points at the real key.
      //
      // Reachable only from the host: `granted_by_recipe` is written by
      // `handleExecute` from a coverage it resolved itself, never from request
      // input (see `ExecuteInternal.granted_by_recipe`). The substitution
      // happens at the top of this branch, above both arms.
      const ingredient = checkpoint.approved_target?.ingredient_slug;
      return ingredient
        ? [`${MCP_INGREDIENT_TOOL_PREFIX}${ingredient}`]
        : [];
    }
    const names = new Set<string>(['recued_runRecipe', 'recipe.run']);
    // A qualified Tier-2 entry loads its recipe from RecipeStore. It cannot
    // authorize an arbitrary inline snapshot that copies the same author/id.
    if (!inlineRecipe && qualified) names.add(qualified);
    return [...names];
  }
  return undefined;
};

/** D-173 N.5 §4 — compute the changed-key diff between a gated step's
 *  authored/prefilled args and the inbox `arg_overrides` the admin applied
 *  at approve time. One entry per override key (overrides are an allowlist
 *  by construction — `reception.inbox.approve` validated them against the
 *  operation's `ArgEditSchema` (N.6) before they reached the checkpoint),
 *  carrying the authored `old` value (or `undefined` when the override adds
 *  a key) and the override `new` value. Prototype-sensitive override keys
 *  are skipped — they never reach the merge either (defense in depth).
 *  Pure + deterministic; the resume path emits it as the "approved with
 *  edits" audit breadcrumb.
 *
 *  N.6 reveal note: a sealed-PII edited value's reveal-on-record gating is
 *  driven by the `ArgEditField.privacy` facet, which `reception.inbox.
 *  approve` owns (Round 2). This helper records the raw old/new pair for
 *  the ephemeral resume breadcrumb; the DURABLE D-120 release-row diff
 *  field + its PII-reveal gating land with the rpc (the release-row carrier
 *  is a contracts type outside this lane's fence). */
export const computeArgEditsDiff = (
  authoredArgs: Record<string, unknown> | undefined,
  argOverrides: Record<string, unknown>,
): ArgEditDiff[] => {
  const proto = new Set(['__proto__', 'constructor', 'prototype']);
  const authored = authoredArgs ?? {};
  const diff: ArgEditDiff[] = [];
  for (const [key, value] of Object.entries(argOverrides)) {
    if (proto.has(key)) continue;
    diff.push({
      key,
      old: Object.prototype.hasOwnProperty.call(authored, key)
        ? authored[key]
        : undefined,
      new: value,
    });
  }
  return diff;
};

/** Build a `PreflightResumer` over `recued-server`'s `handleExecute` +
 *  `AuditLogStore`. */
export const createPreflightResumer = (
  deps: CreatePreflightResumerDeps,
): PreflightResumer => {
  const actionStoreFor = (executeDeps?: ExecuteHandlerDeps): McpActionStore | undefined =>
    executeDeps?.mcpActionStore ?? deps.mcpActionStore;
  /** At-entry idempotency check. Returns `proceed` only when the
   *  paused anchor is still `'awaiting_approval'` AND the audit row's
   *  `checkpoint_id` matches the one the leaf handed us. Every other
   *  state means a previous attempt of this same answer already won —
   *  we skip and let the caller consume the (now-stale) checkpoint.
   *
   *  Throws ONLY on transient I/O failure of `auditLog.get` — the leaf
   *  re-throws, and the next boot's sweep retries. A `null` row (the
   *  paused anchor was pruned by retention or never written) is a
   *  silent skip — the run is genuinely gone, no resume is possible. */
  const decide = async (
    checkpoint: Checkpoint,
  ): Promise<IdempotencyDecision> => {
    const anchor = await deps.auditLog.get(checkpoint.run_id);
    if (anchor === null) {
      return {
        kind: 'skip',
        reason: `paused anchor run_id=${checkpoint.run_id} not found — run was pruned or never persisted`,
      };
    }
    if (TERMINAL_RUN_ANCHOR_STATUSES.has(anchor.commit_status)) {
      return {
        kind: 'skip',
        reason:
          `paused anchor run_id=${checkpoint.run_id} is already terminal `
            + `(commit_status='${anchor.commit_status}') — answer is a retry of a completed run`,
      };
    }
    if (anchor.commit_status === 'awaiting_approval') {
      // A re-pause on a downstream gate would have rewritten the anchor
      // with a fresh `checkpoint_id`. If the row's `checkpoint_id` no
      // longer matches the one this answer is bound to, the answer is
      // for a stale checkpoint — let the leaf consume it without re-
      // dispatching.
      if (
        anchor.checkpoint_id !== undefined
        && anchor.checkpoint_id !== checkpoint.checkpoint_id
      ) {
        return {
          kind: 'skip',
          reason:
            `paused anchor run_id=${checkpoint.run_id} points at checkpoint `
              + `'${anchor.checkpoint_id}', not the one this answer is for `
              + `('${checkpoint.checkpoint_id}') — stale checkpoint, newer awaiting state takes precedence`,
        };
      }
      return { kind: 'proceed', anchor };
    }
    // Some other non-terminal value (e.g., a future RunAnchorStatus
    // value not in the terminal set). Conservative: skip rather than
    // re-dispatch into an unrecognised state.
    return {
      kind: 'skip',
      reason:
        `paused anchor run_id=${checkpoint.run_id} carries unexpected commit_status='${anchor.commit_status}'`,
    };
  };

  /** Build the `ExecuteRequest` that re-instantiates the paused run.
   *  Pulls the run-shape (config / trigger_source / instance_id /
   *  execution_source / contract_snapshot) off the paused audit row.
   *  `internal.run_id` + `internal.resume_from` live on the second
   *  parameter to `handleExecute` so the resume inherits both the
   *  seeded `step.*` and the original run-anchor identity. */
  const buildResumeInputs = (
    checkpoint: Checkpoint,
    anchor: AuditEntry,
    sessionGrant?: {
      ttl_ms: number;
      max_uses: number;
      risk_tier: string;
      // D-177 P5b — 'open' selects the provenance-pinned mint (N.11);
      // threaded opaquely, the Gateway validates the mode.
      grant_mode?: string;
    },
    batchClaim?: { contract_id: string; member_id: string },
  ): { request: ExecuteRequest; internal: NonNullable<Parameters<typeof handleExecute>[2]> } => {
    const request: ExecuteRequest = {
      // R2 step 6 — an inline run (R2 transient dispatch / derived saga
      // compensation) carries its RESOLVED recipe on the checkpoint; its
      // `recipe_id` resolves to nothing in the store. Integrity is
      // verified by the caller (`resumeRun` hash check against the
      // paused anchor) BEFORE this builder runs. Store-resident runs
      // resume by id exactly as before.
      // D-182 §8 — a raw-op checkpoint is routed to `resumeRawOp` before this
      // builder runs, so a checkpoint reaching here is recipe-bound and the
      // `isCheckpoint` guard guarantees `recipe_id` / `gated_step_id` (the `!`s
      // below assert that recipe-bound invariant).
      ...(checkpoint.recipe_snapshot !== undefined
        ? { recipe: checkpoint.recipe_snapshot }
        : { recipe_id: checkpoint.recipe_id! }),
      // D-157 BLOCKER 3 fold — `config_snapshot` now captures the
      // effective merged config the original run resolved
      // `{{config.*}}` against (recipe defaults + user overrides).
      // The resumer feeds it straight back so the resumed gated step
      // dispatches against the same values the gate evaluated.
      config: { ...anchor.config_snapshot },
      // Targeting guard follow-on (design § 8 / codex HIGH fold) — replay
      // the paused run's caller context (persisted on awaiting anchors
      // only). Context is run-scoped input frozen at dispatch: a gated
      // step resolving `{{context.entity_id}}` / `{{context.event...}}`
      // re-dispatches against the approved values instead of undefined.
      // Pre-fold anchors carry no snapshot — resume proceeds without
      // context exactly as before (the execute guard skips resumes).
      ...(anchor.context_snapshot !== undefined
        && Object.keys(anchor.context_snapshot).length > 0
        ? { context: { ...anchor.context_snapshot } }
        : {}),
      ...(anchor.trigger_source != null
        ? { trigger_source: anchor.trigger_source }
        : {}),
      ...(anchor.instance_id != null ? { instance_id: anchor.instance_id } : {}),
      ...(anchor.execution_source != null
        ? { execution_source: anchor.execution_source }
        : {}),
      ...(anchor.contract_snapshot != null
        ? { contract_snapshot: anchor.contract_snapshot }
        : {}),
      ...(anchor.process_id != null ? { process_id: anchor.process_id } : {}),
      // D-179 P1 — preserve standing-dish attribution + continuity across
      // the pause. The handler binds the dish WITHOUT re-merging its
      // overlay on resume (`internal.run_id` set), so the dispatch still
      // replays the anchor's approved `config_snapshot` verbatim.
      // Ephemeral ids are NOT replayed — the resumed run derives a fresh
      // one from the (same) run_id, which yields the identical value.
      ...(anchor.dish_id != null && !isEphemeralDishId(anchor.dish_id)
        ? { dish_id: anchor.dish_id }
        : {}),
    };
    return {
      request,
      internal: {
        run_id: checkpoint.run_id,
        // R2 step 6 — a paused saga compensation run re-instantiates with
        // its compensating link intact, so the dispatched commit still
        // stamps `predecessor_commit_id` (the checkpoint is the durable
        // carrier across the pause).
        ...(checkpoint.predecessor_commit_id !== undefined
          ? { predecessor_commit_id: checkpoint.predecessor_commit_id }
          : {}),
        // D-232 § 20.19 — carry the run's grant coverage across the pause. The
        // resumed run re-derives coverage from its OWN recipe name, and for a
        // host-dispatched carrier (`run-ingredient`) that derivation is
        // structurally empty — so without this the resume re-enters uncovered
        // and its step dies `tool_not_in_contract` AFTER the owner approved it.
        // Anchor-sourced, and the anchor was written by the host: the value
        // never originates from caller input. The resume authority above has
        // already re-verified that this exact grant is still held.
        ...(typeof anchor.granted_by_recipe === 'string'
          && anchor.granted_by_recipe.length > 0
          ? { granted_by_recipe: anchor.granted_by_recipe }
          : {}),
        resume_from: {
          gated_step_id: checkpoint.gated_step_id!,
          step_state: checkpoint.step_state,
          // D-165 follow-on (op-identity binding) — feed the approved
          // identity back so the catalog gate re-verifies the resumed call
          // still targets it (a `{{config.*}}` connection that changed while
          // paused re-asks instead of silently dispatching against the drift).
          ...(checkpoint.approved_target !== undefined
            ? { approved_target: checkpoint.approved_target }
            : {}),
          // D-173 N.5 — feed the consumed checkpoint's editable-args
          // overrides back so the engine merges them over the gated step's
          // authored args on resume (gated step only). THIS is the boundary
          // origin (N.5 MUST): `arg_overrides` flows ONLY from the consumed
          // `checkpoint` object — written by the admin-only
          // `reception.inbox.approve` rpc before it triggered this resume —
          // never from any caller / channel / context input. Absent on a
          // plain binary-gate checkpoint ⇒ the resumed run is byte-identical
          // to D-157's binary approve/deny path.
          ...(checkpoint.arg_overrides !== undefined
            ? { arg_overrides: checkpoint.arg_overrides }
            : {}),
          // D-177 P3 — the `allow_session` answer's mint instruction. THIS
          // is the boundary origin: it flows ONLY from the answer-time
          // `PreflightAskContext` (the durable handler read it back off the
          // ask payload the raise site authored, and forwarded it exactly
          // when the recorded answer was `allow_session`) — never from any
          // caller / channel / context input. Absent on approve/deny ⇒ the
          // resume is byte-identical to the plain binary path.
          ...(sessionGrant !== undefined ? { session_grant: sessionGrant } : {}),
          // D-177 P5a — the batched approve's member-claim instruction.
          // Same boundary origin discipline: flows ONLY from the batch
          // answer flow's resume context (`batch-approval.ts` is the sole
          // writer), never from caller / channel / context input. Absent
          // ⇒ byte-identical to the plain path.
          ...(batchClaim !== undefined ? { batch_claim: batchClaim } : {}),
          // § 7 follow-on (pii-ledger-in-checkpoint) — feed the paused run's
          // serialized pii ledgers back so the engine hydrates its run store
          // and post-gate `pii-restore` steps return REAL values instead of
          // passing aliases through (the s7 codex HIGH). Absent on legacy
          // checkpoints / runs that never aliased ⇒ a plain fresh store,
          // byte-identical to the prior resume path.
          ...(checkpoint.pii_ledgers !== undefined
            ? { pii_ledgers: checkpoint.pii_ledgers }
            : {}),
        },
      },
    };
  };

  /** Replace an awaiting run anchor with one terminal failure. Used by both a
   * human deny and an approve whose live authority disappeared before act time.
   * Keeping the write in one helper preserves the existing insert-or-replace
   * idempotency boundary and prevents a consumed checkpoint from leaving a
   * dangling `awaiting_approval` row. */
  const appendFailedAnchor = async (input: {
    checkpoint: Checkpoint;
    anchor: AuditEntry;
    recipe_hash: string;
    error: RecipeError;
  }): Promise<void> => {
    const { checkpoint, anchor } = input;
    const finishedAt = Date.now();
    const entry = buildAuditEntry({
      recipe_id: anchor.recipe_id,
      recipe_hash: input.recipe_hash,
      commit_status: 'failed',
      duration_ms: Math.max(0, finishedAt - anchor.started_at),
      // Use the same clock sample as duration_ms. Sampling again inside
      // buildAuditEntry can cross a millisecond boundary and shift the
      // replacement row's started_at, breaking paused-run continuity.
      now: finishedAt,
      errors: [input.error],
      config_snapshot: { ...anchor.config_snapshot },
      trigger_url: anchor.trigger_url ?? null,
      trigger_source: anchor.trigger_source ?? null,
      instance_id: anchor.instance_id ?? null,
      run_id: checkpoint.run_id,
      ...(anchor.recipe_insight_id !== undefined
        ? { recipe_insight_id: anchor.recipe_insight_id }
        : {}),
      ...(anchor.backfill ? { backfill: anchor.backfill } : {}),
      ...(anchor.process_id ? { process_id: anchor.process_id } : {}),
      ...(anchor.run_mode ? { run_mode: anchor.run_mode } : {}),
      ...(anchor.execution_source
        ? { execution_source: anchor.execution_source }
        : {}),
      ...(anchor.contract_snapshot
        ? { contract_snapshot: anchor.contract_snapshot }
        : {}),
      ...(anchor.channel_session_id
        ? { channel_session_id: anchor.channel_session_id }
        : {}),
      ...(anchor.cognition_session_id
        ? { cognition_session_id: anchor.cognition_session_id }
        : {}),
      ...(anchor.correlation_id
        ? { correlation_id: anchor.correlation_id }
        : {}),
    });
    await deps.auditLog.append(entry);
  };

  return {
    async resumeRun(
      checkpoint: Checkpoint,
      context: PreflightAskContext,
    ): Promise<void> {
      // D-182 §8 — a recipe-LESS raw-op door hold resumes through its own path:
      // there is no run anchor to `decide()` against, and the held op is
      // re-dispatched directly (not via `executeRecipe`). The at-most-once claim
      // + op re-resolve + admission + dispatch + grant mint all live in
      // `resumeRawOp`. An absent `executeDeps` is transient (bootstrap) — throw
      // so the leaf leaves the ask answered for the next boot's retry (the claim
      // is inside `resumeRawOp`, after this point, so no double-act).
      if (checkpoint.raw_op !== undefined) {
        const executeDeps = deps.getExecuteDeps();
        if (!executeDeps) {
          throw new Error(
            `[preflight-resumer] resumeRun (raw_op): executeDeps not yet published — `
              + `run_id=${checkpoint.run_id} (transient; next boot will retry)`,
          );
        }
        await updateMcpAction(
          actionStoreFor(executeDeps),
          checkpoint.run_id,
          (actions) => actions.markRunning(checkpoint.run_id),
        );
        const outcome = await resumeRawOp(executeDeps, checkpoint, {
          ...(context.session_grant !== undefined
            ? { session_grant: context.session_grant }
            : {}),
        });
        await settleRawMcpAction(actionStoreFor(executeDeps), checkpoint, outcome);
        return;
      }
      const decision = await decide(checkpoint);
      if (decision.kind === 'skip') {
        // No-op return — codex BLOCKER 1 fold makes this the
        // idempotency boundary. The leaf consumes the checkpoint and
        // the at-least-once retry cycle terminates.
        console.warn(`[preflight-resumer] resumeRun skipped: ${decision.reason}`);
        return;
      }
      // D-202 Slice 1b — record the owner's APPROVE as a `quality_good` verdict
      // for the reject-driven learner (only when this was a quality-relevant ask,
      // gated inside the helper). Placed at the proceed boundary so it captures
      // the owner's content verdict independent of the downstream resume outcome
      // (a later authz re-check denial is an authorization concern, §12.1). The
      // `decide()` proceed guard means a boot-sweep retry of a completed run
      // skips above (no re-capture); a retry of a still-awaiting run re-captures
      // idempotently (deterministic `signal_id`). Best-effort — never throws.
      if (deps.qualityDelegationSignalStore !== undefined) {
        captureQualityDelegationSignal(
          { signalStore: deps.qualityDelegationSignalStore },
          {
            checkpoint,
            anchor: decision.anchor,
            outcome: 'approve',
            at: context.approved_at ?? Date.now(),
          },
        );
      }
      const executeDeps = deps.getExecuteDeps();
      if (!executeDeps) {
        // Transient: the host hasn't finished bootstrapping. THROW so
        // the leaf does NOT consume the checkpoint — the next boot's
        // sweep retries (codex BLOCKER 2 fold).
        throw new Error(
          `[preflight-resumer] resumeRun: executeDeps not yet published — run_id=${checkpoint.run_id} (transient; next boot will retry)`,
        );
      }
      await updateMcpAction(
        actionStoreFor(executeDeps),
        checkpoint.run_id,
        (actions) => actions.markRunning(checkpoint.run_id),
      );
      // R2 step 6 — inline-run snapshot integrity. The checkpoint's
      // `recipe_snapshot` is a PRE-ENGINE deep copy of the resolved recipe
      // the paused run executed, captured at the same state the anchor's
      // `recipe_hash` was stamped from (engine entry, before the engine's
      // in-place `output` alias normalization) — so an untampered pair
      // hashes equal. A mismatch means the on-disk checkpoint was tampered
      // with (or corrupted) while paused — re-instantiating it would
      // dispatch a recipe the user never approved. Fail closed and replace
      // the awaiting anchor with a terminal audit row before the answer leaf
      // consumes the checkpoint; the user must re-run.
      if (checkpoint.recipe_snapshot !== undefined) {
        const snapshotHash = hashRecipe(
          checkpoint.recipe_snapshot as unknown as RecipeDefinition,
        );
        if (snapshotHash !== decision.anchor.recipe_hash) {
          const integrityError: RecipeError = {
            error_id:
              `checkpoint-integrity-${Date.now().toString(36)}-`
              + checkpoint.run_id,
            code: 'RECIPE_VALIDATION_FAILED',
            message:
              'The saved resume checkpoint no longer matches the approved recipe.',
            severity: 'fatal',
            source: {
              recipe_id: decision.anchor.recipe_id,
              step_id: checkpoint.gated_step_id ?? null,
              ingredient_slug: context.tool_slug ?? null,
            },
            details: { reason: 'checkpoint_integrity_failed' },
            timestamp: new Date().toISOString(),
            retryable: false,
          };
          console.warn(
            `[preflight-resumer] resumeRun refused: checkpoint recipe_snapshot hash `
              + `'${snapshotHash}' does not match the paused anchor's recipe_hash `
              + `'${decision.anchor.recipe_hash}' (run_id=${checkpoint.run_id}) — `
              + `tampered/corrupt checkpoint; re-run the recipe`,
          );
          await appendFailedAnchor({
            checkpoint,
            anchor: decision.anchor,
            recipe_hash: decision.anchor.recipe_hash,
            error: integrityError,
          });
          await updateMcpAction(
            actionStoreFor(executeDeps),
            checkpoint.run_id,
            (actions) => actions.finish(checkpoint.run_id, {
              status: 'failed',
              status_message: 'The saved resume checkpoint failed its integrity check.',
              result: {
                status: 'failed',
                code: 'checkpoint_integrity_failed',
                message: integrityError.message,
              },
            }),
          );
          return;
        }
      }
      // R2 step 6 (codex HIGH fold) — predecessor provenance integrity.
      // `predecessor_commit_id` is NOT independently trusted off the
      // checkpoint row: a saga compensation recipe's id is
      // `saga-undo-<predecessor_commit_id>` BY CONSTRUCTION
      // (`deriveCompensation`), and that recipe_id sits INSIDE the
      // hash-verified `recipe_snapshot` above — so the snapshot is the
      // tamper-evident carrier and the checkpoint field must agree with
      // it. Any checkpoint carrying a predecessor that (a) has no
      // snapshot, (b) whose snapshot recipe_id is not a compensation id,
      // or (c) disagrees with the id-embedded commit ref was edited on
      // disk to forge compensation provenance — refuse the resume.
      if (checkpoint.predecessor_commit_id !== undefined) {
        const snapshotRecipeId = (
          checkpoint.recipe_snapshot as { recipe_id?: unknown } | undefined
        )?.recipe_id;
        const expectedPredecessor =
          typeof snapshotRecipeId === 'string'
          && snapshotRecipeId.startsWith(COMPENSATION_RECIPE_ID_PREFIX)
            ? snapshotRecipeId.slice(COMPENSATION_RECIPE_ID_PREFIX.length)
            : undefined;
        if (
          expectedPredecessor === undefined
          || checkpoint.predecessor_commit_id !== expectedPredecessor
        ) {
          const provenanceError: RecipeError = {
            error_id:
              `checkpoint-provenance-${Date.now().toString(36)}-`
              + checkpoint.run_id,
            code: 'RECIPE_VALIDATION_FAILED',
            message:
              'The saved compensation provenance no longer matches the approved action.',
            severity: 'fatal',
            source: {
              recipe_id: decision.anchor.recipe_id,
              step_id: checkpoint.gated_step_id ?? null,
              ingredient_slug: context.tool_slug ?? null,
            },
            details: { reason: 'checkpoint_provenance_failed' },
            timestamp: new Date().toISOString(),
            retryable: false,
          };
          console.warn(
            `[preflight-resumer] resumeRun refused: checkpoint predecessor_commit_id `
              + `'${checkpoint.predecessor_commit_id}' is not bound by the hash-verified `
              + `recipe_snapshot (expected '${expectedPredecessor ?? '<none>'}' from the `
              + `compensation recipe id) — forged/corrupt compensation provenance `
              + `(run_id=${checkpoint.run_id}); re-run the recipe`,
          );
          await appendFailedAnchor({
            checkpoint,
            anchor: decision.anchor,
            recipe_hash: decision.anchor.recipe_hash,
            error: provenanceError,
          });
          await updateMcpAction(
            actionStoreFor(executeDeps),
            checkpoint.run_id,
            (actions) => actions.finish(checkpoint.run_id, {
              status: 'failed',
              status_message: 'The saved compensation checkpoint failed its integrity check.',
              result: {
                status: 'failed',
                code: 'checkpoint_provenance_failed',
                message: provenanceError.message,
              },
            }),
          );
          return;
        }
      }
      // D-173 N.5 §4 — when this is an approve-with-edits resume, record
      // the "approved with edits" + changed-key diff (old→new) audit
      // breadcrumb. Attributable to the same admin approve action that
      // authored the edits (N.5 §3 soundness). The "old" side is the gated
      // step's authored/prefilled `input` (the projection-prefilled value
      // before the edit); the "new" side is the override. The DURABLE
      // D-120 release-row diff field lands with `reception.inbox.approve`
      // (Round 2) — its carrier (`GatewayCallAudit` / `AuditEntry`) is a
      // contracts type outside this lane's fence — so this lane emits the
      // ephemeral structured breadcrumb and computes the diff via the
      // exported `computeArgEditsDiff` the rpc will reuse.
      if (checkpoint.arg_overrides !== undefined) {
        // Recipe-bound by construction here (raw-op routed above).
        const recipe = executeDeps.recipeStore.get(checkpoint.recipe_id!);
        const gatedStep = recipe?.steps?.find(
          (s) => (s as { id?: string }).id === checkpoint.gated_step_id,
        ) as { input?: unknown } | undefined;
        const authoredArgs =
          gatedStep?.input
          && typeof gatedStep.input === 'object'
          && !Array.isArray(gatedStep.input)
            ? (gatedStep.input as Record<string, unknown>)
            : undefined;
        const diff = computeArgEditsDiff(authoredArgs, checkpoint.arg_overrides);
        console.info(
          `[preflight-resumer] approved-with-edits run_id=${checkpoint.run_id} `
            + `step='${checkpoint.gated_step_id}' edits=`
            + JSON.stringify(diff),
        );
      }

      // D-196 R2 — the awaiting anchor is evidence of what the user approved,
      // never authority for the later effect. Re-read the bearer and rebuild
      // Seller/contract/grant/route/read-fence authority immediately before
      // `handleExecute`. A denial terminalizes the anchor without invoking the
      // engine, so no pre-gate step or external effect can run and the consumed
      // checkpoint cannot leave a dangling awaiting row.
      let resumeAnchor = decision.anchor;
      const persistedSource = decision.anchor.execution_source;
      const requiresFreshBearer =
        persistedSource?.channel === 'mcp'
        || (
          persistedSource?.channel === 'chat'
          && persistedSource.actor === 'contracted_user'
        );
      if (persistedSource !== undefined && requiresFreshBearer) {
        let authority: ReturnType<
          NonNullable<ExecuteHandlerDeps['approvalResumeAuthority']>['resolve']
        >;
        if (executeDeps.approvalResumeAuthority === undefined) {
          authority = {
            admitted: false,
            reason: 'authority_resolution_failed',
            detail: 'approval-resume authority resolver is unavailable',
          };
        } else {
          try {
            const requiredBearerToolNames = requiredResumeBearerToolNames(
              checkpoint,
              decision.anchor,
              executeDeps,
            );
            authority = executeDeps.approvalResumeAuthority.resolve({
              execution_source: persistedSource,
              ...(requiredBearerToolNames !== undefined
                ? {
                    required_bearer_tool_names: requiredBearerToolNames,
                  }
                : {}),
            });
          } catch (error) {
            authority = {
              admitted: false,
              reason: 'authority_resolution_failed',
              detail: error instanceof Error ? error.message : String(error),
            };
          }
        }
        if (
          authority.admitted
          && executionSourceHasContract(authority.execution_source)
          && authority.contract_snapshot === undefined
        ) {
          authority = {
            admitted: false,
            reason: 'authority_resolution_failed',
            detail: 'fresh authority returned no contract snapshot',
          };
        }
        if (!authority.admitted) {
          const authorityError: RecipeError = {
            error_id:
              `approval-resume-authority-${Date.now().toString(36)}-`
              + checkpoint.run_id,
            code: 'RECIPE_POLICY_DENIED',
            message:
              `Approval resume denied because live authority changed `
              + `(${authority.reason}: ${authority.detail}).`,
            severity: 'fatal',
            source: {
              recipe_id: decision.anchor.recipe_id,
              step_id: checkpoint.gated_step_id!,
              ingredient_slug: context.tool_slug ?? null,
            },
            details: { authority_reason: authority.reason },
            timestamp: new Date().toISOString(),
            retryable: false,
          };
          await appendFailedAnchor({
            checkpoint,
            anchor: decision.anchor,
            recipe_hash: decision.anchor.recipe_hash,
            error: authorityError,
          });
          console.warn(
            `[preflight-resumer] resumeRun denied by fresh authority: `
              + `${authority.reason}: ${authority.detail} `
              + `(run_id=${checkpoint.run_id})`,
          );
          await updateMcpAction(
            actionStoreFor(executeDeps),
            checkpoint.run_id,
            (actions) => actions.finish(checkpoint.run_id, {
              status: 'failed',
              status_message: authorityError.message,
              result: {
                status: 'failed',
                code: authorityError.code,
                message: authorityError.message,
              },
            }),
          );
          return;
        }
        resumeAnchor = { ...decision.anchor };
        resumeAnchor.execution_source = authority.execution_source;
        if (authority.contract_snapshot !== undefined) {
          resumeAnchor.contract_snapshot = authority.contract_snapshot;
        } else {
          delete resumeAnchor.contract_snapshot;
        }
      }
      const { request, internal } = buildResumeInputs(
        checkpoint,
        resumeAnchor,
        context.session_grant,
        context.batch_claim,
      );
      // Dispatch through the normal handler with the internal
      // overrides. A throw propagates out — the leaf leaves the ask
      // `'answered'` and the next boot retries; the at-entry guard
      // above keeps the retry idempotent (a partially-successful run
      // that crashed before checkpoint deletion will appear terminal
      // on retry and walk away).
      let response: ExecuteResponse;
      try {
        response = await handleExecute(executeDeps, request, internal);
      } catch (error) {
        // The established answer-retry path still owns recovery. Put the action
        // back into a waiting state so a transient host failure never reads as a
        // terminal provider failure or invites the MCP caller to resend.
        await updateMcpAction(
          actionStoreFor(executeDeps),
          checkpoint.run_id,
          (actions) => actions.markAwaiting(
            checkpoint.run_id,
            checkpoint.checkpoint_id,
            'Resume was interrupted before a terminal result; Recued will retry from the durable checkpoint.',
          ),
        );
        throw error;
      }
      // If the resumed run paused again (a second gate downstream),
      // the host has already written a fresh `'awaiting_approval'` row
      // + minted its own checkpoint. Nothing more to do — the new
      // anchor and checkpoint are the resume-of-resume target.
      await settleRecipeMcpAction(
        actionStoreFor(executeDeps),
        deps.auditLog,
        checkpoint,
        response,
      );
    },

    async denyRun(
      checkpoint: Checkpoint,
      context: PreflightAskContext,
    ): Promise<void> {
      // D-182 §8 — a recipe-LESS raw-op door hold has no run anchor to transition
      // to `'failed'`; the op never dispatched, so the deny is a logged no-op
      // (the answer handler's trailing `delete` consumes the checkpoint).
      if (checkpoint.raw_op !== undefined) {
        await denyRawOp(checkpoint);
        const actionStore = actionStoreFor(deps.getExecuteDeps());
        await updateMcpAction(actionStore, checkpoint.run_id, (actions) =>
          actions.finish(checkpoint.run_id, {
            status: 'denied',
            status_message: 'The owner denied the pending operation.',
            result: {
              status: 'denied',
              denied: true,
              message: 'The owner denied the pending operation; no provider call was dispatched.',
            },
          }));
        return;
      }
      const decision = await decide(checkpoint);
      if (decision.kind === 'skip') {
        console.warn(`[preflight-resumer] denyRun skipped: ${decision.reason}`);
        return;
      }
      const anchor = decision.anchor;
      // D-202 Slice 1b — record the owner's DENY as a `quality_bad` verdict for
      // the reject-driven learner (only when this was a quality-relevant ask,
      // gated inside the helper). A reject knocks the (recipe, op)'s quality
      // confidence down; the offer re-earns only on fresh approves after it
      // (§6/§8). Deterministic `signal_id` keeps a boot-sweep retry idempotent;
      // best-effort — never throws. `at` = the resolve clock (the deny context
      // carries no answer time, unlike approve's `approved_at`). A boot-sweep
      // re-dispatch of a deny that crashed before its failed-anchor append
      // could re-stamp `at` to the (later) retry clock — but that is FAIL-SAFE:
      // a later `lastRejectAt` can only EXCLUDE approves before it (§8 — a
      // reject never earns an offer), so a drifted deny `at` can only delay a
      // suggestion, never wrongly produce one.
      if (deps.qualityDelegationSignalStore !== undefined) {
        captureQualityDelegationSignal(
          { signalStore: deps.qualityDelegationSignalStore },
          {
            checkpoint,
            anchor,
            outcome: 'reject',
            at: Date.now(),
          },
        );
      }
      // Re-derive the recipe-hash off the recipe store so the deny row
      // honestly records what the user denied (matches the audit
      // contract: `recipe_hash` is the recipe-shape under which the
      // call was attempted). Falls back to the paused anchor's hash if
      // the recipe is no longer installed — the resume couldn't have
      // succeeded either way; the deny row carries the historical
      // hash, which is the right value for a denied retroactive
      // review.
      // Recipe-bound by construction here (raw-op routed above); the anchor's
      // `recipe_id` is the required-string authority for the deny row.
      const recipe = deps.getExecuteDeps()?.recipeStore.get(anchor.recipe_id);
      const recipe_hash = recipe
        ? hashRecipe(recipe as RecipeDefinition)
        : anchor.recipe_hash;

      const denyError: RecipeError = {
        error_id: `preflight-deny-${Date.now().toString(36)}-${checkpoint.run_id}`,
        code: 'RECIPE_POLICY_DENIED',
        message:
          `User denied preflight approval for `
            + (context.tool_slug !== undefined
              ? `'${context.tool_slug}'`
              : 'a boundary-crossing call')
            + (context.risk_tier !== undefined
              ? ` (risk_tier='${context.risk_tier}')`
              : '')
            + ` at step '${checkpoint.gated_step_id}'.`,
        severity: 'fatal',
        source: {
          recipe_id: anchor.recipe_id,
          step_id: checkpoint.gated_step_id!,
          ingredient_slug: context.tool_slug ?? null,
        },
        details: {},
        timestamp: new Date().toISOString(),
        retryable: false,
      };

      // The deny row keys on the same `run_id` as the paused anchor —
      // SQLite's `INSERT OR REPLACE` flips the row from
      // `'awaiting_approval'` to `'failed'` in one write. The original
      // anchor's `commit_status` is retired in place. Duration is the
      // elapsed time between the original run's start and the answer
      // arriving — `buildAuditEntry` computes `started_at = finished_at
      // - duration_ms`, so feeding that delta reproduces the original
      // `started_at` exactly. A throw propagates out — codex BLOCKER
      // 2 fold: the leaf leaves the ask `'answered'`, next boot
      // retries; the at-entry guard makes that retry idempotent (the
      // already-failed row triggers the terminal-status skip path).
      await appendFailedAnchor({
        checkpoint,
        anchor,
        recipe_hash,
        error: denyError,
      });
      const actionStore = actionStoreFor(deps.getExecuteDeps());
      await updateMcpAction(actionStore, checkpoint.run_id, (actions) =>
        actions.finish(checkpoint.run_id, {
          status: 'denied',
          status_message: 'The owner denied the pending action.',
          result: {
            status: 'denied',
            denied: true,
            message: denyError.message,
          },
        }));
    },
  };
};
