/** D-153 P1 — Commit substrate constants + types.
 *
 *  D-153 reframes execution as a sequence of atomic commits: one tool
 *  call = one commit. The Engine records what happened (commits); the
 *  cognition component decides what should happen next. The commit log
 *  is the observable audit truth.
 *
 *  P1 ships substrate-only — the contracts here define the shape that
 *  D-120 audit rows graduate into. Engine wiring that populates these
 *  fields with non-null values is D-145 (Engine substrate); P1's only
 *  storage-side touch is the column rename `success` → `commit_status`
 *  plus seven new optional fields on `AuditEntry`. Query rpcs for the
 *  three tier scopes are P1.B.
 *
 *  Spec: D-153 § Execution Substrate / Commit substrate.
 */

import { isDeclaredMessengerVendor } from './messenger-vendors.js';
// Type-only: `ingredient-catalog`'s own import of this module is type-only too,
// so no runtime cycle materialises.
import type { TrustCeiling } from './ingredient-catalog.js';

// ────────────────────────────────────────────────────────────────
// Commit kind — observable category of the commit
// ────────────────────────────────────────────────────────────────

/** Closed enumeration of commit kinds. The discriminator is observable
 *  at audit-time so consumers can split action / query / cognition-
 *  output streams without re-deriving from the ingredient slug.
 *
 *  - `'action'` — outbound side-effect (mail send, calendar create,
 *    DOM click, vendor API write). The bulk of audit-relevant commits.
 *  - `'query'` — inbound read (mail list, calendar fetch, contact
 *    resolve). Separates "what we observed" from "what we did".
 *  - `'cognition_output'` — a cognition component emitted a
 *    composition / plan / classification artifact. The commit captures
 *    the artifact, not its downstream dispatches (those land as their
 *    own action/query commits). */
export const COMMIT_KINDS = ['action', 'query', 'cognition_output'] as const;

/** String-literal union derived from `COMMIT_KINDS`. */
export type CommitKind = (typeof COMMIT_KINDS)[number];

/** Predicate — true when `value` is a known `CommitKind`. */
export const isCommitKind = (value: unknown): value is CommitKind =>
  typeof value === 'string'
  && (COMMIT_KINDS as readonly string[]).includes(value);

// ────────────────────────────────────────────────────────────────
// Commit status — lifecycle state of the commit
// ────────────────────────────────────────────────────────────────

/** Closed enumeration of commit statuses. Replaces the pre-D-153
 *  `success: boolean` field on audit rows. Six values:
 *
 *  - `'pending'`     — Gateway wrote the row pre-dispatch; external
 *                      side-effect has not been observed yet.
 *  - `'running'`     — primitive accepted the dispatch and is mid-flight
 *                      (reserved for long-running tools).
 *  - `'succeeded'`   — terminal: tool returned a confirmed success.
 *  - `'failed'`      — terminal: tool returned a confirmed failure.
 *  - `'cancelled'`   — terminal: cancelled within grace window, or
 *                      via compensating commit (predecessor_commit_id
 *                      points at the row being undone).
 *  - `'killed'`      — terminal: the owner killed a running heavy op
 *                      via the D-181 live active-list (SIGKILL of a
 *                      `service` subprocess, or an abandoned external-io
 *                      await). Distinct from `'failed'` (the op failed on
 *                      its own) and `'cancelled'` (grace-window /
 *                      compensating undo) — a kill is a deliberate user
 *                      override of a long-running op. See D-181 §7/§12.
 *  - `'in_doubt'`    — terminal-ish: Gateway crashed or timed out
 *                      before observing the tool's outcome. No auto-
 *                      resume; user reconciles via Activity surface.
 *
 *  Spec: D-153 § Dispatch-outbox + crash-recovery.
 *
 *  Pre-D-153 audit rows (success: true/false) migrate to
 *  `'succeeded'` / `'failed'` at write time. The pending / running /
 *  cancelled / in_doubt values are reserved for the Gateway-driven
 *  dispatch outbox that lands in a later P1 slice + P3 cancellation
 *  substrate; today's synchronous recipe-runner only emits the two
 *  terminal values. */
export const COMMIT_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'killed',
  'in_doubt',
] as const;

/** String-literal union derived from `COMMIT_STATUSES`. */
export type CommitStatus = (typeof COMMIT_STATUSES)[number];

/** Predicate — true when `value` is a known `CommitStatus`. */
export const isCommitStatus = (value: unknown): value is CommitStatus =>
  typeof value === 'string'
  && (COMMIT_STATUSES as readonly string[]).includes(value);

/** Subset of `CommitStatus` representing terminal lifecycle states —
 *  the commit will not change status after this point (modulo
 *  user-driven `'in_doubt'` reconciliation, which writes a new
 *  compensating commit rather than mutating the original).
 *
 *  `'pending'` and `'running'` are the only non-terminal values. */
export const TERMINAL_COMMIT_STATUSES: ReadonlySet<CommitStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'killed',
  'in_doubt',
]);

/** True when `status` is one of the terminal lifecycle states. */
export const isTerminalCommitStatus = (status: CommitStatus): boolean =>
  TERMINAL_COMMIT_STATUSES.has(status);

// ────────────────────────────────────────────────────────────────
// Run-anchor status (D-157 P1) — lifecycle state of the recipe RUN,
// distinct from a Commit's status
// ────────────────────────────────────────────────────────────────

/** Closed enumeration of run-anchor statuses — the lifecycle state of
 *  the execution-request anchor (the recipe-run `AuditEntry`, D-153
 *  § Execution-request anchor). Distinct grain from `CommitStatus`: an
 *  anchor is one *recipe run*; a `Commit` is one *tool call* (see
 *  `Commit`). D-157 P1 widens the run-anchor status contract — a run
 *  carries every `CommitStatus` value PLUS `'awaiting_approval'`.
 *
 *  `'awaiting_approval'` is D-157's preflight-gate pause: when the
 *  `(channel × actor × contract_id)` policy matrix yields an `ask`
 *  verdict for a boundary-crossing call, the engine persists a
 *  `Checkpoint`, ends the execution, and the run anchor carries
 *  `'awaiting_approval'` until the user answers the preflight
 *  `notification.ask`.
 *
 *  `'awaiting_approval'` is deliberately NOT a member of
 *  `COMMIT_STATUSES` — a *commit* (one tool call) is never "awaiting
 *  approval": the call either dispatched or it did not. The pause is a
 *  property of the *run*, not of any single commit. `RUN_ANCHOR_STATUSES`
 *  derives from `COMMIT_STATUSES` by extension (a new array), leaving
 *  the commit-status closed set untouched (D-157 § A.3 / N.4).
 *
 *  Spec: D-157 § N.4 / A.3. */
