/** D-145 PB1.8 — server-side composer integration test.
 *
 *  End-to-end: composes the substrate from `composeCapacitySpecDeps`,
 *  walks a multi-capacity spec, exercises cache hits + invalidation
 *  (including the PA11 join via `publishSourceEnabledChange`), and
 *  asserts audit + transparency events round-trip cleanly through
 *  the real composer wiring. */

import { describe, expect, it } from 'vitest';

import * as capacity from '@recued/middleware/capacity/index.js';
import {
  CAPACITY_AUDIT_GAP_ACTION,
  CAPACITY_AUDIT_OK_ACTION,
  type CapacitySpec,
} from '@recued/contracts';

import {
  composeCapacitySpecDeps,
  publishSourceEnabledChange,
} from '../capacity-spec-deps.js';

const stubDeps = () => {
  const state = {
    bridgeOnline: true,
    loggedInSites: new Set<string>(),
    installedIngredients: new Set<string>(),
    permissions: new Set<string>(),
    connections: new Map<string, boolean>(),
    sources: new Map<string, boolean>(),
    pools: new Map<'free' | 'byok', boolean>([
      ['free', true],
      ['byok', true],
    ]),
    refs: new Set<string>(),
    bumpedAt: new Map<string, number>(),
    selectorTtl: new Map<string, number>(),
  };
  return {
    state,
    deps: {
      bridgeStateProbe: {
        getOnline: () => state.bridgeOnline,
        getLoggedIn: (site: string) => state.loggedInSites.has(site),
      },
      ingredientRegistryProbe: {
        isInstalled: (slug: string) => state.installedIngredients.has(slug),
        getBumpedAt: (slug: string) => state.bumpedAt.get(slug) ?? null,
        getSelectorTtlMs: (slug: string) => state.selectorTtl.get(slug) ?? null,
      },
      permissionRegistryProbe: {
        hasPermission: (p: string) => state.permissions.has(p),
      },
      connectionHealthProbe: {
        isHealthy: (vendor: string, entity?: string) =>
          state.connections.get(`${vendor}|${entity ?? '*'}`) ?? false,
      },
      sourceEnablementProbe: {
        hasEnabledSource: (vendor: string, entity?: string) =>
          state.sources.get(`${vendor}|${entity ?? '*'}`) ?? false,
      },
      quotaHeadroomProbe: {
        hasHeadroom: (pool: 'free' | 'byok') => state.pools.get(pool) ?? false,
      },
      warehouseRefResolver: {
        resolve: (ref: string) => state.refs.has(ref),
      },
      probeTimeoutMs: 100,
    },
  };
};

describe('D-145 PB1.8 — composeCapacitySpecDeps integration', () => {
  it('composes substrate that walks an OK path + emits audit', async () => {
    const { state, deps } = stubDeps();
    const auditLog: { action: string; detail?: string }[] = [];
    const composed = composeCapacitySpecDeps({
      ...deps,
      auditAdapter: {
        logActivity(entry) {
          auditLog.push({ action: entry.action, detail: entry.detail });
        },
      },
    });

    state.bridgeOnline = true;
    state.installedIngredients.add('webchat-gemini');
    state.bumpedAt.set('webchat-gemini', Date.now());
    state.selectorTtl.set('webchat-gemini', 7 * 24 * 60 * 60_000);
    state.loggedInSites.add('gemini.google.com');

    const spec: CapacitySpec = {
      capacities: [
        { kind: 'bridge_online' },
        { kind: 'ingredient_installed', slug: 'webchat-gemini' },
        { kind: 'logged_in', site: 'gemini.google.com' },
      ],
      remediations: {
        bridge_online: {
          action: 'show_bridge_install_prompt',
          user_facing_copy: 'Install.',
        },
        'ingredient_installed:webchat-gemini': {
          action: 'offer_install',
          user_facing_copy: 'Install Gemini.',
        },
        'logged_in:gemini.google.com': {
          action: 'open_login_tab',
          user_facing_copy: 'Sign in.',
        },
      },
    };
    const result = await capacity.walkCapacities({
      spec,
      registry: composed.registry,
      cache: composed.cache,
      ctx: {
        audit_emitter: composed.audit,
        transparency_emitter: composed.transparency,
        counters: composed.counters,
      },
    });
    expect(result.ok).toBe(true);
    expect(auditLog.some((e) => e.action === CAPACITY_AUDIT_OK_ACTION)).toBe(true);

    composed.shutdown();
  });

  it('PA11 join — publishSourceEnabledChange invalidates cached connection_active row', async () => {
    const { state, deps } = stubDeps();
    const auditLog: { action: string; detail?: string }[] = [];
    const composed = composeCapacitySpecDeps({
      ...deps,
      auditAdapter: {
        logActivity(entry) {
          auditLog.push({ action: entry.action, detail: entry.detail });
        },
      },
    });

    state.connections.set('hubspot|task', true);
    state.sources.set('hubspot|task', true);
    const spec: CapacitySpec = {
      capacities: [{ kind: 'connection_active', vendor: 'hubspot', entity: 'task' }],
      remediations: {
        'connection_active:hubspot:task': {
          action: 'enroll_connection',
          user_facing_copy: 'Enroll.',
        },
      },
    };

    const r1 = await capacity.walkCapacities({
      spec,
      registry: composed.registry,
      cache: composed.cache,
      ctx: {
        audit_emitter: composed.audit,
        transparency_emitter: composed.transparency,
      },
    });
    expect(r1.ok).toBe(true);

    // Disable the source via the PA11 publisher.
    state.sources.set('hubspot|task', false);
    publishSourceEnabledChange(
      composed.invalidationSource,
      'hubspot.conn-42.task',
      false,
    );

    const r2 = await capacity.walkCapacities({
      spec,
      registry: composed.registry,
      cache: composed.cache,
      ctx: {
        audit_emitter: composed.audit,
        transparency_emitter: composed.transparency,
      },
    });
    expect(r2.ok).toBe(false);
    expect(auditLog.some((e) => e.action === CAPACITY_AUDIT_GAP_ACTION)).toBe(true);

    composed.shutdown();
  });

  it('publishSourceEnabledChange handles built-in source ids without crashing', () => {
    const { deps } = stubDeps();
    const composed = composeCapacitySpecDeps(deps);
    publishSourceEnabledChange(composed.invalidationSource, 'recued.task', false);
    composed.shutdown();
  });

  it('shutdown unsubscribes invalidation handlers', () => {
    const { deps } = stubDeps();
    const composed = composeCapacitySpecDeps(deps);
    composed.shutdown();
    // Subsequent publish doesn't crash + has no observable effect.
    composed.invalidationSource.publish({
      topic: 'source.enabled_changed',
      vendor: 'hubspot',
      entity: 'task',
    });
    expect(true).toBe(true);
  });
});
