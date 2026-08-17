/** D-137 P5 follow-on § A.9 — agent credential renderer
 *  substrate.
 *
 *  Acceptance:
 *    - CHAT_INBOUND_TOKEN_CONCURRENCY_COPY exhaustive over the
 *      `MCP_INBOUND_CONCURRENCY_LADDER` (3 / 5 / 10)
 *    - CHAT_INBOUND_TOKEN_KIND_COPY exhaustive over IngredientKind
 *    - inferChatInboundTokenToolKind maps T1 / T2 / T3 entries to the
 *      right kind (storage / requires_kinds[0] / mcp)
 *    - deriveChatInboundTokenKindMaster — `'all' | 'none' | 'mixed'`
 *      across the per-row grant flags
 *    - buildChatInboundTokenDetailModel — `'pending'` discriminator on
 *      missing snapshot; resolves with grouped rows + summary +
 *      defaults; rows excluded when grants map omits a tool (default-
 *      deny per substrate)
 *    - buildChatInboundTokenTableRows — pre-counted granted_count +
 *      catalog_count + chat_mode_offered chip
 *    - projectToggledChatInboundTokenTool — pure single-tool flip
 *    - projectToggledChatInboundTokenKind — kind-level master fan
 *    - projectDefaultChatInboundTokenGrants — calls into substrate's
 *      `buildDefaultMcpInboundTokenGrants` (T1+T3 reads true; T2 false)
 *    - reduceChatInboundTokenChanged — issue / update / revoke insert/
 *      replace; delete removes the row
 *    - buildChatInboundTokenIssuanceDefaults — pre-fills tier 5 +
 *      `now + DEFAULT_EXPIRY_MS` + null chat_mode + default grants
 */

import { describe, it, expect } from 'vitest';
import {
  MCP_INBOUND_CONCURRENCY_LADDER,
  MCP_INBOUND_TOKEN_DEFAULT_EXPIRY_MS,
  type IngredientKind,
  type McpInboundTokenRecord,
  type ToolEntry,
} from '@recued/contracts';
import {
  CHAT_INBOUND_TOKEN_CONCURRENCY_COPY,
  CHAT_INBOUND_TOKEN_KIND_COPY,
  buildChatInboundTokenConcurrencyOptions,
  buildChatInboundTokenDetailModel,
  buildChatInboundTokenIssuanceDefaults,
  buildChatInboundTokenTableRows,
  deriveChatInboundTokenKindMaster,
  inferChatInboundTokenToolKind,
  projectDefaultChatInboundTokenGrants,
  projectToggledChatInboundTokenKind,
  projectToggledChatInboundTokenTool,
  reduceChatInboundTokenChanged,
} from '../contracts/chat-inbound-tokens.js';

const baseToken = (
  overrides: Partial<McpInboundTokenRecord> = {},
): McpInboundTokenRecord => ({
  token_id: 'tok-id-aaaaaaaaaaaaaaaa',
  bearer_hash: 'a'.repeat(64),
  label: 'Test',
  created_at: 1_000,
  revoked_at: null,
  grants: { 'mail.search': true, 'recipe.run': false },
  concurrency_tier: 5,
  chat_mode: null,
  updated_at: 1_000,
  ...overrides,
});

const t1 = (name: string, classification: 'read' | 'write' | 'unknown' = 'read'): ToolEntry => ({
  name,
  tier: 1,
  description: `T1 ${name}`,
  arg_schema: {},
  topic_tags: [],
  classification,
  concurrency_safe: classification === 'read',
});

const t2 = (
  name: string,
  classification: 'read' | 'write' | 'unknown',
  requires_kinds: ReadonlyArray<IngredientKind>,
): ToolEntry => ({
  name,
  tier: 2,
  description: `T2 ${name}`,
  arg_schema: {},
  topic_tags: [],
  classification,
  concurrency_safe: false,
  requires_kinds,
});

const t3 = (
  name: string,
  classification: 'read' | 'write' | 'unknown',
): ToolEntry => ({
  name,
  tier: 3,
  description: `T3 ${name}`,
  arg_schema: {},
  topic_tags: [],
  classification,
  concurrency_safe: false,
});

