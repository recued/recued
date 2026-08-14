/** D-157 P1 slice 4 — the preflight-approval flow (gateway-side leaf).
 *
 *  D-153's `(channel × actor × contract_id)` policy matrix can yield an
 *  `'ask'` verdict for a boundary-crossing call. The recipe's engine run
 *  cannot wait for the answer in-process — a preflight `ask` can be
 *  outstanding for minutes or days, and a held promise leaks and dies on
 *  restart (I-4). Instead:
 *
 *    1. The engine catches `PreflightRequiredSignal` raised by the
 *       commit-gateway wrapper, snapshots `step.*`, returns
 *       `awaiting_approval`, and ENDS the execution.
 *    2. The host persists the snapshot as a `Checkpoint` (the run's
 *       resumable on-disk identity) and calls `notification.ask(...)`
 *       with kind `gateway.preflight`, payload `{ checkpoint_id }`.
 *    3. When the user answers — any channel, now or after a restart —
 *       the durable `on_answer` handler dispatches:
 *         - `approve` → re-instantiate a FRESH execution from the
 *                       checkpoint, continuing PAST the gate. Resume in
 *                       mechanism only; not a revived process.
 *         - `deny`    → abort the run with a policy error.
 *       Either way the checkpoint is consumed (`CheckpointStore.delete`).
 *
 *  Invariants this leaf upholds:
 *   - I-1  the gateway names no channel — it only calls `ask` /
 *          `registerAskHandler` on the injected `PreflightNotifier`. The
 *          interface has no channel surface to name.
 *   - I-4  no held call — `ask` resolves immediately with `{ ask_id }`;
 *          the engine has already ended. The pause lives entirely on
 *          disk (the `Checkpoint`).
 *   - I-5  the `on_answer` handler is durable, not an awaited promise.
 *          The block persists `(kind, payload)`; this module re-builds
 *          the function fresh at every boot via `registerPreflightHandler`.
 *   - I-6  re-instantiation is faithful — a fresh execution seeded from
 *          the checkpoint's `step_state` reproduces the run past the
 *          gate. The engine pause/resume slice (slice 3) guarantees this;
 *          this module hands the checkpoint to the host's `resumeRun`
 *          callback unchanged.
 *   - I-10 the recipe stays oblivious — the engine surfaces a gated call
 *          as `awaiting_approval` in the result; the recipe JSON / logic
 *          is unchanged. This module never inspects recipe content.
 *
 *  This module is the pure leaf — the `PreflightNotifier` (D-158
 *  notification block) and the `PreflightResumer` (the host's resume +
 *  deny callbacks) are both injected. The boot-sweep wiring + the real
 *  implementations live in `backend/server` as the D-157 server-side
 *  slice.
 *
 *  Spec: D-157 § N.3 / A.2 / I-1 / I-4 / I-5 / I-6 / I-10.
 */

import {
  RISK_TIERS,
  isOperationSpecHash,
  renderBatchItemsBlock,
} from '@recued/contracts';
import type {
  BatchedApprovalItem,
  Checkpoint,
  OriginUnit,
  OriginUnitKind,
  AuthorizationProvenance,
  OperationApproval,
  PreflightOverrideOffer,
  RiskTier,
} from '@recued/contracts';
import type {
  Answer,
  AskHandlerFn,
  AskHandlerKind,
  AskHandlerRef,
  AskOption,
  NotificationMessage,
} from '@recued/notification';
import type { CheckpointStore } from '@recued/storage';

// ────────────────────────────────────────────────────────────────
// Vocabulary — the constants that name the preflight-approval flow
// ────────────────────────────────────────────────────────────────

/** The `AskHandlerKind` the gateway registers with the notification
 *  block for preflight-approval answers (A.2 step 3). The block persists
 *  this slug — never a closure — and re-dispatches an answer to the
 *  function registered under it, so the handler survives the restart
 *  between an outstanding ask and its answer (I-5; D-158 N.3). */
export const PREFLIGHT_HANDLER_KIND: AskHandlerKind = 'gateway.preflight';

/** The two answers a preflight ask always offers (A.2):
 *   - `approve` — admit the gated call; the run re-instantiates from
 *                 the checkpoint and continues PAST the gate.
 *   - `deny`    — refuse the call; the run aborts with a policy error.
 *  Two-state by construction; no `Cancel` (a denied run is the
 *  user-facing "don't proceed" outcome — they re-run themselves if they
 *  want a retry, per the no-auto-resume invariant). D-177 P3 adds a
 *  CONDITIONAL third option (`ALLOW_SESSION_ASK_OPTION`) when the host
 *  resolved a session-grant offer for the hold — see `buildPreflightAsk`. */
export const PREFLIGHT_ASK_OPTIONS: readonly AskOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'deny', label: 'Deny' },
];

/** D-177 P3 (N.5) — the third answer: approve AND mint a session grant so
 *  the exact same call repeats without re-asking for the rest of the channel
 *  session (bounded by the offered TTL + use budget). Offered ONLY when the
 *  ask context carries a `session_grant` offer (fail closed — the option is
 *  simply absent otherwise); the D-158 block validates an inbound answer
 *  against the offered options, so an `allow_session` reply on a binary ask
 *  never reaches the handler. */
export const ALLOW_SESSION_ASK_OPTION: AskOption = {
  id: 'allow_session',
  label: 'Allow this session',
};

export const NEVER_ASK_OPERATION_OPTION_ID = 'approve_never_ask_op';
export const RELAX_OPERATION_TO_ASK_OPTION_ID = 'approve_relax_to_ask';

const overrideAskOption = (offer: PreflightOverrideOffer): AskOption =>
  offer.kind === 'never_ask'
    ? {
        id: NEVER_ASK_OPERATION_OPTION_ID,
        label: 'Never ask for this op again',
      }
    : {
        id: RELAX_OPERATION_TO_ASK_OPTION_ID,
        label: 'Relax to ask (grantable)',
      };

/** D-177 P3 — the option list for an ask whose context carries a
 *  session-grant offer: Approve / Allow this session / Deny ("deny last" —
 *  both affirmative answers sit together; the destructive refusal anchors
 *  the end). */
export const PREFLIGHT_ASK_OPTIONS_WITH_SESSION: readonly AskOption[] = [
  PREFLIGHT_ASK_OPTIONS[0],
  ALLOW_SESSION_ASK_OPTION,
  PREFLIGHT_ASK_OPTIONS[1],
];

// ────────────────────────────────────────────────────────────────
// Injected seams — the leaf depends on interfaces, not the server
// ────────────────────────────────────────────────────────────────

