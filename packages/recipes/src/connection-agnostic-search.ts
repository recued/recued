/** Connection-agnostic op dispatch — vendor SEARCH-query derivation (NEXT-1).
 *
 *  The request-side mirror of the read-side projection. A connection-agnostic
 *  `<crm_alias>.search` op-step carries vendor-NEUTRAL `CanonicalSearchArgs`
 *  (`{ limit, filter, sort }`) — NO vendor property names. The read-side
 *  projection (`connection-agnostic.ts`) maps the vendor record shape → canonical
 *  field names via the pack's `entity_fields`; THIS module does the inverse for
 *  the request: it derives the vendor SELECT + filter + sort + limit from the
 *  same `entity_fields` so a LIVE search hits the vendor with the right query.
 *
 *  Two search DSLs, structurally different, each its own builder keyed by the
 *  catalog-declared SEARCH DIALECT (`surfaces.api.search_style` — NEXT-1, vendor
 *  search-builder extensibility), NOT by the vendor id. Decoupling the builder from
 *  the vendor lets a 3rd-party CRM whose search API matches a shipped dialect declare
 *  it and resolve with zero new code; a structurally-novel API adds one reviewed
 *  dialect builder to the closed set below (the same extension model as
 *  `WebhookExecutionBinding.signature_scheme`):
 *    - `hubspot_search` — `POST /crm/v3/objects/{type}/search` with a JSON body
 *      `{ properties, filterGroups, sorts, limit }`. Emitted as connection-api
 *      `body.*` wire-key args.
 *    - `soql` — `GET /services/data/vXX/query?q=<SOQL>` (`SELECT … FROM …
 *      WHERE … ORDER BY … LIMIT …`). Emitted as the `query.q` wire-key arg.
 *
 *  The output is connection-api WIRE-KEY args (the same `body.*` / `query.*`
 *  shape the catalog gateway's `buildApiDispatchInput` folds, then the executor's
 *  `resolveRefs` resolves) — pure (no backend / engine import).
 *
 *  SAFETY — the connection-agnostic trust model says a recipe's blast radius is
 *  its DECLARED gated ops; an injectable filter would break that (a crafted WHERE
 *  could read beyond intent). So a LITERAL filter value is type-checked against the
 *  canonical field type before formatting, and:
 *    - HubSpot rides values as JSON body fields (no query-string injection); the
 *      value is matched literally by HubSpot.
 *    - Salesforce SOQL escapes + quotes string literals and emits type-checked
 *      number/boolean literals unquoted — never an arbitrary string into the query.
 *  A `{{ref}}`-valued filter resolves at runtime AFTER this build step, so it can't be
 *  type-checked or escaped here. v1 (B1) threads a PURE `{{ref}}` on a STRING field —
 *  the one case escapable without the value in hand — through the SAME two channels:
 *    - HubSpot emits the ref as the JSON body value, resolved at runtime (injection-safe
 *      by construction, exactly like a write body — see connection-agnostic-write.ts).
 *    - Salesforce emits the ref carrying a `soql_string` / `soql_like` ESCAPE HINT; the
 *      resolver escapes the resolved value into the query at interpolation (the runtime
 *      SOQL-escaping seam — `@recued/contracts` `soql.ts`), so an attacker-influenced
 *      value can never break out of its quoted literal.
 *  A ref on a NUMBER / BOOLEAN / DATETIME field stays rejected (it would splice UNQUOTED
 *  into SOQL — it needs a typed runtime escape that validates the resolved value to the
 *  field type with a fail-closed channel, a later slice), as does an interpolation /
 *  nested / malformed ref value (no single-hint escape). `limit` / `sort` carry no
 *  injectable value (`sort` is field-only; `limit` is a positive integer).
 *
 *  SCOPE (NEXT-1): SEARCH verb only. `read` (path-param args) + write verbs
 *  (`create`/`update`/`delete` — reverse-projection of a write body, §C) keep
 *  verbatim args (a later slice). `datetime` filters ARE now supported (G2 request
 *  side): a canonical threshold (ISO date / datetime string OR epoch-ms) normalizes
 *  to unix-ms, then formats to the vendor date literal per the field's declared
 *  `date_granularity` — HubSpot a string filter value, Salesforce an UNQUOTED SOQL
 *  date/datetime literal. A `datetime` field whose pack declares no granularity
 *  fails closed (filter it over the projected unix-ms in a transform instead). A
 *  catalog that declares no `search_style` (or an unknown dialect) fails closed — a
 *  3rd-party CRM whose API matches a shipped dialect declares it; a
 *  structurally-novel one needs a new dialect builder added.
 *
 *  PAGINATION (walk-all): a canonical `search` is WALK-ALL when the catalog
 *  operation declares v3 `pagination` (or a legacy CRM catalog declares
 *  `surfaces.api.pagination_style`). The gateway walks every page and merges
 *  the records so the recipe sees the FULL result set (bounded by
 *  `PAGINATION_MAX_RECORDS` / `PAGINATION_MAX_PAGES`, never silently truncated). So
 *  `limit` is NOT a total cap — it is a per-page SIZE HINT, and the two dialects
 *  consume it differently:
 *    - HubSpot — `body.limit` is the per-PAGE size; clamped to `HUBSPOT_SEARCH_PAGE_MAX`
 *      (the vendor's hard per-request max). The follower walks `paging.next.after`.
 *    - Salesforce — SOQL has no page-size knob (the Query API auto-batches), so the
 *      builder emits `LIMIT <PAGINATION_MAX_RECORDS>` to cap the set at the SOURCE
 *      (the follower's record ceiling, belt-and-suspenders with the gateway cap) and
 *      `limit` does NOT affect Salesforce. The follower walks `nextRecordsUrl`.
 *  (A future slice can add a vendor-neutral total cap if a recipe needs one; today
 *  the ceiling is the bound.)
 */
import type {
  CanonicalFilter,
  CanonicalFilterCondition,
  CanonicalFilterOperator,
  CanonicalFilterOrGroups,
  CanonicalSearchArgs,
  DateGranularity,
  EntityFieldRow,
  SearchStyle,
} from '@recued/contracts';
import {
  CANONICAL_CRM_FIELD_SCHEMA,
  CANONICAL_FILTER_OPERATORS,
  CANONICAL_UNARY_FILTER_OPERATORS,
  escapeSoqlStringLiteral,
  fieldDerivationInputPaths,
  NS,
  PAGINATION_MAX_RECORDS,
  SEARCH_STYLES,
} from '@recued/contracts';

/** Default per-PAGE size hint when a canonical `search` omits `limit` (walk-all —
 *  the gateway follows the vendor cursor across pages, so this sizes a page, not the
 *  total; see the module header). 100 = HubSpot's hard per-request max, so the
 *  default already fetches the largest page HubSpot allows (fewest round-trips);
 *  Salesforce ignores it (no page-size knob — it caps at `PAGINATION_MAX_RECORDS`).
 *  (HubSpot's own `/search` default is 10 — too small to be a useful canonical
 *  default.) */
export const DEFAULT_SEARCH_LIMIT = 100;

/** HubSpot's hard per-request page maximum on `POST …/search` (`body.limit` ≤ 100;
 *  the API rejects a larger value). The HubSpot builder clamps the canonical per-page
 *  `limit` hint to this so a recipe asking for a bigger page never trips a vendor
 *  400 — the gateway's cursor-follow loop assembles the full set across pages
 *  regardless. Salesforce has no equivalent (the Query API auto-batches), so this is
 *  HubSpot-only. */
export const HUBSPOT_SEARCH_PAGE_MAX = 100;

/** Conservative Pipedrive v2 page size for list endpoints. The gateway walks
 *  `additional_data.next_cursor`, so this is a per-page hint, not a total cap. */
export const PIPEDRIVE_SEARCH_PAGE_MAX = 50;

const FILTER_OPERATOR_SET: ReadonlySet<string> = new Set(CANONICAL_FILTER_OPERATORS);
const UNARY_OPERATOR_SET: ReadonlySet<string> = new Set(CANONICAL_UNARY_FILTER_OPERATORS);
const ARRAY_OPERATORS: ReadonlySet<CanonicalFilterOperator> = new Set(['in', 'not_in']);
const LIKE_OPERATORS: ReadonlySet<CanonicalFilterOperator> = new Set(['contains', 'not_contains']);

