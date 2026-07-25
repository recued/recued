/** D-192 messenger flagship M4 — the message→proposal funnel.
 *
 *  The messenger analog of the email flagship's E3 funnel: an inbound chat
 *  message that MATCHES the connection's declared patterns (M2's
 *  `matchMessage`) is captured as a single immutable `message`
 *  COMMITMENT_EVIDENCE_KIND snapshot and routed through the SAME
 *  `commitment-propose` gate the F1 CRM next-step showcase + the E3 mail
 *  funnel use → the D-173 inbox → owner approves → a canonical
 *  `data_commitment` (`derivation: 'evidence_captured'` + a `message`
 *  evidence blob). One approval funnel, one canonical commitment truth.
 *
 *  Deliberate REUSE of the F1 proposal surface (no new inbox plumbing): each
 *  fire holds on the F1 synthetic proposal recipe
 *  (`COMMITMENT_EVIDENCE_PROPOSAL_RECIPE`, whose single op-step is the
 *  `commitment-propose` slug that rides the all-actor approval lift) and
 *  carries the F1 provenance pair (`source_recipe` / `event_kind`), so the
 *  D-173 inbox origin filter, source-kind recovery, and approve-with-editable-
 *  args allowlist all apply UNCHANGED — the minted commitment's
 *  `evidence_blob[].kind: 'message'` is what distinguishes the messenger funnel
 *  from the mail / crm_field funnels at the data layer.
 *
 *  Dedup is on the message identity (`message_id` = the bus `record_id`) via
 *  the durable `message-commitment-ledger.ts` — a redelivered webhook, a
 *  message matching several patterns, or a re-processing listener never
 *  re-floods the inbox, and a DECLINED proposal never re-proposes. The claim
 *  happens BEFORE the fire (both-halves-up-first): a hard dispatch failure
 *  releases the claim so a redelivery re-proposes.
 *
 *  Direction defaults `inbound` (a received message states/promises something
 *  TO us — the messenger bus is inbound-only, so the sender IS the
 *  counterparty; there is no actor-vs-subject flip). M3 resolves that sender:
 *  the `(vendor, actor_platform_id)` pair is mapped through the D-138
 *  `contact_platform_link` table (`resolveMessageCommitmentActor`) → the
 *  sender's canonical email, which lands BOTH on the evidence entry
 *  (`actor_contact_id`) AND as the proposal's `counterparty_contact_id`. An
 *  unlinked sender stays an opaque `actor_platform_id` and the counterparty
 *  defaults EMPTY — the owner fills it at approval (the F1 nullable posture).
 *  Deterministic capture (no AI, no `confidence` on the entry — the match
 *  itself is the proof; an AI-paraphrase layer, if added, sits ABOVE this
 *  funnel).
 *
 *  Spec: D-192 § 3a (M-1). */

import {
  COMMITMENT_MESSAGE_EVIDENCE_SNIPPET_MAX,
  COMMITMENT_STATEMENT_MAX,
  matchMessage,
  type CommitmentDirection,
  type CommitmentMessageEvidence,
  type ExecutionSource,
  type MessageMatchPattern,
  type MessageProjection,
  type RecipeDefinition,
} from '@recued/contracts';

import {
  COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND,
  COMMITMENT_EVIDENCE_PROPOSAL_RECIPE,
  COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID,
  type FireCommitmentEvidenceProposal,
} from './commitment-evidence-capture.js';
import type { MessageCommitmentLedger } from './storage/message-commitment-ledger.js';

/** A received chat message states/promises something TO us by default. */
const DEFAULT_MESSAGE_COMMITMENT_DIRECTION: CommitmentDirection = 'inbound';

// ────────────────────────────────────────────────────────────────
// M3 — the `messenger_sender_contact` actor/counterparty resolver
// ────────────────────────────────────────────────────────────────

export interface MessageCommitmentActorInput {
  /** The messenger vendor slug (`slack` / `telegram` / …). */
  vendor: string;
  /** The sender's platform-native id (`ParsedInbound.from`). */
  actor_platform_id: string;
  /** D-138 `(vendor, platform_id) → canonical_email` link lookup
   *  (`contactStore.lookupPlatformLink`). Absent / throwing / no link ⇒ the
   *  sender stays unresolved. */
  lookupPlatformLink?: (vendor: string, platform_id: string) => string | null | undefined;
  /** D-138 canonical resolver
   *  (`contactStore.resolveCanonicalEmail(email).canonical_email`). Absent /
   *  throwing (malformed email / corrupt merge chain) ⇒ unresolved. */
  resolveCanonical?: (email: string) => string | undefined;
}

