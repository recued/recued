/** Resolve a `record_fields` output block against a pack's own entity schema.
 *
 *  Pure, and deliberately in contracts rather than the engine: the engine
 *  resolves it at run time so every consumer sees it (an MCP / chat caller
 *  receives `{type, data, record_fields}` verbatim and never calls a
 *  renderer), and the Kitchen preview wants the same answer without an
 *  execution context. One implementation, both callers.
 *
 *  The block carries no per-field vocabulary. Everything a reader sees —
 *  label, format hint, PII class, "not set" — comes from the entity schema the
 *  pack already ships in `surfaces.records.schema.entities[<entity>]`. That is
 *  `filter`'s principle applied to the other boundary: a block that restated
 *  field metadata would let the block and the schema disagree, and the page
 *  would then describe a record shape the pack does not have.
 */

import type { RecordsEntitySnapshot } from './records.js';
import type {
  ResolvedRecordField,
  ResolvedRecordFieldsDescriptor,
  ResolvedRecordColumn,
  ResolvedRecordColumnsDescriptor,
  TableAppendedColumn,
} from './recipe.js';

/** One entity field as the PACK AUTHOR declared it, normalized across the two
 *  runtime shapes the same authored cell lands in.
 *
 *  A composition's `ingredients[].entities.<kind>.fields[]` is one cell —
 *  `{maps_to, type, optional, pii, description}` — but decomposition splits it
 *  by ingredient kind:
 *
 *    storage (Records) → `surfaces.records.schema.entities[<kind>].fields[]`
 *                        as `RecordsFieldSnapshot {key, slot, kind, required, privacy}`
 *    http    (API)     → `entity_schemas[].meta_fields` (scope
 *                        `connection.api.<vendor>.<entity>`)
 *                        as `{key, type, description, required, source_path, privacy}`
 *
 *  Those are the same facts under different key names in different places, and
 *  the split is 11 storage ingredients against 221 http ones. A block that read
 *  only the Records shape would derive its display from 5% of the declarations
 *  that exist — so the seam takes THIS, and each host adapts its own shape into
 *  it with the helpers below rather than each growing its own reader. */
export interface EntityFieldDeclaration {
  /** Friendly key the recipe and the record both use (`contact_name`). */
  key: string;
  /** Declared scalar kind — `string` / `number` / `boolean` / `datetime` /
   *  `date` / `id` / `json` … Drives formatting, never gating. */
  type: string;
  /** False when the author marked it optional; an absent optional field is the
   *  "not set" case rather than a missing one. */
  required: boolean;
  /** Declared PII class, carried for display badging only. */
  privacy?: string;
  /** Author's sentence about the field. Present on the http path, absent on the
   *  Records one — it is NOT a label (it reads "Attendee name.", not "Name"). */
  description?: string;
  /** Dotted path to the value in the RAW record, when that differs from `key`.
   *
   *  ⛔ Found live, and only live. An http entity's `key` is the FRIENDLY name
   *  (`event_type_slug`) while the record is the vendor's untouched payload,
   *  where the value sits at `eventType.slug`. Reading by `key` rendered a
   *  populated field as "Not set" — the exact failure this block was built to
   *  prevent, produced by the block itself.
   *
   *  Absent on the Records path ON PURPOSE: there the friendly projection has
   *  already happened, and that path's `source_path` is the physical SLOT
   *  (`s1`, `pk`), which is not where the value is on the returned record.
   *  The two adapters differ because the two records differ. */
  source_path?: string;
  /** Authored display name. Absent → `recordFieldLabel` title-cases `key`. */
  label?: string;
  /** For a reference field: the entity kind it targets. What a record picker
   *  would search, and what makes a wrong `<kind>/` prefix refusable. */
  references?: string;
}

/** Adapt the Records snapshot. `kind` is that shape's name for `type`. */
export const entityFieldsFromRecordsSnapshot = (
  snapshot: RecordsEntitySnapshot,
): EntityFieldDeclaration[] =>
  snapshot.fields.map((field) => ({
    key: field.key,
    type: field.kind,
    required: field.required,
    ...(field.label === undefined ? {} : { label: field.label }),
    ...(field.references === undefined ? {} : { references: field.references }),
    ...(field.privacy === undefined ? {} : { privacy: field.privacy }),
    ...(field.description === undefined ? {} : { description: field.description }),
  }));

/** Adapt an `entity_schemas[].meta_fields` row. Read defensively: it arrives
 *  from an installed artifact, not from a typed local build. */
export const entityFieldsFromMetaFields = (
  metaFields: readonly unknown[],
): EntityFieldDeclaration[] => {
  const out: EntityFieldDeclaration[] = [];
  for (const raw of metaFields) {
    if (!isRecord(raw)) continue;
    const { key, type, required, privacy, description, label } = raw;
    if (typeof key !== 'string' || key === '') continue;
    out.push({
      key,
      type: typeof type === 'string' && type !== '' ? type : 'string',
      // A meta field omits `required` when the author omitted `optional`, and
      // the decomposer already inverted it — so only an explicit false is
      // optional.
      required: required !== false,
      ...(typeof label === 'string' && label !== '' ? { label } : {}),
      ...(typeof raw.references === 'string' && raw.references !== ''
        ? { references: raw.references }
        : {}),
      ...(typeof privacy === 'string' ? { privacy } : {}),
      ...(typeof description === 'string' ? { description } : {}),
      ...(typeof raw.source_path === 'string' && raw.source_path !== ''
        ? { source_path: raw.source_path }
        : {}),
    });
  }
  return out;
};

