import { ENTITY_FIELD_PRIVACY_KINDS, recordsSlotKind, type IngredientEntityField } from '@recued/contracts';
import { recordsSlots, recordsMetaFieldType } from './records.js';

interface Field { type: 'string' | 'boolean'; description: string; required?: boolean }
/** Editing metadata for persisted Records fields; the canonical validator still decides admission. */
const fields = {
  maps_to: { type: 'string', required: true, description: 'Friendly field key exposed to recipes. Dotted keys stay literal field identities.' },
  field_path: { type: 'string', required: true, description: 'One fixed Records storage slot. Each slot can be assigned once per entity. Changing an installed row shape requires migration review.' },
  type: { type: 'string', required: true, description: 'The shared warehouse type required by this storage slot. Decimal and reference slots use string; date slots use datetime plus date granularity.' },
  optional: { type: 'boolean', description: 'Whether this stored field may be absent. The protected id mapped to pk is required.' },
  source_operation: { type: 'string', description: 'The declared read operation that exposes this entity field.' },
  pii: { type: 'string', description: 'The field privacy class. Choose the sensitivity of the data explicitly.' },
  label: { type: 'string', description: 'Display name for this field. Changing a label redeclares its presentation rather than migrating storage.' },
  description: { type: 'string', description: 'A description of this field for authors and AI context.' },
  references: { type: 'string', description: 'For an r1..r5 reference slot, the entity declared in this same Records composition that the stored reference targets.' },
  date_granularity: { type: 'string', description: 'date for a d slot or datetime for a dt slot. Other slot kinds have no date granularity.' },
} satisfies Partial<Record<keyof IngredientEntityField, Field>>;
export const recordsFieldFields = (): (Field & { key: string })[] => Object.entries(fields).map(([key, field]) => ({ key, ...field }));
export const recordsFieldChoices = (key: string, field: Partial<IngredientEntityField>, usedSlots: readonly string[], entities: readonly string[]): (string | boolean)[] => {
  const slot = field.field_path, kind = slot === 'pk' ? 'id' : typeof slot === 'string' ? recordsSlotKind(slot) : undefined;
  if (key === 'field_path') return ['pk', ...recordsSlots()].filter(value => !usedSlots.includes(value)
    && (field.maps_to !== 'id' || value === 'pk')
    && (value !== 'pk' || field.maps_to === undefined || field.maps_to === '' || field.maps_to === 'id')
    && (!field.type || recordsMetaFieldType(value === 'pk' ? 'id' : recordsSlotKind(value)!) === field.type));
  if (key === 'type') return kind ? [recordsMetaFieldType(kind)] : [];
  if (key === 'references') return kind === 'ref' ? [...entities] : [];
  if (key === 'date_granularity') return kind === 'date' || kind === 'datetime' ? [kind] : [];
  if (key === 'optional') return kind === 'id' ? [false] : [true, false];
  if (key === 'pii') return [...ENTITY_FIELD_PRIVACY_KINDS];
  return [];
};
