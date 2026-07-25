/** D-166 Slice 4b — `composeForRole` dispatcher.
 *
 *  Proves the dispatcher gathers a role's contributing scopes, scans rows for a
 *  ResolutionContext (required-prefix anchoring + optional-tail narrowing),
 *  projects (4a) + folds (Slice 3) policy roles, returns the raw row set for
 *  inventory roles, and that the P2 fix (policy_resolution `union`, not
 *  `override`) preserves a prior grant's fields under cross-scope composition.
 *  Pure: every test injects a fake `scan` — no storage. */

import { describe, expect, it } from 'vitest';

import {
  composeForRole,
  D165_CONTRACT_SCHEMA,
  type CompositeKeySchema,
  type ContractRowLike,
  type ResolutionContext,
  type ScanFn,
} from '@recued/contracts';

const COMPOSITE_KEYS = D165_CONTRACT_SCHEMA.composite_keys;

/** A fake scan over an in-memory row table keyed by scope. Mirrors the store's
 *  prefix-scan contract: returns rows whose segments START WITH `prefix`
 *  (empty ⇒ the whole scope). */
const fakeScan = (
  table: Readonly<Record<string, readonly { segments: readonly string[]; value: Record<string, unknown> }[]>>,
): ScanFn => {
  return (scope, prefix) => {
    const rows = table[scope] ?? [];
    return rows.filter(
      (r) =>
        prefix.length <= r.segments.length &&
        prefix.every((seg, i) => r.segments[i] === seg),
    );
  };
};

/** Records each (scope, prefix) the dispatcher asks for — lets a test assert the
 *  scan was anchored on the required prefix, not the optional tail. */
const recordingScan = (
  table: Parameters<typeof fakeScan>[0],
): { scan: ScanFn; calls: Array<{ scope: string; prefix: readonly string[] }> } => {
  const calls: Array<{ scope: string; prefix: readonly string[] }> = [];
  const inner = fakeScan(table);
  return {
    calls,
    scan: (scope, prefix) => {
      calls.push({ scope, prefix });
      return inner(scope, prefix);
    },
  };
};

const policy = (result: ReturnType<typeof composeForRole>): Record<string, unknown> => {
  if (result.kind !== 'policy') throw new Error(`expected policy result, got ${result.kind}`);
  return result.policy;
};

const inventoryRows = (result: ReturnType<typeof composeForRole>): ContractRowLike[] => {
  if (result.kind !== 'inventory') throw new Error(`expected inventory result, got ${result.kind}`);
  return result.rows;
};

// ════════════════════════════════════════════════════════════════
// Inventory roles — return the raw row set, never a merged policy
// ════════════════════════════════════════════════════════════════

describe('composeForRole — inventory roles', () => {
  it('returns the matching ingredient rows for ingredient_inventory', () => {
    const scan = fakeScan({
      installed_ingredient: [
        { segments: ['hubspot/deal-reader'], value: { ingredient_id: 'hubspot/deal-reader', version: '1.0.0', installed_at: 1 } },
        { segments: ['hubspot/contact-reader'], value: { ingredient_id: 'hubspot/contact-reader', version: '1.0.0', installed_at: 2 } },
      ],
    });
    const result = composeForRole(COMPOSITE_KEYS, 'ingredient_inventory', {}, scan);
    expect(result.kind).toBe('inventory');
    expect(inventoryRows(result)).toHaveLength(2);
  });

  it('narrows the inventory list when context names the leading segment', () => {
    const scan = fakeScan({
      installed_ingredient: [
        { segments: ['hubspot/deal-reader'], value: { ingredient_id: 'hubspot/deal-reader', version: '1.0.0', installed_at: 1 } },
        { segments: ['hubspot/contact-reader'], value: { ingredient_id: 'hubspot/contact-reader', version: '1.0.0', installed_at: 2 } },
      ],
    });
    const result = composeForRole(
      COMPOSITE_KEYS,
      'ingredient_inventory',
      { ingredient_id: 'hubspot/deal-reader' },
      scan,
    );
    expect(inventoryRows(result).map((r) => r.segments)).toEqual([['hubspot/deal-reader']]);
  });

  it('does NOT project inventory rows (returns raw values verbatim)', () => {
    const raw = { ingredient_id: 'hubspot/deal-reader', version: '1.0.0', installed_at: 1, catalog_kind: 'official' };
    const scan = fakeScan({ installed_ingredient: [{ segments: ['hubspot/deal-reader'], value: raw }] });
    const result = composeForRole(COMPOSITE_KEYS, 'ingredient_inventory', {}, scan);
    expect(inventoryRows(result)[0].value).toEqual(raw);
  });
});

