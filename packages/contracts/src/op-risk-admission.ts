/** D-187 policy-matrix retirement (slice 4) — the op-risk × stage-trust APPROVAL
 *  bridge the four live dispatch chokepoints call instead of the matrix's
 *  `lookupPolicy → mergePolicyWithContract → admitWithPolicyMatrix` chain.
 *
 *  Slice 3 stood up the two pure substrate primitives in `ingredient-catalog.ts`:
 *    - `resolveSimpleFormOperationPolicy({slug, risk_tier})` — the op-risk base for
 *      a simple-form ingredient (one ingredient = one op; op-risk IS the manifest
 *      `risk_tier`), run through the SAME `baseApprovalOrDeny` algebra catalog ops
 *      use (read→never, write/admin→ask, destructive→always).
 *    - `applyTrustCeiling(base, ceiling)` — RELAX an `ask`-class op to admit IFF its
 *      op-risk is at or below the trust `ceiling`; `always`-class (destructive /
 *      author opt-in) and `never`-class are untouched (the FLOOR trust can't cross).
 *
 *  This module is the WIRING glue (slice 4):
 *    - `resolveTrustCeiling(source, snapshot)` — which ceiling applies to a dispatch:
 *      contract-less (manual / trigger / schedule / auto / owner-direct) → the global
 *      owner/automation default `admin` (behavior-preserving — only destructive asks,
 *      reads/writes/admin run silent); contracted (chat / mcp / messenger under a
 *      contract) → the contract's trust, derived from the snapshot's
 *      `approval_required` (defaults LOW so an AI's writes surface for approval).
 *    - `admitByOpRisk(...)` — the single entry: base → ceiling RELAX → outbound-send
 *      LIFT → `AdmissionDecision`. The chokepoints map `verdict`/`detail` onto their
 *      own control flow exactly as they did for `admitWithPolicyMatrix`.
 *    - the outbound-send approval LIFT — relocated here from the (now-deleted)
 *      matrix-coupled `escalateOutboundSend` (`policy-matrix-dispatch.ts`). It is
 *      DELIBERATELY actor-scoped, not folded into the send op's `risk_tier`: at the
 *      same `admin` ceiling a send must RELAX for unattended automation (`system`)
 *      yet ASK for the attended owner (`user_self`) — an asymmetry no single
 *      risk-tier / `approval` tag can express (a `destructive` retag would prompt on
 *      every scheduled digest; an `admin` retag would relax silently at the `admin`
 *      ceiling). So the closed `OUTBOUND_SEND_INGREDIENT_SLUGS` set + the user_self
 *      scoping survive verbatim, just decoupled from the matrix.
 *
 *  APPROVAL (Layer 2) only. ACCESS (`contract × op → boolean`, Layer 1) stays the
 *  separate op-admission gate (`backend/server/src/op-admission-gate.ts`), layered on
 *  top of this decision by each dispatch host — never here. Pure: no I/O, no clock.
 *
 *  Spec: `docs/d-187-spec.md` + `[[project_policy_matrix_retirement]]`. */

import type { ContractSnapshot, ExecutionSource } from './commits.js';
import { executionSourceHasContract, isDelegatedMcpToken } from './commits.js';
import { stripCorePrefix } from './core-pack.js';
import {
  resolveSimpleFormOperationPolicy,
  type CatalogOperationResolution,
  type TrustCeiling,
} from './ingredient-catalog.js';
import type { RiskTier } from './ingredient.js';
import type { AdmissionDecision, AdmissionDenyCode } from './policy-enforcement.js';

// ════════════════════════════════════════════════════════════════
// Outbound-send slug set (relocated from policy-matrix-dispatch.ts)
// ════════════════════════════════════════════════════════════════