export interface MessageCommitmentActor {
  /** The resolved sender's D-138 canonical email — set ONLY when the
   *  `(vendor, platform_id)` link resolves to a canonical contact. */
  actor_contact_id?: string;
}

/** Resolve an inbound matched message's sender to a Recued contact (M3 —
 *  the `messenger_sender_contact` strategy). The messenger bus is
 *  inbound-only, so the sender IS the counterparty; this maps the
 *  `(vendor, actor_platform_id)` pair through the D-138
 *  `contact_platform_link` table → the sender's D-138 canonical email —
 *  the SAME `lookupPlatformLink` → `resolveCanonicalEmail` walk F1's
 *  `record_contact_edges` applies to a `remote_id` edge. FAIL-CLOSED:
 *  every missing dep, blank vendor/id, missing link, throwing lookup, or
 *  empty canonical yields an unresolved actor (`{}`) — the owner fills the
 *  counterparty at approval (the F1 nullable posture). Pure. */
export const resolveMessageCommitmentActor = (
  input: MessageCommitmentActorInput,
): MessageCommitmentActor => {
  if (input.lookupPlatformLink === undefined || input.resolveCanonical === undefined) return {};
  const vendor = input.vendor.trim();
  const platform_id = input.actor_platform_id.trim();
  if (vendor.length === 0 || platform_id.length === 0) return {};
  let email: string | null | undefined;
  try {
    email = input.lookupPlatformLink(vendor, platform_id);
  } catch {
    return {}; // corrupt link store — fail closed
  }
  if (email === null || email === undefined || email.length === 0) return {};
  let canonical: string | undefined;
  try {
    canonical = input.resolveCanonical(email);
  } catch {
    return {}; // malformed email / corrupt merge chain — fail closed
  }
  return canonical !== undefined && canonical.length > 0 ? { actor_contact_id: canonical } : {};
};

// ────────────────────────────────────────────────────────────────
// Evidence composition
// ────────────────────────────────────────────────────────────────

/** Compose the single immutable `message` evidence snapshot for a matched
 *  message — the message IS the evidence (ONE entry regardless of how many
 *  declared patterns matched). The `snippet` is the message text, trimmed then
 *  capped to `COMMITMENT_MESSAGE_EVIDENCE_SNIPPET_MAX` (verbatim, not a
 *  paraphrase).
 *
 *  FAIL-CLOSED: returns `undefined` unless every field the work-entity store's
 *  `message` evidence validator requires is well-formed — a non-empty snippet
 *  (invariant 1: no evidence, no commitment) AND a non-empty message_id /
 *  vendor / sender. This runs BEFORE the ledger claim, so a malformed message
 *  never claims the dedup key nor fires a proposal that would only fail the
 *  store validator at mint time (and then, with the claim persisted, block a
 *  well-formed redelivery). `sent_at` falls back to `captured_at` when the bus
 *  event carries no finite send time.
 *
 *  The evidence `full_target_id` is VENDOR-SCOPED (`<vendor>_<message_id>`,
 *  mirroring the CRM `<vendor>_<entity>_...` convention) — and is ALSO the
 *  dedup ledger key — so a native id that is unique only within a vendor
 *  cannot collide across vendors. ⚠ v1 residual: the messenger bus record is
 *  deliberately minimal (`{from,text,vendor,connection_name,media_count}`) and
 *  carries NO channel/chat id, so a vendor whose native message id is unique
 *  only per-CHAT (Telegram `message_id`) can still collide across chats.
 *  Slack `ts` is workspace-global (safe) and the dispatcher's sha256 fallback
 *  id is already fully scoped; closing the Telegram-multi-chat gap needs the
 *  chat id forwarded onto the bus record (a dispatcher / M1-projection
 *  enhancement, out of this funnel's scope). */
