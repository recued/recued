/** Connection-agnostic op dispatch — vendor WRITE-body reverse projection.
 *
 *  The request-side mirror of the read projection for the WRITE verbs. A
 *  connection-agnostic `<crm_alias>.{create,update}` op-step carries a CANONICAL
 *  field→value body (`{ name, stage, amount }` — canonical field names, NOT vendor
 *  property names) plus, for `update`/`delete`, a canonical `id` record selector.
 *  The read projection (`connection-agnostic.ts`) maps a vendor record → canonical
 *  field names via the pack's `entity_fields`; THIS module does the inverse for the
 *  request: it reverse-maps each canonical body field → the vendor `field_path` and
 *  shapes the vendor write body, so a LIVE create/update hits the vendor with the
 *  right payload (§C of the contract doc).
 *
 *  WRITABILITY (§2B) — only coerce-only / source-backed canonical fields are
 *  WRITABLE; a DERIVED field (`close_state`, the `name` concat, `mailing_address`) has
 *  no single vendor source, so it has no `entity_fields` row → writing it fails
 *  closed (read-only). The reverse map is built from the SAME response rows the read
 *  projection uses, so read and write are symmetric over the round-trippable fields.
 *
 *  Two write DSLs, each its own builder keyed by the catalog-declared WRITE DIALECT
 *  (`surfaces.api.write_style`), NOT the vendor id — decoupling lets a 3rd-party CRM
 *  whose write API matches a shipped dialect declare it and resolve with zero new
 *  code; a structurally-novel API adds one reviewed dialect builder to the closed set
 *  below (the same extension model as `SearchStyle`):
 *    - `hubspot_properties` — one `body.properties` object of BARE property names
 *      (the `properties.` prefix stripped from each vendor `field_path`), scalar
 *      values STRING-coerced (the inverse of the read side's G2 number-from-string —
 *      HubSpot stores/compares properties as strings). Emitted as the
 *      `body.properties` wire-key arg.
 *    - `salesforce_sobject` — each vendor `field_path` a flat `body.<field>` wire-key
 *      arg, values TYPE-preserved (the sObject REST body is typed JSON).
 *  The `id` record selector is dialect-INDEPENDENT — it maps to the vendor path-param
 *  token `<vendorEntity>_id` (the convention every shipped CRM catalog follows:
 *  `{{deal_id}}` / `{{contact_id}}` / `{{opportunity_id}}`), passed as a top-level
 *  dispatch arg the catalog gateway substitutes into the op's `path_template`.
 *
 *  SAFETY — unlike a search filter (which bakes a value into a query STRING), a write
 *  value rides as a JSON body VALUE (no injection surface), so a `{{ref}}` value is
 *  ALLOWED (it resolves at runtime into the body) and values are NOT type-checked at
 *  install. What IS attacker-influenced for a 3rd-party pack is the KEY-paths: the
 *  vendor `field_path` (→ body key / wire key) and the canonical `maps_to`. They are
 *  guarded with the SAME `PROJECTION_FIELD_PATH_REGEX` / prototype-key rules the read
 *  projection uses (`connection-agnostic-paths.ts`) so an unsafe identifier fails
 *  closed (no prototype pollution, no wire-key smuggling). The resolver also
 *  pre-validates every response row before calling here; the builder re-checks the
 *  field_paths it actually splices (self-contained, like the SOQL search builder).
 *
 *  SCOPE: `create`/`update` bodies + `update`/`delete` selectors. `read`/`search`
 *  keep their own paths. Canonical single-object RESPONSE projection (reading a write
 *  result back as canonical fields) is deferred — a write op outputs the raw vendor
 *  record envelope (see the resolver). HubSpot scalar→string covers number/boolean
 *  LITERALS; a number `{{ref}}` resolves to a number at runtime (HubSpot's write API
 *  accepts both — the read side is the strict consumer). A catalog that declares no
 *  `write_style` (or an unknown dialect) fails closed for `create`/`update`.
 */
