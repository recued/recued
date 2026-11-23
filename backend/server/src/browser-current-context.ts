import { BROWSER_DATA_REF, BROWSER_COLLECT_MAX_PAGES, BROWSER_COLLECT_MAX_ITEMS, BROWSER_COLLECT_MAX_SECONDS,
  isBrowserReadState, isBrowserInteractionTargets, isBrowserPostActionState, isBrowserFailureObservation, parseBrowserActSteps,
  type ChatPriorToolCall } from '@recued/contracts';
import { browserTabKey } from './bridges/browser-routing.js';

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const handle = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/^https?:/i.test(v);
const trusted = (call: ChatPriorToolCall): call is ChatPriorToolCall & { result: Record<string, unknown> } => call.tier === 2
  && /^(recued-core|kitchen)\/(act-on-web-page|inspect-web-page|read-web-text|read-web-element)$/.test(call.tool_name)
  && object(call.result) && call.result.recipe_id === call.tool_name.replace(/^(recued-core|kitchen)\//, '');
// Observation ordering adds prompt-only context. Validate the original read
// contract separately; no context supplied by captured page text qualifies.
const orderedRead = (v: unknown) => {
  if (!object(v) || !object(v.read_state)) return;
  const { context, ...state } = v.read_state;
  if (!isBrowserReadState(state) || !object(context) || typeof context.observation_id !== 'string'
    || !/^c[1-9]\d*:r[1-9]\d*$/.test(context.observation_id)) return;
  return { state, context };
};
const passive = (v: unknown): v is Record<string, unknown> => {
  if (!object(v) || !object(v.view)) return false;
  const read = orderedRead(v.view);
  if (!read) return false;
  const original = { ...v, view: { ...v.view, read_state: read.state } };
  return isBrowserPostActionState(original) || isBrowserFailureObservation(original);
};
type Passive = { value: Record<string, unknown>; path: Array<string | number> };
const passiveViews = (run: Record<string, unknown>): Passive[] => {
  const views: Passive[] = [];
  const add = (v: unknown, path: Array<string | number>) => { if (passive(v)) views.push({ value: v, path }); };
  add(run.browser_state, ['browser_state']); add(run.browser_observation, ['browser_observation']);
  if (Array.isArray(run.errors)) run.errors.forEach((error, i) => {
    if (!object(error) || !object(error.source) || error.source.ingredient_slug !== 'dom-act' || !object(error.details)) return;
    add(error.details.post_action, ['errors', i, 'details', 'post_action']);
    add(error.details.failure_observation, ['errors', i, 'details', 'failure_observation']);
  });
  if (object(run.output) && Array.isArray(run.output.render)) run.output.render.forEach((row, i) => {
    if (!object(row) || row.type !== 'json' || !object(row.data)) return;
    add(row.data.post_action, ['output', 'render', i, 'data', 'post_action']);
    if (Array.isArray(row.data.tabs)) row.data.tabs.forEach((tab, j) => {
      if (object(tab)) add(tab.post_action, ['output', 'render', i, 'data', 'tabs', j, 'post_action']);
    });
  });
  return views;
};

/** An empty computation is positive evidence of no selected items, not an item
 * fact or an action result. Only authored data steps may supply this receipt. */
const latestEmptyComputation = (calls: readonly ChatPriorToolCall[]): Record<string, unknown> | undefined => {
  let latest: Record<string, unknown> | undefined;
  for (const [index, call] of calls.entries()) {
    if (!trusted(call) || call.result.success !== true || !object(call.result.output) || !Array.isArray(call.result.output.render)) continue;
    if (call.result.recipe_id !== 'act-on-web-page') { latest = undefined; continue; }
    const parsed = object(call.args) ? parseBrowserActSteps(call.args.steps) : undefined;
    if (!parsed?.ok) continue;
    const results: Array<{ step: number; value: Record<string, unknown> }> = [];
    for (const row of call.result.output.render) {
      if (!object(row) || row.type !== 'json' || !object(row.data)) continue;
      const root = row.data;
      if (Array.isArray(root.data)) for (const value of root.data) if (object(value) && Number.isSafeInteger(value.step))
        results.push({ step: Number(value.step), value });
      if (Array.isArray(root.tabs)) for (const tab of root.tabs) if (object(tab) && Array.isArray(tab.reads))
        for (const read of tab.reads) if (object(read) && Number.isSafeInteger(read.step))
          results.push({ step: Number(read.step), value: object(read.data) ? read.data : read });
    }
    for (const { step, value } of results.sort((a, b) => a.step - b.step)) {
      const authored = parsed.steps[step - 1];
      if (authored && ['read', 'table', 'collect'].includes(authored.do)) { latest = undefined; continue; }
      if (authored?.do !== 'data' || typeof value.data_ref !== 'string' || !BROWSER_DATA_REF.test(value.data_ref)
        || typeof value.source_complete !== 'boolean' || !object(value.input_source)
        || typeof value.input_source.data_ref !== 'string' || !BROWSER_DATA_REF.test(value.input_source.data_ref)) continue;
      latest = value.kind === 'array' && value.row_count === 0 && Array.isArray(value.value) && value.value.length === 0 ? {
        source_call: index + 1, step, data_ref: value.data_ref, input_ref: value.input_source.data_ref,
        result_kind: 'empty_array', item_facts_returned: false, source_complete: value.source_complete,
        note: 'This computation selected no items. Empty can answer a matching absence question; it supplies no item title/value/order fact. When the request needs an item fact, obtain supporting records using the retained input and exact captured section labels. Capture completeness does not validate the predicate.' } : undefined;
    }
  }
  return latest;
};

/** Complete examples only when the capture supplies every argument. Unknown
 * text stays with the author; examples never choose a value or execute. */
const addControlCallExamples = (context: { pages: Record<string, unknown>[]; [key: string]: unknown }, tool: string,
  attachments: readonly { file_ref: string }[]) => {
  const note = 'Call examples are authoring alternatives, not recommendations or an execution sequence. Choose only requested actions. Combine chosen steps in the same document into one call, copying its page/ref together. Existing approval and document checks still apply.';
  const candidate = { ...context, call_examples_note: note };
  if (JSON.stringify(candidate).length > 6_000) return context;
  let count = 0, chars = 0;
  const file = attachments.length === 1 && /^file:[0-9a-f]{32}$/.test(attachments[0]!.file_ref) ? attachments[0]!.file_ref : undefined;
  for (const page of context.pages) {
    if (!handle(page.page) || !object(page.interaction_targets) || !Array.isArray(page.interaction_targets.items)) continue;
    const items = page.interaction_targets.items.filter(object);
    // Protected input first; the submit example must not crowd it out.
    const navigation = page.interaction_targets.captured_editable_fields === 0 && object(page.read_state) && page.read_state.loading === true
      ? items.filter(item => item.tag === 'a') : [];
    for (const item of [...items.filter(item => item.tag === 'input' && String(item.type).toLowerCase() === 'password'),
      ...items.filter(item => item.tag === 'input' && String(item.type).toLowerCase() === 'file'),
      ...items.filter(item => ['input', 'button'].includes(String(item.tag)) && String(item.type).toLowerCase() === 'submit'), ...navigation]) {
      if (count === 3 || item.disabled === true || item.readonly === true || !Array.isArray(item.actions)) continue;
      const type = String(item.type).toLowerCase();
      const step = type === 'password' && item.actions.includes('type')
        ? { do: 'type', ref: item.ref, secret: 'password' }
        : type === 'file' && item.actions.includes('upload') && file ? { do: 'upload', ref: item.ref, file }
        : (type === 'submit' || navigation.includes(item)) && item.actions.includes('click') ? { do: 'click', ref: item.ref } : undefined;
      if (!step || !parseBrowserActSteps([step], { page: page.page }).ok) continue;
      const example = { tool, args: { page: page.page, steps: step.do === 'click' ? [step, { do: 'read', form: 'outline' }] : [step] } };
      const size = JSON.stringify(example).length;
      if (chars + size > 900) continue;
      item.call_example = example;
      if (JSON.stringify(candidate).length > 6_000) { delete item.call_example; continue; }
      count++; chars += size;
    }
  }
  return count ? candidate : context;
};

/** Facts from the latest retained usable observation in each owning tab. No
 * guessed next action, task interpretation or extra browser read. */
export const browserCurrentContext = (calls: readonly ChatPriorToolCall[], actTool?: string,
  attachments: readonly { file_ref: string }[] = []): Record<string, unknown> | undefined => {
  const emptyComputation = latestEmptyComputation(calls);
  const latest = new Map<string, { position: number; value: Record<string, unknown> }>();
  for (const [index, call] of calls.entries()) {
    if (!trusted(call)) continue;
    const run = call.result;
    const add = (v: unknown, page: unknown, url: unknown, position: number) => {
      const read = orderedRead(v);
      if (!object(v) || !read || read.state.source !== 'bridge_read' || read.context.current_for_controls !== true
        || !handle(page) || typeof url !== 'string' || url.length > 2_048) return;
      const targets = isBrowserInteractionTargets(v.interaction_targets)
        && (read.state.loading !== true || v.interaction_targets.source_complete === false) ? v.interaction_targets : undefined;
      const value = { source_call: index + 1, observation_id: read.context.observation_id, page, url, read_state: read.state,
        ...(targets ? { interaction_targets: { ...targets, items: targets.items.map(item => ({ ...item, target: { page, ref: item.ref } })) } } : {}) };
      const order = index * 100 + position, tab = browserTabKey(page);
      if (!latest.has(tab) || latest.get(tab)!.position <= order) latest.set(tab, { position: order, value });
    };
    for (const { value } of passiveViews(run)) if (object(value.view)) add(value.view, value.view.page, value.view.url,
      Number(value.after_step ?? value.step) + 0.5);
    if (run.success !== true || !object(run.output) || !Array.isArray(run.output.render)) continue;
    const parsed = object(call.args) && run.recipe_id === 'act-on-web-page' ? parseBrowserActSteps(call.args.steps) : undefined;
    for (const row of run.output.render) {
      if (!object(row) || row.type !== 'json' || !object(row.data)) continue;
      const root = row.data;
      if (run.recipe_id !== 'act-on-web-page') add(root, root.page, root.url, 21);
      else if (parsed?.ok && Array.isArray(root.tabs)) for (const tab of root.tabs) {
        if (!object(tab) || !Array.isArray(tab.reads)) continue;
        for (const read of tab.reads) if (object(read) && Number.isSafeInteger(read.step)
          && parsed.steps[Number(read.step) - 1]?.do === 'read') add(read, tab.page, tab.url, Number(read.step));
      }
    }
  }
  if (!latest.size && !emptyComputation) return;
  const pages: Record<string, unknown>[] = [];
  const result: { pages: Record<string, unknown>[]; [key: string]: unknown; omitted_tabs: number } = { pages, omitted_tabs: latest.size,
    note: 'Latest retained observations, not guaranteed live state. Copy each control\'s full target.page and target.ref together; never shorten a document handle or substitute its URL. Actions describe this capture, not permission. Counts are scoped; incomplete sources do not prove absence. Control contexts name containing records; position is captured sibling order and ordinal is literal displayed rank, not score order. Containment alone proves neither task identity nor persistence. view_ref and field_refs reference identical retained content in this packet. Existing guards apply.' };
  for (const { value } of [...latest.values()].sort((a, b) => b.position - a.position)) {
    if (pages.length === 3) break;
    if (JSON.stringify({ ...result, pages: [...pages, value] }).length > 6_000) continue;
    pages.push(value); result.omitted_tabs--;
  }
  for (const page of pages) {
    if (!object(page.interaction_targets) || page.interaction_targets.captured_editable_fields !== 0) continue;
    page.typing_context = { observed_editable_fields: 0, type_step_supported_by_capture: false, capture_only: true,
      note: Number(page.interaction_targets.captured_upload_fields) > 0
        ? 'This capture supports upload, not type, for its file input. Use an exact current-turn attachment file_ref with do:upload and the owning page/ref. Incomplete coverage does not prove other fields absent.'
        : 'This capture supports no type step. Obtain an observed editable target before authoring type; never invent a field ref or selector from the task or tool examples. If navigation is needed, choose an observed link; otherwise obtain the missing field evidence. Incomplete coverage does not prove fields are absent from the live page.' };
    if (JSON.stringify(result).length > 6_000) delete page.typing_context;
  }
  if (emptyComputation) {
    result.latest_computation = emptyComputation;
    if (JSON.stringify(result).length > 6_000) delete result.latest_computation;
  }
  result.collection_limits = { max_pages: BROWSER_COLLECT_MAX_PAGES, max_items: BROWSER_COLLECT_MAX_ITEMS, max_seconds: BROWSER_COLLECT_MAX_SECONDS };
  if (JSON.stringify(result).length > 6_000) delete result.collection_limits;
  return pages.length || result.latest_computation ? actTool && /^(recued-core|kitchen)\/act-on-web-page$/.test(actTool) ? addControlCallExamples(result, actTool, attachments) : result : undefined;
};

/** Elide only byte-identical passive view copies within one retained host
 * result, after ordering. The full canonical view stays in the same packet;
 * every action/check/progress receipt and the stored audit remain unchanged. */
export const compactBrowserPassiveViews = (calls: readonly ChatPriorToolCall[]) => {
  let copies = 0, chars = 0;
  const projected = calls.map((call, index) => {
    if (!trusted(call)) return call;
    const seen = new Map<string, { observation_id: string; path: string }>();
    const duplicates: Array<{ path: Array<string | number>; ref: { observation_id: string; path: string } }> = [];
    for (const { value, path } of passiveViews(call.result)) {
      const view = value.view, read = orderedRead(view);
      if (!read) continue;
      const signature = JSON.stringify(view), reference = seen.get(signature);
      if (reference) duplicates.push({ path, ref: reference });
      else seen.set(signature, { observation_id: String(read.context.observation_id),
        path: `/prior_tool_calls/${index}/result/${[...path, 'view'].join('/')}` });
    }
    if (!duplicates.length) return call;
    let result: Record<string, unknown>;
    // The engine and promoted header can share the same wrapper by reference.
    // Break those aliases as the outgoing JSON does before replacing a copy;
    // structuredClone would preserve them and could remove the canonical view.
    try { result = JSON.parse(JSON.stringify(call.result)) as Record<string, unknown>; } catch { return call; }
    for (const duplicate of duplicates) {
      let at: unknown = result;
      for (const key of duplicate.path) at = object(at) || Array.isArray(at) ? (at as Record<string | number, unknown>)[key] : undefined;
      if (!object(at) || !object(at.view)) continue;
      const originalSize = JSON.stringify(at.view).length;
      if (JSON.stringify(duplicate.ref).length + 16 >= originalSize) continue;
      delete at.view; at.view_ref = duplicate.ref;
      copies++; chars += originalSize - JSON.stringify(duplicate.ref).length - 4;
    }
    return { ...call, result };
  });
  return { calls: projected, copies, chars };
};

/** Reuse identical fields of an explicit read in this same successful batch.
 * Keep the passive view's own coverage/order and every action/check receipt.
 * These references assert byte equality, not readiness or application success. */
export const compactBrowserReadFields = (calls: readonly ChatPriorToolCall[]) => {
  let copies = 0, chars = 0;
  const fields = ['outline', 'control_evidence', 'field_evidence', 'extraction_targets', 'interaction_targets'] as const;
  const projected = calls.map((call, index) => {
    if (!trusted(call) || call.result.success !== true || call.result.recipe_id !== 'act-on-web-page'
      || !object(call.args) || !object(call.result.output) || !Array.isArray(call.result.output.render)) return call;
    const parsed = parseBrowserActSteps(call.args.steps);
    if (!parsed.ok) return call;
    const reads: Array<{ value: Record<string, unknown>; page: string; url: string; step: number; path: string }> = [];
    call.result.output.render.forEach((row, i) => {
      if (!object(row) || row.type !== 'json' || !object(row.data) || !Array.isArray(row.data.tabs)) return;
      row.data.tabs.forEach((tab, j) => {
        if (!object(tab) || !handle(tab.page) || typeof tab.url !== 'string' || !Array.isArray(tab.reads)) return;
        for (const [k, read] of tab.reads.entries()) {
          const state = orderedRead(read);
          if (!object(read) || !state || state.state.source !== 'bridge_read' || state.state.loading !== false
            || state.state.scope.kind === 'unknown' || !Number.isSafeInteger(read.step)
            || read.page !== undefined && read.page !== tab.page || read.url !== undefined && read.url !== tab.url
            || parsed.steps[Number(read.step) - 1]?.do !== 'read') continue;
          reads.push({ value: read, page: tab.page, url: tab.url, step: Number(read.step),
            path: `/prior_tool_calls/${index}/result/output/render/${i}/data/tabs/${j}/reads/${k}` });
        }
      });
    });
    const edits: Array<{ path: Array<string | number>; refs: Record<string, { observation_id: string; path: string }> }> = [];
    for (const { value, path } of passiveViews(call.result)) {
      const view = value.view, state = orderedRead(view);
      if (!object(view) || !state || state.state.source !== 'bridge_read' || state.state.loading !== false) continue;
      const source = [...reads].reverse().find(read => read.page === view.page && read.url === view.url
        && read.step > Number(value.after_step ?? value.step)
        && JSON.stringify(orderedRead(read.value)!.state.scope) === JSON.stringify(state.state.scope));
      if (!source) continue;
      const refs: Record<string, { observation_id: string; path: string }> = {};
      for (const key of fields) {
        if (view[key] === undefined || JSON.stringify(view[key]) !== JSON.stringify(source.value[key])) continue;
        const ref = { observation_id: String(orderedRead(source.value)!.context.observation_id), path: `${source.path}/${key}` };
        if (JSON.stringify(view[key]).length > JSON.stringify(ref).length + key.length + 32) refs[key] = ref;
      }
      if (Object.keys(refs).length) edits.push({ path, refs });
    }
    if (!edits.length) return call;
    let result: Record<string, unknown>;
    try { result = JSON.parse(JSON.stringify(call.result)) as Record<string, unknown>; } catch { return call; }
    let count = 0;
    for (const edit of edits) {
      let at: unknown = result;
      for (const key of edit.path) at = object(at) || Array.isArray(at) ? (at as Record<string | number, unknown>)[key] : undefined;
      if (!object(at) || !object(at.view)) continue;
      for (const key of Object.keys(edit.refs)) { delete at.view[key]; count++; }
      at.view.field_refs = edit.refs;
    }
    const saved = JSON.stringify(call.result).length - JSON.stringify(result).length;
    if (saved <= 0) return call;
    copies += count; chars += saved;
    return { ...call, result };
  });
  return { calls: projected, copies, chars };
};