export const RUN_ANCHOR_STATUSES = [
  ...COMMIT_STATUSES,
  'awaiting_approval',
  /** D-234 § 234.4 — held for a PEER'S answer, not the owner's.
   *
   *  ⛔⛔ A DISTINCT STATUS, NOT A FLAG BESIDE `awaiting_approval`, AND THE
   *  REASON IS THE FAILURE DIRECTION. `commit_status` is carried verbatim and
   *  surfaces switch on it (`DishLastRun` — "so the surface can distinguish a
   *  hold from a failure"). A flag makes any surface that does not know the flag
   *  render an APPROVE BUTTON ON SOMETHING IT CANNOT APPROVE — the owner cannot
   *  answer this hold, only cancel it or keep waiting. A distinct status makes an
   *  unaware surface render "a hold I do not recognise", which is the harmless
   *  direction. Adding it obliges a sweep of every `awaiting_approval` consumer;
   *  that is the intended cost. */
  'awaiting_peer',
] as const;

/** String-literal union derived from `RUN_ANCHOR_STATUSES` — equivalent
 *  to `CommitStatus | 'awaiting_approval'`. The type of the recipe-run
 *  `AuditEntry`'s `commit_status` field (D-157 P1 widens it from
 *  `CommitStatus`). */
export type RunAnchorStatus = (typeof RUN_ANCHOR_STATUSES)[number];

/** Predicate — true when `value` is a known `RunAnchorStatus`. */
export const isRunAnchorStatus = (value: unknown): value is RunAnchorStatus =>
  typeof value === 'string'
  && (RUN_ANCHOR_STATUSES as readonly string[]).includes(value);

/** D-234 § 234.4 — is this anchor HELD, i.e. suspended into a live `Checkpoint`
 *  that something must eventually resume or sweep?
 *
 *  ⛔⛔ THIS PREDICATE EXISTS BECAUSE THE ALTERNATIVE WAS 54 EDITS THAT WOULD
 *  NEVER CONVERGE. `awaiting_peer` doubled the meanings of a literal that ~54
 *  non-test sites compare against, and adding `|| 'awaiting_peer'` at each is a
 *  per-site sweep with no completion criterion — you cannot tell a site you
 *  finished from a site you never saw.
 *
 *  🔑 EVERY SITE NOW HAS TO ANSWER ONE QUESTION, AND THE TWO ANSWERS ARE
 *  DIFFERENT CODE: does it mean "a run is HELD" (use this) or "held for MY
 *  OWNER'S APPROVAL specifically" (keep the literal)? A resumer, a boot sweep and
 *  a retention scan mean the first. An approvals queue, an approve/deny
 *  affordance and an ask-pairing mean the second.
 *
 *  ⛔ THE SITE THAT PROVES THE POINT: `checkpoint-retention.ts` deletes the
 *  checkpoint of any anchor whose status `!== 'awaiting_approval'` as "crash
 *  residue". Left alone it would sweep away every run waiting on a peer, after a
 *  grace period, silently — and no test would have caught it, because nothing
 *  writes the new status in a fixture. */
export const isHeldRunAnchorStatus = (value: unknown): boolean =>
  value === 'awaiting_approval' || value === 'awaiting_peer';

/** Closed set of post-execution observability degradation reasons.
 *  These do not change the run's side-effect outcome: the recipe
 *  already executed, but a durable audit/provenance surface is
 *  incomplete and callers must show that distinction instead of
 *  treating the run as fully recorded. */
export const RUN_DEGRADATIONS = [
  'audit_unwritten',
  'provenance_incomplete',
] as const;

export type RunDegradation = (typeof RUN_DEGRADATIONS)[number];

export const isRunDegradation = (value: unknown): value is RunDegradation =>
  typeof value === 'string'
  && (RUN_DEGRADATIONS as readonly string[]).includes(value);

// ────────────────────────────────────────────────────────────────
// Actor — who's driving the invocation
// ────────────────────────────────────────────────────────────────

/** Closed enumeration of actor identities — *who is driving*. Combined
 *  with `channel` on the `ExecutionSource` discriminator to key the
 *  (channel × actor) policy matrix (D-153 P2). Identity-only (D-161
 *  Part A): an actor names a *who*, never a *mode*. Four values:
 *
 *  - `'user_self'`       — the user acting as themselves. A `user_self`
 *                          carrying a `contract_id` is the *self-
 *                          restricted* mode ("during work hours, no
 *                          destructive tools") — a derived label
 *                          (`renderActorLabel`), NOT a separate actor.
 *  - `'contracted_user'` — a distinct outside identity under a user-
 *                          established contract (MCP agent with token,
 *                          reception visitor with chat-contract,
 *                          messenger bot bound to a contract). Carries
 *                          `contract_id`.
 *  - `'system'`          — engine-internal — cron / reactive /
 *                          housekeeping / vendor webhook. No human or
 *                          agent presence at dispatch time.
 *  - `'anonymous'`       — reception channel without chat-contract
 *                          (form submission, drop link). No actor
 *                          identity established.
 *
 *  D-161 Part A collapsed the former five-member enum to these four:
 *  `contracted_self` was `user_self` carrying a contract (a *mode*, not
 *  an identity); `mini_self` (a prose synonym) and the stale `agent` are
 *  also gone. "Operating under a contract" is encoded once — as
 *  `contract_id` on the `ExecutionSource` (read via
 *  `executionSourceHasContract`) — never as an actor variant.
 *
 *  Spec: D-161 § N.2 / N.3; D-153 § (channel ×
 *  actor) policy matrix. */
export const ACTORS = [
  'user_self',
  'contracted_user',
  'system',
  'anonymous',
] as const;

/** String-literal union derived from `ACTORS`. */
export type Actor = (typeof ACTORS)[number];

/** Predicate — true when `value` is a known `Actor`. */
export const isActor = (value: unknown): value is Actor =>
  typeof value === 'string'
  && (ACTORS as readonly string[]).includes(value);

// ────────────────────────────────────────────────────────────────
// Channel — how the invocation entered Recued
// ────────────────────────────────────────────────────────────────

/** Closed enumeration of channels. The launch set is 9 channels;
 *  extension requires a D-spec naming the channel semantics + actor
 *  pairings (closed-list-with-extension-protocol shape). Near-term
 *  candidate: `'voice'` (phone / smart speaker). The list is closed
 *  at the type-system level today; new channels add a row here, a
 *  row in the policy matrix, and any cognition-component updates.
 *
 *  Spec: D-153 § (channel × actor) policy matrix —
 *  "Channel list is open for extension". */
export const CHANNELS = [
  'user',
  'chat',
  'mcp',
  'messenger',
  'reception',
  'webhook',
  'schedule',
  'reactive',
  'housekeeping',
] as const;

/** String-literal union derived from `CHANNELS`. */
export type Channel = (typeof CHANNELS)[number];

/** Predicate — true when `value` is a known `Channel`. */
export const isChannel = (value: unknown): value is Channel =>
  typeof value === 'string'
  && (CHANNELS as readonly string[]).includes(value);

// ────────────────────────────────────────────────────────────────
// ExecutionSource — discriminated union of (channel × actor) tagged
// with the channel-specific identifying fields
// ────────────────────────────────────────────────────────────────

