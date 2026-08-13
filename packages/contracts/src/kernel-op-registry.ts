/** D-182 — Kernel op registry (slice 3a).
 *
 *  The per-op enumeration of the Tier-K *closed-kind* kernel ops
 *  (`core.<domain>.<op>`). Slice 2 (`kernel-ops.ts`) registered the kernel
 *  DOMAINS + the canonical-convention runnability; slice 3a adds the concrete
 *  per-op rows for the closed-kind domains, each an **addressing + policy**
 *  record: the fully-qualified `core.*` op id → its backing kernel ingredient
 *  slug + kernel-defined risk. (Approval is NOT recorded here — it derives from
 *  `risk` at the enforcement point; see the ⛔ block below §3.)
 *
 *  Scope boundary (read before extending):
 *   - This is a CONTRACTS-LAYER addressing layer, NOT a re-definition of op
 *     behavior. The `community/ingredients/*.json` files stay the behavioral
 *     source of truth (loaded by `backend/server/src/manifest-loader.ts`;
 *     `risk` here is taken verbatim from each backing ingredient's `risk_tier`).
 *     There is NO runtime wiring here — resolving a `core.*` op-step to its
 *     handler is a later slice.
 *   - Only the CLOSED-KIND domains are enumerated (`ai`, `mail`, `contact`,
 *     `notification`, `work-entity`, `memory`, `data`, `storage`, `schedule`,
 *     `customer-access`, `customer`, `webhook`).
 *     The
 *     cross-vendor canonical conventions (`core.crm.*` / `core.acct.*`) are NOT
 *     here — slice 2 derives their risk/approval/runnability from the verb +
 *     the `crm_alias`/`acct_alias` resolver.
 *   - DEFERRED (out of slice 3a): vendor readers, per-platform cli `service`
 *     manifests, `dom` / `chat` / `http` ingredients, the `connection*` /
 *     `*-catalog` ingredients, housekeeping infra, and `ai-embed` (no usable
 *     embed model+mode declaration surface — D-131 plumbing is half-built; see
 *     the exclusion list in the spec/plan). The `watch` trigger-position domain
 *     is being PROTOTYPED (`core.watch.time` → `time-watcher`); the rest of the
 *     KernelWatcherSlug family follows once the prototype is accepted.
 *
 *  The AI dedup rule: `core.ai.<fn>` is backed by the anti-shadow-fenced
 *  `core-ai-<fn>` slug (unspoofable via the manifest-loader `isCoreSlug` gate),
 *  not the bare `ai-<fn>` (the legacy recipe-facing alias, removed in a later
 *  slice). Every `core.ai.*` backing slug strips (via `stripCorePrefix`) to a
 *  member of `CORE_CAPABILITY_SLUGS` — a drift guard the test pins.
 *
 *  Spec: D-182 §3 (Tier-K), §4 (kernel ops are NOT pack rows),
 *  §10 step 2. Pickup: internal design notes.
 */
import { parseOpId } from './op-model.js';
import { getKernelDomain } from './kernel-ops.js';
import type { RiskTier } from './ingredient.js';

// ────────────────────────────────────────────────────────────────
// §3/§4 — the kernel op record
// ────────────────────────────────────────────────────────────────

/** One Tier-K closed-kind kernel op (`core.<domain>.<op>`) → its backing kernel
 *  ingredient slug + kernel-defined risk. An addressing record; the ingredient
 *  JSON stays the behavioral source of truth.
 *
 *  D-187 grant-foundation slice 3 — a row may instead be a NATIVE verb-op
 *  (`native: true`): a grantable handle for an MCP-server-native direct-return
 *  read tool that has NO backing ingredient and is NOT recipe-runnable (see
 *  {@link KernelOpEntry.native}). */
export interface KernelOpEntry {
  /** the fully-qualified Tier-K op id (`core.mail.get`,
   *  `core.work-entity.task.mark-done`). Parses via `parseOpId` as
   *  `tier: 'kernel'` with `domain === this.domain`, a registered closed-kind
   *  domain. */
  op: string;
  /** the closed-kind kernel domain — a `class: 'closed_kind'` entry in slice-2
   *  `KERNEL_DOMAINS` (asserted at module load). */
  domain: string;
  /** the backing kernel ingredient slug in `community/ingredients/` (the
   *  manifest-loader resolution target; authoring-only, never recipe-faced).
   *  ABSENT on a {@link KernelOpEntry.native} op — a native verb-op has no
   *  backing ingredient + no lowering target. */
  backing_slug?: string;
  /** kernel-defined risk — taken verbatim from the backing ingredient's
   *  `risk_tier` (or kernel-assigned for a {@link KernelOpEntry.native} op). */
  risk: RiskTier;
  /** D-187 grant-foundation slice 3 — a NATIVE verb-op: a grant handle for an
   *  MCP-server-native direct-return read tool (`timeline` reuses the existing
   *  `core.memory.timeline.read`; `registry.describe` / `enrichment.read` /
   *  `vector_search` mint new `core.data.enrichment.*` ids). It exists ONLY so
   *  the cross-topic read verb is a grantable per-contract `op` entry (the
   *  amendment §3 `verb-op ∧ entry` read gate, gated channel-agnostically at the
   *  `ReadGrantChecker` seam). Native ops carry NO `backing_slug`, are excluded
   *  from the backing-slug reverse map ({@link kernelOpForBackingSlug}), and are
   *  rejected as recipe op-steps ({@link isNativeKernelOp}). Absent/false ⇒ an
   *  ordinary ingredient-backed, recipe-runnable kernel op. */
  native?: boolean;
  /** D-234 § 234.4 — the STATIC MCP TOOL NAME this native verb-op is reached
   *  through, when it is reachable from outside at all.
   *
   *  ⛔⛔ IT EXISTS BECAUSE THE MINT AND THE GATE SPOKE DIFFERENT LANGUAGES, AND
   *  THE DISAGREEMENT FAILED CLOSED IN SILENCE. `chat.inbound_token.issue`
   *  validates each grant key through `preflightExternalToolGrant`, which
   *  ACCEPTS a registered kernel op id — so an owner can hand a door
   *  `core.peer.receive-ask` and the mint says yes. At call time the per-token
   *  checklist is an EXACT lookup on the TOOL name
   *  ({@link isMcpInboundTokenToolAuthorized} → `grants[tool_name] === true`),
   *  so it asked for `recued_peerAsk` and found nothing. A native op has no
   *  `backing_slug`, so it is also filtered out of the one place op ids ARE
   *  honoured (`buildMcpContractSnapshot`'s `KERNEL_OP_REGISTRY` walk). Net
   *  effect: the only name the owner could grant was a name nothing ever read.
   *
   *  ⇒ This field is the join, so the vocabulary the mint accepts is the
   *  vocabulary the gate reads. Populated ONLY where a native op is actually
   *  callable as a static MCP tool; every other native verb-op is a per-contract
   *  READ grant consulted through `ReadGrantChecker`, never a checklist entry,
   *  and giving those a tool name would invent a door rather than describe one.
   *
   *  ⚠ Additive at the gate: it widens what satisfies the checklist, never what
   *  the checklist protects. A token granted the tool NAME still passes exactly
   *  as before. */
  mcp_tool?: string;
}

