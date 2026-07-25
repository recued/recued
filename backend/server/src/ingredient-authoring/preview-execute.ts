/** D-170 N.4 / N.15 — preview READ-execution seam over the real connection
 *  adapter.
 *
 *  `ingredient.preview` runs a read "through the real gateway connection
 *  adapter" (N.15). This builds that seam: a dedicated `connection` adapter
 *  instance over the SAME store + api-handler deps the live executor wires
 *  (`createConnectionApiHandler` — auth injection, OAuth2 refresh, cross-origin
 *  guard, timeout), so a previewed read is byte-for-byte the call the installed
 *  catalog would make — but with NO audit emitter: a preview is a pre-install
 *  test, never a recipe run, so it writes no activity row (N.4 / R14 "samples
 *  not persisted").
 *
 *  A separate adapter instance (separate OAuth single-flight map) is correct —
 *  the same posture as the server vs extension runtimes each holding their own
 *  (`connection-api.ts` factory note); a preview-driven refresh persists the
 *  rotated token through the shared `persistAuth` exactly as a live read does.
 *
 *  Only ever dispatched for `connection_kind: 'api'` + `risk_tier: 'read'` (the
 *  preview's risk gate is upstream — `preview.ts`). */

import {
  createConnectionAdapter,
  createConnectionApiHandler,
  type Adapter,
  type ConnectionAdapterStore,
  type ConnectionApiHandlerDeps,
  type ResolvedCall,
} from '@recued/ingredients';

export interface PreviewConnectionExecuteDeps {
  /** Live connection store (`.get(kind, name)`) — the same handle the executor
   *  passes to its connection adapter. */
  store: ConnectionAdapterStore;
  /** The api-handler deps (`decodeAuth` / `persistAuth` / fetch) the boot site
   *  built for the live `connection.api` handler. */
  connectionApi: ConnectionApiHandlerDeps;
}

export const createPreviewConnectionExecute = (
  deps: PreviewConnectionExecuteDeps,
): ((call: ResolvedCall) => Promise<unknown>) => {
  const adapter: Adapter = createConnectionAdapter({
    store: deps.store,
    handlers: { api: createConnectionApiHandler(deps.connectionApi) },
    // No `emitAudit` — a preview is non-persisting (N.4 / R14).
  });
  return (call) => adapter(call);
};
