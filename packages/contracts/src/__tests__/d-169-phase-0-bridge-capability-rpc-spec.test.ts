/** D-169 P0 - bridge capability profile rpc contract ratchets. */

import { describe, expect, it } from 'vitest';
import {
  MCP_RESERVED_RPC_PREFIXES,
  isReservedLocalRpc,
} from '../mcp-tool-catalog.js';
import { SERVER_RPC_METHODS } from '../rpc/server-registry.js';

describe('D-169 P0 - bridge capability profile rpc contract', () => {
  it('registers bridge.capabilityProfile.push in SERVER_RPC_METHODS', () => {
    expect(SERVER_RPC_METHODS).toContain('bridge.capabilityProfile.push');
  });

  it('reserves the bridge rpc prefix from MCP exposure', () => {
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('bridge.');
    expect(isReservedLocalRpc('bridge.capabilityProfile.push')).toBe(true);
  });
});
