/** D-177 P5a — the batch-approval coordinator (N.10).
 *
 *  The server-side flow over the pure vocabulary (`@recued/contracts`
 *  `batched-approval.ts`) and the durable row store (`@recued/storage`
 *  `batch-asks.ts`). Two halves, one closure:
 *
 *  HOLD SIDE (`registerHold` — called from `handleExecute`'s
 *  awaiting-approval branch, after the checkpoint is durable):
 *    - no open row for the hold's key → create the row (one member) and
 *      raise the v1 ask. The v1 ask is byte-compatible with the P3
 *      single-hold ask (same options incl. a resolvable `allow_session`
 *      offer, same legacy payload fields) PLUS the batch identity +
 *      version pin + the one-item rendering.
 *    - an open row matches → JOIN: append the member (version bump),
 *      CANCEL the superseded version's ask, raise the re-rendered ask
 *      (enumerated items; `allow_session` is NOT offered on a
 *      multi-member ask — exact-mode bounds have no meaning over N
 *      distinct payloads). The anchor pairing (`ask_id` ↔ awaiting
 *      anchor) uses the returned ask_id, so the boot sweep treats joined
 *      members as already-paired (it never re-raises per member).
 *    - anything that cannot batch (cap overflow, store failure, race
 *      with a concurrent close) → `'fallback'`, and the caller raises
 *      today's per-hold ask — strictly additive, never fewer reviews.
 *
 *  ANSWER SIDE (`hooks.handleAnswer` — the `gateway.preflight` handler
 *  delegates any `batch_id`-carrying payload here):
 *    - version-guarded close (`open → closing`, N.10): a stale answer
 *      (version moved — a JOIN re-rendered after that ask was raised) is
 *      REJECTED; the live re-rendered ask is the re-ask. The recorded
 *      `(option, version)` makes an at-least-once re-dispatch provably
 *      the same answer (`'reentry'`) finishing interrupted work.
 *    - deny → `denyRun` every member (idempotent per the resumer's
 *      anchor guard), consume the checkpoints, `answered`.
 *    - approve, one member → EXACTLY the landed P3 path (plain marker
 *      resume; `allow_session` mints the exact grant) — the batch
 *      machinery is dormant at N=1 by design.
 *    - approve, N≥2 → mint ONE `grant_mode: 'batch'` grant from the
 *      member snapshot (`max_uses` = member count), then resume each
 *      member with its `batch_claim` marker: the resumed dispatch
 *      atomically claims ITS member at the Gateway proceed point (the
 *      claim IS the consumption — N.4), and an agent replay claims by
 *      hash equality through the matcher's batch arm. Either way the
 *      member burns once — TOTAL EXECUTIONS NEVER EXCEED THE APPROVED
 *      COUNT. A failed mint degrades to plain marker resumes (the
 *      approval still executes; only the replay-absorption grant is
 *      dropped).
 *
 *  CONCURRENCY: every store mutation (find-or-create, join, close,
 *  answer work) runs through ONE global promise-chain. Batch operations
 *  are human-paced (holds + answers), the backing Collection is async
 *  (read-modify-write would otherwise interleave), and a single mutex
 *  removes the whole join-vs-close race class. Cross-process safety is
 *  the durable state machine itself (version guard + recorded answer +
 *  idempotent re-entry).
 *
 *  Spec: docs/d-177-spec.md § N.10 / N.4; landing order P5a. */

import {
  BATCH_ASK_MAX_MEMBERS,
  SESSION_GRANT_RISK_TIERS,
  deriveOriginUnit,
  executionSourceContractId,
  isDoorDispatchSource,
  summarizeArgsPreview,
} from '@recued/contracts';
import type {
  BatchAskKey,
  BatchAskRecord,
  Checkpoint,
  ExecutionSource,
  RiskTier,
  SessionGrantOffer,
} from '@recued/contracts';
import {
  buildPreflightAsk,
  readSessionGrantPayload,
} from '@recued/gateway';
import type {
  PreflightAskContext,
  PreflightBatchAnswerHooks,
  PreflightNotifier,
  PreflightResumer,
} from '@recued/gateway';
import type { Answer } from '@recued/notification';
import type { BatchAskStore, CheckpointStore } from '@recued/storage';
import { randomUUID } from 'node:crypto';

import type { SessionGrantResolver } from './session-grant-resolver.js';

/** Everything the hold site knows about one freshly-checkpointed hold.
 *  The coordinator derives the origin unit (`deriveOriginUnit`) and the
 *  member summary (`summarizeArgsPreview`) itself — one home each. */
