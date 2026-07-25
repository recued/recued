/** R26.4 Delta 3 (D-148 § A.11 / § P7) — `key.rotate` + `key.health` rpc
 *  handler + durable compromise ledger tests.
 *
 *  Covers:
 *    - handleKeyHealth: returns the view; operator-only (null instance_id
 *      → forbidden).
 *    - handleKeyRotate: operator-only gate runs BEFORE arg validation
 *      (Codex P1 fold); dispatches each accepted op to the right engine
 *      method; rejects the excluded ops (tls_renew / webclient_token_rotate)
 *      + garbage; validates vendor / key_class; surfaces RotationResult
 *      verbatim (incl. key_not_loaded for unwired ops).
 *    - buildKeyHealthView: overlays compromise_alert per class + attaches
 *      the availability map.
 *    - makeKeyRotateHandlers: undefined deps → undefined; else a slice
 *      exposing exactly [key.health, key.rotate].
 *    - createSqliteCompromiseLedger: mark / isMarked / clear roundtrip +
 *      durability across a re-open of the same db.
 *    - the engine sub_dek-escalation fold: a successful master_dek
 *      escalation clears the stale sub_dek flag (Codex P2 fold).
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import {
  RpcError,
  type KeyClass,
  type KeyHealthView,
  type RotationResult,
} from '@recued/contracts';

import {
  buildKeyHealthView,
  handleKeyHealth,
  handleKeyRotate,
  makeKeyRotateHandlers,
  type KeyRotationRpcDeps,
} from '../keys/rotation/key-rotate-handler.js';
import {
  createInMemoryCompromiseLedger,
  createRotationEngine,
  type RotationEngine,
  type RotationSideEffects,
} from '../keys/rotation/index.js';
import { createSqliteCompromiseLedger } from '../keys/rotation/compromise-ledger-store.js';
import { generateEd25519Keypair } from '../keys/index.js';
import type { WsClient } from '../ws-server.js';

const stubCtx = (instance_id: string | null): WsClient =>
  ({
    ws: null,
    realm: 'recued',
    instance_id,
    display_name: 'test client',
    connected_at: Date.now(),
  }) as unknown as WsClient;

const noopEffects = (): RotationSideEffects => ({
  recordAudit: async () => {},
  broadcast: async () => {},
  broadcastCertRotationNotice: async () => {},
  broadcastCertRotationReverted: async () => {},
});

/** Engine with only `server_identity` + `compromise_ledger` wired — the
 *  self-host shape. master_dek / publisher / webhook return
 *  `key_not_loaded`. */
const buildSelfHostEngine = (
  compromiseLedger = createInMemoryCompromiseLedger(),
): RotationEngine => {
  const identity = generateEd25519Keypair('server_identity_key');
  return createRotationEngine({
    server_identity: {
      load: async () => identity,
      save: async () => {},
      revokeAllPairedClients: async () => ({ revoked_client_ids: ['dev-1', 'dev-2'] }),
    },
    compromise_ledger: compromiseLedger,
    effects: noopEffects(),
  });
};

const healthView = (): KeyHealthView => ({
  key_health: {
    master_dek: { status: 'healthy' },
    sub_dek: { status: 'healthy' },
    server_identity_key: { status: 'healthy' },
    publisher_identity_key: { status: 'healthy' },
    tls_private_key: { status: 'healthy' },
    webclient_token: { status: 'healthy' },
    webhook_secret: { status: 'healthy' },
  },
  availability: {
    master_dek: 'unavailable',
    sub_dek: 'unavailable',
    server_identity_key: 'available',
    publisher_identity_key: 'unavailable',
    tls_private_key: 'managed_elsewhere',
    webclient_token: 'managed_elsewhere',
    webhook_secret: 'unavailable',
  },
});

const depsFor = (engine: RotationEngine, view: KeyHealthView = healthView()): KeyRotationRpcDeps => ({
  engine,
  loadHealthView: async () => view,
});

describe('R26.4 Delta 3 — handleKeyHealth', () => {
  it('returns the loaded view verbatim', async () => {
    const view = healthView();
    const result = await handleKeyHealth(depsFor(buildSelfHostEngine(), view), stubCtx('admin-1'));
    expect(result).toEqual(view);
    expect(result.availability.server_identity_key).toBe('available');
    expect(result.availability.master_dek).toBe('unavailable');
  });

  it('operator-only — null instance_id → forbidden 401', async () => {
    await expect(
      handleKeyHealth(depsFor(buildSelfHostEngine()), stubCtx(null)),
    ).rejects.toMatchObject({ code: 'forbidden', status: 401 });
  });
});

