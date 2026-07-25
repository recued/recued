/** D-122 Phase 2 — `timeline-read` recipe-channel kernel handler.
 *
 *  Recipe-side mirror of the MCP `data.timeline()` primitive. The two
 *  channels stay isolated per the channel invariant: same SELECT, same
 *  storage, separate dispatcher. MCP traffic flows through
 *  `mcp/timeline.ts` + `mcp-server.ts`; recipe-execution traffic flows
 *  through this handler + the kernel adapter. They share only the
 *  underlying `handleTimelineRequest` query function — no rpc envelope,
 *  no auth surface, no audit hook collision.
 *
 *  The recipe-channel handler doesn't emit MCP-channel audit;
 *  recipe-channel reads are accounted on the engine's normal audit
 *  row through `runtime.runIngredient` like every other kernel
 *  ingredient. */

import {
  RpcError,
  type TimelineEntry,
  type TimelineRequest,
} from '@recued/contracts';
import {
  handleTimelineRequest,
  type TimelineDeps,
} from './mcp/timeline.js';

export interface TimelineRecipeHandlerDeps {
  timelineDeps: TimelineDeps;
}

export const handleTimelineReadFromRecipe = async (
  deps: TimelineRecipeHandlerDeps,
  args: {
    entity?: unknown;
    axis?: unknown;
    since?: unknown;
    until?: unknown;
    limit?: unknown;
    cursor?: unknown;
    /** D-136 P7.G — set when the enclosing recipe was MCP-triggered
     *  (`'mcp'`). The handler flips `gateMcpPrivate` so the timeline
     *  filter applies the user's per-pair MCP visibility override
     *  (override > registry default). Paired-client triggers
     *  (`'manual'` / `'auto_run'` / `'reactive'` / `'cron'`) leave the
     *  filter off so paired clients see private rows by construction.
     *  Mirrors the `enrichment-list` recipe-channel `mcp_exposed` gate
     *  per P7.E. */
    trigger_source?: unknown;
  },
): Promise<{ entries: TimelineEntry[]; next_cursor?: string }> => {
  if (typeof args.entity !== 'string' || args.entity.length === 0) {
    throw new RpcError(
      'bad_request',
      'timeline.read: entity is required (format <collection>:<id>)',
      400,
    );
  }
  // Validation of the colon-shape happens inside handleTimelineRequest
  // — it returns a typed RpcError(bad_request) for unparseable refs,
  // which our kernel adapter translates back to a recipe-side error.
  const request: TimelineRequest = {
    entity_id: args.entity,
  };
  if (args.axis === 'event' || args.axis === 'ingestion') {
    request.axis = args.axis;
  }
  if (typeof args.since === 'number') request.since = args.since;
  if (typeof args.until === 'number') request.until = args.until;
  if (typeof args.limit === 'number') request.limit = args.limit;
  if (typeof args.cursor === 'string') request.cursor = args.cursor;

  // P7.G — fold `gateMcpPrivate` per-call so paired-client recipes
  // bypass the filter and MCP-triggered recipes apply it. The store
  // itself is wired into `deps.timelineDeps` once at boot; this only
  // controls whether the filter consults it.
  //
  // D-177 read-gate — this recipe-channel path is scope-fenced UPSTREAM at the
  // ingredient gate: `deriveDispatchScope('timeline-read', input)` derives the
  // scope from the ENTITY's collection (`data.<entity_collection>`, not the
  // generic `data.timeline`), so the call is admitted only if the door's
  // `scope_restrictions` admits that collection — the SAME `scope_restrictions`
  // axis + matcher the MCP meta-tool's `readableCollections` fence uses. So the
  // two channels can't diverge: reading X's timeline requires X's collection
  // scope on either path. The meta-tool FILTERS (empty feed) where the coarse
  // gate DENIES (policy error) — same security outcome, channel-appropriate
  // response. Hence no per-collection enum is threaded here; the upstream gate
  // already fenced the dispatch. (LIVE since 2026-06-12 — the `#contracts`
  // fence UI authors `scope_restrictions` and the D-171 transport binds
  // door bearers to their contract.)
  const timelineDeps = args.trigger_source === 'mcp'
    ? { ...deps.timelineDeps, gateMcpPrivate: true }
    : deps.timelineDeps;

  const response = await handleTimelineRequest(timelineDeps, request);
  // Re-shape only if next_cursor is set; preserves the kernel's
  // declared output (`entries` + optional `next_cursor`) without an
  // explicit `undefined` slot in the JSON.
  return response.next_cursor !== undefined
    ? { entries: response.entries, next_cursor: response.next_cursor }
    : { entries: response.entries };
};
