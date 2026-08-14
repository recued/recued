/** D-145 PB1.2 — walker correctness tests.
 *
 *  Covers halt-on-first-gap ordering, cache hit/miss, correlation
 *  IDs, visibility split, audit + transparency emit, defensive
 *  validation. */

import { describe, expect, it, beforeEach } from 'vitest';

import * as capacity from '../capacity/index.js';
import {
  CAPACITY_AUDIT_GAP_ACTION,
  CAPACITY_AUDIT_OK_ACTION,
  type CapacityCheckGapTransparencyEvent,
  type CapacitySpec,
} from '@recued/contracts';

import {
  buildStubProbeDeps,
  connKey,
  createStubControls,
  type StubProbeControls,
} from './fixtures/d-145-pb1/stub-deps.js';
import {
  F1_SOCIAL_FACEBOOK_LOOKUP,
  F2_BRIDGE_DOM_LOOKUP,
  F4_BRIDGE_OFFLINE_ANYWHERE,
  F6_QUOTA_EXHAUSTED,
} from './fixtures/d-145-pb1/index.js';

interface Harness {
  controls: StubProbeControls;
  composed: ReturnType<typeof composeAdHoc>;
  audit: { action: string; detail: string }[];
  transparency: CapacityCheckGapTransparencyEvent[];
}

const composeAdHoc = (controls: StubProbeControls) => {
  const audit: { action: string; detail: string }[] = [];
  const transparency: CapacityCheckGapTransparencyEvent[] = [];

  const probeDeps = buildStubProbeDeps(controls);
  const invalidationSource = capacity.createCapacityInvalidationSource();
  const cache = capacity.createCapacityCache({ invalidationSource });
  const registry = capacity.createCapacityProbeRegistry(probeDeps);
  const counters = capacity.createEmptyCounters();
  const auditEmitter = capacity.createCapacityAuditEmitter({
    logActivity(entry) {
      audit.push({ action: entry.action, detail: entry.detail ?? '' });
    },
  });
  const [transparencyEmitter] = (() => {
    const [t, events] = capacity.createCapturingTransparencyEmitter();
    transparency.push(...events);
    // mutable handle: we re-bind by returning the captured array
    return [t, events] as const;
  })();
  const tEvents: CapacityCheckGapTransparencyEvent[] = [];
  const tEmitter: capacity.CapacityTransparencyEmitter = {
    async emit(event) {
      tEvents.push(event);
    },
  };
  return {
    cache,
    registry,
    counters,
    invalidationSource,
    audit,
    transparency: tEvents,
    auditEmitter,
    transparencyEmitter: tEmitter,
    transparencyCapture: transparency,
  };
};

const buildHarness = (): Harness => {
  const controls = createStubControls();
  const composed = composeAdHoc(controls);
  return {
    controls,
    composed,
    audit: composed.audit,
    transparency: composed.transparency,
  };
};

const walkWith = async (h: Harness, spec: CapacitySpec, walk_id?: string) =>
  capacity.walkCapacities({
    spec,
    registry: h.composed.registry,
    cache: h.composed.cache,
    ctx: {
      audit_emitter: h.composed.auditEmitter,
      transparency_emitter: h.composed.transparencyEmitter,
      counters: h.composed.counters,
      ...(walk_id ? { walk_id } : {}),
    },
  });

describe('D-145 PB1.2 — walker happy path', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('returns ok with one check per requirement when every probe passes', async () => {
    h.controls.bridgeOnline = true;
    h.controls.installedIngredients.add('web-page-reader');
    h.controls.bumpedAt.set('web-page-reader', Date.now() - 1000);
    h.controls.selectorTtlMs.set('web-page-reader', 7 * 24 * 60 * 60_000);
    h.controls.loggedInSites.add('example.com');

    const result = await walkWith(h, F2_BRIDGE_DOM_LOOKUP.spec);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.checks).toHaveLength(5);
    // Audit emit for ok branch.
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]!.action).toBe(CAPACITY_AUDIT_OK_ACTION);
    // No transparency emit on success.
    expect(h.transparency).toHaveLength(0);
  });

  it('annotation_not_required sentinel passes without invoking probes', async () => {
    h.controls.bridgeOnline = true;
    h.controls.installedIngredients.add('web-page-reader');
    h.controls.bumpedAt.set('web-page-reader', Date.now());
    h.controls.selectorTtlMs.set('web-page-reader', 7 * 24 * 60 * 60_000);
    h.controls.loggedInSites.add('example.com');

    const result = await walkWith(h, F2_BRIDGE_DOM_LOOKUP.spec);
    if (!result.ok) throw new Error('unreachable');
    const sentinel = result.checks.find((c) => c.kind === 'annotation_not_required');
    expect(sentinel).toBeDefined();
    expect(sentinel!.cached).toBe(false);
    expect(sentinel!.ok).toBe(true);
  });
});

