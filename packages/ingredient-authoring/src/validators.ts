import {
  KIND_ALLOWED_TIERS,
  OP_KINDS,
  isOpKind,
  SLUG_RE,
  PACK_CONTENT_KINDS,
  parseBulkPackManifest,
  assertEntitySchemaIngredientShape,
  assertEngagementFacetShape,
  ACCT_ALIAS_VALUES,
  CRM_ALIAS_VALUES,
  canonicalCrmFieldSet,
  canonicalCrmFieldTypeLabel,
  requiredCanonicalCrmFields,
  crmFieldPackTypeConforms,
  isMetaFieldType,
  isDateGranularity,
  SEARCH_STYLES,
  isSearchStyle,
  WRITE_STYLES,
  isWriteStyle,
  PAGINATION_STYLES,
  isPaginationStyle,
  OPERATION_PAGINATION_STYLES,
  OPERATION_PAGINATION_PLACEMENTS,
  isOperationPaginationStyle,
  isOperationPaginationPlacement,
  CLI_OUTPUT_SHAPES,
  CLI_OUTPUT_STORAGES,
  SERVICE_RESTART_POLICIES,
  isClosedRequestSchema,
} from '@recued/contracts';
import type {
  BulkPackIssue,
  BulkPackManifest,
  CliOutputShape,
  CliOutputStorage,
  CompositionIngredient,
  CrmAlias,
  EntitySchemaIngredientInput,
  OperationApproval,
  PackContentRef,
} from '@recued/contracts';
import {
  validateIngredient,
  type ValidationIssue,
  type ValidationSeverity,
} from '@recued/ingredients/validate';
// cli `argv_template` SAFETY — the shared single source the CATALOG validator
// (`validateIngredient`) also uses, so the "locked binary + typed-data args"
// invariant can never drift between the authoring table and a directly-published
// catalog ingredient. The interpreter code/eval-hole guard + the argv[0]
// command-pin both live here.
import { cliInterpreterViolations, cliCommandViolation } from '@recued/ingredients/cli-argv-safety';
import type { CliArgvTemplateEntryLike } from '@recued/ingredients/cli-argv-safety';
import {
  CANONICAL_WORKFLOW_TEMPLATE_REGISTRY,
  COMPOSITION_MAX_FIELDS,
  COMPOSITION_MAX_OPERATIONS,
  COMPOSITION_MAX_SERIALIZED_BYTES,
} from './schema.js';
import { decomposeComposition, decomposePack, normalizeEntityId } from './decomposer.js';
import type { DecomposedArtifacts, PackDecomposition } from './decomposer.js';

export type CompositionValidationIssue = ValidationIssue;

export interface CompositionValidationResult {
  valid: boolean;
  issues: CompositionValidationIssue[];
  decomposed?: DecomposedArtifacts | PackDecomposition;
}

type AddIssue = (
  severity: ValidationSeverity,
  code: string,
  path: string,
  message: string,
) => void;
export type RecipeValidator = (input: unknown) => { issues: readonly ValidationIssue[] };

export interface CompositionValidationOptions {
  recipeValidator?: RecipeValidator;
}

const OPERATION_APPROVALS: ReadonlySet<OperationApproval> = new Set(['never', 'ask', 'always']);
const PACK_CONTENT_KIND_SET: ReadonlySet<string> = new Set(PACK_CONTENT_KINDS);
const CRM_ALIAS_SET: ReadonlySet<string> = new Set(CRM_ALIAS_VALUES);
const ACCT_ALIAS_SET: ReadonlySet<string> = new Set(ACCT_ALIAS_VALUES);
const PAGINATION_SELECTOR_SET: ReadonlySet<string> = new Set(['first', 'last']);
const WORKFLOW_ROW_KEYS: ReadonlySet<string> = new Set([
  'template',
  'trigger',
  'operation',
  'sync_target',
  'notify_target',
  'escalate_after_ms',
]);
const WORKFLOW_TRIGGER_KEYS: ReadonlySet<string> = new Set(['entity', 'field', 'value', 'cron']);
const WORKFLOW_SYNC_TARGET_KEYS: ReadonlySet<string> = new Set(['source_id', 'write_back_op']);
const CLI_STREAMING_LINT_TOKENS: ReadonlySet<string> = new Set([
  '-f',
  '--follow',
  'logs',
  'tail',
  'dev',
  '--watch',
  '--build',
]);
const CLI_DETACHED_PATTERN_REF_RE = /\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g;
const CLI_CWD_ARG_RE = /^\{([A-Za-z_][A-Za-z0-9_.-]*)\}$/;
const CLI_FILE_REF_ARRAY_MAX_ITEMS = 32;

const addIssue = (
  issues: CompositionValidationIssue[],
  severity: ValidationSeverity,
  code: string,
  path: string,
  message: string,
): void => {
  issues.push({ severity, code, path, message });
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isNonEmptyString);

const isCliArgvExpandEntry = (value: unknown): value is { expand_arg: string } =>
  isPlainObject(value)
  && Object.keys(value).length === 1
  && isNonEmptyString(value.expand_arg);

const isCliArgvTemplate = (value: unknown): value is Array<string | { expand_arg: string }> =>
  Array.isArray(value)
  && value.length > 0
  && value.every((entry) => isNonEmptyString(entry) || isCliArgvExpandEntry(entry));

const serializedBytes = (value: unknown): number | null => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return null;
  }
};

const objectKeysExactly = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, idx) => key === [...expected].sort()[idx]);
};

const streamingLintTokenIndex = (argvTemplate: readonly CliArgvTemplateEntryLike[]): number => {
  const hasDetachedUp = argvTemplate.includes('-d');
  return argvTemplate.findIndex((token) => (
    typeof token === 'string'
      && (CLI_STREAMING_LINT_TOKENS.has(token) || (token === 'up' && !hasDetachedUp))
  ));
};

const validateCliArgvTemplate = (
  argvTemplate: Array<string | { expand_arg: string }>,
  declaredTool: string | undefined,
  path: string,
  add: AddIssue,
): void => {
  // argv[0] is the COMMAND — a non-templated literal pinned to the bound cli
  // ingredient's declared launched binary (the decomposer's
  // `entry_point ?? tool ?? slug`). A call-time `{hole}` command lets a recipe
  // arg choose which binary runs, escalating a narrow tool grant to arbitrary
  // execution. (The CATALOG validator re-checks this post-decompose against the
  // stamped `runtime.entry_point`; this surfaces it at the composition layer.)
  const cmd = cliCommandViolation(argvTemplate, declaredTool);
  if (cmd?.kind === 'command_templated') {
    add(
      'error',
      'composition_cli_command_hole',
      `${path}[0]`,
      'CLI argv_template[0] (the command) must be a non-templated literal, not a call-time hole; lock the binary and pass typed data args instead',
    );
  } else if (cmd?.kind === 'command_tool_mismatch') {
    add(
      'error',
      'composition_cli_command_tool_mismatch',
      `${path}[0]`,
      `CLI argv_template[0] '${argvTemplate[0]}' must equal the cli ingredient's declared binary '${cmd.tool}' (entry_point) — the grant authorizes that binary, not an arbitrary command`,
    );
  }

  // No interpreter eval/code or unlocked script-path hole (the shared guard the
  // catalog validator also uses — one source, no drift).
  for (const v of cliInterpreterViolations(argvTemplate)) {
    add(
      'error',
      'composition_cli_code_hole',
      `${path}[${v.index}]`,
      v.kind === 'code_eval'
        ? `CLI argv_template must not invoke ${v.interpreter} with code/eval flag '${v.flag}'; lock a script or binary and pass typed data args instead`
        : `CLI argv_template must not let ${v.interpreter} choose its script path from a call-time hole; lock the script path token and pass typed data args instead`,
    );
  }

  const lintIdx = streamingLintTokenIndex(argvTemplate);
  if (lintIdx >= 0) {
    const token = argvTemplate[lintIdx];
    if (typeof token !== 'string') return;
    add(
      'warn',
      'composition_cli_streaming_lint',
      `${path}[${lintIdx}]`,
      `CLI operations run one-shot (<=120s); '${token}' looks streaming or long-running, so prefer a bounded snapshot or a detached CLI job declaration`,
    );
  }
};

const cliArgvHasScalarRef = (
  argvTemplate: unknown,
  arg: string,
): boolean =>
  Array.isArray(argvTemplate)
  && argvTemplate.some((token) => typeof token === 'string' && token.includes(`{${arg}}`));

const cliArgvHasExpandArg = (
  argvTemplate: unknown,
  arg: string,
): boolean =>
  Array.isArray(argvTemplate)
  && argvTemplate.some((token) => isPlainObject(token) && token.expand_arg === arg);

const cliArgvExpandedArgs = (argvTemplate: unknown): string[] => {
  if (!Array.isArray(argvTemplate)) return [];
  return argvTemplate
    .map((token) => (isPlainObject(token) && typeof token.expand_arg === 'string' ? token.expand_arg : undefined))
    .filter((arg): arg is string => arg !== undefined);
};

const templateRefs = (template: unknown): string[] => {
  if (typeof template !== 'string') return [];
  const refs = new Set<string>();
  for (const match of template.matchAll(CLI_DETACHED_PATTERN_REF_RE)) {
    if (match[1] !== 'code') refs.add(match[1]);
  }
  return [...refs];
};

const editableArgsAffectingTarget = (raw: unknown): ReadonlySet<string> => {
  if (!Array.isArray(raw)) return new Set();
  const keys = new Set<string>();
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry.key === 'string' && entry.affects_target === true) {
      keys.add(entry.key);
    }
  }
  return keys;
};

const cliCwdArgRef = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const match = value.match(CLI_CWD_ARG_RE);
  return match?.[1];
};

const validateCliCwd = (
  row: Record<string, unknown>,
  path: string,
  add: AddIssue,
): void => {
  if (!isPlainObject(row.bind) || row.bind.kind !== 'cli_invocation') return;
  const cwd = row.bind.cwd;
  if (cwd === undefined) return;
  const cwdPath = `${path}.bind.cwd`;
  if (!isPlainObject(cwd) || !objectKeysExactly(cwd, ['arg'])) {
    add(
      'error',
      'composition_cli_cwd_shape',
      cwdPath,
      'cwd must be an object with exactly { "arg": "{arg_name}" } when present',
    );
    return;
  }
  const ref = cliCwdArgRef(cwd.arg);
  if (ref === undefined) {
    add(
      'error',
      'composition_cli_cwd_arg',
      `${cwdPath}.arg`,
      'cwd.arg must be a single {arg_name} template token',
    );
    return;
  }
  if (!editableArgsAffectingTarget(row.editable_args).has(ref)) {
    add(
      'error',
      'composition_cli_cwd_target_arg',
      `${cwdPath}.arg`,
      `cwd arg ${JSON.stringify(ref)} must be declared in editable_args with affects_target: true`,
    );
  }
};

const CLI_DETACHED_PATTERN_ROOT = '{result_dir}/';

