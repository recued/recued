/** Connection-agnostic op dispatch — the R1 install-time resolver.
 *
 *  Rewrites a connection-agnostic canonical recipe (one whose steps carry
 *  `CanonicalOpStep`s — a bare `deal.search`, no concrete ingredient/connection)
 *  into a standard vendor-bound `RecipeDefinition` that runs through the existing
 *  engine / gateway / audit path unchanged. Each op-step expands into two
 *  concrete steps:
 *    1. `<id>__raw` — a catalog fetch (`ingredient: <catalog>`, `connection:
 *       <bound>`, `input: { operation, args }`) dispatched via the connection
 *       gateway, exactly like any catalog op.
 *    2. `<id>` — a `map` projection from the vendor record shape to canonical
 *       field names (`maps_to` ← `{{item.<field_path>}}`), KEEPING the op-step's
 *       id so downstream `{{step.<id>}}` reads see canonical records.
 *
 *  Three pieces (contract §2):
 *    A. dispatch   — `deal.search` → vendor op via the registry crm_alias→entity
 *       map + the pack's `operation_families` (match the `<entity>.<verb>`
 *       operation id) + the pack's bound connection/catalog.
 *    B. projection — vendor `field_path` → canonical `maps_to` via the pack's
 *       `entity_fields`, applied with a clean `map` step (pure refs preserve
 *       type). Request-only fields are excluded.
 *    C. op-step    — `CanonicalOpStep` is rewritten away here (R1), so the
 *       engine never executes one.
 *
 *  Pure + portable (no backend import): the binding / catalog / result-envelope
 *  arrive via the injected `PackResolutionContext`. Design + probe results:
 *  `docs/unified-pack-exploration/connection-agnostic-op-contract.md`.
 *
 *  G2 (slice 5 + datetime unify): a `number` canonical field is coerced from a
 *  string vendor value, and a `datetime` (`date_ms`) field is normalized to unix-MS
 *  from either an epoch-ms or an ISO vendor value, at the projection (see
 *  `projectionRef`) — so the canonical record honors its declared type identically
 *  across vendors.
 *
 *  NEXT-1 (search-query derivation): for a `search` op the vendor-neutral
 *  `CanonicalSearchArgs` (`{ limit, filter, sort }`) are translated to the vendor
 *  query — HubSpot search POST body / Salesforce SOQL `q` — via
 *  `deriveVendorSearchArgs` (`connection-agnostic-search.ts`), the request-side
 *  mirror of the read projection. The query builder is selected by the catalog's
 *  declared `ctx.search_style` DIALECT, not the vendor — so a 3rd-party CRM whose
 *  search API matches a shipped dialect resolves with zero new code (a catalog that
 *  declares no dialect fails closed at the `search` op). `read` NEUTRALIZES its
 *  canonical `id` selector → the vendor path-param token `<vendorEntity>_id` (the same
 *  selector-only shape as `delete`, via the shared `deriveRecordSelectorArgs`), so a
 *  connection-agnostic read never hard-codes the vendor token.
 *
 *  Write-verb reverse projection (§C): for `create`/`update` the canonical write body
 *  (`{ name, stage, … }`) is reverse-projected to the vendor write body (HubSpot
 *  `body.properties` / Salesforce flat sObject) via `deriveVendorWriteArgs`
 *  (`connection-agnostic-write.ts`) — the inverse of the read projection, selected by
 *  the catalog's `ctx.write_style` DIALECT; the canonical `id` selector maps to the
 *  vendor path-param token (`delete` carries only the selector). Only source-backed
 *  canonical fields are WRITABLE (§2B — a derived field has no row → fails closed). The
 *  reverse-projected write body rides the `<id>__raw` fetch's `input.args` (the REQUEST).
 *
 *  Single-object RESPONSE projection (read / create / update): a `read`/`create`/`update`
 *  op returns ONE vendor record (not a collection), so its projection step is a
 *  single-object `project` transform (not the `search` collection `map` — `map` over a
 *  non-array yields `[]`). `project` applies the SAME projection template to the BARE
 *  response record (`{{step.<id>__raw.result}}`, no records-array envelope) via the
 *  shared `resolveExpression`, so `{{step.<id>.<canonical_field>}}` reads canonical with
 *  identical G2 `| number` coercion + nested-template behavior. So read/create/update
 *  all resolve to TWO steps (fetch + project); only `delete` is a single fetch (204 — no
 *  body to project); `search` keeps the two-step fetch + collection `map`.
 *
 *  Deferred: request-side `datetime` FILTER/sort coercion (the read projection now
 *  normalizes `datetime` → unix-ms, but translating a canonical date THRESHOLD to
 *  each vendor's search WHERE-clause date literal is a separate vendor-specific
 *  follow-on); op-steps in `prefetch_steps`. (Derived read-only fields (G3) + walk-all
 *  pagination are now BUILT — see `buildDerivationExpr` / the search derivation.)
 */
import {
  ACCT_ALIAS_VALUES,
  CANONICAL_CRM_VERBS,
  CRM_ALIAS_VALUES,
  getVendorEntityByAcctAlias,
  getVendorEntityByCrmAlias,
  isCanonicalOpStep,
  type AcctAlias,
  fieldDerivationInputPaths,
  type CanonicalOpStep,
  type CrmAlias,
  type EntityFieldRow,
  type FieldDerivation,
  type IngredientStep,
  type PackResolutionContext,
  type RecipeDefinition,
  type RecipeStep,
  type ResolvedBinding,
  type TransformStep,
} from '@recued/contracts';
import { deriveVendorSearchArgs } from './connection-agnostic-search.js';
import {
  PROJECTION_FIELD_PATH_REGEX,
  PROTOTYPE_SENSITIVE_KEYS,
  isSafeCanonicalKey,
  parseOpStepConnectionRef,
} from './connection-agnostic-paths.js';
import { deriveRecordSelectorArgs, deriveVendorWriteArgs } from './connection-agnostic-write.js';