/** Build result — a discriminated union rather than a throw, so the search
 *  module stays free of the resolver's `CanonicalOpResolutionError` (no circular
 *  import) and the resolver attaches the op-step context to the message. */
export type SearchArgsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; reason: string };

/** A canonical filter condition resolved + validated against the pack's vendor
 *  fields — the vendor builders consume this and only FORMAT it (all field /
 *  type / value safety checks already happened centrally). */
interface ResolvedCondition {
  /** the resolved vendor field path (HubSpot `properties.dealstage`, SF `StageName`). */
  field_path: string;
  /** the canonical field type (drives SOQL quoting + the date-literal path). Never
   *  `json` (rejected during resolution). A `datetime` field is allowed when its
   *  pack declares `date_granularity` — its `values` are normalized unix-ms numbers
   *  (G2) and `granularity` formats the vendor date literal. */
  type: EntityFieldRow['type'];
  operator: CanonicalFilterOperator;
  /** literal values: `[]` for unary, `[v]` for binary / LIKE, `[…]` for in / not_in.
   *  For a `datetime` field these are normalized unix-MS numbers (the builder formats
   *  each to the vendor date literal per `granularity`). */
  values: unknown[];
  /** (G2) set ONLY for a `datetime` field — the field's date granularity, which
   *  formats the vendor date literal (`date` → `YYYY-MM-DD`, `datetime` → ISO-Z). */
  granularity?: DateGranularity;
}

/** The unix-MS window `Date.prototype.toISOString()` renders with a STRICT 4-digit
 *  year: `0000-01-01T00:00:00Z` … `9999-12-31T23:59:59.999Z`. Outside it,
 *  `toISOString` emits an expanded `±YYYYYY` year (malformed for both vendor query
 *  DSLs) or, beyond the ECMAScript Date range (±8.64e15), THROWS `RangeError`. A
 *  threshold outside this window fails closed in `coerceDateThresholdToMs` so
 *  formatting downstream can never throw or emit a non-strict literal. */
const MIN_STRICT_YEAR_MS = -62167219200000; // 0000-01-01T00:00:00Z
const MAX_STRICT_YEAR_MS = 253402300799999; // 9999-12-31T23:59:59.999Z

/** (G2) Coerce a canonical datetime filter THRESHOLD to a unix-MS number — the
 *  request-side mirror of the read projection's `| date_ms`. Accepts an epoch-ms
 *  number, an epoch-ms string, or an ISO date / datetime string; trims; returns
 *  `null` for empty / unparseable OR an out-of-range value (one that would make
 *  `toISOString` throw or emit an expanded-year literal — see the bounds above), so
 *  the caller fails the build closed rather than crashing / emitting garbage. */
const coerceDateThresholdToMs = (value: unknown): number | null => {
  let ms: number;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    ms = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    if (Number.isFinite(n)) {
      ms = n;
    } else {
      const parsed = Date.parse(trimmed);
      if (Number.isNaN(parsed)) return null;
      ms = parsed;
    }
  } else {
    return null;
  }
  return ms >= MIN_STRICT_YEAR_MS && ms <= MAX_STRICT_YEAR_MS ? ms : null;
};

/** (G2) Format a unix-MS threshold as the vendor-neutral ISO date literal for the
 *  field's `granularity` — `date` → `YYYY-MM-DD`, `datetime` →
 *  `YYYY-MM-DDThh:mm:ssZ` (sub-second stripped; SOQL date literals take no ms).
 *  PRECONDITION: `ms` is in the strict 4-digit-year window (guaranteed by
 *  `coerceDateThresholdToMs`, the only source of these values), so `toISOString`
 *  never throws nor emits an expanded year here.
 *  Both vendors consume this ISO content: HubSpot as a string filter value,
 *  Salesforce as an UNQUOTED SOQL date/datetime literal (both STRICT — a Date field
 *  needs `YYYY-MM-DD`, a DateTime field the full ISO-Z form — which is exactly why
 *  granularity is a per-field annotation). Always UTC (the canonical ms is UTC).
 *  Injection-safe by construction: derived from a NUMBER via `toISOString`, never a
 *  raw author string, so it splices into SOQL unquoted without an escaping seam. */
const formatDateLiteral = (ms: number, granularity: DateGranularity): string => {
  const iso = new Date(ms).toISOString(); // YYYY-MM-DDThh:mm:ss.sssZ (UTC)
  return granularity === 'date' ? iso.slice(0, 10) : iso.replace(/\.\d{3}Z$/, 'Z');
};

interface ResolvedSort {
  field_path: string;
  direction: 'asc' | 'desc';
}

interface VendorSearchInput {
  /** the vendor entity the canonical alias resolved to (e.g. `deal` /
   *  `opportunity` / `contact` / `account`). */
  vendorEntity: string;
  /** the response-side `entity_fields` for the vendor entity — the SELECT set.
   *  The resolver passes the SAME rows it builds the projection from, so request
   *  and read are symmetric. */
  rows: ReadonlyArray<EntityFieldRow>;
  /** the resolved + validated filter as an array of AND-groups (vendor builders
   *  only format). The groups are OR'd; conditions within a group are AND'd. The
   *  bare-condition / bare-array forms are a single group. `[]` = no filter. */
  conditionGroups: ReadonlyArray<ReadonlyArray<ResolvedCondition>>;
  sort: ResolvedSort | undefined;
  limit: number;
}

// A dialect builder may FAIL CLOSED (returns `SearchArgsResult`, not bare args):
// the `soql` builder rejects an unsafe field/object IDENTIFIER (a SOQL query has
// no identifier quoting, and a 3rd-party `soql` pack supplies its own field paths
// — see `isSafeSoqlIdentifier`). The HubSpot builder never fails (its field names
// ride a JSON body, structurally injection-safe).
type VendorSearchBuilder = (input: VendorSearchInput) => SearchArgsResult;

// ────────────────────────────────────────────────────────────────
// Canonical-args validation (shape — the vendor-neutral vocabulary)
// ────────────────────────────────────────────────────────────────

const KNOWN_SEARCH_ARG_KEYS: ReadonlySet<string> = new Set(['limit', 'filter', 'sort']);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validate + narrow a raw op-step `args` object to `CanonicalSearchArgs`. Unknown
 *  top-level keys are REJECTED — the canonical args are vendor-neutral, so a stray
 *  vendor key (a raw `filterGroups`, a typo'd `filters`) is an authoring error, not
 *  a silent no-op. */
const parseCanonicalSearchArgs = (
  raw: Record<string, unknown>,
): { ok: true; args: CanonicalSearchArgs } | { ok: false; reason: string } => {
  for (const key of Object.keys(raw)) {
    if (!KNOWN_SEARCH_ARG_KEYS.has(key)) {
      return {
        ok: false,
        reason:
          `search arg '${key}' is not a canonical search arg (allowed: ${[...KNOWN_SEARCH_ARG_KEYS].join(', ')}) — ` +
          `canonical args are vendor-neutral; the resolver derives the vendor query`,
      };
    }
  }

  const args: CanonicalSearchArgs = {};

  if (raw.limit !== undefined) {
    if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit <= 0) {
      return { ok: false, reason: `search arg 'limit' must be a positive integer` };
    }
    args.limit = raw.limit;
  }

  if (raw.filter !== undefined) {
    const parsed = parseFilter(raw.filter);
    if (!parsed.ok) return parsed;
    args.filter = parsed.filter;
  }

  if (raw.sort !== undefined) {
    const parsed = parseSort(raw.sort);
    if (!parsed.ok) return parsed;
    args.sort = parsed.sort;
  }

  return { ok: true, args };
};

/** Condition-object keys (a bare `{ field, operator, value }`). The OR-groups
 *  `{ any: [...] }` form is EXCLUSIVE with these — an object mixing `any` with a
 *  condition key is ambiguous and fails closed (`parseFilter`), never silently
 *  dropping the condition. */
