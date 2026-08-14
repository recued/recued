/** D-145 PB1 — fault-injection tests (§ N.17). */

import { describe, expect, it } from 'vitest';

import * as capacity from '../capacity/index.js';
import { type CapacitySpec } from '@recued/contracts';

import {
  buildStubProbeDeps,
  connKey,
  createStubControls,
} from './fixtures/d-145-pb1/stub-deps.js';

const buildHarness = (probeTimeoutMs = 100) => {
  const controls = createStubControls();
  const probeDeps = buildStubProbeDeps(controls);
  const invalidationSource = capacity.createCapacityInvalidationSource();
  const cache = capacity.createCapacityCache({ invalidationSource });
  const registry = capacity.createCapacityProbeRegistry({
    ...probeDeps,
    probeTimeoutMs,
  });
  const counters = capacity.createEmptyCounters();
  const audit: { action: string; detail: string }[] = [];
  const auditEmitter = capacity.createCapacityAuditEmitter({
    logActivity(entry) {
      audit.push({ action: entry.action, detail: entry.detail ?? '' });
    },
  });
  const [transparencyEmitter, transparency] =
    capacity.createCapturingTransparencyEmitter();
  return {
    controls,
    registry,
    cache,
    audit,
    transparency,
    counters,
    auditEmitter,
    transparencyEmitter,
    invalidationSource,
  };
};

const walk = (h: ReturnType<typeof buildHarness>, spec: CapacitySpec) =>
  capacity.walkCapacities({
    spec,
    registry: h.registry,
    cache: h.cache,
    ctx: {
      audit_emitter: h.auditEmitter,
      transparency_emitter: h.transparencyEmitter,
      counters: h.counters,
    },
  });

describe('D-145 PB1 — § N.17 FI1 probe timeout', () => {
  it('hanging probe is mapped to repair_capacity_probe via probe_timeout', async () => {
    const h = buildHarness(50);
    h.controls.hangOnKind.add('bridge_online');
    const result = await walk(h, {
      capacities: [{ kind: 'bridge_online' }],
      remediations: {
        bridge_online: {
          action: 'show_bridge_install_prompt',
          user_facing_copy: 'Install.',
        },
      },
    });
    if (result.ok) throw new Error('unreachable');
    expect(result.remediation.action).toBe('repair_capacity_probe');
    expect(h.counters.probe_errors.bridge_online).toBe(1);
  });
});

describe('D-145 PB1 — § N.17 FI4 audit emitter rejection', () => {
  it('walker still returns a result + counters track the failure', async () => {
    const controls = createStubControls();
    controls.bridgeOnline = false;
    const probeDeps = buildStubProbeDeps(controls);
    const cache = capacity.createCapacityCache();
    const registry = capacity.createCapacityProbeRegistry(probeDeps);
    const counters = capacity.createEmptyCounters();
    const failingAudit: capacity.CapacityAuditEmitter = {
      async emitOk() {
        throw new Error('audit down');
      },
      async emitGap() {
        throw new Error('audit down');
      },
    };
    const [transparencyEmitter] = capacity.createCapturingTransparencyEmitter();
    const result = await capacity.walkCapacities({
      spec: {
        capacities: [{ kind: 'bridge_online' }],
        remediations: {
          bridge_online: {
            action: 'show_bridge_install_prompt',
            user_facing_copy: 'Install.',
          },
        },
      },
      registry,
      cache,
      ctx: {
        audit_emitter: failingAudit,
        transparency_emitter: transparencyEmitter,
        counters,
      },
    });
    expect(result.ok).toBe(false);
    expect(counters.audit_emit_failures).toBe(1);
  });
});

describe('D-145 PB1 — § N.17 FI5 transparency emitter rejection', () => {
  it('walker still returns a result + counters track the failure', async () => {
    const h = buildHarness();
    h.controls.bridgeOnline = false;
    const failingTransparency: capacity.CapacityTransparencyEmitter = {
      async emit() {
        throw new Error('renderer down');
      },
    };
    const result = await capacity.walkCapacities({
      spec: {
        capacities: [{ kind: 'bridge_online' }],
        remediations: {
          bridge_online: {
            action: 'show_bridge_install_prompt',
            user_facing_copy: 'Install.',
          },
        },
      },
      registry: h.registry,
      cache: h.cache,
      ctx: {
        audit_emitter: h.auditEmitter,
        transparency_emitter: failingTransparency,
        counters: h.counters,
      },
    });
    expect(result.ok).toBe(false);
    expect(h.counters.transparency_emit_failures).toBe(1);
  });
});

describe('D-145 PB1 — § N.17 FI8 disabled Source after cached pass', () => {
  it('cached pass + invalidation + next walk halts with enroll_connection', async () => {
    const h = buildHarness();
    h.controls.connectionHealth.set(connKey('hubspot', 'task'), true);
    h.controls.enabledSources.set(connKey('hubspot', 'task'), true);
    const r1 = await walk(h, {
      capacities: [{ kind: 'connection_active', vendor: 'hubspot', entity: 'task' }],
      remediations: {
        'connection_active:hubspot:task': {
          action: 'enroll_connection',
          user_facing_copy: 'Enroll.',
        },
      },
    });
    expect(r1.ok).toBe(true);
    h.controls.enabledSources.set(connKey('hubspot', 'task'), false);
    h.invalidationSource.publish({
      topic: 'connection.disabled',
      vendor: 'hubspot',
      entity: 'task',
    });
    const r2 = await walk(h, {
      capacities: [{ kind: 'connection_active', vendor: 'hubspot', entity: 'task' }],
      remediations: {
        'connection_active:hubspot:task': {
          action: 'enroll_connection',
          user_facing_copy: 'Enroll.',
        },
      },
    });
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error('unreachable');
    expect(r2.remediation.action).toBe('enroll_connection');
  });
});

describe('D-145 PB1 — § N.17 FI2 stale cache row', () => {
  it('elapsed TTL re-runs the probe', async () => {
    const h = buildHarness();
    h.controls.bridgeOnline = true;
    let now = 1_000_000;
    const result1 = await capacity.walkCapacities({
      spec: {
        capacities: [{ kind: 'bridge_online' }],
        remediations: {
          bridge_online: {
            action: 'show_bridge_install_prompt',
            user_facing_copy: 'Install.',
          },
        },
      },
      registry: h.registry,
      cache: h.cache,
      ctx: {
        audit_emitter: h.auditEmitter,
        transparency_emitter: h.transparencyEmitter,
        counters: h.counters,
        now: () => now,
      },
    });
    expect(result1.ok).toBe(true);
    // Advance past 30s TTL.
    now += 31_000;
    h.controls.bridgeOnline = false;
    const result2 = await capacity.walkCapacities({
      spec: {
        capacities: [{ kind: 'bridge_online' }],
        remediations: {
          bridge_online: {
            action: 'show_bridge_install_prompt',
            user_facing_copy: 'Install.',
          },
        },
      },
      registry: h.registry,
      cache: h.cache,
      ctx: {
        audit_emitter: h.auditEmitter,
        transparency_emitter: h.transparencyEmitter,
        counters: h.counters,
        now: () => now,
      },
    });
    expect(result2.ok).toBe(false);
  });
});
