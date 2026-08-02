import { describe, it, expect } from 'vitest';
import {
  createIngredientExecutor,
  mergeManifestStepInput,
  resolveDispatchSlot,
  type Adapter,
} from '../dispatch.js';
import { RECEPTION_MATERIALIZE_SLUG } from '../kernel.js';
import { IngredientError } from '../types.js';
import type { IngredientKind, IngredientManifest } from '@recued/contracts';
import type { ManifestLoader } from '../types.js';

// ────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────

const mkManifest = (overrides: Partial<IngredientManifest> = {}): IngredientManifest => ({
  slug: 'test-slug',
  name: 'Test',
  description: 'test',
  author: 'test',
  kind: 'http',
  category: 'data',
  risk_tier: 'read',
  input: {},
  output: {},
  ...overrides,
});

/** Track which adapter got called with what. */
const mkAdapters = (): {
  adapterRegistry: Partial<Record<IngredientKind, Adapter>>;
  calls: { kind: string; slug: string; input: Record<string, unknown> }[];
} => {
  const calls: { kind: string; slug: string; input: Record<string, unknown> }[] = [];
  const makeAdapter = (kind: string): Adapter =>
    async (resolved) => {
      calls.push({ kind, slug: resolved.slug, input: resolved.input });
      return { from: kind, slug: resolved.slug };
    };
  return {
    adapterRegistry: {
      http: makeAdapter('http'),
      dom: makeAdapter('dom'),
      mcp: makeAdapter('mcp'),
      ai: makeAdapter('ai'),
      chat: makeAdapter('chat'),
    },
    calls,
  };
};

/** Build a manifest loader from a table. */
const mkLoader = (table: Record<string, IngredientManifest>): ManifestLoader =>
  async (slug) => table[slug] ?? null;

// ────────────────────────────────────────────────────────────────
// resolveDispatchSlot — D-126 P2.2 kind-based routing decisions
// ────────────────────────────────────────────────────────────────

describe('resolveDispatchSlot (D-126 P2.2)', () => {
  it('routes by manifest.kind for non-kernel manifests', () => {
    expect(resolveDispatchSlot(mkManifest({ kind: 'http' }))).toBe('http');
    expect(resolveDispatchSlot(mkManifest({ kind: 'dom' }))).toBe('dom');
    expect(resolveDispatchSlot(mkManifest({ kind: 'ai' }))).toBe('ai');
    expect(resolveDispatchSlot(mkManifest({ kind: 'chat' }))).toBe('chat');
    expect(resolveDispatchSlot(mkManifest({ kind: 'mcp' }))).toBe('mcp');
    expect(resolveDispatchSlot(mkManifest({ kind: 'service' }))).toBe('service');
    expect(resolveDispatchSlot(mkManifest({ kind: 'storage' }))).toBe('storage');
    expect(resolveDispatchSlot(mkManifest({ kind: 'connection' }))).toBe('connection');
  });

  it('overrides per-kind routing for kernel-author manifests (kernel slot wins)', () => {
    // Kernel manifests dispatch through the kernel slot regardless of
    // their stamped kind — the kernel adapter routes internally by slug.
    expect(resolveDispatchSlot(mkManifest({ author: 'recued', kind: 'storage' }))).toBe('kernel');
    expect(resolveDispatchSlot(mkManifest({ author: 'recued', kind: 'service' }))).toBe('kernel');
    expect(resolveDispatchSlot(mkManifest({ author: 'recued', kind: 'mcp' }))).toBe('kernel');
  });

  it('does not give kernel priority to non-recued authors named like a kernel', () => {
    // Only the literal `recued` author triggers the kernel shortcut.
    expect(resolveDispatchSlot(mkManifest({ author: 'recued-core', kind: 'http' }))).toBe('http');
    expect(resolveDispatchSlot(mkManifest({ author: 'alice', kind: 'http' }))).toBe('http');
  });

  // D-125 P3.1 carve-out — kind: 'connection' wins over kernel routing.
  // The kernel `connection` direct-adapter ingredient and third-party
  // `kind: 'connection'` wrappers share dispatch through the connection
  // adapter; the engine's permission + risk_tier gate stays per-manifest.
  it('routes kind: connection through the connection slot even for kernel-authored manifests (D-125 P3.1)', () => {
    expect(resolveDispatchSlot(mkManifest({ author: 'recued', kind: 'connection' })))
      .toBe('connection');
    expect(resolveDispatchSlot(mkManifest({ author: 'recued-core', kind: 'connection' })))
      .toBe('connection');
    expect(resolveDispatchSlot(mkManifest({ author: 'alice', kind: 'connection' })))
      .toBe('connection');
  });

  it('keeps kernel priority for every other kind (D-125 P3.1 carve-out is narrow)', () => {
    // Sanity — the carve-out fires only on `kind === 'connection'`, not
    // on any other kind a kernel manifest might declare.
    expect(resolveDispatchSlot(mkManifest({ author: 'recued', kind: 'http' }))).toBe('kernel');
    expect(resolveDispatchSlot(mkManifest({ author: 'recued', kind: 'storage' }))).toBe('kernel');
    expect(resolveDispatchSlot(mkManifest({ author: 'recued', kind: 'service' }))).toBe('kernel');
    expect(resolveDispatchSlot(mkManifest({ author: 'recued', kind: 'mcp' }))).toBe('kernel');
  });
});

