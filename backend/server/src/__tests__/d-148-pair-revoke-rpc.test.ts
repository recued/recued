/** D-148 § A.2.1 — `pair.revoke` rpc audit emission tests.
 *
 *  Closes the mint → consume → revoke ledger arc: the matching
 *  `pair_mint` + `pair_consume` audit emission tests live in
 *  `d-148-pair-mint-rpc.test.ts` + `d-148-pair-consume-rpc.test.ts`.
 *
 *  Covers:
 *    - happy path: one `pair_revoke` audit row on success with
 *      `instance_id` as target + `revoked_by_user_id` /
 *      `revoked_by_instance_id` / `display_name` in detail.
 *    - deterministic `activity_id` keyed on the durable `instance_id`
 *      so the wrapper's canonical-JSON signing path round-trips
 *      cleanly through the underlying store (mirrors the
 *      mint/consume Codex P1 fold rationale).
 *    - failure paths (bad_request / unauthorized / not_found /
 *      forbidden) emit nothing — the ledger only carries rows that
 *      actually revoked a device.
 *    - omitting `auditLog` keeps the rpc working — composer-side
 *      absence is a no-op (matches mint/consume).
 *    - audit emit failures are best-effort — the device is already
 *      revoked + the ws is already closed; an audit-sink throw is a
 *      missed row, not a rolled-back revoke.
 *    - end-to-end signing round-trip through `createSigningAuditLog`
 *      + `verifyActivityEntry` — the stored row's signature verifies
 *      against the server-identity public key + reserve is auto-set.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import {
  handlePairRevoke,
  makePairHandlers,
  type PairHandlerDeps,
  type PairListChangedEvent,
} from '../pair-handler.js';
import {
  createPairedInstancesStore,
  type PairedInstancesStore,
} from '../paired-instances-store.js';
import type { WsClient, WsServerHandle } from '../ws-server.js';
import {
  generateEd25519Keypair,
  type Ed25519Keypair,
} from '../keys/index.js';

const FIXED_NOW = 1_700_000_000_000;

const stubCtx = (
  instance_id: string | null,
  user_id: string = 'mary',
): WsClient =>
  ({
    ws: null,
    realm: 'recued',
    instance_id,
    display_name: 'caller client',
    connected_at: Date.now(),
    user_id,
  }) as unknown as WsClient;

/** D-148 § A.2.1 — test stub mirrors the production
 *  `revokeConnectedInstance` shape (`{ revoked, client_token_id? }`)
 *  so test deps don't drift from the real handle. `tokenByInstance`
 *  seeds the per-instance `client_token_id` the live ws would have
 *  carried — undefined entries simulate the today-state where WS
 *  auth hasn't been flipped to bearer-verify yet, populated entries
 *  simulate the future-state where the join column resolves. */
const stubWsServer = (
  tokenByInstance: Record<string, string> = {},
): WsServerHandle & { closedIds: string[] } => {
  const closedIds: string[] = [];
  return {
    clientCount: () => 0,
    listConnectedInstances: () => [],
    getPairedUserId: () => undefined,
    revokeConnectedInstance: (id: string) => {
      closedIds.push(id);
      const client_token_id = tokenByInstance[id];
      return {
        revoked: true,
        ...(client_token_id !== undefined ? { client_token_id } : {}),
      };
    },
    revokeAllConnectedInstances: () => 0,
    closeAllForWsLockout: () => 0,
    closedIds,
  } as unknown as WsServerHandle & { closedIds: string[] };
};

