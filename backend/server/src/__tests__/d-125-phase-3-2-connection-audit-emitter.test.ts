/** D-125 Phase 3.2 — server-executor audit emitter wiring tests.
 *
 *  `createConnectionAuditEmitter` is the boot-site translator that
 *  converts an adapter-level `ConnectionAuditEmission` into the
 *  `ActivityEntry` shape the audit-log store consumes. Pinned here:
 *
 *    1. `kind` maps 1:1 to a `connection_<kind>` activity action code.
 *    2. `target` carries the connection record `name` for queryable
 *       per-connection filtering without parsing the JSON detail.
 *    3. `detail` is JSON-encoded `ConnectionAuditDetail` with subtype,
 *       status, duration_ms, error?, and `intent` resolved from the
 *       wrapper manifest's `permission` field.
 *    4. `intent` falls back to empty string when the manifest doesn't
 *       declare a permission (forward-compat — pre-D-125 wrappers
 *       haven't been migrated yet, the row still lands).
 *    5. `intent` is empty when the manifest is missing entirely
 *       (e.g. the wrapper was uninstalled mid-call between adapter
 *       dispatch and emit).
 *    6. `timestamp` mirrors `emission.ts` (call start time), so the
 *       row sorts by dispatch start, not by emission completion.
 *    7. `bytes_in` / `bytes_out` flow through to detail when present;
 *       omitted when absent (P3.2 shell never sets them, but P4.x
 *       handlers will). */

import { describe, expect, it } from 'vitest';
import type { IngredientManifest } from '@recued/contracts';
import type { ActivityEntry, AppendOptions, AuditEntry, AuditLogStore } from '@recued/storage';
import type { ConnectionAuditEmission } from '@recued/ingredients';
import { createConnectionAuditEmitter, type ConnectionAuditDetail } from '../server-executor.js';
import { createManifestRegistry } from '../manifest-loader.js';

