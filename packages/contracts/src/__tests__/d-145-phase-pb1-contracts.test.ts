/** D-145 PB1 — capacity_spec contracts surface tests.
 *
 *  Covers § N.1 closed list, § N.2 discriminated union, § N.3
 *  capacityKey, § N.4 remediations, § N.5 result shapes, § N.7
 *  redaction, § N.8 validator, § N.9 cache policies, § N.11
 *  invalidation topics. */

import { describe, expect, it } from 'vitest';

import {
  CACHEABLE_CAPACITY_KINDS,
  CAPACITY_AUDIT_ACTIONS,
  CAPACITY_AUDIT_GAP_ACTION,
  CAPACITY_AUDIT_OK_ACTION,
  CAPACITY_CACHE_POLICIES,
  CAPACITY_INVALIDATION_TOPICS,
  CAPACITY_KINDS,
  CAPACITY_PROBE_FAILURE_DETAILS,
  CAPACITY_REMEDIATION_ACTIONS,
  CAPACITY_SPEC_VALIDATION_ISSUE_KINDS,
  CAPACITY_TRANSPARENCY_GAP_EVENT_KIND,
  CapacitySpecValidationError,
  IDENTITY_BEARING_FIELDS,
  POOL_KINDS,
  assertValidCapacitySpec,
  capacityKey,
  capacityParamsForAudit,
  isCapacityProbeFailure,
  resolveRemediationEntry,
  validateCapacitySpec,
  type CapacityCheckGapTransparencyEvent,
  type CapacityRequirement,
  type CapacitySpec,
} from '../index.js';

describe('D-145 PB1 — § N.1 CapacityKind closed list', () => {
  it('contains exactly the 9 PB1 kinds in spec order', () => {
    expect(CAPACITY_KINDS).toEqual([
      'bridge_online',
      'ingredient_installed',
      'logged_in',
      'annotation',
      'annotation_not_required',
      'permission_grant',
      'connection_active',
      'pool_quota_available',
      'selector_freshness',
    ]);
    expect(CAPACITY_KINDS.length).toBe(9);
  });

  it('every kind has a CapacityCachePolicy entry', () => {
    for (const k of CAPACITY_KINDS) {
      expect(CAPACITY_CACHE_POLICIES[k]).toBeDefined();
      expect(CAPACITY_CACHE_POLICIES[k].capacity_kind).toBe(k);
    }
  });

  it('CACHEABLE_CAPACITY_KINDS excludes annotation + annotation_not_required', () => {
    expect(CACHEABLE_CAPACITY_KINDS.has('annotation')).toBe(false);
    expect(CACHEABLE_CAPACITY_KINDS.has('annotation_not_required')).toBe(false);
    expect(CACHEABLE_CAPACITY_KINDS.has('bridge_online')).toBe(true);
    expect(CACHEABLE_CAPACITY_KINDS.has('connection_active')).toBe(true);
  });
});

describe('D-145 PB1 — § N.3 capacityKey', () => {
  it('produces stable keys per kind', () => {
    expect(capacityKey({ kind: 'bridge_online' })).toBe('bridge_online');
    expect(capacityKey({ kind: 'annotation_not_required' })).toBe('annotation_not_required');
    expect(capacityKey({ kind: 'ingredient_installed', slug: 'webchat-gemini' })).toBe(
      'ingredient_installed:webchat-gemini',
    );
    expect(capacityKey({ kind: 'selector_freshness', slug: 'webchat-gemini' })).toBe(
      'selector_freshness:webchat-gemini',
    );
    expect(capacityKey({ kind: 'logged_in', site: 'gemini.google.com' })).toBe(
      'logged_in:gemini.google.com',
    );
    expect(capacityKey({ kind: 'annotation', ref: 'data.contact.X.aliases.facebook' })).toBe(
      'annotation:data.contact.X.aliases.facebook',
    );
    expect(capacityKey({ kind: 'permission_grant', permission: 'write_enrichment' })).toBe(
      'permission_grant:write_enrichment',
    );
    expect(capacityKey({ kind: 'pool_quota_available', pool: 'free' })).toBe(
      'pool_quota_available:free',
    );
  });

  it('connection_active key reflects vendor / entity / connection_id narrowing', () => {
    expect(capacityKey({ kind: 'connection_active', vendor: 'hubspot' })).toBe(
      'connection_active:hubspot:*',
    );
    expect(
      capacityKey({ kind: 'connection_active', vendor: 'hubspot', entity: 'task' }),
    ).toBe('connection_active:hubspot:task');
    expect(
      capacityKey({
        kind: 'connection_active',
        vendor: 'hubspot',
        entity: 'task',
        connection_id: 'conn-42',
      }),
    ).toBe('connection_active:hubspot:task:conn-42');
  });
});