// ════════════════════════════════════════════════════════════════
// Policy roles — project + fold contributing scopes
// ════════════════════════════════════════════════════════════════

describe('composeForRole — grant_resolution', () => {
  const ctx: ResolutionContext = {
    installed_pack_id: 'sales-pack',
    ingredient_id: 'hubspot/deal-reader',
    connection_name: 'primary',
    group_id_or_operation_id: 'deals',
    pack_slug: 'sales-pack',
    group_id: 'deals',
    actor: 'user:1',
  };

  it('projects + composes a lone grant row to canonical policy fields', () => {
    const scan = fakeScan({
      grant: [
        {
          segments: ['sales-pack', 'hubspot/deal-reader', 'primary', 'deals'],
          value: {
            allowed: true,
            approval: 'ask',
            risk_tier: 'read',
            denied_operation_ids: ['hubspot/deal-reader.delete_deal'],
          },
        },
      ],
    });
    const result = composeForRole(COMPOSITE_KEYS, 'grant_resolution', ctx, scan);
    expect(policy(result)).toEqual({
      allowed: true,
      approval: 'ask',
      risk_tier: 'read',
      denied_operation_ids: ['hubspot/deal-reader.delete_deal'],
    });
  });

  it('P2 FIX: a partial policy_resolution (union) overlays approval WITHOUT erasing the grant', () => {
    // grant (prec 10) carries the full policy; the merge-card resolution (prec 20,
    // `union`) carries only approval + allowed_operation_ids. union composes from
    // {...acc}, so the grant's allowed / risk_tier / denied survive and the
    // resolution's approval wins by take-last. (override would erase them — the
    // P2 regression this guards.)
    const scan = fakeScan({
      grant: [
        {
          segments: ['sales-pack', 'hubspot/deal-reader', 'primary', 'deals'],
          value: {
            allowed: true,
            approval: 'ask',
            risk_tier: 'write',
            denied_operation_ids: ['hubspot/deal-reader.delete_deal'],
          },
        },
      ],
      policy_resolution: [
        {
          segments: ['sales-pack', 'deals'],
          value: { resolved_approval: 'always', resolved_operations: ['hubspot/deal-reader.read_deals'] },
        },
      ],
    });
    const result = composeForRole(COMPOSITE_KEYS, 'grant_resolution', ctx, scan);
    expect(policy(result)).toEqual({
      allowed: true,
      approval: 'always', // resolution overlaid it (take-last)
      risk_tier: 'write', // grant field PRESERVED (not erased)
      denied_operation_ids: ['hubspot/deal-reader.delete_deal'], // grant field PRESERVED
      allowed_operation_ids: ['hubspot/deal-reader.read_deals'], // resolution added it
    });
  });

  it('composes grant + override (tightening) — the deny-flag tightens allowed', () => {
    const scan = fakeScan({
      grant: [
        {
          segments: ['sales-pack', 'hubspot/deal-reader', 'primary', 'deals'],
          value: { allowed: true, approval: 'ask' },
        },
      ],
      override: [
        {
          segments: ['user:1', 'hubspot/deal-reader'],
          value: { denied: true, approval: 'always' },
        },
      ],
    });
    const result = composeForRole(COMPOSITE_KEYS, 'grant_resolution', ctx, scan);
    // override (prec 30, tightening_only) — denied:true → allowed:false and
    // approval always tightens ask. Global D-211 defaults use another scope.
    expect(policy(result)).toEqual({ allowed: false, approval: 'always' });
  });

  it('returns the empty policy when no rows match', () => {
    const result = composeForRole(COMPOSITE_KEYS, 'grant_resolution', ctx, fakeScan({}));
    expect(result).toEqual({ kind: 'policy', policy: {}, conflicts: [] });
  });
});

