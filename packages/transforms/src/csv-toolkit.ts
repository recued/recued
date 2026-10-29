import { decimal, compare, plus, format, average, type Decimal } from './csv-decimal.js';
import { compileCsvExpression } from './csv-expressions.js';
import { CSV_TOOLKIT_LIMITS as LIMITS, type CsvTransformInput, type CsvTableSummary, type CsvAggregation } from '@recued/contracts';
import { csv_parse } from './object.js';

export interface CsvTable { columns: string[]; rows: string[][] }
export interface CsvTableOperationResult { table: CsvTable; counts: Record<string, number>; notes: string[] }
const fail = (message: string): never => { throw new Error(`CSV Toolkit: ${message}`); };
const checkColumns = (columns: string[]): void => {
  if (!columns.length || columns.length > LIMITS.columns) fail(`output must have 1 to ${LIMITS.columns} columns`);
  if (columns.some(c => !c.trim() || c.length > 512 || c.includes('\0'))) fail('column names must be nonempty and at most 512 characters');
  if (new Set(columns).size !== columns.length) fail('duplicate column names; rename them before processing');
  if (JSON.stringify(columns).length > 8192) fail('column names exceed the 8192-character metadata limit');
};

/** Uses the existing CSV parser, opting into strict syntax and bounded allocation. */
export const parseCsvTable = (text: string, delimiter: string): CsvTable => {
  if (text.includes('\0')) fail('NUL bytes are not supported in CSV');
  const raw = csv_parse({ input: text, delimiter, has_header: false, strict: true,
    max_rows: LIMITS.rows + 1, max_columns: LIMITS.columns,
    max_cells: LIMITS.cells + LIMITS.columns, max_cell_chars: LIMITS.cell_chars }, {} as never) as string[][];
  const columns = raw.shift();
  if (!columns) return fail('the file has no header row');
  checkColumns(columns);
  if (raw.length * columns.length > LIMITS.cells) fail('input exceeds the cell limit');
  for (let i = 0; i < raw.length; i++) {
    if (raw[i]!.length !== columns.length) fail(`data row ${i + 1} has ${raw[i]!.length} cells; expected ${columns.length}`);
  }
  return { columns, rows: raw };
};

export const summarizeCsvTable = (table: CsvTable, previewRows = 5): CsvTableSummary => {
  const preview: string[][] = [];
  for (const row of table.rows.slice(0, previewRows)) {
    // Never truncate an individual value and present it as a complete cell.
    if (JSON.stringify([...preview, row]).length > LIMITS.preview_chars) break;
    preview.push(row);
  }
  return { columns: table.columns, rows: table.rows.length, preview, preview_truncated: preview.length < table.rows.length };
};

/** A quoted empty field survives a one-column round trip. A literal BOM stays
 * inside quotes so the next reader cannot mistake it for an encoding marker. */
