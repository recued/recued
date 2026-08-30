/** D-153 / D-187 — admission-decision primitives shared by the gateway and the
 *  engine's dispatch chokepoints. Pure: no I/O, no clock.
 *
 *  What lives here after the policy-matrix retirement (D-187):
 *    - the closed `AdmissionDenyCode` enum + the tri-state `AdmissionDecision`
 *      (`admit` / `deny` / `ask`) every gate returns;
 *    - the scope fence the per-call read-gate uses — `evaluateScopeRestrictions`
 *      (gate a `data.*` / `connection.*` path against a
 *      `ContractSnapshot.scope_restrictions` list), `matchScopePattern`, and
 *      `deriveDispatchScope` (map a tool dispatch to its canonical scope path).
 *
 *  D-187 retired the `(channel × actor [× contract])` policy matrix: the
 *  `PerCellPolicy` merge (`mergePolicyWithContract` / `EffectivePolicy`), the
 *  coarse `allowed_kinds × allowed_risk_tiers` tool gate
 *  (`evaluateToolAdmissibility` + `requiresApproval`), and the
 *  `EffectivePolicy`-wrapped scope gate (`evaluateScopeAdmissibility`) were deleted
 *  with the matrix modules. Approval is now op-risk × stage-trust
 *  (`op-risk-admission.ts`); access is the op-admission grant gate
 *  (`op-admission-gate.ts`) + the per-tool `allowed_tools` check
 *  (`admitContractToolAccess`). What survives here is the decision SHAPE every gate
 *  returns plus the scope fence.
 *
 *  Spec: D-153; D-157 § N.3 / A.2; D-187. */

import { isReadableCollection } from './read-collection-grant.js';
import type { IngredientKind, RiskTier } from './ingredient.js';
import type {
  AuthorizationProvenance,
  OperationApproval,
  OwnerOverridePolicy,
} from './ingredient-catalog.js';
import type { PreflightOverrideOffer } from './preflight-signal.js';

/** Kernel slugs whose dispatch scope is the `data.form_response` collection.
 *  Underscore, not the hyphen the generic leading-segment rule would produce.
 *  Every `form-response-*` op belongs here — the read AND every write. */
const FORM_RESPONSE_SCOPED_SLUGS: ReadonlySet<string> = new Set([
  'form-response-list',
  'form-response-get',
  'form-response-set-state',
]);


// ────────────────────────────────────────────────────────────────
// Admission decision shape — closed deny-code list
// ────────────────────────────────────────────────────────────────

/** Closed enumeration of deny-reason codes returned by the admission gates.
 *  Stable strings — embedded in audit rows, surfaced in user-facing
 *  approval-blocked messages, queried by upstream observability. Adding a code
 *  requires updating the closed list + every consumer that switches on it.
 *  D-187 retired the matrix coarse-gate (`risk_tier_not_allowed`) + rate-limit
 *  (`rate_limit_rpm` / `rate_limit_daily`) codes with the substrate, and renamed
 *  `policy_matrix_denied` → `op_risk_denied` (the matrix is gone).
 *
 *  - `'kind_not_allowed'`         — the static recipe walk hit an unknown
 *                                   ingredient slug (manifest miss) — a fail-closed
 *                                   stand-in for "this tool can't be resolved"
 *                                   (`policy-gate.ts`).
 *  - `'tool_not_in_contract'`     — a contracted dispatch's tool slug is not in the
 *                                   contract snapshot's `allowed_tools` per-tool
 *                                   allowlist (`admitContractToolAccess`).
 *  - `'scope_not_in_restrictions'`— a `data.*` / `connection.*` scope path is not
 *                                   matched by any of the contract's
 *                                   `scope_restrictions` (`evaluateScopeRestrictions`).
 *  - `'op_risk_denied'`           — the op-risk × stage-trust resolver refused the
 *                                   op (a deny-class `default_policy`). The op-risk
 *                                   path normally resolves admit / ask, so this is a
 *                                   defensive deny; the matrix-free successor to the
 *                                   retired `policy_matrix_denied`.
 *  - `'op_not_granted'`           — D-187 AMENDMENT 3b: the dispatched op's grant
 *                                   entry resolves to a REVOKE (or an un-granted
 *                                   author-default) for the governing contract — the
 *                                   unified `(contract × grant)` admission gate.
 *                                   Distinct from `tool_not_in_contract` (the
 *                                   per-token MCP allowlist): this is the owner /
 *                                   standing-contract per-op grant. Emitted by the
 *                                   backend op-admission gate (`op-admission-gate.ts`);
 *                                   the `detail` names the op + the governing contract.
 *  - `'server_paused'`            — D-188: the master "Pause server" circuit-breaker is
 *                                   engaged, so every GOVERNED dispatch (owner-AI + doors)
 *                                   is frozen until the owner resumes. Distinct from
 *                                   `op_not_granted` (a per-op grant revoke): pause is a
 *                                   transient server-wide halt, not a grant decision, so it
 *                                   carries its own honest code (a paused server reads as
 *                                   "paused," never "not granted"). Emitted by the backend
 *                                   op-admission gate (`op-admission-gate.ts isFrozenByPause`);
 *                                   the contract-free owner HID + system channels bypass it. */