/** §3 — ⛔ THERE IS DELIBERATELY NO KERNEL APPROVAL DERIVATION HERE.
 *
 *  A `kernelApprovalForRisk(risk)` used to sit at this line, materializing a
 *  `KernelOpEntry.approval` field. Both were RETIRED (D-209 §5b follow-on) —
 *  retired, not corrected — because they were a SECOND derivation of a value
 *  that already has exactly one enforced source, parked beside the registry it
 *  claimed to describe. `RISK_APPROVAL_FLOOR` states the rule it broke: that
 *  closed list "lives here, never copied beside what it guards"
 *  (`ingredient-catalog.ts`).
 *
 *  The retired map DISAGREED with the enforced one on exactly two tiers:
 *
 *      tier         retired map   RISK_APPROVAL_FLOOR (enforced)
 *      read         never         never
 *      write        ask           ask
 *      admin        always   ←→   ask
 *      destructive  ask      ←→   always
 *
 *  ⛔ DO NOT RE-ADD ONE. Nothing ever read the field (verified repo-wide, at
 *  retirement and before it), so the disagreement was DORMANT — but dormant is
 *  not benign. Under the enforced floor a `destructive` op is `always`-class and
 *  `applyTrustCeiling` can never relax it; under the retired map it was
 *  `ask`-class, and `ask` relaxes to `admit` whenever op-risk <= the ceiling. A
 *  naive `if (op.approval)` plumb would therefore have made a destructive kernel
 *  op run SILENTLY on the owner's own `admin`-ceiling cron.
 *
 *  Need a kernel op STRICTER than its risk floor? That channel already exists
 *  one layer down, at the enforcement point: an op's manifest
 *  `OperationSpec.approval` is read by `baseApprovalOrDeny` and CLAMPED UP to
 *  the floor (D-209 §1.3 — a declared value may only tighten, never loosen).
 *  Declare it there, where it is enforced and cannot loosen. Never here.
 *
 *  ⚠ Do NOT "fix" the `always-class` reasoning in `op-risk-admission.ts` to
 *  match the retired map: that comment is CORRECT (driven 2026-07-17 — a
 *  destructive op resolves `ask` at read/write/admin ceilings via the enforced
 *  floor, while a write op relaxes to `admit` at `admin`). The retired map was
 *  the wrong one, not it. */

/** Internal builder — the table below declares exactly
 *  `(op, domain, backing_slug, risk)`, which is the whole record. */
const op = (
  opId: string,
  domain: string,
  backing_slug: string,
  risk: RiskTier,
): KernelOpEntry => ({ op: opId, domain, backing_slug, risk });

/** D-187 grant-foundation slice 3 — builder for a NATIVE verb-op
 *  ({@link KernelOpEntry.native}): a grant handle for an MCP-server-native
 *  direct-return read tool. No `backing_slug` (no backing ingredient, not
 *  recipe-runnable). */
const nativeOp = (
  opId: string,
  domain: string,
  risk: RiskTier,
  /** D-234 § 234.4 — see {@link KernelOpEntry.mcp_tool}. Supply it only for a
   *  native op that is genuinely callable as a static MCP tool. */
  mcp_tool?: string,
): KernelOpEntry => ({
  op: opId,
  domain,
  risk,
  native: true,
  ...(mcp_tool !== undefined ? { mcp_tool } : {}),
});

// ────────────────────────────────────────────────────────────────
// §10 step 2 — the closed-kind kernel op enumeration, grouped by domain
// ────────────────────────────────────────────────────────────────

/** D-182 §10 step 2 — every closed-kind Tier-K kernel op. Risk is verbatim from
 *  the backing ingredient file's `risk_tier`. Grouped by kernel domain (each
 *  must be a slice-2 `class: 'closed_kind'` domain). */
