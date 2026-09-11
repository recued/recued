/** D-182 — Kernel op registry + R1 verb-split runnability (slice 2).
 *
 *  The Tier-K side of the two-tier op model (§3): the kernel-owned `core.*` ops.
 *  This module registers the kernel DOMAINS (`core.<domain>.*`) with their class
 *  + (for the cross-vendor canonical conventions) the connection family that
 *  must be bound, and derives a `core.*` op's runnability from the live
 *  connections via the R1 verb-split.
 *
 *  Scope boundary (read before extending):
 *   - Slice 2 registers DOMAINS, not individual ops. The concrete `core.*` ops
 *     (`core.ai.summarize`, `core.work-entity.commitment.create`, …) are LOWERED
 *     from the 165 kernel ingredient files in slice 3; the domain registry is
 *     all the R1 runnability check needs (it classifies any `core.<domain>.*` op
 *     by `parseOpId` → domain). Per-op RISK for closed-kind domains lands with
 *     that lowering; for the canonical conventions risk is verb-DERIVED here
 *     (`kernelVerbRiskTier`). APPROVAL is derived at neither — it comes from
 *     the enforced `approvalFloorForRisk`; see the ⛔ block at §3 below.
 *   - The runnability gatherer is PURE — it takes the already-resolved set of
 *     bound connection families. Recomputing that set from the live connections
 *     on the connection broadcast is runtime wiring (slice 5 / engine), not here.
 *
 *  Spec: D-182 §3 (Tier-K + R1 verb-split), §10 step 8, §11/§12.
 *  Wires on top of the already-built `crm_alias`/`acct_alias` registry
 *  (`connection-vendors.ts`) — `conventionFamilyForVendor` derives a vendor's
 *  family from it, so a 3rd-party CRM/acct pack's vendor participates with no new
 *  code. Pickup: internal design notes.
 */
import { parseOpId } from './op-model.js';
import { type CanonicalCrmVerb } from './connection-agnostic.js';
import {
  ACCT_ALIAS_VALUES,
  CONNECTION_VENDOR_ENTITIES,
  CRM_ALIAS_VALUES,
  type ConnectionVendorEntity,
} from './connection-vendors.js';
import type { RiskTier } from './ingredient.js';

// ────────────────────────────────────────────────────────────────
// §3 — kernel connection families (the cross-vendor canonical conventions)
// ────────────────────────────────────────────────────────────────

/** D-182 §3 — the cross-vendor canonical conventions Recued maintains as kernel
 *  ops. A `core.crm.*` / `core.acct.*` op is run-resolved to whichever bound
 *  vendor provides it; its runnability is derived from whether a vendor in this
 *  family is bound (R1). Future conventions (`ticket` / `issue` / `payment` /
 *  `sponsor`) extend this list + `KERNEL_DOMAINS`. */
export const KERNEL_CONNECTION_FAMILIES = ['crm', 'acct'] as const;
export type KernelConnectionFamily = (typeof KERNEL_CONNECTION_FAMILIES)[number];

const KERNEL_CONNECTION_FAMILY_SET: ReadonlySet<string> = new Set(KERNEL_CONNECTION_FAMILIES);

export const isKernelConnectionFamily = (v: unknown): v is KernelConnectionFamily =>
  typeof v === 'string' && KERNEL_CONNECTION_FAMILY_SET.has(v);

// ────────────────────────────────────────────────────────────────
// §3 — kernel domain registry
// ────────────────────────────────────────────────────────────────

/** A kernel domain's class.
 *   - `closed_kind` — a fixed kernel kind (`ai` / `storage` / `work-entity` /
 *     `notification` / `mail` / `contact` / `memory` / `data` / `schedule` /
 *     `seller` / `customer-access`): always present.
 *     Any per-kind reachability / authorization (e.g. a mail-send connection) is
 *     the §6 kind handler's `authorized` preflight stage (slice 5), NOT the R1
 *     convention-runnability check.
 *   - `canonical_convention` — a cross-vendor convention (`crm` / `acct`):
 *     run-resolved to a bound vendor; its runnability is the R1 derived check. */
export type KernelDomainClass = 'closed_kind' | 'canonical_convention';