export const ADMISSION_DENY_CODES = [
  'kind_not_allowed',
  'tool_not_in_contract',
  'scope_not_in_restrictions',
  'op_risk_denied',
  'op_not_granted',
  /** The governing contract's `scope.connection_names` axis does not admit the
   *  connection this dispatch would authenticate with.
   *
   *  ⛔ NOT `scope_not_in_restrictions`, and the distinction is diagnostic, not
   *  cosmetic. That code means the snapshot's `scope_restrictions` PATH patterns
   *  refused the dispatch — and `connection.*` is unconditionally KEPT in
   *  `SCOPE_FENCE_KEEP_PATTERNS`, so anyone sent to look there would find the
   *  connection admitted and conclude the denial was a bug. Two different fences;
   *  reusing one name for both is the mistake the peer-ceiling code below spells
   *  out at length. */
  'connection_not_in_scope',
  'server_paused',
  /** D-234 § 234.1 — the owner's CEILING declined to answer this peer.
   *
   *  ⛔ NOT `tool_not_in_contract`, WHICH WAS THE FIRST SPELLING AND WAS A LIE.
   *  The tool IS in the contract — the peer is admitted, granted, and the recipe
   *  is installed; the owner simply declined to answer them with it. Reusing that
   *  code sends whoever diagnoses it to look at a contract that turns out to be
   *  correct, which is the same misnamed-vocabulary failure § 21 spent four
   *  commits undoing for `NETWORK_ERROR`.
   *
   *  ⚠ Distinct from `server_paused` too: that is a whole-server condition that
   *  clears on its own. This is a durable, per-peer, per-recipe DECISION. */
  'peer_admission_refused',
] as const;

/** String-literal union derived from `ADMISSION_DENY_CODES`. */
export type AdmissionDenyCode = (typeof ADMISSION_DENY_CODES)[number];

/** Predicate — true when `value` is a known `AdmissionDenyCode`. */
export const isAdmissionDenyCode = (
  value: unknown,
): value is AdmissionDenyCode =>
  typeof value === 'string'
  && (ADMISSION_DENY_CODES as readonly string[]).includes(value);

/** Closed set of admission verdicts. D-157 P1 widens the D-153 P2.B
 *  binary `admit` / `deny` decision into a tri-state — the gateway's
 *  policy matrix can yield `ask`, the verdict it turns into a preflight
 *  approval (D-157 N.3). The verdict is produced internally by the
 *  `evaluate*` helpers and consumed in-process; it never crosses the
 *  wire, so — unlike `AdmissionDenyCode` — it carries no runtime guard. */
export type AdmissionVerdict = 'admit' | 'deny' | 'ask';

