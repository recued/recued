/** D-148 P3 + D-169 P0 Slice 2B — popup inspector tests.
 *
 *  Covers the no-state-proof gate (Appendix I.15): the inspector
 *  surface returns exactly the closed-list 8 fields. */

import { describe, it, expect, vi } from 'vitest';
import {
  buildBridgeStateInspection,
  documentedLocalKeys,
} from '../pairing/inspector.js';
import { createInMemoryBridgeLocalStore } from '../storage/local-store.js';
import { createFifoQueue } from '../queue/fifo-queue.js';
import { createInMemoryIdempotencyCache } from '../idempotency/cache.js';
import {
  buildGrant,
  createInMemoryBridgeGrantStore,
} from '../permissions/grants.js';
import {
  BRIDGE_LOCAL_STORAGE_FIELDS,
  type BridgeIngredientRef,
  type WebclientTokenRecord,
} from '@recued/contracts';

const fakeTokenRecord: WebclientTokenRecord = {
  token_id: 'tok-fixture',
  ciphertext_b64: 'Y2lwaGVy',
  iv_b64: 'aXY=',
  issued_at: 1_700_000_000_000,
};

const ingredient: BridgeIngredientRef = {
  publisher_id: 'recued-core',
  slug: 'draft-email-reader-hubspot',
  version: '1.0.0',
  surface_kind: 'reading',
  domain_allowlist: ['*://app.hubspot.com/*'],
  domain_allowlist_signature: 'PUB_SIG',
};