const validateDetachedCliPatternRefs = (
  row: Record<string, unknown>,
  path: string,
  add: AddIssue,
): void => {
  if (!isPlainObject(row.bind) || row.bind.kind !== 'cli_invocation') return;
  const detached = row.bind.detached;
  if (!isPlainObject(detached)) return;
  const completion = isPlainObject(detached.completion) ? detached.completion : {};
  const cancel = isPlainObject(detached.cancel) ? detached.cancel : {};
  const patterns: ReadonlyArray<[string, unknown]> = [
    [`${path}.bind.detached.completion.exit_pattern`, completion.exit_pattern],
    [`${path}.bind.detached.completion.log_pattern`, completion.log_pattern],
    [`${path}.bind.detached.cancel.pid_pattern`, cancel.pid_pattern],
  ];
  for (const [patternPath, pattern] of patterns) {
    if (typeof pattern !== 'string' || pattern.length === 0) continue;
    // The server executor confines every marker path under the `result_dir`
    // arg — a pattern rooted anywhere else fails at runtime, so reject it at
    // authoring time.
    if (!pattern.startsWith(CLI_DETACHED_PATTERN_ROOT)) {
      add(
        'error',
        'composition_cli_detached_pattern_root',
        patternPath,
        `detached marker patterns must start with '${CLI_DETACHED_PATTERN_ROOT}' — the runtime confines them under the result_dir arg`,
      );
    }
  }
  const refs = new Set<string>([
    ...templateRefs(completion.exit_pattern),
    ...templateRefs(completion.log_pattern),
    ...templateRefs(cancel.pid_pattern),
  ]);
  if (refs.size === 0) return;
  const targetArgs = editableArgsAffectingTarget(row.editable_args);
  for (const ref of refs) {
    if (targetArgs.has(ref)) continue;
    add(
      'error',
      'composition_cli_detached_ref_not_target_editable',
      `${path}.bind.detached`,
      `detached marker template arg ${JSON.stringify(ref)} must be declared in editable_args with affects_target: true`,
    );
  }
};

/** Validate an optional `bind.detached.supervision` block — the keep-alive
 *  declaration that makes a detached cli op a supervised long-running daemon. */
const validateDetachedSupervision = (
  row: Record<string, unknown>,
  path: string,
  add: AddIssue,
): void => {
  if (!isPlainObject(row.bind) || row.bind.kind !== 'cli_invocation') return;
  const detached = row.bind.detached;
  if (!isPlainObject(detached)) return;
  const supervision = detached.supervision;
  if (supervision === undefined) return;
  const supPath = `${path}.bind.detached.supervision`;
  if (!isPlainObject(supervision)) {
    add('error', 'composition_cli_supervision_shape', supPath, 'supervision must be an object when present');
    return;
  }
  const rp = supervision.restart_policy;
  if (typeof rp !== 'string' || !(SERVICE_RESTART_POLICIES as readonly string[]).includes(rp)) {
    add(
      'error',
      'composition_cli_supervision_restart_policy',
      `${supPath}.restart_policy`,
      `supervision.restart_policy must be one of ${SERVICE_RESTART_POLICIES.join(' | ')}`,
    );
  }
  if (
    supervision.restart_on_server_start !== undefined &&
    typeof supervision.restart_on_server_start !== 'boolean'
  ) {
    add(
      'error',
      'composition_cli_supervision_restart_on_server_start',
      `${supPath}.restart_on_server_start`,
      'supervision.restart_on_server_start must be a boolean when present',
    );
  }
};

const editableArgKeys = (raw: unknown): ReadonlySet<string> => {
  if (!Array.isArray(raw)) return new Set();
  const keys = new Set<string>();
  for (const entry of raw) {
    if (isPlainObject(entry) && typeof entry.key === 'string') keys.add(entry.key);
  }
  return keys;
};

/** Document-toolkit — validate `binding.output_capture` (capture the cli op's
 *  output file as a `data.file` ref). The `dir_arg` token is engine-managed: the
 *  executor injects a throwaway temp dir there, so it MUST be an argv token AND
 *  MUST NOT be a user-supplied editable_arg (else the recipe could redirect where
 *  output lands). Foreground-only — `detached` ops have their own `result_dir`
 *  marker model. */
const validateCliOutputCapture = (
  row: Record<string, unknown>,
  path: string,
  add: AddIssue,
): void => {
  if (!isPlainObject(row.bind) || row.bind.kind !== 'cli_invocation') return;
  const capture = row.bind.output_capture;
  if (capture === undefined) return;
  const capturePath = `${path}.bind.output_capture`;
  if (!isPlainObject(capture)) {
    add('error', 'composition_cli_output_capture_shape', capturePath, 'output_capture must be an object');
    return;
  }
  if (row.bind.detached !== undefined) {
    add('error', 'composition_cli_output_capture_detached', capturePath, 'output_capture is foreground-only and cannot combine with a detached job spec');
  }
  if (typeof capture.mime_type !== 'string' || capture.mime_type.length === 0) {
    add('error', 'composition_cli_output_capture_mime', `${capturePath}.mime_type`, 'output_capture.mime_type must be a non-empty string');
  }
  // D-185 Slice 3 — content isolation, now keyed on `shape`: an output_capture
  // op produces a `file_ref`, so it MUST declare `shape: 'ref'` (which makes the
  // executor discard stdout). A VALUE shape would ALSO capture stdout — mixing
  // the file content back into op-step values. (`validateCliOutputShape` checks
  // the symmetric direction: `shape: 'ref'` requires an output_capture.)
  if (row.bind.shape !== 'ref') {
    add('error', 'composition_cli_output_capture_shape', `${path}.bind.shape`, "an output_capture op must declare shape: 'ref' — a value shape would capture stdout and leak the file content into op-step values; the file content flows only via result.file_ref");
  }
  const dirArg = capture.dir_arg;
  if (typeof dirArg !== 'string' || dirArg.length === 0) {
    add('error', 'composition_cli_output_capture_dir_arg', `${capturePath}.dir_arg`, 'output_capture.dir_arg must be a non-empty string');
    return;
  }
  if (!cliArgvHasScalarRef(row.bind.argv_template, dirArg)) {
    add('error', 'composition_cli_output_capture_dir_arg', `${capturePath}.dir_arg`, `output_capture.dir_arg '${dirArg}' must appear as a {${dirArg}} token in argv_template`);
  }
  if (editableArgKeys(row.editable_args).has(dirArg)) {
    add('error', 'composition_cli_output_capture_dir_arg_editable', `${capturePath}.dir_arg`, `output_capture.dir_arg '${dirArg}' is engine-managed and must not be declared in editable_args`);
  }
};

/** SMB-finance slice 3 — validate a REST `binding.response_capture` (capture the
 *  HTTP body as a `data.file` ref, storage-gdrive `file.download`). Content
 *  isolation + safety: capture is read-tier GET ONLY (a write endpoint can never
 *  be a capture op), returns a fixed `{ file_ref }` shape (no `result_path` —
 *  the bytes are never JSON-walked), and is mutually exclusive with pagination. */
const validateRestResponseCapture = (
  row: Record<string, unknown>,
  path: string,
  add: AddIssue,
): void => {
  if (!isPlainObject(row.bind) || row.bind.kind !== 'rest') return;
  const capture = row.bind.response_capture;
  if (capture === undefined) return;
  const capturePath = `${path}.bind.response_capture`;
  if (!isPlainObject(capture)) {
    add('error', 'composition_rest_response_capture_shape', capturePath, 'response_capture must be an object');
    return;
  }
  if (capture.kind !== 'file_ref') {
    add('error', 'composition_rest_response_capture_kind', `${capturePath}.kind`, "response_capture.kind must be 'file_ref'");
  }
  if (row.bind.method !== 'GET') {
    add('error', 'composition_rest_response_capture_method', `${path}.bind.method`, 'a response_capture op must be a GET (it is a read; a write endpoint can never be a capture op)');
  }
  if (row.risk !== 'read') {
    add('error', 'composition_rest_response_capture_risk', `${path}.risk`, 'a response_capture op must be risk_tier read');
  }
  if (row.result_path !== undefined) {
    add('error', 'composition_rest_response_capture_result_path', `${path}.result_path`, 'a response_capture op returns a fixed { file_ref } result and must not declare result_path (the body is never JSON-walked)');
  }
  if (row.pagination !== undefined) {
    add('error', 'composition_rest_response_capture_pagination', `${path}.pagination`, 'a response_capture op captures a single body and cannot paginate');
  }
  if (capture.mime_type !== undefined && (typeof capture.mime_type !== 'string' || capture.mime_type.length === 0)) {
    add('error', 'composition_rest_response_capture_mime', `${capturePath}.mime_type`, 'response_capture.mime_type must be a non-empty string when present');
  }
  const fs = capture.filename_source;
  if (!isPlainObject(fs)) {
    add('error', 'composition_rest_response_capture_filename_source', `${capturePath}.filename_source`, 'response_capture.filename_source must be an object');
    return;
  }
  if (fs.kind === 'static') {
    if (typeof fs.value !== 'string' || fs.value.length === 0) {
      add('error', 'composition_rest_response_capture_filename_static', `${capturePath}.filename_source.value`, "filename_source.value must be a non-empty string for kind 'static'");
    }
  } else if (fs.kind === 'arg') {
    // The arg name carrying the download filename (e.g. the `name` a prior
    // `file.list` returned). Read-op args are not editable_args, and the
    // filename only labels the CAS record + names the basename-sanitized temp
    // file — not a security boundary — so it need only be a non-empty arg name.
    if (typeof fs.arg !== 'string' || fs.arg.length === 0) {
      add('error', 'composition_rest_response_capture_filename_arg', `${capturePath}.filename_source.arg`, "filename_source.arg must be a non-empty string for kind 'arg'");
    }
  } else if (fs.kind !== 'header') {
    add('error', 'composition_rest_response_capture_filename_kind', `${capturePath}.filename_source.kind`, "filename_source.kind must be one of 'header' | 'static' | 'arg'");
  }
};

/** Basecamp/int64 audit fold — validate the closed opt-in JSON normalization
 * declaration. Keeping the shape closed prevents a typo from silently falling
 * back to native lossy number parsing. Binary capture and JSON parsing are
 * mutually exclusive response modes. */
const validateRestResponseJson = (
  row: Record<string, unknown>,
  path: string,
  add: AddIssue,
): void => {
  if (!isPlainObject(row.bind) || row.bind.kind !== 'rest') return;
  const spec = row.bind.response_json;
  if (spec === undefined) return;
  const specPath = `${path}.bind.response_json`;
  if (!isPlainObject(spec)) {
    add('error', 'composition_rest_response_json_shape', specPath, 'response_json must be an object');
    return;
  }
  if (Object.keys(spec).length !== 1 || spec.unsafe_integers !== 'string') {
    add('error', 'composition_rest_response_json_unsafe_integers', `${specPath}.unsafe_integers`, "response_json must be exactly { unsafe_integers: 'string' }");
  }
  if (row.bind.response_capture !== undefined) {
    add('error', 'composition_rest_response_json_capture_conflict', specPath, 'response_json cannot be combined with response_capture because a captured body is not JSON-parsed');
  }
};

const DECIMAL_INTEGER_FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[\])?$/;

/** Validate exact decimal-string request serialization. The selector grammar
 * is deliberately top-level and closed because the connection adapter's body
 * model is a flat `body.<key>` map. */
