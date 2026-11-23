/** Observations from one captured, cleaned DOM, not claims about unseen frames or later states. */
export interface BrowserExtractionTargets {
  source: 'captured_dom';
  scope: 'page' | 'element';
  source_complete: boolean;
  tables_complete: boolean;
  tables: Array<{ step?: { do: 'table'; ref?: string; selector?: string }; label?: string; label_truncated?: true;
    headers?: string[]; columns?: string[]; columns_complete?: boolean }>;
  files?: Array<{ step: { do: 'download'; ref: string }; label?: string; label_truncated?: true }>;
  files_truncated?: true;
  /** The existing collection_hint supplies the checked field selectors, without repeating its plan. */
  collection?: { items: string; fields: string[]; rows_in_snapshot: number };
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(k => allowed.includes(k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
export const isBrowserExtractionTargets = (v: unknown): v is BrowserExtractionTargets => object(v)
  && keys(v, ['source', 'scope', 'source_complete', 'tables_complete', 'tables', 'collection', 'files', 'files_truncated']) && v.source === 'captured_dom'
  && ['page', 'element'].includes(String(v.scope)) && typeof v.source_complete === 'boolean' && typeof v.tables_complete === 'boolean'
  && Array.isArray(v.tables) && v.tables.length <= 3 && v.tables.every(table => object(table) && keys(table, ['step', 'label', 'label_truncated', 'headers', 'columns', 'columns_complete'])
    && (table.label === undefined || text(table.label, 80)) && (table.label_truncated === undefined || table.label_truncated === true && table.label !== undefined)
    && (table.step === undefined || object(table.step) && keys(table.step, ['do', 'ref', 'selector']) && table.step.do === 'table'
      && (table.step.ref === undefined || typeof table.step.ref === 'string' && /^e[1-9]\d{0,8}$/.test(table.step.ref))
      && (table.step.selector === undefined || text(table.step.selector, 1_000))
      && !(table.step.ref !== undefined && table.step.selector !== undefined))
    && ['headers', 'columns'].every(key => table[key] === undefined || Array.isArray(table[key]) && (table[key] as unknown[]).length <= 8
      && (table[key] as unknown[]).every(value => typeof value === 'string' && value.length <= 80))
    && (table.columns_complete === undefined || typeof table.columns_complete === 'boolean')
    && (table.columns_complete !== true || v.source_complete === true && Array.isArray(table.columns) && table.columns.length > 0))
  && (v.files === undefined || Array.isArray(v.files) && v.files.length <= 3 && v.files.every(file => object(file)
    && keys(file, ['step', 'label', 'label_truncated']) && object(file.step) && keys(file.step, ['do', 'ref']) && file.step.do === 'download'
    && typeof file.step.ref === 'string' && /^e[1-9]\d{0,8}$/.test(file.step.ref)
    && (file.label === undefined || text(file.label, 80)) && (file.label_truncated === undefined || file.label_truncated === true && typeof file.label === 'string')))
  && (v.files_truncated === undefined || v.files_truncated === true)
  && (v.collection === undefined || object(v.collection) && keys(v.collection, ['items', 'fields', 'rows_in_snapshot'])
    && text(v.collection.items, 1_000) && Array.isArray(v.collection.fields) && v.collection.fields.length <= 4
    && v.collection.fields.every(field => text(field, 40)) && Number.isSafeInteger(v.collection.rows_in_snapshot)
    && Number(v.collection.rows_in_snapshot) >= 3 && Number(v.collection.rows_in_snapshot) <= 50)
  && JSON.stringify(v).length <= 2_000;
