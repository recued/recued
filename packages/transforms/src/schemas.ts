/** Transform parameter schemas — the minimum surface needed for the recipe
 *  validator to catch missing-required-param bugs and literal-value type
 *  errors BEFORE a recipe ships.
 *
 *  DESIGN PRINCIPLES
 *  -----------------
 *  1. Co-located with the implementations in this package. Schemas and the
 *     functions they describe cannot drift across package boundaries.
 *  2. One entry per transform. The shape is `Record<ParamName, ParamDef>`.
 *     ParamDef is a 2-field struct — anything richer (enums, cross-param
 *     constraints, nested object shapes) is overengineering for phase 1.
 *  3. Type checks only apply to LITERAL values. A parameter whose value is
 *     a reference string like `"{{step.deals}}"` is always a string at
 *     validation time — the runtime type depends on what the reference
 *     resolves to. The validator skips type-checking any value that looks
 *     like a template reference.
 *  4. "Required" means "the transform implementation reads this without a
 *     default or fallback". Where the implementation has a sensible default
 *     (e.g. `slice` defaults start=0, end=arr.length) the param is optional.
 *  5. Where a transform has either/or params (e.g. `compare` accepts `right`
 *     OR `value`), both are marked optional. The recipe validator can't
 *     express "exactly one of these" with a single param-level ParamDef
 *     without becoming a tiny schema language — deferred.
 */

export type ParamType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'any';

export interface ParamDef {
  required?: boolean;
  type?: ParamType;
  /** Allowed literal values. The validator only enforces this when the
   *  recipe supplies a literal string — reference values like `"{{step.x}}"`
   *  are skipped because their runtime value is unknown at validation time. */
  enum?: readonly string[];
}

export type TransformSchema = Record<string, ParamDef>;

const REQ = (type: ParamType): ParamDef => ({ required: true, type });
const OPT = (type: ParamType): ParamDef => ({ required: false, type });
const REQ_ENUM = (values: readonly string[]): ParamDef =>
  ({ required: true, type: 'string', enum: values });
const OPT_ENUM = (values: readonly string[]): ParamDef =>
  ({ required: false, type: 'string', enum: values });

// ── Canonical enum sets (single source of truth) ────────────────
// Runtime implementations in ../collection.ts, ../numeric.ts, ../date.ts
// must accept exactly these strings. If a transform adds a new operator,
// extend the corresponding set here.

const CONDITION_OPS = [
  'equal', 'not_equal',
  'greater', 'greater_or_equal', 'less', 'less_or_equal',
  'is_null', 'is_not_null', 'is_empty', 'is_not_empty',
  'contains', 'not_contains', 'in', 'not_in',
] as const;

/** Source of truth: MathOp in ../types.ts */
const MATH_OPS = [
  'add', 'subtract', 'multiply', 'divide', 'modulo',
  'abs', 'ceil', 'floor',
] as const;

/** Source of truth: ReduceOp in ../types.ts */
const REDUCE_OPS = ['sum', 'count', 'avg', 'min', 'max'] as const;

/** Source of truth: DateUnit in ../types.ts */
const DATE_UNITS = ['days', 'hours', 'minutes', 'seconds'] as const;

/** Source of truth: SortDirection in ../types.ts */
const SORT_DIRECTIONS = ['asc', 'desc'] as const;

/** Source of truth: DATE_PERIODS in ../date.ts */
const DATE_PERIOD_NAMES = [
  'today', 'yesterday',
  'this_week', 'last_week',
  'this_month', 'last_month',
  'this_quarter', 'last_quarter',
  'this_year', 'last_year',
  'last_7_days', 'last_30_days', 'last_90_days',
  'next_7_days', 'next_30_days',
] as const;

/** Full registry of transform schemas. Keys match the TRANSFORMS
 *  registry in index.ts — if you add a transform there, add a schema here. */
