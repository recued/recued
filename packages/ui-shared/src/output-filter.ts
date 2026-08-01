/** D-222 resolved-output filter state.
 *
 * Pure state/config helpers shared by the owner result panel and tests. Hidden
 * carrier values are copied from the trusted resolved descriptor, never read
 * from HTML. Search and paging deliberately have different cursor semantics.
 */

import type {
  OutputFilterInvocation,
  ResolvedFilterDescriptor,
  VariableDefault,
} from '@recued/contracts';
import {
  isValidValueHint,
  toWidgetShape,
  validateWidgetValue,
} from './variable-widgets.js';

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const isJsonCompatible = (
  value: unknown,
  ancestors: ReadonlySet<object> = new Set(),
): boolean => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonCompatible(entry, nextAncestors));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>)
    .every((entry) => isJsonCompatible(entry, nextAncestors));
};

const isVariableDefault = (value: unknown): value is VariableDefault =>
  value === null
  || typeof value === 'string'
  || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value))
  || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  || isValidValueHint(value as VariableDefault);

/** One runtime guard for every resolved-filter consumer. The engine is the
 *  producer, but transport data still crosses package/process boundaries; a
 *  copied partial check previously let the standalone renderer turn a numeric
 *  cursor into an actionable paging button while the Recipes panel rejected
 *  the same descriptor. Keep shape, eligibility, and paging semantics here. */
export const isResolvedFilterDescriptor = (
  value: unknown,
): value is ResolvedFilterDescriptor => {
  const row = asRecord(value);
  if (row === null
      || !Number.isInteger(row.section_index)
      || (row.section_index as number) < 0
      || typeof row.recipe_hash !== 'string'
      || row.recipe_hash.length === 0
      || !Array.isArray(row.fields)
      || !Array.isArray(row.hidden)
      || typeof row.submit !== 'string'
      || row.submit.trim().length === 0) {
    return false;
  }

  const fields = row.fields as unknown[];
  const hidden = row.hidden as unknown[];
  if ([...fields, ...hidden].some((key) =>
    typeof key !== 'string' || key.trim().length === 0)) return false;
  const fieldKeys = fields as string[];
  const hiddenKeys = hidden as string[];
  if (new Set(fieldKeys).size !== fieldKeys.length
      || new Set(hiddenKeys).size !== hiddenKeys.length) return false;
  const fieldSet = new Set(fieldKeys);
  if (hiddenKeys.some((key) => fieldSet.has(key))) return false;

  const definitions = asRecord(row.definitions);
  const values = asRecord(row.values);
  if (definitions === null || values === null) return false;
  const listed = new Set([...fieldKeys, ...hiddenKeys]);
  if (Object.keys(definitions).length !== listed.size
      || Object.keys(definitions).some((key) => !listed.has(key))
      || Object.keys(values).some((key) =>
        !listed.has(key) || !isJsonCompatible(values[key]))) return false;

  for (const key of fieldKeys) {
    if (!hasOwn(definitions, key)) return false;
    const definition = definitions[key];
    if (!isVariableDefault(definition)
        || !isValidValueHint(definition)
        || definition.type === 'secret'
        || definition.type === 'oauth') return false;
  }
  for (const key of hiddenKeys) {
    if (!hasOwn(definitions, key)) return false;
    const definition = definitions[key];
    if (!isVariableDefault(definition)) return false;
    if (isValidValueHint(definition)
        && (definition.type === 'secret' || definition.type === 'oauth')) return false;
  }

  if (row.paging !== undefined) {
    const paging = asRecord(row.paging);
    if (paging === null
        || Object.keys(paging).some((key) =>
          key !== 'next_cursor' && key !== 'prev_cursor')
        || (paging.next_cursor !== undefined && typeof paging.next_cursor !== 'string')
        || (paging.prev_cursor !== undefined && typeof paging.prev_cursor !== 'string')) {
      return false;
    }
  }
  return true;
};

const clone = <T>(value: T): T => structuredClone(value);

const jsonEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

export interface OutputFilterState {
  readonly executed_values: Record<string, unknown>;
  readonly draft_values: Record<string, unknown>;
  readonly dirty: boolean;
}

export const outputFilterKey = (
  recipeId: string,
  descriptor: Pick<ResolvedFilterDescriptor, 'recipe_hash' | 'section_index'>,
): string => `${recipeId}:${descriptor.recipe_hash}:${descriptor.section_index}`;

