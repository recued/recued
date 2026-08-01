/** D-174 #22 — `data.timeline` pair-RPC handler.
 *
 *  The webclient Data route's read-only drill-down feed (D-174 D11 —
 *  "mirror it" kinds surface as an entity's `data.timeline()`
 *  provenance feed, never a browse-everything client). This is the
 *  THIRD isolated channel for the `data.timeline()` primitive, alongside
 *  the MCP tool (`recued_dataTimeline`, `mcp-server.ts`) + the recipe
 *  kernel (`timeline-read`, `timeline-recipe-handler.ts`): same SELECT,
 *  same storage, separate dispatcher — no shared rpc envelope, no audit-
 *  hook collision (the channel-isolation invariant the recipe handler's
 *  header describes). Read-only; wraps the EXISTING
 *  `handleTimelineRequest` query function verbatim.
 *
 *  Privacy: the paired-client channel leaves `gateMcpPrivate` OFF — a
 *  local-UI caller sees private rows by construction (mirrors the
 *  recipe-channel paired-client path; the boot wiring constructs
 *  `timelineDeps` WITHOUT the gate). The MCP channel keeps its own gated
 *  handler, so adding this surface does NOT double-expose the MCP tool
 *  nor weaken its `mcp_exposed: 'private'` gate.
 *
 *  Spec: D-174 D11 + D-120 (`data.timeline()`). */

import {
  RpcError,
  type HandlerSlice,
  type ServerRpcRegistry,
  type TimelineRequest,
  type TimelineResponse,
} from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import { handleTimelineRequest, type TimelineDeps } from './mcp/timeline.js';

export interface TimelineRpcDeps {
  /** Shared timeline query deps (db / auditLog / annotationStore /
   *  enrichmentStore). Constructed at boot WITHOUT `gateMcpPrivate` so
   *  the paired-client read sees private rows. */
  timelineDeps: TimelineDeps;
}

/** Require a registered paired client. The paired read intentionally
 *  runs WITHOUT the MCP privacy gate (private rows visible), so that
 *  visibility decision MUST be enforced by an actual registered-local-UI
 *  boundary — not left as an assumption. An unregistered / pre-register
 *  (or legacy raw-bearer) WS caller is rejected before the query runs,
 *  so it can never read rows the MCP path would filter with
 *  `gateMcpPrivate: true`. Mirrors `account-binding-handler.ts`. */
const requireRegisteredClient = (client: WsClient): void => {
  if (!client.instance_id) {
    throw new RpcError(
      'unauthorized',
      'data.timeline requires a registered paired client',
      401,
    );
  }
};

export const handleDataTimeline = async (
  deps: TimelineRpcDeps,
  args: TimelineRequest,
): Promise<TimelineResponse> => {
  if (typeof args.entity_id !== 'string' || args.entity_id.length === 0) {
    throw new RpcError(
      'bad_request',
      'data.timeline: entity_id is required (format <collection>:<id>)',
    );
  }
  // Project only the recognized request fields; the colon-shape +
  // origin-actor sanitization happen inside `handleTimelineRequest`.
  const request: TimelineRequest = { entity_id: args.entity_id };
  if (args.axis === 'event' || args.axis === 'ingestion') request.axis = args.axis;
  if (typeof args.since === 'number') request.since = args.since;
  if (typeof args.until === 'number') request.until = args.until;
  if (typeof args.limit === 'number') request.limit = args.limit;
  if (typeof args.cursor === 'string') request.cursor = args.cursor;
  if (Array.isArray(args.origin_actors)) request.origin_actors = args.origin_actors;

  const response = await handleTimelineRequest(deps.timelineDeps, request);
  // Preserve the declared output (drop an explicit `undefined`
  // next_cursor slot from the wire frame).
  // ⚠ ENUMERATING PROJECTION — a field not named here never reaches the wire.
  // D-226's `rollups` was invisible on this path until it was added; anything
  // new on `TimelineResponse` has to be listed in the same commit.
  const base = response.next_cursor !== undefined
    ? { entries: response.entries, next_cursor: response.next_cursor }
    : { entries: response.entries };
  return response.rollups === undefined ? base : { ...base, rollups: response.rollups };
};

type TimelineRpcMethods = 'data.timeline';

export const makeTimelineRpcHandlers = (
  deps: TimelineRpcDeps | undefined,
):
  | HandlerSlice<ServerRpcRegistry, TimelineRpcMethods, WsClient>
  | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['data.timeline'],
    handlers: {
      // Registered-client gate at the slice arrow (enforces the
      // private-row-visibility boundary the no-gate read relies on).
      'data.timeline': async (args, client) => {
        requireRegisteredClient(client);
        return handleDataTimeline(deps, args as TimelineRequest);
      },
    },
  };
};
