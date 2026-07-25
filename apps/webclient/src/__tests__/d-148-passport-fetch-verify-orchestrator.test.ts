/** D-148 § A.6.5 + § A.9 / slice 116 — passport-fetch verify
 *  orchestrator.
 *
 *  Covers `runPassportFetchVerify` — the post-WS-connect pipeline that
 *  composes the slice-115 verify primitives with the rpc surface +
 *  local-store persist + cert-pin state watcher + local pair-required
 *  trigger.
 *
 *  Each test pins the conn + localStore + watcher behind in-memory
 *  doubles so the dispatch logic is observable without a live WS or
 *  a real verify primitive (the verify primitive is exercised by the
 *  slice 115 test file; this file's concern is the orchestration glue).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  canonicalPassportSigningPayload,
  SERVER_PASSPORT_VERSION,
  type Conn,
  type ServerPassportSupportRedacted,
  type ServerRpcRegistry,
  type WebclientCertPinState,
} from '@recued/contracts';
import { bytesToBase64 } from '@recued/crypto';

import { runPassportFetchVerify } from '../realtime/passport-fetch-verify.js';
import type { CertPinStateWatcher } from '../realtime/cert-pin-state-watcher.js';
import { createInMemoryWebclientLocalStore } from '../storage/local-store.js';

// ════════════════════════════════════════════════════════════════
// Fixtures
// ════════════════════════════════════════════════════════════════

const ed25519Available = async (): Promise<boolean> => {
  try {
    await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
};

interface KeyFixture {
  pubkeyB64: string;
  privateKey: CryptoKey;
}

const generateEd25519Fixture = async (): Promise<KeyFixture> => {
  const kp = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as unknown as { privateKey: CryptoKey; publicKey: CryptoKey };
  const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
  return {
    pubkeyB64: bytesToBase64(new Uint8Array(spki)),
    privateKey: kp.privateKey,
  };
};

const FIXED_NOW = 1_700_000_000_000;

const buildSignedPassport = async (
  key: KeyFixture,
  over?: Partial<ServerPassportSupportRedacted['network']>,
): Promise<ServerPassportSupportRedacted> => {
  const passport: Omit<ServerPassportSupportRedacted, 'signature'> = {
    passport_version: SERVER_PASSPORT_VERSION,
    passport_id: 'passport-uuid-1',
    profile: 'support_redacted',
    exported_at: FIXED_NOW,
    exported_by_client_id: 'client-abc',
    identity: {
      server_public_key: key.pubkeyB64,
      server_identity_fingerprint: 'sha256:server',
      current_handle: 'alice',
    },
    network: {
      cert_fingerprint: 'sha256:current',
      cert_expires_at: 1_710_000_000_000,
      derived_preset_label: 'lan_only',
      public_mcp_acknowledged: false,
      per_path: {
        health: { resolution: { lan: true, public: false } },
        ws: { resolution: { lan: true, public: false } },
        mcp: { resolution: { lan: true, public: false } },
        llm_gateway: { resolution: { lan: true, public: false } },
        webhooks: { resolution: { lan: false, public: false } },
        reception: { resolution: { lan: false, public: false } },
        oauth: { resolution: { lan: false, public: false } },
        ask: { resolution: { lan: false, public: false } },
        webclient: { resolution: { lan: true, public: false } },
      },
      ...over,
    },
    clients: { bridge_count: 0, webclient_count: 1, cli_count: 0 },
    capabilities: {
      software_version: '0.2.0',
      os: 'linux',
      arch: 'x64',
      installed_pack_count: 0,
      connections_by_vendor: [],
    },
    recovery: {
      backup_status: 'configured',
      filevault_recovery_key_status: 'present',
    },
    key_health: {
      master_dek: { status: 'healthy' },
      sub_dek: { status: 'healthy' },
      server_identity_key: { status: 'healthy' },
      publisher_identity_key: { status: 'healthy' },
      tls_private_key: { status: 'healthy' },
      webclient_token: { status: 'healthy' },
      webhook_secret: { status: 'healthy' },
    },
  };
  const transcript = new TextEncoder().encode(
    canonicalPassportSigningPayload({ ...passport, signature: '' }),
  );
  const sigBytes = await crypto.subtle.sign(
    { name: 'Ed25519' },
    key.privateKey,
    transcript as BufferSource,
  );
  return { ...passport, signature: bytesToBase64(new Uint8Array(sigBytes)) };
};

const buildStubConn = <T>(value: T): { call: Conn<ServerRpcRegistry>; calls: number } => {
  let calls = 0;
  const call = (async (method: string) => {
    calls += 1;
    if (method !== 'passport.fetch') {
      throw new Error(`unexpected rpc method in stub: ${method}`);
    }
    return value as unknown;
  }) as unknown as Conn<ServerRpcRegistry>;
  return {
    call,
    get calls() {
      return calls;
    },
  };
};

const buildStubWatcher = (): CertPinStateWatcher & {
  readonly notifyCalls: ReadonlyArray<WebclientCertPinState | null>;
} => {
  const notifyCalls: Array<WebclientCertPinState | null> = [];
  return {
    getState: () => null,
    subscribe: () => () => undefined,
    notify: (state) => {
      notifyCalls.push(state);
    },
    refresh: async () => null,
    dispose: () => undefined,
    get notifyCalls() {
      return notifyCalls;
    },
  };
};

// ════════════════════════════════════════════════════════════════
// runPassportFetchVerify
// ════════════════════════════════════════════════════════════════

describe('D-148 § A.6.5 + § A.9 / slice 116 — runPassportFetchVerify orchestrator', () => {
  it('persists the seeded pin state + fires watcher.notify when no prior pin exists', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const passport = await buildSignedPassport(key, {
      cert_fingerprint: 'sha256:fresh',
      cert_expires_at: 1_750_000_000_000,
    });
    const conn = buildStubConn({ passport });
    const store = createInMemoryWebclientLocalStore();
    const watcher = buildStubWatcher();
    await runPassportFetchVerify({
      conn: conn.call,
      localStore: store,
      pinnedServerPublicKey: key.pubkeyB64,
      certPinWatcher: watcher,
      now: () => FIXED_NOW,
    });
    expect(conn.calls).toBe(1);
    const persisted = await store.get('cert_pin_state');
    expect(persisted?.current_fingerprint).toBe('sha256:fresh');
    expect(persisted?.previous_fingerprint).toBeUndefined();
    expect(watcher.notifyCalls).toHaveLength(1);
    expect(watcher.notifyCalls[0]?.current_fingerprint).toBe('sha256:fresh');
  });

  it('promotes staged-next + retains previous_fingerprint on observation of the new cert', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const passport = await buildSignedPassport(key, {
      cert_fingerprint: 'sha256:next',
      cert_expires_at: 1_750_000_000_000,
    });
    const conn = buildStubConn({ passport });
    const store = createInMemoryWebclientLocalStore();
    await store.set('cert_pin_state', {
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      current_valid_until: 1_701_000_000_000,
    });
    const watcher = buildStubWatcher();
    await runPassportFetchVerify({
      conn: conn.call,
      localStore: store,
      pinnedServerPublicKey: key.pubkeyB64,
      certPinWatcher: watcher,
      now: () => FIXED_NOW,
    });
    const persisted = await store.get('cert_pin_state');
    expect(persisted?.current_fingerprint).toBe('sha256:next');
    expect(persisted?.previous_fingerprint).toBe('sha256:current');
    expect(persisted?.next_fingerprint).toBeUndefined();
    expect(watcher.notifyCalls).toHaveLength(1);
  });

  it('skips persist + notify on idempotent outcome (DD#4)', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const passport = await buildSignedPassport(key, {
      cert_fingerprint: 'sha256:current',
      cert_expires_at: 1_710_000_000_000,
    });
    const conn = buildStubConn({ passport });
    const store = createInMemoryWebclientLocalStore();
    const initialPin: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      current_valid_until: 1_710_000_000_000,
    };
    await store.set('cert_pin_state', initialPin);
    const watcher = buildStubWatcher();
    const setSpy = vi.spyOn(store, 'set');
    await runPassportFetchVerify({
      conn: conn.call,
      localStore: store,
      pinnedServerPublicKey: key.pubkeyB64,
      certPinWatcher: watcher,
      now: () => FIXED_NOW,
    });
    expect(setSpy).not.toHaveBeenCalled();
    expect(watcher.notifyCalls).toHaveLength(0);
  });

  it('fires onPairRequired when verify rejects with observed_fingerprint_unknown (MITM signal)', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const passport = await buildSignedPassport(key, {
      cert_fingerprint: 'sha256:wild',
      cert_expires_at: 1_750_000_000_000,
    });
    const conn = buildStubConn({ passport });
    const store = createInMemoryWebclientLocalStore();
    await store.set('cert_pin_state', {
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      current_valid_until: 1_701_000_000_000,
    });
    const pairRequiredEvents: Array<{ cert_fingerprint_observed: string }> = [];
    const onError = vi.fn();
    await runPassportFetchVerify({
      conn: conn.call,
      localStore: store,
      pinnedServerPublicKey: key.pubkeyB64,
      now: () => FIXED_NOW,
      onError,
      onPairRequired: (ctx) => pairRequiredEvents.push(ctx),
    });
    expect(pairRequiredEvents).toEqual([
      { cert_fingerprint_observed: 'sha256:wild' },
    ]);
    expect(onError).not.toHaveBeenCalled();
    // Pin state untouched — MITM signal must not advance the pin.
    const persisted = await store.get('cert_pin_state');
    expect(persisted?.current_fingerprint).toBe('sha256:current');
    expect(persisted?.next_fingerprint).toBe('sha256:next');
  });

  it('routes signature_invalid through onError with stage=verify + verify_reason populated', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const passport = await buildSignedPassport(key);
    // Forge the signature.
    const conn = buildStubConn({ passport: { ...passport, signature: 'AAAA' } });
    const store = createInMemoryWebclientLocalStore();
    const errors: Array<{ message: string; stage: string; verify_reason?: string }> = [];
    await runPassportFetchVerify({
      conn: conn.call,
      localStore: store,
      pinnedServerPublicKey: key.pubkeyB64,
      now: () => FIXED_NOW,
      onError: (err, ctx) =>
        errors.push({
          message: err.message,
          stage: ctx.stage,
          ...(ctx.verify_reason !== undefined ? { verify_reason: ctx.verify_reason } : {}),
        }),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.stage).toBe('verify');
    expect(errors[0]?.verify_reason).toBe('signature_invalid');
    expect(errors[0]?.message).toContain('signature_invalid');
  });

  it('routes rpc rejection through onError with stage=rpc (e.g. not_configured)', async () => {
    const conn: { call: Conn<ServerRpcRegistry> } = {
      call: (async () => {
        throw new Error('rpc: passport.fetch not_configured');
      }) as unknown as Conn<ServerRpcRegistry>,
    };
    const store = createInMemoryWebclientLocalStore();
    const errors: Array<{ message: string; stage: string }> = [];
    await runPassportFetchVerify({
      conn: conn.call,
      localStore: store,
      pinnedServerPublicKey: 'pinned',
      now: () => FIXED_NOW,
      onError: (err, ctx) => errors.push({ message: err.message, stage: ctx.stage }),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.stage).toBe('rpc');
    expect(errors[0]?.message).toContain('not_configured');
  });

  it('routes localStore.set failure through onError with stage=persist', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const passport = await buildSignedPassport(key, {
      cert_fingerprint: 'sha256:fresh',
      cert_expires_at: 1_750_000_000_000,
    });
    const conn = buildStubConn({ passport });
    const store = createInMemoryWebclientLocalStore();
    vi.spyOn(store, 'set').mockRejectedValue(new Error('disk full'));
    const errors: Array<{ message: string; stage: string }> = [];
    await runPassportFetchVerify({
      conn: conn.call,
      localStore: store,
      pinnedServerPublicKey: key.pubkeyB64,
      now: () => FIXED_NOW,
      onError: (err, ctx) => errors.push({ message: err.message, stage: ctx.stage }),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.stage).toBe('persist');
    expect(errors[0]?.message).toContain('disk full');
  });

  it('routes localStore.get failure through onError with stage=read', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const passport = await buildSignedPassport(key);
    const conn = buildStubConn({ passport });
    const store = createInMemoryWebclientLocalStore();
    vi.spyOn(store, 'get').mockImplementation((async (k: string) => {
      if (k === 'cert_pin_state') throw new Error('store unavailable');
      return null;
    }) as typeof store.get);
    const errors: Array<{ stage: string }> = [];
    await runPassportFetchVerify({
      conn: conn.call,
      localStore: store,
      pinnedServerPublicKey: key.pubkeyB64,
      now: () => FIXED_NOW,
      onError: (_err, ctx) => errors.push({ stage: ctx.stage }),
    });
    expect(errors).toEqual([{ stage: 'read' }]);
  });

  it('skips watcher.notify when no watcher is wired (DD#3 — optional render-freshness optimization)', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const passport = await buildSignedPassport(key, {
      cert_fingerprint: 'sha256:fresh',
      cert_expires_at: 1_750_000_000_000,
    });
    const conn = buildStubConn({ passport });
    const store = createInMemoryWebclientLocalStore();
    await runPassportFetchVerify({
      conn: conn.call,
      localStore: store,
      pinnedServerPublicKey: key.pubkeyB64,
      now: () => FIXED_NOW,
    });
    // Persist should have happened.
    const persisted = await store.get('cert_pin_state');
    expect(persisted?.current_fingerprint).toBe('sha256:fresh');
    // No watcher: no notify call possible — the test asserts the
    // orchestrator doesn't throw when the optional dep is absent.
  });

  it('skips persist when a concurrent transition lands between read + write (Codex P2 fold, slice 116 CAS)', async () => {
    if (!(await ed25519Available())) return;
    // Simulate the race: the orchestrator reads the snapshot, then a
    // concurrent transition (e.g. a cert.rotation_reverted from the
    // bus) writes a different snapshot, then the orchestrator tries
    // to persist. Pre-fold the persist would resurrect the
    // promoted-then-reverted state. Post-fold the CAS check drops
    // the late write + lets the next reconnect re-attempt.
    const key = await generateEd25519Fixture();
    const passport = await buildSignedPassport(key, {
      cert_fingerprint: 'sha256:next',
      cert_expires_at: 1_750_000_000_000,
    });
    const conn = buildStubConn({ passport });
    const store = createInMemoryWebclientLocalStore();
    const stagedInitial: WebclientCertPinState = {
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      current_valid_until: 1_701_000_000_000,
    };
    await store.set('cert_pin_state', stagedInitial);
    // Set up the race: after the first .get (the read in step 2),
    // mutate the store to a different snapshot. The CAS re-read at
    // write time should see the new snapshot + bail.
    let firstGetSeen = false;
    const originalGet = store.get.bind(store);
    vi.spyOn(store, 'get').mockImplementation(((async (k: string) => {
      const value = await originalGet(k as 'cert_pin_state');
      if (k === 'cert_pin_state' && !firstGetSeen) {
        firstGetSeen = true;
        // Simulate a concurrent transition writing a different state.
        await store.set('cert_pin_state', {
          current_fingerprint: 'sha256:current',
          previous_fingerprint: 'sha256:current',
          previous_valid_until: 1_701_000_000_000,
          current_valid_until: 1_701_000_000_000,
          last_rotated_at: 1_700_500_000_000,
        });
      }
      return value;
    }) as unknown) as typeof store.get);
    const watcher = buildStubWatcher();
    await runPassportFetchVerify({
      conn: conn.call,
      localStore: store,
      pinnedServerPublicKey: key.pubkeyB64,
      certPinWatcher: watcher,
      now: () => FIXED_NOW,
    });
    // Persist was skipped — the concurrent state wins.
    const persisted = await store.get('cert_pin_state');
    expect(persisted?.current_fingerprint).toBe('sha256:current');
    expect(persisted?.previous_fingerprint).toBe('sha256:current');
    // Watcher should NOT have been notified — the verify path bailed.
    expect(watcher.notifyCalls).toHaveLength(0);
  });

  it('routes an unexpectedly-thrown verify error through onError with stage=verify (Codex P2 fold, slice 116b round 3)', async () => {
    if (!(await ed25519Available())) return;
    // Build a malformed passport: a non-finite number in
    // `cert_expires_at` causes `canonicalPassportSigningPayload` to
    // throw (`canonicalJSONStringify: non-finite number`) BEFORE
    // `verifyPassportCertAttestation` reaches its typed rejection path.
    // Pre-fold this would have surfaced as an unhandled promise
    // rejection from the bootstrap's fire-and-forget call.
    const key = await generateEd25519Fixture();
    const malformed = await buildSignedPassport(key);
    (malformed.network as unknown as { cert_expires_at: number }).cert_expires_at =
      Number.POSITIVE_INFINITY;
    const conn = buildStubConn({ passport: malformed });
    const store = createInMemoryWebclientLocalStore();
    const errors: Array<{ message: string; stage: string }> = [];
    await runPassportFetchVerify({
      conn: conn.call,
      localStore: store,
      pinnedServerPublicKey: key.pubkeyB64,
      now: () => FIXED_NOW,
      onError: (err, ctx) => errors.push({ message: err.message, stage: ctx.stage }),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.stage).toBe('verify');
  });

  it('isolates an onPairRequired sink that throws (must never re-enter the orchestrator)', async () => {
    if (!(await ed25519Available())) return;
    const key = await generateEd25519Fixture();
    const passport = await buildSignedPassport(key, {
      cert_fingerprint: 'sha256:wild',
      cert_expires_at: 1_750_000_000_000,
    });
    const conn = buildStubConn({ passport });
    const store = createInMemoryWebclientLocalStore();
    await store.set('cert_pin_state', {
      current_fingerprint: 'sha256:current',
      current_valid_until: 1_710_000_000_000,
    });
    // Should not throw out of the orchestrator.
    await expect(
      runPassportFetchVerify({
        conn: conn.call,
        localStore: store,
        pinnedServerPublicKey: key.pubkeyB64,
        now: () => FIXED_NOW,
        onPairRequired: () => {
          throw new Error('renderer bug');
        },
      }),
    ).resolves.toBeUndefined();
  });
});
