import { BROWSER_DATA_REF, BROWSER_COLLECT_MAX_PAGES, BROWSER_COLLECT_MAX_ITEMS, isBrowserExtractionTargets, parseBrowserActSteps, readBrowserFailure } from '@recued/contracts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const handle = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/^https?:/i.test(value);
const dataRef = (value: unknown): value is string => typeof value === 'string' && BROWSER_DATA_REF.test(value);
const validExample = (value: unknown): boolean => parseBrowserActSteps(Array.isArray(value) ? value : [value]).ok;

// A table returns rows, not a computed `value`. Describe their availability
// without copying cells or claiming that several page captures are one set.
const returnedTables = (views: Array<{ read: Record<string, unknown> }>) => {
  return views.flatMap(({ read }) => {
    const table = object(read.table) ? read.table : read;
    if (!dataRef(table.data_ref) || !Array.isArray(table.rows)
      || !Array.isArray(table.data_columns) || typeof table.data_source_complete !== 'boolean'
      || table.value_omitted === true) return [];
    const columns = table.data_columns.every(column => object(column) && typeof column.field === 'string'
      && column.field.length > 0 && column.field.length <= 160)
      ? table.data_columns.map(column => (column as { field: string }).field) : [];
    return [{ data_ref: table.data_ref, rows: table.rows.length, complete: table.data_source_complete,
      ...(Number.isSafeInteger(read.step) ? { step: read.step } : {}), columns }];
  });
};

/** Offers existing read-only capabilities at the observation that justifies them.
 * Never searches captured strings, user data values or another recipe's output.
 * Examples are not executed, corrected automatically or granted new authority. */