/** Title-case a friendly key: `contact_name` → "Contact name", `due_at` →
 *  "Due at". The entity schema declares no label, so this is the whole of the
 *  label derivation — and it is wrong for acronyms and terms of art (`po_number`
 *  → "Po number"). Fixing that means a `label` cell on the entity field, which
 *  is an entity-schema decision, not this block's. */
export const recordFieldLabel = (key: string): string => {
  const spaced = key.replace(/[_-]+/g, ' ').trim();
  if (spaced.length === 0) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Find the one record inside a resolved `source`.
 *
 *  A recipe points this block at whatever step produced the row, and the
 *  Records ops do not agree on a shape: `get` returns `{ record }`, `search` /
 *  `get_many` return `{ records: [...] }`, and a `map`/`coalesce` transform
 *  hands over the bare row. Accepting all three is not laxity — it is the
 *  difference between the block working where authors actually put it and the
 *  author inserting a projection step whose only job is to unwrap. A list's
 *  FIRST row is deliberate: a block that silently rendered row 1 of many would
 *  be lying, so `records` is only unwrapped when it holds exactly one. */
export const recordFieldsSource = (source: unknown): Record<string, unknown> | null => {
  if (!isRecord(source)) return null;
  if (isRecord(source.record)) return source.record;
  if (Array.isArray(source.records)) {
    return source.records.length === 1 && isRecord(source.records[0])
      ? source.records[0]
      : null;
  }
  // A bare row. `_record` (the Records metadata envelope) or a plain `id` is
  // what distinguishes one from an arbitrary object a transform produced.
  //
  // `id` may be a NUMBER: Records mints string ids, but a vendor record does
  // not have to — Cal.com's booking carries `id: number` beside a string `uid`.
  // Accepting only strings made the block resolve `no_record` against every
  // API-backed entity whose key is numeric, which is most of them.
  if (isRecord(source._record)) return source;
  if (typeof source.id === 'string' || typeof source.id === 'number') return source;
  return null;
};

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/** Read a dotted path, reporting PRESENCE separately from value so an
 *  explicitly-null field is still "present" while a missing one is not. */
const readPath = (
  record: Record<string, unknown>,
  path: string,
): { present: boolean; value: unknown } => {
  let cur: unknown = record;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
      return { present: false, value: undefined };
    }
    const holder = cur as Record<string, unknown>;
    if (!hasOwn(holder, seg)) return { present: false, value: undefined };
    cur = holder[seg];
  }
  return { present: cur !== undefined, value: cur };
};

/** Project one declared field against the record. */
const resolveField = (
  field: EntityFieldDeclaration,
  record: Record<string, unknown>,
): ResolvedRecordField => {
  // Read where the declaration says the value IS, not where its name suggests.
  const { present, value } = readPath(record, field.source_path ?? field.key);
  return {
    key: field.key,
    label: field.label ?? recordFieldLabel(field.key),
    kind: field.type,
    ...(field.privacy !== undefined ? { privacy: field.privacy } : {}),
    ...(field.description !== undefined ? { description: field.description } : {}),
    present,
    value: present ? value : undefined,
  };
};

/** Resolve the block. `entity` is the authored entity kind; `declared` is the
 *  installed pack's normalized field list for it (null when no installed pack
 *  declares it); `source` is the resolved `step.<id>` value.
 *
 *  Returns a descriptor even when it cannot resolve, carrying `unresolved` so a
 *  consumer can tell "this record has no fields" from "I could not look it
 *  up". Rendering the second as the first is how an uninstalled pack would
 *  read as an empty record. */
export const resolveRecordFields = (
  entity: string,
  declared: readonly EntityFieldDeclaration[] | null,
  source: unknown,
  requested?: readonly string[],
): ResolvedRecordFieldsDescriptor => {
  if (declared === null) return { entity, fields: [], unresolved: 'no_schema' };
  const record = recordFieldsSource(source);
  if (record === null) return { entity, fields: [], unresolved: 'no_record' };

  const byKey = new Map(declared.map((f) => [f.key, f] as const));
  // Authored order when `fields` is given, declaration order otherwise. A
  // requested key the pack does not declare is DROPPED here and rejected at
  // install by the validator — the two must agree, and a blank row would hide
  // the typo.
  const selected = requested === undefined
    ? declared
    : requested
      .map((key) => byKey.get(key))
      .filter((f): f is EntityFieldDeclaration => f !== undefined);

  return { entity, fields: selected.map((f) => resolveField(f, record)) };
};

