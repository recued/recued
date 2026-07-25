/** Connection-agnostic op dispatch — shared projection path-safety guards.
 *
 *  Extracted (write-verb reverse projection slice) from `connection-agnostic.ts`
 *  (d997a500) so BOTH the read-side resolver AND the request-side reverse builders
 *  (the write module `connection-agnostic-write.ts`) enforce the SAME field_path /
 *  canonical-key safety grammar. Lives in its own module to avoid a circular import
 *  (the resolver imports the write module, which imports these guards).
 *
 *  SECURITY context: a 3rd-party CRM pack's vendor `field_path` comes from its
 *  composition `source_path`, which the entity-schema layer validates ONLY as
 *  non-whitespace (deliberately permissive — it must not false-reject a non-CRM
 *  JSONPath like `$..author` / `x['Due Date']`). When such a `field_path` is spliced
 *  into a `{{item.<field_path>}}` template ref (read projection) OR a vendor body
 *  key-path (write reverse projection), and its `maps_to` becomes nested object KEYS,
 *  an unconstrained value could exfiltrate warehouse data (template-ref injection) or
 *  pollute the prototype. These guards admit exactly the safe projectable paths and
 *  fail everything else closed.
 */

/** Object keys that walk to the prototype chain — never legitimate canonical field
 *  names or vendor property names. */
export const PROTOTYPE_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  '__proto__', 'constructor', 'prototype',
]);

/** A projectable vendor `field_path`: a `walkPath` dot-path of identifier OR numeric
 *  (array-index) segments — `properties.dealname`, `Name`, `data.0.value`.
 *
 *  The read projection emits `{{item.<field_path>}}` and the engine resolves a `map`
 *  expression with `deferItem` — leaving `{{item.*}}` raw but RESOLVING every OTHER
 *  namespace against the live stores. The write reverse projection splices the
 *  `field_path` into a vendor body key-path. This grammar admits exactly the
 *  `walkPath`-resolvable dot-paths (every shipped first-party path matches) and
 *  rejects the template metacharacters (`{` `}` `|` `:` space quotes) an injection
 *  needs — so a `field_path` that isn't a plain projectable path fails closed. */
export const PROJECTION_FIELD_PATH_REGEX = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;

/** A single SAFE identifier segment — letter-leading, alphanumeric/underscore, and
 *  not a prototype-sensitive key. Used where a path segment becomes an OBJECT KEY (a
 *  canonical `maps_to` segment, a HubSpot bare property name, the `<entity>_id`
 *  selector key) — i.e. stricter than `PROJECTION_FIELD_PATH_REGEX` (no leading
 *  digit, no prototype key). */
export const isSafeIdentifierSegment = (seg: string): boolean =>
  /^[A-Za-z][A-Za-z0-9_]*$/.test(seg) && !PROTOTYPE_SENSITIVE_KEYS.has(seg);

/** A canonical `maps_to`: a dot-path of identifier (letter-leading) segments, none
 *  prototype-sensitive. `maps_to` becomes nested object KEYS in the read projection
 *  template (`assignProjectionPath`), so a `__proto__` segment would pollute the
 *  prototype. `META_FIELD_KEY_REGEX` (entity-schema) already blocks `__proto__` for
 *  the composition path, but the pure resolver must not trust a hand-built / future
 *  caller context, so it re-checks here. */
export const isSafeCanonicalKey = (mapsTo: string): boolean =>
  mapsTo.split('.').every(isSafeIdentifierSegment);

/** A per-operand connection SLOT ref (`CanonicalOpStep.connection`, doc §1.3): a
 *  PURE `{{config.<var>}}` ref and nothing else — `<var>` the recipe-identifier
 *  grammar (one rule across step IDs / config / refs). Anchored both ends so a
 *  slot can never smuggle interpolation, another namespace (`{{step.x}}` would be
 *  a dispatch-target injection from data), or a literal connection name (non-
 *  portable in a published canonical recipe). Shared by the resolver (fail-closed
 *  resolve), the recipe validator, and the dispatch slot derivation. */
export const OP_STEP_CONNECTION_REF_REGEX = /^\{\{config\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}$/;

/** Parse a slot ref to its `config` variable name (`{{config.crm_a}}` → `crm_a`);
 *  `undefined` when the value is not a pure config ref. */
export const parseOpStepConnectionRef = (ref: string): string | undefined =>
  OP_STEP_CONNECTION_REF_REGEX.exec(ref)?.[1];