export const initialOutputFilterState = (
  descriptor: ResolvedFilterDescriptor,
): OutputFilterState => {
  const executed: Record<string, unknown> = {};
  const draft: Record<string, unknown> = {};
  for (const key of [...descriptor.fields, ...descriptor.hidden]) {
    if (!hasOwn(descriptor.values, key)) continue;
    executed[key] = clone(descriptor.values[key]);
    if (descriptor.fields.includes(key)) draft[key] = clone(descriptor.values[key]);
  }
  return { executed_values: executed, draft_values: draft, dirty: false };
};

export const setOutputFilterDraftValue = (
  descriptor: ResolvedFilterDescriptor,
  state: OutputFilterState,
  key: string,
  value: unknown,
): OutputFilterState => {
  if (!descriptor.fields.includes(key)) return state;
  const draft = { ...state.draft_values, [key]: clone(value) };
  const dirty = descriptor.fields.some((field) => {
    const draftHas = hasOwn(draft, field);
    const executedHas = hasOwn(state.executed_values, field);
    return draftHas !== executedHas
      || (draftHas && !jsonEqual(draft[field], state.executed_values[field]));
  });
  return {
    executed_values: state.executed_values,
    draft_values: draft,
    dirty,
  };
};

export const validateOutputFilterDraft = (
  descriptor: ResolvedFilterDescriptor,
  state: OutputFilterState,
): ReadonlyArray<{ key: string; message: string }> => {
  const issues: Array<{ key: string; message: string }> = [];
  for (const key of descriptor.fields) {
    const definition = descriptor.definitions[key];
    if (definition === undefined) continue;
    const value = hasOwn(state.draft_values, key)
      ? state.draft_values[key]
      : undefined;
    const shape = toWidgetShape(key, definition as VariableDefault, value);
    const message = validateWidgetValue(shape, shape.value);
    if (message !== null) issues.push({ key, message });
  }
  return issues;
};

const copyHiddenCarrier = (
  descriptor: ResolvedFilterDescriptor,
): Record<string, unknown> => {
  const config: Record<string, unknown> = {};
  for (const key of descriptor.hidden) {
    if (!hasOwn(descriptor.values, key)) continue;
    config[key] = clone(descriptor.values[key]);
  }
  return config;
};

/** A new search carries edited visible values and every non-cursor hidden
 *  value, but always resets an eligible cursor to its empty declaration
 *  default. */
export const outputFilterSearchConfig = (
  descriptor: ResolvedFilterDescriptor,
  state: OutputFilterState,
): Record<string, unknown> => {
  const config = copyHiddenCarrier(descriptor);
  for (const key of descriptor.fields) {
    if (!hasOwn(state.draft_values, key)) continue;
    config[key] = clone(state.draft_values[key]);
  }
  if (descriptor.hidden.includes('cursor')) {
    const definition = descriptor.definitions.cursor;
    const declared = definition === undefined
      ? undefined
      : toWidgetShape('cursor', definition).value;
    if (declared === '') config.cursor = '';
  }
  return config;
};

/** A page turn is bound to the last successfully executed values, replacing
 *  only the cursor. Dirty visible fields are a UI state error and refuse. */
export const outputFilterPageConfig = (
  descriptor: ResolvedFilterDescriptor,
  state: OutputFilterState,
  cursor: string,
): Record<string, unknown> => {
  if (state.dirty) {
    throw new Error('Run Search before paging with edited filter values.');
  }
  const config: Record<string, unknown> = {};
  for (const key of [...descriptor.fields, ...descriptor.hidden]) {
    if (!hasOwn(state.executed_values, key)) continue;
    config[key] = clone(state.executed_values[key]);
  }
  config.cursor = cursor;
  return config;
};

export const outputFilterInvocation = (
  descriptor: ResolvedFilterDescriptor,
): OutputFilterInvocation => ({
  kind: 'output.filter',
  recipe_hash: descriptor.recipe_hash,
  section_index: descriptor.section_index,
});

/** Weakly-consistent pages can repeat a row at a shifted boundary. Keep the
 *  first row for each string/number `id`; rows without a usable id remain. */
export const dedupeOutputRowsById = <T>(rows: readonly T[]): T[] => {
  const seen = new Set<string | number>();
  const out: T[] = [];
  for (const row of rows) {
    const id = row !== null && typeof row === 'object' && !Array.isArray(row)
      ? (row as { id?: unknown }).id
      : undefined;
    if ((typeof id === 'string' || typeof id === 'number') && seen.has(id)) continue;
    if (typeof id === 'string' || typeof id === 'number') seen.add(id);
    out.push(row);
  }
  return out;
};
