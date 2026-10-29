import { createHash } from 'node:crypto';
import {
  CSV_TOOLKIT_LIMITS, parseCsvInspectInput, parseCsvTransformInput,
  type CsvInspectResult, type CsvTransformInput, type CsvTransformResult, type CsvSourceReceipt,
} from '@recued/contracts';
import { parseCsvTable, summarizeCsvTable, serializeCsvTable, operateCsvTable, type CsvTable } from '@recued/transforms';
import type { CsvFileReader, CsvOutputIngestor } from './csv-filter-handler.js';

export interface CsvToolkitReadDeps { reader: CsvFileReader }
export interface CsvToolkitDeps extends CsvToolkitReadDeps { ingest: CsvOutputIngestor }
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

interface CsvSnapshot { text: string; receipt: Omit<CsvSourceReceipt, 'rows'> }
interface CsvRead { table: CsvTable; receipt: CsvSourceReceipt }

const snapshot = async (deps: CsvToolkitReadDeps, source: string): Promise<CsvSnapshot> => {
  const result = await deps.reader.readFile({ record_id: source });
  // The production reader enforces this before reading bytes too. Check here
  // for alternate hosts before allocating a decoded string or a table.
  if (result.bytes_b64.length > Math.ceil(CSV_TOOLKIT_LIMITS.bytes / 3) * 4) throw new Error('CSV Toolkit: source exceeds the 32 MiB file limit');
  const bytes = Buffer.from(result.bytes_b64, 'base64');
  if (bytes.length > CSV_TOOLKIT_LIMITS.bytes) throw new Error('CSV Toolkit: source exceeds the 32 MiB file limit');
  let text: string;
  // csv_parse owns removal of the file's BOM. Removing it in the decoder too
  // would eat a second, literal BOM belonging to the first column's name.
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('CSV Toolkit: source must be UTF-8 CSV; convert its encoding first'); }
  return { text, receipt: { file_ref: source, content_hash: hash(bytes), bytes: bytes.length } };
};

const parseSnapshot = (source: CsvSnapshot, delimiter: string): CsvRead => {
  const table = parseCsvTable(source.text, delimiter);
  return { table, receipt: { ...source.receipt, rows: table.rows.length } };
};
const read = async (deps: CsvToolkitReadDeps, source: string, delimiter: string): Promise<CsvRead> =>
  parseSnapshot(await snapshot(deps, source), delimiter);

const readInputs = async (deps: CsvToolkitReadDeps, input: CsvTransformInput): Promise<[CsvRead, CsvRead?]> => {
  // A live source may change between reads. One occurrence of a file reference
  // in this operation must mean the same bytes as the other occurrence. This
  // reuse ends with this call; later operations read and revalidate afresh.
  if ('other_source' in input && input.source === input.other_source) {
    const source = await snapshot(deps, input.source);
    const left = parseSnapshot(source, input.delimiter);
    return [left, input.delimiter === input.other_delimiter ? left : parseSnapshot(source, input.other_delimiter)];
  }
  const left = await read(deps, input.source, input.delimiter);
  return [left, 'other_source' in input ? await read(deps, input.other_source, input.other_delimiter) : undefined];
};

export const handleCsvInspect = async (deps: CsvToolkitReadDeps, raw: unknown): Promise<CsvInspectResult> => {
  const input = parseCsvInspectInput(raw), source = await read(deps, input.source, input.delimiter);
  const empty_cells = source.table.columns.map(() => 0);
  for (const row of source.table.rows) row.forEach((cell, i) => { if (cell === '') empty_cells[i]!++; });
  return { ...summarizeCsvTable(source.table, input.preview_rows), source: source.receipt, empty_cells };
};

/** No full table leaves this boundary. Only a durable output ref and bounded metadata enter step state. */
export const handleCsvTransform = async (deps: CsvToolkitDeps, raw: unknown): Promise<CsvTransformResult> => {
  const input = parseCsvTransformInput(raw), [left, right] = await readInputs(deps, input);
  const result = operateCsvTable(left.table, input, right?.table);
  const bytes = Buffer.from(serializeCsvTable(result.table), 'utf8');
  const filename = `csv-${input.operation}.csv`, mime_type = 'text/csv';
  // All validation and output bounds finish before the single write. The source
  // records are unchanged. Ingest uses normal tool-output retention and provenance.
  const saved = await deps.ingest({ bytes, filename, mime_type });
  const content_hash = hash(bytes);
  return { ...summarizeCsvTable(result.table), operation: input.operation,
    file_ref: saved.record_id, record_id: saved.record_id, filename, mime_type,
    content_hash, bytes: bytes.length, sha256: content_hash, size_bytes: bytes.length, generated_at: Date.now(),
    sources: [left.receipt, ...(right ? [right.receipt] : [])], counts: result.counts, notes: result.notes };
};