describe('CHAT_INBOUND_TOKEN_CONCURRENCY_COPY exhaustive over the ladder', () => {
  it('covers every tier', () => {
    for (const tier of MCP_INBOUND_CONCURRENCY_LADDER) {
      expect(CHAT_INBOUND_TOKEN_CONCURRENCY_COPY[tier]).toBeDefined();
      expect(CHAT_INBOUND_TOKEN_CONCURRENCY_COPY[tier].label).toBeTruthy();
    }
  });
});

describe('CHAT_INBOUND_TOKEN_KIND_COPY exhaustive over IngredientKind', () => {
  it('covers every kind from the closed 8-kind list (D-126)', () => {
    const expected: ReadonlyArray<IngredientKind> = [
      'http',
      'dom',
      'ai',
      'chat',
      'mcp',
      'service',
      'storage',
      'connection',
    ];
    for (const k of expected) {
      expect(CHAT_INBOUND_TOKEN_KIND_COPY[k]).toBeDefined();
      expect(CHAT_INBOUND_TOKEN_KIND_COPY[k].label).toBeTruthy();
    }
  });

  it('also covers the D-171 legacy buckets (recued_native / recued_ingredient) + the D-182 raw-op bucket (recued_op)', () => {
    expect(CHAT_INBOUND_TOKEN_KIND_COPY.recued_native.label).toBeTruthy();
    expect(CHAT_INBOUND_TOKEN_KIND_COPY.recued_ingredient.label).toBeTruthy();
    expect(CHAT_INBOUND_TOKEN_KIND_COPY.recued_op.label).toBeTruthy();
  });
});

describe('inferChatInboundTokenToolKind', () => {
  it('maps T1 known names per the static table', () => {
    expect(inferChatInboundTokenToolKind(t1('contact.search'))).toBe('storage');
    expect(inferChatInboundTokenToolKind(t1('mail.search'))).toBe('storage');
    expect(inferChatInboundTokenToolKind(t1('calendar.search'))).toBe('storage');
    expect(inferChatInboundTokenToolKind(t1('memory.search'))).toBe('storage');
    expect(inferChatInboundTokenToolKind(t1('enrichment.search'))).toBe('storage');
    expect(inferChatInboundTokenToolKind(t1('deal.search'))).toBe('connection');
    expect(inferChatInboundTokenToolKind(t1('recipe.run', 'unknown'))).toBe('storage');
  });

  it('maps T2 by requires_kinds[0]', () => {
    expect(
      inferChatInboundTokenToolKind(t2('foo.bar', 'write', ['ai', 'storage'])),
    ).toBe('ai');
  });

  it('falls back to storage when T2 lacks requires_kinds', () => {
    expect(inferChatInboundTokenToolKind(t2('legacy', 'read', []))).toBe('storage');
  });

  it('always groups T3 under mcp', () => {
    expect(inferChatInboundTokenToolKind(t3('exa.search', 'read'))).toBe('mcp');
  });

  it('groups the D-171 legacy surface by name prefix, independent of tier', () => {
    // recued_* meta tools → the native bucket.
    expect(inferChatInboundTokenToolKind(t2('recued_listRecipes', 'read', []))).toBe(
      'recued_native',
    );
    expect(inferChatInboundTokenToolKind(t2('recued_runRecipe', 'unknown', []))).toBe(
      'recued_native',
    );
    // recued_ingredient_<slug> → the direct-ingredient bucket. The
    // `recued_ingredient_` prefix must win over the bare `recued_` prefix.
    expect(
      inferChatInboundTokenToolKind(t2('recued_ingredient_mail-send', 'write', [])),
    ).toBe('recued_ingredient');
    // Prefix wins over tier: even a (synthetic) T1-shaped recued_ entry groups
    // as native, never via the Tier-1 table.
    expect(inferChatInboundTokenToolKind(t1('recued_getAudit'))).toBe('recued_native');
  });

  it('groups D-182 raw catalog ops (recued_op_<opid>) into the recued_op bucket, not recued_native', () => {
    // recued_op_<publisher>.<pack>.<operation> → the raw-operation bucket.
    // The `recued_op_` prefix must win over the bare `recued_` prefix (else a
    // raw op would mislabel as a Recued server meta tool).
    expect(
      inferChatInboundTokenToolKind(
        t2('recued_op_recued-core.hubspot.deal.create', 'write', []),
      ),
    ).toBe('recued_op');
    expect(
      inferChatInboundTokenToolKind(
        t2('recued_op_recued-core.hubspot.contact.search', 'read', []),
      ),
    ).toBe('recued_op');
    // recued_op_ and recued_ingredient_ are distinct sub-prefixes — neither
    // bleeds into the other.
    expect(
      inferChatInboundTokenToolKind(t2('recued_ingredient_mail-send', 'write', [])),
    ).toBe('recued_ingredient');
  });
});

