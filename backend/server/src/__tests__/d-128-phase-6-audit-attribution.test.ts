/** D-128 Phase 6 — connection-audit emitter platform_scope attribution.
 *
 *  Pins the boot-site translation contract for the new
 *  `platform_scope` field on `ConnectionAuditDetail`:
 *    1. `emission.platform_scope` flows through to detail when present.
 *    2. Field is omitted from detail when absent on the emission
 *       (recipes that don't operate on a specific platform-reference
 *       scope leave it unset).
 *    3. Empty strings are treated as absent — no half-populated
 *       `"platform_scope":""` rows that look queryable but never match.
 *    4. Vendor reconcilers that stamp the scope alongside recipe_id +
 *       step_id produce rows queryable by all three for forensic
 *       investigations. */

import { describe, expect, it } from 'vitest';
import type { IngredientManifest } from '@recued/contracts';
import type { ActivityEntry, AppendOptions, AuditEntry, AuditLogStore } from '@recued/storage';
import type { ConnectionAuditEmission } from '@recued/ingredients';
import { createConnectionAuditEmitter, type ConnectionAuditDetail } from '../server-executor.js';
import { createManifestRegistry } from '../manifest-loader.js';

const mkManifest = (overrides: Partial<IngredientManifest> & { permission?: string } = {}): IngredientManifest =>
  ({
    slug: overrides.slug ?? 'deal-reader-hubspot',
    name: overrides.name ?? 'Deal reader HubSpot',
    description: overrides.description ?? 'Read HubSpot deals',
    author: overrides.author ?? 'recued-core',
    kind: overrides.kind ?? 'connection',
    version: overrides.version ?? 1,
    category: overrides.category ?? 'data',
    risk_tier: overrides.risk_tier ?? 'read',
    input: overrides.input ?? { connection_kind: 'api', connection: null },
    output: overrides.output ?? {},
    ...(overrides.permission !== undefined ? { permission: overrides.permission } : {}),
  } as IngredientManifest);

const mkRegistry = (manifests: IngredientManifest[]) => {
  const reg = createManifestRegistry('/tmp/__d128-p6-empty-dir-does-not-exist');
  for (const m of manifests) reg.register(m);
  return reg;
};

interface MockSink {
  log: AuditLogStore;
  rows: ActivityEntry[];
}

const mkAuditLog = (): MockSink => {
  const rows: ActivityEntry[] = [];
  const log: AuditLogStore = {
    append: async (_entry: AuditEntry, _opts?: AppendOptions) => {},
    listRecent: async () => [],
    listByRecipe: async () => [],
    listByChannelSession: async () => [],
    listByCognitionSession: async () => [],
    listByCorrelation: async () => [],
    get: async () => null,
    clearOlderThan: async () => 0,
    clearByRecipe: async () => 0,
    exportAll: async () => [],
    size: async () => 0,
    clearAll: async () => {},
    logActivity: async (entry: ActivityEntry, _opts?: AppendOptions) => {
      rows.push(entry);
    },
    listActivities: async () => [],
    exportActivities: async () => [],
    clearOldestActivities: async () => 0,
    clearOldestEntries: async () => 0,
    countReserveEntries: async () => 0,
    countReserveActivities: async () => 0,
    lastSuccessfulBridgeDispatch: async () => null,
  };
  return { log, rows };
};

const mkEmission = (overrides: Partial<ConnectionAuditEmission> = {}): ConnectionAuditEmission => ({
  slug: overrides.slug ?? 'deal-reader-hubspot',
  kind: overrides.kind ?? 'api',
  name: overrides.name ?? 'acme-hubspot',
  status: overrides.status ?? 'ok',
  duration_ms: overrides.duration_ms ?? 240,
  ts: overrides.ts ?? 1_700_000_000_000,
  ...(overrides.subtype !== undefined ? { subtype: overrides.subtype } : {}),
  ...(overrides.bytes_in !== undefined ? { bytes_in: overrides.bytes_in } : {}),
  ...(overrides.bytes_out !== undefined ? { bytes_out: overrides.bytes_out } : {}),
  ...(overrides.error !== undefined ? { error: overrides.error } : {}),
  ...(overrides.recipe_id !== undefined ? { recipe_id: overrides.recipe_id } : {}),
  ...(overrides.step_id !== undefined ? { step_id: overrides.step_id } : {}),
  ...(overrides.platform_scope !== undefined ? { platform_scope: overrides.platform_scope } : {}),
});

