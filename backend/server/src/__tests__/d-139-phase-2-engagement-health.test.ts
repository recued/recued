/** D-139 Phase 2 — Connection-page UX rpc handler test suite.
 *
 *  Covers spec § P2 acceptance:
 *    - Per-entity health surface renders for HubSpot (5 entities)
 *      + Salesforce (3 + winning call).
 *    - Vendor inferred from `connection.config.vendor`; unsupported
 *      vendor / missing vendor / unknown connection rejects cleanly.
 *    - last_pulled_at = the cycle row's last_run_at when complete
 *      (D-184 retired the separate runonce row).
 *    - last_error reflects the cycle row's most-recent failed run.
 *    - api_calls_consumed_today + budget_utilization_pct + rate-control
 *      state come from the rate-control store.
 *    - Salesforce capability re-probe round-trip persists capability
 *      rows + auto-creates PushTopics + detects winning_call_entity
 *      change.
 *    - HubSpot reprobe rejects with hint at `collection.connection.probe`.
 *
 *  Spec: docs/d-139-spec.md § A.8, § P2 acceptance. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RpcError,
  CONNECTION_VENDOR_ENTITIES,
  buildConnectionVendorEntity,
  type ConnectionAuth,
  type ConnectionRecord,
  type ConnectionVendorEntity,
  type EngagementCapabilityFlags,
} from '@recued/contracts';

import { createConnectionStore, type ConnectionStoreSqlite } from '../storage/connection-store.js';
import {
  createHousekeepingStateStore,
  type HousekeepingStateStore,
} from '../housekeeping/state-store.js';
import {
  createEngagementRateControlStore,
  type EngagementRateControlStore,
} from '../storage/engagement-rate-control-store.js';
import {
  createEngagementCapabilityStore,
  type EngagementCapabilityStore,
} from '../storage/engagement-capability-store.js';
import { reconciliationTaskId } from '../housekeeping/reconciliation/vendor-reconciler.js';
import {
  handleEngagementHealth,
  handleReprobeEngagementCapabilities,
  type EngagementHealthDeps,
} from '../engagement-health-handler.js';

// ────────────────────────────────────────────────────────────────
// Fixture
// ────────────────────────────────────────────────────────────────

const FIXED_NOW = 1_714_867_200_000;

const HUBSPOT_NAME = 'acme-hubspot';
const SALESFORCE_NAME = 'acme-salesforce';

interface Fixture {
  db: Database.Database;
  connectionStore: ConnectionStoreSqlite;
  housekeepingState: HousekeepingStateStore;
  rateControlStore: EngagementRateControlStore;
  capabilityStore: EngagementCapabilityStore;
  fakeFetcher: ReturnType<typeof vi.fn>;
  fakeRefreshAuth: ReturnType<typeof vi.fn>;
  deps: EngagementHealthDeps;
}

const buildFixture = (): Fixture => {
  const db = new Database(':memory:');
  const connectionStore = createConnectionStore(db);
  const housekeepingState = createHousekeepingStateStore(db);
  const rateControlStore = createEngagementRateControlStore(db);
  const capabilityStore = createEngagementCapabilityStore(db);

  // Seed two connections — one HubSpot, one Salesforce.
  connectionStore.upsert({
    kind: 'api',
    name: HUBSPOT_NAME,
    display_name: 'Acme HubSpot',
    config_json: JSON.stringify({ vendor: 'hubspot' }),
    auth_ciphertext: 'opaque',
    enrolled_at: FIXED_NOW - 86_400_000,
    updated_at: FIXED_NOW - 86_400_000,
  });
  connectionStore.upsert({
    kind: 'api',
    name: SALESFORCE_NAME,
    display_name: 'Acme Salesforce',
    config_json: JSON.stringify({
      vendor: 'salesforce',
      base_url: 'https://acme.my.salesforce.com',
    }),
    auth_ciphertext: 'opaque',
    enrolled_at: FIXED_NOW - 86_400_000,
    updated_at: FIXED_NOW - 86_400_000,
  });

  const fakeRefreshAuth = vi.fn(
    async (connection: ConnectionRecord): Promise<ConnectionAuth> =>
      connection.auth,
  );
  const fakeFetcher = vi.fn(async () => new Response('{}', { status: 200 }));
  const lookupConnection = async (name: string): Promise<ConnectionRecord | null> => {
    const row = connectionStore.get('api', name);
    if (!row) return null;
    return {
      name: row.name,
      kind: row.kind,
      display_name: row.display_name,
      config: JSON.parse(row.config_json) as Record<string, unknown>,
      auth: {
        type: 'oauth2_refresh',
        refresh_token: 'rt',
        client_id: 'cid',
        token_endpoint: 'http://x',
        current_access_token: 'at',
      } satisfies ConnectionAuth,
      enrolled_at: row.enrolled_at,
      updated_at: row.updated_at,
    };
  };

  const deps: EngagementHealthDeps = {
    connectionStore,
    housekeepingState,
    rateControlStore,
    capabilityStore,
    lookupConnection,
    refreshAuth: fakeRefreshAuth,
    now: () => FIXED_NOW,
    fetcher: fakeFetcher as unknown as typeof fetch,
  };

  return {
    db,
    connectionStore,
    housekeepingState,
    rateControlStore,
    capabilityStore,
    fakeFetcher,
    fakeRefreshAuth,
    deps,
  };
};

// ────────────────────────────────────────────────────────────────
// engagementHealth — HubSpot
// ────────────────────────────────────────────────────────────────

describe('D-139 P2 — handleEngagementHealth (HubSpot)', () => {
  let f: Fixture;
  beforeEach(() => {
    f = buildFixture();
  });
  afterEach(() => {
    f.db.close();
  });

  it('returns 5 rows for HubSpot — one per engagement entity', () => {
    const resp = handleEngagementHealth(f.deps, { name: HUBSPOT_NAME });
    expect(resp.vendor).toBe('hubspot');
    expect(resp.rows.map((r) => r.entity).sort()).toEqual([
      'call',
      'email',
      'meeting',
      'note',
      'task',
    ]);
    // HubSpot rows never carry a capability flag.
    expect(resp.rows.every((r) => r.capability === undefined)).toBe(true);
  });

  it('seeds rate-control bucket on first read + reports zero usage', () => {
    const resp = handleEngagementHealth(f.deps, { name: HUBSPOT_NAME });
    expect(resp.daily_budget).toBe(250_000);
    for (const row of resp.rows) {
      expect(row.api_calls_consumed_today).toBe(0);
      expect(row.budget_utilization_pct).toBe(0);
      expect(row.rate_control_state).toBe('normal');
    }
  });

  it('last_pulled_at = the cycle row last_run_at when its last run completed', () => {
    const cycleTaskId = reconciliationTaskId('hubspot', 'email', HUBSPOT_NAME);
    f.housekeepingState.set({
      task_id: cycleTaskId,
      cursor: { kind: 'time', last_seen_at: 2 },
      last_run_at: FIXED_NOW - 5_000,
      last_status: 'complete',
    });

    const resp = handleEngagementHealth(f.deps, { name: HUBSPOT_NAME });
    const emailRow = resp.rows.find((r) => r.entity === 'email');
    expect(emailRow?.last_pulled_at).toBe(FIXED_NOW - 5_000);
    expect(emailRow?.last_error).toBeNull();
  });

  it('last_error surfaces when the cycle row last run failed', () => {
    const cycleTaskId = reconciliationTaskId('hubspot', 'meeting', HUBSPOT_NAME);
    f.housekeepingState.set({
      task_id: cycleTaskId,
      cursor: { kind: 'time', last_seen_at: 2 },
      last_run_at: FIXED_NOW - 1_000,
      last_status: 'error',
      last_error: 'cycle: search timeout',
    });

    const resp = handleEngagementHealth(f.deps, { name: HUBSPOT_NAME });
    const meetingRow = resp.rows.find((r) => r.entity === 'meeting');
    expect(meetingRow?.last_error).toBe('cycle: search timeout');
    expect(meetingRow?.last_pulled_at).toBeNull();
  });

  it('reflects rate-control state when budget escalates', () => {
    // Rate-control keys on the BARE connection name (what the reconciler /
    // rate-gate writes), NOT the composite `api:<name>` pk — see the health
    // handler's readUsage/readPages call sites.
    const conn_id = HUBSPOT_NAME;
    f.rateControlStore.recordUsage({
      connection_id: conn_id,
      vendor: 'hubspot',
      n: Math.ceil(250_000 * 0.85),
      now: FIXED_NOW,
    });

    const resp = handleEngagementHealth(f.deps, { name: HUBSPOT_NAME });
    expect(resp.rows[0]!.rate_control_state).toBe('degraded_30m');
    expect(resp.rows[0]!.budget_utilization_pct).toBeGreaterThanOrEqual(0.85);
    expect(resp.rows[0]!.budget_utilization_pct).toBeLessThanOrEqual(1.0);
  });

  it('rejects connection without vendor field', () => {
    f.connectionStore.upsert({
      kind: 'api',
      name: 'unscoped',
      display_name: 'Unscoped',
      config_json: '{}',
      auth_ciphertext: 'opaque',
      enrolled_at: 1,
      updated_at: 1,
    });
    expect(() =>
      handleEngagementHealth(f.deps, { name: 'unscoped' }),
    ).toThrowError(/has no vendor/);
  });

  it('rejects a connection whose vendor declares no engagement entities', () => {
    // D-192 — pipedrive is a built-in CRM vendor (crm_alias entities) but declares
    // NO engagement entity, so the registry predicate `vendorHasEngagement` rejects
    // it (replacing the retired closed `hubspot`/`salesforce` union guard).
    f.connectionStore.upsert({
      kind: 'api',
      name: 'pipedrive',
      display_name: 'Pipedrive',
      config_json: JSON.stringify({ vendor: 'pipedrive' }),
      auth_ciphertext: 'opaque',
      enrolled_at: 1,
      updated_at: 1,
    });
    expect(() =>
      handleEngagementHealth(f.deps, { name: 'pipedrive' }),
    ).toThrowError(/no engagement surface for vendor 'pipedrive'/);
  });

  it('rejects unknown connection name', () => {
    expect(() =>
      handleEngagementHealth(f.deps, { name: 'does-not-exist' }),
    ).toThrowError(/no api connection/);
  });

  it('rejects empty / non-string args', () => {
    expect(() =>
      handleEngagementHealth(f.deps, { name: '' }),
    ).toThrowError(/name is required/);
    expect(() =>
      handleEngagementHealth(f.deps, { name: '   ' }),
    ).toThrowError(/name is required/);
  });
});

// ────────────────────────────────────────────────────────────────
// engagementHealth — Salesforce
// ────────────────────────────────────────────────────────────────

describe('D-139 P2 — handleEngagementHealth (Salesforce)', () => {
  let f: Fixture;
  beforeEach(() => {
    f = buildFixture();
  });
  afterEach(() => {
    f.db.close();
  });

  it('returns 3 baseline entities pre-probe (no call entity yet)', () => {
    const resp = handleEngagementHealth(f.deps, { name: SALESFORCE_NAME });
    expect(resp.vendor).toBe('salesforce');
    expect(resp.rows.map((r) => r.entity).sort()).toEqual([
      'email_message',
      'event',
      'task',
    ]);
  });

  it('surfaces voice_call when probe says VoiceCall is queryable', () => {
    const conn_id = `api:${SALESFORCE_NAME}`;
    const flags: EngagementCapabilityFlags = {
      connection_id: conn_id,
      vendor: 'salesforce',
      entity: 'voice_call',
      available: true,
      cdc_supported: false,
      push_topic_supported: true,
      reconciler_only: false,
      association_rescan_required: false,
      last_probed_at: FIXED_NOW,
    };
    f.capabilityStore.upsert(flags);

    const resp = handleEngagementHealth(f.deps, { name: SALESFORCE_NAME });
    const entities = resp.rows.map((r) => r.entity).sort();
    expect(entities).toContain('voice_call');
    const voiceRow = resp.rows.find((r) => r.entity === 'voice_call');
    expect(voiceRow?.capability?.push_topic_supported).toBe(true);
  });

  it('surfaces call_history when only CallHistory is queryable', () => {
    const conn_id = `api:${SALESFORCE_NAME}`;
    f.capabilityStore.upsert({
      connection_id: conn_id,
      vendor: 'salesforce',
      entity: 'voice_call',
      available: false,
      association_rescan_required: false,
      last_probed_at: FIXED_NOW,
    });
    f.capabilityStore.upsert({
      connection_id: conn_id,
      vendor: 'salesforce',
      entity: 'call_history',
      available: true,
      cdc_supported: false,
      push_topic_supported: true,
      reconciler_only: false,
      association_rescan_required: false,
      last_probed_at: FIXED_NOW,
    });

    const resp = handleEngagementHealth(f.deps, { name: SALESFORCE_NAME });
    const entities = resp.rows.map((r) => r.entity).sort();
    expect(entities).toContain('call_history');
    expect(entities).not.toContain('voice_call');
  });

  it('Salesforce rows carry per-entity capability when present', () => {
    const conn_id = `api:${SALESFORCE_NAME}`;
    f.capabilityStore.upsert({
      connection_id: conn_id,
      vendor: 'salesforce',
      entity: 'task',
      available: true,
      cdc_supported: true,
      push_topic_supported: true,
      reconciler_only: false,
      association_rescan_required: false,
      last_probed_at: FIXED_NOW,
    });

    const resp = handleEngagementHealth(f.deps, { name: SALESFORCE_NAME });
    const taskRow = resp.rows.find((r) => r.entity === 'task');
    expect(taskRow?.capability).toBeDefined();
    expect(taskRow?.capability?.cdc_supported).toBe(true);
    // The other Salesforce rows (event, email_message) have no
    // capability rows seeded → `capability` should be undefined.
    const eventRow = resp.rows.find((r) => r.entity === 'event');
    expect(eventRow?.capability).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// reprobeEngagementCapabilities
// ────────────────────────────────────────────────────────────────

describe('D-139 P2 — handleReprobeEngagementCapabilities', () => {
  let f: Fixture;
  beforeEach(() => {
    f = buildFixture();
  });
  afterEach(() => {
    f.db.close();
  });

  it('rejects HubSpot connections with hint at collection.connection.probe', async () => {
    // D-192 — re-probe is gated on the streaming sync class (Salesforce), not the
    // vendor literal; HubSpot (poll) is still rejected, with a streaming-framed hint.
    await expect(
      handleReprobeEngagementCapabilities(f.deps, { name: HUBSPOT_NAME }),
    ).rejects.toThrow(/streaming engagement vendors only/);
  });

  it('rejects unknown connection', async () => {
    await expect(
      handleReprobeEngagementCapabilities(f.deps, { name: 'does-not-exist' }),
    ).rejects.toThrow(/no api connection/);
  });

  it('rejects empty name', async () => {
    await expect(
      handleReprobeEngagementCapabilities(f.deps, { name: '' }),
    ).rejects.toThrow(/name is required/);
  });

  it('runs probe + persists capability rows + detects call_entity_changed', async () => {
    const conn_id = `api:${SALESFORCE_NAME}`;
    // Prior probe state: VoiceCall not available, CallHistory available.
    f.capabilityStore.upsert({
      connection_id: conn_id,
      vendor: 'salesforce',
      entity: 'voice_call',
      available: false,
      association_rescan_required: false,
      last_probed_at: FIXED_NOW - 86_400_000,
    });
    f.capabilityStore.upsert({
      connection_id: conn_id,
      vendor: 'salesforce',
      entity: 'call_history',
      available: true,
      push_topic_supported: false,
      reconciler_only: true,
      association_rescan_required: true,
      last_probed_at: FIXED_NOW - 86_400_000,
    });

    // Mock fetcher: respond OK to all probe legs (object describe + CDC
    // + PushTopic dry-run + PushTopic existence + SOAP create). The
    // probe runs serially across 8 entities (5 engagement + 3
    // relationship); responses are sticky JSON.
    let callCount = 0;
    f.fakeFetcher.mockImplementation(async (url: string | URL) => {
      callCount += 1;
      const u = String(url);
      // describe — 200 with queryable: true
      if (u.includes('/describe')) {
        return new Response(
          JSON.stringify({ queryable: true }),
          { status: 200 },
        );
      }
      // EntityDefinition CDC probe — 200 with one row, IsChange=true
      if (u.includes('IsChangeDataCaptureSelected')) {
        return new Response(
          JSON.stringify({
            records: [{ IsChangeDataCaptureSelected: true }],
          }),
          { status: 200 },
        );
      }
      // PushTopic dry-run query — 200 with empty records
      // existing-PushTopic-by-name check + dry-run share /query?
      if (u.includes('/query?q=')) {
        return new Response(
          JSON.stringify({ records: [] }),
          { status: 200 },
        );
      }
      // SOAP create
      if (u.includes('/services/Soap/u/')) {
        return new Response(
          '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><createResponse><result><id>0aa</id><success>true</success></result></createResponse></soapenv:Body></soapenv:Envelope>',
          { status: 200, headers: { 'content-type': 'text/xml' } },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const resp = await handleReprobeEngagementCapabilities(f.deps, {
      name: SALESFORCE_NAME,
    });
    expect(callCount).toBeGreaterThan(0);
    expect(resp.reprobed_at).toBe(FIXED_NOW);
    // After probe, the persisted rows should have the freshest
    // last_probed_at.
    const persisted = f.capabilityStore.listByConnection(conn_id);
    expect(persisted.length).toBeGreaterThan(0);
    for (const row of persisted) {
      expect(row.last_probed_at).toBe(FIXED_NOW);
    }
    // Probe responded that VoiceCall is now queryable + has CDC +
    // PushTopic-streamable; `winning_call_entity` should flip to
    // voice_call.
    expect(resp.winning_call_entity).toBe('voice_call');
    expect(resp.call_entity_changed).toBe(true);
    // The fresh health rows include `voice_call` (no longer
    // `call_history`).
    const entities = resp.rows.map((r) => r.entity).sort();
    expect(entities).toContain('voice_call');
    expect(entities).not.toContain('call_history');
  });

  it('reports call_entity_changed false when winner stable across probes', async () => {
    const conn_id = `api:${SALESFORCE_NAME}`;
    // Prior probe: VoiceCall available; CallHistory not.
    f.capabilityStore.upsert({
      connection_id: conn_id,
      vendor: 'salesforce',
      entity: 'voice_call',
      available: true,
      push_topic_supported: true,
      reconciler_only: false,
      association_rescan_required: false,
      last_probed_at: FIXED_NOW - 86_400_000,
    });

    f.fakeFetcher.mockImplementation(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/describe')) {
        return new Response(JSON.stringify({ queryable: true }), { status: 200 });
      }
      if (u.includes('IsChangeDataCaptureSelected')) {
        return new Response(
          JSON.stringify({ records: [{ IsChangeDataCaptureSelected: true }] }),
          { status: 200 },
        );
      }
      if (u.includes('/query?q=')) {
        return new Response(JSON.stringify({ records: [] }), { status: 200 });
      }
      return new Response(
        '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><createResponse><result><id>0aa</id><success>true</success></result></createResponse></soapenv:Body></soapenv:Envelope>',
        { status: 200, headers: { 'content-type': 'text/xml' } },
      );
    });

    const resp = await handleReprobeEngagementCapabilities(f.deps, {
      name: SALESFORCE_NAME,
    });
    expect(resp.winning_call_entity).toBe('voice_call');
    expect(resp.call_entity_changed).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Args validation
// ────────────────────────────────────────────────────────────────

describe('D-139 P2 — args validation', () => {
  let f: Fixture;
  beforeEach(() => {
    f = buildFixture();
  });
  afterEach(() => {
    f.db.close();
  });

  it('engagementHealth throws RpcError on non-object args', () => {
    expect(() =>
      handleEngagementHealth(f.deps, null as unknown as { name: string }),
    ).toThrowError(RpcError);
  });

  it('reprobeEngagementCapabilities throws RpcError on non-object args', async () => {
    await expect(
      handleReprobeEngagementCapabilities(
        f.deps,
        undefined as unknown as { name: string },
      ),
    ).rejects.toThrow(RpcError);
  });
});

// ────────────────────────────────────────────────────────────────
// Codex review fold-back tests
// ────────────────────────────────────────────────────────────────

describe('D-139 P2 Codex review fold #1 (P1) — capability flag mismatch on PushTopic-create failure', () => {
  let f: Fixture;
  beforeEach(() => {
    f = buildFixture();
  });
  afterEach(() => {
    f.db.close();
  });

  it('persists push_topic_supported: false + reconciler_only: true + last_probe_error when SOAP create fails', async () => {
    f.fakeFetcher.mockImplementation(async (url: string | URL) => {
      const u = String(url);
      // describe — 200 with queryable: true
      if (u.includes('/describe')) {
        return new Response(JSON.stringify({ queryable: true }), { status: 200 });
      }
      // CDC probe — true
      if (u.includes('IsChangeDataCaptureSelected')) {
        return new Response(
          JSON.stringify({ records: [{ IsChangeDataCaptureSelected: true }] }),
          { status: 200 },
        );
      }
      // PushTopic dry-run query — empty records (probe leg succeeds);
      // existing-PushTopic-by-name check — also empty so SOAP create
      // is attempted on every entity.
      if (u.includes('/query?q=')) {
        return new Response(JSON.stringify({ records: [] }), { status: 200 });
      }
      // SOAP create (path `/services/Soap/c/<api_version>` per
      // SALESFORCE_SOAP_PARTNER_PATH) — return 500 to force a thrown
      // error in ensureEngagementPushTopics (which surfaces as
      // create_failed for every streamable entity in the helper's
      // catch block).
      if (u.includes('/services/Soap/')) {
        return new Response('SOAP fault', { status: 500 });
      }
      return new Response('{}', { status: 200 });
    });

    const resp = await handleReprobeEngagementCapabilities(f.deps, {
      name: SALESFORCE_NAME,
    });

    // Every streamable entity should surface as create_failed.
    const failures = resp.pushtopic_creation.filter(
      (p) => p.outcome === 'create_failed',
    );
    expect(failures.length).toBeGreaterThan(0);

    // And the persisted capability rows should reflect the SOAP-create
    // failure: push_topic_supported: false, reconciler_only: true,
    // association_rescan_required: true, last_probe_error carries the
    // SOAP error string (Codex P1 #1 — pre-fold the rows would say
    // push_topic_supported: true even though SOAP create failed).
    const conn_id = `api:${SALESFORCE_NAME}`;
    const persisted = f.capabilityStore.listByConnection(conn_id);
    const taskRow = persisted.find((r) => r.entity === 'task');
    expect(taskRow?.push_topic_supported).toBe(false);
    expect(taskRow?.reconciler_only).toBe(true);
    expect(taskRow?.association_rescan_required).toBe(true);
    expect(taskRow?.last_probe_error).toMatch(/pushtopic_create:/);
  });
});

describe('D-139 P2 Codex review fold #2 (P2) — last_pulled_at + last_error semantics', () => {
  let f: Fixture;
  beforeEach(() => {
    f = buildFixture();
  });
  afterEach(() => {
    f.db.close();
  });

  it('a completed cycle run → last_pulled_at = its ts; last_error = null', () => {
    const cycleTaskId = reconciliationTaskId('hubspot', 'email', HUBSPOT_NAME);
    f.housekeepingState.set({
      task_id: cycleTaskId,
      cursor: { kind: 'time', last_seen_at: 2 },
      last_run_at: FIXED_NOW - 5_000,
      last_status: 'complete',
    });
    const resp = handleEngagementHealth(f.deps, { name: HUBSPOT_NAME });
    const emailRow = resp.rows.find((r) => r.entity === 'email');
    // last_pulled_at surfaces the cycle row's ts only when it succeeded.
    expect(emailRow?.last_pulled_at).toBe(FIXED_NOW - 5_000);
    // A completed run carries no error.
    expect(emailRow?.last_error).toBeNull();
  });

  it('failed-only case — last_pulled_at is null + last_error surfaces', () => {
    const cycleTaskId = reconciliationTaskId('hubspot', 'note', HUBSPOT_NAME);
    f.housekeepingState.set({
      task_id: cycleTaskId,
      cursor: { kind: 'time', last_seen_at: 1 },
      last_run_at: FIXED_NOW - 60_000,
      last_status: 'error',
      last_error: 'cycle: 500',
    });
    const resp = handleEngagementHealth(f.deps, { name: HUBSPOT_NAME });
    const noteRow = resp.rows.find((r) => r.entity === 'note');
    expect(noteRow?.last_pulled_at).toBeNull();
    expect(noteRow?.last_error).toBe('cycle: 500');
  });

  it('a failed cycle run → last_pulled_at = null; last_error = the error', () => {
    const cycleTaskId = reconciliationTaskId('hubspot', 'task', HUBSPOT_NAME);
    f.housekeepingState.set({
      task_id: cycleTaskId,
      cursor: { kind: 'time', last_seen_at: 2 },
      last_run_at: FIXED_NOW - 5_000,
      last_status: 'error',
      last_error: 'cycle: 500',
    });
    const resp = handleEngagementHealth(f.deps, { name: HUBSPOT_NAME });
    const taskRow = resp.rows.find((r) => r.entity === 'task');
    // A failed run is not a successful pull → last_pulled_at stays null.
    expect(taskRow?.last_pulled_at).toBeNull();
    expect(taskRow?.last_error).toBe('cycle: 500');
  });
});

describe('D-139 P2 Codex review fold #3 (P2) — pages_fetched_today populated', () => {
  let f: Fixture;
  beforeEach(() => {
    f = buildFixture();
  });
  afterEach(() => {
    f.db.close();
  });

  it('pages_fetched_today reflects per-entity recordPages bumps', () => {
    // Rate-control keys on the BARE connection name (what the reconciler /
    // rate-gate writes), NOT the composite `api:<name>` pk — see the health
    // handler's readUsage/readPages call sites.
    const conn_id = HUBSPOT_NAME;
    f.rateControlStore.recordPages({
      connection_id: conn_id,
      vendor: 'hubspot',
      entity: 'email',
      n: 4,
      now: FIXED_NOW,
    });
    f.rateControlStore.recordPages({
      connection_id: conn_id,
      vendor: 'hubspot',
      entity: 'meeting',
      n: 2,
      now: FIXED_NOW,
    });

    const resp = handleEngagementHealth(f.deps, { name: HUBSPOT_NAME });
    const emailRow = resp.rows.find((r) => r.entity === 'email');
    const meetingRow = resp.rows.find((r) => r.entity === 'meeting');
    const noteRow = resp.rows.find((r) => r.entity === 'note');
    expect(emailRow?.pages_fetched_today).toBe(4);
    expect(meetingRow?.pages_fetched_today).toBe(2);
    // Untouched entity rolls a fresh zero bucket.
    expect(noteRow?.pages_fetched_today).toBe(0);
  });

  it('per-entity bucket rolls after 24h', () => {
    // Rate-control keys on the BARE connection name (what the reconciler /
    // rate-gate writes), NOT the composite `api:<name>` pk — see the health
    // handler's readUsage/readPages call sites.
    const conn_id = HUBSPOT_NAME;
    // First bump in the prior day.
    f.rateControlStore.recordPages({
      connection_id: conn_id,
      vendor: 'hubspot',
      entity: 'email',
      n: 7,
      now: FIXED_NOW - 25 * 60 * 60 * 1000,
    });
    // Now read at FIXED_NOW — bucket should reset.
    const resp = handleEngagementHealth(f.deps, { name: HUBSPOT_NAME });
    const emailRow = resp.rows.find((r) => r.entity === 'email');
    expect(emailRow?.pages_fetched_today).toBe(0);
  });
});

describe('D-139 P2 Codex review fold #4 (P2) — winning_call_entity runner registration hook', () => {
  let f: Fixture;
  let registerHookCalls: Array<{
    winner: 'voice_call' | 'call_history' | null;
    prior: 'voice_call' | 'call_history' | null;
  }>;
  beforeEach(() => {
    f = buildFixture();
    registerHookCalls = [];
    f.deps.registerSalesforceCallEntity = async (input) => {
      registerHookCalls.push({ winner: input.winner, prior: input.prior });
    };

    // Mock fetcher — VoiceCall wins.
    f.fakeFetcher.mockImplementation(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/describe')) {
        return new Response(JSON.stringify({ queryable: true }), { status: 200 });
      }
      if (u.includes('IsChangeDataCaptureSelected')) {
        return new Response(
          JSON.stringify({ records: [{ IsChangeDataCaptureSelected: true }] }),
          { status: 200 },
        );
      }
      if (u.includes('/query?q=')) {
        return new Response(JSON.stringify({ records: [] }), { status: 200 });
      }
      return new Response(
        '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><createResponse><result><id>0aa</id><success>true</success></result></createResponse></soapenv:Body></soapenv:Envelope>',
        { status: 200, headers: { 'content-type': 'text/xml' } },
      );
    });
  });
  afterEach(() => {
    f.db.close();
  });

  it('fires hook with winner + prior when probe surfaces a winning call entity', async () => {
    await handleReprobeEngagementCapabilities(f.deps, { name: SALESFORCE_NAME });
    expect(registerHookCalls.length).toBe(1);
    expect(registerHookCalls[0]!.winner).toBe('voice_call');
    expect(registerHookCalls[0]!.prior).toBeNull();
  });

  it('hook failures do not fail the rpc round-trip (best-effort)', async () => {
    f.deps.registerSalesforceCallEntity = async () => {
      throw new Error('runner registration crashed');
    };
    const resp = await handleReprobeEngagementCapabilities(f.deps, {
      name: SALESFORCE_NAME,
    });
    // Despite the throw, the rpc returned the fresh capability list.
    expect(resp.winning_call_entity).toBe('voice_call');
  });
});

describe('D-139 P2 Codex review fold #7 (P2) — Salesforce relationship-object capability surface', () => {
  let f: Fixture;
  beforeEach(() => {
    f = buildFixture();
  });
  afterEach(() => {
    f.db.close();
  });

  it('relationships array empty for HubSpot', () => {
    const resp = handleEngagementHealth(f.deps, { name: HUBSPOT_NAME });
    expect(resp.relationships).toEqual([]);
  });

  it('relationships array carries TaskRelation / EventRelation / EmailMessageRelation rows when present', () => {
    const conn_id = `api:${SALESFORCE_NAME}`;
    f.capabilityStore.upsert({
      connection_id: conn_id,
      vendor: 'salesforce',
      entity: 'task_relation',
      available: true,
      cdc_supported: false,
      push_topic_supported: true,
      reconciler_only: false,
      association_rescan_required: false,
      last_probed_at: FIXED_NOW,
    });
    f.capabilityStore.upsert({
      connection_id: conn_id,
      vendor: 'salesforce',
      entity: 'event_relation',
      available: false,
      association_rescan_required: false,
      last_probed_at: FIXED_NOW,
    });
    f.capabilityStore.upsert({
      connection_id: conn_id,
      vendor: 'salesforce',
      entity: 'email_message_relation',
      available: true,
      cdc_supported: true,
      push_topic_supported: true,
      reconciler_only: false,
      association_rescan_required: false,
      last_probed_at: FIXED_NOW,
    });

    const resp = handleEngagementHealth(f.deps, { name: SALESFORCE_NAME });
    expect(resp.relationships.length).toBe(3);
    const entities = resp.relationships.map((r) => r.entity).sort();
    expect(entities).toEqual([
      'email_message_relation',
      'event_relation',
      'task_relation',
    ]);
    // Engagement-entity rows should NOT contain the relationship
    // objects.
    const engagementEntities = resp.rows.map((r) => r.entity);
    expect(engagementEntities).not.toContain('task_relation');
    expect(engagementEntities).not.toContain('event_relation');
    expect(engagementEntities).not.toContain('email_message_relation');
  });
});

// ────────────────────────────────────────────────────────────────
// D-192 — a PACK-declared engagement vendor works with NO code edit
// ────────────────────────────────────────────────────────────────

describe('D-192 — pack-declared engagement vendor (registry-facet-driven surface)', () => {
  const ACME = 'acme-crm';
  // A hypothetical pack CRM whose engagement plane syncs by delta-cursor (the
  // third archetype, neither poll nor stream) with a probe-gated exclusive call
  // group — declared ONLY in the injected live registry, never in the shipped
  // built-ins. If the health surface still branched on the retired
  // `hubspot`/`salesforce` literals, none of this would work.
  const acmeEntities: ConnectionVendorEntity[] = [
    buildConnectionVendorEntity({ vendor: 'acme', entity: 'message', display_name: 'Acme Message', meta_fields: [], engagement: { capability: 'always', sync_kind: 'delta_cursor' } }),
    buildConnectionVendorEntity({ vendor: 'acme', entity: 'meeting', display_name: 'Acme Meeting', meta_fields: [], engagement: { capability: 'always', sync_kind: 'delta_cursor' } }),
    buildConnectionVendorEntity({ vendor: 'acme', entity: 'call_recorded', display_name: 'Acme Recorded Call', meta_fields: [], engagement: { capability: 'probe_gated', exclusive_group: 'call', sync_kind: 'delta_cursor' } }),
    buildConnectionVendorEntity({ vendor: 'acme', entity: 'call_logged', display_name: 'Acme Logged Call', meta_fields: [], engagement: { capability: 'probe_gated', exclusive_group: 'call', sync_kind: 'delta_cursor' } }),
  ];
  const liveRegistry: ConnectionVendorEntity[] = [...CONNECTION_VENDOR_ENTITIES, ...acmeEntities];

  let f: Fixture;
  beforeEach(() => {
    f = buildFixture();
    f.connectionStore.upsert({
      kind: 'api', name: ACME, display_name: 'Acme CRM',
      config_json: JSON.stringify({ vendor: 'acme' }),
      auth_ciphertext: 'opaque', enrolled_at: FIXED_NOW - 86_400_000, updated_at: FIXED_NOW - 86_400_000,
    });
    // Rewire deps to expose the live merged registry (built-ins + the pack).
    f.deps = { ...f.deps, resolveVendorRegistry: () => liveRegistry };
  });
  afterEach(() => { f.db.close(); });

  it('accepts the pack vendor + surfaces its always-present entities (probe-gated group hidden pre-probe)', () => {
    const resp = handleEngagementHealth(f.deps, { name: ACME });
    expect(resp.vendor).toBe('acme');
    // Always entities surface; the exclusive call group stays hidden until a probe lands.
    expect(resp.rows.map((r) => r.entity).sort()).toEqual(['meeting', 'message']);
    // delta_cursor is not streaming — no capability column, no relationship panel.
    expect(resp.rows.every((r) => r.capability === undefined)).toBe(true);
    expect(resp.relationships).toEqual([]);
  });

  it('picks the probed winner of an exclusive group (the SF voice_call/call_history rule, generalized)', () => {
    f.capabilityStore.upsert({
      connection_id: `api:${ACME}`, vendor: 'acme', entity: 'call_recorded',
      available: true, association_rescan_required: false, last_probed_at: FIXED_NOW,
    });
    f.capabilityStore.upsert({
      connection_id: `api:${ACME}`, vendor: 'acme', entity: 'call_logged',
      available: false, association_rescan_required: false, last_probed_at: FIXED_NOW,
    });
    const entities = handleEngagementHealth(f.deps, { name: ACME }).rows.map((r) => r.entity).sort();
    expect(entities).toContain('call_recorded');
    expect(entities).not.toContain('call_logged');
  });

  it('rejects re-probe for a non-streaming (delta_cursor) pack vendor', async () => {
    await expect(
      handleReprobeEngagementCapabilities(f.deps, { name: ACME }),
    ).rejects.toThrow(/streaming engagement vendors only/);
  });
});
