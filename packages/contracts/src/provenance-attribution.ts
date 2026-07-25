/** D-161 Part B (P4) — provenance-honesty attribution.
 *
 *  The last D-161 phase. P1 stamped every warehouse / memory / link /
 *  enrichment row with an `origin_actor` write-actor facet
 *  (`origin-provenance.ts`); P2 let a producer *read* that stamp to gate
 *  its input (`input-provenance.ts`); P3 read it on the *consumer* side
 *  to foreground the gold-path lane and make outside-actor activity a
 *  filterable lane (`timeline-lanes.ts`). P4 closes the loop: when an
 *  outside-actor row *does* surface, it must surface **attributed** — an
 *  agent's assertion is never presented as the user's own knowledge
 *  (I-10 / N.8).
 *
 *  **O-3 settled — render, do NOT store.** The attribution is a *derived
 *  view*, computed at read time from the row's origin facet (P1/P2's
 *  `origin_actor` + `origin_contract_id` columns) plus — for `data.memory`
 *  entries / provenance links — the audit row's `execution_source` (the
 *  agent identity, "agent X") and the `contract_snapshot` the commit
 *  already carries (the contract version, "contract Y"; N.8 names exactly
 *  these two substrates). There is NO new stored column: a stored
 *  attribution field would re-encode what `(origin_actor, contract_id)`
 *  already holds — the double-encoding D-161 removes (I-2 / N.3), and
 *  exactly the move P0's `renderActorLabel` + P1's memory-derive already
 *  made. Pre-launch, zero installs — nothing to backfill.
 *
 *  **First-person is the silent default (I-9 / I-10).** Only the two
 *  outside actors produce an attribution: `contracted_user` → an *agent*
 *  assertion, `anonymous` → *visitor-derived*. The gold-path actors
 *  (`user_self` / `system`) produce `undefined` — a first-person row
 *  carries no attribution wrapper and renders as the user's own
 *  knowledge / context, exactly as today. The absence of an attribution
 *  IS the "this is the user's own" signal, so adding the facet to the
 *  read-model never changes gold-path rendering.
 *
 *  This is a TREATMENT signal, never an EXCLUSION one (I-7): an
 *  attributed row stays in the warehouse and reachable; attribution only
 *  shapes how it is *presented*. The abuse gate is upstream (D-149).
 *
 *  Spec: docs/d-161-spec.md § N.8 / A.7 / I-10 / O-3.
 */

import type { Actor, ContractSnapshot, ExecutionSource } from './commits.js';
import { executionSourceContractId } from './commits.js';

/** The kind of attribution a non-first-person row carries — the derived
 *  presentation lane (mirrors P3's named lanes, computed from the actor,
 *  never a second taxonomy):
 *
 *  - `'agent'`   — `contracted_user`: a distinct outside identity under a
 *    user-established contract (an MCP agent, a contracted messenger bot,
 *    a reception visitor with a chat-contract). Fully attributable.
 *  - `'visitor'` — `anonymous`: an outside party with no identity
 *    established — a Reception submission, or (D-209 #1 W3) a
 *    webhook-fired write. Marked visitor-/vendor-event-derived; never
 *    auto-asserted into the user's knowledge graph (N.9 SHOULD). The kind
 *    stays ONE bucket for the whole `anonymous` class (a closed
 *    vocabulary consumers key Records on — no per-channel kinds); the
 *    channel distinction lives in the `label`, rendered only when the
 *    read path actually knows the channel. */
export type ProvenanceAttributionKind = 'agent' | 'visitor';

/** The derived attribution descriptor for an outside-actor row. Present
 *  on a read-model entry (`TimelineEntry.attribution`,
 *  `ServerRecentExecution.attribution`) ONLY when the row was written by
 *  a `contracted_user` or `anonymous` actor — a first-person
 *  (`user_self` / `system`) row carries none (the absence is the
 *  "user's own" signal; I-10).
 *
 *  Carries both the structured facts (so a UI can render its own copy /
 *  group by lane) and a ready-made `label` (the canonical phrasing the
 *  spec names, so the rendering lives in one place and can't drift —
 *  the `renderActorLabel` precedent). */
export interface ProvenanceAttribution {
  /** `'agent'` for `contracted_user`, `'visitor'` for `anonymous`. */
  kind: ProvenanceAttributionKind;
  /** The outside actor that wrote the row — narrowed to the two
   *  non-first-person actors (a first-person row never produces a
   *  `ProvenanceAttribution` at all). Self-describing so the descriptor
   *  is meaningful detached from its entry. */
  origin_actor: 'contracted_user' | 'anonymous';
  /** The agent identity — "agent X". The MCP `agent_id` when the writing
   *  source was an MCP agent (the canonical contracted-agent case, D-137);
   *  absent for a `contracted_user` on another channel (chat / messenger /
   *  reception have no stable agent id) and always absent for a visitor. */
  agent_id?: string;
  /** The contract in force on the writing execution — "contract Y". Present
   *  for a `contracted_user` (a contract is required on every
   *  `contracted_user` source — O-6); absent for a visitor (`anonymous`
   *  never carries a contract). */
  contract_id?: string;
  /** The pinned contract version from the commit's `contract_snapshot`,
   *  when the read path had the snapshot available (memory entries /
   *  provenance links — N.8). Lets attribution stay interpretable after
   *  the contract is revoked / version-bumped, the snapshot's whole
   *  purpose. Absent when the read path only had the `origin_contract_id`
   *  column (annotation / link / enrichment rows). */
  contract_version?: string;
  /** Canonical human phrasing — "agent <X>, under contract <Y>, asserted
   *  this" / "an agent asserted this" / "visitor-derived (anonymous
   *  reception)" / "vendor-event-derived (anonymous webhook)" /
   *  channel-unknown "visitor-derived (anonymous)". The single place the
   *  sentence the spec quotes is rendered, so consumers that don't build
   *  their own from the structured fields can't drift from it. */
  label: string;
}

