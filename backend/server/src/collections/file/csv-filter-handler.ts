/** D-244 — `csv-filter` / `csv-rows` / `csv-columns` / `csv-stats`: search a
 *  stored CSV without pulling it through recipe step state. `csv-filter` SAVES
 *  its matches as a new record (a write); `csv-rows` returns them, capped, and
 *  saves nothing.
 *
 *  ⛔⛔ THE PROBLEM THIS EXISTS FOR. Searching a stored sheet used to mean
 *  `data-file-read → decode_base64 → csv_parse → filter`, and every one of those
 *  step outputs is RETAINED for the rest of the run: the base64 (~1.33×), the
 *  decoded text (1×) and the parsed rows (several × again — each cell a string,
 *  each row repeating the column names) are all resident at once. A 10 MB CSV is
 *  plausibly 150 MB of step state. Here the bytes live inside this handler,
 *  bounded, and only the FILTERED result becomes a record.
 *
 *  🔑 THE PARSER IS NOT HERE. `csvFilter` / `csvColumns` are pure functions in
 *  `@recued/transforms`, sharing `csv_parse`'s exact semantics — BOM stripping,
 *  delimiter, quote, the CRLF and quoted-field rules. A second parser in the
 *  kernel would read the identical file differently from the transform layer,
 *  and a BOM'd header matching in one place and not the other reads to an owner
 *  as "the data is wrong". This file owns the I/O and nothing else.
 *
 *  ⚠ Why a KERNEL op and not a transform: dereferencing a `file_ref` is the
 *  Gateway-gated content boundary, and `packages/` code runs on clients with no
 *  warehouse at all. A file-reading transform would be both an unaudited second
 *  path to those bytes and undefined on two of three hosts.
 */

import {
  csvColumns, csvFilter, csvRows, csvStats,
  type CsvMatchMode, type CsvRowsResult, type CsvStatsResult,
} from '@recued/transforms';

/** Read one `data.file.received` record's bytes — the same dep shape
 *  `markdown-template-render-handler` takes, so both go through one gated read
 *  rather than each growing its own. */
export interface CsvFileReader {
  readFile(input: { record_id: string }): Promise<{
    record_id: string;
    bytes_b64: string;
    filename?: string;
    mime_type?: string;
  }>;
}

/** D-245 — read a record on a NAMED file instance (`{slug, path}`).
 *
 *  🔑 The second addressing mode, and the reason it exists: a CAS id is
 *  content-derived, so a recipe cannot name its own file in advance. A
 *  `{slug, path}` record can be named once and rewritten in place — which is
 *  what makes "the file I own" expressible at all. These ops accept EITHER, so
 *  the caller picks a stable name or a content address without the op caring. */
export interface CsvInstanceReader {
  readInstanceFile(input: { slug: string; path: string }): Promise<{ body_b64: string }>;
}

/** Land the filtered CSV as a `data.file.received` record. */
export type CsvOutputIngestor = (input: {
  bytes: Buffer;
  filename: string;
  mime_type: string;
}) => Promise<{ record_id: string }>;

export interface CsvFilterDeps {
  readonly reader: CsvFileReader;
  /** Present on the server; absent hosts simply cannot address a named
   *  instance, and say so rather than silently reading nothing. */
  readonly instanceReader?: CsvInstanceReader;
  readonly ingest: CsvOutputIngestor;
  /** ⛔ A ceiling on the DECODED text. The filtered output is usually small, but
   *  the source is not, and this handler is the last place able to refuse before
   *  the bytes are decoded into memory. */
  readonly maxBytes?: number;
}

/** 32 MiB of decoded CSV. Generous next to the 8 MB a recipe could safely pull
 *  into step state, because here the bytes never leave the handler — but still a
 *  bound, so a mistaken ref cannot exhaust the server. */
export const CSV_FILTER_MAX_BYTES = 32 * 1024 * 1024;

export interface CsvFilterArgs extends CsvAddress {
  column: string;
  match: string;
  mode?: CsvMatchMode;
  ignore_case?: boolean;
  delimiter?: string;
}

export interface CsvFilterResponse {
  /** Absent when the column does not exist — there is nothing to hand back, and
   *  a caller that got a ref anyway would parse an empty file and read it as
   *  "no such record". */
  file_ref?: string;
  matched: number;
  scanned: number;
  /** ⛔ THE FIELD EVERY GUARD KEYS ON. A missing column and a genuine miss both
   *  yield zero rows; only this tells them apart. */
  column_found: boolean;
  columns: readonly string[];
}

/** One of the two addresses, never both. ⛔ Ambiguity is refused rather than
 *  resolved by precedence — a caller that passed both meant one of them, and
 *  guessing silently reads the wrong file. */
export interface CsvAddress {
  record_id?: string;
  slug?: string;
  path?: string;
}

/** Everything a CSV op needs to READ, and nothing it would need to save. The
 *  reading ops take this, so they are never handed the ingestor. */
export type CsvReadDeps = Omit<CsvFilterDeps, 'ingest'>;

