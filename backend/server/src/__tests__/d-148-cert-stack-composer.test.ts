/** D-148 § A.6.5 — cert-stack composer pair-revoke cascade acceptance.
 *
 *  Slice 104 closes the second half of NEXT-#2 (the first half — engine-
 *  driven `save` unification onto `adoptServerIdentity` — landed in slice
 *  103). The composer wires every hook the rotation engine's
 *  `rotateServerIdentity` flow needs to a real impl: the DB-side mass
 *  revoke against `PairedInstancesStore.revokeAllActive` (returning the
 *  revoked instance_id list) + the WS-side fan-out via the
 *  `closeAllActiveSessions` closure bin.ts threads in (resolved lazily
 *  against `wsHandleForLockoutRef`).
 *
 *  D-156 P9 retired the bus-side `pair_required` emit slot — recovery
 *  now flows through the natural disconnect → unpaired-state →
 *  pair-form remount path driven by the webclient's `onReauthRequired`
 *  funnel. The cascade-against-substrate coverage below pins the
 *  remaining DB + WS hooks.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';

import { composeCertStack } from '../composition/bin/wire-cert-stack.js';
import { createPairedInstancesStore } from '../paired-instances-store.js';
import { createClientTokenStore } from '../pairing/client-tokens.js';
import { createEventBus } from '../events/bus.js';
import { createServerIdentity } from '../identity/index.js';
import { createInMemoryServerKeyStore } from '../keys/index.js';
import type { BootedServerIdentity } from '../identity/boot.js';

const buildSigningIdentity = (): BootedServerIdentity => {
  const keyStore = createInMemoryServerKeyStore();
  const identity = createServerIdentity({ store: keyStore });
  return {
    identity,
    keyStore,
    // Composer never reads `filePath` / `created`; satisfy the shape.
    filePath: '/tmp/d-148-cert-stack-composer-test-keys.bin',
    created: false,
  };
};

const buildAuditLog = () =>
  createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );

/** Bootstrap the minimum schema the composer's `createSqliteProAuthStore`
 *  + companion stores expect. bin.ts emits the same DDL at boot; we
 *  replicate the call inside each test fixture so the composer's
 *  state-machine bootstrap (eager `current()` calls against SQLite)
 *  succeeds against a fresh `:memory:` db. */
