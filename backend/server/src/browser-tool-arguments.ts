import { browserActUploadRefs, parseBrowserActSteps, readBrowserFailure, type ToolEntry, type ChatDispatchResult, type BrowserDocumentBindingMismatch } from '@recued/contracts';
import { validateBrowserDataStep, browserDataParameterRepair } from './bridges/browser-data-pipeline.js';

const browserInput = (tool: ToolEntry | null | undefined, args: unknown): Record<string, unknown> | undefined => {
  if (tool?.tier !== 2 || !/^(recued-core|kitchen)\/act-on-web-page$/.test(tool.name)
    || args === null || typeof args !== 'object' || Array.isArray(args)) return;
  const schema = tool.arg_schema as { properties?: { steps?: { 'x-recued-browser-act-direct'?: unknown } } } | undefined;
  return schema?.properties?.steps?.['x-recued-browser-act-direct'] === true ? args as Record<string, unknown> : undefined;
};

/** Host-owned inspector choices. Examples remain reads in the caller's exact scope. */
export const browserInspectArgumentGuidance = (tool: ToolEntry | null | undefined, args: unknown): Record<string, unknown> | undefined => {
  if (tool?.tier !== 2 || !/^(recued-core|kitchen)\/(inspect-web-page|read-web-text)$/.test(tool.name)
    || !args || typeof args !== 'object' || Array.isArray(args)) return;
  const schema = tool.arg_schema as { properties?: Record<string, { 'x-recued-browser-argument'?: unknown }> };
  if (schema.properties?.find?.['x-recued-browser-argument'] !== 'text') return;
  const input = args as Record<string, unknown>;
  const find = typeof input.find === 'string' ? input.find.trim() : '';
  const block = typeof input.block === 'string' ? input.block.trim() : '';
  const from = typeof input.from === 'number' && Number.isSafeInteger(input.from) && input.from > 0 ? input.from : 0;
  if ([Boolean(find), Boolean(block), from > 0].filter(Boolean).length < 2) return;
  const options: Record<string, unknown>[] = [];
  const scope = { ...(typeof input.page === 'string' ? { page: input.page } : {}),
    ...(typeof input.bridge_id === 'string' ? { bridge_id: input.bridge_id } : {}) };
  const guide = { tool: tool.name, preflight: { dispatched: false }, options,
    note: 'Choose one read intent. A new search starts with from:0. Continuation clears find/block. These are alternative read-only calls, not a sequence; nothing ran automatically.' };
  const emptyBlock = schema.properties?.block ? { block: '' } : {};
  if (find && find.length <= 200) options.push({ kind: 'new_search', args: { ...scope, find, from: 0, ...emptyBlock } });
  if (from) options.push({ kind: 'continue', args: { ...scope, from, find: '', ...emptyBlock } });
  if (block && block.length <= 80) options.push({ kind: 'block', args: { ...scope, block, from: 0, find: '' } });
  while (options.length && JSON.stringify(guide).length > 1_800) options.pop();
  return guide;
};

export const browserInspectArgumentError = (tool: ToolEntry | null | undefined, args: unknown): string | undefined =>
  browserInspectArgumentGuidance(tool, args) ? 'Inspect chooses one of search, block or continuation. For a new search set from:0; to continue clear find/block. Choose one of the returned read-only alternatives.' : undefined;

/** Only the host-derived Toolkit Act surface may classify a failed recipe run
 * as deterministic authoring failure. Remote tools and runtime failures cannot
 * put themselves into the turn's unchanged-argument refusal ledger. */
