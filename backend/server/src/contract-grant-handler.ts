/** Grant-foundation slice 3 (D-187 AMENDMENT `693b7d03`) —
 *  `contract.grant.{read,read_by_entry,write}` rpc handlers (the unified
 *  `(contract × grant)` matrix surface).
 *
 *  Read/write a contract's grant ENTRIES — `<operation_id>` (op admission) |
 *  `data.<collection>` (collection read) | `enrichment.<topic>` (topic read), one
 *  consolidated namespace (the `grant-entry.ts` taxonomy). The two D-174 R22 transpose
 *  UIs read this: `read` = a contract's row, `read_by_entry` = an entry's column. Unlike
 *  the owner-only `mcp.visibility.*` rpc, these key on an arbitrary `contract_id` (a
 *  door, an agent, or the owner contract) — the owner's paired client configures any
 *  contract's grants from Settings.
 *
 *  Channel isolation is the load-bearing invariant: `contract.grant.` is in
 *  `MCP_RESERVED_RPC_PREFIXES`, so a contracted MCP agent can NEVER reach `write` to
 *  widen its own grants (admission would become self-granting). `write` additionally
 *  requires a registered paired client (D-121) as defense in depth.
 *
 *  Reads return the EXPLICIT stored rows only — an entry with no row resolves to its
 *  author default at the gate (the grant resolver), so the UI joins this with the
 *  registry for the effective view (mirroring `mcp.visibility.read` +
 *  `housekeeping.registry.describe`).
 *
 *  Spec: D-187 AMENDMENT block; handover
 *  `handover_grant_foundation_slice3_amended.md`. */

import { RpcError } from '@recued/contracts';
import type { HandlerSlice, ServerRpcRegistry } from '@recued/contracts';

import type { ContractGrantEntryStore } from './storage/contract-grant-entry-store.js';
import type { WsClient } from './ws-server.js';

export interface ContractGrantRpcDeps {
  /** The unified `contract_grant`-backed grant store. */
  store: ContractGrantEntryStore;
  /** Optional clock injection. Tests pin the boundary; production falls back to
   *  `Date.now()`. */
  now?: () => number;
}

export const handleContractGrantRead = (
  deps: ContractGrantRpcDeps,
  args: { contract_id?: unknown },
): {
  grants: ReadonlyArray<{ entry_key: string; granted: boolean; set_at: number }>;
} => {
  if (typeof args.contract_id !== 'string' || args.contract_id.length === 0) {
    throw new RpcError('bad_request', 'contract.grant.read: contract_id is required');
  }
  // `set_at` is always written by `set`; the `?? 0` only guards a hand-seeded row.
  const grants = deps.store.listForContract(args.contract_id).map((row) => ({
    entry_key: row.entry_key,
    granted: row.granted,
    set_at: row.set_at ?? 0,
  }));
  return { grants };
};

export const handleContractGrantReadByEntry = (
  deps: ContractGrantRpcDeps,
  args: { entry_key?: unknown },
): {
  contracts: ReadonlyArray<{ contract_id: string; granted: boolean; set_at: number }>;
} => {
  if (typeof args.entry_key !== 'string' || args.entry_key.length === 0) {
    throw new RpcError('bad_request', 'contract.grant.read_by_entry: entry_key is required');
  }
  const contracts = deps.store.listForEntry(args.entry_key).map((row) => ({
    contract_id: row.contract_id,
    granted: row.granted,
    set_at: row.set_at ?? 0,
  }));
  return { contracts };
};

export const handleContractGrantWrite = (
  deps: ContractGrantRpcDeps,
  args: { contract_id?: unknown; entry_key?: unknown; granted?: unknown },
  caller: { instance_id: string | null } | undefined,
): { ok: true; granted: boolean | null } => {
  // Grant edits require a registered paired client (D-121); the channel-isolation
  // reservation already bars MCP agents, this bars unregistered connections too.
  if (!caller?.instance_id) {
    throw new RpcError(
      'permission_denied',
      'contract.grant.write: requires a paired client (D-121); rpc dispatched from an unregistered connection',
    );
  }
  if (typeof args.contract_id !== 'string' || args.contract_id.length === 0) {
    throw new RpcError('bad_request', 'contract.grant.write: contract_id is required');
  }
  if (typeof args.entry_key !== 'string' || args.entry_key.length === 0) {
    throw new RpcError('bad_request', 'contract.grant.write: entry_key is required');
  }
  // `boolean` (grant/revoke) | `null` (clear). The store is dumb about the taxonomy;
  // semantic validation (is this a LIVE op/collection/topic) is the install/seed path's
  // job — a stale entry_key simply never matches at the gate.
  if (args.granted !== null && typeof args.granted !== 'boolean') {
    throw new RpcError(
      'bad_request',
      `contract.grant.write: granted must be a boolean or null (clear); got ${JSON.stringify(args.granted)}`,
    );
  }

  const ts = deps.now?.() ?? Date.now();
  if (args.granted === null) {
    deps.store.clear(args.contract_id, args.entry_key);
    return { ok: true, granted: null };
  }
  deps.store.set(args.contract_id, args.entry_key, args.granted, ts);
  return { ok: true, granted: args.granted };
};

type ContractGrantMethods =
  | 'contract.grant.read'
  | 'contract.grant.read_by_entry'
  | 'contract.grant.write';

export const makeContractGrantHandlers = (
  deps: ContractGrantRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ContractGrantMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['contract.grant.read', 'contract.grant.read_by_entry', 'contract.grant.write'],
    handlers: {
      'contract.grant.read': async (args) =>
        handleContractGrantRead(deps, args as { contract_id?: unknown }),
      'contract.grant.read_by_entry': async (args) =>
        handleContractGrantReadByEntry(deps, args as { entry_key?: unknown }),
      'contract.grant.write': async (args, client) =>
        handleContractGrantWrite(
          deps,
          args as { contract_id?: unknown; entry_key?: unknown; granted?: unknown },
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
    },
  };
};