import type { EntityFieldRow, WriteStyle } from '@recued/contracts';
import { WRITE_STYLES } from '@recued/contracts';
import {
  PROJECTION_FIELD_PATH_REGEX,
  isSafeIdentifierSegment,
} from './connection-agnostic-paths.js';

/** The canonical record selector key used to address WHICH record to read / update /
 *  delete (every selector-bearing verb) — vendor-neutral (`id`), reverse-mapped to the
 *  vendor path-param token `<vendorEntity>_id`. The only reserved top-level write arg;
 *  every OTHER key is a canonical body field.
 *
 *  CONTRACT EXCEPTION (intentional): `id` is ALWAYS the record selector, never a
 *  writable body field — so a canonical field that happens to be named `id` (a vendor
 *  field mapped to canonical `id`, e.g. the Pipedrive test fixture's `id → id`) is
 *  selector-only and cannot be reverse-projected INTO a write body. This matches CRM
 *  semantics: a record's identity is assigned by the vendor and addresses the record;
 *  you never write a record's own id as a property. The READ projection still projects
 *  a canonical `id` field normally (this reservation is write-side only). */
export const WRITE_SELECTOR_KEY = 'id';

/** The write verbs this module derives args for. `delete` carries only a selector (no
 *  body, no dialect); `create`/`update` shape a body via the declared dialect. */
export type CanonicalWriteVerb = 'create' | 'update' | 'delete';

/** Build result — a discriminated union (not a throw) so the write module stays free
 *  of the resolver's `CanonicalOpResolutionError` (no circular import) and the
 *  resolver attaches the op-step context to the message. Mirrors `SearchArgsResult`. */
export type WriteArgsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; reason: string };

/** A canonical body field resolved against the pack's vendor fields — the dialect
 *  builders consume this and only SHAPE it (field resolution already happened). */
interface ResolvedWriteField {
  /** the canonical field name (a `maps_to`) — for error context. */
  canonical: string;
  /** the resolved vendor field path (HubSpot `properties.amount`, SF `Amount`). */
  field_path: string;
  /** the canonical field type (drives the HubSpot scalar→string coercion). */
  type: EntityFieldRow['type'];
  /** the value to write — a literal OR a `{{ref}}` (resolved at runtime); passed
   *  through untouched except the HubSpot scalar→string coercion. */
  value: unknown;
}

interface VendorWriteInput {
  fields: ReadonlyArray<ResolvedWriteField>;
}

// A dialect builder may FAIL CLOSED (an unsafe spliced field identifier from a
// 3rd-party pack); returns the body wire-key args (the selector is added by the
// caller, since it is dialect-independent).
type VendorWriteBuilder = (input: VendorWriteInput) => WriteArgsResult;

/** A record selector value must be present + usable — a non-empty literal id or a
 *  `{{ref}}` string (resolves at runtime). An empty string / null would address no
 *  path target. */
const isUsableSelector = (value: unknown): boolean =>
  (typeof value === 'string' && value.length > 0) ||
  (typeof value === 'number' && Number.isFinite(value));

/** Selector-only arg derivation — shared by the SELECTOR-ONLY verbs (`read` /
 *  `delete`), which carry NO body and NO write dialect: the op-step's args must be
 *  exactly the canonical `id` record selector, reverse-mapped to the vendor path-param
 *  token `<vendorEntity>_id` (the dispatch arg the catalog gateway substitutes into the
 *  op's `path_template`). Any extra key fails closed (a selector-only verb addresses ONE
 *  record by id — it has no body). `verb` is used only for the fail-closed message. */