// ────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────

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
  // createManifestRegistry pulls bundled community/ingredients by
  // default — pass an empty dir + register what each test needs so
  // the tests are deterministic and independent of disk state.
  const reg = createManifestRegistry('/tmp/__d125-p3-2-empty-dir-does-not-exist');
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
  ...(overrides.content_sha256 !== undefined
    ? { content_sha256: overrides.content_sha256 }
    : {}),
  ...(overrides.chunked_upload !== undefined
    ? { chunked_upload: overrides.chunked_upload }
    : {}),
  ...(overrides.error !== undefined ? { error: overrides.error } : {}),
});
// ⚠ This helper REBUILDS its input from a fixed field list rather than
// spreading `overrides`, so a field added to `ConnectionAuditEmission` is
// silently dropped here and the test asserts the HELPER, not the emitter.
// (D-217 § 6.3 hit exactly that — it failed loudly, but a test written to
// assert ABSENCE would have passed vacuously.) Add new fields above.

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('createConnectionAuditEmitter (D-125 P3.2)', () => {
  it('maps kind → connection_<kind> action code per transport', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([mkManifest({ slug: 'wrapper', permission: 'p' })]);
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({ slug: 'wrapper', kind: 'api' }));
    await emit(mkEmission({ slug: 'wrapper', kind: 'mcp' }));
    await emit(mkEmission({ slug: 'wrapper', kind: 'notification' }));

    expect(rows.map((r) => r.action))
      .toEqual(['connection_api', 'connection_mcp', 'connection_notification']);
  });

  it('uses connection name as activity target', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([mkManifest({ slug: 'wrapper', permission: 'p' })]);
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({ slug: 'wrapper', name: 'team-slack' }));

    expect(rows[0]?.target).toBe('team-slack');
  });

  it('mirrors emission.ts to activity timestamp (call-start ordering)', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([mkManifest({ slug: 'wrapper', permission: 'p' })]);
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({ slug: 'wrapper', ts: 1_700_000_000_500 }));

    expect(rows[0]?.timestamp).toBe(1_700_000_000_500);
  });

  it('encodes ConnectionAuditDetail in JSON detail string', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([mkManifest({ slug: 'slack-post', permission: 'notification_send' })]);
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({
      slug: 'slack-post',
      kind: 'notification',
      name: 'team-slack',
      subtype: 'slack',
      status: 'ok',
      duration_ms: 87,
    }));

    const detail = JSON.parse(rows[0]?.detail ?? '{}') as ConnectionAuditDetail;
    expect(detail).toEqual({
      subtype: 'slack',
      status: 'ok',
      duration_ms: 87,
      intent: 'notification_send',
    });
  });

  it('resolves intent from wrapper manifest.permission', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([
      mkManifest({ slug: 'ticket-reader-hubspot', permission: 'hubspot_read' }),
      mkManifest({ slug: 'connection', permission: 'connection.direct' }),
    ]);
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({ slug: 'ticket-reader-hubspot', kind: 'api' }));
    await emit(mkEmission({ slug: 'connection', kind: 'api' }));

    const intents = rows.map((r) => (JSON.parse(r.detail ?? '{}') as ConnectionAuditDetail).intent);
    expect(intents).toEqual(['hubspot_read', 'connection.direct']);
  });

  it('intent is empty string when manifest declares no permission', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([mkManifest({ slug: 'no-perm-wrapper' })]); // no `permission`
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({ slug: 'no-perm-wrapper' }));

    const detail = JSON.parse(rows[0]?.detail ?? '{}') as ConnectionAuditDetail;
    expect(detail.intent).toBe('');
  });

  it('intent is empty string when the manifest is missing entirely', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([]); // no manifests at all
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({ slug: 'uninstalled-wrapper' }));

    const detail = JSON.parse(rows[0]?.detail ?? '{}') as ConnectionAuditDetail;
    expect(detail.intent).toBe('');
  });

  it('flows error fields through detail when status=error', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([mkManifest({ slug: 'wrapper', permission: 'p' })]);
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({
      slug: 'wrapper',
      status: 'error',
      error: { code: 'CONNECTION_NOT_FOUND', message: 'no record' },
    }));

    const detail = JSON.parse(rows[0]?.detail ?? '{}') as ConnectionAuditDetail;
    expect(detail).toMatchObject({
      status: 'error',
      error: { code: 'CONNECTION_NOT_FOUND', message: 'no record' },
    });
  });

  it('flows bytes_in / bytes_out through detail when present', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([mkManifest({ slug: 'wrapper', permission: 'p' })]);
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({ slug: 'wrapper', bytes_in: 100, bytes_out: 250 }));

    const detail = JSON.parse(rows[0]?.detail ?? '{}') as ConnectionAuditDetail;
    expect(detail.bytes_in).toBe(100);
    expect(detail.bytes_out).toBe(250);
  });

  it('omits bytes / error / subtype from detail when absent on emission', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([mkManifest({ slug: 'wrapper', permission: 'p' })]);
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({ slug: 'wrapper' }));

    const detail = JSON.parse(rows[0]?.detail ?? '{}') as ConnectionAuditDetail;
    expect(detail).not.toHaveProperty('bytes_in');
    expect(detail).not.toHaveProperty('bytes_out');
    expect(detail).not.toHaveProperty('content_sha256');
    expect(detail).not.toHaveProperty('error');
    expect(detail).not.toHaveProperty('subtype');
  });

  it('D-216 carries the one-shot upload content hash onto the durable row', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([mkManifest({ slug: 'wrapper', permission: 'p' })]);
    const emit = createConnectionAuditEmitter(registry, log);
    const hash = 'a'.repeat(64);

    await emit(mkEmission({ slug: 'wrapper', bytes_out: 6, content_sha256: hash }));

    const detail = JSON.parse(rows[0]?.detail ?? '{}') as ConnectionAuditDetail;
    expect(detail.content_sha256).toBe(hash);
  });

  it('D-217 § 6.3 — carries chunked-walk telemetry onto the DURABLE row', async () => {
    // ⛔ The point of the field is that it survives to disk. `bytes_out` alone
    // cannot tell a complete upload from an abandoned one that moved the same
    // volume, and `committed_unconfirmed` is an `ok` row like `committed` — so
    // the forensic question "did this act finish, and how far did it get" is
    // answerable ONLY from here.
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([mkManifest({ slug: 'wrapper', permission: 'p' })]);
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({
      slug: 'wrapper',
      status: 'error',
      bytes_out: 32,
      chunked_upload: {
        outcome: 'failed', chunks_sent: 2, chunk_count: 4, requests: 4,
      },
    }));

    const detail = JSON.parse(rows[0]?.detail ?? '{}') as ConnectionAuditDetail;
    expect(detail.chunked_upload).toEqual({
      outcome: 'failed', chunks_sent: 2, chunk_count: 4, requests: 4,
    });
    expect(detail.bytes_out).toBe(32);
  });

  it('omits chunked_upload for an ordinary single-request call', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([mkManifest({ slug: 'wrapper', permission: 'p' })]);
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({ slug: 'wrapper', bytes_out: 32 }));

    const detail = JSON.parse(rows[0]?.detail ?? '{}') as ConnectionAuditDetail;
    expect(detail).not.toHaveProperty('chunked_upload');
  });

  it('produces unique activity_id per emission', async () => {
    const { log, rows } = mkAuditLog();
    const registry = mkRegistry([mkManifest({ slug: 'wrapper', permission: 'p' })]);
    const emit = createConnectionAuditEmitter(registry, log);

    await emit(mkEmission({ slug: 'wrapper' }));
    await emit(mkEmission({ slug: 'wrapper' }));

    expect(rows[0]?.activity_id).not.toBe(rows[1]?.activity_id);
    expect(rows[0]?.activity_id).toMatch(/^cn-\d+-[a-z0-9]+$/);
  });
});
