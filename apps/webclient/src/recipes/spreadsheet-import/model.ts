/** D-292 — the guided spreadsheet import: pure state and the rules that move it.
 *
 *  Upload → match columns → check → import, for any recipe whose
 *  `metadata.spreadsheet_import` holds (`spreadsheetImportOf`). Everything here is
 *  a function of its arguments; `wire.ts` owns the DOM, the upload and the rpc.
 *
 *  ⛔⛔ THE BROWSER READS THE FILE ONLY TO SHOW IT. The header and the first values
 *  under each column come from `csv_parse` — the SAME function the server's import
 *  runs (`records/store.ts` `importCsv`), with the same delimiter — so a column the
 *  screen offers is a column the import can read, byte for byte (BOM, quoting,
 *  duplicate headers: last one wins, the names `csv_parse` drops are not offered).
 *  Nothing here decides what gets recorded: the CHECK is a real server dry run and
 *  the import is a real server run. A client-side imitation of the mapping would be
 *  a second implementation free to disagree with the first exactly where it
 *  matters.
 */
import {
  isOptionalVariable,
  type ServerExecuteResponse,
  type SpreadsheetImportDeclaration,
  type VariableDefault,
} from '@recued/contracts';
import { csvColumns, getTransform } from '@recued/transforms';

/** How much of the file the mapping screen reads. The header and a handful of
 *  values need a few KB; 1 MiB covers any real statement WHOLE (so the row count is
 *  exact) and bounds the work on a file that is not one. Past it the count is
 *  withheld rather than guessed. */
export const INSPECT_CHARS = 1024 * 1024;
/** Values shown under each column choice. */
export const SAMPLE_VALUES = 3;
/** Rows scanned for those values — past a sparse first few rows, not the file. */
const SAMPLE_SCAN_ROWS = 50;
/** Delimiters detection tries, in order of how often exports use them. */
export const DELIMITER_CANDIDATES = [',', ';', '\t', '|'] as const;
const DETECT_LINES = 21;

export type SheetImportStep = 'file' | 'columns' | 'check';

export interface SheetInspection {
  /** Distinct header names the IMPORTER can read, in file order. */
  readonly header: readonly string[];
  /** Header name → the first non-empty values under it. */
  readonly samples: Readonly<Record<string, readonly string[]>>;
  /** Data rows, exact when the whole file was read; `null` when it was cut. */
  readonly rowCount: number | null;
}

/** Where a column choice came from — shown, so a guess is never mistaken for a
 *  fact the owner stated. */
export type MappingSource = 'remembered' | 'recipe' | 'guessed' | 'chosen' | 'none';

export type UploadPhase = 'idle' | 'uploading' | 'done' | 'error';