describe('deriveChatInboundTokenKindMaster', () => {
  it('returns none on empty group', () => {
    expect(deriveChatInboundTokenKindMaster([])).toBe('none');
  });

  it('returns all when every row granted', () => {
    expect(
      deriveChatInboundTokenKindMaster([
        { tool_name: 'a', tier: 1, classification: 'read', granted: true, default_grant: true, description: '' },
        { tool_name: 'b', tier: 1, classification: 'read', granted: true, default_grant: true, description: '' },
      ]),
    ).toBe('all');
  });

  it('returns none when zero rows granted', () => {
    expect(
      deriveChatInboundTokenKindMaster([
        { tool_name: 'a', tier: 1, classification: 'read', granted: false, default_grant: true, description: '' },
      ]),
    ).toBe('none');
  });

  it('returns mixed otherwise', () => {
    expect(
      deriveChatInboundTokenKindMaster([
        { tool_name: 'a', tier: 1, classification: 'read', granted: true, default_grant: true, description: '' },
        { tool_name: 'b', tier: 1, classification: 'read', granted: false, default_grant: true, description: '' },
      ]),
    ).toBe('mixed');
  });
});

describe('buildChatInboundTokenDetailModel', () => {
  it('returns pending on null token', () => {
    expect(
      buildChatInboundTokenDetailModel({ token: null, catalog: [], now: 0 }).kind,
    ).toBe('pending');
  });

  it('resolves with grouped rows + summary', () => {
    const catalog: ReadonlyArray<ToolEntry> = [
      t1('mail.search'),
      t1('recipe.run', 'unknown'),
      t3('exa.search', 'read'),
    ];
    const token = baseToken({
      grants: { 'mail.search': true, 'recipe.run': false, 'exa.search': true },
    });
    const model = buildChatInboundTokenDetailModel({ token, catalog, now: 1_000 });
    expect(model.kind).toBe('resolved');
    if (model.kind === 'resolved') {
      // Two groups: storage (mail.search + recipe.run) + mcp (exa.search).
      // Order matches the substrate's closed ordered-kinds list:
      // storage first, mcp second.
      expect(model.groups.map((g) => g.kind)).toEqual(['storage', 'mcp']);
      const storageGroup = model.groups.find((g) => g.kind === 'storage')!;
      expect(storageGroup.rows.map((r) => r.tool_name).sort()).toEqual([
        'mail.search',
        'recipe.run',
      ]);
      expect(storageGroup.master).toBe('mixed');
      const mcpGroup = model.groups.find((g) => g.kind === 'mcp')!;
      expect(mcpGroup.master).toBe('all');
      expect([...model.summary.allowed_read].sort()).toEqual([
        'exa.search',
        'mail.search',
      ]);
    }
  });

  it('groups the D-171 legacy surface into its own buckets, ordered last + default-off (D-171 slice-2c follow-on #1)', () => {
    const catalog: ReadonlyArray<ToolEntry> = [
      t1('mail.search'),
      t2('recued_dataTimeline', 'read', []),
      t2('recued_runRecipe', 'unknown', []),
      t2('recued_ingredient_mail-send', 'write', []),
    ];
    // Door default-deny: only the registry read is granted (its substrate
    // default); the legacy entries carry no grant.
    const token = baseToken({ grants: { 'mail.search': true } });
    const model = buildChatInboundTokenDetailModel({ token, catalog, now: 1_000 });
    expect(model.kind).toBe('resolved');
    if (model.kind === 'resolved') {
      // The two legacy buckets render AFTER the registry kinds.
      expect(model.groups.map((g) => g.kind)).toEqual([
        'storage',
        'recued_native',
        'recued_ingredient',
      ]);
      const native = model.groups.find((g) => g.kind === 'recued_native')!;
      expect(native.rows.map((r) => r.tool_name).sort()).toEqual([
        'recued_dataTimeline',
        'recued_runRecipe',
      ]);
      // Default-deny: nothing legacy is granted, so the bucket master is none.
      expect(native.master).toBe('none');
      expect(native.rows.every((r) => !r.granted)).toBe(true);
      const ingredients = model.groups.find((g) => g.kind === 'recued_ingredient')!;
      expect(ingredients.rows.map((r) => r.tool_name)).toEqual([
        'recued_ingredient_mail-send',
      ]);
      expect(ingredients.master).toBe('none');
      // The write-classified direct ingredient shows under denied_write, not read.
      expect(model.summary.denied_write).toContain('recued_ingredient_mail-send');
    }
  });

  it('groups D-182 raw catalog ops into their own recued_op bucket, ordered last, with read default-on / write default-off (D-182 §8)', () => {
    const catalog: ReadonlyArray<ToolEntry> = [
      t1('mail.search'),
      t2('recued_op_recued-core.hubspot.contact.search', 'read', []),
      t2('recued_op_recued-core.hubspot.deal.create', 'write', []),
    ];
    // The door has no explicit raw-op grants yet — `granted` is default-deny;
    // `default_grant` carries the substrate's smart default we assert below.
    const token = baseToken({ grants: { 'mail.search': true } });
    const model = buildChatInboundTokenDetailModel({ token, catalog, now: 1_000 });
    expect(model.kind).toBe('resolved');
    if (model.kind === 'resolved') {
      // The raw-op bucket renders AFTER the registry kinds (storage here).
      expect(model.groups.map((g) => g.kind)).toEqual(['storage', 'recued_op']);
      const rawOps = model.groups.find((g) => g.kind === 'recued_op')!;
      expect(rawOps.rows.map((r) => r.tool_name).sort()).toEqual([
        'recued_op_recued-core.hubspot.contact.search',
        'recued_op_recued-core.hubspot.deal.create',
      ]);
      // Read defaults on, write defaults off (recipe-preferred) — the
      // `recued_op_` special-case in `buildDefaultMcpInboundTokenGrants`.
      const read = rawOps.rows.find((r) => r.classification === 'read')!;
      const write = rawOps.rows.find((r) => r.classification === 'write')!;
      expect(read.default_grant).toBe(true);
      expect(write.default_grant).toBe(false);
      // No explicit grant persisted yet ⇒ live state is default-deny for both,
      // so the bucket master is none until the owner widens it.
      expect(rawOps.master).toBe('none');
      expect(rawOps.rows.every((r) => !r.granted)).toBe(true);
    }
  });

  it('pins the full synthetic-bucket render order: registry kinds, then recued_native, recued_ingredient, recued_op last', () => {
    // One tool per synthetic bucket (+ a registry storage kind) so the test
    // catches any reordering of `orderedKinds` — the per-bucket tests above
    // each see only a subset, so this is the authoritative full-order pin.
    const catalog: ReadonlyArray<ToolEntry> = [
      t1('mail.search'),
      t2('recued_dataTimeline', 'read', []),
      t2('recued_ingredient_mail-send', 'write', []),
      t2('recued_op_recued-core.hubspot.contact.search', 'read', []),
    ];
    const token = baseToken({ grants: { 'mail.search': true } });
    const model = buildChatInboundTokenDetailModel({ token, catalog, now: 1_000 });
    expect(model.kind).toBe('resolved');
    if (model.kind === 'resolved') {
      expect(model.groups.map((g) => g.kind)).toEqual([
        'storage',
        'recued_native',
        'recued_ingredient',
        'recued_op',
      ]);
    }
  });

  it('projectToggledChatInboundTokenKind toggles a whole legacy bucket', () => {
    const catalog: ReadonlyArray<ToolEntry> = [
      t2('recued_runRecipe', 'unknown', []),
      t2('recued_dataTimeline', 'read', []),
      t1('mail.search'),
    ];
    const next = projectToggledChatInboundTokenKind({
      current: {},
      catalog,
      kind: 'recued_native',
      next_granted: true,
    });
    // Both native meta tools flip on; the registry storage tool is untouched.
    expect(next.recued_runRecipe).toBe(true);
    expect(next.recued_dataTimeline).toBe(true);
    expect(next['mail.search']).toBeUndefined();
  });

  it('granted reflects substrate authorisation predicate (revoked → all denied)', () => {
    const catalog: ReadonlyArray<ToolEntry> = [t1('mail.search')];
    const revoked = baseToken({
      grants: { 'mail.search': true },
      revoked_at: 500,
    });
    const model = buildChatInboundTokenDetailModel({
      token: revoked,
      catalog,
      now: 1_000,
    });
    if (model.kind === 'resolved') {
      const row = model.groups[0].rows[0];
      expect(row.granted).toBe(false);
      expect(model.active).toBe(false);
    }
  });
});

