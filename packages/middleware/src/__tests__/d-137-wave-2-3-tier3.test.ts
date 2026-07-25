/** D-137 Wave 2.3 — InternalToolRegistry Tier 3 enumeration.
 *
 *  Acceptance per spec § A.1.1 + § A.10 + the W2.3 substrate notes:
 *   - The factory accepts an optional `tier3Source`; without it the
 *     catalog stays Tier 1 + Tier 2 only.
 *   - `listByTier(3)` projects Mary's per-connection MCP annotation
 *     through the contracts-side `buildTier3Catalog` pipeline; only
 *     enabled + classified tools surface.
 *   - `list()` returns Tier 1 / Tier 2 / Tier 3 in that order; the
 *     Tier 1 ordering is preserved.
 *   - `getByName('<connection>.<tool>')` resolves Tier 3 entries.
 *   - Dispatch on a Tier 3 name routes through the optional
 *     `tier3Dispatch` override; defaults to `not_implemented`.
 *   - Source mutation (Mary toggles a tool in Settings → Connections)
 *     surfaces in the next `list()` call.
 *   - Disabled / unclassified tools never surface (substrate-level
 *     enforcement; matches § A.10 "until classified, invisible"). */

import { describe, it, expect } from 'vitest';
import {
  TIER1_TOOL_NAMES,
  type ChatDispatchContext,
  type ConnectionMcpAnnotationState,
} from '@recued/contracts';
import {
  createInternalToolRegistry,
  type Tier3Handler,
  type Tier3Source,
} from '../internal-tool-registry/index.js';

const ctxInternal = (
  session_id = 'sess-1',
  turn_id = 'turn-1',
): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id,
  turn_id,
});

const baseAnnotation = (
  connection_name: string,
  overrides: Partial<ConnectionMcpAnnotationState> = {},
): ConnectionMcpAnnotationState => ({
  connection_name,
  topic_tags: [],
  tool_overrides: {},
  tools_list_cache: { tools: [], cached_at: 0 },
  updated_at: 0,
  ...overrides,
});