export interface SheetImportState {
  readonly step: SheetImportStep;
  // ── the file ──
  readonly fileName: string | null;
  readonly fileSize: number | null;
  /** The `data.file` record the recipe's file variable receives. */
  readonly recordId: string | null;
  /** Where the file came from. The existing-file picker shows a selection only
   *  for a file chosen THERE — an upload is not a pick, and showing it in the
   *  picker read as though the owner had searched for it. */
  readonly fileSource: 'upload' | 'existing' | null;
  readonly upload: { readonly phase: UploadPhase; readonly fraction: number; readonly error: string | null };
  readonly reading: boolean;
  readonly readError: string | null;
  /** The text the screen inspects (at most `INSPECT_CHARS`). */
  readonly text: string | null;
  readonly textTruncated: boolean;
  // ── how it parses ──
  readonly delimiter: string;
  /** What detection chose, when it changed the recipe's default — said out loud. */
  readonly delimiterDetected: string | null;
  readonly inspection: SheetInspection | null;
  // ── the mapping ──
  readonly mapping: Readonly<Record<string, string>>;
  readonly mappingSource: Readonly<Record<string, MappingSource>>;
  /** The recipe's OTHER variables (account label, currency, …), by key. */
  readonly settings: Readonly<Record<string, unknown>>;
  /** D-301 — the owner opened "More options". The formats also show, whatever
   *  this says, while one is not at its default (`formatsChanged`). */
  readonly moreOpen: boolean;
  readonly remember: boolean;
  // ── the runs ──
  readonly busy: 'check' | 'import' | null;
  readonly checkResult: ServerExecuteResponse | null;
  readonly runError: string | null;
  /** A message that outlives a step change (e.g. "imported, but could not
   *  remember your columns"). */
  readonly notice: string | null;
  /** The real import finished and the dialog stayed open only to say something
   *  (a remember that failed). Nothing but Close is offered: a second Import
   *  button over a finished import is an invitation to run it twice. */
  readonly imported: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A variable's default, whichever way it was declared. */
export const variableDefault = (def: VariableDefault | undefined): unknown => {
  if (def === undefined || def === null) return undefined;
  if (isRecord(def)) return def.default;
  return def;
};

/** The variable's label, falling back to its key. */
export const variableLabel = (key: string, def: VariableDefault | undefined): string =>
  isRecord(def) && typeof def.label === 'string' && def.label.trim() !== '' ? def.label : key;

/** The recipe's variables the flow renders as ordinary settings: everything the
 *  declaration does not name. */
export const settingKeys = (
  declaration: SpreadsheetImportDeclaration,
  variables: Readonly<Record<string, VariableDefault>>,
): string[] => {
  const named = new Set<string>([
    declaration.file, declaration.preview, ...declaration.columns,
    ...(declaration.delimiter === undefined ? [] : [declaration.delimiter]),
  ]);
  return Object.keys(variables).filter((key) => !named.has(key));
};

/** D-301 — the settings the declaration names as how the file writes its values,
 *  in declaration order. */
export const formatKeys = (
  declaration: SpreadsheetImportDeclaration,
  variables: Readonly<Record<string, VariableDefault>>,
): string[] => {
  const settings = settingKeys(declaration, variables);
  return (declaration.formats ?? []).filter((key) => key !== declaration.conflicts && settings.includes(key));
};

/** D-301 — is any format not at its default? Then the formats are never tucked
 *  away: a remembered "day first" hidden behind "More options" would apply to an
 *  import the owner never saw it on. */
export const formatsChanged = (
  declaration: SpreadsheetImportDeclaration,
  variables: Readonly<Record<string, VariableDefault>>,
  settings: Readonly<Record<string, unknown>>,
): boolean => formatKeys(declaration, variables).some((key) =>
  JSON.stringify(settings[key]) !== JSON.stringify(asDisplayed(variables[key], variableDefault(variables[key]) ?? '')));

const parseObjects = (text: string, delimiter: string): Record<string, string>[] =>
  getTransform('csv_parse')!({ input: text, delimiter }, {} as never) as Record<string, string>[];

const parseRaw = (text: string, delimiter: string): string[][] =>
  getTransform('csv_parse')!({ input: text, delimiter, has_header: false }, {} as never) as string[][];

/** Cut `text` to the inspection budget, at a line boundary so the last row the
 *  screen reads is whole. */
export const inspectionText = (text: string): { text: string; truncated: boolean } => {
  if (text.length <= INSPECT_CHARS) return { text, truncated: false };
  const cut = text.slice(0, INSPECT_CHARS);
  const lastBreak = cut.lastIndexOf('\n');
  return { text: lastBreak > 0 ? cut.slice(0, lastBreak) : cut, truncated: true };
};

/** Read the header and the first values under each column — with the importer's
 *  own parser, so what is offered is what the import can read. */
export const inspectSheet = (text: string, delimiter: string, truncated = false): SheetInspection => {
  const rawHeader = csvColumns({ text, delimiter });
  const rows = parseObjects(text, delimiter);
  const first = rows[0];
  // A parsed row's OWN keys are the columns a mapping can read: `csv_parse`
  // drops the names it refuses (`__proto__`, `constructor`, `prototype`) and
  // folds a repeated name onto one key. The header only answers for a file with
  // no data rows, where nothing would be imported either way.
  const readable = (name: string): boolean =>
    first === undefined || Object.prototype.hasOwnProperty.call(first, name);
  const header: string[] = [];
  for (const name of rawHeader) {
    if (!header.includes(name) && readable(name)) header.push(name);
  }
  const samples: Record<string, string[]> = {};
  for (const name of header) samples[name] = [];
  for (const row of rows.slice(0, SAMPLE_SCAN_ROWS)) {
    for (const name of header) {
      const list = samples[name]!;
      if (list.length >= SAMPLE_VALUES) continue;
      const value = (Object.prototype.hasOwnProperty.call(row, name) ? row[name] ?? '' : '').trim();
      if (value !== '') list.push(value);
    }
  }
  return { header, samples, rowCount: truncated ? null : rows.length };
};

/** The delimiter that splits the first lines into the most columns,
 *  CONSISTENTLY — or `fallback` when nothing beats it.
 *
 *  ⚠ A switch needs a strictly better score, so a file that parses the same way
 *  either way keeps the recipe's delimiter, and a single-column file keeps it too.
 *  Consistent means ≥ 80% of the sampled rows have the header's width: a comma
 *  inside a quoted amount (`"1,200.00"`) must not make a semicolon file look like
 *  a comma one. */
export const detectDelimiter = (text: string, fallback: string): string => {
  const head = text.split('\n').slice(0, DETECT_LINES).join('\n');
  const score = (delimiter: string): number => {
    const rows = parseRaw(head, delimiter);
    const width = rows[0]?.length ?? 0;
    if (width < 2) return 0;
    const body = rows.slice(1);
    if (body.length === 0) return width;
    const consistent = body.filter((row) => row.length === width).length / body.length;
    return consistent >= 0.8 ? width : 0;
  };
  let best = fallback;
  let bestScore = score(fallback);
  for (const candidate of DELIMITER_CANDIDATES) {
    if (candidate === fallback) continue;
    const candidateScore = score(candidate);
    if (candidateScore > bestScore) {
      best = candidate;
      bestScore = candidateScore;
    }
  }
  return best;
};

/** How a delimiter reads to a person. */
export const delimiterLabel = (delimiter: string): string =>
  delimiter === ',' ? 'Comma'
    : delimiter === ';' ? 'Semicolon'
      : delimiter === '\t' ? 'Tab'
        : delimiter === '|' ? 'Pipe'
          : `“${delimiter}”`;

/** Lowercase, letters and digits only — `Transaction Date` ≈ `transaction_date`. */
export const normalizeHeader = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Pre-select a column for every declared variable.
 *
 *  Precedence: what the owner remembered, then the recipe's own default — both
 *  only when the file HAS that column — then a guess by normalised name, which is
 *  marked as a guess. A guess never takes a column another variable already holds,
 *  and a column the file lacks is never pre-selected: offering it would put back
 *  the silent-empty-column defect the dropdown exists to remove. */
export const initialMapping = (args: {
  declaration: SpreadsheetImportDeclaration;
  variables: Readonly<Record<string, VariableDefault>>;
  header: readonly string[];
  remembered?: Readonly<Record<string, unknown>>;
}): { mapping: Record<string, string>; source: Record<string, MappingSource> } => {
  const { declaration, variables, header } = args;
  const inHeader = (value: unknown): value is string =>
    typeof value === 'string' && value !== '' && header.includes(value);
  const mapping: Record<string, string> = {};
  const source: Record<string, MappingSource> = {};
  for (const variable of declaration.columns) {
    const remembered = args.remembered?.[variable];
    const recipeDefault = variableDefault(variables[variable]);
    if (inHeader(remembered)) {
      mapping[variable] = remembered;
      source[variable] = 'remembered';
    } else if (typeof remembered === 'string' && remembered === '' && isOptionalVariable(variables[variable])) {
      // The owner said "not in my file" last time — for an optional column that
      // is a remembered answer too, and it outranks the recipe's default.
      mapping[variable] = '';
      source[variable] = 'remembered';
    } else if (inHeader(recipeDefault)) {
      mapping[variable] = recipeDefault;
      source[variable] = 'recipe';
    }
  }
  const taken = (): Set<string> => new Set(Object.values(mapping).filter((value) => value !== ''));
  for (const variable of declaration.columns) {
    if (mapping[variable] !== undefined) continue;
    const recipeDefault = variableDefault(variables[variable]);
    const wanted = typeof recipeDefault === 'string' ? normalizeHeader(recipeDefault) : '';
    const free = header.filter((name) => !taken().has(name));
    const exact = wanted === '' ? [] : free.filter((name) => normalizeHeader(name) === wanted);
    const partial = wanted.length < 3 ? [] : free.filter((name) => normalizeHeader(name).includes(wanted));
    const pick = exact.length === 1 ? exact[0] : exact.length === 0 && partial.length === 1 ? partial[0] : undefined;
    if (pick !== undefined) {
      mapping[variable] = pick;
      source[variable] = 'guessed';
    } else {
      mapping[variable] = '';
      source[variable] = 'none';
    }
  }
  return { mapping, source };
};

export interface MappingProblem {
  readonly variable: string;
  readonly kind: 'required' | 'not_in_file';
  readonly message: string;
}

/** What stops a check from running. A required column left unmatched, or a
 *  choice the file no longer has (the delimiter changed under it). */
export const mappingProblems = (
  declaration: SpreadsheetImportDeclaration,
  variables: Readonly<Record<string, VariableDefault>>,
  mapping: Readonly<Record<string, string>>,
  header: readonly string[],
): MappingProblem[] => {
  const problems: MappingProblem[] = [];
  for (const variable of declaration.columns) {
    const value = mapping[variable] ?? '';
    if (value === '') {
      if (!isOptionalVariable(variables[variable])) {
        problems.push({
          variable, kind: 'required',
          message: 'Choose a column — this one is needed.',
        });
      }
      continue;
    }
    if (!header.includes(value)) {
      problems.push({
        variable, kind: 'not_in_file',
        message: `This file has no column called “${value}”.`,
      });
    }
  }
  return problems;
};

/** Columns chosen for more than one field. Allowed (the store permits it) but
 *  almost always a slip, so it is pointed out, never refused. */
export const sharedColumns = (
  declaration: SpreadsheetImportDeclaration,
  mapping: Readonly<Record<string, string>>,
): string[] => {
  const seen = new Map<string, number>();
  for (const variable of declaration.columns) {
    const value = mapping[variable] ?? '';
    if (value !== '') seen.set(value, (seen.get(value) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
};

/** The initial value of every ordinary setting: the owner's remembered install
 *  config, else what the opener handed in, else the recipe's default. */
export const initialSettings = (args: {
  declaration: SpreadsheetImportDeclaration;
  variables: Readonly<Record<string, VariableDefault>>;
  remembered?: Readonly<Record<string, unknown>>;
  prefill?: Readonly<Record<string, unknown>>;
}): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of settingKeys(args.declaration, args.variables)) {
    const has = (from: Readonly<Record<string, unknown>> | undefined): boolean =>
      from !== undefined && Object.prototype.hasOwnProperty.call(from, key);
    // ⛔ The conflict choice is decided at the check, EACH TIME: a saved config
    // never pre-sets it — only an opener's explicit prefill for this one run does.
    const saved = key !== args.declaration.conflicts && has(args.remembered);
    const value = has(args.prefill) ? args.prefill![key]
      : saved ? args.remembered![key]
        : variableDefault(args.variables[key]) ?? '';
    out[key] = asDisplayed(args.variables[key], value);
  }
  return out;
};

/** The value exactly as its widget will SHOW it — so what runs is what was on
 *  screen. A checkbox shows ticked only for `true` / `"true"`, so a saved
 *  `"false"` is sent as `false`, never as a truthy string; a dropdown whose value
 *  is not one of its options shows the first option, so that is what is sent. */
const asDisplayed = (def: VariableDefault | undefined, value: unknown): unknown => {
  if (typeof def === 'boolean') return value === true || value === 'true';
  if (!isRecord(def)) return value;
  if (def.type === 'boolean') return value === true || value === 'true';
  if (def.type === 'enum' && Array.isArray(def.options) && def.options.length > 0) {
    return def.options.some((option) => String(option) === String(value)) ? value : def.options[0];
  }
  return value;
};

/** The config for one run. EVERY declared variable is sent explicitly — a column
 *  the owner marked "not in my file" is sent as `''` — so neither a saved install
 *  config nor a recipe default can put back a column the screen did not show.
 *  What ran is exactly what was on screen. */
export const buildRunConfig = (
  declaration: SpreadsheetImportDeclaration,
  state: Pick<SheetImportState, 'recordId' | 'delimiter' | 'mapping' | 'settings'>,
  preview: boolean,
): Record<string, unknown> => {
  const config: Record<string, unknown> = { ...state.settings };
  config[declaration.file] = state.recordId ?? '';
  if (declaration.delimiter !== undefined) config[declaration.delimiter] = state.delimiter;
  for (const variable of declaration.columns) config[variable] = state.mapping[variable] ?? '';
  config[declaration.preview] = preview;
  return config;
};

/** The install config to store when the owner ticks "remember": the existing
 *  overlay, plus the column choices, the delimiter and (D-301) the formats —
 *  never the other settings. The formats describe the FILE, as the columns do,
 *  and a date format that changed between two imports of one account changes
 *  every line's identity: the second import would add the statement again.
 *
 *  ⛔ AN ACCOUNT LABEL IS NEVER REMEMBERED. Each line's identity is scoped to it;
 *  pre-filling last month's label onto a different account's statement would merge
 *  two ledgers under one name, silently and permanently. Column names are a fact
 *  about a bank's FORMAT and are safe to carry; which account this is is not. */
export const rememberedConfig = (
  existing: Readonly<Record<string, unknown>>,
  declaration: SpreadsheetImportDeclaration,
  state: Pick<SheetImportState, 'delimiter' | 'mapping' | 'settings'>,
): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...existing };
  for (const variable of declaration.columns) next[variable] = state.mapping[variable] ?? '';
  if (declaration.delimiter !== undefined) next[declaration.delimiter] = state.delimiter;
  for (const key of declaration.formats ?? []) {
    if (key !== declaration.conflicts && Object.prototype.hasOwnProperty.call(state.settings, key)) {
      next[key] = state.settings[key];
    }
  }
  return next;
};