// ════════════════════════════════════════════════════════════════
// Required-segment gating + path anchoring
// ════════════════════════════════════════════════════════════════

describe('composeForRole — path resolution', () => {
  it('skips a policy scope whose required segments are absent from context', () => {
    // `grant` requires installed_pack_id/ingredient_id/connection_name/
    // group_id_or_operation_id; with none present it must contribute nothing
    // (and must not even scan it).
    const { scan, calls } = recordingScan({
      grant: [
        { segments: ['sales-pack', 'hubspot/deal-reader', 'primary', 'deals'], value: { allowed: true } },
      ],
    });
    const result = composeForRole(COMPOSITE_KEYS, 'grant_resolution', { actor: 'user:1' }, scan);
    expect(policy(result)).toEqual({}); // grant skipped; override has only actor (needs ingredient_id too) → also skipped
    expect(calls.find((c) => c.scope === 'grant')).toBeUndefined();
  });

  it('anchors the scan on the required prefix, not the optional tail', () => {
    // `override` required = [actor, ingredient_id]; optional_tail = [operation_id].
    // With no operation_id in context the scan prefix must be [actor, ingredient_id]
    // so both the match-all override row and operation-specific rows stay in range.
    const { scan, calls } = recordingScan({
      override: [
        { segments: ['user:1', 'hubspot/deal-reader'], value: { denied: true } },
      ],
    });
    composeForRole(
      COMPOSITE_KEYS,
      'risk_override',
      { actor: 'user:1', ingredient_id: 'hubspot/deal-reader' },
      scan,
    );
    const overrideCall = calls.find((c) => c.scope === 'override');
    expect(overrideCall?.prefix).toEqual(['user:1', 'hubspot/deal-reader']);
  });

  it('a broad request (no operation_id) inherits operation-specific tightening — match-all, fail-closed', () => {
    // The optional_tail "resolve to match-all on scan" contract: omitting
    // operation_id means EVERY override row applies (bare + per-operation), so an
    // operation-specific user tightening is NOT silently dropped on a broad
    // evaluation. tightening_only takes the stricter, so the delete_deal-specific
    // `none` wins over the bare `read` — fail-closed, never widening permissions.
    const scan = fakeScan({
      override: [
        { segments: ['user:1', 'hubspot/deal-reader'], value: { max_risk_without_approval: 'read' } },
        { segments: ['user:1', 'hubspot/deal-reader', 'hubspot/deal-reader.delete_deal'], value: { max_risk_without_approval: 'none' } },
      ],
    });
    const result = composeForRole(
      COMPOSITE_KEYS,
      'risk_override',
      { actor: 'user:1', ingredient_id: 'hubspot/deal-reader' },
      scan,
    );
    expect(policy(result)).toEqual({ max_risk_without_approval: 'none' });
  });

  it('selects the operation-specific override row when context targets that operation', () => {
    const scan = fakeScan({
      override: [
        { segments: ['user:1', 'hubspot/deal-reader'], value: { max_risk_without_approval: 'read' } },
        { segments: ['user:1', 'hubspot/deal-reader', 'hubspot/deal-reader.delete_deal'], value: { max_risk_without_approval: 'none' } },
      ],
    });
    const result = composeForRole(
      COMPOSITE_KEYS,
      'risk_override',
      { actor: 'user:1', ingredient_id: 'hubspot/deal-reader', operation_id: 'hubspot/deal-reader.delete_deal' },
      scan,
    );
    // Both the match-all (read) and the targeted specific (none) apply; tightening_only
    // takes the stricter → none.
    expect(policy(result)).toEqual({ max_risk_without_approval: 'none' });
  });
});

// ════════════════════════════════════════════════════════════════
// Single-scope override roles
// ════════════════════════════════════════════════════════════════