export const composeMessageEvidence = (input: {
  projection: MessageProjection;
  message_id: string;
  captured_at: number;
  /** The M3-resolved sender contact (`resolveMessageCommitmentActor`) —
   *  the sender's D-138 canonical email. Attached to the evidence when the
   *  `(vendor, platform_id)` linker matched; a blank/absent value leaves the
   *  sender an opaque `actor_platform_id`. */
  actor_contact_id?: string;
}): CommitmentMessageEvidence | undefined => {
  const message_id = input.message_id.trim();
  const vendor = input.projection.vendor.trim();
  const actor_platform_id = input.projection.sender.trim();
  const snippet = input.projection.text.trim().slice(0, COMMITMENT_MESSAGE_EVIDENCE_SNIPPET_MAX);
  if (
    message_id.length === 0 ||
    vendor.length === 0 ||
    actor_platform_id.length === 0 ||
    snippet.length === 0
  ) {
    return undefined;
  }
  const sent_at = Number.isFinite(input.projection.sent_at)
    ? (input.projection.sent_at as number)
    : input.captured_at;
  const actor_contact_id = input.actor_contact_id?.trim();
  return {
    kind: 'message',
    full_target_id: `${vendor}_${message_id}`,
    vendor,
    actor_platform_id,
    ...(actor_contact_id !== undefined && actor_contact_id.length > 0
      ? { actor_contact_id }
      : {}),
    snippet,
    sent_at,
    captured_at: input.captured_at,
    ...(input.projection.permalink !== undefined
      ? { vendor_url: input.projection.permalink }
      : {}),
  };
};

// ────────────────────────────────────────────────────────────────
// The funnel
// ────────────────────────────────────────────────────────────────

export interface MessageCommitmentFunnelDeps {
  /** The held-proposal dispatch (F1's `fire`) — read LAZILY per call: the
   *  runtime ref is late-populated by the post-listener wire, so a funnel built
   *  at compose time reads the live `fire` only when a message actually
   *  arrives. Absent (pre-wire / dbless) ⇒ the funnel skips WITHOUT claiming so
   *  a redelivery re-proposes once the runtime is up (mirrors the E3 funnel's
   *  absent-runtime posture). */
  getFire: () => FireCommitmentEvidenceProposal | undefined;
  ledger: MessageCommitmentLedger;
  /** M3 messenger→contact linker — D-138 `(vendor, platform_id) →
   *  canonical_email` link lookup (`contactStore.lookupPlatformLink`).
   *  Absent (dbless / pre-store) ⇒ the sender stays unresolved and the
   *  proposal's counterparty defaults EMPTY (owner fills at approval). */
  lookupPlatformLink?: (vendor: string, platform_id: string) => string | null | undefined;
  /** M3 — D-138 canonical resolver
   *  (`contactStore.resolveCanonicalEmail(email).canonical_email`). */
  resolveCanonical?: (email: string) => string | undefined;
  /** M1b — the declaration-driven messenger→contact link WRITER. Awaited
   *  (best-effort, guarded) after a match and BEFORE the M3 resolve, so a
   *  matched sender who is not yet linked gets their `(vendor, platform_id) →
   *  email` link recorded (via a Slack `users.info` profile fetch) and the
   *  SAME-message resolve then picks it up — a first-time sender links and
   *  resolves in one pass. Scoped to MATCHED senders only (the funnel is the
   *  sole consumer of messenger links). Fail-open + never affects the outcome:
   *  a link failure just leaves the sender opaque (owner fills at approval).
   *  Absent (dbless / pre-store / a `'none'` vendor like Telegram) ⇒ skipped. */
  ensureSenderLinked?: (vendor: string, platform_id: string) => Promise<void>;
  now?: () => number;
}

export interface MessageCommitmentFunnelInput {
  /** The projected inbound message (vendor / sender / text + optional sent_at /
   *  permalink / structured tags·mentions). */
  projection: MessageProjection;
  /** The connection's declared match patterns (M2). */
  patterns: readonly MessageMatchPattern[];
  /** The message's stable identity — the bus event `record_id` (vendor message
   *  id, or its sha256 digest). Both the evidence `full_target_id` and the
   *  dedup ledger key. */
  message_id: string;
}

export type MessageCommitmentFunnelOutcome =
  /** Matched → a held `commitment-propose` run was dispatched. */
  | 'proposed'
  /** No declared pattern matched the message. */
  | 'no_match'
  /** The late-bound fire runtime is not up yet (skipped without claiming). */
  | 'runtime_unavailable'
  /** Matched, but the message carried no capturable text (empty snippet). */
  | 'no_evidence'
  /** Already proposed (pending / approved / declined) — the ledger held. */
  | 'duplicate'
  /** The proposal dispatch threw before a durable hold — the claim was
   *  released so a redelivery re-proposes. */
  | 'dispatch_failed';

/** Route ONE inbound message through match → held `commitment-propose`.
 *  The OUTCOME is deterministic — every normal path returns a distinct outcome;
 *  the match + evidence compose are fail-closed and the dispatch failure + its
 *  claim release are guarded, so the only way out is a returned outcome — except
 *  a catastrophic ledger/db throw at claim time, which propagates to the caller
 *  (the bus subscriber boundary swallows a throwing listener, so it never
 *  crashes the bus). The one side-effect beyond the proposal is M1b's
 *  best-effort `ensureSenderLinked` (an identity-learning link write via a live
 *  vendor profile fetch) — guarded + fail-open, it never changes which outcome
 *  is returned, only whether the resolved counterparty is populated. */
