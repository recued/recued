import type { ClosedInputSchema } from './closed-inputs.js';

/** Bounded missing-value scaffolding, never a business default or a type coercion.
 * Objects contain required children only; arrays and scalar leaves remain explicit nulls.
 */
export const closedInputScaffold = (schema: ClosedInputSchema) => {
  const placeholders: string[][] = []; let fields = 0, complete = true;
  const build = (field: ClosedInputSchema, path: string[], depth: number): unknown => {
    if (++fields > 100 || depth > 8) { complete = false; return null; }
    if (field.type !== 'object') { placeholders.push(path); return null; }
    const value: Record<string, unknown> = {};
    for (const key of field.required ?? []) {
      const child = field.properties?.[key]; if (!child) { complete = false; return value; }
      Object.defineProperty(value, key, { value: build(child, [...path, key], depth + 1), enumerable: true, configurable: true, writable: true });
      if (!complete) break;
    }
    return value;
  };
  const value = build(schema, [], 0);
  return complete ? { value, placeholders, fields } : undefined;
};