/** Result of an evaluate* call — a tri-state discriminated on `verdict`
 *  (D-157 P1; pre-D-157 this was a binary `admit: true | false`):
 *
 *  - `'admit'` — the bare success; dispatch may proceed.
 *  - `'deny'`  — refused; carries a stable `code` + a free-form
 *    `detail`. `detail` is for human reading, not programmatic
 *    matching — key off `code` instead.
 *  - `'ask'`   — admissible, but the cell's `approval_required_tiers`
 *    puts this `risk_tier` behind preflight approval. The gateway
 *    checkpoints the run and raises a `notification.ask` (D-157 N.3);
 *    `risk_tier` is the structured reason, `detail` the human-readable
 *    one. The op-risk × stage-trust resolver (`op-risk-admission.ts`)
 *    produces `ask`; the scope fence stays pure pass/fail. */
export type AdmissionDecision =
  | {
      readonly verdict: 'admit';
      /** Present on op-risk decisions; absent on structural access admits. */
      readonly authorization_provenance?: AuthorizationProvenance;
    }
  | {
      readonly verdict: 'deny';
      readonly code: AdmissionDenyCode;
      readonly detail: string;
      /** Present when an op-risk resolver, rather than an access fence, denied. */
      readonly authorization_provenance?: AuthorizationProvenance;
    }
  | {
      readonly verdict: 'ask';
      readonly risk_tier: RiskTier;
      readonly detail: string;
      /** D-209 §1.7 — load-bearing input to grant and quality handling. */
      readonly authorization_provenance: AuthorizationProvenance;
      /** D-211 — the exact simple-form owner ruling that produced this ask.
       * Carried only so the quality-gate authorization recompute applies the
       * same standing ruling and cannot skip an owner-authored `always`. */
      readonly owner_override?: OwnerOverridePolicy;
      readonly owner_override_offer?: PreflightOverrideOffer;
      /** D-211 — a hand-stored approval was raised to the hard risk floor. */
      readonly approval_clamped_from?: OperationApproval;
    };

/** Sentinel for the bare admit case; safe to share since the shape is
 *  frozen and structurally inert. Most evaluate* calls return this; a
 *  shared reference avoids allocating one object per admitted check. */
const ADMITTED: AdmissionDecision = Object.freeze({ verdict: 'admit' });

/** Allocate + freeze a deny decision. */
const deny = (code: AdmissionDenyCode, detail: string): AdmissionDecision =>
  Object.freeze({ verdict: 'deny', code, detail });

// ────────────────────────────────────────────────────────────────
// ToolUnderEvaluation — the dispatch descriptor a caller supplies
// ────────────────────────────────────────────────────────────────

/** Minimum shape a caller needs to supply about the tool being
 *  evaluated. `slug` is the ingredient slug (in the current
 *  one-ingredient-equals-one-tool model; the multi-tool ingredient
 *  upgrade per D-153 § ingredient upgrade is downstream). `kind` and
 *  `risk_tier` come from the ingredient manifest — both required by the
 *  validator since D-126, so this is always available at the dispatch
 *  boundary. */
export interface ToolUnderEvaluation {
  readonly slug: string;
  readonly kind: IngredientKind;
  readonly risk_tier: RiskTier;
}

// ────────────────────────────────────────────────────────────────
// evaluateScopeRestrictions — gate a data.* / connection.* path
// ────────────────────────────────────────────────────────────────

/** Gate `scopePath` against a bare `scope_restrictions` list. D-187: the
 *  per-call gateway probe fences directly against
 *  `ContractSnapshot.scope_restrictions` (the per-door collection fence, derived
 *  from `data.<collection>` grant rows); the matrix baseline cell and its
 *  `EffectivePolicy` wrapper were retired, so the list IS the fence. Empty list ⇒
 *  all paths admissible (no scope gate active).
 *
 *  Pattern grammar (intentionally minimal until the formal `ScopePattern` branded
 *  type lands per spec open question #21):
 *
 *    - `'<prefix>.*'`     — matches any path equal to `<prefix>` OR starting with
 *                           `<prefix>.`. The trailing segment-glob — most common form.
 *    - `'*'`              — universal match.
 *    - any other literal  — exact-match (no wildcards).
 *
 *  No support for embedded `*` or per-segment globbing — punted to the
 *  scope-grammar substrate (open question #21). */