/** D-192 CORE #6 — the `'messenger'` channel's `vendor` tag is a declared
 *  chat-transport slug (`MESSENGER_VENDOR_DECLARATIONS` in
 *  `messenger-vendors.ts`), validated at runtime by
 *  `isDeclaredMessengerVendor`. The former closed `MESSENGER_VENDORS`
 *  union (`slack | telegram | email`) + its `MessengerVendor` type +
 *  `isMessengerVendor` predicate were retired: `email` was a category
 *  error (it is a notification channel / mail-mirror inbound, never a chat
 *  transport — the `work-entities.ts` `CommitmentMessageEvidence.vendor`
 *  comment names this exact bug), and hardcoding the transport set here in
 *  a second place drifted from the registry. A new transport is a registry
 *  entry + a leaf, never an edit to this union. */

/** Discriminated union over `(channel × actor)`. Each variant carries
 *  the channel-specific identifying fields the policy matrix uses to
 *  refine the lookup. The policy key is `(channel × actor ×
 *  contract_id)`.
 *
 *  `contract_id` encodes "operating under a contract" — once (D-161
 *  N.4). A `'contracted_user'` always carries it (required on every
 *  variant below). A `'user_self'` carries it *optionally* on the
 *  `'user'` / `'chat'` channels: a present `contract_id` is the self-
 *  restricted mode (the derived `renderActorLabel` "self-restricted");
 *  absent is the unrestricted baseline. Read it variant-agnostically via
 *  `executionSourceHasContract` / `executionSourceContractId` rather than
 *  narrowing on the actor — an actor-based check misses self-restriction.
 *
 *  Where a channel admits both `'user_self'` and a `'contracted_user'`
 *  (`'chat'` / `'messenger'`) the variant splits into two: the
 *  `'user_self'` shape and the `'contracted_user'` shape with a required
 *  `contract_id`. Downstream narrowing on `source.actor` resolves to the
 *  right shape. (O-6: `contract_id` stays *required* for every
 *  `'contracted_user'` variant — the tightening D-161 keeps over the
 *  looser channel-keyed form.)
 *
 *  Spec: D-161 § A.1; D-153 § (channel × actor)
 *  policy matrix. */
export type ExecutionSource =
  | {
      channel: 'user';
      actor: 'user_self';
      user_id: string;
      client_token_id: string;
      contract_id?: string;
    }
  | {
      channel: 'chat';
      actor: 'user_self';
      chat_session_id: string;
      user_id: string;
      contract_id?: string;
      /** D-177 P5a (N.10) — the chat turn this dispatch originated in,
       *  plumbed onto the commit input so the batched-approval origin
       *  unit can group same-turn holds (`deriveOriginUnit`). Optional:
       *  a source minted before the turn boundary (or by a harness)
       *  falls back to the `correlation_id` stand-in. */
      turn_id?: string;
    }
  | {
      channel: 'chat';
      actor: 'contracted_user';
      chat_session_id: string;
      user_id: string;
      contract_id: string;
      /** D-177 P5a (N.10) — see the `user_self` chat variant. */
      turn_id?: string;
    }
  | {
      channel: 'mcp';
      actor: 'contracted_user';
      agent_id: string;
      tool_call_id: string;
      mcp_token_id: string;
      contract_id: string;
    }
  | {
      channel: 'messenger';
      actor: 'user_self';
      /** A declared chat-transport slug (`isDeclaredMessengerVendor`);
       *  never `email` (a notification channel, not a transport). */
      vendor: string;
      from: string;
    }
  | {
      channel: 'messenger';
      actor: 'contracted_user';
      /** A declared chat-transport slug (`isDeclaredMessengerVendor`);
       *  never `email` (a notification channel, not a transport). */
      vendor: string;
      from: string;
      contract_id: string;
    }
  | {
      channel: 'reception';
      actor: 'anonymous';
      reception_id: string;
      visitor_id?: string;
      /** D-207 slice 1b — the reception DOOR contract governing this dispatch.
       *
       *  SERVER-DERIVED, never caller-supplied: the handler resolves
       *  `reception_id → pair → recipe → that recipe's contract_id`. A public visitor
       *  cannot name a contract.
       *
       *  The actor stays `anonymous` — deliberately. It would have been smaller to reuse
       *  the `(reception, contracted_user)` variant, which already carries a
       *  `contract_id`, but `contracted_user` renders as an AGENT assertion while
       *  `anonymous` renders as VISITOR-derived (`provenance-attribution.ts`), and that
       *  actor propagates into every row the recipe writes. Overloading identity to
       *  encode dispatch authority would make the warehouse lie about its own
       *  provenance, permanently. Identity says WHO; `contract_id` says UNDER WHAT
       *  AUTHORITY. They are different questions.
       *
       *  Absent ⇒ the gate resolves the fail-closed {@link PUBLIC_CONTRACT_ID} floor,
       *  NEVER "contract-free". */
      contract_id?: string;
    }
  | {
      channel: 'reception';
      actor: 'contracted_user';
      reception_id: string;
      visitor_id?: string;
      contract_id: string;
    }
  | {
      channel: 'webhook';
      /** D-209 #1 (W3) — `anonymous`, not `system`: a webhook fire is an EXTERNAL
       *  party's dispatch (the vendor's machine), not the server's own maintenance.
       *  Same actor-honesty rule as the reception variant above: identity says WHO
       *  (an outside caller), `contract_id` says UNDER WHAT AUTHORITY (the recipe's
       *  webhook door). The actor propagates into every row the recipe writes
       *  (`origin_actor`), so `system` here would launder vendor-driven writes into
       *  server-internal ones, permanently. */
      actor: 'anonymous';
      vendor: string;
      /** Legacy ExecutionSource field name; carries the ingress identity, never a
       *  secret or credential-set reference (D-201). */
      webhook_secret_id: string;
      /** D-209 #1 — the recipe's webhook DOOR contract (`door_types: ['webhook']`),
       *  minted at save/install (W2b) and stamped on the recipe's trigger rows.
       *
       *  SERVER-DERIVED, never caller-supplied: the consumer resolves it from the
       *  dispatch claim's trigger row. A vendor cannot name a contract.
       *
       *  Absent ⇒ the trigger row was never stamped (pre-mint crash window, legacy
       *  row) — the gate resolves the fail-closed {@link PUBLIC_CONTRACT_ID} floor
       *  (denies every op) and `resolveTrustCeiling` keeps the LOW `read` ceiling,
       *  NEVER "contract-free". The owner's remedy is re-save (re-mint + re-stamp). */
      contract_id?: string;
    }
  | {
      channel: 'schedule';
      actor: 'system';
      cron: string;
      source_recipe: string;
      /** D-209 §1.4 — the owner's own AUTOMATION runs under a contract: the origin
       *  recipe's (the owner's own scheduled recipes take `OWNER_CONTRACT_ID`).
       *  `resolveTrustCeiling` reads it → has-contract → `read` ceiling → writes HOLD.
       *  Silence is earned via the D-177 learner, or by the owner raising this
       *  contract's ceiling — never automatic. Optional because a genuinely
       *  server-internal background dispatch (a materialize) may run contract-free. */
      contract_id?: string;
    }
  | {
      channel: 'reactive';
      actor: 'system';
      event_kind: string;
      source_recipe: string;
      /** D-209 §1.4 — see the `schedule` variant. The origin's contract: the owner's
       *  own trigger/auto-run recipes take `OWNER_CONTRACT_ID` (→ `read` → HOLD); a
       *  server-INTERNAL reactive fire (a reception materialize) runs contract-free.
       *  Optional — the `reactive` channel spans both. */
      contract_id?: string;
    }
  | {
      channel: 'housekeeping';
      actor: 'system';
      cycle_id: string;
      task: string;
      visible_to_user: false;
    };