describe('D-128 P6 — createConnectionAuditEmitter platform_scope attribution', () => {
  it('flows platform_scope through to detail when present on emission', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([
      mkManifest({ slug: 'deal-reader-hubspot', permission: 'hubspot_read' }),
    ]);
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({
      slug: 'deal-reader-hubspot',
      kind: 'api',
      name: 'acme-hubspot',
      recipe_id: 'reconcile-hubspot-deals',
      step_id: 'fetch_updated',
      platform_scope: 'connection.api.hubspot.deal',
    }));

    const detail = JSON.parse(rows[0]?.detail ?? '{}') as ConnectionAuditDetail;
    expect(detail).toMatchObject({
      status: 'ok',
      intent: 'hubspot_read',
      recipe_id: 'reconcile-hubspot-deals',
      step_id: 'fetch_updated',
      platform_scope: 'connection.api.hubspot.deal',
    });
  });

  it('omits platform_scope from detail when absent on emission', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([
      mkManifest({ slug: 'slack-post', permission: 'notification_send', kind: 'connection' }),
    ]);
    const emit = createConnectionAuditEmitter(registry, log);

    // Plain notification call — no platform-reference scope context.
    await emit(mkEmission({
      slug: 'slack-post',
      kind: 'notification',
      name: 'team-slack',
      recipe_id: 'detect-deal-risk',
      step_id: 'notify_owner',
    }));

    const detail = JSON.parse(rows[0]?.detail ?? '{}') as ConnectionAuditDetail;
    expect(detail).toHaveProperty('recipe_id');
    expect(detail).not.toHaveProperty('platform_scope');
  });

  it('treats empty-string platform_scope as absent (no half-populated rows)', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([
      mkManifest({ slug: 'deal-reader-hubspot', permission: 'hubspot_read' }),
    ]);
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({
      slug: 'deal-reader-hubspot',
      platform_scope: '',
    }));

    const detail = JSON.parse(rows[0]?.detail ?? '{}') as ConnectionAuditDetail;
    expect(detail).not.toHaveProperty('platform_scope');
  });

  it('error-path emission still carries platform_scope into detail', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([
      mkManifest({ slug: 'deal-reader-hubspot', permission: 'hubspot_read' }),
    ]);
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({
      slug: 'deal-reader-hubspot',
      kind: 'api',
      status: 'error',
      error: { code: 'CONNECTION_NOT_FOUND', message: 'no record' },
      recipe_id: 'reconcile-hubspot-deals',
      step_id: 'fetch_updated',
      platform_scope: 'connection.api.hubspot.deal',
    }));

    const detail = JSON.parse(rows[0]?.detail ?? '{}') as ConnectionAuditDetail;
    expect(detail).toMatchObject({
      status: 'error',
      error: { code: 'CONNECTION_NOT_FOUND', message: 'no record' },
      recipe_id: 'reconcile-hubspot-deals',
      step_id: 'fetch_updated',
      platform_scope: 'connection.api.hubspot.deal',
    });
  });

  it('platform_scope coexists with subtype + bytes telemetry on the same row', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([
      mkManifest({ slug: 'deal-reader-hubspot', permission: 'hubspot_read' }),
    ]);
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({
      slug: 'deal-reader-hubspot',
      kind: 'api',
      subtype: 'rest',
      bytes_in: 1024,
      bytes_out: 256,
      platform_scope: 'connection.api.hubspot.deal',
    }));

    const detail = JSON.parse(rows[0]?.detail ?? '{}') as ConnectionAuditDetail;
    expect(detail).toMatchObject({
      subtype: 'rest',
      bytes_in: 1024,
      bytes_out: 256,
      platform_scope: 'connection.api.hubspot.deal',
    });
  });

  it('forensic query shape: platform_scope queryable across rows', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([
      mkManifest({ slug: 'deal-reader-hubspot', permission: 'hubspot_read' }),
      mkManifest({ slug: 'opp-reader-salesforce', permission: 'salesforce_read' }),
    ]);
    const emit = createConnectionAuditEmitter(registry, log);

    // Fan a few calls across two vendors; the platform_scope field is
    // what makes "show every HubSpot deal API call" cheap without
    // joining recipe_id back through the recipe-row catalogue.
    await emit(mkEmission({
      slug: 'deal-reader-hubspot',
      platform_scope: 'connection.api.hubspot.deal',
      ts: 1,
    }));
    await emit(mkEmission({
      slug: 'opp-reader-salesforce',
      platform_scope: 'connection.api.salesforce.opportunity',
      ts: 2,
    }));
    await emit(mkEmission({
      slug: 'deal-reader-hubspot',
      platform_scope: 'connection.api.hubspot.deal',
      ts: 3,
    }));

    const scopes = rows.map((r) => {
      const d = JSON.parse(r.detail ?? '{}') as ConnectionAuditDetail;
      return d.platform_scope;
    });
    expect(scopes).toEqual([
      'connection.api.hubspot.deal',
      'connection.api.salesforce.opportunity',
      'connection.api.hubspot.deal',
    ]);
  });
});
