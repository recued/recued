/** D-182 §7.2 — contracts surface for the owner-only `cli.reachability.*` rpc.
 *
 *  Asserts the contracts-side deliverables of the reachability grid rpc:
 *    1. the wire-shape types are reachable through the barrel (`index.ts`) —
 *       the backend handler imports them as `@recued/contracts`.
 *    2. the two `cli.reachability.*` methods are in SERVER_RPC_METHOD_SET, with
 *       their RpcMethodSpec request/response shapes pinned (compile-time).
 *    3. `cli.reachability.` is reserved local-UI-only in
 *       MCP_RESERVED_RPC_PREFIXES, so no MCP-channel agent can grant itself
 *       reachability to a local binary, revoke a cell, nor enumerate the grid. */

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  MCP_RESERVED_RPC_PREFIXES,
  SERVER_RPC_METHOD_SET,
  isReservedLocalRpc,
} from '../index.js';
import type {
  CliReachabilityListResponse,
  CliReachabilitySetRequest,
  CliReachabilitySetResponse,
  CliReachabilityUniverseResponse,
} from '../index.js';
import type { RpcRequest, RpcResponse } from '../rpc/types.js';
import type { ServerRpcRegistry } from '../rpc/server-registry.js';

describe('D-182 §7.2 — cli.reachability rpc registry', () => {
  it('SERVER_RPC_METHOD_SET includes all three cli.reachability methods', () => {
    expect(SERVER_RPC_METHOD_SET.has('cli.reachability.list')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('cli.reachability.universe')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('cli.reachability.set')).toBe(true);
  });

  it('the deleted cli.capability.* family is gone from the registry', () => {
    expect(SERVER_RPC_METHOD_SET.has('cli.capability.enable' as never)).toBe(false);
    expect(SERVER_RPC_METHOD_SET.has('cli.capability.list' as never)).toBe(false);
  });

  it('pins the request/response payload shapes (compile-time ratchet)', () => {
    expectTypeOf<
      RpcRequest<ServerRpcRegistry, 'cli.reachability.set'>
    >().toEqualTypeOf<CliReachabilitySetRequest>();
    expectTypeOf<
      RpcResponse<ServerRpcRegistry, 'cli.reachability.set'>
    >().toEqualTypeOf<CliReachabilitySetResponse>();
    expectTypeOf<
      RpcResponse<ServerRpcRegistry, 'cli.reachability.list'>
    >().toEqualTypeOf<CliReachabilityListResponse>();
    expectTypeOf<
      RpcResponse<ServerRpcRegistry, 'cli.reachability.universe'>
    >().toEqualTypeOf<CliReachabilityUniverseResponse>();
  });
});

describe('D-182 §7.2 — MCP channel isolation', () => {
  it('reserves the whole `cli.reachability.` namespace for local-UI only', () => {
    expect((MCP_RESERVED_RPC_PREFIXES as readonly string[])).toContain('cli.reachability.');
  });

  it('isReservedLocalRpc flags every cli.reachability method', () => {
    expect(isReservedLocalRpc('cli.reachability.list')).toBe(true);
    expect(isReservedLocalRpc('cli.reachability.universe')).toBe(true);
    expect(isReservedLocalRpc('cli.reachability.set')).toBe(true);
  });
});