const validateRestRequestJson = (
  row: Record<string, unknown>,
  path: string,
  add: AddIssue,
): void => {
  if (!isPlainObject(row.bind) || row.bind.kind !== 'rest') return;
  const spec = row.bind.request_json;
  if (spec === undefined) return;
  const specPath = `${path}.bind.request_json`;
  const selectors = isPlainObject(spec) && isStringArray(spec.decimal_integer_fields)
    ? spec.decimal_integer_fields
    : [];
  const shapeValid = isPlainObject(spec)
    && Object.keys(spec).length === 1
    && isStringArray(spec.decimal_integer_fields)
    && selectors.length > 0
    && new Set(selectors).size === selectors.length
    && selectors.every((field) => DECIMAL_INTEGER_FIELD_RE.test(field));
  if (!shapeValid) {
    add('error', 'composition_rest_request_json_decimal_integer_fields', specPath,
      'request_json must be exactly { decimal_integer_fields: [unique top-level field or field[] selectors] }');
  } else {
    const declaredArgs = new Map<string, string>();
    if (Array.isArray(row.args)) {
      for (const arg of row.args) {
        if (typeof arg === 'string' && arg.length > 0) declaredArgs.set(arg, 'string');
        else if (isPlainObject(arg) && isNonEmptyString(arg.key)) {
          declaredArgs.set(arg.key, typeof arg.type === 'string' ? arg.type : 'string');
        }
      }
    }
    const schema = isPlainObject(row.request_schema) ? row.request_schema : {};
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const selector of selectors) {
      const array = selector.endsWith('[]');
      const argKey = `body.${selector.replace(/\[\]$/, '')}`;
      const expectedType = array ? 'array' : 'string';
      if (declaredArgs.get(argKey) !== expectedType) {
        add('error', 'composition_rest_request_json_arg_mismatch', specPath,
          `request_json selector '${selector}' requires declared arg '${argKey}' with type '${expectedType}'`);
      }
      const property = properties[argKey];
      const schemaMatches = isPlainObject(property)
        && property.type === expectedType
        && (!array || (isPlainObject(property.items) && property.items.type === 'string'));
      if (!schemaMatches) {
        add('error', 'composition_rest_request_json_schema_mismatch', specPath,
          `request_json selector '${selector}' requires request_schema.properties['${argKey}'] to describe ${array ? 'an array of strings' : 'a string'}`);
      }
    }
  }
  if (!['POST', 'PUT', 'PATCH'].includes(String(row.bind.method))) {
    add('error', 'composition_rest_request_json_method', `${path}.bind.method`, 'request_json requires a body-carrying method (POST/PUT/PATCH)');
  }
  const headers = isPlainObject(row.bind.static_headers) ? row.bind.static_headers : {};
  const contentType = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  if (contentType !== undefined
    && (typeof contentType !== 'string'
      || contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')) {
    add('error', 'composition_rest_request_json_content_type', `${path}.bind.static_headers`, 'request_json requires application/json when a static Content-Type is declared');
  }
};

/** SMB-finance slice 3 — validate a cli `binding.input_materialize` (materialize
 *  a `file_ref` arg to a temp file the cli reads, docling `source`). Unlike
 *  `output_capture.dir_arg` (engine-owned), the materialized `arg` IS the
 *  caller-supplied input — it must be a declared editable_arg AND an argv token,
 *  and must not collide with an engine-owned `output_capture.dir_arg`. */
const validateCliInputMaterialize = (
  row: Record<string, unknown>,
  path: string,
  add: AddIssue,
): void => {
  if (!isPlainObject(row.bind) || row.bind.kind !== 'cli_invocation') return;
  const materialize = row.bind.input_materialize;
  const expandedArgs = cliArgvExpandedArgs(row.bind.argv_template);
  if (materialize === undefined) {
    for (const expandedArg of expandedArgs) {
      add('error', 'composition_cli_argv_expand_materialize', `${path}.bind.argv_template`, `argv_template expand_arg '${expandedArg}' requires input_materialize.kind 'file_ref_array' in D-189 v1`);
    }
    return;
  }
  const mPath = `${path}.bind.input_materialize`;
  if (!isPlainObject(materialize)) {
    add('error', 'composition_cli_input_materialize_shape', mPath, 'input_materialize must be an object');
    return;
  }
  if (materialize.kind !== 'file_ref' && materialize.kind !== 'file_ref_array') {
    add('error', 'composition_cli_input_materialize_kind', `${mPath}.kind`, "input_materialize.kind must be 'file_ref' or 'file_ref_array'");
  }
  // Content isolation (D-185 Slice 3 — keyed on `shape`): an input_materialize op
  // reads a file_ref's bytes into a temp file the cli consumes. A VALUE shape
  // (`text`/`json`/`jsonl`) captures stdout, which could echo those bytes back
  // into a recipe-readable op-step value, bypassing the Gateway-gated file_ref
  // read — so the op MUST NOT declare a value shape (its output, if any, flows
  // via output_capture's file_ref under `shape: 'ref'`).
  if (row.bind.shape !== undefined && row.bind.shape !== 'ref') {
    add('error', 'composition_cli_input_materialize_stdout', `${path}.bind.shape`, "an input_materialize op must not declare a value shape (text/json/jsonl) — captured stdout could echo the materialized file's bytes through op-step values, bypassing the Gateway-gated file_ref read; use shape: 'ref' (or omit) so stdout is discarded");
  }
  // Content isolation (D-172 I-4) — input_materialize is foreground-only. A
  // detached job redirects stdout AND stderr to an on-disk log (and returns its
  // log_path), re-opening the content-echo channel the foreground stderr
  // suppression closes (a materialize op's stderr can echo the input file's bytes
  // — ffmpeg/imagemagick metadata, verbose parser snippets). Mirrors the
  // detached + output_capture prohibition.
  if (row.bind.detached !== undefined) {
    add('error', 'composition_cli_input_materialize_detached', `${path}.bind.detached`, "an input_materialize op must not be detached — a detached job redirects stdout+stderr to a log file, re-opening the file-content echo channel; materialize is foreground-only");
  }
  const arg = materialize.arg;
  if (typeof arg !== 'string' || arg.length === 0) {
    add('error', 'composition_cli_input_materialize_arg', `${mPath}.arg`, 'input_materialize.arg must be a non-empty string');
    return;
  }
  if (materialize.kind === 'file_ref_array') {
    if (!cliArgvHasExpandArg(row.bind.argv_template, arg)) {
      add('error', 'composition_cli_input_materialize_arg', `${mPath}.arg`, `input_materialize.arg '${arg}' must appear as an argv_template { "expand_arg": "${arg}" } entry`);
    }
    const min = materialize.min_items;
    const max = materialize.max_items;
    if (min !== undefined && (typeof min !== 'number' || !Number.isInteger(min) || min < 1 || min > CLI_FILE_REF_ARRAY_MAX_ITEMS)) {
      add('error', 'composition_cli_input_materialize_bounds', `${mPath}.min_items`, `input_materialize.min_items must be an integer from 1 to ${CLI_FILE_REF_ARRAY_MAX_ITEMS}`);
    }
    if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > CLI_FILE_REF_ARRAY_MAX_ITEMS)) {
      add('error', 'composition_cli_input_materialize_bounds', `${mPath}.max_items`, `input_materialize.max_items must be an integer from 1 to ${CLI_FILE_REF_ARRAY_MAX_ITEMS}`);
    }
    if (typeof min === 'number' && typeof max === 'number' && Number.isInteger(min) && Number.isInteger(max) && max < min) {
      add('error', 'composition_cli_input_materialize_bounds', `${mPath}.max_items`, 'input_materialize.max_items must be greater than or equal to min_items');
    }
  } else if (!cliArgvHasScalarRef(row.bind.argv_template, arg)) {
    add('error', 'composition_cli_input_materialize_arg', `${mPath}.arg`, `input_materialize.arg '${arg}' must appear as a {${arg}} token in argv_template`);
  }
  for (const expandedArg of expandedArgs) {
    if (materialize.kind !== 'file_ref_array' || expandedArg !== arg) {
      add('error', 'composition_cli_argv_expand_materialize', `${path}.bind.argv_template`, `argv_template expand_arg '${expandedArg}' requires matching input_materialize.kind 'file_ref_array'`);
    }
  }
  if (!editableArgKeys(row.editable_args).has(arg)) {
    add('error', 'composition_cli_input_materialize_arg_editable', `${mPath}.arg`, `input_materialize.arg '${arg}' is caller-supplied (the file_ref) and must be declared in editable_args`);
  }
  const captureDirArg = isPlainObject(row.bind.output_capture) ? row.bind.output_capture.dir_arg : undefined;
  if (typeof captureDirArg === 'string' && captureDirArg === arg) {
    add('error', 'composition_cli_input_materialize_dir_arg_collision', `${mPath}.arg`, `input_materialize.arg '${arg}' must not be the same token as output_capture.dir_arg`);
  }
};

/** D-185 — validate `binding.shape` (the SOLE cli output declaration after
 *  Slice 3). `text`/`json`/`jsonl` capture stdout into a value; `ref` is the
 *  file-output shape and requires an `output_capture` (the `dir_arg`+`mime_type`).
 *  Omitted ⇒ exit-code-only, unvalidated. The stdout-capture mode is DERIVED from
 *  the shape (no `stdout_handling` to cross-check). */
const validateCliOutputShape = (
  row: Record<string, unknown>,
  path: string,
  add: AddIssue,
): void => {
  if (!isPlainObject(row.bind) || row.bind.kind !== 'cli_invocation') return;
  const shape = row.bind.shape;
  if (shape === undefined) return;
  const shapePath = `${path}.bind.shape`;
  if (typeof shape !== 'string' || !CLI_OUTPUT_SHAPES.includes(shape as CliOutputShape)) {
    add('error', 'composition_cli_output_shape_invalid', shapePath, `shape must be one of ${CLI_OUTPUT_SHAPES.join('|')}`);
    return;
  }
  if (shape === 'ref' && !isPlainObject(row.bind.output_capture)) {
    add('error', 'composition_cli_output_shape_ref_capture', shapePath, "shape: 'ref' requires an output_capture (file backing: dir_arg + mime_type); use a value shape (text|json|jsonl) for stdout output");
  }
};

/** D-185 Slice 2 — validate `binding.storage` (WHERE a ref-producing op's file
 *  lives: `cas` durable record_id, or `temp` run-scoped path). `storage`
 *  describes the file-backing of an `output_capture`, so it is meaningful ONLY
 *  with one — a `storage` on a stdout op is an authoring mistake. Absent ⇒ `cas`
 *  during the additive slices (D-185 §2), unvalidated. */
const validateCliOutputStorage = (
  row: Record<string, unknown>,
  path: string,
  add: AddIssue,
): void => {
  if (!isPlainObject(row.bind) || row.bind.kind !== 'cli_invocation') return;
  const storage = row.bind.storage;
  if (storage === undefined) return;
  const storagePath = `${path}.bind.storage`;
  if (typeof storage !== 'string' || !CLI_OUTPUT_STORAGES.includes(storage as CliOutputStorage)) {
    add('error', 'composition_cli_output_storage_invalid', storagePath, `storage must be one of ${CLI_OUTPUT_STORAGES.join('|')}`);
    return;
  }
  if (!isPlainObject(row.bind.output_capture)) {
    add('error', 'composition_cli_output_storage_no_capture', storagePath, `storage: '${storage}' describes a ref-producing op and requires an output_capture (file backing); a stdout op has no storage`);
  }
};

