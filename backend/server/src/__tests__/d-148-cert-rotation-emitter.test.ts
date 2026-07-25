/** D-148 § A.6.5 — server-side cert.rotation_notice emitter + revertCert
 *  substrate acceptance.
 *
 *  Pairs with `apps/webclient/src/__tests__/d-148-cert-pin.test.ts`
 *  (consumer side, prior session 87). This file exercises:
 *
 *    - `createCertRotationBroadcaster({ bus })` translating substrate
 *      callbacks to `ServerEvent` shapes onto the realtime bus.
 *    - `RotationEngine.revertCert` signing + broadcasting the revert
 *      event + recording the audit row.
 *    - `signedBytesForCertRotationNotice` /
 *      `signedBytesForCertRotationReverted` literal-order transcripts
 *      matching the verifier (byte-for-byte parity with the consumer
 *      side's `verifyEd25519` reproduction).
 *
 *  The emitter is the production bridge that closes the prior session
 *  87's flagged gap: "Server-side cert.rotation_notice emitter — wire
 *  the server's renewTls() path to actually emit broadcasts on real
 *  rotation events. Currently the substrate is tested but no
 *  production emitter fires."
 */

import { describe, expect, it } from 'vitest';
import {
  createCertRotationBroadcaster,
  createInMemoryCompromiseLedger,
  createRotationEngine,
  signedBytesForCertRotationNotice,
  signedBytesForCertRotationReverted,
  verifyCertRotationNotice,
  verifyCertRotationRevertedEvent,
  type RotationSideEffects,
} from '../keys/rotation/index.js';
import { generateEd25519Keypair } from '../keys/index.js';
import { createEventBus } from '../events/bus.js';
import type { ServerEvent } from '@recued/contracts';

describe('D-148 § A.6.5 — signed-bytes helpers', () => {
  it('signedBytesForCertRotationNotice matches the rotation engine emit transcript', () => {
    // Literal-order JSON.stringify with keys in the order the engine
    // historically emitted (alphabetical-by-key with `type` last).
    // The webclient consumer's `cert-pin.ts` reproduces this byte
    // sequence; a drift here would make the consumer drop every
    // valid notice with `signature_invalid`.
    const bytes = signedBytesForCertRotationNotice({
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      rotation_at: 1_700_000_000_000,
    });
    expect(bytes).toBe(
      JSON.stringify({
        current_fingerprint: 'sha256:current',
        next_fingerprint: 'sha256:next',
        rotation_at: 1_700_000_000_000,
        type: 'cert_rotation_notice',
      }),
    );
  });

  it('signedBytesForCertRotationReverted coerces missing reason to null', () => {
    // Coercion to null keeps the transcript stable across the
    // "reason supplied" / "reason absent" cases — the verifier on
    // the receive side does the same coercion.
    const withReason = signedBytesForCertRotationReverted({
      reverted_to_fingerprint: 'sha256:prev',
      reverted_at: 1_700_000_000_001,
      reason: 'reachability regression',
    });
    const withoutReason = signedBytesForCertRotationReverted({
      reverted_to_fingerprint: 'sha256:prev',
      reverted_at: 1_700_000_000_001,
    });
    expect(withReason).toBe(
      JSON.stringify({
        reverted_to_fingerprint: 'sha256:prev',
        reason: 'reachability regression',
        reverted_at: 1_700_000_000_001,
        type: 'cert_rotation_reverted',
      }),
    );
    expect(withoutReason).toBe(
      JSON.stringify({
        reverted_to_fingerprint: 'sha256:prev',
        reason: null,
        reverted_at: 1_700_000_000_001,
        type: 'cert_rotation_reverted',
      }),
    );
  });
});

