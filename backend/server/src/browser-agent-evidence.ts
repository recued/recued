import { BROWSER_DATA_REF, BRIDGE_PAGE_CHANGED_MESSAGE, BRIDGE_PAGE_GONE_MESSAGE, isBrowserReadState, isBrowserSourceIssues, isBrowserPostActionState, parseBrowserActSteps, readBrowserFailure,
  type BrowserPostActionState, type BrowserConditionFailure, type BrowserReadinessFailure, type BrowserFailureObservation, type BrowserControlCorrection } from '@recued/contracts';
import { browserAgentGuidance } from './browser-agent-guidance.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const readCursor = (value: unknown): Record<string, unknown> | undefined => {
  if (!object(value) || value.do !== 'read' || typeof value.page !== 'string' || /^https?:/i.test(value.page)) return undefined;
  const parsed = parseBrowserActSteps([value]);
  if (!parsed.ok) return undefined;
  const { do: _operation, ...cursor } = parsed.steps[0]!;
  return cursor;
};

// Legacy Bridge messages still drive host ref/delivery checks. Only their
// agent projection loses the follow-up instruction; the stored error is intact.
const factualFailureMessage = (message: string): string => {
  const prefix = /^(Stopped at step \d+ of \d+: )?/.exec(message)![0];
  let body = message.slice(prefix.length);
  if (body.startsWith(BRIDGE_PAGE_CHANGED_MESSAGE)) body = 'The referenced element changed since the recorded observation.' + body.slice(BRIDGE_PAGE_CHANGED_MESSAGE.length);
  else if (body.startsWith(BRIDGE_PAGE_GONE_MESSAGE)) body = 'The referenced page document is no longer available.' + body.slice(BRIDGE_PAGE_GONE_MESSAGE.length);
  else if (/^e\d+ now shows /.test(body)) body = body.replace(/^(e\d+ now shows .*: the page changed it since it was inspected)\. Inspect it again\./s, '$1.');
  else if (body.startsWith('The page is still loading and did not establish one stable visible field;')) body = body.replace(
    'The page is still loading and did not establish one stable visible field; inspect it again and use its current ref.',
    'The loading page did not establish one stable visible field.');
  else if (body.startsWith('This URL now continues on ')) body = body.replace(' Read that page and use its current refs.', '');
  else if (body.startsWith('The tab opened, but its page ')) body = body.replace(
    /^The tab opened, but its page (had not finished loading|could not be read yet)\. List the tabs, or inspect it, before opening it again\./,
    'The tab opened, but its page $1.');
  return prefix + body;
};

const factualFailures = <T extends Record<string, unknown>>(result: T): T => {
  if (result.success !== false || !Array.isArray(result.errors)) return result;
  const messages = new Map<string, string>();
  let changed = false;
  const errors = result.errors.map(error => {
    if (!object(error) || !object(error.source) || !['dom-act', 'dom-click', 'dom-write', 'dom-wait', 'dom-scroll', 'dom-inspect',
      'dom-table', 'dom-open', 'dom-tabs', 'dom-download', 'dom-screenshot'].includes(String(error.source.ingredient_slug))) return error;
    const failure = readBrowserFailure({ code: error.code, browser_failure: { slug: error.source.ingredient_slug, details: error.details } });
    let message = typeof error.message === 'string' ? factualFailureMessage(error.message) : error.message;
    const correction = failure?.details.control_correction;
    if (correction && typeof message === 'string' && /^(Stopped at step \d+ of \d+: )?In the fresh read, /.test(message)) {
      message = `The refusal's observation identified ${correction.ref} as a ${correction.kind}${correction.name ? ` named ${JSON.stringify(correction.name)}` : ''}, not an editable field. Typing was not sent. Supported action: click.`;
    }
    const progress = failure?.details.batch_progress;
    const omit = progress && (progress.next_step !== undefined || progress.recovery !== undefined);
    if (message === error.message && !omit) return error;
    changed = true;
    if (typeof error.message === 'string' && typeof message === 'string') messages.set(error.message, message);
    const { next_step: _next, recovery: _recovery, ...facts } = progress ?? {};
    return { ...error, ...(message !== undefined ? { message } : {}),
      ...(omit ? { details: { ...failure!.details, batch_progress: facts } } : {}) };
  });
  if (!changed) return result;
  return { ...result, errors, ...(Array.isArray(result.steps) ? { steps: result.steps.map(step => object(step)
    && typeof step.error === 'string' && messages.has(step.error) ? { ...step, error: messages.get(step.error) } : step) } : {}) };
};

/** A bounded agent-facing header from host browser evidence. Never scans page
 * strings, captured values, arbitrary data results or another recipe's output.
 * The original run and its audit are not mutated. */
