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
/** ⛔⛔ WHAT AN OP REACHES — the axis the Contracts panel groups by, so an owner
 *  answers "what can touch my files?" by reading ONE section instead of recognising
 *  a naming convention across three tabs.
 *
 *  ⛔ IT IS AN ANNOTATION, NOT A PARSE, AND THAT IS THE WHOLE POINT. The entity is
 *  NOT recoverable from the op id: its segment position varies by domain —
 *  `core.mail.send` (2), `core.memory.read` (2), `core.contact.upsert` (2) versus
 *  `core.data.calendar.get` (3), `core.storage.file.read` (3) — and several ops
 *  reach something their id does not name at all (`core.storage.csv.*` and
 *  `core.storage.data-file-read` reach FILES; `core.storage.exchange.status`
 *  reaches PEER; `core.customer.status` is SELLER). A prefix parser would put those
 *  five in the wrong group while looking right, and a mis-grouped op is a permission
 *  an owner revokes believing it covered something else.
 *
 *  ⚠ TWO KINDS LIVE IN ONE LIST, DELIBERATELY. Most members are DATA the owner holds
 *  (`mail` / `file` / `memory` / …). Four are CAPABILITIES with no stored entity
 *  behind them — `ai` (calls a model), `browser` (drives the Bridge's DOM),
 *  `schedule` (arms a cron), `watch` (declares a trigger). Splitting them into a
 *  second field would buy a distinction no owner is asking about; forcing them to a
 *  `'none'` bucket would dump 22 ops into one undifferentiated heap, which is worse
 *  for the reader than the mild category impurity. The panel renders both as groups.
 *
 *  ⚠ `notification` and `peer` are data-ish, `seller` spans an entire subsystem —
 *  the test is "would an owner look for this op under this heading", not taxonomy. */
export const OP_ENTITIES = [
  // data the owner holds
  'mail', 'calendar', 'contact', 'file', 'shared', 'memory', 'audit',
  'enrichment', 'work', 'form_response', 'webhook', 'peer', 'seller',
  'notification', 'recall',
  // capabilities with no stored entity behind them
  'ai', 'browser', 'schedule', 'watch',
  // ⚠ NO KERNEL OP CARRIES THESE TWO — they exist for the Tier-1 chat primitives
  // (`TIER1_TOOL_ENTITY` in `chat.ts`), which share this vocabulary so the panel can
  // render ONE group per entity across both registries. `crm` is `deal.search` /
  // `account.search` (remote vendor records, not a local collection); `recipe` is
  // `recipe.run` (it reaches the recipe catalog, not data). Keeping them here rather
  // than in a second union is what makes "one group per entity" expressible at all.
  'crm', 'recipe',
] as const;

/** String-literal union derived from {@link OP_ENTITIES}. */
export type OpEntity = (typeof OP_ENTITIES)[number];

/** ⛔⛔ WHICH ENTITIES ARE ALSO FENCE-GOVERNED COLLECTIONS — the bridge that lets the
 *  `data.*` axis retire as a CONTROL while surviving as an ENFORCEMENT detail.
 *
 *  ⛔ `data.*` DOES TWO JOBS AND ONLY ONE OF THEM CAN BECOME AN OP ANNOTATION.
 *  Job one is a grant row the tool handlers read — that one is now derived from the
 *  op's own `entity` and needs no separate checkbox. Job two is
 *  `scopeRestrictionsFromReadableCollections`, which emits `data.<c>.*` PATH PATTERNS
 *  consumed by `evaluateScopeAdmissibility` at the execute gate: the ingredient-read
 *  fence over recipe template reads (`{{data.mail.<id>}}`). Those reads dispatch NO
 *  OP, so there is nothing to hang a per-op grant on, and retiring the row outright
 *  would leave every recipe's raw collection read ungated.
 *
 *  ⇒ The row stays, the CHECKBOX goes. The entity group toggle writes the collection
 *  row alongside its ops, so one owner action still means one thing on both fences —
 *  which is the invariant `read-collection-grant.ts` already states: the two "can never
 *  disagree about what a checkbox means."
 *
 *  ⚠ NOT EVERY ENTITY MAPS. `ai` / `browser` / `schedule` / `watch` / `recipe` / `crm`
 *  / `seller` / `shared` / `peer` / `notification` / `enrichment` / `memory` / `audit`
 *  have no `READABLE_COLLECTIONS` member behind them — enrichment and memory carry
 *  their own gates (topic grants, `core.memory.*` verb-ops), and the rest are not
 *  collections at all. Absent here means "no path fence", never "denied". */
export const OP_ENTITY_COLLECTION: Readonly<Partial<Record<OpEntity, string>>> = {
  mail: 'mail',
  calendar: 'calendar',
  file: 'file',
  contact: 'contact',
  form_response: 'form_response',
  webhook: 'webhook',
  // ⚠ `work` IS ABSENT ON PURPOSE and this map is deliberately one-to-one. It fans out
  // to every `WORK_ENTITY_KINDS` member of `READABLE_COLLECTIONS` (task / note /
  // commitment / project / booking), which a `Partial<Record<OpEntity, string>>` cannot
  // express. The reverse direction — collection -> entity, which IS total — is built in
  // the Contracts panel (`COLLECTION_ENTITY`) by folding the work kinds in there.
};