const isJsonScalar = (value: unknown): boolean =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

const validatePaginationPlacementParam = (
  raw: Record<string, unknown>,
  path: string,
  add: AddIssue,
): void => {
  if (!isOperationPaginationPlacement(raw.placement)) {
    add(
      'error',
      'composition_operation_pagination_placement_unknown',
      `${path}.placement`,
      `placement must be one of ${OPERATION_PAGINATION_PLACEMENTS.join(' | ')}`,
    );
  }
  if (!isNonEmptyString(raw.param)) {
    add('error', 'composition_operation_pagination_param_required', `${path}.param`, 'param must be a non-empty string');
  }
};

const validatePaginationPageSize = (
  raw: unknown,
  path: string,
  add: AddIssue,
): void => {
  if (!isPlainObject(raw)) {
    add('error', 'composition_operation_pagination_page_size_shape', path, 'page_size must be an object');
    return;
  }
  validatePaginationPlacementParam(raw, path, add);
  if (!Number.isInteger(raw.value) || (raw.value as number) <= 0) {
    add('error', 'composition_operation_pagination_page_size_value', `${path}.value`, 'value must be a positive integer');
  }
  if (raw.max !== undefined) {
    if (!Number.isInteger(raw.max) || (raw.max as number) <= 0) {
      add('error', 'composition_operation_pagination_page_size_max', `${path}.max`, 'max must be a positive integer when present');
    } else if (Number.isInteger(raw.value) && (raw.value as number) > (raw.max as number)) {
      add('error', 'composition_operation_pagination_page_size_over_max', `${path}.value`, 'value must be less than or equal to max');
    }
  }
};

/** D-192 #8g — graphql_relay's page size is a GraphQL VARIABLE (`{ variable,
 *  value }`), not a wire placement param. */
const validateGraphqlPaginationPageSize = (
  raw: unknown,
  path: string,
  add: AddIssue,
): void => {
  if (!isPlainObject(raw)) {
    add('error', 'composition_operation_pagination_page_size_shape', path, 'page_size must be an object');
    return;
  }
  if (!isNonEmptyString(raw.variable)) {
    add('error', 'composition_operation_pagination_page_size_variable', `${path}.variable`, 'variable must be a non-empty string');
  }
  if (!Number.isInteger(raw.value) || (raw.value as number) <= 0) {
    add('error', 'composition_operation_pagination_page_size_value', `${path}.value`, 'value must be a positive integer');
  }
};

const validatePaginationCondition = (
  raw: unknown,
  path: string,
  add: AddIssue,
): void => {
  if (!isPlainObject(raw)) {
    add('error', 'composition_operation_pagination_condition_shape', path, 'pagination condition must be an object');
    return;
  }
  if (!isNonEmptyString(raw.path)) {
    add('error', 'composition_operation_pagination_condition_path', `${path}.path`, 'path must be a non-empty string');
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'equals') || !isJsonScalar(raw.equals)) {
    add('error', 'composition_operation_pagination_condition_equals', `${path}.equals`, 'equals must be a JSON scalar');
  }
};

const validateOperationPagination = (
  raw: unknown,
  path: string,
  add: AddIssue,
): void => {
  if (!isPlainObject(raw)) {
    add('error', 'composition_operation_pagination_shape', path, 'pagination must be an object');
    return;
  }
  if (!isOperationPaginationStyle(raw.style)) {
    add(
      'error',
      'composition_operation_pagination_style_unknown',
      `${path}.style`,
      `pagination.style must be one of ${OPERATION_PAGINATION_STYLES.join(' | ')}`,
    );
    return;
  }
  // The placement page-size shape covers every style EXCEPT graphql_relay (whose
  // page size is a GraphQL variable, validated in its own branch).
  if (raw.style !== 'graphql_relay' && raw.page_size !== undefined) {
    validatePaginationPageSize(raw.page_size, `${path}.page_size`, add);
  }
  if (raw.style === 'body_cursor') {
    if (raw.next_when !== undefined) {
      validatePaginationCondition(raw.next_when, `${path}.next_when`, add);
    } else {
      add(
        'warn',
        'composition_operation_pagination_no_next_when',
        `${path}.next_when`,
        'body_cursor without next_when stops only on an empty final page (one extra upstream call per walk); declare the provider\'s has_more-style predicate when one exists',
      );
    }
    if (!isPlainObject(raw.cursor_from)) {
      add('error', 'composition_operation_pagination_cursor_from_shape', `${path}.cursor_from`, 'cursor_from must be an object');
    } else {
      if (!isNonEmptyString(raw.cursor_from.path)) {
        add('error', 'composition_operation_pagination_cursor_from_path', `${path}.cursor_from.path`, 'path must be a non-empty string');
      }
      if (typeof raw.cursor_from.select !== 'string' || !PAGINATION_SELECTOR_SET.has(raw.cursor_from.select)) {
        add('error', 'composition_operation_pagination_cursor_from_select', `${path}.cursor_from.select`, 'select must be first or last');
      }
      if (!isNonEmptyString(raw.cursor_from.field)) {
        add('error', 'composition_operation_pagination_cursor_from_field', `${path}.cursor_from.field`, 'field must be a non-empty string');
      }
    }
    if (!isPlainObject(raw.cursor_to)) {
      add('error', 'composition_operation_pagination_cursor_to_shape', `${path}.cursor_to`, 'cursor_to must be an object');
    } else {
      validatePaginationPlacementParam(raw.cursor_to, `${path}.cursor_to`, add);
    }
    return;
  }
  if (raw.style === 'query_token') {
    if (!isNonEmptyString(raw.token_from)) {
      add('error', 'composition_operation_pagination_token_from', `${path}.token_from`, 'token_from must be a non-empty string');
    }
    if (!isPlainObject(raw.token_to)) {
      add('error', 'composition_operation_pagination_token_to_shape', `${path}.token_to`, 'token_to must be an object');
    } else {
      validatePaginationPlacementParam(raw.token_to, `${path}.token_to`, add);
    }
    if (raw.done_when !== undefined) validatePaginationCondition(raw.done_when, `${path}.done_when`, add);
    return;
  }
  if (raw.style === 'query_token_link') {
    if (!isNonEmptyString(raw.link_from)) {
      add('error', 'composition_operation_pagination_link_from', `${path}.link_from`, 'link_from must be a non-empty string');
    }
    if (!isNonEmptyString(raw.query_param)) {
      add('error', 'composition_operation_pagination_query_param', `${path}.query_param`, 'query_param must be a non-empty string');
    }
    if (!isPlainObject(raw.token_to)) {
      add('error', 'composition_operation_pagination_token_to_shape', `${path}.token_to`, 'token_to must be an object');
    } else {
      validatePaginationPlacementParam(raw.token_to, `${path}.token_to`, add);
    }
    if (raw.done_when !== undefined) validatePaginationCondition(raw.done_when, `${path}.done_when`, add);
    return;
  }
  if (raw.style === 'offset') {
    if (raw.increment === 'by_page_size' && raw.page_size === undefined) {
      add('error', 'composition_operation_pagination_offset_page_size', `${path}.page_size`, 'offset pagination with increment by_page_size requires page_size (the per-cycle record advance)');
    }
    if (!isPlainObject(raw.param)) {
      add('error', 'composition_operation_pagination_offset_param_shape', `${path}.param`, 'param must be an object');
    } else {
      validatePaginationPlacementParam(raw.param, `${path}.param`, add);
    }
    if (!Number.isInteger(raw.start) || (raw.start as number) < 0) {
      add('error', 'composition_operation_pagination_offset_start', `${path}.start`, 'start must be a non-negative integer');
    }
    if (raw.increment !== 'page' && raw.increment !== 'by_page_size') {
      add('error', 'composition_operation_pagination_offset_increment', `${path}.increment`, 'increment must be page or by_page_size');
    }
    if (raw.done_when !== undefined) validatePaginationCondition(raw.done_when, `${path}.done_when`, add);
    return;
  }
  if (raw.style === 'graphql_relay') {
    if (raw.page_size !== undefined) validateGraphqlPaginationPageSize(raw.page_size, `${path}.page_size`, add);
    if (!isNonEmptyString(raw.page_info_path)) {
      add('error', 'composition_operation_pagination_page_info_path', `${path}.page_info_path`, 'page_info_path must be a non-empty string');
    }
    if (!isNonEmptyString(raw.cursor_variable)) {
      add('error', 'composition_operation_pagination_cursor_variable', `${path}.cursor_variable`, 'cursor_variable must be a non-empty string');
    }
    if (raw.has_next_field !== undefined && !isNonEmptyString(raw.has_next_field)) {
      add('error', 'composition_operation_pagination_has_next_field', `${path}.has_next_field`, 'has_next_field must be a non-empty string when present');
    }
    if (raw.end_cursor_field !== undefined && !isNonEmptyString(raw.end_cursor_field)) {
      add('error', 'composition_operation_pagination_end_cursor_field', `${path}.end_cursor_field`, 'end_cursor_field must be a non-empty string when present');
    }
    return;
  }
  if (raw.style === 'single_page') {
    // No required fields — asserts the whole set arrives in one call.
    return;
  }
  if (raw.style === 'next_path') {
    if (!isNonEmptyString(raw.path)) {
      add('error', 'composition_operation_pagination_next_path', `${path}.path`, 'path must be a non-empty string');
    }
    if (raw.done_when !== undefined) validatePaginationCondition(raw.done_when, `${path}.done_when`, add);
    if (raw.path_prefix !== undefined && !isNonEmptyString(raw.path_prefix)) {
      add('error', 'composition_operation_pagination_path_prefix', `${path}.path_prefix`, 'path_prefix must be a non-empty string when present');
    }
    return;
  }
  if (raw.header !== undefined && !isNonEmptyString(raw.header)) {
    add('error', 'composition_operation_pagination_header', `${path}.header`, 'header must be a non-empty string when present');
  }
};

const OPERATION_ARG_TYPES: ReadonlySet<string> = new Set([
  'string', 'number', 'boolean', 'object', 'array', 'file_ref', 'file_ref[]',
]);

/** Validate an operation's `args[]` — each entry is a bare key string (a
 *  required string arg) or an `{ key, type?, required?, affects_target? }`
 *  object. */
const validateOperationArgs = (raw: unknown, path: string, add: AddIssue): void => {
  if (!Array.isArray(raw)) {
    add('error', 'composition_operation_args_shape', path, 'args must be an array when present');
    return;
  }
  raw.forEach((entry, idx) => {
    const p = `${path}[${idx}]`;
    if (typeof entry === 'string') {
      if (entry.length === 0) {
        add('error', 'composition_operation_arg_key', p, 'a bare arg entry must be a non-empty key string');
      }
      return;
    }
    if (!isPlainObject(entry)) {
      add('error', 'composition_operation_arg_shape', p, 'arg must be a string key or an object');
      return;
    }
    if (!isNonEmptyString(entry.key)) {
      add('error', 'composition_operation_arg_key', `${p}.key`, 'arg.key must be a non-empty string');
    }
    if (entry.type !== undefined && (typeof entry.type !== 'string' || !OPERATION_ARG_TYPES.has(entry.type))) {
      add('error', 'composition_operation_arg_type', `${p}.type`,
        `arg.type must be one of ${[...OPERATION_ARG_TYPES].join(' | ')} when present`);
    }
    if (entry.affects_target !== undefined && typeof entry.affects_target !== 'boolean') {
      add('error', 'composition_operation_arg_affects_target', `${p}.affects_target`,
        'arg.affects_target must be a boolean when present');
    }
    if (entry.required !== undefined && typeof entry.required !== 'boolean') {
      add('error', 'composition_operation_arg_required', `${p}.required`,
        'arg.required must be a boolean when present');
    }
  });
};

