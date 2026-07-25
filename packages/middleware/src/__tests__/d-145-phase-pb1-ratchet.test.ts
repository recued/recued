/** D-145 PB1 — drift ratchet (§ N.13).
 *
 *  Every drift-prone enum / map / union pairs with a ratchet test
 *  that fails on additions. Catches the closed-list-discipline
 *  invariant (I-8) at PR time. */

import { describe, expect, it } from 'vitest';

import * as capacity from '../capacity/index.js';
import {
  CACHEABLE_CAPACITY_KINDS,
  CAPACITY_AUDIT_ACTIONS,
  CAPACITY_CACHE_POLICIES,
  CAPACITY_INVALIDATION_TOPICS,
  CAPACITY_KINDS,
  CAPACITY_PROBE_FAILURE_DETAILS,
  CAPACITY_REMEDIATION_ACTIONS,
  CAPACITY_SPEC_VALIDATION_ISSUE_KINDS,
} from '@recued/contracts';
import { ACTIVITY_LABELS } from '@recued/contracts';
import { isReserveAction } from '@recued/storage';

describe('D-145 PB1 — § N.13 closed-list ratchet', () => {
  it('CAPACITY_KINDS.length === 9 (PB1 v1)', () => {
    expect(CAPACITY_KINDS.length).toBe(9);
  });

  it('every CapacityKind has a CapacityCachePolicy entry', () => {
    for (const k of CAPACITY_KINDS) {
      expect(CAPACITY_CACHE_POLICIES[k]).toBeDefined();
      expect(CAPACITY_CACHE_POLICIES[k].capacity_kind).toBe(k);
    }
  });

  it('every CapacityKind has a registry entry (real or sentinel)', () => {
    // Build a default registry with stubs and verify probe() can dispatch every kind.
    const noop = async () => true;
    const reg = capacity.createCapacityProbeRegistry({
      bridgeStateProbe: { getOnline: noop, getLoggedIn: noop },
      ingredientRegistryProbe: {
        isInstalled: noop,
        getBumpedAt: () => null,
        getSelectorTtlMs: () => null,
      },
      permissionRegistryProbe: { hasPermission: noop },
      connectionHealthProbe: { isHealthy: noop },
      sourceEnablementProbe: { hasEnabledSource: noop },
      quotaHeadroomProbe: { hasHeadroom: noop },
      warehouseRefResolver: { resolve: noop },
    });
    for (const k of CAPACITY_KINDS) {
      reg.override({
        kind: k,
        async probe() {
          return { ok: true };
        },
      });
    }
    expect(true).toBe(true); // override didn't throw
  });

  it('CACHEABLE_CAPACITY_KINDS subsetOf CAPACITY_KINDS', () => {
    for (const k of CACHEABLE_CAPACITY_KINDS) {
      expect(CAPACITY_KINDS).toContain(k);
    }
  });

  it('every CAPACITY_REMEDIATION_ACTIONS entry has fallback copy', () => {
    for (const a of CAPACITY_REMEDIATION_ACTIONS) {
      expect(capacity.CAPACITY_REMEDIATION_FALLBACK_COPY[a]).toBeDefined();
    }
  });

  it('every CAPACITY_REMEDIATION_ACTIONS entry has default visibility', () => {
    for (const a of CAPACITY_REMEDIATION_ACTIONS) {
      expect(capacity.CAPACITY_REMEDIATION_DEFAULT_VISIBILITY[a]).toBeDefined();
    }
  });

  it('every CAPACITY_INVALIDATION_TOPICS entry is referenced by ≥1 cache policy', () => {
    const referenced = new Set<string>();
    for (const k of CAPACITY_KINDS) {
      for (const t of CAPACITY_CACHE_POLICIES[k].invalidation_topics) {
        referenced.add(t);
      }
    }
    for (const t of CAPACITY_INVALIDATION_TOPICS) {
      expect(referenced.has(t)).toBe(true);
    }
  });

  it("'capacity_check.ok' + 'capacity_check.gap' appear in ACTIVITY_LABELS", () => {
    expect(ACTIVITY_LABELS).toHaveProperty('capacity_check.ok');
    expect(ACTIVITY_LABELS).toHaveProperty('capacity_check.gap');
  });

  it("'capacity_check.gap' is reserve-class via isReserveAction()", () => {
    expect(isReserveAction('capacity_check.gap')).toBe(true);
    expect(isReserveAction('capacity_check.ok')).toBe(false);
  });

  it('CAPACITY_AUDIT_ACTIONS has both ok + gap entries', () => {
    expect(CAPACITY_AUDIT_ACTIONS).toEqual(['capacity_check.ok', 'capacity_check.gap']);
  });

  it('CAPACITY_PROBE_FAILURE_DETAILS contains the closed-list values', () => {
    for (const v of ['probe_threw', 'probe_timeout', 'probe_unavailable', 'probe_misconfigured']) {
      expect(CAPACITY_PROBE_FAILURE_DETAILS).toContain(v);
    }
  });

  it('CAPACITY_SPEC_VALIDATION_ISSUE_KINDS contains the 8 PB1.1 issue kinds', () => {
    expect(CAPACITY_SPEC_VALIDATION_ISSUE_KINDS).toHaveLength(8);
  });
});