export const browserActArgumentError = (tool: ToolEntry | null | undefined, args: unknown): string | undefined => {
  const input = browserInput(tool, args);
  if (!input) return;
  const parsed = parseBrowserActSteps(input.steps, { page: input.page });
  if (parsed.ok) {
    const first = parsed.steps[0];
    if (parsed.steps.some(step => step.do !== 'data') && !(typeof input.page === 'string' && input.page.trim())
      && !(first && ('page' in first && typeof first.page === 'string' && first.page.trim()
        || 'url' in first && typeof first.url === 'string' && first.url.trim()))) return 'A browser batch needs its starting page on the call or first step; copy the current full page handle. Data-only calls are exempt.';
    for (const [index, step] of parsed.steps.entries()) if (step.do === 'data') {
      try { validateBrowserDataStep(step); } catch (error) { return `step ${index + 1}: ${error instanceof Error ? error.message : 'invalid data parameters'}`.slice(0, 1_000); }
      if (browserDataParameterRepair(step)) return `step ${index + 1}: the data input has a known array/object shape incompatible with its operation. Review the checked input-slot/row-map alternative.`;
    }
    return;
  }
  const messages = parsed.violations?.length ? parsed.violations.map(violation =>
    `${violation.path.slice(0, 160)}: ${violation.message.slice(0, 220)}`).join('; ') : parsed.error;
  return messages.length > 1_000 ? messages.slice(0, 950) + '; additional diagnostics omitted' : messages;
};

/** Only a validated host refusal of this exact request, with no planned effect,
 * can close an unchanged binding attempt. A timeout or partial action cannot. */
export const browserActBindingRefusal = (tool: ToolEntry | null | undefined, args: unknown, result: ChatDispatchResult): BrowserDocumentBindingMismatch | undefined => {
  const input = browserInput(tool, args);
  if (!input || !result.ok || !result.run_failed || !result.result || typeof result.result !== 'object') return;
  const run = result.result as Record<string, unknown>;
  if (run.recipe_id !== 'act-on-web-page' || run.success !== false || !Array.isArray(run.errors)) return;
  for (const error of run.errors) {
    if (!error || typeof error !== 'object') continue;
    const item = error as Record<string, unknown>;
    const source = item.source as { ingredient_slug?: unknown } | undefined;
    if (source?.ingredient_slug !== 'dom-act') continue;
    const failure = readBrowserFailure({ code: item.code, browser_failure: { slug: 'dom-act', details: item.details } });
    const binding = failure?.details.binding_mismatch;
    if (binding && binding.requested_page === input.page) return binding;
  }
};

/** Only a host preflight refusal may use this: no step in this attempt ran.
 * Suggestions are checked read-only plans, never automatic execution. */
