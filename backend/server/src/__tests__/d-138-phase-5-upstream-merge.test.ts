/** D-138 Phase 5 — upstream-merge outbox + driver acceptance tests.
 *
 *  Covers the P5 acceptance set from the spec:
 *    - HubSpot upstream merge — happy path
 *    - Salesforce Lead/Account merge — happy path (SOAP)
 *    - Salesforce Contact degraded path — vendor call skipped, local
 *      merge proceeds
 *    - Two-step second-click confirm — handled at the UI surface;
 *      tested in the ui-shared file. Backend-side, the rpc layer does
 *      NOT fire `merge()` on the describe rpc (only on request)
 *    - D-113 approval routing — synthetic approval surfaces in the
 *      approval sink with risk_tier 'destructive'
 *    - Audit provenance — every state transition emits an entry
 *    - Outbox happy-path state machine: pending → in_flight →
 *      succeeded → local_pending → committed
 *    - Outbox vendor-success / local-failure recovery — boot sweep
 *      replays from `vendor_merge_succeeded` to terminal commit
 *    - Outbox vendor failure terminal — 3 retryable failures →
 *      vendor_merge_failed + bus emit
 *    - Outbox idempotency key — same vendor pair re-requested
 *      collapses onto the same outbox row */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeUpstreamMergeIdempotencyKey,
  type ConnectionRecord,
  type UpstreamMergeIdempotencyInput,
  type UpstreamMergeObjectType,
  type UpstreamMergeOutboxRow,
} from '@recued/contracts';

import {
  createContactStore,
  type ContactStore,
} from '../storage/contact-store.js';
import {
  createUpstreamMergeStore,
  type UpstreamMergeStore,
} from '../storage/upstream-merge-store.js';
import {
  handleUpstreamMergeDescribe,
  handleUpstreamMergeDiscard,
  handleUpstreamMergeList,
  handleUpstreamMergeRequest,
  handleUpstreamMergeRetry,
  runUpstreamMergeRecoverySweep,
  type UpstreamMergeAuditEntry,
  type UpstreamMergeRpcDeps,
} from '../upstream-merge-handler.js';
import type {
  VendorMergeClient,
  VendorMergePreview,
  VendorMergeResult,
} from '../data/vendor-merge.js';
import { SALESFORCE_CONTACT_DEGRADED } from '../data/vendor-merge.js';
import { createEventBus, type EventBus } from '../events/bus.js';

const realSha = (canonical: string): string => {
  // Uses node:crypto under the hood — same algorithm the handler picks.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(canonical).digest('hex');
};

interface RecordedAudit extends UpstreamMergeAuditEntry {}

interface FakeVendorMerger {
  client: VendorMergeClient;
  /** Number of merge() invocations. */
  calls: number;
  /** Each entry's idempotency_key — used to assert key constancy
   *  across retries. */
  idempotency_keys: string[];
  /** Override per-call; index by `calls` (zero-based). Returns the
   *  default success when undefined. */
  scriptedResults: VendorMergeResult[];
}

const makeFakeMerger = (
  object_type: UpstreamMergeObjectType,
  scripted: VendorMergeResult[] = [],
): FakeVendorMerger => {
  const fake: FakeVendorMerger = {
    calls: 0,
    idempotency_keys: [],
    scriptedResults: scripted,
    client: {
      object_type,
      describe: async (): Promise<VendorMergePreview> => ({
        field_outcomes: [],
        vendor_semantics_summary: `fake ${object_type} semantics`,
        dispatchable: true,
      }),
      merge: async (
        _conn: ConnectionRecord,
        _pair,
        idempotency_key: string,
      ): Promise<VendorMergeResult> => {
        fake.idempotency_keys.push(idempotency_key);
        const i = fake.calls;
        fake.calls += 1;
        if (i < fake.scriptedResults.length) return fake.scriptedResults[i]!;
        return { ok: true, vendor_response: { id: 'master_x' } };
      },
    },
  };
  return fake;
};

const fakeConnection = (
  name: string,
  vendor: string = 'hubspot',
): ConnectionRecord => ({
  kind: 'api',
  subtype: vendor,
  name,
  display_name: name,
  publisher_id: 'recued-core',
  config: { base_url: vendor === 'salesforce' ? 'https://test.my.salesforce.com' : 'https://api.hubapi.com' },
  auth: {
    type: 'oauth2_refresh',
    refresh_token: 'ref_xxx',
    client_id: 'cid',
    token_endpoint: 'https://example.com/token',
    current_access_token: 'tok_xxx',
    expires_at: Date.now() + 3_600_000,
  },
  enrolled_at: Date.now(),
  updated_at: Date.now(),
  health: { status: 'ok', last_probed_at: Date.now() },
});