describe('buildChatInboundTokenTableRows', () => {
  it('counts granted overlap with the live catalog', () => {
    const catalog: ReadonlyArray<ToolEntry> = [
      t1('mail.search'),
      t1('contact.search'),
      t1('recipe.run', 'unknown'),
    ];
    const tokens: ReadonlyArray<McpInboundTokenRecord> = [
      baseToken({
        token_id: 'a'.repeat(16),
        label: 'Mary',
        peer_handle: 'mary',
        grants: { 'mail.search': true, 'contact.search': true, 'recipe.run': false },
      }),
      baseToken({
        token_id: 'b'.repeat(16),
        label: 'Carol',
        // Uninstalled tool grant — should not count toward the
        // catalog-overlap stat.
        grants: { 'gone.tool': true, 'mail.search': true },
        chat_mode: { offered: true },
      }),
    ];
    const rows = buildChatInboundTokenTableRows({ tokens, catalog, now: 1_000 });
    expect(rows).toHaveLength(2);
    expect(rows[0].label).toBe('Mary');
    expect(rows[0].granted_count).toBe(2);
    expect(rows[0].catalog_count).toBe(3);
    expect(rows[0].chat_mode_offered).toBe(false);
    expect(rows[1].label).toBe('Carol');
    expect(rows[1].granted_count).toBe(1); // gone.tool excluded
    expect(rows[1].chat_mode_offered).toBe(true);
  });
});

