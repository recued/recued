/** D-148 follow-up #4 — `tls_domain.{upload,remove,list}` rpc handler tests.
 *
 *  Three rpc methods, one closed list each:
 *    - `tls_domain.upload` → BYO cert / Pro ACME upload via the W3.6
 *      `SqliteTlsDomainStore`. Validation surfaces the closed
 *      `TLSDomainUploadIssue` codes (`tls_san_mismatch` /
 *      `tls_key_pair_mismatch` / `tls_chain_invalid` /
 *      `tls_cert_expired_at_upload`) as the rpc error code with the
 *      full issues array threaded via `RpcError.details`.
 *    - `tls_domain.remove` → idempotent delete. The handler echoes
 *      `removed: bool` so the UI can suppress a stale-row toast.
 *    - `tls_domain.list` → projection over the store's `list()`.
 *
 *  Coverage:
 *    - `makeTlsDomainHandlers(undefined)` returns undefined (slice drops).
 *    - `makeTlsDomainHandlers(deps)` registers all three methods.
 *    - Unregistered caller (no `instance_id`) → `permission_denied`.
 *    - Wire-shape validators reject malformed args at the handler edge
 *      (domain / cert_pem / private_key_pem / chain_pem / source).
 *    - Successful upload routes through the store + returns the
 *      `TLSDomainUploadResult` shape.
 *    - `TlsDomainUploadValidationError` surfaces as `RpcError` with the
 *      first issue's code + structured `details.issues`.
 *    - `TlsDomainVaultLockedError` surfaces as `not_configured` (503).
 *    - `remove` is idempotent + `removed` bit reflects pre-state.
 *    - `list` returns the substrate's `list()` projection.
 *    - Channel-isolation invariant: `tls_domain.` in
 *      `MCP_RESERVED_RPC_PREFIXES`; every method in `SERVER_RPC_METHODS`.
 *
 *  Spec: docs/d-148-spec.md § A.6.3. */

import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  MCP_RESERVED_RPC_PREFIXES,
  RpcError,
  SERVER_RPC_METHODS,
  isReservedLocalRpc,
  type TLSDomainUploadIssue,
  type TLSDomainUploadVerifiers,
  type TlsDomainUploadErrorDetails,
} from '@recued/contracts';
import {
  createSqliteTlsDomainStore,
  ensureTlsDomainSchema,
  type SqliteTlsDomainStore,
  type TlsDomainKeyProvider,
} from '../tls/domain-store.js';
import {
  handleTlsDomainList,
  handleTlsDomainRemove,
  handleTlsDomainUpload,
  makeTlsDomainHandlers,
  type TlsDomainRpcDeps,
} from '../tls-domain-handler.js';

// ────────────────────────────────────────────────────────────────
// Test scaffolding — stub verifiers + stub key provider
// ────────────────────────────────────────────────────────────────

/** Deterministic 32-byte sub-DEK for AEAD round-trips. NEVER for prod. */
const STUB_KEY: TlsDomainKeyProvider = () => {
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = (i * 7 + 13) & 0xff;
  return key;
};

/** Stub cert PEM that encodes the SAN domain in an out-of-band header
 *  so the stub `extractSANs` can recover it (mirrors the W3.6 store
 *  test pattern — no ASN.1 parsing in stubs). */
const stubCertFor = (domain: string): string =>
  `-----BEGIN CERTIFICATE-----\n;DOMAIN=${domain};\nCERT_BODY\n-----END CERTIFICATE-----`;

const stubKeyPem = '-----BEGIN PRIVATE KEY-----\nKEY_BODY\n-----END PRIVATE KEY-----';
const stubChainPem = '-----BEGIN CERTIFICATE-----\nCHAIN_BODY\n-----END CERTIFICATE-----';

interface VerifierOverrides {
  san_mismatch?: boolean;
  key_pair_mismatch?: boolean;
  chain_invalid?: boolean;
  expired?: boolean;
}

const buildVerifiers = (overrides: VerifierOverrides = {}): TLSDomainUploadVerifiers => ({
  extractSANs: (cert: string) => {
    if (overrides.san_mismatch) return ['someone-else.example'];
    const m = cert.match(/;DOMAIN=([^;]+);/);
    return m ? [m[1]!] : ['stub.example'];
  },
  verifyKeyPair: () => !overrides.key_pair_mismatch,
  verifyChain: () => !overrides.chain_invalid,
  readExpiresAt: () =>
    overrides.expired
      ? Date.now() - 86_400_000 // 1 day ago
      : Date.now() + 30 * 86_400_000,
});