/** Decode a `data.file.read` payload as the server's `decode_base64` does: the
 *  bytes as UTF-8. */
export const decodeBase64Text = (b64: string): string => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
};

export const initialSheetImportState = (args: {
  declaration: SpreadsheetImportDeclaration;
  variables: Readonly<Record<string, VariableDefault>>;
  prefill?: Readonly<Record<string, unknown>>;
  canRemember: boolean;
}): SheetImportState => {
  const delimiterDefault = args.declaration.delimiter === undefined
    ? ','
    : variableDefault(args.variables[args.declaration.delimiter]);
  return {
    step: 'file',
    fileName: null,
    fileSize: null,
    recordId: null,
    fileSource: null,
    upload: { phase: 'idle', fraction: 0, error: null },
    reading: false,
    readError: null,
    text: null,
    textTruncated: false,
    delimiter: typeof delimiterDefault === 'string' && delimiterDefault.length === 1 ? delimiterDefault : ',',
    delimiterDetected: null,
    inspection: null,
    mapping: {},
    mappingSource: {},
    settings: initialSettings({
      declaration: args.declaration,
      variables: args.variables,
      ...(args.prefill === undefined ? {} : { prefill: args.prefill }),
    }),
    moreOpen: false,
    remember: args.canRemember,
    busy: null,
    checkResult: null,
    runError: null,
    notice: null,
    imported: false,
  };
};

/** Can the owner move on from the File step? The screen has read a header and
 *  the file is on the server or on its way — matching columns overlaps the
 *  upload; only the CHECK needs the file to have arrived (`fileOnServer`). */
export const fileStepReady = (state: SheetImportState): boolean =>
  state.inspection !== null && state.inspection.header.length > 0
  && state.upload.phase !== 'error'
  && (state.recordId !== null || state.upload.phase === 'uploading');

/** The server holds the file, so a run can read it. */
export const fileOnServer = (state: SheetImportState): boolean => state.recordId !== null;

/** A human sentence for a failed run — the first message the engine reported. */
export const runFailureMessage = (result: ServerExecuteResponse): string => {
  if (result.run_terminated !== undefined) return 'The run was stopped before it finished.';
  for (const entry of result.errors ?? []) {
    if (typeof entry === 'string' && entry.trim() !== '') return entry;
    if (isRecord(entry)) {
      const message = entry.message ?? entry.error ?? entry.reason;
      if (typeof message === 'string' && message.trim() !== '') return message;
    }
  }
  return 'The run did not finish. Nothing was recorded.';
};

export const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B`
    : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