describe('D-137 Wave 2.3 — Tier 3 catalog enumeration (§ A.1.1 + § A.10)', () => {
  it('list() preserves prior posture when no tier3Source is provided', () => {
    const registry = createInternalToolRegistry();
    expect(registry.listByTier(3)).toEqual([]);
    // Without Tier 2 source either, the catalog stays Tier-1-only.
    expect(registry.list().length).toBe(TIER1_TOOL_NAMES.length);
  });

  it('listByTier(3) projects enabled + classified annotation tools', () => {
    const annotations: ConnectionMcpAnnotationState[] = [
      baseAnnotation('exa', {
        topic_tags: ['web'],
        tool_overrides: {
          search: { enabled: true, classification: 'read' },
          contents: { enabled: true, classification: 'read' },
          delete_index: { enabled: true, classification: 'write' },
        },
        tools_list_cache: {
          tools: [
            { name: 'search' },
            { name: 'contents' },
            { name: 'delete_index', destructive_hint: true },
          ],
          cached_at: 100,
        },
      }),
    ];
    const registry = createInternalToolRegistry({
      tier3Source: { listAnnotations: () => annotations },
    });
    const tier3 = registry.listByTier(3);
    expect(tier3.map((e) => e.name)).toEqual([
      'exa.contents',
      'exa.delete_index',
      'exa.search',
    ]);
    for (const e of tier3) {
      expect(e.tier).toBe(3);
    }
  });

  it('list() returns Tier 1 first, then Tier 3 (Tier 1 ordering preserved)', () => {
    const annotations: ConnectionMcpAnnotationState[] = [
      baseAnnotation('exa', {
        tool_overrides: {
          search: { enabled: true, classification: 'read' },
        },
        tools_list_cache: {
          tools: [{ name: 'search' }],
          cached_at: 100,
        },
      }),
    ];
    const registry = createInternalToolRegistry({
      tier3Source: { listAnnotations: () => annotations },
    });
    const list = registry.list();
    expect(list.length).toBe(TIER1_TOOL_NAMES.length + 1);
    expect(list.slice(0, TIER1_TOOL_NAMES.length).map((e) => e.name)).toEqual(
      [...TIER1_TOOL_NAMES],
    );
    expect(list[list.length - 1]!.name).toBe('exa.search');
    expect(list[list.length - 1]!.tier).toBe(3);
  });

  it('getByName resolves a Tier 3 entry by its formatted name', () => {
    const annotations: ConnectionMcpAnnotationState[] = [
      baseAnnotation('exa', {
        tool_overrides: {
          search: { enabled: true, classification: 'read' },
        },
        tools_list_cache: {
          tools: [{ name: 'search' }],
          cached_at: 100,
        },
      }),
    ];
    const registry = createInternalToolRegistry({
      tier3Source: { listAnnotations: () => annotations },
    });
    const entry = registry.getByName('exa.search');
    expect(entry).not.toBeNull();
    expect(entry!.tier).toBe(3);
    expect(entry!.classification).toBe('read');
  });

  it('getByName returns null for tools the gates excluded from catalog', () => {
    const annotations: ConnectionMcpAnnotationState[] = [
      baseAnnotation('exa', {
        tool_overrides: {
          delete_index: { enabled: true, classification: 'unknown' },
          contents: { enabled: false, classification: 'read' },
        },
        tools_list_cache: {
          tools: [{ name: 'delete_index' }, { name: 'contents' }, { name: 'search' }],
          cached_at: 100,
        },
      }),
    ];
    const registry = createInternalToolRegistry({
      tier3Source: { listAnnotations: () => annotations },
    });
    expect(registry.getByName('exa.delete_index')).toBeNull(); // unclassified
    expect(registry.getByName('exa.contents')).toBeNull(); // disabled
    expect(registry.getByName('exa.search')).toBeNull(); // no override
  });

  it('dispatch on a Tier 3 entry routes through tier3Dispatch override', async () => {
    const annotations: ConnectionMcpAnnotationState[] = [
      baseAnnotation('exa', {
        tool_overrides: {
          search: { enabled: true, classification: 'read' },
        },
        tools_list_cache: {
          tools: [{ name: 'search' }],
          cached_at: 100,
        },
      }),
    ];
    let calls = 0;
    const dispatch: Tier3Handler = async (name, args, ctx) => {
      calls += 1;
      expect(name).toBe('exa.search');
      expect(args).toEqual({ query: 'recued' });
      expect(ctx.channel).toBe('internal_function_call');
      return { ok: true, result: { hits: ['recued.com'] } };
    };
    const registry = createInternalToolRegistry({
      tier3Source: { listAnnotations: () => annotations },
      tier3Dispatch: dispatch,
    });
    const r = await registry.dispatch('exa.search', { query: 'recued' }, ctxInternal());
    expect(calls).toBe(1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result).toEqual({ hits: ['recued.com'] });
    }
  });

  it('dispatch on an unwired Tier 3 entry defaults to not_implemented', async () => {
    const annotations: ConnectionMcpAnnotationState[] = [
      baseAnnotation('exa', {
        tool_overrides: {
          search: { enabled: true, classification: 'read' },
        },
        tools_list_cache: {
          tools: [{ name: 'search' }],
          cached_at: 100,
        },
      }),
    ];
    const registry = createInternalToolRegistry({
      tier3Source: { listAnnotations: () => annotations },
    });
    const r = await registry.dispatch('exa.search', {}, ctxInternal());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('not_implemented');
    }
  });

  it('dispatch on a name that fails the gates resolves unknown_tool (not in catalog)', async () => {
    const annotations: ConnectionMcpAnnotationState[] = [
      baseAnnotation('exa', {
        tool_overrides: {
          delete_index: { enabled: true, classification: 'unknown' },
        },
        tools_list_cache: {
          tools: [{ name: 'delete_index' }],
          cached_at: 100,
        },
      }),
    ];
    const registry = createInternalToolRegistry({
      tier3Source: { listAnnotations: () => annotations },
    });
    const r = await registry.dispatch('exa.delete_index', {}, ctxInternal());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('unknown_tool');
    }
  });

  it('mutation in the source surfaces in the next list() call', () => {
    let live: ConnectionMcpAnnotationState[] = [];
    const source: Tier3Source = { listAnnotations: () => live };
    const registry = createInternalToolRegistry({ tier3Source: source });
    expect(registry.listByTier(3)).toEqual([]);
    live = [
      baseAnnotation('exa', {
        tool_overrides: {
          search: { enabled: true, classification: 'read' },
        },
        tools_list_cache: {
          tools: [{ name: 'search' }],
          cached_at: 100,
        },
      }),
    ];
    expect(registry.listByTier(3).map((e) => e.name)).toEqual(['exa.search']);
    // Mary disables the tool — gone from the catalog.
    live = [
      baseAnnotation('exa', {
        tool_overrides: {
          search: { enabled: false, classification: 'read' },
        },
        tools_list_cache: {
          tools: [{ name: 'search' }],
          cached_at: 100,
        },
      }),
    ];
    expect(registry.listByTier(3)).toEqual([]);
  });

  it('Tier 2 and Tier 3 sources compose without interference', () => {
    const annotations: ConnectionMcpAnnotationState[] = [
      baseAnnotation('exa', {
        tool_overrides: {
          search: { enabled: true, classification: 'read' },
        },
        tools_list_cache: {
          tools: [{ name: 'search' }],
          cached_at: 100,
        },
      }),
    ];
    const registry = createInternalToolRegistry({
      tier2Source: { listRecipes: () => [] },
      tier3Source: { listAnnotations: () => annotations },
    });
    const list = registry.list();
    expect(list.some((e) => e.name === 'exa.search')).toBe(true);
    expect(list.some((e) => e.tier === 1)).toBe(true);
  });
});