const CONDITION_KEYS = ['field', 'operator', 'value'] as const;

/** Detect the `{ any: [...] }` OR-of-AND-groups shape: a plain object with an OWN
 *  `any` property (NOT a bare `{ field, operator }` condition object, which never
 *  has an `any` key). Own-property check (not `in`) so an inherited `any` can't
 *  misroute. The value isn't checked here — an `any` that isn't a non-empty array,
 *  or one mixed with condition keys, is routed here so `parseFilter` fails closed
 *  with the right reason. */
const isFilterOrGroups = (raw: unknown): raw is { any: unknown } =>
  isPlainObject(raw) && Object.prototype.hasOwnProperty.call(raw, 'any');

/** Validate + parse ONE filter condition object with the per-condition rules
 *  (field non-empty, operator in the set, unary/array/value rules) — the SAME
 *  checks the single-group path has always used. */
const parseCondition = (
  entry: unknown,
): { ok: true; condition: CanonicalFilterCondition } | { ok: false; reason: string } => {
  if (!isPlainObject(entry)) {
    return { ok: false, reason: `each filter condition must be an object { field, operator, value? }` };
  }
  if (typeof entry.field !== 'string' || entry.field.length === 0) {
    return { ok: false, reason: `filter condition 'field' must be a non-empty canonical field name` };
  }
  if (typeof entry.operator !== 'string' || !FILTER_OPERATOR_SET.has(entry.operator)) {
    return {
      ok: false,
      reason:
        `filter condition operator '${String(entry.operator)}' on '${entry.field}' is not a canonical filter ` +
        `operator (${[...FILTER_OPERATOR_SET].join(' | ')})`,
    };
  }
  const operator = entry.operator as CanonicalFilterOperator;
  if (UNARY_OPERATOR_SET.has(operator)) {
    if (entry.value !== undefined) {
      return { ok: false, reason: `filter operator '${operator}' on '${entry.field}' takes no value` };
    }
    return { ok: true, condition: { field: entry.field, operator } };
  }
  if (ARRAY_OPERATORS.has(operator)) {
    if (!Array.isArray(entry.value) || entry.value.length === 0) {
      return {
        ok: false,
        reason: `filter operator '${operator}' on '${entry.field}' requires a non-empty array value`,
      };
    }
  } else if (entry.value === undefined) {
    return { ok: false, reason: `filter operator '${operator}' on '${entry.field}' requires a value` };
  }
  return { ok: true, condition: { field: entry.field, operator, value: entry.value } };
};

/** Parse ONE AND-group — a single condition object OR a non-empty array of
 *  condition objects — into a `CanonicalFilterCondition[]`. An empty array group
 *  fails closed (a group must constrain something). */
const parseGroup = (
  raw: unknown,
): { ok: true; group: CanonicalFilterCondition[] } | { ok: false; reason: string } => {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) return { ok: false, reason: `a filter group must contain at least one condition` };
  const group: CanonicalFilterCondition[] = [];
  for (const entry of list) {
    const parsed = parseCondition(entry);
    if (!parsed.ok) return parsed;
    group.push(parsed.condition);
  }
  return { ok: true, group };
};

/** Parse a raw `filter` into the canonical filter shape. Routes the
 *  `{ any: [...] }` OR-of-AND-groups form (each `any` element is one AND-group)
 *  through `parseGroup`; the bare-condition / bare-array forms parse as a single
 *  AND-group, exactly as before. Normalization to `CanonicalFilterCondition[][]`
 *  happens in `normalizeFilterGroups`. */
const parseFilter = (
  raw: unknown,
): { ok: true; filter: CanonicalFilter } | { ok: false; reason: string } => {
  if (isFilterOrGroups(raw)) {
    // `any` (OR-groups) is EXCLUSIVE with bare-condition keys — an object carrying
    // both (e.g. `{ field, operator, value, any: [...] }`) is ambiguous; treating it
    // as OR-groups would SILENTLY drop the field/operator/value condition. Fail closed.
    const mixed = CONDITION_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(raw, k));
    if (mixed.length > 0) {
      return {
        ok: false,
        reason:
          `filter object mixes the OR-groups key 'any' with condition key(s) ${mixed.join(', ')} — ` +
          `use either { any: [...] } (OR-of-AND-groups) OR a bare { field, operator, value } condition, not both`,
      };
    }
    if (!Array.isArray(raw.any) || raw.any.length === 0) {
      return { ok: false, reason: `filter 'any' must be a non-empty array of AND-groups` };
    }
    const groups: Array<CanonicalFilterCondition | ReadonlyArray<CanonicalFilterCondition>> = [];
    for (const rawGroup of raw.any) {
      const parsed = parseGroup(rawGroup);
      if (!parsed.ok) return parsed;
      groups.push(parsed.group);
    }
    const orGroups: CanonicalFilterOrGroups = { any: groups };
    return { ok: true, filter: orGroups };
  }
  // Single AND-group: a bare condition or an AND-conjoined array. Absent / empty
  // array → an empty single group; `normalizeFilterGroups` collapses it to no groups.
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) return { ok: true, filter: [] };
  const parsed = parseGroup(list);
  if (!parsed.ok) return parsed;
  return { ok: true, filter: parsed.group };
};

const parseSort = (
  raw: unknown,
): { ok: true; sort: { field: string; direction?: 'asc' | 'desc' } } | { ok: false; reason: string } => {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: `search arg 'sort' must be an object { field, direction? }` };
  }
  if (typeof raw.field !== 'string' || raw.field.length === 0) {
    return { ok: false, reason: `sort 'field' must be a non-empty canonical field name` };
  }
  if (raw.direction !== undefined && raw.direction !== 'asc' && raw.direction !== 'desc') {
    return { ok: false, reason: `sort 'direction' must be 'asc' or 'desc'` };
  }
  return {
    ok: true,
    sort: raw.direction === undefined ? { field: raw.field } : { field: raw.field, direction: raw.direction },
  };
};

// ────────────────────────────────────────────────────────────────
// Central field resolution + value safety (vendor-agnostic)
// ────────────────────────────────────────────────────────────────

/** Canonical→vendor reverse map: `maps_to` → its `EntityFieldRow`. Filter / sort
 *  reference canonical field names; the request side reverse-maps them to the
 *  vendor `field_path` (+ `type`, for SOQL value formatting). A DERIVED canonical
 *  field has no `entity_fields` row (no vendor `source_path`), so it is absent
 *  here → filtering / sorting on it fails closed (G3 read-only). Duplicate
 *  `maps_to` is the resolver's concern (it fails closed before calling here), so
 *  first-wins is never observed in practice. */
const buildReverseMap = (
  rows: ReadonlyArray<EntityFieldRow>,
): ReadonlyMap<string, EntityFieldRow> => {
  const map = new Map<string, EntityFieldRow>();
  for (const row of rows) {
    if (!map.has(row.maps_to)) map.set(row.maps_to, row);
  }
  return map;
};

/** Normalize a parsed `CanonicalFilter` to the internal representation — an array
 *  of AND-groups (`CanonicalFilterCondition[][]`), the groups OR'd. The
 *  `{ any: [...] }` form yields one group per `any` element (each element is itself
 *  a single condition or an array → normalized to a condition array). The
 *  bare-condition / bare-array forms yield a SINGLE group. An absent filter, or an
 *  empty bare array, yields `[]` (no groups). */
const normalizeFilterGroups = (
  filter: CanonicalFilter | undefined,
): CanonicalFilterCondition[][] => {
  if (filter === undefined) return [];
  if (isFilterOrGroups(filter)) {
    // Parse guarantees `any` is a non-empty array of non-empty groups; normalize
    // each element (single condition or array) to a condition array.
    return filter.any.map((g) => (Array.isArray(g) ? [...g] : [g as CanonicalFilterCondition]));
  }
  // `Array.isArray` doesn't narrow the `ReadonlyArray` union member, so the
  // single-condition branch is cast (it's a condition by construction here).
  const conditions = Array.isArray(filter) ? [...filter] : [filter as CanonicalFilterCondition];
  // An empty bare array → no groups (no filter), preserving today's behavior.
  return conditions.length === 0 ? [] : [conditions];
};

