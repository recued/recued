import {
  CLI_STDIN_HANDLINGS, CLI_OUTPUT_SHAPES, CLI_OUTPUT_STORAGES, CLI_PROGRESS_ADAPTERS, CLI_PROGRESS_ANSWER_ADAPTERS,
  CLI_BINDING_ENV_NAMES, CLI_BINDING_ENV_VALUE_MAX,
  type CliMethodBinding, type CliProgressSpec, type CliHeartbeatProgressSpec, type CliFileGrowthProgressSpec,
  type CliInputMaterializeSpec, type CliInvocationCwdSpec,
  type CliOutputDirCaptureSpec, type CliOutputInPlaceCaptureSpec, type CliOutputStdoutCaptureSpec,
  type CliOutputProgressAnswerCaptureSpec, type CliBindingEnvName, type CliArgvTemplateEntry,
} from '@recued/contracts';

export interface CliAuthoringField {
  key: string; type: 'string' | 'number' | 'boolean' | 'object' | 'array'; required: boolean; description: string;
  values?: readonly (string | boolean)[];
}
type Field = Omit<CliAuthoringField, 'key'>;
type AdmittedKeys<T> = { [K in keyof T]-?: [Exclude<T[K], undefined>] extends [never] ? never : K }[keyof T];
type Fields<T> = Record<Extract<AdmittedKeys<T>, string>, Field>;
const text = (description: string, required = false, values?: Field['values']): Field => ({ type: 'string', required, description, ...(values ? { values } : {}) });
const number = (description: string, required = false): Field => ({ type: 'number', required, description });
const object = (description: string, required = false): Field => ({ type: 'object', required, description });
const array = (description: string, required = false): Field => ({ type: 'array', required, description });
const selector = (description: string): Field => ({ type: 'boolean', required: true, description, values: [true] });
const exitPresets: Record<Extract<CliMethodBinding['exit_code_handling'], string>, true> = { zero_is_success: true };
const progressKinds: Record<CliProgressSpec['contract'], true> = { heartbeat: true, 'file-growth': true };
const inputKinds: Record<CliInputMaterializeSpec['kind'], true> = { file_ref: true, file_ref_array: true };
const binding: Fields<Omit<CliMethodBinding, 'detached'>> = {
  kind: text('Foreground CLI invocation. The declared executable stays pinned; operation risk, approval and grants remain authored.', true),
  argv_template: array('Discrete argv tokens, never a shell string. The first token pins the declared executable. Later single-brace tokens refer to operation arguments; expand_arg preserves array order without shell splitting.', true),
  stdin_handling: text('Choose whether to send no stdin, the serialized arguments, or the body argument. This selects transport behavior; values and policies stay authored.', false, CLI_STDIN_HANDLINGS),
  shape: text('The output contract: text keeps stdout, json/jsonl parse it, ref returns a captured file. Omission is exit-code-only. File materialization cannot combine with value output; ref requires output_capture.', false, CLI_OUTPUT_SHAPES),
  storage: text('File output backing, meaningful with output_capture. Omission uses run-scoped temp storage. cas retains a durable file record. The editor chooses no retention policy.', false, CLI_OUTPUT_STORAGES),
  exit_code_handling: text('Use zero_is_success or an explicit object with success_codes. Choose the accepted exit codes from the tool contract; the editor chooses none.', true, Object.keys(exitPresets)),
  cwd: object('Select one caller argument through a single {arg_name} token. That editable argument must explicitly affect the target; completing this object does not add that authority.'),
  progress: object('Semantic progress and stall detection for an awaited foreground command. A positive timeout_ms remains the hard deadline; timeout_ms: 0 is unbounded and requires progress. Choose the contract and durations explicitly.'),
  output_capture: object('Return a file through shape ref. Choose one output source: an engine-owned output directory, the materialized input, stdout, or an eligible progress adapter final answer. The editor chooses no capture source.'),
  input_materialize: object('Materialize a caller file reference, or an ordered array of references, into engine-owned temporary paths. Bind the scalar token or expand_arg explicitly. File bytes remain behind the file-reference flow.'),
  env: object('Pinned process environment. Only the shared allowed names are admitted; values are literal pack data, never caller templates, bounded to ' + CLI_BINDING_ENV_VALUE_MAX + ' characters. Choosing a name inserts no policy value.'),
};
const contract = text('Choose heartbeat for a registered semantic progress adapter, or file-growth for an explicitly watched output file. Changing the contract preserves existing metadata for review.', true, Object.keys(progressKinds));
const stall = number('Required positive milliseconds without semantic progress. Must be shorter than a positive timeout_ms; timeout_ms: 0 has no absolute deadline. The editor chooses no duration.', true);
const heartbeat: Fields<CliHeartbeatProgressSpec> = {
  contract, stall_ms: stall,
  adapter: text('Registered host code that recognizes semantic progress. Naming arbitrary stdout does not create an adapter. Answer capture requires an adapter that exposes its final answer.', true, CLI_PROGRESS_ADAPTERS),
  first_output_ms: number('Optional initial silence window on the heartbeat stream, shorter than stall_ms. Any output ends this initial window; semantic progress still governs the later stall limit.'),
};
const growth: Fields<CliFileGrowthProgressSpec> = {
  contract, stall_ms: stall,
  watch_path: text('The explicitly authored file whose growth indicates progress, after engine-owned output tokens are injected. Existing argument completion and F12 remain available.', true),
};
const inputKind = text('Choose one file_ref or an ordered file_ref_array. A scalar uses a single-brace argv token; an array uses an expand_arg entry. Completing this choice preserves the authored arguments and capture policy.', true, Object.keys(inputKinds));
const inputArg = text('The caller argument to materialize. It must be declared in editable_args and used by the matching scalar argv token or array expansion. The engine-owned output token is separate.', true);
const scalarInput: Fields<Extract<CliInputMaterializeSpec, { kind: 'file_ref' }>> = { kind: inputKind, arg: inputArg };
const arrayInput: Fields<Extract<CliInputMaterializeSpec, { kind: 'file_ref_array' }>> = {
  kind: inputKind, arg: inputArg,
  min_items: number('Optional positive lower item bound within the shared materialization limit. It must not exceed max_items. The editor chooses no bound.'),
  max_items: number('Optional positive upper item bound within the shared materialization limit. It must not be below min_items. The editor chooses no bound.'),
};
const mime = text('Authored MIME type for the captured file. Directory capture also uses it to select the produced file among sidecars. The editor does not infer a filename, extension or provider type.', true);
const filename = text('Non-empty display filename for the captured output. The engine chooses the actual local path; this name labels the file reference.', true);
const directory: Fields<CliOutputDirCaptureSpec> = {
  dir_arg: text('An engine-owned output-directory token used in argv_template. It must not be a caller editable argument. Existing token help distinguishes this location from caller data.', true), mime_type: mime,
};
const inPlace: Fields<CliOutputInPlaceCaptureSpec> = {
  from_input_arg: text('Capture the file edited in place at the engine-owned scalar materialization path. This must equal input_materialize.arg; arrays and caller-chosen path passthrough are incompatible.', true), mime_type: mime,
};
const stdout: Fields<CliOutputStdoutCaptureSpec> = {
  from_stdout: selector('Explicit true streams stdout into an engine-owned file returned as a file reference. stderr stays separate. Choose this source explicitly.'), mime_type: mime, filename,
};
const answer: Fields<CliOutputProgressAnswerCaptureSpec> = {
  from_progress_answer: selector('Explicit true captures only the final answer read by an eligible heartbeat adapter, instead of its whole event stream. Choose this source explicitly.'), mime_type: mime, filename,
};
export const CLI_CAPTURE_SELECTOR_KEYS = ['dir_arg', 'from_input_arg', 'from_stdout', 'from_progress_answer'] as const;
const captures = { dir_arg: directory, from_input_arg: inPlace, from_stdout: stdout, from_progress_answer: answer };
const cwd: Fields<CliInvocationCwdSpec> = { arg: text('Exactly one {arg_name} token selecting the working directory. The same editable argument must declare affects_target: true. No directory or target annotation is inferred.', true) };
const exit: Fields<Exclude<CliMethodBinding['exit_code_handling'], string>> = { success_codes: array('Explicit numeric exit codes the tool treats as successful. This replaces the zero_is_success spelling; no codes are filled in automatically.', true) };
const expansion: Fields<Exclude<CliArgvTemplateEntry, string>> = { expand_arg: text('Expand one declared array argument into discrete argv elements in order. Current file-array materialization requires a matching file_ref_array input. Existing array-name completion and F12 remain available.', true) };
const env: Record<CliBindingEnvName, Field> = {
  OPENCODE_DISABLE_PROJECT_CONFIG: text('Literal OpenCode configuration control. Select its value explicitly and review the tool version; this flag does not establish that repository code cannot load.'),
  OPENCODE_PERMISSION: text('Literal OpenCode permission policy for this process. The editor does not generate a permission policy or grant Recued authority.'),
};
export type CliAuthoringSection = 'binding' | 'progress' | 'materialize' | 'capture' | 'cwd' | 'exit' | 'expansion' | 'env';
export interface CliAuthoringSelection { mode?: unknown; captureKeys?: readonly string[]; answerCapture?: boolean }
/** Shared typed metadata only; no execution, policy selection or new validity rules. */
export const cliAuthoringFields = (section: CliAuthoringSection, selection: CliAuthoringSelection = {}): CliAuthoringField[] => {
  let fields: Record<string, Field>;
  if (section === 'binding') fields = binding;
  else if (section === 'progress') fields = selection.mode === 'heartbeat' ? {
    ...heartbeat, adapter: { ...heartbeat.adapter, values: selection.answerCapture ? CLI_PROGRESS_ANSWER_ADAPTERS : CLI_PROGRESS_ADAPTERS },
  } : selection.mode === 'file-growth' ? growth : { contract, stall_ms: stall };
  else if (section === 'materialize') fields = selection.mode === 'file_ref' ? scalarInput : selection.mode === 'file_ref_array' ? arrayInput : { kind: inputKind };
  else if (section === 'capture') {
    const keys = selection.captureKeys ?? [];
    fields = keys.length === 1 && Object.hasOwn(captures, keys[0]!) ? captures[keys[0] as keyof typeof captures]
      : keys.length ? { mime_type: mime } : { dir_arg: directory.dir_arg, from_input_arg: inPlace.from_input_arg, from_stdout: stdout.from_stdout, from_progress_answer: answer.from_progress_answer, mime_type: mime };
  } else fields = section === 'cwd' ? cwd : section === 'exit' ? exit : section === 'expansion' ? expansion : Object.fromEntries(CLI_BINDING_ENV_NAMES.map(key => [key, env[key]]));
  return Object.entries(fields).map(([key, field]) => ({ key, ...field }));
};