/** The kernel ingredients that deliver a message OUTSIDE the user's trust boundary
 *  to a third party — irreversible outbound communications. All `risk_tier: 'write'`,
 *  so at the contract-less owner ceiling (`admin`) `applyTrustCeiling` would RELAX
 *  them to admit silently — yet "an AI emailed / Slacked someone on my behalf" is
 *  exactly the action the control-plane "every action is granted, gated, audited, and
 *  reversible" promise must surface for confirmation. The outbound-send LIFT
 *  (`liftOutboundSend`) re-raises an otherwise-admit verdict to `ask` at the attended
 *  `user_self` cells, routing the send through the D-157 preflight gate (the user
 *  reviews the REAL recipient, restored via D-167 P2, before it leaves).
 *
 *  A closed slug set rather than a manifest flag is deliberate (the policy decision
 *  sees only slug + risk_tier; a closed list mirrors the codebase idiom). Internal
 *  writes (annotation / note / task / link / shared-write / calendar / enrichment) are
 *  `write` too and stay silent — only the external-send slugs lift. Add a new send
 *  ingredient here when one ships (a future `telegram-send` is the documented sibling
 *  in `mail-post`'s description). */
export const OUTBOUND_SEND_INGREDIENT_SLUGS: ReadonlySet<string> = new Set([
  'mail-send', //         recued/mail-send — direct warehouse send (kind storage)
  'mail-post', //         recued-core/mail-post — email via connection.notification
  'slack-post', //        recued-core/slack-post — Slack via connection.notification
  'notification-send', // recued-core/notification-send — channel-delivery fan-out
  // D-210 §7 — recued/notify-booking-visitor: a booking-visitor courtesy send. The
  // recipient (the visitor's sealed email) is resolved server-side, never authored by
  // the recipe — but it IS an irreversible external delivery, so it lifts identically to
  // mail-send. The owner reviews the BOOKING it is bound to at the preflight gate (the
  // raw address is deliberately not surfaced — it never left the substrate).
  'notify-booking-visitor',
  // D-177 P2b — recued/connection-mcp-write: a WRITE-classified tool on an enrolled
  // MCP connection is an external side-effect authored at dispatch time (the chat
  // Tier-3 path routes here via run-ingredient). Lifting it closes the N.12 hole. The
  // read sibling (connection-mcp-read) deliberately stays out — reads pass through.
  'connection-mcp-write',
]);

/** True when `slug` is a known outbound external-communication send. A `core-<bare>`
 *  kernel alias (e.g. `core-mail-post`) is the SAME outbound send as its bare slug and
 *  must lift identically, so the prefix is stripped before the membership test —
 *  otherwise a published recipe could reach an outbound send via the core alias that
 *  bypasses the preflight-approval lift the bare slug triggers. */
export const isOutboundSendSlug = (slug: string): boolean =>
  OUTBOUND_SEND_INGREDIENT_SLUGS.has(stripCorePrefix(slug));

// ════════════════════════════════════════════════════════════════
// Trust-ceiling resolution
// ════════════════════════════════════════════════════════════════

/** The global owner/automation trust ceiling for a contract-less dispatch — the home
 *  the seeded `(user, user_self)` baseline cell's `max_risk_without_approval: 'admin'`
 *  re-homes to (D-187 retirement). `admin` = reads/writes/admin run silent, only
 *  destructive asks. One GLOBAL value (not per-channel): the matrix's tighter
 *  `(chat | messenger, user_self)` `write` ceiling collapses into this — an admin-risk
 *  op now runs silent in chat/messenger too, a deliberate consequence of one owner
 *  ceiling. There is no per-deployment knob in slice 4; `session_grant_defaults` (the
 *  per-channel grantable-tier seed) re-homes to the contract substrate in slice 6. */
export const CONTRACT_LESS_TRUST_CEILING: TrustCeiling = 'admin';

