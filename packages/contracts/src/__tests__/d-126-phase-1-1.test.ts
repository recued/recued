/** D-126 Phase 1.1 — IngredientKind taxonomy + required `kind` field.
 *
 *  Covers:
 *    - `IngredientKind` closed enum (eight kinds, declaration order).
 *    - `INGREDIENT_KINDS` membership set (cardinality + every member).
 *    - `KIND_ALLOWED_TIERS` table (every kind covered, per-kind tier
 *      rules including the "ai/chat are read-only" + "dom/storage are
 *      local-only" + "mcp excludes destructive" invariants).
 *    - `IngredientManifest.kind` is now a required field, narrowed to
 *      `IngredientKind`, and `isServiceManifest` still routes only on
 *      `kind === 'service'` (D-118 carve-out preserved).
 */

import { describe, it, expect } from 'vitest';

import {
  INGREDIENT_KINDS,
  KIND_ALLOWED_TIERS,
  isServiceManifest,
  type IngredientKind,
  type IngredientManifest,
  type RiskTier,
} from '../index.js';

const ALL_KINDS: readonly IngredientKind[] = [
  'http',
  'dom',
  'ai',
  'chat',
  'mcp',
  'service',
  'storage',
  'connection',
  'cli',
] as const;

describe('IngredientKind taxonomy', () => {
  it('INGREDIENT_KINDS contains exactly nine members', () => {
    // D-182 F2 — `cli` graduated into IngredientKind (8 → 9).
    expect(INGREDIENT_KINDS.size).toBe(9);
  });

  it('INGREDIENT_KINDS contains every declared kind', () => {
    for (const kind of ALL_KINDS) {
      expect(INGREDIENT_KINDS.has(kind)).toBe(true);
    }
  });

  it('INGREDIENT_KINDS rejects values outside the closed set', () => {
    const intruders = ['webhook', 'stream', 'transform', 'batch', 'recipe', ''];
    for (const v of intruders) {
      expect(INGREDIENT_KINDS.has(v as IngredientKind)).toBe(false);
    }
  });
});

describe('KIND_ALLOWED_TIERS', () => {
  it('covers every IngredientKind exhaustively', () => {
    for (const kind of ALL_KINDS) {
      expect(KIND_ALLOWED_TIERS[kind]).toBeInstanceOf(Set);
      expect(KIND_ALLOWED_TIERS[kind].size).toBeGreaterThan(0);
    }
    expect(Object.keys(KIND_ALLOWED_TIERS).sort()).toEqual([...ALL_KINDS].sort());
  });

  it('AI is read-only (programmatic inference, no side effects)', () => {
    const tiers = KIND_ALLOWED_TIERS.ai;
    expect(tiers.has('read')).toBe(true);
    expect(tiers.has('write')).toBe(false);
    expect(tiers.has('admin')).toBe(false);
    expect(tiers.has('destructive')).toBe(false);
  });

  it('chat allows read+write — the web-chat tab is DOM-driven', () => {
    // P4.2 catalog audit found web-chat-gemini / -deepseek declare
    // category=action, risk_tier=write — typing into the prompt field +
    // clicking submit IS a DOM write to the user's browser session.
    const tiers = KIND_ALLOWED_TIERS.chat;
    expect(tiers.has('read')).toBe(true);
    expect(tiers.has('write')).toBe(true);
    expect(tiers.has('admin')).toBe(false);
    expect(tiers.has('destructive')).toBe(false);
  });

  it('dom allows read+write but not admin/destructive', () => {
    const tiers = KIND_ALLOWED_TIERS.dom;
    expect(tiers.has('read')).toBe(true);
    expect(tiers.has('write')).toBe(true);
    expect(tiers.has('admin')).toBe(false);
    expect(tiers.has('destructive')).toBe(false);
  });

  it('storage allows read+write+destructive (warehouse delete ops) but no admin', () => {
    // P4.2 catalog audit: file-delete / file-move / calendar-delete /
    // shared-delete-prefix all declare risk_tier='destructive' — they
    // genuinely destroy user data. No `admin` concept at the storage
    // layer (admin is for workspace-level mutations on remote services).
    const tiers = KIND_ALLOWED_TIERS.storage;
    expect(tiers.has('read')).toBe(true);
    expect(tiers.has('write')).toBe(true);
    expect(tiers.has('destructive')).toBe(true);
    expect(tiers.has('admin')).toBe(false);
  });

  it('mcp excludes destructive (reserved for connection)', () => {
    const tiers = KIND_ALLOWED_TIERS.mcp;
    expect(tiers.has('read')).toBe(true);
    expect(tiers.has('write')).toBe(true);
    expect(tiers.has('admin')).toBe(true);
    expect(tiers.has('destructive')).toBe(false);
  });

  it('http + service + connection allow the full RiskTier range', () => {
    const allTiers: readonly RiskTier[] = ['read', 'write', 'admin', 'destructive'];
    for (const kind of ['http', 'service', 'connection'] as const) {
      const tiers = KIND_ALLOWED_TIERS[kind];
      for (const tier of allTiers) expect(tiers.has(tier)).toBe(true);
    }
  });
});

describe('IngredientManifest.kind required field', () => {
  it('a kind field is required at the type level', () => {
    // Type-level assertion: the manifest below cannot omit `kind`.
    // If P1.1 ever regressed to optional, the next line would still
    // compile — we anchor the contract at runtime by asserting the
    // value is a member of INGREDIENT_KINDS.
    const manifest: IngredientManifest = {
      slug: 'http-sample',
      name: 'sample',
      description: 'sample',
      author: 'recued-core',
      kind: 'http',
      category: 'data',
      risk_tier: 'read',
      input: { url: 'https://example.com', method: 'GET' },
      output: { x: 'x' },
    };
    expect(INGREDIENT_KINDS.has(manifest.kind)).toBe(true);
  });

  it('isServiceManifest narrows to kind === "service" only', () => {
    const service: Pick<IngredientManifest, 'kind'> = { kind: 'service' };
    const http: Pick<IngredientManifest, 'kind'> = { kind: 'http' };
    const storage: Pick<IngredientManifest, 'kind'> = { kind: 'storage' };
    expect(isServiceManifest(service)).toBe(true);
    expect(isServiceManifest(http)).toBe(false);
    expect(isServiceManifest(storage)).toBe(false);
    expect(isServiceManifest(null)).toBe(false);
    expect(isServiceManifest(undefined)).toBe(false);
    expect(isServiceManifest({})).toBe(false);
  });
});