export const KERNEL_OP_REGISTRY: readonly KernelOpEntry[] = [
  // ── ai — the contracted functions; `core.ai.<fn>` → the `core-ai-<fn>`
  //    anti-shadow-fenced slug. `core.ai.embed` (D-174 R28) routes to the
  //    embeddings executor; the rest are chat. All `risk_tier: 'read'`.
  op('core.ai.classify', 'ai', 'core-ai-classify', 'read'),
  op('core.ai.compare', 'ai', 'core-ai-compare', 'read'),
  op('core.ai.embed', 'ai', 'core-ai-embed', 'read'),
  op('core.ai.extract', 'ai', 'core-ai-extract', 'read'),
  op('core.ai.generate', 'ai', 'core-ai-generate', 'read'),
  op('core.ai.prompt', 'ai', 'core-ai-prompt', 'read'),
  op('core.ai.rewrite', 'ai', 'core-ai-rewrite', 'read'),
  op('core.ai.score', 'ai', 'core-ai-score', 'read'),
  op('core.ai.sentiment', 'ai', 'core-ai-sentiment', 'read'),
  op('core.ai.summarize', 'ai', 'core-ai-summarize', 'read'),
  op('core.ai.translate', 'ai', 'core-ai-translate', 'read'),

  // ── mail — warehouse mail/email reads + the direct send.
  op('core.mail.get', 'mail', 'mail-get', 'read'),
  op('core.mail.body-read', 'mail', 'mail-body-read', 'read'),
  op('core.mail.thread-read', 'mail', 'mail-thread-reader', 'read'),
  op('core.mail.send', 'mail', 'mail-send', 'write'),
  /** D-210 §7 — notify a booking's visitor server-side. A sibling outbound send to
   *  `mail-send`, but the recipient (the visitor's SEALED email) is resolved by the
   *  dispatcher from the booking's own `reception_record_id`, never authored by
   *  the caller and never returned. `write` + the outbound-send lift, so it holds at
   *  the D-157 gate exactly like `mail-send` (the owner reviews the booking). */
  op('core.mail.notify-booking-visitor', 'mail', 'notify-booking-visitor', 'write'),
  /** D-207 slice 3d — the general no-resend fence, lifted out of D-200.
   *
   *  `write` because it settles the claim, but note what a caller CANNOT do with it:
   *  the op takes a reconciliation id and NOTHING else, derives the whole provider
   *  query from the server-written claim, and settles on the provider's VERDICT
   *  rather than a status the caller names. So there is no argument through which a
   *  forged `matched` could be smuggled — and a forged `matched` is the dangerous
   *  one, because it marks a document DELIVERED that was never sent. */
  op('core.mail.sent.reconcile', 'mail', 'mail-sent-reconcile', 'write'),
  op('core.mail.email.get', 'mail', 'email-get', 'read'),
  op('core.mail.email.list', 'mail', 'email-list', 'read'),
  op('core.mail.email.search', 'mail', 'email-search', 'read'),

  // ── contact — the personal contact graph.
  op('core.contact.resolve', 'contact', 'contact-resolve', 'read'),
  op('core.contact.business-context', 'contact', 'contact-business-context', 'read'),
  op('core.contact.upsert', 'contact', 'contact-upsert', 'write'),
  // D-187 slice 3b — NATIVE verb-op for the `recued_contactEngagementsList` MCP tool
  // (contact-rooted engagement evidence; D-139). No backing ingredient. OWNER-default-only
  // (sensitive — exposes a contact's engagement history): see OWNER_DEFAULT_ONLY_GRANT_ENTRIES.
  nativeOp('core.contact.engagements.read', 'contact', 'read'),

  // ── notification — the alert-dispatch surface; backed by the anti-shadow
  //    `core-notification-send` slug (bare `notification-send` is the alias).
  op('core.notification.send', 'notification', 'core-notification-send', 'write'),
  // A bounded, coalescing hint with a flat pointer/settings envelope to a
  // contract-bound MCP client. The transport adds no query result; the client
  // must call `query_tool` through the ordinary live token/contract gates, and
  // this op grants no read authority itself.
  op(
    'core.notification.recipe-callback',
    'notification',
    'core-notification-recipe-callback',
    'write',
  ),

  // ── work-entity — the note / task / commitment / project / booking entity CRUD.
  op('core.work-entity.note.create', 'work-entity', 'note-create', 'write'),
  op('core.work-entity.note.update', 'work-entity', 'note-update', 'write'),
  op('core.work-entity.note.delete', 'work-entity', 'note-delete', 'destructive'),
  op('core.work-entity.task.create', 'work-entity', 'task-create', 'write'),
  op('core.work-entity.task.update', 'work-entity', 'task-update', 'write'),
  op('core.work-entity.task.delete', 'work-entity', 'task-delete', 'destructive'),
  op('core.work-entity.task.mark-done', 'work-entity', 'task-mark-done', 'write'),
  op('core.work-entity.commitment.create', 'work-entity', 'commitment-create', 'write'),
  // D-192 F1 — the review-then-approve PROPOSAL surface: same mint effect as
  // commitment.create, but `commitment-propose` is in
  // COMMITMENT_PROPOSAL_INGREDIENT_SLUGS (op-risk-admission.ts), whose lift
  // raises admit → ask for EVERY actor — a proposal HOLDS at the D-157 gate
  // no matter who dispatches (invariant 3: the owner ratifies every capture).
  op('core.work-entity.commitment.propose', 'work-entity', 'commitment-propose', 'write'),
  op('core.work-entity.commitment.update', 'work-entity', 'commitment-update', 'write'),
  op('core.work-entity.commitment.cancel', 'work-entity', 'commitment-cancel', 'write'),
  op('core.work-entity.commitment.fulfill', 'work-entity', 'commitment-fulfill', 'write'),
  op('core.work-entity.project.create', 'work-entity', 'project-create', 'write'),
  op('core.work-entity.project.update', 'work-entity', 'project-update', 'write'),
  op('core.work-entity.project.archive', 'work-entity', 'project-archive', 'write'),
  // D-210 — booking. THREE verbs, not the commitment quartet: a booking's
  // lifecycle move rides `update` (which re-stamps `state_changed_at` only on a
  // real transition) rather than earning dedicated `-cancel` / `-fulfill` ops.
  // Commitment needs its own because its moves carry a state MACHINE the update
  // path deliberately refuses (§ A.1.3: lifecycle + due_status are not mutable
  // through `commitment-update`). A booking has no such machine — any state may
  // follow any other, because a real reservation genuinely does go
  // confirmed → cancelled → confirmed again.
  op('core.work-entity.booking.create', 'work-entity', 'booking-create', 'write'),
  op('core.work-entity.booking.update', 'work-entity', 'booking-update', 'write'),
  op('core.work-entity.booking.delete', 'work-entity', 'booking-delete', 'destructive'),
  op('core.work-entity.list', 'work-entity', 'work-entity-list', 'read'),
  op('core.work-entity.get', 'work-entity', 'work-entity-get', 'read'),
  /** NATIVE verb-op for the Tier-1 `work.search` + `work.read` tools — the READ
   *  half of this domain, which had no grant handle at all while all 15 writes
   *  above had one. No backing ingredient (the tools are registry-native, not
   *  recipe-runnable), so `nativeOp` — the same shape as `core.memory.read`
   *  (`memory.search`), the closest peer: a Tier-1 read over a governed store.
   *
   *  ONE op for BOTH tools on purpose: read is ONE risk (you see the row).
   *  `work.read` is `work.search` narrowed to an id you already hold, so a
   *  split would mint a grant pair no owner could meaningfully answer
   *  differently. Mirrors `core.memory.read` gating `memory.search` whole, and
   *  `core.memory.timeline.read` gating the timeline whole.
   *
   *  ⚠ This is the CAPABILITY axis only. WHICH kinds a door may see stays the
   *  D-205 `data.<kind>` collection grant (every `WorkEntityKind`
   *  ∈ READABLE_COLLECTIONS, derived), composed AND per `isGrantedReadAdmissible` — a
   *  collection grant does not imply the verb, and the verb does not imply a
   *  collection. Keeping them separate is what lets the grants panel keep
   *  labelling the DATA rows in the user's own vocabulary (`task`) while this
   *  row names the tool. `feedback_separate_authorization_axes`. */
  nativeOp('core.work-entity.read', 'work-entity', 'read'),

  // ── memory — the provenance / audit / annotation + links graph + timeline
  //    (CLAUDE.md: data.memory = audit/memory + provenance links + annotations).
  op('core.memory.annotation.create', 'memory', 'annotation-create', 'write'),
  op('core.memory.annotation.delete', 'memory', 'annotation-delete', 'write'),
  op('core.memory.annotation.list', 'memory', 'annotation-list', 'read'),
  op('core.memory.annotation.search', 'memory', 'annotation-search', 'read'),
  op('core.memory.link.create', 'memory', 'link-create', 'write'),
  op('core.memory.link.delete', 'memory', 'link-delete', 'write'),
  op('core.memory.link.list', 'memory', 'link-list', 'read'),
  op('core.memory.timeline.read', 'memory', 'timeline-read', 'read'),
  op('core.memory.annotate', 'memory', 'data-annotate', 'write'),
  op('core.memory.link', 'memory', 'data-link', 'write'),
  // D-187 slice 3b — NATIVE verb-op for the `recued_getAudit` MCP tool (run-history /
  // audit-log read). No backing ingredient. OWNER-default-only (sensitive — run history
  // reveals the owner's automation activity): see OWNER_DEFAULT_ONLY_GRANT_ENTRIES.
  // D-198 follow-on — RUN HISTORY is its own domain (`audit`), not "memory".
  // Renamed from `core.memory.audit.read`: the old id was a D-120 fossil (back
  // then "memory" MEANT the provenance substrate) that made an audit grant look
  // like part of the D-198 knowledge-pool family in the grant surface. Pre-launch
  // → renamed outright, no migration (`feedback_pre_launch_no_migration`).
  nativeOp('core.audit.read', 'audit', 'read'),
  // D-198 Slice 4 — NATIVE verb-ops for contract-governed collective memory: a
  // contracted AI / customer WRITES memory (`memory.write` primitive / chat tool)
  // or READS the shared pool (`memory.search` / `memory.recall`) only when the
  // contract grants it. No backing ingredient (middleware primitive / chat tool,
  // not recipe-runnable). Both are OWNER-default-only (ON for owner, OFF for every
  // door by default — the seller opts a tier in per §3): see
  // OWNER_DEFAULT_ONLY_GRANT_ENTRIES.
  nativeOp('core.memory.write', 'memory', 'write'),
  nativeOp('core.memory.read', 'memory', 'read'),

  // ── data — typed warehouse collections plus accepted free-form responses.
  op('core.data.enrichment.upsert', 'data', 'enrichment-upsert', 'write'),
  op('core.data.enrichment.list', 'data', 'enrichment-list', 'read'),
  // D-187 grant-foundation slice 3 — NATIVE verb-ops (no backing ingredient, not
  // recipe-runnable): grant handles for the three MCP-server-native enrichment
  // read tools, so the amendment §3 read gate can gate the VERB (`verb-op ∧
  // entry`), not just the per-topic entry. `core.data.enrichment.read` ←
  // `recued_enrichmentRead`; `.vector-search` ← `recued_vectorSimilaritySearch`;
  // `.describe` ← `recued_registryDescribe` (the enrichment-registry catalog).
  // All `risk: read` (approval never). Channel-agnostic ids — these are NOT named
  // after the MCP transport (the verb-op travels with the tool regardless of
  // channel; Fork B). DISTINCT from the recipe-runnable `core.data.enrichment.list`
  // above (which lowers to `enrichment-list`); these have no lowering target.
  // (timeline's verb-op is the existing `core.memory.timeline.read`.)
  nativeOp('core.data.enrichment.read', 'data', 'read'),
  nativeOp('core.data.enrichment.vector-search', 'data', 'read'),
  nativeOp('core.data.enrichment.describe', 'data', 'read'),
  op('core.data.calendar.get', 'data', 'calendar-get', 'read'),
  op('core.data.calendar.list', 'data', 'calendar-list', 'read'),
  op('core.data.calendar.search', 'data', 'calendar-search', 'read'),
  op('core.data.calendar.stat', 'data', 'calendar-stat', 'read'),
  op('core.data.calendar.create', 'data', 'calendar-create', 'write'),
  op('core.data.calendar.update', 'data', 'calendar-update', 'write'),
  op('core.data.calendar.delete', 'data', 'calendar-delete', 'destructive'),
  op('core.data.calendar.rsvp', 'data', 'calendar-rsvp', 'write'),
  // Accepted intake responses carry arbitrary visitor-authored values. The
  // operation is recipe-runnable, but its author default is owner-only (see
  // OWNER_DEFAULT_ONLY_GRANT_ENTRIES) and its dispatch scope is additionally
  // fenced to the exact `data.form_response` collection.
  op('core.data.form-response.list', 'data', 'form-response-list', 'read'),
  op('core.data.form-response.get', 'data', 'form-response-get', 'read'),
  // D-210 A.8 slice 2 — advance the owner-authored lifecycle. Named
  // `set-state`, NOT `update`: it can change `lifecycle_state` and nothing
  // else, and a model reading `update` would go looking for the answer fields
  // it cannot touch. The same reason the `booking-*` manifests state what they
  // do not carry (see internal design notes).
  op('core.data.form-response.set-state', 'data', 'form-response-set-state', 'write'),
  op('core.data.webhook.get', 'data', 'webhook-get', 'read'),
  op('core.data.webhook.list', 'data', 'webhook-list', 'read'),

  // D-201 Slice 4 — run-scoped accepted-event read. The backing ingredient
  // accepts only an opaque event ref; engine-only StepMeta supplies the recipe
  // and run identities used by the consumer-binding authorization check.
  op('core.webhook.event.get', 'webhook', 'webhook-event-get', 'read'),

  // ── peer — D-234 § 234.4, what this server offers another server's OWNER.
  //
  // ⛔ `write` RISK IS LOAD-BEARING, NOT A GUESS. A write-tier op pauses for the
  // owner's approval, and declaring yourself answerable to a peer is exactly a
  // decision they should see before it takes effect — the exposure is what turns
  // "we are connected" into "they may put questions on my screen". Getting the
  // owner into that loop is free at this tier and would need inventing at `read`.
  // D-234 § 234.4 — THE ASKING HALF. ⛔ `write` RISK, and it is not a formality:
  // this op puts a question on ANOTHER PERSON'S SCREEN and suspends the run until
  // they answer. Spending someone else's attention is an outward action, and the
  // owner should see it proposed before it leaves — the same tier that gates a
  // mail send, for the same reason.
  op('core.peer.ask', 'peer', 'peer-ask', 'write'),
  // D-234 § 234.4 — THE INBOUND DOOR, as a NATIVE verb-op.
  //
  // ⛔⛔ NATIVE, NOT RECIPE-BACKED, AND THE FIRST CUT GOT THIS WRONG. It shipped
  // as a bundled kernel recipe, and the live drive found that a peer's call could
  // never resolve: `mcp-server` looks an incoming tool name up in `recipeStore`,
  // and bundled kernel recipes are deliberately never in it. That resolution
  // failure was the architecture saying the VEHICLE was wrong.
  //
  // 🔑 AND THE OWNER'S ARGUMENT IS THE REAL ONE: if the receiver's whole job is
  // to raise an ask and answer it, a recipe makes the door CONDITIONAL ON AN
  // INSTALL — it exists only where someone happened to add a pack. That is
  // exactly what putting this in core is meant to avoid. A recipe earns its place
  // when the receiver DOES something (write, store, act), and that is `peer.run`.
  // Native means every Recued server can answer a peer out of the box.
  //
  // ⇒ It also removes the § 234.1 ceiling exemption entirely rather than
  // justifying it: a native verb is not a recipe dispatch, so the recipe
  // admission ceiling never applies and EXPOSURE is the only gate — one door,
  // not two with a bridge between them.
  // ⚠ THE ONLY NATIVE OP WITH AN `mcp_tool`, and the asymmetry is the point:
  // every other native verb-op above is a per-contract READ grant consulted
  // through `ReadGrantChecker`, never a per-token checklist entry. This one is a
  // DOOR a peer calls, so the token that reaches it has to be able to name it —
  // and until this field the only name the mint accepted was one the gate never
  // read. See {@link KernelOpEntry.mcp_tool}.
  nativeOp('core.peer.receive-ask', 'peer', 'write', 'recued_peerAsk'),
  // D-234 § 234.4 — THE RETURN LEG'S DOOR: where the peer's ANSWER comes back.
  //
  // ⛔ A SEPARATE OP FROM `receive-ask`, NOT A MODE ON IT, because the two admit
  // on DIFFERENT evidence and an owner must be able to hold one without the
  // other. `receive-ask` is gated by EXPOSURE — a standing "you may put questions
  // to me". This one is gated by CORRELATION: we must have asked THIS ref, and
  // the answer must arrive from the contract the connection we asked through is
  // bound to. A peer that was never exposed can still answer a question we sent
  // them, and a peer we exposed to cannot push an answer we never solicited.
  // Folding them into one op would make each grant carry the other's authority.
  //
  // ⚠ `write` because it resumes a suspended run of the owner's; see
  // `isSelfGatedNativeMcpTool` for why the synchronous-path ceiling is
  // substituted rather than applied — § 234.2 already ruled that the reply you
  // asked for needs no prompt.
  nativeOp('core.peer.receive-answer', 'peer', 'write', 'recued_peerAnswer'),
  // ⛔⛔ D-234 § 234.4j — `core.peer.expose` / `.revoke` / `.exposures` USED TO SIT
  // HERE AND WERE DELETED. They wrote a `peer_exposures` table saying "this peer
  // may ask me things under this label" — which is the SAME QUESTION the peer's
  // contract already answers, in a second store with no UI. `peer.label.<label>`
  // on the contract grant is the one gate now; `admitPeerAsk` reads it directly.
  // Do not re-add a per-peer flag store: the contract IS the flag store.

  // ── storage — the generic KV / blob surface (data.shared + data.file).
  op('core.storage.shared.write', 'storage', 'shared-write', 'write'),
  op('core.storage.shared.compare-and-set', 'storage', 'shared-compare-and-set', 'write'),
  op('core.storage.shared.read', 'storage', 'shared-read', 'read'),
  // D-232 § 23 — the asker's own question. `output.exchange` returns a ref, and
  // until this op the ref addressed nothing a RECIPE could query: the audit
  // lookup behind it was wired only to the AI door, so a model could ask what
  // happened to an exchange and the recipe that started it could not.
  // ⚠ `read` risk and grantable (§ 20.20): naming a ref you already hold and
  // being told whether it was delivered confers nothing.
  // ⚠ NAMED UNDER `storage`, not a new `exchange` domain — the registry asserts
  // at BOOT that an op's domain segment is a registered closed kind, and caught
  // both halves of getting this wrong in turn. The backing ingredient's own
  // `kind` is `storage` and the answer is an audit read, so `storage` is the
  // honest home rather than a domain invented for one op.
  op('core.storage.exchange.status', 'storage', 'exchange-status', 'read'),
  op('core.storage.shared.delete', 'storage', 'shared-delete', 'write'),
  op('core.storage.shared.delete-prefix', 'storage', 'shared-delete-prefix', 'destructive'),
  op('core.storage.shared.list', 'storage', 'shared-list', 'read'),
  op('core.storage.shared.search', 'storage', 'shared-search', 'read'),
  op('core.storage.file.read', 'storage', 'file-read', 'read'),
  op('core.storage.file.write', 'storage', 'file-write', 'write'),
  op('core.storage.file.delete', 'storage', 'file-delete', 'destructive'),
  op('core.storage.file.get', 'storage', 'file-get', 'read'),
  op('core.storage.file.list', 'storage', 'file-list', 'read'),
  op('core.storage.file.move', 'storage', 'file-move', 'destructive'),
  op('core.storage.file.stat', 'storage', 'file-stat', 'read'),
  // D-185 Slice 4 — the explicit temp→cas keep step: ingest a run-scoped temp
  // file_ref's bytes into data.file.received, returning a durable cas_ref.
  op('core.storage.file.persist', 'storage', 'file-persist', 'write'),
  // D-200 Slice 3 — strict deterministic Markdown substitution from one
  // durable template file ref to one run-scoped temp file ref.
  op(
    'core.storage.file.render-markdown-template',
    'storage',
    'file-render-markdown-template',
    'write',
  ),
  // D-173 P5 (scan-gate part B) — the post-scan write-back: patch a
  // data.file.received record's scan_status hot field to a local scanner's
  // verdict. MCP-reserved (the backing kernel ingredient is not in
  // `MCP_EXPOSED_KERNEL_INGREDIENTS`) — only the reactive scan recipe writes it.
  op('core.storage.file.set-scan-status', 'storage', 'file-set-scan-status', 'write'),
  op('core.storage.data-file-read', 'storage', 'data-file-read', 'read'),

  // ── schedule — D-193 installed-recipe scheduling control plane.
  //    Creates recurring or one-shot rows for recipes already installed in the
  //    local RecipeStore. Write risk because it arms autonomous future execution.
  op('core.schedule.recipe', 'schedule', 'schedule-recipe', 'write'),

  // ── seller — core-owned commerce registry. Recipes can establish and read
  //    fixed-shape offers, but only Seller owns the DB/schema/menu/UI and the
  //    operation vocabulary. Ensure creates drafts only; attach-fulfillment is
  //    a one-way creator-recipe self-link, never arbitrary definition or
  //    transaction editing. Pack provenance never grants identity or mutation
  //    authority.
  op('core.seller.offer.ensure', 'seller', 'seller-offer-ensure', 'write'),
  op(
    'core.seller.offer.attach-fulfillment',
    'seller',
    'seller-offer-attach-fulfillment',
    'write',
  ),
  op('core.seller.offer.get', 'seller', 'seller-offer-get', 'read'),
  op('core.seller.offer.list', 'seller', 'seller-offer-list', 'read'),

  // ── seller.order — D-207 §4.3, the money leg. One purchase of one offer.
  //
  //    ⛔ `open` names WHICH offer, never WHAT it costs: it takes an `offer_id`
  //    and reads the commerce terms from the offer row. No operation here accepts
  //    an amount, so no visitor value can become a price. That absence is what
  //    replaces D-200's `isLiteralIntentStep` — and unlike it, it generalizes.
  //
  //    ⛔ `paid` and `refunded` assert that MONEY MOVED, so `transition` cannot
  //    reach them. The lifecycle graph legitimately contains
  //    `awaiting_payment -> paid` (confirm-payment needs that edge), so a
  //    graph-only check would let a recipe mark an order paid with no provider
  //    evidence and then fulfil — a free document. They are writable only by
  //    their source-truth operation, enforced at the storage boundary.
  //
  //    Every write here resolves to `ask` (the enforced `RISK_APPROVAL_FLOOR`),
  //    so on a
  //    public reception door — where D-207 slice 1a pins `anonymous` to a `read`
  //    ceiling — they all HOLD. That is intended: under the slice-3 ruling the
  //    anonymous channel performs no writes at all. It renders a link to the
  //    owner's pre-created checkout, and payment confirmation arrives on the
  //    `webhook` channel, which carries owner authority.
  op('core.seller.order.open', 'seller', 'seller-order-open', 'write'),
  op('core.seller.order.get', 'seller', 'seller-order-get', 'read'),
  op('core.seller.order.list', 'seller', 'seller-order-list', 'read'),
  op('core.seller.order.quote', 'seller', 'seller-order-quote', 'write'),
  op(
    'core.seller.order.attach-payment',
    'seller',
    'seller-order-attach-payment',
    'write',
  ),
  op(
    'core.seller.order.confirm-payment',
    'seller',
    'seller-order-confirm-payment',
    'write',
  ),
  //    D-196 renewal — the second specialized `paid` writer. A renewal order is
  //    keyed on the provider invoice that caused it (`origin_kind:
  //    'provider_invoice'`), and no provider object ever carries ITS handle —
  //    Stripe mints renewal invoices autonomously — so the session-shaped
  //    confirm's correlation fence cannot be satisfied honestly. This op's
  //    correlation is structural instead: the evidence invoice must be the
  //    order's own origin_ref, and the acquisition order recovered from
  //    provider-read subscription metadata must exist with the same offer and
  //    entitlement snapshot. All enforced at the storage boundary (F5).
  op(
    'core.seller.order.confirm-renewal-payment',
    'seller',
    'seller-order-confirm-renewal-payment',
    'write',
  ),
  op(
    'core.seller.order.confirm-refund',
    'seller',
    'seller-order-confirm-refund',
    'write',
  ),
  op(
    'core.seller.order.attach-artifact',
    'seller',
    'seller-order-attach-artifact',
    'write',
  ),
  op('core.seller.order.transition', 'seller', 'seller-order-transition', 'write'),
  op(
    'core.seller.order.link-work-entity',
    'seller',
    'seller-order-link-work-entity',
    'write',
  ),
  //    §4.5 — binds a paid order to the seller customer its fulfilment issued.
  //    `order.open` already accepts a `customer_id` (a renewal's customer exists
  //    before its order does); an ACQUISITION order is opened at checkout, before
  //    `customer-access.issue` mints the customer, so without this the money↔access
  //    edge would be one-way and unbackfillable.
  op(
    'core.seller.order.link-customer',
    'seller',
    'seller-order-link-customer',
    'write',
  ),

  // ── seller.tier — D-196 §4.5 ingress: the vendor-neutral tier read. The tier
  //    row was ALWAYS the vendor bridge (`lifecycle_source` +
  //    `external_entitlement_id` + `entitlement_key`, UNIQUE on
  //    `(door_id, lifecycle_source, entitlement_key)`) — it just had no
  //    recipe-facing read, which is what kept pushing the tier's home into
  //    fields that were never its to carry. Reads return the PUBLIC projection
  //    only (`SellerTierPublic`): never `template_contract_id` (I-1 — the op
  //    family takes an entitlement key and the server resolves the template,
  //    so no recipe can name tools/scopes), and never a tier row id (the KEY
  //    is the recipe-facing identity; it survives a re-sync, row ids do not).
  op('core.seller.tier.get', 'seller', 'seller-tier-get', 'read'),
  op('core.seller.tier.list', 'seller', 'seller-tier-list', 'read'),

  // ── seller.customer-access — D-196 seller-customer lifecycle control plane.
  //    These mutate local seller customers, customer-instance contracts, and
  //    inbound MCP tokens. Write risk: issue/extend/swap/close all change a
  //    customer's access posture.
  //
  //    D-207 §4.5 — these four moved from `core.customer-access.*` into the
  //    `seller` domain: a subscription is a seller transaction, and parking it
  //    in its own top-level domain left two seller substrates that could not
  //    name each other. The op PATH moved; the backing capability slug
  //    (`customer-access-*`) is deliberately unchanged. Pre-launch, zero
  //    installs and zero stored grant rows carry the old ids → renamed
  //    outright, no compat shim.
  op('core.seller.customer-access.issue', 'seller', 'customer-access-issue', 'write'),
  op('core.seller.customer-access.extend', 'seller', 'customer-access-extend', 'write'),
  op(
    'core.seller.customer-access.swap-tier',
    'seller',
    'customer-access-swap-tier',
    'write',
  ),
  op('core.seller.customer-access.close', 'seller', 'customer-access-close', 'write'),

  // ── customer — D-196 customer self-service. Native read op: no backing
  //    ingredient, not recipe-runnable, resolved strictly from the caller's
  //    bound seller customer context by the MCP transport.
  nativeOp('core.customer.status', 'customer', 'read'),

  // ── watch — D-182 trigger-position kernel ops. Each backs a reactive
  //    `trigger_steps` gate (D-115) and lowers to a kernel watcher ingredient
  //    routed through the server's `KernelDispatchers.watcher` slot, producing a
  //    `should_run` gate. The op id is the `KernelWatcherSlug` minus the
  //    `-watcher` suffix (`time-relative-watcher` → `core.watch.time-relative`).
  //    All `risk: read` — but ⛔⛔ NOT because none make a side effect, which is
  //    what this comment used to claim and is FALSE. `webhook-watcher` DELETES the
  //    queue it returns (`watchers/webhook-watcher.ts` — drain-on-read), and
  //    `time-relative-watcher` MUTATES firing state. Both were found by a Codex
  //    review of D-228, 2026-07-31.
  //
  //    🔑 They stay `read` because this is the TRIGGER position and `risk` here
  //    feeds the APPROVAL gate (`admitByOpRisk`: read→admit, write/admin→ask,
  //    destructive→always). A trigger predicate is evaluated every tick, so any
  //    asking tier makes it nonfunctional — `core.watch.time-relative` alone backs
  //    5 shipped recipes, which a bump to `write` would have broken. Raising the
  //    tier was tried and reverted for exactly that reason.
  //
  //    ✅ THE WEBHOOK DRAIN IS FIXED (2026-07-31) — and NOT by making the read
  //    non-destructive, which an earlier note here wrongly prescribed. The
  //    DESTRUCTIVE drain is correct: it is the at-most-once consume that stops a
  //    webhook re-firing on every tick. What was wrong is WHOSE queue a caller
  //    could name — `recipe_id` was ordinary authored input, so one recipe could
  //    drain another's queue, reading its headers / body / source IP and leaving
  //    the owner to miss those deliveries. The kernel adapter now injects the
  //    trusted `stepMeta.recipe_id` (`packages/ingredients/src/kernel.ts`),
  //    exactly as it already did for `time-relative-watcher`'s firing ledger.
  //    ⚠ Residual, pinned by test: a caller with NO engine context (the
  //    `runtime.runWatcher` pair-rpc, which no client calls today) still supplies
  //    its own id.
  //
  //    ⛔ Either way it was never a tiering question. `risk_tier` cannot express
  //    "reads someone else's queue and empties it"; binding the identity can. Do
  //    not re-tier these to paper over such a thing: the tier would be wrong on
  //    the approval axis in order to be right on an axis it does not represent —
  //    the same mistake slice 2 made with MCP exposure, which is now the authored
  //    `mcp_exposed` field instead.
  //
  //    Connection-less closed-kind: the mail/calendar/file
  //    watchers read warehouse state (like `core.mail.email.list`), http-watcher
  //    polls an args-supplied URL — none bind a per-instance connection. (There is
  //    NO `core.watch.dom`: DOM watching is not a server-local watcher — it runs
  //    through the D-179 reactive watch-poll source, which reads via the paired
  //    Bridge; see `backend` `watch/dom-source.ts`. The inert D-115 `dom-watcher`
  //    kernel slug + this op were removed.)
  op('core.watch.time', 'watch', 'time-watcher', 'read'),
  op('core.watch.time-relative', 'watch', 'time-relative-watcher', 'read'),
  op('core.watch.mail', 'watch', 'mail-watcher', 'read'),
  op('core.watch.calendar', 'watch', 'calendar-watcher', 'read'),
  op('core.watch.file', 'watch', 'file-watcher', 'read'),
  op('core.watch.http', 'watch', 'http-watcher', 'read'),
  op('core.watch.recipe', 'watch', 'recipe-watcher', 'read'),
  op('core.watch.webhook', 'watch', 'webhook-watcher', 'read'),

  // ── dom — D-182 "core.dom" close-out. The Bridge-actuated DOM action ops
  //    (SEQUENTIAL-position — a recipe step, not a trigger watcher).
  //    They lower (closed-kind path) to the kernel `dom-read` / `dom-write`
  //    ingredients dispatched through the server's `dom` slot (BridgeDomAdapter),
  //    which builds the BridgeCommand from the op ARGS — `core.dom.read(target,
  //    selector)` → a `read_dom` command → `{ text }`; `core.dom.write(target,
  //    selector, value, submit_selector?)` → a `fill` (+ optional `enter`) →
  //    `{ written, fields, failed }`. No manifest selector map (the Bridge is the
  //    uniform executor); `target` is the actuation domain, gated by op risk +
  //    the Bridge domain_allowlist. read → never, write → ask. Both are
  //    `SERVER_NOT_REACHABLE`-class without a paired Bridge (extension-actuated).
  op('core.dom.read', 'dom', 'dom-read', 'read'),
  op('core.dom.write', 'dom', 'dom-write', 'write'),
];

