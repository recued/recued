import { getField } from '@recued/transforms';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);

/** Browser columns use exact own keys before the recipe engine's nested paths.
 * This does not change global recipe transform semantics. */
export const browserDataField = (row: unknown, field: string): unknown => !forbidden.has(field) && object(row) && Object.hasOwn(row, field)
  ? row[field] : getField(row, field);

/** Adapt literal dotted column names for existing collection transforms.
 * Aliases are non-enumerable, collision-free and discarded by the pipeline's
 * output clone. Original rows and all public column names stay unchanged. */
export const browserDataFieldParams = (name: string, params: Record<string, unknown>): Record<string, unknown> => {
  if (!Array.isArray(params.array) || name === 'map' && params.expression !== undefined) return params;
  const rows = params.array;
  const wanted = new Set<string>();
  const inspect = (field: unknown) => {
    if (typeof field === 'string' && field.includes('.') && !forbidden.has(field)
      && rows.some(row => object(row) && Object.hasOwn(row, field))) wanted.add(field);
  };
  inspect(params.field);
  for (const key of ['conditions', 'fields']) if (Array.isArray(params[key])) for (const item of params[key]) if (object(item)) inspect(item.field);
  if (object(params.aggregate)) for (const item of Object.values(params.aggregate)) if (object(item)) inspect(item.field);
  if (!wanted.size) return params;
  const keys = new Set(rows.flatMap(row => object(row) ? Object.keys(row) : []));
  let prefix = '__recued_field_';
  while ([...wanted].some((_, index) => keys.has(prefix + index))) prefix += '_';
  const aliases = new Map([...wanted].map((field, index) => [field, prefix + index]));
  const field = (value: unknown) => typeof value === 'string' ? aliases.get(value) ?? value : value;
  const fields = (items: unknown) => Array.isArray(items) ? items.map(item => object(item) ? { ...item, field: field(item.field) } : item) : items;
  const adapted = { ...params, array: rows.map(row => {
    if (!object(row)) return row;
    const copy = { ...row };
    for (const [column, alias] of aliases) Object.defineProperty(copy, alias, { value: Object.hasOwn(row, column) ? row[column] : undefined, enumerable: false });
    return copy;
  }) };
  return { ...adapted,
    ...(params.field !== undefined ? { field: field(params.field) } : {}),
    ...(params.conditions !== undefined ? { conditions: fields(params.conditions) } : {}),
    ...(params.fields !== undefined ? { fields: fields(params.fields) } : {}),
    ...(object(params.aggregate) ? { aggregate: Object.fromEntries(Object.entries(params.aggregate).map(([key, item]) =>
      [key, object(item) && item.field !== undefined ? { ...item, field: field(item.field) } : item])) } : {}),
    ...(name === 'group_by' && params.group_as === undefined && aliases.has(String(params.field)) ? { group_as: params.field } : {}),
  };
};