/** The stage-trust ceiling for a CONTRACTED dispatch (a `contracted_user`, or a
 *  self-restricted `user_self`) — decision-1's "the contract's `max_risk_without_
 *  approval`, defaulting LOW so an AI's writes surface for approval." `read` is the LOW
 *  default: a read is never-class (it admits regardless of the ceiling), while write /
 *  admin op-risks exceed it and so SURFACE — they HOLD on a checkpointable path
 *  (recipe / chat / messenger) or REFUSE on the synchronous direct MCP path. This is
 *  the control-plane posture: an AI acting under a contract cannot write or administer
 *  silently.
 *
 *  D-209 #1 — the snapshot can carry the door's authored `max_risk_without_approval`,
 *  which `resolveTrustCeiling` reads in preference when the snapshot is the source's
 *  own door (contract_id match). The D-209 #1 AMENDMENT (owner-ratified 2026-07-17)
 *  NARROWS that to the `(webhook, anonymous)` door ALONE — see {@link
 *  resolveTrustCeiling}. Every other door takes this LOW default, and no row can
 *  raise it. */
export const CONTRACTED_DEFAULT_TRUST_CEILING: TrustCeiling = 'read';

/** D-209 #1 — the per-door AUTHORED ceiling, honored ONLY when the snapshot is the
 *  SOURCE'S OWN door (contract_id match): a snapshot resolved for some other contract
 *  must never raise this dispatch's trust. Absent field ⇒ undefined ⇒ the flat default.
 *
 *  ⛔ D-209 #1 AMENDMENT — this is scoped to a FUNCTION with exactly ONE call site (the `(webhook,
 *  anonymous)` branch of {@link resolveTrustCeiling}) rather than a value computed at the
 *  top of the resolver, DELIBERATELY: as a shared local it was one `??` away from every
 *  other door, and that is precisely the reach the D-209 #1 AMENDMENT pin exists to remove. Keep it
 *  callable from the webhook branch and nowhere else — a second call site is the bug. */
const authoredWebhookDoorCeiling = (
  source: ExecutionSource,
  contractSnapshot?: ContractSnapshot,
): TrustCeiling | undefined => {
  if (contractSnapshot?.max_risk_without_approval === undefined) return undefined;
  const contractId = (source as { contract_id?: unknown }).contract_id;
  return typeof contractId === 'string' && contractId === contractSnapshot.contract_id
    ? contractSnapshot.max_risk_without_approval
    : undefined;
};

/** The applicable stage-trust ceiling for a dispatch (decision 1). Contract-less
 *  (manual / trigger / schedule / auto / owner-direct, OR the unbound stdio/CLI owner on
 *  mcp) → the global owner/automation `CONTRACT_LESS_TRUST_CEILING` (`admin`, behavior-
 *  preserving). Contracted (a real bound contract / door) → `CONTRACTED_DEFAULT_TRUST_
 *  CEILING` (`read`, LOW) so the AI's writes/admin surface for approval. Reads admit
 *  either way (never-class), so the split only governs write+ ops.
 *
 *  The `mcp` channel is special-cased: it forces every source to `actor:
 *  'contracted_user'` + a `contract_id` (synthetic = the token id when unbound), so
 *  NEITHER the actor nor the contract_id can tell the owner from a delegated door. The
 *  honest discriminator is the `mcp_token_id`: only the owner's OWN local stdio /
 *  canonical-CLI client lacks a bearer and falls back to the reserved
 *  `STDIO_MCP_TOKEN_ID` sentinel; EVERY inbound door bearer (bound OR unbound) is stamped
 *  a derived token id by the HTTP transport. So mcp is contract-less (`admin`) IFF
 *  `mcp_token_id === STDIO_MCP_TOKEN_ID` (the owner), else contracted LOW (a delegated
 *  door — its writes surface, whether or not it carries a bound cap/expiry contract). The
 *  `contract_id`-vs-`mcp_token_id` synthetic-equality test it replaced WRONGLY admitted an
 *  unbound inbound door at the owner ceiling (codex slice-4 HIGH#2).
 *  Source-derivable on every mcp path (direct + recipe + raw-op) — no `boundContractId`
 *  threading.
 *
 *  D-207 slice 1 — the ANONYMOUS floor (the same bug class as HIGH#2, on reception).
 *  `contract-less` must mean "the owner, or the owner's own automation" — it must NEVER
 *  mean "an unauthenticated third party". The `(reception, anonymous)` source carries no
 *  `contract_id` FIELD at all (`commits.ts`), so `executionSourceHasContract` returned
 *  false for it and a public visitor's dispatch took the OWNER `admin` ceiling — where a
 *  `write` op RELAXES to `admit`, and `liftOutboundSend` (the "every external send
 *  surfaces" backstop) does not fire because it is scoped to `user_self`. The premise this
 *  comment used to carry — "every other channel's `contract_id` is always real" — was
 *  false for exactly this actor. An `anonymous` actor is therefore pinned to the CONTRACTED
 *  LOW ceiling by the ACTOR, independently of whether a door contract has been resolved
 *  onto the source yet: absence of a `contract_id` means "not yet bound to a door", not
 *  "the owner". This is a fail-closed floor, not the D-207 door design — the door's real
 *  grants still arrive via its `ContractSnapshot`; this guarantees no future caller can
 *  hand an unauthenticated visitor the owner ceiling by forgetting to set one. */