/** A registered kernel domain (`core.<domain>.*`). */
export interface KernelDomain {
  /** the `<domain>` segment of a Tier-K op id (`ai`, `crm`, `work-entity`). */
  domain: string;
  class: KernelDomainClass;
  /** canonical conventions ONLY — the connection family that must be bound for
   *  an op in this domain to run-resolve (the R1 derived check
   *  `convention → required_connection_kind → is-bound`, §10 step 8). Absent on
   *  closed-kind domains. */
  required_connection_kind?: KernelConnectionFamily;
}

/** D-182 §3 — the closed list of kernel domains. Closed kinds first, then the
 *  cross-vendor canonical conventions. Adding a domain is a kernel change (a
 *  decisions-log entry + a new `core.<domain>.*` op surface). */
export const KERNEL_DOMAINS: readonly KernelDomain[] = [
  { domain: 'ai', class: 'closed_kind' },
  { domain: 'storage', class: 'closed_kind' },
  { domain: 'work-entity', class: 'closed_kind' },
  { domain: 'notification', class: 'closed_kind' },
  // D-261: grantable owner-review requests. Granting the decision is never an op.
  { domain: 'preapproval', class: 'closed_kind' },
  { domain: 'mail', class: 'closed_kind' },
  { domain: 'contact', class: 'closed_kind' },
  { domain: 'memory', class: 'closed_kind' },
  // ⛔ D-213's interaction-recall corpus — prior-conversation history, a DIFFERENT
  // store from `memory` (curated knowledge). It gets its own domain rather than a
  // `core.memory.recall.*` id precisely because D-213 separated the two: an id saying
  // `memory` would re-conflate them for every future reader, and the whole reason
  // recall needs a grant is that it is the most sensitive corpus on the server.
  { domain: 'recall', class: 'closed_kind' },
  // D-198 follow-on (2026-07-11) — RUN HISTORY is its own kernel surface, not
  // "memory". `core.audit.read` (the `recued_getAudit` verb-op) used to live at
  // `core.memory.audit.read`, a D-120 fossil from when "memory" MEANT the
  // provenance substrate (audit + annotations + links + timeline). D-198 then
  // reused the same word for a completely different thing — a curated knowledge
  // pool (`core.memory.read`/`write`) — so a grant screen showed an audit grant
  // sitting inside the memory family, reading as if "let them read my knowledge"
  // might also open the owner's run history. It never did (the grants are
  // independent), but the NAME implied a hierarchy that gates nothing, and that
  // is a trust bug on the one surface where trust is the product.
  // Same reasoning D-201 used to split `webhook` out of the generic `data`
  // collection readers: a capability-scoped surface deserves its own domain.
  { domain: 'audit', class: 'closed_kind' },
  // D-234 § 234.4 — PEER: what this server offers ANOTHER RECUED SERVER'S owner.
  //
  // ⛔ ITS OWN DOMAIN, NOT FOLDED UNDER `storage`, AND FOR THE REASON THE
  // audit/memory SPLIT ABOVE RECORDS. § 23 put the exchange-resolve op under
  // `storage` because it is an audit read that confers nothing. This surface is
  // the opposite: it hands another owner the ability to INTERRUPT you. A grant
  // screen showing that inside the storage family would read as "let them read
  // my storage" — a name implying a hierarchy that gates nothing, which is a
  // trust bug on the one surface where trust is the product.
  { domain: 'peer', class: 'closed_kind' },
  { domain: 'data', class: 'closed_kind' },
  // D-201 — accepted webhook events are a capability-scoped kernel surface,
  // separate from the legacy generic `data.webhook` collection readers.
  { domain: 'webhook', class: 'closed_kind' },
  // D-193 — autonomous future execution control plane. `core.schedule.recipe`
  // creates rows in the server-owned schedule store for recipes already
  // installed on this instance; no vendor connection participates.
  { domain: 'schedule', class: 'closed_kind' },
  // Core Seller owns the durable offer schema, closed operation vocabulary,
  // Settings menu, and fixed UI. Recipes may compose against these operations;
  // they do not define Seller infrastructure or acquire authority from pack
  // publisher/version provenance.
  //
  // D-207 §4.5 — also home to D-196's seller-customer access lifecycle control
  // plane (`core.seller.customer-access.*`), which mutates local seller rows,
  // customer-instance contracts, and inbound MCP tokens. It previously held its
  // own top-level `customer-access` domain; that domain was MERGED here (a
  // subscription is a seller transaction). No provider connection is part of
  // Tier-K runnability for either family.
  { domain: 'seller', class: 'closed_kind' },
  // D-196 — customer self-service read surface. `core.customer.status` is a
  // native MCP read op (not recipe-runnable) that resolves to the caller's own
  // bound seller customer row.
  { domain: 'customer', class: 'closed_kind' },
  // D-182 watcher prototype — the trigger-position kernel domain. `core.watch.*`
  // ops are the reactive `trigger_steps` predicates (D-115): each produces a
  // `should_run` gate and lowers to a kernel watcher ingredient routed through
  // the server's `KernelDispatchers.watcher` slot. Closed-kind (no per-instance
  // connection — the predicate / warehouse-read drives it); the trigger-position
  // restriction (a `core.watch.*` op is only valid in `trigger_steps`) is a
  // validator concern, not a domain field.
  { domain: 'watch', class: 'closed_kind' },
  // D-182 "core.dom" close-out (2026-06-18) — the Bridge-actuated DOM action
  // domain, the last of the settled kernel-uniform primitives (§ kernel-vs-Tier-P
  // line: ai / notification / storage / data / memory / contact / watch / dom).
  // `core.dom.{read,write}` are SEQUENTIAL-position ops (a recipe step, not a
  // trigger watcher): they lower to the kernel `dom-read` / `dom-write` ingredients
  // dispatched through the server's `dom` slot (the BridgeDomAdapter), which builds
  // the BridgeCommand from the op ARGS (target + selector [+ value]) — there is NO
  // per-tool signed manifest selector map, the Bridge is the uniform executor.
  // Closed-kind: no per-instance connection; the `target` URL rides as an op arg,
  // gated by the op's risk/approval (read → never, write → ask) + the Bridge's
  // domain_allowlist intersection.
  { domain: 'dom', class: 'closed_kind' },
  { domain: 'crm', class: 'canonical_convention', required_connection_kind: 'crm' },
  { domain: 'acct', class: 'canonical_convention', required_connection_kind: 'acct' },
];

