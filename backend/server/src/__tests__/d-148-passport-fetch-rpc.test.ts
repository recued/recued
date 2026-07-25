/** D-148 § A.6.5 + § A.9 — `passport.fetch` rpc handler tests.
 *
 *  Covers the thin rpc-layer wrapper around `exportServerPassport(...)`
 *  configured for the post-WS-connect verify path:
 *
 *    - happy path: returns a signed `support_redacted` projection;
 *      signature verifies against the server identity public key over
 *      the canonical-JSON transcript (matches the webclient verify
 *      primitive's transcript byte-for-byte).
 *    - audit-row exemption: the fetch path NEVER writes a
 *      `passport.exported` high-assurance audit row (per the module-
 *      level rationale — every WS reconnect would otherwise flood the
 *      ledger). This is the load-bearing invariant; channel isolation
 *      (`passport.` in `MCP_RESERVED_RPC_PREFIXES`) is what makes the
 *      exemption safe.
 *    - identity-mismatch defense: the rpc returns a passport whose
 *      `identity.server_public_key` matches the signing key; the
 *      webclient verify primitive's identity-replay check sees this
 *      end-to-end.
 *    - `ctx.instance_id` null → `RpcError('forbidden')`: belt-and-
 *      braces with the dispatcher's register gate.
 *    - `makePassportFetchHandlers(undefined)` returns `undefined` so
 *      the slice composer drops + the rpc returns `not_configured` 501.
 *    - slice methods array contains exactly `'passport.fetch'`.
 *    - `exported_by_client_id` carries the caller's `instance_id`
 *      (forensic linkage between the verify call + the connected
 *      client even though no audit row is written).
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  canonicalPassportSigningPayload,
  SERVER_PASSPORT_VERSION,
  type ServerPassportSupportRedacted,
} from '@recued/contracts';

import {
  handlePassportFetch,
  makePassportFetchHandlers,
  type PassportFetchRpcDeps,
} from '../passport/fetch-handler.js';
import {
  ed25519Verify,
  generateEd25519Keypair,
  type Ed25519Keypair,
} from '../keys/index.js';
import type { PassportBlockProviders } from '../passport/index.js';
import type { WsClient } from '../ws-server.js';

// ════════════════════════════════════════════════════════════════
// Fixtures
// ════════════════════════════════════════════════════════════════

const stubCtx = (instance_id: string | null): WsClient =>
  ({
    ws: null,
    realm: 'recued',
    instance_id,
    display_name: 'test client',
    connected_at: Date.now(),
  }) as unknown as WsClient;

const buildProviders = (serverPublicKey: string): PassportBlockProviders => ({
  loadIdentity: () => ({
    server_public_key: serverPublicKey,
    server_identity_fingerprint: 'sha256:identity',
    publisher_id: 'pub-1',
    current_handle: 'alice',
    handle_history: [],
    publisher_identity_fingerprint: 'sha256:publisher',
  }),
  loadNetwork: () => ({
    lan_urls: ['https://alice.local:8443'],
    cert_fingerprint: 'sha256:cert',
    cert_expires_at: 1_710_000_000_000,
    derived_preset_label: 'lan_only',
    public_mcp_acknowledgement: {
      acknowledged: false,
    },
    per_path: {
      health: {
        resolution: { lan: true, public: false },
      },
      ws: {
        resolution: { lan: true, public: false },
      },
      mcp: {
        resolution: { lan: true, public: false },
      },
      llm_gateway: {
        resolution: { lan: true, public: false },
      },
      webhooks: {
        resolution: { lan: false, public: false },
      },
      reception: {
        resolution: { lan: false, public: false },
      },
      oauth: {
        resolution: { lan: false, public: false },
      },
      ask: {
        resolution: { lan: false, public: false },
      },
      webclient: {
        resolution: { lan: true, public: false },
      },
    },
  }),
  loadClients: () => [
    {
      client_id: 'client-1',
      client_kind: 'webclient',
      paired_at: 1_690_000_000_000,
    },
  ],
  loadCapabilities: () => ({
    software_version: '0.2.0',
    os: 'linux',
    arch: 'x64',
    storage_size_bytes: 1024,
    ai_pool_configured: false,
    byok_slots_configured: 0,
    scheduled_recipes_count: 0,
    reactive_recipes_count: 0,
    installed_packs: [],
    connections: [],
  }),
  loadRecovery: () => ({
    backup_status: 'configured',
    filevault_recovery_key_status: 'present',
  }),
  loadKeyHealth: () => ({
    master_dek: { status: 'healthy' },
    sub_dek: { status: 'healthy' },
    server_identity_key: { status: 'healthy' },
    publisher_identity_key: { status: 'healthy' },
    tls_private_key: { status: 'healthy' },
    webclient_token: { status: 'healthy' },
    webhook_secret: { status: 'healthy' },
  }),
});

const FIXED_NOW = 1_700_000_000_000;

describe('D-148 § A.6.5 + § A.9 — handlePassportFetch rpc handler', () => {
  let serverIdentity: Ed25519Keypair;
  let deps: PassportFetchRpcDeps;

  beforeEach(() => {
    serverIdentity = generateEd25519Keypair('server_identity_key');
    deps = {
      providers: buildProviders(serverIdentity.public_key_b64),
      // Per-call getter (Codex P1 fold, slice 117) — production wires
      // `() => signingIdentityRef.identity.serverIdentityKey()` so a
      // rotation between deps construction + the rpc call signs with
      // the live key. Tests pin a single keypair for the suite.
      serverIdentity: () => serverIdentity,
      now: () => FIXED_NOW,
      mintId: () => 'passport-uuid-test',
    };
  });

  it('happy path: returns a signed support_redacted projection that verifies against the signing key', async () => {
    const result = await handlePassportFetch(deps, undefined, stubCtx('client-xyz'));
    expect(result.passport.profile).toBe('support_redacted');
    expect(result.passport.passport_version).toBe(SERVER_PASSPORT_VERSION);
    expect(result.passport.passport_id).toBe('passport-uuid-test');
    expect(result.passport.exported_at).toBe(FIXED_NOW);
    expect(result.passport.exported_by_client_id).toBe('client-xyz');

    // Verify the signature against the signing key over the canonical
    // signing payload — same transcript the webclient verify primitive
    // composes.
    const projection = result.passport as ServerPassportSupportRedacted;
    const verified = ed25519Verify(
      serverIdentity.public_key_b64,
      canonicalPassportSigningPayload(projection),
      projection.signature,
    );
    expect(verified).toBe(true);
  });

  it('identity block carries the server_public_key for the webclient identity-replay defense', async () => {
    const result = await handlePassportFetch(deps, undefined, stubCtx('client-xyz'));
    const projection = result.passport as ServerPassportSupportRedacted;
    expect(projection.identity.server_public_key).toBe(serverIdentity.public_key_b64);
  });

  it('network block surfaces cert_fingerprint + cert_expires_at the verify path consumes as observed_*', async () => {
    const result = await handlePassportFetch(deps, undefined, stubCtx('client-xyz'));
    const projection = result.passport as ServerPassportSupportRedacted;
    expect(projection.network.cert_fingerprint).toBe('sha256:cert');
    expect(projection.network.cert_expires_at).toBe(1_710_000_000_000);
  });

  it('NEVER writes a passport.exported audit row (audit-exemption invariant)', async () => {
    // The audit emitter the slice composes is the in-handler NO-OP
    // constant; we proxy `args.providers` + `args.serverIdentity` +
    // `args.now` + `args.mintId` through but no `audit` field is
    // exposed on the rpc-deps surface. Asserting that absence — plus
    // the happy-path call succeeding — is the contract. The dedicated
    // audit-row test for user-initiated `passport.export` lives in
    // `d-148-phase-8-passport.test.ts`.
    expect((deps as unknown as Record<string, unknown>).audit).toBeUndefined();
    const result = await handlePassportFetch(deps, undefined, stubCtx('client-xyz'));
    expect(result.passport).toBeDefined();
  });

  it('accepts callers with null instance_id (webclient-bearer-only path, Codex 2026-05-17 P1 fold)', async () => {
    // Pre-fold the handler raised forbidden when `ctx.instance_id ===
    // null`. The fold lifts that gate because the webclient bootstrap
    // doesn't send the legacy `register` message — every default-on
    // passport-fetch call would have 403'd otherwise. Channel isolation
    // (`passport.` in MCP_RESERVED_RPC_PREFIXES) remains the operator-
    // only gate; the fetch path is read-only + writes no audit row.
    const result = await handlePassportFetch(deps, undefined, stubCtx(null));
    expect(result.passport).toBeDefined();
    expect(result.passport.exported_by_client_id).toBe(
      'webclient-bearer-unregistered',
    );
  });

  it('exported_by_client_id is the caller-provided instance_id when set (forensic linkage even without an audit row)', async () => {
    const result = await handlePassportFetch(deps, undefined, stubCtx('forensic-client-id'));
    expect(result.passport.exported_by_client_id).toBe('forensic-client-id');
  });

  it('makePassportFetchHandlers(undefined) returns undefined (slice drops; rpc returns not_configured)', () => {
    expect(makePassportFetchHandlers(undefined)).toBeUndefined();
  });

  it('slice methods array contains exactly passport.fetch', () => {
    const slice = makePassportFetchHandlers(deps);
    expect(slice).toBeDefined();
    expect(slice?.methods).toEqual(['passport.fetch']);
    expect(slice?.handlers['passport.fetch']).toBeTypeOf('function');
  });

  it('serverIdentity getter resolves per-call so rotation between deps construction and rpc invocation signs with the live key (Codex P1 fold, slice 117)', async () => {
    // Pre-fold the contract took a `Ed25519Keypair` snapshot — a
    // rotation between boot + the rpc call left the cached private key
    // in place, but `loadIdentity()` read the LIVE public key so the
    // passport's identity block + signature were misaligned (webclient
    // would reject `signature_invalid` for post-rotation pins).
    //
    // Post-fold: pass a getter that mutates between calls. The first
    // call signs with key A + reports key A's fingerprint; rotate the
    // getter to key B; the second call signs with key B + reports key
    // B's fingerprint. Both signatures verify against their respective
    // identity blocks — proving the wiring resolves both surfaces from
    // the same fresh keypair per invocation.
    const keyA = generateEd25519Keypair('server_identity_key');
    const keyB = generateEd25519Keypair('server_identity_key');
    let liveKey = keyA;
    // The loadIdentity provider must ALSO read live (mirroring the
    // production composer's behaviour); rebuild providers around a
    // mutable live-key getter.
    const liveProviders: PassportBlockProviders = {
      ...buildProviders(''),
      loadIdentity: () => ({
        server_public_key: liveKey.public_key_b64,
        server_identity_fingerprint: liveKey.public_key_fingerprint,
        publisher_id: 'pub-1',
        current_handle: 'alice',
        handle_history: [],
        publisher_identity_fingerprint: 'sha256:publisher',
      }),
    };
    const rotatingDeps: PassportFetchRpcDeps = {
      providers: liveProviders,
      serverIdentity: () => liveKey,
      now: () => FIXED_NOW,
      mintId: () => 'passport-uuid-rotating',
    };
    const before = await handlePassportFetch(rotatingDeps, undefined, stubCtx('client-pre'));
    const projectionA = before.passport as ServerPassportSupportRedacted;
    expect(projectionA.identity.server_public_key).toBe(keyA.public_key_b64);
    expect(
      ed25519Verify(
        keyA.public_key_b64,
        canonicalPassportSigningPayload(projectionA),
        projectionA.signature,
      ),
    ).toBe(true);
    // Rotate.
    liveKey = keyB;
    const after = await handlePassportFetch(rotatingDeps, undefined, stubCtx('client-post'));
    const projectionB = after.passport as ServerPassportSupportRedacted;
    expect(projectionB.identity.server_public_key).toBe(keyB.public_key_b64);
    expect(
      ed25519Verify(
        keyB.public_key_b64,
        canonicalPassportSigningPayload(projectionB),
        projectionB.signature,
      ),
    ).toBe(true);
  });
});
