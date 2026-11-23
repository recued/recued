import type { ServerPendingApproval, ServerPendingAsk } from '@recued/contracts';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import type { PendingChatPlan } from './pending-chat-plans-store.js';
import { decisionSearchTerms, decisionTextMatches, type DecisionKind } from './decision-search.js';
import { createDecisionSearchRecords, type DecisionSearchMatch, type DecisionSearchNames } from './decision-search-record.js';

export interface PendingDecisionSearchCallers {
  gates: () => Promise<{ approvals: readonly ServerPendingApproval[] }>;
  asks: () => Promise<{ asks: readonly ServerPendingAsk[] }>;
  plans?: (refresh: boolean) => Promise<readonly PendingChatPlan[]>;
  names?: () => Promise<DecisionSearchNames>;
  observe?: (changed: (kind?: DecisionKind) => void) => () => void;
}
interface Source { loaded: boolean; loading: boolean; error?: string; unsupported?: boolean }
export interface PendingDecisionSearchState {
  query: string; rows: readonly DecisionSearchMatch[]; matches: readonly DecisionSearchMatch[];
  sources: Record<DecisionKind, Source>; loading: boolean; loaded: boolean; incomplete: boolean;
}
const empty = (): PendingDecisionSearchState => ({ query: '', rows: [], matches: [],
  sources: { gate: { loaded: false, loading: false }, ask: { loaded: false, loading: false }, plan: { loaded: false, loading: false } },
  loading: false, loaded: false, incomplete: false });
const kinds = ['gate', 'ask', 'plan'] as const;
export const createPendingDecisionSearch = (deps: {
  document: Document; callers?: PendingDecisionSearchCallers;
  active: () => boolean; changed: () => void;
}) => {
  let state = empty(), epoch = 0, selectionEpoch = 0, disposed = false, planReads = 0, started = false;
  let pending = Promise.resolve();
  const records = createDecisionSearchRecords(deps.document);
  const publish = () => {
    const terms = decisionSearchTerms(state.query);
    const rows = [...state.rows].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
    state = { ...state, rows, matches: rows.filter(row => decisionTextMatches(row.text, terms)),
      loading: kinds.some(kind => state.sources[kind].loading),
      loaded: kinds.every(kind => state.sources[kind].loaded),
      incomplete: kinds.some(kind => !!state.sources[kind].error || !!state.sources[kind].unsupported) };
    deps.changed();
  };
  const read = async (refresh: boolean): Promise<void> => {
    const callers = deps.callers; if (!callers) return;
    const mine = ++epoch; selectionEpoch++; started = true;
    state = { ...state, sources: { gate: { ...state.sources.gate, loading: true, error: undefined, unsupported: false },
      ask: { ...state.sources.ask, loading: true, error: undefined, unsupported: false },
      plan: { ...state.sources.plan, loading: true, error: undefined, unsupported: false } } }; publish();
    const readKind = async (kind: DecisionKind, fetch: () => Promise<readonly DecisionSearchMatch[]>) => {
      try {
        const rows = await fetch();
        if (disposed || mine !== epoch) return;
        if (new Set(rows.map(row => row.key)).size !== rows.length) throw Error('The pending decision list could not be confirmed.');
        state = { ...state, rows: [...state.rows.filter(row => row.kind !== kind), ...rows],
          sources: { ...state.sources, [kind]: { loaded: true, loading: false } } };
      } catch (failure) {
        if (disposed || mine !== epoch) return;
        const code = classifyRpcError(failure).code;
        state = { ...state, sources: { ...state.sources, [kind]: { ...state.sources[kind], loading: false,
          error: humanizeRpcError(failure), unsupported: code === 'unknown_method' || code === 'not_configured' } } };
      }
      if (!disposed && mine === epoch) publish();
    };
    await Promise.all([
      readKind('gate', async () => {
        const [out, names] = await Promise.all([callers.gates(), callers.names?.().catch(() => ({})) ?? Promise.resolve({})]);
        if (!Array.isArray(out?.approvals)) throw Error('The pending approval list could not be confirmed.');
        return out.approvals.map(row => records.gate(row, names));
      }),
      readKind('ask', async () => {
        const out = await callers.asks();
        if (!Array.isArray(out?.asks)) throw Error('The pending question list could not be confirmed.');
        return out.asks.map(records.ask);
      }),
      readKind('plan', async () => {
        if (!callers.plans) throw Error('Pending Chat plans are unavailable on this server.');
        planReads++;
        try { const rows = await callers.plans(refresh); if (!Array.isArray(rows)) throw Error('The pending plan list could not be confirmed.'); return rows.map(records.plan); }
        finally { planReads--; }
      }),
    ]);
  };
  const reset = () => { epoch++; selectionEpoch++; started = false; state = empty(); };
  const load = (query: string, refresh = false) => {
    if (disposed || !deps.callers) return Promise.resolve();
    selectionEpoch++; state = { ...state, query };
    if (refresh || !started) pending = read(refresh);
    else publish();
    return pending;
  };
  const unsubscribe = deps.callers?.observe?.(kind => {
    if (disposed || !started || kind === 'plan' && planReads > 0) return;
    epoch++; selectionEpoch++;
    if (deps.active()) void load(state.query, true);
    else reset();
  });
  return {
    state: () => state, load,
    async resolve(selected: DecisionSearchMatch): Promise<boolean> {
      const work = load(state.query, true), mine = selectionEpoch, generation = epoch;
      await work;
      if (disposed || !deps.active() || mine !== selectionEpoch || generation !== epoch) return false;
      const source = state.sources[selected.kind];
      if (source.loading || source.error || source.unsupported) throw Error('This decision could not be checked. Retry the pending decision search.');
      const current = state.rows.find(row => row.key === selected.key);
      if (!current) throw Error('This decision is no longer pending. The search results have been refreshed.');
      if (current.identity !== selected.identity || current.at !== selected.at) throw Error('This decision changed. Review its refreshed search result before opening it.');
      return true;
    },
    reset, whenLoaded: () => pending,
    snapshot: () => structuredClone({ ...state, loading: false, sources: {
      gate: { ...state.sources.gate, loading: false }, ask: { ...state.sources.ask, loading: false }, plan: { ...state.sources.plan, loading: false } } }),
    restore(value: PendingDecisionSearchState) { epoch++; selectionEpoch++; started = value.loaded || value.incomplete || kinds.some(kind => value.sources[kind].loaded); state = structuredClone(value); },
    dispose() { disposed = true; epoch++; selectionEpoch++; unsubscribe?.(); },
  };
};
