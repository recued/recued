/** Browser transport fixture for the Records entry point. CSV interpretation,
 * dry-run rollback and duplicate identity use the existing real-store tests. */
import type { RecordsNamespaceView, ServerRecipeListEntry, SpreadsheetImportDeclaration } from '@recued/contracts';

/** The bank-statement import as a current server lists it: the recipe without its steps, and the
 * `spreadsheet_import` the server works out from them (`recipe-list-handler.ts`). Written out
 * rather than read from `community/`: this folder ships with the public repo, which does not
 * carry the statement-import pack. `d-292-spreadsheet-import-declaration.test.ts` checks the
 * shipped recipe itself. */
const declaration: SpreadsheetImportDeclaration = {
  file: 'file', preview: 'check_first', delimiter: 'delimiter',
  columns: ['column_date', 'column_description', 'column_amount', 'column_debit', 'column_credit', 'column_balance'],
  conflicts: 'keep_mine', formats: ['decimal_mark', 'date_format'],
};
const bankRecipe = {
  recipe_id: 'import-bank-statement', chat_exposed: false, version: 8, ttl: 0,
  metadata: { name: 'Import a bank statement (CSV)', description: 'Records the lines of a bank statement CSV.',
    author: 'recued-core', supported_platforms: [],
    recipe_bundle: 'recued-core/statement-import', spreadsheet_import: declaration,
    retired_variables: ['thousands_separator'],
    retired_carries: [{ variable: 'thousands_separator', when: '.', set: { decimal_mark: 'Comma: 1.234,56' } }] },
  depends_on: ['recued-core.statement-import'],
  variables: {
    file: { label: 'Statement CSV exported from your bank', type: 'file_ref' },
    account_label: { label: 'Which account is this? (e.g. “barclays-current”)', type: 'string', default: '' },
    currency: { label: 'Currency', type: 'string', default: 'GBP' },
    delimiter: { label: 'CSV delimiter', type: 'string', default: ',' },
    column_date: { label: 'Column holding the date', type: 'string', default: 'Date' },
    column_description: { label: 'Column holding the description', type: 'string', default: 'Description' },
    column_amount: { label: 'Column holding one signed amount — only when your bank uses a single amount column', type: 'string', optional: true, default: 'Amount' },
    column_debit: { label: 'Column holding money out — only when your bank splits money in and out', type: 'string', optional: true, default: '' },
    column_credit: { label: 'Column holding money in — only when your bank splits money in and out', type: 'string', optional: true, default: '' },
    column_balance: { label: 'Column holding the running balance', type: 'string', optional: true, default: '' },
    decimal_mark: { label: 'Decimal mark used in the amounts', type: 'enum', options: ['Point: 1,234.56', 'Comma: 1.234,56'], default: 'Point: 1,234.56' },
    date_format: { label: 'Date format in your file', type: 'string', optional: true, default: '' },
    keep_mine: { label: 'When a line is already recorded with different details, keep what I already have', type: 'boolean', default: true },
    check_first: { label: 'Check first, record nothing (recommended the first time you map a bank)', type: 'boolean', default: false },
  },
  requires: [],
  output: { render: [] },
};

const CSV = 'Date,Description,Amount\n2026-10-01,Coffee,-3.50\n';
const entry: ServerRecipeListEntry = {
  recipe_id: bankRecipe.recipe_id, publisher_id: 'recued-core', recipe_hash: 'bank-import-hash',
  version: bankRecipe.version, recipe: bankRecipe as ServerRecipeListEntry['recipe'], source: 'bundled', installed_at: 1,
  spreadsheet_import: declaration,
};

