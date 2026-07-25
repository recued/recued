/** D-137 P1.4 — InternalToolRegistry-backed MCP adapter.
 *
 *  Acceptance per § A.1 + § A.1.1:
 *    - listTools projects ToolEntry[] to MCP `tools/list` shape
 *    - callTool routes through registry.dispatch with channel:
 *      'mcp_wire' + mcp_token_id (channel-isolation invariant)
 *    - callTool NEVER injects session_id (internal-channel slot)
 *    - hasTool returns true for known names, false otherwise
 *    - formatMcpDispatchError maps every closed-list reason to a
 *      diagnostic message
 *    - Tier 1 + Tier 2 + Tier 3 entries surface in listTools when
 *      present in the registry
 */

import { describe, it, expect } from 'vitest';
import type {
  ChatDispatchContext,
  ChatDispatchResult,
  ContractSnapshot,
  ExecutionSource,
  InternalToolRegistry,
  ToolEntry,
} from '@recued/contracts';
import {
  buildInternalToolMcpAdapter,
  formatMcpDispatchError,
  MCP_DISPATCH_ERROR_MESSAGES,
} from '../mcp-internal-tools.js';

const mkTool = (
  name: string,
  tier: 1 | 2 | 3,
  classification: ToolEntry['classification'] = 'read',
): ToolEntry => ({
  name,
  tier,
  description: `desc for ${name}`,
  arg_schema: { type: 'object' },
  topic_tags: ['mail'],
  classification,
  concurrency_safe: tier === 1 && classification === 'read',
});

const mkRegistry = (
  catalog: ReadonlyArray<ToolEntry>,
  dispatchImpl?: (name: string, args: unknown, ctx: ChatDispatchContext) => Promise<ChatDispatchResult>,
): InternalToolRegistry => ({
  list: () => catalog,
  listByTier: (tier) => catalog.filter((e) => e.tier === tier),
  getByName: (name) => catalog.find((e) => e.name === name) ?? null,
  dispatch: dispatchImpl
    ?? (async () => ({ ok: false, reason: 'not_implemented' })),
  subscribeRefresh: () => () => undefined,
});

const mcpExecutionSource: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'stdio_local',
  tool_call_id: 'mcp-test-abc123',
  mcp_token_id: 'stdio_local',
  contract_id: 'stdio_local',
};

const mcpContractSnapshot: ContractSnapshot = {
  contract_id: 'stdio_local',
  contract_version: '1',
  allowed_tools: ['safe-http'],
  approval_required: [],
  scope_restrictions: [],
  resolved_at: 1_000,
};

describe('buildInternalToolMcpAdapter — listTools', () => {
  it('projects Tier 1 / 2 / 3 entries to MCP tools/list shape', () => {
    const catalog: ToolEntry[] = [
      mkTool('contact.search', 1),
      mkTool('publisher/draft-email', 2),
      mkTool('exa.search', 3),
    ];
    const adapter = buildInternalToolMcpAdapter({
      registry: mkRegistry(catalog),
      mcp_token_id: 'tok-1',
    });
    const tools = adapter.listTools();
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual([
      'contact.search',
      'publisher/draft-email',
      'exa.search',
    ]);
    expect(tools[0]?._meta.tier).toBe(1);
    expect(tools[0]?._meta.classification).toBe('read');
    expect(tools[0]?._meta.topic_tags).toContain('mail');
  });

  it('surfaces destructive_hint + requires_kinds when present', () => {
    const tool: ToolEntry = {
      ...mkTool('exa.delete_index', 3, 'write'),
      destructive_hint: true,
      requires_kinds: ['mcp'],
    };
    const adapter = buildInternalToolMcpAdapter({
      registry: mkRegistry([tool]),
      mcp_token_id: 'tok-1',
    });
    const tools = adapter.listTools();
    expect(tools[0]?._meta.destructive_hint).toBe(true);
    expect(tools[0]?._meta.requires_kinds).toEqual(['mcp']);
  });
});

