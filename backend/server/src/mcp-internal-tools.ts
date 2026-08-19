/** D-137 P1.4 — InternalToolRegistry-backed MCP adapter (external-
 *  agent surface).
 *
 *  Per § A.1 (amended 2026-05-11): the MCP server is the canonical
 *  **external** AI agent surface (Claude Desktop / peer Recued / generic
 *  MCP clients). It wraps `InternalToolRegistry.dispatch` with the
 *  `channel: 'mcp_wire'` discriminator so per-token gating +
 *  per-pair rate limits + visibility filters fire only on this
 *  surface. The same underlying engine primitives
 *  serve both consumers; only the channel-isolation wrapping differs.
 *
 *  This module ships the adapter shape (`buildInternalToolMcpAdapter`)
 *  so the mcp-server.ts route handler can hand off
 *  `tools/list` + `tools/call` for InternalToolRegistry-managed tools
 *  to it. The legacy mcp-server.ts tools (`recued_listRecipes` etc.)
 *  continue to serve until the path-routing amendment's full
 *  consolidation lands; this substrate is additive, not replacing.
 *
 *  Channel-isolation invariants enforced here:
 *    - Every dispatch carries `channel: 'mcp_wire'` + the caller-
 *      supplied `mcp_token_id`. The registry's own gate rejects
 *      missing token_id with `channel_denied`.
 *    - The adapter NEVER injects `session_id` (that's the internal-
 *      channel slot; the registry rejects sets carrying both).
 *
 *  Spec: § A.1 + § A.1.1 + § A.2 + `project_mcp_channel_invariant.md`. */

import type {
  ChatDispatchResult,
  ContractSnapshot,
  ExecutionSource,
  InternalToolRegistry,
  ToolEntry,
} from '@recued/contracts';

/** MCP `tools/list` per-tool schema shape. Mirrors the existing
 *  mcp-server.ts TOOLS shape but typed against the
 *  InternalToolRegistry's `ToolEntry`. */
export interface McpInternalToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
  /** MCP `_meta` slot for non-standard annotations. We surface tier +
   *  classification + topic_tags so external agents can render badge
   *  hints (read-only, write, etc.) without re-classifying upstream. */
  _meta: {
    tier: ToolEntry['tier'];
    classification: ToolEntry['classification'];
    topic_tags: ReadonlyArray<string>;
    destructive_hint?: boolean;
    requires_kinds?: ReadonlyArray<string>;
  };
}

export interface McpInternalToolAdapter {
  /** Project the registry's `list()` to MCP `tools/list` entries. */
  listTools(): ReadonlyArray<McpInternalToolDescriptor>;
  /** Route an MCP `tools/call` through the registry with the
   *  mcp_wire channel discriminator + per-token gating. Returns the
   *  raw `ChatDispatchResult` so the caller can map to MCP success /
   *  error envelope shape. */
  callTool(name: string, args: unknown): Promise<ChatDispatchResult>;
  /** Returns true iff the registry knows the name (Tier 1 / 2 / 3).
   *  The mcp-server.ts catalog merge uses this to disambiguate legacy
   *  `recued_listRecipes` from the wrapped registry tools. */
  hasTool(name: string): boolean;
}

export interface BuildInternalToolMcpAdapterOptions {
  registry: InternalToolRegistry;
  /** Per-pair MCP bearer token id — caller derives from the
   *  Authorization header at the request boundary. Empty string is
   *  invalid (registry rejects with `channel_denied`); the caller is
   *  responsible for surfacing 401 before reaching this adapter. */
  mcp_token_id: string;
  /** D-153 P2.C — channel-shaped `ExecutionSource` resolved per-call
   *  at the mcp wire boundary. Threaded into the registry dispatch
   *  ctx so registry-routed Tier 1 `recipe.run` + Tier 2 dispatches
   *  reach the execute-handler's policy gate with the right
   *  `(channel × actor)` source. Pure pass-through here; the adapter
   *  never reads it. Absent on dispatches that don't need a gate
   *  (the legacy `recued_*` paths build their own at the call site;
   *  tests that exercise only catalog enumeration leave it
   *  undefined). */
  execution_source?: ExecutionSource;
  /** D-153 P2.C — per-token `ContractSnapshot` paired with
   *  `execution_source` for contract-scoped actors. Required at the
   *  execute-handler when `execution_source.actor` is contract-scoped
   *  (`'mcp'` always is); the adapter still treats this as
   *  pass-through. Producer-side resolution lives in mcp-server.ts. */
  contract_snapshot?: ContractSnapshot;
}

/** § A.1 — build the MCP-wire-channel adapter over the registry.
 *  Pure factory; no I/O. */