// ────────────────────────────────────────────────────────────────
// load-time integrity assertion + lookup index
// ────────────────────────────────────────────────────────────────

/** Asserts the registry's structural invariants once at module load (mirrors
 *  slice-2's `assertConnectionVendorRegistry`). Throws on the first violation so
 *  a bad entry never ships:
 *   1. every `op` parses as a kernel op whose `domain` equals `entry.domain`
 *      (pins SLUG_RE legality + catches a domain mismatch);
 *   2. that domain is a registered slice-2 `class: 'closed_kind'` domain
 *      (rejects a stray `core.crm.*`/`core.acct.*` convention op + unknown
 *      domains) — applies to native ops too (they live in a closed-kind domain);
 *   3. backing_slug rule — an ORDINARY op carries a non-empty `backing_slug`
 *      (the manifest-loader target); a NATIVE op (`native: true`, D-187 slice 3)
 *      carries NONE (it has no backing ingredient + no lowering target);
 *   4. op ids are unique;
 *   5. backing slugs are unique among ORDINARY ops (so the slice-2b backing_slug
 *      → op reverse map can't silently drop a colliding entry). Native ops carry
 *      no slug, so they are exempt — many native ops legitimately "share" the
 *      absent slug. */
export const assertKernelOpRegistry = (
  registry: readonly KernelOpEntry[] = KERNEL_OP_REGISTRY,
): void => {
  const seen = new Set<string>();
  const slugToOp = new Map<string, string>();
  for (const e of registry) {
    const parsed = parseOpId(e.op);
    if (parsed === null || parsed.tier !== 'kernel') {
      throw new Error('kernel-op-registry: malformed kernel op id ' + JSON.stringify(e.op));
    }
    if (parsed.domain !== e.domain) {
      throw new Error(
        'kernel-op-registry: op ' + JSON.stringify(e.op) + ' domain segment ' +
          JSON.stringify(parsed.domain) + ' != declared domain ' + JSON.stringify(e.domain),
      );
    }
    const dom = getKernelDomain(e.domain);
    if (dom === undefined || dom.class !== 'closed_kind') {
      throw new Error(
        'kernel-op-registry: op ' + JSON.stringify(e.op) +
          ' domain is not a registered closed-kind kernel domain: ' + JSON.stringify(e.domain),
      );
    }
    if (e.native === true) {
      // A native verb-op (MCP-native read tool grant handle) has NO backing
      // ingredient — it must not declare a backing_slug (else a stray slug would
      // wrongly enter the reverse map / suggest a lowering target that doesn't
      // exist). D-187 slice 3.
      if (e.backing_slug !== undefined) {
        throw new Error(
          'kernel-op-registry: native op ' + JSON.stringify(e.op) +
            ' must not declare a backing_slug (no backing ingredient)',
        );
      }
    } else if (typeof e.backing_slug !== 'string' || e.backing_slug.length === 0) {
      throw new Error(
        'kernel-op-registry: op ' + JSON.stringify(e.op) + ' has an empty backing_slug',
      );
    }
    if (seen.has(e.op)) {
      throw new Error('kernel-op-registry: duplicate op id ' + JSON.stringify(e.op));
    }
    seen.add(e.op);
    // slice 2b — backing slugs must be unique too, checked AFTER op-id
    // uniqueness so a fully-duplicate entry reports as a duplicate op id (the
    // existing contract). This guards only genuinely-distinct ops sharing one
    // backing slug, which would silently collide the backing_slug → op reverse
    // map (`KERNEL_OP_BY_BACKING_SLUG`). NATIVE ops carry no slug (item 3 above
    // proved `backing_slug === undefined`) and are exempt — they never enter the
    // reverse map, so many can coexist.
    if (e.native !== true && e.backing_slug !== undefined) {
      const slugOwner = slugToOp.get(e.backing_slug);
      if (slugOwner !== undefined) {
        throw new Error(
          'kernel-op-registry: backing_slug ' + JSON.stringify(e.backing_slug) +
            ' is shared by ops ' + JSON.stringify(slugOwner) + ' and ' + JSON.stringify(e.op) +
            ' — backing slugs must be unique (the reverse map would collide)',
        );
      }
      slugToOp.set(e.backing_slug, e.op);
    }
  }
};