export const browserActPreflightGuidance = (tool: ToolEntry | null | undefined, args: unknown,
  attachments: readonly { file_ref: string; filename: string }[] = []): Record<string, unknown> | undefined => {
  const input = browserInput(tool, args);
  if (!input) return;
  let steps: unknown = input.steps;
  if (typeof steps === 'string' && steps.length <= 20_000) { try { steps = JSON.parse(steps); } catch { return; } }
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!Array.isArray(steps) || !steps.length || steps.length > 20 || !steps.every(object)) return;
  const parsed = parseBrowserActSteps(steps, { page: input.page });
  const violations = !parsed.ok ? parsed.violations ?? [] : [];
  const listed: typeof violations[number][] = [];
  let truncated = !parsed.ok && parsed.violations_truncated === true;
  for (const violation of violations) {
    const bounded = { ...violation, path: violation.path.slice(0, 160), message: violation.message.slice(0, 220) };
    if (bounded.path !== violation.path || bounded.message !== violation.message) truncated = true;
    listed.push(bounded);
    if (JSON.stringify(listed).length > 1_000) { listed.pop(); truncated = true; break; }
  }
  const call = (replacement: unknown[]) => ({ ...(input.page !== undefined ? { page: input.page } : {}),
    ...(input.bridge_id !== undefined ? { bridge_id: input.bridge_id } : {}), steps: replacement });
  const checked = (replacement: unknown[]): boolean => {
    if (browserActArgumentError(tool, call(replacement))) return false;
    const parsed = parseBrowserActSteps(replacement, { page: input.page });
    if (!parsed.ok) return false;
    try { for (const step of parsed.steps) if (step.do === 'data') validateBrowserDataStep(step); return true; } catch { return false; }
  };
  const options: Record<string, unknown>[] = [];
  const badUpload = steps.findIndex(step => step.do === 'upload' && browserActUploadRefs(step) === undefined);
  const eligible = attachments.filter(file => /^file:[0-9a-f]{32}$/.test(file.file_ref) && file.filename.length > 0).slice(0, 3)
    .map(file => ({ file_ref: file.file_ref, filename: file.filename.slice(0, 120) }));
  const fileReference = badUpload < 0 ? undefined : { kind: 'malformed_file_reference', step: badUpload + 1,
    expected: { prefix: 'file:', hex_digits: 32 },
    received: { type: Array.isArray(steps[badUpload]!.files) ? 'array' : typeof steps[badUpload]!.file,
      ...(typeof steps[badUpload]!.file === 'string' ? { characters: steps[badUpload]!.file.length } : {}) },
    lookup_performed: false, upload_performed: false,
    ...(eligible.length ? { issued_attachments: eligible, references_complete: eligible.length === attachments.length,
      note: 'These exact references were issued with this turn. Select the requested file; availability and permissions are checked on upload.' } : {}) };
  const typePaths = steps.flatMap((step, index) => step.do === 'type' ? [`steps[${index}]`] : []);
  const formInput = violations.some(violation => typePaths.some(path => violation.path === path || violation.path.startsWith(path + '.')))
    ? { operation: 'type', target: 'exactly one observed ref, selector or text',
      input_choices: ['value: text or username/email', 'secret: password, PIN or sign-in code; omit value'],
      secret_fulfillment: 'The server uses a saved site-bound secret or asks the owner outside the model, then types it.',
      document_context: '/browser_context/pages: copy the current target.page and target.ref together', automatic_execution: false } : undefined;
  const guide = { tool: tool!.name, preflight: { dispatched: false,
    ...(formInput ? { form_input: formInput } : {}),
    ...(fileReference ? { file_reference: fileReference } : {}),
    ...(listed.length ? { violations: listed } : {}), ...(truncated ? { violations_truncated: true } : {}) }, options,
    note: 'No batch steps ran in this attempt. Correct all listed violations together; steps[i] paths use zero-based array indices. Limits are not clamped automatically. Review any read-only replacement call in args; nothing executes automatically. Keep the original scope and page/bridge. Return sufficient facts directly.' };
  if (parsed.ok) for (const [index, step] of parsed.steps.entries()) if (step.do === 'data') {
    const replacement = browserDataParameterRepair(step);
    if (!replacement) continue;
    options.push({ kind: 'data_step_repair', step: index + 1, replacement_step: replacement,
      when: 'Replace only this data step in the original batch. Its source, predicates, expressions and branch IDs are preserved. latest still needs that batch\'s original capture. This is not a standalone call or an executed repair.' });
    if (JSON.stringify(guide).length > 1_800) options.pop();
    break;
  }
  while (eligible.length && JSON.stringify(guide).length > 1_800) {
    eligible.pop();
    if (fileReference) fileReference.references_complete = false;
  }
  if (JSON.stringify(guide).length > 1_800) delete guide.preflight.form_input;
  // Mixed action batches may receive diagnostics, but never an automatically
  // repaired write plan or a suggestion to replay earlier actions.
  if (!steps.every(step => ['read', 'table', 'data'].includes(String(step.do)))) return listed.length || fileReference || options.length ? guide : undefined;
  const add = (kind: string, when: string, replacement: unknown[]) => {
    if (!checked(replacement)) return;
    options.push({ kind, when, args: call(replacement) });
    if (JSON.stringify(guide).length > 1_800) options.pop();
  };
  const at = steps.findIndex(step => object(step) && step.do === 'data' && Array.isArray(step.return) && step.return.length === 1
    && Array.isArray(step.pipeline) && !step.pipeline.some(op => object(op) && op.id === (step.return as unknown[])[0]));
  if (at >= 0) {
    const { return: _output, ...lastValue } = steps[at] as Record<string, unknown>;
    add('argument_repair', 'return names operation IDs, not final JSON wrapper keys. This checked plan omits the undefined ID and returns the last pipeline value. Review the requested output.',
      steps.map((step, index) => index === at ? lastValue : step));
  }
  if (object(steps[0]) && ['read', 'table'].includes(String(steps[0].do))) add('preflight_read',
    'If the data plan is unfamiliar, capture the original first read/table on its own. Headers are already excluded from table rows. Answer from sufficient values or query the returned data_ref; do not repeat the rejected plan.', [steps[0]]);
  return options.length || listed.length ? guide : undefined;
};