export const evaluateScopeRestrictions = (
  scopeRestrictions: ReadonlyArray<string>,
  scopePath: string,
): AdmissionDecision => {
  if (scopeRestrictions.length === 0) {
    return ADMITTED;
  }
  for (const pattern of scopeRestrictions) {
    if (matchScopePattern(pattern, scopePath)) {
      return ADMITTED;
    }
  }
  return deny(
    'scope_not_in_restrictions',
    `path '${scopePath}' not matched by any of [${scopeRestrictions.join(', ')}]`,
  );
};

/** Pure scope-pattern matcher. See `evaluateScopeRestrictions` for the
 *  three-form grammar. Exported for tests + future scope-grammar
 *  consumers that want to share the implementation; not intended for
 *  use outside the `data.*` / `connection.*` path family. */
export const matchScopePattern = (pattern: string, path: string): boolean => {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    if (prefix.length === 0) return true;
    return path === prefix || path.startsWith(`${prefix}.`);
  }
  return path === pattern;
};

// ────────────────────────────────────────────────────────────────
// deriveDispatchScope — map a tool dispatch to its data.*/connection.* path
// ────────────────────────────────────────────────────────────────

/** The four `annotation-*` kernel slugs whose scope is the ANNOTATED RECORD'S
 *  collection rather than the generic `data.annotation`. A SET so a fifth
 *  annotation op cannot be added without landing here — the same reason
 *  `FORM_RESPONSE_SCOPED_SLUGS` is one. */
const ANNOTATION_SIDECAR_SLUGS: ReadonlySet<string> = new Set([
  'annotation-create',
  'annotation-delete',
  'annotation-list',
  'annotation-search',
]);

/** Resolve the annotated record's collection from an `annotation-*` dispatch's
 *  resolved input, or `undefined` when it cannot be named with confidence.
 *
 *  Accepts the combined `target` (`data.contact:jane@acme.com` — the
 *  `annotation-create` manifest shape; the leading `data.` is optional) and the
 *  split `target_collection` (`-delete` / `-list` / `-search`). Applies the same
 *  `email` -> `mail` alias the generic rule and `timeline-read` apply.
 *
 *  Returns `undefined` unless the result is a governed readable collection, so
 *  a caller cannot name a keep-pattern family (`memory` / `shared` /
 *  `enrichment`) and inherit its unconditional admission. */
const annotationTargetCollection = (
  input: Record<string, unknown> | undefined,
): string | undefined => {
  const named = (raw: string): string | undefined => {
    const colon = raw.indexOf(':');
    const head = (colon > 0 ? raw.slice(0, colon) : raw).trim();
    const bare = head.startsWith('data.') ? head.slice('data.'.length) : head;
    if (bare.length === 0 || bare.includes('.')) return undefined;
    const aliased = bare === 'email' ? 'mail' : bare;
    return isReadableCollection(aliased) ? aliased : undefined;
  };
  const combined = input?.['target'];
  if (typeof combined === 'string') {
    const fromCombined = named(combined);
    if (fromCombined !== undefined) return fromCombined;
  }
  const split = input?.['target_collection'];
  if (typeof split === 'string') return named(split);
  return undefined;
};

