/** D-145 PB1 — golden fixtures (§ N.15) end-to-end paths. */

import { describe, expect, it } from 'vitest';

import * as capacity from '../capacity/index.js';
import {
  ALL_FIXTURES,
  F1_SOCIAL_FACEBOOK_LOOKUP,
  F3_ENRICHMENT_CONNECTION_BACKED,
  F4_BRIDGE_OFFLINE_ANYWHERE,
  F5_SOURCE_DISABLED_PA11_JOIN,
  F6_QUOTA_EXHAUSTED,
  F7_DUPLICATE_INGREDIENT_REQUIREMENTS,
  F8_PROBE_ERROR_PATH,
} from './fixtures/d-145-pb1/index.js';
import {
  buildStubProbeDeps,
  connKey,
  createStubControls,
} from './fixtures/d-145-pb1/stub-deps.js';

const buildHarness = () => {
  const controls = createStubControls();
  const probeDeps = buildStubProbeDeps(controls);
  const invalidationSource = capacity.createCapacityInvalidationSource();
  const cache = capacity.createCapacityCache({ invalidationSource });
  const registry = capacity.createCapacityProbeRegistry({
    ...probeDeps,
    probeTimeoutMs: 100,
  });
  const audit: { action: string; detail: string }[] = [];
  const auditEmitter = capacity.createCapacityAuditEmitter({
    logActivity(entry) {
      audit.push({ action: entry.action, detail: entry.detail ?? '' });
    },
  });
  const [transparencyEmitter, transparency] =
    capacity.createCapturingTransparencyEmitter();
  return { controls, registry, cache, audit, transparency, auditEmitter, transparencyEmitter, invalidationSource };
};

const walk = (h: ReturnType<typeof buildHarness>, spec: any) =>
  capacity.walkCapacities({
    spec,
    registry: h.registry,
    cache: h.cache,
    ctx: {
      audit_emitter: h.auditEmitter,
      transparency_emitter: h.transparencyEmitter,
    },
  });

describe('D-145 PB1 — F1 social.facebook.lookup', () => {
  it('all-fail path halts at bridge_online', async () => {
    const h = buildHarness();
    h.controls.bridgeOnline = false;
    const result = await walk(h, F1_SOCIAL_FACEBOOK_LOOKUP.spec);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.gap.kind).toBe('bridge_online');
  });

  it('happy path passes when every probe satisfied', async () => {
    const h = buildHarness();
    h.controls.bridgeOnline = true;
    h.controls.installedIngredients.add('facebook-profile-reader');
    h.controls.loggedInSites.add('facebook.com');
    h.controls.warehouseRefs.add(
      'data.contact.contact-pii-7f3e.aliases.facebook',
    );
    const result = await walk(h, F1_SOCIAL_FACEBOOK_LOOKUP.spec);
    expect(result.ok).toBe(true);
  });
});

describe('D-145 PB1 — F3 enrichment.connection-backed', () => {
  it('halts when source disabled', async () => {
    const h = buildHarness();
    h.controls.connectionHealth.set(connKey('hubspot', 'deal'), true);
    h.controls.enabledSources.set(connKey('hubspot', 'deal'), false);
    const result = await walk(h, F3_ENRICHMENT_CONNECTION_BACKED.spec);
    expect(result.ok).toBe(false);
  });
});

describe('D-145 PB1 — F4 bridge-offline-anywhere', () => {
  it('halts with show_bridge_install_prompt', async () => {
    const h = buildHarness();
    h.controls.bridgeOnline = false;
    const result = await walk(h, F4_BRIDGE_OFFLINE_ANYWHERE.spec);
    if (result.ok) throw new Error('unreachable');
    expect(result.remediation.action).toBe('show_bridge_install_prompt');
  });
});

describe('D-145 PB1 — F5 source-disabled-pa11-join', () => {
  it('toggling source.enabled=false invalidates cached pass + halts next walk', async () => {
    const h = buildHarness();
    h.controls.connectionHealth.set(connKey('hubspot', 'task'), true);
    h.controls.enabledSources.set(connKey('hubspot', 'task'), true);
    const r1 = await walk(h, F5_SOURCE_DISABLED_PA11_JOIN.spec);
    expect(r1.ok).toBe(true);
    h.controls.enabledSources.set(connKey('hubspot', 'task'), false);
    h.invalidationSource.publish({
      topic: 'connection.disabled',
      vendor: 'hubspot',
      entity: 'task',
    });
    const r2 = await walk(h, F5_SOURCE_DISABLED_PA11_JOIN.spec);
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error('unreachable');
    expect(r2.remediation.action).toBe('enroll_connection');
  });
});

describe('D-145 PB1 — F6 quota-exhausted', () => {
  it('halts with check_pool_quota when free pool exhausted', async () => {
    const h = buildHarness();
    h.controls.poolHeadroom.set('free', false);
    const result = await walk(h, F6_QUOTA_EXHAUSTED.spec);
    if (result.ok) throw new Error('unreachable');
    expect(result.remediation.action).toBe('check_pool_quota');
  });
});

describe('D-145 PB1 — F7 duplicate-ingredient-requirements', () => {
  it('halts with per-key remediation, not a kind-only fallback', async () => {
    const h = buildHarness();
    h.controls.installedIngredients.add('calendar-reader');
    // crm-contact-reader missing — expect halt on it
    const result = await walk(h, F7_DUPLICATE_INGREDIENT_REQUIREMENTS.spec);
    if (result.ok) throw new Error('unreachable');
    expect(result.gap_key).toBe('ingredient_installed:crm-contact-reader');
    expect(result.remediation.user_facing_copy).toBe('Install CRM contact reader.');
  });
});

describe('D-145 PB1 — F8 probe-error-path', () => {
  it('throwing probe maps to repair_capacity_probe with engine_internal visibility', async () => {
    const h = buildHarness();
    h.controls.throwOnKind.add('bridge_online');
    const result = await walk(h, F8_PROBE_ERROR_PATH.spec);
    if (result.ok) throw new Error('unreachable');
    expect(result.remediation.action).toBe('repair_capacity_probe');
    // engine_internal — no transparency emit.
    expect(h.transparency).toHaveLength(0);
  });
});

describe('D-145 PB1 — fixture catalogue ratchet', () => {
  it('ALL_FIXTURES exposes 8 entries with unique ids', () => {
    expect(ALL_FIXTURES).toHaveLength(8);
    const ids = ALL_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(8);
  });
});