/** The owner-facing heading for each entity — what the Contracts panel prints above
 *  the group. A `Record` over the closed union, so a new entity cannot ship without a
 *  human-readable name; a fallback like `entity` raw would surface `form_response` to
 *  a person.
 *
 *  ⚠ Named for what the owner calls the thing, not for the registry's vocabulary:
 *  `work` reads as "Tasks & notes" because nobody looks for a commitment under
 *  "work-entity", and `shared` says "Shared store" because "shared" alone names
 *  nothing on its own. */
export const OP_ENTITY_LABEL: Readonly<Record<OpEntity, string>> = {
  mail: 'Mail',
  calendar: 'Calendar',
  contact: 'Contacts',
  file: 'Files',
  shared: 'Shared store',
  memory: 'Memory',
  recall: 'Conversation history',
  audit: 'Audit trail',
  enrichment: 'Enrichments',
  work: 'Tasks & notes',
  form_response: 'Form responses',
  webhook: 'Webhooks',
  peer: 'Peers',
  seller: 'Selling',
  notification: 'Notifications',
  crm: 'CRM records',
  recipe: 'Recipes',
  ai: 'AI models',
  browser: 'Browser',
  schedule: 'Schedules',
  watch: 'Triggers',
};

export const OP_ENTITY_SET: ReadonlySet<string> = new Set(OP_ENTITIES);

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
  /** What this op reaches — see {@link OP_ENTITIES}. REQUIRED, so a new op cannot
   *  be added without deciding where an owner would look for it; an optional field
   *  would let ops accumulate ungrouped and the panel would quietly under-report
   *  what reaches a collection. */
  entity: OpEntity;
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
  entity: OpEntity,
): KernelOpEntry => ({ op: opId, domain, backing_slug, risk, entity });

/** D-187 grant-foundation slice 3 — builder for a NATIVE verb-op
 *  ({@link KernelOpEntry.native}): a grant handle for an MCP-server-native
 *  direct-return read tool. No `backing_slug` (no backing ingredient, not
 *  recipe-runnable). */
