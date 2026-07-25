/** D-148 § A.5.3 / § A.6.5 — Pro auth contracts ratchet.
 *
 *  Asserts the contract invariants the server-side handler + bin.ts
 *  composition rely on:
 *    - `PRO_AUTH_RPC_ERROR_CODES` array is exhaustive over the
 *      `ProAuthRpcErrorCode` union (compile-time sentinel).
 *    - `MCP_RESERVED_RPC_PREFIXES` carries `'pro.'` — channel
 *      isolation invariant.
 *    - The three `pro.*` rpcs are members of the server registry's
 *      complete-method list. */

import { describe, it, expect } from 'vitest';
import {
  SERVER_RPC_METHODS,
  MCP_RESERVED_RPC_PREFIXES,
  PRO_AUTH_RPC_ERROR_CODES,
  PRO_AUTH_TOKEN_MAX_BYTES,
  PRO_AUTH_TOKEN_MIN_BYTES,
  isReservedLocalRpc,
  type ProAuthRpcErrorCode,
} from '../index.js';

describe('D-148 Pro auth contracts', () => {
  it("MCP_RESERVED_RPC_PREFIXES carries 'pro.'", () => {
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('pro.');
  });

  it("every pro.* rpc method is reserved", () => {
    for (const method of ['pro.authenticate', 'pro.signOut', 'pro.current']) {
      expect(isReservedLocalRpc(method)).toBe(true);
    }
  });

  it('SERVER_RPC_METHODS includes the three pro.* rpcs', () => {
    expect(SERVER_RPC_METHODS).toContain('pro.authenticate');
    expect(SERVER_RPC_METHODS).toContain('pro.signOut');
    expect(SERVER_RPC_METHODS).toContain('pro.current');
  });

  it('PRO_AUTH_RPC_ERROR_CODES is exhaustive over the union', () => {
    const sentinel: Record<ProAuthRpcErrorCode, true> = {
      pro_auth_token_invalid: true,
      pro_auth_not_authenticated: true,
    };
    for (const code of PRO_AUTH_RPC_ERROR_CODES) {
      expect(sentinel[code]).toBe(true);
    }
    expect(Object.keys(sentinel).length).toBe(PRO_AUTH_RPC_ERROR_CODES.length);
  });

  it('PRO_AUTH_TOKEN_MAX_BYTES is a 4 KB soft cap', () => {
    expect(PRO_AUTH_TOKEN_MAX_BYTES).toBe(4096);
  });

  it('PRO_AUTH_TOKEN_MIN_BYTES enforces the display-only token_suffix invariant (Codex P2 fold)', () => {
    // The handler's display-only `token_suffix` slices the last 4 chars.
    // The lower bound must guarantee the suffix reveals at most 25%.
    expect(PRO_AUTH_TOKEN_MIN_BYTES).toBeGreaterThanOrEqual(16);
    // And must sit strictly below the upper bound so the validator
    // has a non-empty accept window.
    expect(PRO_AUTH_TOKEN_MIN_BYTES).toBeLessThan(PRO_AUTH_TOKEN_MAX_BYTES);
  });
});
