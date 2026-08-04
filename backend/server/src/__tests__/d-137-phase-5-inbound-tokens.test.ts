/** D-137 P5 § A.9 — Inbound MCP token grants substrate.
 *
 *  Substrate-level acceptance for:
 *    - `buildDefaultMcpInboundTokenGrants` — read-only checked, write/
 *      recipe/unknown unchecked at issuance (spec § A.9 default-deny
 *      posture).
 *    - `isMcpInboundTokenActive` — `revoked_at !== null` or `expires_at`
 *      past `now` → false; `expires_at: 0` sentinel → always active.
 *    - `isMcpInboundTokenToolAuthorized` — active + grants[tool] === true.
 *      Missing keys resolve to `false` (spec § A.9 new-tool default-off).
 *    - `summarizeMcpInboundTokenCapability` — six-bucket projection for
 *      the "This token can / cannot" UI summary.
 *    - `validateMcpInboundTokenInput` — closed-list issue codes for
 *      malformed shapes.
 *    - SQLite store — schema install, CRUD round-trip, constant-time
 *      bearer verifier, revoke + expiry gates, hard-delete.
 *
 *  Acceptance maps directly to spec § P5 acceptance bullets:
 *    - "Per-token permission checklist" — store CRUD round-trip.
 *    - "Read-only default" — buildDefaultMcpInboundTokenGrants posture.
 *    - "Token capability summary" — summarizeMcpInboundTokenCapability
 *      buckets.
 *    - "New-tool default-off" — isMcpInboundTokenToolAuthorized returns
 *      false for tools not in grants.
 *    - "Token expiry" — isMcpInboundTokenActive false past `expires_at`.
 *    - "Revoked peer token" — isMcpInboundTokenActive false after
 *      `revokeToken`. */

import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  MCP_INBOUND_CONCURRENCY_LADDER,
  MCP_INBOUND_CONCURRENCY_TIER_SET,
  MCP_INBOUND_TOKEN_DEFAULT_EXPIRY_MS,
  MCP_INBOUND_TOKEN_PREFIX,
  MCP_INBOUND_TOKEN_VALIDATION_ISSUE_CODES,
  buildDefaultMcpInboundTokenGrants,
  isMcpInboundConcurrencyTier,
  isMcpInboundTokenActive,
  isMcpInboundTokenToolAuthorized,
  summarizeMcpInboundTokenCapability,
  validateMcpInboundTokenInput,
  validateInboundTokenChatModeUpdate,
  type McpInboundTokenRecord,
  type ToolEntry,
  type ValidatedMcpInboundTokenInput,
} from '@recued/contracts';
import {
  createChatInboundTokenStore,
  deriveMcpInboundTokenId,
  ensureChatInboundTokenSchema,
  generateMcpInboundTokenBearer,
  hashMcpInboundTokenBearer,
  PEER_HANDLE_CONFLICT_PREFIX,
} from '../storage/chat-inbound-token-store.js';

const tier1Read = (name: string): ToolEntry => ({
  name,
  tier: 1,
  description: 'desc',
  arg_schema: { type: 'object' },
  topic_tags: [],
  classification: 'read',
  concurrency_safe: true,
});

const tier1Unknown = (name: string): ToolEntry => ({
  name,
  tier: 1,
  description: 'desc',
  arg_schema: { type: 'object' },
  topic_tags: [],
  classification: 'unknown',
  concurrency_safe: false,
});

const tier2Recipe = (
  name: string,
  classification: 'read' | 'write' | 'unknown' = 'read',
): ToolEntry => ({
  name,
  tier: 2,
  description: 'recipe',
  arg_schema: { type: 'object' },
  topic_tags: [],
  classification,
  concurrency_safe: false,
});

const tier3Read = (name: string): ToolEntry => ({
  name,
  tier: 3,
  description: 'mcp tool',
  arg_schema: { type: 'object' },
  topic_tags: [],
  classification: 'read',
  concurrency_safe: false,
});

const tier3Write = (name: string): ToolEntry => ({
  name,
  tier: 3,
  description: 'mcp tool',
  arg_schema: { type: 'object' },
  topic_tags: [],
  classification: 'write',
  concurrency_safe: false,
});