// ────────────────────────────────────────────────────────────────
// mergeManifestStepInput — D-177 P1b hash-basis merge seam
// ────────────────────────────────────────────────────────────────

describe('mergeManifestStepInput', () => {
  it('includes manifest defaults and lets step input win on collisions', () => {
    expect(mergeManifestStepInput(
      { method: 'GET', url: 'https://api.example.com/items', note: 'manifest' },
      { note: 'step', q: 'search' },
      { trustedSurfaceDispatch: false },
    )).toEqual({
      method: 'GET',
      url: 'https://api.example.com/items',
      note: 'step',
      q: 'search',
    });
  });

  it('strips locked keys from untrusted step input unless trustedSurfaceDispatch is set', () => {
    const manifestInput = {
      method: 'GET',
      url: 'https://api.example.com/items',
    };
    const stepInput = {
      method: 'DELETE',
      url: 'https://evil.example/items',
      'header.authorization': 'Bearer pwned',
      q: 'search',
    };

    expect(mergeManifestStepInput(
      manifestInput,
      stepInput,
      { trustedSurfaceDispatch: false },
    )).toEqual({
      method: 'GET',
      url: 'https://api.example.com/items',
      q: 'search',
    });
    expect(mergeManifestStepInput(
      manifestInput,
      stepInput,
      { trustedSurfaceDispatch: true },
    )).toEqual({
      method: 'DELETE',
      url: 'https://evil.example/items',
      'header.authorization': 'Bearer pwned',
      q: 'search',
    });
  });

  it('never strips locked keys from the manifest side', () => {
    expect(mergeManifestStepInput(
      {
        method: 'POST',
        url: 'https://api.example.com/items',
        'header.authorization': 'Bearer {{vault.api.token}}',
      },
      {},
      { trustedSurfaceDispatch: false },
    )).toEqual({
      method: 'POST',
      url: 'https://api.example.com/items',
      'header.authorization': 'Bearer {{vault.api.token}}',
    });
  });

  it('drops prototype-sensitive keys from both manifest defaults and step input', () => {
    const manifestInput = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"leak":true},"prototype":{"leak":true},"safe":"manifest"}',
    ) as Record<string, unknown>;
    const stepInput = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"leak":true},"prototype":{"leak":true},"safe":"step"}',
    ) as Record<string, unknown>;

    const merged = mergeManifestStepInput(manifestInput, stepInput, {
      trustedSurfaceDispatch: true,
    });

    expect(Object.prototype.hasOwnProperty.call(merged, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(merged, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(merged, 'prototype')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
    expect(merged.safe).toBe('step');
  });
});

// ────────────────────────────────────────────────────────────────
// createIngredientExecutor — kind-based routing
// ────────────────────────────────────────────────────────────────