export const resolveTrustCeiling = (
  source: ExecutionSource,
  contractSnapshot?: ContractSnapshot,
): TrustCeiling => {
  if (source.actor === 'anonymous') {
    // D-209 #1 (W3) — the `webhook` channel is the ONE anonymous door that reads its
    // authored ceiling: a webhook is a machine endpoint the owner wired on BOTH sides
    // (enabled on Recued AND pasted in the vendor console) — the two-sided enrollment
    // IS the standing approval, expressed as the door's `max_risk_without_approval`
    // (§1.4, minted `'admin'`). Honored only on the source's own door (the
    // `doorCeiling` contract_id match above); an unstamped trigger row / missing
    // snapshot / dead door leaves `doorCeiling` undefined → the LOW default (and the
    // grant axis floors an anonymous no-contract dispatch to `PUBLIC_CONTRACT_ID`,
    // which denies — two fences, both closed).
    if (source.channel === 'webhook') {
      return authoredWebhookDoorCeiling(source, contractSnapshot)
        ?? CONTRACTED_DEFAULT_TRUST_CEILING;
    }
    // ⛔ A `reception` (human-facing) door stays PINNED at the LOW ceiling by the
    // READER, not just by mint convention — the rev-5 F3 rule: raising the
    // ceiling turns a qualifying `ask` straight into `admit`, skipping the
    // taint check, and a public form's inputs are exactly the prompt-injection
    // surface that check exists for. A webhook differs in kind: its payload is
    // still tainted data (origin_actor propagates), but its DISPATCH authority
    // was standing-approved by the two-sided enrollment above.
    return CONTRACTED_DEFAULT_TRUST_CEILING;
  }
  const contracted =
    source.channel === 'mcp'
      // The SHARED discriminator (`commits.ts`) — the grant axis's door clause asks
      // this same question of the same field, and an inlined copy here is how the two
      // drift apart.
      ? isDelegatedMcpToken(source.mcp_token_id)
      : executionSourceHasContract(source);
  // ⛔ D-209 #1 AMENDMENT (owner-ratified 2026-07-17) — the MODEL-DOOR PIN. A contracted dispatch
  // takes the LOW default and NO row may raise it. This NARROWS D-209 #1 (which read the
  // authored ceiling on any door) to the `(webhook, anonymous)` carve-out alone.
  //
  // THE RULE: an authored ceiling is admissible only where a MACHINE delivers a payload
  // to a deterministic path. Every door reached here has a MODEL in the decision loop —
  // `llm_gateway` and `mcp_chat` (a customer / external agent prompting the owner's AI),
  // `mcp` tools (a tool call whose CALLER is an agent: the wire format is not prose, but
  // the decision to call was made by a model reading arbitrary text), a contracted
  // `messenger` (a third party's message), and `reception` above (a stranger's form text,
  // read downstream by a model — the F3 rule). A raised ceiling turns a qualifying `ask`
  // straight into `admit` and SKIPS the taint check, so for these doors it reduces to
  // "let attacker-influenced text write silently". A webhook differs in kind: nobody's
  // model decided to call it — the vendor POSTed, and the two-sided enrollment IS the
  // standing approval (D-209 §1.4).
  //
  // THIS COSTS NO FRICTION, because the relief routes through the BOUNDED instrument
  // instead of the unbounded one: `(mcp, contracted_user)` and `(reception, anonymous)`
  // are SEEDED session-grant cells (`session-grant.ts`), so the owner approves ONCE and
  // the grant absorbs the rest under a TTL + use cap + tier cap it can never exceed. The
  // cells that are NOT seeded — `(chat, contracted_user)` (llm_gateway / mcp_chat) and
  // `(messenger, contracted_user)` — are deliberately closed: standing repeat authority
  // for an external party is a different trust posture, and those doors ask every time BY
  // DESIGN. An authored ceiling would have been the set-and-forget way around exactly
  // that ruling.
  if (contracted) return CONTRACTED_DEFAULT_TRUST_CEILING;
  // D-209 §1.4 — a CONTRACT-FREE dispatch. The owner acting DIRECTLY (`user_self` HID /
  // chat) takes the `admin` ceiling (present, full-permission → a write relaxes silent).
  if (source.actor !== 'system') return CONTRACT_LESS_TRUST_CEILING;
  // A contract-free `system` BACKGROUND dispatch, resolved by channel:
  //   - `housekeeping` — the server's own maintenance, outside the user-approval model →
  //                      `admin` (destructive still holds pending the §1.6 FULL refinement).
  //   - everything else (`reactive` materialize, `schedule`, a source-less / legacy fire)
  //     is UNATTENDED and not owner-direct → fail closed to the LOW `read` ceiling (HOLD).
  //     The owner's own AUTOMATION carries `OWNER_CONTRACT_ID` and already took the `read`
  //     (has-contract) branch above; this is the safe interim, never a silent admit.
  // D-209 #1 (W3) — the flat `webhook → admin` interim branch is DELETED: the webhook
  // source is now `(webhook, anonymous)` and takes the per-door authored ceiling in the
  // anonymous branch above. A `(webhook, system)` source no longer exists
  // (`isExecutionSource` rejects it), so no webhook dispatch can reach this line.
  return source.channel === 'housekeeping'
    ? CONTRACT_LESS_TRUST_CEILING
    : CONTRACTED_DEFAULT_TRUST_CEILING;
};

