/** D-145 PA8 — MCP visibility ratchet (§ A.4.4).
 *
 *  Aliases are per-pair private vocabulary. They MUST never reach
 *  external AI clients via MCP. There's no per-token override —
 *  unlike most MCP-exposed topics this is a hard substrate-level
 *  exclusion.
 *
 *  This test asserts the substrate's reservation primitives keep the
 *  alias surface out of MCP for both the published meta-tool list
 *  AND the reserved-prefix list. Future rpc registrations that
 *  attempt to bridge alias data onto MCP get caught by these
 *  ratchets at install / build time. */

import { describe, expect, it } from 'vitest';

import {
  MCP_TOOL_CATALOG,
  MCP_RESERVED_RPC_PREFIXES,
  isReservedLocalRpc,
} from '../mcp-tool-catalog.js';
import {
  CONTACT_ALIAS_MCP_EXPOSURE,
  CONTACT_ALIAS_SYNC_TRANSPORTS,
} from '../contact-identity.js';

describe('D-145 PA8 — alias surface excluded from MCP catalog (§ A.4.4)', () => {
  it('no `contact.alias.*` rpc in MCP_TOOL_CATALOG', () => {
    for (const tool of MCP_TOOL_CATALOG) {
      expect(tool.startsWith('contact.alias.')).toBe(false);
      expect(tool.startsWith('contact.identity.')).toBe(false);
      // Defensive: also check the legacy `recued_` MCP-meta-tool
      // prefix doesn't sneak an alias surface through.
      expect(tool.toLowerCase().includes('alias')).toBe(false);
    }
  });

  it('contact.alias.* + contact.identity.* prefixes are reserved local-UI-only', () => {
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('contact.alias.');
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('contact.identity.');
    expect(isReservedLocalRpc('contact.alias.list')).toBe(true);
    expect(isReservedLocalRpc('contact.alias.upsert')).toBe(true);
    expect(isReservedLocalRpc('contact.alias.delete')).toBe(true);
    expect(isReservedLocalRpc('contact.identity.set_network_domain')).toBe(true);
    expect(isReservedLocalRpc('contact.identity.create_mention_only')).toBe(true);
    expect(isReservedLocalRpc('contact.identity.promote')).toBe(true);
  });

  it('contact_alias substrate-level exposure marker is "never"', () => {
    // The exposure marker is a string literal; we assert against the
    // exact value rather than a closed set so any future relaxation
    // of the invariant is caught at compile time + test time.
    expect(CONTACT_ALIAS_MCP_EXPOSURE).toBe('never');
  });

  it('contact_alias has zero sync transports (per-pair only, no cloud)', () => {
    expect(CONTACT_ALIAS_SYNC_TRANSPORTS).toEqual([]);
  });

});

describe('D-145 PA8 — closed-list discipline (defense-in-depth)', () => {
  it('every entry in MCP_TOOL_CATALOG starts with `recued_` (no rpc bridge in)', () => {
    for (const tool of MCP_TOOL_CATALOG) {
      expect(tool.startsWith('recued_')).toBe(true);
    }
  });
  it('reserved-prefix list covers every alias / identity rpc family', () => {
    // Defense-in-depth: even if a future MCP-tool bridge accidentally
    // tries to register `contact.alias.list` as a tool, the reserved-
    // prefix check at the registration boundary catches it. This
    // asserts the ratchet's guard catches every shape we ship.
    const candidate_rpcs = [
      'contact.alias.list',
      'contact.alias.upsert',
      'contact.alias.delete',
      'contact.identity.set_network_domain',
      'contact.identity.create_mention_only',
      'contact.identity.promote',
    ];
    for (const rpc of candidate_rpcs) {
      expect(isReservedLocalRpc(rpc)).toBe(true);
    }
  });
});
