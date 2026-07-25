/** D-137 W2.2 § A.1.1 — Settings → Chat → Tool Catalog Scope renderer.
 *
 *  Acceptance:
 *    - buildChatToolCatalogScopeOptions iterates the closed 8-kind list
 *      in canonical declaration order with correct safe/risky tags
 *    - buildChatToolCatalogScopeModel returns 'pending' when snapshot
 *      missing / array empty member off-list
 *    - buildChatToolCatalogScopeModel resolves is_customised flag
 *      correctly when matching / diverging from safe defaults
 *    - projectToggledKinds preserves canonical order on toggle on/off
 *    - reduceChatToolCatalogScopeChanged absorbs broadcast events
 */

import { describe, it, expect } from 'vitest';
import {
  CHAT_TOOL_CATALOG_KIND_COPY,
  buildChatToolCatalogScopeModel,
  buildChatToolCatalogScopeOptions,
  projectToggledKinds,
  reduceChatToolCatalogScopeChanged,
} from '../settings/chat-tool-catalog.js';
import type { IngredientKind } from '@recued/contracts';

describe('CHAT_TOOL_CATALOG_KIND_COPY exhaustive over IngredientKind', () => {
  it('covers all 9 D-126/D-182 closed-list kinds', () => {
    const keys = Object.keys(CHAT_TOOL_CATALOG_KIND_COPY);
    expect(new Set(keys)).toEqual(
      new Set(['http', 'dom', 'ai', 'chat', 'mcp', 'service', 'storage', 'connection', 'cli']),
    );
  });

  it('safe-tier covers http / ai / storage / service', () => {
    expect(CHAT_TOOL_CATALOG_KIND_COPY.http.risk_tier).toBe('safe');
    expect(CHAT_TOOL_CATALOG_KIND_COPY.ai.risk_tier).toBe('safe');
    expect(CHAT_TOOL_CATALOG_KIND_COPY.storage.risk_tier).toBe('safe');
    expect(CHAT_TOOL_CATALOG_KIND_COPY.service.risk_tier).toBe('safe');
  });

  it('risky-tier covers dom / chat / mcp / connection / cli', () => {
    expect(CHAT_TOOL_CATALOG_KIND_COPY.dom.risk_tier).toBe('risky');
    expect(CHAT_TOOL_CATALOG_KIND_COPY.chat.risk_tier).toBe('risky');
    expect(CHAT_TOOL_CATALOG_KIND_COPY.mcp.risk_tier).toBe('risky');
    expect(CHAT_TOOL_CATALOG_KIND_COPY.connection.risk_tier).toBe('risky');
    // D-182 — cli (Local tools) joins the default-off risky set.
    expect(CHAT_TOOL_CATALOG_KIND_COPY.cli.risk_tier).toBe('risky');
  });
});

describe('buildChatToolCatalogScopeOptions', () => {
  it('returns one row per IngredientKind in canonical order', () => {
    const enabled = new Set<IngredientKind>(['http', 'ai']);
    const options = buildChatToolCatalogScopeOptions(enabled);
    expect(options.map((o) => o.kind)).toEqual([
      'http',
      'dom',
      'ai',
      'chat',
      'mcp',
      'service',
      'storage',
      'connection',
      'cli',
    ]);
  });

  it('enabled flag matches the input set', () => {
    const enabled = new Set<IngredientKind>(['http', 'ai']);
    const options = buildChatToolCatalogScopeOptions(enabled);
    const map = new Map(options.map((o) => [o.kind, o.enabled] as const));
    expect(map.get('http')).toBe(true);
    expect(map.get('ai')).toBe(true);
    expect(map.get('storage')).toBe(false);
    expect(map.get('connection')).toBe(false);
  });
});