// ════════════════════════════════════════════════════════════════
// Contracted per-tool ACCESS gate (the wildcard-door real gate)
// ════════════════════════════════════════════════════════════════

/** The per-tool ACCESS deny a contracted dispatch must still face: the tool slug must
 *  be in the contract snapshot's `allowed_tools` allowlist, else `tool_not_in_contract`.
 *  Returns the deny decision, or `null` when access is clear (contract-free → no gate;
 *  or the slug is granted).
 *
 *  WHY this stays at the chokepoint and is NOT folded into the op-admission gate
 *  (Layer 1): `op-admission-gate.ts` is PERMISSIVE for a WILDCARD door (empty
 *  `scope.operation_ids`) — its own comment says "its real gate is the per-token
 *  `ContractSnapshot.allowed_tools`". So `allowed_tools` is NOT redundant with the
 *  op-admission grant gate for wildcard doors; dropping it would let a wildcard door
 *  dispatch ANY tool. The D-187 matrix retirement removes the matrix's coarse
 *  `allowed_kinds` / `allowed_risk_tiers` gate (those ARE redundant with Layer-1 access
 *  + the owner/system trust posture) but PRESERVES this per-tool allowlist verbatim —
 *  it mirrors `evaluateToolAdmissibility`'s `allowed_tools` deny exactly
 *  (`policy.allowed_tools === snapshot.allowed_tools` after `mergePolicyWithContract`).
 *  Contract-FREE dispatches (owner HID / system channels) carry no snapshot and are
 *  ungated here — the op-admission gate skips them too (owner/system are trusted; their
 *  control is the op-risk approval, not a per-tool allowlist). Pure. */