export const buildInternalToolMcpAdapter = (
  options: BuildInternalToolMcpAdapterOptions,
): McpInternalToolAdapter => {
  const { registry, mcp_token_id, execution_source, contract_snapshot } = options;

  const listTools = (): ReadonlyArray<McpInternalToolDescriptor> => {
    // ⛔⛔ D-247 D9 — DELIBERATELY NOT FILTERED BY THE OWNER'S `recipe.*` GRANT,
    // and the draft that said this was "the third exposure surface" was wrong.
    // This adapter serves a DOOR, whose Tier-2 authority is its INBOUND TOKEN
    // (`buildMcpContractSnapshot` folds granted recipe wire names into
    // `allowed_tools` under `inboundTokenAuthorize`, D-232 § 20.19) — already
    // enforced on that path. The `recipe.*` axis is OWNER-scoped (D7), so
    // `isOwnerRecipeGranted` answers `false` for every door STRUCTURALLY; wiring
    // it here would hide every Tier-2 recipe from every door and look like a
    // working gate while doing it. The owner-governed surfaces (the chat catalog
    // and `tools.search`) are where that filter belongs.
    const entries = registry.list();
    const out: McpInternalToolDescriptor[] = [];
    for (const e of entries) {
      const meta: McpInternalToolDescriptor['_meta'] = {
        tier: e.tier,
        classification: e.classification,
        topic_tags: e.topic_tags,
      };
      if (e.destructive_hint !== undefined) {
        meta.destructive_hint = e.destructive_hint;
      }
      if (e.requires_kinds !== undefined) {
        meta.requires_kinds = e.requires_kinds;
      }
      out.push({
        name: e.name,
        description: e.description,
        inputSchema: e.arg_schema,
        _meta: meta,
      });
    }
    return out;
  };

  const callTool = async (name: string, args: unknown): Promise<ChatDispatchResult> => {
    // Channel-isolation invariant: every dispatch from this adapter
    // carries the `mcp_wire` channel + the caller-supplied token id.
    // Never inject session_id (that's reserved for the internal channel
    // and the registry asserts the discriminator-shape invariant
    // accordingly).
    //
    // D-153 P2.C — when the caller resolved an `execution_source` +
    // `contract_snapshot` at the wire boundary, thread them onto the
    // dispatch ctx. The registry doesn't read them (pure pass-through);
    // chat-tool-handlers' `buildExecuteRequest` reads them out for
    // recipe.run + Tier 2 dispatches so the execute-handler's policy
    // gate evaluates the recipe under the right `(channel × actor)`
    // cell. Catalog-enumeration tests + read-only Tier 1 callers leave
    // both undefined; the registry passes them through unchanged.
    return registry.dispatch(name, args, {
      channel: 'mcp_wire',
      mcp_token_id,
      ...(execution_source ? { execution_source } : {}),
      ...(contract_snapshot ? { contract_snapshot } : {}),
    });
  };

  const hasTool = (name: string): boolean => registry.getByName(name) !== null;

  return { listTools, callTool, hasTool };
};

/** Closed-list of MCP error-envelope mappings for `ChatDispatchResult`
 *  failure paths. Mirrors mcp-server.ts's `err()` helper but typed
 *  against the chat-dispatch reason codes so the mapping is
 *  exhaustive. The caller surfaces a single MCP error response per
 *  failed dispatch. */
export const MCP_DISPATCH_ERROR_MESSAGES: Readonly<Record<
  ChatDispatchResult extends infer R
    ? R extends { ok: false; reason: infer Reason }
      ? Reason extends string ? Reason : never
      : never
    : never,
  string
>> = {
  not_implemented: 'Tool not implemented yet on this server.',
  unknown_tool: 'Tool not found in the registry.',
  invalid_args: 'Tool args failed validation.',
  channel_denied: 'Dispatch channel rejected the request.',
  kind_gated: 'Tool gated by the server-side per-kind catalog scope.',
  classification_blocked: 'Tool classification gate blocked the call.',
  connection_unavailable: 'Upstream connection unavailable.',
  capacity_gap: 'Required capacity slot missing.',
  execution_error: 'Tool dispatch raised at runtime.',
  // D-137 P3 § A.11 — plan-approval gate dispatch reasons. External
  // MCP agents that hit a write-classified tool see the same gate as
  // Mary's internal chat agent; the copy here is what surfaces in
  // the JSON-RPC error envelope the agent reads.
  awaiting_approval: 'Write paused — Mary must approve the plan via chat.plan.approve before this tool fires.',
  plan_cancelled: 'Write blocked — Mary cancelled the proposed plan via chat.plan.cancel.',
  // D-181 § 9 — the owner killed / cancelled-in-queue the dispatched run.
  // The appended `detail` carries the do-not-retry / resolve-with-user copy.
  run_cancelled: 'Run cancelled by the user.',
} as const;

/** Map a failed `ChatDispatchResult` to the MCP error message shape.
 *  Returns the diagnostic string the caller surfaces in the MCP
 *  response envelope. */
export const formatMcpDispatchError = (
  result: Extract<ChatDispatchResult, { ok: false }>,
): string => {
  const base = MCP_DISPATCH_ERROR_MESSAGES[result.reason];
  return result.detail ? `${base} (${result.detail})` : base;
};