/** A `{{ref}}` value resolves at runtime AFTER this build step, so it cannot be
 *  type-checked here. For a STRING field it is still threaded through (B1): SOQL escapes
 *  it at interpolation via the `soql_string` / `soql_like` hint, and HubSpot rides it as
 *  a JSON body value (injection-safe). For a non-string field it stays rejected (a
 *  number/boolean/datetime ref needs a typed runtime escape — a later slice). */
const containsRef = (value: unknown): boolean =>
  typeof value === 'string' && value.includes('{{');

/** A PURE, RESOLVABLE `{{ns.path}}` value — `{{…}}` with no surrounding text, no
 *  nested/extra braces, and no `:hint`, AND whose `ns` is a known namespace with a
 *  non-empty path. Only such a ref can be threaded into a vendor search: the SOQL builder
 *  wraps the WHOLE value in one escape hint, so an interpolation (`'pre-{{x}}'`), a
 *  nested/malformed ref, or a pre-hinted ref has no single-hint escape and is rejected.
 *
 *  The namespace + non-empty-path check fails CLOSED at install: a namespace-less
 *  (`{{config}}`) or whitespace (`{{ }}`) ref would otherwise install and then emit an
 *  unresolvable `{{…:soql_string}}` placeholder that breaks the query at the vendor
 *  (`NS.has` mirrors the resolver's own acceptance, so a ref that the resolver could
 *  never fill is rejected up front rather than producing a runtime-broken request). A
 *  colon is excluded above so this split is unambiguous and `withSoqlHint`'s slice
 *  operates on a clean `ns.path`. */
const isPureRef = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\{\{[^{}:]+\}\}$/.test(value)) return false;
  const inner = value.slice(2, -2).trim();
  const dot = inner.indexOf('.');
  const ns = dot === -1 ? inner : inner.slice(0, dot);
  const path = dot === -1 ? '' : inner.slice(dot + 1);
  return path.length > 0 && (NS as ReadonlySet<string>).has(ns);
};

/** Re-wrap a validated pure `{{ref}}` carrying a SOQL escape hint, e.g.
 *  `{{config.stage}}` + `soql_string` → `{{config.stage:soql_string}}`. The resolver
 *  escapes the resolved value into the SOQL string at interpolation (B1 runtime seam).
 *  PRECONDITION: `ref` matches `isPureRef` (validated in `resolveConditions`). */
const withSoqlHint = (ref: string, hint: 'soql_string' | 'soql_like'): string =>
  `{{${ref.slice(2, -2)}:${hint}}}`;

/** A LITERAL filter value must match the canonical field's declared type — this is
 *  what makes the SOQL number/boolean (unquoted) path safe (never an arbitrary
 *  string) and catches type-mismatched filters early. */
const valueMatchesType = (value: unknown, type: EntityFieldRow['type']): boolean => {
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    default:
      return false; // json is rejected, datetime is coerced (to unix-ms) — both before this
  }
};

/** D-190 Slice 2 — canonical fields that declare a closed enum, keyed by canonical
 *  field name (today only `close_state` → `open` | `won` | `lost`). Sourced from the
 *  single canonical contract (`CANONICAL_CRM_FIELD_SCHEMA`), so the search filter
 *  guard and the describe surface (Slice 4) agree by construction. A LITERAL filter
 *  value on such a field must be a declared member (fail closed) — the AI/author
 *  can't construct a value the vendor can't satisfy (`close_state == 'success'`). A
 *  `{{ref}}` resolves post-build and is NOT checked here. */
const CANONICAL_ENUM_BY_FIELD: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const map = new Map<string, ReadonlySet<string>>();
  for (const fields of Object.values(CANONICAL_CRM_FIELD_SCHEMA)) {
    for (const field of fields) {
      if (field.enum_values !== undefined) map.set(field.name, new Set(field.enum_values));
    }
  }
  return map;
})();

/** Resolve + validate every filter condition against the vendor fields:
 *  field maps to a vendor field; not a `datetime` / `json` field (deferred /
 *  unfilterable); LIKE only on string fields; every literal value matches the
 *  field type and is NOT a `{{ref}}`. The vendor builders consume the result and
 *  only format it. */
const resolveConditions = (
  reverse: ReadonlyMap<string, EntityFieldRow>,
  conditions: ReadonlyArray<CanonicalFilterCondition>,
  // D-190 Slice 4 — the formatted per-connection server-filterable set, appended to a
  // field-level rejection (wrong / derived field) so the author / AI is shown what it
  // CAN push down at the failure point. Empty for the value/operator-level rejections
  // below (right field, wrong value) where it is not the actionable hint.
  filterableHint: string,
): { ok: true; resolved: ResolvedCondition[] } | { ok: false; reason: string } => {
  const resolved: ResolvedCondition[] = [];
  for (const condition of conditions) {
    const row = reverse.get(condition.field);
    if (row === undefined) {
      return {
        ok: false,
        reason:
          `filter references canonical field '${condition.field}' which the pack does not map to a vendor field ` +
          `(unknown, or a derived/read-only field with no vendor source)` + filterableHint,
      };
    }
    if (row.derivation !== undefined) {
      // A COMPUTED field (e.g. close_state) has no single vendor source — its
      // `field_path` is only the primary input flag, so a server-side filter would
      // compare the wrong vendor field against the canonical value. It is read-only
      // for server-side querying; filter it in a transform step over the PROJECTED
      // records instead (where it carries the correct derived value).
      return {
        ok: false,
        reason:
          `cannot filter on canonical field '${condition.field}' in a search query — it is a COMPUTED (derived) ` +
          `field with no single vendor source. Filter it in a transform step over the projected records instead.` +
          filterableHint,
      };
    }
    if (row.type === 'json') {
      return { ok: false, reason: `cannot filter on canonical field '${condition.field}' (object/json type)` };
    }
    // (G2) A `datetime` field is server-side filterable ONLY when the pack declares
    // its date granularity (date vs datetime) — both vendors need the right literal
    // form and it is not derivable from the canonical type (per-vendor; see
    // `DateGranularity`). Without it, fail closed (filter over the projected unix-ms
    // in a transform step instead) — the pre-G2 behavior for any datetime field.
    const isDatetime = row.type === 'datetime';
    if (isDatetime && row.date_granularity === undefined) {
      return {
        ok: false,
        reason:
          `datetime filter on '${condition.field}' is not supported — the pack does not declare the field's ` +
          `date granularity (date | datetime). Filter it in a transform step over the projected unix-ms instead.`,
      };
    }
    const granularityPatch = isDatetime ? { granularity: row.date_granularity } : {};
    if (UNARY_OPERATOR_SET.has(condition.operator)) {
      // is_null / is_not_null carry no value — no date formatting needed; granularity
      // rides along for symmetry (the builders ignore it for unary).
      resolved.push({ field_path: row.field_path, type: row.type, operator: condition.operator, values: [], ...granularityPatch });
      continue;
    }
    if (LIKE_OPERATORS.has(condition.operator) && row.type !== 'string') {
      return {
        ok: false,
        reason: `filter operator '${condition.operator}' on '${condition.field}' requires a string field`,
      };
    }
    const rawValues = ARRAY_OPERATORS.has(condition.operator)
      ? (condition.value as unknown[])
      : [condition.value];
    const values: unknown[] = [];
    for (const value of rawValues) {
      if (containsRef(value)) {
        // RUNTIME-RESOLVED filter value (B1). A {{ref}} resolves AFTER this build step,
        // so it can't be type-checked or escaped here. v1 supports a PURE {{ref}} on a
        // STRING field — the only case escapable WITHOUT the value in hand: the SOQL
        // builder wraps it in a `soql_string` / `soql_like` escape hint the resolver
        // applies at interpolation, and HubSpot rides it as a JSON body value
        // (injection-safe, like a write body — see connection-agnostic-write.ts).
        if (row.type !== 'string') {
          // A number/boolean/datetime ref would splice UNQUOTED into SOQL, so it needs a
          // typed runtime escape that validates the resolved value to the field type with
          // a fail-closed channel — a later slice. Reject with the post-projection
          // workaround (the same escape hatch datetime-without-granularity / computed
          // fields use).
          return {
            ok: false,
            reason:
              `ref-valued filter on '${condition.field}' is not supported for a ${row.type} field — ref ` +
              `filters are limited to string fields (a number/boolean/datetime ref needs a typed runtime ` +
              `escape, a later slice). Use a literal value, or filter over the projected records in a transform step.`,
          };
        }
        if (!isPureRef(value)) {
          // An interpolation (`'pre-{{x}}'`) or nested/malformed ref can't be escaped as a
          // unit (a single hint escapes the whole resolved value, not surrounding text).
          return {
            ok: false,
            reason:
              `ref-valued filter on '${condition.field}' must be a single {{ref}} with no surrounding text — ` +
              `'${String(value)}' mixes a ref with literal text (or is malformed) and cannot be safely escaped for the vendor query`,
          };
        }
        // Pure string ref — keep the raw ref string; the builders emit it (SOQL
        // escape-hinted, HubSpot passthrough) and the resolver fills it at runtime.
        values.push(value);
        continue;
      }
      if (isDatetime) {
        // Normalize the canonical threshold (ISO date/datetime string OR epoch-ms) to
        // unix-ms; the builder formats it to the vendor literal per `granularity`.
        const ms = coerceDateThresholdToMs(value);
        if (ms === null) {
          return {
            ok: false,
            reason:
              `datetime filter value for '${condition.field}' must be an ISO date / datetime string ` +
              `or a unix-ms number (got ${JSON.stringify(value)})`,
          };
        }
        values.push(ms);
      } else {
        if (!valueMatchesType(value, row.type)) {
          return {
            ok: false,
            reason: `filter value for '${condition.field}' must be a ${row.type} literal`,
          };
        }
        // D-190 Slice 2 — an ENUM canonical field (today only `close_state`) accepts
        // only its declared values; a bogus literal fails closed at build so the AI/
        // author can't issue a query the vendor can't satisfy. Keyed by canonical
        // field name (`condition.field` is the `maps_to`); `{{ref}}` values resolve
        // post-build and bypass this branch (handled above).
        const enumValues = CANONICAL_ENUM_BY_FIELD.get(condition.field);
        if (enumValues !== undefined && !enumValues.has(value as string)) {
          return {
            ok: false,
            reason:
              `filter value '${String(value)}' for canonical field '${condition.field}' is not a declared value ` +
              `(allowed: ${[...enumValues].join(', ')})`,
          };
        }
        values.push(value);
      }
    }
    resolved.push({ field_path: row.field_path, type: row.type, operator: condition.operator, values, ...granularityPatch });
  }
  return { ok: true, resolved };
};

