import { typedKernelArguments, type KernelArgumentSchema } from '@recued/contracts';
import { referencePath as formatReferencePath } from './reference-locations.js';
import { REF_PATTERN, type AddFn } from './helpers.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const dynamic = (value: unknown) => typeof value === 'string' && REF_PATTERN.test(value);
const matches = (value: unknown, type: string): boolean => type === 'object' ? object(value) : type === 'array' ? Array.isArray(value)
  : type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
    : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;

/** Static constraints only: values containing references defer to dispatch. */
export const validateKernelArguments = (recipe: Record<string, unknown>, add: AddFn): void => {
  const visit = (value: unknown, schema: KernelArgumentSchema, path: (string | number)[]) => {
    const at = formatReferencePath(path);
    if (dynamic(value)) return;
    if (schema.type && !matches(value, schema.type)) {
      add('error', 'kernel_argument_type', at, `kernel argument must be ${schema.type}`); return;
    }
    if (schema.enum && !schema.enum.includes(value)) {
      add('error', 'kernel_argument_enum', at, `kernel argument must be one of ${schema.enum.map(v => JSON.stringify(v)).join(', ')}`);
    }
    if (typeof value === 'number' && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) {
      add('error', 'kernel_argument_range', at, `kernel argument is outside its declared numeric bounds${schema.minimum !== undefined ? ` (minimum ${schema.minimum})` : ''}${schema.maximum !== undefined ? ` (maximum ${schema.maximum})` : ''}`);
    }
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) {
        add('error', 'kernel_argument_items', at, 'kernel argument array is outside its declared item-count bounds');
      }
      if (schema.items) value.forEach((item, index) => visit(item, schema.items!, [...path, index]));
    } else if (object(value)) {
      const entries = Object.entries(value), dynamicKeys = entries.some(([key]) => dynamic(key));
      if (!dynamicKeys) for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) {
        add('error', 'kernel_argument_required', formatReferencePath([...path, key]), `kernel argument ${JSON.stringify(key)} is required`);
      }
      for (const [key, child] of entries) {
        if (dynamic(key)) continue;
        const field = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
        if (field) visit(child, field, [...path, key]);
        else if (schema.additionalProperties === false) add('error', 'kernel_argument_unknown', formatReferencePath([...path, key]), `unknown kernel argument ${JSON.stringify(key)}`);
      }
    }
  };
  for (const group of ['steps', 'prefetch_steps', 'trigger_steps']) {
    const steps = recipe[group]; if (!Array.isArray(steps)) continue;
    steps.forEach((step, index) => {
      if (!object(step) || typeof step.op !== 'string') return;
      const schema = typedKernelArguments(step.op, object(step.args) ? step.args : {}); if (!schema) return;
      visit(step.args === undefined ? {} : step.args, schema, [group, index, 'args']);
    });
  }
};