/** Field kinds whose values are QUANTITIES and read right-aligned.
 *
 *  ⛔ Derived from the declared kind, never from the runtime value. Money in a
 *  Records pack is a `decimal` slot authored `type: 'string'` and returned as
 *  `"1200.0000"` — a `typeof value === 'number'` test says text and left-aligns
 *  every amount in the ledger.
 *
 *  Dates are deliberately NOT here. They are ordered, but they read as labels
 *  and right-aligning them separates the column from its heading for no gain. */
export const NUMERIC_FIELD_KINDS: ReadonlySet<string> = new Set(['number', 'decimal']);

/** Column definitions for a `table` block, derived from the same entity schema
 *  `record_fields` reads. The rows come from the data; only the COLUMNS are
 *  resolved here, which is the half a recipe otherwise hand-writes.
 *
 *  ⚠ Deliberately NOT a values resolver. A table's cells are looked up per row
 *  by `field`, exactly as a hand-written `to_table` column does — so an
 *  entity-derived table and an authored one render through one path and a
 *  surface has no second shape to learn. */
export const resolveRecordColumns = (
  entity: string,
  declared: readonly EntityFieldDeclaration[] | null,
  requested?: ReadonlyArray<string | TableAppendedColumn>,
): ResolvedRecordColumnsDescriptor => {
  if (declared === null) return { entity, columns: [], unresolved: 'no_schema' };
  const byKey = new Map(declared.map((f) => [f.key, f] as const));

  /** One schema field as a column. */
  const fromSchema = (f: EntityFieldDeclaration): ResolvedRecordColumn => ({
    field: f.source_path ?? f.key,
    label: f.label ?? recordFieldLabel(f.key),
    kind: f.type,
    // ⛔ CARRIED SO AN EDITABLE REF CELL CAN BE A PICKER. The schema already
    // knows which entity a ref points at; without it here the column reaches
    // the grid as a plain text box and the owner types `tag/alice` by hand —
    // which is precisely the raw-id field `record_ref` exists to replace, one
    // layer up. Presentation only: what the picker offers is not what the
    // operation admits.
    ...(f.references === undefined ? {} : { references: f.references }),
    // Only the date family gets a format. A `decimal` is not necessarily
    // money and a `number` is not necessarily a quantity worth grouping —
    // guessing either would restyle a column the author never asked about.
    ...(f.type === 'date' || f.type === 'datetime' ? { format: 'date' as const } : {}),
  });

  // Authored order when `fields` is given, declaration order otherwise —
  // matching `resolveRecordFields` so the two blocks cannot disagree about
  // what "this entity's fields" means. A requested key the pack does not
  // declare is dropped here and refused at install by the validator.
  if (requested === undefined) return { entity, columns: declared.map(fromSchema) };

  const columns: ResolvedRecordColumn[] = [];
  for (const entry of requested) {
    if (typeof entry === 'string') {
      const f = byKey.get(entry);
      if (f !== undefined) columns.push(fromSchema(f));
      continue;
    }
    // An AUTHORED column: appended where the schema has no such field, an
    // override of presentation where it does. Either way the author's label
    // wins and their `kind` wins WHERE GIVEN — omitting `kind` on an override
    // keeps the schema's, so retitling a decimal does not silently un-align it.
    const base = byKey.get(entry.field);
    const kind = entry.kind ?? base?.type ?? 'string';
    columns.push({
      field: base?.source_path ?? entry.field,
      label: entry.label,
      kind,
      ...(kind === 'date' || kind === 'datetime' ? { format: 'date' as const } : {}),
      ...(entry.control !== undefined ? { control: entry.control } : {}),
      ...(entry.options !== undefined ? { options: [...entry.options] } : {}),
    });
  }
  return { entity, columns };
};

/** Wire-shape guard for the resolved column descriptor. */
export const isResolvedRecordColumnsDescriptor = (
  value: unknown,
): value is ResolvedRecordColumnsDescriptor => {
  if (!isRecord(value)) return false;
  if (typeof value.entity !== 'string') return false;
  if (!Array.isArray(value.columns)) return false;
  return value.columns.every((column) => isRecord(column)
    && typeof column.field === 'string'
    && typeof column.label === 'string'
    && typeof column.kind === 'string');
};

/** Wire-shape guard for the resolved descriptor. Lives beside the resolver so
 *  the producer and the check cannot drift; the renderer imports it rather than
 *  re-deriving what a valid descriptor looks like. */
export const isResolvedRecordFieldsDescriptor = (
  value: unknown,
): value is ResolvedRecordFieldsDescriptor => {
  if (!isRecord(value)) return false;
  if (typeof value.entity !== 'string' || value.entity.length === 0) return false;
  if (!Array.isArray(value.fields)) return false;
  if (value.unresolved !== undefined
    && value.unresolved !== 'no_schema'
    && value.unresolved !== 'no_record') return false;
  return value.fields.every((field) =>
    isRecord(field)
    && typeof field.key === 'string'
    && typeof field.label === 'string'
    && typeof field.kind === 'string'
    && typeof field.present === 'boolean'
    && (field.privacy === undefined || typeof field.privacy === 'string'));
};