/** Derive the canonical `data.*` / `connection.*` scope path a tool
 *  dispatch targets, so the per-call admission probe can gate it via
 *  `evaluateScopeRestrictions`. Returns `null` when the dispatch touches
 *  no gated scope family — every kind other than `connection`
 *  (named-endpoint calls) and `storage` (warehouse reads/writes). A
 *  `null` scope means "scope axis N/A": the caller admits on it, because
 *  a `scope_restrictions` fence only ever RESTRICTS the listed families
 *  (a cell with no restrictions admits everything; the `http` / `ai` /
 *  `mcp` / `dom` / `chat` / `service` kinds never write a gated scope).
 *
 *  Derivation:
 *
 *    - `connection`-kind → `connection.<connection_kind>` read from the
 *      RESOLVED `input.connection_kind` (`api` / `mcp` / `notification`)
 *      — the SAME value the `connection` adapter dispatches on
 *      (`packages/ingredients/src/connection.ts`), so a recipe can't
 *      declare one sub-kind in its manifest and override to another in
 *      args to slip past the fence. A connection ingredient with no /
 *      non-string `connection_kind` (the `*-catalog` + connection-
 *      management wrappers) resolves to the bare `connection` scope,
 *      which matches no `connection.<sub>.*` restriction → fail closed.
 *      The trailing `.<name>` segment is deliberately omitted: the
 *      launch restriction patterns gate the sub-kind family
 *      (`connection.api.*`), and `matchScopePattern` matches the bare
 *      `connection.api` against it exactly.
 *
 *    - `storage`-kind → `data.<collection>` from the kernel slug's
 *      leading segment, with the established `email-*` → `mail`
 *      canonicalization (mirrors `platformForSlug` in the kernel — the
 *      slug keeps `email-*` for recipe authors; the warehouse collection
 *      is `mail`). Yields `data.<other>` for every other collection
 *      (denied under a `data.enrichment.*`-only fence). EXCEPTION:
 *      `enrichment-*` ops gate PER-TOPIC — `data.enrichment.<topic>` from the
 *      resolved `topic` arg (bare `data.enrichment` only when no topic is
 *      present) — so a contract grants enrichment access per topic row, while a
 *      `data.enrichment.*` grant still covers every topic for the webhook
 *      reconcilers. This is the one fence the D-136 `mcp_exposed` per-topic read
 *      control folds into.
 *      EXCEPTION: `data-file-read` is special-cased to `data.file` — the
 *      file-read collection is `file` (the slug's SECOND segment), not its
 *      leading `data` segment, so the generic leading-segment rule would
 *      mis-derive `data.data` and mis-evaluate `data.file` `scope_restrictions`.
 *
 *  Pure — no store reads, no clock. The result feeds
 *  `evaluateScopeRestrictions(scope_restrictions, scopePath)`. */
/** D-249 — kernel slugs whose GOVERNED COLLECTION arrives in the args rather than
 *  in the slug. `work-entity-*` names it `kind`; `data-annotate` names it
 *  `target_collection`. Both are checked against `isReadableCollection` at the
 *  use site — the value is caller-supplied. */
const COLLECTION_ARG_SLUGS: ReadonlySet<string> = new Set([
  'work-entity-get',
  'work-entity-list',
  'data-annotate',
]);

/** D-249 — kernel slugs that write NO governed collection, so the scope axis does
 *  not apply to them (`null`, the same answer every non-storage kind gets).
 *
 *  ⛔⛔ THEY ARE `kind: 'storage'` FOR ROUTING, NOT FOR STORAGE. On a kernel
 *  ingredient that kind is what sends the dispatch to the kernel adapter; the
 *  scope fence read it as "touches a collection" and manufactured
 *  `data.<leading-segment>` — `data.peer`, `data.seller`, `data.schedule` — names
 *  that appear in no namespace table and can appear in no grant row.
 *
 *  ⚠ MEMBERSHIP IS A CLAIM, so each family carries its reason:
 *
 *   - `peer-ask` — suspends the run and puts a question to a PERSON on another
 *     server. Reads and writes nothing locally. (D-234 § 234.4.)
 *   - `notification-send` — fans text to channels. No record.
 *   - `schedule-recipe` — writes a schedule row; schedules are not a warehouse
 *     collection the owner browses under `data.*`.
 *   - `exchange-status` — folds RUN rows under an exchange ref. Run history is
 *     `data.audit`, which is not a `READABLE_COLLECTION` and is gated by
 *     `core.audit.read` instead (D-232 § 20.9 put it on that existing door
 *     deliberately, rather than minting a second name for one authority).
 *   - `csv-*` — operate on a passed record/blob handle, not on a collection.
 *   - the `seller-*` / `customer-access-*` families — offers, orders, tiers and
 *     customer access rows. A seller's ledger is its own store; the owner does
 *     not read it through `data.<collection>` and no grant row names it.
 *
 *  ⛔ NOT HERE, DELIBERATELY: the LINK family (`link-create` / `-delete` /
 *  `-list`, `data-link`). A link spans TWO records in TWO collections, and this
 *  fence carries ONE path — so admitting it on either end would let one
 *  collection's grant reach every other, which is precisely the hazard the
 *  annotation sidecar note above describes. It stays denied at a fenced door
 *  until the fence can express a pair; that is a design change, not a list entry. */