/** Full structural predicate — true when `value` matches one of the
 *  `ExecutionSource` discriminated-union variants exactly. Validates:
 *    - `channel` is a known `Channel` literal
 *    - `actor` is admissible under the variant's actor set (e.g.,
 *      `'mcp'` requires `'contracted_user'`, never `'anonymous'`)
 *    - every required string / vendor / boolean-literal field is present
 *      with the right primitive type
 *    - optional fields, when present, are strings (closed by the type)
 *
 *  The predicate's narrowing promise (`value is ExecutionSource`) is
 *  load-bearing for the (channel × actor) policy matrix (D-153 P2) +
 *  the Gateway dispatch outbox: callers rely on variant-specific
 *  fields like `contract_id` or `vendor` being present after the
 *  guard returns true. A weaker shallow check would let downstream
 *  policy code make decisions on partial shapes. */
export const isExecutionSource = (value: unknown): value is ExecutionSource => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const { channel, actor } = v;
  if (!isChannel(channel) || !isActor(actor)) return false;

  const isString = (x: unknown): x is string => typeof x === 'string';
  const isOptString = (x: unknown): boolean => x === undefined || isString(x);

  switch (channel) {
    case 'user':
      if (actor === 'user_self') {
        return isString(v.user_id)
          && isString(v.client_token_id)
          && isOptString(v.contract_id);
      }
      return false;
    case 'chat':
      if (actor === 'user_self') {
        return isString(v.chat_session_id)
          && isString(v.user_id)
          && isOptString(v.contract_id)
          && isOptString(v.turn_id);
      }
      if (actor === 'contracted_user') {
        return isString(v.chat_session_id)
          && isString(v.user_id)
          && isString(v.contract_id)
          && isOptString(v.turn_id);
      }
      return false;
    case 'mcp':
      return actor === 'contracted_user'
        && isString(v.agent_id)
        && isString(v.tool_call_id)
        && isString(v.mcp_token_id)
        && isString(v.contract_id);
    case 'messenger':
      if (actor === 'user_self') {
        return isDeclaredMessengerVendor(v.vendor) && isString(v.from);
      }
      if (actor === 'contracted_user') {
        return isDeclaredMessengerVendor(v.vendor)
          && isString(v.from)
          && isString(v.contract_id);
      }
      return false;
    case 'reception':
      if (actor === 'anonymous') {
        return isString(v.reception_id) && isOptString(v.visitor_id);
      }
      if (actor === 'contracted_user') {
        return isString(v.reception_id)
          && isOptString(v.visitor_id)
          && isString(v.contract_id);
      }
      return false;
    case 'webhook':
      // D-209 #1 (W3) — `anonymous`: an external vendor's dispatch under a webhook
      // door, never the server's own `system` (see the variant's doc comment).
      return actor === 'anonymous'
        && isString(v.vendor)
        && isString(v.webhook_secret_id)
        && isOptString(v.contract_id);
    case 'schedule':
      return actor === 'system'
        && isString(v.cron)
        && isString(v.source_recipe)
        && isOptString(v.contract_id);
    case 'reactive':
      return actor === 'system'
        && isString(v.event_kind)
        && isString(v.source_recipe)
        && isOptString(v.contract_id);
    case 'housekeeping':
      return actor === 'system'
        && isString(v.cycle_id)
        && isString(v.task)
        && v.visible_to_user === false;
  }
};

// ────────────────────────────────────────────────────────────────
// Contract-presence + actor-label helpers — read "has a contract" and
// render the actor for a human, both off the (actor × contract_id)
// primitive (D-161 N.3 / N.4)
// ────────────────────────────────────────────────────────────────

/** The `contract_id` carried by an `ExecutionSource`, or `undefined`
 *  when none is set. D-161 N.4: "operating under a contract" is encoded
 *  exactly once — as `contract_id` on the source — never as an actor
 *  variant. Read it through this helper rather than narrowing on the
 *  actor: a `'contracted_user'` always carries one, and a self-restricted
 *  `'user_self'` carries one too (the case an actor-based check misses).
 *  Tolerates the optional field being present-but-`undefined`. */
export const executionSourceContractId = (
  source: ExecutionSource,
): string | undefined => {
  const id = (source as { contract_id?: unknown }).contract_id;
  return typeof id === 'string' ? id : undefined;
};

/** True when the `ExecutionSource` carries a `contract_id`. The single
 *  condition governing `contract_snapshot` presence on a commit (D-161
 *  N.4): a commit carries a snapshot iff its source carries a
 *  `contract_id` — covering both a `'contracted_user'` and a self-
 *  restricted `'user_self'`, and nothing else. Replaces the former
 *  actor-based `isContractScopedActor`, which missed self-restriction. */
export const executionSourceHasContract = (source: ExecutionSource): boolean =>
  executionSourceContractId(source) !== undefined;

/** The reserved `mcp_token_id` for the owner's OWN local stdio / canonical-CLI MCP
 *  client — the one MCP source that is NOT a delegated door. Every INBOUND door bearer
 *  is stamped a derived token id by the HTTP transport; only the owner's local client
 *  has no token and falls back to this sentinel (`buildMcpExecutionSource`). It is the
 *  delegated-vs-owner discriminator the D-187 trust ceiling needs (`resolveTrustCeiling`):
 *  the mcp channel forces every source to `actor: 'contracted_user'` + a `contract_id`
 *  (synthetic = the token id when unbound), so neither the actor nor the contract_id can
 *  tell the owner from an unbound inbound door — but the token id can (a real bearer's
 *  derived id ≠ this sentinel). Owner stdio ⇒ contract-less (`admin`); any inbound door,
 *  bound or unbound ⇒ contracted (`read`, LOW — AI writes surface). Defined here with the
 *  `ExecutionSource` it keys; `mcp-server.ts` re-exports it for its source-builder. */
export const STDIO_MCP_TOKEN_ID = 'stdio_local';

