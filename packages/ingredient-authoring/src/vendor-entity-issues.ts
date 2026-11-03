import type { IngredientEntityField, EntitySchemaIngredientInput } from '@recued/contracts';
import { normalizeEntityId } from './decomposer.js';
import { vendorEntityMetaField } from './vendor-entity-authoring.js';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const entityPropertyPath = (key: string, siblings?: Record<string, unknown>): string => /^[A-Za-z_]\w*$/.test(key)
  && !Object.keys(siblings ?? {}).some(other => other.startsWith(key + '.')) ? '.' + key : '[' + JSON.stringify(key) + ']';
/** Exact shared compiler projection joins only. Repeated identities/projections
 * withhold source ownership; no message parsing or new validation takes place. */
export const vendorEntitySchemaOrigins = (body: unknown, schemas: EntitySchemaIngredientInput[]): Map<number, string> => {
  const candidates = new Map<string, string[]>(), emitted = new Map<string, number>();
  if (!object(body) || !Array.isArray(body.ingredients)) return new Map();
  for (const [index, ingredient] of body.ingredients.entries()) {
    if (!object(ingredient) || ingredient.kind !== 'http' || !object(ingredient.entities)) continue;
    for (const [key, entity] of Object.entries(ingredient.entities)) {
      if (!object(entity) || !Array.isArray(entity.fields) || !entity.fields.every(object)) continue;
      const identity = JSON.stringify([normalizeEntityId(key), entity.fields.map(field => vendorEntityMetaField(field as unknown as IngredientEntityField)), entity.engagement]);
      candidates.set(identity, [...(candidates.get(identity) ?? []), `ingredients[${index}].entities${entityPropertyPath(key, ingredient.entities)}`]);
    }
  }
  const keys = schemas.map(schema => JSON.stringify([schema.entity_id, schema.meta_fields, schema.engagement]));
  for (const key of keys) emitted.set(key, (emitted.get(key) ?? 0) + 1);
  return new Map(keys.flatMap((key, index) => {
    const paths = candidates.get(key); return paths?.length === 1 && emitted.get(key) === 1 && schemas[index]?.ingredient_id === body.slug ? [[index, paths[0]!] as const] : [];
  }));
};
export const vendorEntityFindingPath = (origin: string | undefined, path: readonly (string | number)[] | undefined): string | undefined => {
  if (origin && path?.length === 2 && path[0] === 'engagement' && typeof path[1] === 'string') return origin + '.engagement.' + path[1];
  if (!origin || path?.length !== 3 || path[0] !== 'meta_fields' || typeof path[1] !== 'number' || typeof path[2] !== 'string') return;
  const key = ({ key: 'maps_to', type: 'type', description: 'description', source_path: 'field_path', privacy: 'pii', date_granularity: 'date_granularity' } as Record<string, string>)[path[2]];
  // required is derived from optional by boolean coercion, so never project a
  // generated required-shape failure back as an authored optional finding.
  return key ? origin + '.fields[' + path[1] + '].' + key : undefined;
};