/** The loose `(origin_actor, …)` input `renderProvenanceAttribution`
 *  derives from. Every field optional except `origin_actor` (itself
 *  nullable — an unstamped row resolves to `'system'`, matching the P1
 *  column default + P3's lane treatment). Callers with a full
 *  `ExecutionSource` + `ContractSnapshot` (memory / execution feeds) use
 *  `provenanceAttributionFromSource`; callers with only the
 *  `origin_actor` + `origin_contract_id` columns (annotation / link /
 *  enrichment) build this directly. */
export interface ProvenanceAttributionInput {
  /** The row's write-actor (the P1 `origin_actor` facet). `undefined` →
   *  treated as `'system'` (an unstamped / pruned row is engine-internal
   *  by construction, never an outside injection surface — the same
   *  default P3's `originActorPassesTimelineFilter` uses) → no
   *  attribution. */
  origin_actor: Actor | undefined;
  /** The writing dispatch's channel, when the read path knows it (a full
   *  `ExecutionSource` — memory / execution feeds). Selects the honest
   *  `anonymous` label: `reception` → visitor-derived, `webhook`
   *  (D-209 #1 W3) → vendor-event-derived. Column-only callers
   *  (annotation / link / enrichment rows carry no channel) leave it
   *  absent → the channel-neutral phrasing, which claims nothing it
   *  cannot know. */
  channel?: ExecutionSource['channel'];
  /** The MCP agent identity, when the read path resolved one. */
  agent_id?: string;
  /** The contract in force (`origin_contract_id` column, or
   *  `executionSourceContractId` / `contract_snapshot.contract_id`). */
  contract_id?: string;
  /** The pinned contract version (`contract_snapshot.contract_version`),
   *  when available. */
  contract_version?: string;
}

/** Render the canonical agent-assertion phrasing the spec quotes —
 *  "agent X, under contract Y, asserted this" — degrading gracefully as
 *  identity is missing: no agent id → "an agent …"; no contract → drop
 *  the "under contract …" clause. */
const renderAgentLabel = (
  agent_id: string | undefined,
  contract_id: string | undefined,
): string => {
  const who = agent_id !== undefined ? `agent ${agent_id}` : 'an agent';
  return contract_id !== undefined
    ? `${who}, under contract ${contract_id}, asserted this`
    : `${who} asserted this`;
};

/** The `anonymous` phrasings (N.9 SHOULD: "marked visitor-derived").
 *  `anonymous` carries no writer identity, so there is nothing to
 *  interpolate — but the CHANNEL, when the read path knows it, picks the
 *  honest noun: a reception row is a human visitor's submission; a
 *  webhook row (D-209 #1 W3) is a vendor machine event. A read path that
 *  cannot know the channel (column-only rows, pruned audit) gets the
 *  neutral phrasing — a rendering must never claim a channel it didn't
 *  see. (The door `contract_id` an anonymous source may carry is dispatch
 *  AUTHORITY — the owner's own standing grant — not the outside party's
 *  identity, so no anonymous label interpolates it; the commit row keeps
 *  it auditable.) */
const VISITOR_LABEL_RECEPTION = 'visitor-derived (anonymous reception)';
const VISITOR_LABEL_WEBHOOK = 'vendor-event-derived (anonymous webhook)';
const VISITOR_LABEL_NEUTRAL = 'visitor-derived (anonymous)';

const visitorLabelForChannel = (
  channel: ExecutionSource['channel'] | undefined,
): string => {
  if (channel === 'reception') return VISITOR_LABEL_RECEPTION;
  if (channel === 'webhook') return VISITOR_LABEL_WEBHOOK;
  return VISITOR_LABEL_NEUTRAL;
};

/** Derive the attribution descriptor from a row's origin facet, or
 *  `undefined` for a first-person (`user_self` / `system`) row.
 *
 *  The first-person `undefined` is load-bearing: a consumer attaches the
 *  result onto a read-model entry *only when defined*, so gold-path rows
 *  keep today's exact shape (I-9) and a `contracted_user` / `anonymous`
 *  row never surfaces unattributed in the user's first-person knowledge
 *  feed (I-10). */