export const admitContractToolAccess = (
  snapshot: ContractSnapshot | null | undefined,
  slug: string,
): AdmissionDecision | null => {
  if (!snapshot) return null;
  if (snapshot.allowed_tools.includes(slug)) return null;
  return Object.freeze({
    verdict: 'deny',
    code: 'tool_not_in_contract' satisfies AdmissionDenyCode,
    detail: `tool slug '${slug}' not in contract.allowed_tools (${snapshot.allowed_tools.length} entries)`,
  });
};

// ════════════════════════════════════════════════════════════════
// Outbound-send LIFT (relocated escalateOutboundSend, op-risk world)
// ════════════════════════════════════════════════════════════════

/** Lift an outbound-send op-risk `admit` to `ask` at the attended `user_self` cells.
 *  The op-risk replacement for the matrix-coupled `escalateOutboundSend`, with the
 *  SAME deliberately-narrow scope:
 *    - only an `admit` resolution lifts (a `deny` / already-`ask` is returned
 *      untouched — a pure tightening, never a relaxation);
 *    - only `actor === 'user_self'` lifts — the cells where a human is driving and
 *      reachable to approve. `'system'` (schedule / reactive / housekeeping) is EXEMPT
 *      (a scheduled "daily digest" send must not prompt on every unattended run);
 *      `'contracted_user'` is EXEMPT (already gated by its contract's LOW trust
 *      ceiling — a write send asks via the ceiling, never double-gated here);
 *    - only the closed outbound-send slug set lifts.
 *  Sets `verdict: 'ask'` + `approval: 'ask'`; `effective_risk_tier` is preserved for
 *  audit (the send is still a `write`, not reclassified). Pure; never mutates `res`. */
const liftOutboundSend = (
  res: CatalogOperationResolution,
  slug: string,
  source: ExecutionSource,
): CatalogOperationResolution => {
  if (res.verdict !== 'admit') return res;
  if (source.actor !== 'user_self') return res;
  if (!isOutboundSendSlug(slug)) return res;
  return { ...res, verdict: 'ask', approval: 'ask' };
};

// ════════════════════════════════════════════════════════════════
// Commitment-proposal LIFT (D-192 F1 invariant 3)
// ════════════════════════════════════════════════════════════════

/** The dedicated PROPOSAL surface — the D-192 F1 capture producer's
 *  `commitment-propose` kernel ingredient (backing
 *  `core.work-entity.commitment.propose`). Deliberately DISJOINT from
 *  `commitment-create`: proposal is a review-then-approve surface, the
 *  plain create keeps the normal write posture (recipes minting
 *  `recipe_emitted` / extraction commitments under owner automation
 *  trust run silent, unchanged). */
export const COMMITMENT_PROPOSAL_INGREDIENT_SLUGS: ReadonlySet<string> = new Set([
  'commitment-propose',
]);

export const isCommitmentProposalSlug = (slug: string): boolean =>
  COMMITMENT_PROPOSAL_INGREDIENT_SLUGS.has(stripCorePrefix(slug));

/** Lift a commitment-PROPOSAL op-risk `admit` to `ask` for EVERY actor —
 *  the deliberately-enumerated asymmetry vs `liftOutboundSend`'s
 *  `user_self` scoping (D-192 F1 invariant 3: "approval-gated, never
 *  auto-from-AI — this holds even for DETERMINISTIC captures; the owner
 *  ratifies every one"):
 *    - `'system'` is NOT exempt: the unattended reactive fire IS the
 *      proposal producer — the whole point of the surface is that a
 *      capture becomes a HELD run for the D-173 inbox, so relaxing the
 *      unattended case would delete the surface's meaning (contrast a
 *      scheduled digest send, where the unattended relax is the
 *      feature);
 *    - `'contracted_user'` lifts too (its LOW ceiling already asks —
 *      the lift is then a no-op, `res` is already `ask`);
 *    - `'user_self'` lifts: a human-driven propose is still a proposal
 *      (author it directly via `commitment-create` to skip review).
 *  Same pure-tightening contract as the send lift: only `admit` lifts,
 *  `effective_risk_tier` preserved for audit. */