describe('buildInternalToolMcpAdapter — callTool channel isolation', () => {
  it('routes dispatch through channel: mcp_wire + mcp_token_id', async () => {
    const captured: ChatDispatchContext[] = [];
    const adapter = buildInternalToolMcpAdapter({
      registry: mkRegistry([mkTool('contact.search', 1)], async (_n, _a, ctx) => {
        captured.push(ctx);
        return { ok: true, result: { hits: [] } };
      }),
      mcp_token_id: 'tok-42',
    });

    const result = await adapter.callTool('contact.search', { q: 'peter' });
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.channel).toBe('mcp_wire');
    expect(captured[0]?.mcp_token_id).toBe('tok-42');
    // Channel-isolation invariant: session_id must NEVER be set on
    // the mcp_wire channel.
    expect(captured[0]?.session_id).toBeUndefined();
  });

  it('threads execution_source + contract_snapshot when the MCP boundary resolved them', async () => {
    const captured: ChatDispatchContext[] = [];
    const adapter = buildInternalToolMcpAdapter({
      registry: mkRegistry([mkTool('recipe.run', 1)], async (_n, _a, ctx) => {
        captured.push(ctx);
        return { ok: true, result: { success: true } };
      }),
      mcp_token_id: 'tok-contract',
      execution_source: mcpExecutionSource,
      contract_snapshot: mcpContractSnapshot,
    });

    const result = await adapter.callTool('recipe.run', { recipe_id: 'daily' });

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      channel: 'mcp_wire',
      mcp_token_id: 'tok-contract',
      execution_source: mcpExecutionSource,
      contract_snapshot: mcpContractSnapshot,
    });
    expect(captured[0]?.session_id).toBeUndefined();
  });

  it('omits execution_source + contract_snapshot for catalog-only callers', async () => {
    const captured: ChatDispatchContext[] = [];
    const adapter = buildInternalToolMcpAdapter({
      registry: mkRegistry([mkTool('recipe.run', 1)], async (_n, _a, ctx) => {
        captured.push(ctx);
        return { ok: true, result: { success: true } };
      }),
      mcp_token_id: 'tok-legacy',
    });

    const result = await adapter.callTool('recipe.run', { recipe_id: 'daily' });

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.channel).toBe('mcp_wire');
    expect(captured[0]?.mcp_token_id).toBe('tok-legacy');
    expect(captured[0]?.execution_source).toBeUndefined();
    expect(captured[0]?.contract_snapshot).toBeUndefined();
  });

  it('returns the raw ChatDispatchResult on failure', async () => {
    const adapter = buildInternalToolMcpAdapter({
      registry: mkRegistry([mkTool('contact.search', 1)], async () => ({
        ok: false,
        reason: 'not_implemented',
        detail: 'Tier 1 wiring lands in P2',
      })),
      mcp_token_id: 'tok-1',
    });
    const result = await adapter.callTool('contact.search', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_implemented');
      expect(result.detail).toContain('P2');
    }
  });
});

describe('buildInternalToolMcpAdapter — hasTool', () => {
  it('returns true for known names + false otherwise', () => {
    const adapter = buildInternalToolMcpAdapter({
      registry: mkRegistry([mkTool('mail.search', 1)]),
      mcp_token_id: 'tok-1',
    });
    expect(adapter.hasTool('mail.search')).toBe(true);
    expect(adapter.hasTool('unknown.tool')).toBe(false);
  });
});

describe('formatMcpDispatchError', () => {
  it('maps every closed-list reason to a non-empty message', () => {
    const reasons = Object.keys(MCP_DISPATCH_ERROR_MESSAGES) as Array<
      keyof typeof MCP_DISPATCH_ERROR_MESSAGES
    >;
    for (const reason of reasons) {
      const msg = formatMcpDispatchError({ ok: false, reason });
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it('appends detail when provided', () => {
    const msg = formatMcpDispatchError({
      ok: false,
      reason: 'invalid_args',
      detail: 'missing field "q"',
    });
    expect(msg).toContain('missing field');
  });
});
