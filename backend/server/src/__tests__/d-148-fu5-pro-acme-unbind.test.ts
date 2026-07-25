/** D-148 follow-up #5 — Pro auto-managed `<handle>.recued.cloud` unbind tests.
 *
 *  Two surfaces under test:
 *
 *    1. `proAcmeUnbind` substrate — tagged-union result over a coupled
 *       (DDNS release + audit emit + cert remove) transaction. Tests
 *       cover the happy path, the closed-list error outcomes
 *       (`pro_acme_not_found` / `pro_acme_ddns_release_failed`), the
 *       4-step ordering invariant (validate → release → audit → remove),
 *       and the idempotent-retry semantics.
 *    2. `pro_acme.unbind` rpc handler — thin adapter over the substrate.
 *       Tests cover wire-shape arg validation, unregistered-caller gate,
 *       result → wire/RpcError mapping, and the slice factory.
 *
 *  Ratchets:
 *    - `'pro_acme_unbound'` in `HIGH_ASSURANCE_AUDIT_KINDS`.
 *    - `'pro_acme.'` in `MCP_RESERVED_RPC_PREFIXES` (channel isolation).
 *    - `'pro_acme.unbind'` in `SERVER_RPC_METHODS`.
 *    - `'pro_acme_not_found'` + `'pro_acme_ddns_release_failed'` in
 *      `NETWORK_ERROR_CODES`.
 *
 *  Spec: D-148 § A.5.2 + § A.6.3. */

import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  HIGH_ASSURANCE_AUDIT_KINDS,
  MCP_RESERVED_RPC_PREFIXES,
  NETWORK_ERROR_CODES,
  RpcError,
  SERVER_RPC_METHODS,
  isHighAssuranceAuditKind,
  isReservedLocalRpc,
  type TLSDomainUploadVerifiers,
} from '@recued/contracts';
import {
  canonicaliseProAcmeDomain,
  deriveProAcmeHandle,
  proAcmeUnbind,
  type DdnsHandleControl,
  type ProAcmeAuditSink,
  type ProAcmeUnbindOptions,
} from '../pro-acme/unbind.js';
import {
  handleProAcmeUnbind,
  makeProAcmeHandlers,
  type ProAcmeRpcDeps,
} from '../pro-acme-handler.js';
import {
  createSqliteTlsDomainStore,
  ensureTlsDomainSchema,
  type SqliteTlsDomainStore,
  type TlsDomainKeyProvider,
} from '../tls/domain-store.js';

// ────────────────────────────────────────────────────────────────
// Test scaffolding — TLS store + DDNS stub + audit sink stub
// ────────────────────────────────────────────────────────────────

const STUB_KEY: TlsDomainKeyProvider = () => {
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = (i * 11 + 17) & 0xff;
  return key;
};

const stubCertFor = (domain: string): string =>
  `-----BEGIN CERTIFICATE-----\n;DOMAIN=${domain};\nCERT_BODY\n-----END CERTIFICATE-----`;

const stubKeyPem =
  '-----BEGIN PRIVATE KEY-----\nKEY_BODY\n-----END PRIVATE KEY-----';

const buildVerifiers = (): TLSDomainUploadVerifiers => ({
  extractSANs: (cert: string) => {
    const m = cert.match(/;DOMAIN=([^;]+);/);
    return m ? [m[1]!] : ['stub.example'];
  },
  verifyKeyPair: () => true,
  verifyChain: () => true,
  readExpiresAt: () => Date.now() + 30 * 86_400_000,
});

const buildStore = (): SqliteTlsDomainStore => {
  const db = new Database(':memory:');
  ensureTlsDomainSchema(db);
  return createSqliteTlsDomainStore({
    db,
    getKey: STUB_KEY,
    verifiers: buildVerifiers(),
  });
};

interface DdnsStub extends DdnsHandleControl {
  releaseCalls: Array<{ handle: string; reason?: string }>;
  setFailure(err: Error | null): void;
}

const buildDdnsStub = (): DdnsStub => {
  const calls: Array<{ handle: string; reason?: string }> = [];
  let failure: Error | null = null;
  return {
    releaseCalls: calls,
    setFailure(err) {
      failure = err;
    },
    async release(args) {
      if (failure) throw failure;
      calls.push({
        handle: args.handle,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      });
      return { released: true };
    },
  };
};