describe('R26.4 Delta 3 — handleKeyRotate gate + validation', () => {
  it('Codex P1 fold — null instance_id rejected with forbidden BEFORE arg validation', async () => {
    // A malformed op from a null-instance caller must still see forbidden,
    // not bad_request (no probing of accepted op names).
    await expect(
      handleKeyRotate(
        depsFor(buildSelfHostEngine()),
        { op: 'not_a_real_op' as never },
        stubCtx(null),
      ),
    ).rejects.toMatchObject({ code: 'forbidden', status: 401 });
  });

  it('rejects the excluded tls_renew op with bad_request', async () => {
    await expect(
      handleKeyRotate(depsFor(buildSelfHostEngine()), { op: 'tls_renew' as never }, stubCtx('admin-1')),
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects the excluded webclient_token_rotate op with bad_request', async () => {
    await expect(
      handleKeyRotate(
        depsFor(buildSelfHostEngine()),
        { op: 'webclient_token_rotate' as never },
        stubCtx('admin-1'),
      ),
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects a non-object args body with bad_request', async () => {
    await expect(
      handleKeyRotate(depsFor(buildSelfHostEngine()), null as never, stubCtx('admin-1')),
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects a non-string reason with bad_request', async () => {
    await expect(
      handleKeyRotate(
        depsFor(buildSelfHostEngine()),
        { op: 'server_identity_rotate', reason: 7 as never },
        stubCtx('admin-1'),
      ),
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects webhook_secret_rotate without a vendor', async () => {
    await expect(
      handleKeyRotate(
        depsFor(buildSelfHostEngine()),
        { op: 'webhook_secret_rotate' } as never,
        stubCtx('admin-1'),
      ),
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects mark_compromised with an unknown key_class', async () => {
    await expect(
      handleKeyRotate(
        depsFor(buildSelfHostEngine()),
        { op: 'mark_compromised', key_class: 'bogus' as never },
        stubCtx('admin-1'),
      ),
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });
});

describe('R26.4 Delta 3 — handleKeyRotate dispatch', () => {
  it('server_identity_rotate → rotateServerIdentity, returns repair_client_ids', async () => {
    const result = await handleKeyRotate(
      depsFor(buildSelfHostEngine()),
      { op: 'server_identity_rotate', reason: 'incident' },
      stubCtx('admin-1'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.op).toBe('server_identity_rotate');
    expect(result.repair_client_ids).toEqual(['dev-1', 'dev-2']);
  });

  it('mark_compromised(server_identity_key) → markCompromised, cascades the rotation', async () => {
    const result = await handleKeyRotate(
      depsFor(buildSelfHostEngine()),
      { op: 'mark_compromised', key_class: 'server_identity_key' },
      stubCtx('admin-1'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.op).toBe('mark_compromised');
    expect(result.key_class).toBe('server_identity_key');
    expect(result.dependents?.some((d) => d.key_class === 'server_identity_key')).toBe(true);
  });

  it('master_dek_rotate on a self-host engine → key_not_loaded verbatim (no throw)', async () => {
    const result = await handleKeyRotate(
      depsFor(buildSelfHostEngine()),
      { op: 'master_dek_rotate' },
      stubCtx('admin-1'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.op).toBe('master_dek_rotate');
    expect(result.error).toBe('key_not_loaded');
  });

  it('forwards triggered_by_client_id from ctx.instance_id', async () => {
    const calls: string[] = [];
    const base = buildSelfHostEngine();
    const engine: RotationEngine = {
      ...base,
      rotateServerIdentity: async (args) => {
        calls.push(args.triggered_by_client_id);
        return {
          ok: true,
          op: 'server_identity_rotate',
          key_class: 'server_identity_key',
          new_fingerprint: 'sha256:beef',
          repair_client_ids: [],
          rotated_at: 1,
        } satisfies RotationResult;
      },
    };
    await handleKeyRotate(depsFor(engine), { op: 'server_identity_rotate' }, stubCtx('alice-laptop'));
    expect(calls).toEqual(['alice-laptop']);
  });
});

describe('R26.4 Delta 3 — buildKeyHealthView', () => {
  it('overlays compromise_alert from the ledger + attaches availability', async () => {
    const availability = healthView().availability;
    const view = await buildKeyHealthView({
      availability,
      isCompromised: async (cls: KeyClass) => cls === 'master_dek',
    });
    expect(view.key_health.master_dek.compromise_alert).toBe(true);
    expect(view.key_health.server_identity_key.compromise_alert).toBeUndefined();
    expect(view.availability).toBe(availability);
    // Exhaustive over every key class.
    expect(Object.keys(view.key_health).sort()).toEqual(
      [
        'master_dek',
        'publisher_identity_key',
        'server_identity_key',
        'sub_dek',
        'tls_private_key',
        'webclient_token',
        'webhook_secret',
      ].sort(),
    );
  });
});

describe('R26.4 Delta 3 — makeKeyRotateHandlers', () => {
  it('returns undefined when deps absent', () => {
    expect(makeKeyRotateHandlers(undefined)).toBeUndefined();
  });

  it('returns a slice exposing exactly [key.health, key.rotate]', () => {
    const slice = makeKeyRotateHandlers(depsFor(buildSelfHostEngine()));
    expect(slice).toBeDefined();
    expect(slice?.methods).toEqual(['key.health', 'key.rotate']);
  });

  it('slice handlers delegate + thread ctx', async () => {
    const slice = makeKeyRotateHandlers(depsFor(buildSelfHostEngine()));
    if (!slice) throw new Error('unreachable');
    const health = await slice.handlers['key.health'](undefined, stubCtx('admin-1'));
    expect(health.availability.server_identity_key).toBe('available');
    const rotate = await slice.handlers['key.rotate'](
      { op: 'server_identity_rotate' },
      stubCtx('admin-1'),
    );
    expect(rotate.ok).toBe(true);
  });

  it('slice key.rotate handler still enforces the operator gate', async () => {
    const slice = makeKeyRotateHandlers(depsFor(buildSelfHostEngine()));
    if (!slice) throw new Error('unreachable');
    await expect(
      slice.handlers['key.rotate']({ op: 'server_identity_rotate' }, stubCtx(null)),
    ).rejects.toBeInstanceOf(RpcError);
  });
});

describe('R26.4 Delta 3 — createSqliteCompromiseLedger', () => {
  it('mark / isMarked / clear roundtrip', async () => {
    const db = new Database(':memory:');
    const ledger = createSqliteCompromiseLedger(db);
    expect(await ledger.isMarked('master_dek')).toBe(false);
    await ledger.mark({ key_class: 'master_dek', marked_at: 1, triggered_by_client_id: 'admin', reason: 'leak' });
    expect(await ledger.isMarked('master_dek')).toBe(true);
    expect(await ledger.isMarked('server_identity_key')).toBe(false);
    await ledger.clear('master_dek');
    expect(await ledger.isMarked('master_dek')).toBe(false);
    db.close();
  });

  it('durable — a flag survives a re-open of the same db file table', async () => {
    const db = new Database(':memory:');
    const ledger1 = createSqliteCompromiseLedger(db);
    await ledger1.mark({ key_class: 'master_dek', marked_at: 1, triggered_by_client_id: 'admin' });
    // A fresh ledger over the SAME db (simulates a process restart sharing
    // the on-disk table) still sees the flag.
    const ledger2 = createSqliteCompromiseLedger(db);
    expect(await ledger2.isMarked('master_dek')).toBe(true);
    db.close();
  });
});

describe('R26.4 Delta 3 — Codex P2 fold: sub_dek escalation clears the stale flag', () => {
  it('successful master_dek escalation from a sub_dek compromise clears sub_dek', async () => {
    const ledger = createInMemoryCompromiseLedger();
    const identity = generateEd25519Keypair('server_identity_key');
    const engine = createRotationEngine({
      master_dek: { current: () => new Uint8Array(32), install: async () => {} },
      master_dek_reencryptor: {
        // Stands in for a complete implementation: the substrate refuses to
        // rotate unless the reencryptor declares it rekeys the realm database.
        rekeysRealmDatabase: true,
        rotate: async ({ installNewMaster }) => {
          await installNewMaster();
          return { reencrypted_blob_count: 3 };
        },
      },
      server_identity: {
        load: async () => identity,
        save: async () => {},
        revokeAllPairedClients: async () => ({ revoked_client_ids: [] }),
      },
      compromise_ledger: ledger,
      effects: noopEffects(),
    });
    const r = await engine.markCompromised({ key_class: 'sub_dek', triggered_by_client_id: 'admin' });
    expect(r.ok).toBe(true);
    // Both the escalated master_dek AND the original sub_dek flag are clear
    // after a successful re-derivation — no permanent stale alert.
    expect(await ledger.isMarked('sub_dek')).toBe(false);
    expect(await ledger.isMarked('master_dek')).toBe(false);
  });

  it('a FAILED escalation (master_dek not loaded) leaves sub_dek marked for the operator', async () => {
    const ledger = createInMemoryCompromiseLedger();
    // No master_dek hooks → rotateMasterDek returns key_not_loaded → cascade
    // fails → both flags stay set (genuine unresolved compromise).
    const engine = buildSelfHostEngine(ledger);
    const r = await engine.markCompromised({ key_class: 'sub_dek', triggered_by_client_id: 'admin' });
    expect(r.ok).toBe(false);
    expect(await ledger.isMarked('sub_dek')).toBe(true);
  });
});
