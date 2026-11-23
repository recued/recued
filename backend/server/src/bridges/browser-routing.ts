/** Server-owned browser identity. A handle selects a paired browser, not an
 * authority: ordinary recipe, origin, approval and Bridge grants still apply. */
import { bridgeRunsCommand, isPatternWithinGrantedOrigins, kernelOpForBackingSlug, type BridgeResult } from '@recued/contracts';
import { IngredientError } from '@recued/ingredients';
import type { BrowserCommand } from './browser-step-commands.js';
import type { BridgeDispatcher, DispatchOutcome, DispatchRequest } from './dispatcher.js';
import type { BridgeConnectionRecord, BridgeRegistry } from './registry.js';

export interface BrowserBridge { bridge_id: string; bridge_label: string; online: boolean }

/** D-402 slice H3 (§4.2 item 3) — a browser step as the check before step 1 reads it
 *  (`browser-step-check.ts`). */
export interface BrowserStepNeed {
  readonly step_id: string;
  /** The setting that names its browser. */
  readonly setting: string;
  /** What the setting holds for this run: the browser's lasting id, or a token id. */
  readonly browser_id: string;
  /** The site the step acts on, when the run knows it before step 1. */
  readonly target?: string;
  /** Slice H3b — the commands it may send (`browser-step-commands.ts`), when known before step 1. */
  readonly commands?: readonly BrowserCommand[];
}
/** What stops a step's browser, the browser named as its owner named it. A browser no longer paired
 *  has a name only when its pairing left one. */
export type BrowserStepProblem = BrowserStepNeed & (
  | { readonly problem: 'not_paired'; readonly name?: string }
  | { readonly problem: 'offline'; readonly name: string }
  | { readonly problem: 'site'; readonly name: string; readonly site: string }
  /** Slice H3b — its Bridge cannot run one of the step's commands: the version it reported. */
  | { readonly problem: 'update'; readonly name: string; readonly version?: string });

/** A site pattern as the owner reads it: `https://water.example.com/*` is water.example.com. */
export const browserSiteOf = (pattern: string): string => pattern === '<all_urls>' || /^\*:\/\/\*\/\*$/u.test(pattern)
  ? 'every site' : pattern.replace(/^[a-z*]+:\/\//iu, '').replace(/\/.*$/u, '') || pattern;
export const browserPage = (bridge: string, page: string): string => `bridge:${encodeURIComponent(bridge)}:${page}`;
export const browserPageOwner = (page: unknown): { bridge_id: string; page: string } | undefined => {
  if (typeof page !== 'string' || !page.startsWith('bridge:')) return undefined;
  const match = /^bridge:([^:]+):(\d{1,10}:[\w-]{1,128})$/.exec(page);
  if (!match) throw new IngredientError('DOM_SELECTOR_MISSING', 'The browser page handle is invalid. Copy a handle from List browser tabs.');
  try { return { bridge_id: decodeURIComponent(match[1]!), page: match[2]! }; }
  catch { throw new IngredientError('DOM_SELECTOR_MISSING', 'The browser page handle is invalid.'); }
};
/** Navigation changes the document suffix, but neither its browser nor tab. */
export const browserTabKey = (page: string): string => page.includes(':') ? page.slice(0, page.lastIndexOf(':')) : page;
export const browserBridgeId = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 256)
    throw new IngredientError('DOM_SELECTOR_MISSING', 'bridge_id must be an ID from List browser bridges or List browser tabs.');
  return value;
};

export const browserRouting = (input: Record<string, unknown>): Pick<DispatchRequest, 'browser_routing' | 'bridge_id'> => {
  const bridge_id = browserBridgeId(input.bridge_id);
  return { browser_routing: true, ...(bridge_id !== undefined ? { bridge_id } : {}) };
};
/** A community ingredient's name (or business field named bridge_id) cannot
 * opt it into the kernel Browser Toolkit's interactive selection contract. */