describe('D-148 § A.2.1 — handlePairRevoke rpc audit emission', () => {
  let db: Database.Database;
  let paired: PairedInstancesStore;
  let wsServer: WsServerHandle & { closedIds: string[] };

  beforeEach(() => {
    db = new Database(':memory:');
    paired = createPairedInstancesStore(db);
    wsServer = stubWsServer();
    paired.addOrRefresh({
      instance_id: 'ext-target',
      user_id: 'mary',
      display_name: "Mary's laptop ext",
    });
  });

  it('emits one pair_revoke audit row on successful revoke with instance_id as target + revoked_by_user_id in detail', async () => {
    const rows: Array<{
      activity_id: string;
      action: string;
      target: string;
      detail?: string;
      timestamp: number;
    }> = [];
    const deps: PairHandlerDeps = {
      paired,
      wsServer,
      auditLog: {
        logActivity: async (entry) => {
          rows.push({
            activity_id: entry.activity_id,
            action: entry.action,
            target: entry.target,
            ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
            timestamp: entry.timestamp,
          });
        },
      },
      now: () => FIXED_NOW,
    };
    const result = await handlePairRevoke(
      deps,
      'mary',
      { instance_id: 'ext-target' },
      { instance_id: 'caller-client-id' },
    );
    expect(result).toEqual({ ok: true });
    // Best-effort emit is fire-and-forget; let the microtask settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe('pair_revoke');
    expect(row.target).toBe('ext-target');
    expect(row.timestamp).toBe(FIXED_NOW);
    // `activity_id` MUST be populated at handler emit time so the
    // `createSigningAuditLog` wrapper signs the canonical-JSON bytes
    // that actually persist. An empty string would be mutated to a
    // generated id by `createAuditLogStore.logActivity` AFTER signing
    // → verification would surface `signature_invalid` (Codex P1
    // 2026-05-17 fold). Deterministic id keyed on the durable
    // instance_id.
    expect(row.activity_id).toBe('pair_revoke:ext-target');
    const detail = JSON.parse(row.detail!) as {
      revoked_by_user_id: string;
      revoked_by_instance_id?: string;
      client_token_id?: string;
      display_name: string;
    };
    expect(detail.revoked_by_user_id).toBe('mary');
    expect(detail.revoked_by_instance_id).toBe('caller-client-id');
    expect(detail.display_name).toBe("Mary's laptop ext");
    // D-148 § A.2.1 join-column scaffold — the stub didn't seed a
    // `client_token_id` for `ext-target`, so the detail must omit the
    // key rather than emit null. This pins the today-state where WS
    // upgrade hasn't been flipped to bearer-verify; the "populated"
    // future-state test below seeds the stub + asserts presence.
    expect('client_token_id' in detail).toBe(false);
    // The durable revoke + ws close both happened before the audit row
    // — the device is already gone the moment those land.
    expect(paired.isRevoked('ext-target')).toBe(true);
    expect(wsServer.closedIds).toEqual(['ext-target']);
  });

  it('stamps detail.client_token_id when the live ws carried one (D-148 § A.2.1 join column)', async () => {
    // Forward-compat path: once WS auth verifies the bearer against
    // `client_tokens` + populates `WsClient.client_token_id`, this
    // assertion is what guarantees `pair_revoke.detail->>'client_token_id'
    // = pair_consume.target` joins the consume → revoke arc end-to-end
    // for a given device. We seed the stub here to simulate that state
    // ahead of the WS-auth slice landing — the production handler reads
    // `revokeConnectedInstance(...).client_token_id` verbatim, so any
    // future regression that drops the field on the wire will surface
    // here BEFORE the WS-auth slice ships, not after.
    const seededWsServer = stubWsServer({
      'ext-target': 'ctok-laptop-ext',
    });
    const rows: Array<{ detail?: string }> = [];
    const deps: PairHandlerDeps = {
      paired,
      wsServer: seededWsServer,
      auditLog: {
        logActivity: async (entry) => {
          rows.push(entry.detail !== undefined ? { detail: entry.detail } : {});
        },
      },
      now: () => FIXED_NOW,
    };
    await handlePairRevoke(
      deps,
      'mary',
      { instance_id: 'ext-target' },
      { instance_id: 'caller-client-id' },
    );
    await new Promise((r) => setTimeout(r, 0));
    const detail = JSON.parse(rows[0]!.detail!) as Record<string, unknown>;
    expect(detail.client_token_id).toBe('ctok-laptop-ext');
    // Sanity: other detail fields stay intact alongside the new key.
    expect(detail.revoked_by_user_id).toBe('mary');
    expect(detail.revoked_by_instance_id).toBe('caller-client-id');
    expect(detail.display_name).toBe("Mary's laptop ext");
  });

  it('omits revoked_by_instance_id from detail when ctx.instance_id is null (webclient bearer-only path)', async () => {
    const rows: Array<{ detail?: string }> = [];
    const deps: PairHandlerDeps = {
      paired,
      wsServer,
      auditLog: {
        logActivity: async (entry) => {
          rows.push(entry.detail !== undefined ? { detail: entry.detail } : {});
        },
      },
      now: () => FIXED_NOW,
    };
    await handlePairRevoke(
      deps,
      'mary',
      { instance_id: 'ext-target' },
      { instance_id: null },
    );
    await new Promise((r) => setTimeout(r, 0));
    const detail = JSON.parse(rows[0]!.detail!) as Record<string, unknown>;
    expect(detail.revoked_by_user_id).toBe('mary');
    expect('revoked_by_instance_id' in detail).toBe(false);
  });

  it('revokes the device BEARER token(s) on revoke — online (client_token_id) + offline (metadata.instance_id)', async () => {
    // The online socket carried `ctok-online`; revokeConnectedInstance returns it.
    const seededWsServer = stubWsServer({ 'ext-target': 'ctok-online' });
    const revoked: string[] = [];
    // Two tokens bound to ext-target (one is the online one, one offline) +
    // an unrelated token for a different device that MUST stay valid.
    const clientTokens = {
      revoke: (token_id: string, _reason: string) => { revoked.push(token_id); },
      list: () => [
        { token_id: 'ctok-online', metadata: { instance_id: 'ext-target' } },
        { token_id: 'ctok-offline', metadata: { instance_id: 'ext-target' } },
        { token_id: 'ctok-other', metadata: { instance_id: 'other-device' } },
      ],
    } as unknown as PairHandlerDeps['clientTokens'];
    const deps: PairHandlerDeps = {
      paired,
      wsServer: seededWsServer,
      clientTokens,
      now: () => FIXED_NOW,
    };
    await handlePairRevoke(deps, 'mary', { instance_id: 'ext-target' }, { instance_id: 'caller' });
    // Both tokens bound to ext-target are revoked (online + offline); the
    // unrelated device's token is untouched. (`ctok-online` may be revoked
    // twice — once via the live path, once via the list loop — but `revoke`
    // is idempotent; the Set dedups for the assertion.)
    expect(new Set(revoked)).toEqual(new Set(['ctok-online', 'ctok-offline']));
    expect(revoked).not.toContain('ctok-other');
  });

  it('revoke still succeeds when no clientTokens dep is wired (db-less)', async () => {
    const deps: PairHandlerDeps = { paired, wsServer, now: () => FIXED_NOW };
    const result = await handlePairRevoke(deps, 'mary', { instance_id: 'ext-target' }, { instance_id: 'caller' });
    expect(result).toEqual({ ok: true });
    expect(paired.isRevoked('ext-target')).toBe(true);
  });

  it('emits no audit row when the unauthorized auth gate rejects (no signed-in user)', async () => {
    const rows: Array<unknown> = [];
    const deps: PairHandlerDeps = {
      paired,
      wsServer,
      auditLog: {
        logActivity: async (entry) => {
          rows.push(entry);
        },
      },
    };
    await expect(
      handlePairRevoke(deps, '', { instance_id: 'ext-target' }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await new Promise((r) => setTimeout(r, 0));
    expect(rows).toHaveLength(0);
    // Defense: an unauthorized call must NOT mutate state.
    expect(paired.isRevoked('ext-target')).toBe(false);
    expect(wsServer.closedIds).toEqual([]);
  });

  it('emits no audit row when bad_request fires (empty instance_id)', async () => {
    const rows: Array<unknown> = [];
    const deps: PairHandlerDeps = {
      paired,
      wsServer,
      auditLog: {
        logActivity: async (entry) => {
          rows.push(entry);
        },
      },
    };
    await expect(
      handlePairRevoke(deps, 'mary', { instance_id: '' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await new Promise((r) => setTimeout(r, 0));
    expect(rows).toHaveLength(0);
  });

  it('emits no audit row when not_found fires (unknown instance_id)', async () => {
    const rows: Array<unknown> = [];
    const deps: PairHandlerDeps = {
      paired,
      wsServer,
      auditLog: {
        logActivity: async (entry) => {
          rows.push(entry);
        },
      },
    };
    await expect(
      handlePairRevoke(deps, 'mary', { instance_id: 'ghost' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await new Promise((r) => setTimeout(r, 0));
    expect(rows).toHaveLength(0);
  });

  it('emits no audit row when forbidden fires (cross-account revoke attempt)', async () => {
    const rows: Array<unknown> = [];
    const deps: PairHandlerDeps = {
      paired,
      wsServer,
      auditLog: {
        logActivity: async (entry) => {
          rows.push(entry);
        },
      },
    };
    await expect(
      handlePairRevoke(deps, 'eve', { instance_id: 'ext-target' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await new Promise((r) => setTimeout(r, 0));
    expect(rows).toHaveLength(0);
    // Cross-account guard fires BEFORE state mutation — the row must
    // remain active.
    expect(paired.isRevoked('ext-target')).toBe(false);
    expect(wsServer.closedIds).toEqual([]);
  });

  it('omits auditLog dep → handler still revokes (composer-side absence is a no-op)', async () => {
    const deps: PairHandlerDeps = { paired, wsServer };
    const result = await handlePairRevoke(deps, 'mary', {
      instance_id: 'ext-target',
    });
    expect(result).toEqual({ ok: true });
    expect(paired.isRevoked('ext-target')).toBe(true);
    expect(wsServer.closedIds).toEqual(['ext-target']);
  });

  it('audit emit failures do not roll back the revoke (best-effort write — device is already gone)', async () => {
    // A storage-layer throw at the audit sink shouldn't fail the rpc:
    // the durable revoke + ws close both already landed. Rolling the
    // rpc back on an audit-sink throw would re-grant the credential,
    // which is worse than a missed-row gap.
    let calls = 0;
    const deps: PairHandlerDeps = {
      paired,
      wsServer,
      auditLog: {
        logActivity: async () => {
          calls++;
          throw new Error('audit sink down');
        },
      },
    };
    const result = await handlePairRevoke(deps, 'mary', {
      instance_id: 'ext-target',
    });
    expect(result).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
    expect(paired.isRevoked('ext-target')).toBe(true);
  });

  it('idempotent retry on already-revoked instance: returns ok, emits no audit row, does not re-stamp the store, does not re-close the ws', async () => {
    // Codex P2 2026-05-17 fold — the deterministic activity_id
    // `pair_revoke:<instance_id>` collides on retry, which the audit
    // store treats as overwrite (audit.ts:840 `activities.set` is
    // last-write-wins). The fix short-circuits on `row.revoked_at !==
    // null` so the original signed row + revoke timestamp survive a
    // UI double-click / idempotency retry. The rpc still returns ok
    // so the caller treats both the first call + retry as success.
    const { createAuditLogStore, createInMemoryCollection } = await import(
      '@recued/storage'
    );
    const baseStore = createAuditLogStore(createInMemoryCollection());
    const deps: PairHandlerDeps = {
      paired,
      wsServer,
      auditLog: baseStore,
      now: () => FIXED_NOW,
    };
    // First revoke — original row lands.
    await handlePairRevoke(
      deps,
      'mary',
      { instance_id: 'ext-target' },
      { instance_id: 'caller-first' },
    );
    await new Promise((r) => setTimeout(r, 0));
    const originalRevokedAt = paired.get('ext-target')!.revoked_at;
    expect(originalRevokedAt).not.toBeNull();
    const firstRows = await baseStore.listActivities(10);
    expect(firstRows.filter((r) => r.action === 'pair_revoke')).toHaveLength(1);
    // Retry — must NOT mutate state, must NOT emit a second row.
    const depsRetry: PairHandlerDeps = {
      ...deps,
      // Bump the clock so a stale-replay revoke timestamp would be
      // detectable if the short-circuit failed (the durable store's
      // `revoke()` re-stamps with `now ?? Date.now()`, so a wall-clock
      // delta would surface).
      now: () => FIXED_NOW + 60_000,
    };
    const retryResult = await handlePairRevoke(
      depsRetry,
      'mary',
      { instance_id: 'ext-target' },
      { instance_id: 'caller-second' },
    );
    expect(retryResult).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 0));
    // Original revoke timestamp preserved.
    expect(paired.get('ext-target')!.revoked_at).toBe(originalRevokedAt);
    // Ledger holds exactly one pair_revoke row, with the original
    // caller in detail (NOT 'caller-second').
    const secondRows = await baseStore.listActivities(10);
    const revokeRows = secondRows.filter((r) => r.action === 'pair_revoke');
    expect(revokeRows).toHaveLength(1);
    const detail = JSON.parse(revokeRows[0]!.detail!) as Record<
      string,
      unknown
    >;
    expect(detail.revoked_by_instance_id).toBe('caller-first');
    // WS close not re-fired — the first call already closed it.
    expect(wsServer.closedIds).toEqual(['ext-target']);
  });

  it('emitted activity_id round-trips through createSigningAuditLog → createAuditLogStore so the persisted signature verifies', async () => {
    // Codex P1 2026-05-17 ratchet — pre-fix the wrapper signed an
    // entry with `activity_id: ''`, but the underlying store mutates
    // the id to a generated value before persisting, so the stored
    // row's canonical-JSON shape differed from the bytes the signer
    // committed to. The verifier would see `signature_invalid` for
    // every revoke row. This test wires the actual signing wrapper +
    // actual in-memory audit store + actual verifier and asserts the
    // chain works end-to-end (same ratchet as mint/consume).
    const serverIdentity: Ed25519Keypair =
      generateEd25519Keypair('server_identity_key');
    const { createAuditLogStore, createInMemoryCollection } = await import(
      '@recued/storage'
    );
    const { createSigningAuditLog, verifyActivityEntry } = await import(
      '../audit/signing.js'
    );
    const baseStore = createAuditLogStore(createInMemoryCollection());
    const signedStore = createSigningAuditLog(baseStore, {
      getServerIdentity: () => serverIdentity,
    });
    const deps: PairHandlerDeps = {
      paired,
      wsServer,
      auditLog: signedStore,
      now: () => FIXED_NOW,
    };
    await handlePairRevoke(
      deps,
      'mary',
      { instance_id: 'ext-target' },
      { instance_id: 'caller-client-id' },
    );
    await new Promise((r) => setTimeout(r, 0));
    const recent = await signedStore.listActivities(10);
    const revokeRow = recent.find((r) => r.action === 'pair_revoke');
    expect(revokeRow).toBeDefined();
    if (!revokeRow) return;
    expect(revokeRow.activity_id).toBe('pair_revoke:ext-target');
    expect(revokeRow.signature).toBeDefined();
    expect(revokeRow.signer_fingerprint).toBe(
      serverIdentity.public_key_fingerprint,
    );
    // Reserve pin auto-applied by both the signing wrapper (which
    // sets `reserve: true` before signing) and `RESERVE_ACTIONS`
    // auto-classification — the row MUST survive retention pruning.
    expect(revokeRow.reserve).toBe(true);
    const verifyResult = verifyActivityEntry(
      revokeRow,
      serverIdentity.public_key_b64,
    );
    expect(verifyResult.ok).toBe(true);
  });
});

describe('D-148 § A.2.1 — makePairHandlers slice composition (auditLog threading)', () => {
  let db: Database.Database;
  let paired: PairedInstancesStore;
  let wsServer: WsServerHandle & { closedIds: string[] };

  beforeEach(() => {
    db = new Database(':memory:');
    paired = createPairedInstancesStore(db);
    wsServer = stubWsServer();
    paired.addOrRefresh({
      instance_id: 'ext-slice',
      user_id: 'mary',
      display_name: 'sliced device',
    });
  });

  it('threads auditLog through the slice + emits a row when the pair.revoke handler runs', async () => {
    const rows: Array<{ action: string; target: string }> = [];
    const auditLog = {
      logActivity: async (entry: { action: string; target: string }) => {
        rows.push({ action: entry.action, target: entry.target });
      },
    };
    const slice = makePairHandlers(paired, () => wsServer, auditLog);
    expect(slice).toBeDefined();
    expect(slice?.methods.includes('pair.revoke')).toBe(true);
    const ctx = stubCtx('caller-id-1', 'mary');
    const result = await slice!.handlers['pair.revoke'](
      { instance_id: 'ext-slice' },
      ctx,
    );
    expect(result).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(rows).toEqual([{ action: 'pair_revoke', target: 'ext-slice' }]);
  });

  it('omits auditLog arg → slice still dispatches + handler revokes without ledger row', async () => {
    const slice = makePairHandlers(paired, () => wsServer);
    expect(slice).toBeDefined();
    const ctx = stubCtx('caller-id-2', 'mary');
    const result = await slice!.handlers['pair.revoke'](
      { instance_id: 'ext-slice' },
      ctx,
    );
    expect(result).toEqual({ ok: true });
    expect(paired.isRevoked('ext-slice')).toBe(true);
  });

  it('makePairHandlers(undefined, …) returns undefined so the rpc returns not_configured', () => {
    const slice = makePairHandlers(undefined, () => wsServer);
    expect(slice).toBeUndefined();
  });
});

describe('D-156 follow-on — handlePairRevoke pair.list_changed broadcast', () => {
  let db: Database.Database;
  let paired: PairedInstancesStore;
  let wsServer: WsServerHandle & { closedIds: string[] };

  beforeEach(() => {
    db = new Database(':memory:');
    paired = createPairedInstancesStore(db);
    wsServer = stubWsServer();
    paired.addOrRefresh({
      instance_id: 'ext-bcast',
      user_id: 'mary',
      display_name: 'broadcast device',
    });
  });

  it('emits one { kind: pair.list_changed, op: revoked } on a successful revoke', async () => {
    const events: PairListChangedEvent[] = [];
    const deps: PairHandlerDeps = {
      paired,
      wsServer,
      broadcast: (e) => events.push(e),
    };
    const result = await handlePairRevoke(
      deps,
      'mary',
      { instance_id: 'ext-bcast' },
      { instance_id: 'caller' },
    );
    expect(result).toEqual({ ok: true });
    // The emit is synchronous — no microtask settle needed (unlike the
    // best-effort async audit write).
    expect(events).toEqual([{ kind: 'pair.list_changed', op: 'revoked' }]);
    expect(paired.isRevoked('ext-bcast')).toBe(true);
  });

  it('does NOT re-emit on the idempotent already-revoked short-circuit (one emit across revoke + retry)', async () => {
    const events: PairListChangedEvent[] = [];
    const deps: PairHandlerDeps = {
      paired,
      wsServer,
      broadcast: (e) => events.push(e),
    };
    await handlePairRevoke(deps, 'mary', { instance_id: 'ext-bcast' }, { instance_id: 'c1' });
    // Retry on the now-revoked row — returns ok but must NOT re-emit (the
    // short-circuit returns before any mutation, mirroring the audit row).
    const retry = await handlePairRevoke(
      deps,
      'mary',
      { instance_id: 'ext-bcast' },
      { instance_id: 'c2' },
    );
    expect(retry).toEqual({ ok: true });
    expect(events).toEqual([{ kind: 'pair.list_changed', op: 'revoked' }]);
  });

  it('does NOT emit when a guard rejects before mutation (not_found / forbidden)', async () => {
    const events: PairListChangedEvent[] = [];
    const deps: PairHandlerDeps = {
      paired,
      wsServer,
      broadcast: (e) => events.push(e),
    };
    await expect(
      handlePairRevoke(deps, 'mary', { instance_id: 'ghost' }, { instance_id: 'caller' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      handlePairRevoke(deps, 'eve', { instance_id: 'ext-bcast' }, { instance_id: 'caller' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(events).toEqual([]);
    // The guards rejected before any mutation — the row stays active.
    expect(paired.isRevoked('ext-bcast')).toBe(false);
  });

  it('best-effort: a throwing broadcast does not abort the revoke (durable revoke + ws close still land)', async () => {
    const deps: PairHandlerDeps = {
      paired,
      wsServer,
      broadcast: () => {
        throw new Error('bus down');
      },
    };
    const result = await handlePairRevoke(
      deps,
      'mary',
      { instance_id: 'ext-bcast' },
      { instance_id: 'caller' },
    );
    expect(result).toEqual({ ok: true });
    expect(paired.isRevoked('ext-bcast')).toBe(true);
    expect(wsServer.closedIds).toEqual(['ext-bcast']);
  });

  it('threads broadcast through makePairHandlers (5th arg) → emitted when pair.revoke runs', async () => {
    const events: PairListChangedEvent[] = [];
    const slice = makePairHandlers(
      paired,
      () => wsServer,
      undefined,
      undefined,
      (e) => events.push(e),
    );
    expect(slice).toBeDefined();
    const ctx = stubCtx('caller-id', 'mary');
    const result = await slice!.handlers['pair.revoke'](
      { instance_id: 'ext-bcast' },
      ctx,
    );
    expect(result).toEqual({ ok: true });
    expect(events).toEqual([{ kind: 'pair.list_changed', op: 'revoked' }]);
  });

  it('omits the broadcast arg → handler still revokes without emitting', async () => {
    const slice = makePairHandlers(paired, () => wsServer);
    const ctx = stubCtx('caller-id', 'mary');
    const result = await slice!.handlers['pair.revoke'](
      { instance_id: 'ext-bcast' },
      ctx,
    );
    expect(result).toEqual({ ok: true });
    expect(paired.isRevoked('ext-bcast')).toBe(true);
  });
});
