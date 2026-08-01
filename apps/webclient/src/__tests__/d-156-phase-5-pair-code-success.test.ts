/** D-156 P5 — pair-code-input success-path persistence tests.
 *
 *  Drives `finalizePairCodeSuccess` end-to-end through an in-memory
 *  local store + a deterministic token-store fake + a fake
 *  passport-fetch invoker that the test feeds projection shapes into.
 *  Verifies:
 *
 *    - happy path: 5 IDB fields land with the expected values + the
 *      AAD-bound token record references the minted token_id.
 *    - passport-fetch failure surfaces `pair_code_success_passport_failed`
 *      with no IDB writes.
 *    - passport projection missing identity → `server_response_invalid`
 *      with no IDB writes.
 *    - token-store wrap failure surfaces `persist_failed` with no IDB
 *      writes (the wrap is the first persistence step that can fail).
 *    - cert-pin derivation: cert_fingerprint present → seeded;
 *      cert_fingerprint missing → null `cert_pin_state` (LAN-only).
 *    - pair_metadata carries paired_at + the server public key as
 *      fingerprint + current_handle from the passport identity block.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  ServerPassportProjection,
  WebclientLocalStorage,
  WebclientTokenRecord,
} from '@recued/contracts';

import {
  finalizePairCodeSuccess,
  normaliseServerUrlToWs,
  PAIR_CODE_SUCCESS_ERROR_COPY,
} from '../auth/pair-code-success.js';
import { createInMemoryWebclientLocalStore } from '../storage/local-store.js';
import type {
  WebclientTokenAad,
  WebclientTokenStore,
} from '../storage/token-store.js';

// ════════════════════════════════════════════════════════════════
// Test fakes
// ════════════════════════════════════════════════════════════════

const buildFakeTokenStore = (): {
  store: WebclientTokenStore;
  calls: Array<{ token_id: string; bearer: string; aad: WebclientTokenAad }>;
} => {
  const calls: Array<{ token_id: string; bearer: string; aad: WebclientTokenAad }> = [];
  const store: WebclientTokenStore = {
    async wrap({ token_id, bearer, aad }) {
      calls.push({ token_id, bearer, aad });
      return {
        token_id,
        ciphertext_b64: `wrap(${bearer})`,
        iv_b64: 'iv',
        issued_at: 1_700_000_000,
      };
    },
    async unwrap() {
      throw new Error('unwrap not exercised by these tests');
    },
  };
  return { store, calls };
};

/** Build a `ServerPassportProjection`-shaped object with the four
 *  fields the success-path reads. The rest of the shape is left
 *  empty since `extractPassportFields` reads only `identity.*` +
 *  `network.cert_*`. */
const buildPassport = (overrides: {
  server_public_key?: string | undefined;
  current_handle?: string;
  cert_fingerprint?: string;
  cert_expires_at?: number;
} = {}): unknown => {
  const identity: Record<string, unknown> = {
    current_handle: overrides.current_handle ?? 'alice',
  };
  if (overrides.server_public_key !== undefined) {
    identity.server_public_key = overrides.server_public_key;
  }
  const network: Record<string, unknown> = {};
  if (overrides.cert_fingerprint !== undefined) {
    network.cert_fingerprint = overrides.cert_fingerprint;
  }
  if (overrides.cert_expires_at !== undefined) {
    network.cert_expires_at = overrides.cert_expires_at;
  }
  return { identity, network } as unknown as ServerPassportProjection;
};

const FIXED_NOW = 1_700_000_000_000;
const FIXED_TOKEN_ID = 'token-id-fixed-uuid';
const seamOptions = () => ({
  now: () => FIXED_NOW,
  mintTokenId: () => FIXED_TOKEN_ID,
});

// ════════════════════════════════════════════════════════════════
// Happy path
// ════════════════════════════════════════════════════════════════