describe('D-145 PB1.2 — halt-on-first-gap ordering', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('halts on the first failing requirement; subsequent reqs are not probed', async () => {
    // bridge_online is false; ingredient + login + annotation are also unset
    // — but the walker should halt on the bridge req first.
    h.controls.bridgeOnline = false;
    const result = await walkWith(h, F1_SOCIAL_FACEBOOK_LOOKUP.spec);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.gap.kind).toBe('bridge_online');
    expect(result.checks).toHaveLength(1);
    expect(result.remediation.action).toBe('show_bridge_install_prompt');
  });

  it('halts on the second req when first passes but second fails', async () => {
    h.controls.bridgeOnline = true;
    // ingredient not installed
    const result = await walkWith(h, F1_SOCIAL_FACEBOOK_LOOKUP.spec);
    if (result.ok) throw new Error('unreachable');
    expect(result.gap.kind).toBe('ingredient_installed');
    expect(result.checks).toHaveLength(2);
  });

  it('emits user_visible transparency event on user_visible gaps', async () => {
    h.controls.bridgeOnline = false;
    await walkWith(h, F4_BRIDGE_OFFLINE_ANYWHERE.spec);
    expect(h.transparency).toHaveLength(1);
    expect(h.transparency[0]!.kind).toBe('capacity_check.gap');
  });

  it('audit emits capacity_check.gap row', async () => {
    h.controls.bridgeOnline = false;
    await walkWith(h, F4_BRIDGE_OFFLINE_ANYWHERE.spec);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]!.action).toBe(CAPACITY_AUDIT_GAP_ACTION);
  });
});

describe('D-145 PB1.2 — cache hit / miss', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('second walk against the same spec serves from cache (cached: true)', async () => {
    h.controls.bridgeOnline = true;
    h.controls.installedIngredients.add('web-page-reader');
    h.controls.bumpedAt.set('web-page-reader', Date.now());
    h.controls.selectorTtlMs.set('web-page-reader', 7 * 24 * 60 * 60_000);
    h.controls.loggedInSites.add('example.com');

    await walkWith(h, F2_BRIDGE_DOM_LOOKUP.spec);
    const second = await walkWith(h, F2_BRIDGE_DOM_LOOKUP.spec);
    if (!second.ok) throw new Error('unreachable');
    // bridge_online + ingredient_installed + selector_freshness + logged_in
    // are all cacheable. annotation_not_required is non-cacheable.
    const cacheableHits = second.checks.filter(
      (c) => c.kind !== 'annotation_not_required',
    );
    for (const c of cacheableHits) expect(c.cached).toBe(true);
  });

  it('annotation kind is non-cacheable — every walk re-probes', async () => {
    h.controls.warehouseRefs.add(
      'data.contact.contact-pii-7f3e.aliases.facebook',
    );
    const spec: CapacitySpec = {
      capacities: [
        {
          kind: 'annotation',
          ref: 'data.contact.contact-pii-7f3e.aliases.facebook',
        },
      ],
      remediations: {
        'annotation:data.contact.contact-pii-7f3e.aliases.facebook': {
          action: 'lazy_ask_user',
          user_facing_copy: 'Need handle.',
        },
      },
    };
    const r1 = await walkWith(h, spec);
    const r2 = await walkWith(h, spec);
    if (!r1.ok || !r2.ok) throw new Error('unreachable');
    expect(r1.checks[0]!.cached).toBe(false);
    expect(r2.checks[0]!.cached).toBe(false);
  });

  it('cache row drops when invalidation topic fires', async () => {
    h.controls.bridgeOnline = true;
    await walkWith(h, F4_BRIDGE_OFFLINE_ANYWHERE.spec);
    h.controls.bridgeOnline = false; // probe will now return false
    h.composed.invalidationSource.publish({
      topic: 'bridge.online_state_changed',
    });
    const result = await walkWith(h, F4_BRIDGE_OFFLINE_ANYWHERE.spec);
    expect(result.ok).toBe(false);
  });
});

describe('D-145 PB1.2 — correlation IDs', () => {
  it('assigns walk_id when not provided + propagates run_id / intent_id / primitive', async () => {
    const h = buildHarness();
    h.controls.bridgeOnline = false;
    const result = await capacity.walkCapacities({
      spec: F4_BRIDGE_OFFLINE_ANYWHERE.spec,
      registry: h.composed.registry,
      cache: h.composed.cache,
      ctx: {
        audit_emitter: h.composed.auditEmitter,
        transparency_emitter: h.composed.transparencyEmitter,
        counters: h.composed.counters,
        run_id: 'run-1',
        intent_id: 'intent-9',
        primitive: 'bridge.dispatch',
        recipe_id: 'recipe-X',
      },
    });
    if (result.ok) throw new Error('unreachable');
    expect(result.correlation.walk_id).toBeDefined();
    expect(result.correlation.run_id).toBe('run-1');
    expect(result.correlation.intent_id).toBe('intent-9');
    expect(result.correlation.primitive).toBe('bridge.dispatch');
    expect(result.correlation.recipe_id).toBe('recipe-X');
  });

  it('honors injected walk_id (deterministic test mode)', async () => {
    const h = buildHarness();
    h.controls.bridgeOnline = false;
    const result = await walkWith(h, F4_BRIDGE_OFFLINE_ANYWHERE.spec, 'walk-fixed');
    if (result.ok) throw new Error('unreachable');
    expect(result.correlation.walk_id).toBe('walk-fixed');
  });
});

