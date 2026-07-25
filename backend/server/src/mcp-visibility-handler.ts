/** D-187 AMENDMENT — `mcp.visibility.{read,write}` rpc handlers (owner read-scope).
 *
 *  Backs the Settings → MCP per-topic "mark private" toggle. This is the OWNER's
 *  warehouse read-grant default: reads/writes land on the owner contract's per-topic
 *  `enrichment.<topic>` GRANT rows in the unified grant store
 *  (`contract.contract_grant.<OWNER_CONTRACT_ID>.enrichment.<topic>`) — the visibility
 *  toggle folded into the one `(contract × grant)` matrix. The wire shape keeps the
 *  `'public' | 'private'` policy (so the existing webclient panel is unchanged); a
 *  `'public'` policy maps to a `granted: true` row, `'private'` to a `granted: false`
 *  revoke row, `null` clears the row (revert to the registry author default). Reads
 *  return the owner's explicit grant rows; absent topics fall back to the author default
 *  at resolve time. (Slice 3c's topic-detail transpose view may subsume this rpc.)
 *
 *  The MCP-channel read gates (`registry.describe` filter, `enrichment.read` reject,
 *  `vector.similarity_search` reject, `timeline` filter, `enrichment.list` MCP-trigger
 *  reject) resolve the same `enrichment.<topic>` grant per (bound contract, topic), so a
 *  write here takes effect on the next read without restart.
 *
 *  Spec: D-187 AMENDMENT block §6. */

import {
  ALL_MCP_EXPOSURE_POLICIES,
  OWNER_CONTRACT_ID,
  RpcError,
  classifyGrantEntry,
  isEnrichmentTopic,
  parseGrantEntry,
  resolveGrantEntry,
  resolveMCPExposure,
  topicGrantEntry,
  type EnrichmentTopic,
  type MCPExposurePolicy,
} from '@recued/contracts';
import type {
  HandlerSlice,
  ServerRpcRegistry,
} from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import type { ContractGrantEntryStore } from './storage/contract-grant-entry-store.js';

/** Map a stored grant boolean to the wire visibility policy: a grant ⇒ `'public'`, an
 *  explicit revoke ⇒ `'private'`. */
const policyFromGranted = (granted: boolean): MCPExposurePolicy =>
  granted ? 'public' : 'private';

export interface MCPVisibilityRpcDeps {
  /** The unified per-contract grant store. The rpc operates on the OWNER contract's
   *  `enrichment.<topic>` grant rows (`OWNER_CONTRACT_ID`) — the owner's own warehouse
   *  read-grant default. */
  store: ContractGrantEntryStore;
  /** Optional clock injection. Tests pin the boundary; production calls
   *  fall back to `Date.now()`. */
  now?: () => number;
}

export const handleMCPVisibilityRead = (
  deps: MCPVisibilityRpcDeps,
): {
  overrides: ReadonlyArray<{ topic: string; policy: MCPExposurePolicy; updated_at: number }>;
} => {
  // The wire shape keeps the D-136 field names (`policy` / `updated_at`); map the owner's
  // `enrichment.<topic>` grant rows (`granted` / `set_at`) onto them. Only topic-kind
  // entries surface here (the owner's op / collection grants are configured elsewhere).
  // `set_at` is always written by `set`, so the `?? 0` only guards a hand-seeded row.
  const overrides = deps.store
    .listForContract(OWNER_CONTRACT_ID)
    .filter((row) => classifyGrantEntry(row.entry_key) === 'topic')
    .map((row) => ({
      topic: parseGrantEntry(row.entry_key).value,
      policy: policyFromGranted(row.granted),
      updated_at: row.set_at ?? 0,
    }));
  return { overrides };
};

export const handleMCPVisibilityWrite = (
  deps: MCPVisibilityRpcDeps,
  args: { topic?: unknown; policy?: unknown },
  caller: { instance_id: string | null } | undefined,
): { ok: true; effective_policy: MCPExposurePolicy } => {
  // Settings → MCP toggles require a registered paired client (D-121).
  // Anonymous / pre-register connections are rejected outright.
  if (!caller?.instance_id) {
    throw new RpcError(
      'permission_denied',
      'mcp.visibility.write: requires a paired client (D-121); rpc dispatched from an unregistered connection',
    );
  }

  if (typeof args.topic !== 'string' || args.topic.length === 0) {
    throw new RpcError('bad_request', 'mcp.visibility.write: topic is required');
  }
  if (!isEnrichmentTopic(args.topic)) {
    throw new RpcError(
      'bad_request',
      `mcp.visibility.write: unknown topic '${args.topic}'`,
    );
  }
  const topic = args.topic as EnrichmentTopic;
  const entryKey = topicGrantEntry(topic);

  // Closed list: 'public' | 'private' | null (clear).
  if (
    args.policy !== null
    && (typeof args.policy !== 'string'
        || !ALL_MCP_EXPOSURE_POLICIES.includes(args.policy as MCPExposurePolicy))
  ) {
    throw new RpcError(
      'bad_request',
      `mcp.visibility.write: policy must be one of ${ALL_MCP_EXPOSURE_POLICIES.join(', ')} or null (clear); got ${JSON.stringify(args.policy)}`,
    );
  }

  const ts = deps.now?.() ?? Date.now();

  if (args.policy === null) {
    deps.store.clear(OWNER_CONTRACT_ID, entryKey);
  } else {
    // 'public' ⇒ a `granted: true` row; 'private' ⇒ a `granted: false` revoke row.
    deps.store.set(OWNER_CONTRACT_ID, entryKey, args.policy === 'public', ts);
  }

  // Echo the post-state effective policy so the UI doesn't have to re-fetch: the owner's
  // explicit grant if present (just written), else the registry author default (just
  // cleared). Same uniform `resolveGrantEntry` rule the read gates consult — the topic
  // author default is `mcp_exposed === 'public'`.
  const effective = resolveGrantEntry(
    deps.store.get(OWNER_CONTRACT_ID, entryKey),
    resolveMCPExposure(topic) === 'public',
  );
  return { ok: true, effective_policy: policyFromGranted(effective) };
};

type MCPVisibilityMethods = 'mcp.visibility.read' | 'mcp.visibility.write';

export const makeMCPVisibilityHandlers = (
  deps: MCPVisibilityRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, MCPVisibilityMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['mcp.visibility.read', 'mcp.visibility.write'],
    handlers: {
      'mcp.visibility.read': async () => handleMCPVisibilityRead(deps),
      'mcp.visibility.write': async (args, client) =>
        handleMCPVisibilityWrite(
          deps,
          args as { topic?: unknown; policy?: unknown },
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
    },
  };
};