describe('composeForRole — single-scope override roles', () => {
  const ctx: ResolutionContext = { actor: 'user:1', ingredient_id: 'hubspot/deal-reader' };

  it('timeout_override composes only the override scope', () => {
    const scan = fakeScan({
      override: [{ segments: ['user:1', 'hubspot/deal-reader'], value: { timeout_ms: 5_000 } }],
    });
    expect(policy(composeForRole(COMPOSITE_KEYS, 'timeout_override', ctx, scan))).toEqual({ timeout_ms: 5_000 });
  });

  it('cache_ttl_override composes only the override scope', () => {
    const scan = fakeScan({
      override: [{ segments: ['user:1', 'hubspot/deal-reader'], value: { cache_ttl_ms: 60_000 } }],
    });
    expect(policy(composeForRole(COMPOSITE_KEYS, 'cache_ttl_override', ctx, scan))).toEqual({ cache_ttl_ms: 60_000 });
  });
});

// ════════════════════════════════════════════════════════════════
// Schema-driven: a synthetic registry composes without code change
// ════════════════════════════════════════════════════════════════

describe('composeForRole — schema-driven', () => {
  it('picks up a hand-built composite_keys map by applies_to membership', () => {
    const compositeKeys: Record<string, CompositeKeySchema> = {
      a: {
        segments: ['id'],
        required: ['id'],
        value_shape: 'grant_policy',
        applies_to: ['grant_resolution'],
        merge_precedence: 10,
        merge_rule: 'union_with_stricter_wins',
        writeable_by: 'install_planner',
      },
      // Contributes to a DIFFERENT role — must be ignored for grant_resolution.
      b: {
        segments: ['id'],
        required: ['id'],
        value_shape: 'override_policy',
        applies_to: ['timeout_override'],
        merge_precedence: 30,
        merge_rule: 'tightening_only',
        writeable_by: 'user',
      },
    };
    const scan = fakeScan({
      a: [{ segments: ['x'], value: { allowed: true, approval: 'ask' } }],
      b: [{ segments: ['x'], value: { timeout_ms: 1_000 } }],
    });
    const result = composeForRole(compositeKeys, 'grant_resolution', { id: 'x' }, scan);
    expect(policy(result)).toEqual({ allowed: true, approval: 'ask' });
  });

  it('surfaces a same-precedence conflict from composeRows', () => {
    const compositeKeys: Record<string, CompositeKeySchema> = {
      a: {
        segments: ['id'], required: ['id'], value_shape: 'merge_card_resolution',
        applies_to: ['grant_resolution'], merge_precedence: 20, merge_rule: 'union', writeable_by: 'user',
      },
      b: {
        segments: ['id'], required: ['id'], value_shape: 'merge_card_resolution',
        applies_to: ['grant_resolution'], merge_precedence: 20, merge_rule: 'union', writeable_by: 'user',
      },
    };
    const scan = fakeScan({
      a: [{ segments: ['x'], value: { resolved_approval: 'ask' } }],
      b: [{ segments: ['x'], value: { resolved_approval: 'always' } }],
    });
    const result = composeForRole(compositeKeys, 'grant_resolution', { id: 'x' }, scan);
    if (result.kind !== 'policy') throw new Error('expected policy');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ kind: 'value', field: 'approval', merge_precedence: 20 });
  });

  it('throws if an inventory shape reaches the policy branch (mis-declared scope)', () => {
    // A scope whose value_shape is an inventory shape but declares a POLICY role —
    // projectToPolicyFields rejects it (fail-closed), surfacing the schema error.
    const compositeKeys: Record<string, CompositeKeySchema> = {
      bad: {
        segments: ['id'], required: ['id'], value_shape: 'installed_ingredient_info',
        applies_to: ['grant_resolution'], merge_precedence: 10, merge_rule: 'union', writeable_by: 'install_planner',
      },
    };
    const scan = fakeScan({ bad: [{ segments: ['x'], value: { ingredient_id: 'x', version: '1', installed_at: 1 } }] });
    expect(() => composeForRole(compositeKeys, 'grant_resolution', { id: 'x' }, scan)).toThrow();
  });
});
