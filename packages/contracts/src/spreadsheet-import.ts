/** D-292 — `metadata.spreadsheet_import`: a recipe declaring that it imports a
 *  spreadsheet the owner uploads, so a surface can guide them through it —
 *  upload → match columns → check → import — instead of asking them to type
 *  header names into free-text fields.
 *
 *  ## What the declaration names
 *
 *  What a surface cannot infer from the variables alone:
 *
 *    - `file`      — the `file_ref` variable the spreadsheet goes into;
 *    - `preview`   — the boolean variable that makes a run a CHECK that records
 *                    nothing (the import op's `dry_run`);
 *    - `delimiter` — optional: the variable holding the delimiter, so the
 *                    surface can detect it and re-read the header with it;
 *    - `columns`   — string variables that each name ONE header cell of the
 *                    file, in the order a mapping screen should show them;
 *    - `conflicts` — optional: the owner's choice for a line they already have
 *                    with different details (keep theirs, or be told).
 *    - `formats`   — optional (D-301): the variables that say how the FILE
 *                    writes its values — its decimal mark, its dates. A surface
 *                    tucks them under "More options", opened whenever one is not
 *                    at its default, and remembers them WITH the columns: like a
 *                    column name they are a fact about the bank's export, and a
 *                    date format forgotten between two imports changes every
 *                    line's identity, so the second import would add the whole
 *                    statement again.
 *
 *  Whether a column may be left unmapped is NOT restated here: it is the
 *  variable's own `optional: true` (`ValueHint` — "the recipe still works if
 *  you skip this"), so the plain run form and the guided one read the same
 *  fact from the same place.
 *
 *  ## ⛔⛔ The cross-check that is a safety property
 *
 *  A surface presses "Check" by setting the `preview` variable to `true`. If
 *  that variable did not actually reach the import's `dry_run`, **Check would
 *  be a real import** — the owner rehearses, and the rehearsal writes every row.
 *  So `spreadsheetImportProblems` requires that EVERY step carrying a
 *  `dry_run` passes exactly `{{config.<preview>}}`, and that at least one does —
 *  in the authored op-step shape AND the lowered ingredient shape a pack install
 *  validates (see `dryRunSites`). It is deliberately strict about the form: a computed value
 *  (`{{step.x}}`, a literal, an interpolated string) would need the engine to
 *  prove it tracks the switch, and nothing can.
 *
 *  ⚠ What this CANNOT prove statically: that the recipe has no OTHER write step
 *  the switch does not gate (a vendor op's risk is not knowable here). That half
 *  is proved by driving every declaring recipe with the switch on against a real
 *  store — `backend/server/src/__tests__/spreadsheet-import-corpus.test.ts`.
 *
 *  ## Why the webclient runs this too, not only `validateRecipe`
 *
 *  Metadata keys are OPEN — a server older than D-292 installs a recipe
 *  carrying this block and ignores it, unvalidated. After an upgrade that stored
 *  recipe reaches a new client never having been checked. So the client asks
 *  the same question before offering the flow, and one pure function answers it
 *  in both places.
 *
 *  Spec: D-292. */

export const SPREADSHEET_IMPORT_METADATA_KEY = 'spreadsheet_import' as const;

export interface SpreadsheetImportDeclaration {
  /** The `file_ref` variable the spreadsheet goes into. */
  readonly file: string;
  /** The boolean variable that turns a run into a check that records nothing.
   *  Must reach the import op's `dry_run` — see the module note. */
  readonly preview: string;
  /** The single-character string variable holding the delimiter, when the
   *  owner can change it. Absent ⇒ the recipe fixes the delimiter itself. */
  readonly delimiter?: string;
  /** String variables that each name one header cell. May be empty: a
   *  fixed-header import still gains upload + check + import. */
  readonly columns: readonly string[];
  /** Optional: the variable that decides what happens to a line the owner
   *  ALREADY HAS with different details — a boolean ("keep what I already
   *  have") or an enum of answers. A surface shows it next to Import, beside the
   *  check that revealed those lines, so the OWNER decides what their data
   *  keeps; the recipe maps it to the import's `on_conflict`. Absent ⇒ the
   *  recipe has no such choice to offer. */
  readonly conflicts?: string;
  /** Optional (D-301): variables describing how the file writes its values.
   *  Shown under "More options" and remembered with the columns — see the
   *  module note. */
  readonly formats?: readonly string[];
}