describe('projectToggledChatInboundTokenTool', () => {
  it('flips the tool entry, preserves siblings', () => {
    const next = projectToggledChatInboundTokenTool({
      current: { 'mail.search': true, 'recipe.run': false },
      tool_name: 'mail.search',
      next_granted: false,
    });
    expect(next).toEqual({ 'mail.search': false, 'recipe.run': false });
  });
});

describe('projectToggledChatInboundTokenKind', () => {
  it('fans the toggle across every catalog entry within the kind', () => {
    const catalog: ReadonlyArray<ToolEntry> = [
      t1('mail.search'),
      t1('contact.search'),
      t3('exa.search', 'read'),
    ];
    const current = { 'mail.search': false, 'contact.search': false, 'exa.search': false };
    const next = projectToggledChatInboundTokenKind({
      current,
      catalog,
      kind: 'storage',
      next_granted: true,
    });
    expect(next['mail.search']).toBe(true);
    expect(next['contact.search']).toBe(true);
    // T3 untouched since it groups under 'mcp', not 'storage'.
    expect(next['exa.search']).toBe(false);
  });

  it('leaves stale grants on uninstalled tools alone', () => {
    const catalog: ReadonlyArray<ToolEntry> = [t1('mail.search')];
    const current = { 'mail.search': true, 'gone.tool': true };
    const next = projectToggledChatInboundTokenKind({
      current,
      catalog,
      kind: 'storage',
      next_granted: false,
    });
    expect(next['mail.search']).toBe(false);
    expect(next['gone.tool']).toBe(true); // untouched
  });
});