const KERNEL_DOMAIN_BY_NAME: ReadonlyMap<string, KernelDomain> = new Map(
  KERNEL_DOMAINS.map((d) => [d.domain, d]),
);

/** Resolve a kernel domain by name (`'crm'` → its `KernelDomain`); undefined for
 *  an unregistered domain. */
export const getKernelDomain = (domain: string): KernelDomain | undefined =>
  KERNEL_DOMAIN_BY_NAME.get(domain);

export const isKernelDomain = (domain: string): boolean => KERNEL_DOMAIN_BY_NAME.has(domain);

// ────────────────────────────────────────────────────────────────
// §3 / R1 — the canonical-verb split + kernel-defined risk/approval
// ────────────────────────────────────────────────────────────────

/** R1 verb-split (§3) — the read-side canonical verbs: unbound → empty result +
 *  pre-run warning (downstream-safe). */
export const KERNEL_READ_VERBS = ['read', 'search'] as const satisfies readonly CanonicalCrmVerb[];

/** R1 verb-split (§3) — the write-side canonical verbs: unbound → fail closed /
 *  pre-run block (NEVER a silent no-op of a side effect). */
export const KERNEL_WRITE_VERBS = ['create', 'update', 'delete'] as const satisfies readonly CanonicalCrmVerb[];

export type KernelVerbClass = 'read' | 'write';

const READ_VERB_SET: ReadonlySet<string> = new Set(KERNEL_READ_VERBS);
const WRITE_VERB_SET: ReadonlySet<string> = new Set(KERNEL_WRITE_VERBS);

/** The closed alias set per canonical-convention family — a canonical op's
 *  entity segment must be one of these for THAT convention. A `core.crm.*` op
 *  addresses a `crm_alias` (`deal`/`contact`/`account`); a `core.acct.*` op an
 *  `acct_alias`. Used to reject a MALFORMED canonical op (unknown alias) before
 *  the R1 read-empty path — see `kernelOpRunnability`. */
const CONVENTION_ALIAS_SET: Readonly<Record<KernelConnectionFamily, ReadonlySet<string>>> = {
  crm: new Set<string>(CRM_ALIAS_VALUES),
  acct: new Set<string>(ACCT_ALIAS_VALUES),
};