/** True when an `mcp` dispatch is a DELEGATED inbound door rather than the owner's own
 *  local stdio / canonical-CLI client — the ONE definition of that distinction.
 *
 *  The mcp channel forces EVERY source to `actor: 'contracted_user'` + a `contract_id`
 *  ({@link STDIO_MCP_TOKEN_ID}'s note), so neither field can tell the owner from a door;
 *  only the token can. Two axes ask this same question and MUST agree — the TRUST axis
 *  ({@link resolveTrustCeiling}: does this dispatch take the owner's `admin` ceiling?)
 *  and the GRANT axis (`matchesGateGrant`'s door clause: may this dispatch ride an
 *  UNBOUND session grant?). They were one inlined `!==` away from drifting apart, and the
 *  equality test that predated the trust axis's version WRONGLY admitted an unbound
 *  inbound door at the owner ceiling (codex slice-4 HIGH#2) — the cost of getting this
 *  comparison wrong is already on the record once.
 *
 *  FAIL-CLOSED BY CONSTRUCTION: anything that is not POSITIVELY the reserved owner
 *  sentinel is a door, so a caller that cannot supply the id gets the door treatment.
 *  The owner proves ownership; a door never proves its way out. The failure directions
 *  are deliberately asymmetric — an unsupplied id breaks the owner's own client loudly
 *  (a test pins it), where the opposite default would hand a door the owner's authority
 *  silently. */
export const isDelegatedMcpToken = (mcp_token_id: string | undefined): boolean =>
  mcp_token_id !== STDIO_MCP_TOKEN_ID;

/** D-177 N.14.6 — is this dispatch a DOOR (an outside identity reaching in through an
 *  externally-established entry point) rather than the owner? The source-side twin of
 *  `isDoorMatchContext` (`session-grant.ts`), which asks the same question of the
 *  narrowed match context; the two arms are stated once each and must agree.
 *
 *  Doors: the reception visitor (the ACTOR carries it) and a DELEGATED mcp bearer (only
 *  {@link isDelegatedMcpToken} carries it — the channel forces the owner's own stdio
 *  client to `contracted_user` + a `contract_id` as well). Everything else is NOT a door,
 *  deliberately: a self-restricted `user_self` and the owner's contracted chat both carry
 *  a `contract_id`, so classifying on contract PRESENCE would strip the owner of their
 *  own grants.
 *
 *  ⚠ Does NOT classify an `llm_gateway` door — see `isDoorMatchContext`'s note. */
export const isDoorDispatchSource = (source: ExecutionSource): boolean =>
  source.actor === 'anonymous'
  || (source.channel === 'mcp' && isDelegatedMcpToken(source.mcp_token_id));

/** The label for an actor as rendered for a human (audit / UI). D-161
 *  N.3 / A.3: "self-restricted" is NOT a stored actor — it is the
 *  derived label for a `'user_self'` carrying a `contract_id`. Every
 *  other case renders the bare actor identity. The stored primitive is
 *  always `(actor, contract_id?)`; this is the single place the label is
 *  computed, so the two encodings of "has a contract" can never drift
 *  (the defect D-161 removes — I-2 / TR-2). */
export type ActorLabel = Actor | 'self-restricted';

export const renderActorLabel = (source: ExecutionSource): ActorLabel =>
  source.actor === 'user_self' && executionSourceHasContract(source)
    ? 'self-restricted'
    : source.actor;

// ────────────────────────────────────────────────────────────────
// ContractSnapshot — resolved contract scope inlined at dispatch time
// ────────────────────────────────────────────────────────────────

/** Resolved contract scope at the moment of dispatch. Inlined onto
 *  every commit whose `ExecutionSource` carries a `contract_id` (D-161
 *  N.4 — a `'contracted_user'`, or a self-restricted `'user_self'`) so
 *  future revocation / version-bump never invalidates historical commit
 *  interpretation.
 *
 *  Costs ~200 bytes per contract-scoped commit; the bulk of commits
 *  are `'user_self'` and don't carry a snapshot.
 *
 *  The full contracts substrate (issue / revoke / version-bump /
 *  lifecycle UI) is deferred (D-153 open question #21). The snapshot
 *  itself is NOT deferred — without it, post-revocation audit reads
 *  fail closed (or worse, succeed with wrong scope).
 *
 *  Spec: D-153 § Commit substrate / Contract lifecycle
 *  is a deferred concern. */
export interface ContractSnapshot {
  /** Opaque ref to the contract this commit ran under. */
  contract_id: string;
  /** Opaque content version of the resolved authority at dispatch time. It
   *  changes whenever an authority field in this snapshot changes (tool
   *  allowlist, approval tiers, scope fence, or trust ceiling) and stays stable
   *  across dispatches with equivalent authority. Pinning by
   *  `(contract_id, contract_version)` lets audit readers identify the exact
   *  policy that was in force even though its fields are resolved from multiple
   *  live stores. Current server values use the domain-separated
   *  `authority-sha256-v1:<digest>` scheme; consumers must treat the string as
   *  opaque. */
  contract_version: string;
  /** Resolved tool allowlist — the set of ingredient.tool slugs the
   *  contract admitted at dispatch time. */
  allowed_tools: ReadonlyArray<string>;
  /** Resolved approval-required tiers — which risk tiers required
   *  approval under this contract version. Item shape is `string` for
   *  P1; tightens to a `RiskTier` literal once the contracts
   *  substrate formalises the risk-tier taxonomy (open question #21). */
  approval_required: ReadonlyArray<string>;
  /** Resolved `data.*` / `connection.*` scopes admissible under this
   *  contract version. Item shape is `string` for P1; grammar
   *  formalises with the contracts substrate (open question #21). */
  scope_restrictions: ReadonlyArray<string>;
  /** Dispatch-time unix-ms — when the Gateway resolved + inlined this
   *  snapshot. Pairs with the commit's own `dispatched_at`. */
  resolved_at: number;
  /** D-209 #1 — the DOOR's authored stage-trust ceiling, resolved from the
   *  door contract at snapshot-build time. `resolveTrustCeiling` reads it in
   *  preference to the flat `CONTRACTED_DEFAULT_TRUST_CEILING` — this is what
   *  makes trust PER-DOOR (a webhook door the owner wired on both sides
   *  admits granted writes; an mcp door the owner deliberately raised, ditto)
   *  instead of one constant for every contracted dispatch.
   *
   *  Absent ⇒ the contracted LOW default (`read`) — every existing door.
   *  ⛔ A `reception` (human-facing, prompt-injectable) door is PINNED at
   *  `read` by the READER regardless of this field (the rev-5 F3 rule:
   *  raising the ceiling turns `ask` into `admit`, skipping the taint check —
   *  a public form must never be raisable). */
  max_risk_without_approval?: TrustCeiling;
  /** The ops this door's owner CONFIRMED at bind, resolved at snapshot-build
   *  time — present exactly when the door carries
   *  `DoorExecutionPolicy.standing_closure`.
   *
   *  A gate reading this admits an `ask` verdict for an op NAMED HERE, at or
   *  below `write`, instead of raising. Absent (every mcp / webhook snapshot,
   *  and every reception door without the opt-in) ⇒ the field is never read and
   *  behaviour is unchanged.
   *
   *  ⛔ IT IS AN AUTHORITY FIELD, so it is IN `contract_version`. A closure that
   *  moved without moving the version would make an audit row's "this is the
   *  exact policy that was in force" untrue. */
  standing_closure_operation_ids?: ReadonlyArray<string>;
}