const CRM_ALIAS_SET: ReadonlySet<string> = new Set<string>(CRM_ALIAS_VALUES);

/** SMB-finance slice 5b — the accounting canonical entity vocabulary. An
 *  `<acct_alias>.<verb>` op-step dispatches to the bound accounting vendor's
 *  by-value pack (QuickBooks / Xero). */
const ACCT_ALIAS_SET: ReadonlySet<string> = new Set<string>(ACCT_ALIAS_VALUES);

/** SMB-finance slice 5b — accounting canonical ops are READ-ONLY: a money write
 *  (create/update/void/payment/refund) MUST ride the explicit ingredient binding
 *  (so it carries its approval context + is never agnostic-dispatched), never a
 *  canonical op-step. So an `<acct_alias>.<verb>` admits only the two read verbs. */
const CANONICAL_ACCT_VERBS = ['search', 'read'] as const;
const CANONICAL_ACCT_VERB_SET: ReadonlySet<string> = new Set<string>(CANONICAL_ACCT_VERBS);

/** The canonical CRM verb vocabulary an op-step may use (convention §2). A pack's
 *  vendor-specific (non-canonical) ops are not reachable through a canonical op. */
const CANONICAL_VERB_SET: ReadonlySet<string> = new Set<string>(CANONICAL_CRM_VERBS);

/** `EntityFieldRow.applies` values that mark a field request-side (write args) —
 *  excluded from the read projection. */
const REQUEST_APPLIES: ReadonlySet<string> = new Set(['request', 'req']);

// Projection path safety (SECURITY) — untrusted 3rd-party field identifiers.
// `PROTOTYPE_SENSITIVE_KEYS` / `PROJECTION_FIELD_PATH_REGEX` / `isSafeCanonicalKey`
// were extracted to `connection-agnostic-paths.ts` (write-verb reverse projection
// slice) so the read projection here AND the write reverse projection
// (`connection-agnostic-write.ts`) enforce the SAME grammar without a circular
// import. See that module for the full SECURITY rationale.

/** Thrown when a canonical op-step cannot bind against the pack resolution
 *  context (unknown crm_alias for the vendor, the pack lacks the operation, or
 *  no projectable fields). */
export class CanonicalOpResolutionError extends Error {
  readonly code = 'CANONICAL_OP_RESOLUTION_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalOpResolutionError';
  }
}

/** Parse `<entity>.<verb>` → `{ crmAlias, verb }`. The entity must be a known
 *  `crm_alias`; exactly one dot is allowed. */
const parseCanonicalOp = (op: string): { crmAlias: CrmAlias; verb: string } => {
  const dot = op.indexOf('.');
  if (dot <= 0 || dot >= op.length - 1 || op.indexOf('.', dot + 1) !== -1) {
    throw new CanonicalOpResolutionError(
      `malformed canonical op '${op}' — expected '<entity>.<verb>'`,
    );
  }
  const entity = op.slice(0, dot);
  const verb = op.slice(dot + 1);
  if (!CRM_ALIAS_SET.has(entity)) {
    throw new CanonicalOpResolutionError(
      `canonical op '${op}' entity '${entity}' is not a crm_alias (${CRM_ALIAS_VALUES.join(' | ')})`,
    );
  }
  if (!CANONICAL_VERB_SET.has(verb)) {
    throw new CanonicalOpResolutionError(
      `canonical op '${op}' verb '${verb}' is not a canonical CRM verb (${CANONICAL_CRM_VERBS.join(' | ')}) — vendor-specific ops are not reachable through a canonical op`,
    );
  }
  return { crmAlias: entity as CrmAlias, verb };
};

/** SMB-finance slice 5b — parse `<acct_alias>.<verb>` for an accounting canonical
 *  op. The entity must be a known `acct_alias`; the verb is restricted to the two
 *  READ verbs (`search` / `read`) — a money write must ride the explicit ingredient
 *  binding, never a canonical op-step. (The caller has already confirmed the family
 *  is in `ACCT_ALIAS_SET` before reaching here.) */
const parseCanonicalAcctOp = (op: string): { acctAlias: AcctAlias; verb: string } => {
  const dot = op.indexOf('.');
  // The family-in-ACCT_ALIAS_SET guard at the call site guarantees a single dot
  // with a non-empty family; re-validate the verb segment defensively.
  const entity = op.slice(0, dot);
  const verb = op.slice(dot + 1);
  if (!CANONICAL_ACCT_VERB_SET.has(verb)) {
    throw new CanonicalOpResolutionError(
      `canonical accounting op '${op}' verb '${verb}' is not a read verb (${CANONICAL_ACCT_VERBS.join(' | ')}) — ` +
      `accounting writes (create / update / void / payment / refund) ride the explicit ingredient binding so they keep their approval gate, not a canonical op-step`,
    );
  }
  return { acctAlias: entity as AcctAlias, verb };
};

/** Set a (possibly dotted) canonical `maps_to` into a NESTED object template, so
 *  a dotted canonical field projects to nested output (`key_dates.close_date` →
 *  `{ key_dates: { close_date: <ref> } }`) addressable by a dotted `{{item.*}}`
 *  read downstream. A flat dotted key (`{ 'key_dates.close_date': <ref> }`) would
 *  instead be a single literal key the dotted-path resolver can't reach (the
 *  `map` transform recurses nested object templates but assigns keys literally). */