const buildStore = (overrides: VerifierOverrides = {}): SqliteTlsDomainStore => {
  const db = new Database(':memory:');
  ensureTlsDomainSchema(db);
  return createSqliteTlsDomainStore({
    db,
    getKey: STUB_KEY,
    verifiers: buildVerifiers(overrides),
  });
};

const buildDeps = (store: SqliteTlsDomainStore): TlsDomainRpcDeps => ({
  getStore: () => store,
});

const pairedCaller = { instance_id: 'paired-1' };
const unregisteredCaller = { instance_id: null };

const goodUploadArgs = (domain: string) => ({
  domain,
  cert_pem: stubCertFor(domain),
  private_key_pem: stubKeyPem,
  source: 'byo_upload' as const,
});

// ────────────────────────────────────────────────────────────────
// Slice factory
// ────────────────────────────────────────────────────────────────

describe('makeTlsDomainHandlers', () => {
  it('returns undefined when deps are absent (slice drops; dispatcher → not_configured)', () => {
    expect(makeTlsDomainHandlers(undefined)).toBeUndefined();
  });

  it('registers all three tls_domain methods when deps are present', () => {
    const slice = makeTlsDomainHandlers(buildDeps(buildStore()));
    expect(slice).toBeDefined();
    expect(slice!.methods).toEqual([
      'tls_domain.upload',
      'tls_domain.remove',
      'tls_domain.list',
    ]);
    expect(typeof slice!.handlers['tls_domain.upload']).toBe('function');
    expect(typeof slice!.handlers['tls_domain.remove']).toBe('function');
    expect(typeof slice!.handlers['tls_domain.list']).toBe('function');
  });
});

// ────────────────────────────────────────────────────────────────
// Caller-identity gate
// ────────────────────────────────────────────────────────────────