describe('projectDefaultChatInboundTokenGrants', () => {
  it('matches the substrate default-deny posture (T1+T3 reads true; T2 false)', () => {
    const catalog: ReadonlyArray<ToolEntry> = [
      t1('mail.search'),
      t1('recipe.run', 'unknown'),
      t2('publisher.recipe', 'read', ['storage']),
      t3('exa.search', 'read'),
      t3('exa.write', 'write'),
    ];
    const next = projectDefaultChatInboundTokenGrants({ catalog });
    expect(next['mail.search']).toBe(true);
    expect(next['recipe.run']).toBe(false); // unknown classification
    expect(next['publisher.recipe']).toBe(false); // T2 always false
    expect(next['exa.search']).toBe(true);
    expect(next['exa.write']).toBe(false);
  });
});

describe('reduceChatInboundTokenChanged', () => {
  it('inserts a brand-new issued row at the head', () => {
    const current = [baseToken({ token_id: 'a'.repeat(16), label: 'Mary' })];
    const next = reduceChatInboundTokenChanged({
      current,
      event: {
        op: 'issue',
        token_id: 'b'.repeat(16),
        record: baseToken({ token_id: 'b'.repeat(16), label: 'Carol' }),
      },
    });
    expect(next).toHaveLength(2);
    expect(next[0].token_id).toBe('b'.repeat(16));
    expect(next[1].token_id).toBe('a'.repeat(16));
  });

  it('replaces the row on update_grants / revoke', () => {
    const current = [baseToken({ token_id: 'a'.repeat(16), grants: {} })];
    const next = reduceChatInboundTokenChanged({
      current,
      event: {
        op: 'update_grants',
        token_id: 'a'.repeat(16),
        record: baseToken({
          token_id: 'a'.repeat(16),
          grants: { 'mail.search': true },
        }),
      },
    });
    expect(next[0].grants['mail.search']).toBe(true);
  });

  it('removes the row on delete', () => {
    const current = [baseToken({ token_id: 'a'.repeat(16) })];
    const next = reduceChatInboundTokenChanged({
      current,
      event: { op: 'delete', token_id: 'a'.repeat(16), record: null },
    });
    expect(next).toHaveLength(0);
  });

  it('ignores records with mismatched / missing token_id', () => {
    const current = [baseToken({ token_id: 'a'.repeat(16) })];
    const next = reduceChatInboundTokenChanged({
      current,
      event: {
        op: 'update_grants',
        token_id: 'a'.repeat(16),
        record: { token_id: 0 },
      },
    });
    // Wire-shape rejection — no insert / replace.
    expect(next).toEqual(current);
  });
});

describe('buildChatInboundTokenIssuanceDefaults', () => {
  it('pre-fills tier 5 + 1y expiry + null chat_mode + substrate defaults', () => {
    const catalog: ReadonlyArray<ToolEntry> = [
      t1('mail.search'),
      t2('publisher.recipe', 'read', ['storage']),
    ];
    const defaults = buildChatInboundTokenIssuanceDefaults({
      catalog,
      now: 10_000,
    });
    expect(defaults.concurrency_tier).toBe(5);
    // ⚠ § A.9's 1-year "safety net against abandoned tokens" survives — as a
    // CONTRACT limit, because the token no longer has a lifetime of its own.
    expect(defaults.contract_limits.expiry_at)
      .toBe(10_000 + MCP_INBOUND_TOKEN_DEFAULT_EXPIRY_MS);
    expect(defaults.chat_mode).toBeNull();
    expect(defaults.grants['mail.search']).toBe(true);
    expect(defaults.grants['publisher.recipe']).toBe(false);
  });
});

describe('buildChatInboundTokenConcurrencyOptions', () => {
  it('emits one option per ladder entry with copy populated', () => {
    const opts = buildChatInboundTokenConcurrencyOptions();
    expect(opts.map((o) => o.value)).toEqual([3, 5, 10]);
    for (const o of opts) {
      expect(o.label).toBeTruthy();
      expect(o.description).toBeTruthy();
    }
  });
});