export const runMessageCommitmentFunnel = async (
  deps: MessageCommitmentFunnelDeps,
  input: MessageCommitmentFunnelInput,
): Promise<{ outcome: MessageCommitmentFunnelOutcome }> => {
  const now = deps.now ?? ((): number => Date.now());

  const matches = matchMessage(input.patterns, input.projection);
  if (matches.length === 0) return { outcome: 'no_match' };

  const fire = deps.getFire();
  if (fire === undefined) return { outcome: 'runtime_unavailable' };

  const captured_at = now();
  // M1b — best-effort learn the sender's contact link BEFORE resolving, so a
  // first-time matched sender links + resolves in one pass. Guarded: the writer
  // is fail-open by design, but a throwing dep must never abort the proposal
  // (linking is a side-effect, not a precondition — the M3 resolve below still
  // fails closed to an empty counterparty if the link is absent).
  if (deps.ensureSenderLinked !== undefined) {
    try {
      await deps.ensureSenderLinked(input.projection.vendor, input.projection.sender);
    } catch {
      /* best-effort — never blocks the proposal */
    }
  }
  // M3 — resolve the inbound sender to a Recued contact (the sender IS the
  // counterparty on the inbound-only messenger bus). Fail-closed: an
  // unresolved sender simply omits `actor_contact_id` / the counterparty.
  const { actor_contact_id } = resolveMessageCommitmentActor({
    vendor: input.projection.vendor,
    actor_platform_id: input.projection.sender,
    lookupPlatformLink: deps.lookupPlatformLink,
    resolveCanonical: deps.resolveCanonical,
  });
  const evidence = composeMessageEvidence({
    projection: input.projection,
    message_id: input.message_id,
    captured_at,
    ...(actor_contact_id !== undefined ? { actor_contact_id } : {}),
  });
  if (evidence === undefined) return { outcome: 'no_evidence' };
  // The dedup key IS the evidence identity (vendor-scoped `full_target_id`), so
  // the ledger and the minted commitment agree on what "this message" is.
  const identity = evidence.full_target_id;

  // Claim BEFORE firing (both-halves-up-first): a claim without a fire would
  // swallow this message identity forever.
  if (!deps.ledger.tryClaim({ message_id: identity, vendor: evidence.vendor }, captured_at)) {
    return { outcome: 'duplicate' };
  }

  const payload: Record<string, unknown> = {
    direction: DEFAULT_MESSAGE_COMMITMENT_DIRECTION,
    statement: evidence.snippet.slice(0, COMMITMENT_STATEMENT_MAX),
    derivation: 'evidence_captured',
    // The message send time IS the promise timestamp. The deadline
    // (`promised_for_at`) defaults ABSENT — v1 does no text-date parsing; the
    // owner sets it at approval (the F1 posture).
    promised_at: evidence.sent_at,
    evidence_blob: [evidence],
    // M3 — the inbound sender IS the counterparty. Read from the composed
    // evidence (single source of truth: compose trims/drops a blank id) so
    // the payload counterparty and the evidence `actor_contact_id` never
    // diverge. Absent ⇒ nullable column, owner fills at approval.
    ...(evidence.actor_contact_id !== undefined
      ? { counterparty_contact_id: evidence.actor_contact_id }
      : {}),
  };
  const execution_source: ExecutionSource = {
    channel: 'reactive',
    actor: 'system',
    event_kind: COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND,
    source_recipe: COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID,
  };

  try {
    await fire({
      recipe: COMMITMENT_EVIDENCE_PROPOSAL_RECIPE as RecipeDefinition,
      execution_source,
      payload,
      run_id: `message-commitment-${identity}-${captured_at}`,
    });
    return { outcome: 'proposed' };
  } catch {
    // Hard pre-hold failure (the F1 `fire` throws only BEFORE a durable hold) —
    // release the claim so a redelivery re-proposes. Best-effort: a release
    // failure (e.g. a closed db) must not mask the dispatch failure, so the
    // outcome stays `dispatch_failed` rather than throwing out of the funnel.
    try {
      deps.ledger.release(identity);
    } catch {
      /* swallow — the claim persists; a manual/retention sweep can clear it */
    }
    return { outcome: 'dispatch_failed' };
  }
};
