/** D-169 P1.5 — bridge pair persistence wiring tests.
 *
 *  Covers the implementation surface:
 *   - `apps/bridge/src/pairing/pair-completion.ts` — `finalizeBridgePair`
 *     orchestrator + `normaliseServerUrlToWs` URL canonicaliser + the
 *     `BridgePairFinalizeResult` taxonomy.
 *   - `apps/bridge/src/pairing/pair-passport-invoker.ts` — the one-shot
 *     `passport.fetch` invoker over the bridge's `WsTransportFactory`.
 *   - `apps/bridge/src/boot/service-worker-bootstrap.ts` — the
 *     `recued.bridge.pair` chrome.runtime.onMessage branch that
 *     drives the worker's pairing session (`pairing/worker-pairing.ts`,
 *     which has its own suite) + the single-flight guard + the
 *     test-seam deps.
 *   - `apps/bridge/src/boot/sw-message-queue.ts` — the cold-start
 *     `chrome.runtime.onMessage` shim. Previously inline in
 *     `service-worker-entry.ts` (commit bf7aab2a, 4 it.todo
 *     placeholders); extracted into a pure factory in the follow-on
 *     so the four HIGH ratchets (#3 / #4 / #6 / #10) become unit-
 *     testable without chrome-stub-aware module load. The describe
 *     block at the bottom of this file promotes the 4 todos to
 *     passing tests + adds the ANGLE 7 (post-rejection arrival) +
 *     ANGLE 5 (second-call idempotency) folds caught during the
 *     extraction's own review.
 *
 *  Spec: D-169 § N.5 + Migration.
 *  Folds covered: HIGH #1 timer-covers-handshake, HIGH #2
 *  webclient_token-last write order, HIGH #3 cold-start shim queue,
 *  HIGH #4 explicit drain (not on first addListener), HIGH #6
 *  bootReady gate, HIGH #7 reject re-pair entrance guard, HIGH #8
 *  storage read in try/catch + top-level handler catch, MEDIUM #9
 *  onClose/onError subscriptions, HIGH #10 boot-rejection queue flush,
 *  HIGH #11 single-flight pair-completion guard, ANGLE 5 second-call
 *  idempotency, ANGLE 7 post-rejection arrival hang. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  WebclientCertPinState,
  WebclientPairMetadata,
  WebclientTokenRecord,
} from '@recued/contracts';

import {
  BRIDGE_PAIR_COMPLETION_ERROR_COPY,
  BRIDGE_PAIR_COMPLETION_FINAL_ERRORS,
  finalizeBridgePair,
  normaliseServerUrlToWs,
  type BridgePairCompletionErrorCode,
  type BridgePairPassportInvoker,
  type BridgePairFinalizeResult,
} from '../pairing/pair-completion.js';
import { BRIDGE_PAIR_MESSAGE_TYPE } from '../pairing/worker-pairing.js';
import {
  BRIDGE_PAIR_PASSPORT_INVOKER_DEFAULT_TIMEOUT_MS,
  BridgePairPassportRpcError,
  createBridgePairPassportInvoker,
} from '../pairing/pair-passport-invoker.js';
import {
  bootBridgeServiceWorker,
  type BridgeServiceWorkerDeps,
  type BridgeSwLifecycle,
  type ChromeRuntimeOnMessageApi,
} from '../boot/service-worker-bootstrap.js';
import {
  createSwMessageQueue,
  type SwMessageQueueHandle,
  type SwOnMessageProxy,
} from '../boot/sw-message-queue.js';
import { BRIDGE_PENDING_PAIR_SESSION_KEY } from '../pairing/pending-pair-store.js';
import {
  createInMemoryBridgeLocalStore,
  type BridgeLocalStore,
  type ChromeStorageLocal,
} from '../storage/local-store.js';
import type {
  WebclientTokenAad,
  WebclientTokenStore,
} from '../storage/token-store.js';
import type {
  ActionExecutorOutcome,
  ActionExecutorRequest,
  BridgeActionExecutor,
} from '../queue/dispatcher.js';
import type {
  WsTransport,
  WsTransportFactory,
} from '../transport/ws-client.js';

// ════════════════════════════════════════════════════════════════
// Fakes
// ════════════════════════════════════════════════════════════════

const FIXED_NOW = 1_700_000_000_000;
const FIXED_TOKEN_ID = 'fixed-token-id-1234';

interface FakeTokenStoreCalls {
  wrap: Array<{ token_id: string; bearer: string; aad: WebclientTokenAad }>;
}

const buildFakeTokenStore = (): {
  store: WebclientTokenStore;
  calls: FakeTokenStoreCalls;
} => {
  const calls: FakeTokenStoreCalls = { wrap: [] };
  const store: WebclientTokenStore = {
    async wrap({ token_id, bearer, aad }) {
      calls.wrap.push({ token_id, bearer, aad });
      return {
        token_id,
        ciphertext_b64: `wrap(${bearer})`,
        iv_b64: 'aXY=',
        issued_at: FIXED_NOW,
      };
    },
    async unwrap(record) {
      const m = /^wrap\((.*)\)$/.exec(record.ciphertext_b64);
      if (!m) throw new Error('fake unwrap: ciphertext not produced by fake wrap');
      return m[1]!;
    },
  };
  return { store, calls };
};

const buildPassportProjection = (overrides: {
  server_public_key?: string;
  current_handle?: string;
  cert_fingerprint?: string;
  cert_expires_at?: number;
}): unknown => ({
  identity: {
    server_public_key: overrides.server_public_key ?? 'PUBKEY_BASE64',
    current_handle: overrides.current_handle ?? 'alice',
  },
  network: {
    ...(overrides.cert_fingerprint !== undefined
      ? { cert_fingerprint: overrides.cert_fingerprint }
      : {}),
    ...(overrides.cert_expires_at !== undefined
      ? { cert_expires_at: overrides.cert_expires_at }
      : {}),
  },
});

const seamOptions = () => ({
  now: () => FIXED_NOW,
  mintTokenId: () => FIXED_TOKEN_ID,
});

// ════════════════════════════════════════════════════════════════
// normaliseServerUrlToWs
// ════════════════════════════════════════════════════════════════

describe('normaliseServerUrlToWs', () => {
  it('converts http://host:port → ws://host:port/ws', () => {
    expect(normaliseServerUrlToWs('http://localhost:3001')).toBe(
      'ws://localhost:3001/ws',
    );
  });

  it('converts https://host:port → wss://host:port/ws', () => {
    expect(normaliseServerUrlToWs('https://alice.recued.cloud:8443')).toBe(
      'wss://alice.recued.cloud:8443/ws',
    );
  });

  it('passes through an already-canonical ws://host/ws URL', () => {
    expect(normaliseServerUrlToWs('ws://localhost:3001/ws')).toBe(
      'ws://localhost:3001/ws',
    );
  });

  it('passes through an already-canonical wss URL', () => {
    expect(normaliseServerUrlToWs('wss://server.example/ws')).toBe(
      'wss://server.example/ws',
    );
  });

  it('appends /ws when the path is present but does not end in /ws', () => {
    expect(normaliseServerUrlToWs('https://server.example/api')).toBe(
      'wss://server.example/api/ws',
    );
  });

  it('strips a trailing / from a bare host before appending /ws', () => {
    expect(normaliseServerUrlToWs('http://localhost:3001/')).toBe(
      'ws://localhost:3001/ws',
    );
  });

  it('preserves a path ending in /ws (Codex P5 R1 fold — trailing-slash strip safety)', () => {
    expect(normaliseServerUrlToWs('https://server.example:443/ws')).toBe(
      'wss://server.example:443/ws',
    );
  });

  it('rejects an empty string', () => {
    expect(normaliseServerUrlToWs('')).toBeNull();
  });

  it('rejects a scheme-less URL', () => {
    expect(normaliseServerUrlToWs('localhost:3001')).toBeNull();
  });

  it('rejects a URL with no host (ws:///path)', () => {
    expect(normaliseServerUrlToWs('ws:///ws')).toBeNull();
  });

  it('rejects a URL that is just the scheme (http://)', () => {
    expect(normaliseServerUrlToWs('http://')).toBeNull();
  });

  it('rejects whitespace-only input', () => {
    expect(normaliseServerUrlToWs('   ')).toBeNull();
  });

  // ── F2 (bridge security hunt) — require wss:// for PUBLIC hosts ──

  it('F2 — rejects a public http:// (would be plaintext ws:// over the internet)', () => {
    expect(normaliseServerUrlToWs('http://server.example:3001')).toBeNull();
  });

  it('F2 — rejects an explicit public ws://', () => {
    expect(normaliseServerUrlToWs('ws://server.example/ws')).toBeNull();
  });

  it('F2 — rejects a bare public-IP ws://', () => {
    expect(normaliseServerUrlToWs('ws://203.0.113.7:3001')).toBeNull();
  });

  it('F2 — still allows a public wss:// (TLS-encrypted)', () => {
    expect(normaliseServerUrlToWs('wss://server.example/ws')).toBe('wss://server.example/ws');
  });

  it('F2 — allows loopback + RFC1918 plaintext ws:// (LAN self-host preserved)', () => {
    expect(normaliseServerUrlToWs('http://127.0.0.1:3001')).toBe('ws://127.0.0.1:3001/ws');
    expect(normaliseServerUrlToWs('http://10.0.0.5:3001')).toBe('ws://10.0.0.5:3001/ws');
    expect(normaliseServerUrlToWs('http://192.168.1.10:3001')).toBe('ws://192.168.1.10:3001/ws');
    expect(normaliseServerUrlToWs('http://172.16.0.9:3001')).toBe('ws://172.16.0.9:3001/ws');
    expect(normaliseServerUrlToWs('http://172.31.255.254:3001')).toBe('ws://172.31.255.254:3001/ws');
    expect(normaliseServerUrlToWs('ws://[::1]:3001/ws')).toBe('ws://[::1]:3001/ws');
  });

  it('F2 — rejects 172.x outside the private 172.16–172.31 block', () => {
    expect(normaliseServerUrlToWs('http://172.15.0.1:3001')).toBeNull();
    expect(normaliseServerUrlToWs('http://172.32.0.1:3001')).toBeNull();
  });

  it('F2 — rejects a PUBLIC host with a private-IP-looking prefix (no startsWith bypass)', () => {
    // `127.0.0.1.evil.com` / `10.evil.com` resolve to attacker-controlled public
    // addresses; the octet parse (not a string prefix) must NOT treat them as LAN.
    expect(normaliseServerUrlToWs('ws://127.0.0.1.evil.com/ws')).toBeNull();
    expect(normaliseServerUrlToWs('http://10.evil.com:3001')).toBeNull();
    expect(normaliseServerUrlToWs('http://192.168.1.10.evil.com:3001')).toBeNull();
    expect(normaliseServerUrlToWs('http://localhost.evil.com:3001')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// finalizeBridgePair — substrate happy path + edge cases
// ════════════════════════════════════════════════════════════════

describe('finalizeBridgePair', () => {
  it('writes 5 fields + binds AAD on the wrapped bearer (happy path)', async () => {
    const localStore = createInMemoryBridgeLocalStore();
    const { store: tokenStore, calls } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: buildPassportProjection({
        server_public_key: 'PUBKEY_BASE64',
        current_handle: 'alice',
        cert_fingerprint: 'CF1',
        cert_expires_at: 2_000_000_000,
      }),
    }));

    const result = await finalizeBridgePair({
      serverUrl: 'http://localhost:3001',
      bearer: 'realm-bearer-xyz',
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token_id).toBe(FIXED_TOKEN_ID);
    expect(result.server_url).toBe('ws://localhost:3001/ws');

    const inspected = await localStore.inspect();
    expect(inspected.server_url).toBe('ws://localhost:3001/ws');
    expect(inspected.server_public_key).toBe('PUBKEY_BASE64');
    expect(inspected.pair_metadata).toEqual<WebclientPairMetadata>({
      paired_at: FIXED_NOW,
      server_passport_fingerprint: 'PUBKEY_BASE64',
      server_handle_at_pair: 'alice',
    });
    expect(inspected.cert_pin_state).toEqual<WebclientCertPinState>({
      current_fingerprint: 'CF1',
      current_valid_until: 2_000_000_000,
    });
    expect(inspected.webclient_token).toMatchObject({
      token_id: FIXED_TOKEN_ID,
      ciphertext_b64: 'wrap(realm-bearer-xyz)',
    });

    expect(calls.wrap).toHaveLength(1);
    // ⚠ NO `server_url`: the AAD is v2 and does not bind the address.
    expect(calls.wrap[0]!.aad).toEqual<WebclientTokenAad>({
      token_id: FIXED_TOKEN_ID,
      server_public_key: 'PUBKEY_BASE64',
    });
    expect(invokePassportFetch).toHaveBeenCalledWith({
      server_url: 'ws://localhost:3001/ws',
      bearer: 'realm-bearer-xyz',
    });
  });

  it('uses server-issued token_id and structured auth for passport fetch', async () => {
    const localStore = createInMemoryBridgeLocalStore();
    const { store: tokenStore, calls } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: buildPassportProjection({
        server_public_key: 'PUBKEY_CANONICAL',
        current_handle: 'alice',
      }),
    }));
    const mintTokenId = vi.fn(() => 'local-fallback-token-id');

    const result = await finalizeBridgePair({
      serverUrl: 'http://localhost:3001',
      bearer: 'server-bearer-once',
      token_id: 'server-token-id',
      localStore,
      tokenStore,
      invokePassportFetch,
      now: () => FIXED_NOW,
      mintTokenId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token_id).toBe('server-token-id');
    expect(mintTokenId).not.toHaveBeenCalled();
    expect(calls.wrap[0]).toMatchObject({
      token_id: 'server-token-id',
      bearer: 'server-bearer-once',
    });
    expect(calls.wrap[0]!.aad).toMatchObject({
      token_id: 'server-token-id',
      server_public_key: 'PUBKEY_CANONICAL',
    });
    expect(invokePassportFetch).toHaveBeenCalledWith({
      server_url: 'ws://localhost:3001/ws',
      bearer: 'server-token-id.server-bearer-once',
    });
  });

  it('uses /auth/pair passport directly when returned', async () => {
    const localStore = createInMemoryBridgeLocalStore();
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => {
      throw new Error('passport.fetch should not run');
    });

    const result = await finalizeBridgePair({
      serverUrl: 'http://localhost:3001',
      bearer: 'server-bearer-once',
      token_id: 'server-token-id',
      passport: buildPassportProjection({
        server_public_key: 'PUBKEY_FROM_PAIR',
        current_handle: 'alice',
      }),
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });

    expect(result.ok).toBe(true);
    expect(invokePassportFetch).not.toHaveBeenCalled();
  });

  it('persists null cert_pin_state when the passport carries no cert (LAN-only)', async () => {
    const localStore = createInMemoryBridgeLocalStore();
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: buildPassportProjection({ server_public_key: 'PUBKEY' }),
    }));
    const result = await finalizeBridgePair({
      serverUrl: 'http://192.168.1.10:3001',
      bearer: 'realm-bearer',
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });
    expect(result.ok).toBe(true);
    const inspected = await localStore.inspect();
    expect(inspected.cert_pin_state).toBeNull();
  });

  it('drops cert_pin_state when fingerprint present but expires_at missing', async () => {
    const localStore = createInMemoryBridgeLocalStore();
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: buildPassportProjection({
        server_public_key: 'PUBKEY',
        cert_fingerprint: 'CF1',
      }),
    }));
    const result = await finalizeBridgePair({
      // `wss://` (not `http://x`): a bare/public host over plaintext ws:// is
      // now rejected (F2); this test exercises cert_pin drop, not URL security.
      serverUrl: 'wss://x:1/ws',
      bearer: 'b',
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });
    expect(result.ok).toBe(true);
    expect((await localStore.inspect()).cert_pin_state).toBeNull();
  });

  it('returns pair_completion_invalid_server_url for a malformed URL without touching IO', async () => {
    const localStore = createInMemoryBridgeLocalStore();
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({ passport: {} }));
    const result = await finalizeBridgePair({
      serverUrl: 'not-a-url',
      bearer: 'b',
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'pair_completion_invalid_server_url',
    });
    expect(invokePassportFetch).not.toHaveBeenCalled();
    const inspected = await localStore.inspect();
    expect(inspected.webclient_token).toBeNull();
  });

  it('returns pair_completion_passport_failed when the invoker rejects', async () => {
    const localStore = createInMemoryBridgeLocalStore();
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => {
      throw new Error('boom');
    });
    const result = await finalizeBridgePair({
      serverUrl: 'http://127.0.0.1:1',
      bearer: 'b',
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'pair_completion_passport_failed',
      detail: 'boom',
    });
    expect((await localStore.inspect()).webclient_token).toBeNull();
  });

  it('returns pair_completion_server_response_invalid when the projection lacks server_public_key', async () => {
    const localStore = createInMemoryBridgeLocalStore();
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: { identity: {}, network: {} },
    }));
    const result = await finalizeBridgePair({
      serverUrl: 'http://127.0.0.1:1',
      bearer: 'b',
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'pair_completion_server_response_invalid',
    });
    expect((await localStore.inspect()).webclient_token).toBeNull();
  });

  it('returns pair_completion_persist_failed when tokenStore.wrap rejects', async () => {
    const localStore = createInMemoryBridgeLocalStore();
    const tokenStore: WebclientTokenStore = {
      async wrap() {
        throw new Error('wrap blew up');
      },
      async unwrap() {
        throw new Error('unwrap unused');
      },
    };
    const invokePassportFetch = vi.fn(async () => ({
      passport: buildPassportProjection({ server_public_key: 'P' }),
    }));
    const result = await finalizeBridgePair({
      serverUrl: 'http://127.0.0.1:1',
      bearer: 'b',
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'pair_completion_persist_failed',
    });
    if (!result.ok) {
      expect(result.detail).toContain('token-store wrap');
    }
    expect((await localStore.inspect()).webclient_token).toBeNull();
  });

  it('HIGH #2 ratchet — a localStore.set failure on webclient_token leaves the strict discriminant FALSE', async () => {
    // The bridge's `paired` boot discriminant gates on three fields:
    // server_url + server_public_key + webclient_token all non-null.
    // The write order is pair_metadata → cert_pin_state → server_url
    // → server_public_key → webclient_token, so a failure on the
    // FINAL token write must leave webclient_token null (NOT just an
    // older value) so the next boot stays unpaired.
    const backing = createInMemoryBridgeLocalStore();
    let failOnTokenWrite = true;
    const wrappingStore: BridgeLocalStore = {
      get: backing.get,
      set: async (key, value) => {
        if (failOnTokenWrite && key === 'webclient_token') {
          throw new Error('chrome.storage write failed');
        }
        return backing.set(key, value as never);
      },
      remove: backing.remove,
      inspect: backing.inspect,
      clear: backing.clear,
    };
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: buildPassportProjection({ server_public_key: 'P' }),
    }));
    const result = await finalizeBridgePair({
      serverUrl: 'http://127.0.0.1:1',
      bearer: 'b',
      localStore: wrappingStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'pair_completion_persist_failed',
    });
    const inspected = await backing.inspect();
    // The three strict fields except webclient_token DID land — but
    // since webclient_token is null, the boot's paired discriminant
    // rejects. The user retries cleanly + the partial fields get
    // overwritten on the next attempt.
    expect(inspected.server_url).toBe('ws://127.0.0.1:1/ws');
    expect(inspected.server_public_key).toBe('P');
    expect(inspected.pair_metadata).not.toBeNull();
    expect(inspected.webclient_token).toBeNull();
    // Verify the boot's strict discriminant evaluation matches what
    // the boot path itself would compute.
    const paired =
      inspected.server_url !== null &&
      inspected.server_public_key !== null &&
      inspected.webclient_token !== null;
    expect(paired).toBe(false);
    // The other 4 writes are fine — re-enable token write + verify
    // the same orchestrator succeeds on retry.
    failOnTokenWrite = false;
    const retry = await finalizeBridgePair({
      serverUrl: 'http://127.0.0.1:1',
      bearer: 'b',
      localStore: wrappingStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });
    expect(retry.ok).toBe(true);
  });

  it('HIGH #7 ratchet — rejects re-pair attempts WITHOUT calling the invoker or touching writes', async () => {
    const localStore = createInMemoryBridgeLocalStore();
    // Seed an existing webclient_token so the entrance guard rejects.
    const existingToken: WebclientTokenRecord = {
      token_id: 'previous-token-id',
      ciphertext_b64: 'previous-ciphertext',
      iv_b64: 'aXY=',
      issued_at: FIXED_NOW - 1_000_000,
    };
    await localStore.set('webclient_token', existingToken);
    const { store: tokenStore, calls } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: buildPassportProjection({ server_public_key: 'X' }),
    }));
    const result = await finalizeBridgePair({
      serverUrl: 'http://127.0.0.1:1',
      bearer: 'new-bearer',
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'pair_completion_already_paired',
    });
    expect(invokePassportFetch).not.toHaveBeenCalled();
    expect(calls.wrap).toHaveLength(0);
    // Existing token is preserved untouched.
    expect((await localStore.inspect()).webclient_token).toEqual(existingToken);
  });

  it('a retry of the SAME pairing that already finished answers ok and writes nothing', async () => {
    // The first handoff finished but its answer never reached the pair form
    // (the worker stopped first, or Chrome dropped the reply), so "Finish
    // pairing" sends the same server reply again — the pair host's DD#6.
    const localStore = createInMemoryBridgeLocalStore();
    const { store: tokenStore, calls } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => {
      throw new Error('passport.fetch should not run');
    });
    const attempt = {
      serverUrl: 'https://review.example',
      bearer: 'server-bearer-once',
      token_id: 'server-token-id',
      passport: buildPassportProjection({ server_public_key: 'PUBKEY_FROM_PAIR' }),
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    };
    expect((await finalizeBridgePair(attempt)).ok).toBe(true);
    const afterFirst = await localStore.inspect();

    const retry = await finalizeBridgePair(attempt);
    expect(retry).toEqual({
      ok: true,
      server_url: 'wss://review.example/ws',
      token_id: 'server-token-id',
    });
    // Answered from what is stored: no second wrap, so no second write pass.
    expect(calls.wrap).toHaveLength(1);
    expect(await localStore.inspect()).toEqual(afterFirst);
  });

  it('a DIFFERENT server-issued pairing still gets already_paired', async () => {
    const localStore = createInMemoryBridgeLocalStore();
    await localStore.set('server_url', 'wss://review.example/ws');
    const existingToken: WebclientTokenRecord = {
      token_id: 'earlier-token-id',
      ciphertext_b64: 'earlier-ciphertext',
      iv_b64: 'aXY=',
      issued_at: FIXED_NOW - 1_000_000,
    };
    await localStore.set('webclient_token', existingToken);
    const { store: tokenStore, calls } = buildFakeTokenStore();
    const result = await finalizeBridgePair({
      serverUrl: 'https://review.example',
      bearer: 'new-bearer',
      token_id: 'new-token-id',
      passport: buildPassportProjection({ server_public_key: 'X' }),
      localStore,
      tokenStore,
      invokePassportFetch: vi.fn(),
      ...seamOptions(),
    });
    expect(result).toMatchObject({ ok: false, error: 'pair_completion_already_paired' });
    expect(calls.wrap).toHaveLength(0);
    expect((await localStore.inspect()).webclient_token).toEqual(existingToken);
  });

  it('HIGH #8 ratchet — localStore.get failure surfaces as pair_completion_persist_failed (NOT already_paired)', async () => {
    const backing = createInMemoryBridgeLocalStore();
    const failingGet: BridgeLocalStore = {
      get: async () => {
        throw new Error('storage IO error');
      },
      set: backing.set,
      remove: backing.remove,
      inspect: backing.inspect,
      clear: backing.clear,
    };
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({ passport: {} }));
    const result = await finalizeBridgePair({
      serverUrl: 'http://127.0.0.1:1',
      bearer: 'b',
      localStore: failingGet,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'pair_completion_persist_failed',
    });
    if (!result.ok) {
      expect(result.detail).toContain('local-store read');
    }
    expect(invokePassportFetch).not.toHaveBeenCalled();
  });

  it('returns pair_completion_persist_failed when a mid-sequence set rejects', async () => {
    const backing = createInMemoryBridgeLocalStore();
    const failOnMetadata: BridgeLocalStore = {
      get: backing.get,
      set: async (key, value) => {
        if (key === 'pair_metadata') {
          throw new Error('storage write blocked');
        }
        return backing.set(key, value as never);
      },
      remove: backing.remove,
      inspect: backing.inspect,
      clear: backing.clear,
    };
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: buildPassportProjection({ server_public_key: 'P' }),
    }));
    const result = await finalizeBridgePair({
      serverUrl: 'http://127.0.0.1:1',
      bearer: 'b',
      localStore: failOnMetadata,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'pair_completion_persist_failed',
    });
    // pair_metadata is the FIRST write — none of the strict fields
    // got set, so the boot discriminant rejects cleanly.
    const inspected = await backing.inspect();
    expect(inspected.server_url).toBeNull();
    expect(inspected.server_public_key).toBeNull();
    expect(inspected.webclient_token).toBeNull();
  });

  it('records the instance id sent to /auth/pair in pair_metadata, as the webclient does', async () => {
    const localStore = createInMemoryBridgeLocalStore();
    const { store: tokenStore } = buildFakeTokenStore();
    const result = await finalizeBridgePair({
      serverUrl: 'https://review.example',
      bearer: 'b',
      token_id: 'tok-1',
      passport: buildPassportProjection({ server_public_key: 'P', current_handle: '' }),
      instanceId: 'inst-1',
      localStore,
      tokenStore,
      invokePassportFetch: async () => {
        throw new Error('inline passport — never fetched');
      },
      ...seamOptions(),
    });
    expect(result.ok).toBe(true);
    expect((await localStore.inspect()).pair_metadata).toEqual<WebclientPairMetadata>({
      paired_at: FIXED_NOW,
      server_passport_fingerprint: 'P',
      server_handle_at_pair: '',
      instance_id: 'inst-1',
    });
  });

  it('threads now + mintTokenId seams into the persisted pair_metadata.paired_at', async () => {
    const localStore = createInMemoryBridgeLocalStore();
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: buildPassportProjection({ server_public_key: 'P' }),
    }));
    const result = await finalizeBridgePair({
      serverUrl: 'http://127.0.0.1:1',
      bearer: 'b',
      localStore,
      tokenStore,
      invokePassportFetch,
      now: () => 999_999,
      mintTokenId: () => 'custom-id',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token_id).toBe('custom-id');
    expect((await localStore.inspect()).pair_metadata?.paired_at).toBe(999_999);
  });

  it('STORES the normalised WS server_url (NOT the user-typed HTTP form)', async () => {
    // ⚠ THIS USED TO ASSERT THE AAD, and the AAD no longer binds the address —
    // v2 dropped it so a server that moves stays unwrappable. The invariant the
    // test was really protecting survives and is worth keeping: what gets
    // PERSISTED is the canonical `wss://…/ws` form, not the `https://…` the
    // user typed, because the WS dial reads that field directly.
    const localStore = createInMemoryBridgeLocalStore();
    const { store: tokenStore, calls } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: buildPassportProjection({ server_public_key: 'PUBKEY' }),
    }));
    await finalizeBridgePair({
      serverUrl: 'https://server.example:3001',
      bearer: 'b',
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });
    expect(await localStore.get('server_url')).toBe('wss://server.example:3001/ws');
    // …and the AAD deliberately carries no address at all.
    expect(calls.wrap[0]!.aad).not.toHaveProperty('server_url');
  });

  it('error copy taxonomy covers every documented error code', () => {
    const codes: BridgePairCompletionErrorCode[] = [
      'pair_completion_passport_failed',
      'pair_completion_persist_failed',
      'pair_completion_server_response_invalid',
      'pair_completion_invalid_server_url',
      'pair_completion_already_paired',
    ];
    for (const code of codes) {
      expect(BRIDGE_PAIR_COMPLETION_ERROR_COPY[code]).toBeTypeOf('string');
      expect(BRIDGE_PAIR_COMPLETION_ERROR_COPY[code].length).toBeGreaterThan(0);
    }
  });

  it('no retryable reason tells the user to reload, retry, or look at the code', () => {
    // The pair host follows these with "Select Finish pairing to try again",
    // and its retry reuses the server's reply. "Reload and try again" was the
    // advice that sent a spent code back to the server (2026-10-09).
    const retryable = (
      Object.keys(BRIDGE_PAIR_COMPLETION_ERROR_COPY) as BridgePairCompletionErrorCode[]
    ).filter((code) => !BRIDGE_PAIR_COMPLETION_FINAL_ERRORS.has(code));
    expect(retryable.length).toBe(3);
    for (const code of retryable) {
      expect(BRIDGE_PAIR_COMPLETION_ERROR_COPY[code]).not.toMatch(/reload|try again|code/i);
    }
  });
});

// ════════════════════════════════════════════════════════════════
// createBridgePairPassportInvoker — one-shot WS over WsTransportFactory
// ════════════════════════════════════════════════════════════════

interface FakeTransportHandle {
  transport: WsTransport;
  fireMessage(payload: string): void;
  fireClose(info: { code: number; reason: string }): void;
  fireError(err: Error): void;
  sentPayloads: string[];
  closed: boolean;
}

const buildFakeTransport = (): FakeTransportHandle => {
  const messageListeners: Array<(payload: string) => void> = [];
  const closeListeners: Array<(info: { code: number; reason: string }) => void> = [];
  const errorListeners: Array<(err: Error) => void> = [];
  const sentPayloads: string[] = [];
  let closed = false;
  const transport: WsTransport = {
    send(payload) {
      sentPayloads.push(payload);
    },
    close() {
      closed = true;
    },
    onMessage(handler) {
      messageListeners.push(handler);
      return () => {
        const i = messageListeners.indexOf(handler);
        if (i >= 0) messageListeners.splice(i, 1);
      };
    },
    onClose(handler) {
      closeListeners.push(handler);
      return () => {
        const i = closeListeners.indexOf(handler);
        if (i >= 0) closeListeners.splice(i, 1);
      };
    },
    onError(handler) {
      errorListeners.push(handler);
      return () => {
        const i = errorListeners.indexOf(handler);
        if (i >= 0) errorListeners.splice(i, 1);
      };
    },
  };
  return {
    transport,
    fireMessage(payload) {
      for (const h of [...messageListeners]) h(payload);
    },
    fireClose(info) {
      for (const h of [...closeListeners]) h(info);
    },
    fireError(err) {
      for (const h of [...errorListeners]) h(err);
    },
    get sentPayloads() {
      return sentPayloads;
    },
    get closed() {
      return closed;
    },
  };
};

const buildOpeningFactory = (handle: FakeTransportHandle): WsTransportFactory => ({
  async open() {
    return handle.transport;
  },
});

/** Drain the microtask queue enough times that the invoker's
 *  Promise.race + attached listeners are fully wired before we fire
 *  messages at the fake transport. The chain is:
 *    factory.open (1) → .then(open) (2) → race resolve (3) → invoker
 *    body continuation (4) → onMessage/onClose/onError attach (5).
 *  `await new Promise(resolve => setTimeout(resolve, 0))` drains the
 *  full queue + lets any setTimeout(0) microtasks fire. */