/**
 * A closed schema is the runtime wire allowlist, while `args[]` is the
 * authoring declaration. Require those two views to agree so a schema-only key
 * cannot escape review of its type/target annotation, and so an authored
 * required arg cannot silently become optional (or vice versa) at dispatch.
 */
const validateClosedRequestSchemaArgAlignment = (
  row: Record<string, unknown>,
  path: string,
  add: AddIssue,
): void => {
  if (!isClosedRequestSchema(row.request_schema)) return;
  const schema = row.request_schema as Record<string, unknown>;
  if (!isPlainObject(schema.properties)) return;
  const rawArgs = row.args === undefined ? [] : row.args;
  if (!Array.isArray(rawArgs)) return;

  const declared = new Map<string, { type: string; required: boolean }>();
  for (const entry of rawArgs) {
    if (typeof entry === 'string') {
      if (entry.length > 0) declared.set(entry, { type: 'string', required: true });
      continue;
    }
    if (!isPlainObject(entry) || !isNonEmptyString(entry.key)) continue;
    declared.set(entry.key, {
      type: typeof entry.type === 'string' ? entry.type : 'string',
      required: entry.required === true,
    });
  }

  const schemaRequired = Array.isArray(schema.required)
    && schema.required.every((value) => typeof value === 'string')
    ? new Set(schema.required as string[])
    : undefined;
  for (const [key, arg] of declared) {
    const rawProperty = schema.properties[key];
    if (!isPlainObject(rawProperty)) {
      add(
        'error',
        'composition_operation_closed_request_schema_arg_alignment',
        `${path}.request_schema.properties`,
        `declared arg '${key}' must have one closed-schema property`,
      );
      continue;
    }
    const schemaType = rawProperty.type;
    const typeMatches = schemaType === arg.type
      || (arg.type === 'number' && schemaType === 'integer');
    if (!typeMatches) {
      add(
        'error',
        'composition_operation_closed_request_schema_arg_alignment',
        `${path}.request_schema.properties`,
        `declared arg '${key}' type '${arg.type}' does not match schema type '${String(schemaType)}'`,
      );
    }
    if (schemaRequired !== undefined && arg.required !== schemaRequired.has(key)) {
      add(
        'error',
        'composition_operation_closed_request_schema_arg_alignment',
        `${path}.request_schema.required`,
        `declared arg '${key}' required=${String(arg.required)} does not match the closed schema`,
      );
    }
  }
  for (const key of Object.keys(schema.properties)) {
    if (!declared.has(key)) {
      add(
        'error',
        'composition_operation_closed_request_schema_arg_alignment',
        `${path}.request_schema.properties`,
        `closed-schema property '${key}' is not declared in args`,
      );
    }
  }
};

/** Per-ingredient shared-config cell validation — exactly the cell matching the
 *  ingredient's `kind` must be present + well-formed (the kinds the by-value
 *  packs use: `cli` / `http` / `connection`; `mcp` is optional, others need
 *  nothing shared). The legacy `auth` / `surfaces_seed` checks fold here:
 *  the cli tool + readiness probe, the http base + connection-kind + search /
 *  write dialect. */
/** The ingredient kinds the composition decomposer lowers today (cli → connector
 *  surface; http / connection → api surface). Other `OpKind`s gain handlers in
 *  slice 5. */
const DECOMPOSABLE_INGREDIENT_KINDS: ReadonlySet<string> = new Set(['cli', 'http', 'connection']);

/** The per-kind config-cell keys. Exactly the cell matching the ingredient's
 *  kind may be present — a stale mismatched cell (e.g. an `http.connection` on a
 *  `cli` ingredient) would otherwise leak into the connection/grant binding. */
const INGREDIENT_CONFIG_CELLS = ['cli', 'http', 'connection', 'mcp'] as const;

const validateIngredientConfigCell = (
  ing: Record<string, unknown>,
  kind: string,
  path: string,
  add: AddIssue,
): void => {
  // Kind-cell exclusivity: a cli ingredient must not carry an http/connection
  // cell, etc. (`compositionConnectionName` reads `http.connection` before
  // `connection.connection`, so a stray cell silently changes the binding).
  for (const cell of INGREDIENT_CONFIG_CELLS) {
    if (cell !== kind && ing[cell] !== undefined) {
      add('error', 'composition_ingredient_cell_mismatch', `${path}.${cell}`,
        `a '${kind}' ingredient must not declare a '${cell}' config cell`);
    }
  }
  if (kind === 'cli') {
    if (!isPlainObject(ing.cli)) {
      add('error', 'composition_ingredient_cli_required', `${path}.cli`, 'a cli ingredient must declare a cli config cell');
      return;
    }
    const cli = ing.cli;
    if (!isNonEmptyString(cli.tool)) {
      add('error', 'composition_ingredient_cli_tool_required', `${path}.cli.tool`, 'cli.tool is required');
    }
    if (!isStringArray(cli.probe) || cli.probe.length === 0) {
      add('error', 'composition_ingredient_cli_probe_required', `${path}.cli.probe`, 'cli.probe must be a non-empty string array');
    }
    for (const key of ['config_dir', 'profile', 'package_ref', 'entry_point'] as const) {
      if (cli[key] !== undefined && typeof cli[key] !== 'string') {
        add('error', 'composition_ingredient_cli_field_shape', `${path}.cli.${key}`, `cli.${key} must be a string when present`);
      }
    }
    return;
  }
  if (kind === 'http') {
    if (!isPlainObject(ing.http)) {
      add('error', 'composition_ingredient_http_required', `${path}.http`, 'an http ingredient must declare an http config cell');
      return;
    }
    const http = ing.http;
    if (!isNonEmptyString(http.base)) {
      add('error', 'composition_ingredient_http_base_required', `${path}.http.base`, 'http.base is required');
    }
    if (http.connection !== undefined && !isNonEmptyString(http.connection)) {
      add('error', 'composition_ingredient_http_connection_shape', `${path}.http.connection`, 'http.connection must be a non-empty string when present');
    }
    if (http.result_path !== undefined && typeof http.result_path !== 'string') {
      add('error', 'composition_ingredient_http_result_path_shape', `${path}.http.result_path`, 'http.result_path must be a string when present');
    }
    // The search / write DIALECTs are closed lists (each selects a reviewed
    // builder); a bogus value would otherwise reach the resolver and fail
    // closed there with a less precise message.
    if (http.search_style !== undefined && !isSearchStyle(http.search_style)) {
      add('error', 'composition_search_style_unknown', `${path}.http.search_style`,
        `search_style must be one of ${SEARCH_STYLES.join(' | ')} when present`);
    }
    if (http.write_style !== undefined && !isWriteStyle(http.write_style)) {
      add('error', 'composition_write_style_unknown', `${path}.http.write_style`,
        `write_style must be one of ${WRITE_STYLES.join(' | ')} when present`);
    }
    if (http.pagination_style !== undefined && !isPaginationStyle(http.pagination_style)) {
      add('error', 'composition_pagination_style_unknown', `${path}.http.pagination_style`,
        `pagination_style must be one of ${PAGINATION_STYLES.join(' | ')} when present`);
    }
    // D-192 work-entity Source — the pinned schema-source document(s) the
    // decomposer carries onto `surfaces.api.<kind>_source`. Shape-accept only
    // here: `{ url, sha256 }` objects. The pin-EQUALITY + op-provability + sha
    // FORMAT gates run in `validateWorkEntitySources` over the decomposed
    // catalog (this section validator must not duplicate them).
    for (const pin of ['openapi_source', 'graphql_schema_source', 'google_discovery_source'] as const) {
      const ref = http[pin];
      if (ref === undefined) continue;
      if (!isPlainObject(ref) || !isNonEmptyString(ref.url) || !isNonEmptyString(ref.sha256)) {
        add('error', 'composition_http_schema_source_shape', `${path}.http.${pin}`,
          `http.${pin} must be a { url, sha256 } schema-source pin when present`);
      }
    }
    return;
  }
  if (kind === 'connection') {
    if (!isPlainObject(ing.connection)) {
      add('error', 'composition_ingredient_connection_required', `${path}.connection`, 'a connection ingredient must declare a connection config cell');
      return;
    }
    if (!isNonEmptyString(ing.connection.connection)) {
      add('error', 'composition_ingredient_connection_name_required', `${path}.connection.connection`, 'connection.connection is required');
    }
  }
};

interface DeferredFieldOpRef {
  path: string;
  ref: string;
}

/** Validate one ingredient's nested `entities` map (the vendor surface schema).
 *  Absorbs the legacy flat-`entity_fields` checks: required field columns,
 *  the entity-level `crm_alias` / `acct_alias` (validity + mutual exclusion +
 *  within-composition uniqueness, tracked across ingredients via the shared
 *  `crmOwner` / `acctOwner` maps), `date_granularity`, and the canonical-field
 *  portability warning. `source_operation` refs are DEFERRED (collected into
 *  `fieldOps`) so they can be checked once the operation set is known. Returns
 *  the field count contributed by this ingredient (for the global cap). */