describe('D-145 PB1.2 — visibility split', () => {
  it('engine_internal gaps do NOT emit transparency', async () => {
    const h = buildHarness();
    h.controls.bridgeOnline = false;
    const result = await walkWith(h, {
      capacities: [{ kind: 'bridge_online' }],
      remediations: {
        bridge_online: {
          action: 'noop',
          user_facing_copy: '',
          visibility: 'engine_internal',
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(h.transparency).toHaveLength(0);
    // Audit still emits.
    expect(h.audit.some((e) => e.action === CAPACITY_AUDIT_GAP_ACTION)).toBe(true);
  });

  it('user_visible (default for show_bridge_install_prompt) emits transparency', async () => {
    const h = buildHarness();
    h.controls.bridgeOnline = false;
    await walkWith(h, F4_BRIDGE_OFFLINE_ANYWHERE.spec);
    expect(h.transparency).toHaveLength(1);
  });
});

describe('D-145 PB1.2 — connection_active multi-Source determinism', () => {
  it('passes only when both connection healthy AND source enabled (joined)', async () => {
    const h = buildHarness();
    h.controls.connectionHealth.set(connKey('hubspot', 'task'), true);
    h.controls.enabledSources.set(connKey('hubspot', 'task'), false);
    const r1 = await walkWith(h, {
      capacities: [{ kind: 'connection_active', vendor: 'hubspot', entity: 'task' }],
      remediations: {
        'connection_active:hubspot:task': {
          action: 'enroll_connection',
          user_facing_copy: 'Enroll.',
        },
      },
    });
    expect(r1.ok).toBe(false);
    if (r1.ok) throw new Error('unreachable');
    expect(r1.checks[0]!.detail).toBe('no_active_connection');

    h.controls.enabledSources.set(connKey('hubspot', 'task'), true);
    h.composed.invalidationSource.publish({
      topic: 'connection.disabled',
      vendor: 'hubspot',
      entity: 'task',
    });
    const r2 = await walkWith(h, {
      capacities: [{ kind: 'connection_active', vendor: 'hubspot', entity: 'task' }],
      remediations: {
        'connection_active:hubspot:task': {
          action: 'enroll_connection',
          user_facing_copy: 'Enroll.',
        },
      },
    });
    expect(r2.ok).toBe(true);
  });
});

describe('D-145 PB1.2 — empty capacities', () => {
  it('vacuously ok with empty checks array', async () => {
    const h = buildHarness();
    const result = await walkWith(h, { capacities: [], remediations: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.checks).toHaveLength(0);
  });
});

describe('D-145 PB1.2 — defensive validation', () => {
  it('throws CapacitySpecValidationError when spec is malformed', async () => {
    const h = buildHarness();
    await expect(
      walkWith(h, {
        capacities: [{ kind: 'bridge_online' }],
        remediations: {}, // missing
      }),
    ).rejects.toThrow(/CAPACITY_SPEC_MALFORMED|capacity_spec malformed/);
  });
});

describe('D-145 PB1.2 — best-effort emit', () => {
  it('audit emit failure does not block walk result', async () => {
    const h = buildHarness();
    h.controls.bridgeOnline = false;
    const failingAudit: capacity.CapacityAuditEmitter = {
      async emitOk() {
        throw new Error('audit down');
      },
      async emitGap() {
        throw new Error('audit down');
      },
    };
    const result = await capacity.walkCapacities({
      spec: F4_BRIDGE_OFFLINE_ANYWHERE.spec,
      registry: h.composed.registry,
      cache: h.composed.cache,
      ctx: {
        audit_emitter: failingAudit,
        transparency_emitter: h.composed.transparencyEmitter,
        counters: h.composed.counters,
      },
    });
    expect(result.ok).toBe(false);
    expect(h.composed.counters.audit_emit_failures).toBe(1);
  });
});

describe('D-145 PB1.2 — pool quota path', () => {
  it('returns gap with check_pool_quota when free pool exhausted', async () => {
    const h = buildHarness();
    h.controls.poolHeadroom.set('free', false);
    const result = await walkWith(h, F6_QUOTA_EXHAUSTED.spec);
    if (result.ok) throw new Error('unreachable');
    expect(result.remediation.action).toBe('check_pool_quota');
  });
});