describe('D-137 P5 — buildDefaultMcpInboundTokenGrants', () => {
  it('defaults Tier 1 read primitives to true', () => {
    const catalog: ToolEntry[] = [
      tier1Read('contact.search'),
      tier1Read('mail.search'),
      tier1Read('calendar.search'),
    ];
    const grants = buildDefaultMcpInboundTokenGrants(catalog);
    expect(grants['contact.search']).toBe(true);
    expect(grants['mail.search']).toBe(true);
    expect(grants['calendar.search']).toBe(true);
  });

  it('defaults Tier 3 read tools to true', () => {
    const catalog: ToolEntry[] = [tier3Read('exa.search')];
    const grants = buildDefaultMcpInboundTokenGrants(catalog);
    expect(grants['exa.search']).toBe(true);
  });

  it('defaults Tier 3 write tools to false', () => {
    const catalog: ToolEntry[] = [tier3Write('exa.index_url')];
    const grants = buildDefaultMcpInboundTokenGrants(catalog);
    expect(grants['exa.index_url']).toBe(false);
  });

  it('defaults Tier 1 unknown (recipe.run) to false', () => {
    const catalog: ToolEntry[] = [tier1Unknown('recipe.run')];
    const grants = buildDefaultMcpInboundTokenGrants(catalog);
    expect(grants['recipe.run']).toBe(false);
  });

  it('defaults ALL Tier 2 entries to false regardless of classification', () => {
    // Spec § A.9: "Recipe tools: unchecked by default — recipe execution
    // is potentially write-equivalent." The substrate enforces tier === 2
    // ⇒ false irrespective of any per-recipe classification hint.
    const catalog: ToolEntry[] = [
      tier2Recipe('alice/daily-digest', 'read'),
      tier2Recipe('alice/send-update', 'write'),
      tier2Recipe('alice/cleanup', 'unknown'),
    ];
    const grants = buildDefaultMcpInboundTokenGrants(catalog);
    expect(grants['alice/daily-digest']).toBe(false);
    expect(grants['alice/send-update']).toBe(false);
    expect(grants['alice/cleanup']).toBe(false);
  });

  it('produces a deterministic shape across catalog orderings', () => {
    const order1: ToolEntry[] = [
      tier1Read('contact.search'),
      tier3Read('exa.search'),
      tier1Unknown('recipe.run'),
    ];
    const order2: ToolEntry[] = [
      tier1Unknown('recipe.run'),
      tier3Read('exa.search'),
      tier1Read('contact.search'),
    ];
    const g1 = buildDefaultMcpInboundTokenGrants(order1);
    const g2 = buildDefaultMcpInboundTokenGrants(order2);
    expect(Object.keys(g1).sort()).toEqual(Object.keys(g2).sort());
    for (const k of Object.keys(g1)) {
      expect(g1[k]).toBe(g2[k]);
    }
  });
});