export const deriveRecordSelectorArgs = (
  vendorEntity: string,
  verb: string, // 'read' | 'delete' — only for the error message
  rawArgs: Record<string, unknown>,
): WriteArgsResult => {
  if (!isSafeIdentifierSegment(vendorEntity)) {
    return {
      ok: false,
      reason: `vendor entity '${vendorEntity}' is not a safe identifier for a '<entity>_id' path-param selector key`,
    };
  }
  const selectorKey = `${vendorEntity}_id`;
  const hasSelector = Object.prototype.hasOwnProperty.call(rawArgs, WRITE_SELECTOR_KEY);
  const selector = rawArgs[WRITE_SELECTOR_KEY];
  const extra = Object.keys(rawArgs).filter((k) => k !== WRITE_SELECTOR_KEY);
  if (!hasSelector || !isUsableSelector(selector)) {
    return {
      ok: false,
      reason: `canonical '${verb}' requires an '${WRITE_SELECTOR_KEY}' record selector (the id of the record to ${verb})`,
    };
  }
  if (extra.length > 0) {
    return {
      ok: false,
      reason: `canonical '${verb}' takes only an '${WRITE_SELECTOR_KEY}' selector, not ${extra.join(', ')}`,
    };
  }
  return { ok: true, args: { [selectorKey]: selector } };
};

// ────────────────────────────────────────────────────────────────
// Central field resolution (vendor-agnostic)
// ────────────────────────────────────────────────────────────────

/** Canonical→vendor reverse map: `maps_to` → its `EntityFieldRow`. A DERIVED
 *  canonical field is READ-ONLY and excluded, so writing it fails closed:
 *   - a field with no vendor source (no `source_path`, no row — `name` concat,
 *     `mailing_address`) is absent from `rows` entirely, OR
 *   - a COMPUTED field (a `derivation` — e.g. `close_state`, read from multiple
 *     vendor flags) HAS a row but no single writable source, so it is skipped here.
 *  Duplicate `maps_to` is the resolver's concern (it fails closed before calling
 *  here), so first-wins is never observed in practice. */
const buildReverseMap = (
  rows: ReadonlyArray<EntityFieldRow>,
): ReadonlyMap<string, EntityFieldRow> => {
  const map = new Map<string, EntityFieldRow>();
  for (const row of rows) {
    if (row.derivation !== undefined) continue; // computed → read-only (G3)
    if (!map.has(row.maps_to)) map.set(row.maps_to, row);
  }
  return map;
};

/** Resolve each canonical body field to its vendor field. Fail closed on a key the
 *  pack does not map (unknown, or a derived/read-only field with no vendor source) —
 *  the write surface accepts only writable (source-backed) canonical fields (§2B). */
const resolveWriteFields = (
  reverse: ReadonlyMap<string, EntityFieldRow>,
  body: ReadonlyArray<readonly [string, unknown]>,
): { ok: true; fields: ResolvedWriteField[] } | { ok: false; reason: string } => {
  const fields: ResolvedWriteField[] = [];
  for (const [canonical, value] of body) {
    const row = reverse.get(canonical);
    if (row === undefined) {
      return {
        ok: false,
        reason:
          `write body references canonical field '${canonical}' which the pack does not map to a writable ` +
          `vendor field (unknown, or a derived/read-only field with no vendor source)`,
      };
    }
    fields.push({ canonical, field_path: row.field_path, type: row.type, value });
  }
  return { ok: true, fields };
};

/** SECURITY — fail-closed message for a vendor `field_path` that isn't a safe write
 *  identifier. The resolver pre-validates every response row's `field_path`; the
 *  builder re-checks the ones it actually splices into a vendor body key-path. */
const writeIdentifierReason = (field: ResolvedWriteField): string =>
  `canonical field '${field.canonical}' maps to vendor field_path '${field.field_path}' which is not a ` +
  `safe write identifier (a write field_path is spliced into the vendor body key-path; it must be a ` +
  `dot-path of identifier segments with no prototype keys)`;

// ────────────────────────────────────────────────────────────────
// HubSpot — { properties: { <bareName>: <stringified> } }  →  body.properties arg
// ────────────────────────────────────────────────────────────────

/** HubSpot write paths are `properties.<name>`; the create/update body wants the BARE
 *  property name under a single `properties` object. Strip the single `properties.`
 *  prefix; pass anything else through (a top-level field). */
const hubspotWireName = (fieldPath: string): string =>
  fieldPath.startsWith('properties.') ? fieldPath.slice('properties.'.length) : fieldPath;