/** Tiers a standing closure may admit. ⛔ `destructive` and `admin` are absent
 *  DELIBERATELY: the closure is an approval for the ordinary work a door does,
 *  never for deleting or for administering. The same bound the contract-less
 *  `admin` ceiling already keeps ("only destructive asks") — kept explicitly
 *  here rather than inherited, so widening it is a visible edit. */
export const STANDING_CLOSURE_RISK_TIERS: ReadonlyArray<string> =
  Object.freeze(['read', 'write']);

/** D-207 follow-on — does this dispatch's door admit `operation_id` on its
 *  owner-confirmed standing closure?
 *
 *  ⛔⛔ ONE PREDICATE, TWO GATES. The catalog gate (`runCatalogOperation`) and
 *  the commit Gateway both consult it, because a door recipe dispatches through
 *  BOTH — a Records/API op through the catalog, a simple-form kernel op like
 *  `core.mail.send` through the commit gate. Two copies of this rule is how one
 *  of them would keep asking, or worse, keep admitting after the other stopped.
 *
 *  Fail-closed on every axis: no snapshot, no closure field, an op not named, a
 *  tier above `write`, a snapshot for some OTHER contract than the one this
 *  dispatch runs under, OR an `ask` that came from the commitment-proposal lift
 *  ⇒ `false`, and the gate raises exactly as before. */
export const standingClosureAdmits = (
  snapshot: ContractSnapshot | undefined,
  // ⛔ THE REAL `ExecutionSource`, not a structural `{ contract_id?: string }`.
  // That shape is a TS *weak type* — every property optional — so a union member
  // with no overlap (`{channel:'messenger', actor:'user_self', …}`) is rejected
  // at the call site, which is how this signature failed to compile at all.
  // Naming the union also stops a caller handing it an arbitrary object that
  // happens to carry a `contract_id`.
  source: ExecutionSource | undefined,
  operation_id: string | undefined,
  risk_tier: string | undefined,
  /** D-192 F1 invariant 3 — why the closure must see a LIFT, not just a tier.
   *
   *  ⛔⛔ A LIFT IS NOT A PERMISSION, AND THAT IS THE WHOLE POINT. Standing
   *  closure answers "MAY this op run?" — the review-once-then-stands model the
   *  owner confirmed at bind, and nothing here weakens it. A lift answers a
   *  different question: "what does this op MEAN?". `commitment-propose` has
   *  the SAME MINT EFFECT as `commitment.create` (kernel-op-registry.ts, its
   *  own words); the ONLY thing making it a proposal rather than a fait
   *  accompli is that it HOLDS. Admit it unattended and the two ops become
   *  functionally identical and the proposal surface stops expressing anything.
   *
   *  ⛔ AND THE TIER CANNOT CARRY THIS. `liftCommitmentProposal` is a pure
   *  tightening that moves the VERDICT to `ask` while deliberately PRESERVING
   *  `effective_risk_tier` at `write` for audit — so a tier-only test sees an
   *  ordinary `write` op sitting in the closure and admits it. The lift was
   *  invisible at BOTH ends: `opsThatAskAnyway` (reception-door-bind.ts) filters
   *  on raw `risk`, so the consent screen never listed it either. The gate and
   *  the screen agreed with each other and both were wrong, which is exactly
   *  why no test saw this.
   *
   *  🔑 `'review_send'` deliberately still ADMITS. Its unattended relax IS the
   *  feature — a form's reply email running without a pause is the point — and
   *  D-192 F1 enumerates that asymmetry against the commitment lift on purpose.
   *  Only the commitment lift is closure-proof. `'quality'` also still admits:
   *  it is not a meaning-bearing surface distinction.
   *
   *  ⚠ This costs the unattended-minting use case NOTHING, because it is
   *  already expressible and always was — use `commitment.create`, which the
   *  lift's own docblock names as the way to "author it directly via
   *  commitment-create to skip review".
   *
   *  Found by invention round 9 (AUD-T5-A), latent at the time: 0 of 2,274
   *  shipped recipes name `core.work-entity.commitment.propose`, so this had
   *  never fired in production — it would have gone live the moment anyone
   *  bound a door recipe that proposes commitments. */
  lift_reason: 'review_send' | 'review_commitment' | 'quality' | undefined,
): boolean => {
  if (snapshot === undefined || operation_id === undefined) return false;
  if (lift_reason === 'review_commitment') return false;
  const closure = snapshot.standing_closure_operation_ids;
  if (closure === undefined) return false;
  if (risk_tier === undefined || !STANDING_CLOSURE_RISK_TIERS.includes(risk_tier)) {
    return false;
  }
  // ⛔ The snapshot must be THIS dispatch's own door — the same contract_id
  // match `authoredWebhookDoorCeiling` insists on, and for the same reason: a
  // snapshot resolved for another contract must never authorize this call.
  // Read through `executionSourceContractId`, the one accessor that already
  // knows a self-restricted `user_self` carries a contract too.
  const contractId = source === undefined ? undefined : executionSourceContractId(source);
  if (typeof contractId !== 'string' || contractId !== snapshot.contract_id) return false;
  return closure.includes(operation_id);
};

/** Completeness pin for the snapshot ceiling vocabulary. A `Record` keyed on
 *  the FULL `TrustCeiling` union: a value added to (or dropped from) the union
 *  fails this map's typecheck, where a `readonly TrustCeiling[]` literal would
 *  silently accept a subset. */
const SNAPSHOT_TRUST_CEILINGS: Record<TrustCeiling, true> = {
  none: true,
  read: true,
  write: true,
  admin: true,
};

const isSnapshotTrustCeiling = (value: unknown): value is TrustCeiling =>
  typeof value === 'string'
  && Object.prototype.hasOwnProperty.call(SNAPSHOT_TRUST_CEILINGS, value);

/** Structural predicate — true when `value` matches `ContractSnapshot`
 *  exactly. Validates the six required fields with their primitive types:
 *  the three resolved-scope arrays (`allowed_tools` / `approval_required` /
 *  `scope_restrictions`) must be string arrays, and `contract_id` /
 *  `contract_version` / `resolved_at` their declared primitives; the optional
 *  `max_risk_without_approval` must be a `TrustCeiling` when present. Used by
 *  `isCommit` to narrow the optional snapshot when a commit row is read
 *  back as untyped JSON. */
export const isContractSnapshot = (
  value: unknown,
): value is ContractSnapshot => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const isStringArray = (x: unknown): x is readonly string[] =>
    Array.isArray(x) && x.every((e) => typeof e === 'string');
  const isFinite = (x: unknown): x is number =>
    typeof x === 'number' && Number.isFinite(x);

  if (typeof v.contract_id !== 'string') return false;
  if (typeof v.contract_version !== 'string') return false;
  if (!isStringArray(v.allowed_tools)) return false;
  if (!isStringArray(v.approval_required)) return false;
  if (!isStringArray(v.scope_restrictions)) return false;
  if (v.max_risk_without_approval !== undefined
    && !isSnapshotTrustCeiling(v.max_risk_without_approval)) return false;
  return isFinite(v.resolved_at);
};