/** Classify a canonical verb for the R1 split; null for an unrecognized verb
 *  (callers fail closed). `KERNEL_READ_VERBS ∪ KERNEL_WRITE_VERBS` partitions
 *  `CANONICAL_CRM_VERBS` exactly. */
export const classifyCanonicalVerb = (verb: string): KernelVerbClass | null =>
  READ_VERB_SET.has(verb) ? 'read' : WRITE_VERB_SET.has(verb) ? 'write' : null;

/** §3 — the kernel-defined risk tier for a canonical-convention op, derived from
 *  its verb: read/search → `'read'`; create/update → `'write'`; delete →
 *  `'destructive'`. (`admin` is not in the canonical verb set.) null for an
 *  unrecognized verb. */
export const kernelVerbRiskTier = (verb: string): RiskTier | null => {
  switch (verb) {
    case 'read':
    case 'search':
      return 'read';
    case 'create':
    case 'update':
      return 'write';
    case 'delete':
      return 'destructive';
    default:
      return null;
  }
};

/** §3 — ⛔ THERE IS DELIBERATELY NO VERB→APPROVAL DERIVATION HERE.
 *
 *  A `kernelVerbApproval(verb)` used to sit at this line, returning
 *  `read → never, everything else → ask`. RETIRED alongside the registry's
 *  `kernelApprovalForRisk` (D-209 §5b follow-on) as the second instance of one
 *  defect: an approval map parked beside what it guards, disagreeing with the
 *  only map that is enforced.
 *
 *  It was wrong in the dangerous direction. `delete` classifies `destructive`
 *  ({@link kernelVerbRiskTier}), which the enforced `RISK_APPROVAL_FLOOR` puts
 *  at `always` — never relaxable by `applyTrustCeiling`. This fn returned `ask`,
 *  which relaxes to `admit` whenever op-risk <= the ceiling. Nothing read it
 *  (verified repo-wide at retirement), so the divergence was dormant — but it
 *  was EXPORTED, and the canonical-convention lowering it was written for had
 *  not been wired yet, so the first correct-looking use would have shipped a
 *  destructive convention op running silently on an `admin` ceiling.
 *
 *  ⛔ Its docstring also carried the claim the registry's twin was retired for:
 *  "the Gateway may apply stricter overrides on top". The Gateway does not layer
 *  onto either map — it never read them.
 *
 *  ⇒ Derive approval where it is enforced: {@link kernelVerbRiskTier} for the
 *  verb's tier, then `approvalFloorForRisk` (`ingredient-catalog.ts`), which is
 *  the single source and FAILS CLOSED to `always` on an unrecognized tier. That
 *  composition already yields the right answer for every verb this returned. */

// ────────────────────────────────────────────────────────────────
// §10 step 8 / R1 — runnability gatherer
// ────────────────────────────────────────────────────────────────

/** What the engine does for a canonical-convention op whose required connection
 *  family is NOT bound (R1 verb-split):
 *   - `empty_result_warn` — read/search: return an empty result (the recipe
 *     continues, downstream-safe) + a pre-run warning to the owner.
 *   - `fail_closed` — create/update/delete (any write / destructive): block
 *     pre-run with an actionable connect-this warning. A write must NEVER
 *     silently no-op a side effect because no provider is bound. */
export type KernelUnboundBehavior = 'empty_result_warn' | 'fail_closed';

/** The R1 runnability verdict for a `core.*` op against the bound connections. */
export interface KernelOpRunnability {
  /** runnable as-is — a bound convention op, or a closed-kind kernel op (always
   *  present; its per-kind preflight is the §6 handler's job). */
  runnable: boolean;
  /** R1 verb-split behavior when the required family is NOT bound. Absent when
   *  `runnable`. */
  unbound_behavior?: KernelUnboundBehavior;
  /** the connection family the op needs (canonical-convention ops only). */
  required_connection_kind?: KernelConnectionFamily;
  /** human-facing warning surfaced pre-run for an unbound convention op (both
   *  behaviors carry one — `empty_result_warn` surfaces it, `fail_closed` blocks
   *  with it). */
  warning?: string;
}