describe('caller-identity gate (every method requires a paired client)', () => {
  let deps: TlsDomainRpcDeps;
  beforeEach(() => {
    deps = buildDeps(buildStore());
  });

  it('upload rejects unregistered caller with permission_denied (403)', async () => {
    await expect(
      handleTlsDomainUpload(deps, goodUploadArgs('alice.example'), unregisteredCaller),
    ).rejects.toMatchObject({
      code: 'permission_denied',
      status: 403,
    });
  });

  it('remove rejects unregistered caller with permission_denied (403)', async () => {
    await expect(
      handleTlsDomainRemove(deps, { domain: 'alice.example' }, unregisteredCaller),
    ).rejects.toMatchObject({
      code: 'permission_denied',
      status: 403,
    });
  });

  it('list rejects unregistered caller with permission_denied (403)', async () => {
    await expect(handleTlsDomainList(deps, {}, unregisteredCaller)).rejects.toMatchObject({
      code: 'permission_denied',
      status: 403,
    });
  });

  it('every method rejects a missing caller object', async () => {
    await expect(
      handleTlsDomainUpload(deps, goodUploadArgs('a.example'), undefined),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(
      handleTlsDomainRemove(deps, { domain: 'a.example' }, undefined),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(handleTlsDomainList(deps, {}, undefined)).rejects.toMatchObject({
      code: 'permission_denied',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Wire-shape validators (handler-edge bad_request)
// ────────────────────────────────────────────────────────────────

describe('wire-shape validators', () => {
  let deps: TlsDomainRpcDeps;
  beforeEach(() => {
    deps = buildDeps(buildStore());
  });

  describe('tls_domain.upload', () => {
    it('rejects empty / non-hostname domain', async () => {
      const cases: unknown[] = [undefined, null, '', '   ', 42, 'https://x', 'x/y', 'a b'];
      for (const domain of cases) {
        await expect(
          handleTlsDomainUpload(
            deps,
            { ...goodUploadArgs('ignored.example'), domain },
            pairedCaller,
          ),
        ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
      }
    });

    it('rejects non-PEM cert_pem', async () => {
      await expect(
        handleTlsDomainUpload(
          deps,
          { ...goodUploadArgs('a.example'), cert_pem: 'not a pem' },
          pairedCaller,
        ),
      ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
      await expect(
        handleTlsDomainUpload(
          deps,
          { ...goodUploadArgs('a.example'), cert_pem: '' },
          pairedCaller,
        ),
      ).rejects.toMatchObject({ code: 'bad_request' });
    });

    it('rejects non-PEM private_key_pem', async () => {
      await expect(
        handleTlsDomainUpload(
          deps,
          { ...goodUploadArgs('a.example'), private_key_pem: 'plaintext' },
          pairedCaller,
        ),
      ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    });

    it('rejects non-PEM chain_pem when present', async () => {
      await expect(
        handleTlsDomainUpload(
          deps,
          { ...goodUploadArgs('a.example'), chain_pem: 'bad' },
          pairedCaller,
        ),
      ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    });

    it('accepts chain_pem when omitted (optional field)', async () => {
      const { chain_pem: _omit, ...args } = { ...goodUploadArgs('a.example'), chain_pem: undefined };
      const result = await handleTlsDomainUpload(deps, args, pairedCaller);
      expect(result.fingerprint).toBeTruthy();
    });

    it('rejects source not in closed list', async () => {
      await expect(
        handleTlsDomainUpload(
          deps,
          { ...goodUploadArgs('a.example'), source: 'lets_encrypt' as unknown as 'pro_acme' },
          pairedCaller,
        ),
      ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
      await expect(
        handleTlsDomainUpload(
          deps,
          { ...goodUploadArgs('a.example'), source: undefined as unknown as 'pro_acme' },
          pairedCaller,
        ),
      ).rejects.toMatchObject({ code: 'bad_request' });
    });
  });

  describe('tls_domain.remove', () => {
    it('rejects empty / non-hostname domain', async () => {
      const cases: unknown[] = [undefined, null, '', '   ', 42, 'https://x', 'x/y', 'a b'];
      for (const domain of cases) {
        await expect(
          handleTlsDomainRemove(deps, { domain }, pairedCaller),
        ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
      }
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Success paths
// ────────────────────────────────────────────────────────────────

describe('success paths route through the store', () => {
  it('upload returns TLSDomainUploadResult shape + persists to the store', async () => {
    const store = buildStore();
    const deps = buildDeps(store);
    const args = goodUploadArgs('alice.recued.cloud');
    const result = await handleTlsDomainUpload(deps, args, pairedCaller);
    expect(result.fingerprint).toMatch(/^[0-9a-f]+$/);
    expect(result.expires_at).toBeGreaterThan(Date.now());
    expect(result.san).toContain('alice.recued.cloud');
    // Substrate side-effect: list now carries the new row.
    expect(store.list().map((e) => e.domain)).toContain('alice.recued.cloud');
  });

  it('upload accepts chain_pem when provided', async () => {
    const deps = buildDeps(buildStore());
    const args = { ...goodUploadArgs('alice.example'), chain_pem: stubChainPem };
    const result = await handleTlsDomainUpload(deps, args, pairedCaller);
    expect(result.fingerprint).toBeTruthy();
  });

  it('remove of existing domain returns { removed: true } + drops the row', async () => {
    const store = buildStore();
    const deps = buildDeps(store);
    await handleTlsDomainUpload(deps, goodUploadArgs('to-remove.example'), pairedCaller);
    expect(store.list().map((e) => e.domain)).toContain('to-remove.example');

    const result = await handleTlsDomainRemove(deps, { domain: 'to-remove.example' }, pairedCaller);
    expect(result.removed).toBe(true);
    expect(store.list().map((e) => e.domain)).not.toContain('to-remove.example');
  });

  it('remove of missing domain returns { removed: false } (idempotent no-op)', async () => {
    const deps = buildDeps(buildStore());
    const result = await handleTlsDomainRemove(deps, { domain: 'never-existed.example' }, pairedCaller);
    expect(result.removed).toBe(false);
  });

  it('remove canonicalises mixed-case + whitespace per W3.6 P2 fold', async () => {
    const store = buildStore();
    const deps = buildDeps(store);
    await handleTlsDomainUpload(deps, goodUploadArgs('case.example'), pairedCaller);
    // Upload canonicalises to 'case.example'; remove with mixed-case hits it.
    const result = await handleTlsDomainRemove(deps, { domain: '  CASE.Example  ' }, pairedCaller);
    expect(result.removed).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────
  // Codex FU4 P2 fold — pro_acme removal gate
  // ────────────────────────────────────────────────────────────────

  it('remove of pro_acme row refuses with tls_pro_acme_unbind_required', async () => {
    const store = buildStore();
    const deps = buildDeps(store);
    // Upload a pro_acme row (auto-managed `<handle>.recued.cloud`-shaped).
    await handleTlsDomainUpload(
      deps,
      { ...goodUploadArgs('alice.recued.cloud'), source: 'pro_acme' },
      pairedCaller,
    );
    expect(store.list().map((e) => e.domain)).toContain('alice.recued.cloud');

    try {
      await handleTlsDomainRemove(deps, { domain: 'alice.recued.cloud' }, pairedCaller);
      throw new Error('expected RpcError but none was thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      const rpcErr = err as RpcError;
      expect(rpcErr.code).toBe('tls_pro_acme_unbind_required');
      expect(rpcErr.status).toBe(400);
    }

    // Row MUST still be present (the gate must not delete on the refused
    // path — otherwise the caller's "removed" feedback would diverge
    // from the actual store state).
    expect(store.list().map((e) => e.domain)).toContain('alice.recued.cloud');
  });

  it('remove of byo_upload row proceeds even when a pro_acme row exists', async () => {
    const store = buildStore();
    const deps = buildDeps(store);
    await handleTlsDomainUpload(
      deps,
      { ...goodUploadArgs('alice.recued.cloud'), source: 'pro_acme' },
      pairedCaller,
    );
    await handleTlsDomainUpload(
      deps,
      { ...goodUploadArgs('byo.example'), source: 'byo_upload' },
      pairedCaller,
    );

    const result = await handleTlsDomainRemove(
      deps,
      { domain: 'byo.example' },
      pairedCaller,
    );
    expect(result.removed).toBe(true);
    // pro_acme row untouched.
    expect(store.list().map((e) => e.domain)).toEqual(['alice.recued.cloud']);
  });

  it('remove of missing domain stays idempotent (gate only fires on existing pro_acme rows)', async () => {
    const deps = buildDeps(buildStore());
    // No pre-state — should NOT raise the pro_acme gate; should return
    // { removed: false } per the idempotent contract.
    const result = await handleTlsDomainRemove(
      deps,
      { domain: 'never-existed.recued.cloud' },
      pairedCaller,
    );
    expect(result.removed).toBe(false);
  });

  it('list returns the substrate projection (no private-key material)', async () => {
    const store = buildStore();
    const deps = buildDeps(store);
    await handleTlsDomainUpload(deps, goodUploadArgs('a.example'), pairedCaller);
    await handleTlsDomainUpload(deps, goodUploadArgs('b.example'), pairedCaller);

    const result = await handleTlsDomainList(deps, {}, pairedCaller);
    expect(result.entries.map((e) => e.domain).sort()).toEqual(['a.example', 'b.example']);
    // List rows MUST NOT carry private-key material.
    for (const e of result.entries) {
      expect(Object.keys(e)).not.toContain('private_key_pem');
      expect(Object.keys(e)).not.toContain('private_key_encrypted');
    }
  });

  it('list returns empty array on a fresh store', async () => {
    const deps = buildDeps(buildStore());
    const result = await handleTlsDomainList(deps, {}, pairedCaller);
    expect(result.entries).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// TlsDomainUploadValidationError → RpcError mapping (4 codes)
// ────────────────────────────────────────────────────────────────

describe('validation errors surface with the substrate code + structured details', () => {
  const expectIssue = async (
    overrides: VerifierOverrides,
    expectedCode: TLSDomainUploadIssue['code'],
  ) => {
    const deps = buildDeps(buildStore(overrides));
    try {
      await handleTlsDomainUpload(deps, goodUploadArgs('alice.example'), pairedCaller);
      throw new Error('expected RpcError but none was thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      const rpcErr = err as RpcError;
      expect(rpcErr.code).toBe(expectedCode);
      expect(rpcErr.status).toBe(400);
      const details = rpcErr.details as TlsDomainUploadErrorDetails | undefined;
      expect(details).toBeDefined();
      expect(details!.issues.some((i: TLSDomainUploadIssue) => i.code === expectedCode)).toBe(true);
    }
  };

  it('tls_san_mismatch maps to code + details.issues[0]', async () => {
    await expectIssue({ san_mismatch: true }, 'tls_san_mismatch');
  });

  it('tls_key_pair_mismatch maps to code + details.issues[0]', async () => {
    await expectIssue({ key_pair_mismatch: true }, 'tls_key_pair_mismatch');
  });

  it('tls_chain_invalid maps to code + details.issues[0]', async () => {
    await expectIssue({ chain_invalid: true }, 'tls_chain_invalid');
  });

  it('tls_cert_expired_at_upload maps to code + details.issues[0]', async () => {
    await expectIssue({ expired: true }, 'tls_cert_expired_at_upload');
  });

  it('multiple issues: first-gate code drives RpcError.code; details carries ALL', async () => {
    // SAN mismatch + key pair mismatch + chain invalid + expired all firing.
    // Validator order is SAN → key pair → chain → expiry; first gate
    // (SAN) determines the rpc code.
    const deps = buildDeps(
      buildStore({
        san_mismatch: true,
        key_pair_mismatch: true,
        chain_invalid: true,
        expired: true,
      }),
    );
    try {
      await handleTlsDomainUpload(deps, goodUploadArgs('alice.example'), pairedCaller);
      throw new Error('expected RpcError');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      const rpcErr = err as RpcError;
      expect(rpcErr.code).toBe('tls_san_mismatch');
      const details = rpcErr.details as TlsDomainUploadErrorDetails | undefined;
      expect(details).toBeDefined();
      // All four issue codes should appear in details.issues.
      const codes = new Set(details!.issues.map((i: TLSDomainUploadIssue) => i.code));
      expect(codes.has('tls_san_mismatch')).toBe(true);
      expect(codes.has('tls_key_pair_mismatch')).toBe(true);
      expect(codes.has('tls_chain_invalid')).toBe(true);
      expect(codes.has('tls_cert_expired_at_upload')).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Vault-locked path → not_configured (503)
// ────────────────────────────────────────────────────────────────

describe('vault-locked upload surfaces as not_configured', () => {
  it('upload with locked key provider → not_configured 503', async () => {
    const db = new Database(':memory:');
    ensureTlsDomainSchema(db);
    // Locked: provider returns null.
    const store = createSqliteTlsDomainStore({
      db,
      getKey: () => null,
      verifiers: buildVerifiers(),
    });
    const deps = buildDeps(store);
    await expect(
      handleTlsDomainUpload(deps, goodUploadArgs('alice.example'), pairedCaller),
    ).rejects.toMatchObject({
      code: 'not_configured',
      status: 503,
    });
  });

  it('list still works with locked vault (reads non-encrypted columns only)', async () => {
    const db = new Database(':memory:');
    ensureTlsDomainSchema(db);
    const store = createSqliteTlsDomainStore({
      db,
      getKey: () => null,
      verifiers: buildVerifiers(),
    });
    const deps = buildDeps(store);
    const result = await handleTlsDomainList(deps, {}, pairedCaller);
    expect(result.entries).toEqual([]);
  });

  it('remove still works with locked vault (deletes the row regardless)', async () => {
    const db = new Database(':memory:');
    ensureTlsDomainSchema(db);
    const store = createSqliteTlsDomainStore({
      db,
      getKey: () => null,
      verifiers: buildVerifiers(),
    });
    const deps = buildDeps(store);
    // Remove a missing domain → returns false without throwing.
    const result = await handleTlsDomainRemove(deps, { domain: 'gone.example' }, pairedCaller);
    expect(result.removed).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Boot-order invariant — getStore thunk
// ────────────────────────────────────────────────────────────────

describe('getStore thunk resolves at rpc-call time', () => {
  it('thunk that throws before assignment surfaces the fail-loud message', async () => {
    const deps: TlsDomainRpcDeps = {
      getStore: () => {
        throw new Error('tls_domain rpc dispatched before SqliteTlsDomainStore was wired');
      },
    };
    await expect(
      handleTlsDomainList(deps, {}, pairedCaller),
    ).rejects.toThrow(/before SqliteTlsDomainStore was wired/);
  });

  it('thunk resolved after deferred assignment works on the same deps object', async () => {
    let store: SqliteTlsDomainStore | undefined;
    const deps: TlsDomainRpcDeps = {
      getStore: () => {
        if (!store) throw new Error('not wired yet');
        return store;
      },
    };
    // Late binding — mimics the bin.ts forward-declaration pattern.
    store = buildStore();
    await handleTlsDomainUpload(deps, goodUploadArgs('late-bound.example'), pairedCaller);
    const list = await handleTlsDomainList(deps, {}, pairedCaller);
    expect(list.entries.map((e) => e.domain)).toContain('late-bound.example');
  });
});

// ────────────────────────────────────────────────────────────────
// Channel-isolation ratchets — closed-list source pins
// ────────────────────────────────────────────────────────────────

describe('channel-isolation source pins', () => {
  it('every tls_domain.* method is in SERVER_RPC_METHODS', () => {
    const want = ['tls_domain.upload', 'tls_domain.remove', 'tls_domain.list'];
    for (const m of want) {
      expect(SERVER_RPC_METHODS).toContain(m);
    }
  });

  it('tls_domain. is in MCP_RESERVED_RPC_PREFIXES (channel-isolation invariant)', () => {
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('tls_domain.');
  });

  it('isReservedLocalRpc flags every tls_domain.* method (MCP excluded)', () => {
    expect(isReservedLocalRpc('tls_domain.upload')).toBe(true);
    expect(isReservedLocalRpc('tls_domain.remove')).toBe(true);
    expect(isReservedLocalRpc('tls_domain.list')).toBe(true);
  });
});