const validateIngredientEntities = (
  ing: Record<string, unknown>,
  path: string,
  crmOwner: Map<string, string>,
  acctOwner: Map<string, string>,
  fieldOps: DeferredFieldOpRef[],
  add: AddIssue,
): number => {
  if (ing.entities === undefined) return 0;
  if (!isPlainObject(ing.entities)) {
    add('error', 'composition_ingredient_entities_shape', `${path}.entities`, 'entities must be an object keyed by entity id');
    return 0;
  }
  let fieldCount = 0;
  const seenEntityKeys = new Set<string>();
  for (const [rawEntityId, entityVal] of Object.entries(ing.entities)) {
    const ePath = `${path}.entities.${rawEntityId}`;
    if (!isPlainObject(entityVal)) {
      add('error', 'composition_entity_shape', ePath, 'entity must be an object');
      continue;
    }
    const entity = entityVal;
    const entityKey = normalizeEntityId(rawEntityId);
    // Two raw keys that normalize to the same id (`Deal` / `deal`) would
    // decompose to duplicate entity schemas (same `entity_id` + `scope`) and let
    // split crm/acct-alias declarations dodge the per-entity conflict check.
    if (seenEntityKeys.has(entityKey)) {
      add('error', 'composition_entity_key_duplicate', ePath,
        `entity key '${rawEntityId}' normalizes to '${entityKey}', which another entity in this ingredient already uses`);
      continue;
    }
    seenEntityKeys.add(entityKey);

    let crm: string | undefined;
    let acct: string | undefined;
    if (entity.crm_alias !== undefined) {
      if (typeof entity.crm_alias !== 'string' || !CRM_ALIAS_SET.has(entity.crm_alias)) {
        add('error', 'composition_entity_crm_alias_invalid', `${ePath}.crm_alias`,
          `crm_alias must be one of ${[...CRM_ALIAS_VALUES].join(' / ')} when present`);
      } else {
        crm = entity.crm_alias;
      }
    }
    if (entity.acct_alias !== undefined) {
      if (typeof entity.acct_alias !== 'string' || !ACCT_ALIAS_SET.has(entity.acct_alias)) {
        add('error', 'composition_entity_acct_alias_invalid', `${ePath}.acct_alias`,
          `acct_alias must be one of ${[...ACCT_ALIAS_VALUES].join(' / ')} when present`);
      } else {
        acct = entity.acct_alias;
      }
    }
    if (crm !== undefined && acct !== undefined) {
      add('error', 'composition_entity_alias_domain_conflict', ePath,
        `entity '${rawEntityId}' declares BOTH a crm_alias and an acct_alias — an entity is CRM-canonical or accounting-canonical, not both`);
    }
    if (crm !== undefined) {
      const prior = crmOwner.get(crm);
      if (prior !== undefined && prior !== entityKey) {
        add('error', 'composition_entity_crm_alias_duplicate', ePath,
          `crm_alias '${crm}' is claimed by both '${prior}' and '${entityKey}' — within one composition each crm_alias may name at most one entity`);
      } else {
        crmOwner.set(crm, entityKey);
      }
    }
    if (acct !== undefined) {
      const prior = acctOwner.get(acct);
      if (prior !== undefined && prior !== entityKey) {
        add('error', 'composition_entity_acct_alias_duplicate', ePath,
          `acct_alias '${acct}' is claimed by both '${prior}' and '${entityKey}' — within one composition each acct_alias may name at most one entity`);
      } else {
        acctOwner.set(acct, entityKey);
      }
    }

    // D-192 engagement facet — per-entity SHAPE + 3-way mutual exclusion (an
    // entity is CRM-canonical, accounting-canonical, OR an engagement, never more
    // than one). The per-VENDOR cross-entry invariants (one sync_kind / one
    // daily_budget / uniform group capability) are enforced on the merged live
    // registry at lift time (`assertEngagementRegistryInvariants`), mirroring how
    // crm_alias cross-entry uniqueness lives in `assertConnectionVendorRegistry`.
    if (entity.engagement !== undefined) {
      for (const issue of assertEngagementFacetShape(entity.engagement)) {
        add('error', 'composition_entity_engagement_invalid', `${ePath}.engagement`, issue);
      }
      if (crm !== undefined || acct !== undefined) {
        add('error', 'composition_entity_alias_domain_conflict', ePath,
          `entity '${rawEntityId}' declares an engagement facet AND a ${crm !== undefined ? 'crm_alias' : 'acct_alias'} — an entity is CRM-canonical, accounting-canonical, or an engagement, not more than one`);
      }
    }

    if (!Array.isArray(entity.fields)) {
      add('error', 'composition_entity_fields_shape', `${ePath}.fields`, 'entity fields must be an array');
      continue;
    }
    // D-190 Slice 3 — canonical maps_to values seen on this entity, for the
    // required-canonical-field check after the field loop.
    const seenCrmMapsTo = new Set<string>();
    entity.fields.forEach((fEntry, fIdx) => {
      const fPath = `${ePath}.fields[${fIdx}]`;
      fieldCount += 1;
      if (!isPlainObject(fEntry)) {
        add('error', 'composition_entity_field_row_shape', fPath, 'entity field must be an object');
        return;
      }
      const field = fEntry;
      for (const key of ['field_path', 'type', 'maps_to'] as const) {
        if (!isNonEmptyString(field[key])) {
          add('error', 'composition_entity_field_required', `${fPath}.${key}`, `${key} must be a non-empty string`);
        }
      }
      if (field.source_operation !== undefined) {
        if (!isNonEmptyString(field.source_operation)) {
          add('error', 'composition_entity_field_operation_ref', `${fPath}.source_operation`, 'source_operation must reference a declared operation');
        } else {
          fieldOps.push({ path: `${fPath}.source_operation`, ref: field.source_operation });
        }
      }
      if (field.date_granularity !== undefined) {
        if (!isDateGranularity(field.date_granularity)) {
          add('error', 'composition_entity_field_date_granularity_invalid', `${fPath}.date_granularity`,
            `date_granularity must be 'date' or 'datetime' when present`);
        } else if (field.type !== 'datetime') {
          add('error', 'composition_entity_field_date_granularity_type', `${fPath}.date_granularity`,
            `date_granularity is only valid on a 'datetime' field (got type '${String(field.type)}')`);
        }
      }
      // Portability — a crm_alias entity's fields should map to canonical
      // convention fields; a non-canonical maps_to is a non-portable vendor
      // extra (a recipe reading canonical fields won't see it). Quality → warn.
      // D-190 Slice 3: a canonical maps_to ALSO carries a typed contract — a type
      // divergence is a real cross-vendor break (error, fork B-split). The
      // unknown-name warn and the type error are mutually exclusive: a name not
      // in the convention has no type to honour.
      if (crm !== undefined && isNonEmptyString(field.maps_to)) {
        const crmAlias = crm as CrmAlias;
        // A canonical mapping declared twice on one entity makes the projection
        // ambiguous (and would mask the required-field check below). Quality → warn.
        if (seenCrmMapsTo.has(field.maps_to)) {
          add('warn', 'composition_entity_field_crm_alias_duplicate_maps_to', `${fPath}.maps_to`,
            `maps_to '${field.maps_to}' is declared by more than one field on this '${crm}' entity — the canonical projection is ambiguous`);
        }
        seenCrmMapsTo.add(field.maps_to);
        if (!canonicalCrmFieldSet(crmAlias).has(field.maps_to)) {
          add('warn', 'composition_entity_field_crm_alias_noncanonical', `${fPath}.maps_to`,
            `maps_to '${field.maps_to}' is not a canonical '${crm}' field — recipes reading canonical fields won't see it (non-portable vendor extra)`);
        } else if (isMetaFieldType(field.type) && !crmFieldPackTypeConforms(crmAlias, field.maps_to, field.type)) {
          add('error', 'composition_entity_field_crm_alias_type_mismatch', `${fPath}.type`,
            `canonical '${crm}' field '${field.maps_to}' must be ${canonicalCrmFieldTypeLabel(crmAlias, field.maps_to)} (got '${String(field.type)}')`);
        }
      }
    });
    // D-190 Slice 3 — required canonical fields. A crm_alias entity that omits a
    // required canonical field is a portability gap (a cross-vendor recipe reads
    // undefined) → warn, never an authoring error (fork B-split).
    if (crm !== undefined) {
      for (const req of requiredCanonicalCrmFields(crm as CrmAlias)) {
        if (!seenCrmMapsTo.has(req)) {
          add('warn', 'composition_entity_crm_alias_missing_required', ePath,
            `crm_alias '${crm}' entity is missing required canonical field '${req}' — a cross-vendor recipe reading it will get undefined`);
        }
      }
    }
  }
  return fieldCount;
};

interface ValidatedIngredients {
  slugs: Set<string>;
  kindBySlug: Map<string, string>;
  /** Per-cli-ingredient declared launched binary, mirroring the decomposer's
   *  `entry_point ?? tool ?? composition.slug` — the literal `argv[0]` must
   *  equal (the catalog validator re-checks against the stamped
   *  `runtime.entry_point` post-decompose). */
  declaredToolBySlug: Map<string, string>;
  fieldOps: DeferredFieldOpRef[];
}

/** D-182 §4 Table A — validate `ingredients[]`: each row's slug + `kind`
 *  (∈ `OP_KINDS`) + the kind-matching config cell + its nested entity schema.
 *  Returns the declared slugs + per-slug kind (so `validateOperations` can gate
 *  each op's `bind` by its ingredient's kind) + the deferred entity-field
 *  `source_operation` refs (checked against the op set by the caller). */
const validateIngredients = (
  raw: Record<string, unknown>,
  add: AddIssue,
): ValidatedIngredients => {
  const slugs = new Set<string>();
  const kindBySlug = new Map<string, string>();
  const declaredToolBySlug = new Map<string, string>();
  const fieldOps: DeferredFieldOpRef[] = [];
  const crmOwner = new Map<string, string>();
  const acctOwner = new Map<string, string>();
  const compositionSlug = isNonEmptyString(raw.slug) ? raw.slug : undefined;
  if (!Array.isArray(raw.ingredients)) {
    add('error', 'composition_ingredients_shape', 'ingredients', 'ingredients must be an array');
    return { slugs, kindBySlug, declaredToolBySlug, fieldOps };
  }
  if (raw.ingredients.length === 0) {
    add('error', 'composition_ingredients_empty', 'ingredients', 'ingredients must contain at least one row');
  }
  // The decomposer builds the catalog surface (base_url / connection / runtime)
  // from a SINGLE ingredient (`ingredients[0]`); a multi-ingredient composition
  // would silently lower every op under the first ingredient's surface. Enforce
  // the single-ingredient invariant the contract documents until the decomposer
  // grows multi-surface support.
  if (raw.ingredients.length > 1) {
    add('error', 'composition_ingredients_too_many', 'ingredients',
      'a composition declares exactly one ingredient (the decomposer builds the catalog surface from a single ingredient)');
  }
  let fieldCount = 0;
  raw.ingredients.forEach((entry, idx) => {
    const path = `ingredients[${idx}]`;
    if (!isPlainObject(entry)) {
      add('error', 'composition_ingredient_row_shape', path, 'ingredient row must be an object');
      return;
    }
    const ing = entry;
    if (!isNonEmptyString(ing.slug)) {
      add('error', 'composition_ingredient_slug_required', `${path}.slug`, 'slug must be a non-empty string');
    } else if (!SLUG_RE.test(ing.slug)) {
      add('error', 'composition_ingredient_slug_format', `${path}.slug`, `slug must match ${SLUG_RE.source}`);
    } else if (slugs.has(ing.slug)) {
      add('error', 'composition_ingredient_slug_duplicate', `${path}.slug`, `ingredient slug '${ing.slug}' is duplicated`);
    } else {
      slugs.add(ing.slug);
    }
    if (!isOpKind(ing.kind)) {
      add('error', 'composition_ingredient_kind_unknown', `${path}.kind`, `kind must be one of ${OP_KINDS.join(' | ')}`);
    } else {
      // Only `cli` / `http` / `connection` are lowered by the decomposer today
      // (cli → connector surface; http/connection → api surface). Any other
      // OpKind (ai/dom/chat/mcp/service/storage) would mis-lower as an api
      // catalog — fail closed until the per-kind handlers land (slice 5).
      if (!DECOMPOSABLE_INGREDIENT_KINDS.has(ing.kind)) {
        add('error', 'composition_ingredient_kind_unsupported', `${path}.kind`,
          `kind '${ing.kind}' is not yet decomposable in a composition (supported: ${[...DECOMPOSABLE_INGREDIENT_KINDS].join(' | ')})`);
      }
      if (isNonEmptyString(ing.slug)) kindBySlug.set(ing.slug, ing.kind);
      validateIngredientConfigCell(ing, ing.kind, path, add);
      // Capture the cli ingredient's declared launched binary for the op-level
      // argv[0] pin (mirrors the decomposer's `entry_point ?? tool ?? slug`).
      if (ing.kind === 'cli' && isNonEmptyString(ing.slug)) {
        const cli = isPlainObject(ing.cli) ? ing.cli : undefined;
        const tool = cli && isNonEmptyString(cli.entry_point)
          ? cli.entry_point
          : cli && isNonEmptyString(cli.tool)
            ? cli.tool
            : compositionSlug;
        if (tool !== undefined) declaredToolBySlug.set(ing.slug, tool);
      }
    }
    fieldCount += validateIngredientEntities(ing, path, crmOwner, acctOwner, fieldOps, add);
  });
  if (fieldCount > COMPOSITION_MAX_FIELDS) {
    add('error', 'composition_fields_too_many', 'ingredients',
      `a composition may declare at most ${COMPOSITION_MAX_FIELDS} entity fields across its ingredients`);
  }
  return { slugs, kindBySlug, declaredToolBySlug, fieldOps };
};

