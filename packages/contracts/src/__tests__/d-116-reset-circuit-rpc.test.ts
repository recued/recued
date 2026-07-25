/** D-116 Phase 7 — `runtime.resetCircuit` pair-rpc entry. Locks the
 *  method so the Kitchen / options Reset button can dispatch through
 *  the paired server without a dispatcher "unknown_method" swallow. */

import { describe, it, expect } from 'vitest';
import { SERVER_RPC_METHODS, SERVER_RPC_METHOD_SET } from '../rpc/server-registry.js';

describe('runtime.resetCircuit rpc method', () => {
  it('is present in SERVER_RPC_METHODS', () => {
    expect(SERVER_RPC_METHODS).toContain('runtime.resetCircuit');
  });

  it('is present in SERVER_RPC_METHOD_SET for O(1) dispatcher lookup', () => {
    expect(SERVER_RPC_METHOD_SET.has('runtime.resetCircuit')).toBe(true);
  });
});
