/** D-196 S2 — seller overview pair-RPC contract. */

import { describe, expect, it } from 'vitest';

import {
  SERVER_RPC_METHODS,
  SERVER_RPC_METHOD_SET,
  type ServerRpcRegistry,
} from '../rpc/server-registry.js';
import { MCP_RESERVED_RPC_PREFIXES } from '../mcp-tool-catalog.js';

describe('D-196 seller overview rpc', () => {
  it('registers the owner-only seller methods in the closed server rpc list', () => {
    const methods: Array<keyof ServerRpcRegistry> = [
      'server.seller.getOverview',
      'server.seller.transitionOfferState',
      'server.seller.updateSettings',
      'server.seller.upsertManualTier',
      'server.seller.issueManualCustomer',
      'server.seller.extendManualCustomer',
      'server.seller.swapManualCustomerTier',
      'server.seller.closeManualCustomer',
      'server.seller.reissueManualCustomerToken',
      'server.seller.bulkAdjustManualTierCustomers',
      'server.seller.synchronizeStripeEntitlements',
      'server.seller.synchronizeProviderTiers',
    ];

    for (const method of methods) {
      expect(SERVER_RPC_METHODS).toContain(method);
      expect(SERVER_RPC_METHOD_SET.has(method)).toBe(true);
    }
  });

  it('reserves the seller owner surface out of the MCP-channel catalog', () => {
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('server.seller.');
  });
});
