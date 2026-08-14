/** D-177 P2b / D-228 slice 4 — the connection-MCP TIER gate.
 *
 *  The gate exists for one reason: `connection-mcp-read` claims a read tier to
 *  the preflight, so a read-tier dispatch of a tool that is actually a write is
 *  a spoof past the approval hold. Everything here is that claim, or a way it
 *  could be dodged.
 *
 *  ⚠ **THE SOURCE OF TRUTH MOVED, THE CLAIM DID NOT.** The tier used to come
 *  from `tool_overrides` — a value the owner typed into the chat presentation
 *  store — and now comes from the pack operation the tool is dispatched through,
 *  resolved through the same contract rows the door reads. So the vocabulary of
 *  these tests changed (`enabled` / `classification` are gone) while the
 *  properties did not: an unresolvable tier still refuses, and a write still
 *  cannot ride the read surface.
 */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  CONNECTION_MCP_READ_SLUG,
  CONNECTION_MCP_WRITE_SLUG,
  type ConnectionRow,
  type OperationRiskTier,
} from '@recued/contracts';
import { IngredientError, type ConnectionAdapterDeps, type ResolvedCall } from '@recued/ingredients';
import {
  createConnectionMcpClassificationGate,
  createConnectionMcpGateFromDb,
} from '../connection-mcp-gate.js';

type GateArgs = Parameters<NonNullable<ConnectionAdapterDeps['gateDispatch']>>[0];

const mkRow = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
  pk: `${overrides.kind ?? 'mcp'}:${overrides.name ?? 'exa'}`,
  kind: overrides.kind ?? 'mcp',
  name: overrides.name ?? 'exa',
  display_name: overrides.display_name ?? 'Exa',
  config_json: overrides.config_json ?? '{}',
  auth_ciphertext: overrides.auth_ciphertext ?? 'opaque',
  enrolled_at: overrides.enrolled_at ?? 1_700_000_000_000,
  updated_at: overrides.updated_at ?? 1_700_000_000_000,
  ...(overrides.subtype !== undefined ? { subtype: overrides.subtype } : {}),
});

const mkCall = (slug: string): ResolvedCall => ({
  slug,
  risk_tier: slug === CONNECTION_MCP_READ_SLUG ? 'read' : 'write',
  input: {},
  output: {},
});

const mkArgs = (
  overrides: Partial<GateArgs> & { slug?: string } = {},
): GateArgs => {
  const kind = overrides.kind ?? 'mcp';
  return {
    kind,
    record: overrides.record ?? mkRow({ kind, name: 'exa' }),
    params: overrides.params ?? { tool: 'search' },
    call: overrides.call ?? mkCall(overrides.slug ?? CONNECTION_MCP_READ_SLUG),
  };
};

/** The pack-resolved tiers for connection `exa`. */
const tiers = (map: Record<string, OperationRiskTier> = {}) =>
  vi.fn(() => new Map(Object.entries(map)) as ReadonlyMap<string, OperationRiskTier>);

const expectMcpGateError = (fn: () => void): IngredientError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(IngredientError);
    expect((error as IngredientError).code).toBe('MCP_TOOL_NOT_CLASSIFIED');
    return error as IngredientError;
  }
  throw new Error('expected MCP_TOOL_NOT_CLASSIFIED');
};

