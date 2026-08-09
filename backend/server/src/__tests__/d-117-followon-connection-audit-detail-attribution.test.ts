/** D-117 follow-on (post-D-127) — server-executor connection audit
 *  emitter step-identity tests.
 *
 *  Pins the boot-site translation contract:
 *    1. `emission.recipe_id` + `step_id` flow through to the JSON-encoded
 *       `ConnectionAuditDetail` when present.
 *    2. Both fields are omitted from detail when absent on the emission
 *       (direct-rpc callers without engine context).
 *    3. Empty strings on either field are treated as absent — the field
 *       is omitted from detail entirely so the resulting JSON doesn't
 *       contain `"recipe_id":""` (queryable but never matchable). */

import { describe, expect, it } from 'vitest';
import type { IngredientManifest } from '@recued/contracts';
import type { ActivityEntry, AppendOptions, AuditEntry, AuditLogStore } from '@recued/storage';
import type { ConnectionAuditEmission } from '@recued/ingredients';
import { createConnectionAuditEmitter, type ConnectionAuditDetail } from '../server-executor.js';
import { createManifestRegistry } from '../manifest-loader.js';

const mkManifest = (overrides: Partial<IngredientManifest> & { permission?: string } = {}): IngredientManifest =>
  ({
    slug: overrides.slug ?? 'slack-post',
    name: overrides.name ?? 'Slack post',
    description: overrides.description ?? 'Post to Slack',
    author: overrides.author ?? 'recued-core',
    kind: overrides.kind ?? 'connection',
    version: overrides.version ?? 1,
    category: overrides.category ?? 'action',
    risk_tier: overrides.risk_tier ?? 'write',
    input: overrides.input ?? { connection_kind: 'notification', connection: null, text: null },
    output: overrides.output ?? {},
    ...(overrides.permission !== undefined ? { permission: overrides.permission } : {}),
  } as IngredientManifest);

const mkRegistry = (manifests: IngredientManifest[]) => {
  const reg = createManifestRegistry('/tmp/__d117-followon-empty-dir-does-not-exist');
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
    listWindow: async () => [],
    listPendingExchangeRefs: async () => [],
    listInboundContractIds: async () => [],
    listRecent: async () => [],
    listByRecipe: async () => [],
    listByChannelSession: async () => [],
    listByCognitionSession: async () => [],
    listByCorrelation: async () => [],
    listByExchangeRef: async () => [],
    listByPeerContract: async () => [],
    listByDish: async () => [],
    latestByDishes: async () => new Map(),
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
  slug: overrides.slug ?? 'slack-post',
  kind: overrides.kind ?? 'notification',
  name: overrides.name ?? 'team-slack',
  status: overrides.status ?? 'ok',
  duration_ms: overrides.duration_ms ?? 120,
  ts: overrides.ts ?? 1_700_000_000_000,
  ...(overrides.subtype !== undefined ? { subtype: overrides.subtype } : {}),
  ...(overrides.bytes_in !== undefined ? { bytes_in: overrides.bytes_in } : {}),
  ...(overrides.bytes_out !== undefined ? { bytes_out: overrides.bytes_out } : {}),
  ...(overrides.error !== undefined ? { error: overrides.error } : {}),
  ...(overrides.recipe_id !== undefined ? { recipe_id: overrides.recipe_id } : {}),
  ...(overrides.step_id !== undefined ? { step_id: overrides.step_id } : {}),
});

describe('createConnectionAuditEmitter — step identity attribution', () => {
  it('flows recipe_id + step_id through to detail when present on emission', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([mkManifest({ slug: 'slack-post', permission: 'notification_send' })]);
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({
      slug: 'slack-post',
      kind: 'notification',
      name: 'team-slack',
      subtype: 'slack',
      recipe_id: 'detect-deal-risk-hubspot',
      step_id: 'notify_owner',
    }));

    const detail = JSON.parse(rows[0]?.detail ?? '{}') as ConnectionAuditDetail;
    expect(detail).toMatchObject({
      subtype: 'slack',
      status: 'ok',
      intent: 'notification_send',
      recipe_id: 'detect-deal-risk-hubspot',
      step_id: 'notify_owner',
    });
  });

  it('omits recipe_id + step_id from detail when absent on emission', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([mkManifest({ slug: 'slack-post', permission: 'notification_send' })]);
    const emit = createConnectionAuditEmitter(registry, log);

    // Direct-rpc caller — no engine stepMeta, no attribution.
    await emit(mkEmission({ slug: 'slack-post', kind: 'notification' }));

    const detail = JSON.parse(rows[0]?.detail ?? '{}') as ConnectionAuditDetail;
    expect(detail).not.toHaveProperty('recipe_id');
    expect(detail).not.toHaveProperty('step_id');
  });

  it('treats empty-string recipe_id / step_id as absent (no half-populated rows)', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([mkManifest({ slug: 'wrapper', permission: 'p' })]);
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({
      slug: 'wrapper',
      recipe_id: '',
      step_id: '',
    }));

    const detail = JSON.parse(rows[0]?.detail ?? '{}') as ConnectionAuditDetail;
    expect(detail).not.toHaveProperty('recipe_id');
    expect(detail).not.toHaveProperty('step_id');
  });

  it('partial attribution (step_id only) propagates step_id without recipe_id', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([mkManifest({ slug: 'wrapper', permission: 'p' })]);
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({
      slug: 'wrapper',
      step_id: 'fetch_ticket',
    }));

    const detail = JSON.parse(rows[0]?.detail ?? '{}') as ConnectionAuditDetail;
    expect(detail.step_id).toBe('fetch_ticket');
    expect(detail).not.toHaveProperty('recipe_id');
  });

  it('error-path emission still carries identity into detail', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([mkManifest({ slug: 'ticket-reader-hubspot', permission: 'hubspot_read' })]);
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({
      slug: 'ticket-reader-hubspot',
      kind: 'api',
      status: 'error',
      error: { code: 'CONNECTION_NOT_FOUND', message: 'no record' },
      recipe_id: 'detect-ticket-risk-hubspot',
      step_id: 'fetch_ticket',
    }));

    const detail = JSON.parse(rows[0]?.detail ?? '{}') as ConnectionAuditDetail;
    expect(detail).toMatchObject({
      status: 'error',
      error: { code: 'CONNECTION_NOT_FOUND', message: 'no record' },
      recipe_id: 'detect-ticket-risk-hubspot',
      step_id: 'fetch_ticket',
    });
  });
});