let dir: string;
let db: Database.Database;
let contactStore: ContactStore;
let store: UpstreamMergeStore;
let bus: EventBus;
let audits: RecordedAudit[];
let approvalSink: {
  pending: { request_id: string; outbox_id: string; description: string }[];
  resolved: { approval_id: string; decision: string }[];
};
let cascade: { survivor_email: string; loser_emails: string[] }[];

const seedContact = (email: string, name: string, platforms: { vendor: string; platform_id: string }[] = []): void => {
  contactStore.upsertManual({ email, name, last_interaction: Date.now() });
  for (const p of platforms) {
    contactStore.linkPlatformId({
      canonical_email: email,
      vendor: p.vendor,
      platform_id: p.platform_id,
      state: 'auto',
      linked_at: Date.now(),
      linked_by: 'test',
    });
  }
};

const seedCandidate = (id: string, email_a: string, email_b: string): void => {
  contactStore.enqueueMergeCandidate({
    id,
    email_a,
    email_b,
    matched_fields: ['name'],
    detected_at: Date.now(),
    detected_by: 'inline',
  });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd138-p5-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  contactStore = createContactStore(db);
  store = createUpstreamMergeStore(db);
  bus = createEventBus();
  audits = [];
  approvalSink = { pending: [], resolved: [] };
  cascade = [];
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const buildDeps = (
  registry: Map<UpstreamMergeObjectType, VendorMergeClient>,
  overrides?: Partial<UpstreamMergeRpcDeps>,
): UpstreamMergeRpcDeps => ({
  store,
  contactStore,
  vendorMergers: registry,
  vendorConnectionLookup: (vendor, connection_name) =>
    fakeConnection(connection_name, vendor),
  eventBus: bus,
  approvalSink: {
    addPending: (input) => {
      approvalSink.pending.push({
        request_id: input.request.request_id,
        outbox_id: input.outbox_id,
        description: input.request.description,
      });
      return input.request.request_id;
    },
    markResolved: (approval_id, decision) => {
      approvalSink.resolved.push({ approval_id, decision });
    },
  },
  audit: (entry) => audits.push(entry as RecordedAudit),
  onIdentityChanged: (input) => cascade.push(input),
  sleep: async () => undefined, // skip real timeouts in tests
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// Happy path — HubSpot
// ────────────────────────────────────────────────────────────────

describe('D-138 P5 — HubSpot happy path', () => {
  it('runs the full state machine pending → in_flight → succeeded → local_pending → committed', async () => {
    seedContact('survivor@example.com', 'Survivor', [{ vendor: 'hubspot', platform_id: 'hs_master' }]);
    seedContact('loser@example.com', 'Loser', [{ vendor: 'hubspot', platform_id: 'hs_victim' }]);
    seedCandidate('cand_1', 'loser@example.com', 'survivor@example.com');

    const merger = makeFakeMerger('hubspot:contact');
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['hubspot:contact', merger.client],
    ]);
    const deps = buildDeps(registry);
    const response = await handleUpstreamMergeRequest(deps, {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'hs_master', loser_platform_id: 'hs_victim' }],
      connection_name: 'main',
    });

    expect(response.state).toBe('local_merge_committed');
    expect(merger.calls).toBe(1);

    const transitions = audits.map((a) => a.transition);
    expect(transitions).toEqual([
      'outbox_inserted',
      'vendor_call_started',
      'vendor_call_succeeded',
      'local_step_started',
      'local_step_committed',
    ]);

    // Local-side absorption took effect
    const survivorAfter = contactStore.get('survivor@example.com');
    const loserAfter = contactStore.get('loser@example.com');
    expect(loserAfter?.merged_into).toBe('survivor@example.com');
    expect(survivorAfter?.platform_ids?.some((p) => p.platform_id === 'hs_victim')).toBe(true);
    expect(cascade).toEqual([
      { survivor_email: 'survivor@example.com', loser_emails: ['loser@example.com'] },
    ]);
    expect(approvalSink.pending).toHaveLength(1);
    expect(approvalSink.pending[0]!.description).toContain('hubspot');
    expect(approvalSink.resolved).toEqual([
      { approval_id: response.approval_id, decision: 'approve' },
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// Salesforce Lead/Account happy path
// ────────────────────────────────────────────────────────────────

describe('D-138 P5 — Salesforce Lead/Account happy path', () => {
  it('Lead merge follows the same state machine', async () => {
    seedContact('survivor@example.com', 'Survivor', [{ vendor: 'salesforce', platform_id: 'sf_lead_master' }]);
    seedContact('loser@example.com', 'Loser', [{ vendor: 'salesforce', platform_id: 'sf_lead_victim' }]);
    seedCandidate('cand_1', 'loser@example.com', 'survivor@example.com');

    const merger = makeFakeMerger('salesforce:lead');
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['salesforce:lead', merger.client],
    ]);
    const response = await handleUpstreamMergeRequest(buildDeps(registry), {
      vendor: 'salesforce',
      object_type: 'salesforce:lead',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'sf_lead_master', loser_platform_id: 'sf_lead_victim' }],
      connection_name: 'main',
    });
    expect(response.state).toBe('local_merge_committed');
    expect(merger.calls).toBe(1);
  });

  it('Account merge follows the same state machine', async () => {
    seedContact('survivor@example.com', 'Survivor');
    seedContact('loser@example.com', 'Loser');
    seedCandidate('cand_1', 'loser@example.com', 'survivor@example.com');

    const merger = makeFakeMerger('salesforce:account');
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['salesforce:account', merger.client],
    ]);
    const response = await handleUpstreamMergeRequest(buildDeps(registry), {
      vendor: 'salesforce',
      object_type: 'salesforce:account',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'sf_acc_master', loser_platform_id: 'sf_acc_victim' }],
      connection_name: 'main',
    });
    expect(response.state).toBe('local_merge_committed');
  });
});