describe('createIngredientExecutor — routing', () => {
  it('routes kind:ai manifest to ai adapter', async () => {
    const { adapterRegistry, calls } = mkAdapters();
    const exec = createIngredientExecutor({
      manifestLoader: mkLoader({
        'ai-classify': mkManifest({
          slug: 'ai-classify', kind: 'ai', category: 'ai',
          input: { 'llm.data': null, 'llm.categories': null },
        }),
      }),
      adapterRegistry,
    });
    await exec('ai-classify', { 'llm.data': 'x', 'llm.categories': ['a', 'b'] });
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('ai');
    expect(calls[0].slug).toBe('ai-classify');
  });

  it('routes kind:mcp manifest to mcp adapter', async () => {
    const { adapterRegistry, calls } = mkAdapters();
    const exec = createIngredientExecutor({
      manifestLoader: mkLoader({
        'search-exa-mcp': mkManifest({
          slug: 'search-exa-mcp', kind: 'mcp',
          input: { 'mcp.server_url': null, 'mcp.tool': null },
        }),
      }),
      adapterRegistry,
    });
    await exec('search-exa-mcp', {
      'mcp.server_url': 'https://mcp.example.com',
      'mcp.tool': 'search',
    });
    expect(calls[0].kind).toBe('mcp');
  });

  it('routes kind:http manifest to http adapter', async () => {
    const { adapterRegistry, calls } = mkAdapters();
    const exec = createIngredientExecutor({
      manifestLoader: mkLoader({
        'deal-reader-hubspot': mkManifest({
          slug: 'deal-reader-hubspot', kind: 'http',
          input: { url: null, method: null },
        }),
      }),
      adapterRegistry,
    });
    await exec('deal-reader-hubspot', { url: 'https://api.hubspot.com/deals/42' });
    expect(calls[0].kind).toBe('http');
  });

  it('routes kind:dom manifest to dom adapter', async () => {
    const { adapterRegistry, calls } = mkAdapters();
    const exec = createIngredientExecutor({
      manifestLoader: mkLoader({
        'email-draft-reader-hubspot': mkManifest({
          slug: 'email-draft-reader-hubspot', kind: 'dom',
          input: { selector: null },
        }),
      }),
      adapterRegistry,
    });
    await exec('email-draft-reader-hubspot', { selector: '.email-body' });
    expect(calls[0].kind).toBe('dom');
  });

  it('routes kind:chat manifest to chat adapter', async () => {
    const { adapterRegistry, calls } = mkAdapters();
    const exec = createIngredientExecutor({
      manifestLoader: mkLoader({
        'web-chat-gemini': mkManifest({
          slug: 'web-chat-gemini', kind: 'chat',
          input: { 'chat.prompt': null },
        }),
      }),
      adapterRegistry,
    });
    await exec('web-chat-gemini', { 'chat.prompt': 'hello' });
    expect(calls[0].kind).toBe('chat');
  });

  it('routes recued-author manifest to kernel adapter regardless of kind', async () => {
    const calls: string[] = [];
    const exec = createIngredientExecutor({
      manifestLoader: mkLoader({
        'shared-write': mkManifest({
          slug: 'shared-write', author: 'recued', kind: 'storage',
          input: {},
        }),
      }),
      kernelAdapter: async (resolved) => {
        calls.push(resolved.slug);
        return { ok: true };
      },
      adapterRegistry: {
        // storage adapter present but should NOT be reached
        storage: async () => {
          throw new Error('storage adapter must not be called for kernel manifests');
        },
      },
    });
    await exec('shared-write', {});
    expect(calls).toEqual(['shared-write']);
  });

  it('refuses a direct reception-materialize call before the kernel adapter', async () => {
    const kernelCalls: string[] = [];
    const exec = createIngredientExecutor({
      manifestLoader: mkLoader({
        [RECEPTION_MATERIALIZE_SLUG]: mkManifest({
          slug: RECEPTION_MATERIALIZE_SLUG,
          author: 'recued',
          kind: 'storage',
          category: 'action',
          risk_tier: 'write',
        }),
      }),
      kernelAdapter: async (resolved) => {
        kernelCalls.push(resolved.slug);
        return { ok: true };
      },
      adapterRegistry: {},
    });

    await expect(exec(
      RECEPTION_MATERIALIZE_SLUG,
      { top_tier_kind: 'commitment', id: 'forged', title: 'forged' },
      undefined,
      undefined,
      // Even an engine-only marker cannot make a direct manifest load valid.
      { step_id: 'forged', surface_dispatch: true },
    )).rejects.toMatchObject({
      code: 'INGREDIENT_INTERNAL_ONLY',
      details: { slug: RECEPTION_MATERIALIZE_SLUG },
    });
    expect(kernelCalls).toEqual([]);
  });

  it('merges manifest defaults with step input (step wins for non-locked keys; D-112 strips locked keys)', async () => {
    const { adapterRegistry, calls } = mkAdapters();
    const manifest = mkManifest({
      slug: 'http-thing',
      kind: 'http',
      input: { url: 'https://api.example.com/v1/foo', method: 'GET' },
    });
    const exec = createIngredientExecutor({
      manifestLoader: mkLoader({ 'http-thing': manifest }),
      adapterRegistry,
    });
    // D-112 C3: step's `url` is locked and must be stripped before merge,
    // preserving the manifest-declared target. `custom` is non-locked so
    // step value wins.
    const input = { url: 'https://evil.example/x', custom: 'value' };
    await exec('http-thing', input);
    expect(calls[0].input).toEqual({
      url: 'https://api.example.com/v1/foo',
      method: 'GET',
      custom: 'value',
    });
  });

  it('returns the adapter result', async () => {
    const { adapterRegistry } = mkAdapters();
    const exec = createIngredientExecutor({
      manifestLoader: mkLoader({
        'x': mkManifest({ slug: 'x', kind: 'http', input: { url: null } }),
      }),
      adapterRegistry,
    });
    const result = await exec('x', {});
    expect(result).toEqual({ from: 'http', slug: 'x' });
  });
});