assertKernelOpRegistry();

const KERNEL_OP_BY_ID: ReadonlyMap<string, KernelOpEntry> = new Map(
  KERNEL_OP_REGISTRY.map((e) => [e.op, e]),
);

/** Grant-foundation slice 2b — the reverse of {@link kernelOpBackingSlug}:
 *  backing kernel ingredient slug → its `core.*` op id. Built only after
 *  `assertKernelOpRegistry` proved backing slugs unique (assertion item 6), so a
 *  colliding slug can never silently drop an entry here. NATIVE ops (D-187 slice
 *  3) carry no backing slug, so they are excluded — a native verb-op can never be
 *  recovered/dispatched as a simple-form kernel slug. */
const KERNEL_OP_BY_BACKING_SLUG: ReadonlyMap<string, string> = new Map(
  KERNEL_OP_REGISTRY.flatMap((e) =>
    e.native !== true && e.backing_slug !== undefined
      ? [[e.backing_slug, e.op] as const]
      : [],
  ),
);

// ────────────────────────────────────────────────────────────────
// lookup helpers
// ────────────────────────────────────────────────────────────────

/** Resolve a Tier-K closed-kind op id to its registry entry; undefined for an
 *  unregistered / non-closed-kind / malformed id. (The canonical-convention ops
 *  `core.crm.*` / `core.acct.*` are NOT here — slice 2 handles them
 *  verb-derived.) */