const nativeOp = (
  opId: string,
  domain: string,
  risk: RiskTier,
  entity: OpEntity,
  /** D-234 § 234.4 — see {@link KernelOpEntry.mcp_tool}. Supply it only for a
   *  native op that is genuinely callable as a static MCP tool. */
  mcp_tool?: string,
): KernelOpEntry => ({
  op: opId,
  domain,
  risk,
  entity,
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
  op('core.ai.classify', 'ai', 'core-ai-classify', 'read', 'ai'),
  op('core.ai.compare', 'ai', 'core-ai-compare', 'read', 'ai'),
  op('core.ai.embed', 'ai', 'core-ai-embed', 'read', 'ai'),
  op('core.ai.extract', 'ai', 'core-ai-extract', 'read', 'ai'),
  op('core.ai.generate', 'ai', 'core-ai-generate', 'read', 'ai'),
  op('core.ai.prompt', 'ai', 'core-ai-prompt', 'read', 'ai'),
  op('core.ai.rewrite', 'ai', 'core-ai-rewrite', 'read', 'ai'),
  op('core.ai.score', 'ai', 'core-ai-score', 'read', 'ai'),
  op('core.ai.sentiment', 'ai', 'core-ai-sentiment', 'read', 'ai'),
  op('core.ai.summarize', 'ai', 'core-ai-summarize', 'read', 'ai'),
  op('core.ai.translate', 'ai', 'core-ai-translate', 'read', 'ai'),

  // ── mail — warehouse mail/email reads + the direct send.
  op('core.mail.get', 'mail', 'mail-get', 'read', 'mail'),
  op('core.mail.body-read', 'mail', 'mail-body-read', 'read', 'mail'),
  op('core.mail.thread-read', 'mail', 'mail-thread-reader', 'read', 'mail'),
  op('core.mail.send', 'mail', 'mail-send', 'write', 'mail'),
  /** D-210 §7 — notify a booking's visitor server-side. A sibling outbound send to
   *  `mail-send`, but the recipient (the visitor's SEALED email) is resolved by the
   *  dispatcher from the booking's own `reception_record_id`, never authored by
   *  the caller and never returned. `write` + the outbound-send lift, so it holds at
   *  the D-157 gate exactly like `mail-send` (the owner reviews the booking). */
  op('core.mail.notify-booking-visitor', 'mail', 'notify-booking-visitor', 'write', 'mail'),
  /** D-207 slice 3d — the general no-resend fence, lifted out of D-200.
   *
   *  `write` because it settles the claim, but note what a caller CANNOT do with it:
   *  the op takes a reconciliation id and NOTHING else, derives the whole provider
   *  query from the server-written claim, and settles on the provider's VERDICT
   *  rather than a status the caller names. So there is no argument through which a
   *  forged `matched` could be smuggled — and a forged `matched` is the dangerous
   *  one, because it marks a document DELIVERED that was never sent. */
  op('core.mail.sent.reconcile', 'mail', 'mail-sent-reconcile', 'write', 'mail'),
  /** D-239 — the mail WRITE-BACK: mutating the state of a message that already
   *  exists, as distinct from `core.mail.send`, which creates a new one.
   *
   *  ⛔ THESE ARE NOT OUTBOUND SENDS AND MUST NOT JOIN `OUTBOUND_SEND_INGREDIENT_SLUGS`.
   *  Nothing here crosses the user's trust boundary — marking your own mail read,
   *  starring it, or filing it in your own folder is an INTERNAL warehouse-and-
   *  provider write, the same class as `calendar-update` or `annotation-upsert`,
   *  which are all `write` and all stay silent at the owner ceiling. Adding one of
   *  these to the send set would prompt the owner for permission to mark their own
   *  mail read, on every run.
   *
   *  The `write` tier still does the real work under a CONTRACT: an AI acting on a
   *  door takes the LOW ceiling, where a `write` surfaces for approval. So the
   *  owner's own recipe files mail silently and an agent's request to do it asks —
   *  which is the split the tier exists to express. */
  op('core.mail.mark', 'mail', 'mail-mark', 'write', 'mail'),
  op('core.mail.flag', 'mail', 'mail-flag', 'write', 'mail'),
  op('core.mail.move', 'mail', 'mail-move', 'write', 'mail'),
  /** `destructive` — the always-class. No trust ceiling can relax it (the FLOOR
   *  can't cross an always), so deleting mail asks EVERY time, for every actor,
   *  including the owner's own unattended automation. Same tier as
   *  `calendar-delete`, for the same reason: the provider's trash is the only copy
   *  left once the warehouse row is gone. */
  op('core.mail.delete', 'mail', 'mail-delete', 'destructive', 'mail'),
  op('core.mail.email.get', 'mail', 'email-get', 'read', 'mail'),
  op('core.mail.email.list', 'mail', 'email-list', 'read', 'mail'),
  op('core.mail.email.search', 'mail', 'email-search', 'read', 'mail'),

  // ── contact — the personal contact graph.
  op('core.contact.resolve', 'contact', 'contact-resolve', 'read', 'contact'),
  op('core.contact.business-context', 'contact', 'contact-business-context', 'read', 'contact'),
  op('core.contact.upsert', 'contact', 'contact-upsert', 'write', 'contact'),
  // D-187 slice 3b — NATIVE verb-op for the `recued_contactEngagementsList` MCP tool
  // (contact-rooted engagement evidence; D-139). No backing ingredient. OWNER-default-only
  // (sensitive — exposes a contact's engagement history): see OWNER_DEFAULT_ONLY_GRANT_ENTRIES.
  nativeOp('core.contact.engagements.read', 'contact', 'read', 'contact'),

  // ── notification — the alert-dispatch surface; backed by the anti-shadow
  //    `core-notification-send` slug (bare `notification-send` is the alias).
  /** ⛔⛔ `read`, NOT `write` — AND IT IS NOT AN OUTBOUND SEND. Both halves are
   *  one decision (owner ruling 2026-08-20); either alone leaves the defect.
   *
   *  🔑 THE ARGUMENT IS THAT THIS OP HAS NO RECIPIENT. Every other member of
   *  `OUTBOUND_SEND_INGREDIENT_SLUGS` takes a per-call destination the recipe
   *  authors — `mail-send`'s `to`, `slack-post`'s channel, `peer-ask`'s target
   *  server — and the lift exists so the owner can review THAT destination
   *  before it leaves. This op's input is `{channels, text, title, link_url}`:
   *  no address, no target. `channels` can only NARROW to the channels the
   *  owner already enrolled and switched on (an unenrolled channel has no
   *  dispatcher and lands in `failed[]`), so the destination is the owner's own
   *  deliberate endpoint setup and the only reader is the owner. The lift would
   *  render a recipient review with nothing to review.
   *
   *  This is the recipe-surface half of a ruling the rpc surface already had:
   *  D-177 N.12 kept `notification.send` a wire method on exactly this
   *  reasoning — *"carries NO recipient … cannot be aimed at an arbitrary
   *  target the way `collection.mail.send`'s per-call `to[]` can, so it is not
   *  a trust-bypass"* (`notification-handler.ts`). The two surfaces disagreed;
   *  now they do not.
   *
   *  ⛔ AND GATING IT WAS WORSE THAN NOT GATING IT. The approval prompt is
   *  ITSELF a notification, delivered on the SAME channels to the SAME person:
   *  the owner got *"recipe A wants to send you a notification, allow?"* and
   *  then *"recipe A: xxx"* — two interruptions where the gate was supposed to
   *  save one, and the first carries no information the second lacks. A gate
   *  whose prompt costs exactly what it is protecting trains the owner to
   *  approve without reading, which is a security LOSS, not a gain. Same shape
   *  as the D-239 note above: never make the owner authorize an act whose only
   *  subject is themselves.
   *
   *  ⚠ CONSEQUENCE, STATED NOT DISCOVERED: `read` is never-class, so a
   *  DELEGATED door that has been granted this op notifies without a per-call
   *  ask too (`d-209-webhook-outbound-send-ceiling.test.ts` pins it). That is
   *  the intended reading of "the authorization is the setup": Layer-1 access
   *  still requires the owner to have granted `core.notification.send` on that
   *  door, `permission: notification_send` still gates the install, and there
   *  is nothing per-call to review even when they have. Precedent for the tier:
   *  `core.ai.*` is `read` while shipping the owner's data to an external LLM
   *  provider — strictly more exposure than a message to the owner's own Slack.
   *  ⇒ If a door must not be able to ring the owner's phone, revoke the OP on
   *  that door; do not re-tier the op, which would put the double-notification
   *  back on every recipe. */
  op('core.notification.send', 'notification', 'core-notification-send', 'read', 'notification'),
  // D-261: an inert owner-directed request, with the same no-double-ask risk
  // classification as notification.send. No approve/set-approved entry exists.
  op('core.preapproval.request', 'preapproval', 'preapproval-request', 'read', 'notification'),
  op('core.mail.draft.create', 'mail', 'mail-draft-create', 'write', 'mail'),
  op('core.mail.draft.read', 'mail', 'mail-draft-read', 'read', 'mail'),
  op('core.mail.draft.update', 'mail', 'mail-draft-update', 'write', 'mail'),
  op('core.mail.draft.delete', 'mail', 'mail-draft-delete', 'destructive', 'mail'),
  // D-264 — save a draft into the mail account's own Drafts folder, so the
  // owner can pick it up in their phone or desktop mail client and finish it
  // there.
  //
  // ⚠ NAMED FOR THE ACT. This was `core.mail.draft.export` until the owner
  // pointed out that "export" implies crossing a boundary — a different account
  // or device — and this crosses none: the target is derived from the draft's
  // OWN `sender_mail_instance`, and there is no way to aim it elsewhere. The
  // wrong name was not cosmetic; it is why the stored provider id was first
  // written UNSCOPED, which let a re-pointed draft hand mailbox A's id to B.
  // "Hand-off" was the other candidate and names the hoped-for OUTCOME (the
  // owner may never pick it up); this names what actually happens.
  //
  // ⛔ `write`, and DELIBERATELY ABSENT from `OUTBOUND_SEND_INGREDIENT_SLUGS`.
  // That set's own membership test is "does the RECIPE author a destination?",
  // not "does a packet leave the machine" — every member takes a per-call
  // target the owner must see before it goes. This op has one destination and
  // the owner already owns it: their own mailbox. Nothing is delivered, nobody
  // is contacted, and sending still takes a human action afterwards. Lifting it
  // to `ask` would gate "put this where I can find it on my phone" behind the
  // same prompt as "email this person", which is the miscalibration D-177 N.12
  // corrected for `notification-send`.
  //
  // ⚠ It IS reversible in the only sense that matters here — the owner deletes
  // the draft — but it is NOT invisible: the copy syncs to their devices. Hence
  // `write` rather than `read`.
  op('core.mail.draft.save-to-mailbox', 'mail', 'mail-draft-save-to-mailbox', 'write', 'mail'),
  // A bounded, coalescing hint with a flat pointer/settings envelope to a
  // contract-bound MCP client. The transport adds no query result; the client
  // must call `query_tool` through the ordinary live token/contract gates, and
  // this op grants no read authority itself.
  op(
    'core.notification.recipe-callback',
    'notification',
    'core-notification-recipe-callback',
    'write',
    'notification',
  ),

  // ── work-entity — the note / task / commitment / project / booking entity CRUD.
  op('core.work-entity.note.create', 'work-entity', 'note-create', 'write', 'work'),
  op('core.work-entity.note.update', 'work-entity', 'note-update', 'write', 'work'),
  op('core.work-entity.note.delete', 'work-entity', 'note-delete', 'destructive', 'work'),
  op('core.work-entity.task.create', 'work-entity', 'task-create', 'write', 'work'),
  op('core.work-entity.task.update', 'work-entity', 'task-update', 'write', 'work'),
  op('core.work-entity.task.delete', 'work-entity', 'task-delete', 'destructive', 'work'),
  op('core.work-entity.task.mark-done', 'work-entity', 'task-mark-done', 'write', 'work'),
  op('core.work-entity.commitment.create', 'work-entity', 'commitment-create', 'write', 'work'),
  // D-192 F1 — the review-then-approve PROPOSAL surface: same mint effect as
  // commitment.create, but `commitment-propose` is in
  // COMMITMENT_PROPOSAL_INGREDIENT_SLUGS (op-risk-admission.ts), whose lift
  // raises admit → ask for EVERY actor — a proposal HOLDS at the D-157 gate
  // no matter who dispatches (invariant 3: the owner ratifies every capture).
  op('core.work-entity.commitment.propose', 'work-entity', 'commitment-propose', 'write', 'work'),
  op('core.work-entity.commitment.update', 'work-entity', 'commitment-update', 'write', 'work'),
  op('core.work-entity.commitment.cancel', 'work-entity', 'commitment-cancel', 'write', 'work'),
  op('core.work-entity.commitment.fulfill', 'work-entity', 'commitment-fulfill', 'write', 'work'),
  op('core.work-entity.project.create', 'work-entity', 'project-create', 'write', 'work'),
  op('core.work-entity.project.update', 'work-entity', 'project-update', 'write', 'work'),
  op('core.work-entity.project.archive', 'work-entity', 'project-archive', 'write', 'work'),
  // D-210 — booking. THREE verbs, not the commitment quartet: a booking's
  // lifecycle move rides `update` (which re-stamps `state_changed_at` only on a
  // real transition) rather than earning dedicated `-cancel` / `-fulfill` ops.
  // Commitment needs its own because its moves carry a state MACHINE the update
  // path deliberately refuses (§ A.1.3: lifecycle + due_status are not mutable
  // through `commitment-update`). A booking has no such machine — any state may
  // follow any other, because a real reservation genuinely does go
  // confirmed → cancelled → confirmed again.
  op('core.work-entity.booking.create', 'work-entity', 'booking-create', 'write', 'work'),
  op('core.work-entity.booking.update', 'work-entity', 'booking-update', 'write', 'work'),
  op('core.work-entity.booking.delete', 'work-entity', 'booking-delete', 'destructive', 'work'),
  op('core.work-entity.list', 'work-entity', 'work-entity-list', 'read', 'work'),
  op('core.work-entity.get', 'work-entity', 'work-entity-get', 'read', 'work'),
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
  nativeOp('core.work-entity.read', 'work-entity', 'read', 'work'),

  // ── memory — the provenance / audit / annotation + links graph + timeline
  //    (CLAUDE.md: data.memory = audit/memory + provenance links + annotations).
  op('core.memory.annotation.create', 'memory', 'annotation-create', 'write', 'memory'),
  op('core.memory.annotation.delete', 'memory', 'annotation-delete', 'write', 'memory'),
  op('core.memory.annotation.list', 'memory', 'annotation-list', 'read', 'memory'),
  op('core.memory.annotation.search', 'memory', 'annotation-search', 'read', 'memory'),
  op('core.memory.link.create', 'memory', 'link-create', 'write', 'memory'),
  op('core.memory.link.delete', 'memory', 'link-delete', 'write', 'memory'),
  op('core.memory.link.list', 'memory', 'link-list', 'read', 'memory'),
  op('core.memory.timeline.read', 'memory', 'timeline-read', 'read', 'memory'),
  op('core.memory.annotate', 'memory', 'data-annotate', 'write', 'memory'),
  op('core.memory.link', 'memory', 'data-link', 'write', 'memory'),
  // D-187 slice 3b — NATIVE verb-op for the `recued_getAudit` MCP tool (run-history /
  // audit-log read). No backing ingredient. OWNER-default-only (sensitive — run history
  // reveals the owner's automation activity): see OWNER_DEFAULT_ONLY_GRANT_ENTRIES.
  // D-198 follow-on — RUN HISTORY is its own domain (`audit`), not "memory".
  // Renamed from `core.memory.audit.read`: the old id was a D-120 fossil (back
  // then "memory" MEANT the provenance substrate) that made an audit grant look
  // like part of the D-198 knowledge-pool family in the grant surface. Pre-launch
  // → renamed outright, no migration (`feedback_pre_launch_no_migration`).
  nativeOp('core.audit.read', 'audit', 'read', 'audit'),
  // D-198 Slice 4 — NATIVE verb-ops for contract-governed collective memory: a
  // contracted AI / customer WRITES memory (`memory.write` primitive / chat tool)
  // or READS the shared pool (`memory.search` / `memory.recall`) only when the
  // contract grants it. No backing ingredient (middleware primitive / chat tool,
  // not recipe-runnable). Both are OWNER-default-only (ON for owner, OFF for every
  // door by default — the seller opts a tier in per §3): see
  // OWNER_DEFAULT_ONLY_GRANT_ENTRIES.
  nativeOp('core.memory.write', 'memory', 'write', 'memory'),
  nativeOp('core.memory.read', 'memory', 'read', 'memory'),
  /** ⛔⛔ THE GRANT HANDLE FOR `recall.search` — the one AI-reachable read surface that
   *  had NO ROW AT ALL. `chat-recall-search-tool.ts` is hand-built into the CHAT
   *  registry view specifically so it never enters the raw MCP registry, and its own
   *  header records the consequence: "interaction recall acquires no grant handle and
   *  cannot be discovered there." Correct for DOORS — `resolveOwnerRecallCorpusScope`
   *  fail-closes everything but `(chat, owner)` — and wrong for the OWNER, who could
   *  not switch off the tool that reads every conversation they have ever had.
   *
   *  🔑 THE FIX IS TO SPLIT TWO LISTS THAT WERE ACCIDENTALLY ONE: "has a grant row" and
   *  "is on the MCP wire". Adding it to `TIER1_TOOL_NAMES` would have bought the row by
   *  ALSO exposing it to doors — inverting D-213. A kernel op id buys the row alone; the
   *  chat-only wrapper is untouched, so the wire posture is exactly as before. The
   *  precedent already exists in reverse: Tier-3 entries sit in the registry and are
   *  refused at the wire (`mcp-server.ts`).
   *
   *  `native: true` — no backing ingredient, not recipe-runnable. `read` risk. */
  nativeOp('core.recall.search', 'recall', 'read', 'recall'),

  // ── data — typed warehouse collections plus accepted free-form responses.
  op('core.data.enrichment.upsert', 'data', 'enrichment-upsert', 'write', 'enrichment'),
  op('core.data.enrichment.list', 'data', 'enrichment-list', 'read', 'enrichment'),
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
  nativeOp('core.data.enrichment.read', 'data', 'read', 'enrichment'),
  nativeOp('core.data.enrichment.vector-search', 'data', 'read', 'enrichment'),
  nativeOp('core.data.enrichment.describe', 'data', 'read', 'enrichment'),
  op('core.data.calendar.get', 'data', 'calendar-get', 'read', 'calendar'),
  op('core.data.calendar.list', 'data', 'calendar-list', 'read', 'calendar'),
  op('core.data.calendar.search', 'data', 'calendar-search', 'read', 'calendar'),
  op('core.data.calendar.stat', 'data', 'calendar-stat', 'read', 'calendar'),
  op('core.data.calendar.create', 'data', 'calendar-create', 'write', 'calendar'),
  op('core.data.calendar.update', 'data', 'calendar-update', 'write', 'calendar'),
  op('core.data.calendar.delete', 'data', 'calendar-delete', 'destructive', 'calendar'),
  op('core.data.calendar.rsvp', 'data', 'calendar-rsvp', 'write', 'calendar'),
  // Accepted intake responses carry arbitrary visitor-authored values. The
  // operation is recipe-runnable, but its author default is owner-only (see
  // OWNER_DEFAULT_ONLY_GRANT_ENTRIES) and its dispatch scope is additionally
  // fenced to the exact `data.form_response` collection.
  op('core.data.form-response.list', 'data', 'form-response-list', 'read', 'form_response'),
  op('core.data.form-response.get', 'data', 'form-response-get', 'read', 'form_response'),
  // D-210 A.8 slice 2 — advance the owner-authored lifecycle. Named
  // `set-state`, NOT `update`: it can change `lifecycle_state` and nothing
  // else, and a model reading `update` would go looking for the answer fields
  // it cannot touch. The same reason the `booking-*` manifests state what they
  // do not carry (see internal design notes).
  op('core.data.form-response.set-state', 'data', 'form-response-set-state', 'write', 'form_response'),
  op('core.data.webhook.get', 'data', 'webhook-get', 'read', 'webhook'),
  op('core.data.webhook.list', 'data', 'webhook-list', 'read', 'webhook'),

  // D-201 Slice 4 — run-scoped accepted-event read. The backing ingredient
  // accepts only an opaque event ref; engine-only StepMeta supplies the recipe
  // and run identities used by the consumer-binding authorization check.
  op('core.webhook.event.get', 'webhook', 'webhook-event-get', 'read', 'webhook'),

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
  op('core.peer.ask', 'peer', 'peer-ask', 'write', 'peer'),
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
  nativeOp('core.peer.receive-ask', 'peer', 'write', 'peer', 'recued_peerAsk'),
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
  nativeOp('core.peer.receive-answer', 'peer', 'write', 'peer', 'recued_peerAnswer'),
  // ⛔⛔ D-234 § 234.4j — `core.peer.expose` / `.revoke` / `.exposures` USED TO SIT
  // HERE AND WERE DELETED. They wrote a `peer_exposures` table saying "this peer
  // may ask me things under this label" — which is the SAME QUESTION the peer's
  // contract already answers, in a second store with no UI. `peer.label.<label>`
  // on the contract grant is the one gate now; `admitPeerAsk` reads it directly.
  // Do not re-add a per-peer flag store: the contract IS the flag store.

  // ── storage — the generic KV / blob surface (data.shared + data.file).
  op('core.storage.shared.write', 'storage', 'shared-write', 'write', 'shared'),
  op('core.storage.shared.compare-and-set', 'storage', 'shared-compare-and-set', 'write', 'shared'),
  op('core.storage.shared.read', 'storage', 'shared-read', 'read', 'shared'),
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
  op('core.storage.exchange.status', 'storage', 'exchange-status', 'read', 'peer'),
  op('core.storage.shared.delete', 'storage', 'shared-delete', 'write', 'shared'),
  op('core.storage.shared.delete-prefix', 'storage', 'shared-delete-prefix', 'destructive', 'shared'),
  op('core.storage.shared.list', 'storage', 'shared-list', 'read', 'shared'),
  op('core.storage.shared.search', 'storage', 'shared-search', 'read', 'shared'),
  op('core.storage.file.read', 'storage', 'file-read', 'read', 'file'),
  op('core.storage.file.write', 'storage', 'file-write', 'write', 'file'),
  op('core.storage.file.delete', 'storage', 'file-delete', 'destructive', 'file'),
  op('core.storage.file.get', 'storage', 'file-get', 'read', 'file'),
  op('core.storage.file.list', 'storage', 'file-list', 'read', 'file'),
  op('core.storage.file.move', 'storage', 'file-move', 'destructive', 'file'),
  op('core.storage.file.stat', 'storage', 'file-stat', 'read', 'file'),
  // D-185 Slice 4 — the explicit temp→cas keep step: ingest a run-scoped temp
  // file_ref's bytes into data.file.received, returning a durable cas_ref.
  op('core.storage.file.persist', 'storage', 'file-persist', 'write', 'file'),
  /** D-274 — hand a run-scoped temp ref's BYTES back to the recipe that made
   *  them, so a view can draw a file the owner keeps on disk WITHOUT copying it.
   *  `persist` is the copying sibling; a copy of a file the owner still edits is
   *  a cache with no invalidation. Confined to the producing run's scratch root,
   *  so it can name nothing this run did not just create. */
  op('core.storage.file.read-temp', 'storage', 'file-read-temp', 'read', 'file'),
  /** D-245 — write a REF's bytes into a record the RECIPE named. Closes the knot
   *  that a CAS id is content-derived (no name a recipe can choose in advance)
   *  while the only writer for a named `{slug, path}` record is value-shaped
   *  (`file-write { body_b64 }`, so a large file round-trips through step state).
   *  A stable NAME or memory-safe BYTES — this is what makes it both. */
  op('core.storage.file.put-ref', 'storage', 'file-put-ref', 'write', 'file'),
  // D-200 Slice 3 — strict deterministic Markdown substitution from one
  // durable template file ref to one run-scoped temp file ref.
  op(
    'core.storage.file.render-markdown-template',
    'storage',
    'file-render-markdown-template',
    'write',
    'file',
  ),
  // D-173 P5 (scan-gate part B) — the post-scan write-back: patch a
  // data.file.received record's scan_status hot field to a local scanner's
  // verdict. MCP-reserved (the backing kernel ingredient is not in
  // `MCP_EXPOSED_KERNEL_INGREDIENTS`) — only the reactive scan recipe writes it.
  op('core.storage.file.set-scan-status', 'storage', 'file-set-scan-status', 'write', 'file'),
  /** ⛔⛔ THE ONE GRANT THAT SAYS "MAY BYTES LEAVE THIS MACHINE'S STORAGE AND BE
   *  FETCHED FROM A CONNECTED VENDOR". It gates `resolveRemoteFileBytes` — the single
   *  function BOTH remote-reach routes funnel through: `handleFileRead` for a
   *  `file:remote:*` id, and the CLI executor's `input_materialize` reader.
   *
   *  🔑 IT IS NOT A SECOND `file.read`, AND THAT IS WHY IT IS ITS OWN OP. The local
   *  and remote branches of `core.storage.file.read` are chosen by the ARG
   *  (`{slug,path}` / a CAS `record_id` → local; a `file:remote:*` id → the vendor),
   *  so one grant on that id cannot distinguish them — an op gate fires on the op id,
   *  before the arg is known. Measured on the shipped corpus (3,400 JSON files): all 9
   *  `core.storage.file.read` steps pass `{slug,path}`, ZERO pass `record_id`, so this
   *  op is purely additive there. The real reach is the CLI path — 101 ops across 46
   *  packs declare `input_materialize` and 45 of the 46 shipped call sites pass a
   *  DYNAMIC `source` (`{{step.file_ref}}` out of SharePoint, `{{item}}`, …). Those are
   *  101 DIFFERENT ops, so the capability cannot live on an op id there either: remote
   *  reach is a property of the BINDING. Hence one grant, at the boundary.
   *
   *  ⚠ SERVER-WIDE, NOT PER-CONTRACT — stated so it is not mistaken for more. Neither
   *  caller carries an `ExecutionSource` (`handleFileRead(deps, args)`; the CLI reader
   *  is a bare `(record_id) => bytes` closure), so the predicate reads the OWNER's row
   *  and answers the same for every dispatch. Per-door granularity needs the source
   *  threaded through kernel-op dispatch and is deliberately NOT bundled here.
   *
   *  `native: true` — no backing ingredient, not recipe-runnable; it is a capability
   *  handle, not a step an author writes. `read` risk: it mutates nothing. What makes
   *  it worth its own row is EGRESS OF THE OWNER'S VENDOR CREDENTIAL, not mutation, and
   *  that is what the grant expresses — the ceiling axis has no way to say it. */
  nativeOp('core.storage.file.fetch-remote', 'storage', 'read', 'file'),
  /** D-244 — whole-file CSV filtering, in the KERNEL rather than a CLI pack.
   *  csvkit and xlsx2csv are Python tools an owner must install; a spreadsheet
   *  used as a customer list is too common a case to have its search silently
   *  absent on a fresh box. CSV is a FORMAT we can own — the parser is already
   *  shipped as `csv_parse`, and these ops reuse it rather than growing a second
   *  one. (XLSX stays external: zip + XML + shared strings + date serials is a
   *  real project, which is why libreoffice exists.)
   *
   *  ⛔ Kernel ops, not transforms. Dereferencing a `file_ref` is the
   *  Gateway-gated content boundary, and `packages/` transforms run on clients
   *  with no warehouse at all — a file-reading transform would be both an
   *  unaudited second path to those bytes and undefined on two of three hosts.
   *  Transforms operate on what is already in step state; kernel ops are how
   *  bytes enter it. */
  op('core.storage.csv.filter', 'storage', 'csv-filter', 'read', 'file'),
  op('core.storage.csv.stats', 'storage', 'csv-stats', 'read', 'file'),
  op('core.storage.csv.columns', 'storage', 'csv-columns', 'read', 'file'),
  op('core.storage.data-file-read', 'storage', 'data-file-read', 'read', 'file'),

  // ── schedule — D-193 installed-recipe scheduling control plane.
  //    Creates recurring or one-shot rows for recipes already installed in the
  //    local RecipeStore. Write risk because it arms autonomous future execution.
  op('core.schedule.recipe', 'schedule', 'schedule-recipe', 'write', 'schedule'),

  // ── seller — core-owned commerce registry. Recipes can establish and read
  //    fixed-shape offers, but only Seller owns the DB/schema/menu/UI and the
  //    operation vocabulary. Ensure creates drafts only; attach-fulfillment is
  //    a one-way creator-recipe self-link, never arbitrary definition or
  //    transaction editing. Pack provenance never grants identity or mutation
  //    authority.
  op('core.seller.offer.ensure', 'seller', 'seller-offer-ensure', 'write', 'seller'),
  op(
    'core.seller.offer.attach-fulfillment',
    'seller',
    'seller-offer-attach-fulfillment',
    'write',
    'seller',
  ),
  op('core.seller.offer.get', 'seller', 'seller-offer-get', 'read', 'seller'),
  op('core.seller.offer.list', 'seller', 'seller-offer-list', 'read', 'seller'),

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
  op('core.seller.order.open', 'seller', 'seller-order-open', 'write', 'seller'),
  op('core.seller.order.get', 'seller', 'seller-order-get', 'read', 'seller'),
  op('core.seller.order.list', 'seller', 'seller-order-list', 'read', 'seller'),
  op('core.seller.order.quote', 'seller', 'seller-order-quote', 'write', 'seller'),
  op(
    'core.seller.order.attach-payment',
    'seller',
    'seller-order-attach-payment',
    'write',
    'seller',
  ),
  op(
    'core.seller.order.confirm-payment',
    'seller',
    'seller-order-confirm-payment',
    'write',
    'seller',
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
    'seller',
  ),
  op(
    'core.seller.order.confirm-refund',
    'seller',
    'seller-order-confirm-refund',
    'write',
    'seller',
  ),
  op(
    'core.seller.order.attach-artifact',
    'seller',
    'seller-order-attach-artifact',
    'write',
    'seller',
  ),
  op('core.seller.order.transition', 'seller', 'seller-order-transition', 'write', 'seller'),
  op(
    'core.seller.order.link-work-entity',
    'seller',
    'seller-order-link-work-entity',
    'write',
    'seller',
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
    'seller',
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
  op('core.seller.tier.get', 'seller', 'seller-tier-get', 'read', 'seller'),
  op('core.seller.tier.list', 'seller', 'seller-tier-list', 'read', 'seller'),

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
  op('core.seller.customer-access.issue', 'seller', 'customer-access-issue', 'write', 'seller'),
  op('core.seller.customer-access.extend', 'seller', 'customer-access-extend', 'write', 'seller'),
  op(
    'core.seller.customer-access.swap-tier',
    'seller',
    'customer-access-swap-tier',
    'write',
    'seller',
  ),
  op('core.seller.customer-access.close', 'seller', 'customer-access-close', 'write', 'seller'),

  // ── customer — D-196 customer self-service. Native read op: no backing
  //    ingredient, not recipe-runnable, resolved strictly from the caller's
  //    bound seller customer context by the MCP transport.
  nativeOp('core.customer.status', 'customer', 'read', 'seller'),

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
  op('core.watch.time', 'watch', 'time-watcher', 'read', 'watch'),
  op('core.watch.time-relative', 'watch', 'time-relative-watcher', 'read', 'watch'),
  op('core.watch.mail', 'watch', 'mail-watcher', 'read', 'watch'),
  op('core.watch.calendar', 'watch', 'calendar-watcher', 'read', 'watch'),
  op('core.watch.file', 'watch', 'file-watcher', 'read', 'watch'),
  op('core.watch.http', 'watch', 'http-watcher', 'read', 'watch'),
  op('core.watch.recipe', 'watch', 'recipe-watcher', 'read', 'watch'),
  op('core.watch.webhook', 'watch', 'webhook-watcher', 'read', 'watch'),

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
  op('core.dom.read', 'dom', 'dom-read', 'read', 'browser'),
  op('core.dom.write', 'dom', 'dom-write', 'write', 'browser'),
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

/** The TRANSPOSE of {@link KERNEL_OP_BY_MCP_TOOL} — op id → static tool name.
 *
 *  Built from the same registry rows, so the two can never name different pairs.
 *  `mcp_tool` is unique per op by construction (one row declares it), and a
 *  duplicate would collapse here the same way it would collide there. */
const MCP_TOOL_BY_KERNEL_OP: ReadonlyMap<string, string> = new Map(
  KERNEL_OP_REGISTRY
    .filter((e): e is KernelOpEntry & { mcp_tool: string } => e.mcp_tool !== undefined)
    .map((e) => [e.op, e.mcp_tool] as const),
);

/** D-225 auto-mint — the static MCP tool a granted kernel op is reached through,
 *  or undefined when the op fronts no tool.
 *
 *  🔑 The reverse of {@link kernelOpForMcpTool}, and needed for the same reason
 *  that one exists: a contract's grant rows are keyed on OP IDS, while a peer
 *  probing our `tools/list` sees TOOL NAMES. Answering "what do we expose to this
 *  peer" in the peer's vocabulary needs the join walked the other way. Without
 *  it a granted native read-tool is invisible to the loopback filter and its
 *  reflection mints back into our own pack. */
export const mcpToolForKernelOp = (opId: string): string | undefined =>
  MCP_TOOL_BY_KERNEL_OP.get(opId);

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