export const recordsImportReply = (method: string, raw: unknown): { result?: unknown; error?: { code: string; message: string } } | null => {
  if (new URLSearchParams(location.search).get('records_import') !== '1') return null;
  const args = (raw ?? {}) as Record<string, unknown>;
  const imported = sessionStorage.getItem('recued-test-records-imported') === '1';
  const namespace: RecordsNamespaceView = {
    owner: { publisher: 'recued-core', pack_slug: 'statement-import' }, display_name: 'Statement import',
    state: { state: 'ready', version: 1, storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64) },
    activation_generation: 1, state_generation: 1,
    quota: { row_count: imported ? 1 : 0, payload_bytes: 0, row_limit: 1000, byte_limit: 1000000,
      outbox_count: 0, outbox_limit: 1000, data_generation: imported ? 2 : 1 },
    schema: { decimal_scale: 4, entities: { line: { kind: 'line', fields: [
      { key: 'id', slot: 'pk', kind: 'id', required: true },
      { key: 'description', slot: 's1', kind: 'string', required: true },
      { key: 'amount', slot: 'n1', kind: 'number', required: false },
    ] } } },
    artifact_digest: 'fixture', subscriber_digest: 'fixture', updated_at: 1,
  };
  if (method === 'records.namespace.list' && imported && sessionStorage.getItem('recued-test-records-import-refresh-failure') === '1') {
    return { error: { code: 'UNAVAILABLE', message: 'Records refresh is temporarily unavailable' } };
  }
  if (method === 'records.namespace.list') return { result: { namespaces: [namespace,
    { ...namespace, owner: { ...namespace.owner, publisher: 'other-publisher' }, display_name: 'Other statement pack' }], global_quota: null } };
  if (method === 'records.kind.list') return { result: { kinds: [{ kind: 'line', rows: imported ? 1 : 0, payload_bytes: 0 }] } };
  if (method === 'records.retention.list') return { result: { policies: {} } };
  if (method === 'records.outbox.list') return { result: { pending: 0, delivered: 0, dead_letter: 0, total_retries: 0,
    oldest_pending_at: null, oldest_pending_age_ms: null, events: [] } };
  if (method === 'records.changes.list') return { result: { changes: [], has_more: false } };
  if (method === 'records.search') return { result: { records: imported && (args.owner as { publisher?: string })?.publisher === 'recued-core'
    ? [{ id: 'imported-line', description: 'Coffee', amount: -3.5,
      _record: { entity: 'line', version: 1, revision: 1, created_at: 1, updated_at: 1 } }] : [] } };
  if (method === 'recipe.list') return { result: { recipes: [entry,
    { ...entry, recipe_id: 'unrelated-import', publisher_id: 'other-publisher' }] satisfies ServerRecipeListEntry[] } };
  if (method === 'dishes.list') return { result: { dishes: JSON.parse(sessionStorage.getItem('recued-test-records-import-dishes') ?? '[]') } };
  if (method === 'dishes.create') {
    const dish = { ...args, dish_id: 'remembered-import', is_default: true };
    sessionStorage.setItem('recued-test-records-import-dishes', JSON.stringify([dish]));
    return { result: { dish } };
  }
  if (method === 'data.mirror.search' && args.kind === 'files') return { result: {
    results: [{ entity_id: 'file:file:statement', label: 'Statement.csv' }], total: 1,
  } };
  if (method === 'data.file.read' && args.record_id === 'file:statement') return { result: {
    bytes_b64: btoa(CSV), filename: 'Statement.csv', size_bytes: CSV.length,
  } };
  if (method === 'execute' && args.recipe_id === bankRecipe.recipe_id) {
    const calls = JSON.parse(sessionStorage.getItem('recued-test-records-import-runs') ?? '[]');
    calls.push(args); sessionStorage.setItem('recued-test-records-import-runs', JSON.stringify(calls));
    const preview = (args.config as Record<string, unknown>).check_first === true;
    if (!preview) sessionStorage.setItem('recued-test-records-imported', '1');
    return { result: { recipe_id: bankRecipe.recipe_id, recipe_hash: entry.recipe_hash, success: true,
      output: { render: [{ type: 'summary', source: 'step.card', data: { fields: [
        { label: 'What happened', value: preview ? 'Check only — nothing recorded' : 'Import finished' },
        { label: 'Lines in this file', value: 1 }, { label: preview ? 'Would record' : 'Recorded', value: imported ? 0 : 1 },
        { label: 'Already had', value: imported ? 1 : 0 }, { label: 'Refused', value: 0 },
      ] } }], sidebar: [] }, steps: [], errors: [], duration_ms: 1,
    } };
  }
  return null;
};