export const TRANSFORM_SCHEMAS: Record<string, TransformSchema> = {
  // ── Collection ────────────────────────────────────────────
  filter: {
    array: REQ('array'),
    // field + operator are required for single-condition mode, but
    // optional when the author uses the `conditions` array mode (which
    // carries its own field/operator per entry). Runtime picks the
    // correct path based on whether `conditions` is present.
    field: OPT('string'),
    operator: OPT_ENUM(CONDITION_OPS),
    value: OPT('any'),
    conditions: OPT('array'),
    mode: OPT_ENUM(['all', 'any']),
  },
  sort: {
    array: REQ('array'),
    fields: OPT('array'),
    field: OPT('string'),
    direction: OPT_ENUM(SORT_DIRECTIONS),
  },
  map: {
    array: REQ('array'),
    expression: OPT('any'),
    apply: OPT('string'),
    field: OPT('string'),
    output_field: OPT('string'),
  },
  // Single-object analogue of `map` — projects ONE record (`object`) through the
  // `expression` template (the connection-agnostic single-object response
  // projection for read/create/update). Resolver-generated, but it MUST carry a
  // schema: the recipe validator (`validateTransformStep`) rejects any transform
  // absent from `TRANSFORM_SCHEMAS` as `unknown_transform`, and the resolved recipe
  // is re-validated at install (`installBulkPack` → `parseRecipe`).
  project: {
    object: REQ('object'),
    expression: REQ('any'),
  },
  reduce: {
    array: REQ('array'),
    operator: REQ_ENUM(REDUCE_OPS),
    field: OPT('string'),
    initial: OPT('any'),
  },
  unique: {
    array: REQ('array'),
    field: OPT('string'),
  },
  flatten: {
    array: REQ('array'),
    depth: OPT('number'),
  },
  slice: {
    array: REQ('array'),
    start: OPT('number'),
    end: OPT('number'),
  },
  group_by: {
    array: REQ('array'),
    field: REQ('string'),
    aggregate: OPT('object'),
    group_as: OPT('string'),
  },
  to_list: {
    input: REQ('any'),
  },
  chunk: {
    array: REQ('array'),
    size: REQ('number'),
  },
  partition: {
    array: REQ('array'),
    field: OPT('string'),
    operator: OPT_ENUM(CONDITION_OPS),
    value: OPT('any'),
    conditions: OPT('array'),
    mode: OPT_ENUM(['all', 'any']),
  },

  // ── Object ────────────────────────────────────────────────
  merge: {
    source: OPT('object'),
    sources: OPT('array'),
  },
  enrich_by: {
    array: REQ('array'),
    with: REQ('array'),
    key: REQ('string'),
    with_key: OPT('string'),
    fields: REQ('object'),
  },
  prefix_keys: {
    source: REQ('object'),
    prefix: REQ('string'),
  },
  pick: {
    source: REQ('object'),
  },
  omit: {
    source: REQ('object'),
    fields: REQ('array'),
  },
  rename: {
    source: REQ('object'),
    mapping: REQ('object'),
  },
  set: {
    source: REQ('object'),
    field: REQ('string'),
    value: REQ('any'),
  },
  json_byte_length: {
    input: REQ('any'),
  },
  json_stringify: {
    input: REQ('any'),
  },
  json_parse: {
    input: REQ('string'),
  },
  csv_parse: {
    input: REQ('string'),
    delimiter: OPT('string'),
    quote: OPT('string'),
    has_header: OPT('boolean'),
    ragged: OPT('string'),
  },
  utf8_byte_length: {
    input: REQ('string'),
  },
  sha256: {
    input: REQ('string'),
  },

  // ── String ────────────────────────────────────────────────
  lowercase: { input: REQ('string') },
  uppercase: { input: REQ('string') },
  trim:      { input: REQ('string') },
  string_length: { input: REQ('string') },
  encode_base64: { input: REQ('string') },
  decode_base64: { input: REQ('string') },
  split: {
    input: REQ('string'),
    delimiter: REQ('string'),
  },
  contains_any: {
    input: REQ('string'),
    terms: REQ('array'),
    case_sensitive: OPT('boolean'),
  },
  concat: {
    values: REQ('array'),
  },
  replace: {
    input: REQ('string'),
    pattern: REQ('string'),
    replacement: REQ('string'),
    all: OPT('boolean'),
  },
  template: {
    template: REQ('string'),
  },
  truncate: {
    input: REQ('string'),
    max_length: REQ('number'),
    suffix: OPT('string'),
  },
  strip_html: { input: REQ('string') },

  // ── Numeric ───────────────────────────────────────────────
  round: {
    input: REQ('number'),
    precision: OPT('number'),
  },
  clamp: {
    input: REQ('number'),
    min: REQ('number'),
    max: REQ('number'),
  },
  to_number: {
    input: REQ('any'),
  },
  math: {
    // Expression mode (preferred): "min(left / right * 100, 100)"
    expression: OPT('string'),
    // Classic mode: left/operator/right (still supported)
    left: OPT('number'),
    operator: OPT_ENUM(MATH_OPS),
    right: OPT('number'),
  },
  weighted_score: {
    scores: REQ('array'),    // [{value, weight}]
    clamp: OPT('array'),     // [min, max]
    precision: OPT('number'),// decimal places (default: 1)
  },

  // ── Date ──────────────────────────────────────────────────
  date_diff: {
    from: REQ('any'),
    to: REQ('any'),
    unit: REQ_ENUM(DATE_UNITS),
  },
  to_recent_date: { input: REQ('number') },
  date_format: {
    date: REQ('any'),
    format: REQ('string'),
  },
  date_add: {
    date: REQ('any'),
    amount: REQ('number'),
    unit: REQ_ENUM(DATE_UNITS),
  },
  date_parse: {
    input: REQ('any'),
    require_offset: OPT('boolean'),
  },
  is_past: {
    date: REQ('any'),
  },
  is_future: {
    date: REQ('any'),
  },
  date_period: {
    period: REQ_ENUM(DATE_PERIOD_NAMES),
  },

  // ── Logic ─────────────────────────────────────────────────
  compare: {
    left: REQ('any'),
    operator: REQ_ENUM(CONDITION_OPS),
    right: OPT('any'),
    value: OPT('any'),
  },
  coalesce: {
    values: REQ('array'),
  },
  // Note: `switch` is a TS reserved word; the implementation name is switch_
  // but the registry key is 'switch'. Schema keys match the registry.
  switch: {
    input: REQ('any'),
    cases: REQ('object'),
    default: OPT('any'),
  },
  all: {
    values: OPT('array'),
    conditions: OPT('array'),
  },
  any: {
    values: OPT('array'),
    conditions: OPT('array'),
  },
  count: {
    input: REQ('any'),
  },
  default: {
    value: REQ('any'),
    fallback: OPT('any'),
  },
  not: {
    input: REQ('any'),
  },
  ternary: {
    if: REQ('any'),
    then: REQ('any'),
    else: OPT('any'),
  },
  pluralize: {
    count: REQ('number'),
    zero: OPT('string'),
    one: OPT('string'),
    many: OPT('string'),
    other: OPT('string'),
  },

  // ── Privacy ───────────────────────────────────────────────
  hash_replace: {
    data: REQ('any'),
    fields: REQ('array'),
  },
  hash_restore: {
    data: REQ('any'),
    mapping: REQ('object'),
  },
  redact: {
    data: REQ('any'),
    fields: REQ('array'),
  },
  // D-167 P4 — reversible PII alias comfort layer. `fields` is optional
  // (omitted → no-op pass-through that still emits a ledger handle); each tag
  // is `{ path, kind }`, the deeper shape validated at runtime, not here.
  'pii-protect': {
    data: REQ('any'),
    fields: OPT('array'),
  },
  'pii-restore': {
    data: REQ('any'),
    ledger_handle: REQ('string'),
  },

  // ── Display ───────────────────────────────────────────────
  to_checklist: {
    title: REQ('string'),
    items: REQ('array'),
  },
  to_table: {
    array: REQ('array'),
    columns: REQ('array'),
  },
  to_summary: {
    fields: REQ('array'),
  },
  // Serialize rows → a CSV string artifact. `columns` is optional (omitted →
  // columns derived from the union of row keys); accepts field-name strings or
  // `{ field, label }` objects. `header`/`delimiter` default to true / ",".
  to_csv: {
    array: REQ('array'),
    columns: OPT('array'),
    delimiter: OPT('string'),
    header: OPT('boolean'),
  },
  to_slack_blocks: {
    blocks: REQ('array'),
  },

  // ── Boolean ───────────────────────────────────────────────
  starts_with: {
    input: REQ('string'),
    prefix: REQ('string'),
  },
  ends_with: {
    input: REQ('string'),
    suffix: REQ('string'),
  },

  // ── Compound (Tier 2) ─────────────────────────────────────
  find: {
    array: REQ('array'),
    field: REQ('string'),
    operator: REQ_ENUM(CONDITION_OPS),
    value: OPT('any'),
  },
  pluck: {
    array: REQ('array'),
    field: REQ('string'),
  },
  sum: {
    array: REQ('array'),
    field: OPT('string'),
  },
  min_by: {
    array: REQ('array'),
    field: REQ('string'),
  },
  max_by: {
    array: REQ('array'),
    field: REQ('string'),
  },
  percent: {
    value: REQ('number'),
    total: REQ('number'),
    precision: OPT('number'),
  },
  join: {
    array: REQ('array'),
    separator: REQ('string'),
  },

  // ── D-115 reactive (Tier 2 — starter set) ───────────────────
  mail_received: {
    mails: REQ('array'),
    from: OPT('string'),
    subject: OPT('string'),
    label: OPT('string'),
  },
  file_changed: {
    files: REQ('array'),
    since_ms: REQ('number'),
    path_prefix: OPT('string'),
    extension: OPT('string'),
  },
  calendar_starting_soon: {
    events: REQ('array'),
    minutes_ahead: REQ('number'),
    now: REQ('number'),
  },
  recipe_succeeded_since: {
    entries: REQ('array'),
    since_ms: REQ('number'),
    recipe_id: OPT('string'),
  },
  time_within_window: {
    now: REQ('number'),
    weekdays: OPT('array'),
    start_hour: OPT('number'),
    end_hour: OPT('number'),
  },
  time_elapsed_since: {
    now: REQ('number'),
    window_ms: REQ('number'),
    since_ms: OPT('number'),
  },
  http_changed: {
    current_etag: OPT('string'),
    previous_etag: OPT('string'),
    current_hash: OPT('string'),
    previous_hash: OPT('string'),
  },

  // ── D-117 calendar reactive helpers ──────────────────────
  // `events` is the `{{trigger.cal.items}}` array from the
  // calendar-watcher output; `since_ms` is the high-watermark the
  // recipe supplies (via `{{trigger.cal.last_seen_at}}` snapshotted
  // into `shared.*`, or via `{{context.now}} - window`).
  calendar_changed_since: {
    events: REQ('array'),
    since_ms: REQ('number'),
  },
  calendar_new_since: {
    events: REQ('array'),
    since_ms: REQ('number'),
  },
  // `prior` + `current` accept either full `CanonicalEvent` objects
  // (preferred — pair with `{{item.prior}}` and the full item) or raw
  // attendee arrays directly. Both are optional so recipes gating on
  // the first-sync case (`prior: null`) still type-check.
  attendee_diff: {
    prior: OPT('any'),
    current: OPT('any'),
    prior_attendees: OPT('array'),
    current_attendees: OPT('array'),
    attendees: OPT('array'),
  },

  // ── D-116 timing ──────────────────────────────────────────
  // The `max` on `ms` is enforced by the dedicated `validateWait`
  // hook in ../recipes (WAIT_TRANSFORM_MAX_MS). Schemas stay purely
  // about shape; specific bounds live next to the transform's other
  // cross-field rules (trigger_steps placement, non-reactive hint).
  wait: {
    ms: REQ('number'),
  },

  // ── D-125 P6.2 enrichment-first convention ───────────────
  'enrichment-or-fetch': {
    ref: REQ('string'),
    trust_min: OPT('number'),
    max_age_ms: OPT('number'),
    fallback_step: OPT('string'),
  },
};