/** HubSpot stores/compares properties as STRINGS — coerce a scalar (number/boolean)
 *  LITERAL to its string form (the inverse of the read side's G2 number coercion). A
 *  `{{ref}}` value is already a string here (it resolves at runtime to its canonical
 *  type; HubSpot's write API accepts a number too — only the read side is strict), and
 *  a non-scalar (an object/array from a `json` field, null) is left intact (`String()`
 *  would mangle it). */
const hubspotWriteValue = (value: unknown): unknown =>
  typeof value === 'number' || typeof value === 'boolean' ? String(value) : value;

const buildHubspotPropertiesWrite: VendorWriteBuilder = ({ fields }) => {
  // Null-proto so a `__proto__` bare name (rejected below too) lands as an own
  // property, never the prototype — defense in depth with the segment guard.
  const properties: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    if (!PROJECTION_FIELD_PATH_REGEX.test(field.field_path)) {
      return { ok: false, reason: writeIdentifierReason(field) };
    }
    const bareName = hubspotWireName(field.field_path);
    // The bare name becomes an OBJECT KEY in `properties`; reject any prototype-
    // sensitive / non-identifier segment (`properties.__proto__` → pollution).
    if (!bareName.split('.').every(isSafeIdentifierSegment)) {
      return { ok: false, reason: writeIdentifierReason(field) };
    }
    properties[bareName] = hubspotWriteValue(field.value);
  }
  return { ok: true, args: { 'body.properties': properties } };
};

// ────────────────────────────────────────────────────────────────
// Salesforce — { <Field>: <typed> }  →  body.<Field> wire-key args
// ────────────────────────────────────────────────────────────────

const buildSalesforceSObjectWrite: VendorWriteBuilder = ({ fields }) => {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    // A flat sObject body field — the `field_path` becomes a `body.<field>` wire key
    // the connection-api folds to a top-level sObject body field. Require a SINGLE
    // safe identifier (rejects a dotted relationship path — not writable flat — plus
    // prototype keys / wire metacharacters).
    if (!isSafeIdentifierSegment(field.field_path)) {
      return { ok: false, reason: writeIdentifierReason(field) };
    }
    out[`body.${field.field_path}`] = field.value; // typed; no coercion
  }
  return { ok: true, args: out };
};

// ────────────────────────────────────────────────────────────────
// Pipedrive — { <field>: <typed> }  →  body.<field> wire-key args
// ────────────────────────────────────────────────────────────────

const buildPipedriveJsonWrite: VendorWriteBuilder = ({ fields }) => {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    // Pipedrive v2 create/update bodies are flat JSON objects for the CRM fields we
    // expose (`title`, `value`, `owner_id`, etc.). Reject dotted/array paths until a
    // nested body dialect is deliberately added.
    if (!isSafeIdentifierSegment(field.field_path)) {
      return { ok: false, reason: writeIdentifierReason(field) };
    }
    out[`body.${field.field_path}`] = field.value;
  }
  return { ok: true, args: out };
};

// ────────────────────────────────────────────────────────────────
// Dispatch
// ────────────────────────────────────────────────────────────────

/** The closed set of reviewed write-body builders, keyed by the catalog-declared
 *  WRITE DIALECT (`WriteStyle`) — NOT by vendor. A `Record<WriteStyle, …>` so adding a
 *  dialect to the `WriteStyle` union forces a builder here (exhaustive). */
const WRITE_BUILDERS: Record<WriteStyle, VendorWriteBuilder> = {
  hubspot_properties: buildHubspotPropertiesWrite,
  salesforce_sobject: buildSalesforceSObjectWrite,
  pipedrive_json: buildPipedriveJsonWrite,
};