export interface BatchHoldRegistration {
  readonly source: ExecutionSource;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly channel_session_id: string;
  readonly ingredient_slug: string;
  readonly operation_id?: string;
  readonly connection_name?: string;
  readonly risk_tier: RiskTier;
  readonly recipe_id: string;
  readonly recipe_hash: string;
  readonly arg_shape_hash: string;
  readonly canonical_payload_hash: string;
  readonly args_preview?: Record<string, unknown>;
  /** The durable checkpoint this hold pauses on (already written). */
  readonly checkpoint: Checkpoint;
  /** The structured ask-body fields off the signal (tool/risk/reason).
   *  D-177 P5b — `open_projection_preview` rides for the v1 (single-member)
   *  ask's open-grant rendering; dropped alongside the offer on JOIN
   *  re-renders (no open semantics over N distinct payloads). */
  readonly ask_context: {
    readonly tool_slug?: string;
    readonly risk_tier?: string;
    readonly reason?: string;
    readonly open_projection_preview?: {
      readonly pinned: ReadonlyArray<{
        readonly label: string;
        readonly value: string;
      }>;
      readonly varying: ReadonlyArray<{
        readonly label: string;
        readonly origin: string;
      }>;
    };
  };
  /** The P3 `allow_session` offer for this hold, when the host resolved
   *  one. Rides the v1 (single-member) ask only — a JOIN re-render drops
   *  it (no exact-mode semantics over N distinct payloads). */
  readonly session_grant_offer?: SessionGrantOffer;
}

export type RegisterHoldResult =
  | { kind: 'registered'; ask_id: string }
  /** The hold cannot batch — the caller raises today's per-hold ask. */
  | { kind: 'fallback' };

export interface BatchApprovalCoordinator {
  registerHold(reg: BatchHoldRegistration): Promise<RegisterHoldResult>;
  readonly hooks: PreflightBatchAnswerHooks;
}

export interface CreateBatchApprovalCoordinatorDeps {
  readonly batchAskStore: BatchAskStore;
  readonly checkpointStore: CheckpointStore;
  readonly resumer: PreflightResumer;
  readonly notifier: PreflightNotifier;
  /** `NotificationBlock.cancelAsk` — retires the superseded version's
   *  ask on JOIN. */
  readonly cancelAsk: (ask_id: string) => Promise<'cancelled' | 'not_open'>;
  /** The batch mint + (transitively) the member-claim substrate. Absent
   *  (dbless harness) ⇒ approves degrade to plain marker resumes. */
  readonly sessionGrantResolver?: SessionGrantResolver;
  readonly now?: () => number;
  readonly newBatchId?: () => string;
}

/** Read the batch identity off a persisted handler payload. */
const readBatchPayload = (
  payload: Record<string, unknown>,
): { batch_id: string; payload_version: number } | undefined => {
  if (typeof payload.batch_id !== 'string' || payload.batch_id.length === 0) {
    return undefined;
  }
  if (
    typeof payload.payload_version !== 'number'
    || !Number.isInteger(payload.payload_version)
    || payload.payload_version < 1
  ) {
    return undefined;
  }
  return { batch_id: payload.batch_id, payload_version: payload.payload_version };
};