// ────────────────────────────────────────────────────────────────
// Error paths
// ────────────────────────────────────────────────────────────────

describe('createIngredientExecutor — errors', () => {
  it('throws INGREDIENT_NOT_FOUND when manifest loader returns null', async () => {
    const { adapterRegistry } = mkAdapters();
    const exec = createIngredientExecutor({
      manifestLoader: async () => null,
      adapterRegistry,
    });
    await expect(exec('missing', {})).rejects.toThrow(IngredientError);
    await expect(exec('missing', {})).rejects.toMatchObject({
      code: 'INGREDIENT_NOT_FOUND',
    });
  });

  it('propagates errors thrown by the manifest loader', async () => {
    const { adapterRegistry } = mkAdapters();
    const exec = createIngredientExecutor({
      manifestLoader: async () => { throw new Error('registry down'); },
      adapterRegistry,
    });
    await expect(exec('x', {})).rejects.toThrow('registry down');
  });

  it('throws INGREDIENT_ADAPTER_ALL_FAILED when routed adapter slot is missing', async () => {
    // Only HTTP adapter configured, but manifest routes to MCP
    const exec = createIngredientExecutor({
      manifestLoader: mkLoader({
        'mcp-thing': mkManifest({
          slug: 'mcp-thing', kind: 'mcp',
          input: { 'mcp.server_url': null, 'mcp.tool': null },
        }),
      }),
      adapterRegistry: { http: async () => 'ok' }, // no mcp
    });
    await expect(exec('mcp-thing', {})).rejects.toMatchObject({
      code: 'INGREDIENT_ADAPTER_ALL_FAILED',
    });
  });

  it('missing adapter error includes the kind and available adapters', async () => {
    const exec = createIngredientExecutor({
      manifestLoader: mkLoader({
        'ai-thing': mkManifest({ slug: 'ai-thing', kind: 'ai', category: 'ai', input: { 'llm.data': null } }),
      }),
      adapterRegistry: { http: async () => 'ok', dom: async () => 'ok' },
    });
    try {
      await exec('ai-thing', {});
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(IngredientError);
      const err = e as IngredientError;
      expect(err.code).toBe('INGREDIENT_ADAPTER_ALL_FAILED');
      expect(err.details?.kind).toBe('ai');
      expect(err.details?.available).toEqual(['http', 'dom']);
    }
  });

  it('throws INGREDIENT_ADAPTER_ALL_FAILED for kernel manifest when kernel adapter is missing', async () => {
    const exec = createIngredientExecutor({
      manifestLoader: mkLoader({
        'shared-write': mkManifest({
          slug: 'shared-write', author: 'recued', kind: 'storage', input: {},
        }),
      }),
      adapterRegistry: { storage: async () => 'ok' }, // no kernelAdapter passed
    });
    await expect(exec('shared-write', {})).rejects.toMatchObject({
      code: 'INGREDIENT_ADAPTER_ALL_FAILED',
      details: { kind: 'kernel' },
    });
  });

  it('propagates errors thrown by the adapter itself', async () => {
    const exec = createIngredientExecutor({
      manifestLoader: mkLoader({
        'x': mkManifest({ slug: 'x', kind: 'http', input: { url: null } }),
      }),
      adapterRegistry: {
        http: async () => { throw new Error('network down'); },
      },
    });
    await expect(exec('x', {})).rejects.toThrow('network down');
  });
});

// ────────────────────────────────────────────────────────────────
// Partial adapter sets (real-world scenarios)
// ────────────────────────────────────────────────────────────────

