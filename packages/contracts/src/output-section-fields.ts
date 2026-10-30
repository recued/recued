import type { DataOutputSection, FilterOutputSection, RecordFieldsOutputSection, TableOutputSection, TableEditSpec, TableSelectSpec, TableAppendedColumn } from './recipe.js';

/** Closed authoring keys, shared by admission and editor help. */
export const OUTPUT_SECTION_KEYS = ['type', 'source', 'label'] as const satisfies readonly (keyof DataOutputSection)[];
export const FILTER_OUTPUT_SECTION_KEYS = [...OUTPUT_SECTION_KEYS, 'fields', 'hidden', 'submit'] as const satisfies readonly (keyof FilterOutputSection)[];
export const RECORD_FIELDS_OUTPUT_SECTION_KEYS = [...OUTPUT_SECTION_KEYS, 'entity', 'fields'] as const satisfies readonly (keyof RecordFieldsOutputSection)[];
export const TABLE_OUTPUT_SECTION_KEYS = [...OUTPUT_SECTION_KEYS, 'entity', 'fields', 'edit', 'select', 'group_by'] as const satisfies readonly (keyof TableOutputSection)[];
export type OutputSectionKey = typeof FILTER_OUTPUT_SECTION_KEYS[number] | typeof RECORD_FIELDS_OUTPUT_SECTION_KEYS[number] | typeof TABLE_OUTPUT_SECTION_KEYS[number];
export const TABLE_EDIT_KEYS = ['into', 'submit', 'rows', 'hidden', 'columns', 'scopes'] as const satisfies readonly (keyof TableEditSpec)[];
export const TABLE_SELECT_KEYS = ['into', 'submit', 'id_field', 'hidden'] as const satisfies readonly (keyof TableSelectSpec)[];
export const TABLE_COLUMN_KEYS = ['field', 'label', 'kind', 'control', 'options'] as const satisfies readonly (keyof TableAppendedColumn)[];
export const TABLE_EDIT_ROW_MODES = ['fixed', 'add_remove'] as const satisfies readonly NonNullable<TableEditSpec['rows']>[];

type Complete<Shape, Keys extends readonly string[]> = Exclude<keyof Shape, Keys[number]> extends never ? true : false;
const complete: [
  Complete<DataOutputSection, typeof OUTPUT_SECTION_KEYS>,
  Complete<FilterOutputSection, typeof FILTER_OUTPUT_SECTION_KEYS>,
  Complete<RecordFieldsOutputSection, typeof RECORD_FIELDS_OUTPUT_SECTION_KEYS>,
  Complete<TableOutputSection, typeof TABLE_OUTPUT_SECTION_KEYS>,
  Complete<TableEditSpec, typeof TABLE_EDIT_KEYS>,
  Complete<TableSelectSpec, typeof TABLE_SELECT_KEYS>,
  Complete<TableAppendedColumn, typeof TABLE_COLUMN_KEYS>,
] = [true, true, true, true, true, true, true];
void complete;

export const outputSectionKeys = (type: unknown): readonly string[] => type === 'filter' ? FILTER_OUTPUT_SECTION_KEYS
  : type === 'record_fields' ? RECORD_FIELDS_OUTPUT_SECTION_KEYS : type === 'table' ? TABLE_OUTPUT_SECTION_KEYS : OUTPUT_SECTION_KEYS;