/** Why a preflight gate fired — bound to the answer-time handler so the
 *  resume / deny paths surface the same reason the original ask did
 *  ("approved write `mail.send`" / "denied write `mail.send`"). All
 *  fields are JSON-serialisable; the notification block persists this
 *  alongside the `(kind, ask_id)` so a boot-time re-dispatch carries it
 *  back to the handler verbatim. */
export interface PreflightAskContext {
  /** The recipe whose run paused. OPTIONAL since D-182 §8 — a recipe-LESS
   *  raw-op door hold (`raw_op` set) has no recipe; the resumer reads the
   *  held op identity off `Checkpoint.raw_op`, never off this context. */
  recipe_id?: string;
  /** The step the gate fired at — the `Checkpoint.gated_step_id`. OPTIONAL
   *  since D-182 §8 (a raw op is a single dispatch, not a step in a loop). */
  gated_step_id?: string;
  /** D-182 §8 — the recipe-LESS raw-op door hold marker: the Tier-P op id the
   *  agent is held on. Present ⇒ the ask renders the raw-op sentence (no
   *  recipe/step phrasing) and the answer handler reconstructs a recipe-less
   *  context. The full held call lives on `Checkpoint.raw_op`; this carries
   *  only the id the ask body + payload need. */
  raw_op?: { op_id: string };
  /** The ingredient slug the gated dispatch targeted (when known —
   *  absent only on legacy paths whose gate origin can't be classified). */
  tool_slug?: string;
  /** The named connection the gated call would go out on — WHICH account
   *  the action lands in (`gmail-personal` vs `gmail-work`,
   *  `hubspot-sandbox` vs `hubspot-prod`). Part of the batch aggregation
   *  key and of `BatchedApprovalPayload` from the start, but it never
   *  reached the rendered ask: the owner was asked to approve a write
   *  without being told whose account it hits — the blast radius, left
   *  off the one surface that decides it.
   *
   *  BACKED ON CATALOG HOLDS ONLY. The value flows from
   *  `awaitingApproval.connection_name`, which only the catalog gate sets
   *  (`catalog-gateway.ts`). The commit Gateway's simple-form raise
   *  (`raiseOnAsk`) has the value in scope — it resolves
   *  `resolvedConnectionName` off the hash basis and binds a minted grant
   *  to it — but does not put it on the signal, so a simple-form hold
   *  still renders no connection. Closing that is NOT a rendering change:
   *  the same `awaiting_approval.connection_name` feeds
   *  `Checkpoint.approved_target` (`execute-handler.ts`), whose D-165
   *  op-identity binding deliberately carries only `ingredient_slug` on
   *  the simple-form path, so populating it would tighten the RESUME
   *  ADMISSION check as a side effect. Left for that decision rather than
   *  smuggled in behind a copy edit. Absent on a dispatch with no named
   *  connection. */
  connection_name?: string;
  /** The tool's `RiskTier` — surfaced to the user so the ask's body
   *  carries the structured reason (`"… (write tier — needs approval)"`).
   *  Absent on the same legacy paths as `tool_slug`. */
  risk_tier?: string;
  /** Free-form reason from the policy decision's `detail`. Surfaces in
   *  the ask body. Absent → the body falls back to the structured
   *  fields above. */
  reason?: string;
  /** D-217 § 6.1 — the AMPLIFICATION BOUND of a multi-request act: how many
   *  requests this ONE approval authorizes, and how many bytes leave.
   *
   *  ⛔ Every other gated call is one approval buying one request. A chunked
   *  upload is one approval buying up to 103 — so an ask that says "an upload"
   *  is asking the owner to consent to something it did not describe. Fixed
   *  before the first dispatch (§ 8a), so it is knowable here and is not an
   *  estimate. Absent on every single-request hold. */
  egress_bound?: { readonly requests: number; readonly total_bytes: number };
  /** D-211 — optional standing owner-ruling action for this held op. */
  owner_override_offer?: PreflightOverrideOffer;
  /** D-211 — stored approval was below the effective risk floor. */
  approval_clamped_from?: OperationApproval;
  /** D-209 §1.7 — durable grant-eligibility provenance; not rendered. */
  authorization_provenance?: AuthorizationProvenance;
  /** Unix-ms when the notification block durably recorded the affirmative
   * answer. Populated only on answer-time resume (never trusted from the
   * raise-time payload) so host pre-resume effects can retain the actual owner
   * decision time across crash/recovery retries. It is provenance, not an
   * authority input. */
  approved_at?: number;
  /** D-177 P3 (N.5) — the session-grant offer for this hold, resolved by the
   *  HOST at raise time (`resolveSessionGrantOffer` over the owner cell's
   *  defaults + the host-owned run-shape conditions: a resumable checkpoint
   *  path, a commit-gateway hold, a wired resolver). Present ⇒
   *  `buildPreflightAsk` offers the `allow_session` third option and the
   *  handler payload carries these bounds; absent ⇒ the binary ask,
   *  byte-identical to pre-P3 (fail closed — the option is simply absent).
   *
   *  Dual moment, one field: at ask-build time this is the OFFER (the bounds
   *  snapshot the answer will mint); on the answer-time resume context the
   *  handler populates it ONLY when the recorded answer was `allow_session`
   *  (a plain `approve` on an offering ask must not mint), and the resumer
   *  threads it to the engine as the gated step's mint instruction.
   *
   *  `risk_tier` (codex HIGH fold) is the tier the ask SHOWED the human; the
   *  commit Gateway's mint precondition compares it to the resume decision's
   *  tier and skips the mint on drift — the grant pins what was approved,
   *  never what a policy/manifest mutation re-classified mid-ask.
   *
   *  D-177 P5b (N.11) — `grant_mode: 'open'` marks an offer the raise site
   *  upgraded because the hold's open-projection walk succeeded (the signal
   *  carried a preview): the ask renders the rule-7 sentence + pinned/varies
   *  lines, and the answer's resume instructs the Gateway to mint the
   *  provenance-pinned grant. Absent/`'exact'` keeps the P3 exact-hash flow
   *  byte-identical. */
  session_grant?: {
    ttl_ms: number;
    max_uses: number;
    risk_tier: string;
    grant_mode?: string;
  };
  /** D-177 P5b (N.11) — the held call's pinned/varies summary, threaded from
   *  the signal at RAISE time for the ask-body rendering (what stays pinned,
   *  what may vary — rule 7's clauses made visible). Raise-time only, like
   *  `batch`; never round-tripped onto an answer-time resume context, never
   *  persisted on the handler payload (the mint recomputes the projection
   *  from the resume dispatch itself — D9). */
  open_projection_preview?: {
    pinned: ReadonlyArray<{ label: string; value: string }>;
    varying: ReadonlyArray<{ label: string; origin: string }>;
  };
  /** D-177 P5a (N.10) — present when the host registered this hold in a
   *  batch-ask row: `buildPreflightAsk` renders the enumerated items block
   *  and stamps `batch_id` + `payload_version` onto the handler payload,
   *  so the answer routes through the batch flow (the version pin is the
   *  stale-approve guard — answering a superseded version is rejected and
   *  the live re-rendered ask stands). Raise-time only; never populated
   *  on an answer-time resume context. */
  batch?: {
    batch_id: string;
    payload_version: number;
    items: ReadonlyArray<BatchedApprovalItem>;
    unit: OriginUnit;
  };
  /** D-177 P5a (N.10) — answer-time resume context ONLY: the member-claim
   *  instruction for ONE held run of a batched approve. The batch answer
   *  flow (the sole writer) populates it per member; the resumer threads
   *  it to the engine, which marks the resumed gated step
   *  (`StepMeta.preflight_batch_claim`) so the commit Gateway atomically
   *  claims the member at the proceed point (the claim IS the consumption
   *  — N.4). Never read at raise time. */
  batch_claim?: { contract_id: string; member_id: string };
}