/** Resolve EVERY AND-group via the per-condition `resolveConditions` (its
 *  field-mapping / type-checking / `{{ref}}`-rejection / datetime-rejection rules
 *  apply per condition, unchanged) → an array of resolved AND-groups. Fails closed
 *  on the first group whose conditions don't resolve. Parse guarantees no empty
 *  groups, so a group always yields ≥1 resolved condition. */
const resolveGroups = (
  reverse: ReadonlyMap<string, EntityFieldRow>,
  groups: ReadonlyArray<ReadonlyArray<CanonicalFilterCondition>>,
  filterableHint: string,
): { ok: true; resolved: ResolvedCondition[][] } | { ok: false; reason: string } => {
  const resolved: ResolvedCondition[][] = [];
  for (const group of groups) {
    const r = resolveConditions(reverse, group, filterableHint);
    if (!r.ok) return r;
    resolved.push(r.resolved);
  }
  return { ok: true, resolved };
};

const dedupe = (values: ReadonlyArray<string>): string[] => [...new Set(values)];

// ────────────────────────────────────────────────────────────────
// HubSpot — POST /crm/v3/objects/{type}/search  →  body.* wire-key args
// ────────────────────────────────────────────────────────────────

/** HubSpot read paths are `properties.<name>`; the search body's `properties`
 *  list + `filterGroups[].propertyName` + `sorts[].propertyName` want the BARE
 *  property name. Strip the single `properties.` prefix; pass anything else
 *  through (a top-level field). */
const hubspotWireName = (fieldPath: string): string =>
  fieldPath.startsWith('properties.') ? fieldPath.slice('properties.'.length) : fieldPath;

const HUBSPOT_OPERATORS: Record<CanonicalFilterOperator, string> = {
  equal: 'EQ',
  not_equal: 'NEQ',
  greater: 'GT',
  greater_or_equal: 'GTE',
  less: 'LT',
  less_or_equal: 'LTE',
  is_null: 'NOT_HAS_PROPERTY',
  is_not_null: 'HAS_PROPERTY',
  in: 'IN',
  not_in: 'NOT_IN',
  contains: 'CONTAINS_TOKEN',
  not_contains: 'NOT_CONTAINS_TOKEN',
};

/** HubSpot serialises filter values as strings (its search API compares string-
 *  typed even for number / date properties). A `datetime` field's value is a
 *  normalized unix-ms number → format it to the ISO date literal HubSpot accepts
 *  for the field's granularity (date `YYYY-MM-DD` / datetime `…Z`); every other
 *  type stringifies its already-type-checked literal. */
const hubspotFormatValue = (condition: ResolvedCondition, value: unknown): string =>
  condition.type === 'datetime' && condition.granularity !== undefined
    ? formatDateLiteral(value as number, condition.granularity)
    : String(value);

const hubspotFilter = (condition: ResolvedCondition): Record<string, unknown> => {
  const propertyName = hubspotWireName(condition.field_path);
  const operator = HUBSPOT_OPERATORS[condition.operator];
  if (UNARY_OPERATOR_SET.has(condition.operator)) {
    return { propertyName, operator };
  }
  if (ARRAY_OPERATORS.has(condition.operator)) {
    // HubSpot IN / NOT_IN take a `values` (plural) array, not `value`.
    return { propertyName, operator, values: condition.values.map((v) => hubspotFormatValue(condition, v)) };
  }
  return { propertyName, operator, value: hubspotFormatValue(condition, condition.values[0]) };
};

/** The vendor field path(s) one response row reads from. A normal row reads its
 *  single `field_path`; a DERIVED row (the G3 lift — `close_state` reads its two
 *  flags, `name` reads its concat parts + fallback) reads every derivation input
 *  path, so the SELECT fetches everything the projection needs back. */
export const rowSelectPaths = (row: EntityFieldRow): readonly string[] =>
  row.derivation !== undefined
    ? fieldDerivationInputPaths(row.derivation)
    : [row.field_path];

const buildHubspotSearch: VendorSearchBuilder = ({ rows, conditionGroups, sort, limit }) => {
  const out: Record<string, unknown> = {
    // NB the canonical `id` row for the REAL HubSpot entities reads
    // `properties.hs_object_id` (HubSpot's property mirror of the record
    // id) — NOT the top-level `id` — precisely so this list stays pure
    // property names. A 3p composition on this dialect with flat field
    // paths legitimately requests those paths verbatim (no prefix filter
    // here — its paths ARE its property names).
    'body.properties': dedupe(rows.flatMap(rowSelectPaths).map(hubspotWireName)),
    // PER-PAGE size (walk-all): clamp the canonical `limit` hint to HubSpot's hard
    // per-request max — the gateway's cursor-follow loop walks `paging.next.after`
    // to assemble the full set, so a bigger requested page can never trip a vendor
    // 400; it only changes how many pages the follower fetches.
    'body.limit': Math.min(limit, HUBSPOT_SEARCH_PAGE_MAX),
  };
  // HubSpot's `filterGroups` array is OR-of-groups (conditions within a group
  // AND'd). One AND-group → `[{ filters: [...] }]` (byte-identical to the old
  // single-group emit); N groups → N entries (OR'd). Emit only when ≥1 condition
  // total. (Parse rejects empty groups, but guard against any empty group anyway.)
  const nonEmptyGroups = conditionGroups.filter((g) => g.length > 0);
  if (nonEmptyGroups.length > 0) {
    out['body.filterGroups'] = nonEmptyGroups.map((g) => ({ filters: g.map(hubspotFilter) }));
  }
  if (sort !== undefined) {
    out['body.sorts'] = [
      {
        propertyName: hubspotWireName(sort.field_path),
        direction: sort.direction === 'desc' ? 'DESCENDING' : 'ASCENDING',
      },
    ];
  }
  // Never fails: HubSpot field names ride a JSON body (serialised as JSON string
  // values), so an unexpected property name cannot break out of the request shape.
  return { ok: true, args: out };
};