export const getKernelOp = (opId: string): KernelOpEntry | undefined => KERNEL_OP_BY_ID.get(opId);

/** D-232 § 20.20 — the kernel ops a DOOR may never be granted directly.
 *
 *  ⛔ THIS IS A USEFULNESS FENCE, NOT A SAFETY ONE, and the distinction is the
 *  whole point. Everything dangerous on this registry stays GRANTABLE and is
 *  gated by RISK — `core.data.calendar.delete` is `destructive`, `core.dom.write`
 *  actuates the owner's browser, and both remain grantable because invasive is a
 *  reason to GATE, not a reason to make un-nameable. What is excluded here is
 *  excluded because granting it accomplishes nothing for the holder.
 *
 *  Two classes, plus one hazard:
 *
 *  1. `core.ai.*` — a door IS an LLM, so granting it `summarize` asks the owner's
 *     model to do what the caller already does. 🔑 And the real reason is SPEND:
 *     every call runs on the owner's free-pool quota or BYOK key, so the grant
 *     transfers COST, not capability. ⚠ A RECIPE using `ai-*` internally is
 *     untouched — this governs only what a door may call DIRECTLY.
 *
 *  2. `core.watch.*` — a watcher is a TRIGGER EVALUATOR the engine runs against
 *     its own cursor state to answer "should this run fire". A door calling one
 *     receives a verdict, not data. ⇒ And excluding them forecloses no future
 *     push capability, because push is the opposite DIRECTION from a grant: a
 *     grant says what a door may CALL, a callback says what the server may SEND.
 *     That path already exists (see 3).
 *
 *  3. `core.notification.recipe-callback` — how a RECIPE pushes a pointer to a
 *     door. A DOOR holding it could queue notifications at OTHER doors: no use to
 *     the caller, and a small cross-door hazard. Excluded from direct grant,
 *     untouched for recipes.
 *
 *  ⚠ Deliberately NOT excluded, though each was considered:
 *  `core.mail.sent.reconcile` / `core.storage.file.set-scan-status` (internal
 *  bookkeeping — no use, but both are `write` and therefore already ask, so
 *  excluding them would be tidiness posing as safety), and `core.dom.*` (a door
 *  driving the owner's browser is a REAL capability to offer, gated by risk). */