describe('D-145 PB1 — § N.4 CapacityRemediation', () => {
  it('CAPACITY_REMEDIATION_ACTIONS includes the Pass-2 repair_capacity_probe action', () => {
    expect(CAPACITY_REMEDIATION_ACTIONS).toContain('repair_capacity_probe');
    expect(CAPACITY_REMEDIATION_ACTIONS).toContain('show_bridge_install_prompt');
    expect(CAPACITY_REMEDIATION_ACTIONS).toContain('mark_ingredient_degraded');
  });
});

describe('D-145 PB1 — § N.5 result + probe-failure shapes', () => {
  it('isCapacityProbeFailure narrows CapacityProbeResult correctly', () => {
    expect(isCapacityProbeFailure({ ok: true })).toBe(false);
    expect(isCapacityProbeFailure({ ok: false, detail: 'degraded' })).toBe(false);
    expect(
      isCapacityProbeFailure({ ok: false, failure: 'probe_error', detail: 'probe_threw' }),
    ).toBe(true);
  });

  it('CAPACITY_PROBE_FAILURE_DETAILS closed list', () => {
    expect(CAPACITY_PROBE_FAILURE_DETAILS).toEqual([
      'probe_threw',
      'probe_timeout',
      'probe_unavailable',
      'probe_misconfigured',
    ]);
  });
});

describe('D-145 PB1 — § N.7 redaction projection', () => {
  it('annotation refs project to ref_kind + ref_hash + path_template (no raw id)', () => {
    const projected = capacityParamsForAudit({
      kind: 'annotation',
      ref: 'data.contact.contact-pii-7f3e.aliases.facebook',
    });
    expect(projected.kind).toBe('annotation');
    if (projected.kind !== 'annotation') throw new Error('unreachable');
    expect(projected.ref_kind).toBe('data.contact.aliases.facebook');
    expect(projected.path_template).toBe('data.contact.{id}.aliases.facebook');
    expect(projected.ref_hash).toMatch(/^[0-9a-f]{12}$/);
    // Identity-bearing string never appears in any field.
    const json = JSON.stringify(projected);
    expect(json).not.toContain('contact-pii-7f3e');
  });

  it('connection_active hashes connection_id when present, omits otherwise', () => {
    const a = capacityParamsForAudit({ kind: 'connection_active', vendor: 'hubspot' });
    if (a.kind !== 'connection_active') throw new Error('unreachable');
    expect(a.connection_id_hash).toBeUndefined();
    expect(a.entity).toBeUndefined();

    const b = capacityParamsForAudit({
      kind: 'connection_active',
      vendor: 'hubspot',
      entity: 'task',
      connection_id: 'conn-pii-99',
    });
    if (b.kind !== 'connection_active') throw new Error('unreachable');
    expect(b.entity).toBe('task');
    expect(b.connection_id_hash).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(b)).not.toContain('conn-pii-99');
  });

  it('non-identity kinds round-trip their primitive payload verbatim', () => {
    expect(capacityParamsForAudit({ kind: 'bridge_online' })).toEqual({ kind: 'bridge_online' });
    expect(
      capacityParamsForAudit({ kind: 'ingredient_installed', slug: 'webchat-gemini' }),
    ).toEqual({ kind: 'ingredient_installed', slug: 'webchat-gemini' });
    expect(capacityParamsForAudit({ kind: 'pool_quota_available', pool: 'free' })).toEqual({
      kind: 'pool_quota_available',
      pool: 'free',
    });
  });

  it('IDENTITY_BEARING_FIELDS lists at least the closed-list set', () => {
    for (const f of ['contact_id', 'email', 'phone', 'address', 'mail_thread_id', 'name']) {
      expect(IDENTITY_BEARING_FIELDS).toContain(f);
    }
  });
});