/** The narrow notification-block seam this leaf calls — the subset of
 *  the D-158 `NotificationBlock` the preflight flow uses. A
 *  `NotificationBlock` satisfies it structurally. Channel-agnostic by
 *  construction (I-1): the interface offers only `ask` + an `on_answer`
 *  registration; channel fan-out is entirely the block's concern. */
export interface PreflightNotifier {
  ask(
    message: NotificationMessage,
    options: readonly AskOption[],
    handler: AskHandlerRef,
  ): Promise<{ ask_id: string }>;
  registerAskHandler(kind: AskHandlerKind, handler: AskHandlerFn): void;
  /** D-210 Phase C — the passive fan-out `raisePreflightNotify` uses when
   *  the owner's `inbox_fanout_mode` is `'notify'`. Fire-and-forget:
   *  collects no reply and never throws on a delivery failure, matching
   *  `NotificationBlock.notify`, which satisfies this structurally. */
  notify(message: NotificationMessage): Promise<void>;
}

/** D-177 P5a (N.10) — the batch answer flow's leaf-facing seam. The host
 *  (`backend/server/src/batch-approval.ts`) implements it over the
 *  batch-ask store + the resumer + the session-grant mint; the leaf only
 *  routes a `batch_id`-carrying payload through it. At-least-once safe:
 *  the block re-dispatches a recorded answer after a crash, and the flow
 *  re-enters idempotently (the `closing` state + the recorded answer
 *  prove it is the same answer finishing its work). */
export interface PreflightBatchAnswerHooks {
  handleAnswer(
    payload: Record<string, unknown>,
    answer: Answer,
  ): Promise<'handled' | 'fallback'>;
}

/** The host's resume + deny callbacks — the side of the flow this leaf
 *  cannot own. Both receive the consumed `Checkpoint` plus the original
 *  `PreflightAskContext` so the host can re-instantiate the run (resume)
 *  or write a fresh policy-deny audit row (deny). Both run on the boot
 *  thread after the user answers (potentially after a restart); a
 *  thrown error leaves the ask `'answered'`-but-unhandled and the boot
 *  sweep retries dispatch on the next restart (D-158 A.5). */
export interface PreflightResumer {
  /** Re-instantiate a fresh execution from `checkpoint`, continuing
   *  past the gate. The host loads the recipe by `checkpoint.recipe_id`,
   *  seeds `ctx.stores.step` from `checkpoint.step_state`, and calls
   *  `executeRecipe` with `ctx.resumeFrom = { gated_step_id }`. The
   *  resumed run writes its own fresh audit row (its `run_id` is the
   *  paused anchor's `run_id` — the same execution-request anchor; a
   *  fresh-yet-faithful continuation, not a new request). */
  resumeRun(checkpoint: Checkpoint, context: PreflightAskContext): Promise<void>;
  /** Record the denial outcome — a fresh audit row pinned to the
   *  paused run's `run_id` carrying a `RECIPE_POLICY_DENIED`-shaped
   *  error so the surface mirrors the static gate's deny UX. The
   *  paused anchor's `commit_status` transitions from
   *  `'awaiting_approval'` to `'failed'`; the run is terminal. */
  denyRun(checkpoint: Checkpoint, context: PreflightAskContext): Promise<void>;
}

// ────────────────────────────────────────────────────────────────
// The flow
// ────────────────────────────────────────────────────────────────

/** The three components of a preflight `notification.ask`, ready to
 *  pass straight to `PreflightNotifier.ask(...)`. */
export interface PreflightAsk {
  message: NotificationMessage;
  options: readonly AskOption[];
  handler: AskHandlerRef;
}

// ────────────────────────────────────────────────────────────────
// Ask-body vocabulary — the gate's words, in the owner's language
// ────────────────────────────────────────────────────────────────
//
//  The ask body is not a log line: it is the whole of what the owner has
//  to go on when they decide. Every identifier that appears here has to
//  earn its place by changing an answer, and every internal name has to
//  be spelled out — `risk_tier='write'` names the field the engine reads,
//  not the thing the owner is being asked about. An approval surface the
//  owner skims is an approval surface that approves everything, which is
//  the one failure the gate cannot survive.

/** What each tier MEANS, in consequences. Sourced from the tier's own
 *  definition, not invented per-surface: `Record<RiskTier, …>` is
 *  exhaustive, so a fifth tier fails to compile here rather than
 *  silently rendering as nothing. */
const TIER_CLAUSE: Record<RiskTier, string> = {
  read: 'Your policy gates read actions here',
  write: 'Write actions change data outside Recued',
  admin: 'Admin actions change account settings or access',
  destructive:
    'Destructive actions permanently remove data and cannot be undone',
};

/** `PreflightAskContext.risk_tier` is a widened `string` (it round-trips
 *  through JSON persistence), so it can NOT index `TIER_CLAUSE` directly —
 *  an unknown tier would resolve to `undefined` and render the word
 *  "undefined" into the sentence the owner is deciding on. Membership is
 *  checked against the tier list itself before the lookup; an unrecognized
 *  tier degrades to no clause at all, never to a broken one. */
const tierClause = (tier: string | undefined): string | undefined =>
  tier !== undefined && (RISK_TIERS as readonly string[]).includes(tier)
    ? TIER_CLAUSE[tier as RiskTier]
    : undefined;