describe('D-137 P5 — isMcpInboundTokenActive', () => {
  const baseRecord = (
    overrides: Partial<McpInboundTokenRecord> = {},
  ): McpInboundTokenRecord => ({
    token_id: 'abcd1234abcd1234',
    bearer_hash: 'a'.repeat(64),
    label: 'mary',
    created_at: 1_000,
    expires_at: 100_000,
    revoked_at: null,
    grants: {},
    concurrency_tier: 3,
    chat_mode: null,
    updated_at: 1_000,
    ...overrides,
  });

  it('returns true for an active token within its expiry window', () => {
    expect(isMcpInboundTokenActive(baseRecord({ expires_at: 50_000 }), 10_000)).toBe(true);
  });

  it('returns false when revoked_at is set', () => {
    expect(isMcpInboundTokenActive(baseRecord({ revoked_at: 5_000 }), 10_000)).toBe(false);
  });

  it('returns false past the expiry window', () => {
    expect(isMcpInboundTokenActive(baseRecord({ expires_at: 100 }), 10_000)).toBe(false);
  });

  it('treats expires_at: 0 as the substrate "never expires" sentinel', () => {
    expect(isMcpInboundTokenActive(baseRecord({ expires_at: 0 }), Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('respects revocation even when expires_at: 0 sentinel applies', () => {
    expect(isMcpInboundTokenActive(
      baseRecord({ expires_at: 0, revoked_at: 5_000 }),
      10_000,
    )).toBe(false);
  });

  it('matches the boundary case (expires_at === now → expired)', () => {
    // The predicate uses `expires_at > now` ⇒ expires_at === now means
    // the window just closed. UX surfaces "expired" on boundary.
    expect(isMcpInboundTokenActive(baseRecord({ expires_at: 10_000 }), 10_000)).toBe(false);
  });
});

describe('D-137 P5 — isMcpInboundTokenToolAuthorized', () => {
  const record = (
    grants: Record<string, boolean>,
    overrides: Partial<McpInboundTokenRecord> = {},
  ): McpInboundTokenRecord => ({
    token_id: 'abcd1234abcd1234',
    bearer_hash: 'a'.repeat(64),
    label: 'mary',
    created_at: 1_000,
    expires_at: 100_000,
    revoked_at: null,
    grants,
    concurrency_tier: 3,
    chat_mode: null,
    updated_at: 1_000,
    ...overrides,
  });

  it('returns true when the tool is granted on an active token', () => {
    const r = record({ 'contact.search': true });
    expect(isMcpInboundTokenToolAuthorized(r, 'contact.search', 50_000)).toBe(true);
  });

  it('returns false when grants[tool] === false', () => {
    const r = record({ 'mail.send': false });
    expect(isMcpInboundTokenToolAuthorized(r, 'mail.send', 50_000)).toBe(false);
  });

  it('returns false for a tool not present in grants (new-tool default-off)', () => {
    // Spec § A.9: "when Bob's MCP server gains a new tool in a future
    // release, existing tokens default to off for that tool (explicit
    // opt-in required)."
    const r = record({ 'contact.search': true });
    expect(isMcpInboundTokenToolAuthorized(r, 'future.new_primitive', 50_000)).toBe(false);
  });

  it('returns false when the token is revoked, even with grant=true', () => {
    const r = record({ 'contact.search': true }, { revoked_at: 1_500 });
    expect(isMcpInboundTokenToolAuthorized(r, 'contact.search', 50_000)).toBe(false);
  });

  it('returns false when the token is expired, even with grant=true', () => {
    const r = record({ 'contact.search': true }, { expires_at: 100 });
    expect(isMcpInboundTokenToolAuthorized(r, 'contact.search', 50_000)).toBe(false);
  });
});

describe('D-137 P5 — summarizeMcpInboundTokenCapability', () => {
  it('buckets every catalog entry by (granted? × classification)', () => {
    const catalog: ToolEntry[] = [
      tier1Read('contact.search'),
      tier1Read('mail.search'),
      tier3Read('exa.search'),
      tier3Write('exa.index_url'),
      tier1Unknown('recipe.run'),
      tier2Recipe('alice/digest', 'read'),
    ];
    const grants: Record<string, boolean> = {
      'contact.search': true,
      'mail.search': true,
      'exa.search': true,
      'exa.index_url': false,
      'recipe.run': false,
      'alice/digest': false,
    };
    const summary = summarizeMcpInboundTokenCapability(grants, catalog);
    expect(summary.allowed_read).toEqual(['contact.search', 'mail.search', 'exa.search']);
    expect(summary.allowed_write).toEqual([]);
    expect(summary.allowed_unknown).toEqual([]);
    expect(summary.denied_read).toEqual(['alice/digest']);
    expect(summary.denied_write).toEqual(['exa.index_url']);
    expect(summary.denied_unknown).toEqual(['recipe.run']);
  });

  it('ignores grant keys not present in the live catalog', () => {
    // Stale grant entries (e.g., for a recipe Mary uninstalled) don't
    // leak into the summary — the bucket tracks the live catalog only.
    const catalog: ToolEntry[] = [tier1Read('contact.search')];
    const grants: Record<string, boolean> = {
      'contact.search': true,
      'ghost.tool': true,
    };
    const summary = summarizeMcpInboundTokenCapability(grants, catalog);
    expect(summary.allowed_read).toEqual(['contact.search']);
    expect(summary.allowed_write).toEqual([]);
    expect(summary.denied_read).toEqual([]);
    expect(summary.denied_write).toEqual([]);
    expect(summary.denied_unknown).toEqual([]);
  });

  it('treats missing grant keys as denied (matches the auth predicate)', () => {
    const catalog: ToolEntry[] = [
      tier1Read('contact.search'),
      tier3Write('exa.index_url'),
    ];
    const summary = summarizeMcpInboundTokenCapability({}, catalog);
    expect(summary.allowed_read).toEqual([]);
    expect(summary.denied_read).toEqual(['contact.search']);
    expect(summary.denied_write).toEqual(['exa.index_url']);
  });
});

describe('D-137 P5 — validateMcpInboundTokenInput', () => {
  const validInput = (
    overrides: Partial<Record<string, unknown>> = {},
  ): Record<string, unknown> => ({
    label: 'mary',
    grants: { 'contact.search': true },
    concurrency_tier: 3,
    expires_at: 0,
    chat_mode: null,
    ...overrides,
  });

  it('accepts a valid issuance payload', () => {
    const r = validateMcpInboundTokenInput(validInput());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.label).toBe('mary');
      expect(r.value.grants).toEqual({ 'contact.search': true });
      expect(r.value.concurrency_tier).toBe(3);
      expect(r.value.expires_at).toBe(0);
      expect(r.value.chat_mode).toBeNull();
    }
  });

  it('rejects non-object input', () => {
    const r = validateMcpInboundTokenInput('not an object');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.code).toBe('input_not_object');
  });

  it('rejects an empty label', () => {
    const r = validateMcpInboundTokenInput(validInput({ label: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.code === 'label_invalid')).toBe(true);
  });

  it('rejects an off-list concurrency_tier', () => {
    const r = validateMcpInboundTokenInput(validInput({ concurrency_tier: 7 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.code === 'concurrency_tier_invalid')).toBe(true);
  });

  it('accepts each ladder concurrency tier (3 / 5 / 10)', () => {
    for (const tier of MCP_INBOUND_CONCURRENCY_LADDER) {
      const r = validateMcpInboundTokenInput(validInput({ concurrency_tier: tier }));
      expect(r.ok).toBe(true);
    }
  });

  it('rejects a negative expires_at', () => {
    const r = validateMcpInboundTokenInput(validInput({ expires_at: -1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.code === 'expires_at_invalid')).toBe(true);
  });

  it('rejects a non-integer expires_at', () => {
    const r = validateMcpInboundTokenInput(validInput({ expires_at: 1.5 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.code === 'expires_at_invalid')).toBe(true);
  });

  it('rejects non-boolean grants values', () => {
    const r = validateMcpInboundTokenInput(validInput({
      grants: { 'contact.search': 'yes' as unknown as boolean },
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.code === 'grants_value_invalid')).toBe(true);
  });

  it('rejects empty grants keys', () => {
    const r = validateMcpInboundTokenInput(validInput({ grants: { '': true } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.code === 'grants_key_invalid')).toBe(true);
  });

  it('accepts a valid chat_mode object', () => {
    const r = validateMcpInboundTokenInput(validInput({
      chat_mode: { offered: true, session_cap: { per_day: 5, concurrent: 2 } },
    }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.chat_mode).toEqual({
        offered: true,
        session_cap: { per_day: 5, concurrent: 2 },
      });
    }
  });

  it('rejects malformed chat_mode shape', () => {
    const r = validateMcpInboundTokenInput(validInput({ chat_mode: 'on' as unknown as null }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.code === 'chat_mode_shape_invalid')).toBe(true);
  });

  it('rejects chat_mode without boolean offered', () => {
    const r = validateMcpInboundTokenInput(validInput({
      chat_mode: { offered: 'yes' } as unknown as null,
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.code === 'chat_mode_offered_invalid')).toBe(true);
  });

  it('rejects chat_mode.session_cap with negative per_day', () => {
    const r = validateMcpInboundTokenInput(validInput({
      chat_mode: { offered: true, session_cap: { per_day: -1, concurrent: 2 } } as unknown as null,
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.code === 'chat_mode_session_cap_per_day_invalid')).toBe(true);
  });

  it('Codex review P3 fold — exact closed-list ratchet on validation issue codes', () => {
    // Pre-fold: this only checked `length > 0`, which would silently
    // accept accidental additions / removals. The exact list pins
    // the closed substrate.
    expect([...MCP_INBOUND_TOKEN_VALIDATION_ISSUE_CODES]).toEqual([
      'input_not_object',
      'label_invalid',
      'peer_handle_invalid',
      'grants_shape_invalid',
      'grants_key_invalid',
      'grants_value_invalid',
      'concurrency_tier_invalid',
      'expires_at_invalid',
      'chat_mode_shape_invalid',
      'chat_mode_offered_invalid',
      'chat_mode_session_cap_shape_invalid',
      'chat_mode_session_cap_per_day_invalid',
      'chat_mode_session_cap_concurrent_invalid',
      // D-166 P2 — token↔contract binding issuance field.
      'contract_id_invalid',
    ]);
    expect(MCP_INBOUND_TOKEN_VALIDATION_ISSUE_CODES.length).toBe(14);
  });
});

describe('D-171 slice 2b — validateInboundTokenChatModeUpdate', () => {
  it('returns present:false when chat_mode is absent (preserve-on-absent)', () => {
    const r = validateInboundTokenChatModeUpdate({ token_id: 't', grants: {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.present).toBe(false);
  });

  it('returns present:true + null when chat_mode is explicit null (clear)', () => {
    const r = validateInboundTokenChatModeUpdate({ chat_mode: null });
    expect(r.ok).toBe(true);
    if (r.ok && r.present) expect(r.chat_mode).toBeNull();
    // Discriminant narrowing sanity: present must be true here.
    if (r.ok) expect(r.present).toBe(true);
  });

  it('accepts { offered: true } without a session_cap', () => {
    const r = validateInboundTokenChatModeUpdate({ chat_mode: { offered: true } });
    expect(r.ok).toBe(true);
    if (r.ok && r.present) expect(r.chat_mode).toEqual({ offered: true });
  });

  it('accepts { offered: false }', () => {
    const r = validateInboundTokenChatModeUpdate({ chat_mode: { offered: false } });
    expect(r.ok).toBe(true);
    if (r.ok && r.present) expect(r.chat_mode).toEqual({ offered: false });
  });

  it('accepts a valid session_cap and round-trips it', () => {
    const r = validateInboundTokenChatModeUpdate({
      chat_mode: { offered: true, session_cap: { per_day: 5, concurrent: 2 } },
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.present) {
      expect(r.chat_mode).toEqual({
        offered: true,
        session_cap: { per_day: 5, concurrent: 2 },
      });
    }
  });

  it('rejects a non-object / non-null chat_mode', () => {
    const r = validateInboundTokenChatModeUpdate({ chat_mode: 'on' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.code === 'chat_mode_shape_invalid')).toBe(true);
  });

  it('rejects a non-boolean offered', () => {
    const r = validateInboundTokenChatModeUpdate({ chat_mode: { offered: 'yes' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.code === 'chat_mode_offered_invalid')).toBe(true);
  });

  it('rejects a negative session_cap.per_day', () => {
    const r = validateInboundTokenChatModeUpdate({
      chat_mode: { offered: true, session_cap: { per_day: -1, concurrent: 2 } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.code === 'chat_mode_session_cap_per_day_invalid')).toBe(true);
    }
  });

  it('rejects a non-integer session_cap.concurrent', () => {
    const r = validateInboundTokenChatModeUpdate({
      chat_mode: { offered: true, session_cap: { per_day: 5, concurrent: 1.5 } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.code === 'chat_mode_session_cap_concurrent_invalid')).toBe(true);
    }
  });

  it('rejects a non-object session_cap', () => {
    const r = validateInboundTokenChatModeUpdate({
      chat_mode: { offered: true, session_cap: 'cap' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.code === 'chat_mode_session_cap_shape_invalid')).toBe(true);
    }
  });

  it('treats a present-but-empty session_cap as no cap', () => {
    const r = validateInboundTokenChatModeUpdate({
      chat_mode: { offered: true, session_cap: null },
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.present) expect(r.chat_mode).toEqual({ offered: true });
  });
});

describe('D-137 P5 — token bearer helpers', () => {
  it('generates a bearer with the documented prefix + base64url body', () => {
    const bearer = generateMcpInboundTokenBearer();
    expect(bearer.startsWith(MCP_INBOUND_TOKEN_PREFIX)).toBe(true);
    const body = bearer.slice(MCP_INBOUND_TOKEN_PREFIX.length);
    // base64url alphabet only — no `+` / `/` / `=` padding.
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates distinct bearers across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 16; i++) {
      seen.add(generateMcpInboundTokenBearer());
    }
    expect(seen.size).toBe(16);
  });

  it('derives a 16-hex token_id from the bearer plaintext', () => {
    const id = deriveMcpInboundTokenId('recued_test');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    // Determinism: same bearer → same id.
    expect(deriveMcpInboundTokenId('recued_test')).toBe(id);
  });

  it('hashes the bearer into a 64-hex sha256 digest', () => {
    const h = hashMcpInboundTokenBearer('recued_test');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // The 16-hex token_id is the prefix of the full digest.
    expect(deriveMcpInboundTokenId('recued_test')).toBe(h.slice(0, 16));
  });
});

describe('D-137 P5 — ChatInboundTokenStore', () => {
  const newDb = () => {
    const db = new Database(':memory:');
    ensureChatInboundTokenSchema(db);
    return db;
  };

  const validValue = (
    overrides: Partial<ValidatedMcpInboundTokenInput> = {},
  ): ValidatedMcpInboundTokenInput => ({
    label: 'mary',
    grants: { 'contact.search': true, 'mail.search': true },
    concurrency_tier: 3,
    expires_at: 0,
    chat_mode: null,
    ...overrides,
  });

  it('issues a token and returns the bearer plaintext exactly once', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    const issued = store.issueToken({
      value: validValue(),
      now: 1_000,
    });
    expect(issued.bearer_plaintext.startsWith(MCP_INBOUND_TOKEN_PREFIX)).toBe(true);
    expect(issued.record.token_id).toMatch(/^[0-9a-f]{16}$/);
    expect(issued.record.bearer_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.record.created_at).toBe(1_000);
    expect(issued.record.expires_at).toBe(0);
    expect(issued.record.revoked_at).toBeNull();
    expect(issued.record.grants).toEqual({
      'contact.search': true,
      'mail.search': true,
    });
    // Subsequent reads via the store never re-surface the plaintext.
    const fetched = store.getTokenById(issued.record.token_id);
    expect(fetched).not.toBeNull();
    expect(fetched).not.toHaveProperty('bearer_plaintext');
  });

  it('round-trips a peer_handle when supplied', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    const issued = store.issueToken({
      value: validValue({ peer_handle: 'mary' }),
      now: 1_000,
    });
    expect(issued.record.peer_handle).toBe('mary');
    const reread = store.getTokenById(issued.record.token_id);
    expect(reread?.peer_handle).toBe('mary');
  });

  it('round-trips chat_mode metadata', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    const issued = store.issueToken({
      value: validValue({
        chat_mode: { offered: true, session_cap: { per_day: 5, concurrent: 2 } },
      }),
      now: 1_000,
    });
    expect(issued.record.chat_mode).toEqual({
      offered: true,
      session_cap: { per_day: 5, concurrent: 2 },
    });
    // Re-read via getTokenById to exercise the JSON parse path.
    const reread = store.getTokenById(issued.record.token_id);
    expect(reread?.chat_mode).toEqual({
      offered: true,
      session_cap: { per_day: 5, concurrent: 2 },
    });
  });

  it('round-trips chat_mode null (default — not offered)', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    const issued = store.issueToken({
      value: validValue({ chat_mode: null }),
      now: 1_000,
    });
    expect(issued.record.chat_mode).toBeNull();
    const reread = store.getTokenById(issued.record.token_id);
    expect(reread?.chat_mode).toBeNull();
  });

  it('round-trips chat_mode { offered: false } without session_cap', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    const issued = store.issueToken({
      value: validValue({ chat_mode: { offered: false } }),
      now: 1_000,
    });
    const reread = store.getTokenById(issued.record.token_id);
    expect(reread?.chat_mode).toEqual({ offered: false });
  });

  it('listTokens returns newest issuance first', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    store.issueToken({ value: validValue({ label: 'alice' }), now: 1_000 });
    store.issueToken({ value: validValue({ label: 'bob' }), now: 2_000 });
    store.issueToken({ value: validValue({ label: 'carol' }), now: 1_500 });
    const list = store.listTokens();
    expect(list.map((r) => r.label)).toEqual(['bob', 'carol', 'alice']);
  });

  it('updateTokenGrants persists a fresh map + stamps updated_at', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    const issued = store.issueToken({
      value: validValue({ grants: { 'contact.search': true } }),
      now: 1_000,
    });
    const updated = store.updateTokenGrants({
      token_id: issued.record.token_id,
      grants: { 'contact.search': true, 'mail.send': false },
      now: 2_000,
    });
    expect(updated).not.toBeNull();
    expect(updated?.grants).toEqual({ 'contact.search': true, 'mail.send': false });
    expect(updated?.updated_at).toBe(2_000);
    expect(updated?.created_at).toBe(1_000);
  });

  it('updateTokenGrants returns null when the row does not exist', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    const result = store.updateTokenGrants({
      token_id: 'never_issued',
      grants: {},
      now: 1_000,
    });
    expect(result).toBeNull();
  });

  it('D-171 2b — updateTokenGrants writes chat_mode + grants together', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    const issued = store.issueToken({
      value: validValue({ grants: { 'contact.search': true }, chat_mode: null }),
      now: 1_000,
    });
    const updated = store.updateTokenGrants({
      token_id: issued.record.token_id,
      grants: { 'mail.send': true },
      chat_mode: { offered: true },
      now: 2_000,
    });
    expect(updated?.grants).toEqual({ 'mail.send': true });
    expect(updated?.chat_mode).toEqual({ offered: true });
    // Re-read to exercise the persisted JSON parse path.
    const reread = store.getTokenById(issued.record.token_id);
    expect(reread?.chat_mode).toEqual({ offered: true });
  });

  it('D-171 2b — updateTokenGrants preserves prior chat_mode when omitted (grants-only)', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    const issued = store.issueToken({
      value: validValue({
        grants: { 'contact.search': true },
        chat_mode: { offered: true, session_cap: { per_day: 5, concurrent: 2 } },
      }),
      now: 1_000,
    });
    // A grants-only edit (no chat_mode key) must NOT clear chat-mode.
    const updated = store.updateTokenGrants({
      token_id: issued.record.token_id,
      grants: { 'contact.search': false, 'mail.send': true },
      now: 2_000,
    });
    expect(updated?.grants).toEqual({ 'contact.search': false, 'mail.send': true });
    expect(updated?.chat_mode).toEqual({
      offered: true,
      session_cap: { per_day: 5, concurrent: 2 },
    });
  });

  it('D-171 2b — updateTokenGrants preserves prior grants when omitted (chat_mode-only)', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    const issued = store.issueToken({
      value: validValue({
        grants: { 'contact.search': true, 'mail.search': true },
        chat_mode: null,
      }),
      now: 1_000,
    });
    // A chat-only edit (no grants key) must NOT clobber the grant map.
    const updated = store.updateTokenGrants({
      token_id: issued.record.token_id,
      chat_mode: { offered: true },
      now: 2_000,
    });
    expect(updated?.grants).toEqual({ 'contact.search': true, 'mail.search': true });
    expect(updated?.chat_mode).toEqual({ offered: true });
    expect(updated?.updated_at).toBe(2_000);
  });

  it('D-171 2b — updateTokenGrants chat_mode:null clears chat-mode, grants untouched', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    const issued = store.issueToken({
      value: validValue({
        grants: { 'contact.search': true },
        chat_mode: { offered: true },
      }),
      now: 1_000,
    });
    const updated = store.updateTokenGrants({
      token_id: issued.record.token_id,
      chat_mode: null,
      now: 2_000,
    });
    expect(updated?.chat_mode).toBeNull();
    expect(updated?.grants).toEqual({ 'contact.search': true });
  });

  it('D-171 2b — updateTokenGrants with neither field touches updated_at, preserves both', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    const issued = store.issueToken({
      value: validValue({
        grants: { 'contact.search': true },
        chat_mode: { offered: true },
      }),
      now: 1_000,
    });
    const updated = store.updateTokenGrants({
      token_id: issued.record.token_id,
      now: 2_000,
    });
    expect(updated?.updated_at).toBe(2_000);
    expect(updated?.grants).toEqual({ 'contact.search': true });
    expect(updated?.chat_mode).toEqual({ offered: true });
  });

  it('revokeToken stamps revoked_at + returns true once; subsequent revokes are no-ops', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    const issued = store.issueToken({ value: validValue(), now: 1_000 });
    expect(store.revokeToken({ token_id: issued.record.token_id, now: 2_000 })).toBe(true);
    const after = store.getTokenById(issued.record.token_id);
    expect(after?.revoked_at).toBe(2_000);
    // Idempotent — re-revoking preserves the original revoked_at.
    expect(store.revokeToken({ token_id: issued.record.token_id, now: 5_000 })).toBe(false);
    const after2 = store.getTokenById(issued.record.token_id);
    expect(after2?.revoked_at).toBe(2_000);
  });

  it('deleteToken removes the row', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    const issued = store.issueToken({ value: validValue(), now: 1_000 });
    expect(store.deleteToken(issued.record.token_id)).toBe(true);
    expect(store.getTokenById(issued.record.token_id)).toBeNull();
    expect(store.deleteToken(issued.record.token_id)).toBe(false);
  });

  it('tracks and drains authority-change cleanup for every direct mutator', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const changed = vi.fn(async () => gate);
    const db = newDb();
    const store = createChatInboundTokenStore(db, {
      onAuthorityChanged: changed,
    });
    const issued = store.issueToken({ value: validValue(), now: 1_000 });

    store.updateTokenGrants({
      token_id: issued.record.token_id,
      grants: { 'contact.search': false },
      now: 2_000,
    });
    store.updateTokenContract({
      token_id: issued.record.token_id,
      contract_id: 'ct_rebound',
      now: 3_000,
    });
    store.revokeToken({ token_id: issued.record.token_id, now: 4_000 });
    store.deleteToken(issued.record.token_id);
    // Missing/idempotent lifecycle calls deliberately re-admit cleanup so a
    // retry heals residue from a prior process crash.
    store.revokeToken({ token_id: issued.record.token_id, now: 5_000 });
    store.deleteToken(issued.record.token_id);

    expect(changed).toHaveBeenCalledTimes(6);
    let drained = false;
    const draining = store.drainAuthorityChanges().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release?.();
    await draining;
    expect(drained).toBe(true);
  });

  it('contains synchronous and asynchronous authority cleanup failures', async () => {
    const db = newDb();
    let sync = true;
    const store = createChatInboundTokenStore(db, {
      onAuthorityChanged: () => {
        if (sync) throw new Error('sync cleanup failed');
        return Promise.reject(new Error('async cleanup failed'));
      },
    });
    const issued = store.issueToken({ value: validValue(), now: 1_000 });

    expect(() => store.revokeToken({
      token_id: issued.record.token_id,
      now: 2_000,
    })).not.toThrow();
    sync = false;
    expect(() => store.deleteToken(issued.record.token_id)).not.toThrow();
    await expect(store.drainAuthorityChanges()).resolves.toBeUndefined();
  });

  it('verifyBearer returns the row for a valid bearer + null for garbage / mismatched / revoked / expired', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    const issued = store.issueToken({
      value: validValue({ expires_at: 10_000 }),
      now: 1_000,
    });
    const bearer = issued.bearer_plaintext;
    // Happy path
    expect(store.verifyBearer({ bearer, now: 5_000 })?.token_id).toBe(issued.record.token_id);
    // Garbage bearer (different plaintext → different sha256-16 → no row)
    expect(store.verifyBearer({ bearer: 'recued_garbage', now: 5_000 })).toBeNull();
    // Empty bearer
    expect(store.verifyBearer({ bearer: '', now: 5_000 })).toBeNull();
    // Past expiry
    expect(store.verifyBearer({ bearer, now: 20_000 })).toBeNull();
    // Revoked
    store.revokeToken({ token_id: issued.record.token_id, now: 2_000 });
    expect(store.verifyBearer({ bearer, now: 5_000 })).toBeNull();
  });

  it('verifyBearer constant-time rejects a same-prefix forged bearer', () => {
    // Forge a bearer whose sha256-16 prefix collides with an issued
    // token by writing a hand-crafted row directly. The store's
    // constant-time hash compare is the load-bearing gate.
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    const real = generateMcpInboundTokenBearer();
    const realId = deriveMcpInboundTokenId(real);
    const realHash = hashMcpInboundTokenBearer(real);
    // Insert a row with the forged scenario: same token_id (prefix) but
    // a different full digest. We use SQLite directly to bypass the
    // bearer-derived insertion path.
    const fakeHash = 'f'.repeat(64);
    db.prepare(`
      INSERT INTO chat_inbound_tokens
        (token_id, bearer_hash, label, peer_handle, created_at, expires_at,
         revoked_at, grants_json, concurrency_tier, chat_mode_json, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?)
    `).run(realId, fakeHash, 'forged', 1_000, 0, '{}', 3, 'null', 1_000);
    // The real bearer derives the same token_id (lookup hits) but the
    // full digest mismatches the persisted `fakeHash` ⇒ verifier
    // refuses.
    expect(store.verifyBearer({ bearer: real, now: 5_000 })).toBeNull();
    expect(realHash).not.toBe(fakeHash);
  });

  it('exposes the closed concurrency ladder and tier set', () => {
    expect(MCP_INBOUND_CONCURRENCY_LADDER).toEqual([3, 5, 10]);
    expect(MCP_INBOUND_CONCURRENCY_TIER_SET.has(3)).toBe(true);
    expect(MCP_INBOUND_CONCURRENCY_TIER_SET.has(5)).toBe(true);
    expect(MCP_INBOUND_CONCURRENCY_TIER_SET.has(10)).toBe(true);
    expect(isMcpInboundConcurrencyTier(3)).toBe(true);
    expect(isMcpInboundConcurrencyTier(7)).toBe(false);
  });

  it('exposes the 1-year default expiry constant', () => {
    expect(MCP_INBOUND_TOKEN_DEFAULT_EXPIRY_MS).toBe(365 * 24 * 60 * 60 * 1000);
  });
});