describe('D-145 PB1 — § N.8 validator', () => {
  const goodSpec = (): CapacitySpec => ({
    capacities: [
      { kind: 'bridge_online' },
      { kind: 'ingredient_installed', slug: 'webchat-gemini' },
      { kind: 'logged_in', site: 'gemini.google.com' },
      { kind: 'annotation_not_required' },
    ],
    remediations: {
      bridge_online: {
        action: 'show_bridge_install_prompt',
        user_facing_copy: 'Install bridge.',
        visibility: 'user_visible',
      },
      'ingredient_installed:webchat-gemini': {
        action: 'offer_install',
        user_facing_copy: 'Install ingredient.',
      },
      'logged_in:gemini.google.com': {
        action: 'open_login_tab',
        user_facing_copy: 'Sign in.',
      },
      annotation_not_required: {
        action: 'noop',
        user_facing_copy: '',
      },
    },
  });

  it('validates the happy path with zero issues', () => {
    expect(validateCapacitySpec(goodSpec())).toEqual([]);
  });

  it('emits unknown_capacity_kind for a malformed kind', () => {
    const spec = goodSpec();
    spec.capacities.push({ kind: 'imaginary_kind' as 'bridge_online' });
    const issues = validateCapacitySpec(spec);
    expect(issues.some((i) => i.kind === 'unknown_capacity_kind')).toBe(true);
  });

  it('emits missing_required_field for ingredient_installed without slug', () => {
    const spec: CapacitySpec = {
      capacities: [{ kind: 'ingredient_installed', slug: '' }],
      remediations: {
        'ingredient_installed:': {
          action: 'offer_install',
          user_facing_copy: 'Install.',
        },
      },
    };
    const issues = validateCapacitySpec(spec);
    expect(issues.some((i) => i.kind === 'missing_required_field')).toBe(true);
  });

  it('emits connection_active_missing_entity when connection_id supplied without entity', () => {
    const spec: CapacitySpec = {
      capacities: [{ kind: 'connection_active', vendor: 'hubspot', connection_id: 'c1' }],
      remediations: {
        'connection_active:hubspot:*:c1': {
          action: 'enroll_connection',
          user_facing_copy: 'Enroll.',
        },
      },
    };
    const issues = validateCapacitySpec(spec);
    expect(issues.some((i) => i.kind === 'connection_active_missing_entity')).toBe(true);
  });

  it('emits duplicate_capacity_key for two requirements that resolve to the same key', () => {
    const spec: CapacitySpec = {
      capacities: [
        { kind: 'ingredient_installed', slug: 'webchat-gemini' },
        { kind: 'ingredient_installed', slug: 'webchat-gemini' },
      ],
      remediations: {
        'ingredient_installed:webchat-gemini': {
          action: 'offer_install',
          user_facing_copy: 'Install.',
        },
      },
    };
    const issues = validateCapacitySpec(spec);
    expect(issues.some((i) => i.kind === 'duplicate_capacity_key')).toBe(true);
  });

  it('emits missing_remediation when no exact + no kind-only entry resolves', () => {
    const spec: CapacitySpec = {
      capacities: [{ kind: 'bridge_online' }],
      remediations: {},
    };
    const issues = validateCapacitySpec(spec);
    expect(issues.some((i) => i.kind === 'missing_remediation')).toBe(true);
  });

  it('emits ambiguous_kind_only_remediation when two reqs share kind + only kind-only entry exists', () => {
    const spec: CapacitySpec = {
      capacities: [
        { kind: 'ingredient_installed', slug: 'a' },
        { kind: 'ingredient_installed', slug: 'b' },
      ],
      remediations: {
        ingredient_installed: { action: 'offer_install', user_facing_copy: 'Install.' },
      },
    };
    const issues = validateCapacitySpec(spec);
    expect(issues.some((i) => i.kind === 'ambiguous_kind_only_remediation')).toBe(true);
  });

  it('emits sentinel_action_mismatch when annotation_not_required carries non-noop action', () => {
    const spec: CapacitySpec = {
      capacities: [{ kind: 'annotation_not_required' }],
      remediations: {
        annotation_not_required: {
          action: 'offer_install',
          user_facing_copy: 'Wrong.',
        },
      },
    };
    const issues = validateCapacitySpec(spec);
    expect(issues.some((i) => i.kind === 'sentinel_action_mismatch')).toBe(true);
  });

  it('emits sentinel_action_mismatch for selector_freshness with wrong action', () => {
    const spec: CapacitySpec = {
      capacities: [{ kind: 'selector_freshness', slug: 'webchat-gemini' }],
      remediations: {
        'selector_freshness:webchat-gemini': {
          action: 'offer_install',
          user_facing_copy: 'Wrong.',
        },
      },
    };
    const issues = validateCapacitySpec(spec);
    expect(issues.some((i) => i.kind === 'sentinel_action_mismatch')).toBe(true);
  });

  it('emits unknown_remediation_action for a malformed action', () => {
    const spec: CapacitySpec = {
      capacities: [{ kind: 'bridge_online' }],
      remediations: {
        bridge_online: {
          action: 'imaginary_action' as 'noop',
          user_facing_copy: 'Bad.',
        },
      },
    };
    const issues = validateCapacitySpec(spec);
    expect(issues.some((i) => i.kind === 'unknown_remediation_action')).toBe(true);
  });

  it('CAPACITY_SPEC_VALIDATION_ISSUE_KINDS lists every kind validateCapacitySpec can produce', () => {
    expect(CAPACITY_SPEC_VALIDATION_ISSUE_KINDS).toEqual([
      'unknown_capacity_kind',
      'missing_required_field',
      'unknown_remediation_action',
      'missing_remediation',
      'ambiguous_kind_only_remediation',
      'sentinel_action_mismatch',
      'connection_active_missing_entity',
      'duplicate_capacity_key',
    ]);
  });

  it('assertValidCapacitySpec throws CapacitySpecValidationError on issues', () => {
    expect(() =>
      assertValidCapacitySpec({ capacities: [{ kind: 'bridge_online' }], remediations: {} }),
    ).toThrow(CapacitySpecValidationError);
  });

  it('assertValidCapacitySpec is silent on a clean spec', () => {
    expect(() => assertValidCapacitySpec(goodSpec())).not.toThrow();
  });
});

