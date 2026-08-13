/** D-145 PA1 — Source primitive types.
 *
 *  Per § A.2. A Source is a named entity provider for a top_tier_kind.
 *  Each kind has N Sources at any time (Recued built-in + per-
 *  connection + future adapter-derived + future dish-derived). PA1
 *  lays the registration shape + table; PA2 wires the resolver +
 *  default-Source memory + connection-Source auto-register.
 *
 *  Spec: D-145 § A.2. */

import {
  WORK_ENTITY_KINDS,
  WORK_ENTITY_KIND_SET,
  type WorkEntityKind,
} from './work-entities.js';

/** Source-able top tier kinds — superset of `WorkEntityKind` because
 *  § A.2.1 enumerates `mail_message` / `calendar.event` / `contact` as
 *  shapes the Source registry can carry. PA1 ships the four work
 *  entities; the broader set lands as related substrate fully wires up
 *  in later phases. `file` (D-192 file SOURCE family) is a `file_meta_ref`
 *  posture kind — populated by per-vendor meta adapters, never a reception
 *  write path (it follows the `mail_message` arm, not `contact`);
 *  D-192. */
export const SOURCE_TOP_TIER_KINDS = [
  ...WORK_ENTITY_KINDS,
  'mail_message',
  'calendar.event',
  'contact',
  'file',
] as const;
export type SourceTopTierKind = (typeof SOURCE_TOP_TIER_KINDS)[number];
export const SOURCE_TOP_TIER_KIND_SET: ReadonlySet<SourceTopTierKind> = new Set(
  SOURCE_TOP_TIER_KINDS,
);