/** D-182 §10 step 8 / R1 — derive a kernel op's runnability from the set of
 *  bound connection families (build that set with `boundConventionFamilies`).
 *
 *  Returns null when `op` is not a well-formed Tier-K op for a REGISTERED kernel
 *  domain (the caller treats it as not-a-kernel-op). A closed-kind kernel op is
 *  always `{ runnable: true }`. A canonical-convention op is runnable iff its
 *  family is bound; otherwise the R1 verb-split decides
 *  (read/search → empty+warn, write/destructive OR an unrecognized verb →
 *  fail closed). No runnable/degraded/blocked state machine, no capability-DI. */
export const kernelOpRunnability = (
  op: string,
  boundFamilies: ReadonlySet<KernelConnectionFamily>,
): KernelOpRunnability | null => {
  const parsed = parseOpId(op);
  if (parsed === null || parsed.tier !== 'kernel') return null;
  const dom = getKernelDomain(parsed.domain);
  if (dom === undefined) return null;

  if (dom.class === 'closed_kind' || dom.required_connection_kind === undefined) {
    return { runnable: true };
  }

  const family = dom.required_connection_kind;
  if (boundFamilies.has(family)) {
    return { runnable: true, required_connection_kind: family };
  }

  // Unbound — R1 verb-split on the op's canonical SHAPE. The read-empty path is
  // taken ONLY for a WELL-FORMED canonical op: `<alias>.<verb>` — exactly two
  // segments, the entity a registered alias for THIS convention, the verb a
  // recognized canonical READ verb. A canonical op `read`/`search` that is
  // otherwise valid returns the downstream-safe empty result; everything else —
  // a write/destructive verb, an UNRECOGNIZED verb, an UNKNOWN alias
  // (`core.crm.invoice.search`), or an extra-segment remainder
  // (`core.crm.deal.extra.search`) — FAILS CLOSED. A malformed canonical op must
  // never be silently emptied (that would mask an authoring error as "provider
  // not connected"); failing closed blocks the run, and when a provider IS bound
  // the lowering/validation surfaces the precise alias/verb error instead.
  const segments = parsed.op.split('.');
  const alias = segments[0];
  const verb = segments[segments.length - 1];
  const wellFormedRead =
    segments.length === 2
    && CONVENTION_ALIAS_SET[family].has(alias)
    && classifyCanonicalVerb(verb) === 'read';
  if (wellFormedRead) {
    return {
      runnable: false,
      unbound_behavior: 'empty_result_warn',
      required_connection_kind: family,
      warning: `${family} not connected — returning an empty result; connect a ${family} provider for live data.`,
    };
  }
  return {
    runnable: false,
    unbound_behavior: 'fail_closed',
    required_connection_kind: family,
    warning: `${family} not connected — connect a ${family} provider to run this${verb ? ` ${verb}` : ''}.`,
  };
};

// ────────────────────────────────────────────────────────────────
// Wire-on-top of the crm_alias/acct_alias registry — vendor → family
// ────────────────────────────────────────────────────────────────

/** Wire-on-top of the `crm_alias`/`acct_alias` registry — the convention family
 *  a vendor belongs to: `crm` if it registers any `crm_alias` entity, `acct` if
 *  any `acct_alias`. null for a non-canonical vendor. Deriving from the registry
 *  (rather than a hardcoded `{hubspot, salesforce}` list) means a 3rd-party
 *  CRM/acct pack's vendor participates automatically. A vendor that somehow
 *  registers BOTH alias kinds is a registry bug (`assertConnectionVendorRegistry`
 *  enforces crm_alias XOR acct_alias per entity); `crm` wins deterministically. */
export const conventionFamilyForVendor = (
  vendor: string,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): KernelConnectionFamily | null => {
  let crm = false;
  let acct = false;
  for (const e of registry) {
    if (e.vendor !== vendor) continue;
    if (e.crm_alias !== undefined) crm = true;
    if (e.acct_alias !== undefined) acct = true;
  }
  return crm ? 'crm' : acct ? 'acct' : null;
};

/** Build the `boundFamilies` set `kernelOpRunnability` consumes from the live
 *  bound connection VENDORS (the runtime resolves these from the `connection`
 *  namespace on the connection broadcast — slice 5). Non-canonical vendors drop
 *  out. */
export const boundConventionFamilies = (
  boundVendors: Iterable<string>,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): Set<KernelConnectionFamily> => {
  const out = new Set<KernelConnectionFamily>();
  for (const v of boundVendors) {
    const fam = conventionFamilyForVendor(v, registry);
    if (fam !== null) out.add(fam);
  }
  return out;
};