export const renderProvenanceAttribution = (
  input: ProvenanceAttributionInput,
): ProvenanceAttribution | undefined => {
  // An unstamped / pruned row is engine-internal `system` by construction
  // (the P1 column default + P3 lane treatment) — first-person, no
  // attribution.
  const actor: Actor = input.origin_actor ?? 'system';
  if (actor === 'user_self' || actor === 'system') return undefined;

  if (actor === 'anonymous') {
    // Anonymous: no writer identity — a fixed per-channel marker. Any
    // contract_id / agent_id on the input is ignored: a door contract on an
    // anonymous source (D-207 reception, D-209 webhook) is the OWNER's
    // standing dispatch authority, not the outside party's identity.
    return {
      kind: 'visitor',
      origin_actor: 'anonymous',
      label: visitorLabelForChannel(input.channel),
    };
  }

  // contracted_user → an attributable agent assertion.
  const attribution: ProvenanceAttribution = {
    kind: 'agent',
    origin_actor: 'contracted_user',
    label: renderAgentLabel(input.agent_id, input.contract_id),
  };
  if (input.agent_id !== undefined) attribution.agent_id = input.agent_id;
  if (input.contract_id !== undefined) attribution.contract_id = input.contract_id;
  if (input.contract_version !== undefined) {
    attribution.contract_version = input.contract_version;
  }
  return attribution;
};

/** The agent identity ("agent X") for an `ExecutionSource`, or
 *  `undefined` when the channel carries none. Only the `'mcp'` channel
 *  names a stable agent (`agent_id`) — the canonical contracted-agent
 *  case (D-137). A `contracted_user` on `chat` / `messenger` /
 *  `reception` has a session / sender / visitor id but no agent identity,
 *  so attribution there names the contract alone ("an agent, under
 *  contract Y, asserted this"). */
export const agentIdFromSource = (
  source: ExecutionSource,
): string | undefined =>
  source.channel === 'mcp' ? source.agent_id : undefined;

/** Derive the attribution descriptor from a run's `ExecutionSource` (the
 *  actor + agent identity + contract) and the commit's optional
 *  `ContractSnapshot` (the pinned contract version — N.8's "contract_snapshot
 *  the commit already carries"). The convenience the rich read paths use:
 *  `data.timeline()` memory entries and the `execution.recent` aggregate
 *  feed both join each row to its audit `AuditEntry`, which carries both.
 *
 *  An absent `source` (a sync / housekeeping write with no execution
 *  source, or a pruned audit row whose source is gone) → `undefined`:
 *  engine-internal `system`, first-person, no attribution — keeping
 *  attribution coherent with P3's `origin_actor` derivation off the same
 *  source. */
export const provenanceAttributionFromSource = (
  source: ExecutionSource | undefined,
  snapshot?: ContractSnapshot,
): ProvenanceAttribution | undefined => {
  if (source === undefined) return undefined;
  // The SOURCE is the sole source of truth for actor + contract_id (covers a
  // self-restricted `user_self` too, though that resolves first-person
  // above). The `contract_snapshot` ONLY supplies the pinned
  // `contract_version`, and ONLY when it is a snapshot of THIS source's
  // contract — never a divergent one: a version from a different contract
  // would mislabel the row (provenance honesty). No `snapshot.contract_id`
  // fallback either — a source with no contract is not retroactively
  // contracted by an (incoherent) snapshot.
  const contract_id = executionSourceContractId(source);
  return renderProvenanceAttribution({
    origin_actor: source.actor,
    // The rich path knows the channel, so an anonymous row gets the honest
    // per-channel label (reception visitor vs D-209 webhook vendor event).
    channel: source.channel,
    agent_id: agentIdFromSource(source),
    contract_id,
    contract_version:
      snapshot !== undefined && snapshot.contract_id === contract_id
        ? snapshot.contract_version
        : undefined,
  });
};

/** Structural predicate — true when `value` matches `ProvenanceAttribution`:
 *  a coherent `(kind, origin_actor)` pair (`agent` ⇔ `contracted_user`,
 *  `visitor` ⇔ `anonymous`), a string `label`, and the three optional
 *  identity fields are strings when present. Narrows attribution read back
 *  from a serialized read-model entry. */
export const isProvenanceAttribution = (
  value: unknown,
): value is ProvenanceAttribution => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.kind !== 'agent' && v.kind !== 'visitor') return false;
  if (v.origin_actor !== 'contracted_user' && v.origin_actor !== 'anonymous') {
    return false;
  }
  if (typeof v.label !== 'string') return false;
  if (v.agent_id !== undefined && typeof v.agent_id !== 'string') return false;
  if (v.contract_id !== undefined && typeof v.contract_id !== 'string') return false;
  if (
    v.contract_version !== undefined
    && typeof v.contract_version !== 'string'
  ) {
    return false;
  }
  // (kind, origin_actor) must agree — the two are not independent.
  if (v.kind === 'agent' && v.origin_actor !== 'contracted_user') return false;
  if (v.kind === 'visitor' && v.origin_actor !== 'anonymous') return false;
  return true;
};