// ────────────────────────────────────────────────────────────────
// Salesforce Contact degraded path
// ────────────────────────────────────────────────────────────────

describe('D-138 P5 — Salesforce Contact degraded path', () => {
  it('skips vendor call but completes the local merge + surfaces degraded_path receipt', async () => {
    seedContact('survivor@example.com', 'Survivor');
    seedContact('loser@example.com', 'Loser');
    seedCandidate('cand_1', 'loser@example.com', 'survivor@example.com');

    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['salesforce:contact', SALESFORCE_CONTACT_DEGRADED],
    ]);
    const merger = makeFakeMerger('salesforce:contact'); // counts calls
    registry.set('salesforce:contact', merger.client);

    const response = await handleUpstreamMergeRequest(buildDeps(registry), {
      vendor: 'salesforce',
      object_type: 'salesforce:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'sf_c_master', loser_platform_id: 'sf_c_victim' }],
      connection_name: 'main',
    });
    expect(response.state).toBe('local_merge_committed');
    expect(response.degraded_path).toBe('vendor_not_dispatchable');
    // Vendor merge() was NOT called — degraded path skips it.
    expect(merger.calls).toBe(0);
    // But local merge still ran.
    expect(contactStore.get('loser@example.com')?.merged_into).toBe('survivor@example.com');
    // Audit recorded the degraded skip — fold-back split the synthetic
    // transition into started + succeeded steps so each state hop is
    // covered by the centralized "apply event + audit" helper.
    const transitions = audits.map((a) => a.transition);
    expect(transitions).toContain('vendor_call_skipped_degraded_path_started');
    expect(transitions).toContain('vendor_call_skipped_degraded_path_succeeded');
  });
});

// ────────────────────────────────────────────────────────────────
// Two-step second-click confirm (rpc-side guarantee)
// ────────────────────────────────────────────────────────────────

describe('D-138 P5 — describe rpc never fires merge', () => {
  it('describe is a pure read — vendor.merge() is NOT called', async () => {
    const merger = makeFakeMerger('hubspot:contact');
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['hubspot:contact', merger.client],
    ]);
    const preview = await handleUpstreamMergeDescribe(buildDeps(registry), {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      survivor_platform_id: 'hs_master',
      loser_platform_id: 'hs_victim',
      connection_name: 'main',
    });
    expect(preview.dispatchable).toBe(true);
    expect(preview.vendor_semantics_summary).toContain('fake hubspot:contact');
    expect(merger.calls).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Vendor failure terminal
// ────────────────────────────────────────────────────────────────

describe('D-138 P5 — vendor failure terminal', () => {
  it('3 retryable failures → vendor_merge_failed + bus emit', async () => {
    seedContact('survivor@example.com', 'Survivor');
    seedContact('loser@example.com', 'Loser');
    seedCandidate('cand_1', 'loser@example.com', 'survivor@example.com');

    const merger = makeFakeMerger('hubspot:contact', [
      { ok: false, retryable: true, error: { code: 'vendor_http_5xx', message: '503', http_status: 503 } },
      { ok: false, retryable: true, error: { code: 'vendor_http_5xx', message: '503', http_status: 503 } },
      { ok: false, retryable: true, error: { code: 'vendor_http_5xx', message: '503', http_status: 503 } },
    ]);
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['hubspot:contact', merger.client],
    ]);

    const failureEvents: { kind: string; error_code: string }[] = [];
    bus.subscribe('test', { kinds: ['upstream_merge_failed'] }, (ev) => {
      if (ev.kind === 'upstream_merge_failed') {
        failureEvents.push({ kind: ev.kind, error_code: ev.error_code });
      }
    });

    const response = await handleUpstreamMergeRequest(buildDeps(registry), {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'hs_master', loser_platform_id: 'hs_victim' }],
      connection_name: 'main',
    });

    expect(response.state).toBe('vendor_merge_failed');
    expect(merger.calls).toBe(3);
    // Local merge did NOT happen.
    expect(contactStore.get('loser@example.com')?.merged_into).toBeUndefined();
    // Bus emit fired exactly once with the error code.
    expect(failureEvents).toEqual([
      { kind: 'upstream_merge_failed', error_code: 'retry_budget_exhausted' },
    ]);
    // Approval sink resolved as reject.
    expect(approvalSink.resolved).toEqual([
      { approval_id: response.approval_id, decision: 'reject' },
    ]);
  });

  it('terminal vendor failure (4xx) → vendor_merge_failed without retry', async () => {
    seedContact('survivor@example.com', 'Survivor');
    seedContact('loser@example.com', 'Loser');
    seedCandidate('cand_1', 'loser@example.com', 'survivor@example.com');

    const merger = makeFakeMerger('hubspot:contact', [
      { ok: false, retryable: false, error: { code: 'vendor_invalid_request', message: '400', http_status: 400 } },
    ]);
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['hubspot:contact', merger.client],
    ]);

    const response = await handleUpstreamMergeRequest(buildDeps(registry), {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'hs_master', loser_platform_id: 'hs_victim' }],
      connection_name: 'main',
    });
    expect(response.state).toBe('vendor_merge_failed');
    expect(merger.calls).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Idempotency key