const ensureServerConfigTable = (db: Database.Database): void => {
  db.exec(`CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
};

describe('D-148 § A.6.5 — cert-stack composer pair-revoke cascade', () => {
  it('engine-driven rotateServerIdentity drives DB revoke + WS close', async () => {
    const db = new Database(':memory:');
    ensureServerConfigTable(db);
    const pairedInstances = createPairedInstancesStore(db);
    pairedInstances.addOrRefresh({ instance_id: 'phone', user_id: 'u', display_name: 'Phone' });
    pairedInstances.addOrRefresh({ instance_id: 'laptop', user_id: 'u', display_name: 'Laptop' });
    pairedInstances.addOrRefresh({ instance_id: 'tablet', user_id: 'u', display_name: 'Tablet' });

    // Seat two active bearer rows so the Codex-flagged fold has
    // observable subjects — without this the revoke call is a no-op
    // and the `client_tokens` snapshot can't tell whether the call
    // actually ran.
    const clientTokens = createClientTokenStore(db);
    const tokenA = await clientTokens.issue({ client_kind: 'webclient', client_label: 'Laptop' });
    const tokenB = await clientTokens.issue({ client_kind: 'bridge', client_label: 'Phone' });

    let closeCallCount = 0;
    const closeAllActiveSessions = (): number => {
      closeCallCount += 1;
      // Production resolves against the WS listener's connected-client
      // count; in the composer test we don't need a live WS listener —
      // returning 3 (one per active paired_instances row above) lets
      // us assert the engine's `closed_session_count` propagation
      // without binding a real socket.
      return 3;
    };

    const signingIdentity = buildSigningIdentity();
    const certStack = await composeCertStack({
      db,
      auditLog: buildAuditLog(),
      signingIdentity,
      eventBus: createEventBus(),
      cloudBaseUrl: 'https://api.test.recued.cloud',
      pairedInstances,
      clientTokens,
      closeAllActiveSessions,
    });
    expect(certStack.rotationEngine).toBeDefined();

    const fp_before = signingIdentity.identity.serverIdentityKey().public_key_fingerprint;
    const result = await certStack.rotationEngine!.rotateServerIdentity({
      triggered_by_client_id: 'admin-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    // Engine surface — repair_client_ids carries the instance_ids the
    // DB-side revoke captured. Sort for stable comparison; the impl
    // iterates SQLite's row order which depends on insertion.
    expect([...(result.repair_client_ids ?? [])].sort()).toEqual(['laptop', 'phone', 'tablet']);
    // Identity rotated through `adoptServerIdentity(next)` (slice 103
    // save unification) — cache + persisted store both swapped.
    const fp_after = signingIdentity.identity.serverIdentityKey().public_key_fingerprint;
    expect(fp_after).not.toBe(fp_before);
    expect(signingIdentity.keyStore.loadServerIdentityKey()!.public_key_fingerprint).toBe(fp_after);

    // DB-side fan-out — every active paired_instances row + every
    // active client_tokens row are revoked in lockstep (Codex P2 fold:
    // bearer rows must retire alongside the device-pairing rows or a
    // surviving bearer could re-auth against the rotated identity).
    expect(pairedInstances.listActive('u')).toEqual([]);
    expect(pairedInstances.get('phone')!.revoked_at).not.toBeNull();
    expect(pairedInstances.get('laptop')!.revoked_at).not.toBeNull();
    expect(pairedInstances.get('tablet')!.revoked_at).not.toBeNull();
    expect(clientTokens.list({ include_revoked: false })).toHaveLength(0);
    const allTokens = clientTokens.list({ include_revoked: true });
    expect(allTokens.find((t) => t.token_id === tokenA.token_id)!.revoked_at).not.toBeNull();
    expect(allTokens.find((t) => t.token_id === tokenB.token_id)!.revoked_at).not.toBeNull();

    // WS-side fan-out — the closer closure was invoked once.
    expect(closeCallCount).toBe(1);
  });

  it('markCompromised cascades into rotateServerIdentity with the DB revoke fanout', async () => {
    const db = new Database(':memory:');
    ensureServerConfigTable(db);
    const pairedInstances = createPairedInstancesStore(db);
    pairedInstances.addOrRefresh({ instance_id: 'only', user_id: 'u', display_name: 'Only' });
    const clientTokens = createClientTokenStore(db);
    const certStack = await composeCertStack({
      db,
      auditLog: buildAuditLog(),
      signingIdentity: buildSigningIdentity(),
      eventBus: createEventBus(),
      cloudBaseUrl: 'https://api.test.recued.cloud',
      pairedInstances,
      clientTokens,
      closeAllActiveSessions: () => 0,
    });
    // `markCompromised` flags the ledger, then the engine cascades
    // through `rotateServerIdentity` which drains it. Post-D-156 P9 the
    // bus-side `pair_required` emit is gone; recovery flows through the
    // webclient's `onReauthRequired` funnel after the bearer revoke
    // below. We assert the DB-side fanout still fires.
    await certStack.rotationEngine!.markCompromised({
      key_class: 'server_identity_key',
      triggered_by_client_id: 'admin-1',
    });
    expect(pairedInstances.listActive('u')).toEqual([]);
    expect(pairedInstances.get('only')!.revoked_at).not.toBeNull();
  });

  it('returns empty revoked list when no paired_instances rows are active', async () => {
    const db = new Database(':memory:');
    ensureServerConfigTable(db);
    const pairedInstances = createPairedInstancesStore(db);
    const clientTokens = createClientTokenStore(db);
    const eventBus = createEventBus();
    const certStack = await composeCertStack({
      db,
      auditLog: buildAuditLog(),
      signingIdentity: buildSigningIdentity(),
      eventBus,
      cloudBaseUrl: 'https://api.test.recued.cloud',
      pairedInstances,
      clientTokens,
      closeAllActiveSessions: () => 0,
    });
    const result = await certStack.rotationEngine!.rotateServerIdentity({
      triggered_by_client_id: 'admin-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // Zero paired rows → empty repair_client_ids — rotation still
    // completes (audit row records the rotation event regardless).
    expect(result.repair_client_ids).toEqual([]);
  });
});