interface AuditStub extends ProAcmeAuditSink {
  rows: Array<{
    action: 'pro_acme_unbound';
    domain: string;
    handle: string;
    unbound_by_client_id: string;
    reason?: string;
  }>;
  setFailure(err: Error | null): void;
}

const buildAuditStub = (): AuditStub => {
  const rows: AuditStub['rows'] = [];
  let failure: Error | null = null;
  return {
    rows,
    setFailure(err) {
      failure = err;
    },
    async recordAudit(payload) {
      if (failure) throw failure;
      rows.push({
        action: payload.action,
        domain: payload.domain,
        handle: payload.handle,
        unbound_by_client_id: payload.unbound_by_client_id,
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
      });
    },
  };
};

const buildOptions = (
  overrides: {
    store?: SqliteTlsDomainStore;
    ddns?: DdnsStub;
    effects?: AuditStub;
  } = {},
): ProAcmeUnbindOptions => ({
  store: overrides.store ?? buildStore(),
  ddns: overrides.ddns ?? buildDdnsStub(),
  effects: overrides.effects ?? buildAuditStub(),
});

const uploadProAcmeRow = async (
  store: SqliteTlsDomainStore,
  domain: string,
): Promise<void> => {
  await store.upload({
    domain,
    cert_pem: stubCertFor(domain),
    private_key_pem: stubKeyPem,
    source: 'pro_acme',
  });
};

const uploadByoRow = async (
  store: SqliteTlsDomainStore,
  domain: string,
): Promise<void> => {
  await store.upload({
    domain,
    cert_pem: stubCertFor(domain),
    private_key_pem: stubKeyPem,
    source: 'byo_upload',
  });
};

const pairedCaller = { instance_id: 'paired-1' };

// ────────────────────────────────────────────────────────────────
// Closed-list ratchets
// ────────────────────────────────────────────────────────────────

describe('D-148 FU5 closed-list ratchets', () => {
  it('pro_acme_unbound is registered as a high-assurance audit kind', () => {
    expect(HIGH_ASSURANCE_AUDIT_KINDS.has('pro_acme_unbound')).toBe(true);
    expect(isHighAssuranceAuditKind('pro_acme_unbound')).toBe(true);
  });

  it('pro_acme. is reserved as a local-UI-only rpc prefix (MCP channel isolation)', () => {
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('pro_acme.');
    expect(isReservedLocalRpc('pro_acme.unbind')).toBe(true);
  });

  it('pro_acme.unbind is registered in SERVER_RPC_METHODS', () => {
    expect(SERVER_RPC_METHODS).toContain('pro_acme.unbind');
  });

  it('NETWORK_ERROR_CODES carries the two new FU5 codes', () => {
    expect(NETWORK_ERROR_CODES).toContain('pro_acme_not_found');
    expect(NETWORK_ERROR_CODES).toContain('pro_acme_ddns_release_failed');
  });
});

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