describe('D-137 P5 — Codex review P1 fold: one token per peer constraint', () => {
  const newDb = () => {
    const db = new Database(':memory:');
    ensureChatInboundTokenSchema(db);
    return db;
  };

  const validValue = (
    overrides: Partial<ValidatedMcpInboundTokenInput> = {},
  ): ValidatedMcpInboundTokenInput => ({
    label: 'mary',
    grants: { 'contact.search': true },
    concurrency_tier: 3,
    expires_at: 0,
    chat_mode: null,
    ...overrides,
  });

  it('refuses a second issuance to the same peer_handle while the first is active', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    store.issueToken({ value: validValue({ peer_handle: 'mary' }), now: 1_000 });
    expect(() => store.issueToken({
      value: validValue({ peer_handle: 'mary', label: 'mary-2' }),
      now: 2_000,
    })).toThrow(/peer_handle_conflict/);
  });

  it('PEER_HANDLE_CONFLICT_PREFIX is the documented contract prefix', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    store.issueToken({ value: validValue({ peer_handle: 'mary' }), now: 1_000 });
    try {
      store.issueToken({
        value: validValue({ peer_handle: 'mary' }),
        now: 2_000,
      });
      expect.fail('expected throw');
    } catch (err) {
      expect((err as Error).message.startsWith(PEER_HANDLE_CONFLICT_PREFIX)).toBe(true);
    }
  });

  it('allows reissuance after revoke (peer_handle constraint relaxes for revoked rows)', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    const first = store.issueToken({
      value: validValue({ peer_handle: 'mary' }),
      now: 1_000,
    });
    expect(store.revokeToken({ token_id: first.record.token_id, now: 2_000 })).toBe(true);
    // After revoke, a fresh issuance to the same peer succeeds.
    const second = store.issueToken({
      value: validValue({ peer_handle: 'mary', label: 'mary-2' }),
      now: 3_000,
    });
    expect(second.record.peer_handle).toBe('mary');
    expect(second.record.token_id).not.toBe(first.record.token_id);
  });

  it('allows multiple tokens with no peer_handle (operator-issued / test fixtures)', () => {
    // The partial unique index applies ONLY when peer_handle is non-
    // null. Tokens without a peer_handle freely coexist.
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    store.issueToken({ value: validValue({ label: 'a' }), now: 1_000 });
    store.issueToken({ value: validValue({ label: 'b' }), now: 2_000 });
    store.issueToken({ value: validValue({ label: 'c' }), now: 3_000 });
    expect(store.listTokens().length).toBe(3);
  });

  it('allows tokens to distinct peer_handles', () => {
    const db = newDb();
    const store = createChatInboundTokenStore(db);
    store.issueToken({ value: validValue({ peer_handle: 'mary' }), now: 1_000 });
    store.issueToken({ value: validValue({ peer_handle: 'bob', label: 'bob' }), now: 2_000 });
    expect(store.listTokens().length).toBe(2);
  });
});