/** The admitted keys. Closed: a misspelt `colums` must be refused, not read as
 *  "this import maps nothing". */
export const SPREADSHEET_IMPORT_KEYS = ['file', 'preview', 'delimiter', 'columns', 'conflicts', 'formats'] as const;

export type SpreadsheetImportProblemCode =
  /** Not an object, an unknown key, or a member of the wrong JSON type. */
  | 'spreadsheet_import_shape'
  /** A named variable is not declared in `variables`. */
  | 'spreadsheet_import_variable_unknown'
  /** The same variable is named twice (or in two roles). */
  | 'spreadsheet_import_variable_repeated'
  | 'spreadsheet_import_file_not_file_ref'
  | 'spreadsheet_import_preview_not_boolean'
  /** ⛔ The switch does not reach `dry_run` — Check would write. */
  | 'spreadsheet_import_preview_unwired'
  | 'spreadsheet_import_delimiter_not_string'
  /** The conflict choice is neither a boolean nor an enum — nothing a surface
   *  can offer as a decision. */
  | 'spreadsheet_import_conflicts_not_choice'
  /** A conflict choice is declared, but an import step's `on_conflict` is not
   *  set from the recipe (absent, or a literal) — the choice cannot change what
   *  the import does. */
  | 'spreadsheet_import_conflicts_unwired'
  | 'spreadsheet_import_column_not_string'
  /** A named variable is never read by the recipe, so setting it does nothing. */
  | 'spreadsheet_import_variable_unread';

export interface SpreadsheetImportProblem {
  readonly code: SpreadsheetImportProblemCode;
  /** Dotted path into the recipe, for a validator issue. */
  readonly path: string;
  readonly detail: string;
}

/** The recipe fields this module reads. Structural, so the webclient can pass a
 *  `ServerRecipeListEntry['recipe']` and the validator an unvalidated object. */