const liftCommitmentProposal = (
  res: CatalogOperationResolution,
  slug: string,
): CatalogOperationResolution => {
  if (res.verdict !== 'admit') return res;
  if (!isCommitmentProposalSlug(slug)) return res;
  return { ...res, verdict: 'ask', approval: 'ask' };
};

// ════════════════════════════════════════════════════════════════
// CatalogOperationResolution → AdmissionDecision bridge + entry
// ════════════════════════════════════════════════════════════════

/** Map an op-risk resolution to the engine's `AdmissionDecision` (the shape the four
 *  chokepoints already branch on — `verdict` + `detail`):
 *    - `admit` → the bare admit;
 *    - `ask`   → `risk_tier` = the resolution's `effective_risk_tier` (audit-honest;
 *      a send carries `write`, not a reclassified tier); the `detail` distinguishes an
 *      outbound send (the user reviews the real recipient) from a trust-ceiling ask;
 *    - `deny`  → a deny decision. UNREACHABLE for `admitByOpRisk` (it passes no
 *      `default_policy`, so `resolveSimpleFormOperationPolicy` only ever resolves
 *      `admit` / `ask`; the synthetic op is always declared + granted), so this branch
 *      is pure defence. The `op_risk_denied` code is the matrix-free "a policy
 *      layer refused this action" discriminator (D-187 slice 6 renamed it from
 *      `policy_matrix_denied` when the matrix modules were deleted). */
const mapResolutionToAdmission = (
  res: CatalogOperationResolution,
  slug: string,
): AdmissionDecision => {
  switch (res.verdict) {
    case 'admit':
      return Object.freeze({ verdict: 'admit' });
    case 'ask':
      return Object.freeze({
        verdict: 'ask',
        risk_tier: res.effective_risk_tier,
        // These render VERBATIM into the ask body's "Reason:" line, so
        // they are owner-facing prose, not log text: no field syntax
        // (`risk_tier='write'` names the field the engine reads — the ask
        // already renders the tier as its consequence, in words), and no
        // spec citation (`(D-192 F1)` means nothing to the person being
        // asked). Each claim is unchanged.
        detail: isOutboundSendSlug(slug)
          ? `outbound send '${slug}' delivers a message outside your trust boundary `
            + `— preflight approval required`
          : isCommitmentProposalSlug(slug)
            ? `'${slug}' is a review-then-approve proposal surface — the commitment `
              + `mints only on your approval`
            : `op '${slug}' requires preflight approval under the active trust ceiling`,
      });
    case 'deny':
      return Object.freeze({
        verdict: 'deny',
        code: 'op_risk_denied' satisfies AdmissionDenyCode,
        detail: `op '${slug}' denied by op-risk policy (${res.deny_reason ?? 'unspecified'})`,
      });
  }
};

/** D-187 slice 4 — the single op-risk × stage-trust APPROVAL entry the four matrix
 *  chokepoints call. Composes: simple-form op-risk base (`resolveSimpleFormOperationPolicy`)
 *  → stage-trust RELAX (`applyTrustCeiling`) → outbound-send LIFT (`liftOutboundSend`)
 *  → `AdmissionDecision`. `ceiling` is the dispatch's applicable trust
 *  (`resolveTrustCeiling`); `source` drives ONLY the user_self-scoped outbound-send
 *  lift. APPROVAL (Layer 2) only — the host layers the op-admission ACCESS gate
 *  (Layer 1) on top of the returned decision. Pure: no I/O, no clock. */
export const admitByOpRisk = (args: {
  readonly slug: string;
  readonly risk_tier: RiskTier;
  readonly ceiling: TrustCeiling;
  readonly source: ExecutionSource;
}): AdmissionDecision => {
  // D-209 Slice B — the stage-trust ceiling is applied INSIDE the resolver now
  // (one relax code path for every op shape); this path no longer re-applies
  // `applyTrustCeiling` (the double-apply the spec removes). The outbound-send /
  // commitment-proposal review lifts still compose OVER the relaxed resolution.
  const relaxed = resolveSimpleFormOperationPolicy({
    slug: args.slug,
    risk_tier: args.risk_tier,
    ceiling: args.ceiling,
  });
  const lifted = liftCommitmentProposal(
    liftOutboundSend(relaxed, args.slug, args.source),
    args.slug,
  );
  return mapResolutionToAdmission(lifted, args.slug);
};

