import {
  RECORDS_MAX_PREDICATES, parseRecordsViewSettings,
  type RecordsEntitySnapshot, type RecordsFieldSnapshot, type RecordsViewSettings,
} from '@recued/contracts';
import { e } from '@recued/ui-shared';

export interface RecordsFilterDraft { field: string; op: string; value: string }
export interface RecordsViewDraft { filters: RecordsFilterDraft[]; sort: string }
export interface RecordsBrowseState {
  view: RecordsViewSettings;
  viewDraft: RecordsViewDraft;
  nextCursor: string | null;
  prevCursor: string | null;
  page: number;
}

export const recordsViewDraft = (view: RecordsViewSettings): RecordsViewDraft => ({
  filters: Object.entries(view.filters ?? {}).map(([field, filter]) => ({
    field,
    op: filter.op === 'is_null' && !filter.value ? 'is_not_null' : filter.op,
    value: filter.op === 'is_null' ? '' : filter.op === 'in' ? JSON.stringify(filter.value) : String(filter.value),
  })),
  sort: view.sort ?? 'id',
});
export const initialRecordsBrowseState = (view: RecordsViewSettings = {}): RecordsBrowseState => ({
  view, viewDraft: recordsViewDraft(view), nextCursor: null, prevCursor: null, page: 1,
});
export const recordsViewHasDraft = (state: RecordsBrowseState): boolean =>
  JSON.stringify(state.viewDraft) !== JSON.stringify(recordsViewDraft(state.view));

const ordered = (field: RecordsFieldSnapshot): boolean =>
  ['number', 'decimal', 'date', 'datetime', 'boolean'].includes(field.kind);
export const recordsFilterOperators = (field: RecordsFieldSnapshot): string[] => [
  ...(field.kind === 'text' || field.kind === 'id' ? [] : ['eq', 'ne', 'in']),
  ...(ordered(field) && field.kind !== 'boolean' ? ['lt', 'lte', 'gt', 'gte'] : []),
  ...(field.kind === 'string' ? ['prefix'] : []),
  ...(field.kind === 'id' ? [] : ['is_null', 'is_not_null']),
];
export const recordsSortFields = (entity: RecordsEntitySnapshot): Array<{ key: string; label: string }> => [
  { key: 'id', label: 'Record ID' },
  { key: '_record.created_at', label: 'Created' },
  { key: '_record.updated_at', label: 'Updated' },
  ...entity.fields.filter(ordered).map(field => ({ key: field.key, label: field.label ?? field.key })),
];

const filterValue = (field: RecordsFieldSnapshot, value: unknown): string | number | boolean | null => {
  if (value === null) return null;
  if (field.kind === 'number') {
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) throw new Error(`Type a number for ${field.key}.`);
    return number;
  }
  if (field.kind === 'boolean') {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new Error(`Choose yes or no for ${field.key}.`);
  }
  if (typeof value !== 'string') throw new Error(`Type some text for ${field.key}.`);
  if (field.kind === 'decimal' && !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error(`Type an amount for ${field.key}.`);
  if (field.kind === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error(`Type a date for ${field.key}.`);
  if (field.kind === 'datetime' && (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))) {
    throw new Error(`Type a date, a time, and a time zone for ${field.key}.`);
  }
  return value;
};

/** Validate against the currently installed schema before issuing a read. A
 * saved field that disappeared remains visible and fails until the owner edits it. */
export const parseRecordsViewDraft = (draft: RecordsViewDraft, entity: RecordsEntitySnapshot): RecordsViewSettings => {
  const filters: Record<string, unknown> = {};
  for (const row of draft.filters) {
    const field = entity.fields.find(field => field.key === row.field);
    if (!field || !recordsFilterOperators(field).includes(row.op)) throw new Error(`The filter for ${row.field || 'this field'} cannot be used. Pick a different field or test.`);
    if (Object.hasOwn(filters, row.field)) throw new Error(`Use one filter per field (${row.field}).`);
    let value: unknown;
    if (row.op === 'is_null' || row.op === 'is_not_null') value = row.op === 'is_null';
    else if (row.op === 'in') {
      let items: unknown;
      try { items = JSON.parse(row.value); } catch { throw new Error(`Type a list, like ["open", "closed"], for ${row.field}.`); }
      if (!Array.isArray(items)) throw new Error(`Type a list of values for ${row.field}.`);
      value = items.map(item => filterValue(field, item));
    } else value = filterValue(field, row.value);
    Object.defineProperty(filters, row.field, { value: { op: row.op === 'is_not_null' ? 'is_null' : row.op, value }, enumerable: true });
  }
  const sortField = draft.sort.startsWith('-') ? draft.sort.slice(1) : draft.sort;
  if (!recordsSortFields(entity).some(field => field.key === sortField)) throw new Error(`The sort field ${sortField} cannot be used. Pick another order.`);
  const view = parseRecordsViewSettings({ filters, sort: draft.sort });
  if (view === null) throw new Error('Check what you typed before using this view.');
  return view;
};