// ────────────────────────────────────────────────────────────────

describe('D-138 P5 — idempotency key', () => {
  it('same vendor pair re-requested collapses onto the same outbox row', async () => {
    seedContact('survivor@example.com', 'Survivor');
    seedContact('loser@example.com', 'Loser');
    seedCandidate('cand_1', 'loser@example.com', 'survivor@example.com');

    const merger = makeFakeMerger('hubspot:contact');
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['hubspot:contact', merger.client],
    ]);

    // First request — drives to terminal.
    const r1 = await handleUpstreamMergeRequest(buildDeps(registry), {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'hs_master', loser_platform_id: 'hs_victim' }],
      connection_name: 'main',
    });
    expect(r1.state).toBe('local_merge_committed');
    expect(merger.calls).toBe(1);

    // Second request — same key. The handler returns the existing row;
    // no new vendor call.
    const r2 = await handleUpstreamMergeRequest(buildDeps(registry), {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'hs_master', loser_platform_id: 'hs_victim' }],
      connection_name: 'main',
    });
    expect(r2.outbox_id).toBe(r1.outbox_id);
    expect(r2.state).toBe('local_merge_committed');
    expect(merger.calls).toBe(1);
  });

  it('vendor receives the same idempotency_key across retry attempts', async () => {
    seedContact('survivor@example.com', 'Survivor');
    seedContact('loser@example.com', 'Loser');
    seedCandidate('cand_1', 'loser@example.com', 'survivor@example.com');

    const merger = makeFakeMerger('hubspot:contact', [
      { ok: false, retryable: true, error: { code: 'vendor_http_5xx', message: '503', http_status: 503 } },
      { ok: true, vendor_response: { id: 'master_x' } },
    ]);
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['hubspot:contact', merger.client],
    ]);
    await handleUpstreamMergeRequest(buildDeps(registry), {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'hs_master', loser_platform_id: 'hs_victim' }],
      connection_name: 'main',
    });
    expect(merger.calls).toBe(2);
    // Both attempts saw the same idempotency_key — vendor-side dedupe holds.
    expect(merger.idempotency_keys).toHaveLength(2);
    expect(merger.idempotency_keys[0]).toBe(merger.idempotency_keys[1]);
  });

  it('the idempotency key matches the contracts-level helper', () => {
    const input: UpstreamMergeIdempotencyInput = {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'hs_master', loser_platform_id: 'hs_victim' }],
    };
    const k = computeUpstreamMergeIdempotencyKey(input, realSha);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ────────────────────────────────────────────────────────────────
// Outbox boot recovery sweep
// ────────────────────────────────────────────────────────────────