describe('D-148 § A.6.5 — createCertRotationBroadcaster', () => {
  it('broadcastCertRotationNotice emits cert.rotation_notice ServerEvent', async () => {
    const bus = createEventBus();
    const captured: ServerEvent[] = [];
    bus.subscribe('subscriber-1', { kinds: ['cert.rotation_notice'] }, (ev) => {
      captured.push(ev);
    });
    const broadcaster = createCertRotationBroadcaster({ bus });

    await broadcaster.broadcastCertRotationNotice({
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      rotation_at: 1_700_000_000_000,
      signature: 'sig-xyz',
      signer_fingerprint: 'sha256:signer',
      emitted_at: 1_699_999_999_000,
    });

    expect(captured).toHaveLength(1);
    const ev = captured[0]!;
    expect(ev.kind).toBe('cert.rotation_notice');
    if (ev.kind !== 'cert.rotation_notice') throw new Error('unreachable');
    expect(ev.current_fingerprint).toBe('sha256:current');
    expect(ev.next_fingerprint).toBe('sha256:next');
    expect(ev.rotation_at).toBe(1_700_000_000_000);
    expect(ev.signature).toBe('sig-xyz');
    expect(ev.signer_fingerprint).toBe('sha256:signer');
    expect(ev.emitted_at).toBe(1_699_999_999_000);
    // Cursor stamped by the bus.
    expect(ev.cursor).toBeGreaterThan(0);
  });

  it('broadcastCertRotationReverted emits cert.rotation_reverted ServerEvent (with reason)', async () => {
    const bus = createEventBus();
    const captured: ServerEvent[] = [];
    bus.subscribe('subscriber-1', { kinds: ['cert.rotation_reverted'] }, (ev) => {
      captured.push(ev);
    });
    const broadcaster = createCertRotationBroadcaster({ bus });

    await broadcaster.broadcastCertRotationReverted({
      reverted_to_fingerprint: 'sha256:prev',
      reason: 'reachability regression',
      reverted_at: 1_700_000_000_001,
      signature: 'sig-revert',
      signer_fingerprint: 'sha256:signer',
    });

    expect(captured).toHaveLength(1);
    const ev = captured[0]!;
    expect(ev.kind).toBe('cert.rotation_reverted');
    if (ev.kind !== 'cert.rotation_reverted') throw new Error('unreachable');
    expect(ev.reverted_to_fingerprint).toBe('sha256:prev');
    expect(ev.reason).toBe('reachability regression');
    expect(ev.reverted_at).toBe(1_700_000_000_001);
    expect(ev.signature).toBe('sig-revert');
    expect(ev.signer_fingerprint).toBe('sha256:signer');
  });

  it('broadcastCertRotationReverted omits reason key when undefined (clean wire shape)', async () => {
    const bus = createEventBus();
    const captured: ServerEvent[] = [];
    bus.subscribe('subscriber-1', { kinds: ['cert.rotation_reverted'] }, (ev) => {
      captured.push(ev);
    });
    const broadcaster = createCertRotationBroadcaster({ bus });

    await broadcaster.broadcastCertRotationReverted({
      reverted_to_fingerprint: 'sha256:prev',
      reverted_at: 1_700_000_000_001,
      signature: 'sig-revert',
      signer_fingerprint: 'sha256:signer',
    });

    expect(captured).toHaveLength(1);
    const ev = captured[0]!;
    if (ev.kind !== 'cert.rotation_reverted') throw new Error('unreachable');
    // Wire shape should NOT carry a `reason: undefined` key — the
    // emitter spreads the key only when defined.
    expect('reason' in ev).toBe(false);
  });

  it('does not push events to subscribers filtered to other kinds', async () => {
    const bus = createEventBus();
    const noticeBucket: ServerEvent[] = [];
    const revertBucket: ServerEvent[] = [];
    bus.subscribe('notice-only', { kinds: ['cert.rotation_notice'] }, (ev) => {
      noticeBucket.push(ev);
    });
    bus.subscribe('revert-only', { kinds: ['cert.rotation_reverted'] }, (ev) => {
      revertBucket.push(ev);
    });
    const broadcaster = createCertRotationBroadcaster({ bus });

    await broadcaster.broadcastCertRotationNotice({
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      rotation_at: 1_700_000_000_000,
      signature: 'sig-xyz',
      signer_fingerprint: 'sha256:signer',
      emitted_at: 1_699_999_999_000,
    });
    await broadcaster.broadcastCertRotationReverted({
      reverted_to_fingerprint: 'sha256:prev',
      reverted_at: 1_700_000_000_001,
      signature: 'sig-revert',
      signer_fingerprint: 'sha256:signer',
    });

    expect(noticeBucket).toHaveLength(1);
    expect(revertBucket).toHaveLength(1);
    expect(noticeBucket[0]!.kind).toBe('cert.rotation_notice');
    expect(revertBucket[0]!.kind).toBe('cert.rotation_reverted');
  });
});