export const KERNEL_OP_GRANT_EXCLUSIONS: ReadonlySet<string> = new Set(
  KERNEL_OP_REGISTRY
    .filter((e) => e.domain === 'ai' || e.domain === 'watch')
    .map((e) => e.op)
    .concat(['core.notification.recipe-callback']),
);

/** D-232 § 20.20 — may a door be granted this kernel op directly? True for every
 *  registered op outside {@link KERNEL_OP_GRANT_EXCLUSIONS}, including the
 *  destructive ones: risk gates them, grantability does not.
 *
 *  ⛔ Derived from the registry, never a hand-listed allowlist. A kernel op added
 *  tomorrow is grantable by default, which is the correct direction for a
 *  USEFULNESS fence — the failure mode of forgetting to add one is "the owner
 *  cannot grant something useful", not "a door reaches something it should not".
 *  The reverse (a hand-listed grantable set) would fail the other way. */
export const isGrantableKernelOp = (opId: string): boolean =>
  KERNEL_OP_BY_ID.has(opId) && !KERNEL_OP_GRANT_EXCLUSIONS.has(opId);

/** True iff `opId` is a registered closed-kind kernel op (ordinary OR native).
 *  Use {@link isNativeKernelOp} to exclude native verb-ops where recipe
 *  runnability matters (a native op is registered but NOT recipe-runnable). */