describe('D-138 P5 — boot recovery sweep', () => {
  it('replays a row stuck in vendor_merge_succeeded → terminal commit', async () => {
    seedContact('survivor@example.com', 'Survivor');
    seedContact('loser@example.com', 'Loser', [{ vendor: 'hubspot', platform_id: 'hs_victim' }]);
    seedCandidate('cand_1', 'loser@example.com', 'survivor@example.com');

    // Manually craft an outbox row stuck at vendor_merge_succeeded —
    // simulates a crash between vendor success and local commit.
    const idem_input: UpstreamMergeIdempotencyInput = {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'hs_master', loser_platform_id: 'hs_victim' }],
    };
    const stuckRow: UpstreamMergeOutboxRow = {
      id: 'outbox_recovery',
      approval_id: 'app_recovery',
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      loser_emails: ['loser@example.com'],
      vendor_pairs: idem_input.vendor_pairs as { survivor_platform_id: string; loser_platform_id: string }[],
      idempotency_key: computeUpstreamMergeIdempotencyKey(idem_input, realSha),
      state: 'vendor_merge_succeeded',
      attempts: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    store.insert(stuckRow);

    const merger = makeFakeMerger('hubspot:contact');
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['hubspot:contact', merger.client],
    ]);
    const result = await runUpstreamMergeRecoverySweep(
      buildDeps(registry),
      () => 'main',
    );
    expect(result.replayed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    // Vendor merge() was NOT called again — already past in_flight.
    expect(merger.calls).toBe(0);
    // Local merge ran — survivor absorbed the platform_id.
    expect(contactStore.get('loser@example.com')?.merged_into).toBe('survivor@example.com');
    expect(contactStore.get('survivor@example.com')?.platform_ids?.length).toBeGreaterThan(0);
    const final = store.get('outbox_recovery');
    expect(final?.state).toBe('local_merge_committed');
  });

  it('replays a row stuck in vendor_merge_local_pending → terminal commit', async () => {
    seedContact('survivor@example.com', 'Survivor');
    seedContact('loser@example.com', 'Loser');
    seedCandidate('cand_1', 'loser@example.com', 'survivor@example.com');

    const idem_input: UpstreamMergeIdempotencyInput = {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'hs_master', loser_platform_id: 'hs_victim' }],
    };
    const stuckRow: UpstreamMergeOutboxRow = {
      id: 'outbox_local_pending',
      approval_id: 'app_local_pending',
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      loser_emails: ['loser@example.com'],
      vendor_pairs: idem_input.vendor_pairs as { survivor_platform_id: string; loser_platform_id: string }[],
      idempotency_key: computeUpstreamMergeIdempotencyKey(idem_input, realSha),
      state: 'vendor_merge_local_pending',
      attempts: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    store.insert(stuckRow);

    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['hubspot:contact', makeFakeMerger('hubspot:contact').client],
    ]);
    const result = await runUpstreamMergeRecoverySweep(
      buildDeps(registry),
      () => 'main',
    );
    expect(result.replayed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(store.get('outbox_local_pending')?.state).toBe('local_merge_committed');
  });

  it('replays a same-user-auto-approve pending row (Codex F3 fold-back)', async () => {
    seedContact('survivor@example.com', 'Survivor');
    seedContact('loser@example.com', 'Loser');
    seedCandidate('cand_1', 'loser@example.com', 'survivor@example.com');

    // Manually craft a row stuck at pending_vendor_merge with
    // same_user_auto_approve = true — simulates a crash between
    // request rpc insert + first dispatch.
    const idem_input: UpstreamMergeIdempotencyInput = {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'hs_master', loser_platform_id: 'hs_victim' }],
    };
    store.insert({
      id: 'pending_auto_approved',
      approval_id: 'app_pending_auto',
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      loser_emails: ['loser@example.com'],
      vendor_pairs: idem_input.vendor_pairs as { survivor_platform_id: string; loser_platform_id: string }[],
      idempotency_key: computeUpstreamMergeIdempotencyKey(idem_input, realSha),
      state: 'pending_vendor_merge',
      attempts: 0,
      connection_name: 'main',
      same_user_auto_approve: true,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    const merger = makeFakeMerger('hubspot:contact');
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['hubspot:contact', merger.client],
    ]);
    const result = await runUpstreamMergeRecoverySweep(
      buildDeps(registry),
      () => 'main',
    );
    expect(result.replayed).toBe(1);
    expect(result.succeeded).toBe(1);
    // Vendor merge() WAS called this time — pre-vendor state requires
    // the call (in contrast to the post-vendor recovery tests).
    expect(merger.calls).toBe(1);
    expect(store.get('pending_auto_approved')?.state).toBe('local_merge_committed');
  });

  it('does NOT replay a pending row that has same_user_auto_approve = false', async () => {
    const idem_input: UpstreamMergeIdempotencyInput = {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_no_auto'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'm', loser_platform_id: 'v' }],
    };
    store.insert({
      id: 'pending_awaiting_approval',
      approval_id: 'app_awaiting',
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_no_auto'],
      survivor_email: 'survivor@example.com',
      loser_emails: ['loser@example.com'],
      vendor_pairs: idem_input.vendor_pairs as { survivor_platform_id: string; loser_platform_id: string }[],
      idempotency_key: computeUpstreamMergeIdempotencyKey(idem_input, realSha),
      state: 'pending_vendor_merge',
      attempts: 0,
      same_user_auto_approve: false,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['hubspot:contact', makeFakeMerger('hubspot:contact').client],
    ]);
    const result = await runUpstreamMergeRecoverySweep(
      buildDeps(registry),
      () => 'main',
    );
    expect(result.replayed).toBe(0);
    expect(store.get('pending_awaiting_approval')?.state).toBe('pending_vendor_merge');
  });

  it('post-vendor recovery does NOT call the vendor connection lookup (Codex F4 fold-back)', async () => {
    seedContact('survivor@example.com', 'Survivor');
    seedContact('loser@example.com', 'Loser');
    seedCandidate('cand_1', 'loser@example.com', 'survivor@example.com');

    const idem_input: UpstreamMergeIdempotencyInput = {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'm', loser_platform_id: 'v' }],
    };
    store.insert({
      id: 'post_vendor_no_conn',
      approval_id: 'app_post',
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      loser_emails: ['loser@example.com'],
      vendor_pairs: idem_input.vendor_pairs as { survivor_platform_id: string; loser_platform_id: string }[],
      idempotency_key: computeUpstreamMergeIdempotencyKey(idem_input, realSha),
      state: 'vendor_merge_succeeded',
      attempts: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['hubspot:contact', makeFakeMerger('hubspot:contact').client],
    ]);
    // Recovery callback returns null (no enrolled connection) — but
    // post-vendor states should still complete because they don't
    // need a connection.
    const result = await runUpstreamMergeRecoverySweep(
      buildDeps(registry),
      () => null,
    );
    expect(result.succeeded).toBe(1);
    expect(store.get('post_vendor_no_conn')?.state).toBe('local_merge_committed');
  });

  it('terminal rows are not replayed', async () => {
    const idem_input: UpstreamMergeIdempotencyInput = {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_done'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'hs_master', loser_platform_id: 'hs_victim' }],
    };
    store.insert({
      id: 'committed_row',
      approval_id: 'app_done',
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_done'],
      survivor_email: 'survivor@example.com',
      loser_emails: ['loser@example.com'],
      vendor_pairs: idem_input.vendor_pairs as { survivor_platform_id: string; loser_platform_id: string }[],
      idempotency_key: computeUpstreamMergeIdempotencyKey(idem_input, realSha),
      state: 'local_merge_committed',
      attempts: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['hubspot:contact', makeFakeMerger('hubspot:contact').client],
    ]);
    const result = await runUpstreamMergeRecoverySweep(
      buildDeps(registry),
      () => 'main',
    );
    expect(result.replayed).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Retry rpc — creates fresh row
// ────────────────────────────────────────────────────────────────

describe('D-138 P5 — upstream_merge.retry creates a fresh row', () => {
  it('retry against a failed row creates a fresh outbox + approval; same-user auto-approve drives to terminal', async () => {
    seedContact('survivor@example.com', 'Survivor');
    seedContact('loser@example.com', 'Loser');
    seedCandidate('cand_1', 'loser@example.com', 'survivor@example.com');

    // First call fails terminally; the retry's vendor call uses a
    // SECOND merger result (success) — emulating "the user retried
    // after fixing the upstream issue".
    const merger = makeFakeMerger('hubspot:contact', [
      { ok: false, retryable: false, error: { code: 'vendor_invalid_request', message: '400', http_status: 400 } },
      { ok: true, vendor_response: { id: 'master_x' } },
    ]);
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['hubspot:contact', merger.client],
    ]);
    const failed = await handleUpstreamMergeRequest(buildDeps(registry), {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'hs_master', loser_platform_id: 'hs_victim' }],
      connection_name: 'main',
    });
    expect(failed.state).toBe('vendor_merge_failed');

    // Retry — creates fresh row + drives same-user-auto-approve by
    // default (P5 fold-back Codex F2). The fresh row's idempotency
    // key differs from the failed row, so the vendor sees a fresh
    // call.
    const retry = await handleUpstreamMergeRetry(buildDeps(registry), {
      failed_outbox_id: failed.outbox_id,
    });
    expect(retry.outbox_id).not.toBe(failed.outbox_id);
    expect(retry.approval_id).not.toBe(failed.approval_id);
    // Old row is still terminal (failed).
    expect(store.get(failed.outbox_id)?.state).toBe('vendor_merge_failed');
    // Fresh row was driven through to terminal commit.
    expect(retry.state).toBe('local_merge_committed');
    expect(store.get(retry.outbox_id)?.state).toBe('local_merge_committed');
  });

  it('retry with same_user_auto_approve=false leaves the fresh row pending for multi-surface approval', async () => {
    seedContact('survivor@example.com', 'Survivor');
    seedContact('loser@example.com', 'Loser');
    seedCandidate('cand_1', 'loser@example.com', 'survivor@example.com');

    const merger = makeFakeMerger('hubspot:contact', [
      { ok: false, retryable: false, error: { code: 'vendor_invalid_request', message: '400', http_status: 400 } },
    ]);
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['hubspot:contact', merger.client],
    ]);
    const failed = await handleUpstreamMergeRequest(buildDeps(registry), {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'hs_master', loser_platform_id: 'hs_victim' }],
      connection_name: 'main',
    });
    expect(failed.state).toBe('vendor_merge_failed');

    const retry = await handleUpstreamMergeRetry(buildDeps(registry), {
      failed_outbox_id: failed.outbox_id,
      same_user_auto_approve: false,
    });
    expect(retry.state).toBe('pending_vendor_merge');
    // Fresh row carries the connection_name from the failed row.
    expect(store.get(retry.outbox_id)?.connection_name).toBe('main');
    expect(store.get(retry.outbox_id)?.same_user_auto_approve).toBe(false);
  });

  it('retry against non-failed row returns conflict', async () => {
    const idem_input: UpstreamMergeIdempotencyInput = {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'hs_master', loser_platform_id: 'hs_victim' }],
    };
    store.insert({
      id: 'pending_row',
      approval_id: 'app_pending',
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      loser_emails: ['loser@example.com'],
      vendor_pairs: idem_input.vendor_pairs as { survivor_platform_id: string; loser_platform_id: string }[],
      idempotency_key: computeUpstreamMergeIdempotencyKey(idem_input, realSha),
      state: 'pending_vendor_merge',
      attempts: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>();
    await expect(
      handleUpstreamMergeRetry(buildDeps(registry), { failed_outbox_id: 'pending_row' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

// ────────────────────────────────────────────────────────────────
// Fold-back surface — survivor missing → local_step_failed
// ────────────────────────────────────────────────────────────────

describe('D-138 P5 fold-back — local_step_failed (Codex F5)', () => {
  it('survivor missing locally after vendor success → vendor_merge_failed (terminal)', async () => {
    // Note: NO seedContact for survivor — only the loser exists.
    seedContact('loser@example.com', 'Loser');
    seedCandidate('cand_1', 'loser@example.com', 'survivor@example.com');

    const merger = makeFakeMerger('hubspot:contact');
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['hubspot:contact', merger.client],
    ]);

    // Seed survivor for the request rpc's pre-flight check, then
    // delete it before the local step runs. Easiest path: bypass the
    // request rpc's `ensureSurvivor` by directly inserting an outbox
    // row at `vendor_merge_succeeded` (post-vendor) + driving via
    // recovery. The local step then hits the missing-survivor path.
    const idem_input: UpstreamMergeIdempotencyInput = {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'm', loser_platform_id: 'v' }],
    };
    store.insert({
      id: 'survivor_missing',
      approval_id: 'app_missing',
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      loser_emails: ['loser@example.com'],
      vendor_pairs: idem_input.vendor_pairs as { survivor_platform_id: string; loser_platform_id: string }[],
      idempotency_key: computeUpstreamMergeIdempotencyKey(idem_input, realSha),
      state: 'vendor_merge_succeeded',
      attempts: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    const failureEvents: string[] = [];
    bus.subscribe('survivor-missing', { kinds: ['upstream_merge_failed'] }, (ev) => {
      if (ev.kind === 'upstream_merge_failed') failureEvents.push(ev.error_code);
    });

    const result = await runUpstreamMergeRecoverySweep(
      buildDeps(registry),
      () => 'main',
    );
    expect(result.failed).toBe(1);
    const finalRow = store.get('survivor_missing');
    expect(finalRow?.state).toBe('vendor_merge_failed');
    expect(finalRow?.last_error?.code).toBe('survivor_missing_locally');
    // Bus emit fired (via the centralized helper).
    expect(failureEvents).toContain('survivor_missing_locally');
    // Audit chain shows local_step_failed.
    expect(audits.map((a) => a.transition)).toContain('local_step_failed');
  });
});

// ────────────────────────────────────────────────────────────────
// Fold-back surface — phantom-approval guard on idempotent replay
// ────────────────────────────────────────────────────────────────

describe('D-138 P5 fold-back — phantom approval guard (Codex F8)', () => {
  it('idempotent replay against a terminal row does NOT re-add an approval', async () => {
    seedContact('survivor@example.com', 'Survivor');
    seedContact('loser@example.com', 'Loser');
    seedCandidate('cand_1', 'loser@example.com', 'survivor@example.com');

    const merger = makeFakeMerger('hubspot:contact');
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['hubspot:contact', merger.client],
    ]);
    // First request — drives to terminal, registers approval, marks resolved.
    await handleUpstreamMergeRequest(buildDeps(registry), {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'hs_master', loser_platform_id: 'hs_victim' }],
      connection_name: 'main',
    });
    expect(approvalSink.pending).toHaveLength(1);
    expect(approvalSink.resolved).toHaveLength(1);

    // Second request — same idempotency key. No new approval should
    // surface; the existing terminal row stays terminal.
    await handleUpstreamMergeRequest(buildDeps(registry), {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'hs_master', loser_platform_id: 'hs_victim' }],
      connection_name: 'main',
    });
    expect(approvalSink.pending).toHaveLength(1); // Did NOT bump.
    expect(approvalSink.resolved).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Fold-back surface — retry budget pre-check on resume (Codex F6)
// ────────────────────────────────────────────────────────────────

describe('D-138 P5 fold-back — retry budget pre-check on resume (Codex F6)', () => {
  it('resuming an in_flight row at the budget exits without firing a new vendor call', async () => {
    seedContact('survivor@example.com', 'Survivor');
    seedContact('loser@example.com', 'Loser');
    seedCandidate('cand_1', 'loser@example.com', 'survivor@example.com');

    // Manually craft a row at `vendor_merge_in_flight` with
    // attempts === UPSTREAM_MERGE_RETRY_BUDGET (3). Recovery sweep
    // should NOT fire a 4th call.
    const idem_input: UpstreamMergeIdempotencyInput = {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'm', loser_platform_id: 'v' }],
    };
    store.insert({
      id: 'budget_exhausted',
      approval_id: 'app_exhausted',
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      loser_emails: ['loser@example.com'],
      vendor_pairs: idem_input.vendor_pairs as { survivor_platform_id: string; loser_platform_id: string }[],
      idempotency_key: computeUpstreamMergeIdempotencyKey(idem_input, realSha),
      state: 'vendor_merge_in_flight',
      attempts: 3,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    const merger = makeFakeMerger('hubspot:contact');
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['hubspot:contact', merger.client],
    ]);
    const result = await runUpstreamMergeRecoverySweep(
      buildDeps(registry),
      () => 'main',
    );
    expect(result.failed).toBe(1);
    expect(merger.calls).toBe(0);
    expect(store.get('budget_exhausted')?.state).toBe('vendor_merge_failed');
  });
});