describe('finalizePairCodeSuccess — happy path', () => {
  it('writes 5 IDB fields + binds AAD on the wrapped bearer', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    const ensureProfile = vi.spyOn(localStore, 'ensureProfile');
    const setField = vi.spyOn(localStore, 'set');
    const { store: tokenStore, calls: wrapCalls } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: buildPassport({
        server_public_key: 'PUBKEY_BASE64',
        current_handle: 'alice',
        cert_fingerprint: 'CF1',
        cert_expires_at: 2_000_000_000,
      }) as ServerPassportProjection,
    }));

    const result = await finalizePairCodeSuccess({
      serverUrl: 'http://localhost:3001',
      bearer: 'realm-bearer-xyz',
      localStore,
      profileStore: localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.server_public_key).toBe('PUBKEY_BASE64');
    expect(result.token_id).toBe(FIXED_TOKEN_ID);
    expect(result.pair_metadata.paired_at).toBe(FIXED_NOW);
    expect(result.pair_metadata.server_handle_at_pair).toBe('alice');
    // Codex 2026-05-18 P5 R1 fold — server_url is normalised to the
    // canonical WS endpoint before persistence + passport-fetch.
    expect(result.server_url).toBe('ws://localhost:3001/ws');

    const inspected: WebclientLocalStorage = await localStore.inspect();
    expect(inspected.server_url).toBe('ws://localhost:3001/ws');
    expect(inspected.server_public_key).toBe('PUBKEY_BASE64');
    expect(inspected.pair_metadata).toEqual({
      paired_at: FIXED_NOW,
      server_passport_fingerprint: 'PUBKEY_BASE64',
      server_handle_at_pair: 'alice',
    });
    expect(inspected.cert_pin_state).toEqual({
      current_fingerprint: 'CF1',
      current_valid_until: 2_000_000_000,
    });
    expect(inspected.webclient_token).toMatchObject({
      token_id: FIXED_TOKEN_ID,
      ciphertext_b64: 'wrap(realm-bearer-xyz)',
    });

    expect(wrapCalls).toHaveLength(1);
    expect(wrapCalls[0].aad).toEqual({
      token_id: FIXED_TOKEN_ID,
      server_url: 'ws://localhost:3001/ws',
      server_public_key: 'PUBKEY_BASE64',
    });
    expect(invokePassportFetch).toHaveBeenCalledWith({
      server_url: 'ws://localhost:3001/ws',
      bearer: 'realm-bearer-xyz',
    });
    expect(ensureProfile).toHaveBeenCalledOnce();
    expect(ensureProfile).toHaveBeenCalledWith('ws://localhost:3001/ws');
    expect(setField.mock.calls.some(([key]) => key === 'server_url')).toBe(false);
  });

  it('persists the D-151 paired instance_id into pair_metadata when supplied', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: buildPassport({
        server_public_key: 'PUBKEY_BASE64',
        current_handle: 'alice',
      }) as ServerPassportProjection,
    }));

    const result = await finalizePairCodeSuccess({
      serverUrl: 'http://localhost:3001',
      bearer: 'realm-bearer-xyz',
      instanceId: 'wc-instance-1',
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The instance id rides pair_metadata (the "pinned at pair time"
    // slot) so a re-pair can reuse it; it was also forwarded to
    // /auth/pair as `instanceId` (the host owns that wire, not finalize).
    expect(result.pair_metadata.instance_id).toBe('wc-instance-1');
    const inspected: WebclientLocalStorage = await localStore.inspect();
    expect(inspected.pair_metadata).toEqual({
      paired_at: FIXED_NOW,
      server_passport_fingerprint: 'PUBKEY_BASE64',
      server_handle_at_pair: 'alice',
      instance_id: 'wc-instance-1',
    });
  });

  it('selects an existing URL before writing, so adopting it does not discard fresh metadata', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    const serverUrl = 'wss://alice.example:8443/ws';
    await localStore.ensureProfile(serverUrl);
    await localStore.set('pair_metadata', {
      paired_at: 1,
      server_passport_fingerprint: 'OLD_PUBKEY',
      server_handle_at_pair: 'old-handle',
    });
    await localStore.set('server_public_key', 'OLD_PUBKEY');
    await localStore.set('webclient_token', {
      token_id: 'old-token',
      ciphertext_b64: 'old-ciphertext',
      iv_b64: 'old-iv',
      issued_at: 1,
    });
    // "Add another server" opens a pending active record. Entering a URL
    // already in the roster must retire that pending record, select the known
    // profile, and only then write the replacement generation into it.
    await localStore.beginNewProfile();

    const { store: tokenStore } = buildFakeTokenStore();
    const result = await finalizePairCodeSuccess({
      serverUrl: 'https://alice.example:8443',
      bearer: 'replacement-bearer',
      localStore,
      profileStore: localStore,
      tokenStore,
      invokePassportFetch: vi.fn(async () => ({
        passport: buildPassport({
          server_public_key: 'NEW_PUBKEY',
          current_handle: 'new-handle',
          cert_fingerprint: 'NEW_CERT',
          cert_expires_at: 2_000_000_000,
        }) as ServerPassportProjection,
      })),
      ...seamOptions(),
    });

    expect(result.ok).toBe(true);
    expect(await localStore.listProfiles()).toHaveLength(1);
    expect(await localStore.inspect()).toMatchObject({
      server_url: serverUrl,
      server_public_key: 'NEW_PUBKEY',
      webclient_token: { token_id: FIXED_TOKEN_ID },
      pair_metadata: {
        server_passport_fingerprint: 'NEW_PUBKEY',
        server_handle_at_pair: 'new-handle',
      },
      cert_pin_state: {
        current_fingerprint: 'NEW_CERT',
      },
    });
  });

  it('uses server-issued token_id and structured auth for passport fetch', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    const { store: tokenStore, calls: wrapCalls } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: buildPassport({
        server_public_key: 'PUBKEY_CANONICAL',
        current_handle: 'alice',
      }) as ServerPassportProjection,
    }));
    const mintTokenId = vi.fn(() => 'local-fallback-token-id');

    const result = await finalizePairCodeSuccess({
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
    expect(wrapCalls[0]).toMatchObject({
      token_id: 'server-token-id',
      bearer: 'server-bearer-once',
    });
    expect(wrapCalls[0].aad).toMatchObject({
      token_id: 'server-token-id',
      server_url: 'ws://localhost:3001/ws',
      server_public_key: 'PUBKEY_CANONICAL',
    });
    expect(invokePassportFetch).toHaveBeenCalledWith({
      server_url: 'ws://localhost:3001/ws',
      bearer: 'server-token-id.server-bearer-once',
    });
  });

  it('uses /auth/pair passport directly when returned', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => {
      throw new Error('passport.fetch should not run');
    });

    const result = await finalizePairCodeSuccess({
      serverUrl: 'http://localhost:3001',
      bearer: 'server-bearer-once',
      token_id: 'server-token-id',
      passport: buildPassport({
        server_public_key: 'PUBKEY_FROM_PAIR',
        current_handle: 'alice',
      }),
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.server_public_key).toBe('PUBKEY_FROM_PAIR');
    expect(invokePassportFetch).not.toHaveBeenCalled();
  });

  it('persists null cert_pin_state when the passport carries no cert (LAN-only)', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: buildPassport({
        server_public_key: 'PUBKEY',
        // No cert_fingerprint / cert_expires_at — LAN-only server.
      }) as ServerPassportProjection,
    }));

    const result = await finalizePairCodeSuccess({
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
    const localStore = createInMemoryWebclientLocalStore();
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: buildPassport({
        server_public_key: 'PUBKEY',
        cert_fingerprint: 'CF1',
        // cert_expires_at omitted — derivation must drop the pin.
      }) as ServerPassportProjection,
    }));

    const result = await finalizePairCodeSuccess({
      serverUrl: 'http://x',
      bearer: 'b',
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });

    expect(result.ok).toBe(true);
    const inspected = await localStore.inspect();
    expect(inspected.cert_pin_state).toBeNull();
  });

  it('threads current_handle="" when the projection omits it', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: {
        identity: { server_public_key: 'PUBKEY' },
        network: {},
      } as unknown as ServerPassportProjection,
    }));

    const result = await finalizePairCodeSuccess({
      serverUrl: 'http://x',
      bearer: 'b',
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pair_metadata.server_handle_at_pair).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════
// Failure modes
// ════════════════════════════════════════════════════════════════

describe('finalizePairCodeSuccess — failures leave IDB untouched', () => {
  it('passport.fetch rejects → pair_code_success_passport_failed; no writes', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    const { store: tokenStore, calls: wrapCalls } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => {
      throw new Error('transport drop');
    });

    const result = await finalizePairCodeSuccess({
      serverUrl: 'http://x',
      bearer: 'b',
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('pair_code_success_passport_failed');
    expect(result.detail).toContain('transport drop');
    expect(wrapCalls).toHaveLength(0);
    const inspected = await localStore.inspect();
    expect(inspected).toEqual({
      server_url: null,
      webclient_token: null,
      server_public_key: null,
      pair_metadata: null,
      cert_pin_state: null,
    });
  });

  it('passport missing identity.server_public_key → server_response_invalid; no writes', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: { identity: { current_handle: 'x' }, network: {} } as unknown as ServerPassportProjection,
    }));

    const result = await finalizePairCodeSuccess({
      serverUrl: 'http://x',
      bearer: 'b',
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('pair_code_success_server_response_invalid');
    const inspected = await localStore.inspect();
    expect(inspected.server_url).toBeNull();
  });

  it('passport with non-string identity.server_public_key → server_response_invalid', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: {
        identity: { server_public_key: 42 },
        network: {},
      } as unknown as ServerPassportProjection,
    }));

    const result = await finalizePairCodeSuccess({
      serverUrl: 'http://x',
      bearer: 'b',
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('pair_code_success_server_response_invalid');
  });

  it('token-store wrap rejects → persist_failed; no IDB writes', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    const tokenStore: WebclientTokenStore = {
      async wrap(): Promise<WebclientTokenRecord> {
        throw new Error('AES-GCM key revoked');
      },
      async unwrap() {
        throw new Error('unwrap not exercised');
      },
    };
    const invokePassportFetch = vi.fn(async () => ({
      passport: buildPassport({
        server_public_key: 'PUBKEY',
      }) as ServerPassportProjection,
    }));

    const result = await finalizePairCodeSuccess({
      serverUrl: 'http://x',
      bearer: 'b',
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('pair_code_success_persist_failed');
    expect(result.detail).toContain('AES-GCM key revoked');
    const inspected = await localStore.inspect();
    expect(inspected.server_url).toBeNull();
    expect(inspected.webclient_token).toBeNull();
  });

  it('local-store set failure → persist_failed (mid-write leaves partial state)', async () => {
    // Sabotage the store after the first set call to simulate a
    // mid-write failure. The bootstrap's hydratePairState rejects
    // half-paired states so this leaves the user in the unpaired
    // form for a retry.
    const localStore = createInMemoryWebclientLocalStore();
    const originalSet = localStore.set.bind(localStore);
    let calls = 0;
    localStore.set = async <K extends keyof WebclientLocalStorage>(
      key: K,
      value: WebclientLocalStorage[K],
    ): Promise<void> => {
      calls++;
      if (calls > 2) throw new Error('IDB quota exceeded');
      await originalSet(key, value);
    };
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: buildPassport({
        server_public_key: 'PUBKEY',
      }) as ServerPassportProjection,
    }));

    const result = await finalizePairCodeSuccess({
      serverUrl: 'http://x',
      bearer: 'b',
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('pair_code_success_persist_failed');
    expect(result.detail).toContain('IDB quota');
  });

  it('profile selection failure → persist_failed before the strict token triple lands', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: buildPassport({ server_public_key: 'PUBKEY' }) as ServerPassportProjection,
    }));

    const result = await finalizePairCodeSuccess({
      serverUrl: 'https://alice.example:8443',
      bearer: 'b',
      localStore,
      profileStore: {
        ensureProfile: async () => {
          throw new Error('profile roster unavailable');
        },
      },
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('pair_code_success_persist_failed');
    expect(result.detail).toContain('profile roster unavailable');
    const inspected = await localStore.inspect();
    expect(inspected.server_url).toBeNull();
    expect(inspected.server_public_key).toBeNull();
    expect(inspected.webclient_token).toBeNull();
    expect(inspected.pair_metadata).toBeNull();
    expect(inspected.cert_pin_state).toBeNull();
  });

  it('clears an existing target token before replacement writes can fail', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    const serverUrl = 'wss://known.example:8443/ws';
    await localStore.ensureProfile(serverUrl);
    await localStore.set('server_public_key', 'OLD_PUBKEY');
    await localStore.set('webclient_token', {
      token_id: 'old-token',
      ciphertext_b64: 'old-ciphertext',
      iv_b64: 'old-iv',
      issued_at: 1,
    });
    await localStore.beginNewProfile();
    const originalSet = localStore.set.bind(localStore);
    localStore.set = async <K extends keyof WebclientLocalStorage>(
      key: K,
      value: WebclientLocalStorage[K],
    ): Promise<void> => {
      if (key === 'server_public_key') throw new Error('write interrupted');
      await originalSet(key, value);
    };
    const { store: tokenStore } = buildFakeTokenStore();

    const result = await finalizePairCodeSuccess({
      serverUrl: 'https://known.example:8443',
      bearer: 'replacement-bearer',
      localStore,
      profileStore: localStore,
      tokenStore,
      invokePassportFetch: vi.fn(async () => ({
        passport: buildPassport({ server_public_key: 'NEW_PUBKEY' }) as ServerPassportProjection,
      })),
      ...seamOptions(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('pair_code_success_persist_failed');
    // The known profile may retain its old public key, but its old token can
    // no longer make that mixed generation pass the strict boot discriminant.
    expect(await localStore.inspect()).toMatchObject({
      server_url: serverUrl,
      server_public_key: 'OLD_PUBKEY',
      webclient_token: null,
    });
  });
});