export const browserCallRouting = (slug: string, input: Record<string, unknown>): Pick<DispatchRequest, 'browser_routing' | 'bridge_id'> =>
  kernelOpForBackingSlug(slug)?.startsWith('core.dom.') ? browserRouting(input) : {};
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const bindResult = (outcome: DispatchOutcome, bridge: BrowserBridge,
  remember: (id: string, page: string, url: string) => void): DispatchOutcome => {
  if (outcome.kind !== 'completed' || outcome.result.status !== 'ok' || !outcome.result.outputs) return outcome;
  const outputs: Record<string, unknown> = { ...outcome.result.outputs, bridge_id: bridge.bridge_id, bridge_label: bridge.bridge_label };
  const bind = (value: Record<string, unknown>) => {
    if (typeof value.page === 'string') {
      if (typeof value.url === 'string') remember(bridge.bridge_id, value.page, value.url);
      return { ...value, page: browserPage(bridge.bridge_id, value.page), bridge_id: bridge.bridge_id, bridge_label: bridge.bridge_label };
    }
    return { ...value, bridge_id: bridge.bridge_id, bridge_label: bridge.bridge_label };
  };
  Object.assign(outputs, bind(outputs));
  if (Array.isArray(outputs.tabs)) outputs.tabs = outputs.tabs.filter(record).map(bind);
  // The Bridge names cross-origin frame documents inside cleaned HTML too.
  // Those handles must not escape without their owning browser namespace.
  if (typeof outputs.html === 'string') outputs.html = outputs.html.replace(/<iframe\b[^>]*>/g, tag =>
    tag.replace(/ page="(\d{1,10}:[\w-]{1,128})"/, (_match, page: string) => {
      const src = / src="([^"]*)"/.exec(tag)?.[1];
      if (src) {
        try { remember(bridge.bridge_id, page, new URL(src, typeof outputs.url === 'string' ? outputs.url : undefined).href); }
        catch { /* The frame remains bound even when its source cannot narrow an origin. */ }
      }
      return ` page="${browserPage(bridge.bridge_id, page)}"`;
    }));
  return { ...outcome, result: { ...outcome.result, outputs } };
};

/** Only the public tab-discovery read fans out. All other browser calls select
 * exactly one Bridge, including old unqualified handles while one is eligible. */