// ────────────────────────────────────────────────────────────────
// Salesforce — GET /services/data/vXX/query?q=<SOQL>  →  query.q wire-key arg
// ────────────────────────────────────────────────────────────────

const SOQL_BINARY_OPERATORS: Partial<Record<CanonicalFilterOperator, string>> = {
  equal: '=',
  not_equal: '!=',
  greater: '>',
  greater_or_equal: '>=',
  less: '<',
  less_or_equal: '<=',
};

/** The Salesforce SObject API name for a registry vendor entity. The registry
 *  stores it lowercase (`opportunity`); SOQL's `FROM` wants the PascalCase API
 *  name (`Opportunity`). The CRM trio (`opportunity`/`contact`/`account`) are all
 *  single-word standard objects → capitalise the first letter. (Multi-word /
 *  custom `__c` objects are out of scope for the v1 CRM convention.) */
const salesforceSObject = (vendorEntity: string): string =>
  vendorEntity.length === 0
    ? vendorEntity
    : vendorEntity.charAt(0).toUpperCase() + vendorEntity.slice(1);

// One escape rule across install (here) and runtime (the resolver's `soql_string` /
// `soql_like` hint, B1) — both import `escapeSoqlStringLiteral` from contracts so a
// literal value and a runtime-resolved `{{ref}}` value can never escape differently.
const soqlEscape = escapeSoqlStringLiteral;

/** Reviewed SOQL IDENTIFIER grammar — a field/object name or a dot-separated
 *  relationship path (`Name`, `StageName`, `Account.Name`, `My_Field__c`). Each
 *  segment starts with a letter, then alphanumerics/underscore (covers standard +
 *  custom `__c`/`__r`).
 *
 *  SECURITY (NEXT-1, vendor search-builder extensibility): SOQL has NO identifier
 *  quoting, so the builder splices field / object names straight into the query.
 *  That was safe while `soql` was effectively vendor-locked to the FROZEN built-in
 *  Salesforce registry (trusted constants), but the dialect is now catalog-declared
 *  — a 3rd-party `soql` pack supplies its own `field_path`/`source_path`, which the
 *  composition layer only checks is a non-empty string (a JSONPath/dot-path can be
 *  arbitrary). So every identifier the SOQL builder splices is checked against this
 *  grammar and the build FAILS CLOSED otherwise, closing the identifier-injection
 *  vector the decoupling opens. (Filter VALUES are separately literal-escaped.) */
const SOQL_IDENTIFIER_REGEX = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;
const isSafeSoqlIdentifier = (s: string): boolean => SOQL_IDENTIFIER_REGEX.test(s);

/** Format one canonical LITERAL value for a SOQL predicate. Quotes by the canonical
 *  FIELD type: `number`/`boolean` emit the (type-checked) literal UNQUOTED
 *  (`Amount > 30000`); `datetime` emits the ISO date/datetime literal UNQUOTED per
 *  the field's `granularity` (`CloseDate > 2025-01-01` / `CreatedDate > 2025-01-01T00:00:00Z`
 *  — SOQL date literals carry NO quotes), injection-safe because it is built from a
 *  unix-ms NUMBER via `toISOString`; `string` emits it QUOTED + ESCAPED
 *  (`StageName = 'Closed \\'Won'`). Other values are always type-checked literals, so
 *  the unquoted paths can never be an arbitrary string. */
const soqlScalar = (
  value: unknown,
  type: EntityFieldRow['type'],
  granularity: DateGranularity | undefined,
): string => {
  // A pure string-field {{ref}} (B1) — emit the ref carrying the `soql_string` escape
  // hint; the resolver renders it as a quoted+escaped SOQL literal at interpolation
  // (`resolveConditions` admits a ref only for a string field, so a ref never reaches
  // the unquoted number/boolean/datetime paths below).
  if (containsRef(value)) return withSoqlHint(value as string, 'soql_string');
  if (type === 'datetime') return formatDateLiteral(value as number, granularity ?? 'datetime');
  if (type === 'number' || type === 'boolean') return String(value);
  return `'${soqlEscape(String(value))}'`;
};

const soqlPredicate = (condition: ResolvedCondition): string => {
  const field = condition.field_path;
  const { type, granularity } = condition;
  if (condition.operator === 'is_null') return `${field} = null`;
  if (condition.operator === 'is_not_null') return `${field} != null`;
  if (condition.operator === 'in' || condition.operator === 'not_in') {
    const items = condition.values.map((v) => soqlScalar(v, type, granularity)).join(', ');
    return `${field} ${condition.operator === 'in' ? 'IN' : 'NOT IN'} (${items})`;
  }
  if (condition.operator === 'contains' || condition.operator === 'not_contains') {
    // LIKE is string-only (enforced upstream); wrap the escaped value in %…%. A pure
    // string-field {{ref}} (B1) emits the `soql_like` escape hint instead — the resolver
    // renders the resolved value as a `'%…%'` operand at interpolation.
    const v0 = condition.values[0];
    const like = containsRef(v0) ? withSoqlHint(v0 as string, 'soql_like') : `'%${soqlEscape(String(v0))}%'`;
    return condition.operator === 'contains' ? `${field} LIKE ${like}` : `(NOT ${field} LIKE ${like})`;
  }
  return `${field} ${SOQL_BINARY_OPERATORS[condition.operator]} ${soqlScalar(condition.values[0], type, granularity)}`;
};

const buildSalesforceSearch: VendorSearchBuilder = ({ vendorEntity, rows, conditionGroups, sort }) => {
  const sObject = salesforceSObject(vendorEntity);
  const nonEmptyGroups = conditionGroups.filter((g) => g.length > 0);
  // IDENTIFIER-injection guard (SECURITY) — validate every field / object name this
  // builder splices UNescaped into the SOQL string (object → FROM, SELECT fields,
  // filter fields across ALL groups, sort field) against the reviewed grammar, and
  // FAIL CLOSED on any miss. `Id` + the operator/keyword tokens are builder-owned
  // constants; the LIMIT is a positive integer; filter VALUES are literal-escaped —
  // so the identifiers are the only attacker-influenced spliced bits left to guard.
  const splicedIdentifiers = [
    sObject,
    ...rows.flatMap(rowSelectPaths),
    ...nonEmptyGroups.flatMap((g) => g.map((c) => c.field_path)),
    ...(sort !== undefined ? [sort.field_path] : []),
  ];
  for (const id of splicedIdentifiers) {
    if (!isSafeSoqlIdentifier(id)) {
      return {
        ok: false,
        reason:
          `SOQL identifier '${id}' is not a valid field/object name — a soql-dialect pack's ` +
          `entity name + field paths must match ${SOQL_IDENTIFIER_REGEX.source} ` +
          `(SOQL has no identifier quoting, so an identifier spliced into the query cannot be escaped)`,
      };
    }
  }
  // `Id` is always selected (record identity); the rest are the projectable field
  // paths (flat on the SObject — `Name`, `StageName`, …), all now identifier-checked.
  const selectFields = dedupe(['Id', ...rows.flatMap(rowSelectPaths)]);
  const clauses = [`SELECT ${selectFields.join(', ')}`, `FROM ${sObject}`];
  if (nonEmptyGroups.length === 1) {
    // ONE AND-group → `WHERE a AND b` — byte-identical to the old single-group emit
    // (NO surrounding parens).
    clauses.push(`WHERE ${nonEmptyGroups[0].map(soqlPredicate).join(' AND ')}`);
  } else if (nonEmptyGroups.length > 1) {
    // MULTIPLE groups → `(a AND b) OR (c AND d)`: parenthesize each AND-group, OR-join.
    clauses.push(
      `WHERE ${nonEmptyGroups
        .map((g) => `(${g.map(soqlPredicate).join(' AND ')})`)
        .join(' OR ')}`,
    );
  }
  if (sort !== undefined) {
    clauses.push(`ORDER BY ${sort.field_path} ${sort.direction === 'desc' ? 'DESC' : 'ASC'}`);
  }
  // WALK-ALL: SOQL has no per-page size knob (the Query API auto-batches + returns
  // `nextRecordsUrl`), so the canonical `limit` page-size hint does NOT apply to
  // Salesforce. Cap the SET at the SOURCE with the follower's record ceiling — the
  // gateway's `soql_query_locator` follower walks `nextRecordsUrl`, bounded by the
  // same `PAGINATION_MAX_RECORDS` (belt-and-suspenders), so the recipe sees every
  // matching record up to the ceiling.
  clauses.push(`LIMIT ${PAGINATION_MAX_RECORDS}`);
  return { ok: true, args: { 'query.q': clauses.join(' ') } };
};