export const isRegisteredKernelOp = (opId: string): boolean => KERNEL_OP_BY_ID.has(opId);

/** D-187 grant-foundation slice 3 — true iff `opId` is a registered NATIVE
 *  verb-op (an MCP-native read-tool grant handle with no backing ingredient,
 *  {@link KernelOpEntry.native}). These are grantable per-contract `op` entries
 *  but NOT recipe-runnable, so the op-step save check rejects them as steps. */
/** D-234 § 234.4 — the static MCP tool name → native verb-op id map, built once
 *  from the registry. Empty for every tool with no native op behind it. */
const KERNEL_OP_BY_MCP_TOOL: ReadonlyMap<string, string> = new Map(
  KERNEL_OP_REGISTRY
    .filter((e): e is KernelOpEntry & { mcp_tool: string } => e.mcp_tool !== undefined)
    .map((e) => [e.mcp_tool, e.op] as const),
);

/** The native verb-op a static MCP tool is reached through, or undefined when
 *  the tool fronts no kernel op ({@link KernelOpEntry.mcp_tool}).
 *
 *  ⇒ The per-token checklist uses this to accept EITHER name: the tool the
 *  caller invoked, or the op id the owner actually granted at mint time. Without
 *  it the two vocabularies never meet and the op-id grant is inert — see the
 *  field doc for how that failed silently. */
export const kernelOpForMcpTool = (tool_name: string): string | undefined =>
  KERNEL_OP_BY_MCP_TOOL.get(tool_name);

export const isNativeKernelOp = (opId: string): boolean =>
  KERNEL_OP_BY_ID.get(opId)?.native === true;

/** All registered ops in a domain (empty for an unknown / convention-only
 *  domain). */
export const kernelOpsInDomain = (domain: string): KernelOpEntry[] =>
  KERNEL_OP_REGISTRY.filter((e) => e.domain === domain);

/** The backing kernel ingredient slug for a registered op (the manifest-loader
 *  resolution target); undefined when unregistered. */
export const kernelOpBackingSlug = (opId: string): string | undefined =>
  KERNEL_OP_BY_ID.get(opId)?.backing_slug;

/** Grant-foundation slice 2b — the inverse of {@link kernelOpBackingSlug}:
 *  resolve a kernel backing ingredient slug (the simple-form lowering target a
 *  `core.*` op dispatches as, e.g. `mail-send`) back to its fully-qualified
 *  `core.*` op id (`core.mail.send`); undefined for a slug backing no registered
 *  kernel op. The Gateway admission path uses this to recover the op id for a
 *  simple-form `core.*` dispatch (which carries no surface op key), so an
 *  op-scoped standing contract can match the kernel op on the op axis. */
export const kernelOpForBackingSlug = (slug: string): string | undefined =>
  KERNEL_OP_BY_BACKING_SLUG.get(slug);
