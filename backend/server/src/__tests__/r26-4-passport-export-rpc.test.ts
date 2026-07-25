/** R26.4 Delta 2 — `passport.export` + `passport.history.list` rpc handlers +
 *  the durable SQLite history store.
 *
 *  The user-initiated half of the passport surface (sibling to the
 *  `passport.fetch` cert-pin path). Covers: a deliberate export SIGNS a
 *  verifiable projection at the requested profile, EMITS the
 *  `passport.exported` high-assurance audit row, and APPENDS to the history
 *  store; profile / reason validation at the trust boundary; the unregistered-
 *  bearer attribution sentinel; history.list reads the store newest-first; the
 *  SQLite store's sort / limit-clamp / before-cursor behavior; and the
 *  absent-deps → undefined-slice gating. */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  SERVER_PASSPORT_PROFILES,
  PASSPORT_REASON_MAX_BYTES,
  RpcError,
  type KeyHealthBundle,
  type ServerCapabilityProfile,
  type ServerPassportIdentityBlock,
  type ServerPassportNetworkBlock,
  type ServerPassportProfile,
  type ServerPassportProjection,
  type ServerPassportRecoveryBlock,
} from '@recued/contracts';

import { generateEd25519Keypair, type Ed25519Keypair } from '../keys/index.js';
import {
  createInMemoryPassportHistoryStore,
  verifyServerPassport,
  type PassportAuditEmitter,
  type PassportBlockProviders,
  type PassportHistoryEntry,
} from '../passport/index.js';
import {
  handlePassportExport,
  handlePassportHistoryList,
  makePassportExportHandlers,
  makePassportHistoryListHandlers,
  type PassportExportRpcDeps,
} from '../passport/export-handler.js';
import { createSqlitePassportHistoryStore } from '../passport/history-store.js';
import type { WsClient } from '../ws-server.js';
import type { ActivityEntry } from '@recued/storage';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const makeProviders = (
  identityKey: Ed25519Keypair,
  publisherKey: Ed25519Keypair,
): PassportBlockProviders => {
  const identity: ServerPassportIdentityBlock = {
    server_public_key: identityKey.public_key_b64,
    server_identity_fingerprint: identityKey.public_key_fingerprint,
    publisher_id: 'pub_alice',
    current_handle: 'alice',
    handle_history: [{ handle: 'alice', reserved_at: 1_700_000_000_000 }],
    publisher_identity_fingerprint: publisherKey.public_key_fingerprint,
  };
  const network: ServerPassportNetworkBlock = {
    lan_urls: ['https://192.168.1.5:8443'],
    cert_fingerprint: 'sha256:abc',
    cert_expires_at: 1_800_000_000_000,
    derived_preset_label: 'lan_only',
    public_mcp_acknowledgement: { acknowledged: false },
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
  };
  const capabilities: ServerCapabilityProfile = {
    software_version: 'recued',
    os: 'darwin',
    arch: 'arm64',
    storage_size_bytes: 0,
    ai_pool_configured: false,
    byok_slots_configured: 0,
    scheduled_recipes_count: 0,
    reactive_recipes_count: 0,
    installed_packs: [],
    connections: [],
  };
  const recovery: ServerPassportRecoveryBlock = {
    backup_status: 'unconfigured',
    filevault_recovery_key_status: 'absent',
  };
  const key_health: KeyHealthBundle = {
    master_dek: { status: 'healthy' },
    sub_dek: { status: 'healthy' },
    server_identity_key: { status: 'healthy' },
    publisher_identity_key: { status: 'healthy' },
    tls_private_key: { status: 'healthy' },
    webclient_token: { status: 'healthy' },
    webhook_secret: { status: 'healthy' },
  };
  return {
    loadIdentity: () => identity,
    loadNetwork: () => network,
    loadClients: () => [],
    loadCapabilities: () => capabilities,
    loadRecovery: () => recovery,
    loadKeyHealth: () => key_health,
  };
};

const makeAudit = (): { emitter: PassportAuditEmitter; rows: ActivityEntry[] } => {
  const rows: ActivityEntry[] = [];
  return { emitter: { log: (e) => void rows.push({ ...e }) }, rows };
};