/** D-182 §4 Table B — validate `operations[]`: each op's `op` id (unique),
 *  `ingredient` join (must name a declared ingredient), `bind` (shape gated by
 *  the ingredient's kind — connector binding for `cli`, api binding for
 *  `http` / `connection`), `risk` + `approval`, `out`, optional `args` +
 *  `required_scopes` + `pagination`. Returns the declared op-id set. */
const validateOperations = (
  raw: Record<string, unknown>,
  ingredientSlugs: Set<string>,
  kindBySlug: Map<string, string>,
  declaredToolBySlug: Map<string, string>,
  add: AddIssue,
): Set<string> => {
  const operations = new Set<string>();
  if (!Array.isArray(raw.operations)) {
    add('error', 'composition_operations_shape', 'operations', 'operations must be an array');
    return operations;
  }
  if (raw.operations.length === 0) {
    add('error', 'composition_operations_empty', 'operations', 'operations must contain at least one row');
  }
  if (raw.operations.length > COMPOSITION_MAX_OPERATIONS) {
    add('error', 'composition_operations_too_many', 'operations',
      `operations may contain at most ${COMPOSITION_MAX_OPERATIONS} rows`);
  }
  raw.operations.forEach((entry, idx) => {
    const path = `operations[${idx}]`;
    if (!isPlainObject(entry)) {
      add('error', 'composition_operation_row_shape', path, 'operation row must be an object');
      return;
    }
    const row = entry;
    if (!isNonEmptyString(row.op)) {
      add('error', 'composition_operation_op_required', `${path}.op`, 'op must be a non-empty string');
    } else {
      if (operations.has(row.op)) {
        add('error', 'composition_operation_duplicate', `${path}.op`, `op '${row.op}' is duplicated`);
      }
      operations.add(row.op);
    }
    let kind: string | undefined;
    if (!isNonEmptyString(row.ingredient)) {
      add('error', 'composition_operation_ingredient_required', `${path}.ingredient`, 'ingredient must be a non-empty string');
    } else if (!ingredientSlugs.has(row.ingredient)) {
      add('error', 'composition_operation_ingredient_ref', `${path}.ingredient`,
        `ingredient '${row.ingredient}' is not a declared ingredient`);
    } else {
      kind = kindBySlug.get(row.ingredient);
    }
    if (!isPlainObject(row.bind)) {
      add('error', 'composition_operation_bind_shape', `${path}.bind`, 'operation bind must be an object');
    } else if (kind === 'cli') {
      const bindKind = row.bind.kind;
      if (bindKind !== 'method_call' && bindKind !== 'cli_invocation') {
        add('error', 'composition_operation_bind_kind', `${path}.bind.kind`, 'a cli ingredient operation requires a method_call or cli_invocation bind');
      }
      if (bindKind === 'cli_invocation') {
        if (!isCliArgvTemplate(row.bind.argv_template)) {
          add(
            'error',
            'composition_cli_argv_template_shape',
            `${path}.bind.argv_template`,
            'cli argv_template must be a non-empty array of string tokens or { "expand_arg": "<arg>" } entries',
          );
        } else {
          validateCliArgvTemplate(
            row.bind.argv_template,
            isNonEmptyString(row.ingredient) ? declaredToolBySlug.get(row.ingredient) : undefined,
            `${path}.bind.argv_template`,
            add,
          );
        }
      }
      if (bindKind === 'cli_invocation') {
        validateCliCwd(row, path, add);
        validateCliOutputCapture(row, path, add);
        validateCliInputMaterialize(row, path, add);
        validateCliOutputShape(row, path, add);
        validateCliOutputStorage(row, path, add);
      }
    } else if (kind === 'http' || kind === 'connection') {
      const bindKind = row.bind.kind;
      const apiKinds = new Set(['rest', 'graphql', 'webhook_subscription', 'queue_subscription', 'push_channel']);
      if (typeof bindKind !== 'string' || !apiKinds.has(bindKind)) {
        add('error', 'composition_operation_bind_kind', `${path}.bind.kind`, 'an http/connection ingredient operation has an invalid bind kind');
      }
      if (bindKind === 'rest') {
        validateRestResponseCapture(row, path, add);
        validateRestResponseJson(row, path, add);
        validateRestRequestJson(row, path, add);
      }
    }
    const risk = row.risk;
    if (typeof risk !== 'string' || !KIND_ALLOWED_TIERS.connection.has(risk as never)) {
      add('error', 'composition_operation_risk_invalid', `${path}.risk`, 'risk must be one of read|write|admin|destructive');
    }
    if (typeof row.approval !== 'string' || !OPERATION_APPROVALS.has(row.approval as OperationApproval)) {
      add('error', 'composition_operation_approval_invalid', `${path}.approval`, 'approval must be one of never|ask|always');
    }
    // D-185 Slice 3b — the `out` required-non-empty rule is RETIRED (the field is gone).
    if (row.args !== undefined) {
      validateOperationArgs(row.args, `${path}.args`, add);
    }
    validateClosedRequestSchemaArgAlignment(row, path, add);
    if (row.required_scopes !== undefined && !isStringArray(row.required_scopes)) {
      add('error', 'composition_operation_required_scopes_shape', `${path}.required_scopes`, 'required_scopes must be a string array when present');
    }
    validateDetachedCliPatternRefs(row, path, add);
    validateDetachedSupervision(row, path, add);
    if (row.pagination !== undefined) {
      if (row.risk !== 'read') {
        add('error', 'composition_operation_pagination_non_read', `${path}.pagination`,
          'pagination may only be declared on read-tier operations');
      }
      validateOperationPagination(row.pagination, `${path}.pagination`, add);
    }
  });
  return operations;
};

/** D-182 §4 (3b) — validate `recipe_templates[]` (renamed from
 *  `workflow_families`; same shape): each row's canonical template, declared-op
 *  `operation` + `sync_target.write_back_op` refs, trigger shape, and the
 *  per-template optional-hole allowlist. */
const validateRecipeTemplateRows = (
  raw: Record<string, unknown>,
  operationKeys: Set<string>,
  add: AddIssue,
): void => {
  if (raw.recipe_templates === undefined) return;
  if (!Array.isArray(raw.recipe_templates)) {
    add('error', 'composition_recipe_templates_shape', 'recipe_templates', 'recipe_templates must be an array when present');
    return;
  }

  raw.recipe_templates.forEach((entry, idx) => {
    const path = `recipe_templates[${idx}]`;
    if (!isPlainObject(entry)) {
      add('error', 'composition_recipe_template_row_shape', path, 'recipe_templates row must be an object');
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!WORKFLOW_ROW_KEYS.has(key)) {
        add('error', 'composition_recipe_template_row_unknown_key', `${path}.${key}`,
          `recipe_templates row field '${key}' is not part of the canonical template schema`);
      }
    }

    const template = entry.template;
    const templateEntry = typeof template === 'string'
      ? CANONICAL_WORKFLOW_TEMPLATE_REGISTRY[template as keyof typeof CANONICAL_WORKFLOW_TEMPLATE_REGISTRY]
      : undefined;
    if (templateEntry === undefined) {
      add('error', 'composition_workflow_template_unknown', `${path}.template`, 'template must name a canonical workflow template');
    }

    if (!isNonEmptyString(entry.operation) || !operationKeys.has(entry.operation)) {
      add('error', 'composition_workflow_operation_ref', `${path}.operation`, 'operation must reference a declared operation');
    }

    if (!isPlainObject(entry.trigger)) {
      add('error', 'composition_workflow_trigger_shape', `${path}.trigger`, 'trigger must be an object');
    } else {
      for (const key of Object.keys(entry.trigger)) {
        if (!WORKFLOW_TRIGGER_KEYS.has(key)) {
          add('error', 'composition_workflow_trigger_unknown_key', `${path}.trigger.${key}`,
            `trigger field '${key}' is not supported by canonical workflow templates`);
        }
      }
      if (!isNonEmptyString(entry.trigger.entity)) {
        add('error', 'composition_workflow_trigger_entity_required', `${path}.trigger.entity`, 'trigger.entity must be a non-empty string');
      }
      if (entry.trigger.field !== undefined && !isNonEmptyString(entry.trigger.field)) {
        add('error', 'composition_workflow_trigger_field_shape', `${path}.trigger.field`, 'trigger.field must be a non-empty string when present');
      }
      if (entry.trigger.value !== undefined && typeof entry.trigger.value !== 'string') {
        add('error', 'composition_workflow_trigger_value_shape', `${path}.trigger.value`, 'trigger.value must be a string when present');
      }
      if (entry.trigger.cron !== undefined && !isNonEmptyString(entry.trigger.cron)) {
        add('error', 'composition_workflow_trigger_cron_shape', `${path}.trigger.cron`, 'trigger.cron must be a non-empty string when present');
      }
      if (template === 'scheduled-operate' && !isNonEmptyString(entry.trigger.cron)) {
        add('error', 'composition_workflow_trigger_cron_required', `${path}.trigger.cron`, 'scheduled-operate workflows must declare trigger.cron');
      }
    }

    const optionalHoles = new Set(
      templateEntry !== undefined && 'optional_holes' in templateEntry
        ? templateEntry.optional_holes
        : [],
    );
    if (entry.sync_target !== undefined && !optionalHoles.has('sync_target')) {
      add('error', 'composition_workflow_hole_forbidden', `${path}.sync_target`,
        `template '${String(template)}' does not declare a sync_target hole`);
    }
    if (entry.notify_target !== undefined && !optionalHoles.has('notify_target')) {
      add('error', 'composition_workflow_hole_forbidden', `${path}.notify_target`,
        `template '${String(template)}' does not declare a notify_target hole`);
    }
    if (entry.escalate_after_ms !== undefined && !optionalHoles.has('escalate_after_ms')) {
      add('error', 'composition_workflow_hole_forbidden', `${path}.escalate_after_ms`,
        `template '${String(template)}' does not declare an escalate_after_ms hole`);
    }

    if (entry.sync_target !== undefined) {
      if (!isPlainObject(entry.sync_target)) {
        add('error', 'composition_workflow_sync_target_shape', `${path}.sync_target`, 'sync_target must be an object when present');
      } else {
        for (const key of Object.keys(entry.sync_target)) {
          if (!WORKFLOW_SYNC_TARGET_KEYS.has(key)) {
            add('error', 'composition_workflow_sync_target_unknown_key', `${path}.sync_target.${key}`,
              `sync_target field '${key}' is not supported`);
          }
        }
        if (!isNonEmptyString(entry.sync_target.source_id)) {
          add('error', 'composition_workflow_sync_source_required', `${path}.sync_target.source_id`, 'sync_target.source_id must be a non-empty string');
        }
        if (!isNonEmptyString(entry.sync_target.write_back_op) || !operationKeys.has(entry.sync_target.write_back_op)) {
          add('error', 'composition_workflow_sync_operation_ref', `${path}.sync_target.write_back_op`, 'sync_target.write_back_op must reference a declared operation');
        }
      }
    }

    if (entry.notify_target !== undefined && !isNonEmptyString(entry.notify_target)) {
      add('error', 'composition_workflow_notify_target_shape', `${path}.notify_target`, 'notify_target must be a non-empty string when present');
    }
    if (entry.escalate_after_ms !== undefined
      && (typeof entry.escalate_after_ms !== 'number'
        || !Number.isFinite(entry.escalate_after_ms)
        || entry.escalate_after_ms <= 0)) {
      add('error', 'composition_workflow_escalate_after_shape', `${path}.escalate_after_ms`, 'escalate_after_ms must be a positive finite number when present');
    }
  });
};

