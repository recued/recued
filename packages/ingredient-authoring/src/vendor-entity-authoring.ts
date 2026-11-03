import { META_FIELD_TYPES, ENTITY_FIELD_PRIVACY_KINDS, DATE_GRANULARITIES, CRM_ALIAS_VALUES, ACCT_ALIAS_VALUES,
  CANONICAL_CRM_FIELD_SCHEMA, crmFieldPackTypeConforms, isMetaFieldType, type CrmAlias, type IngredientEntityField, type MetaField } from '@recued/contracts';
interface Field { key: string; type: 'string' | 'boolean' | 'array' | 'object' | 'number'; required?: boolean; description: string }
const fields = {
  field_path: { type: 'string', required: true, description: 'Authored vendor response path. It is not a Records storage slot. Choose it from the actual response; the editor does not infer vendor paths or result envelopes.' },
  maps_to: { type: 'string', required: true, description: 'Canonical field key exposed by this mapping. A CRM alias offers shared canonical names; vendor extras retain the existing portability warning.' },
  type: { type: 'string', required: true, description: 'Warehouse MetaFieldType from the shared schema contract. Canonical CRM fields also have shared accepted types. This does not validate returned provider data.' },
  optional: { type: 'boolean', description: 'True lowers to required false; omission or false lowers to required true. This is an explicit author claim about the mapped field.' },
  pii: { type: 'string', description: 'Declared privacy class for the mapped data. Choose it explicitly. It does not establish grants, approval or a guarantee of redaction.' },
  source_operation: { type: 'string', description: 'Declared local operation sourcing this field. Existing operation completion, F12 and Rename apply. A declaration does not establish runtime availability.' },
  description: { type: 'string', description: 'Field description carried into the generated entity schema.' },
  label: { type: 'string', description: 'Display heading carried into the generated entity schema, separate from its description.' },
  date_granularity: { type: 'string', description: 'Request-side date filter granularity: date or datetime, and only for a datetime field. Shared validation retains its existing rules.' },
} satisfies Partial<Record<keyof IngredientEntityField, Omit<Field, 'key'>>>;
export const vendorEntityFieldFields = (): Field[] => Object.entries(fields).map(([key, value]) => ({ key, ...value }));
export const vendorEntityFields = (): Field[] => [
  { key: 'engagement', type: 'object', description: 'Explicit activity category for email, meeting, call or task mappings. Mutually exclusive with CRM/accounting aliases. Capability and sync metadata do not run provider probes or establish quotas.' },
  { key: 'fields', type: 'array', required: true, description: 'Vendor-to-canonical field declarations. Authored vendor paths remain explicit; catalog lowering emits entity schema metadata.' },
  { key: 'crm_alias', type: 'string', description: 'Explicit canonical CRM category. Mutually exclusive with accounting aliases and engagement facets; each alias has one owner per composition. Missing required CRM mappings are portability warnings.' },
  { key: 'acct_alias', type: 'string', description: 'Explicit canonical accounting category. Mutually exclusive with CRM aliases and engagement facets. The editor does not infer the category from names or vendor paths.' },
];
export const vendorCrmAlias = (value: unknown): CrmAlias | undefined => (CRM_ALIAS_VALUES as readonly unknown[]).includes(value) ? value as CrmAlias : undefined;
export const vendorCanonicalFields = (alias: unknown) => { const key = vendorCrmAlias(alias); return key ? CANONICAL_CRM_FIELD_SCHEMA[key] : []; };
export const vendorEntityFieldChoices = (key: string, field: Partial<IngredientEntityField>, alias: unknown, used: readonly string[] = []): (string | boolean)[] => {
  const crm = vendorCrmAlias(alias);
  if (key === 'type') return META_FIELD_TYPES.filter(type => !crm || !field.maps_to || crmFieldPackTypeConforms(crm, field.maps_to, type));
  if (key === 'pii') return [...ENTITY_FIELD_PRIVACY_KINDS];
  if (key === 'optional') return [true, false];
  if (key === 'date_granularity') return field.type === 'datetime' ? [...DATE_GRANULARITIES] : [];
  if (key === 'maps_to') return vendorCanonicalFields(alias).filter(row => !used.includes(row.name)
    && (!isMetaFieldType(field.type) || crmFieldPackTypeConforms(crm!, row.name, field.type))).map(row => row.name);
  return [];
};
export const vendorEntityAliases = (key: string): readonly string[] => key === 'crm_alias' ? CRM_ALIAS_VALUES : key === 'acct_alias' ? ACCT_ALIAS_VALUES : [];
/** This exact projection is used by the compiler, source joins and the inspector.
 * Keep key order and undefined handling stable: generated artifact bytes matter. */
export const vendorEntityMetaField = (field: IngredientEntityField): MetaField => ({
  key: field.maps_to, type: field.type, description: field.description,
  ...(field.label === undefined ? {} : { label: field.label }),
  required: field.optional === undefined ? true : !field.optional,
  source_path: field.field_path, privacy: field.pii,
  ...(field.date_granularity === undefined ? {} : { date_granularity: field.date_granularity }),
});