export interface SpreadsheetImportRecipeView {
  readonly metadata?: unknown;
  readonly variables?: unknown;
  readonly steps?: unknown;
  readonly prefetch_steps?: unknown;
  readonly trigger_steps?: unknown;
  readonly output?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const PATH = `metadata.${SPREADSHEET_IMPORT_METADATA_KEY}`;

/** The raw block, or `undefined` when the recipe declares none. */
export const readSpreadsheetImport = (recipe: SpreadsheetImportRecipeView): unknown =>
  isRecord(recipe.metadata) ? recipe.metadata[SPREADSHEET_IMPORT_METADATA_KEY] : undefined;

/** A variable's declared type, as far as this module needs to know it. A
 *  primitive default declares its own type; a `ValueHint` object names one. */
const variableKind = (def: unknown): 'string' | 'boolean' | 'file_ref' | 'enum' | 'other' => {
  if (typeof def === 'string') return 'string';
  if (typeof def === 'boolean') return 'boolean';
  if (!isRecord(def)) return 'other';
  const type = def.type;
  // `'string'` is outside `ValueHintType` but is how 3,677 corpus hints spell a
  // string (see the note on `ValueHintType`); `'text'` / `'long_text'` are the
  // other string-valued members.
  if (type === 'string' || type === 'text' || type === 'long_text') return 'string';
  if (type === 'boolean') return 'boolean';
  if (type === 'file_ref') return 'file_ref';
  if (type === 'enum' && Array.isArray(def.options) && def.options.length > 0) return 'enum';
  return 'other';
};

/** `true` when the variable's hint says the recipe works without it. */
export const isOptionalVariable = (def: unknown): boolean =>
  isRecord(def) && def.optional === true;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does the recipe read `{{config.<name>}}` anywhere outside its declarations?
 *  `stepsOnly` leaves the output out: a variable mentioned only in a label is
 *  shown, not used. */
const readsConfig = (recipe: SpreadsheetImportRecipeView, name: string, stepsOnly = false): boolean => {
  const pattern = new RegExp(`\\{\\{\\s*config\\.${escapeRegExp(name)}(?![A-Za-z0-9_])`);
  const parts = [recipe.steps, recipe.prefetch_steps, recipe.trigger_steps, ...(stepsOnly ? [] : [recipe.output])];
  for (const part of parts) {
    if (part === undefined) continue;
    let text: string;
    try {
      text = JSON.stringify(part) ?? '';
    } catch {
      continue;
    }
    if (pattern.test(text)) return true;
  }
  return false;
};

interface DryRunSite {
  readonly path: string;
  readonly value: unknown;
  /** Where this import's `spec.on_conflict` sits — the same container as the
   *  `dry_run`, in whichever shape the step has — and what it holds. */
  readonly onConflictPath: string;
  readonly onConflict: unknown;
}

/** `container.spec.on_conflict`, whatever is (or is not) there. */
const onConflictOf = (container: Record<string, unknown>): unknown =>
  isRecord(container.spec) ? container.spec.on_conflict : undefined;

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/** Every step, in every phase, that passes a `dry_run` — in EITHER of the two
 *  shapes a step has in this recipe's life.
 *
 *  ⛔⛔ THE SAME RECIPE IS VALIDATED IN BOTH SHAPES. It is authored with a
 *  two-tier `op` step (`args.dry_run`), but a Records pack install validates it
 *  AFTER `lowerOpStepRecipe` has rewritten every op step into a concrete
 *  ingredient step: a Tier-P pack op becomes
 *  `{ ingredient, input: { operation, args } }` and a kernel op becomes
 *  `{ ingredient, input: <args> }`. A check that knew only the authored shape
 *  found NO import step at install and refused all three shipped importers —
 *  found by driving the real install, not by any artifact test. So every place a
 *  step can carry a `dry_run` is a site: `args`, `input.args`, and `input`. */
const dryRunSites = (recipe: SpreadsheetImportRecipeView): DryRunSite[] => {
  const sites: DryRunSite[] = [];
  for (const phase of ['prefetch_steps', 'steps', 'trigger_steps'] as const) {
    const steps = recipe[phase];
    if (!Array.isArray(steps)) continue;
    steps.forEach((step, index) => {
      if (!isRecord(step)) return;
      const at = `${phase}.${typeof step.id === 'string' ? step.id : String(index)}`;
      if (typeof step.op === 'string' && isRecord(step.args) && hasOwn(step.args, 'dry_run')) {
        sites.push({
          path: `${at}.args.dry_run`, value: step.args.dry_run,
          onConflictPath: `${at}.args.spec.on_conflict`, onConflict: onConflictOf(step.args),
        });
      }
      if (typeof step.ingredient === 'string' && isRecord(step.input)) {
        const input = step.input;
        if (isRecord(input.args) && hasOwn(input.args, 'dry_run')) {
          sites.push({
            path: `${at}.input.args.dry_run`, value: input.args.dry_run,
            onConflictPath: `${at}.input.args.spec.on_conflict`, onConflict: onConflictOf(input.args),
          });
        }
        if (hasOwn(input, 'dry_run')) {
          sites.push({
            path: `${at}.input.dry_run`, value: input.dry_run,
            onConflictPath: `${at}.input.spec.on_conflict`, onConflict: onConflictOf(input),
          });
        }
      }
    });
  }
  return sites;
};

/** Everything wrong with the recipe's declaration. `[]` means it is sound —
 *  OR that the recipe declares none; ask `readSpreadsheetImport` which.
 *
 *  Every problem is an error: a declaration that does not hold would make a
 *  surface mislead the owner, and the worst case (an unwired switch) makes a
 *  rehearsal write. */
export const spreadsheetImportProblems = (
  recipe: SpreadsheetImportRecipeView,
): SpreadsheetImportProblem[] => {
  const raw = readSpreadsheetImport(recipe);
  if (raw === undefined) return [];
  const problems: SpreadsheetImportProblem[] = [];
  const add = (code: SpreadsheetImportProblemCode, path: string, detail: string): void => {
    problems.push({ code, path, detail });
  };
  if (!isRecord(raw)) {
    add('spreadsheet_import_shape', PATH,
      `${PATH} must be an object { file, preview, delimiter?, columns, conflicts?, formats? }`);
    return problems;
  }
  for (const key of Object.keys(raw)) {
    if (!(SPREADSHEET_IMPORT_KEYS as readonly string[]).includes(key)) {
      add('spreadsheet_import_shape', `${PATH}.${key}`,
        `unknown key '${key}' — admitted: ${SPREADSHEET_IMPORT_KEYS.join(', ')}`);
    }
  }
  const nameAt = (key: 'file' | 'preview' | 'delimiter' | 'conflicts', required: boolean): string | null => {
    const value = raw[key];
    if (value === undefined && !required) return null;
    if (typeof value !== 'string' || value.length === 0) {
      add('spreadsheet_import_shape', `${PATH}.${key}`, `${key} must name a variable`);
      return null;
    }
    return value;
  };
  const file = nameAt('file', true);
  const preview = nameAt('preview', true);
  const delimiter = nameAt('delimiter', false);
  const conflicts = nameAt('conflicts', false);
  const columns: string[] = [];
  if (!Array.isArray(raw.columns)) {
    add('spreadsheet_import_shape', `${PATH}.columns`,
      'columns must be an array of variable names (empty for a fixed-header import)');
  } else {
    raw.columns.forEach((entry, index) => {
      if (typeof entry !== 'string' || entry.length === 0) {
        add('spreadsheet_import_shape', `${PATH}.columns[${index}]`, 'must name a variable');
        return;
      }
      columns.push(entry);
    });
  }

  const formats: string[] = [];
  if (raw.formats !== undefined) {
    if (!Array.isArray(raw.formats)) {
      add('spreadsheet_import_shape', `${PATH}.formats`, 'formats must be an array of variable names');
    } else {
      raw.formats.forEach((entry, index) => {
        if (typeof entry !== 'string' || entry.length === 0) {
          add('spreadsheet_import_shape', `${PATH}.formats[${index}]`, 'must name a variable');
          return;
        }
        formats.push(entry);
      });
    }
  }

  const variables = isRecord(recipe.variables) ? recipe.variables : {};
  const declared = (name: string): boolean =>
    Object.prototype.hasOwnProperty.call(variables, name);

  const seen = new Set<string>();
  const roles: Array<[string, string]> = [
    ...(file === null ? [] : [['file', file] as [string, string]]),
    ...(preview === null ? [] : [['preview', preview] as [string, string]]),
    ...(delimiter === null ? [] : [['delimiter', delimiter] as [string, string]]),
    ...(conflicts === null ? [] : [['conflicts', conflicts] as [string, string]]),
    ...columns.map((name, index) => [`columns[${index}]`, name] as [string, string]),
    ...formats.map((name, index) => [`formats[${index}]`, name] as [string, string]),
  ];
  for (const [role, name] of roles) {
    if (seen.has(name)) {
      add('spreadsheet_import_variable_repeated', `${PATH}.${role}`,
        `variable '${name}' is named more than once — each role needs its own variable`);
    }
    seen.add(name);
    if (!declared(name)) {
      add('spreadsheet_import_variable_unknown', `${PATH}.${role}`,
        `'${name}' is not declared in variables`);
    }
  }

  if (file !== null && declared(file)) {
    if (variableKind(variables[file]) !== 'file_ref') {
      add('spreadsheet_import_file_not_file_ref', `${PATH}.file`,
        `variable '${file}' must be declared { "type": "file_ref" } — it is where the upload goes`);
    }
    if (!readsConfig(recipe, file)) {
      add('spreadsheet_import_variable_unread', `${PATH}.file`,
        `no step reads {{config.${file}}}, so the uploaded file would never be imported`);
    }
  }
  if (conflicts !== null && declared(conflicts)) {
    const kind = variableKind(variables[conflicts]);
    if (kind !== 'boolean' && kind !== 'enum') {
      add('spreadsheet_import_conflicts_not_choice', `${PATH}.conflicts`,
        `variable '${conflicts}' must be a boolean or an enum — it is a decision the owner makes`);
    }
    // ⛔ A control that reaches nothing reads as a decision while being
    // decoration. Two halves, because neither proves the other: a STEP must read
    // the choice (a mention in an output label is shown, not used), and every
    // import must take its `on_conflict` from the recipe (a literal, or none,
    // cannot be changed by anything the owner picks).
    if (!readsConfig(recipe, conflicts, true)) {
      add('spreadsheet_import_variable_unread', `${PATH}.conflicts`,
        `no step reads {{config.${conflicts}}}, so the owner's choice would change nothing`);
    }
    for (const site of dryRunSites(recipe)) {
      if (typeof site.onConflict === 'string' && /\{\{[^}]+\}\}/.test(site.onConflict)) continue;
      add('spreadsheet_import_conflicts_unwired', site.onConflictPath,
        'this import\'s on_conflict is not set from the recipe, so the owner\'s choice cannot change what it does');
    }
  }
  if (delimiter !== null && declared(delimiter)) {
    if (variableKind(variables[delimiter]) !== 'string') {
      add('spreadsheet_import_delimiter_not_string', `${PATH}.delimiter`,
        `variable '${delimiter}' must be a string variable`);
    }
    if (!readsConfig(recipe, delimiter)) {
      add('spreadsheet_import_variable_unread', `${PATH}.delimiter`,
        `no step reads {{config.${delimiter}}}, so a detected delimiter would be ignored`);
    }
  }
  columns.forEach((name, index) => {
    if (!declared(name)) return;
    if (variableKind(variables[name]) !== 'string') {
      add('spreadsheet_import_column_not_string', `${PATH}.columns[${index}]`,
        `variable '${name}' must be a string variable — it holds one header cell`);
    }
    if (!readsConfig(recipe, name)) {
      add('spreadsheet_import_variable_unread', `${PATH}.columns[${index}]`,
        `no step reads {{config.${name}}}, so choosing a column for it would change nothing`);
    }
  });