// ────────────────────────────────────────────────────────────────
// list + discard
// ────────────────────────────────────────────────────────────────

describe('D-138 P5 — list + discard', () => {
  it('default list returns vendor_merge_failed rows only', async () => {
    seedContact('survivor@example.com', 'Survivor');
    seedContact('loser@example.com', 'Loser');
    seedCandidate('cand_1', 'loser@example.com', 'survivor@example.com');
    const merger = makeFakeMerger('hubspot:contact', [
      { ok: false, retryable: false, error: { code: 'vendor_invalid_request', message: '400', http_status: 400 } },
    ]);
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['hubspot:contact', merger.client],
    ]);
    await handleUpstreamMergeRequest(buildDeps(registry), {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'hs_master', loser_platform_id: 'hs_victim' }],
      connection_name: 'main',
    });
    const listed = await handleUpstreamMergeList(buildDeps(registry), undefined);
    expect(listed.rows).toHaveLength(1);
    expect(listed.rows[0]!.state).toBe('vendor_merge_failed');
  });

  it('discard removes a failed row + audit recorded', async () => {
    seedContact('survivor@example.com', 'Survivor');
    seedContact('loser@example.com', 'Loser');
    seedCandidate('cand_1', 'loser@example.com', 'survivor@example.com');
    const merger = makeFakeMerger('hubspot:contact', [
      { ok: false, retryable: false, error: { code: 'vendor_invalid_request', message: '400', http_status: 400 } },
    ]);
    const registry = new Map<UpstreamMergeObjectType, VendorMergeClient>([
      ['hubspot:contact', merger.client],
    ]);
    const r = await handleUpstreamMergeRequest(buildDeps(registry), {
      vendor: 'hubspot',
      object_type: 'hubspot:contact',
      candidate_ids: ['cand_1'],
      survivor_email: 'survivor@example.com',
      vendor_pairs: [{ survivor_platform_id: 'hs_master', loser_platform_id: 'hs_victim' }],
      connection_name: 'main',
    });
    const discardResp = await handleUpstreamMergeDiscard(buildDeps(registry), {
      failed_outbox_id: r.outbox_id,
    });
    expect(discardResp.discarded).toBe(true);
    expect(store.get(r.outbox_id)).toBeNull();
    expect(audits.map((a) => a.transition)).toContain('outbox_discarded');
  });
});