/** Where a Source comes from. */
export const SOURCE_KINDS = ['builtin', 'connection', 'adapter', 'dish'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SOURCE_KIND_SET: ReadonlySet<SourceKind> = new Set(SOURCE_KINDS);

/** D-192 P-1 — how a Source syncs into the warehouse (the posture). A
 *  single shape can carry two postures (a Notion page as a note-record
 *  vs a document-meta-ref), so the spine dispatches on posture, not the
 *  shape. `records` = the full-walk reconcile every Source built today
 *  uses (mail / calendar / CRM work-entities); `file_meta_ref` = list
 *  metadata + `storage_ref:'remote'` without fetching bodies during sync
 *  (explicit reads resolve lazily); `contact_import` = scoped import into `data.contact`
 *  via D-138 merge. Taxonomy D-192 § 2 +
 *  `read_through` = no warehouse materialization at all: generic reads
 *  invoke the declared Source on demand and return transient, Source-qualified
 *  entities; D-192. */
export const SOURCE_SYNC_POSTURES = [
  'records',
  'read_through',
  'file_meta_ref',
  'contact_import',
] as const;
export type SourceSyncPosture = (typeof SOURCE_SYNC_POSTURES)[number];
export const SOURCE_SYNC_POSTURE_SET: ReadonlySet<SourceSyncPosture> = new Set(
  SOURCE_SYNC_POSTURES,
);

/** Substrate-shipped Recued built-in Source id format —
 *  `recued.<kind>`. PA2 auto-registers one row per kind on first server
 *  init. */
export const RECUED_BUILTIN_SOURCE_ID = (kind: SourceTopTierKind): string =>
  `recued.${kind}`;

/** Connection-derived Source id format — `<vendor>.<connection_id>.<kind>`.
 *  Examples: `hubspot.<conn_id>.task` / `salesforce.<conn_id>.task`.
 *  PA2 auto-registers when D-129 / D-130 connection is enrolled with
 *  task-capable scope. */
export const CONNECTION_SOURCE_ID = (
  vendor: string,
  connection_id: string,
  kind: SourceTopTierKind,
): string => `${vendor}.${connection_id}.${kind}`;

export interface SourceRegistration {
  id: string;
  top_tier_kind: SourceTopTierKind;
  source_kind: SourceKind;
  /** D-192 P-1 — how this Source is read/materialized (the posture). Optional in the
   *  type so callers that pre-date P-1 keep working; the store coerces
   *  `undefined → 'records'` at write time. `read_through` deliberately
   *  persists no canonical rows; generic reads invoke its declaration live.
   *  Structural pack policy, not a user toggle. Taxonomy § 2. */
  sync_posture?: SourceSyncPosture;
  source_label: string;
  write_capable: boolean;
  mcp_exposed: boolean;
  /** D-145 PA11 — Settings → Work Entities user toggle. Disabled
   *  Sources are excluded from polymorphic `data.<kind>.*` reads + the
   *  page-header dropdown's concrete-Source list (the All-Sources
   *  sentinel still resolves; it just walks fewer Sources). Disabled
   *  Sources continue to receive reconciler updates so re-enabling
   *  doesn't strand rows behind a stale cursor. Default `true` —
   *  every Source registers enabled; users opt out per Source via
   *  Settings. Optional in the type so callers that pre-date PA11
   *  (e.g. `registerSource({ enabled: undefined })`) keep working;
   *  the store coerces `undefined → true` at write time. */
  enabled?: boolean;
  schema_extension_blob?: Record<string, unknown>;
  registered_at: number;
  config_blob?: Record<string, unknown>;
}

export const isSourceTopTierKind = (v: unknown): v is SourceTopTierKind =>
  typeof v === 'string' && SOURCE_TOP_TIER_KIND_SET.has(v as SourceTopTierKind);

export const isSourceKind = (v: unknown): v is SourceKind =>
  typeof v === 'string' && SOURCE_KIND_SET.has(v as SourceKind);

export const isSourceSyncPosture = (v: unknown): v is SourceSyncPosture =>
  typeof v === 'string' && SOURCE_SYNC_POSTURE_SET.has(v as SourceSyncPosture);

/** ⚠ Derived from `WORK_ENTITY_KIND_SET`, never re-spelled. This
 *  predicate used to hand-copy the four kinds — and because
 *  `SourceTopTierKind` SPREADS `WORK_ENTITY_KINDS` (line 22), a fifth
 *  kind widened the parameter type while the body kept answering
 *  `false`: a type predicate that compiles clean and lies at runtime.
 *  It is the gate that routes `runReceptionProjection` into the
 *  work-entity arm, so the lie surfaced as "not locally
 *  materializable" with no compile error anywhere. Keep it a set
 *  lookup. */
export const isWorkEntitySourceKind = (v: SourceTopTierKind): v is WorkEntityKind =>
  WORK_ENTITY_KIND_SET.has(v as WorkEntityKind);

// ════════════════════════════════════════════════════════════════
// D-232 § 21 — one failure vocabulary for remote work
// ════════════════════════════════════════════════════════════════

/** WHY a remote leg did not produce an answer, in the four terms a caller can
 *  actually act on.
 *
 *  ⛔⛔ THE POINT IS THE DECISION IT ENABLES, NOT THE LABEL. A bare
 *  `succeeded | failed` tells a caller that something went wrong and nothing
 *  about what to do next, so every failure gets the same treatment: usually a
 *  retry, which for three of these four is either useless or harmful.
 *
 *  - `config`      — the far side is not wired for this (no such operation, no
 *                    profile, no result path). Retrying NEVER helps; a human
 *                    has to change something.
 *  - `policy`      — the far side refused you: not granted, approval denied,
 *                    outside the contract. Retrying is useless until the OWNER
 *                    acts, and hammering it is indistinguishable from probing.
 *  - `unavailable` — nobody answered: unreachable, timed out, down. The ONLY
 *                    one of the four where retrying later is the right move,
 *                    which is precisely why it must not be lumped in with the
 *                    others.
 *  - `error`       — it was reached, understood the ask, and broke. A human may
 *                    decide a retry is worth it; a machine must not assume so
 *                    (see {@link isRetryableRemoteFailure}).
 *
 *  🔑 SHARED ON PURPOSE, and lifted here to be shareable. This vocabulary was
 *  invented by the SYNCHRONOUS read-through path (`work.search` fans out to N
 *  Sources and reports each failure as `{source_id, kind, reason}`), which is
 *  the same question an ASYNCHRONOUS exchange asks one hop later. Two
 *  vocabularies for one question would mean a caller has to learn which layer
 *  answered before it can read the answer. It lives in contracts because
 *  `packages/` can never import from `backend/` — the engine's exchange payload
 *  and the server's read tools both need it, and only contracts is reachable
 *  from both. */
export type RemoteFailureKind = 'config' | 'policy' | 'unavailable' | 'error';

export const REMOTE_FAILURE_KINDS: readonly RemoteFailureKind[] = Object.freeze([
  'config',
  'policy',
  'unavailable',
  'error',
]);

const REMOTE_FAILURE_KIND_SET: ReadonlySet<string> = new Set(REMOTE_FAILURE_KINDS);

export const isRemoteFailureKind = (v: unknown): v is RemoteFailureKind =>
  typeof v === 'string' && REMOTE_FAILURE_KIND_SET.has(v);

/** Is retrying this failure, UNCHANGED AND UNATTENDED, safe and capable of a
 *  different result?
 *
 *  ⚠ `unavailable` ONLY, and the exclusion of `error` is deliberate rather than
 *  pessimistic: `error` covers `ACTION_DELIVERY_UNCERTAIN`, where the write may
 *  ALREADY HAVE COMMITTED and the acknowledgement was lost. Auto-retrying that
 *  duplicates it. A human looking at the reason can still choose to retry — this
 *  answers what an unattended caller may do on its own.
 *
 *  Encoded here rather than left to each caller because "which of these should I
 *  retry" is the whole reason the classification exists, and a caller made to
 *  re-derive it will eventually get it wrong in the expensive direction. */
export const isRetryableRemoteFailure = (kind: RemoteFailureKind): boolean =>
  kind === 'unavailable';

/** D-232 § 19.3 — the engine-derived receipt a fire hands back: not an answer,
 *  a handle, plus whether the letter actually went.
 *
 *  🔑 IT LIVES HERE, BESIDE {@link RemoteFailureKind}, FOR THE SAME REASON THAT
 *  TYPE DOES — and § 30 is what forced the move. It began in the engine, whose
 *  fire point derives it. But it is now ALSO: the shape a receiver puts on the
 *  wire, the shape an asker validates OFF the wire, a field on a stored audit
 *  row, and an input to `deriveExchangeStatus` below. `packages/storage` cannot
 *  import the engine and `packages/` can never import `backend/`, so contracts
 *  is the only place all four reach. `@recued/engine` re-exports it, so every
 *  existing import still resolves.
 *
 *  ⛔⛔ THE FIELDS ARE A WIRE CONTRACT NOW, AND THAT IS A REAL PROMOTION. Until
 *  § 30 this crossed servers only as prose inside a MODEL-FACING projection
 *  (`projectRunResultForAgent`), whose strings are tuned against
 *  `chat-prompt-optimization-log.md`. Binding two servers to that would make a
 *  prompt tuning a protocol break — and it was already lossy in the way that
 *  mattered: the projection dropped `retrying`, the one field telling an asker
 *  whether to wait or give up. An LLM did not need it, so the LLM-shaped copy
 *  threw it away. */
export interface ExchangeAcknowledgement {
  readonly ref: string;
  readonly callback_op?: string;
  /** Did the letter GO? ⚠ Was `true` by construction, which conflated two
   *  different things and cost the caller the more useful one. */
  readonly accepted: boolean;
  /** Present iff `accepted === false` — why not, in the § 21 vocabulary. */
  readonly kind?: RemoteFailureKind;
  readonly reason?: string;
  /** Whether the § 24 sweep will try again on the caller's behalf. ⚠ Derived
   *  from `kind`, not asserted separately: only `unavailable` is retryable, and
   *  a second source for that answer is a second thing to get wrong. */
  readonly retrying?: boolean;
}

/** ⚠ A PEER'S `reason` IS PEER-SUPPLIED TEXT that lands in an audit row and a
 *  status surface. Capped for the same reason `mcpToolErrorDetail` caps its
 *  own: a verbose or hostile correspondent is otherwise unbounded. */
export const EXCHANGE_PEER_REASON_MAX = 600;

/** Validate an acknowledgement that arrived OFF THE WIRE.
 *
 *  ⛔⛔ NOT A CAST, AND NOT A SPREAD. Everything here was written by another
 *  server. The posture is the one `declaredFailKind` already takes inside the
 *  classifier: re-validate rather than trust, and admit only the closed
 *  vocabulary — a `kind` outside {@link REMOTE_FAILURE_KINDS} is DROPPED, not
 *  passed through, so a peer cannot invent a classification this side branches
 *  on. Returns `undefined` when the shape is not an acknowledgement at all,
 *  which is the overwhelmingly common case (every non-exchange tool result).
 *
 *  ⚠ `retrying` IS DELIBERATELY NOT RE-DERIVED FROM `kind` HERE. It is the
 *  PEER's statement about the PEER's own sweep — their policy, their bound, on
 *  their server — and recomputing it locally would silently overwrite what they
 *  said with what we would have done. It is carried verbatim as a boolean. */
export const parsePeerExchangeAck = (v: unknown): ExchangeAcknowledgement | undefined => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;
  if (typeof raw.ref !== 'string' || raw.ref === '') return undefined;
  if (typeof raw.accepted !== 'boolean') return undefined;
  const reason = typeof raw.reason === 'string' && raw.reason !== ''
    ? raw.reason.slice(0, EXCHANGE_PEER_REASON_MAX)
    : undefined;
  return {
    ref: raw.ref,
    accepted: raw.accepted,
    ...(typeof raw.callback_op === 'string' && raw.callback_op !== ''
      ? { callback_op: raw.callback_op }
      : {}),
    ...(isRemoteFailureKind(raw.kind) ? { kind: raw.kind } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(typeof raw.retrying === 'boolean' ? { retrying: raw.retrying } : {}),
  };
};

// ════════════════════════════════════════════════════════════════
// D-232 § 23 — what happened to my letter
// ════════════════════════════════════════════════════════════════

/** The DELIVERY state of an exchange, as distinct from its ANSWER.
 *
 *  ⛔⛔ THE ASKER COULD NOT ASK. `output.exchange` hands back a ref and the ref
 *  addressed nothing from recipe-land: `listByExchangeRef` existed in storage and
 *  was wired only to the AI door's `recued_getAudit`, so a model could ask what
 *  happened to an exchange and the recipe that started it could not.
 *
 *  ⛔ AND `awaiting` VS `undeliverable` WAS UNANSWERABLE EVEN THEN. A ref with no
 *  answer looked identical to one still in flight — the same silence D-232 § 19.4
 *  forbids ("undeliverable beats a swallowed letter"), relocated one level up
 *  from the message to the conversation.
 *
 *  🔑 DERIVED, NOT STORED. Every input already exists in the audit trail, so this
 *  adds no state to keep consistent — and a state machine that can drift from the
 *  runs it describes is worse than a projection that cannot. If deriving proves
 *  insufficient, THEN store. */
export type ExchangeDeliveryStatus =
  /** No run filed under this ref at all. Either the ref is wrong, or the fire
   *  never happened — deliberately not distinguished, because from the caller's
   *  side they are the same fact: nothing was sent. */
  | 'unknown'
  /** The carrier run failed: the message did not reach the peer. */
  | 'undeliverable'
  /** D-232 § 30 — DELIVERED, AND THE PEER HAS TOLD US THEY CANNOT REPLY. Their
   *  receipt came back on the carrier's own tool result: `accepted: false`.
   *
   *  ⛔⛔ THIS IS NOT `undeliverable`, AND REUSING THAT NAME WOULD HAVE ARMED A
   *  RETRY THAT MUST NOT FIRE. Our letter ARRIVED — the peer received it and ran
   *  their receiver; it is their ANSWER that could not leave THEIR server. So:
   *  (a) `undeliverable` would be false, our message was delivered; and
   *  (b) {@link planExchangeRetry} retries exactly `undeliverable` with a
   *  retryable kind, and a peer whose outbound is down reports `unavailable` —
   *  so overloading the name would re-send OUR ask because THEIR reply failed.
   *  That neither fixes their route nor is harmless: it makes the peer act twice
   *  on one request, which is the precise thing that function's rule 2 exists to
   *  prevent.
   *
   *  🔑 NAMING THE STATE HONESTLY IS WHAT MAKES THE FENCE FREE. `planExchangeRetry`
   *  needs no new guard — its existing `status !== 'undeliverable'` refusal
   *  already covers this, and says why. Same lesson as `deliver_to` vs
   *  `callback_op`: two meanings that coincide in the first case you build are
   *  still two meanings. */
  | 'unanswerable'
  /** Sent, and nothing has come back yet. ⚠ NOT a failure — the peer's owner may
   *  legitimately take days. It is the state an exchange spends most of its life
   *  in, which is exactly why it must be nameable. */
  | 'awaiting'
  /** The far side answered: a run for the callback landed under this ref. */
  | 'answered';

export interface ExchangeStatusRow {
  readonly recipe_id: string;
  /** A terminal run status — `'succeeded'` / `'failed'` / anything else. */
  readonly status: string;
  readonly errors?: readonly unknown[];
  /** D-232 § 30 — what the PEER said on this run's own tool result. Present on
   *  a carrier run whose synchronous response carried an acknowledgement.
   *
   *  ⚠ The peer's receipt, not ours: `ExecutionResult.exchange_ack` is what WE
   *  handed our caller ("I posted it"), this is what THEY handed us ("I got it
   *  and here is what happened to my reply"). Both are filed under one ref by
   *  design, so they must not share a field. */
  readonly peer_ack?: ExchangeAcknowledgement;
}

export interface ExchangeStatusReport {
  readonly ref: string;
  readonly status: ExchangeDeliveryStatus;
  /** Present when `undeliverable` (OUR classification of the carrier's failure)
   *  or `unanswerable` (§ 30 — the PEER's classification of theirs, carried
   *  verbatim) — either way, in the one § 21 vocabulary. ⚠ Optional on
   *  `unanswerable` in a way it is not on `undeliverable`: a peer may report a
   *  refusal without a kind, and inventing one for them would be this side
   *  guessing at the far side's cause. */
  readonly kind?: RemoteFailureKind;
  readonly reason?: string;
  /** Runs filed under the ref, for a caller that wants the detail. */
  readonly runs: number;
}

/** The carrier recipe the host dispatches a fire through. ⚠ Kernel plumbing, so
 *  it is never the ANSWER — a run of it under a ref means the letter was posted,
 *  not that it was replied to. */
const EXCHANGE_CARRIER_RECIPE_ID = 'run-ingredient';

/** Fold the runs filed under one ref into a delivery status.
 *
 *  ⚠ `callbackRecipeId` is what makes `answered` distinguishable from `awaiting`,
 *  and it must be the CALLBACK's recipe id — not merely "some other run". Both
 *  servers file under the same ref, so on the ASKER's server the runs include her
 *  own asking recipe and her own carrier; counting any of those as an answer
 *  would report every exchange answered the moment it was sent. */
export const deriveExchangeStatus = (
  ref: string,
  rows: readonly ExchangeStatusRow[],
  callbackRecipeId: string | undefined,
  classify: (errors: readonly unknown[]) => { kind: RemoteFailureKind; reason: string },
): ExchangeStatusReport => {
  if (rows.length === 0) return { ref, status: 'unknown', runs: 0 };

  // ⛔⛔ ACCEPT EITHER VOCABULARY, BECAUSE THE CALLER HAS THE OTHER ONE. A caller
  // naturally passes the `callback_op` they wrote in `output.exchange` — the
  // WIRE NAME, `<publisher>/<recipe_id>` — while audit rows carry the bare
  // `recipe_id`. Comparing them raw silently reports `awaiting` for an exchange
  // that was answered, which is the worst shape available here: it looks like
  // patience is warranted when the answer already arrived. Caught by a recipe
  // calling this for real; every earlier test had passed the bare id because I
  // wrote both sides.
  const callbackId = callbackRecipeId === undefined
    ? undefined
    : callbackRecipeId.slice(callbackRecipeId.indexOf('/') + 1);
  if (
    callbackId !== undefined
    && rows.some((r) => r.recipe_id === callbackId && r.status === 'succeeded')
  ) {
    return { ref, status: 'answered', runs: rows.length };
  }

  // ⛔ ONLY THE CARRIER'S FAILURE IS AN UNDELIVERABLE. The DECLARING run can fail
  // for its own reasons while the letter still went — a fire happens after the
  // run terminates, and § 19.4 fires a FAILED run's answer deliberately. Reading
  // any failure as undeliverable would report a delivered refusal as a lost one.
  const carrier = rows.find((r) => r.recipe_id === EXCHANGE_CARRIER_RECIPE_ID);
  if (carrier !== undefined && carrier.status === 'failed') {
    const { kind, reason } = classify(carrier.errors ?? []);
    return { ref, status: 'undeliverable', kind, reason, runs: rows.length };
  }

  // D-232 § 30 — THE PEER'S OWN VERDICT, WHICH USED TO REACH US AND STOP HERE.
  // A carrier that SUCCEEDED still returns a synchronous tool result, and when
  // the peer's answer could not leave their server that result says so. Nothing
  // read it: every classifier on the inbound path keys on `isError` / a JSON-RPC
  // error envelope, and a receiver reporting its own failure sets neither — the
  // agent-facing projection is deliberately never an error, so a model does not
  // read it as one and loop. Correct for an LLM; invisible to a machine. So the
  // fact arrived, was dropped, and this function fell through to `awaiting` for
  // an exchange that would never be answered.
  //
  // ⚠ AFTER the carrier check, because "my letter never went" outranks "their
  // reply never went": the first is the more fundamental failure and is the one
  // a retry can actually fix.
  const refused = rows.find((r) => r.peer_ack !== undefined && !r.peer_ack.accepted);
  if (refused?.peer_ack !== undefined) {
    const { kind, reason } = refused.peer_ack;
    return {
      ref,
      status: 'unanswerable',
      ...(kind !== undefined ? { kind } : {}),
      ...(reason !== undefined ? { reason } : {}),
      runs: rows.length,
    };
  }

  return { ref, status: 'awaiting', runs: rows.length };
};

// ════════════════════════════════════════════════════════════════
// D-232 § 24 — retry, and the four times you must not
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// D-234 § 234.2 — is this inbound call a REPLY I asked for?
// ════════════════════════════════════════════════════════════════

/** One run already filed under an exchange ref, as the correlation check sees it. */
export interface ExchangeCorrelationRow {
  readonly recipe_id: string;
  /** The contract the run was executed under, when it had one. Absent for the
   *  owner's own runs — which is exactly the signal that WE opened this. */
  readonly contract_id?: string;
  /** D-234 § 234.2 — where the run that opened the exchange said to answer, as
   *  the WIRE NAME (`<publisher>/<recipe_id>`). */
  readonly callback_op?: string;
}

/** Should an inbound peer call be admitted as a REPLY we solicited?
 *
 *  ⛔⛔ THE ASYMMETRY THIS ENCODES: UNSOLICITED FACES THE CEILING, SOLICITED IS
 *  ADMITTED BY OUR OWN RECORD OF HAVING SOLICITED IT. Asking the owner "do you
 *  want the answer you asked for?" is both absurd and dangerous — it lets a
 *  server starve its own conversations, and § 19.4 already calls silence the
 *  worst outcome for a correspondent. But blind trust is worse: a landing recipe
 *  does real work (in the review case, it is where the mail is actually SENT), so
 *  "it claims to be a reply" cannot be enough.
 *
 *  🔑 THE PEER'S REF IS A LOOKUP KEY, NEVER A CREDENTIAL. `exchange_ref` is
 *  caller-supplied — it rides in `EXCHANGE_ENVELOPE_KEYS` precisely so it can
 *  round-trip. Authority here comes from OUR OWN ROWS: a ref we never opened
 *  finds nothing and falls straight through to the ceiling. Same posture as
 *  § 30's peer ack (peer-supplied, validated, used as data).
 *
 *  🔑 CORRELATION ADMITS; IT NEVER AUTHORIZES. The reply still runs under the
 *  peer's contract, so their grants still fence what the landing recipe may do.
 *  This answers only "did I ask for this?" — the same line the container pick
 *  draws when it says the pick DISAMBIGUATES but never AUTHORIZES.
 *
 *  Four conditions, and the last two are what keep it narrow:
 *   1. the ref names an exchange we have rows for;
 *   2. at least one of those rows is OURS (not run under the calling peer's
 *      contract) — otherwise a peer who merely called us once could later cite
 *      their own inbound run as evidence that we solicited them;
 *   3. the recipe being invoked is the one we NAMED as `callback_op`. ⛔ Without
 *      this the admission is far too wide: a peer holding any ref we opened could
 *      skip the entry ask for ANY recipe their contract reaches;
 *   4. that recipe has not already run under this ref — one solicitation admits
 *      one reply, so a replayed answer faces the ceiling like anything else. */
export const isSolicitedReply = (
  rows: readonly ExchangeCorrelationRow[],
  input: { recipe_id: string; caller_contract_id: string },
): boolean => {
  if (rows.length === 0) return false;
  // (2) — evidence that WE participated, not merely that they called.
  if (!rows.some((r) => r.contract_id !== input.caller_contract_id)) return false;
  // (4) — one solicitation, one reply.
  if (rows.some((r) => r.recipe_id === input.recipe_id)) return false;
  // (3) — and it must be where we said to answer. ⚠ Accept either spelling: the
  // stamp is the WIRE NAME a recipe authors, audit rows carry the bare id. The
  // same normalization `deriveExchangeStatus` needed, for the same reason —
  // comparing them raw silently answers "no" for a correct reply.
  return rows.some((r) => {
    const declared = r.callback_op;
    if (declared === undefined || declared === '') return false;
    return declared.slice(declared.indexOf('/') + 1) === input.recipe_id
      || declared === input.recipe_id;
  });
};

/** ⚠ THE WHOLE POLICY, IN ONE PLACE, BECAUSE A CALLER MADE TO RE-DERIVE IT WILL
 *  EVENTUALLY GET IT WRONG IN THE EXPENSIVE DIRECTION. */
export const EXCHANGE_RETRY_MAX_ATTEMPTS = 4;
export const EXCHANGE_RETRY_BASE_MS = 60_000;

/** ⚠ DEV-ONLY backoff override, same reason as the interval one: the end-to-end
 *  path cannot be observed at production timings inside a test. Read once, at
 *  module load, so nothing can flip the policy mid-run. */
const BACKOFF_BASE_MS = ((): number => {
  const raw = Number(globalThis.process?.env?.RECUED_EXCHANGE_RETRY_BASE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : EXCHANGE_RETRY_BASE_MS;
})();

export interface ExchangeRetryRow extends ExchangeStatusRow {
  /** When this run finished. Attempts are ordered and spaced by it. */
  readonly at: number;
  /** The carrier run's own inputs — the fire args. ⚠ This is what makes a retry
   *  possible WITHOUT new storage: the payload to re-send is already recorded. */
  readonly config?: Record<string, unknown>;
}

export type ExchangeRetryPlan =
  | { readonly retry: false; readonly reason: string }
  | {
      readonly retry: true;
      readonly attempt: number;
      readonly not_before: number;
      readonly args: Record<string, unknown>;
    };

/** Should this exchange be re-sent, and when?
 *
 *  ⛔⛔ RETRY IS THE ONE PIECE OF THIS FEATURE THAT CAN CAUSE HARM BY WORKING.
 *  Every other part reports; this one ACTS, and the act is "send it again". So
 *  the interesting content is the refusals, not the permission:
 *
 *  1. ⛔ ONLY `unavailable`. `config` never succeeds, `policy` needs the OWNER
 *     rather than another attempt, and `error` may have ALREADY COMMITTED
 *     (`ACTION_DELIVERY_UNCERTAIN`). Retrying any of the three is between
 *     useless and a duplicate write. This is `isRetryableRemoteFailure`, and it
 *     is asked here rather than re-implemented.
 *  2. ⛔ NEVER ONCE ANSWERED. An answer that arrived after a failed carrier
 *     means an earlier attempt DID land; re-sending would ask a peer to act
 *     twice on one request. § 23 already computes this, so it is read, not
 *     guessed.
 *  3. ⛔ BOUNDED. Four attempts. A peer that is down for a week must not be
 *     knocked on forever — the traffic lands on THEIR server, and an unbounded
 *     retry against an unreachable host is indistinguishable from probing it.
 *  4. ⛔ SPACED, exponentially, from the LAST attempt. Retrying a dead peer
 *     every tick is the same hammering with extra steps.
 *
 *  🔑 ATTEMPTS ARE COUNTED FROM THE TRAIL, NOT STORED. Every attempt is already
 *  a carrier run filed under the ref, so the audit log IS the outbox — no second
 *  record to drift from the runs it describes, and the idempotency key
 *  (`exchange_ref`) is on every attempt by construction. */
export const planExchangeRetry = (
  ref: string,
  rows: readonly ExchangeRetryRow[],
  callbackRecipeId: string | undefined,
  classify: (errors: readonly unknown[]) => { kind: RemoteFailureKind; reason: string },
  now: number,
): ExchangeRetryPlan => {
  const status = deriveExchangeStatus(ref, rows, callbackRecipeId, classify);
  if (status.status !== 'undeliverable') {
    // Covers rule 2 (`answered`) and the ordinary in-flight case in one read.
    //
    // ⛔ AND, SINCE § 30, RULE 5 FOR FREE: `unanswerable` — the peer HAS our
    // message and cannot reply — lands here too. Re-sending would not fix their
    // outbound route and WOULD make them act twice on one request. This costs no
    // new guard only because that state is not called `undeliverable`; see the
    // note on `ExchangeDeliveryStatus['unanswerable']` for why the honest name
    // is what closes the hole.
    return { retry: false, reason: `status is '${status.status}', not 'undeliverable'` };
  }
  if (status.kind === undefined || !isRetryableRemoteFailure(status.kind)) {
    return { retry: false, reason: `'${String(status.kind)}' is not retryable` };
  }

  const carriers = rows
    .filter((r) => r.recipe_id === EXCHANGE_CARRIER_RECIPE_ID)
    .sort((a, b) => a.at - b.at);
  const attempt = carriers.length;
  if (attempt >= EXCHANGE_RETRY_MAX_ATTEMPTS) {
    return { retry: false, reason: `${String(attempt)} attempts is the ceiling` };
  }

  const last = carriers[carriers.length - 1];
  // ⚠ Exponential from the LAST attempt, not the first: a peer down for an hour
  // should be knocked on less often as time passes, not more.
  const not_before = (last?.at ?? now) + BACKOFF_BASE_MS * 2 ** (attempt - 1);
  if (now < not_before) {
    return { retry: false, reason: `backoff until ${String(not_before)}` };
  }

  // ⛔ THE PAYLOAD COMES FROM THE ATTEMPT THAT FAILED, so a retry re-sends what
  // was actually sent. Rebuilding it from anywhere else would risk sending
  // something subtly different under a ref the peer may already have seen.
  const args = last?.config;
  if (args === undefined || Object.keys(args).length === 0) {
    return { retry: false, reason: 'the failed attempt recorded no args to re-send' };
  }
  return { retry: true, attempt: attempt + 1, not_before, args };
};