describe('D-137 P5 — Codex review P2 fold: malformed nested session_cap fails closed', () => {
  const newDb = () => {
    const db = new Database(':memory:');
    ensureChatInboundTokenSchema(db);
    return db;
  };

  it('inbound-token store collapses chat_mode to null when persisted session_cap is malformed', () => {
    // Plant a hand-crafted row with `chat_mode` carrying a corrupted
    // session_cap (negative per_day). Pre-fold the parser dropped the
    // cap silently but kept `offered: true`, converting "offered with
    // cost-controls" into "offered uncapped." Post-fold the parser
    // collapses the whole chat_mode to null.
    const db = newDb();
    db.prepare(`
      INSERT INTO chat_inbound_tokens
        (token_id, bearer_hash, label, peer_handle, created_at, expires_at,
         revoked_at, grants_json, concurrency_tier, chat_mode_json, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?)
    `).run(
      'abcd1234abcd1234',
      'f'.repeat(64),
      'mary',
      1_000,
      0,
      '{}',
      3,
      '{"offered":true,"session_cap":{"per_day":-1,"concurrent":2}}',
      1_000,
    );
    const store = createChatInboundTokenStore(db);
    const r = store.getTokenById('abcd1234abcd1234');
    expect(r?.chat_mode).toBeNull();
  });

  it('inbound-token store collapses chat_mode to null when persisted session_cap is non-integer', () => {
    const db = newDb();
    db.prepare(`
      INSERT INTO chat_inbound_tokens
        (token_id, bearer_hash, label, peer_handle, created_at, expires_at,
         revoked_at, grants_json, concurrency_tier, chat_mode_json, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?)
    `).run(
      'abcd1234abcd1234',
      'f'.repeat(64),
      'mary',
      1_000,
      0,
      '{}',
      3,
      '{"offered":true,"session_cap":{"per_day":1.5,"concurrent":2}}',
      1_000,
    );
    const store = createChatInboundTokenStore(db);
    const r = store.getTokenById('abcd1234abcd1234');
    expect(r?.chat_mode).toBeNull();
  });

  it('inbound-token store keeps { offered: true } when session_cap is absent (uncapped is intentional)', () => {
    // Distinct from the malformed cap path: when there is NO session_cap
    // field at all, "offered uncapped" is the explicit intent.
    const db = newDb();
    db.prepare(`
      INSERT INTO chat_inbound_tokens
        (token_id, bearer_hash, label, peer_handle, created_at, expires_at,
         revoked_at, grants_json, concurrency_tier, chat_mode_json, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?)
    `).run(
      'abcd1234abcd1234',
      'f'.repeat(64),
      'mary',
      1_000,
      0,
      '{}',
      3,
      '{"offered":true}',
      1_000,
    );
    const store = createChatInboundTokenStore(db);
    const r = store.getTokenById('abcd1234abcd1234');
    expect(r?.chat_mode).toEqual({ offered: true });
  });
});