// ────────────────────────────────────────────────────────────────
// Pipedrive — GET /deals|persons|organizations?…  →  query.* wire-key args
// ────────────────────────────────────────────────────────────────

const PIPEDRIVE_QUERY_PARAM_REGEX = /^[a-z][a-z0-9_]*$/;

const PIPEDRIVE_EQUAL_QUERY_PARAMS: Readonly<Record<string, ReadonlyMap<string, string>>> = {
  deal: new Map([
    ['owner_id', 'owner_id'],
    ['person_id', 'person_id'],
    ['org_id', 'org_id'],
    ['pipeline_id', 'pipeline_id'],
    ['stage_id', 'stage_id'],
    ['status', 'status'],
  ]),
  person: new Map([
    ['owner_id', 'owner_id'],
    ['org_id', 'org_id'],
    ['deal_id', 'deal_id'],
  ]),
  organization: new Map([
    ['owner_id', 'owner_id'],
  ]),
};

const pipedriveParamValue = (condition: ResolvedCondition, value: unknown): string =>
  condition.type === 'datetime' && condition.granularity !== undefined
    ? formatDateLiteral(value as number, condition.granularity)
    : String(value);

const assignPipedriveQueryParam = (
  out: Record<string, unknown>,
  param: string,
  value: string,
): SearchArgsResult | undefined => {
  if (!PIPEDRIVE_QUERY_PARAM_REGEX.test(param)) {
    return {
      ok: false,
      reason:
        `Pipedrive query param '${param}' is not a safe identifier — query params are emitted as query.<param> wire keys`,
    };
  }
  const key = `query.${param}`;
  if (Object.prototype.hasOwnProperty.call(out, key)) {
    return {
      ok: false,
      reason: `Pipedrive search maps more than one condition to query param '${param}'`,
    };
  }
  out[key] = value;
  return undefined;
};

const applyPipedriveCondition = (
  vendorEntity: string,
  out: Record<string, unknown>,
  condition: ResolvedCondition,
): SearchArgsResult | undefined => {
  if (condition.field_path === 'id') {
    if (condition.operator === 'equal') {
      return assignPipedriveQueryParam(out, 'ids', pipedriveParamValue(condition, condition.values[0]));
    }
    if (condition.operator === 'in') {
      return assignPipedriveQueryParam(out, 'ids', condition.values.map((v) => pipedriveParamValue(condition, v)).join(','));
    }
    return {
      ok: false,
      reason: `Pipedrive search supports only equal/in filters on canonical id (got '${condition.operator}')`,
    };
  }

  if (condition.field_path === 'update_time') {
    if (condition.operator === 'greater' || condition.operator === 'greater_or_equal') {
      return assignPipedriveQueryParam(out, 'updated_since', pipedriveParamValue(condition, condition.values[0]));
    }
    if (condition.operator === 'less' || condition.operator === 'less_or_equal') {
      return assignPipedriveQueryParam(out, 'updated_until', pipedriveParamValue(condition, condition.values[0]));
    }
    return {
      ok: false,
      reason:
        `Pipedrive search supports only range filters on updated_at/update_time (got '${condition.operator}')`,
    };
  }

  if (condition.operator !== 'equal') {
    return {
      ok: false,
      reason:
        `Pipedrive search supports equality filters only for list query params (got '${condition.operator}' on '${condition.field_path}')`,
    };
  }

  const param = PIPEDRIVE_EQUAL_QUERY_PARAMS[vendorEntity]?.get(condition.field_path);
  if (param === undefined) {
    return {
      ok: false,
      reason:
        `Pipedrive search cannot server-filter field_path '${condition.field_path}' on entity '${vendorEntity}'`,
    };
  }
  return assignPipedriveQueryParam(out, param, pipedriveParamValue(condition, condition.values[0]));
};

const buildPipedriveSearch: VendorSearchBuilder = ({ vendorEntity, conditionGroups, sort, limit }) => {
  const out: Record<string, unknown> = {
    // ⛔ NOT `String(...)`. `deal.search` and its siblings declare `query.limit`
    // as `{ type: 'number' }`, and the binding's own `pagination.page_size.value`
    // is the NUMBER 100 for that same param — so the runtime already puts a
    // number there on the paginated path. The stringified first page disagreed
    // with both, which nothing could see while the request schema carried
    // `additionalProperties: true` and the gate therefore discarded it whole.
    'query.limit': Math.min(limit, PIPEDRIVE_SEARCH_PAGE_MAX),
  };

  const nonEmptyGroups = conditionGroups.filter((g) => g.length > 0);
  if (nonEmptyGroups.length > 1) {
    return {
      ok: false,
      reason: 'Pipedrive list endpoints do not support OR filter groups; use one AND group or filter after projection',
    };
  }
  for (const condition of nonEmptyGroups[0] ?? []) {
    const failed = applyPipedriveCondition(vendorEntity, out, condition);
    if (failed !== undefined) return failed;
  }

  if (sort !== undefined) {
    if (!PIPEDRIVE_QUERY_PARAM_REGEX.test(sort.field_path)) {
      return {
        ok: false,
        reason:
          `Pipedrive sort field '${sort.field_path}' is not a supported flat list field`,
      };
    }
    out['query.sort_by'] = sort.field_path;
    out['query.sort_direction'] = sort.direction;
  }

  return { ok: true, args: out };
};

// ────────────────────────────────────────────────────────────────
// D-190 Slice 4 — per-connection server-filterable set (the queryability rule)
// ────────────────────────────────────────────────────────────────

/** Pipedrive's server-filterable field PATHS for one vendor entity: the `id`
 *  (→ `ids`) and `update_time` (→ `updated_since`/`until`) special cases the builder
 *  handles, plus the equality query-param whitelist. Single-sourced from
 *  `PIPEDRIVE_EQUAL_QUERY_PARAMS` so the describe / hint set can't drift from what
 *  `applyPipedriveCondition` actually accepts. */
const pipedriveFilterableFieldPaths = (vendorEntity: string): ReadonlySet<string> => {
  const params = PIPEDRIVE_EQUAL_QUERY_PARAMS[vendorEntity];
  return new Set<string>(['id', 'update_time', ...(params ? params.keys() : [])]);
};

/** D-190 Slice 4 — does one resolved vendor field back a SERVER-SIDE filter on the
 *  given dialect? The QUERYABILITY RULE as a predicate: server-filterable IFF (1) the
 *  field projects from a single vendor source (NOT a `derivation`), is not an
 *  object/`json` type, and — for a `datetime` field — declares its granularity (the
 *  exact field-level gate `resolveConditions` fails closed on), AND (2) the dialect's
 *  query builder can emit a predicate for its `field_path`. A derived field
 *  (`close_state` on HubSpot/SF) fails (1); a field the vendor API can't filter
 *  (Pipedrive `title` / `value`) fails (2). Mirrors the builders so the set never
 *  claims a field the resolver would then reject. */