export const validateCompositionStructure = (body: unknown): CompositionValidationIssue[] => {
  const issues: CompositionValidationIssue[] = [];
  const add: AddIssue = (...args) => addIssue(issues, ...args);
  if (!isPlainObject(body)) {
    add('error', 'composition_not_object', '', 'composition body must be an object');
    return issues;
  }
  const raw = body;
  const bytes = serializedBytes(body);
  if (bytes === null) {
    add('error', 'composition_serialization_failed', '', 'composition body must be JSON-serializable');
  } else if (bytes > COMPOSITION_MAX_SERIALIZED_BYTES) {
    add('error', 'composition_serialized_too_large', '',
      `composition body may be at most ${COMPOSITION_MAX_SERIALIZED_BYTES} bytes when serialized`);
  }
  if (typeof raw.schema_version !== 'number' || !Number.isInteger(raw.schema_version) || raw.schema_version < 1) {
    add('error', 'composition_schema_version_shape', 'schema_version', 'schema_version must be a positive integer');
  }
  if (!isNonEmptyString(raw.slug)) {
    add('error', 'composition_slug_required', 'slug', 'slug must be a non-empty string');
  }
  // Ingredients first (collect slugs + per-slug kind + deferred entity-field
  // operation refs), then operations (gate each `bind` by its ingredient's
  // kind), then resolve the deferred entity-field `source_operation` refs
  // against the now-known op set, then the recipe templates.
  const { slugs, kindBySlug, declaredToolBySlug, fieldOps } = validateIngredients(raw, add);
  const operationKeys = validateOperations(raw, slugs, kindBySlug, declaredToolBySlug, add);
  for (const { path, ref } of fieldOps) {
    if (!operationKeys.has(ref)) {
      add('error', 'composition_entity_field_operation_ref', path, 'source_operation must reference a declared operation');
    }
  }
  validateRecipeTemplateRows(raw, operationKeys, add);
  // Optional install-time grant override — must be a string[] of group ids when
  // present (existence against the derived groups is cross-checked in
  // `validateComposition`, which has the decomposed groups).
  if (raw.default_grants !== undefined && !isStringArray(raw.default_grants)) {
    add('error', 'composition_default_grants_shape', 'default_grants',
      'default_grants must be an array of derived group-id strings when present');
  }
  return issues;
};

const wrapEntityIssues = (
  schema: EntitySchemaIngredientInput,
  schemaIdx: number,
): CompositionValidationIssue[] =>
  assertEntitySchemaIngredientShape(schema).map((message, idx) => ({
    severity: 'error',
    code: 'entity_schema_invalid',
    path: `entity_schemas[${schemaIdx}]#${idx}`,
    message,
  }));

export const validateComposition = (
  body: unknown,
  opts: CompositionValidationOptions = {},
): CompositionValidationResult => {
  const issues = validateCompositionStructure(body);
  const schemaVersion = isPlainObject(body) ? body.schema_version : undefined;
  const decompose = typeof schemaVersion === 'number' ? decomposeComposition[schemaVersion] : undefined;
  if (decompose === undefined) {
    issues.push({
      severity: 'error',
      code: 'unknown_schema_version',
      path: 'schema_version',
      message: `${String(schemaVersion)}`,
    });
    return { valid: false, issues };
  }
  let decomposed: DecomposedArtifacts;
  try {
    decomposed = decompose(body as CompositionIngredient);
  } catch (error) {
    issues.push({
      severity: 'error',
      code: 'decompose_failed',
      path: '',
      message: error instanceof Error ? error.message : String(error),
    });
    return { valid: false, issues };
  }
  // A 1x1 http/connection composition lowers to a plain ingredient and drops
  // its operation row (including request_schema). Never accept a closed schema
  // on that path: it would advertise a runtime gate that cannot exist. Authors
  // can keep the schema by using a catalog-shaped composition.
  if (decomposed.catalog === undefined
    && isPlainObject(body)
    && Array.isArray(body.operations)) {
    body.operations.forEach((rawOperation, idx) => {
      if (isPlainObject(rawOperation) && isClosedRequestSchema(rawOperation.request_schema)) {
        issues.push({
          severity: 'error',
          code: 'composition_closed_request_schema_requires_catalog',
          path: `operations[${idx}].request_schema`,
          message: 'a closed request schema requires a catalog-shaped composition; the 1x1 plain-ingredient lowering drops operation schemas',
        });
      }
    });
  }
  // Surface decompose-time notes (e.g. a 1×1 API wrapper dropping its declared
  // PII field tags — `composition_1x1_privacy_tags_dropped`) as non-blocking
  // warnings, so they reach the install review (`review.issues`) and the install
  // result (`IngredientInstallResult.warnings`) wherever validation issues do.
  for (const warning of decomposed.warnings ?? []) {
    issues.push({ severity: 'warn', ...warning });
  }
  // An authored `default_grants` override must name a group the decomposer
  // actually derives (the `<ingredient>.<family>.<risk>` form); an unknown id
  // would silently grant nothing.
  if (isPlainObject(body) && isStringArray(body.default_grants)) {
    const derivedGroupIds = new Set((decomposed.operation_groups ?? []).map((g) => g.group_id));
    for (const id of body.default_grants) {
      if (!derivedGroupIds.has(id)) {
        issues.push({
          severity: 'error',
          code: 'composition_default_grant_unknown',
          path: 'default_grants',
          message: `default_grants references '${id}', which is not a derived operation group (expected one of: ${[...derivedGroupIds].join(', ') || '(none)'})`,
        });
      }
    }
  }
  if (decomposed.ingredient !== undefined) {
    issues.push(...validateIngredient(decomposed.ingredient).issues);
  }
  if (decomposed.catalog !== undefined) {
    issues.push(...validateIngredient(decomposed.catalog).issues);
  }
  for (const [idx, schema] of (decomposed.entity_schemas ?? []).entries()) {
    issues.push(...wrapEntityIssues(schema, idx));
  }
  if (opts.recipeValidator !== undefined) {
    for (const [idx, recipe] of (decomposed.recipes ?? []).entries()) {
      issues.push(...opts.recipeValidator(recipe).issues.map((issue) => ({
        ...issue,
        path: issue.path.length > 0 ? `recipes[${idx}].${issue.path}` : `recipes[${idx}]`,
      })));
    }
  }
  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues,
    decomposed,
  };
};

const fromBulkPackIssue = (issue: BulkPackIssue): CompositionValidationIssue => ({
  severity: issue.severity === 'warning' ? 'warn' : issue.severity,
  code: issue.code,
  path: issue.path,
  message: issue.message,
});

const validateCompositionContentRef = (
  content: unknown,
  path: string,
  issues: CompositionValidationIssue[],
): void => {
  if (!isPlainObject(content) || content.type !== 'composition') return;
  if (!objectKeysExactly(content, ['composition', 'type'])) {
    issues.push({
      severity: 'error',
      code: 'pack_composition_ref_strict_keys',
      path,
      message: "composition content refs must contain exactly 'type' and 'composition'",
    });
  }
  const bytes = serializedBytes(content.composition);
  if (bytes === null) {
    issues.push({
      severity: 'error',
      code: 'pack_composition_serialization_failed',
      path: `${path}.composition`,
      message: 'composition content must be JSON-serializable',
    });
  } else if (bytes > COMPOSITION_MAX_SERIALIZED_BYTES) {
    issues.push({
      severity: 'error',
      code: 'pack_composition_serialized_too_large',
      path: `${path}.composition`,
      message: `composition content may be at most ${COMPOSITION_MAX_SERIALIZED_BYTES} bytes when serialized`,
    });
  }
};

export const validatePackStructure = (pack: unknown): CompositionValidationIssue[] => {
  const parsed = parseBulkPackManifest(pack);
  const issues = parsed.issues.map(fromBulkPackIssue);
  if (isPlainObject(pack) && Array.isArray(pack.contents)) {
    pack.contents.forEach((content, idx) => {
      if (isPlainObject(content)
        && typeof content.type === 'string'
        && PACK_CONTENT_KIND_SET.has(content.type)
        && content.type === 'composition') {
        validateCompositionContentRef(content, `contents[${idx}]`, issues);
      }
    });
  }
  return issues;
};

export const validatePack = (
  pack: unknown,
  opts: CompositionValidationOptions = {},
): CompositionValidationResult => {
  const issues = validatePackStructure(pack);
  const manifestVersion = isPlainObject(pack) ? pack.manifest_version : undefined;
  const decompose = typeof manifestVersion === 'number' ? decomposePack[manifestVersion] : undefined;
  if (decompose === undefined) {
    issues.push({
      severity: 'error',
      code: 'unknown_pack_schema_version',
      path: 'manifest_version',
      message: `${String(manifestVersion)}`,
    });
    return { valid: false, issues };
  }
  let decomposed: PackDecomposition;
  try {
    decomposed = decompose(pack as BulkPackManifest);
  } catch (error) {
    issues.push({
      severity: 'error',
      code: 'pack_decompose_failed',
      path: '',
      message: error instanceof Error ? error.message : String(error),
    });
    return { valid: false, issues };
  }
  for (const [idx, content] of decomposed.contents.entries()) {
    if (content.type === 'composition') {
      const result = validateComposition(content.composition, opts);
      issues.push(...result.issues.map((issue) => ({
        ...issue,
        path: issue.path.length > 0 ? `contents[${idx}].composition.${issue.path}` : `contents[${idx}].composition`,
      })));
    } else if (!isPlainObject(content) || typeof content.type !== 'string' || !PACK_CONTENT_KIND_SET.has(content.type)) {
      issues.push({
        severity: 'error',
        code: 'pack_content_type_unknown',
        path: `contents[${idx}].type`,
        message: 'content type is not known',
      });
    }
  }
  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues,
    decomposed,
  };
};