export const browserAgentGuidance = (result: Record<string, unknown>): Record<string, unknown> | undefined => {
  const options: Record<string, unknown>[] = [];
  const guide: Record<string, unknown> = { tool: 'recued-core/act-on-web-page', options,
    note: 'When all requested actions and verification are complete and returned facts have sufficient coverage, format the final answer yourself. More calls are for unfinished actions, missing evidence or needed computation. Data-only examples use exact snapshots; latest means the latest capture/result in this call, including scalar counts. Check coverage; pages do not merge. Existing permissions apply.' };
  const add = (kind: string, when: string, example: unknown, facts: Record<string, unknown> = {}) => {
    if (options.length >= 3 || options.some(option => option.kind === kind) || !validExample(example)) return;
    const option = { kind, when, ...(Array.isArray(example) ? { steps: example } : { step: example }), ...facts };
    options.push(option);
    if (JSON.stringify(guide).length > 1_800) options.pop();
  };
  const reuse = (value: Record<string, unknown>) => {
    if (value.kind !== 'array' || !dataRef(value.data_ref) || typeof value.source_complete !== 'boolean') return;
    const fields = Array.isArray(value.fields) ? value.fields.filter(object).flatMap(field => typeof field.field === 'string' ? [field.field] : []) : [];
    add('reuse_data', 'Use already captured rows after a failure or omitted output; adjust this bounded preview for the requested filter/calculation.',
      { do: 'data', source: value.data_ref, pipeline: [{ transform: 'slice', start: 0, end: 20 }] },
      { source_complete: value.source_complete, ...(Number.isSafeInteger(value.row_count) ? { captured_rows: value.row_count } : {}),
        ...(fields.length ? { fields: fields.slice(0, 6) } : {}) });
  };
  if (result.recipe_id === 'act-on-web-page' && result.success === false && Array.isArray(result.errors)) {
    for (const error of result.errors) {
      if (!object(error) || !object(error.source) || error.source.ingredient_slug !== 'dom-act') continue;
      const failure = readBrowserFailure({ code: error.code, browser_failure: { slug: 'dom-act', details: error.details } });
      if (!failure) continue;
      const diagnostic = failure.details.data_failure;
      if (diagnostic?.numeric) guide.numeric_failure = diagnostic.numeric;
      if (diagnostic?.source_issues) guide.source_issues = diagnostic.source_issues.slice(0, 1).map(({ read_step: _read, restart_url: _url, ...issue }) => issue);
      if (diagnostic?.repair_step) add('data_repair',
        'The input is an array: project accepts one object; map reshapes each row. This checked suggestion preserves the original source and other operations. Review it; do not repeat the rejected plan.',
        diagnostic.repair_step, { input_kind: diagnostic.input_kind });
      if (diagnostic) add('data_schema', 'The data operation failed. Read its schema, then correct the reported parameter/expression using actual keys. Keep the original source and valid earlier operations.',
        diagnostic.schema_step, { source_ref: diagnostic.source_ref, operation: diagnostic.operation,
          input_kind: diagnostic.input_kind, input_fields: diagnostic.input_fields.slice(0, 6).map(field => field.name) });
      if (failure.details.data_schema_step) add('data_schema', 'This data plan was refused before any step ran. Read these schemas before rewriting it; use exact field/select keys or quoted item["Column Name"] paths.',
        failure.details.data_schema_step);
      const completed = failure.details.completed_data ?? [];
      if (completed.some(saved => saved.value_omitted === false)) guide.result_use = {
        completed_values_returned: true,
        note: 'Small whole values from completed earlier steps are in completed_data.value. Use them if sufficient; the batch still failed and each value retains its own source coverage. Never replay completed browser actions just to recover these values.' };
      for (const saved of [...completed].reverse()) if (saved.value_omitted) reuse(saved as unknown as Record<string, unknown>);
    }
  }
  if (result.success === true && object(result.output) && Array.isArray(result.output.render)) {
    const roots = result.output.render.filter(object).filter(item => item.type === 'json').map(item => item.data).filter(object);
    const views: Array<{ read: Record<string, unknown>; page: unknown }> = result.recipe_id === 'act-on-web-page' ? roots.flatMap(root => [
      ...(Array.isArray(root.tabs) ? root.tabs.filter(object).flatMap(tab => Array.isArray(tab.reads) ? tab.reads.filter(object).map(read => ({ read, page: tab.page })) : []) : []),
      ...(Array.isArray(root.data) ? root.data.filter(object).map(data => ({ read: { data }, page: undefined })) : []),
    ])
      : roots.map(read => ({ read, page: read.page }));
    const latest = views.at(-1);
    if (latest) {
      const { read } = latest;
      const value = object(read.table) ? read.table : object(read.collection) ? read.collection : object(read.data) ? read.data : read;
      const page = handle(value.page) ? value.page : handle(latest.page) ? latest.page : undefined;
      if (Array.isArray(value.rows) && Array.isArray(value.data_columns)) {
        const tables = returnedTables(views), shown = tables.slice(0, 4);
        if (shown.length) guide.note = 'Data-only examples use these exact snapshots; review before use. They do not execute, merge pages or grant permission. Existing action and verification requirements still apply.';
        if (shown.length) guide.result_use = { table_rows_returned: true,
          table_snapshots: shown.map(({ columns: _columns, ...facts }) => facts),
          ...(tables.length > shown.length ? { snapshots_omitted: tables.length - shown.length } : {}),
          note: 'Rows already appear in the returned table reads. These are separate snapshots; completeness applies to each capture, not all pages or distinct records. When requested actions and verification are complete and these rows supply the facts, format the answer directly. Computation is optional; do not replay browser actions for formatting.' };
        if (tables.length >= 2 && tables.length <= 4 && tables[0]!.columns.length
          && new Set(tables.map(table => table.data_ref)).size === tables.length
          && tables.every(table => JSON.stringify(table.columns) === JSON.stringify(tables[0]!.columns))) {
          add('combine_tables', 'Only if computation needs these separate snapshots together: concatenate them explicitly, then append requested operations. IDs stay inside this one pipeline.',
            { do: 'data', source: tables[0]!.data_ref,
              pipeline: tables.slice(1).map(table => ({ transform: 'table.concat', other: { data_ref: table.data_ref }, schema: 'strict' })) });
        }
      }
      if (dataRef(value.data_ref) && Object.hasOwn(value, 'value') && value.value_omitted !== true && typeof value.source_complete === 'boolean') {
        const empty = Array.isArray(value.value) && value.value.length === 0;
        const scalar = value.value === null || ['number', 'boolean', 'string'].includes(typeof value.value);
        const scalarFields = object(value.value) && Object.keys(value.value).length > 0
          && Object.values(value.value).every(field => field === null || ['number', 'boolean', 'string'].includes(typeof field));
        const scalarOnly = scalar || scalarFields;
        guide.result_use = { value_returned: true, source_complete: value.source_complete,
          ...(empty ? { result_kind: 'empty_array', item_facts_returned: false } : scalarOnly ? { result_kind: scalar ? 'scalar' : 'scalar_fields', record_rows_returned: false } : {}),
          note: empty ? 'This query returned no items. It supplies no item title, value or last-item fact. It may answer an absence question only when the predicate and scope match that question. For a requested item fact, obtain supporting records before answering; do not substitute unrelated page content. source_complete describes the capture, not whether the predicate selected the intended records.'
            : scalarOnly ? 'Only the returned scalar value or named fields are available, with no accompanying records or unreturned fields. Answer directly when this value and earlier returned evidence satisfy the request. For missing names, titles or other record fields, query retained input_source in a data-only call, preserving the requested filter and projection. Do not infer those facts or replay collection with a page handle from before pagination. Source coverage still applies.'
            : 'The computed value is already returned. If all requested actions and verification are complete and it supplies the requested facts, produce the requested JSON/text directly, including field names and simple presentation edits. Do not run a formatting pipeline just to match the answer shape. Incomplete source coverage still needs resolution.' };
        if (object(value.input_source) && (empty || scalarOnly) && value.input_source.kind === 'array' && dataRef(value.input_source.data_ref)) add('inspect_query_source',
          'Only if record facts are missing: query this retained input with the requested filter/projection. This bounded preview is an example, not a replacement query or coverage proof. No browser action is replayed.',
          { do: 'data', source: value.input_source.data_ref, pipeline: [{ transform: 'slice', start: 0, end: 10 }] });
      }
      if (value.value_omitted === true) reuse(value);
      const targets = read.extraction_targets;
      if (isBrowserExtractionTargets(targets)) {
        guide.observed = { tables: targets.tables.length, tables_complete: targets.tables_complete,
          ...(targets.collection ? { repeated_rows: targets.collection.rows_in_snapshot } : {}) };
        for (const file of targets.files ?? []) if (page) add('save_file', 'Download the requested observed link. Saving alone needs its filename/size receipt. When contents are requested, pass the saved file_ref to document.read; reuse an automatic read already returned. A click alone does not prove saving.',
          { ...file.step, page }, file.label ? { example_label: file.label } : {});
        const table = targets.tables.find(table => table.step);
        if (page && table?.step) add('table', 'For cells in an observed table/grid, capture its structured rows directly.', { ...table.step, page },
          table.columns ? { columns: table.columns, columns_complete: table.columns_complete } : {});
        // The existing hint is checked on the captured DOM. Do not invent card
        // selectors from prose, or offer a table-shaped collection over a table.
        const collection = read.collection_hint;
        if (!table && targets.collection && object(collection) && object(collection.step)
          && collection.step.do === 'collect' && collection.step.items === targets.collection.items && collection.step.max_pages === 1 && page) {
          add('collect', `Use these checked fields for repeated records. Set max_pages to the requested scope (1–${BROWSER_COLLECT_MAX_PAGES}) and check coverage. For exact text or array membership, where:{field,equals} returns matching records and their count in this step. Add data for further computation.`,
            { ...collection.step, ...(object(collection.step.next) ? { max_pages: BROWSER_COLLECT_MAX_PAGES, max_items: BROWSER_COLLECT_MAX_ITEMS } : {}), page });
        }
      }
      const entries = object(read.entry_data) ? read.entry_data : read.data_format === 'entries' ? read : undefined;
      const captured = entries ?? value;
      const hint = captured.data_hint;
      const sourceComplete = typeof captured.data_source_complete === 'boolean' ? captured.data_source_complete : captured.source_complete;
      if (dataRef(captured.data_ref) && typeof sourceComplete === 'boolean' && object(hint)) {
        const facts = { source_complete: sourceComplete,
          ...(entries && Array.isArray(hint.sections) ? { sections: hint.sections.filter((section): section is string => typeof section === 'string' && section.length <= 100).slice(0, 4) } : {}) };
        if (entries && hint.representation === 'semantic_entries' && hint.row_count === 0) {
          guide.empty_entries = { data_ref: captured.data_ref, captured_rows: 0, source_complete: sourceComplete,
            scope: ['captured_element_entries', 'captured_entries'].includes(String(captured.data_scope)) ? captured.data_scope : 'unknown',
            note: 'No semantic list items or definition terms were extracted in this scope. This does not establish absence of prose, page content or other CSS matches. Use returned outline/text when sufficient; otherwise choose a prose read. Source completeness still applies.' };
          if (page) add('read_prose', 'If the requested facts are missing, read the current page as text. This optional page-wide read does not repeat actions or imply that its result will be complete.',
            { do: 'read', page, form: 'text' });
        } else {
          if (object(hint.select_step) && hint.select_step.source === captured.data_ref) add('select_columns',
            'Select these exact column names without rebuilding rows. select belongs on the data step, not in pipeline. Keys with spaces are exact names. This example previews up to 20 rows.', hint.select_step, facts);
          if (object(hint.numeric_step) && hint.numeric_step.source === captured.data_ref) add('numeric_data',
            'For a requested numeric minimum, this example normalizes the observed currency field and selects its minimum; adjust only as the request requires.', hint.numeric_step, facts);
          if (object(hint.step) && hint.step.source === captured.data_ref) add(entries ? 'entries' : 'data',
            entries ? 'For exact list/definition counts or last entries, query captured records; filter the requested section/kind before grouping. Source coverage bounds the answer.'
              : 'When both rows and a count are needed, return them together. Name the matching rows, then count and return both IDs. This example uses every captured row; add the requested filter first. A later latest source after count is a number.',
            entries && sourceComplete === false && page
              ? [{ do: 'read', page, data_format: 'entries' }, { ...hint.step, source: 'latest' }] : hint.step, facts);
        }
      }
    }
  }
  // Adding observed facts after an option must not bypass the shared budget.
  while (options.length && JSON.stringify(guide).length > 1_800) options.pop();
  return (options.length || guide.result_use || guide.empty_entries) && JSON.stringify(guide).length <= 1_800 ? guide : undefined;
};
