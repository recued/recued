/** D-137 W2.2 § A.1.1 — per-kind catalog scope substrate ratchets.
 *
 *  Pure contract surface only: closed-list constants, computeKindGated-
 *  Tier2Names projection over a Tier 2 catalog, validator over inbound
 *  rpc args, rpc + broadcast registry membership.
 *
 *  Network / storage / orchestrator integration covered in the engine
 *  + server suites.
 */

import { describe, it, expect } from 'vitest';
import {
  CHAT_BROADCAST_EVENT_KINDS,
  CHAT_RPC_METHODS,
  CHAT_TOOL_CATALOG_SCOPE_VALIDATION_ISSUE_CODES,
  DEFAULT_CHAT_CATALOG_SCOPE,
  INGREDIENT_KINDS,
  SAFE_DEFAULT_CHAT_CATALOG_KINDS,
  SERVER_RPC_METHODS,
  computeKindGatedTier2Names,
  validateChatToolCatalogScopeInput,
  type IngredientKind,
  type ToolEntry,
} from '../index.js';

describe('D-137 W2.2 — SAFE_DEFAULT_CHAT_CATALOG_KINDS closed list', () => {
  it('contains exactly the four safe kinds per § P1 in canonical order', () => {
    // Canonical INGREDIENT_KINDS declaration order:
    //   http | dom | ai | chat | mcp | service | storage | connection
    expect(SAFE_DEFAULT_CHAT_CATALOG_KINDS).toEqual(['http', 'ai', 'service', 'storage']);
  });
  it('every member is a valid IngredientKind', () => {
    for (const k of SAFE_DEFAULT_CHAT_CATALOG_KINDS) {
      expect(INGREDIENT_KINDS.has(k)).toBe(true);
    }
  });
  it('default-off kinds (dom / chat / mcp / connection / cli) are absent', () => {
    const set = new Set<string>(SAFE_DEFAULT_CHAT_CATALOG_KINDS);
    expect(set.has('dom')).toBe(false);
    expect(set.has('chat')).toBe(false);
    expect(set.has('mcp')).toBe(false);
    expect(set.has('connection')).toBe(false);
    // D-182 — cli (local tools) joins the default-off set per the §7 opt-in posture.
    expect(set.has('cli')).toBe(false);
  });
});

describe('D-137 W2.2 — DEFAULT_CHAT_CATALOG_SCOPE substrate default', () => {
  it('matches SAFE_DEFAULT_CHAT_CATALOG_KINDS', () => {
    expect(DEFAULT_CHAT_CATALOG_SCOPE.enabled_kinds).toBe(
      SAFE_DEFAULT_CHAT_CATALOG_KINDS,
    );
  });
  it('updated_at is 0 (not yet stamped — first-boot sentinel)', () => {
    expect(DEFAULT_CHAT_CATALOG_SCOPE.updated_at).toBe(0);
  });
});

const tier2 = (name: string, requires?: IngredientKind[]): ToolEntry => ({
  name,
  tier: 2,
  description: 'x',
  arg_schema: { type: 'object' },
  topic_tags: [],
  classification: 'unknown',
  concurrency_safe: false,
  ...(requires ? { requires_kinds: requires } : {}),
});

const tier1 = (name: string): ToolEntry => ({
  name,
  tier: 1,
  description: 'x',
  arg_schema: { type: 'object' },
  topic_tags: [],
  classification: 'read',
  concurrency_safe: true,
});

const tier3 = (name: string): ToolEntry => ({
  name,
  tier: 3,
  description: 'x',
  arg_schema: { type: 'object' },
  topic_tags: [],
  classification: 'unknown',
  concurrency_safe: false,
});

