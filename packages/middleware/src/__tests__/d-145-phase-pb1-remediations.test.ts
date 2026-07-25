/** D-145 PB1.6 — remediation registry tests. */

import { describe, expect, it } from 'vitest';

import * as capacity from '../capacity/index.js';
import { CAPACITY_REMEDIATION_ACTIONS } from '@recued/contracts';

describe('D-145 PB1.6 — fallback copy registry', () => {
  it('every action in CAPACITY_REMEDIATION_ACTIONS has a fallback copy entry', () => {
    for (const action of CAPACITY_REMEDIATION_ACTIONS) {
      const copy = capacity.CAPACITY_REMEDIATION_FALLBACK_COPY[action];
      expect(typeof copy).toBe('string');
    }
  });

  it('repair_capacity_probe has non-empty fallback copy', () => {
    expect(
      capacity.CAPACITY_REMEDIATION_FALLBACK_COPY.repair_capacity_probe.length,
    ).toBeGreaterThan(0);
  });

  it('noop fallback copy is empty string', () => {
    expect(capacity.CAPACITY_REMEDIATION_FALLBACK_COPY.noop).toBe('');
  });
});

describe('D-145 PB1.6 — default visibility registry', () => {
  it('every action has a default visibility', () => {
    for (const action of CAPACITY_REMEDIATION_ACTIONS) {
      const v = capacity.CAPACITY_REMEDIATION_DEFAULT_VISIBILITY[action];
      expect(['user_visible', 'engine_internal']).toContain(v);
    }
  });

  it('mark_ingredient_degraded defaults to engine_internal', () => {
    expect(capacity.CAPACITY_REMEDIATION_DEFAULT_VISIBILITY.mark_ingredient_degraded).toBe(
      'engine_internal',
    );
  });

  it('repair_capacity_probe defaults to engine_internal', () => {
    expect(capacity.CAPACITY_REMEDIATION_DEFAULT_VISIBILITY.repair_capacity_probe).toBe(
      'engine_internal',
    );
  });

  it('show_bridge_install_prompt defaults to user_visible', () => {
    expect(capacity.CAPACITY_REMEDIATION_DEFAULT_VISIBILITY.show_bridge_install_prompt).toBe(
      'user_visible',
    );
  });

  it('noop defaults to engine_internal', () => {
    expect(capacity.CAPACITY_REMEDIATION_DEFAULT_VISIBILITY.noop).toBe('engine_internal');
  });
});

describe('D-145 PB1.6 — registry completeness', () => {
  it('CAPACITY_REMEDIATION_ACTIONS includes all 10 actions', () => {
    expect(CAPACITY_REMEDIATION_ACTIONS).toHaveLength(10);
  });
});