const isFieldServerFilterable = (
  searchStyle: SearchStyle,
  vendorEntity: string,
  row: EntityFieldRow,
): boolean => {
  // (1) field-level gate — identical to resolveConditions' fail-closed checks.
  if (row.derivation !== undefined) return false;
  if (row.type === 'json') return false;
  if (row.type === 'datetime' && row.date_granularity === undefined) return false;
  // (2) dialect-level gate — can the builder emit a predicate for this field_path?
  switch (searchStyle) {
    case 'hubspot_search':
      return true; // HubSpot search filters ANY property (filterGroups over propertyName).
    case 'soql':
      // SOQL splices the field identifier UNescaped; the builder fails closed on an
      // unsafe one, so a field is filterable only when its path is a safe identifier.
      return isSafeSoqlIdentifier(row.field_path);
    case 'pipedrive_filter':
      return pipedriveFilterableFieldPaths(vendorEntity).has(row.field_path);
    default:
      return false;
  }
};

/** Compute the server-filterable canonical-field set from an already-built reverse map
 *  (the `deriveVendorSearchArgs` fast path — avoids a second `buildReverseMap`). */
const filterableFromReverse = (
  searchStyle: SearchStyle,
  vendorEntity: string,
  reverse: ReadonlyMap<string, EntityFieldRow>,
): ReadonlySet<string> => {
  const out = new Set<string>();
  for (const [mapsTo, row] of reverse) {
    if (isFieldServerFilterable(searchStyle, vendorEntity, row)) out.add(mapsTo);
  }
  return out;
};

/** D-190 Slice 4 — the per-connection set of canonical field names (the `maps_to`
 *  vocabulary) that are SERVER-FILTERABLE under the queryability rule, DERIVED from the
 *  vendor entity's response `entity_fields` × the catalog search dialect — never
 *  hand-authored (a flag would drift). A field ABSENT from the set is a read-only
 *  projection: it still reads consistently across vendors, but a `search` filter on it
 *  fails closed (filter it in a transform step over the projected records). Consumed by
 *  the fail-closed filter-reject hint here, and by the cross-vendor `deal.search`
 *  fan-out (the AI-offered filter vocabulary is the intersection of these sets across
 *  the participating vendors). `searchStyle === undefined` (no declared dialect → a
 *  canonical search can't resolve at all) → empty. */
export const canonicalFilterableFields = (
  searchStyle: SearchStyle | undefined,
  vendorEntity: string,
  rows: ReadonlyArray<EntityFieldRow>,
): ReadonlySet<string> => {
  if (searchStyle === undefined) return new Set<string>();
  return filterableFromReverse(searchStyle, vendorEntity, buildReverseMap(rows));
};

/** D-190 Slice 4 — render the per-connection server-filterable set as a one-clause hint
 *  appended to a fail-closed filter / sort rejection, so an author / AI sees what it CAN
 *  push down at the exact point it named a field it can't. An empty set restates the
 *  transform-step guidance (nothing here is server-filterable). */
const formatFilterableHint = (filterable: ReadonlySet<string>): string =>
  filterable.size > 0
    ? ` (server-filterable canonical fields on this connection: ${[...filterable].sort().join(', ')})`
    : ` (no canonical field is server-filterable on this connection — filter over the projected records in a transform step)`;

// ────────────────────────────────────────────────────────────────
// Dispatch
// ────────────────────────────────────────────────────────────────

/** The closed set of reviewed query builders, keyed by the catalog-declared search
 *  DIALECT (`SearchStyle`) — NOT by vendor. A `Record<SearchStyle, …>` so adding a
 *  dialect to the `SearchStyle` union forces a builder here (exhaustive). */
const SEARCH_BUILDERS: Record<SearchStyle, VendorSearchBuilder> = {
  hubspot_search: buildHubspotSearch,
  soql: buildSalesforceSearch,
  pipedrive_filter: buildPipedriveSearch,
};

/** Derive the vendor connection-api wire-key args for a canonical `search` op
 *  from its vendor-neutral `CanonicalSearchArgs` + the vendor entity's response
 *  `entity_fields`. Returns `{ ok: false, reason }` on a bad arg shape, an
 *  unmappable filter/sort field, an unsupported (`datetime`/`json`/ref) filter, or
 *  a catalog that declares no (or an unknown) search dialect; the resolver wraps
 *  the reason in a `CanonicalOpResolutionError` with the op-step context.
 *
 *  `searchStyle` is the catalog-declared dialect (`surfaces.api.search_style`) that
 *  selects the query builder — NOT the vendor id (NEXT-1, vendor search-builder
 *  extensibility). `undefined` (the catalog declared none) → fail closed. `rawArgs`
 *  is the op-step's `args` object verbatim; `rows` are the SAME response-side
 *  `entity_fields` the resolver builds the read projection from (with duplicate
 *  `maps_to` already failed-closed by the resolver). */
export const deriveVendorSearchArgs = (
  searchStyle: SearchStyle | undefined,
  vendorEntity: string,
  rows: ReadonlyArray<EntityFieldRow>,
  rawArgs: Record<string, unknown>,
): SearchArgsResult => {
  // Selected by the catalog-declared dialect, not the vendor — a runtime-bogus
  // value (the reader narrows JSON via `isSearchStyle`, but defend in depth) +
  // `undefined` both land here as a fail-closed `no … search-query builder`.
  const builder = searchStyle === undefined ? undefined : SEARCH_BUILDERS[searchStyle];
  if (builder === undefined) {
    return {
      ok: false,
      reason:
        searchStyle === undefined
          ? `this CRM pack declares no canonical search-query builder — its catalog must declare ` +
            `surfaces.api.search_style (one of: ${SEARCH_STYLES.join(' | ')}) so a canonical search ` +
            `can be translated to the vendor query`
          : `search style '${searchStyle}' has no canonical search-query builder ` +
            `(known dialects: ${SEARCH_STYLES.join(' | ')})`,
    };
  }
  const parsed = parseCanonicalSearchArgs(rawArgs);
  if (!parsed.ok) return parsed;

  const reverse = buildReverseMap(rows);

  // D-190 Slice 4 — the per-connection server-filterable set, formatted once for the
  // fail-closed filter / sort rejections below (so they name what the AI / author CAN
  // push down here, not just what it can't). DERIVED from the same rows + dialect the
  // builders consume, so the hint never lists a field the resolver would then reject.
  const filterableHint = formatFilterableHint(
    canonicalFilterableFields(searchStyle, vendorEntity, rows),
  );

  // Group-aware: normalize the parsed filter to AND-groups (OR'd), then resolve each
  // group's conditions via the per-condition `resolveConditions`. A single-group
  // filter (the bare-condition / bare-array forms) yields exactly one group, so the
  // emitted wire args stay byte-identical to the pre-OR pipeline.
  const resolvedFilter = resolveGroups(reverse, normalizeFilterGroups(parsed.args.filter), filterableHint);
  if (!resolvedFilter.ok) return resolvedFilter;

  let sort: ResolvedSort | undefined;
  if (parsed.args.sort !== undefined) {
    const sortRow = reverse.get(parsed.args.sort.field);
    if (sortRow === undefined) {
      return {
        ok: false,
        reason:
          `sort references canonical field '${parsed.args.sort.field}' which the pack does not map to a vendor field ` +
          `(unknown, or a derived/read-only field with no vendor source)` + filterableHint,
      };
    }
    if (sortRow.derivation !== undefined) {
      // A COMPUTED field has no single vendor source to ORDER BY server-side
      // (its `field_path` is only the primary input flag) — sort it in a transform
      // step over the projected records instead. (See the filter guard above.)
      return {
        ok: false,
        reason:
          `cannot sort on canonical field '${parsed.args.sort.field}' in a search query — it is a COMPUTED (derived) ` +
          `field with no single vendor source. Sort it in a transform step over the projected records instead.` +
          filterableHint,
      };
    }
    sort = { field_path: sortRow.field_path, direction: parsed.args.sort.direction ?? 'asc' };
  }

  // The builder returns `SearchArgsResult` directly — the `soql` builder fails
  // closed on an unsafe spliced identifier (`isSafeSoqlIdentifier`); HubSpot never
  // fails. Return it as-is so a builder-level rejection propagates.
  return builder({
    vendorEntity,
    rows,
    conditionGroups: resolvedFilter.resolved,
    sort,
    limit: parsed.args.limit ?? DEFAULT_SEARCH_LIMIT,
  });
};