const assignProjectionPath = (
  template: Record<string, unknown>,
  mapsTo: string,
  ref: unknown,
): void => {
  const parts = mapsTo.split('.');
  // Defense in depth: a prototype-sensitive segment (`__proto__`/`constructor`/
  // `prototype`) would walk this write to the prototype chain. `resolveOpStep`
  // already fails closed on such a `maps_to` (`isSafeCanonicalKey`), so this is
  // unreachable in practice — but keep the helper self-safe for any caller.
  if (parts.some((seg) => PROTOTYPE_SENSITIVE_KEYS.has(seg))) return;
  let cursor = template;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const seg = parts[i];
    const next = cursor[seg];
    if (next === undefined || typeof next !== 'object' || next === null) {
      cursor[seg] = {};
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = ref;
};

/** (G2) The projection ref for one canonical field. Two canonical types are
 *  COERCED so the SAME canonical field reads identically across vendors; every
 *  other type stays a pure, type-preserving ref.
 *
 *  `number` — many vendors (HubSpot in particular) return numerics as STRINGS
 *  (`properties.amount: "30000"`), and a pure ref preserves that string, so the
 *  canonical record breaks its declared numeric type two ways: (1) a missing /
 *  empty value stays a non-null `""` string, so `is_null` / `is_not_null`
 *  mis-classify a deal with no amount as HAVING one; (2) any consumer that doesn't
 *  itself `Number()`-coerce — display, an AI prompt, JSON output, a strict-equality
 *  check — reads a string where the convention declares a number. We emit the
 *  `map`-expression numeric-coercion form (`{{item.<path> | number}}`): the
 *  evaluator coerces via `Number()` (so exponent forms like `1e-7` parse correctly)
 *  and PRESERVES a missing / empty / non-finite value as `null` (NOT 0, which would
 *  wrongly satisfy `is_not_null` / `equal 0`). Note `applyReduce`'s `sum`/`avg` AND
 *  `evaluateOp`'s `greater`/`less`/`equal` already `Number()`-coerce, so numeric
 *  aggregates + comparisons were already correct on a string amount — `number`'s job
 *  is the null-classification + the non-coercing READ consumers they don't cover.
 *
 *  `datetime` (registry `date_ms`) — THE cross-vendor portability bite (converged
 *  §8 "G2 type unify"). HubSpot returns `closedate` as an epoch-MS string
 *  ("1735689600000"); Salesforce returns `CloseDate` as an ISO string
 *  ("2025-01-15") / datetime. A pure ref leaves canonical `key_dates.close_date` as
 *  two DIFFERENT shapes per vendor, so a portable recipe can't sort/compare/format
 *  it. We emit `{{item.<path> | date_ms}}`: the evaluator normalizes BOTH forms to a
 *  single unix-MS number (`Number()`-first for the epoch-ms form, `Date.parse`
 *  fallback for ISO), preserving missing / empty / unparseable as `null`. This
 *  honors the registry's declared `date_ms` type ("numerically the same as
 *  `number`") so canonical dates are comparable + `:date`/`:relative`-formattable.
 *  (Request-side `search` filter/sort over a `datetime` field — translating a
 *  threshold to each vendor's WHERE-clause date literal — stays a documented
 *  follow-on; this is the read-projection half §8 names.) */
const projectionRef = (field: EntityFieldRow): string => {
  if (field.type === 'number') return `{{item.${field.field_path} | number}}`;
  if (field.type === 'datetime') return `{{item.${field.field_path} | date_ms}}`;
  return `{{item.${field.field_path}}}`;
};

/** The response-side `entity_fields` rows for one vendor entity. Matches the
 *  entity case-insensitively (`OperationRow.family` is lowercase, the schema's
 *  `EntityFieldRow.entity` is the object name, e.g. `Deal`) and excludes
 *  request-only fields. Shared by the read projection (`buildProjectionTemplate`)
 *  AND the request-side search derivation, so a `search` SELECTs exactly the
 *  fields the projection reads back.
 *
 *  Exported for the poll-manager (G6): its canonical poll runs the SAME
 *  rows → search-args → projection pipeline at runtime that the install
 *  resolver lowers into recipes — one semantics source. */
export const vendorEntityResponseRows = (
  entityFields: ReadonlyArray<EntityFieldRow>,
  vendorEntity: string,
): EntityFieldRow[] => {
  const target = vendorEntity.toLowerCase();
  return entityFields.filter(
    (field) =>
      field.entity.toLowerCase() === target &&
      !(field.applies !== undefined && REQUEST_APPLIES.has(field.applies)),
  );
};

/** (B) Build the projection object template from a vendor entity's response rows:
 *  canonical `maps_to` → projected vendor field (pure ref, or a G2 numeric
 *  coercion — see `projectionRef`), nesting dotted `maps_to` (e.g.
 *  `key_dates.close_date`). */
/** (B, G3 lift) Lower a `FieldDerivation` to a projection expression the engine's
 *  `resolveExpression` evaluates per record. `closed_state` → a NESTED `$ternary`
 *  over the two vendor flags: `closed ? (won ? "won" : "lost") : "open"` (a flag
 *  that arrives as a "true"/"false" string on HubSpot is handled by `$ternary`'s
 *  bool coercion). `concat` → a `$concat` over the part refs joined by `separator`,
 *  skipping empty parts, falling back to `fallback_path` when all are empty (the
 *  cross-vendor contact `name` for HubSpot/Salesforce). Each input path becomes a
 *  `{{item.*}}` ref, validated in `resolveOpStep` like every other projected path. */
const buildDerivationExpr = (d: FieldDerivation): unknown => {
  if (d.kind === 'closed_state') {
    return {
      $ternary: {
        if: `{{item.${d.closed_path}}}`,
        then: { $ternary: { if: `{{item.${d.won_path}}}`, then: 'won', else: 'lost' } },
        else: 'open',
      },
    };
  }
  // The fallback rides the same `{{item.*}}` ref, optionally through the
  // `| local_part` projection hint (an email field → its name part).
  const fallbackRef = d.fallback_path === undefined
    ? undefined
    : d.fallback_transform === 'local_part'
      ? `{{item.${d.fallback_path} | local_part}}`
      : `{{item.${d.fallback_path}}}`;
  return {
    $concat: {
      parts: d.parts.map((p) => `{{item.${p}}}`),
      separator: d.separator ?? '',
      ...(fallbackRef !== undefined ? { fallback: fallbackRef } : {}),
    },
  };
};

/** Exported for the poll-manager (G6) — see `vendorEntityResponseRows`. */
export const buildProjectionTemplate = (
  rows: ReadonlyArray<EntityFieldRow>,
): Record<string, unknown> => {
  const template: Record<string, unknown> = {};
  for (const field of rows) {
    const projected = field.derivation !== undefined
      ? buildDerivationExpr(field.derivation)
      : projectionRef(field);
    assignProjectionPath(template, field.maps_to, projected);
  }
  return template;
};

/** Resolve the connection a single op-step binds to — shared by the CRM and the
 *  §5 tool-op paths (the binding rule is verb/entity-agnostic, doc §1.3). An
 *  explicit per-operand slot ref wins over the pack default. SECURITY: a slot must
 *  be a PURE `{{config.<var>}}` ref naming a DECLARED `type:'connection'` variable —
 *  anything else (a literal name, interpolation, another namespace, an
 *  undeclared/arbitrary config key) would re-point the dispatch target from data /
 *  non-portable state, so it fails closed here even if a caller skipped the
 *  validator. Neither a slot nor a pack default → fail closed (a multi-variable
 *  recipe's op-step with no slot is ambiguous by construction). */
const resolveStepConnection = (
  step: CanonicalOpStep,
  ctx: PackResolutionContext,
  declaredConnectionVars: readonly string[],
): string => {
  if (step.connection !== undefined) {
    const slotVar = parseOpStepConnectionRef(step.connection);
    if (slotVar === undefined) {
      throw new CanonicalOpResolutionError(
        `canonical op '${step.op}' (step '${step.id}') has an invalid connection slot ` +
        `'${step.connection}' — must be a pure {{config.<var>}} ref naming a type:'connection' recipe variable`,
      );
    }
    if (!declaredConnectionVars.includes(slotVar)) {
      throw new CanonicalOpResolutionError(
        `canonical op '${step.op}' (step '${step.id}') connection slot names variable '${slotVar}', ` +
        `which is not declared as a type:'connection' variable`,
      );
    }
  }
  const connection = step.connection ?? ctx.connection;
  if (connection === undefined) {
    throw new CanonicalOpResolutionError(
      `canonical op '${step.op}' (step '${step.id}') has no connection to bind — name a per-operand ` +
      `slot (connection: "{{config.<var>}}") or install into a pack with a bound connection`,
    );
  }
  return connection;
};

/** §5 tool-op pack seam — resolve a NON-CRM canonical op-step (`web.search`) into a
 *  SINGLE concrete catalog fetch. Unlike a CRM op (entity translate + canonical-field
 *  projection), a tool op names a pack-declared catalog operation DIRECTLY and is
 *  dispatched PASS-THROUGH: the op-step's `args` ride the fetch verbatim and the raw
 *  catalog response is the op's observable output (`{{step.<id>.result…}}`) — there is
 *  no vendor→canonical projection (a tool pack is entity-less, v3 §7). So the fetch
 *  KEEPS the op-step id (single-step, like the CRM `delete` verb — no `__raw` split, no
 *  projection step). The op string IS the catalog operation id; the bound pack MUST
 *  declare it (fail-closed). The richer kind (e.g. web egress) stays a GATED catalog
 *  operation through the existing D-165 gateway — the whole point of the seam: a
 *  published recipe reaches it only as a pack-bound op, never as a direct ingredient. */
const resolveToolOpStep = (
  step: CanonicalOpStep,
  ctx: PackResolutionContext,
  connection: string,
): { steps: RecipeStep[]; binding: ResolvedBinding } => {
  // Defense in depth (the validator already enforces exactly one dot): a tool op is
  // `<family>.<verb>` — reject any other shape so a catalog can't expose an op under
  // a malformed id (trailing / multiple dots) even if a caller skipped the validator.
  // Mirrors `parseCanonicalOp`'s dot-rigor for the CRM path.
  const dot = step.op.indexOf('.');
  if (dot <= 0 || dot >= step.op.length - 1 || step.op.indexOf('.', dot + 1) !== -1) {
    throw new CanonicalOpResolutionError(
      `malformed tool op '${step.op}' (step '${step.id}') — expected '<family>.<verb>'`,
    );
  }
  const opRow = ctx.operation_families.find((o) => o.operation === step.op);
  if (opRow === undefined) {
    throw new CanonicalOpResolutionError(
      `pack '${ctx.pack_slug}' has no operation '${step.op}' for tool op-step '${step.id}'`,
    );
  }
  // The `<family>.<verb>` verb segment (after the single dot, guaranteed above).
  // Recorded on the binding for disclosure; a tool verb is NOT a CRM collection
  // verb, so the install-path collection result_path warning never fires for it
  // (and that warning additionally gates on `op_kind !== 'tool'`).
  const verb = step.op.slice(dot + 1);
  const fetch: IngredientStep = {
    id: step.id,
    ingredient: ctx.catalog_slug,
    connection,
    input: { operation: step.op, args: step.args ?? {} },
    ...(step.skip_when !== undefined ? { skip_when: step.skip_when } : {}),
    ...(step.fail_on !== undefined ? { fail_on: step.fail_on } : {}),
    ...(step.cache !== undefined ? { cache: step.cache } : {}),
    // A tool op resolves to ONE pass-through fetch, so `foreach` (the engine's
    // per-iteration knob) rides it verbatim — the op iterates exactly like a foreach
    // ingredient step, `{{item.*}}` in `args` binding per iteration, each call's
    // failure isolated into an `{ ok:false }` envelope by the foreach loop. The CRM
    // path can't carry it (fetch + projection is two steps); the validator rejects it
    // there (`op_step_iteration_unsupported`). No `optional` here — it is a
    // prefetch-only knob (the validator rejects it on every op-step).
    ...(step.foreach !== undefined ? { foreach: step.foreach } : {}),
  };
  const binding: ResolvedBinding = {
    op_kind: 'tool',
    canonical_op: step.op,
    verb,
    operation: step.op,
    catalog_slug: ctx.catalog_slug,
    connection,
    vendor: ctx.vendor,
    step_id: step.id,
    result_path: '',
  };
  return { steps: [fetch], binding };
};

/** (A + C) Resolve one canonical op-step into its concrete fetch + projection
 *  steps and the binding it resolved to. */
const resolveOpStep = (
  step: CanonicalOpStep,
  ctx: PackResolutionContext,
  declaredConnectionVars: readonly string[],
  reservedIds: ReadonlySet<string>,
  generatedRawIds: Set<string>,
): { steps: RecipeStep[]; binding: ResolvedBinding } => {
  // §5 tool-op pack seam — branch on the op FAMILY before any parsing / connection
  // binding (it needs only `step.op`). A well-formed op is `<family>.<verb>` (exactly
  // one dot — the validator enforces that). A DOTTED op whose family is not a
  // `crm_alias` is a TOOL op (`web.search`): it names a pack-declared catalog
  // operation directly and dispatches pass-through (no entity translation, no
  // canonical-field projection). A no-dot op (`family === ''`) falls through to the
  // CRM `parseCanonicalOp` so its precise `malformed` error is preserved.
  const familyDot = step.op.indexOf('.');
  const family = familyDot > 0 ? step.op.slice(0, familyDot) : '';
  const isAcct = family !== '' && ACCT_ALIAS_SET.has(family);
  if (family !== '' && !CRM_ALIAS_SET.has(family) && !isAcct) {
    const toolConnection = resolveStepConnection(step, ctx, declaredConnectionVars);
    return resolveToolOpStep(step, ctx, toolConnection);
  }

  // Parse FIRST, then resolve the connection, so a malformed / bad-verb op surfaces
  // its parse error before any connection-binding error (preserving the pre-seam
  // error precedence). The accounting (`acct_alias`) arm is the SMB-finance slice-5b
  // sibling of the CRM arm: a different alias registry + a READ-ONLY verb set + an
  // IDENTITY entity mapping (the canonical name IS the pack entity, no remap), but
  // the SAME projection + step-emission tail below.
  const acctParsed = isAcct ? parseCanonicalAcctOp(step.op) : undefined;
  const crmParsed = isAcct ? undefined : parseCanonicalOp(step.op);
  const crmAlias = crmParsed?.crmAlias;
  const verb = isAcct ? acctParsed!.verb : crmParsed!.verb;
  const connection = resolveStepConnection(step, ctx, declaredConnectionVars);

  // (A.1) alias → vendor entity via the registry. `ctx.registry` lets the install
  // path widen the lookup with a pack's own lifted entities (CRM slice 4.5;
  // accounting slice 5b); undefined → the built-in `CONNECTION_VENDOR_ENTITIES`.
  // For accounting the lookup is an IDENTITY (entity === alias) but still CONFIRMS
  // the bound vendor models the alias before dispatching.
  const vendorEntity = isAcct
    ? getVendorEntityByAcctAlias(ctx.vendor, acctParsed!.acctAlias, ctx.registry)?.entity
    : getVendorEntityByCrmAlias(ctx.vendor, crmAlias as CrmAlias, ctx.registry)?.entity;
  if (vendorEntity === undefined) {
    throw new CanonicalOpResolutionError(
      `vendor '${ctx.vendor}' does not model ${isAcct ? 'acct_alias' : 'crm_alias'} '${family}' (canonical op '${step.op}')`,
    );
  }

  // (A.2) the vendor op id is `<vendorEntity>.<verb>`; confirm the pack declares
  // it. (`OperationRow.verb` is the HTTP method, so the match is on the op id.)
  const expectedOperation = `${vendorEntity}.${verb}`;
  const opRow = ctx.operation_families.find((o) => o.operation === expectedOperation);
  if (opRow === undefined) {
    throw new CanonicalOpResolutionError(
      `pack '${ctx.pack_slug}' has no operation '${expectedOperation}' for canonical op '${step.op}'`,
    );
  }

  // (B) projection from the pack's entity_fields for this vendor entity.
  const responseRows = vendorEntityResponseRows(ctx.entity_fields, vendorEntity);

  // Fail closed on a DUPLICATE canonical mapping: the read projection is last-wins
  // (`assignProjectionPath` overwrites) while the search reverse map is first-wins,
  // so two rows mapping the same `maps_to` to DIFFERENT vendor fields would read
  // one field and filter/sort another — a silent inconsistency. (Registry rows are
  // unique per the registry validator; this guards a hand-built / 3rd-party
  // `PackResolutionContext`.)
  const seenMapsTo = new Set<string>();
  for (const row of responseRows) {
    // SECURITY — a 3rd-party pack's `field_path` (composition `source_path`, only
    // non-whitespace-validated upstream) is interpolated into `{{item.<field_path>}}`
    // and its `maps_to` becomes nested projection KEYS. Fail closed on a `field_path`
    // that isn't a plain projectable dot-path (→ template-ref injection / warehouse
    // exfiltration) or a `maps_to` that isn't a safe canonical key (→ prototype
    // pollution). First-party registry rows always pass; this guards the 3rd-party /
    // hand-built context. See `PROJECTION_FIELD_PATH_REGEX` / `isSafeCanonicalKey`.
    if (!PROJECTION_FIELD_PATH_REGEX.test(row.field_path)) {
      throw new CanonicalOpResolutionError(
        `pack '${ctx.pack_slug}' field '${row.maps_to}' for '${vendorEntity}' has an unprojectable vendor field_path ` +
        `'${row.field_path}' (canonical op '${step.op}') — must be a dot-path of identifier/index segments ` +
        `(${PROJECTION_FIELD_PATH_REGEX.source})`,
      );
    }
    // A derived field embeds its input paths in the projection expression as
    // `{{item.*}}` refs (the PRIMARY == `field_path`, checked above; `closed_state`
    // adds `won_path`, `concat` adds the remaining parts + `fallback_path`). EVERY
    // input path must be the same kind of safe dot-path — otherwise a 3rd-party /
    // hand-built context could inject a template ref (warehouse exfiltration via
    // the map-expr deferItem resolve), exactly the `field_path` vector (d997a500).
    if (row.derivation !== undefined) {
      for (const inputPath of fieldDerivationInputPaths(row.derivation)) {
        if (!PROJECTION_FIELD_PATH_REGEX.test(inputPath)) {
          throw new CanonicalOpResolutionError(
            `pack '${ctx.pack_slug}' field '${row.maps_to}' for '${vendorEntity}' has an unprojectable derivation input path ` +
            `'${inputPath}' (canonical op '${step.op}') — must be a dot-path of identifier/index segments`,
          );
        }
      }
    }
    if (!isSafeCanonicalKey(row.maps_to)) {
      throw new CanonicalOpResolutionError(
        `pack '${ctx.pack_slug}' declares an unsafe canonical field name '${row.maps_to}' for '${vendorEntity}' ` +
        `(canonical op '${step.op}') — canonical fields must be dotted identifier segments and not prototype keys`,
      );
    }
    if (seenMapsTo.has(row.maps_to)) {
      throw new CanonicalOpResolutionError(
        `pack '${ctx.pack_slug}' declares duplicate canonical field '${row.maps_to}' for '${vendorEntity}' (canonical op '${step.op}')`,
      );
    }
    seenMapsTo.add(row.maps_to);
  }

  // `delete` is selector-only — it reverse-maps no fields (no read projection, no
  // write body, no `write_style`), so it must NOT require the entity to declare any
  // projectable/writable fields. Read/search (project results) and create/update
  // (reverse-project a body) DO need ≥1 mapped field, so the empty gate stands for
  // them. (The per-row field_path / maps_to safety loop above still runs for delete —
  // a whole-entity invariant — but a clean entity passes it; only a malformed pack
  // trips it, which is the right fail-closed direction.)
  const projection = buildProjectionTemplate(responseRows);
  if (verb !== 'delete' && Object.keys(projection).length === 0) {
    throw new CanonicalOpResolutionError(
      `pack '${ctx.pack_slug}' declares no projectable entity_fields for '${vendorEntity}' (canonical op '${step.op}')`,
    );
  }

  // (A.3) request-side arg derivation, by verb:
  //  - `search` — the vendor-NEUTRAL `CanonicalSearchArgs` (`{ limit, filter, sort }`)
  //    are translated to the vendor query (HubSpot search POST body / Salesforce SOQL
  //    `q`) from the SAME response rows (NEXT-1), selected by `ctx.search_style`.
  //  - `create`/`update`/`delete` — the canonical write body (`{ name, stage, … }`)
  //    is reverse-projected to the vendor write body (HubSpot `body.properties` /
  //    Salesforce flat sObject fields) from the SAME response rows, selected by
  //    `ctx.write_style`; the canonical `id` selector maps to the vendor path-param
  //    token (write-verb reverse projection, §C). `delete` carries only the selector.
  //  - `read` — NEUTRALIZES its canonical `id` record selector to the vendor path-param
  //    token `<vendorEntity>_id` (selector-only — identical arg shape to `delete`), so a
  //    connection-agnostic read recipe addresses a record by canonical `id` and never
  //    hard-codes the vendor token. The single response RECORD is projected by the
  //    `project` step below (canonical single-object response projection).
  // Every derivation is vendor-decoupled (a 3rd-party CRM declaring a shipped dialect
  // resolves with zero new code) and fails closed (→ install-block) on a bad arg shape
  // or a catalog that declares no dialect.
  let dispatchArgs: Record<string, unknown> = step.args ?? {};
  if (isAcct && verb === 'search') {
    // Accounting `search` passes args THROUGH verbatim — the by-value accounting
    // pack bakes the vendor filter into the binding's `static_query` (QuickBooks SQL
    // `SELECT … MAXRESULTS`, Xero `where=Type=="ACCREC"`) and the recipe filters the
    // PROJECTED canonical records itself. So there is no vendor search DIALECT to
    // derive (the packs declare no `search_style`); the projection below still maps
    // each vendor's raw record to the canonical field names.
    dispatchArgs = step.args ?? {};
  } else if (verb === 'search') {
    const derived = deriveVendorSearchArgs(ctx.search_style, vendorEntity, responseRows, step.args ?? {});
    if (!derived.ok) {
      throw new CanonicalOpResolutionError(
        `pack '${ctx.pack_slug}' cannot derive the ${ctx.vendor} search query for canonical op '${step.op}': ${derived.reason}`,
      );
    }
    dispatchArgs = derived.args;
  } else if (verb === 'read') {
    const derived = deriveRecordSelectorArgs(vendorEntity, 'read', step.args ?? {});
    if (!derived.ok) {
      throw new CanonicalOpResolutionError(
        `pack '${ctx.pack_slug}' cannot derive the ${ctx.vendor} read selector for canonical op '${step.op}': ${derived.reason}`,
      );
    }
    dispatchArgs = derived.args;
  } else if (verb === 'create' || verb === 'update' || verb === 'delete') {
    const derived = deriveVendorWriteArgs(ctx.write_style, vendorEntity, verb, responseRows, step.args ?? {});
    if (!derived.ok) {
      throw new CanonicalOpResolutionError(
        `pack '${ctx.pack_slug}' cannot derive the ${ctx.vendor} write body for canonical op '${step.op}': ${derived.reason}`,
      );
    }
    dispatchArgs = derived.args;
  }

  // Effective result-envelope key. A per-op `OperationRow.result_path` override wins
  // ONLY when non-empty; an absent OR empty (`''`) per-op value inherits the surface
  // default (`ctx.result_path`) — the decided semantic ("empty per-op = inherit"; NOT
  // `??`, which would treat `''` as an explicit per-op bare-array). Computed before
  // the verb fork so both shapes record it on the binding (`result_path` addresses
  // the records array WITHIN the vendor body — HubSpot `results`, Salesforce
  // `records`; empty means the vendor body IS the array).
  const opOverride = opRow.result_path;
  const effectiveResultPath =
    opOverride !== undefined && opOverride.length > 0 ? opOverride : ctx.result_path;

  const binding: ResolvedBinding = {
    // A CRM op leaves `op_kind` ABSENT (absent === 'crm', preserving the shipped CRM
    // binding shape); an accounting op marks itself `'acct'` and carries an
    // `acct_alias` (via `canonical_op`) instead of a `crm_alias`.
    ...(isAcct ? { op_kind: 'acct' as const } : {}),
    canonical_op: step.op,
    ...(crmAlias !== undefined ? { crm_alias: crmAlias } : {}),
    ...(isAcct ? { acct_alias: acctParsed!.acctAlias } : {}),
    verb,
    vendor_entity: vendorEntity,
    operation: opRow.operation,
    catalog_slug: ctx.catalog_slug,
    connection,
    vendor: ctx.vendor,
    step_id: step.id,
    result_path: effectiveResultPath,
  };

  // (C.delete) `delete` is the ONLY single-step verb: a SINGLE concrete fetch KEEPING
  // the op-step id — no `__raw` split, no projection. The vendor returns 204 with no
  // body, so there is nothing to project; the op's observable output is the raw
  // delete envelope (`{{step.<id>.result…}}`). `fail_on` rides this single step (it
  // IS the result).
  if (verb === 'delete') {
    const deleteFetch: IngredientStep = {
      id: step.id,
      ingredient: ctx.catalog_slug,
      connection,
      input: { operation: opRow.operation, args: dispatchArgs },
      ...(step.skip_when !== undefined ? { skip_when: step.skip_when } : {}),
      ...(step.fail_on !== undefined ? { fail_on: step.fail_on } : {}),
      ...(step.cache !== undefined ? { cache: step.cache } : {}),
    };
    return { steps: [deleteFetch], binding };
  }

  // read / search / create / update — the two-step shape: a raw catalog fetch +
  // a projection step that KEEPS the op-step id (so downstream `{{step.<id>}}` reads
  // see canonical fields). `search` projects the records COLLECTION with `map`;
  // `read` / `create` / `update` project the SINGLE response record with `project`
  // (canonical single-object response projection — `map` over a non-array yields `[]`,
  // so single-object ops need `project`).
  const rawId = `${step.id}__raw`;
  if (reservedIds.has(rawId) || generatedRawIds.has(rawId)) {
    throw new CanonicalOpResolutionError(
      `generated raw step id '${rawId}' (from canonical op '${step.op}') collides with an existing step id`,
    );
  }
  generatedRawIds.add(rawId);

  // concrete catalog fetch — raw vendor envelope, routed through the gateway.
  // `skip_when` gates the whole op; `cache` (the IO knob) rides the fetch. For
  // create/update the reverse-projected vendor write BODY rides this fetch's
  // `input.args` (`dispatchArgs` from `deriveVendorWriteArgs` — the REQUEST); the
  // projection step below projects the RESPONSE record.
  const fetchRaw: IngredientStep = {
    id: rawId,
    ingredient: ctx.catalog_slug,
    connection,
    input: { operation: opRow.operation, args: dispatchArgs },
    ...(step.skip_when !== undefined ? { skip_when: step.skip_when } : {}),
    ...(step.cache !== undefined ? { cache: step.cache } : {}),
  };

  // The fetched step value is NOT the bare vendor body. The catalog op dispatches
  // through the connection-api, whose response shape is
  // `{ status, headers, result: <vendor body> }`, and a connection-agnostic
  // catalog's `output` map (`{ result: "result" }`, emitted by the decomposer +
  // carried by the bundled catalogs) keeps the vendor body under `.result` — so
  // the stored value is `{ result: <vendor body> }`. The records array therefore
  // lives at `<raw>.result.<envelope>` (or `<raw>.result` when the vendor body IS
  // the array). Prepending `result.` here — rather than baking it into every
  // `result_path` — keeps `result_path` the intuitive vendor envelope an author
  // declares, and rides the connection-api response invariant uniformly.
  //
  // search → the records array at `<raw>.result.<envelope>` (collection projection).
  // read / create / update → the SINGLE record is the BARE vendor body at
  // `<raw>.result` (a single-object op has NO collection envelope, so the
  // `effectiveResultPath` records-array suffix does NOT apply — the `project`
  // step's `object` is the bare record).
  const projectionStep: TransformStep =
    verb === 'search'
      ? // clean `map` projection over the records array, KEEPING the canonical id so
        // downstream `{{step.<id>}}` reads project. The map-expression fix defers
        // `{{item.*}}` so the object template resolves per record; pure refs preserve
        // types. `skip_when` mirrors the fetch; `fail_on` checks the projected
        // canonical result; `cache` (the op-step's freshness intent) rides BOTH steps
        // so it gates the projection's L2 step cache — the observable canonical output
        // — as well as the fetch.
        {
          id: step.id,
          transform: 'map',
          array:
            effectiveResultPath.length > 0
              ? `{{step.${rawId}.result.${effectiveResultPath}}}`
              : `{{step.${rawId}.result}}`,
          expression: projection,
          ...(step.skip_when !== undefined ? { skip_when: step.skip_when } : {}),
          ...(step.fail_on !== undefined ? { fail_on: step.fail_on } : {}),
          ...(step.cache !== undefined ? { cache: step.cache } : {}),
        }
      : // single-object `project` over the bare response record, KEEPING the canonical
        // id so downstream `{{step.<id>.<canonical_field>}}` reads see canonical
        // fields. Uses the SAME projection template the search `map` uses (shared
        // `resolveExpression` → identical G2 `| number` coercion + nested templates +
        // type-preservation). `skip_when` / `fail_on` / `cache` ride it exactly as the
        // `map` projection does.
        {
          id: step.id,
          transform: 'project',
          object: `{{step.${rawId}.result}}`,
          expression: projection,
          ...(step.skip_when !== undefined ? { skip_when: step.skip_when } : {}),
          ...(step.fail_on !== undefined ? { fail_on: step.fail_on } : {}),
          ...(step.cache !== undefined ? { cache: step.cache } : {}),
        };

  return { steps: [fetchRaw, projectionStep], binding };
};

/** The recipe's declared `type:'connection'` variable names, in declaration
 *  order — the per-operand SLOT vocabulary (doc §1.3). Shared by the install
 *  path's slot plan, the recipe validator, and the dispatch slot derivation so
 *  "what counts as a connection variable" is one rule. */
export const connectionVariableNames = (
  recipe: Partial<Pick<RecipeDefinition, 'variables'>>,
): string[] => {
  const names: string[] = [];
  for (const [name, def] of Object.entries(recipe.variables ?? {})) {
    // A VariableDefault is a bare literal (string/number/boolean/string[]/null)
    // or a ValueHint object — only the object form can carry `type`.
    if (def !== null && typeof def === 'object' && !Array.isArray(def)
      && (def as { type?: unknown }).type === 'connection') {
      names.push(name);
    }
  }
  return names;
};

/** Per-operand connection SLOT derivation (R2 step 5, doc §1.3) — map each
 *  op-step in `steps` to the `type:'connection'` variable it binds:
 *
 *    - explicit `connection: "{{config.<var>}}"` slot → `<var>` (the ref shape
 *      and the variable's declaration are validated — fail-closed);
 *    - omitted + exactly ONE declared connection variable → that variable (the
 *      single-target catalog-recipe convention);
 *    - omitted + zero or several declared variables → typed failure (nothing to
 *      bind / ambiguous — every op-step of a multi-variable recipe must name
 *      its slot).
 *
 *  The DISPATCH-side derivation: each distinct variable is a slot the run
 *  supplies a connection for (`config.<var>`), so the caller resolves each
 *  slot's connection → catalog and feeds a per-step context selector. (The
 *  install paths use their own plan with a pack-default tier this helper
 *  deliberately lacks — a composition's bound connection is not a variable.)
 *  Pure; ignores `prefetch_steps` (op-steps there are rejected elsewhere). */
export const opStepConnectionSlots = (
  recipe: Pick<RecipeDefinition, 'steps'> & Partial<Pick<RecipeDefinition, 'variables'>>,
): { ok: true; slotByStepId: Map<string, string>; variables: string[] }
  | { ok: false; reason: string } => {
  const connVars = connectionVariableNames(recipe);
  const slotByStepId = new Map<string, string>();
  const variables: string[] = [];
  for (const step of recipe.steps) {
    if (!isCanonicalOpStep(step)) continue;
    let varName: string;
    if (step.connection !== undefined) {
      const parsed = parseOpStepConnectionRef(step.connection);
      if (parsed === undefined) {
        return {
          ok: false,
          reason:
            `op-step '${step.id}' has an invalid connection slot '${step.connection}' — must be a pure ` +
            `{{config.<var>}} ref naming a type:'connection' recipe variable`,
        };
      }
      if (!connVars.includes(parsed)) {
        return {
          ok: false,
          reason:
            `op-step '${step.id}' connection slot names variable '${parsed}', which is not declared as a ` +
            `type:'connection' variable`,
        };
      }
      varName = parsed;
    } else if (connVars.length === 1) {
      varName = connVars[0];
    } else if (connVars.length === 0) {
      return {
        ok: false,
        reason:
          'recipe carries canonical op-steps but declares no type:\'connection\' variable to bind a connection at dispatch',
      };
    } else {
      return {
        ok: false,
        reason:
          `recipe declares ${connVars.length} connection variables (${[...connVars].sort().join(', ')}) — ` +
          `op-step '${step.id}' must name its slot explicitly (connection: "{{config.<var>}}")`,
      };
    }
    slotByStepId.set(step.id, varName);
    if (!variables.includes(varName)) variables.push(varName);
  }
  return { ok: true, slotByStepId, variables };
};

/** R1 install-time rewrite (and, with a selector, the R2 per-slot dispatch
 *  rewrite). Resolve every `CanonicalOpStep` in `recipe.steps` against its
 *  context into concrete catalog fetch + projection steps; non-op steps pass
 *  through unchanged. Returns the rewritten recipe (ready for the existing
 *  engine) + the resolved bindings (for install-time disclosure / grant keying).
 *
 *  `ctx` is one `PackResolutionContext` for every op-step (the install paths —
 *  a pack binds one catalog), or a per-step SELECTOR `(step) => ctx` for the
 *  per-operand dispatch path (doc §1.3): each op-step's slot can bind a
 *  different connection, whose catalog/vendor context the selector supplies —
 *  cross-vendor compare resolves each operand against its own registry mapping.
 *
 *  Throws `CanonicalOpResolutionError` if any op-step cannot bind. `prefetch_steps`
 *  are NOT rewritten — op-steps live in `steps`. */
export const resolveConnectionAgnosticRecipe = (
  recipe: RecipeDefinition,
  ctx: PackResolutionContext | ((step: CanonicalOpStep) => PackResolutionContext),
): { recipe: RecipeDefinition; bindings: ResolvedBinding[] } => {
  const ctxForStep = typeof ctx === 'function' ? ctx : () => ctx;
  // The declared slot vocabulary — an explicit per-step slot must name one of
  // these (fail-closed in `resolveOpStep`, independent of the validator).
  const declaredConnectionVars = connectionVariableNames(recipe);
  // Reserve every authored step id so a generated `<id>__raw` can't collide with
  // a real step (the op-step's own id is kept by its projection step).
  const reservedIds: ReadonlySet<string> = new Set(recipe.steps.map((s) => s.id));
  const generatedRawIds = new Set<string>();
  const bindings: ResolvedBinding[] = [];
  const steps: RecipeStep[] = [];

  for (const step of recipe.steps) {
    if (isCanonicalOpStep(step)) {
      const resolved = resolveOpStep(
        step, ctxForStep(step), declaredConnectionVars, reservedIds, generatedRawIds,
      );
      steps.push(...resolved.steps);
      bindings.push(resolved.binding);
    } else {
      steps.push(step);
    }
  }

  return { recipe: { ...recipe, steps }, bindings };
};
