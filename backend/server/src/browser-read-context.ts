import { createHash } from 'node:crypto';
import { parseBrowserActSteps, isBrowserReadState, isBrowserPostActionState, isBrowserFailureObservation, browserActStepWrites, readBrowserFailure } from '@recued/contracts';
import type { ChatPriorToolCall } from '@recued/contracts';
import { browserTabKey } from './bridges/browser-routing.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => record(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const READ_TOOLS = new Set(['recued-core/inspect-web-page', 'kitchen/inspect-web-page']);
const BATCH_TOOLS = new Set(['recued-core/act-on-web-page', 'kitchen/act-on-web-page']);
/** A text's lines as two reads of one page are compared: element refs left out, since a page read again numbers its
 *  elements afresh, blank lines skipped. A cut text's last line was cut too, so it is left out. */
const comparableLines = (text: string, cut = false): string[] => {
  const lines = text.split('\n').map((line) => line.replace(/\(e[1-9]\d*\)/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return cut ? lines.slice(0, -1) : lines;
};
/** What a partial preview says in place of its text once the complete read of the same page shows every line of it. */
export const browserPartialPreviewNote = (fullRead: string): string =>
  `(A partial preview of this page was here. Every line it showed is in the complete read ${fullRead} of the same page in this result: read that one.)`;
export interface BrowserReadContextStats { reads_considered: number; reads_elided: number; snapshot_copies_elided: number; field_copies_elided?: number; chars_saved: number }

/** Label the ordering of actually retained observations, without replacing
 * their content or implying that a later action left the page unchanged.
 * IDs refer only to this packet's one-based prior_tool_calls sequence. */
export const projectBrowserObservationOrder = (calls: readonly ChatPriorToolCall[]): readonly ChatPriorToolCall[] => {
  type Observation = { key: string; id: string; page: string; url: string; call: number; position: number; fresh: boolean; whole: boolean;
    superseded?: string; invalidated?: number; lines?: ReadonlySet<string> };
  const latest = new Map<string, Observation>();
  const observations = new Map<string, Observation>();
  const signatures = new Map<number, Map<string, string>>();
  const mutations: Array<{ tab: string; call: number; position: number }> = [];
  let visited = 0, unsafe = false;
  const visit = (value: unknown, parent: { page?: string; url?: string; position?: number },
    found: (v: Record<string, unknown>, page: string, url: string, position: number) => void, depth = 0): void => {
    if (++visited > 20_000 || depth > 32) { unsafe = true; return; }
    if (Array.isArray(value)) { for (const item of value) visit(item, parent, found, depth + 1); return; }
    if (!record(value)) return;
    const page = typeof value.page === 'string' ? value.page : parent.page;
    const url = typeof value.url === 'string' ? value.url : parent.url;
    const position = isBrowserPostActionState(value) ? value.after_step + 0.5 : isBrowserFailureObservation(value) ? value.step + 0.5
      : Number.isSafeInteger(value.step) ? Number(value.step) : parent.position ?? 21;
    if (page && page.length <= 512 && url !== undefined && url.length <= 2_048 && isBrowserReadState(value.read_state)
      && ['outline', 'text', 'lines'].some(key => typeof value[key] === 'string')) found(value, page, url, position);
    for (const [key, child] of Object.entries(value)) if (key !== 'read_state') visit(child, { page, url, position }, found, depth + 1);
  };
  const signature = (value: Record<string, unknown>, page: string, url: string) => canonical([page, url, value.step,
    value.read_state, value.outline ?? value.text ?? value.lines]);
  const roots = (run: Record<string, unknown>): unknown[] => {
    if (run.success === true && record(run.output) && Array.isArray(run.output.render)) return [run.output.render,
      ...(isBrowserPostActionState(run.browser_state) ? [run.browser_state] : [])];
    if (run.success !== false || !Array.isArray(run.errors)) return [];
    return run.errors.flatMap(error => {
      if (!record(error) || !record(error.source) || error.source.ingredient_slug !== 'dom-act') return [];
      const failure = readBrowserFailure({ code: error.code, browser_failure: { slug: 'dom-act', details: error.details } });
      return [...(failure?.details.post_action ? [failure.details.post_action] : []), ...(failure?.details.failure_observation ? [failure.details.failure_observation] : [])];
    }).concat(isBrowserPostActionState(run.browser_state) ? [run.browser_state] : [],
      isBrowserFailureObservation(run.browser_observation) ? [run.browser_observation] : []);
  };
  for (const [index, call] of calls.entries()) {
    const slug = call.tool_name.replace(/^(recued-core|kitchen)\//, '');
    if (call.tier !== 2 || !/^(recued-core|kitchen)\//.test(call.tool_name)
      || !['inspect-web-page', 'read-web-text', 'read-web-element', 'act-on-web-page'].includes(slug)
      || !record(call.result) || call.result.recipe_id !== slug) continue;
    const run = call.result, values = roots(run);
    if (slug === 'act-on-web-page') {
      if (run.success === false && Array.isArray(run.errors)) for (const error of run.errors) {
        if (!record(error) || !record(error.source) || error.source.ingredient_slug !== 'dom-act') continue;
        const details = readBrowserFailure({ code: error.code, browser_failure: { slug: 'dom-act', details: error.details } })?.details;
        const page = details?.batch_progress?.current_page;
        if (details?.check_failure && !details.post_action && page) mutations.push({ tab: browserTabKey(page), call: index, position: details.check_failure.step });
      }
      // Only an actual host result can invalidate a view. Never infer a write
      // from arbitrary captured data, a URL alone, or an unexecuted proposal.
      const posts: Array<{ before_page: string; after_step: number }> = [];
      const scan = (v: unknown, depth = 0): void => {
        if (depth > 12) return;
        if (isBrowserPostActionState(v)) { posts.push(v); return; }
        if (Array.isArray(v)) { for (const item of v) scan(item, depth + 1); }
        else if (record(v)) for (const [key, item] of Object.entries(v)) if (['data', 'tabs', 'post_action'].includes(key)) scan(item, depth + 1);
      };
      for (const value of values) scan(value);
      for (const post of posts) mutations.push({ tab: browserTabKey(post.before_page), call: index, position: post.after_step });
      const args = call.args;
      const parsed = record(args) ? parseBrowserActSteps(args.steps) : undefined;
      if (parsed?.ok && record(args) && typeof args.page === 'string' && !/^https?:/i.test(args.page)) {
        const progress = Array.isArray(run.errors) ? run.errors.flatMap(error => {
          if (!record(error) || !record(error.source) || error.source.ingredient_slug !== 'dom-act') return [];
          return readBrowserFailure({ code: error.code, browser_failure: { slug: 'dom-act', details: error.details } })?.details.batch_progress?.effects ?? [];
        }) : [];
        let page: string | undefined = args.page;
        parsed.steps.forEach((step, i) => {
          if (step.url) page = undefined;
          if (step.page) page = step.page;
          if (page && browserActStepWrites(step) && (run.success === true || progress.some(effect => effect.step === i + 1))) {
            mutations.push({ tab: browserTabKey(page), call: index, position: i + 1 });
          }
        });
      }
    }
    const perCall = new Map<string, string>();
    for (const value of values) visit(value, {}, (v, page, url, position) => {
      if (!isBrowserReadState(v.read_state) || v.read_state.scope.kind === 'unknown') return;
      const hash = signature(v, page, url);
      if (perCall.has(hash)) return;
      const id = `c${index + 1}:r${perCall.size + 1}`;
      const key = canonical([page, url, v.read_state.scope]);
      const previous = latest.get(key);
      if (previous) previous.superseded = id;
      const whole = v.read_state.scope.kind === 'page' && v.read_state.complete === true;
      const text = typeof v.outline === 'string' ? v.outline : typeof v.text === 'string' ? v.text : typeof v.lines === 'string' ? v.lines : '';
      const item = { key, id, page, url, call: index, position, fresh: v.read_state.source === 'bridge_read', whole,
        ...(whole ? { lines: new Set(comparableLines(text)) } : {}) };
      observations.set(id, item); latest.set(key, item); perCall.set(hash, id);
    });
    if (perCall.size) signatures.set(index, perCall);
  }
  if (unsafe || !observations.size) return calls;
  const after = (call: number, position: number, item: Observation) => call > item.call || call === item.call && position > item.position;
  for (const item of observations.values()) {
    const mutation = mutations.find(event => event.tab === browserTabKey(item.page) && after(event.call, event.position, item));
    const route = [...observations.values()].find(view => view.fresh && browserTabKey(view.page) === browserTabKey(item.page)
      && (view.page !== item.page || view.url !== item.url || view.whole) && after(view.call, view.position, item));
    const priorMutation = !item.fresh && mutations.find(event => event.tab === browserTabKey(item.page)
      && (event.call < item.call || event.call === item.call && event.position < item.position));
    item.invalidated = mutation ? mutation.call + 1 : route ? route.call + 1 : priorMutation ? priorMutation.call + 1 : undefined;
  }
  visited = 0;
  const result = calls.map((call, index) => {
    const perCall = signatures.get(index);
    if (!perCall) return call;
    let clone: unknown;
    try { clone = structuredClone(call.result); } catch { unsafe = true; return call; }
    if (!record(clone)) return call;
    for (const root of roots(clone)) visit(root, {}, (value, page, url) => {
      const id = perCall.get(signature(value, page, url)), item = id ? observations.get(id) : undefined;
      if (!item || !isBrowserReadState(value.read_state)) return;
      value.read_state = { ...value.read_state, context: { observation_id: item.id, latest_for_same_scope: latest.get(item.key)?.id === item.id,
        current_for_controls: item.invalidated === undefined && item.superseded === undefined,
        ...(item.invalidated ? { invalidated_by_call: item.invalidated, note: 'Historical view: an action, failed condition or newer page observation followed it. Its controls are not current. Retained data remains usable.' } : {}),
        ...(item.superseded ? { superseded_by: item.superseded } : {}) } };
      if (item.invalidated !== undefined || item.superseded !== undefined) {
        const obsolete = ['loading_recovery', 'next_read', 'next_step'].filter(key => value[key] !== undefined);
        for (const key of obsolete) delete value[key];
        // 2026-11-20 — a partial preview (the view after an action, cut at 3,000 characters) whose every line a complete
        //   read of the same page later in this same result shows adds only a partial list, and it comes first. On task I
        //   (the cheapest of 11 books) the model answered the cheapest of the preview's 7 books, though the preview said
        //   it was partial and historical. A preview holding a line the complete read lacks, such as a message gone by
        //   then, keeps its text.
        const full = item.superseded !== undefined ? observations.get(item.superseded) : undefined;
        const field = typeof value.outline === 'string' ? 'outline' : typeof value.text === 'string' ? 'text' : undefined;
        const state = value.read_state as { complete?: unknown; truncated?: unknown };
        if (full?.lines && full.call === item.call && field !== undefined && (state.complete !== true || state.truncated === true)
          && comparableLines(value[field] as string, state.truncated === true).every((line) => full.lines!.has(line))) {
          value[field] = browserPartialPreviewNote(full.id);
        }
        if (obsolete.length) value.historical_dom_advice = { omitted: obsolete, note: 'Earlier recovery/continuation advice is historical. The current observation is recorded separately. Retained data remains usable.' };
      }
    });
    const items = [...new Set(perCall.values())].map(id => observations.get(id)!);
    if (items.length && items.every(item => item.invalidated !== undefined || item.superseded !== undefined)
      && record(clone.browser_attention) && ['partial_read', 'element_selection', 'batch_stopped'].includes(String(clone.browser_attention.kind))) {
      const { next_step: _next, continuation: _cursor, ...attention } = clone.browser_attention;
      clone.browser_attention = { ...attention, historical: true,
        note: 'Historical browser evidence. The associated observation is superseded. Original coverage and completed-action receipts remain valid.' };
    }
    return { ...call, result: clone };
  });
  return unsafe ? calls : result;
};

/** Prompt projection only. Start with calls that survived fitting, so a receipt
 * never refers to an evicted or abbreviated snapshot. Changed/partial/loading
 * reads and other operations break the sequence. Reads still execute normally;
 * stored results and their provenance are untouched. */
export const projectBrowserReadContext = (calls: readonly ChatPriorToolCall[]) => {
  const stats: BrowserReadContextStats = { reads_considered: 0, reads_elided: 0, snapshot_copies_elided: 0, chars_saved: 0 };
  const projected = [...calls];
  const latest = new Map<string, { fingerprint: string; index: number }>();
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]!;
    const args = call.args;
    const run = call.result;
    if (call.status !== 'ok' || !record(args) || !record(run)
      || run.success !== true || !Array.isArray(run.errors) || run.errors.length) { latest.clear(); continue; }
    const isBatch = BATCH_TOOLS.has(call.tool_name) && call.tier === 2 && run.recipe_id === 'act-on-web-page';
    const fullRead = (input: { find?: unknown; block?: unknown; ref?: unknown; selector?: unknown; from?: unknown }) => !(['find', 'block', 'ref', 'selector'] as const).some(key => input[key] !== undefined && input[key] !== '')
      && (input.from === undefined || input.from === 0);
    const parsed = isBatch ? parseBrowserActSteps(args.steps) : undefined;
    if (isBatch) {
      // Only the host's single act step, containing pure read/data operations.
      // Unknown recipe steps, navigation and even hover/wait break the chain.
      const executed = Array.isArray(run.steps) && run.steps.length === 1 ? run.steps[0] : undefined;
      if (!parsed?.ok || parsed.steps.some(step => step.do !== 'data' && (step.do !== 'read' || !fullRead(step)))
        || !record(executed) || (executed.id ?? executed.step_id) !== 'act'
        || executed.type !== 'ingredient' || executed.skipped === true || executed.error != null) { latest.clear(); continue; }
      if (parsed.steps.every(step => step.do === 'data')) continue;
    } else if (!READ_TOOLS.has(call.tool_name) || run.recipe_id !== 'inspect-web-page' || !fullRead(args)) { latest.clear(); continue; }
    const snapshots = new Map<string, Record<string, unknown>>();
    let visited = 0;
    let unsafe = false;
    const walk = (value: unknown, replace?: (snapshot: Record<string, unknown>) => unknown, depth = 0): unknown => {
      if (++visited > 8_000 || depth > 32) { unsafe = true; return value; }
      if (Array.isArray(value)) return value.map(item => walk(item, replace, depth + 1));
      if (!record(value)) return value;
      if (isBatch && Array.isArray(value.tabs)) {
        if (!parsed?.ok || value.done !== parsed.steps.length || value.of !== parsed.steps.length) { unsafe = true; return value; }
        const seen = new Set<number>();
        const tabs = value.tabs.map(tab => {
          if (!record(tab) || typeof tab.page !== 'string' || typeof tab.url !== 'string' || typeof tab.title !== 'string'
            || ['opened', 'closed', 'files', 'pdf', 'pdfs', 'changes', 'page_observation', 'page_observation_omitted'].some(key => tab[key] !== undefined)
            || !Array.isArray(tab.reads)) { unsafe = true; return tab; }
          return { ...tab, reads: tab.reads.map(read => {
            if (!record(read) || !Number.isInteger(read.step) || seen.has(read.step as number)) { unsafe = true; return read; }
            const step = parsed.steps[(read.step as number) - 1];
            seen.add(read.step as number);
            // Computations remain verbatim, including differing values and their
            // source/coverage descriptors. Never visit data as page content.
            if (step?.do === 'data' && record(read.data)) return read;
            if (step?.do !== 'read' || (typeof read.outline !== 'string' && typeof read.text !== 'string')
              || read.truncated !== false || read.complete === false || read.loading === true || read.next !== undefined) { unsafe = true; return read; }
            const snapshot = { ...read, page: tab.page, url: tab.url, title: tab.title };
            if (replace) return replace(snapshot);
            snapshots.set(canonical(snapshot), snapshot);
            return read;
          }) };
        });
        if (seen.size !== parsed.steps.length) unsafe = true;
        return { ...value, tabs };
      }
      if (!isBatch && typeof value.page === 'string' && typeof value.url === 'string' && typeof value.title === 'string'
        && (typeof value.outline === 'string' || typeof value.text === 'string')) {
        if (value.truncated !== false || value.complete === false || value.loading === true || value.next !== undefined) { unsafe = true; return value; }
        if (replace) return replace(value);
        snapshots.set(canonical(value), value);
        return value;
      }
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, replace, depth + 1)]));
    };
    walk(run);
    if (unsafe || snapshots.size !== 1) { latest.clear(); continue; }
    const [serialized, snapshot] = [...snapshots.entries()][0]!;
    const page = snapshot.page as string;
    stats.reads_considered += 1;
    const fingerprint = createHash('sha256').update(serialized).digest('hex');
    const retained = latest.get(page);
    if (!retained || retained.fingerprint !== fingerprint) { latest.set(page, { fingerprint, index }); continue; }
    let copies = 0;
    visited = 0;
    const result = walk(run, value => {
      copies += 1;
      return { ...(isBatch ? { step: value.step } : {}), page: value.page, url: value.url, title: value.title,
        duplicate_read: { prior_tool_call: retained.index + 1, snapshot_sha256: fingerprint,
          note: 'Full identical observation is retained in that prior_tool_calls entry (one-based). This earlier read executed normally.' } };
    });
    const saved = JSON.stringify(run).length - JSON.stringify(result).length;
    if (unsafe || saved <= 0) continue;
    projected[index] = { ...call, result };
    stats.reads_elided += 1;
    stats.snapshot_copies_elided += copies;
    stats.chars_saved += saved;
    // Always point to the full retained call, never to another receipt.
  }
  return { calls: projected, stats };
};