/** Derive the vendor connection-api wire-key args for a canonical write op
 *  (`create`/`update`/`delete`) from its canonical body + selector + the vendor
 *  entity's response `entity_fields`. Returns `{ ok: false, reason }` on a bad arg
 *  shape (wrong/missing selector, empty body, a `delete` with body fields), an
 *  unwritable canonical field, an unsafe spliced identifier, or — for `create`/
 *  `update` — a catalog that declares no (or an unknown) `write_style`; the resolver
 *  wraps the reason in a `CanonicalOpResolutionError` with the op-step context.
 *
 *  `writeStyle` is the catalog-declared dialect (`surfaces.api.write_style`) that
 *  selects the body builder — NOT the vendor id. `vendorEntity` derives the path-param
 *  selector key `<vendorEntity>_id`. `rows` are the SAME response-side `entity_fields`
 *  the resolver builds the read projection from (duplicate `maps_to` already
 *  failed-closed by the resolver). `rawArgs` is the op-step's `args` verbatim: the
 *  reserved `id` selector (for `update`/`delete`) plus canonical body fields. */
export const deriveVendorWriteArgs = (
  writeStyle: WriteStyle | undefined,
  vendorEntity: string,
  verb: CanonicalWriteVerb,
  rows: ReadonlyArray<EntityFieldRow>,
  rawArgs: Record<string, unknown>,
): WriteArgsResult => {
  // The vendor path-param token the canonical `id` selector maps to. Guard the
  // spliced entity name (it becomes a dispatch-arg KEY) even though the registry /
  // entity-schema validates it.
  if (!isSafeIdentifierSegment(vendorEntity)) {
    return {
      ok: false,
      reason: `vendor entity '${vendorEntity}' is not a safe identifier for a '<entity>_id' path-param selector key`,
    };
  }
  const selectorKey = `${vendorEntity}_id`;

  // (1) split the canonical args into the reserved `id` selector + the body fields.
  const hasSelector = Object.prototype.hasOwnProperty.call(rawArgs, WRITE_SELECTOR_KEY);
  const selector = rawArgs[WRITE_SELECTOR_KEY];
  const body: Array<readonly [string, unknown]> = [];
  for (const [key, value] of Object.entries(rawArgs)) {
    if (key === WRITE_SELECTOR_KEY) continue;
    body.push([key, value]);
  }

  // (2) per-verb arg-shape validation.
  // `delete` is selector-only (no body, no dialect) — identical shape to `read`, so it
  // delegates to the shared selector-only deriver (re-validates the entity guard above,
  // harmlessly).
  if (verb === 'delete') {
    return deriveRecordSelectorArgs(vendorEntity, 'delete', rawArgs);
  }

  // create / update — both shape a write body via the declared dialect.
  if (verb === 'create' && hasSelector) {
    return {
      ok: false,
      reason: `canonical 'create' must not carry an '${WRITE_SELECTOR_KEY}' selector — the vendor assigns the new record's id`,
    };
  }
  if (verb === 'update' && (!hasSelector || !isUsableSelector(selector))) {
    return {
      ok: false,
      reason: `canonical 'update' requires an '${WRITE_SELECTOR_KEY}' record selector (the id of the record to update)`,
    };
  }
  if (body.length === 0) {
    return { ok: false, reason: `canonical '${verb}' requires at least one canonical field to write` };
  }

  const builder = writeStyle === undefined ? undefined : WRITE_BUILDERS[writeStyle];
  if (builder === undefined) {
    return {
      ok: false,
      reason:
        writeStyle === undefined
          ? `this CRM pack declares no canonical write-body builder — its catalog must declare ` +
            `surfaces.api.write_style (one of: ${WRITE_STYLES.join(' | ')}) so a canonical ` +
            `create/update can be translated to the vendor write body`
          : `write style '${writeStyle}' has no canonical write-body builder (known dialects: ${WRITE_STYLES.join(' | ')})`,
    };
  }

  const resolved = resolveWriteFields(buildReverseMap(rows), body);
  if (!resolved.ok) return resolved;

  const built = builder({ fields: resolved.fields });
  if (!built.ok) return built;

  // update — add the path-param selector alongside the body wire keys.
  if (verb === 'update') {
    return { ok: true, args: { ...built.args, [selectorKey]: selector } };
  }
  return built;
};