export const createBatchApprovalCoordinator = (
  deps: CreateBatchApprovalCoordinatorDeps,
): BatchApprovalCoordinator => {
  const now = deps.now ?? ((): number => Date.now());
  const newBatchId = deps.newBatchId ?? ((): string => `ba_${randomUUID()}`);

  // ONE global mutex over every row mutation (module doc). Failures do
  // not poison the chain — each link swallows into the next.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  /** Raise (or re-raise) the row's ask at its CURRENT version. The
   *  checkpoint argument anchors the legacy payload fields — the v1
   *  member's own checkpoint, or (on JOIN re-renders) the newest
   *  member's; those fields are inert while the batch hooks intercept
   *  (the `batch_id` routes first) and exist for the v1-row-missing
   *  fallback + debuggability. */
  const raiseBatchAsk = async (
    row: BatchAskRecord,
    checkpoint: Checkpoint,
    askContext: BatchHoldRegistration['ask_context'],
    offer: SessionGrantOffer | undefined,
  ): Promise<string> => {
    const context: PreflightAskContext = {
      recipe_id: row.recipe_id,
      gated_step_id: checkpoint.gated_step_id,
      ...(askContext.tool_slug !== undefined
        ? { tool_slug: askContext.tool_slug }
        : {}),
      // Off the ROW, not the registration: `connection_name` is part of
      // the aggregation key, so every member of this batch agrees on it
      // by construction — the row is the authority for what the whole
      // approval lands on. (Populated for catalog holds only; a
      // simple-form hold's row carries no connection — see the field's
      // note on `PreflightAskContext`.)
      ...(row.connection_name !== undefined
        ? { connection_name: row.connection_name }
        : {}),
      ...(askContext.risk_tier !== undefined
        ? { risk_tier: askContext.risk_tier }
        : {}),
      ...(askContext.reason !== undefined ? { reason: askContext.reason } : {}),
      // `allow_session` rides single-member asks only (P3 parity). The P5b
      // open preview follows the same rule — it renders the offer's
      // open-grant block, which only exists where the offer does.
      ...(offer !== undefined && row.members.length === 1
        ? { session_grant: offer }
        : {}),
      ...(offer !== undefined
        && row.members.length === 1
        && askContext.open_projection_preview !== undefined
        ? { open_projection_preview: askContext.open_projection_preview }
        : {}),
      batch: {
        batch_id: row.batch_id,
        payload_version: row.payload_version,
        items: row.members.map((m) => ({
          member_id: m.member_id,
          canonical_payload_hash: m.canonical_payload_hash,
          summary: m.summary,
          ...(m.args_preview !== undefined
            ? { args_preview: m.args_preview }
            : {}),
        })),
        unit: { kind: row.unit_kind, id: row.unit_id },
      },
    };
    const { message, options, handler } = buildPreflightAsk({
      checkpoint,
      context,
    });
    const { ask_id } = await deps.notifier.ask(message, options, handler);
    await deps.batchAskStore.setCurrentAsk(row.batch_id, ask_id);
    return ask_id;
  };

  const registerHold = (reg: BatchHoldRegistration): Promise<RegisterHoldResult> =>
    serialize(async (): Promise<RegisterHoldResult> => {
      try {
        // Batch only what the eventual grant could bind (D7): write/admin.
        // read/destructive-tier holds keep per-hold asks (destructive
        // deserves individual review; read-tier asks are rare policy
        // configurations).
        if (
          !(SESSION_GRANT_RISK_TIERS as readonly string[]).includes(reg.risk_tier)
        ) {
          return { kind: 'fallback' };
        }
        const unit = deriveOriginUnit(reg.source, {
          run_id: reg.run_id,
          correlation_id: reg.correlation_id,
        });
        const key: BatchAskKey = {
          unit,
          ingredient_slug: reg.ingredient_slug,
          ...(reg.operation_id !== undefined
            ? { operation_id: reg.operation_id }
            : {}),
          ...(reg.connection_name !== undefined
            ? { connection_name: reg.connection_name }
            : {}),
          channel: reg.source.channel,
          actor: reg.source.actor,
          channel_session_id: reg.channel_session_id,
          risk_tier: reg.risk_tier,
          recipe_id: reg.recipe_id,
          recipe_hash: reg.recipe_hash,
          arg_shape_hash: reg.arg_shape_hash,
        };
        const member = {
          checkpoint_id: reg.checkpoint.checkpoint_id,
          run_id: reg.run_id,
          canonical_payload_hash: reg.canonical_payload_hash,
          summary: summarizeArgsPreview(reg.args_preview),
          ...(reg.args_preview !== undefined
            ? { args_preview: reg.args_preview }
            : {}),
        };

        const createFresh = async (): Promise<RegisterHoldResult> => {
          const created_at = now();
          const row = await deps.batchAskStore.create(
            {
              batch_id: newBatchId(),
              unit_kind: unit.kind,
              unit_id: unit.id,
              ingredient_slug: reg.ingredient_slug,
              ...(reg.operation_id !== undefined
                ? { operation_id: reg.operation_id }
                : {}),
              ...(reg.connection_name !== undefined
                ? { connection_name: reg.connection_name }
                : {}),
              channel: reg.source.channel,
              actor: reg.source.actor,
              channel_session_id: reg.channel_session_id,
              risk_tier: reg.risk_tier,
              recipe_id: reg.recipe_id,
              recipe_hash: reg.recipe_hash,
              arg_shape_hash: reg.arg_shape_hash,
              source: reg.source,
              current_ask_id: '',
              created_at,
            },
            member,
          );
          try {
            const ask_id = await raiseBatchAsk(
              row,
              reg.checkpoint,
              reg.ask_context,
              reg.session_grant_offer,
            );
            return { kind: 'registered', ask_id };
          } catch (e) {
            // codex MEDIUM fold — the v1 ask never raised: terminalize the
            // fresh row so it can never absorb future joins, then fall
            // back to the legacy per-hold ask for this hold.
            try {
              await deps.batchAskStore.terminalize(row.batch_id);
            } catch {
              /* best-effort — an open orphan only self-heals via joins */
            }
            console.warn(
              '[batch-approval] v1 batch ask raise failed; row terminalized, '
                + 'falling back to per-hold ask: '
                + (e instanceof Error ? e.message : String(e)),
            );
            return { kind: 'fallback' };
          }
        };

        const open = await deps.batchAskStore.findOpenByKey(key);
        if (open !== null) {
          // Cap: a runaway loop must not grow one ask without bound —
          // overflow holds fall back to per-hold asks.
          if (open.members.length >= BATCH_ASK_MAX_MEMBERS) {
            return { kind: 'fallback' };
          }
          const joined = await deps.batchAskStore.addMember(
            open.batch_id,
            member,
            now(),
          );
          if (joined.kind === 'not_open') {
            // The row closed between findOpen and addMember (an answer
            // raced in — possible across the await even under the global
            // mutex ONLY via direct store callers; defensively): a hold
            // arriving after the transition starts a NEW ask (N.10).
            return createFresh();
          }
          // codex MEDIUM fold — RAISE the re-rendered ask BEFORE
          // cancelling the superseded one, so a raise failure never
          // strands the older members ask-less. Both asks are briefly
          // live: an answer on the old one is version-rejected at the
          // hooks (the version already bumped), the new one is the live
          // re-ask — the version guard is the correctness half, the
          // cancel the UX half.
          let ask_id: string;
          try {
            ask_id = await raiseBatchAsk(
              joined.row,
              reg.checkpoint,
              reg.ask_context,
              undefined,
            );
          } catch (e) {
            // Re-render raise failed: ROLL BACK the join (pop the member,
            // restore the prior version) so the still-live previous ask
            // pins coherently again, and fall back to a per-hold ask for
            // this hold. A failed rollback leaves the row to the
            // self-healing paths (next join re-renders everything).
            try {
              await deps.batchAskStore.removeMember(
                joined.row.batch_id,
                joined.member_id,
              );
            } catch {
              /* best-effort */
            }
            console.warn(
              '[batch-approval] join re-render raise failed; member rolled '
                + 'back, falling back to per-hold ask: '
                + (e instanceof Error ? e.message : String(e)),
            );
            return { kind: 'fallback' };
          }
          const superseded = open.current_ask_id;
          try {
            await deps.cancelAsk(superseded);
          } catch {
            /* best-effort — the version guard is the correctness half */
          }
          return { kind: 'registered', ask_id };
        }
        return createFresh();
      } catch (e) {
        // Any store/raise failure degrades to the legacy per-hold ask —
        // strictly additive, never a lost review.
        console.warn(
          '[batch-approval] registerHold degraded to per-hold ask: '
            + (e instanceof Error ? e.message : String(e)),
        );
        return { kind: 'fallback' };
      }
    });

  /** Per-member answer work — resume (with optional claim marker /
   *  exact-mode session grant) or deny, then consume the checkpoint.
   *  Missing checkpoints are silent skips (the legacy posture: the
   *  paused run no longer exists / was already finished by a prior
   *  attempt). Throws propagate — the block leaves the ask `answered`
   *  and the boot sweep retries; the `closing` state + the resumer's
   *  anchor guard make the retry idempotent. */
  const settleMembers = async (
    row: BatchAskRecord,
    option: string,
    grantContractId: string | undefined,
    approvedAt: number,
  ): Promise<void> => {
    for (const m of row.members) {
      const checkpoint = await deps.checkpointStore.get(m.checkpoint_id);
      if (checkpoint === null) continue;
      const context: PreflightAskContext = {
        recipe_id: row.recipe_id,
        gated_step_id: checkpoint.gated_step_id,
        tool_slug: row.ingredient_slug,
        risk_tier: row.risk_tier,
        ...(option !== 'deny' && grantContractId !== undefined
          ? {
              batch_claim: {
                contract_id: grantContractId,
                member_id: m.member_id,
              },
            }
          : {}),
      };
      if (option === 'deny') {
        await deps.resumer.denyRun(checkpoint, context);
      } else {
        await deps.resumer.resumeRun(checkpoint, {
          ...context,
          approved_at: approvedAt,
        });
      }
      await deps.checkpointStore.delete(m.checkpoint_id);
    }
  };

  const hooks: PreflightBatchAnswerHooks = {
    handleAnswer: (
      payload: Record<string, unknown>,
      answer: Answer,
    ): Promise<'handled' | 'fallback'> =>
      serialize(async (): Promise<'handled' | 'fallback'> => {
        const batch = readBatchPayload(payload);
        if (batch === undefined) return 'fallback';
        // The closed option lists pre-validate at the block; everything
        // not an affirmative is the deny arm (legacy defense-in-depth).
        const option =
          answer.option === 'approve' || answer.option === 'allow_session'
            ? answer.option
            : 'deny';
        const closed = await deps.batchAskStore.close(
          batch.batch_id,
          batch.payload_version,
          option,
          now(),
        );
        if (closed.kind === 'not_found') {
          // Row gone (store wiped/pruned while the ask was outstanding).
          // A v1 payload carries complete legacy fields for its single
          // member — the legacy path resolves it fully. A multi-member
          // payload cannot be partially resumed (silent under-execution
          // of a reviewed approval); log and stop.
          if (batch.payload_version === 1) return 'fallback';
          console.warn(
            `[batch-approval] answer for missing batch row '${batch.batch_id}' `
              + `(v${batch.payload_version}) — nothing actionable; members must be re-run`,
          );
          return 'handled';
        }
        if (closed.kind === 'stale') {
          // N.10 — a stale answer (version moved) is rejected; the live
          // re-rendered ask IS the re-ask (the JOIN raised it).
          console.info(
            `[batch-approval] stale answer rejected for batch '${batch.batch_id}' `
              + `(answered v${batch.payload_version}) — the re-rendered ask stands`,
          );
          return 'handled';
        }
        const row = closed.row;
        if (option === 'deny') {
          await settleMembers(row, 'deny', undefined, answer.answered_at);
          await deps.batchAskStore.markAnswered(batch.batch_id);
          return 'handled';
        }
        if (row.members.length === 1) {
          // Degenerate single-member approve — EXACTLY the landed P3
          // path: plain marker resume; `allow_session` threads the
          // offered bounds (read back off the persisted payload) so the
          // commit Gateway mints the exact-mode grant. No batch grant,
          // no claim marker.
          const m = row.members[0];
          const checkpoint = await deps.checkpointStore.get(m.checkpoint_id);
          if (checkpoint !== null) {
            const grant =
              option === 'allow_session'
                ? readSessionGrantPayload(payload.session_grant)
                : undefined;
            await deps.resumer.resumeRun(checkpoint, {
              recipe_id: row.recipe_id,
              gated_step_id: checkpoint.gated_step_id,
              tool_slug: row.ingredient_slug,
              risk_tier: row.risk_tier,
              approved_at: answer.answered_at,
              ...(grant !== undefined ? { session_grant: grant } : {}),
            });
            await deps.checkpointStore.delete(m.checkpoint_id);
          }
          await deps.batchAskStore.markAnswered(batch.batch_id);
          return 'handled';
        }
        // N≥2 — mint the batch grant from the snapshot (the approval
        // materialized: max_uses = member count, claim-once per member),
        // then resume each member with its claim marker. A refused /
        // failed / unwired mint degrades to plain marker resumes — the
        // human-approved actions still execute; only the replay-
        // absorption accounting is dropped.
        const grantContractId = deps.sessionGrantResolver?.mintBatch({
          channel: row.channel,
          actor: row.actor,
          channel_session_id: row.channel_session_id,
          // D-177 N.14 — a door batch binds its grant to the governing door
          // contract; the batch key includes the source, so every member shares
          // it. Non-door batches supply nothing. N.14.6 — classified with the
          // SHARED predicate, so the delegated mcp door binds here too (its
          // actor is `contracted_user`, which the actor-keyed v1 missed).
          ...(isDoorDispatchSource(row.source)
            && executionSourceContractId(row.source) !== undefined
            ? { source_contract_id: executionSourceContractId(row.source) }
            : {}),
          ingredient_slug: row.ingredient_slug,
          ...(row.operation_id !== undefined
            ? { operation_id: row.operation_id }
            : {}),
          ...(row.connection_name !== undefined
            ? { connection_name: row.connection_name }
            : {}),
          recipe_id: row.recipe_id,
          recipe_hash: row.recipe_hash,
          arg_shape_hash: row.arg_shape_hash,
          risk_tier: row.risk_tier,
          approved_action_ref: row.batch_id,
          members: row.members.map((m) => ({
            member_id: m.member_id,
            canonical_payload_hash: m.canonical_payload_hash,
          })),
        });
        await settleMembers(row, option, grantContractId, answer.answered_at);
        await deps.batchAskStore.markAnswered(batch.batch_id);
        return 'handled';
      }),
  };

  return { registerHold, hooks };
};