const operatorLabels: Record<string, string> = {
  eq: 'Equals', ne: 'Does not equal', in: 'Any of', prefix: 'Starts with',
  lt: 'Less than', lte: 'At most', gt: 'Greater than', gte: 'At least',
  is_null: 'Is not set', is_not_null: 'Is set',
};
const option = (value: string, label: string, selected: string): string =>
  `<option value="${e(value)}"${selected === value ? ' selected' : ''}>${e(label)}</option>`;

export const renderRecordsViewControls = (state: RecordsBrowseState, entity: RecordsEntitySnapshot, loading: boolean): string => {
  const fields = entity.fields.filter(field => field.kind !== 'id');
  const disabled = loading ? ' disabled' : '';
  const sorts = recordsSortFields(entity).flatMap(field => [
    { key: field.key, label: `${field.label} — ascending` },
    { key: `-${field.key}`, label: `${field.label} — descending` },
  ]);
  return `<form class="records-view-controls" data-records-view-form aria-label="Filter and sort Records">
    <p class="records-help">Match all filters. Apply to refresh results.</p>
    ${state.viewDraft.filters.map((row, index) => {
      const field = fields.find(field => field.key === row.field);
      const operators = field ? recordsFilterOperators(field) : [];
      const rowAttr = `data-records-filter-index="${index}"`;
      const valueAttrs = `data-action="records-filter-value" ${rowAttr} aria-label="Filter ${index + 1} value"${disabled}`;
      return `<div class="records-filter-row">
        <label>Field<select data-action="records-filter-field" ${rowAttr} aria-label="Filter ${index + 1} field"${disabled}>
          ${field ? '' : option(row.field, `${row.field} (unavailable)`, row.field)}
          ${fields.map(field => option(field.key, field.label ?? field.key, row.field)).join('')}</select></label>
        <label>Condition<select data-action="records-filter-op" ${rowAttr} aria-label="Filter ${index + 1} condition"${disabled}>
          ${operators.includes(row.op) ? '' : option(row.op, `${row.op} (unavailable)`, row.op)}
          ${operators.map(op => option(op, operatorLabels[op]!, row.op)).join('')}</select></label>
        ${row.op === 'is_null' || row.op === 'is_not_null' ? '' : `<label>Value${field?.kind === 'boolean' && row.op !== 'in'
          ? `<select ${valueAttrs}>${option('', 'Choose a value', row.value)}${option('true', 'True', row.value)}${option('false', 'False', row.value)}</select>`
          : `<input ${valueAttrs} type="${row.op !== 'in' && field?.kind === 'date' ? 'date' : 'text'}" value="${e(row.value)}" maxlength="20000" ${row.op === 'in' ? 'placeholder=\'["open", "closed"]\'' : field?.kind === 'datetime' ? 'placeholder="2026-09-11T09:00:00-07:00"' : ''}>`}</label>`}
        <button type="button" data-action="records-remove-filter" ${rowAttr} aria-label="Remove filter ${index + 1}"${disabled}>Remove</button>
      </div>`;
    }).join('')}
    <div class="records-view-actions">
      <button type="button" data-action="records-add-filter"${loading || state.viewDraft.filters.length >= Math.min(fields.length, RECORDS_MAX_PREDICATES) ? ' disabled' : ''}>Add filter</button>
      <label>Sort records<select data-action="records-view-sort" aria-label="Sort records"${disabled}>
        ${sorts.some(sort => sort.key === state.viewDraft.sort) ? '' : option(state.viewDraft.sort, `${state.viewDraft.sort} (unavailable)`, state.viewDraft.sort)}
        ${sorts.map(sort => option(sort.key, sort.label, state.viewDraft.sort)).join('')}</select></label>
      <button type="submit" data-action="records-apply-view"${loading ? ' aria-disabled="true"' : ''}>Apply filters and sorting</button>
      <button type="button" data-action="records-reset-view"${loading ? ' aria-disabled="true"' : ''}>Reset filters and sorting</button>
    </div>
    <p class="records-help" data-records-draft-status role="status"${recordsViewHasDraft(state) ? '' : ' hidden'}>Unapplied changes. Apply filters and sorting before saving this view.</p>
  </form>`;
};
