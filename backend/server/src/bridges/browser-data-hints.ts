import type { BrowserDataValue } from './browser-data-store.js';

/** Small, data-shaped affordances. No task prompt, domain interpretation or
 * provider call participates in choosing them. Examples remain unevaluated. */
export const browserDataHint = (saved: BrowserDataValue, requestedSection?: string): Record<string, unknown> => {
  const rows = Array.isArray(saved.value) ? saved.value : [];
  const objects = rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row));
  const hint: Record<string, unknown> = { row_count: saved.descriptor.row_count ?? null,
    source_selection: 'The step queries this exact retained capture in a data-only call. After a fresh read/table/collect in the same call, use source:"latest" instead.',
    operations: ['filter', 'count', 'map', 'sort', 'group_by', 'pluck'],
    step: { do: 'data', source: saved.descriptor.data_ref,
      pipeline: [{ transform: 'slice', start: 0, end: rows.length, id: 'rows' }, { transform: 'count', id: 'count' }], return: ['rows', 'count'] },
    note: 'For exact filtering/counts, keep the matching rows and their count in one pipeline: name the filter result, then count it and return both IDs. The example returns every captured row and its count; scope first when needed. A later source:"latest" after count selects that number, not the rows. map reshapes rows; project takes one object. Format sufficient returned values yourself; coverage still bounds the claim.' };
  const source = saved.descriptor.sources.length === 1 ? saved.descriptor.sources[0] : undefined;
  const coverage = source?.coverage;
  // Only an original semantic-entry capture has this meaning. Derived empty
  // arrays can legitimately need counting even when their source was entries.
  if (!saved.descriptor.derived_from?.length && source?.kind === 'read' && coverage && typeof coverage === 'object'
    && !Array.isArray(coverage) && 'representation' in coverage && coverage.representation === 'entries') {
    hint.representation = 'semantic_entries';
    const sections = [...new Set(objects.map(row => row.section).filter((section): section is string => typeof section === 'string' && section.length > 0))];
    hint.sections = sections.filter(section => section.length <= 100).slice(0, 32);
    hint.sections_complete_for_capture = (hint.sections as string[]).length === sections.length;
    if (Array.isArray(saved.value) && saved.value.length === 0) {
      delete hint.step;
      delete hint.operations;
      hint.note = 'No semantic list items or definition terms were extracted in this capture scope. Zero semantic entries does not mean no prose, no page content or no CSS matches. Keep the original scope and source completeness. Use returned outline/text when sufficient; otherwise read prose or collect observed repeated-record fields.';
    }
  }
  if (saved.descriptor.sources.some(source => source.kind === 'read')
    && saved.descriptor.fields.some(field => field.field === 'line') && saved.descriptor.fields.some(field => field.field === 'level')) {
    hint.representation = 'page_lines';
    delete hint.step;
    delete hint.operations;
    hint.note = 'Captured text lines, not table rows or list entries. Read values directly when sufficient. For a visible table use Read a table or Act table; avoid splitting flattened text into cells. For list/definition counts use entry_data.data_ref or read with data_format:"entries", then scope by section/kind. form remains outline or text. Source completeness still applies.';
  }
  if (saved.descriptor.sources.some(source => source.kind === 'table')) {
    hint.representation = 'table_rows';
    hint.note = 'One structured table snapshot. Header rows are already excluded; never filter them out again. Cells preserve displayed strings, including currency and URL schemes. Use exact data_columns field names. Return rows directly when sufficient; use data for requested filtering/sorting/computation and format the final JSON yourself. Other table reads are separate; source completeness still bounds the result.';
    const fields = saved.descriptor.fields.map(field => field.field).filter(field => field.length > 0).slice(0, 12);
    if (fields.length) hint.select_step = { do: 'data', source: saved.descriptor.data_ref,
      pipeline: [{ transform: 'slice', start: 0, end: 20 }], select: fields };
  }
  if (objects.some(row => row.kind === 'definition_term')) {
    hint.kinds = [...new Set(objects.map(row => row.kind).filter(kind => typeof kind === 'string'))];
    if (hint.sections === undefined) hint.sections = [...new Set(objects.map(row => row.section).filter(section => typeof section === 'string' && section))].slice(0, 8);
    const sections = [...new Set(objects.map(row => row.section).filter((section): section is string => typeof section === 'string'))];
    const exact = typeof requestedSection === 'string' ? sections.filter(section => section.toLocaleLowerCase() === requestedSection.trim().toLocaleLowerCase()) : [];
    const selected = exact.length === 1 ? exact[0] : undefined;
    if (selected !== undefined) hint.requested_section = selected;
    hint.step = { do: 'data', source: saved.descriptor.data_ref, pipeline: [
      ...(selected !== undefined ? [{ transform: 'filter', field: 'section', operator: 'equal', value: selected }] : []),
      { transform: 'filter', field: 'kind', operator: 'equal', value: 'definition_term' },
      { transform: 'group_by', field: 'group', aggregate: { count: { operator: 'count' }, last: { operator: 'last', field: 'text' } } }] };
    hint.note = 'Observed definition/list entries, one per row; text excludes nested lists and form values. Filter section/kind to the requested scope. group encodes heading_path, keeping repeated headings separate. Use existing headings to group instead of parsing a code from text. Example counts all captured definition terms and returns their last listed text per group. first/last preserve input order, not numeric extrema; omit field to return the whole entry. source_complete still bounds the claim.';
    if (selected !== undefined) hint.note = 'This example filters the exact observed requested section before grouping captured definition terms. It uses retained entries beyond the displayed excerpt when source_complete permits. first/last preserve input order; last is the displayed entry text. Other sections are excluded; source_complete still bounds every claim.';
  }
  // Offer currency normalization only for a uniform, unambiguous observed
  // prefix+decimal format. Locale/thousands separators are never guessed.
  if (objects.length >= 2 && objects.length === rows.length) for (const { field } of saved.descriptor.fields) {
    const values = objects.map(row => row[field]);
    if (!values.every(value => typeof value === 'string' && /^[£$€]\d+(?:\.\d{1,2})?$/.test(value))) continue;
    const prefix = (values[0] as string)[0]!;
    if (!values.every(value => (value as string)[0] === prefix)) continue;
    let output = 'numeric_value'; while (objects.some(row => Object.hasOwn(row, output))) output += '_';
    hint.numeric_field = { field, format: 'observed currency prefix and decimal point', prefix };
    hint.numeric_step = { do: 'data', source: saved.descriptor.data_ref, pipeline: [
      { transform: 'map', apply: 'to_number', field, output_field: output, format: { style: 'currency', unit: prefix, decimal: '.' } },
      { transform: 'min_by', field: output, value_type: 'number' }] };
    break;
  }
  return hint;
};