export const withBrowserRouting = (base: BridgeDispatcher, registry: BridgeRegistry,
  /** The pairing roster: each browser's current token, the owner's name for it, and (D-402 slice H1)
   *  its lasting id (`browser-identity.ts`). */
  paired?: () => ReadonlyArray<{ bridge_id: string; bridge_label: string; browser_id?: string }>,
  /** D-402 slice H3 — the name a browser no longer paired went by (`browser-identity.ts`). */
  formerName?: (browser_id: string) => string | undefined): BridgeDispatcher => {
  // An address observed on a Bridge can narrow its next command to a granted
  // origin. It never broadens the recipe target. Bounded, per dispatcher.
  const urls = new Map<string, string>();
  const remember = (id: string, page: string, url: string) => {
    const key = browserPage(id, page); urls.delete(key); urls.set(key, url);
    while (urls.size > 4_000) urls.delete(urls.keys().next().value!);
  };
  const bind = (outcome: DispatchOutcome, bridge: BrowserBridge) => bindResult(outcome, bridge, remember);
  const bridges = (): BrowserBridge[] => {
    const known = new Map<string, BrowserBridge>((paired?.() ?? []).map(row => [row.bridge_id,
      { bridge_id: row.bridge_id, bridge_label: row.bridge_label, online: false }]));
    // D-402 slice H1 — a connected browser goes by the roster's name, the owner's, so a rename reaches
    // the routing; the label it paired with only when the roster does not know it.
    for (const row of registry.list()) known.set(row.client_token_id, { bridge_id: row.client_token_id,
      bridge_label: known.get(row.client_token_id)?.bridge_label ?? row.client_label ?? row.client_token_id, online: true });
    return [...known.values()];
  };
  const labelOf = (row: BridgeConnectionRecord): string =>
    (paired?.() ?? []).find(one => one.bridge_id === row.client_token_id)?.bridge_label ?? row.client_label ?? row.client_token_id;
  /** D-402 slice H1 — a browser named by its lasting id (a recipe's `browser` setting) routes to its
   *  current token; a token id, or an id the roster does not know, stays as it is. */
  const current = (id: string | undefined): string | undefined => {
    if (id === undefined || registry.get(id)) return id;
    const roster = paired?.() ?? [];
    if (roster.some(row => row.bridge_id === id)) return id;
    return roster.find(row => row.browser_id === id)?.bridge_id ?? id;
  };
  const missingBridge = (id: string, fromPage: boolean): IngredientError => {
    const roster = bridges(), known = roster.find(row => row.bridge_id === id);
    // Without the pairing roster, absence from live connections cannot prove
    // the ID is unknown. Never guess a replacement browser in either case.
    const unknown = paired !== undefined && !known;
    const message = unknown
      ? `Unknown Browser Bridge ID ${JSON.stringify(id)} in the supplied ${fromPage ? 'page handle' : 'bridge_id'}. `
        + `Copy an exact ${fromPage ? 'page handle from a prior browser result or List browser tabs' : 'bridge_id from List browser bridges'}. No browser was contacted for this routing attempt.`
      : known?.online === false
        ? `Browser Bridge ${id} is paired but offline. Reconnect it; this call will not use another browser.`
        : `No connected Browser Bridge matches ${JSON.stringify(id)}. Verify the exact ${fromPage ? 'page handle from a prior browser result or List browser tabs' : 'bridge_id from List browser bridges'} and check that Bridge's connection.`;
    return new IngredientError(unknown ? 'DOM_PAGE_NOT_MATCHING' : 'ROLE_RESTRICTION', message, { executed: false,
      reason: unknown ? 'bridge_unknown' : 'bridge_unavailable', bridges: roster.filter(row => row.online).slice(0, 32) });
  };
  const select = (request: DispatchRequest): { request: DispatchRequest; bridge: BrowserBridge } => {
    const owner = browserPageOwner(request.args.page);
    const explicit = current(browserBridgeId(request.bridge_id));
    if (owner && explicit && owner.bridge_id !== explicit)
      throw new IngredientError('DOM_PAGE_NOT_MATCHING', 'bridge_id conflicts with the browser that owns this page.', { executed: false });
    const id = explicit ?? owner?.bridge_id;
    const originalPattern = request.target_domain_pattern ?? request.ingredient.domain_allowlist[0];
    let pattern = originalPattern;
    const page = owner?.page ?? (typeof request.args.page === 'string' ? request.args.page : undefined);
    const address = request.browser_address ?? (typeof request.args.url === 'string' ? request.args.url
      : id && page ? urls.get(browserPage(id, page)) : undefined);
    if (address) {
      try {
        // Chrome origin patterns do not carry ports.
        const url = new URL(address), narrowed = `${url.protocol}//${url.hostname}/*`;
        if (originalPattern && /^https?:$/.test(url.protocol)
          && isPatternWithinGrantedOrigins(narrowed, [originalPattern])) pattern = narrowed;
      } catch { /* The native argument validator supplies the address error. */ }
    }
    const forBridge = (row: BridgeConnectionRecord) => originalPattern
      && isPatternWithinGrantedOrigins(originalPattern, row.capabilities.granted_origins) ? originalPattern : pattern;
    const candidates = registry.list().filter(row => (!request.preferred_bridge_label || row.client_label === request.preferred_bridge_label)
      && forBridge(row) !== undefined && isPatternWithinGrantedOrigins(forBridge(row)!, row.capabilities.granted_origins)
      && bridgeRunsCommand(row.capabilities, request.action, request.args));
    const row = id ? registry.get(id) : candidates.length === 1 ? candidates[0] : undefined;
    if (!row) {
      if (id) throw missingBridge(id, owner !== undefined);
      const choices = bridges().filter(row => row.online).slice(0, 32);
      throw new IngredientError('ROLE_RESTRICTION', choices.length > 1 ? `Choose a browser with bridge_id, or use its page handle from List browser tabs: ${choices.map(row => `${row.bridge_label} (${row.bridge_id})`).join(', ')}.`
          : 'No eligible Browser Bridge is connected. Check its site permissions and supported actions.',
      { executed: false, reason: candidates.length > 1 ? 'bridge_selection_required' : 'bridge_unavailable', bridges: choices });
    }
    if (!candidates.some(candidate => candidate.client_token_id === row.client_token_id))
      throw new IngredientError('ROLE_RESTRICTION', 'The selected Browser Bridge cannot serve this site or action. Check its permissions and version.',
        { executed: false, bridge_id: row.client_token_id });
    return { bridge: { bridge_id: row.client_token_id, bridge_label: labelOf(row), online: true },
      request: { ...request, bridge_id: row.client_token_id, ...(forBridge(row) ? { target_domain_pattern: forBridge(row) } : {}),
        args: { ...request.args, ...(owner ? { page: owner.page } : {}) } } };
  };
  const listTabs = async (request: DispatchRequest): Promise<DispatchOutcome> => {
    const id = current(browserBridgeId(request.bridge_id));
    const roster = bridges().filter(bridge => !id || bridge.bridge_id === id);
    if (id && !roster.length) throw missingBridge(id, false);
    const rows: Array<Record<string, unknown>> = [];
    const tabs: Record<string, unknown>[] = [];
    let cursor = 0, truncated = roster.length > 32;
    const included = roster.slice(0, 32);
    // Bounded parallel reads. A slow or disconnected browser never hides the others.
    await Promise.all(Array.from({ length: Math.min(4, included.length) }, async () => {
      for (;;) {
        const index = cursor++, bridge = included[index];
        if (!bridge) return;
        if (!bridge.online) { rows[index] = { ...bridge, status: 'offline' }; continue; }
        try {
          const connected = registry.get(bridge.bridge_id);
          const target = request.target_domain_pattern ?? request.ingredient.domain_allowlist[0];
          if (!connected || !target) { rows[index] = { ...bridge, status: 'unavailable' }; continue; }
          const origins = connected.capabilities.granted_origins;
          const patterns = isPatternWithinGrantedOrigins(target, origins) ? [target]
            : [...new Set(origins.filter(origin => isPatternWithinGrantedOrigins(origin, [target])))];
          if (!patterns.length) { rows[index] = { ...bridge, status: 'permission_missing' }; continue; }
          const found: Record<string, unknown>[] = [], seen = new Set<string>();
          const until = Date.now() + Math.min(request.timeout_ms ?? 5_000, 5_000);
          let partial = patterns.length > 16;
          for (const pattern of patterns.slice(0, 16)) {
            if (Date.now() >= until) { partial = true; break; }
            const chosen = select({ ...request, bridge_id: bridge.bridge_id, target_domain_pattern: pattern });
            const result = bind(await base.dispatch({ ...chosen.request, browser_discovery: true,
              timeout_ms: Math.max(1, until - Date.now()), idempotency_key: `${request.idempotency_key}:${encodeURIComponent(pattern)}` }), bridge);
            if (result.kind !== 'completed' || result.result.status !== 'ok') { partial = true; break; }
            const out = result.result.outputs ?? {};
            if (!Array.isArray(out.tabs)) { partial = true; break; }
            for (const tab of out.tabs.filter(record)) if (typeof tab.page === 'string' && !seen.has(tab.page)) {
              seen.add(tab.page); found.push(tab);
            }
            if (out.truncated === true) partial = true;
          }
          rows[index] = { ...bridge, status: partial ? 'partial' : 'ok', count: found.length, truncated: partial };
          tabs.push(...found);
          if (partial) truncated = true;
        } catch (error) {
          rows[index] = { ...bridge, status: 'unavailable', message: error instanceof Error ? error.message : 'The browser could not be read.' };
        }
      }
    }));
    // Stable order despite parallel completion, and a bounded model-facing result.
    const order = new Map(included.map((bridge, index) => [bridge.bridge_id, index]));
    tabs.sort((a, b) => (order.get(String(a.bridge_id)) ?? 0) - (order.get(String(b.bridge_id)) ?? 0));
    if (tabs.length > 200) truncated = true;
    const complete = !truncated && rows.every(row => row.status === 'ok');
    const result: BridgeResult = { command_id: 'browser-discovery', status: 'ok', duration_ms: 0,
      bridge_version: 'server', idempotency_key_seen: false,
      outputs: { tabs: tabs.slice(0, 200), bridges: rows, complete, truncated } };
    return { kind: 'completed', result, bridge_client_token_id: 'browser-discovery', attempts: 0 };
  };
  return { ...base, listBrowserBridges: bridges,
    browserName: (browser_id) => formerName?.(browser_id),
    listBrowsers: () => {
      const live = new Set(registry.list().map(row => row.client_token_id));
      return (paired?.() ?? []).map(row => ({ bridge_id: row.bridge_id, browser_id: row.browser_id ?? row.bridge_id,
        name: row.bridge_label, online: live.has(row.bridge_id) }));
    },
    // D-402 slice H3 (§4.2 item 3) — by the rule a dispatch applies: the browser a step names is the one
    // it reaches (its lasting id routes to its current token), never another; a site no origin it was
    // granted reaches is refused, as listing its tabs says `permission_missing`.
    checkBrowsers(needs) {
      const roster = paired?.() ?? [];
      const problems: BrowserStepProblem[] = [];
      for (const need of needs) {
        const token = current(need.browser_id) ?? need.browser_id;
        const row = registry.get(token);
        if (!row) {
          const listed = roster.find(one => one.bridge_id === token);
          if (paired !== undefined && listed === undefined) {
            const name = formerName?.(need.browser_id);
            problems.push({ ...need, problem: 'not_paired', ...(name !== undefined ? { name } : {}) });
          } else problems.push({ ...need, problem: 'offline', name: listed?.bridge_label ?? need.browser_id });
          continue;
        }
        const target = need.target;
        const origins = row.capabilities.granted_origins;
        if (target !== undefined && !isPatternWithinGrantedOrigins(target, origins)
          && !origins.some(origin => isPatternWithinGrantedOrigins(origin, [target]))) {
          problems.push({ ...need, problem: 'site', name: labelOf(row), site: browserSiteOf(target) });
          continue;
        }
        // Slice H3b — by the rule each dispatch applies to its command (`bridgeRunsCommand`).
        if (need.commands?.some(one => !bridgeRunsCommand(row.capabilities, one.action, one.args)) === true) {
          const version = row.capabilities.software_version;
          problems.push({ ...need, problem: 'update', name: labelOf(row), ...(typeof version === 'string' && version !== '' ? { version } : {}) });
        }
      }
      return problems;
    },
    // Slice H3b — slice G's check at a batch's start, for a step that names its browser by its lasting id:
    // the base dispatcher knows only tokens, so it found no Bridge there and never refused.
    runs(request) {
      const id = current(browserBridgeId(request.bridge_id));
      return base.runs?.({ ...request, ...(id !== undefined ? { bridge_id: id } : {}) });
    },
    describeDocument(request) {
      if (!request.browser_routing && !browserPageOwner(request.args.page)) return base.describeDocument?.(request) ?? null;
      try { return base.describeDocument?.(select(request).request) ?? null; } catch { return null; }
    },
    async dispatch(request, reviewed) {
      if (!request.browser_routing && !browserPageOwner(request.args.page)) return base.dispatch(request, reviewed);
      if (reviewed && request.browser_all_bridges)
        throw new IngredientError('ROLE_RESTRICTION', 'Reviewed commands cannot discover multiple browsers.', { executed: false });
      if (request.action === 'list_tabs' && request.browser_all_bridges) return listTabs(request);
      const chosen = select(request);
      if (reviewed && reviewed.binding.client_token_id !== chosen.bridge.bridge_id)
        throw new IngredientError('ROLE_RESTRICTION', 'The reviewed browser differs from this page. Review it again.', { executed: false });
      return bind(await base.dispatch(chosen.request, reviewed), chosen.bridge);
    },
  };
};