const drainMicrotasks = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('createBridgePairPassportInvoker', () => {
  it('happy path — opens, sends rpc envelope with mint id, resolves on matching rpc_result', async () => {
    const handle = buildFakeTransport();
    const invoker = createBridgePairPassportInvoker({
      wsTransportFactory: buildOpeningFactory(handle),
      randomId: () => 'req-1',
    });
    const promise = invoker({ server_url: 'ws://x:1/ws', bearer: 'b' });
    // Wait a microtask so transport.open resolves + the listener is
    // attached before we fire the reply.
    await drainMicrotasks();
    handle.fireMessage(
      JSON.stringify({
        type: 'rpc_result',
        request_id: 'req-1',
        result: { passport: { identity: { server_public_key: 'P' } } },
      }),
    );
    const reply = await promise;
    expect(reply).toEqual({
      passport: { identity: { server_public_key: 'P' } },
    });
    // Sent envelope check.
    expect(handle.sentPayloads).toHaveLength(1);
    expect(JSON.parse(handle.sentPayloads[0]!)).toEqual({
      type: 'rpc',
      request_id: 'req-1',
      method: 'passport.fetch',
      args: {},
    });
    // Transport closed in finally.
    expect(handle.closed).toBe(true);
  });

  it('typed rpc error → BridgePairPassportRpcError', async () => {
    const handle = buildFakeTransport();
    const invoker = createBridgePairPassportInvoker({
      wsTransportFactory: buildOpeningFactory(handle),
      randomId: () => 'req-err',
    });
    const promise = invoker({ server_url: 'ws://x:1/ws', bearer: 'b' });
    await drainMicrotasks();
    handle.fireMessage(
      JSON.stringify({
        type: 'rpc_result',
        request_id: 'req-err',
        error: {
          code: 'not_configured',
          message: 'passport block provider missing',
          status: 503,
        },
      }),
    );
    await expect(promise).rejects.toBeInstanceOf(BridgePairPassportRpcError);
    await expect(promise).rejects.toMatchObject({
      code: 'not_configured',
      message: 'passport block provider missing',
      status: 503,
    });
  });

  it('rejects when result and error are both undefined', async () => {
    const handle = buildFakeTransport();
    const invoker = createBridgePairPassportInvoker({
      wsTransportFactory: buildOpeningFactory(handle),
      randomId: () => 'req-empty',
    });
    const promise = invoker({ server_url: 'ws://x:1/ws', bearer: 'b' });
    await drainMicrotasks();
    handle.fireMessage(
      JSON.stringify({ type: 'rpc_result', request_id: 'req-empty' }),
    );
    await expect(promise).rejects.toThrowError(/neither result nor error/);
  });

  it('ignores rpc_result frames whose request_id does not match', async () => {
    const handle = buildFakeTransport();
    const invoker = createBridgePairPassportInvoker({
      wsTransportFactory: buildOpeningFactory(handle),
      randomId: () => 'req-mine',
      timeout_ms: 60_000,
    });
    const promise = invoker({ server_url: 'ws://x:1/ws', bearer: 'b' });
    await drainMicrotasks();
    handle.fireMessage(
      JSON.stringify({
        type: 'rpc_result',
        request_id: 'req-other',
        result: { passport: {} },
      }),
    );
    // Should still be waiting; the matching id arrives later.
    handle.fireMessage(
      JSON.stringify({
        type: 'rpc_result',
        request_id: 'req-mine',
        result: { passport: { identity: { server_public_key: 'P' } } },
      }),
    );
    const reply = await promise;
    expect(reply).toEqual({
      passport: { identity: { server_public_key: 'P' } },
    });
  });

  it('ignores non-JSON inbound payloads', async () => {
    const handle = buildFakeTransport();
    const invoker = createBridgePairPassportInvoker({
      wsTransportFactory: buildOpeningFactory(handle),
      randomId: () => 'r1',
    });
    const promise = invoker({ server_url: 'ws://x:1/ws', bearer: 'b' });
    await drainMicrotasks();
    handle.fireMessage('not json {');
    // Still waiting — fire a valid reply now.
    handle.fireMessage(
      JSON.stringify({
        type: 'rpc_result',
        request_id: 'r1',
        result: { passport: {} },
      }),
    );
    await expect(promise).resolves.toEqual({ passport: {} });
  });

  it('MEDIUM #9 ratchet — post-open transport close rejects with WebSocket-closed error', async () => {
    const handle = buildFakeTransport();
    const invoker = createBridgePairPassportInvoker({
      wsTransportFactory: buildOpeningFactory(handle),
      randomId: () => 'r-close',
    });
    const promise = invoker({ server_url: 'ws://x:1/ws', bearer: 'b' });
    await drainMicrotasks();
    handle.fireClose({ code: 1006, reason: 'abnormal' });
    await expect(promise).rejects.toThrowError(
      /WebSocket closed before rpc_result/,
    );
  });

  it('MEDIUM #9 ratchet — post-open transport error rejects with WebSocket-error error', async () => {
    const handle = buildFakeTransport();
    const invoker = createBridgePairPassportInvoker({
      wsTransportFactory: buildOpeningFactory(handle),
      randomId: () => 'r-err',
    });
    const promise = invoker({ server_url: 'ws://x:1/ws', bearer: 'b' });
    await drainMicrotasks();
    handle.fireError(new Error('network drop'));
    await expect(promise).rejects.toThrowError(
      /WebSocket error before rpc_result.*network drop/,
    );
  });

  it('HIGH #1 ratchet — timer covers the handshake; a stalled wsTransportFactory.open times out', async () => {
    // Factory whose `open()` never resolves — simulates a stalled
    // TLS handshake. Without the HIGH #1 fold the invoker would wait
    // forever (timer was previously started AFTER open resolved); the
    // fold's race-armed structure rejects via the timer in ~1ms here.
    vi.useFakeTimers();
    const stalledFactory: WsTransportFactory = {
      open() {
        return new Promise<WsTransport>(() => {
          /* never resolves */
        });
      },
    };
    const invoker = createBridgePairPassportInvoker({
      wsTransportFactory: stalledFactory,
      randomId: () => 'r-stall',
      timeout_ms: 100,
    });
    const promise = invoker({ server_url: 'ws://x:1/ws', bearer: 'b' });
    // Track rejection without leaking unhandled-rejection noise while
    // the fake timer hasn't advanced yet.
    const rejection = expect(promise).rejects.toThrowError(
      /server did not respond within 100ms/,
    );
    await vi.advanceTimersByTimeAsync(150);
    await rejection;
    vi.useRealTimers();
  });

  it('default timeout matches BRIDGE_PAIR_PASSPORT_INVOKER_DEFAULT_TIMEOUT_MS (30s)', () => {
    expect(BRIDGE_PAIR_PASSPORT_INVOKER_DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  it('detaches listeners + closes transport in the finally block after success', async () => {
    const handle = buildFakeTransport();
    const invoker = createBridgePairPassportInvoker({
      wsTransportFactory: buildOpeningFactory(handle),
      randomId: () => 'r-final',
    });
    const promise = invoker({ server_url: 'ws://x:1/ws', bearer: 'b' });
    await drainMicrotasks();
    handle.fireMessage(
      JSON.stringify({
        type: 'rpc_result',
        request_id: 'r-final',
        result: { passport: {} },
      }),
    );
    await promise;
    expect(handle.closed).toBe(true);
    // Post-finally events should not throw (listeners detached).
    expect(() => handle.fireMessage('{}')).not.toThrow();
    expect(() => handle.fireClose({ code: 1000, reason: '' })).not.toThrow();
    expect(() => handle.fireError(new Error('late'))).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════
// SW bootstrap — the side panel's pairing session + single-flight guard
// ════════════════════════════════════════════════════════════════

const buildInMemoryChromeStorage = (
  seed: Record<string, unknown> = {},
): ChromeStorageLocal => {
  const data = { ...seed };
  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in data) out[k] = data[k];
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data[k] = v;
    },
    async remove(keys) {
      for (const k of keys) delete data[k];
    },
    async clear() {
      for (const k of Object.keys(data)) delete data[k];
    },
  };
};

const buildCapturedSwLifecycle = (): BridgeSwLifecycle => ({
  onInstall: () => undefined,
  onActivate: () => undefined,
  async skipWaiting() {
    /* no-op */
  },
  async claim() {
    /* no-op */
  },
});

interface CapturedOnMessage extends ChromeRuntimeOnMessageApi {
  handlers: Array<
    (
      message: unknown,
      sender: unknown,
      sendResponse: (response: unknown) => void,
    ) => boolean | undefined
  >;
  /** Synchronous dispatch helper. Returns the response captured via
   *  `sendResponse` (the SW handler is fully async so callers `await`
   *  the response Promise). */
  dispatch(message: unknown): Promise<unknown>;
}

const buildCapturedOnMessage = (): CapturedOnMessage => {
  const handlers: CapturedOnMessage['handlers'] = [];
  const api: CapturedOnMessage = {
    handlers,
    addListener(handler) {
      handlers.push(handler);
    },
    dispatch(message) {
      return new Promise((resolve) => {
        for (const h of handlers) {
          const ret = h(message, {}, (response) => resolve(response));
          if (ret === true) return; // async path; resolve via sendResponse
        }
        // No handler claimed the message — resolve undefined.
        resolve(undefined);
      });
    },
  };
  return api;
};

const stubExecutor: BridgeActionExecutor = {
  async execute(_req: ActionExecutorRequest): Promise<ActionExecutorOutcome> {
    return { status: 'ok', outputs: { result: 'stub' } };
  },
};

const buildStubTransportFactory = (): WsTransportFactory => ({
  async open(): Promise<WsTransport> {
    return {
      send: () => undefined,
      close: () => undefined,
      onMessage() {
        return () => undefined;
      },
      onClose() {
        return () => undefined;
      },
      onError() {
        return () => undefined;
      },
    };
  },
});

const stubTokenStore: WebclientTokenStore = {
  async wrap({ token_id, bearer, aad }) {
    return {
      token_id,
      // ⚠ Keyed on what the AAD actually binds now: the server KEY, not the
      // address. v2 dropped the address so a moved server stays unwrappable.
      ciphertext_b64: `wrap(${bearer}:${aad.server_public_key})`,
      iv_b64: 'aXY=',
      issued_at: FIXED_NOW,
    };
  },
  async unwrap(record) {
    const m = /^wrap\((.*?):.*\)$/.exec(record.ciphertext_b64);
    return m ? m[1]! : '';
  },
};

const baseDeps = (
  overrides: Partial<BridgeServiceWorkerDeps>,
): BridgeServiceWorkerDeps => ({
  chromeStorage: buildInMemoryChromeStorage(),
  chromeRuntimeOnMessage: buildCapturedOnMessage(),
  swLifecycle: buildCapturedSwLifecycle(),
  wsTransportFactory: buildStubTransportFactory(),
  tokenStore: stubTokenStore,
  bridgeVersion: 'test',
  defaultNotificationIconUrl: 'icons/logo.svg',
  actionExecutor: stubExecutor,
  ...overrides,
});

/** `/auth/pair` behind the worker's fetch: the code works ONCE, as on the
 *  real server. `reply` is what an accepting answer carries. */
const buildPairServer = (reply: Record<string, unknown>) => {
  const posts: Array<Record<string, unknown>> = [];
  let spent = false;
  let gate: Promise<void> | null = null;
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    posts.push(body);
    const accept = !spent && body.code === 'ABC12345';
    if (accept) spent = true;
    if (gate) await gate;
    return {
      ok: accept,
      status: accept ? 200 : 401,
      json: async () =>
        accept ? reply : { error: { code: 'invalid_code', message: 'Invalid, expired, or already-used pairing code' } },
    } as unknown as Response;
  });
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    posts,
    /** Holds every answer until the returned release is called. */
    hold(): () => void {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
  };
};

const buildSessionArea = () => {
  const data: Record<string, unknown> = {};
  return {
    data,
    area: {
      async get(keys: string[]) {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in data) out[k] = data[k];
        return out;
      },
      async set(items: Record<string, unknown>) {
        for (const [k, v] of Object.entries(items)) data[k] = JSON.parse(JSON.stringify(v));
      },
      async remove(keys: string[]) {
        for (const k of keys) delete data[k];
      },
    },
  };
};

const REPLY_INLINE = {
  token: 'bearer-1',
  token_id: 'tok-id-1',
  bearer: 'bearer-1',
  passport: buildPassportProjection({ server_public_key: 'P', current_handle: '' }),
};
const REPLY_LEGACY = { token: 'bearer-1', token_id: 'tok-id-1', bearer: 'bearer-1' };

const pairOp = (op: 'status' | 'wait' | 'finish' | 'abandon') => ({ type: BRIDGE_PAIR_MESSAGE_TYPE, op });
const startOp = (input: Record<string, unknown> = {}) => ({
  type: BRIDGE_PAIR_MESSAGE_TYPE,
  op: 'start',
  input: { serverUrl: 'https://review.example', code: 'ABC12345', ...input },
});

const bootForPairing = async (overrides: Partial<BridgeServiceWorkerDeps> = {}) => {
  const onMessage = buildCapturedOnMessage();
  const storage = buildInMemoryChromeStorage();
  const session = buildSessionArea();
  const reload = vi.fn();
  // Every socket the worker opens, with the bearer it opens it with.
  const opens: Array<{ url: string; auth_bearer: string }> = [];
  const stub = buildStubTransportFactory();
  const boot = await bootBridgeServiceWorker(
    baseDeps({
      chromeRuntimeOnMessage: onMessage,
      chromeStorage: storage,
      chromeStorageSession: session.area,
      chromeRuntimeReload: reload,
      wsTransportFactory: {
        open: (opts) => {
          opens.push({ ...opts });
          return stub.open(opts);
        },
      },
      pairMintInstanceId: () => 'inst-1',
      now: () => FIXED_NOW,
      ...overrides,
    }),
  );
  return { onMessage, storage, session, reload, boot, opens };
};

describe('bootBridgeServiceWorker — the side panel’s pairing session (recued.bridge.pair)', () => {
  it('start pairs end to end, then connects from this worker without a restart', async () => {
    const server = buildPairServer(REPLY_INLINE);
    const t = await bootForPairing({ fetch: server.fetch });
    expect(await t.onMessage.dispatch(pairOp('status'))).toEqual({ state: 'unpaired' });

    const outcome = await t.onMessage.dispatch(startOp({ displayName: 'Chrome on Windows' }));
    expect(outcome).toEqual({ ok: true, serverUrl: 'https://review.example' });
    expect(server.posts).toEqual([
      {
        code: 'ABC12345',
        instanceId: 'inst-1',
        displayName: 'Chrome on Windows',
        clientKind: 'bridge',
      },
    ]);

    const local = await t.storage.get([
      'server_url',
      'server_public_key',
      'webclient_token',
      'pair_metadata',
    ]);
    expect(local.server_url).toBe('wss://review.example/ws');
    expect(local.server_public_key).toBe('P');
    expect((local.webclient_token as WebclientTokenRecord).token_id).toBe('tok-id-1');
    // The same id the server stamped on the token, as the webclient records it.
    expect((local.pair_metadata as WebclientPairMetadata).instance_id).toBe('inst-1');
    expect(t.session.data).toEqual({});
    // Paired in place: the runtime was started before the answer went back,
    // and connects with the bearer finalize stored. Nothing reloads the
    // extension, which would close the side panel the user paired from.
    expect(t.boot.paired).toBe(true);
    expect(t.boot.wsClient).not.toBeNull();
    await vi.waitFor(() => expect(t.opens).toHaveLength(1));
    expect(t.opens[0]).toEqual({ url: 'wss://review.example/ws', auth_bearer: 'tok-id-1.bearer-1' });
    expect(t.reload).not.toHaveBeenCalled();
    expect(await t.onMessage.dispatch(pairOp('status'))).toEqual({
      state: 'paired',
      serverUrl: 'wss://review.example/ws',
    });
    await t.boot.stop();
  });

  it('a runtime that will not start in place reloads the extension instead', async () => {
    const server = buildPairServer(REPLY_INLINE);
    // Storage that loses the bearer the moment finalize writes it: the
    // stored pair is incomplete when the worker goes to start its runtime.
    const storage = buildInMemoryChromeStorage();
    const forgetful: ChromeStorageLocal = {
      ...storage,
      async set(items) {
        const { webclient_token: _dropped, ...rest } = items as Record<string, unknown>;
        await storage.set(rest);
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const t = await bootForPairing({ fetch: server.fetch, chromeStorage: forgetful });
      await t.onMessage.dispatch(startOp());
      expect(t.boot.paired).toBe(false);
      expect(t.reload).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a bridge that boots paired starts its runtime once; a later start does not restart it', async () => {
    const server = buildPairServer(REPLY_INLINE);
    const first = await bootForPairing({ fetch: server.fetch });
    await first.onMessage.dispatch(startOp());
    await vi.waitFor(() => expect(first.opens).toHaveLength(1));
    await first.boot.stop();

    // The next worker start reads the stored pair at boot.
    const opens: Array<{ url: string; auth_bearer: string }> = [];
    const stub = buildStubTransportFactory();
    const onMessage = buildCapturedOnMessage();
    const boot = await bootBridgeServiceWorker(
      baseDeps({
        chromeRuntimeOnMessage: onMessage,
        chromeStorage: first.storage,
        wsTransportFactory: {
          open: (opts) => {
            opens.push({ ...opts });
            return stub.open(opts);
          },
        },
      }),
    );
    expect(boot.paired).toBe(true);
    await vi.waitFor(() => expect(opens).toHaveLength(1));
    expect(await onMessage.dispatch(startOp({ code: 'NEXT0000' }))).toEqual({
      ok: false,
      kind: 'paired',
      serverUrl: 'wss://review.example/ws',
    });
    expect(opens).toHaveLength(1);
    await boot.stop();
  });

  it('a server without the inline passport is asked over passport.fetch with the structured bearer', async () => {
    const server = buildPairServer(REPLY_LEGACY);
    const passportInvoker = vi.fn<BridgePairPassportInvoker>(async () => ({
      passport: buildPassportProjection({ server_public_key: 'P' }),
    }));
    const t = await bootForPairing({ fetch: server.fetch, pairPassportInvoker: passportInvoker });
    expect((await t.onMessage.dispatch(startOp())) as { ok: boolean }).toMatchObject({ ok: true });
    expect(passportInvoker).toHaveBeenCalledWith({
      server_url: 'wss://review.example/ws',
      bearer: 'tok-id-1.bearer-1',
    });
  });

  it('start on a paired bridge posts nothing', async () => {
    const server = buildPairServer(REPLY_INLINE);
    const t = await bootForPairing({ fetch: server.fetch });
    await t.onMessage.dispatch(startOp());
    const again = await t.onMessage.dispatch(startOp({ code: 'NEXT0000' }));
    expect(again).toEqual({ ok: false, kind: 'paired', serverUrl: 'wss://review.example/ws' });
    expect(server.posts).toHaveLength(1);
  });

  it('HIGH #11 ratchet — a second start while one runs is busy and posts nothing', async () => {
    const server = buildPairServer(REPLY_INLINE);
    const release = server.hold();
    const t = await bootForPairing({ fetch: server.fetch });
    const first = t.onMessage.dispatch(startOp());
    const second = await t.onMessage.dispatch(startOp());
    expect(second).toEqual({ ok: false, kind: 'busy', serverUrl: 'https://review.example' });
    expect(await t.onMessage.dispatch(pairOp('status'))).toEqual({
      state: 'pairing',
      serverUrl: 'https://review.example',
    });
    release();
    expect(await first).toEqual({ ok: true, serverUrl: 'https://review.example' });
    expect(server.posts).toHaveLength(1);
  });

  it('wait hands a reopened panel the outcome of the attempt under way', async () => {
    const server = buildPairServer(REPLY_INLINE);
    const release = server.hold();
    const t = await bootForPairing({ fetch: server.fetch });
    const first = t.onMessage.dispatch(startOp());
    await vi.waitFor(() => expect(server.posts).toHaveLength(1));
    const waited = t.onMessage.dispatch(pairOp('wait'));
    release();
    expect(await waited).toEqual({ ok: true, serverUrl: 'https://review.example' });
    await first;
    expect(await t.onMessage.dispatch(pairOp('wait'))).toBeNull();
  });

  it('a failed setup keeps the reply in session storage; finish completes it without posting', async () => {
    const server = buildPairServer(REPLY_LEGACY);
    let calls = 0;
    const passportInvoker = vi.fn<BridgePairPassportInvoker>(async () => {
      calls += 1;
      if (calls === 1) throw new Error('WebSocket closed before passport.fetch answered');
      return { passport: buildPassportProjection({ server_public_key: 'P' }) };
    });
    const t = await bootForPairing({ fetch: server.fetch, pairPassportInvoker: passportInvoker });

    const first = await t.onMessage.dispatch(startOp());
    expect(first).toEqual({
      ok: false,
      kind: 'accepted',
      serverUrl: 'https://review.example',
      reason: 'pair_completion_passport_failed',
      detail: 'WebSocket closed before passport.fetch answered',
    });
    expect(Object.keys(t.session.data)).toEqual([BRIDGE_PENDING_PAIR_SESSION_KEY]);
    expect(await t.onMessage.dispatch(pairOp('status'))).toEqual({
      state: 'accepted',
      serverUrl: 'https://review.example',
    });

    expect(await t.onMessage.dispatch(pairOp('finish'))).toEqual({
      ok: true,
      serverUrl: 'https://review.example',
    });
    expect(server.posts).toHaveLength(1);
    expect(t.session.data).toEqual({});
  });

  it('a worker that restarted finishes from session storage', async () => {
    const server = buildPairServer(REPLY_LEGACY);
    const t = await bootForPairing({
      fetch: server.fetch,
      pairPassportInvoker: async () => {
        throw new Error('timed out');
      },
    });
    await t.onMessage.dispatch(startOp());

    // Chrome stopped the idle worker; a new one boots over the same storage.
    const onMessage = buildCapturedOnMessage();
    await bootBridgeServiceWorker(
      baseDeps({
        chromeRuntimeOnMessage: onMessage,
        chromeStorage: t.storage,
        chromeStorageSession: t.session.area,
        fetch: server.fetch,
        pairPassportInvoker: async () => ({
          passport: buildPassportProjection({ server_public_key: 'P' }),
        }),
        now: () => FIXED_NOW,
      }),
    );
    expect(await onMessage.dispatch(pairOp('status'))).toEqual({
      state: 'accepted',
      serverUrl: 'https://review.example',
    });
    expect(await onMessage.dispatch(pairOp('finish'))).toEqual({
      ok: true,
      serverUrl: 'https://review.example',
    });
    expect(server.posts).toHaveLength(1);
    const local = await t.storage.get(['pair_metadata']);
    expect((local.pair_metadata as WebclientPairMetadata).instance_id).toBe('inst-1');
  });

  it('a finish of a pairing whose first finalize landed is answered ok, not already_paired', async () => {
    const server = buildPairServer(REPLY_INLINE);
    const t = await bootForPairing({ fetch: server.fetch });
    await t.onMessage.dispatch(startOp());
    // The worker stopped before dropping the held reply.
    await t.session.area.set({
      [BRIDGE_PENDING_PAIR_SESSION_KEY]: {
        serverUrl: 'https://review.example',
        token: 'bearer-1',
        token_id: 'tok-id-1',
        passport: REPLY_INLINE.passport,
      },
    });
    expect(await t.onMessage.dispatch(pairOp('finish'))).toEqual({
      ok: true,
      serverUrl: 'https://review.example',
    });
  });

  it('HIGH #8 ratchet — a finalize that throws is a failed setup with a structured answer', async () => {
    const server = buildPairServer({ token: 'legacy-bearer', passport: REPLY_INLINE.passport });
    const t = await bootForPairing({
      fetch: server.fetch,
      pairCompletionMintTokenId: () => {
        throw new Error('mint blew up');
      },
    });
    expect(await t.onMessage.dispatch(startOp())).toMatchObject({
      ok: false,
      kind: 'accepted',
      reason: 'pair_completion_persist_failed',
      detail: 'finalize crashed: mint blew up',
    });
  });

  it('abandon drops the held reply', async () => {
    const server = buildPairServer(REPLY_LEGACY);
    const t = await bootForPairing({
      fetch: server.fetch,
      pairPassportInvoker: async () => {
        throw new Error('timed out');
      },
    });
    await t.onMessage.dispatch(startOp());
    expect(await t.onMessage.dispatch(pairOp('abandon'))).toEqual({ ok: true });
    expect(t.session.data).toEqual({});
    expect(await t.onMessage.dispatch(pairOp('status'))).toEqual({ state: 'unpaired' });
  });

  it('a start without a server address, and an unknown op, get error outcomes', async () => {
    const t = await bootForPairing();
    expect(
      await t.onMessage.dispatch({ type: BRIDGE_PAIR_MESSAGE_TYPE, op: 'start', input: { code: 'X' } }),
    ).toEqual({ ok: false, kind: 'error', detail: 'pair start is missing the server address' });
    expect(await t.onMessage.dispatch({ type: BRIDGE_PAIR_MESSAGE_TYPE, op: 'reset' })).toEqual({
      ok: false,
      kind: 'error',
      detail: 'unknown pair op: reset',
    });
  });

  it('coexists with the existing inspect message handler', async () => {
    const onMessage = buildCapturedOnMessage();
    await bootBridgeServiceWorker(
      baseDeps({ chromeRuntimeOnMessage: onMessage }),
    );
    const inspectResp = (await onMessage.dispatch({
      type: 'recued.bridge.inspect',
    })) as { local?: { server_url: string | null } } | undefined;
    expect(inspectResp).toBeDefined();
    expect(inspectResp?.local?.server_url).toBeNull();
  });

  it('coexists with the existing side-panel fetch-status handler', async () => {
    const onMessage = buildCapturedOnMessage();
    await bootBridgeServiceWorker(
      baseDeps({ chromeRuntimeOnMessage: onMessage }),
    );
    const resp = (await onMessage.dispatch({
      type: 'recued.bridge.side-panel.fetch-status',
    })) as { ok: false; error: string };
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('bridge_not_paired');
  });

  it('ignores unknown message types (lets Chrome drop them)', async () => {
    const onMessage = buildCapturedOnMessage();
    await bootBridgeServiceWorker(
      baseDeps({ chromeRuntimeOnMessage: onMessage }),
    );
    const resp = await onMessage.dispatch({ type: 'recued.unknown' });
    expect(resp).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// Cold-start onMessage shim — createSwMessageQueue
//
// The shim primitives previously lived inline in
// `service-worker-entry.ts` (commit bf7aab2a, 4 it.todo placeholders).
// They were extracted into `apps/bridge/src/boot/sw-message-queue.ts`
// in this follow-on so the four HIGH ratchets (#3 / #4 / #6 / #10)
// become unit-testable without chrome-stub-aware module load. The
// describe block below promotes the four todos to passing tests + adds
// the ANGLE 7 (post-rejection arrival) + ANGLE 5 (second-call
// idempotency) folds caught during the extraction's own review.
// ════════════════════════════════════════════════════════════════

type ShimMessageHandler = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

interface ShimDispatchResult {
  /** What the chrome-listener returned (`true` keeps the port open). */
  handlerReturnValues: Array<boolean | undefined>;
  /** Every value the listener handed back via `sendResponse`. */
  responses: Array<unknown>;
}

interface FakeChromeOnMessage extends ChromeRuntimeOnMessageApi {
  handlers: Array<ShimMessageHandler>;
  /** Synchronously dispatch a message through every registered handler.
   *  Captures the listener's return value(s) + every `sendResponse`
   *  call so a single test can assert both the chrome-port semantics
   *  (return `true` to keep the port open) and the structured
   *  response shape. */
  dispatch(message: unknown): ShimDispatchResult;
}

/** Multi-handler note (Codex 2026-05-28 MINOR J): real
 *  `chrome.runtime.onMessage` hands the response port exclusively to
 *  the first listener that returns `true`; subsequent listeners can
 *  observe the message but cannot claim the channel. This fake
 *  intentionally invokes every registered listener + captures every
 *  `sendResponse` call so a test can assert against multi-handler
 *  isolation paths in `dispatchToHandlers` (e.g. throwing-handler-
 *  followed-by-async-handler). The shim never registers more than one
 *  real chrome listener per factory instance, so the divergence does
 *  not mask production-relevant behavior. */
const buildFakeChromeOnMessage = (): FakeChromeOnMessage => {
  const handlers: FakeChromeOnMessage['handlers'] = [];
  return {
    handlers,
    addListener(handler) {
      handlers.push(handler);
    },
    dispatch(message) {
      const handlerReturnValues: ShimDispatchResult['handlerReturnValues'] =
        [];
      const responses: ShimDispatchResult['responses'] = [];
      for (const h of handlers) {
        const ret = h(message, {}, (response) => {
          responses.push(response);
        });
        handlerReturnValues.push(ret);
      }
      return { handlerReturnValues, responses };
    },
  };
};

describe('createSwMessageQueue — cold-start shim (extracted)', () => {
  it('HIGH #3 ratchet — queues a message that arrives before drainQueuedMessages; chrome listener returns true to keep port open', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });
    const handler = vi.fn<ShimMessageHandler>(() => true);
    handle.proxy.addListener(handler);

    const result = onMessage.dispatch({
      type: BRIDGE_PAIR_MESSAGE_TYPE,
      payload: { ok: 1 },
    });

    // Pre-drain dispatch: chrome listener returns `true` (keep port
    // open), no sendResponse fired, handler not yet invoked.
    expect(result.handlerReturnValues).toEqual([true]);
    expect(result.responses).toEqual([]);
    expect(handler).not.toHaveBeenCalled();

    // Explicit drain flushes the queue through the registered
    // handler.
    handle.proxy.drainQueuedMessages();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual({
      type: BRIDGE_PAIR_MESSAGE_TYPE,
      payload: { ok: 1 },
    });
  });

  it('HIGH #3 ratchet — multiple queued messages drain in FIFO insertion order', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });
    const seen: Array<unknown> = [];
    handle.proxy.addListener((message) => {
      seen.push(message);
      return undefined;
    });

    onMessage.dispatch({ type: 'recued.bridge.test', n: 1 });
    onMessage.dispatch({ type: 'recued.bridge.test', n: 2 });
    onMessage.dispatch({ type: 'recued.bridge.test', n: 3 });
    expect(seen).toEqual([]);

    handle.proxy.drainQueuedMessages();
    expect(seen).toEqual([
      { type: 'recued.bridge.test', n: 1 },
      { type: 'recued.bridge.test', n: 2 },
      { type: 'recued.bridge.test', n: 3 },
    ]);
  });

  it('HIGH #3 ratchet — re-entrant arrival during the drain loop is still dispatched (drain while-loop continues)', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });
    const seen: Array<unknown> = [];
    let triggeredReentry = false;
    handle.proxy.addListener((message) => {
      seen.push(message);
      // Re-entrant arrival during the first dispatch — synchronously
      // pushes a second message into the queue mid-drain. The drain's
      // `while (queue.length > 0)` must continue past it. Trigger
      // exactly once so the test doesn't recurse forever.
      if (!triggeredReentry) {
        triggeredReentry = true;
        // bootReady is true here (drain in flight), so this arrival
        // takes the post-drain inline-dispatch arm rather than being
        // re-queued. Either path is acceptable for the invariant
        // ("re-entry doesn't strand state"); the assertion below
        // captures the observable: every arrival reached the handler.
        onMessage.dispatch({ type: 'recued.bridge.test', n: 'reentered' });
      }
      return undefined;
    });

    onMessage.dispatch({ type: 'recued.bridge.test', n: 1 });
    handle.proxy.drainQueuedMessages();

    expect(seen).toEqual([
      { type: 'recued.bridge.test', n: 1 },
      { type: 'recued.bridge.test', n: 'reentered' },
    ]);
  });

  it('HIGH #4 ratchet — proxy.addListener does NOT trigger a drain; queue stays queued until explicit drainQueuedMessages', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });

    // Queue a message BEFORE registering the bootstrap's handler.
    onMessage.dispatch({ type: 'recued.bridge.side-panel.fetch-status' });

    const handler = vi.fn<ShimMessageHandler>();
    handle.proxy.addListener(handler);

    // addListener alone must NOT drain the queue — the bootstrap's
    // handler registers BEFORE the rest of its wiring completes, so a
    // drain-on-addListener would dispatch the queued message against
    // an as-yet-null `rpcConnForSidePanel`.
    expect(handler).not.toHaveBeenCalled();

    handle.proxy.drainQueuedMessages();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('HIGH #6 ratchet — explicit bootReady flag (not handler-count) gates dispatch even when a handler is already registered', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });

    // Register the handler FIRST (handlers.length === 1 now).
    const handler = vi.fn<ShimMessageHandler>();
    handle.proxy.addListener(handler);

    // Cold-start message arrives BEFORE drain. A handler-count gate
    // would dispatch immediately because handlers.length > 0; the
    // explicit bootReady gate must keep it queued.
    const result = onMessage.dispatch({ type: 'recued.bridge.test' });
    expect(handler).not.toHaveBeenCalled();
    expect(result.handlerReturnValues).toEqual([true]);

    // Drain dispatches the queued message.
    handle.proxy.drainQueuedMessages();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('HIGH #6 ratchet — post-drain arrivals dispatch synchronously through handlers (no further queuing)', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });
    const handler = vi.fn<ShimMessageHandler>(() => undefined);
    handle.proxy.addListener(handler);

    handle.proxy.drainQueuedMessages();
    // After bootReady is true, dispatch should hit the handler
    // immediately. `dispatchToHandlers` returns the OR of every
    // handler's `ret === true` flag — handler returned undefined, so
    // the chrome-listener result is `false` (no async port retained).
    const result = onMessage.dispatch({ type: 'recued.bridge.test' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.handlerReturnValues).toEqual([false]);
  });

  it('HIGH #6 ratchet — post-drain dispatch propagates `true` when a handler claims an async response', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });
    const asyncHandler = vi.fn<ShimMessageHandler>(() => true);
    handle.proxy.addListener(asyncHandler);

    handle.proxy.drainQueuedMessages();
    const result = onMessage.dispatch({ type: 'recued.bridge.test' });
    expect(asyncHandler).toHaveBeenCalledTimes(1);
    expect(result.handlerReturnValues).toEqual([true]);
  });

  it('HIGH #6 ratchet — addListener registered AFTER drainQueuedMessages still receives subsequent inline arrivals', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });

    // Drain runs before any handler is registered — empty queue, but
    // bootReady flips to true.
    handle.proxy.drainQueuedMessages();

    const handler = vi.fn<ShimMessageHandler>(() => undefined);
    handle.proxy.addListener(handler);

    // Subsequent arrival: bootReady is true → listener takes the
    // dispatch arm, not the queue arm. Handler runs inline.
    const result = onMessage.dispatch({ type: 'recued.bridge.test' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.handlerReturnValues).toEqual([false]);
  });

  it('HIGH #4 ratchet — double-drain is a no-op (second drainQueuedMessages call does not double-dispatch)', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });
    const handler = vi.fn<ShimMessageHandler>(() => undefined);
    handle.proxy.addListener(handler);

    // Queue one message, drain twice. The second drain finds an empty
    // queue → no additional dispatch.
    onMessage.dispatch({ type: 'recued.bridge.test' });
    handle.proxy.drainQueuedMessages();
    handle.proxy.drainQueuedMessages();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('addListener — multiple handlers all receive each dispatched message (no exclusive-claim semantics inside the shim)', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });
    const handlerA = vi.fn<ShimMessageHandler>(() => undefined);
    const handlerB = vi.fn<ShimMessageHandler>(() => true);
    handle.proxy.addListener(handlerA);
    handle.proxy.addListener(handlerB);

    handle.proxy.drainQueuedMessages();
    const result = onMessage.dispatch({ type: 'recued.bridge.test' });

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
    // `dispatchToHandlers` returns OR over every handler's
    // `ret === true`, so the chrome-listener result is `true` because
    // handlerB claimed an async response.
    expect(result.handlerReturnValues).toEqual([true]);
  });

  it('HIGH #10 ratchet — an empty-string type field gets the same bridge_boot_failed shape', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });

    const result = onMessage.dispatch({ type: '' });
    handle.failQueuedAfterBootRejection(new Error('boom'));

    expect(result.responses).toEqual([
      { ok: false, error: 'bridge_boot_failed', detail: 'boom' },
    ]);
  });

  it('HIGH #10 ratchet — boot rejection flushes a queued pairing with a structured bridge_boot_failed (it never reached /auth/pair)', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });

    const result = onMessage.dispatch({
      type: BRIDGE_PAIR_MESSAGE_TYPE,
      op: 'start',
      input: { serverUrl: 'http://localhost:3001', code: 'ABC12345' },
    });
    expect(result.handlerReturnValues).toEqual([true]);
    expect(result.responses).toEqual([]);

    handle.failQueuedAfterBootRejection(new Error('IDB open failed'));

    expect(result.responses).toHaveLength(1);
    expect(result.responses[0]).toEqual({
      ok: false,
      error: 'bridge_boot_failed',
      detail: 'IDB open failed',
    });
  });

  it('HIGH #10 ratchet — boot rejection flushes other queued messages with the same bridge_boot_failed', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });

    const result = onMessage.dispatch({
      type: 'recued.bridge.side-panel.fetch-status',
    });
    handle.failQueuedAfterBootRejection(new Error('boot rejected'));

    expect(result.responses).toEqual([
      { ok: false, error: 'bridge_boot_failed', detail: 'boot rejected' },
    ]);
  });

  it('HIGH #10 ratchet — non-Error rejection values stringify via String(err)', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });

    const result = onMessage.dispatch({ type: 'recued.bridge.test' });
    handle.failQueuedAfterBootRejection('plain-string-rejection');

    expect(result.responses).toEqual([
      {
        ok: false,
        error: 'bridge_boot_failed',
        detail: 'plain-string-rejection',
      },
    ]);
  });

  it('HIGH #10 ratchet — messages without a type field get the generic bridge_boot_failed shape (defensive)', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });

    const resultNullMessage = onMessage.dispatch(null);
    const resultUntyped = onMessage.dispatch({ payload: 'no type' });
    handle.failQueuedAfterBootRejection(new Error('boom'));

    expect(resultNullMessage.responses).toEqual([
      { ok: false, error: 'bridge_boot_failed', detail: 'boom' },
    ]);
    expect(resultUntyped.responses).toEqual([
      { ok: false, error: 'bridge_boot_failed', detail: 'boom' },
    ]);
  });

  it('ANGLE 7 fold — post-rejection arrivals respond synchronously with the structured failure shape (do not queue + return false)', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });

    handle.failQueuedAfterBootRejection(new Error('IDB open failed'));

    // A late-arriving pairing message must NOT be queued (queue never
    // drains again post-failure); it must respond inline with the
    // captured terminal detail.
    const lateResult = onMessage.dispatch({
      type: BRIDGE_PAIR_MESSAGE_TYPE,
      op: 'status',
    });
    expect(lateResult.handlerReturnValues).toEqual([false]);
    expect(lateResult.responses).toEqual([
      {
        ok: false,
        error: 'bridge_boot_failed',
        detail: 'IDB open failed',
      },
    ]);
  });

  it('ANGLE 7 fold — late-arriving side-panel messages also respond with the structured failure shape', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });

    handle.failQueuedAfterBootRejection(new Error('IDB open failed'));

    const lateResult = onMessage.dispatch({
      type: 'recued.bridge.side-panel.fetch-status',
    });
    expect(lateResult.handlerReturnValues).toEqual([false]);
    expect(lateResult.responses).toEqual([
      {
        ok: false,
        error: 'bridge_boot_failed',
        detail: 'IDB open failed',
      },
    ]);
  });

  it('ANGLE 5 fold — second failQueuedAfterBootRejection call is a no-op (preserves first detail for late arrivals)', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });

    handle.failQueuedAfterBootRejection(new Error('first failure'));
    handle.failQueuedAfterBootRejection(new Error('second failure'));

    // A late arrival after BOTH failure calls must surface the FIRST
    // failure's detail string. The second call must not overwrite the
    // captured terminal detail.
    const result = onMessage.dispatch({
      type: BRIDGE_PAIR_MESSAGE_TYPE,
      op: 'status',
    });
    expect(result.responses).toEqual([
      {
        ok: false,
        error: 'bridge_boot_failed',
        detail: 'first failure',
      },
    ]);
  });

  it('drainQueuedMessages — defensive no-op after boot failure (does not flip the gate or dispatch to handlers)', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });
    const handler = vi.fn<ShimMessageHandler>();
    handle.proxy.addListener(handler);

    handle.failQueuedAfterBootRejection(new Error('boom'));
    handle.proxy.drainQueuedMessages();

    // Drain after failure must not flip bootReady: late arrivals
    // should still see the failure arm + respond with the structured
    // shape rather than reaching the handler.
    const lateResult = onMessage.dispatch({ type: 'recued.bridge.test' });
    expect(handler).not.toHaveBeenCalled();
    expect(lateResult.handlerReturnValues).toEqual([false]);
    expect(lateResult.responses).toEqual([
      { ok: false, error: 'bridge_boot_failed', detail: 'boom' },
    ]);
  });

  it('failQueuedAfterBootRejection — defensive no-op after successful drain (does not mutate already-ready state)', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });
    const handler = vi.fn<ShimMessageHandler>(() => undefined);
    handle.proxy.addListener(handler);

    handle.proxy.drainQueuedMessages();
    handle.failQueuedAfterBootRejection(new Error('stale catch arm'));

    // After successful drain, the listener should still dispatch
    // through the handler (NOT respond with failure shape). Handler
    // returned undefined → dispatchToHandlers returns false → no
    // sendResponse call.
    const result = onMessage.dispatch({ type: 'recued.bridge.test' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.handlerReturnValues).toEqual([false]);
    expect(result.responses).toEqual([]);
  });

  it('failQueuedAfterBootRejection — sendResponse throw inside flush does not break the loop (other queued messages still get responses)', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });

    const responses: Array<unknown> = [];
    let firstCallShouldThrow = true;
    // Direct dispatch with a custom sendResponse that throws on the
    // first call to verify the flush loop's catch arm.
    const messages = [
      { type: BRIDGE_PAIR_MESSAGE_TYPE, op: 'status', marker: 'first' },
      { type: 'recued.bridge.side-panel.fetch-status', marker: 'second' },
    ];
    for (const message of messages) {
      onMessage.handlers[0]?.(message, {}, (response) => {
        responses.push(response);
        if (firstCallShouldThrow) {
          firstCallShouldThrow = false;
          throw new Error('sendResponse callback exploded');
        }
      });
    }

    handle.failQueuedAfterBootRejection(new Error('boom'));

    // Both queued messages should have been processed despite the
    // first sendResponse throwing — the flush loop's per-iteration
    // try/catch isolates the error.
    expect(responses).toHaveLength(2);
    expect(responses[0]).toEqual({
      ok: false,
      error: 'bridge_boot_failed',
      detail: 'boom',
    });
    expect(responses[1]).toEqual({
      ok: false,
      error: 'bridge_boot_failed',
      detail: 'boom',
    });
  });

  it('handler throw during dispatch does not break the dispatch loop (other handlers still run + async return value still propagates)', () => {
    const onMessage = buildFakeChromeOnMessage();
    const handle = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessage,
    });
    const throwing = vi.fn<ShimMessageHandler>(() => {
      throw new Error('handler exploded');
    });
    const asyncResponder = vi.fn<ShimMessageHandler>(() => true);
    handle.proxy.addListener(throwing);
    handle.proxy.addListener(asyncResponder);

    handle.proxy.drainQueuedMessages();
    const result = onMessage.dispatch({ type: 'recued.bridge.test' });

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(asyncResponder).toHaveBeenCalledTimes(1);
    expect(result.handlerReturnValues).toEqual([true]);
  });

  it('no-chrome host — factory still returns a working handle (queue stays empty + drain/fail are safe no-ops)', () => {
    const handle: SwMessageQueueHandle = createSwMessageQueue({});

    // No chrome → no shim listener → nothing to queue. The proxy
    // still composes; drain + fail must not throw.
    expect(() => handle.proxy.drainQueuedMessages()).not.toThrow();
    expect(() => handle.failQueuedAfterBootRejection(new Error('boom'))).not.toThrow();
  });

  it('no-chrome host — handlers registered against the proxy are never invoked (no ingress path)', () => {
    const handle: SwMessageQueueHandle = createSwMessageQueue({});
    const handler = vi.fn<ShimMessageHandler>(() => true);
    handle.proxy.addListener(handler);

    // No chrome means no listener subscribed, so the only way a
    // message would reach the proxy is via a direct dispatch — which
    // the proxy doesn't expose. Drain remains a safe no-op + the
    // handler is untouched.
    handle.proxy.drainQueuedMessages();
    expect(handler).not.toHaveBeenCalled();
  });

  it('closure isolation — two factory invocations get independent state (separate handlers / queue / bootReady / bootFailed)', () => {
    const onMessageA = buildFakeChromeOnMessage();
    const onMessageB = buildFakeChromeOnMessage();
    const handleA = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessageA,
    });
    const handleB = createSwMessageQueue({
      chromeRuntimeOnMessage: onMessageB,
    });

    const handlerA = vi.fn<ShimMessageHandler>();
    const handlerB = vi.fn<ShimMessageHandler>();
    handleA.proxy.addListener(handlerA);
    handleB.proxy.addListener(handlerB);

    // Fail A; drain B. Independent state means a dispatch on B
    // should reach handlerB, and a dispatch on A should respond
    // with failure.
    handleA.failQueuedAfterBootRejection(new Error('A failed'));
    handleB.proxy.drainQueuedMessages();

    const resultA = onMessageA.dispatch({
      type: BRIDGE_PAIR_MESSAGE_TYPE,
      op: 'status',
    });
    const resultB = onMessageB.dispatch({ type: 'recued.bridge.test' });

    expect(handlerA).not.toHaveBeenCalled();
    expect(resultA.responses).toEqual([
      {
        ok: false,
        error: 'bridge_boot_failed',
        detail: 'A failed',
      },
    ]);
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(resultB.responses).toEqual([]);
  });

  it('proxy is structurally a ChromeRuntimeOnMessageApi (drops into bootstrap deps without a wrapper)', () => {
    const handle = createSwMessageQueue({});
    const proxy: SwOnMessageProxy = handle.proxy;
    // Type-system spot-check — `proxy` is assignable to the bootstrap's
    // ChromeRuntimeOnMessageApi dep slot because SwOnMessageProxy
    // extends it. The runtime assertion is that `addListener` exists.
    expect(typeof proxy.addListener).toBe('function');
    expect(typeof proxy.drainQueuedMessages).toBe('function');
  });

  it('chrome listener subscribes synchronously at construction (no await between factory call + addListener)', () => {
    const onMessage = buildFakeChromeOnMessage();
    // Pre-construction: no handlers subscribed.
    expect(onMessage.handlers).toHaveLength(0);
    createSwMessageQueue({ chromeRuntimeOnMessage: onMessage });
    // Synchronous subscription — the chrome listener is present
    // immediately after the factory call returns, without yielding.
    expect(onMessage.handlers).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════
// Cleanup
// ════════════════════════════════════════════════════════════════

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.useRealTimers();
});