  // A format a step never reads is a setting that changes nothing — shown, and
  // remembered, while being decoration.
  formats.forEach((name, index) => {
    if (declared(name) && !readsConfig(recipe, name, true)) {
      add('spreadsheet_import_variable_unread', `${PATH}.formats[${index}]`,
        `no step reads {{config.${name}}}, so setting it would change nothing`);
    }
  });

  if (preview !== null && declared(preview)) {
    if (variableKind(variables[preview]) !== 'boolean') {
      add('spreadsheet_import_preview_not_boolean', `${PATH}.preview`,
        `variable '${preview}' must be a boolean variable`);
    }
    const exact = new RegExp(`^\\{\\{\\s*config\\.${escapeRegExp(preview)}\\s*\\}\\}$`);
    const sites = dryRunSites(recipe);
    const wired = sites.filter((site) => typeof site.value === 'string' && exact.test(site.value));
    for (const site of sites) {
      if (wired.includes(site)) continue;
      add('spreadsheet_import_preview_unwired', site.path,
        `this step's dry_run is not {{config.${preview}}} — a check would run it for real`);
    }
    if (wired.length === 0) {
      add('spreadsheet_import_preview_unwired', `${PATH}.preview`,
        `no step passes dry_run: "{{config.${preview}}}" — pressing Check would import for real`);
    }
  }

  return problems;
};

/** The declaration a surface may ACT on: declared, well-formed, and
 *  cross-checked against the recipe's own variables and steps. `null` when the
 *  recipe declares none or the declaration does not hold — the surface then
 *  keeps the plain run form, which works for every import recipe regardless. */
export const spreadsheetImportOf = (
  recipe: SpreadsheetImportRecipeView,
): SpreadsheetImportDeclaration | null => {
  const raw = readSpreadsheetImport(recipe);
  if (raw === undefined || spreadsheetImportProblems(recipe).length > 0) return null;
  const block = raw as Record<string, unknown>;
  return {
    file: block.file as string,
    preview: block.preview as string,
    ...(typeof block.delimiter === 'string' ? { delimiter: block.delimiter } : {}),
    ...(typeof block.conflicts === 'string' ? { conflicts: block.conflicts } : {}),
    columns: [...(block.columns as string[])],
    ...(Array.isArray(block.formats) ? { formats: [...(block.formats as string[])] } : {}),
  };
};