const decode = async (
  deps: CsvReadDeps,
  where: CsvAddress,
): Promise<string> => {
  const hasRecord = typeof where.record_id === 'string' && where.record_id.trim().length > 0;
  const hasInstance = typeof where.slug === 'string' && where.slug.length > 0
    && typeof where.path === 'string' && where.path.length > 0;
  if (hasRecord && hasInstance) {
    throw new Error('csv: pass record_id OR slug+path, not both');
  }
  if (!hasRecord && !hasInstance) {
    throw new Error('csv: record_id, or slug + path, is required');
  }

  let bytes_b64: string;
  if (hasInstance) {
    if (!deps.instanceReader) {
      throw new Error('csv: reading a named file instance needs a paired server');
    }
    ({ body_b64: bytes_b64 } = await deps.instanceReader.readInstanceFile({
      slug: where.slug!, path: where.path!,
    }));
  } else {
    ({ bytes_b64 } = await deps.reader.readFile({ record_id: where.record_id! }));
  }
  const bytes = Buffer.from(bytes_b64, 'base64');
  const ceiling = deps.maxBytes ?? CSV_FILTER_MAX_BYTES;
  if (bytes.length > ceiling) {
    const what = where.record_id ?? `${where.slug}:${where.path}`;
    throw new Error(
      `csv-filter: '${what}' is ${bytes.length} bytes, past the ${ceiling}-byte ceiling`,
    );
  }
  return bytes.toString('utf8');
};

export const handleCsvFilter = async (
  deps: CsvFilterDeps,
  args: CsvFilterArgs,
): Promise<CsvFilterResponse> => {
  if (typeof args.column !== 'string' || args.column.length === 0) {
    throw new Error('csv-filter: column is required');
  }
  const text = await decode(deps, args);
  const result = csvFilter({
    text,
    column: args.column,
    match: typeof args.match === 'string' ? args.match : '',
    ...(args.mode !== undefined ? { mode: args.mode } : {}),
    ...(args.ignore_case !== undefined ? { ignore_case: args.ignore_case } : {}),
    ...(args.delimiter !== undefined ? { delimiter: args.delimiter } : {}),
  });

  const base = {
    matched: result.matched,
    scanned: result.scanned,
    column_found: result.column_found,
    columns: result.columns,
  };
  // ⚠ No ref for a missing column. Handing one back would give the caller a
  // parseable empty file — indistinguishable from a real zero-match, which is
  // the whole failure this op exists to make impossible.
  if (!result.column_found) return base;

  const { record_id } = await deps.ingest({
    bytes: Buffer.from(result.csv, 'utf8'),
    filename: 'filtered.csv',
    mime_type: 'text/csv',
  });
  return { ...base, file_ref: record_id };
};

/** `csv-rows`' row cap when the caller names none, and the most it may ask for.
 *  The cap is what keeps the reading op from becoming the retention D-244 exists
 *  to avoid: a match-everything search on a large sheet would otherwise pull the
 *  whole sheet into step state. `matched` still counts every match, and past the
 *  ceiling `csv-filter` saves the full set as a file. */
export const CSV_ROWS_DEFAULT_LIMIT = 100;
export const CSV_ROWS_MAX_LIMIT = 1000;

export interface CsvRowsArgs extends CsvFilterArgs {
  limit?: number;
}

/** `csv-rows` — the READING twin of {@link handleCsvFilter}: the same matches,
 *  returned as rows keyed by header, and nothing saved. Its deps are
 *  {@link CsvReadDeps}, so it cannot reach the ingestor even by mistake. */
export const handleCsvRows = async (
  deps: CsvReadDeps,
  args: CsvRowsArgs,
): Promise<CsvRowsResult> => {
  if (typeof args.column !== 'string' || args.column.length === 0) {
    throw new Error('csv-rows: column is required');
  }
  const limit = args.limit ?? CSV_ROWS_DEFAULT_LIMIT;
  // ⛔ Refused, not clamped: a caller asking for 5,000 rows and silently getting
  // 1,000 would read `truncated` as a property of the sheet.
  if (!Number.isInteger(limit) || limit < 1 || limit > CSV_ROWS_MAX_LIMIT) {
    throw new Error(`csv-rows: limit must be a whole number from 1 to ${CSV_ROWS_MAX_LIMIT}`);
  }
  const text = await decode(deps, args);
  return csvRows({
    text,
    column: args.column,
    match: typeof args.match === 'string' ? args.match : '',
    ...(args.mode !== undefined ? { mode: args.mode } : {}),
    ...(args.ignore_case !== undefined ? { ignore_case: args.ignore_case } : {}),
    ...(args.delimiter !== undefined ? { delimiter: args.delimiter } : {}),
    limit,
  });
};

export const handleCsvColumns = async (
  deps: CsvFilterDeps,
  args: CsvAddress & { delimiter?: string },
): Promise<{ columns: readonly string[] }> => {
  const text = await decode(deps, args);
  return {
    columns: csvColumns({
      text,
      ...(args.delimiter !== undefined ? { delimiter: args.delimiter } : {}),
    }),
  };
};

/** Column statistics over one stored CSV.
 *
 *  🔑 A VALUE result, unlike `csv-filter` — and that is the whole reason this is
 *  a kernel op rather than the `csvstat` CLI pack on the stdout-capture arm.
 *  That arm would make the stats REACHABLE and worse: a small structured summary
 *  would come back as a FILE, costing three steps (read → decode → parse) to
 *  recover what the caller wanted directly. Every field here is a scalar, so the
 *  result cannot grow with the file.
 *
 *  ⚠ It also needs no Python. `csvstat` is a csvkit install; a summary of a
 *  stored sheet should not depend on one. */
export const handleCsvStats = async (
  deps: CsvFilterDeps,
  args: CsvAddress & { delimiter?: string },
): Promise<CsvStatsResult> => {
  const text = await decode(deps, args);
  return csvStats({
    text,
    ...(args.delimiter !== undefined ? { delimiter: args.delimiter } : {}),
  });
};