export const projectBrowserAgentEvidence = <T>(input: T): T => {
  if (!object(input) || typeof input.recipe_id !== 'string'
    || !['act-on-web-page', 'inspect-web-page', 'read-web-text', 'read-web-element', 'read-web-table', 'type-into-web-page',
      'click-web-element', 'press-on-web-page', 'scroll-web-page', 'wait-for-web-element', 'open-web-page', 'list-browser-tabs',
      'list-browser-bridges', 'save-web-file', 'screenshot-web-page', 'ask-web-page'].includes(input.recipe_id)) return input;
  const result = factualFailures(input);
  const guidance = browserAgentGuidance(result);
  let attention: Record<string, unknown> | undefined;
  let state: BrowserPostActionState | undefined;
  let check: BrowserConditionFailure | undefined;
  let readyCheck: BrowserReadinessFailure | undefined;
  let observation: BrowserFailureObservation | undefined;
  let control: BrowserControlCorrection | undefined;
  let binding: Record<string, unknown> | undefined;
  let navigation: Record<string, unknown> | undefined;
  if (result.success === false && Array.isArray(result.errors)) {
    for (const error of result.errors) {
      if (!object(error) || !object(error.source)) continue;
      const failure = readBrowserFailure({ code: error.code, browser_failure: { slug: error.source.ingredient_slug, details: error.details } });
      const progress = failure?.details.batch_progress;
      state = failure?.details.post_action;
      check = failure?.details.check_failure;
      readyCheck = failure?.details.ready_failure;
      observation = failure?.details.failure_observation;
      control = failure?.details.control_correction;
      binding = failure?.details.binding_mismatch ? { ...failure.details.binding_mismatch } : undefined;
      navigation = failure?.details.navigation_boundary ? { ...failure.details.navigation_boundary } : undefined;
      if (!progress) continue;
      attention = { kind: 'batch_stopped', failed_step: progress.failed_step, total_steps: progress.total_steps,
        completed_steps: progress.completed_steps, effects: progress.effects,
        ...(progress.page_state ? { page_state: progress.page_state } : {}),
        ...(progress.current_page ? { current_page: progress.current_page } : {}),
        note: 'The batch stopped at the recorded failed step. Completed steps and command effect counts are recorded separately; the overall request did not complete.' };
      if (state?.view_status === 'fresh') {
        attention.note = 'browser_state contains a fresh observation after the attempted action. The action and result check retain their recorded statuses. Application acceptance is unverified.';
      }
      if (observation?.view_status === 'fresh' && !binding) {
        attention.note = 'The condition failed. browser_observation is a fresh diagnostic view after the timeout; its read is not a completed planned step.';
      }
      if (binding) attention.note = 'Document refs are scoped to browser_binding.page. The requested URL is recorded separately. No planned step ran; browser_observation is diagnostic evidence.';
      if (navigation) attention.note = 'The batch entered a new document before the pending form steps were observed. Those steps did not run. browser_state records the new view without claiming application acceptance.';
      const issues = failure?.details.data_failure?.source_issues ?? failure?.details.completed_data?.flatMap(data => data.source_issues ?? []);
      if (issues?.length) attention.source_issues = issues.slice(0, 1).map(({ read_step: _read, restart_url: _url, ...issue }) => issue);
      break;
    }
  }
  if (!attention && result.success === true && object(result.output) && Array.isArray(result.output.render)) {
    const roots = result.output.render.filter(object).filter(item => item.type === 'json').map(item => item.data).filter(object);
    for (const root of roots) {
      const candidate = root.post_action;
      if (isBrowserPostActionState(candidate)) state = candidate;
    }
    const reads = result.recipe_id === 'act-on-web-page' ? roots.flatMap(root => Array.isArray(root.tabs)
      ? root.tabs.filter(object).flatMap(tab => Array.isArray(tab.reads) ? tab.reads.filter(object) : []) : []) : roots;
    // Most recent actual read wins within this result. This is evidence about
    // one returned view, not a global task-completion judgement.
    for (const read of [...reads].reverse()) {
      const collection = read.collection;
      if (object(collection) && collection.complete === false && object(collection.coverage) && collection.coverage.complete === false
        && integer(collection.count) && integer(collection.scanned) && typeof collection.stop_reason === 'string' && collection.stop_reason.length <= 128) {
        const field = collection.field_failure;
        attention = { kind: 'partial_collection', complete: false, returned_records: collection.count, scanned: collection.scanned,
          stop_reason: collection.stop_reason, note: 'These are partial records. They do not establish the requested whole-set count or prove omitted items absent.' };
        if (object(field) && typeof field.field === 'string' && field.field.length <= 40 && integer(field.matches)
          && typeof field.required === 'boolean' && typeof field.many === 'boolean') {
          attention.field = field.field; attention.required = field.required; attention.many = field.many; attention.matches = field.matches;
          const next = readCursor(field.read_step); if (next) attention.continuation = next;
          if (typeof field.restart_url === 'string' && field.restart_url.length <= 2_048) attention.restart_url = field.restart_url;
          attention.note = 'A declared field stopped collection. Its required/many settings and match count are recorded. Returned records and coverage are partial; the source page and initial collection URL are recorded separately.';
        }
        break;
      }
      if (!isBrowserReadState(read.read_state) || read.read_state.complete !== false
        || !['outline', 'text', 'lines'].some(key => typeof read[key] === 'string')) continue;
      attention = { kind: 'partial_read', scope: read.read_state.scope, complete: false,
        note: 'This displayed view is incomplete. It does not establish exhaustive counts or absence beyond the excerpt. Retained data has its own recorded source coverage.' };
      const next = readCursor(read.next_step); if (next) attention.continuation = next;
      const entries = read.data_format === 'entries' ? read : read.entry_data;
      if (object(entries) && typeof entries.data_ref === 'string' && BROWSER_DATA_REF.test(entries.data_ref) && typeof entries.data_source_complete === 'boolean') {
        attention.entry_data = { data_ref: entries.data_ref, source_complete: entries.data_source_complete };
        const hint = entries.data_hint;
        if (object(hint) && object(hint.step) && hint.step.do === 'data' && hint.step.source === entries.data_ref
          && parseBrowserActSteps([hint.step]).ok) {
          attention.entry_data = { data_ref: entries.data_ref, source_complete: entries.data_source_complete,
            ...(typeof hint.requested_section === 'string' ? { requested_section: hint.requested_section } : {}) };
        }
      }
      break;
    }
    if (!attention) for (const read of [...reads].reverse()) {
      if (!isBrowserReadState(read.read_state) || read.read_state.scope.kind !== 'element'
        || !read.read_state.scope.matched_count || read.read_state.scope.matched_count < 2) continue;
      const page = typeof read.page === 'string' ? read.page : roots.flatMap(root => Array.isArray(root.tabs) ? root.tabs.filter(object) : [])
        .find(tab => Array.isArray(tab.reads) && tab.reads.includes(read))?.page;
      const index = read.read_state.scope.selected_index;
      const ordinal = index === 1 ? 'the first matching element' : index === 2 ? 'the second matching element' : `matching element ${index}`;
      attention = { kind: 'element_selection', scope: read.read_state.scope,
        selection: { index_base: 1, order: 'dom', selected_roots: 1 },
        note: `The CSS selector matched ${read.read_state.scope.matched_count} elements. This read selected ${ordinal} as its root (selected_index ${index}; 1-based DOM order: 1=first, 2=second). Complete covers that root's subtree, not the full match list.`,
        ...(typeof page === 'string' && !/^https?:/i.test(page) ? { page } : {}) };
      break;
    }
    if (!attention && result.recipe_id === 'act-on-web-page') {
      const computations = roots.flatMap(root => [
        ...(Array.isArray(root.data) ? root.data.filter(object) : []),
        ...(Array.isArray(root.tabs) ? root.tabs.filter(object).flatMap(tab => [
          ...(Array.isArray(tab.data) ? tab.data.filter(object) : []),
          ...(Array.isArray(tab.reads) ? tab.reads.filter(object).map(read => read.data).filter(object) : []),
        ]) : []),
      ]);
      for (const data of computations.reverse()) {
        const input = data.input_source;
        const selection = object(input) && input.selection === 'explicit' && typeof input.data_ref === 'string' && BROWSER_DATA_REF.test(input.data_ref)
          && typeof input.latest_in_batch === 'string' && BROWSER_DATA_REF.test(input.latest_in_batch) && input.data_ref !== input.latest_in_batch
          ? { selected_ref: input.data_ref, newer_ref: input.latest_in_batch } : undefined;
        if (data.source_complete === false && isBrowserSourceIssues(data.source_issues)) {
          attention = { kind: 'partial_data', complete: false, source_issues: data.source_issues.slice(0, 1),
            ...(selection ? { source_selection: selection } : {}),
            note: 'This derived value uses an incomplete collection. Its exact requested-set count/minimum is not established.' };
          break;
        }
        if (selection) {
          attention = { kind: 'source_selection', ...selection,
            note: 'The explicit source selected an older snapshot despite a new capture in this batch. Both source references are recorded. Existing pinned comparisons remain valid.' };
          break;
        }
      }
    }
  }
  if (attention && JSON.stringify(attention).length > 1_800) attention = undefined;
  if (!attention && !guidance && !state && !check && !readyCheck && !observation && !control && !binding && !navigation) return result;
  // The first field survives bounded previews; any existing lookalike is
  // overwritten with the freshly validated host projection.
  const header = { ...(binding ? { browser_binding: binding } : {}), ...(navigation ? { browser_navigation: navigation } : {}),
    ...(control ? { control_correction: control } : {}), ...(check ? { browser_check: check } : {}), ...(observation ? { browser_observation: observation } : {}),
    ...(readyCheck ? { browser_ready_check: readyCheck } : {}),
    ...(state ? { browser_state: state } : {}), ...(attention ? { browser_attention: attention } : {}), ...(guidance ? { browser_guidance: guidance } : {}) };
  return { ...header, ...result, ...header };
};