describe('D-228 slice 4 createConnectionMcpClassificationGate', () => {
  it('passes non-listed slugs untouched and resolves NOTHING', () => {
    const resolveToolTiers = tiers({ search: 'read' });
    const gate = createConnectionMcpClassificationGate({ resolveToolTiers });

    expect(() => gate(mkArgs({
      slug: 'slack-post',
      kind: 'api',
      record: mkRow({ kind: 'api', name: 'slack' }),
      params: {},
    }))).not.toThrow();

    expect(resolveToolTiers).not.toHaveBeenCalled();
  });

  it.each([CONNECTION_MCP_READ_SLUG, CONNECTION_MCP_WRITE_SLUG])(
    'throws when %s dispatches with kind other than mcp',
    (slug) => {
      // The manifests pin `connection_kind`, but step input can override it, and
      // an `api` swap would reroute to a handler with no tier concept at all.
      const resolveToolTiers = tiers({ search: 'read' });
      const gate = createConnectionMcpClassificationGate({ resolveToolTiers });

      const error = expectMcpGateError(() => gate(mkArgs({
        slug,
        kind: 'api',
        record: mkRow({ kind: 'api', name: 'hubspot' }),
      })));

      expect(error.details).toMatchObject({ slug, kind: 'api', name: 'hubspot' });
      expect(resolveToolTiers).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['missing', {}],
    ['empty', { tool: '' }],
    ['blank', { tool: '   ' }],
  ])('throws when the tool param is %s', (_label, params) => {
    const resolveToolTiers = tiers({ search: 'read' });
    const gate = createConnectionMcpClassificationGate({ resolveToolTiers });

    expectMcpGateError(() => gate(mkArgs({ params })));

    expect(resolveToolTiers).not.toHaveBeenCalled();
  });

  it('⛔ throws when NO pack covers the tool — the tier is unknown and is not guessed', () => {
    const gate = createConnectionMcpClassificationGate({ resolveToolTiers: tiers({}) });

    const error = expectMcpGateError(() => gate(mkArgs()));

    expect(error.details).toMatchObject({ name: 'exa', tool: 'search' });
    // The message must point at the cause an owner can act on, not at a code.
    expect(error.message).toMatch(/not covered by an installed operation/);
  });

  it('⛔ throws when the connection has NO bound catalog at all', () => {
    // Distinct input (undefined vs empty map), same refusal — a connection whose
    // server was never reachable has no governed operation to take a tier from.
    const gate = createConnectionMcpClassificationGate({
      resolveToolTiers: () => undefined,
    });
    expectMcpGateError(() => gate(mkArgs()));
  });

  it('⛔⛔ throws when the READ slug dispatches a write-tier tool — THE TIER SPOOF', () => {
    // The whole reason this gate exists. A write riding the read surface reaches
    // the preflight labelled `read` and never holds.
    const gate = createConnectionMcpClassificationGate({
      resolveToolTiers: tiers({ search: 'write' }),
    });

    const error = expectMcpGateError(() => gate(mkArgs({ slug: CONNECTION_MCP_READ_SLUG })));

    expect(error.details).toMatchObject({ risk_tier: 'write' });
    expect(error.message).toMatch(new RegExp(CONNECTION_MCP_WRITE_SLUG));
  });

  it('passes when the READ slug dispatches a read-tier tool', () => {
    const gate = createConnectionMcpClassificationGate({
      resolveToolTiers: tiers({ search: 'read' }),
    });
    expect(() => gate(mkArgs({ slug: CONNECTION_MCP_READ_SLUG }))).not.toThrow();
  });

  it.each<[OperationRiskTier]>([['read'], ['write']])(
    'passes when the WRITE slug dispatches a %s-tier tool',
    (tier) => {
      // Over-gating a read is safe — it only adds the approval hold.
      const gate = createConnectionMcpClassificationGate({
        resolveToolTiers: tiers({ search: tier }),
      });
      expect(() => gate(mkArgs({ slug: CONNECTION_MCP_WRITE_SLUG }))).not.toThrow();
    },
  );

  it.each<[OperationRiskTier]>([['admin'], ['destructive']])(
    '⛔ refuses a %s-tier tool on BOTH slugs',
    (tier) => {
      // These kernel surfaces are the untyped escape hatch. An operation the
      // owner marked this dangerous must be reached through its own op id, where
      // the contract governs it by name.
      for (const slug of [CONNECTION_MCP_READ_SLUG, CONNECTION_MCP_WRITE_SLUG]) {
        const gate = createConnectionMcpClassificationGate({
          resolveToolTiers: tiers({ search: tier }),
        });
        expectMcpGateError(() => gate(mkArgs({ slug })));
      }
    },
  );

  it.each(['__proto__', 'constructor'])(
    'does not resolve a prototype key as a tier (%s)',
    (tool) => {
      // The old gate walked a plain object and needed `hasOwnProperty`. A Map is
      // immune by construction — asserted so the immunity survives a refactor
      // back to an object literal.
      const gate = createConnectionMcpClassificationGate({
        resolveToolTiers: tiers({ search: 'read' }),
      });
      expectMcpGateError(() => gate(mkArgs({ params: { tool } })));
    },
  );
});

describe('D-228 slice 4 createConnectionMcpGateFromDb', () => {
  it('⛔ FAILS CLOSED when the stores are unwired — a gate that admits is not a gate', () => {
    const db = new Database(':memory:');
    try {
      const gate = createConnectionMcpGateFromDb(db);

      // Non-listed slugs still pass untouched.
      expect(() => gate(mkArgs({ slug: 'slack-post', params: {} }))).not.toThrow();
      // Kernel slugs refuse, because no tier can be resolved.
      expectMcpGateError(() => gate(mkArgs({
        slug: CONNECTION_MCP_READ_SLUG,
        params: { tool: 'search' },
      })));
    } finally {
      db.close();
    }
  });

  it('admits a read tool once a bound catalog declares it', () => {
    const db = new Database(':memory:');
    try {
      const PACK = 'mcp-0123456789abcdef0123456789abcdef';
      const gate = createConnectionMcpGateFromDb(db, {
        contractStore: {
          get: (scope: string, segments: readonly string[]) =>
            (scope === 'connection_catalog_binding' && segments[0] === 'exa'
              // ⚠ `installed_pack_id` is REQUIRED by `readBinding` — omit it and
              // the binding resolves to undefined, which reads as "no pack" and
              // makes this permitting witness silently assert the refusal.
              ? {
                  segments: [...segments],
                  value: { catalog_slug: PACK, installed_pack_id: 'pack_1' },
                }
              : null),
          scan: () => [],
        } as never,
        getManifest: (slug) => (slug === PACK
          ? ({
              slug: PACK,
              operations: { search_op: { risk_tier: 'read', operation_id: `x.${PACK}.search_op` } },
              surfaces: { api: { executes: { search_op: { kind: 'mcp', tool: 'search' } } } },
            } as never)
          : null),
      });

      expect(() => gate(mkArgs({
        slug: CONNECTION_MCP_READ_SLUG,
        params: { tool: 'search' },
      }))).not.toThrow();

      // ⚠ THE PERMITTING WITNESS'S SIBLING — the same wiring must still refuse a
      // tool the catalog does not declare, or "it admits" proves only that the
      // gate stopped working.
      expectMcpGateError(() => gate(mkArgs({
        slug: CONNECTION_MCP_READ_SLUG,
        params: { tool: 'not_declared' },
      })));
    } finally {
      db.close();
    }
  });
});