// ════════════════════════════════════════════════════════════════
// Error copy
// ════════════════════════════════════════════════════════════════

describe('PAIR_CODE_SUCCESS_ERROR_COPY', () => {
  it('covers every closed-list error code', () => {
    const required = [
      'pair_code_success_passport_failed',
      'pair_code_success_persist_failed',
      'pair_code_success_server_response_invalid',
      'pair_code_success_invalid_server_url',
    ] as const;
    for (const code of required) {
      expect(PAIR_CODE_SUCCESS_ERROR_COPY[code]).toBeTruthy();
    }
  });
});

// ════════════════════════════════════════════════════════════════
// normaliseServerUrlToWs — Codex 2026-05-18 P5 R1 fold
// ════════════════════════════════════════════════════════════════

describe('normaliseServerUrlToWs', () => {
  it('converts http:// → ws:// and appends /ws', () => {
    expect(normaliseServerUrlToWs('http://localhost:3001')).toBe(
      'ws://localhost:3001/ws',
    );
  });

  it('converts https:// → wss:// and appends /ws', () => {
    expect(normaliseServerUrlToWs('https://alice.recued.cloud:8443')).toBe(
      'wss://alice.recued.cloud:8443/ws',
    );
  });

  it('preserves an existing /ws path', () => {
    expect(normaliseServerUrlToWs('http://localhost:3001/ws')).toBe(
      'ws://localhost:3001/ws',
    );
    expect(normaliseServerUrlToWs('wss://alice.example.com/ws')).toBe(
      'wss://alice.example.com/ws',
    );
  });

  it('strips a single trailing slash before path inspection', () => {
    expect(normaliseServerUrlToWs('http://localhost:3001/')).toBe(
      'ws://localhost:3001/ws',
    );
  });

  it('passes ws:// + wss:// through (already-canonical input)', () => {
    expect(normaliseServerUrlToWs('ws://192.168.1.10:8443/ws')).toBe(
      'ws://192.168.1.10:8443/ws',
    );
    expect(normaliseServerUrlToWs('wss://alice.recued.cloud/ws')).toBe(
      'wss://alice.recued.cloud/ws',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(normaliseServerUrlToWs('  http://localhost:3001  ')).toBe(
      'ws://localhost:3001/ws',
    );
  });

  it('returns null for missing protocol', () => {
    expect(normaliseServerUrlToWs('localhost:3001')).toBeNull();
    expect(normaliseServerUrlToWs('//localhost:3001')).toBeNull();
  });

  it('returns null for empty / whitespace-only input', () => {
    expect(normaliseServerUrlToWs('')).toBeNull();
    expect(normaliseServerUrlToWs('   ')).toBeNull();
  });

  it('returns null for http:// with no host', () => {
    expect(normaliseServerUrlToWs('http://')).toBeNull();
    expect(normaliseServerUrlToWs('http:///ws')).toBeNull();
  });

  it('case-insensitive protocol prefix matching (uppercase HTTP)', () => {
    expect(normaliseServerUrlToWs('HTTP://localhost:3001')).toBe(
      'ws://localhost:3001/ws',
    );
  });
});

describe('finalizePairCodeSuccess — server-URL normalisation (Codex P5 R1 fold)', () => {
  it('surfaces pair_code_success_invalid_server_url before any passport-fetch', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn();
    const result = await finalizePairCodeSuccess({
      serverUrl: 'localhost:3001', // no protocol
      bearer: 'b',
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('pair_code_success_invalid_server_url');
    expect(invokePassportFetch).not.toHaveBeenCalled();
    const inspected = await localStore.inspect();
    expect(inspected.server_url).toBeNull();
  });

  it('persists ws:// even when the user typed https:// (DDNS Pro case)', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    const { store: tokenStore } = buildFakeTokenStore();
    const invokePassportFetch = vi.fn(async () => ({
      passport: buildPassport({
        server_public_key: 'PUBKEY',
      }) as ServerPassportProjection,
    }));
    const result = await finalizePairCodeSuccess({
      serverUrl: 'https://alice.recued.cloud:8443',
      bearer: 'b',
      localStore,
      tokenStore,
      invokePassportFetch,
      ...seamOptions(),
    });
    expect(result.ok).toBe(true);
    const inspected = await localStore.inspect();
    expect(inspected.server_url).toBe('wss://alice.recued.cloud:8443/ws');
    expect(invokePassportFetch).toHaveBeenCalledWith({
      server_url: 'wss://alice.recued.cloud:8443/ws',
      bearer: 'b',
    });
  });
});
