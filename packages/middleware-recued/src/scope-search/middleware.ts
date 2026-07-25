/** D-160 P2 — the `scope-search` stream-middleware adapter (§ P2).
 *
 *  Registers the D-137 P2 § A.4 server-side read consolidation fan-out
 *  as a D-160 stream middleware. Lifecycle footprint: `prompt`
 *  (`before-turn`) — scope search pre-fetches the read context a turn
 *  reasons over, so it runs pre-AI-call. The adapter runs
 *  `runScopeSearchFanout` over the registered sources and writes the
 *  candidate envelope back to `ctx.state`.
 *
 *  Scaffold scope (D-160 P2): the fan-out input — the per-tool args plus
 *  the `ScopeSearchSource[]` list — rides `ctx.state`
 *  (`SCOPE_SEARCH_INPUT_STATE_KEY`). A future producer / the deferred
 *  D-137-chat refactor (D-160 O-5) threads the live sources (local
 *  warehouse + HubSpot + Salesforce) in; absent them the hook is a
 *  faithful no-op (the sources are per-pair connection state).
 *
 *  Spec: docs/d-160-spec.md § P2.
 */

import type { Middleware, TurnContext } from '@recued/middleware';

import { runScopeSearchFanout, type ScopeSearchSource } from './index.js';

/** `ctx.state` key — the fan-out input (`{ args, sources }`). */
export const SCOPE_SEARCH_INPUT_STATE_KEY = 'scope-search:input';
/** `ctx.state` key — where the adapter writes the `ScopeSearchResult`. */
export const SCOPE_SEARCH_RESULT_STATE_KEY = 'scope-search:result';

/** The `ctx.state` snapshot the adapter consumes. */
interface ScopeSearchSnapshot {
  readonly args: unknown;
  readonly sources: readonly ScopeSearchSource<unknown, unknown>[];
}

/** Read the fan-out input off `ctx.state`. Requires a `sources` array;
 *  anything else (or an absent key) yields `undefined` and the hook
 *  no-ops. */
const readSnapshot = (
  state: TurnContext['state'],
): ScopeSearchSnapshot | undefined => {
  const raw = state.get(SCOPE_SEARCH_INPUT_STATE_KEY);
  if (raw === null || typeof raw !== 'object') return undefined;
  const snapshot = raw as { sources?: unknown };
  if (!Array.isArray(snapshot.sources)) return undefined;
  return raw as ScopeSearchSnapshot;
};

/** The `scope-search` middleware — registers enabled (D-160 P2). */
export const scopeSearchMiddleware: Middleware = {
  id: 'scope-search',
  async prompt(ctx: TurnContext): Promise<void> {
    const snapshot = readSnapshot(ctx.state);
    if (snapshot === undefined) return; // faithful no-op — no sources
    const result = await runScopeSearchFanout(snapshot.args, snapshot.sources);
    ctx.state.set(SCOPE_SEARCH_RESULT_STATE_KEY, result);
    // A `prompt` (before-turn) hook surfaces its work to the turn via
    // the prompt draft — the fan-out result is the read context the
    // turn reasons over.
    const failures = result.partial_failures?.length ?? 0;
    ctx.prompt.contribute({
      role: 'context',
      text: `scope search — ${result.candidates.length} candidate(s)${
        failures > 0 ? ` (${failures} source failure(s))` : ''
      }`,
    });
  },
};