describe('D-137 W2.2 — computeKindGatedTier2Names', () => {
  it('returns empty set when no Tier 2 entries reference disabled kinds', () => {
    const catalog = [
      tier1('contact.search'),
      tier2('mary/safe-summary', ['ai']),
      tier3('exa.search'),
    ];
    const enabled = new Set<IngredientKind>(['http', 'ai', 'storage', 'service']);
    const gated = computeKindGatedTier2Names(catalog, enabled);
    expect(gated.size).toBe(0);
  });
  it('gates Tier 2 entries whose requires_kinds intersect the disabled set', () => {
    const catalog = [
      tier2('mary/uses-file', ['storage']),
      tier2('mary/uses-mail', ['http']),
      tier2('mary/uses-connection', ['connection']),
    ];
    const enabled = new Set<IngredientKind>(['http', 'ai']);
    const gated = computeKindGatedTier2Names(catalog, enabled);
    expect(gated.has('mary/uses-file')).toBe(true);
    expect(gated.has('mary/uses-connection')).toBe(true);
    expect(gated.has('mary/uses-mail')).toBe(false);
  });
  it('never gates Tier 1 entries even when the kind list excludes everything', () => {
    const catalog = [tier1('contact.search'), tier1('mail.search')];
    const enabled = new Set<IngredientKind>();
    const gated = computeKindGatedTier2Names(catalog, enabled);
    expect(gated.has('contact.search')).toBe(false);
    expect(gated.has('mail.search')).toBe(false);
  });
  it('never gates Tier 3 entries (per § A.1.1 — toggle only applies to Tier 2)', () => {
    const catalog = [tier3('exa.search')];
    const enabled = new Set<IngredientKind>();
    const gated = computeKindGatedTier2Names(catalog, enabled);
    expect(gated.has('exa.search')).toBe(false);
  });
  it('Tier 2 entry without requires_kinds is treated as kind-free (no gate)', () => {
    const catalog = [tier2('mary/no-deps')];
    const enabled = new Set<IngredientKind>();
    const gated = computeKindGatedTier2Names(catalog, enabled);
    expect(gated.has('mary/no-deps')).toBe(false);
  });
  it('hard refusal: a single disabled kind in requires_kinds gates the entry', () => {
    // The spec says: "Mary unchecks file, every recipe transitively
    // using a file-* ingredient drops from her chat catalog" — even if
    // other kinds are enabled, ANY disabled match gates.
    const catalog = [tier2('mary/multi-kind', ['http', 'storage', 'ai'])];
    const enabled = new Set<IngredientKind>(['http', 'ai']);
    const gated = computeKindGatedTier2Names(catalog, enabled);
    expect(gated.has('mary/multi-kind')).toBe(true);
  });
});

describe('D-137 W2.2 — validateChatToolCatalogScopeInput', () => {
  it('accepts a well-formed input + canonicalises order', () => {
    const result = validateChatToolCatalogScopeInput({
      // Out-of-order on purpose; validator returns canonical order
      // matching INGREDIENT_KINDS declaration:
      //   http | dom | ai | chat | mcp | service | storage | connection
      enabled_kinds: ['storage', 'http', 'ai', 'service'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.enabled_kinds).toEqual(['http', 'ai', 'service', 'storage']);
  });
  it('accepts an empty list (Mary may disable every kind)', () => {
    const result = validateChatToolCatalogScopeInput({ enabled_kinds: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.enabled_kinds).toEqual([]);
  });
  it('rejects a non-object input', () => {
    const result = validateChatToolCatalogScopeInput(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('enabled_kinds_not_array');
  });
  it('rejects when enabled_kinds is missing or not an array', () => {
    const result = validateChatToolCatalogScopeInput({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('enabled_kinds_not_array');
  });
  it('rejects off-list IngredientKind values', () => {
    const result = validateChatToolCatalogScopeInput({
      enabled_kinds: ['http', 'made_up'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toContain('enabled_kinds_member_invalid');
  });
  it('rejects duplicate members', () => {
    const result = validateChatToolCatalogScopeInput({
      enabled_kinds: ['http', 'http'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toContain('enabled_kinds_duplicate');
  });
  it('accumulates multiple issues', () => {
    const result = validateChatToolCatalogScopeInput({
      enabled_kinds: ['http', 'http', 'bogus', 123],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('enabled_kinds_duplicate');
    expect(codes).toContain('enabled_kinds_member_invalid');
  });
  it('CHAT_TOOL_CATALOG_SCOPE_VALIDATION_ISSUE_CODES enumerates exactly 3 codes', () => {
    expect(CHAT_TOOL_CATALOG_SCOPE_VALIDATION_ISSUE_CODES).toEqual([
      'enabled_kinds_not_array',
      'enabled_kinds_member_invalid',
      'enabled_kinds_duplicate',
    ]);
  });
});

describe('D-137 W2.2 — rpc method + broadcast event registry membership', () => {
  it('CHAT_RPC_METHODS includes the two tool_catalog methods', () => {
    expect(CHAT_RPC_METHODS).toContain('chat.tool_catalog.get');
    expect(CHAT_RPC_METHODS).toContain('chat.tool_catalog.set');
  });
  it('SERVER_RPC_METHODS includes the two tool_catalog methods', () => {
    expect(SERVER_RPC_METHODS).toContain('chat.tool_catalog.get' as never);
    expect(SERVER_RPC_METHODS).toContain('chat.tool_catalog.set' as never);
  });
  it('CHAT_BROADCAST_EVENT_KINDS includes the scope_changed variant', () => {
    expect(CHAT_BROADCAST_EVENT_KINDS).toContain('chat.tool_catalog_scope_changed');
  });
});