const makeExportDeps = (
  overrides?: Partial<PassportExportRpcDeps>,
): {
  deps: PassportExportRpcDeps;
  identityKey: Ed25519Keypair;
  audit: ActivityEntry[];
} => {
  const identityKey = generateEd25519Keypair('server_identity_key');
  const publisherKey = generateEd25519Keypair('publisher_identity_key');
  const { emitter, rows } = makeAudit();
  const deps: PassportExportRpcDeps = {
    providers: makeProviders(identityKey, publisherKey),
    serverIdentity: () => identityKey,
    audit: emitter,
    history: createInMemoryPassportHistoryStore(),
    now: () => 1_700_003_000_000,
    mintId: () => 'passport-fixed-id',
    ...overrides,
  };
  return { deps, identityKey, audit: rows };
};

const ctx = (instance_id: string | null): WsClient =>
  ({ instance_id }) as unknown as WsClient;

// ────────────────────────────────────────────────────────────────
// Export handler
// ────────────────────────────────────────────────────────────────

describe('R26.4 Delta 2 — handlePassportExport', () => {
  it.each(SERVER_PASSPORT_PROFILES as ReadonlyArray<ServerPassportProfile>)(
    '%s: signs a verifiable projection',
    async (profile) => {
      const { deps } = makeExportDeps();
      const { passport } = await handlePassportExport(deps, { profile }, ctx('wc_1'));
      expect(passport.profile).toBe(profile);
      expect(verifyServerPassport(passport)).toEqual({ ok: true });
    },
  );

  it('support_redacted drops publisher_id + handle_history (keeps current_handle); migration_full carries the full lineage', async () => {
    const { deps } = makeExportDeps();

    // The privacy boundary the export-half wiring makes load-bearing: now that
    // loadIdentity emits a real publisher_id (server fingerprint) + handle
    // lineage, the support_redacted projection MUST still strip them — only
    // current_handle survives. (Guards a projection regression from leaking the
    // fingerprint/lineage now that real data rides behind it.)
    const redacted = (
      await handlePassportExport(deps, { profile: 'support_redacted' }, ctx('wc_1'))
    ).passport;
    if (redacted.profile !== 'support_redacted') {
      throw new Error('expected support_redacted projection');
    }
    expect(redacted.identity.current_handle).toBe('alice');
    expect(redacted.identity).not.toHaveProperty('publisher_id');
    expect(redacted.identity).not.toHaveProperty('handle_history');
    expect(redacted.identity).not.toHaveProperty('publisher_identity_fingerprint');

    // migration_full carries the full identity block — what a real server
    // migration consumes.
    const full = (
      await handlePassportExport(deps, { profile: 'migration_full' }, ctx('wc_1'))
    ).passport;
    if (full.profile !== 'migration_full') {
      throw new Error('expected migration_full projection');
    }
    expect(full.identity.publisher_id).toBe('pub_alice');
    expect(full.identity.handle_history).toEqual([
      { handle: 'alice', reserved_at: 1_700_000_000_000 },
    ]);
  });

  it('emits the passport.exported high-assurance audit row + appends history', async () => {
    const { deps, audit } = makeExportDeps();
    await handlePassportExport(
      deps,
      { profile: 'support_redacted', reason: 'ticket #7' },
      ctx('wc_1'),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('passport.exported');
    expect(audit[0]?.target).toBe('passport-fixed-id');
    expect(audit[0]?.detail).toContain('reason=ticket #7');
    const rows = await deps.history.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      passport_id: 'passport-fixed-id',
      profile: 'support_redacted',
      exported_at: 1_700_003_000_000,
      exported_by_client_id: 'wc_1',
      reason: 'ticket #7',
    });
  });

  it('attributes an unregistered bearer caller to the sentinel id', async () => {
    const { deps } = makeExportDeps();
    await handlePassportExport(deps, { profile: 'support_redacted' }, ctx(null));
    const rows = await deps.history.list();
    expect(rows[0]?.exported_by_client_id).toBe('webclient-bearer-unregistered');
  });

  it('rejects an unknown profile with bad_request — no audit, no history', async () => {
    const { deps, audit } = makeExportDeps();
    await expect(
      handlePassportExport(
        deps,
        { profile: 'totally_made_up' as ServerPassportProfile },
        ctx('wc_1'),
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(audit).toHaveLength(0);
    expect(await deps.history.list()).toHaveLength(0);
  });

  it('rejects an over-long reason with bad_request', async () => {
    const { deps } = makeExportDeps();
    const reason = 'x'.repeat(PASSPORT_REASON_MAX_BYTES + 1);
    await expect(
      handlePassportExport(deps, { profile: 'support_redacted', reason }, ctx('wc_1')),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('accepts a reason exactly at the byte ceiling', async () => {
    const { deps } = makeExportDeps();
    const reason = 'x'.repeat(PASSPORT_REASON_MAX_BYTES);
    const { passport } = await handlePassportExport(
      deps,
      { profile: 'support_redacted', reason },
      ctx('wc_1'),
    );
    expect(verifyServerPassport(passport)).toEqual({ ok: true });
  });
});

// ────────────────────────────────────────────────────────────────
// History-list handler
// ────────────────────────────────────────────────────────────────

describe('R26.4 Delta 2 — handlePassportHistoryList', () => {
  it('returns appended rows', async () => {
    const { deps } = makeExportDeps();
    await handlePassportExport(deps, { profile: 'support_redacted' }, ctx('wc_1'));
    const res = await handlePassportHistoryList({ history: deps.history }, {});
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.passport_id).toBe('passport-fixed-id');
  });

  it('forwards limit + before to the store', async () => {
    const history = createInMemoryPassportHistoryStore();
    const seed = (id: string, at: number): PassportHistoryEntry => ({
      passport_id: id,
      profile: 'support_redacted',
      exported_at: at,
      exported_by_client_id: 'wc_1',
      signer_fingerprint: 'fp',
    });
    await history.append(seed('a', 100));
    await history.append(seed('b', 200));
    await history.append(seed('c', 300));
    const all = await handlePassportHistoryList({ history }, {});
    expect(all.rows.map((r) => r.passport_id)).toEqual(['c', 'b', 'a']);
    const limited = await handlePassportHistoryList({ history }, { limit: 1 });
    expect(limited.rows.map((r) => r.passport_id)).toEqual(['c']);
    const before = await handlePassportHistoryList({ history }, { before: 300 });
    expect(before.rows.map((r) => r.passport_id)).toEqual(['b', 'a']);
  });
});

// ────────────────────────────────────────────────────────────────
// SQLite history store
// ────────────────────────────────────────────────────────────────

describe('R26.4 Delta 2 — createSqlitePassportHistoryStore', () => {
  const row = (id: string, at: number): PassportHistoryEntry => ({
    passport_id: id,
    profile: 'migration_full',
    exported_at: at,
    exported_by_client_id: 'wc_1',
    reason: `r-${id}`,
    signer_fingerprint: 'fp-1',
  });

  it('persists + lists newest-first across a fresh connection', async () => {
    const db = new Database(':memory:');
    const store = createSqlitePassportHistoryStore(db);
    await store.append(row('a', 100));
    await store.append(row('b', 300));
    await store.append(row('c', 200));
    const rows = await store.list();
    expect(rows.map((r) => r.passport_id)).toEqual(['b', 'c', 'a']);
    expect(rows[0]).toMatchObject({ passport_id: 'b', reason: 'r-b' });
    db.close();
  });

  it('clamps limit to [1, 200] + honors the before cursor', async () => {
    const db = new Database(':memory:');
    const store = createSqlitePassportHistoryStore(db);
    for (let i = 1; i <= 5; i++) await store.append(row(`p${i}`, i * 100));
    expect((await store.list({ limit: 2 })).map((r) => r.passport_id)).toEqual([
      'p5',
      'p4',
    ]);
    // limit clamps up from 0 to at least 1.
    expect(await store.list({ limit: 0 })).toHaveLength(1);
    // before excludes rows at/after the cursor.
    expect((await store.list({ before: 300 })).map((r) => r.passport_id)).toEqual([
      'p2',
      'p1',
    ]);
    db.close();
  });
});

// ────────────────────────────────────────────────────────────────
// Handler-slice gating
// ────────────────────────────────────────────────────────────────

describe('R26.4 Delta 2 — handler gating', () => {
  it('returns undefined slices when deps are absent', () => {
    expect(makePassportExportHandlers(undefined)).toBeUndefined();
    expect(makePassportHistoryListHandlers(undefined)).toBeUndefined();
  });

  it('registers the methods when deps are present', () => {
    const { deps } = makeExportDeps();
    expect(makePassportExportHandlers(deps)?.methods).toEqual(['passport.export']);
    expect(
      makePassportHistoryListHandlers({ history: deps.history })?.methods,
    ).toEqual(['passport.history.list']);
  });
});
