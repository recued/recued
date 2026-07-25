/** D-177 P2b -- ConnectionAdapterDeps.gateDispatch hook tests. */

import { describe, expect, it, vi } from 'vitest';
import type { ConnectionRow } from '@recued/contracts';
import {
  createConnectionAdapter,
  type ConnectionAdapterDeps,
  type ConnectionAdapterStore,
  type ConnectionKindHandler,
} from '../connection.js';
import { IngredientError, type ResolvedCall } from '../types.js';

const mkRow = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
  pk: `${overrides.kind ?? 'mcp'}:${overrides.name ?? 'exa'}`,
  kind: overrides.kind ?? 'mcp',
  name: overrides.name ?? 'exa',
  display_name: overrides.display_name ?? 'Exa',
  config_json: overrides.config_json ?? '{}',
  auth_ciphertext: overrides.auth_ciphertext ?? 'opaque-blob',
  enrolled_at: overrides.enrolled_at ?? 1_700_000_000_000,
  updated_at: overrides.updated_at ?? 1_700_000_000_000,
  ...(overrides.subtype !== undefined ? { subtype: overrides.subtype } : {}),
  ...(overrides.publisher_id !== undefined ? { publisher_id: overrides.publisher_id } : {}),
  ...(overrides.last_used_at !== undefined ? { last_used_at: overrides.last_used_at } : {}),
  ...(overrides.health_json !== undefined ? { health_json: overrides.health_json } : {}),
});

const mkStore = (
  rows: ReadonlyArray<ConnectionRow>,
): ConnectionAdapterStore => ({
  get(kind, name) {
    return rows.find((row) => row.kind === kind && row.name === name) ?? null;
  },
});

const mkCall = (
  input: Record<string, unknown>,
  overrides: Partial<ResolvedCall> = {},
): ResolvedCall => ({
  slug: overrides.slug ?? 'connection-mcp-write',
  risk_tier: overrides.risk_tier ?? 'write',
  input,
  output: overrides.output ?? {},
  ...(overrides.fallback ? { fallback: overrides.fallback } : {}),
});

const mcpCall = (overrides: Record<string, unknown> = {}): ResolvedCall =>
  mkCall({
    connection_kind: 'mcp',
    connection: 'exa',
    tool: 'search',
    args: { q: 'recued' },
    ...overrides,
  });

describe('D-177 P2b connection adapter gateDispatch hook', () => {
  it('invokes the hook exactly once with the resolved kind, record, params, and call', async () => {
    const row = mkRow();
    const call = mcpCall();
    const gateDispatch = vi.fn<NonNullable<ConnectionAdapterDeps['gateDispatch']>>();
    const handler = vi.fn<ConnectionKindHandler>(async () => ({ ok: true }));
    const adapter = createConnectionAdapter({
      store: mkStore([row]),
      handlers: { mcp: handler },
      gateDispatch,
    });

    await expect(adapter(call)).resolves.toEqual({ ok: true });

    expect(gateDispatch).toHaveBeenCalledTimes(1);
    expect(gateDispatch).toHaveBeenCalledWith({
      kind: 'mcp',
      record: row,
      params: { tool: 'search', args: { q: 'recued' } },
      call,
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not invoke the hook on NOT_BOUND or NOT_FOUND paths', async () => {
    const row = mkRow();
    const gateDispatch = vi.fn<NonNullable<ConnectionAdapterDeps['gateDispatch']>>();
    const handler = vi.fn<ConnectionKindHandler>(async () => ({ ok: true }));
    const adapter = createConnectionAdapter({
      store: mkStore([row]),
      handlers: { mcp: handler },
      gateDispatch,
    });

    await expect(adapter(mcpCall({ connection: '' })))
      .rejects.toMatchObject({ code: 'CONNECTION_NOT_BOUND' });
    await expect(adapter(mcpCall({ connection: 'missing' })))
      .rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });

    expect(gateDispatch).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the hook before the handler so a throwing hook prevents dispatch', async () => {
    const row = mkRow();
    const gateError = new IngredientError('MCP_TOOL_NOT_CLASSIFIED', 'blocked before handler');
    const gateDispatch = vi.fn<NonNullable<ConnectionAdapterDeps['gateDispatch']>>(() => {
      throw gateError;
    });
    const handler = vi.fn<ConnectionKindHandler>(async () => ({ ok: true }));
    const adapter = createConnectionAdapter({
      store: mkStore([row]),
      handlers: { mcp: handler },
      gateDispatch,
    });

    await expect(adapter(mcpCall())).rejects.toBe(gateError);

    expect(gateDispatch).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('propagates a throwing hook and emits exactly one error audit row', async () => {
    const row = mkRow({ subtype: 'stdio' });
    const gateError = new IngredientError('MCP_TOOL_NOT_CLASSIFIED', 'classified tool required');
    const gateDispatch = vi.fn<NonNullable<ConnectionAdapterDeps['gateDispatch']>>(() => {
      throw gateError;
    });
    const handler = vi.fn<ConnectionKindHandler>(async () => ({ ok: true }));
    const emitAudit = vi.fn<NonNullable<ConnectionAdapterDeps['emitAudit']>>();
    const adapter = createConnectionAdapter({
      store: mkStore([row]),
      handlers: { mcp: handler },
      gateDispatch,
      emitAudit,
      now: () => 1_700_000_000_000,
    });

    await expect(adapter(mcpCall())).rejects.toBe(gateError);

    expect(handler).not.toHaveBeenCalled();
    expect(emitAudit).toHaveBeenCalledTimes(1);
    expect(emitAudit).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'connection-mcp-write',
      kind: 'mcp',
      name: 'exa',
      subtype: 'stdio',
      status: 'error',
      error: {
        code: 'MCP_TOOL_NOT_CLASSIFIED',
        message: 'classified tool required',
      },
    }));
  });

  it('calls the handler and emits ok when the hook is absent', async () => {
    const row = mkRow();
    const handler = vi.fn<ConnectionKindHandler>(async () => ({ ok: true }));
    const emitAudit = vi.fn<NonNullable<ConnectionAdapterDeps['emitAudit']>>();
    const adapter = createConnectionAdapter({
      store: mkStore([row]),
      handlers: { mcp: handler },
      emitAudit,
    });

    await expect(adapter(mcpCall())).resolves.toEqual({ ok: true });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(emitAudit).toHaveBeenCalledTimes(1);
    expect(emitAudit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'mcp',
      name: 'exa',
      status: 'ok',
    }));
  });

  it('calls the handler and emits ok when the hook returns normally', async () => {
    const row = mkRow({ subtype: 'sse' });
    const gateDispatch = vi.fn<NonNullable<ConnectionAdapterDeps['gateDispatch']>>();
    const handler = vi.fn<ConnectionKindHandler>(async () => ({ ok: true }));
    const emitAudit = vi.fn<NonNullable<ConnectionAdapterDeps['emitAudit']>>();
    const adapter = createConnectionAdapter({
      store: mkStore([row]),
      handlers: { mcp: handler },
      gateDispatch,
      emitAudit,
    });

    await expect(adapter(mcpCall())).resolves.toEqual({ ok: true });

    expect(gateDispatch).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(emitAudit).toHaveBeenCalledTimes(1);
    expect(emitAudit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'mcp',
      name: 'exa',
      subtype: 'sse',
      status: 'ok',
    }));
  });
});
