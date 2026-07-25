/** D-116 Phase 3 — `runtime.testTrigger` pair-rpc entry on the server
 *  rpc registry. Locks the method name so callers fail to compile if
 *  it's renamed, and the dispatcher's `unknown_method` branch doesn't
 *  silently swallow Kitchen forwards. */

import { describe, it, expect } from 'vitest';
import { SERVER_RPC_METHODS, SERVER_RPC_METHOD_SET } from '../rpc/server-registry.js';

describe('runtime.testTrigger rpc method', () => {
  it('is present in SERVER_RPC_METHODS', () => {
    expect(SERVER_RPC_METHODS).toContain('runtime.testTrigger');
  });

  it('is present in SERVER_RPC_METHOD_SET for O(1) dispatcher lookup', () => {
    expect(SERVER_RPC_METHOD_SET.has('runtime.testTrigger')).toBe(true);
  });
});