describe('buildChatToolCatalogScopeModel', () => {
  it('returns pending when snapshot is null', () => {
    const model = buildChatToolCatalogScopeModel(null);
    expect(model.kind).toBe('pending');
  });

  it('returns pending when enabled_kinds is not an array', () => {
    const model = buildChatToolCatalogScopeModel({
      enabled_kinds: 'http' as unknown as IngredientKind[],
      updated_at: 1_000,
    });
    expect(model.kind).toBe('pending');
  });

  it('resolves when snapshot is well-formed', () => {
    const model = buildChatToolCatalogScopeModel({
      enabled_kinds: ['http', 'ai', 'storage', 'service'] as IngredientKind[],
      updated_at: 4_000,
    });
    expect(model.kind).toBe('resolved');
    if (model.kind !== 'resolved') return;
    expect(model.updated_at).toBe(4_000);
    expect(model.is_customised).toBe(false);
  });

  it('marks is_customised=true when enabled set diverges from safe defaults', () => {
    const model = buildChatToolCatalogScopeModel({
      enabled_kinds: ['http'] as IngredientKind[],
      updated_at: 4_000,
    });
    expect(model.kind).toBe('resolved');
    if (model.kind !== 'resolved') return;
    expect(model.is_customised).toBe(true);
  });

  it('drops off-list members silently per D-148 § A.4 invariant', () => {
    const model = buildChatToolCatalogScopeModel({
      enabled_kinds: ['http', 'bogus' as IngredientKind, 'ai'] as IngredientKind[],
      updated_at: 4_000,
    });
    expect(model.kind).toBe('resolved');
    if (model.kind !== 'resolved') return;
    const enabledKinds = model.options.filter((o) => o.enabled).map((o) => o.kind);
    expect(enabledKinds).toEqual(['http', 'ai']);
  });

  it('safe default set: is_customised=false even though kinds are listed', () => {
    const model = buildChatToolCatalogScopeModel({
      enabled_kinds: ['service', 'storage', 'ai', 'http'] as IngredientKind[],
      updated_at: 0,
    });
    expect(model.kind).toBe('resolved');
    if (model.kind !== 'resolved') return;
    expect(model.is_customised).toBe(false);
  });
});

describe('projectToggledKinds', () => {
  it('adds a kind when next_enabled=true', () => {
    const out = projectToggledKinds({
      current: ['http', 'ai'] as IngredientKind[],
      kind: 'storage',
      next_enabled: true,
    });
    expect(out).toEqual(['http', 'ai', 'storage']);
  });

  it('removes a kind when next_enabled=false', () => {
    const out = projectToggledKinds({
      current: ['http', 'ai', 'storage'] as IngredientKind[],
      kind: 'ai',
      next_enabled: false,
    });
    expect(out).toEqual(['http', 'storage']);
  });

  it('idempotent on no-op add', () => {
    const out = projectToggledKinds({
      current: ['http'] as IngredientKind[],
      kind: 'http',
      next_enabled: true,
    });
    expect(out).toEqual(['http']);
  });

  it('idempotent on no-op remove', () => {
    const out = projectToggledKinds({
      current: ['http'] as IngredientKind[],
      kind: 'ai',
      next_enabled: false,
    });
    expect(out).toEqual(['http']);
  });

  it('preserves canonical order regardless of toggle history', () => {
    const out = projectToggledKinds({
      current: ['storage', 'http'] as IngredientKind[],
      kind: 'ai',
      next_enabled: true,
    });
    expect(out).toEqual(['http', 'ai', 'storage']);
  });
});

describe('reduceChatToolCatalogScopeChanged', () => {
  it('replaces current model with broadcast snapshot', () => {
    const initial = buildChatToolCatalogScopeModel({
      enabled_kinds: ['http'] as IngredientKind[],
      updated_at: 1_000,
    });
    const next = reduceChatToolCatalogScopeChanged(initial, {
      enabled_kinds: ['http', 'ai', 'storage'],
      updated_at: 5_000,
    });
    expect(next.kind).toBe('resolved');
    if (next.kind !== 'resolved') return;
    expect(next.updated_at).toBe(5_000);
    const enabled = next.options.filter((o) => o.enabled).map((o) => o.kind);
    expect(enabled).toEqual(['http', 'ai', 'storage']);
  });

  it('drops off-list broadcast members silently', () => {
    const initial = buildChatToolCatalogScopeModel({
      enabled_kinds: ['http'] as IngredientKind[],
      updated_at: 1_000,
    });
    const next = reduceChatToolCatalogScopeChanged(initial, {
      enabled_kinds: ['http', 'made_up_kind'],
      updated_at: 6_000,
    });
    expect(next.kind).toBe('resolved');
    if (next.kind !== 'resolved') return;
    const enabled = next.options.filter((o) => o.enabled).map((o) => o.kind);
    expect(enabled).toEqual(['http']);
  });
});
