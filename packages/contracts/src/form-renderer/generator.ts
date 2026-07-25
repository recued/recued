/** D-145 PA5 — form-from-canonical-schema generator.
 *
 *  Pure function: given a canonical schema (per § A.1) plus an optional
 *  Source extension schema, emit a `FormDefinition` the renderer
 *  consumes. Two entry points:
 *    - `formFromCanonicalSchema(schema)` — Recued-Source path; just
 *      walks the canonical fields.
 *    - `formFromCanonicalSchemaWithExtension(schema, extension)` —
 *      non-Recued-Source path (HubSpot task extras, Salesforce
 *      task extras, etc.); merges canonical + extension. Canonical
 *      wins on name-collision; extension fields are tagged with
 *      `origin: 'extension'` so the renderer can group / annotate.
 *
 *  Spec: docs/d-145-spec.md § A.3.3.
 */

import type {
  CanonicalField,
  CanonicalFieldType,
  CanonicalSchema,
  CanonicalRelationship,
} from '../canonical-schemas/index.js';

import type {
  FormDefinition,
  FormField,
  SourceExtensionField,
  SourceExtensionSchema,
} from './types.js';

/** Pure: canonical schema → form definition. */
export const formFromCanonicalSchema = (
  schema: CanonicalSchema,
): FormDefinition => ({
  kind: schema.kind,
  fields: [
    ...schema.fields.map((f) => canonicalFieldToFormField(f, 'canonical')),
    ...schema.relationships.map((r) =>
      canonicalRelationshipToFormField(r, 'canonical'),
    ),
  ],
});

/** Pure: canonical schema + Source extension → form definition.
 *
 *  Extension fields whose name collides with a canonical field or
 *  relationship are dropped silently — canonical wins. Extension
 *  fields are appended after canonical, tagged `origin: 'extension'`. */
export const formFromCanonicalSchemaWithExtension = (
  schema: CanonicalSchema,
  extension: SourceExtensionSchema,
): FormDefinition => {
  const canonicalNames = new Set<string>([
    ...schema.fields.map((f) => f.name),
    ...schema.relationships.map((r) => r.name),
  ]);
  const extensionFields: FormField[] = [];
  const seenExtensionNames = new Set<string>();
  for (const f of extension.fields) {
    if (canonicalNames.has(f.name)) continue;
    if (seenExtensionNames.has(f.name)) continue; // drop dup-within-extension
    seenExtensionNames.add(f.name);
    extensionFields.push(extensionFieldToFormField(f));
  }
  return {
    kind: schema.kind,
    fields: [
      ...schema.fields.map((f) => canonicalFieldToFormField(f, 'canonical')),
      ...schema.relationships.map((r) =>
        canonicalRelationshipToFormField(r, 'canonical'),
      ),
      ...extensionFields,
    ],
  };
};

const canonicalFieldToFormField = (
  f: CanonicalField,
  origin: 'canonical' | 'extension',
): FormField => ({
  name: f.name,
  type: f.type,
  label: humanizeName(f.name),
  required: f.nullable !== true && f.auto !== true,
  hidden: f.auto === true,
  enum_values: f.enum_values,
  item_type: f.item_type,
  item_enum_values: f.item_enum_values,
  max_length: f.max_length,
  pattern: f.pattern,
  min: f.min,
  max: f.max,
  integer: f.integer,
  default: f.default,
  description: f.description,
  origin,
});

/** Map a canonical relationship into a `ref` (cardinality 'one') or
 *  `array<ref>` (cardinality 'many') form field. The `ref_target`
 *  carries the relationship's `ref` path so the renderer can launch
 *  the right entity picker. */
const canonicalRelationshipToFormField = (
  r: CanonicalRelationship,
  origin: 'canonical' | 'extension',
): FormField =>
  r.cardinality === 'many'
    ? {
        name: r.name,
        type: 'array' as const,
        label: humanizeName(r.name),
        required: r.nullable !== true,
        hidden: false,
        item_type: 'ref' as const,
        ref_target: r.ref,
        description: r.description,
        origin,
      }
    : {
        name: r.name,
        type: 'ref' as const,
        label: humanizeName(r.name),
        required: r.nullable !== true,
        hidden: false,
        ref_target: r.ref,
        description: r.description,
        origin,
      };

const extensionFieldToFormField = (f: SourceExtensionField): FormField => ({
  name: f.name,
  type: f.type,
  label: f.label ?? humanizeName(f.name),
  required: f.nullable !== true,
  hidden: false,
  enum_values: f.enum_values,
  item_type: f.item_type,
  item_enum_values: f.item_enum_values,
  ref_target: f.ref_target,
  max_length: f.max_length,
  pattern: f.pattern,
  min: f.min,
  max: f.max,
  integer: f.integer,
  default: f.default,
  description: f.description,
  origin: 'extension',
});

/** Convert a snake-case canonical field name into a human-readable
 *  label. `assigned_contact` → `Assigned contact`. Pure. */
export const humanizeName = (s: string): string => {
  if (s.length === 0) return s;
  return s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
};

/** Closed-list helper — convenience for callers who already know
 *  the kind. Returns `undefined` if the kind isn't in the registry. */
export const fieldTypesInRegistry = (): readonly CanonicalFieldType[] => [
  'text',
  'textarea',
  'number',
  'boolean',
  'date',
  'timestamp',
  'enum',
  'ref',
  'array',
  'uuid',
];