// ────────────────────────────────────────────────────────────────
// Commit — the atomic execution-substrate row (one tool call = one
// commit). D-145 engine-wiring slice 3a authors the interface; the
// Gateway dispatch-outbox (slice 3b) populates + persists commits.
// ────────────────────────────────────────────────────────────────

/** Ceiling on a commit's `dispatch_depth`. The Gateway refuses to
 *  dispatch a tool call whose depth would exceed this — the within-
 *  process backstop against an unbounded egress→ingress execution loop
 *  (D-153 open question #22).
 *
 *  32 boundary-crossings deep is already far past any legitimate
 *  personal-automation dispatch tree; the ceiling exists to bound a
 *  runaway cycle, not to constrain real recipes. A conservative
 *  default — tunable, not a hard architectural limit.
 *
 *  The `dispatch_depth` field lives on every `Commit`; the Gateway owns
 *  the per-call increment + the refuse-past-ceiling check (slice 3b).
 *  Loops that close through a *channel ingress* (cross-process) are
 *  bounded the same way: D-160 P3 threads `dispatch_depth` onto channel
 *  ingress (`ChannelInbound.dispatch_depth`) as a sibling of the
 *  `ExecutionSource` — `nextDispatchDepth` advances it across the hop,
 *  the run's `CommitRunIdentity` inherits it, and the Gateway refuses
 *  past this same ceiling.
 *
 *  Spec: D-153 § Open question #22; D-160
 *  § I-7. */
export const MAX_DISPATCH_DEPTH = 32;

/** Advance a dispatch-tree depth by one hop — the canonical
 *  `dispatch_depth` increment. Within-process the Gateway already
 *  advances a child run's depth; across a *channel ingress* — a
 *  `messenger` post that re-enters as a trigger — the same `+1` applies
 *  as the hop crosses the boundary (D-160 I-7 / TR-6). One named
 *  primitive so every hop, in-process or cross-channel, counts
 *  identically; the re-entrant `ChannelInbound` carries the result and
 *  the Gateway refuses once it passes `MAX_DISPATCH_DEPTH`, bounding a
 *  `messenger`→trigger→`messenger` cycle.
 *
 *  Spec: D-160 § I-7; D-153 § Open question
 *  #22. */
export const nextDispatchDepth = (parent: number): number => parent + 1;

/** The atomic execution-substrate row: **one boundary-crossing tool
 *  call = one commit**. D-153 reframes execution as a flat sequence of
 *  these — the Engine records what happened (commits); the cognition
 *  component decides what should happen next; the commit log is the
 *  observable audit truth.
 *
 *  Distinct grain from D-120's `AuditEntry`: an `AuditEntry` is one
 *  *recipe run*; a `Commit` is one *tool call*. A run produces N
 *  commits. Tree views (recipe-run grouping, intent grouping) are
 *  computed queries over the flat commit log, not stored structures —
 *  "store atomic facts, derive aggregates" (spec § Commit substrate).
 *
 *  The Gateway writes a commit in two steps for crash-safety: a
 *  `'pending'` row BEFORE crossing the boundary, then an in-place
 *  transition to a terminal status once the outcome is observed (see
 *  `CommitStore` in `@recued/storage`). A commit left non-terminal by
 *  a crash is swept to `'in_doubt'` on the next boot — no auto-resume.
 *
 *  Unlike the redacted recipe-run audit row, a commit retains `args` +
 *  `output` un-redacted: save-as-Recipe (D-153 P8) parameterises `args`
 *  into a reusable template, and in_doubt-reconciliation UX needs the
 *  `output`. Any write-time redaction policy is a Gateway concern
 *  (slice 3b); the substrate shape carries the full values.
 *
 *  Spec: D-153 § Commit substrate (atomic). */