const encodeCsvRow = (row: string[]): string => row.map(c => c === '' || c.startsWith('\ufeff') || /[",\r\n]/u.test(c)
  ? `"${c.replaceAll('"', '""')}"` : c).join(',') + '\n';
const checkOutputBytes = (bytes: number): void => {
  if (bytes > LIMITS.bytes) fail('output exceeds the 32 MiB file limit; select fewer rows or columns');
};

/** Bound while encoding, before joining chunks. */
export const serializeCsvTable = (table: CsvTable): string => {
  const chunks: string[] = []; let bytes = 0;
  const encode = new TextEncoder();
  for (const row of [table.columns, ...table.rows]) {
    const line = encodeCsvRow(row);
    bytes += encode.encode(line).byteLength;
    checkOutputBytes(bytes);
    chunks.push(line);
  }
  return chunks.join('');
};

const positions = (table: CsvTable, names: string[]): number[] => names.map(name => {
  const index = table.columns.indexOf(name);
  return index < 0 ? fail(`column ${JSON.stringify(name)} does not exist`) : index;
});
const output = (columns: string[]) => {
  checkColumns(columns);
  const encode = new TextEncoder();
  let bytes = encode.encode(encodeCsvRow(columns)).byteLength;
  const rows: string[][] = [];
  return { table: { columns, rows }, push(row: string[]) {
    if (rows.length >= LIMITS.rows || (rows.length + 1) * columns.length > LIMITS.cells) fail('output row/cell limit exceeded; narrow the inputs or matching rule');
    // Mapping can expand small inputs into large, newly allocated strings. Stop
    // while accumulating rows, before materializing an oversized result table.
    bytes += encode.encode(encodeCsvRow(row)).byteLength;
    checkOutputBytes(bytes);
    rows.push(row);
  } };
};
const keyOf = (row: string[], indices: number[]): string | null => {
  const parts = indices.map(i => row[i]!);
  return parts.some(p => !p.trim()) ? null : JSON.stringify(parts);
};
const indexRows = (table: CsvTable, indices: number[], unique: boolean, label: string, requireKey = false): Map<string, number[]> => {
  const index = new Map<string, number[]>();
  table.rows.forEach((row, i) => {
    const key = keyOf(row, indices);
    if (key === null) { if (requireKey) fail(`${label} data row ${i + 1} has an empty key`); return; }
    const prior = index.get(key);
    if (prior && unique) fail(`${label} has duplicate keys; choose all matches for a join or deduplicate the input`);
    if (prior) prior.push(i); else index.set(key, [i]);
  });
  return index;
};

export const operateCsvTable = (left: CsvTable, input: CsvTransformInput, right?: CsvTable): CsvTableOperationResult => {
  const counts: Record<string, number> = { input_rows: left.rows.length, ...(right ? { other_rows: right.rows.length } : {}) };
  const notes: string[] = [];
  const pair = (): CsvTable => right ?? fail('this operation needs a second CSV');
  switch (input.operation) {
    case 'map': {
      const columns = [...left.columns, ...input.mappings.map(m => m.as).filter(name => !left.columns.includes(name))];
      const out = output(columns);
      const mappings = input.mappings.map(m => ({ index: columns.indexOf(m.as), name: m.as,
        evaluate: compileCsvExpression(m.expression, left.columns, input.empty_numeric) }));
      left.rows.forEach((row, rowIndex) => {
        const next = [...row, ...Array(columns.length - row.length).fill('')];
        for (const mapping of mappings) {
          try { next[mapping.index] = mapping.evaluate(row); }
          catch (error) { fail(`mapping ${JSON.stringify(mapping.name)}, data row ${rowIndex + 1}: ${error instanceof Error ? error.message : String(error)}`); }
        }
        out.push(next);
      });
      counts.mapped_rows = left.rows.length; counts.mapped_columns = mappings.length;
      notes.push('Each expression reads the original row. Existing named columns are replaced in the new file; new columns are appended.');
      return { table: out.table, counts, notes };
    }
    case 'sort': {
      const keys = input.by.map(k => ({ ...k, index: positions(left, [k.column])[0]! }));
      // Validate/parse every row before sorting or limiting, even if limit is zero.
      const values = left.rows.map((row, rowIndex) => keys.map(k => {
        const value = row[k.index]!, empty = k.comparison === 'decimal' ? !value.trim() : value === '';
        if (empty) {
          if (k.empty === 'error') fail(`empty sort value for ${k.column}, data row ${rowIndex + 1}`);
          return null;
        }
        return k.comparison === 'decimal' ? decimal(value, `sort column ${k.column}, data row ${rowIndex + 1}`) : value;
      }));
      const order = left.rows.map((_, i) => i).sort((a, b) => {
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i]!, x = values[a]![i]!, y = values[b]![i]!;
          if (x === null || y === null) {
            if (x === y) continue;
            return (x === null ? -1 : 1) * (k.empty === 'first' ? 1 : -1);
          }
          const result = typeof x === 'string' && typeof y === 'string' ? (x < y ? -1 : x > y ? 1 : 0)
            : compare(x as Decimal, y as Decimal);
          if (result) return result * (k.direction === 'asc' ? 1 : -1);
        }
        return a - b;
      });
      const out = output(left.columns);
      for (const index of order.slice(input.offset, input.offset + input.limit)) out.push(left.rows[index]!);
      counts.returned = out.table.rows.length; counts.excluded = left.rows.length - counts.returned;
      notes.push('Sort ties preserve source order. Empty placement is independent of ascending/descending direction.');
      return { table: out.table, counts, notes };
    }
    case 'deduplicate': {
      const indices = positions(left, input.keys.length ? input.keys : left.columns);
      const groups = new Map<string, { first: number; last: number; count: number; conflict: boolean }>();
      const kept = new Set<number>(); let emptyKeys = 0;
      left.rows.forEach((row, i) => {
        const parts = indices.map(index => row[index]!);
        const emptyKey = input.keys.length > 0 && parts.some(value => !value.trim());
        if (emptyKey && input.empty_keys === 'error') fail(`data row ${i + 1} has an empty deduplication key`);
        if (emptyKey && input.empty_keys === 'keep') { kept.add(i); emptyKeys++; return; }
        const key = JSON.stringify(parts), group = groups.get(key);
        if (!group) { groups.set(key, { first: i, last: i, count: 1, conflict: false }); return; }
        const conflict = row.some((value, column) => value !== left.rows[group.first]![column]);
        if (conflict && input.keep === 'error') fail('duplicate keys have conflicting rows; choose keep first or last explicitly after ordering the input');
        group.last = i; group.count++; group.conflict ||= conflict;
      });
      let duplicates = 0, conflicts = 0;
      for (const group of groups.values()) {
        kept.add(input.keep === 'last' ? group.last : group.first);
        if (group.count > 1) duplicates++;
        if (group.conflict) conflicts++;
      }
      const out = output(left.columns);
      left.rows.forEach((row, i) => { if (kept.has(i)) out.push(row); });
      counts.removed = left.rows.length - kept.size; counts.duplicate_groups = duplicates;
      counts.conflict_groups = conflicts; counts.empty_keys_kept = emptyKeys;
      notes.push('Surviving rows retain source order. Omitted keys compare complete rows; supplied keys use exact text.');
      return { table: out.table, counts, notes };
    }
    case 'filter': {
      const predicates = input.conditions.map(c => ({ ...c, index: positions(left, [c.column])[0]!,
        number: c.comparison === 'decimal' ? decimal(c.value!, `value for ${c.column}`) : null }));
      const out = output(left.columns);
      left.rows.forEach((row, rowIndex) => {
        // Evaluate every predicate so invalid numeric values cannot hide behind short circuiting.
        const matches = predicates.map(c => {
          const cell = row[c.index]!;
          if (c.operator === 'empty') return cell === '';
          if (c.operator === 'not_empty') return cell !== '';
          if (c.operator === 'contains') return cell.includes(c.value!);
          if (c.operator === 'starts_with') return cell.startsWith(c.value!);
          const order = c.number ? compare(decimal(cell, `data row ${rowIndex + 1}, column ${c.column}`), c.number)
            : cell < c.value! ? -1 : cell > c.value! ? 1 : 0;
          switch (c.operator) {
            case 'eq': return order === 0;
            case 'ne': return order !== 0;
            case 'lt': return order < 0;
            case 'lte': return order <= 0;
            case 'gt': return order > 0;
            case 'gte': return order >= 0;
          }
        });
        if (input.match === 'all' ? matches.every(Boolean) : matches.some(Boolean)) out.push(row);
      });
      counts.matched = out.table.rows.length; counts.excluded = left.rows.length - counts.matched;
      return { table: out.table, counts, notes };
    }
    case 'project': {
      const indices = positions(left, input.columns), out = output(input.names);
      for (const row of left.rows) out.push(indices.map(i => row[i]!));
      return { table: out.table, counts, notes };
    }
    case 'concat': {
      const other = pair();
      if (input.schema === 'strict' && (left.columns.length !== other.columns.length || left.columns.some(c => !other.columns.includes(c)))) fail('concat schemas differ; project/rename first or explicitly choose union');
      const columns = [...left.columns, ...other.columns.filter(c => !left.columns.includes(c))];
      const out = output(columns);
      for (const source of [left, other]) {
        const indices = columns.map(c => source.columns.indexOf(c));
        for (const row of source.rows) out.push(indices.map(i => i < 0 ? '' : row[i]!));
      }
      if (input.schema === 'union') notes.push('Columns absent from an input are filled with empty cells.');
      return { table: out.table, counts, notes };
    }
    case 'join': {
      const other = pair(), li = positions(left, input.left_keys), ri = positions(other, input.right_keys);
      const unique = input.duplicates === 'error';
      indexRows(left, li, unique, 'Left CSV');
      const index = indexRows(other, ri, unique, 'Right CSV');
      const out = output([...left.columns, ...other.columns.map(c => input.right_prefix + c)]);
      const matchedRight = new Set<number>(); let matchedLeft = 0;
      for (const row of left.rows) {
        const key = keyOf(row, li), matches = key === null ? undefined : index.get(key);
        if (matches) {
          matchedLeft++;
          for (const i of matches) { out.push([...row, ...other.rows[i]!]); matchedRight.add(i); }
        } else if (input.join_type !== 'inner') out.push([...row, ...other.columns.map(() => '')]);
      }
      if (input.join_type === 'full') other.rows.forEach((row, i) => {
        if (!matchedRight.has(i)) out.push([...left.columns.map(() => ''), ...row]);
      });
      counts.matched_left = matchedLeft; counts.unmatched_left = left.rows.length - matchedLeft;
      counts.matched_right = matchedRight.size; counts.unmatched_right = other.rows.length - matchedRight.size;
      notes.push('Keys match exact text. Empty or whitespace-only keys never match. Right-hand columns carry the chosen prefix.');
      return { table: out.table, counts, notes };
    }
    case 'diff': {
      const other = pair();
      if (left.columns.length !== other.columns.length || left.columns.some(c => !other.columns.includes(c))) fail('diff schemas differ; project/rename both files to the same columns first');
      const li = positions(left, input.keys), ri = positions(other, input.keys);
      const before = indexRows(left, li, true, 'Before CSV', true), after = indexRows(other, ri, true, 'After CSV', true);
      const columns = input.compare_columns.length ? input.compare_columns : left.columns.filter(c => !input.keys.includes(c));
      const lc = positions(left, columns), rc = positions(other, columns), rightOrder = positions(other, left.columns);
      const out = output(['change', ...left.columns.map(c => 'before_' + c), ...left.columns.map(c => 'after_' + c)]);
      Object.assign(counts, { added: 0, removed: 0, changed: 0, unchanged: 0 });
      const blank = left.columns.map(() => '');
      for (const [key, indices] of before) {
        const row = left.rows[indices[0]!]!, next = after.get(key);
        if (!next) { counts.removed!++; out.push(['removed', ...row, ...blank]); continue; }
        const nextRow = other.rows[next[0]!]!;
        if (lc.some((index, i) => row[index] !== nextRow[rc[i]!])) {
          counts.changed!++; out.push(['changed', ...row, ...rightOrder.map(i => nextRow[i]!)]);
        } else counts.unchanged!++;
      }
      for (const [key, indices] of after) if (!before.has(key)) {
        counts.added!++; out.push(['added', ...blank, ...rightOrder.map(i => other.rows[indices[0]!]![i]!)]);
      }
      notes.push('Only added, removed and changed rows are written. Comparisons use exact cell text.');
      return { table: out.table, counts, notes };
    }
    case 'aggregate': {
      const gi = positions(left, input.group_by);
      const measures = input.aggregations.map(a => ({ ...a, index: a.column === undefined ? -1 : positions(left, [a.column])[0]! }));
      type State = { count: number; sum: Decimal; min: Decimal | null; max: Decimal | null };
      const make = (): State[] => measures.map(() => ({ count: 0, sum: { n: 0n, scale: 0 }, min: null, max: null }));
      const groups = new Map<string, { keys: string[]; measures: State[] }>();
      if (!gi.length) groups.set('[]', { keys: [], measures: make() });
      let skipped = 0;
      left.rows.forEach((row, rowIndex) => {
        const keys = gi.map(i => row[i]!), key = JSON.stringify(keys);
        let group = groups.get(key);
        if (!group) {
          if (groups.size >= LIMITS.rows || (groups.size + 1) * (gi.length + measures.length) > LIMITS.cells) fail('group count exceeds output limits');
          group = { keys, measures: make() }; groups.set(key, group);
        }
        measures.forEach((a, i) => {
          const state = group!.measures[i]!;
          if (a.op === 'count') { state.count++; return; }
          const value = row[a.index]!;
          if (!value.trim() && input.empty_numeric === 'skip') { skipped++; return; }
          const n = decimal(value, `data row ${rowIndex + 1}, column ${a.column}`);
          state.count++; state.sum = plus(state.sum, n);
          if (state.min === null || compare(n, state.min) < 0) state.min = n;
          if (state.max === null || compare(n, state.max) > 0) state.max = n;
        });
      });
      const out = output([...input.group_by, ...measures.map(a => a.as)]);
      const value = (a: CsvAggregation, s: State): string => {
        if (a.op === 'count') return String(s.count);
        if (!s.count) return '';
        if (a.op === 'sum') return format(s.sum);
        if (a.op === 'avg') return average(s.sum, s.count, input.average_scale);
        return format(a.op === 'min' ? s.min! : s.max!);
      };
      for (const group of groups.values()) out.push([...group.keys, ...measures.map((a, i) => value(a, group.measures[i]!))]);
      counts.groups = groups.size; counts.skipped_empty_measure_values = skipped;
      notes.push(`Decimal sums and comparisons are exact. Averages round half away from zero to ${input.average_scale} decimal places. Empty numeric sets produce an empty cell.`);
      return { table: out.table, counts, notes };
    }
  }
};
