/** D-148 § A.6.5 — `tls.renew` rpc handler tests.
 *
 *  Covers the thin rpc-layer wrapper around `RotationEngine.renewTls(...)`:
 *
 *    - happy path: forwards `ctx.instance_id` as `triggered_by_client_id`,
 *      passes optional `reason` + `rotation_at_offset_ms` through, surfaces
 *      the engine's `RotationResult` verbatim (success shape).
 *    - failure surfaces verbatim: engine returns `ok: false` with the
 *      closed-list `RotationErrorCode` — the rpc does NOT throw, the
 *      caller narrows the union themselves.
 *    - `tls` slot undefined at engine: handler surfaces `key_not_loaded`
 *      verbatim (matches the production wiring's pre-tls-hook state).
 *    - input validation: non-string `reason` / non-finite or negative
 *      `rotation_at_offset_ms` raise `RpcError` 400 (typed transport).
 *    - `makeTlsRenewHandlers(undefined)` returns `undefined` so the
 *      slice composer drops + the rpc returns `not_configured` 501.
 *    - slice methods array contains exactly `'tls.renew'`.
 *    - `ctx.instance_id` null sentinel fallback (defence-in-depth; the
 *      dispatcher gates rpc on register so this branch is unreachable
 *      via the real WS server, but the handler is conservative).
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { RpcError } from '@recued/contracts';

import {
  handleTlsRenew,
  makeTlsRenewHandlers,
  type TlsRenewRpcDeps,
} from '../keys/rotation/tls-renew-handler.js';
import {
  createInMemoryCompromiseLedger,
  createRotationEngine,
  type RotationEngine,
  type RotationSideEffects,
} from '../keys/rotation/index.js';
import { generateEd25519Keypair, type Ed25519Keypair } from '../keys/index.js';
import type {
  CertRotationNotice,
  KeyClass,
  KeyRotationEvent,
  RotationOp,
} from '@recued/contracts';
import type { WsClient } from '../ws-server.js';

const makeEffects = (): {
  effects: RotationSideEffects;
  audits: Array<{
    op: RotationOp;
    key_class: KeyClass;
    triggered_by_client_id: string;
    reason?: string;
  }>;
  certNotices: CertRotationNotice[];
} => {
  const audits: Array<{
    op: RotationOp;
    key_class: KeyClass;
    triggered_by_client_id: string;
    reason?: string;
  }> = [];
  const certNotices: CertRotationNotice[] = [];
  return {
    audits,
    certNotices,
    effects: {
      recordAudit: async (entry) => {
        audits.push({
          op: entry.op,
          key_class: entry.key_class,
          triggered_by_client_id: entry.triggered_by_client_id,
          ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
        });
      },
      broadcast: async () => {},
      broadcastCertRotationNotice: async (entry) => {
        certNotices.push({ type: 'cert_rotation_notice', ...entry });
      },
      broadcastCertRotationReverted: async () => {},
    },
  };
};

const stubCtx = (instance_id: string | null): WsClient =>
  ({
    ws: null,
    realm: 'recued',
    instance_id,
    display_name: 'test client',
    connected_at: Date.now(),
  }) as unknown as WsClient;

const buildEngine = (
  opts: {
    identity?: Ed25519Keypair;
    tlsRenew?: () => Promise<
      | { ok: true; new_fingerprint: string; previous_fingerprint?: string }
      | { ok: false; reason: 'helper_unavailable' | 'subscription_required' | 'storage_io_error' }
    >;
    withoutTlsSlot?: boolean;
  } = {},
): RotationEngine => {
  const { effects } = makeEffects();
  const identity = opts.identity ?? generateEd25519Keypair('server_identity_key');
  return createRotationEngine({
    server_identity: {
      load: async () => identity,
      save: async () => {},
      revokeAllPairedClients: async () => ({ revoked_client_ids: [] }),
    },
    ...(opts.withoutTlsSlot
      ? {}
      : {
          tls: {
            renew:
              opts.tlsRenew ??
              (async () => ({
                ok: true,
                new_fingerprint: 'sha256:beef',
                previous_fingerprint: 'sha256:cafe',
              })),
          },
        }),
    compromise_ledger: createInMemoryCompromiseLedger(),
    effects,
  });
};

describe('D-148 § A.6.5 — handleTlsRenew rpc handler', () => {
  let deps: TlsRenewRpcDeps;

  beforeEach(() => {
    deps = { engine: buildEngine() };
  });

  it('happy path: forwards instance_id, returns ok RotationResult verbatim', async () => {
    const result = await handleTlsRenew(
      deps,
      { rotation_at_offset_ms: 1000 },
      stubCtx('client-abc'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.op).toBe('tls_renew');
    expect(result.key_class).toBe('tls_private_key');
    expect(result.new_fingerprint).toBe('sha256:beef');
    expect(typeof result.rotated_at).toBe('number');
  });

  it('threads `triggered_by_client_id` from ctx.instance_id into the audit row', async () => {
    const effects = makeEffects();
    const identity = generateEd25519Keypair('server_identity_key');
    const engine = createRotationEngine({
      server_identity: {
        load: async () => identity,
        save: async () => {},
        revokeAllPairedClients: async () => ({ revoked_client_ids: [] }),
      },
      tls: {
        renew: async () => ({
          ok: true,
          new_fingerprint: 'sha256:beef',
          previous_fingerprint: 'sha256:cafe',
        }),
      },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects: effects.effects,
    });
    await handleTlsRenew(
      { engine },
      { rotation_at_offset_ms: 1000, reason: 'cert age 80d' },
      stubCtx('alice-laptop'),
    );
    expect(effects.audits).toHaveLength(1);
    expect(effects.audits[0]!.triggered_by_client_id).toBe('alice-laptop');
    expect(effects.audits[0]!.reason).toBe('cert age 80d');
  });

  it('Codex P1 fold — null instance_id rejected with forbidden (operator-only)', async () => {
    const effects = makeEffects();
    const identity = generateEd25519Keypair('server_identity_key');
    const engine = createRotationEngine({
      server_identity: {
        load: async () => identity,
        save: async () => {},
        revokeAllPairedClients: async () => ({ revoked_client_ids: [] }),
      },
      tls: {
        renew: async () => ({ ok: true, new_fingerprint: 'sha256:beef' }),
      },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects: effects.effects,
    });
    await expect(
      handleTlsRenew({ engine }, { rotation_at_offset_ms: 1000 }, stubCtx(null)),
    ).rejects.toMatchObject({ code: 'forbidden', status: 401 });
    // No audit row should land — the rotation never reached the engine.
    expect(effects.audits).toHaveLength(0);
  });

  it('forwards `acme_helper_unavailable` verbatim (no throw, no projection)', async () => {
    const engine = buildEngine({
      tlsRenew: async () => ({ ok: false, reason: 'helper_unavailable' }),
    });
    const result = await handleTlsRenew(
      { engine },
      { rotation_at_offset_ms: 1000 },
      stubCtx('client-abc'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.op).toBe('tls_renew');
    expect(result.error).toBe('acme_helper_unavailable');
  });

  it('forwards `subscription_required` verbatim', async () => {
    const engine = buildEngine({
      tlsRenew: async () => ({ ok: false, reason: 'subscription_required' }),
    });
    const result = await handleTlsRenew(
      { engine },
      { rotation_at_offset_ms: 1000 },
      stubCtx('client-abc'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('subscription_required');
  });

  it('forwards `storage_io_error` verbatim', async () => {
    const engine = buildEngine({
      tlsRenew: async () => ({ ok: false, reason: 'storage_io_error' }),
    });
    const result = await handleTlsRenew(
      { engine },
      { rotation_at_offset_ms: 1000 },
      stubCtx('client-abc'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('storage_io_error');
  });

  it('engine without `tls` slot wired returns `key_not_loaded` verbatim', async () => {
    const engine = buildEngine({ withoutTlsSlot: true });
    const result = await handleTlsRenew(
      { engine },
      { rotation_at_offset_ms: 1000 },
      stubCtx('client-abc'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('key_not_loaded');
  });

  it('rejects non-string reason with bad_request 400', async () => {
    await expect(
      handleTlsRenew(
        deps,
        { reason: 42 as unknown as string },
        stubCtx('client-abc'),
      ),
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects non-finite rotation_at_offset_ms with bad_request 400', async () => {
    await expect(
      handleTlsRenew(
        deps,
        { rotation_at_offset_ms: Number.POSITIVE_INFINITY },
        stubCtx('client-abc'),
      ),
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects negative rotation_at_offset_ms with bad_request 400', async () => {
    await expect(
      handleTlsRenew(
        deps,
        { rotation_at_offset_ms: -1 },
        stubCtx('client-abc'),
      ),
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('Codex P2 fold — rejects zero rotation_at_offset_ms (would emit rotation_at_in_past notice)', async () => {
    await expect(
      handleTlsRenew(
        deps,
        { rotation_at_offset_ms: 0 },
        stubCtx('client-abc'),
      ),
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects non-number rotation_at_offset_ms with bad_request 400', async () => {
    await expect(
      handleTlsRenew(
        deps,
        { rotation_at_offset_ms: '0' as unknown as number },
        stubCtx('client-abc'),
      ),
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('thrown errors are RpcError instances (typed transport)', async () => {
    let thrown: unknown;
    try {
      await handleTlsRenew(
        deps,
        { reason: 42 as unknown as string },
        stubCtx('client-abc'),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RpcError);
  });

  it('omits optional fields when not provided (engine receives clean call)', async () => {
    const calls: Array<{
      triggered_by_client_id: string;
      reason?: string;
      rotation_at_offset_ms?: number;
    }> = [];
    const stubEngine: RotationEngine = {
      ...buildEngine(),
      renewTls: async (args) => {
        calls.push(args);
        return {
          ok: true,
          op: 'tls_renew',
          key_class: 'tls_private_key',
          new_fingerprint: 'sha256:beef',
          rotated_at: Date.now(),
        };
      },
    };
    await handleTlsRenew({ engine: stubEngine }, {}, stubCtx('client-abc'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ triggered_by_client_id: 'client-abc' });
  });
});

describe('D-148 § A.6.5 — makeTlsRenewHandlers slice composer', () => {
  it('returns undefined when deps are absent (handler not wired)', () => {
    expect(makeTlsRenewHandlers(undefined)).toBeUndefined();
  });

  it('returns a slice exposing exactly tls.renew', () => {
    const slice = makeTlsRenewHandlers({ engine: buildEngine() });
    expect(slice).toBeDefined();
    expect(slice?.methods).toEqual(['tls.renew']);
  });

  it('slice handler delegates to the engine + threads ctx', async () => {
    const slice = makeTlsRenewHandlers({ engine: buildEngine() });
    if (!slice) throw new Error('unreachable');
    const handler = slice.handlers['tls.renew'];
    const result = await handler(
      { rotation_at_offset_ms: 1000 },
      stubCtx('client-abc'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.op).toBe('tls_renew');
    expect(result.new_fingerprint).toBe('sha256:beef');
  });
});