const NO_GOVERNED_COLLECTION_SLUGS: ReadonlySet<string> = new Set([
  'peer-ask',
  'notification-send',
  'core-notification-send',
  'core-notification-recipe-callback',
  'schedule-recipe',
  'exchange-status',
  'csv-columns',
  'csv-filter',
  'csv-stats',
  'seller-offer-attach-fulfillment',
  'seller-offer-ensure',
  'seller-offer-get',
  'seller-offer-list',
  'seller-order-attach-artifact',
  'seller-order-attach-payment',
  'seller-order-confirm-payment',
  'seller-order-confirm-refund',
  'seller-order-confirm-renewal-payment',
  'seller-order-get',
  'seller-order-link-customer',
  'seller-order-link-work-entity',
  'seller-order-list',
  'seller-order-open',
  'seller-order-quote',
  'seller-order-transition',
  'seller-tier-get',
  'seller-tier-list',
  'customer-access-close',
  'customer-access-extend',
  'customer-access-issue',
  'customer-access-swap-tier',
]);

export const deriveDispatchScope = (
  tool: { readonly kind: IngredientKind; readonly slug: string },
  input: Record<string, unknown> | undefined,
): string | null => {
  if (tool.kind === 'connection') {
    const connectionKind = input?.['connection_kind'];
    return typeof connectionKind === 'string' && connectionKind.length > 0
      ? `connection.${connectionKind}`
      : 'connection';
  }
  if (tool.kind === 'storage') {
    // Review F2 finding B — `data-file-read` is the one storage slug whose
    // warehouse collection (`file`) is NOT its leading slug segment (the slug
    // leads with `data`, so the generic rule below would yield `data.data`).
    // The collection is the slug's 2nd segment, so special-case it to
    // `data.file`. Hardcoded literal (contracts MUST NOT import backend — the
    // canonical const is `DATA_FILE_READ_INGREDIENT_SLUG` in
    // `backend/server/src/collections/file/file-read-handler.ts`). This
    // special-case affects ONLY this slug; every other storage slug keeps the
    // generic leading-segment rule below (verified by tests:
    // `mail-send`→`data.mail`, `enrichment-upsert`→`data.enrichment`, …).
    if (tool.slug === 'data-file-read') {
      return 'data.file';
    }
    // FormResponses use the canonical underscore collection name. The generic
    // leading-segment rule would collapse `form-response-*` to `data.form`,
    // widening or denying against the wrong grant row. Keep the recipe-side
    // ops aligned with the owner Data browser's `data.form_response` grant.
    //
    // ⚠ A SET, not a second `===` literal. When A.8 slice 2 added the write op
    // the read's special case did not cover it, and the miss is SILENT: the new
    // slug would simply resolve to `data.form` and be gated against a row that
    // does not describe it. One membership test, so a third slug cannot be
    // added without landing here. ⇒ [[feedback_a_subset_typechecks_so_derive_the_closed_list]]
    if (FORM_RESPONSE_SCOPED_SLUGS.has(tool.slug)) {
      return 'data.form_response';
    }
    // D-177 read-gate — `timeline-read`'s scope is the ENTITY's collection,
    // NOT the fixed `data.timeline` the generic leading-segment rule would
    // yield. The entity is a `<collection>:<id>` string (kernel-validated),
    // so reading X's timeline requires X's collection scope — the SAME
    // invariant as a direct `<collection>` read and the MCP meta-tool's
    // `readableCollectionsFromScopeRestrictions` fence (so the recipe channel
    // and the MCP channel can't diverge; the generic `data.timeline` would
    // both over-restrict a collection-scoped door AND, if `data.timeline`
    // were granted, let it read any entity ungated). A raw collection prefix
    // (no dot) → `data.<collection>` (with the same `email`→`mail` alias);
    // a dotted platform-ref prefix (`connection.api.…:id`) or an unparseable
    // entity falls back to `data.timeline` (the prior behavior — its own
    // gate decides). Static-`input` only; the resolved `input.entity` is what
    // the gate sees, the same value the dispatcher reads.
    if (tool.slug === 'timeline-read') {
      const entity = input?.['entity'];
      if (typeof entity === 'string') {
        const colon = entity.indexOf(':');
        const prefix = colon > 0 ? entity.slice(0, colon) : '';
        if (prefix.length > 0 && !prefix.includes('.')) {
          return `data.${prefix === 'email' ? 'mail' : prefix}`;
        }
      }
      return 'data.timeline';
    }
    // D-177 sidecar gate — an annotation's scope is the ANNOTATED RECORD'S
    // collection, not the fixed `data.annotation` the generic leading-segment
    // rule yields. Same reasoning as `timeline-read` above, and the same two
    // failure directions: the generic scope both OVER-restricts a
    // collection-scoped door (proven live 2026-08-21 — an MCP door granted a
    // recipe whose only write is `core.memory.annotation.create` was denied
    // `scope_not_in_restrictions: path 'data.annotation'`, and NO door can ever
    // be granted it: `annotation` is not a `READABLE_COLLECTION`, so no grant
    // row produces `data.annotation.*`, and it is not a keep-pattern) and would,
    // if it WERE admitted generically, let one grant annotate every record in
    // every collection ungated.
    //
    // An annotation row has no identity of its own — it is keyed
    // `(target_collection, target_id, key)` — so the parent record's grant is
    // the only coherent gate. `annotation-create` carries the combined
    // `target` (`data.contact:jane@acme.com`, per its manifest); `-delete`,
    // `-list` and `-search` carry `target_collection`.
    //
    // ⛔ THE COLLECTION IS CALLER-SUPPLIED, so it is checked against
    // `isReadableCollection` — the FENCE'S OWN closed vocabulary — before a
    // scope is derived from it. Without that check `target: 'data.memory:x'`
    // would derive `data.memory`, which the keep-patterns admit
    // unconditionally, and the gate would be bypassable by lying about the
    // target. Anything else (unknown collection, dotted platform ref, absent
    // target) falls back to `data.annotation` — today's behaviour, and denied
    // by every fence, so this case only ever ADMITS a dispatch whose target
    // names a collection the door already holds.
    if (ANNOTATION_SIDECAR_SLUGS.has(tool.slug)) {
      const collection = annotationTargetCollection(input);
      if (collection !== undefined) return `data.${collection}`;
      return 'data.annotation';
    }
    // ⛔⛔⛔ D-249 — A KERNEL OP THAT NAMES A COLLECTION IN ITS ARGS IS FENCED BY
    // THAT COLLECTION, NOT BY ITS SLUG. `work-entity-*` carries the collection as
    // `kind` (task / project / note / commitment / booking) and `data-annotate`
    // carries it as `target_collection` — the same shape the annotation sidecar
    // above already handles for its four siblings, which is why it was written.
    //
    // 🔑 WITHOUT THIS THEY DERIVED `data.work` / `data.data`, which matches no
    // grant row — so a door granted `data.task` was DENIED a task read, and the
    // only way to admit it was to grant EVERY collection (which empties the
    // fence). The generic rule was fencing them on a name nobody can grant.
    //
    // ⛔ CALLER-SUPPLIED, so it is checked against `isReadableCollection` — the
    // fence's OWN closed vocabulary — exactly as `annotationTargetCollection`
    // does, and for the same reason: without the check, `kind: 'memory'` would
    // derive a keep-pattern family and admit unconditionally. An unknown /
    // absent value falls through to the generic rule below, which denies.
    if (COLLECTION_ARG_SLUGS.has(tool.slug)) {
      const named = input?.['kind'] ?? input?.['target_collection'];
      if (typeof named === 'string') {
        const aliased = named === 'email' ? 'mail' : named;
        if (isReadableCollection(aliased)) return `data.${aliased}`;
      }
    }
    // ⛔⛔⛔ D-249 — AND AN OP THAT TOUCHES NO GOVERNED COLLECTION MUST NOT CLAIM
    // ONE. The generic rule below reads the slug's leading segment, which is a
    // proxy for "the collection this writes" and is simply FALSE for a kernel op
    // that writes none: `peer-ask` put a question to a person and derived
    // `data.peer`; `schedule-recipe` derived `data.schedule`; the seller ops
    // derived `data.seller`. None of those names a warehouse collection, so none
    // can appear in any grant row.
    //
    // ⛔⛔ AND THE RESULT WAS AN INVERTED FENCE, not a closed one. An unmatched
    // scope DENIES at a fenced door — but `scopeRestrictionsFromReadableCollections`
    // returns `[]` when every collection is granted, and an empty list ADMITS.
    // So granting a peer a NARROW set of collections denied these ops, and
    // granting them EVERYTHING admitted them: narrowing the grant was what broke
    // an op that touches no collection. A fence that is strictest at the most
    // permissive door is not protecting anything.
    //
    // ⇒ `null` is the honest answer, and it is the one this function already
    // gives every non-storage kind: "scope axis N/A — the caller admits on it".
    // Authorization does not move: these ops still need an explicit
    // `contract_grant` row naming them AND still face `admitByOpRisk`, where a
    // `write` op at a delegated door's `read` ceiling resolves to `ask`.
    //
    // ⚠ AN EXPLICIT CLOSED SET, NEVER A HEURISTIC ("is the segment a known
    // collection?"). A heuristic would silently absorb the next kernel slug whose
    // leading segment happens not to match — including one that genuinely writes
    // a collection under a name nobody remembered to add. Adding a member here is
    // a deliberate statement that the op writes no governed collection; the
    // ratchet in `d-249-kernel-scope-classification.test.ts` pins the whole set.
    if (NO_GOVERNED_COLLECTION_SLUGS.has(tool.slug)) return null;
    const dash = tool.slug.indexOf('-');
    const segment = dash === -1 ? tool.slug : tool.slug.slice(0, dash);
    const collection = segment === 'email' ? 'mail' : segment;
    // Enrichment ops gate PER-TOPIC. An `enrichment-*` dispatch (read
    // `enrichment-list` / write `enrichment-upsert`) carries a `topic`, so its
    // scope is `data.enrichment.<topic>` — the per-topic resource row a contract
    // grants. A `data.enrichment.*` grant still matches every topic (the webhook
    // reconcilers keep working), and a `data.enrichment.<topic>` grant admits only
    // that topic. This folds the per-topic read control that D-136 `mcp_exposed`
    // carried into the ONE universal scope fence (the two-layer model: door on/off
    // + per-resource scope rows). A dispatch with no resolved `topic` (malformed —
    // the handler rejects it with `topic is required`) falls back to the bare
    // `data.enrichment` family scope (still matched by a `data.enrichment.*` grant,
    // denied by a per-topic grant — fail closed against a narrower fence).
    if (collection === 'enrichment') {
      const topic = input?.['topic'];
      if (typeof topic === 'string' && topic.length > 0) {
        return `data.enrichment.${topic}`;
      }
    }
    return `data.${collection}`;
  }
  return null;
};