describe('createIngredientExecutor — partial adapter configurations', () => {
  it('node-only dispatcher with just HTTP + MCP (no DOM, no AI)', async () => {
    // A recued-server running recipes might not have DOM (no browser)
    // or AI (no API keys configured). It can still run HTTP + MCP ingredients.
    const { adapterRegistry } = mkAdapters();
    const nodeAdapters = { http: adapterRegistry.http, mcp: adapterRegistry.mcp };

    const exec = createIngredientExecutor({
      manifestLoader: mkLoader({
        'api-thing': mkManifest({ slug: 'api-thing', kind: 'http', input: { url: null } }),
      }),
      adapterRegistry: nodeAdapters,
    });

    const result = await exec('api-thing', {});
    expect(result).toEqual({ from: 'http', slug: 'api-thing' });
  });

  it('ai-only dispatcher for AI testing harness', async () => {
    // A test harness that only cares about AI ingredients can configure
    // just the ai adapter
    const { adapterRegistry, calls } = mkAdapters();
    const exec = createIngredientExecutor({
      manifestLoader: mkLoader({
        'ai-classify': mkManifest({
          slug: 'ai-classify', kind: 'ai', category: 'ai',
          input: { 'llm.data': null, 'llm.categories': null },
        }),
      }),
      adapterRegistry: { ai: adapterRegistry.ai },
    });
    await exec('ai-classify', { 'llm.data': 'x', 'llm.categories': ['a'] });
    expect(calls[0].kind).toBe('ai');
  });

  it('empty adapters → every call fails with INGREDIENT_ADAPTER_ALL_FAILED', async () => {
    const exec = createIngredientExecutor({
      manifestLoader: mkLoader({
        'x': mkManifest({ slug: 'x', kind: 'http', input: { url: null } }),
      }),
      adapterRegistry: {},
    });
    await expect(exec('x', {})).rejects.toMatchObject({
      code: 'INGREDIENT_ADAPTER_ALL_FAILED',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// stepMeta forwarding (D-127 follow-on)
// ────────────────────────────────────────────────────────────────

describe('createIngredientExecutor — forwards stepMeta onto ResolvedCall (D-127 follow-on)', () => {
  it('places the engine-supplied stepMeta on the ResolvedCall the adapter receives', async () => {
    let captured = null as { slug: string; stepMeta?: { step_id: string; recipe_id?: string } } | null;
    const exec = createIngredientExecutor({
      manifestLoader: mkLoader({
        'mail-send': mkManifest({
          slug: 'mail-send', author: 'recued', kind: 'storage', input: {},
        }),
      }),
      adapterRegistry: {},
      kernelAdapter: async (resolved) => {
        captured = { slug: resolved.slug, stepMeta: resolved.stepMeta };
        return null;
      },
    });
    await exec('mail-send', {}, undefined, undefined, {
      step_id: 'send_followup',
      recipe_id: 'detect-deal-risk-hubspot',
    });
    expect(captured?.stepMeta).toEqual({
      step_id: 'send_followup',
      recipe_id: 'detect-deal-risk-hubspot',
    });
  });

  it('omits stepMeta on the ResolvedCall when the executor was called without one', async () => {
    let captured = null as { stepMeta?: unknown } | null;
    const exec = createIngredientExecutor({
      manifestLoader: mkLoader({
        'x': mkManifest({ slug: 'x', kind: 'http' }),
      }),
      adapterRegistry: {
        http: async (resolved) => {
          captured = { stepMeta: resolved.stepMeta };
          return null;
        },
      },
    });
    await exec('x', {});
    // Direct callers (tests, MCP agent) build a `ResolvedCall` without
    // stepMeta; the dispatcher must not synthesize one.
    expect(captured?.stepMeta).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Integration with withIngredientCache
// ────────────────────────────────────────────────────────────────

describe('createIngredientExecutor + withIngredientCache integration', () => {
  it('dispatcher result is cacheable via withIngredientCache', async () => {
    // Prove the two compose: dispatcher → cache wrapper → engine
    const { withIngredientCache } = await import('../cache.js');
    const { createInMemoryStore } = await import('@recued/cache');

    let httpCalls = 0;
    const dispatcher = createIngredientExecutor({
      manifestLoader: mkLoader({
        'deal-reader': mkManifest({
          slug: 'deal-reader', kind: 'http',
          input: { url: null },
          category: 'data',
        }),
      }),
      adapterRegistry: {
        http: async () => {
          httpCalls++;
          return { id: 42, name: 'Acme' };
        },
      },
    });

    const cached = withIngredientCache(dispatcher, {
      manifestLoader: mkLoader({
        'deal-reader': mkManifest({
          slug: 'deal-reader', kind: 'http',
          input: { url: null },
          category: 'data',
        }),
      }),
      store: createInMemoryStore(),
      recipe_ttl: 300,
      recipe_id: 'test',
    });

    await cached('deal-reader', { url: 'https://api.example.com/deal/42' });
    await cached('deal-reader', { url: 'https://api.example.com/deal/42' });
    expect(httpCalls).toBe(1); // second call hit the cache
  });
});