describe('D-148 FU5 helpers', () => {
  describe('canonicaliseProAcmeDomain', () => {
    it('lowercases + trims to match the W3.6 store row key', () => {
      expect(canonicaliseProAcmeDomain('  Alice.Recued.Cloud  ')).toBe(
        'alice.recued.cloud',
      );
    });
    it('preserves the canonical form unchanged', () => {
      expect(canonicaliseProAcmeDomain('bob.recued.cloud')).toBe(
        'bob.recued.cloud',
      );
    });
  });

  describe('deriveProAcmeHandle', () => {
    it('strips the .recued.cloud suffix for a flat Pro handle', () => {
      expect(deriveProAcmeHandle('alice.recued.cloud')).toBe('alice');
    });
    it('returns null for a domain without the .recued.cloud suffix', () => {
      expect(deriveProAcmeHandle('alice.example.com')).toBeNull();
    });
    it('returns null for the empty-stem case (`.recued.cloud`)', () => {
      expect(deriveProAcmeHandle('.recued.cloud')).toBeNull();
    });
    it('returns null for nested sub-subdomains (Pro handles are flat)', () => {
      expect(deriveProAcmeHandle('evil.alice.recued.cloud')).toBeNull();
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Substrate — proAcmeUnbind happy + ordering invariants
// ────────────────────────────────────────────────────────────────

describe('D-148 FU5 substrate — happy path + ordering', () => {
  it('happy path: DDNS release fires → audit row emitted → cert removed', async () => {
    const store = buildStore();
    await uploadProAcmeRow(store, 'alice.recued.cloud');
    const ddns = buildDdnsStub();
    const effects = buildAuditStub();

    const result = await proAcmeUnbind(
      { store, ddns, effects },
      { domain: 'alice.recued.cloud', unbound_by_client_id: 'paired-1' },
    );

    expect(result).toEqual({
      ok: true,
      released: true,
      domain: 'alice.recued.cloud',
      handle: 'alice',
    });
    expect(ddns.releaseCalls).toEqual([{ handle: 'alice' }]);
    expect(effects.rows).toEqual([
      {
        action: 'pro_acme_unbound',
        domain: 'alice.recued.cloud',
        handle: 'alice',
        unbound_by_client_id: 'paired-1',
      },
    ]);
    expect(store.list().map((e) => e.domain)).not.toContain(
      'alice.recued.cloud',
    );
  });

  it('passes operator reason through to BOTH the DDNS release + the audit row', async () => {
    const store = buildStore();
    await uploadProAcmeRow(store, 'bob.recued.cloud');
    const ddns = buildDdnsStub();
    const effects = buildAuditStub();

    await proAcmeUnbind(
      { store, ddns, effects },
      {
        domain: 'bob.recued.cloud',
        unbound_by_client_id: 'paired-2',
        reason: 'switching to BYO domain',
      },
    );

    expect(ddns.releaseCalls).toEqual([
      { handle: 'bob', reason: 'switching to BYO domain' },
    ]);
    expect(effects.rows[0]).toMatchObject({
      reason: 'switching to BYO domain',
    });
  });

  it('canonicalises input domain to match the W3.6 store row (mixed-case + whitespace)', async () => {
    const store = buildStore();
    await uploadProAcmeRow(store, 'alice.recued.cloud');
    const ddns = buildDdnsStub();
    const effects = buildAuditStub();

    const result = await proAcmeUnbind(
      { store, ddns, effects },
      {
        domain: '  Alice.Recued.Cloud  ',
        unbound_by_client_id: 'paired-1',
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.domain).toBe('alice.recued.cloud');
    expect(result.handle).toBe('alice');
  });

  it('orders DDNS release BEFORE audit emit (transaction invariant)', async () => {
    const store = buildStore();
    await uploadProAcmeRow(store, 'alice.recued.cloud');
    const callOrder: string[] = [];

    const ddns: DdnsHandleControl = {
      async release() {
        callOrder.push('ddns');
        return { released: true };
      },
    };
    const effects: ProAcmeAuditSink = {
      async recordAudit() {
        callOrder.push('audit');
      },
    };

    await proAcmeUnbind(
      { store, ddns, effects },
      { domain: 'alice.recued.cloud', unbound_by_client_id: 'paired-1' },
    );

    expect(callOrder).toEqual(['ddns', 'audit']);
  });

  it('orders audit emit BEFORE cert removal (W3.5 audit-first invariant)', async () => {
    const store = buildStore();
    await uploadProAcmeRow(store, 'alice.recued.cloud');
    const observations: Array<{ step: string; rowPresent: boolean }> = [];
    const ddns = buildDdnsStub();
    const effects: ProAcmeAuditSink = {
      async recordAudit() {
        observations.push({
          step: 'audit',
          rowPresent: store
            .list()
            .some((e) => e.domain === 'alice.recued.cloud'),
        });
      },
    };

    await proAcmeUnbind(
      { store, ddns, effects },
      { domain: 'alice.recued.cloud', unbound_by_client_id: 'paired-1' },
    );

    // The audit row was emitted while the cert row was still present —
    // audit-before-removal invariant. Compliance review sees the signed
    // row before the cert disappears.
    expect(observations).toEqual([{ step: 'audit', rowPresent: true }]);
  });
});

// ────────────────────────────────────────────────────────────────
// Substrate — error outcomes
// ────────────────────────────────────────────────────────────────

describe('D-148 FU5 substrate — error outcomes', () => {
  it('returns pro_acme_not_found when the domain doesn\'t exist in the store', async () => {
    const opts = buildOptions();
    const result = await proAcmeUnbind(opts, {
      domain: 'never-existed.recued.cloud',
      unbound_by_client_id: 'paired-1',
    });
    expect(result).toEqual({
      ok: false,
      error: 'pro_acme_not_found',
      domain: 'never-existed.recued.cloud',
    });
  });

  it('returns pro_acme_not_found when the row exists but is byo_upload (not Pro-managed)', async () => {
    const store = buildStore();
    await uploadByoRow(store, 'my-domain.example');
    const result = await proAcmeUnbind(buildOptions({ store }), {
      domain: 'my-domain.example',
      unbound_by_client_id: 'paired-1',
    });
    expect(result).toEqual({
      ok: false,
      error: 'pro_acme_not_found',
      domain: 'my-domain.example',
    });
  });

  it('does NOT fire DDNS release OR audit emit when domain is not pro_acme', async () => {
    const store = buildStore();
    await uploadByoRow(store, 'my-domain.example');
    const ddns = buildDdnsStub();
    const effects = buildAuditStub();
    await proAcmeUnbind(
      { store, ddns, effects },
      {
        domain: 'my-domain.example',
        unbound_by_client_id: 'paired-1',
      },
    );
    expect(ddns.releaseCalls).toEqual([]);
    expect(effects.rows).toEqual([]);
    // Row stays — `byo_upload` removal goes through `tls_domain.remove`
    // not this rpc.
    expect(store.list().map((e) => e.domain)).toContain('my-domain.example');
  });

  it('returns pro_acme_ddns_release_failed when the cloud helper throws', async () => {
    const store = buildStore();
    await uploadProAcmeRow(store, 'alice.recued.cloud');
    const ddns = buildDdnsStub();
    ddns.setFailure(new Error('cloud quota exceeded'));
    const effects = buildAuditStub();

    const result = await proAcmeUnbind(
      { store, ddns, effects },
      { domain: 'alice.recued.cloud', unbound_by_client_id: 'paired-1' },
    );

    expect(result).toEqual({
      ok: false,
      error: 'pro_acme_ddns_release_failed',
      domain: 'alice.recued.cloud',
    });
    // CRITICAL: audit MUST NOT have emitted, cert row MUST still exist.
    // A failed cloud-side release means no real cloud effect happened;
    // emitting "pro_acme_unbound" anyway would be a false durable record.
    expect(effects.rows).toEqual([]);
    expect(store.list().map((e) => e.domain)).toContain('alice.recued.cloud');
  });

  it('audit-emit failure propagates AFTER DDNS release (cert row stays for retry)', async () => {
    const store = buildStore();
    await uploadProAcmeRow(store, 'alice.recued.cloud');
    const ddns = buildDdnsStub();
    const effects = buildAuditStub();
    effects.setFailure(new Error('audit-log persistence failure'));

    await expect(
      proAcmeUnbind(
        { store, ddns, effects },
        { domain: 'alice.recued.cloud', unbound_by_client_id: 'paired-1' },
      ),
    ).rejects.toThrow('audit-log persistence failure');

    // Cloud side already released (DDNS step ran before audit).
    expect(ddns.releaseCalls).toEqual([{ handle: 'alice' }]);
    // Cert row stays — retry path: cloud release idempotent → audit
    // emit re-fires (operator clears the underlying audit-log issue) →
    // cert removed.
    expect(store.list().map((e) => e.domain)).toContain('alice.recued.cloud');
  });
});

// ────────────────────────────────────────────────────────────────
// Substrate — idempotent retry
// ────────────────────────────────────────────────────────────────

describe('D-148 FU5 substrate — idempotent retry', () => {
  it('second call after success returns pro_acme_not_found (cert row already removed)', async () => {
    const store = buildStore();
    await uploadProAcmeRow(store, 'alice.recued.cloud');
    const opts = buildOptions({ store });

    const first = await proAcmeUnbind(opts, {
      domain: 'alice.recued.cloud',
      unbound_by_client_id: 'paired-1',
    });
    expect(first.ok).toBe(true);

    const second = await proAcmeUnbind(opts, {
      domain: 'alice.recued.cloud',
      unbound_by_client_id: 'paired-1',
    });
    expect(second).toEqual({
      ok: false,
      error: 'pro_acme_not_found',
      domain: 'alice.recued.cloud',
    });
  });

  it('retry after audit-emit failure re-fires DDNS release + audit + removes cert (idempotent)', async () => {
    const store = buildStore();
    await uploadProAcmeRow(store, 'alice.recued.cloud');
    const ddns = buildDdnsStub();
    const effects = buildAuditStub();
    effects.setFailure(new Error('transient'));

    await expect(
      proAcmeUnbind(
        { store, ddns, effects },
        { domain: 'alice.recued.cloud', unbound_by_client_id: 'paired-1' },
      ),
    ).rejects.toThrow();

    // Operator clears the underlying audit problem + retries.
    effects.setFailure(null);
    const retry = await proAcmeUnbind(
      { store, ddns, effects },
      { domain: 'alice.recued.cloud', unbound_by_client_id: 'paired-1' },
    );

    expect(retry.ok).toBe(true);
    // Two DDNS release calls (idempotent at the cloud side).
    expect(ddns.releaseCalls).toHaveLength(2);
    // One successful audit row (the failed first attempt left nothing
    // persisted).
    expect(effects.rows).toHaveLength(1);
    expect(store.list().map((e) => e.domain)).not.toContain(
      'alice.recued.cloud',
    );
  });
});

// ────────────────────────────────────────────────────────────────
// rpc handler — wire validation + result mapping
// ────────────────────────────────────────────────────────────────

describe('D-148 FU5 rpc handler — `pro_acme.unbind`', () => {
  let store: SqliteTlsDomainStore;
  let ddns: DdnsStub;
  let effects: AuditStub;
  let deps: ProAcmeRpcDeps;

  beforeEach(async () => {
    store = buildStore();
    await uploadProAcmeRow(store, 'alice.recued.cloud');
    ddns = buildDdnsStub();
    effects = buildAuditStub();
    deps = {
      getOptions: () => ({ store, ddns, effects }),
    };
  });

  it('rejects unregistered caller with permission_denied (403)', async () => {
    try {
      await handleProAcmeUnbind(
        deps,
        { domain: 'alice.recued.cloud' },
        { instance_id: null },
      );
      throw new Error('expected RpcError');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      const rpcErr = err as RpcError;
      expect(rpcErr.code).toBe('permission_denied');
      expect(rpcErr.status).toBe(403);
    }
  });

  it('rejects bad domain shape with bad_request (400)', async () => {
    try {
      await handleProAcmeUnbind(
        deps,
        { domain: 'https://alice.recued.cloud/path' },
        pairedCaller,
      );
      throw new Error('expected RpcError');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      const rpcErr = err as RpcError;
      expect(rpcErr.code).toBe('bad_request');
      expect(rpcErr.status).toBe(400);
    }
  });

  it('rejects empty domain with bad_request (400)', async () => {
    try {
      await handleProAcmeUnbind(deps, { domain: '' }, pairedCaller);
      throw new Error('expected RpcError');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe('bad_request');
    }
  });

  it('rejects non-string reason with bad_request (400)', async () => {
    try {
      await handleProAcmeUnbind(
        deps,
        { domain: 'alice.recued.cloud', reason: 42 },
        pairedCaller,
      );
      throw new Error('expected RpcError');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe('bad_request');
    }
  });

  it('happy path returns { released, domain, handle } from the wire', async () => {
    const result = await handleProAcmeUnbind(
      deps,
      { domain: 'alice.recued.cloud' },
      pairedCaller,
    );
    expect(result).toEqual({
      released: true,
      domain: 'alice.recued.cloud',
      handle: 'alice',
    });
  });

  it('threads operator reason through the substrate', async () => {
    await handleProAcmeUnbind(
      deps,
      { domain: 'alice.recued.cloud', reason: 'subscription lapse' },
      pairedCaller,
    );
    expect(ddns.releaseCalls).toEqual([
      { handle: 'alice', reason: 'subscription lapse' },
    ]);
    expect(effects.rows[0]).toMatchObject({ reason: 'subscription lapse' });
  });

  it('pro_acme_not_found surfaces as RpcError(pro_acme_not_found, 404)', async () => {
    try {
      await handleProAcmeUnbind(
        deps,
        { domain: 'never-existed.recued.cloud' },
        pairedCaller,
      );
      throw new Error('expected RpcError');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      const rpcErr = err as RpcError;
      expect(rpcErr.code).toBe('pro_acme_not_found');
      expect(rpcErr.status).toBe(404);
    }
  });

  it('pro_acme_ddns_release_failed surfaces as RpcError(503)', async () => {
    ddns.setFailure(new Error('cloud unreachable'));
    try {
      await handleProAcmeUnbind(
        deps,
        { domain: 'alice.recued.cloud' },
        pairedCaller,
      );
      throw new Error('expected RpcError');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      const rpcErr = err as RpcError;
      expect(rpcErr.code).toBe('pro_acme_ddns_release_failed');
      expect(rpcErr.status).toBe(503);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Slice factory
// ────────────────────────────────────────────────────────────────

describe('D-148 FU5 slice factory — `makeProAcmeHandlers`', () => {
  it('returns undefined when deps is undefined', () => {
    expect(makeProAcmeHandlers(undefined)).toBeUndefined();
  });

  it('returns a slice listing exactly the `pro_acme.unbind` method', () => {
    const store = buildStore();
    const slice = makeProAcmeHandlers({
      getOptions: () => ({
        store,
        ddns: buildDdnsStub(),
        effects: buildAuditStub(),
      }),
    });
    expect(slice).toBeDefined();
    expect(slice!.methods).toEqual(['pro_acme.unbind']);
    expect(Object.keys(slice!.handlers)).toEqual(['pro_acme.unbind']);
  });
});

// ────────────────────────────────────────────────────────────────
// Codex W3.FU5 fold — source pins
// ────────────────────────────────────────────────────────────────
//
// Codex W3.FU5 review surfaced two P2 wiring gaps:
//
//   P2 #1 — ws-server.ts never composed `makeProAcmeHandlers` despite
//   `pro_acme.unbind` being listed in `SERVER_RPC_METHODS`. Without the
//   slice flowing through `composeHandlers`, the rpc dispatcher would
//   correctly return `not_configured` — but the Settings → Server
//   unbind flow would never reach `proAcmeUnbind` even when the
//   production `DdnsHandleControl` adapter lands.
//
//   P2 #2 — `pro_acme_unbound` was registered in `HIGH_ASSURANCE_AUDIT_KINDS`
//   on the contracts side but missing from `packages/storage/src/audit.ts`'s
//   `ActivityAction` union + `RESERVE_ACTIONS` set. Production audit-log
//   composition wouldn't accept the action without an unsafe cast.
//
// The fold adds:
//   - `ProAcmeRpcDeps` to `AttachWebSocketOptions` + threads the slice
//     into `composeHandlers` (ws-server.ts).
//   - `pro_acme_unbound` to the storage-side `ActivityAction` union +
//     `RESERVE_ACTIONS` set (packages/storage/src/audit.ts).
//
// Source-pin tests below ratchet the wiring against regression.

describe('D-148 FU5 Codex P2 #1 fold — ws-server.ts wiring', () => {
  it('ws-server.ts imports `makeProAcmeHandlers` + `ProAcmeRpcDeps`', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    // Resolve relative to the project root; the test runs under
    // `backend/server` but vitest's cwd is the repo root.
    const wsServerPath = path.resolve(
      process.cwd(),
      'backend/server/src/ws-server.ts',
    );
    const source = await fs.readFile(wsServerPath, 'utf-8');
    expect(source).toContain("from './pro-acme-handler.js'");
    expect(source).toContain('makeProAcmeHandlers');
    expect(source).toContain('ProAcmeRpcDeps');
  });

  it('ws-server.ts threads `proAcmeDeps` into the composer', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const wsServerPath = path.resolve(
      process.cwd(),
      'backend/server/src/ws-server.ts',
    );
    const source = await fs.readFile(wsServerPath, 'utf-8');
    expect(source).toContain('proAcmeDeps');
    expect(source).toContain('makeProAcmeHandlers(proAcmeDeps)');
  });
});

describe('D-148 FU5 Codex P2 #2 fold — storage taxonomy parity', () => {
  it('packages/storage/src/audit.ts carries `pro_acme_unbound` in ActivityAction', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const storageAuditPath = path.resolve(
      process.cwd(),
      'packages/storage/src/audit.ts',
    );
    const source = await fs.readFile(storageAuditPath, 'utf-8');
    expect(source).toContain("'pro_acme_unbound'");
  });

  it('packages/storage/src/audit.ts adds `pro_acme_unbound` to RESERVE_ACTIONS', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const storageAuditPath = path.resolve(
      process.cwd(),
      'packages/storage/src/audit.ts',
    );
    const source = await fs.readFile(storageAuditPath, 'utf-8');
    // Ratchet the RESERVE_ACTIONS membership by source pin (the storage
    // package isn't directly importable from backend/server tests
    // without crossing the `packages/` → `backend/server/` import
    // direction we keep one-way). The pin asserts the literal lands in
    // the RESERVE_ACTIONS set definition.
    const reserveSection = source.slice(
      source.indexOf('RESERVE_ACTIONS'),
      source.indexOf('isReserveAction'),
    );
    expect(reserveSection).toContain("'pro_acme_unbound'");
  });
});
