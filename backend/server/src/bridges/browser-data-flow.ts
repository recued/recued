import type { BrowserDataOperation } from '@recued/contracts';
import { browserDataError } from './browser-data-store.js';

type Kind = 'array' | 'object' | 'string' | 'number' | 'boolean' | 'null' | 'unknown';
const arrays = new Set(['filter', 'sort', 'map', 'unique', 'flatten', 'slice', 'chunk', 'enrich_by', 'to_list', 'pluck', 'split']);
const objects = new Set(['pick', 'omit', 'rename', 'set', 'prefix_keys']);
const numbers = new Set(['count', 'sum']);
const strings = new Set(['json_stringify', 'lowercase', 'uppercase', 'trim', 'replace', 'template']);
const known = (value: string | undefined): Kind => ['array', 'object', 'string', 'number', 'boolean', 'null'].includes(value ?? '') ? value as Kind : 'unknown';

/** Only positive shape facts are propagated. Unknown captures, nested refs and
 * transforms with value-dependent output remain unknown, never guessed. */
export const createBrowserDataFlow = (inputKind?: string) => {
  let current = known(inputKind), previous = 'input';
  const named = new Map<string, Kind>([['input', current]]);
  const kindOf = (value: unknown): Kind => {
    if (typeof value === 'string') {
      const ref = /^\$([A-Za-z][A-Za-z0-9_]*)$/.exec(value);
      if (ref) return named.get(ref[1]!) ?? 'unknown';
      return value.startsWith('$') || value.includes('{{') ? 'unknown' : 'string';
    }
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'object') return Object.keys(value as object).length === 1 && 'data_ref' in value ? 'unknown' : 'object';
    return known(typeof value);
  };
  const inputKindOf = (op: BrowserDataOperation, slot: string | undefined) =>
    slot !== undefined && Object.hasOwn(op, slot) ? kindOf(op[slot]) : current;
  const check = (op: BrowserDataOperation, slot: string | undefined, expected: string | undefined) => {
    const explicit = slot !== undefined && Object.hasOwn(op, slot);
    const actual = inputKindOf(op, slot);
    // Array/object mismatches retain their existing checked map/project repair.
    // A known scalar after count needs an explicitly selected earlier branch.
    if (expected && !['any', 'unknown'].includes(expected) && !['unknown', 'array', 'object'].includes(actual) && actual !== expected) {
      throw browserDataError(`${op.transform} needs ${expected} input, but ${explicit ? slot : previous} supplies ${actual}. `
        + `Automatic input is the preceding value. Keep earlier values under an operation id; ${op.transform} selects one with ${slot ?? 'its input parameter'}:"$id". `
        + (op.transform === 'project' ? 'project takes one object; map reshapes array rows. Return retained rows and their count together when sufficient.' : 'Use the transform schema for its input parameter.'));
    }
    current = op.transform === 'group_by' ? op.aggregate ? 'array' : 'object'
      : op.transform.startsWith('table.') || arrays.has(op.transform) ? 'array'
      : objects.has(op.transform) ? 'object' : numbers.has(op.transform) ? 'number'
        : strings.has(op.transform) ? 'string' : op.transform === 'project' ? kindOf(op.expression) : 'unknown';
    previous = op.transform;
    if (op.id) named.set(op.id, current);
  };
  return Object.assign(check, { inputKindOf });
};