export interface Commit {
  /** UUID — the commit's stable identity, Gateway-generated when the
   *  `'pending'` row is written. */
  commit_id: string;
  /** Observable category — `'action'` / `'query'` / `'cognition_output'`.
   *  The Gateway derives it from the invoked ingredient/tool at dispatch
   *  time so audit consumers split the streams without re-deriving. */
  kind: CommitKind;
  /** Slug of the ingredient invoked. */
  ingredient: string;
  /** Tool name within the ingredient — D-153 ingredients expose
   *  multiple callable tools, so `(ingredient, tool)` together name the
   *  call. */
  tool: string;
  /** Inputs to the tool call. As wired in D-145 engine-wiring slice
   *  3b.3 the Gateway wraps the engine's ingredient-executor chokepoint
   *  — *above* the dispatch layer's manifest-default merge and
   *  `{{vault.*}}` / `{{config.*}}` ref resolution — so `args` is the
   *  recipe step's authored input: template refs intact, manifest
   *  defaults not merged. This is deliberate: it keeps `args`
   *  secret-free (no resolved `{{vault.*}}` ciphertext lands in the
   *  commit log, which is retained un-redacted) and parameterisable —
   *  save-as-Recipe (D-153 P8) reuses the refs as the template.
   *  Capturing the exact post-resolution payload *as actually
   *  dispatched* (which needs a redaction pass for the resolved
   *  secrets) is a Gateway-substrate follow-on. */
  args: Record<string, unknown>;
  // ────────────────────────────────────────────────────────────────
  // D-177 P1b — canonical action identity, stamped at canonicalization.
  // Computed from the RESOLVED-minus-vault payload (post-`{{config.*}}`/
  // `{{step.*}}`/`{{item.*}}`/`{{context.*}}` resolution, `{{vault.*}}`
  // refs left intact) — SIBLINGS of `args`, which deliberately stores
  // the UNRESOLVED template above; never a re-hash of it. Absent when
  // the Gateway has no hash resolver wired, or when the resolved
  // payload is not canonicalizable (`canonicalArgHash` fail-closed
  // throw) — an absent hash can never match a session grant (N.4), so
  // the degraded form holds for approval rather than over-matching.
  // ────────────────────────────────────────────────────────────────
  /** Hash of the resolved args' key skeleton (paths + JSON types,
   *  values erased) — the N.2 drift guard. Lowercase SHA-256 hex. */
  arg_shape_hash?: string;
  /** Hash of the resolved arg values after the op's `hash_exclude_args`
   *  volatile exclusions — the N.2 exact-repeat identity. Lowercase
   *  SHA-256 hex. */
  canonical_payload_hash?: string;
  /** Primary-entity binding when the op declares one (N.1). No op-level
   *  primary-entity declaration exists yet, so nothing stamps it today;
   *  the slot is the envelope's forward-compat anchor. */
  entity_scope?: string;
  /** The tool's return value. Absent on a `'pending'` row; populated by
   *  the Gateway at outcome capture (and only when the primitive
   *  produced a value). */
  output?: unknown;
  /** Lifecycle state — `'pending'` at write time, transitioning to a
   *  terminal status on outcome capture or to `'in_doubt'` via the
   *  crash-recovery sweep. */
  status: CommitStatus;
  /** The typed `(channel × actor)` source that dispatched this commit. */
  source: ExecutionSource;
  /** Resolved contract scope inlined at dispatch time. Required on
   *  every commit whose `source` carries a `contract_id` (D-161 N.4 — a
   *  `'contracted_user'`, or a self-restricted `'user_self'`); absent
   *  otherwise. The Gateway enforces this presence invariant at write
   *  time — `isCommit` validates the shape, not the invariant. */
  contract_snapshot?: ContractSnapshot;
  /** Channel-owned session boundary — the derived projection of
   *  `source` (engine `deriveChannelSessionId`). Indexed for "what
   *  happened in this channel session ever?" queries. */
  channel_session_id: string;
  /** Engine-assigned per cognition window. Undefined when no cognition
   *  component ran for this commit — cognition is pluggable +
   *  default-disabled (D-153 / D-145 §B.16). */
  cognition_session_id?: string;
  /** Engine-assigned per ~1-min intent burst — the unit save-as-Recipe
   *  operates on. */
  correlation_id: string;
  /** Set when this commit compensates a prior one (`schedule.delete`
   *  pointing at a prior `schedule.create`, etc.). Single-predecessor
   *  by design — N-to-1 compensation is deliberately unsupported.
   *  Distinct from `dispatch_depth`: this links *compensation*, not
   *  dispatch ancestry. */
  predecessor_commit_id?: string;
  /** Within-process dispatch-tree depth — `0` for a top-level commit;
   *  the Gateway sets each child to `parent + 1` and refuses dispatch
   *  past `MAX_DISPATCH_DEPTH`. The #22 loop-bounding primitive. */
  dispatch_depth: number;
  /** Gateway-generated UUID; passed to the tool's resume protocol as a
   *  dedup key when the external system supports one. */
  idempotency_key: string;
  /** Dispatch-time unix-ms — when the Gateway wrote the `'pending'`
   *  row, just before crossing the boundary. */
  dispatched_at: number;
  /** Outcome-capture unix-ms. Absent on a `'pending'` row, and on an
   *  `'in_doubt'` row produced by the crash-recovery sweep (the outcome
   *  — including its timing — was never observed). */
  completed_at?: number;
  /** `completed_at − dispatched_at` elapsed ms. Absent whenever
   *  `completed_at` is; the `CommitStore` derives it at outcome
   *  capture. */
  duration_ms?: number;
  // ────────────────────────────────────────────────────────────────
  // D-145 engine-wiring slice 3b.0 — execution-request linkage +
  // result provenance. The Gateway dispatch-outbox (slice 3b)
  // populates these; 3b.0 is contracts-only.
  // ────────────────────────────────────────────────────────────────
  /** FK to the execution-request anchor this commit belongs to — the
   *  `run_id` of the recipe-run `AuditEntry`. A recipe run dispatches N
   *  boundary-crossing tool calls → N commits, every one carrying that
   *  run's `request_id`. The recipe-run-grouping key: D-153 § Commit
   *  substrate calls recipe-run grouping "a computed query" but never
   *  names the key — `correlation_id` is the ~1-min intent burst, which
   *  spans runs. `request_id` is that key, and the join behind the
   *  "execution request including its steps" view + per-run retention.
   *  An atomic fact, not a stored tree. */
  request_id: string;
  /** `true` when the Gateway served this call's `output` from the L1 /
   *  L2 cache instead of crossing the boundary. Conditional-presence —
   *  omitted (never `false`) when the call really dispatched, matching
   *  the audit substrate's omit-when-falsy convention. Cache is a side
   *  effect of the call, never a log row of its own: the commit is
   *  written either way; `cached` records that the boundary was not
   *  actually crossed. */
  cached?: true;
  /** Optional per-kind facet slot — bounded metadata that is neither
   *  `args` (resolved inputs) nor `output` (return value): connection
   *  transport byte counts, mail `message_id`, etc. Forward-compat room
   *  for the per-call audit kinds commits progressively subsume
   *  (`connection_*` / `mail_send` / …; D-153 § Execution-request
   *  anchor). Absent for commits with no extra facets. */
  detail?: Record<string, unknown>;
}

/** Structural predicate — true when `value` matches the `Commit`
 *  shape. Validates field presence + primitive types + the nested
 *  `source` (`isExecutionSource`) and `contract_snapshot`
 *  (`isContractSnapshot`, when present). `output` is unconstrained
 *  (`unknown`) — the predicate does not inspect it; `detail`, when
 *  present, is shape-checked as a plain object but its contents are
 *  not; `cached`, when present, must be the literal `true`.
 *
 *  Structural only — it does NOT enforce write-time *coherence* rules
 *  (a `'pending'` row carrying no `output` / `completed_at`; a
 *  contract-scoped `source.actor` requiring `contract_snapshot`). Those
 *  are Gateway dispatch-time invariants (slice 3b), not shape
 *  constraints. The guard's job is to narrow untyped JSON read back
 *  from the commit store. */
export const isCommit = (value: unknown): value is Commit => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const nonEmpty = (x: unknown): x is string =>
    typeof x === 'string' && x.length > 0;
  const optString = (x: unknown): boolean =>
    x === undefined || typeof x === 'string';
  const finite = (x: unknown): x is number =>
    typeof x === 'number' && Number.isFinite(x);

  if (!nonEmpty(v.commit_id)) return false;
  if (!isCommitKind(v.kind)) return false;
  if (!nonEmpty(v.ingredient)) return false;
  if (!nonEmpty(v.tool)) return false;
  if (!v.args || typeof v.args !== 'object' || Array.isArray(v.args)) return false;
  // D-177 P1b — stamped action identity (optional; absent on degraded rows).
  if (!optString(v.arg_shape_hash)) return false;
  if (!optString(v.canonical_payload_hash)) return false;
  if (!optString(v.entity_scope)) return false;
  if (!isCommitStatus(v.status)) return false;
  if (!isExecutionSource(v.source)) return false;
  if (
    v.contract_snapshot !== undefined
    && !isContractSnapshot(v.contract_snapshot)
  ) {
    return false;
  }
  if (!nonEmpty(v.channel_session_id)) return false;
  if (!optString(v.cognition_session_id)) return false;
  if (!nonEmpty(v.correlation_id)) return false;
  if (!optString(v.predecessor_commit_id)) return false;
  if (
    typeof v.dispatch_depth !== 'number'
    || !Number.isInteger(v.dispatch_depth)
    || v.dispatch_depth < 0
  ) {
    return false;
  }
  if (!nonEmpty(v.idempotency_key)) return false;
  if (!finite(v.dispatched_at)) return false;
  if (v.completed_at !== undefined && !finite(v.completed_at)) return false;
  if (v.duration_ms !== undefined && !finite(v.duration_ms)) return false;
  // D-145 slice 3b.0 — execution-request linkage + result provenance.
  if (!nonEmpty(v.request_id)) return false;
  if (v.cached !== undefined && v.cached !== true) return false;
  if (
    v.detail !== undefined
    && (typeof v.detail !== 'object'
      || v.detail === null
      || Array.isArray(v.detail))
  ) {
    return false;
  }
  return true;
};
