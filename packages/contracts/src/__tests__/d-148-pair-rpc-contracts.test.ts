/** D-148 § A.2.1 / D-156 P10 — pair.* rpc contracts ratchet.
 *
 *  Asserts the channel-isolation invariant for the remaining `pair.*`
 *  surface (D-156 P9 / P10 retired `pair.mint` + `pair.consume` along
 *  with the rest of the D-148 § A.2.1 pair-blob substrate; pairing is
 *  now CLI-only via `POST /auth/pair`).
 *
 *    - `MCP_RESERVED_RPC_PREFIXES` carries `'pair.'` so the entire
 *      family stays off-MCP (the catalog has never published any
 *      `pair.*` method; this ratchet pins that structurally).
 *    - Every surviving `pair.*` rpc method on the server registry is
 *      matched by the prefix — covers `pair.list` / `pair.revoke` /
 *      `pair.registerRecoveryKey`.
 *    - `SERVER_RPC_METHODS` enumerates the three `pair.*` rpcs so the
 *      cross-test sentinels stay accurate.
 *
 *  All three remaining methods are operator-driven from Settings →
 *  Devices on an already-authenticated client. An external AI agent
 *  that has reached the MCP surface has, by definition, an MCP token
 *  bound to an existing pair — it must never be able to enumerate /
 *  destroy paired devices or rebind the realm's recovery key through
 *  that surface. */

import { describe, it, expect } from 'vitest';
import {
  SERVER_RPC_METHODS,
  MCP_RESERVED_RPC_PREFIXES,
  isReservedLocalRpc,
} from '../index.js';

const PAIR_METHODS = [
  'pair.list',
  'pair.revoke',
  'pair.registerRecoveryKey',
] as const;

describe('D-148 pair.* rpc contracts', () => {
  it("MCP_RESERVED_RPC_PREFIXES carries 'pair.'", () => {
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('pair.');
  });

  it('every pair.* rpc method is excluded from the MCP surface', () => {
    for (const method of PAIR_METHODS) {
      expect(isReservedLocalRpc(method)).toBe(true);
    }
  });

  it('SERVER_RPC_METHODS enumerates the three surviving pair.* rpcs', () => {
    for (const method of PAIR_METHODS) {
      expect(SERVER_RPC_METHODS).toContain(method);
    }
  });

  it('D-156 P10 retired pair.mint + pair.consume from SERVER_RPC_METHODS', () => {
    // The substrate is gone. If something tries to re-introduce these
    // rpc methods without first restoring the pair-blob substrate,
    // this assertion catches the leak.
    const methods = SERVER_RPC_METHODS as readonly string[];
    expect(methods).not.toContain('pair.mint');
    expect(methods).not.toContain('pair.consume');
  });
});