/** D-202 task 4a — the op-risk verdict BEFORE the two quality-review lifts:
 *  simple-form op-risk base (`resolveSimpleFormOperationPolicy`) → stage-trust
 *  RELAX (`applyTrustCeiling`) → `AdmissionDecision`, with the outbound-send /
 *  commitment-proposal lifts DELIBERATELY OMITTED. This is the AUTHORIZATION
 *  conjunct the D-202 three-conjunct gate composes against
 *  ({@link resolveQualityGateDecision}).
 *
 *  WHY strip exactly those two lifts and nothing else: they are the "review the
 *  AI output before it acts" surface — the very judgment a quality delegation
 *  removes (spec §0.1 / §1). Everything the trust CEILING itself holds is a
 *  genuine authorization concern a quality delegation must NEVER skip (§12.1):
 *    - an outbound send under the OWNER's `admin` ceiling has op-risk base
 *      `write` → RELAXES to `admit` here, so a matching quality delegation can
 *      auto-accept it (the lifted verdict was `ask` PURELY for the review);
 *    - the SAME send under a CONTRACTED door's LOW `read` ceiling stays `ask`
 *      (the AI is not authorized to send silently — quality can't grant that);
 *    - a `destructive` op stays `ask` at every ceiling (always-class — the
 *      ceiling can't cross it), so quality never auto-runs a destructive op.
 *  Takes no `source` — the two omitted lifts were its only consumer. Pure.
 *
 *  Reconstruction caveat: for a CATALOG op this re-derives from the effective
 *  `risk_tier` alone and does not see an authored `default_policy` override
 *  (which `resolveSimpleFormOperationPolicy` is passed none of). The v1 landing
 *  is the kernel simple-form `core.mail.send`, where this is exact; a catalog op
 *  carrying a `default_policy: 'ask'` would be reconstructed at its base tier.
 *  Noted for the region-decomposition slices; not reached by v1.
 *
 *  ⚠ SOUNDNESS BOUND — read before adding any new `ask` source to the admission
 *  chain (D-202 review Finding 1). This is a PARTIAL, args-BLIND recompute:
 *  op-risk × ceiling × the-two-lifts ONLY. It is a faithful stand-in for "would
 *  authorization admit this send" ONLY while `admitByOpRisk` (base + ceiling +
 *  these two lifts) is the admission's SOLE `ask` source — which it is today
 *  (every other gate DENIES, which throws before the D-202 ask-branch). The moment
 *  a non-lift `ask` source keyed off RESOLVED ARGS lands — notably the spec §1
 *  authorization **value-bounds** ("amount > $X → review", which `quality-
 *  delegation.ts` already documents as part of the re-derived authorization
 *  verdict) — this recompute CANNOT see it and would reconstruct `admit`, so a
 *  value-bound-tripped send carrying a quality delegation would wrongly SKIP the
 *  ask (a §12.1 violation). The robust fix at that point is to derive the D-202
 *  authorization conjunct by re-running the REAL admission with the review lift
 *  suppressed (a `suppressReviewLift` path through `evaluateAdmission` /
 *  `admitByOpRisk`), NOT this reconstruction. Sequence it with the value-bounds
 *  work; until then the quality skip is sound. */
export const admitByOpRiskWithoutQualityLifts = (args: {
  readonly slug: string;
  readonly risk_tier: RiskTier;
  readonly ceiling: TrustCeiling;
}): AdmissionDecision => {
  // D-209 Slice B — ceiling applied inside the resolver (no double-apply).
  const relaxed = resolveSimpleFormOperationPolicy({
    slug: args.slug,
    risk_tier: args.risk_tier,
    ceiling: args.ceiling,
  });
  return mapResolutionToAdmission(relaxed, args.slug);
};