describe('D-145 PB1 — § N.3 resolveRemediationEntry precedence', () => {
  it('prefers exact-key entry over kind-only fallback', () => {
    // capacityKey('ingredient_installed', slug='a') is
    // 'ingredient_installed:a' — distinct from kind-only key
    // 'ingredient_installed'. Exact-key entry wins.
    const spec: CapacitySpec = {
      capacities: [{ kind: 'ingredient_installed', slug: 'a' }],
      remediations: {
        ingredient_installed: {
          action: 'noop',
          user_facing_copy: 'kind-only',
        },
        'ingredient_installed:a': {
          action: 'offer_install',
          user_facing_copy: 'exact',
        },
      },
    };
    const req: CapacityRequirement = { kind: 'ingredient_installed', slug: 'a' };
    const entry = resolveRemediationEntry(spec, req);
    expect(entry?.user_facing_copy).toBe('exact');
  });

  it('falls back to kind-only when no exact entry exists', () => {
    const spec: CapacitySpec = {
      capacities: [{ kind: 'ingredient_installed', slug: 'a' }],
      remediations: {
        ingredient_installed: { action: 'offer_install', user_facing_copy: 'kind-only' },
      },
    };
    const entry = resolveRemediationEntry(spec, {
      kind: 'ingredient_installed',
      slug: 'a',
    });
    expect(entry?.user_facing_copy).toBe('kind-only');
  });

  it('returns null when neither exact nor kind-only resolves', () => {
    const spec: CapacitySpec = { capacities: [], remediations: {} };
    const entry = resolveRemediationEntry(spec, { kind: 'bridge_online' });
    expect(entry).toBeNull();
  });
});