describe('D-148 P3 + D-169 P0 Slice 2B — popup inspector', () => {
  it('does not combine separate reads that straddle a confirmed completion', async () => {
    const idempotency = createInMemoryIdempotencyCache({ now: () => 500 });
    await idempotency.claim('late', 'private-key');
    const result = { command_id: 'late', status: 'ok' as const, duration_ms: 1,
      bridge_version: 'fixture', idempotency_key_seen: false };
    const receipts = idempotency.inspectReceipts.bind(idempotency), markers = idempotency.inspectInFlight.bind(idempotency);
    let release!: () => void;
    const completed = new Promise<void>(resolve => { release = resolve; });
    // Model a marker read that finishes first while opening receipt storage
    // is delayed. The intervening completion is durable before receipts read.
    const receiptRead = vi.spyOn(idempotency, 'inspectReceipts').mockImplementation(async () => { await completed; return receipts(); });
    const markerRead = vi.spyOn(idempotency, 'inspectInFlight').mockImplementation(async () => {
      const before = await markers(); await idempotency.store('late', 'private-key', result); release(); return before;
    });
    const deps = { local: createInMemoryBridgeLocalStore(), queue: createFifoQueue(),
      grants: createInMemoryBridgeGrantStore(), idempotency, now: () => 1_000 };
    const view = await buildBridgeStateInspection(deps);
    const confirmed = new Set(view.idempotency.recent_confirmed?.entries.map(entry => entry.command_id));
    expect(view.idempotency.in_flight?.entries.filter(entry => confirmed.has(entry.command_id))).toEqual([]);
    expect(receiptRead).not.toHaveBeenCalled(); expect(markerRead).not.toHaveBeenCalled();
    await idempotency.store('late', 'private-key', result);
    const after = await buildBridgeStateInspection(deps);
    expect(after.idempotency.in_flight?.count).toBe(0);
    expect(after.idempotency.recent_confirmed?.entries.map(entry => entry.command_id)).toEqual(['late']);
  });

  it('reports unfinished commands even when completed receipts cannot be inspected', async () => {
    const idempotency = createInMemoryIdempotencyCache({ now: () => 500 });
    await idempotency.claim('unconfirmed', 'private-key');
    idempotency.inspectDiagnostics = async () => { throw new Error('receipt unavailable'); };
    const view = await buildBridgeStateInspection({ local: createInMemoryBridgeLocalStore(),
      queue: createFifoQueue(), grants: createInMemoryBridgeGrantStore(), idempotency, now: () => 1_000 });
    expect(view.idempotency).toEqual({ entry_count: null, recent_confirmed: null,
      in_flight: { count: 1, entries: [{ command_id: 'unconfirmed', started_at: 500 }] } });
    expect((await idempotency.claim('retry', 'private-key')).kind).toBe('in_flight');
  });

  it('keeps an unavailable marker inspection distinct from an empty list', async () => {
    const idempotency = createInMemoryIdempotencyCache();
    idempotency.inspectDiagnostics = async () => ({ receipts: await idempotency.inspectReceipts(), in_flight: null });
    const view = await buildBridgeStateInspection({ local: createInMemoryBridgeLocalStore(),
      queue: createFifoQueue(), grants: createInMemoryBridgeGrantStore(), idempotency, now: () => 1_000 });
    expect(view.idempotency).toEqual({ entry_count: 0, in_flight: null, recent_confirmed: { count: 0, entries: [] } });
  });

  it('resolves the cache from its local pair snapshot rather than the prior running connection', async () => {
    const old = createInMemoryIdempotencyCache(), fresh = createInMemoryIdempotencyCache({ now: () => 700 });
    await old.claim('old-pair-command', 'old-key'); await fresh.claim('fresh-pair-command', 'new-key');
    const idempotencyForPair = vi.fn(() => fresh);
    const view = await buildBridgeStateInspection({ local: createInMemoryBridgeLocalStore({
      server_url: 'wss://new.fixture.invalid/ws', server_public_key: 'new-key', webclient_token: fakeTokenRecord }),
    queue: createFifoQueue(), grants: createInMemoryBridgeGrantStore(), idempotency: old, idempotencyForPair, now: () => 1_000 });
    expect(idempotencyForPair).toHaveBeenCalledWith({ server_public_key: 'new-key', token_id: fakeTokenRecord.token_id });
    expect(view.idempotency.in_flight?.entries).toEqual([{ command_id: 'fresh-pair-command', started_at: 700 }]);
    expect(Object.keys(view.local).sort()).toEqual([...BRIDGE_LOCAL_STORAGE_FIELDS].sort());
  });

  it('returns inspection with exactly the documented 10 local fields', async () => {
    const local = createInMemoryBridgeLocalStore({
      server_url: 'wss://alice.recued.cloud:8443/ws',
      webclient_token: fakeTokenRecord,
      server_public_key: 'pubkey.b64',
    });
    const queue = createFifoQueue();
    const idempotency = createInMemoryIdempotencyCache({ now: () => 1_000 });
    const grants = createInMemoryBridgeGrantStore();
    const inspection = await buildBridgeStateInspection({
      local,
      queue,
      idempotency,
      grants,
      now: () => 2_000,
    });
    expect(Object.keys(inspection.local).sort()).toEqual([...BRIDGE_LOCAL_STORAGE_FIELDS].sort());
  });

  it('queue snapshot reports current_command_id + depth + paused', async () => {
    const local = createInMemoryBridgeLocalStore();
    const queue = createFifoQueue();
    const idempotency = createInMemoryIdempotencyCache();
    const grants = createInMemoryBridgeGrantStore();
    queue.setPaused(true);
    const inspection = await buildBridgeStateInspection({
      local,
      queue,
      idempotency,
      grants,
      now: () => 0,
    });
    expect(inspection.queue.paused).toBe(true);
    expect(inspection.queue.pending_depth).toBe(0);
    expect(inspection.queue.current_command_id).toBeNull();
  });

  it('grants summary reports count + most-recent timestamp', async () => {
    const local = createInMemoryBridgeLocalStore();
    const queue = createFifoQueue();
    const idempotency = createInMemoryIdempotencyCache();
    const grants = createInMemoryBridgeGrantStore();
    await grants.put(buildGrant(ingredient, ['*://app.hubspot.com/*'], 1_700_000));
    await grants.put(
      buildGrant({ ...ingredient, slug: 'other' }, ['*://linkedin.com/*'], 1_800_000),
    );
    const inspection = await buildBridgeStateInspection({
      local,
      queue,
      idempotency,
      grants,
      now: () => 1_900_000,
    });
    expect(inspection.grants.count).toBe(2);
    expect(inspection.grants.most_recent_at).toBe(1_800_000);
  });

  it('idempotency summary reports entry count', async () => {
    const local = createInMemoryBridgeLocalStore();
    const queue = createFifoQueue();
    const idempotency = createInMemoryIdempotencyCache({ now: () => 1_000 });
    await idempotency.store('cmd-1', 'idem-1', {
      command_id: 'cmd-1',
      status: 'ok',
      duration_ms: 1,
      bridge_version: '0.0.1',
      idempotency_key_seen: false,
    });
    const grants = createInMemoryBridgeGrantStore();
    const fullReceipts = vi.spyOn(idempotency, 'list').mockRejectedValue(new Error('must not load result bodies'));
    const inspection = await buildBridgeStateInspection({
      local,
      queue,
      idempotency,
      grants,
      now: () => 2_000,
    });
    expect(inspection.idempotency.entry_count).toBe(1);
    expect(inspection.idempotency.recent_confirmed).toEqual({ count: 1,
      entries: [{ command_id: 'cmd-1', status: 'ok', stored_at: 1_000 }] });
    expect(fullReceipts).not.toHaveBeenCalled();
  });

  it('reports an unavailable receipt count without failing the diagnostic snapshot', async () => {
    const idempotency = createInMemoryIdempotencyCache();
    idempotency.inspectDiagnostics = async () => { throw new Error('receipt database unavailable'); };
    const inspection = await buildBridgeStateInspection({
      local: createInMemoryBridgeLocalStore(), queue: createFifoQueue(), idempotency,
      grants: createInMemoryBridgeGrantStore(), now: () => 2_000,
    });
    expect(inspection.idempotency.entry_count).toBeNull();
    expect(Object.keys(inspection.local).sort()).toEqual([...BRIDGE_LOCAL_STORAGE_FIELDS].sort());
    expect(inspection.queue).toEqual({ current_command_id: null, pending_depth: 0, paused: false });
    expect(inspection.inspected_at).toBe(2_000);
  });

  it('documentedLocalKeys returns the 10 closed-list keys', () => {
    expect(documentedLocalKeys()).toEqual(BRIDGE_LOCAL_STORAGE_FIELDS);
  });
});