/** The origin unit, in words. `turn` / `burst` / `fire` / `run` are the
 *  aggregation-key vocabulary (`deriveOriginUnit`) — precise internally,
 *  meaningless to a reader, and "3 pending actions in this burst" is not
 *  a sentence anyone can act on. Exhaustive over the closed list. */
const UNIT_PHRASE: Record<OriginUnitKind, string> = {
  turn: 'this chat turn',
  burst: 'this agent request',
  fire: 'this automatic run',
  run: 'this run',
};

/** Render a millisecond TTL for the ask body — whole hours when round,
 *  else whole minutes (sub-minute TTLs round up to 1 min; the rendering is
 *  advisory, the enforced bound is `expiry_at`). */
const renderTtl = (ttl_ms: number): string => {
  if (ttl_ms >= 3_600_000 && ttl_ms % 3_600_000 === 0) {
    const h = ttl_ms / 3_600_000;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  const m = Math.max(1, Math.round(ttl_ms / 60_000));
  return `${m} minute${m === 1 ? '' : 's'}`;
};

/** Empty inputs remain part of the enforced open projection, but do
 *  not help a person decide whether to approve it. Preview values arrive as
 *  rendered JSON when possible (`null`, `""`, `false`, `0`, ...), with a
 *  best-effort string fallback for truncated or non-JSON values. Hide only
 *  absence; meaningful falsy values and containers stay visible. */
const hasDisplayablePinnedValue = (value: string): boolean => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null
      && !(typeof parsed === 'string' && parsed.trim().length === 0);
  } catch {
    return true;
  }
};

/** D-177 P5b (N.11 rule 7) — the open-grant confirm block: the one plain
 *  sentence the grant must be renderable as, plus the pinned/varies lines
 *  off the raise-time preview. "If a grant cannot be rendered as one plain
 *  sentence, it must not be mintable" — the raise site only upgrades an
 *  offer to `'open'` when the walk produced this preview. */
const renderOpenGrantBlock = (
  offer: { ttl_ms: number; max_uses: number },
  preview: PreflightAskContext['open_projection_preview'],
  toolPhrase: string,
): string => {
  const pinned = (preview?.pinned ?? []).filter((p) => hasDisplayablePinnedValue(p.value));
  const varying = preview?.varying ?? [];
  const hasDetailLines = pinned.length > 0 || varying.length > 0;
  const lines: string[] = [
    `'Allow this session' auto-approves ${toolPhrase} up to `
      + `${offer.max_uses} time${offer.max_uses === 1 ? '' : 's'} for `
      + `${renderTtl(offer.ttl_ms)}, only while its fixed inputs `
      + `stay exactly as approved (anything else re-asks)${hasDetailLines ? ':' : '.'}`,
  ];
  for (const p of pinned) {
    lines.push(`  pinned  ${p.label} = ${p.value}`);
  }
  for (const v of varying) {
    lines.push(`  varies  ${v.label} (${v.origin})`);
  }
  return lines.join('\n');
};

/** Render a byte count as a size a reader can act on.
 *
 *  ⚠ `104857600` is a number the reader has to do arithmetic on before it means
 *  anything, and an approval surface that makes the owner compute the blast
 *  radius has not stated it. Binary units (the ceiling is 512 MiB, and calling
 *  that "537 MB" to match marketing decimals would misreport the actual bound).
 *  Rounded to one decimal below GB — the decision is "is that a lot of my data
 *  leaving", not an invoice. */
/** "WHICH account does this land in" is the first question a reader asks of
 *  any write, and it is the difference between a sandbox and production —
 *  so the connection is named, EXCEPT when naming it a second time is all
 *  the phrase would do. `recued-core/reception-intake.intake.materialize on
 *  reception-intake` spends a clause restating a segment the reader has
 *  already read, and a sentence that repeats itself is a sentence people
 *  learn to skim. Compared against the op id's own segments, so the account
 *  drops out only when it is LITERALLY already on screen: a `hubspot-prod`
 *  connection under a `…/hubspot.deal.update` op is a different string and
 *  survives, which is exactly the sandbox-vs-production case. */
const connectionPhrase = (
  connection: string | undefined,
  named: string | undefined,
): string =>
  connection === undefined
    || (named ?? '').split(/[/.]/).includes(connection)
    ? ''
    : ` on ${connection}`;

/** The title is also the Slack / Telegram / OS notification preview — the
 *  one line a reader is guaranteed to see — so it carries what tells one
 *  queued ask from another. A publisher handle tells them nothing: it is
 *  the same `recued-core/` on every first-party op, and it costs the front
 *  of the line, which is the part that survives truncation on a phone. The
 *  full id stays in the body sentence, which is where identity belongs. */
const titleOperation = (named: string): string =>
  named.slice(named.indexOf('/') + 1);

/** Recipe ids a person wrote are short (`send-email`, `sync-deals`) and are
 *  left exactly as they are. Ones the pack machinery generates are not:
 *  `reception-intake-review-then-approve-intake-materialize-1` is 56
 *  characters that mostly restate the operation named later in the same
 *  sentence, and it lands in front of every word that decides anything.
 *
 *  ⚠ Clipped MIDDLE-OUT, never from the end. These ids are NUMBERED
 *  (`…-1`, `…-2`) — a tail cut would render two different recipes
 *  identically, which is worse than the length it fixed. Both ends survive,
 *  so the id still names one recipe. */
const RECIPE_ID_CLIP = 44;
const RECIPE_ID_HEAD = 24;
const RECIPE_ID_TAIL = 16;

const clipRecipeId = (recipe_id: string | undefined): string => {
  // `String(...)` rather than a `?? ''` default: an absent recipe id on a
  // recipe-BOUND hold renders "undefined" here, exactly as the template
  // literal this replaced did. Papering it over as an empty string would
  // turn a visible contract violation into a sentence missing a subject.
  const id = String(recipe_id);
  return id.length <= RECIPE_ID_CLIP
    ? id
    : `${id.slice(0, RECIPE_ID_HEAD)}…${id.slice(-RECIPE_ID_TAIL)}`;
};

const formatEgressBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return `${String(bytes)} bytes`;
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Whole numbers stay whole (`5 MB`, not `5.0 MB`); everything else gets one
  // decimal, which is the resolution the decision actually turns on.
  const rendered = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${rendered} ${units[unit]}`;
};

/** Build the preflight `notification.ask` for one gated run (A.2).
 *
 *  The handler `payload` carries the `checkpoint_id` (the resumable
 *  on-disk identity, per D-158 N.3) plus the `PreflightAskContext`
 *  fields so the durable `on_answer` handler reconstructs the resume /
 *  deny call without re-reading the audit row. JSON-serialisable: the
 *  block persists the payload verbatim, never a closure (D-158 I-4).
 *
 *  D-177 P3 — a context carrying a `session_grant` offer renders the
 *  three-option list (`PREFLIGHT_ASK_OPTIONS_WITH_SESSION`) and persists the
 *  offered bounds on the payload, so the answer mints exactly what the ask
 *  offered even if the cell defaults are tuned while the ask is outstanding.
 *  Absent offer ⇒ the binary ask, byte-identical to pre-P3. */
export const buildPreflightAsk = (args: {
  checkpoint: Checkpoint;
  context: PreflightAskContext;
}): PreflightAsk => {
  const { checkpoint, context } = args;
  // D-177 P5a (N.10) — the items rendering: a batch-registered hold
  // enumerates its resolved members in the ask body (the reviewable
  // payload). A single-member batch is the degenerate case — same shape,
  // one item.
  const batch = context.batch;
  const count = batch?.items.length ?? 1;
  // What is being run. `raw_op` names the op directly; on a catalog hold
  // `tool_slug` already IS the operation id. Neither ⇒ a legacy path
  // whose gate origin can't be classified: say that, rather than name
  // something we don't know.
  const named = context.raw_op?.op_id ?? context.tool_slug;
  const action = named ?? 'a boundary-crossing call';
  // WHICH account this lands in — unless the op id already said so.
  const onConnection = connectionPhrase(context.connection_name, named);

  // Sentence 1 — what wants to happen, where, and who asked.
  // D-182 §8 — a recipe-LESS raw-op door hold has neither recipe nor step
  // to name. A raw op is never batch-registered (v1), so it is always
  // the single-call sentence.
  const opening =
    context.raw_op !== undefined
      ? `An AI agent wants to run ${action}${onConnection}.`
      : count > 1 && batch !== undefined
        ? `Recipe ${clipRecipeId(context.recipe_id)} wants to run ${count} `
          + `${action} actions${onConnection}, all from `
          + `${UNIT_PHRASE[batch.unit.kind]}.`
        : `Recipe ${clipRecipeId(context.recipe_id)} wants to run `
          + `${action}${onConnection} (step ${context.gated_step_id}).`;

  // Sentence 2 — why it stopped here. The tier IS the reason; naming the
  // consequence answers "should I care?" in a way `risk_tier='write'`
  // never did.
  const clause = tierClause(context.risk_tier);
  const held =
    clause !== undefined
      ? `${clause}, so Recued held ${count === 1 ? 'it' : 'them'} for you.`
      : `Recued held ${count === 1 ? 'it' : 'them'} for your approval.`;

  // The policy decision's own words, when it had any. Kept on its own
  // labeled line rather than jammed into the sentence as a dash clause —
  // it is a distinct claim from a distinct authority, and a reader should
  // be able to tell which parts of this message Recued wrote.
  const reasonLine =
    context.reason !== undefined && context.reason.length > 0
      ? `\n\nReason: ${context.reason}`
      : '';

  // D-217 § 6.1 — the amplification bound, on its own line.
  //
  // ⛔ **One approval buying N requests is the thing a reviewer must see before
  // approving, and it is the ONE fact this ask would otherwise omit.** Every
  // other gated call here is one approval, one request; "wants to run
  // x-media.upload on x-media" reads identically whether that means one request
  // or a hundred and three, and the owner's yes means something different in
  // each case. So the bound is stated in the body, not left to be dug out of the
  // args preview.
  //
  // ⚠ Bytes are rendered as a size, not a raw integer — `104857600` is a number
  // a reader has to do arithmetic on before it means anything, and an approval
  // surface that makes the reader compute the blast radius has not stated it.
  const egressBoundLine =
    context.egress_bound !== undefined
      ? `\n\nThis one approval covers up to ${context.egress_bound.requests} `
        + `request${context.egress_bound.requests === 1 ? '' : 's'}, sending `
        + `${formatEgressBytes(context.egress_bound.total_bytes)} off this machine.`
      : '';

  const clampWarning = context.approval_clamped_from !== undefined
    ? `\n\nWarning: stored approval '${context.approval_clamped_from}' is below `
      + `the ${context.risk_tier ?? 'operation'} risk floor and was clamped. `
      + "Review or reset it on the Contract's operation row."
    : '';

  const itemsBlock =
    batch !== undefined ? `\n\n${renderBatchItemsBlock(batch.items)}` : '';

  // D-177 P5b (N.11 rule 7) — an OPEN offer renders its confirm sentence:
  // every clause maps 1:1 onto an enforced bound (use budget → `max_uses`,
  // lifetime → `expiry_at`, the tool phrase → recipe+ingredient binding, the
  // populated pinned lines → the projection's pinned roots, the varies lines
  // → its clean roots). Null/blank pinned values remain enforced by the
  // projection and hash; only their redundant human-preview lines are omitted.
  const openBlock =
    context.session_grant !== undefined
    && context.session_grant.grant_mode === 'open'
      ? `\n\n${renderOpenGrantBlock(
          context.session_grant,
          context.open_projection_preview,
          action,
        )}`
      : '';

  // The question goes LAST, always — it is what the buttons answer, and a
  // reader who has to scroll back up past the evidence to find what they
  // are saying yes to is a reader who stops reading the evidence. (The
  // open-grant block used to land AFTER "Approve?" for exactly this
  // reason: the question was baked into the sentence instead of being
  // composed last.)
  const question = count > 1 ? `Approve all ${count}?` : 'Approve?';

  // Every ask used to be titled "Approval required" — identical across
  // every pending decision, and the title is also the notification
  // preview on Slack / Telegram / the OS and the one line a reader is
  // guaranteed to see. Five queued asks were five identical previews. So
  // it carries what distinguishes one from another: what, and how much.
  // Only when the dispatch is actually identifiable, though — an unknown
  // tool has nothing to say beyond the old constant, and inventing a
  // specific-sounding title for it would be worse than admitting it.
  const tierSuffix =
    context.risk_tier !== undefined ? ` (${context.risk_tier})` : '';
  const title =
    named !== undefined
      ? `Approve ${count > 1 ? `${count} × ` : ''}${titleOperation(named)}${tierSuffix}`
      : 'Approval required';

  const message: NotificationMessage = {
    title,
    text:
      `${opening}\n${held}${egressBoundLine}${reasonLine}${clampWarning}`
      + `${itemsBlock}${openBlock}\n\n${question}`,
  };
  const handler: AskHandlerRef = {
    kind: PREFLIGHT_HANDLER_KIND,
    payload: {
      checkpoint_id: checkpoint.checkpoint_id,
      run_id: checkpoint.run_id,
      // D-182 §8 — recipe-bound holds carry the recipe identity; a recipe-less
      // raw-op hold carries `raw_op_id` instead (the answer handler branches on
      // it). Mutually exclusive — the checkpoint guard enforces the partition.
      ...(context.recipe_id !== undefined ? { recipe_id: context.recipe_id } : {}),
      ...(context.gated_step_id !== undefined
        ? { gated_step_id: context.gated_step_id }
        : {}),
      ...(context.raw_op !== undefined ? { raw_op_id: context.raw_op.op_id } : {}),
      ...(context.tool_slug !== undefined ? { tool_slug: context.tool_slug } : {}),
      ...(context.risk_tier !== undefined ? { risk_tier: context.risk_tier } : {}),
      ...(context.reason !== undefined ? { reason: context.reason } : {}),
      ...(context.owner_override_offer !== undefined
        ? { owner_override_offer: context.owner_override_offer }
        : {}),
      ...(context.authorization_provenance !== undefined
        ? { authorization_provenance: context.authorization_provenance }
        : {}),
      ...(context.session_grant !== undefined
        ? { session_grant: context.session_grant }
        : {}),
      // D-177 P5a — the batch identity + the version pin (the stale-approve
      // guard): the answer flow transitions the row `open → closing`
      // guarded by exactly this version; a superseded ask's answer fails
      // the guard and is rejected (the live re-rendered ask is the re-ask).
      ...(batch !== undefined
        ? { batch_id: batch.batch_id, payload_version: batch.payload_version }
        : {}),
    },
  };
  const options: readonly AskOption[] =
    context.owner_override_offer === undefined
      ? context.session_grant !== undefined
        ? PREFLIGHT_ASK_OPTIONS_WITH_SESSION
        : PREFLIGHT_ASK_OPTIONS
      : [
          PREFLIGHT_ASK_OPTIONS[0],
          ...(context.session_grant !== undefined ? [ALLOW_SESSION_ASK_OPTION] : []),
          overrideAskOption(context.owner_override_offer),
          PREFLIGHT_ASK_OPTIONS[1],
        ];
  return {
    message,
    options,
    handler,
  };
};

/** D-177 P3 — narrow the persisted `session_grant` payload back to the
 *  offer shape. The payload was authored by `buildPreflightAsk` from the
 *  host-resolved offer, but it round-trips through JSON persistence — so
 *  re-validate structurally: both bounds must be finite positives (and
 *  `max_uses` an integer ≥ 1, mirroring the mint primitive's own guard), and
 *  the offered `risk_tier` a non-empty string (the mint precondition
 *  compares it to the resume decision's tier). Anything else returns
 *  `undefined` → the answer degrades to a plain approve (the grant is a
 *  convenience; the approval is the contract). Exported for the P5a batch
 *  answer flow — its degenerate single-member `allow_session` arm runs
 *  exactly this validation (one reader, two consumers). */
export const readSessionGrantPayload = (
  value: unknown,
): {
  ttl_ms: number;
  max_uses: number;
  risk_tier: string;
  grant_mode?: string;
} | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.ttl_ms !== 'number' || !Number.isFinite(v.ttl_ms) || v.ttl_ms <= 0) {
    return undefined;
  }
  if (typeof v.max_uses !== 'number' || !Number.isInteger(v.max_uses) || v.max_uses < 1) {
    return undefined;
  }
  if (typeof v.risk_tier !== 'string' || v.risk_tier.length === 0) {
    return undefined;
  }
  // D-177 P5b — the mode survives the round-trip ONLY as the literal
  // 'open'; anything else (absent, 'exact', tampered/unknown vocabulary)
  // drops to the exact-hash mint — degrading STRICTER, never looser (an
  // exact grant pins the full payload; the human's approval covers it
  // either way).
  return {
    ttl_ms: v.ttl_ms,
    max_uses: v.max_uses,
    risk_tier: v.risk_tier,
    ...(v.grant_mode === 'open' ? { grant_mode: 'open' } : {}),
  };
};

/** Narrow persisted D-209 provenance. Corruption drops this copied context;
 *  grant enforcement still reads the authoritative checkpoint and the current
 *  admission, so it remains fail-closed. */
const readAuthorizationProvenance = (
  value: unknown,
): AuthorizationProvenance | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (
    v.pre_lift_approval !== 'never'
    && v.pre_lift_approval !== 'ask'
    && v.pre_lift_approval !== 'always'
  ) return undefined;
  if (
    v.lift_reason !== undefined
    && v.lift_reason !== 'review_send'
    && v.lift_reason !== 'review_commitment'
    && v.lift_reason !== 'quality'
  ) return undefined;
  return {
    pre_lift_approval: v.pre_lift_approval,
    ...(v.lift_reason !== undefined ? { lift_reason: v.lift_reason } : {}),
  };
};

/** Re-validate the persisted D-211 affordance before it reaches a standing
 * policy write. Kind and approval are paired so payload tampering cannot turn
 * one displayed action into another. */
export const readPreflightOverrideOffer = (
  value: unknown,
): PreflightOverrideOffer | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.ingredient_id !== 'string' || v.ingredient_id.length === 0) {
    return undefined;
  }
  if (typeof v.operation_id !== 'string' || v.operation_id.length === 0) {
    return undefined;
  }
  if (!isOperationSpecHash(v.op_hash)) return undefined;
  const base = {
    ingredient_id: v.ingredient_id,
    operation_id: v.operation_id,
    op_hash: v.op_hash,
  };
  if (v.kind === 'never_ask' && v.approval === 'never') {
    return { ...base, kind: 'never_ask', approval: 'never' };
  }
  if (v.kind === 'relax_to_ask' && v.approval === 'ask') {
    return { ...base, kind: 'relax_to_ask', approval: 'ask' };
  }
  return undefined;
};

/** Build the durable `on_answer` handler for preflight-approval
 *  answers (A.2 step 4-5). When the user answers — any channel, now or
 *  after a restart — the handler resolves the checkpoint, dispatches
 *  resume / deny to the host's callbacks, and consumes the checkpoint.
 *
 *  Idempotent on at-least-once dispatch: the block re-dispatches a
 *  persisted answer when a crash interrupted the handler between
 *  recording the answer and finishing the resume/deny work; the
 *  consume-on-answer discipline (`CheckpointStore.delete`) is idempotent,
 *  and a re-instantiated run's seed lookup will find the checkpoint
 *  already gone — the host's `resumeRun` MUST be safe to call once and
 *  silently no-op on the retry (the audit row says whether the run
 *  already finished).
 *
 *  A malformed payload throws — the notification block treats the throw
 *  as a handler failure and leaves the ask in `'answered'` state for
 *  the next boot sweep. A missing-checkpoint (the user answered after
 *  the run was reaped by a staleness guard, or a manual delete) is
 *  treated as a silent skip — there is nothing to resume or deny, the
 *  paused run no longer exists in the system. */
export const createPreflightAnswerHandler = (deps: {
  checkpointStore: CheckpointStore;
  resumer: PreflightResumer;
  /** D-177 P5a (N.10) — the batch answer flow (host-implemented; the leaf
   *  cannot reach the batch-ask store). When the payload carries a
   *  `batch_id`, the handler delegates FIRST: `'handled'` means the batch
   *  flow ran the whole answer (version-guarded close, mint, per-member
   *  resume/deny, checkpoint consumption — or rejected a stale answer);
   *  `'fallback'` means the batch row could not own the answer (row
   *  missing with legacy fields present — e.g. a store wiped mid-flight)
   *  and the legacy single-checkpoint path below proceeds. Absent dep ⇒
   *  batch payloads fall through to the legacy path (which resolves the
   *  single-member v1 ask correctly and throws-to-retry on a
   *  multi-member payload — fail closed, never a partial resume). */
  batchApprovals?: PreflightBatchAnswerHooks;
  upsertOverride?: (offer: PreflightOverrideOffer) => Promise<void>;
}): AskHandlerFn => {
  return async (payload: Record<string, unknown>, answer: Answer) => {
    // D-177 P5a — batch-registered asks route through the batch flow.
    if (typeof payload.batch_id === 'string' && payload.batch_id.length > 0) {
      // codex MEDIUM fold — a batch payload with NO batch hooks wired
      // must FAIL CLOSED, not leak into the legacy single-checkpoint
      // path: a multi-member payload's legacy fields anchor only its
      // newest member, so the legacy path would silently resume one of
      // N reviewed actions. Throwing leaves the ask `answered` for the
      // boot sweep to retry once the hooks are wired (production wires
      // them unconditionally with the notification block). The legacy
      // path is reachable for a batch payload ONLY via the hooks'
      // explicit `'fallback'` disposition (the v1 row-missing case,
      // where the legacy fields ARE the single member).
      if (deps.batchApprovals === undefined) {
        throw new Error(
          'gateway.preflight on_answer: payload carries batch_id '
            + `'${payload.batch_id}' but no batch answer hooks are wired — `
            + 'fail closed; retried at next boot',
        );
      }
      // The batch coordinator owns standing-override persistence too. It
      // applies the row's version guard BEFORE writing, so answering a
      // superseded ask can never mutate the owner's policy as a side effect.
      const disposition = await deps.batchApprovals.handleAnswer(payload, answer);
      if (disposition === 'handled') return;
      // 'fallback' — continue into the legacy single-checkpoint path.
    }
    let effectiveAnswer = answer;
    let overrideOffer: PreflightOverrideOffer | undefined;
    const overrideOptionSelected =
      answer.option === NEVER_ASK_OPERATION_OPTION_ID
      || answer.option === RELAX_OPERATION_TO_ASK_OPTION_ID;
    if (overrideOptionSelected) {
      overrideOffer = readPreflightOverrideOffer(payload.owner_override_offer);
      const expectedOverrideOption = overrideOffer?.kind === 'never_ask'
        ? NEVER_ASK_OPERATION_OPTION_ID
        : overrideOffer?.kind === 'relax_to_ask'
          ? RELAX_OPERATION_TO_ASK_OPTION_ID
          : undefined;
      if (overrideOffer === undefined || answer.option !== expectedOverrideOption) {
        throw new Error(
          'gateway.preflight on_answer: standing override option does not match a valid offer',
        );
      }
      if (deps.upsertOverride === undefined) {
        throw new Error(
          'gateway.preflight on_answer: standing override option selected but no writer is wired',
        );
      }
    }
    const checkpointId = payload.checkpoint_id;
    const runId = payload.run_id;
    // D-182 §8 — a recipe-LESS raw-op door payload carries `raw_op_id` instead
    // of `recipe_id` / `gated_step_id`; the resumer reads the full held call
    // off `Checkpoint.raw_op` and never touches those context fields. Detect it
    // first, then validate the variant's required fields.
    const rawOpId = payload.raw_op_id;
    const isRawOp = typeof rawOpId === 'string' && rawOpId.length > 0;
    if (typeof checkpointId !== 'string' || checkpointId.length === 0
      || typeof runId !== 'string' || runId.length === 0) {
      throw new Error(
        'gateway.preflight on_answer: malformed payload — expected '
          + '{ checkpoint_id: string, run_id: string, ... }',
      );
    }
    const recipeId = payload.recipe_id;
    const gatedStepId = payload.gated_step_id;
    if (!isRawOp && (
      typeof recipeId !== 'string'
      || recipeId.length === 0
      || typeof gatedStepId !== 'string'
      || gatedStepId.length === 0
    )) {
      throw new Error(
        'gateway.preflight on_answer: malformed payload — expected '
          + '{ checkpoint_id: string, run_id: string, recipe_id: string, '
          + 'gated_step_id: string } (recipe-bound) or a raw_op_id (raw-op)',
      );
    }
    const authorizationProvenance = readAuthorizationProvenance(
      payload.authorization_provenance,
    );
    const context: PreflightAskContext = {
      ...(isRawOp
        ? { raw_op: { op_id: rawOpId as string } }
        : { recipe_id: recipeId as string, gated_step_id: gatedStepId as string }),
      ...(typeof payload.tool_slug === 'string' ? { tool_slug: payload.tool_slug } : {}),
      ...(typeof payload.risk_tier === 'string' ? { risk_tier: payload.risk_tier } : {}),
      ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
      ...(authorizationProvenance !== undefined
        ? { authorization_provenance: authorizationProvenance }
        : {}),
    };
    const checkpoint = await deps.checkpointStore.get(checkpointId);
    if (checkpoint === null) {
      // The paused run no longer exists in the system — a staleness
      // guard or a manual delete consumed the checkpoint before the
      // answer arrived. Silent skip: nothing to resume or deny.
      return;
    }
    // Checkpoint existence is the single-ask stale guard: a consumed/deleted
    // hold cannot mutate standing policy. Persist before resume so the resumed
    // dispatch observes the ruling selected alongside its approval.
    if (overrideOffer !== undefined) {
      await deps.upsertOverride!(overrideOffer);
      effectiveAnswer = { ...answer, option: 'approve' };
    }
    if (effectiveAnswer.option === 'approve' || effectiveAnswer.option === 'allow_session') {
      // D-177 P3 — `allow_session` is approve PLUS a mint instruction: the
      // resume context carries the bounds the ask offered (read back off the
      // persisted payload — the snapshot taken at raise time), and the
      // resumer threads them to the engine as the gated step's mint marker.
      // The bounds are forwarded ONLY for an `allow_session` answer — a
      // plain `approve` on an offering ask must not mint. Fail-open on the
      // GRANT only: a malformed/absent `session_grant` payload (the block
      // already rejects an option the ask never offered, so this is
      // defense-in-depth against corrupted persisted state) degrades to a
      // plain approve — the human's "go ahead" is honored; the convenience
      // grant is dropped.
      const grant =
        effectiveAnswer.option === 'allow_session'
          ? readSessionGrantPayload(payload.session_grant)
          : undefined;
      await deps.resumer.resumeRun(checkpoint, {
        ...context,
        approved_at: effectiveAnswer.answered_at,
        ...(grant !== undefined ? { session_grant: grant } : {}),
      });
    } else {
      // Any other answer is treated as deny. The closed option lists
      // pre-validate to `approve`/`allow_session`/`deny` at the block's
      // selection layer; this is a defense-in-depth narrow.
      await deps.resumer.denyRun(checkpoint, context);
    }
    // Consume — idempotent. A crash between `resumeRun`/`denyRun` and
    // this delete leaves the checkpoint to a boot-sweep retry; the
    // host's callbacks MUST be safe to call again on the same input.
    await deps.checkpointStore.delete(checkpointId);
  };
};

/** Register the `gateway.preflight` `on_answer` handler with the
 *  notification block. Call once at boot, before live traffic — the
 *  block re-dispatches a persisted answer to the function registered
 *  here (the registration is per-process; the persisted
 *  `(kind, payload)` is what is durable). */
export const registerPreflightHandler = (
  notifier: PreflightNotifier,
  deps: {
    checkpointStore: CheckpointStore;
    resumer: PreflightResumer;
    batchApprovals?: PreflightBatchAnswerHooks;
    upsertOverride?: (offer: PreflightOverrideOffer) => Promise<void>;
  },
): void => {
  notifier.registerAskHandler(
    PREFLIGHT_HANDLER_KIND,
    createPreflightAnswerHandler(deps),
  );
};

/** Raise the preflight `notification.ask` for a freshly-persisted
 *  checkpoint (A.2 step 3). The host calls this immediately after
 *  writing the checkpoint. Returns the minted `ask_id` so the host
 *  can record `checkpoint_id` ↔ `ask_id` on the run anchor (D-157 §
 *  A.3) — that pairing lets a boot sweep find an `awaiting_approval`
 *  run and confirm its ask is still pending in D-158. */
export const raisePreflightAsk = async (
  notifier: PreflightNotifier,
  args: { checkpoint: Checkpoint; context: PreflightAskContext },
): Promise<{ ask_id: string }> => {
  const { message, options, handler } = buildPreflightAsk(args);
  return notifier.ask(message, options, handler);
};

/** D-210 Phase C — the PASSIVE twin of `raisePreflightAsk`.
 *
 *  Same moment, same durable hold, different device surface: instead of an
 *  actionable approve/deny card this fires a fire-and-forget heads-up and
 *  the item is reviewed in the inbox. The caller picks between the two on
 *  the owner's `inbox_fanout_mode` — ONE surface per item, never both.
 *
 *  ⚠ THIS IS NOT A WEAKER GATE. The checkpoint is already written and the
 *  run is already paused when this fires; nothing proceeds until the owner
 *  releases it from the inbox. What changes is only how they hear about
 *  it. Read `notify` here as "the question is waiting elsewhere", never as
 *  "no question was asked".
 *
 *  Returns nothing — deliberately. `raisePreflightAsk` returns an `ask_id`
 *  so the host can pin `checkpoint_id ↔ ask_id` on the run anchor; a
 *  passive notify mints no durable ask, so the anchor stays ask-less and
 *  the inbox releases it through the no-ask path
 *  (`reception-inbox-no-ask-release.ts`). An anchor whose `ask_id` is
 *  absent is the SIGNAL that this happened.
 *
 *  ── Why it does not reuse the ask body ─────────────────────────────
 *  `buildPreflightAsk`'s text is composed around a question it puts last,
 *  because that is what the buttons answer. Delivered with no buttons it
 *  would read as a question the owner cannot answer — the surface would
 *  be asking something it has no way to hear back on. So the body is
 *  written for what it is: a statement that something is held, plus where
 *  to go. It carries the same identifying facts (what, on which account,
 *  which tier) — a passive notice that omitted them would be an
 *  interruption with no information in it. */
export const raisePreflightNotify = async (
  notifier: PreflightNotifier,
  args: { checkpoint: Checkpoint; context: PreflightAskContext },
): Promise<void> => {
  const { context } = args;
  // Same vocabulary the ask body uses, so the two surfaces name the same
  // call the same way.
  const named = context.raw_op?.op_id ?? context.tool_slug;
  const action = named ?? 'a boundary-crossing call';
  const onConnection =
    context.connection_name !== undefined ? ` on ${context.connection_name}` : '';
  const tierSuffix =
    context.risk_tier !== undefined ? ` (${context.risk_tier})` : '';

  const opening =
    context.raw_op !== undefined
      ? `An AI agent asked to run ${action}${onConnection}.`
      : `Recipe ${context.recipe_id} asked to run ${action}${onConnection}.`;
  const clause = tierClause(context.risk_tier);
  const held =
    clause !== undefined
      ? `${clause}, so Recued is holding it for you.`
      : 'Recued is holding it for you.';
  const reasonLine =
    context.reason !== undefined && context.reason.length > 0
      ? `\n\nReason: ${context.reason}`
      : '';

  await notifier.notify({
    title:
      named !== undefined ? `Waiting for you: ${named}${tierSuffix}` : 'Waiting for you',
    // No question, and no implied deadline: the closing line says where the
    // decision lives, because this surface cannot take one.
    text:
      `${opening}\n${held}${reasonLine}`
      + '\n\nNothing happens until you review it in your inbox.',
  });
};