/** Look up a transform's schema by name. Returns undefined for unknown names. */
export const getTransformSchema = (name: string): TransformSchema | undefined =>
  TRANSFORM_SCHEMAS[name];

/** Where `map` apply-mode injects the per-item field value: the target
 *  transform's value-input parameter name. The dominant convention is
 *  `input` (string / numeric / logic transforms — the default); the
 *  exceptions are listed here. One table shared by the runtime injection
 *  (collection.ts apply mode) and the recipe validator's apply-target
 *  param check, so the two can't drift.
 *
 *  History: apply mode used to inject as `from` whenever `field` was set,
 *  which only `date_diff` reads — every other field-carrying apply target
 *  (`compare` → left, `switch`/`math`-classic → input, `is_past` /
 *  `is_future` / `date_format` / `date_add` → date) silently computed on
 *  undefined and attached null / a wrong constant.
 *
 *  ⚠ ADDING AN ENTRY HERE UNBLOCKS A TARGET — `apply_target_incompatible`
 *  rejects any target whose schema lacks the injected param, so a transform
 *  is unusable in apply mode until it appears here (or already reads
 *  `input`). Two conditions have to hold before adding one:
 *
 *    1. The value param is unambiguous — the target takes exactly one
 *       "the thing being operated on" parameter.
 *    2. The target's schema does NOT declare `field`. Apply mode spreads
 *       every non-(array|apply|output_field) key of the map step into the
 *       target, so the step's `field` — which apply mode ALREADY uses to
 *       extract the per-item value — would arrive as the target's `field`
 *       too and mean something different. `sum`, `unique`, `pluck`,
 *       `min_by`, `filter`, `sort` and friends all collide that way: you
 *       cannot say "extract item.rows, then sum .amount inside it" with one
 *       `field`. They stay blocked deliberately, not by oversight. */
export const APPLY_VALUE_PARAM: Record<string, string> = {
  date_diff: 'from',
  date_add: 'date',
  date_format: 'date',
  is_past: 'date',
  is_future: 'date',
  compare: 'left',
  // {array, separator} — no `field`, so no collision. Turning a per-row array
  // into a testable string is the common shape (`pubTypeList.pubType` →
  // "Retracted Publication; Journal Article"), and `contains` is string-only,
  // so without this there is no way to test membership of a nested array from
  // a condition at all.
  join: 'array',
};

/** Resolve the apply-mode value parameter for a transform name. */
export const applyValueParam = (name: string): string =>
  APPLY_VALUE_PARAM[name] ?? 'input';
