/** D-145 PB1.4 — per-capacity probe correctness tests. */

import { describe, expect, it } from 'vitest';

import * as capacity from '../capacity/index.js';
import {
  buildStubProbeDeps,
  connKey,
  createStubControls,
} from './fixtures/d-145-pb1/stub-deps.js';

const minimalCtx = () => ({
  audit_emitter: {
    async emitOk() {},
    async emitGap() {},
  },
  transparency_emitter: { async emit() {} },
});

describe('D-145 PB1.4 — bridge_online probe', () => {
  it('returns ok when state.getOnline returns true', async () => {
    const controls = createStubControls();
    controls.bridgeOnline = true;
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe({ kind: 'bridge_online' }, minimalCtx());
    expect(r.ok).toBe(true);
  });

  it('returns not-ok with bridge_offline detail', async () => {
    const controls = createStubControls();
    controls.bridgeOnline = false;
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe({ kind: 'bridge_online' }, minimalCtx());
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('bridge_offline');
  });
});

describe('D-145 PB1.4 — ingredient_installed probe', () => {
  it('returns ok when slug is installed', async () => {
    const controls = createStubControls();
    controls.installedIngredients.add('webchat-gemini');
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe(
      { kind: 'ingredient_installed', slug: 'webchat-gemini' },
      minimalCtx(),
    );
    expect(r.ok).toBe(true);
  });

  it('returns not-ok with ingredient_missing when slug is unknown', async () => {
    const controls = createStubControls();
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe(
      { kind: 'ingredient_installed', slug: 'never-installed' },
      minimalCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('ingredient_missing');
  });
});

describe('D-145 PB1.4 — logged_in probe', () => {
  it('returns ok when site is in loggedInSites', async () => {
    const controls = createStubControls();
    controls.loggedInSites.add('gemini.google.com');
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe(
      { kind: 'logged_in', site: 'gemini.google.com' },
      minimalCtx(),
    );
    expect(r.ok).toBe(true);
  });

  it('returns logged_out detail when site missing', async () => {
    const controls = createStubControls();
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe(
      { kind: 'logged_in', site: 'gemini.google.com' },
      minimalCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('logged_out');
  });
});

describe('D-145 PB1.4 — annotation probe', () => {
  it('passes when ref resolves', async () => {
    const controls = createStubControls();
    controls.warehouseRefs.add('data.contact.X.aliases.facebook');
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe(
      { kind: 'annotation', ref: 'data.contact.X.aliases.facebook' },
      minimalCtx(),
    );
    expect(r.ok).toBe(true);
  });

  it('returns annotation_missing when ref is unknown', async () => {
    const controls = createStubControls();
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe(
      { kind: 'annotation', ref: 'data.contact.X.aliases.facebook' },
      minimalCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('annotation_missing');
  });
});

describe('D-145 PB1.4 — annotation_not_required sentinel', () => {
  it('always returns ok', async () => {
    const controls = createStubControls();
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe({ kind: 'annotation_not_required' }, minimalCtx());
    expect(r.ok).toBe(true);
  });
});

describe('D-145 PB1.4 — permission_grant probe', () => {
  it('passes when permission is granted', async () => {
    const controls = createStubControls();
    controls.permissions.add('write_enrichment');
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe(
      { kind: 'permission_grant', permission: 'write_enrichment' },
      minimalCtx(),
    );
    expect(r.ok).toBe(true);
  });

  it('returns permission_missing when not granted', async () => {
    const controls = createStubControls();
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe(
      { kind: 'permission_grant', permission: 'write_enrichment' },
      minimalCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('permission_missing');
  });
});

describe('D-145 PB1.4 — connection_active probe (multi-Source, joined)', () => {
  it('passes only when both connection healthy AND source enabled', async () => {
    const controls = createStubControls();
    controls.connectionHealth.set(connKey('hubspot', 'task'), true);
    controls.enabledSources.set(connKey('hubspot', 'task'), true);
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe(
      { kind: 'connection_active', vendor: 'hubspot', entity: 'task' },
      minimalCtx(),
    );
    expect(r.ok).toBe(true);
  });

  it('returns no_active_connection when only one side passes (joined contract)', async () => {
    const controls = createStubControls();
    controls.connectionHealth.set(connKey('hubspot', 'task'), false);
    controls.enabledSources.set(connKey('hubspot', 'task'), true);
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe(
      { kind: 'connection_active', vendor: 'hubspot', entity: 'task' },
      minimalCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('no_active_connection');
  });

  it('returns no_active_connection when both sides fail', async () => {
    const controls = createStubControls();
    controls.connectionHealth.set(connKey('hubspot', 'task'), false);
    controls.enabledSources.set(connKey('hubspot', 'task'), false);
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe(
      { kind: 'connection_active', vendor: 'hubspot', entity: 'task' },
      minimalCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('no_active_connection');
  });

  it('Codex P1 fold — joined probe rejects when no SINGLE connection_id is both healthy AND enabled', async () => {
    // Vendor has two enrolled connections (conn-A, conn-B). Each
    // satisfies one of the two predicates but neither satisfies
    // both. Pre-fold, the existential `isHealthy` + `hasEnabledSource`
    // pair would falsely report ok. Post-fold, the joined probe
    // requires a single connection_id satisfying both — returns null.
    const controls = createStubControls();
    // Make the aggregate-level isHealthy/hasEnabledSource each pass:
    controls.connectionHealth.set(connKey('hubspot', 'task'), true);
    controls.enabledSources.set(connKey('hubspot', 'task'), true);

    // Compose a probe with enumeration variants showing the two
    // predicates apply to disjoint connection_ids.
    const probeDeps = buildStubProbeDeps(controls);
    const reg = capacity.createCapacityProbeRegistry({
      ...probeDeps,
      connectionActivenessProbe: capacity.composeConnectionActivenessProbe(
        {
          isHealthy: () => true,
          listHealthyConnectionIds: () => ['conn-A'], // only A is healthy
        },
        {
          hasEnabledSource: () => true,
          listEnabledConnectionIds: () => ['conn-B'], // only B is enabled
        },
      ),
    });
    const r = await reg.probe(
      { kind: 'connection_active', vendor: 'hubspot', entity: 'task' },
      minimalCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('no_active_connection');
  });

  it('Codex P1 fold — joined probe finds the intersection when overlap exists', async () => {
    const controls = createStubControls();
    controls.connectionHealth.set(connKey('hubspot', 'task'), true);
    controls.enabledSources.set(connKey('hubspot', 'task'), true);
    const probeDeps = buildStubProbeDeps(controls);
    const reg = capacity.createCapacityProbeRegistry({
      ...probeDeps,
      connectionActivenessProbe: capacity.composeConnectionActivenessProbe(
        {
          isHealthy: () => true,
          listHealthyConnectionIds: () => ['conn-A', 'conn-B'],
        },
        {
          hasEnabledSource: () => true,
          listEnabledConnectionIds: () => ['conn-B', 'conn-C'],
        },
      ),
    });
    const r = await reg.probe(
      { kind: 'connection_active', vendor: 'hubspot', entity: 'task' },
      minimalCtx(),
    );
    expect(r.ok).toBe(true);
  });

  it('scoped requirement (connection_id supplied) checks that specific id', async () => {
    const controls = createStubControls();
    controls.connectionHealth.set(connKey('hubspot', 'task', 'conn-42'), true);
    controls.enabledSources.set(connKey('hubspot', 'task', 'conn-42'), true);
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe(
      {
        kind: 'connection_active',
        vendor: 'hubspot',
        entity: 'task',
        connection_id: 'conn-42',
      },
      minimalCtx(),
    );
    expect(r.ok).toBe(true);
  });
});

describe('D-145 PB1.4 — pool_quota_available probe', () => {
  it('passes when free pool has headroom', async () => {
    const controls = createStubControls();
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe(
      { kind: 'pool_quota_available', pool: 'free' },
      minimalCtx(),
    );
    expect(r.ok).toBe(true);
  });

  it('returns quota_exhausted when no headroom', async () => {
    const controls = createStubControls();
    controls.poolHeadroom.set('free', false);
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe(
      { kind: 'pool_quota_available', pool: 'free' },
      minimalCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('quota_exhausted');
  });
});

describe('D-145 PB1.4 — selector_freshness probe (24h vs 7d boundary)', () => {
  it('passes when bumpedAt is within ttl', async () => {
    const controls = createStubControls();
    const now = Date.now();
    controls.bumpedAt.set('webchat-gemini', now - 1000);
    controls.selectorTtlMs.set('webchat-gemini', 7 * 24 * 60 * 60_000);
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe(
      { kind: 'selector_freshness', slug: 'webchat-gemini' },
      { ...minimalCtx(), now: () => now },
    );
    expect(r.ok).toBe(true);
  });

  it('returns selector_stale when past ttl', async () => {
    const controls = createStubControls();
    const now = Date.now();
    controls.bumpedAt.set('webchat-gemini', now - 8 * 24 * 60 * 60_000);
    controls.selectorTtlMs.set('webchat-gemini', 7 * 24 * 60 * 60_000);
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe(
      { kind: 'selector_freshness', slug: 'webchat-gemini' },
      { ...minimalCtx(), now: () => now },
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('selector_stale');
  });

  it('returns selector_unknown when bumpedAt is missing', async () => {
    const controls = createStubControls();
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    const r = await reg.probe(
      { kind: 'selector_freshness', slug: 'never-bumped' },
      minimalCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('selector_unknown');
  });
});

describe('D-145 PB1.4 — registry overrides', () => {
  it('override replaces probe in-place', async () => {
    const controls = createStubControls();
    const reg = capacity.createCapacityProbeRegistry(buildStubProbeDeps(controls));
    reg.override({
      kind: 'bridge_online',
      async probe() {
        return { ok: true };
      },
    });
    controls.bridgeOnline = false; // would otherwise return false
    const r = await reg.probe({ kind: 'bridge_online' }, minimalCtx());
    expect(r.ok).toBe(true);
    reg.resetOverrides();
    const r2 = await reg.probe({ kind: 'bridge_online' }, minimalCtx());
    expect(r2.ok).toBe(false);
  });
});