describe('D-148 § A.6.5 — renewTls + revertCert end-to-end via broadcaster', () => {
  it('renewTls broadcasts a verifiable cert.rotation_notice via the bus', async () => {
    const signer = generateEd25519Keypair('server_identity_key');
    const bus = createEventBus();
    const captured: ServerEvent[] = [];
    bus.subscribe('paired-client', { kinds: ['cert.rotation_notice'] }, (ev) => {
      captured.push(ev);
    });
    const broadcaster = createCertRotationBroadcaster({ bus });
    const fixedNow = 1_700_000_000_000;
    const effects: RotationSideEffects = {
      recordAudit: async () => {},
      broadcast: async () => {},
      broadcastCertRotationNotice: broadcaster.broadcastCertRotationNotice,
      broadcastCertRotationReverted: broadcaster.broadcastCertRotationReverted,
    };
    const engine = createRotationEngine({
      server_identity: {
        load: async () => signer,
        save: async () => {},
        revokeAllPairedClients: async () => ({ revoked_client_ids: [] }),
      },
      tls: {
        renew: async () => ({
          ok: true,
          new_fingerprint: 'sha256:next',
          previous_fingerprint: 'sha256:current',
        }),
      },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
      clock: () => fixedNow,
    });

    // Tight offset to keep the assertion simple — production defaults
    // to 7d lead per spec § A.6.5.
    const r = await engine.renewTls({
      triggered_by_client_id: 'admin',
      rotation_at_offset_ms: 60_000,
    });
    expect(r.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const ev = captured[0]!;
    if (ev.kind !== 'cert.rotation_notice') throw new Error('unreachable');
    expect(ev.current_fingerprint).toBe('sha256:current');
    expect(ev.next_fingerprint).toBe('sha256:next');
    expect(ev.rotation_at).toBe(fixedNow + 60_000);
    expect(ev.emitted_at).toBe(fixedNow);
    expect(ev.signer_fingerprint).toBe(signer.public_key_fingerprint);

    // Signature MUST verify against the signer's public key — proves
    // the bridge passed the substrate-signed bytes through unmodified.
    const verify = verifyCertRotationNotice(
      {
        type: 'cert_rotation_notice',
        current_fingerprint: ev.current_fingerprint,
        next_fingerprint: ev.next_fingerprint,
        rotation_at: ev.rotation_at,
        signature: ev.signature,
        signer_fingerprint: ev.signer_fingerprint,
        emitted_at: ev.emitted_at,
      },
      signer.public_key_b64,
    );
    expect(verify.ok).toBe(true);
  });

  it('revertCert broadcasts a verifiable cert.rotation_reverted via the bus', async () => {
    const signer = generateEd25519Keypair('server_identity_key');
    const bus = createEventBus();
    const captured: ServerEvent[] = [];
    bus.subscribe('paired-client', { kinds: ['cert.rotation_reverted'] }, (ev) => {
      captured.push(ev);
    });
    const broadcaster = createCertRotationBroadcaster({ bus });
    const fixedNow = 1_700_000_000_500;
    const audits: Array<{
      op: string;
      new_fingerprint?: string;
      reason?: string;
      revert?: true;
    }> = [];
    const effects: RotationSideEffects = {
      recordAudit: async (entry) => {
        audits.push({
          op: entry.op,
          ...(entry.new_fingerprint !== undefined
            ? { new_fingerprint: entry.new_fingerprint }
            : {}),
          ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
          ...(entry.revert === true ? { revert: true } : {}),
        });
      },
      broadcast: async () => {},
      broadcastCertRotationNotice: broadcaster.broadcastCertRotationNotice,
      broadcastCertRotationReverted: broadcaster.broadcastCertRotationReverted,
    };
    const engine = createRotationEngine({
      server_identity: {
        load: async () => signer,
        save: async () => {},
        revokeAllPairedClients: async () => ({ revoked_client_ids: [] }),
      },
      tls: {
        renew: async () => ({
          ok: true,
          new_fingerprint: 'sha256:next',
          previous_fingerprint: 'sha256:current',
        }),
      },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
      clock: () => fixedNow,
    });

    const r = await engine.revertCert({
      reverted_to_fingerprint: 'sha256:current',
      triggered_by_client_id: 'admin',
      reason: 'reachability regression',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.op).toBe('tls_renew');
    expect(r.new_fingerprint).toBe('sha256:current');
    expect(r.rotated_at).toBe(fixedNow);

    expect(captured).toHaveLength(1);
    const ev = captured[0]!;
    if (ev.kind !== 'cert.rotation_reverted') throw new Error('unreachable');
    expect(ev.reverted_to_fingerprint).toBe('sha256:current');
    expect(ev.reason).toBe('reachability regression');
    expect(ev.reverted_at).toBe(fixedNow);
    expect(ev.signer_fingerprint).toBe(signer.public_key_fingerprint);

    const verify = verifyCertRotationRevertedEvent(
      {
        type: 'cert_rotation_reverted',
        reverted_to_fingerprint: ev.reverted_to_fingerprint,
        reason: ev.reason,
        reverted_at: ev.reverted_at,
        signature: ev.signature,
        signer_fingerprint: ev.signer_fingerprint,
      },
      signer.public_key_b64,
    );
    expect(verify.ok).toBe(true);

    // Audit row tagged with the revert fingerprint + reason + the
    // machine-readable `revert: true` flag so Key Health / compliance
    // review can distinguish the rollback from a normal forward
    // renewal (Codex P2 fold). The op stays `tls_renew` — the flag
    // does the disambiguation, not the op.
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      op: 'tls_renew',
      new_fingerprint: 'sha256:current',
      reason: 'reachability regression',
      revert: true,
    });
  });

  it('revertCert audit row carries revert: true even when reason is omitted', async () => {
    // Codex P2 fold — the revert flag is independent of the optional
    // reason. A reasonless revert MUST still be machine-distinguishable
    // from a normal renewal in the audit log.
    const signer = generateEd25519Keypair('server_identity_key');
    const bus = createEventBus();
    const broadcaster = createCertRotationBroadcaster({ bus });
    const audits: Array<{ op: string; revert?: true; reason?: string }> = [];
    const effects: RotationSideEffects = {
      recordAudit: async (entry) => {
        audits.push({
          op: entry.op,
          ...(entry.revert === true ? { revert: true } : {}),
          ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
        });
      },
      broadcast: async () => {},
      broadcastCertRotationNotice: broadcaster.broadcastCertRotationNotice,
      broadcastCertRotationReverted: broadcaster.broadcastCertRotationReverted,
    };
    const engine = createRotationEngine({
      server_identity: {
        load: async () => signer,
        save: async () => {},
        revokeAllPairedClients: async () => ({ revoked_client_ids: [] }),
      },
      tls: { renew: async () => ({ ok: true, new_fingerprint: 'sha256:next' }) },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
    });
    const r = await engine.revertCert({
      reverted_to_fingerprint: 'sha256:prev',
      triggered_by_client_id: 'admin',
    });
    expect(r.ok).toBe(true);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.revert).toBe(true);
    expect('reason' in audits[0]!).toBe(false);
  });

  it('revertCert without reason produces a valid verifiable event', async () => {
    const signer = generateEd25519Keypair('server_identity_key');
    const bus = createEventBus();
    const captured: ServerEvent[] = [];
    bus.subscribe('paired-client', { kinds: ['cert.rotation_reverted'] }, (ev) => {
      captured.push(ev);
    });
    const broadcaster = createCertRotationBroadcaster({ bus });
    const effects: RotationSideEffects = {
      recordAudit: async () => {},
      broadcast: async () => {},
      broadcastCertRotationNotice: broadcaster.broadcastCertRotationNotice,
      broadcastCertRotationReverted: broadcaster.broadcastCertRotationReverted,
    };
    const engine = createRotationEngine({
      server_identity: {
        load: async () => signer,
        save: async () => {},
        revokeAllPairedClients: async () => ({ revoked_client_ids: [] }),
      },
      tls: {
        renew: async () => ({ ok: true, new_fingerprint: 'sha256:next' }),
      },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
    });

    const r = await engine.revertCert({
      reverted_to_fingerprint: 'sha256:prev',
      triggered_by_client_id: 'admin',
    });
    expect(r.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const ev = captured[0]!;
    if (ev.kind !== 'cert.rotation_reverted') throw new Error('unreachable');
    expect('reason' in ev).toBe(false);
    // Verifier reproduces the coerced null in the signed bytes —
    // signature must still verify.
    const verify = verifyCertRotationRevertedEvent(
      {
        type: 'cert_rotation_reverted',
        reverted_to_fingerprint: ev.reverted_to_fingerprint,
        reverted_at: ev.reverted_at,
        signature: ev.signature,
        signer_fingerprint: ev.signer_fingerprint,
      },
      signer.public_key_b64,
    );
    expect(verify.ok).toBe(true);
  });

  it('revertCert rejects empty reverted_to_fingerprint at the substrate boundary', async () => {
    const signer = generateEd25519Keypair('server_identity_key');
    const bus = createEventBus();
    const captured: ServerEvent[] = [];
    bus.subscribe('paired-client', { kinds: ['cert.rotation_reverted'] }, (ev) => {
      captured.push(ev);
    });
    const broadcaster = createCertRotationBroadcaster({ bus });
    const effects: RotationSideEffects = {
      recordAudit: async () => {},
      broadcast: async () => {},
      broadcastCertRotationNotice: broadcaster.broadcastCertRotationNotice,
      broadcastCertRotationReverted: broadcaster.broadcastCertRotationReverted,
    };
    const engine = createRotationEngine({
      server_identity: {
        load: async () => signer,
        save: async () => {},
        revokeAllPairedClients: async () => ({ revoked_client_ids: [] }),
      },
      tls: { renew: async () => ({ ok: true, new_fingerprint: 'sha256:next' }) },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
    });

    const r = await engine.revertCert({
      reverted_to_fingerprint: '',
      triggered_by_client_id: 'admin',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.op).toBe('tls_renew');
    expect(r.error).toBe('unsigned_notice');
    // Bus must NOT receive a malformed revert.
    expect(captured).toHaveLength(0);
  });

  it('revertCert surfaces key_not_loaded when server_identity hook is absent', async () => {
    const bus = createEventBus();
    const broadcaster = createCertRotationBroadcaster({ bus });
    const effects: RotationSideEffects = {
      recordAudit: async () => {},
      broadcast: async () => {},
      broadcastCertRotationNotice: broadcaster.broadcastCertRotationNotice,
      broadcastCertRotationReverted: broadcaster.broadcastCertRotationReverted,
    };
    const engine = createRotationEngine({
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
    });
    const r = await engine.revertCert({
      reverted_to_fingerprint: 'sha256:prev',
      triggered_by_client_id: 'admin',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('key_not_loaded');
  });

  it('revertCert is mutually exclusive with renewTls (same tls_private_key inflight guard)', async () => {
    const signer = generateEd25519Keypair('server_identity_key');
    const bus = createEventBus();
    const broadcaster = createCertRotationBroadcaster({ bus });
    const effects: RotationSideEffects = {
      recordAudit: async () => {},
      broadcast: async () => {},
      broadcastCertRotationNotice: broadcaster.broadcastCertRotationNotice,
      broadcastCertRotationReverted: broadcaster.broadcastCertRotationReverted,
    };
    // Renew that never resolves until we say so — proves the inflight
    // guard is per-class shared, so a concurrent revert sees
    // rotation_in_progress.
    let releaseRenew: (() => void) | null = null;
    const renewBlocked = new Promise<void>((resolve) => {
      releaseRenew = resolve;
    });
    const engine = createRotationEngine({
      server_identity: {
        load: async () => signer,
        save: async () => {},
        revokeAllPairedClients: async () => ({ revoked_client_ids: [] }),
      },
      tls: {
        renew: async () => {
          await renewBlocked;
          return { ok: true, new_fingerprint: 'sha256:next', previous_fingerprint: 'sha256:current' };
        },
      },
      compromise_ledger: createInMemoryCompromiseLedger(),
      effects,
    });
    const renewPromise = engine.renewTls({ triggered_by_client_id: 'admin' });
    // Allow the renew to enter the guard before the concurrent revert.
    await Promise.resolve();
    const revert = await engine.revertCert({
      reverted_to_fingerprint: 'sha256:prev',
      triggered_by_client_id: 'admin',
    });
    expect(revert.ok).toBe(false);
    if (revert.ok) throw new Error('unreachable');
    expect(revert.error).toBe('rotation_in_progress');
    releaseRenew!();
    await renewPromise;
  });
});