describe('D-145 PB1 — § N.9 cache policies', () => {
  it('annotation + annotation_not_required are non-cacheable', () => {
    expect(CAPACITY_CACHE_POLICIES.annotation.cacheable).toBe(false);
    expect(CAPACITY_CACHE_POLICIES.annotation.ttl_ms).toBe(0);
    expect(CAPACITY_CACHE_POLICIES.annotation_not_required.cacheable).toBe(false);
  });

  it('selector_freshness uses 24h cache TTL (vs 7d ingredient TTL)', () => {
    expect(CAPACITY_CACHE_POLICIES.selector_freshness.ttl_ms).toBe(24 * 60 * 60_000);
  });

  it('connection_active subscribes to source.enabled_changed (PA11 join)', () => {
    expect(CAPACITY_CACHE_POLICIES.connection_active.invalidation_topics).toContain(
      'source.enabled_changed',
    );
  });

  it('every cache policy invalidation topic is in CAPACITY_INVALIDATION_TOPICS', () => {
    for (const k of CAPACITY_KINDS) {
      const policy = CAPACITY_CACHE_POLICIES[k];
      for (const t of policy.invalidation_topics) {
        expect(CAPACITY_INVALIDATION_TOPICS).toContain(t);
      }
    }
  });
});

describe('D-145 PB1 — § N.11 invalidation topics', () => {
  it('CAPACITY_INVALIDATION_TOPICS contains source.enabled_changed', () => {
    expect(CAPACITY_INVALIDATION_TOPICS).toContain('source.enabled_changed');
  });
});

describe('D-145 PB1 — events.ts mirror', () => {
  it('CAPACITY_AUDIT_ACTIONS lists ok + gap', () => {
    expect(CAPACITY_AUDIT_ACTIONS).toEqual([
      CAPACITY_AUDIT_OK_ACTION,
      CAPACITY_AUDIT_GAP_ACTION,
    ]);
  });

  it('transparency event kind constant matches spec', () => {
    expect(CAPACITY_TRANSPARENCY_GAP_EVENT_KIND).toBe('capacity_check.gap');
  });

  it('CapacityCheckGapTransparencyEvent type is structurally well-formed', () => {
    const evt: CapacityCheckGapTransparencyEvent = {
      kind: CAPACITY_TRANSPARENCY_GAP_EVENT_KIND,
      walk_id: 'w-1',
      gap_kind: 'bridge_online',
      gap_key: 'bridge_online',
      gap_params: { kind: 'bridge_online' },
      remediation: {
        action: 'show_bridge_install_prompt',
        user_facing_copy: 'Install Bridge to continue.',
      },
    };
    expect(evt.gap_kind).toBe('bridge_online');
  });
});

describe('D-145 PB1 — POOL_KINDS', () => {
  it('lists free + byok', () => {
    expect(POOL_KINDS).toEqual(['free', 'byok']);
  });
});
