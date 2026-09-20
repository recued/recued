/** R26.4 Delta 5 (D-148 § A.9 import half) — passport import commit.
 *
 *  Covers the genuinely-missing migration half (model A re-anchor):
 *   - `previewImportPassport` fingerprint binding (Codex Δ5 #1): the claimed
 *     `server_identity_fingerprint` must equal the fingerprint of the key
 *     that actually signed — defeats a forged-but-validly-signed passport.
 *   - `verifyServerPassport` null-safety (Codex Δ5 #2): a `null` identity
 *     block returns a clean `{ ok: false }`, never a TypeError.
 *   - `commitImportedPassport`: verified-fingerprint provenance, the
 *     self-import guard, `handle_reanchor_pending`, audit emission, and the
 *     no-audit-on-rejection invariant.
 *   - `handlePassportImport` / `makePassportImportHandlers`: malformed-input
 *     RpcError vs verification `{ ok: false }`, the loadHandleState seam, and
 *     slice dispatch. */

import { describe, it, expect } from 'vitest';
import {
  RpcError,
  canonicalJSONStringify,
  type KeyHealthBundle,
  type PathRole,
  type ServerCapabilityProfile,
  type ServerPassportIdentityBlock,
  type ServerPassportNetworkBlock,
  type ServerPassportProjection,
  type ServerPassportRecoveryBlock,
} from '@recued/contracts';
import type { ActivityEntry } from '@recued/storage';
import {
  ed25519Sign,
  generateEd25519Keypair,
  type Ed25519Keypair,
} from '../keys/index.js';
import {
  commitImportedPassport,
  exportServerPassport,
  previewImportPassport,
  verifyServerPassport,
  type PassportAuditEmitter,
  type PassportBlockProviders,
} from '../passport/index.js';
import {
  handlePassportImport,
  makePassportImportHandlers,
  type PassportImportRpcDeps,
} from '../passport/import-handler.js';
import type { WsClient } from '../ws-server.js';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const PER_PATH: ServerPassportNetworkBlock['per_path'] = {
  health: { resolution: { lan: true, public: false } },
  ws: { resolution: { lan: true, public: false } },
  mcp: { resolution: { lan: true, public: false } },
  llm_gateway: { resolution: { lan: true, public: false } },
  webhooks: { resolution: { lan: false, public: false } },
  reception: { resolution: { lan: false, public: false } },
  oauth: { resolution: { lan: false, public: false } },
  ask: { resolution: { lan: false, public: false } },
  webclient: { resolution: { lan: true, public: false } },
} as Record<PathRole, { resolution: { lan: boolean; public: boolean } }>;

const KEY_HEALTH: KeyHealthBundle = {
  master_dek: { status: 'healthy' },
  sub_dek: { status: 'healthy' },
  server_identity_key: { status: 'healthy' },
  publisher_identity_key: { status: 'healthy' },
  tls_private_key: { status: 'healthy' },
  webclient_token: { status: 'healthy' },
  webhook_secret: { status: 'healthy' },
};

const CAPABILITIES: ServerCapabilityProfile = {
  software_version: 'recued',
  os: 'linux',
  arch: 'x64',
  storage_size_bytes: 0,
  ai_pool_configured: false,
  byok_slots_configured: 0,
  scheduled_recipes_count: 0,
  reactive_recipes_count: 0,
  installed_packs: [],
  connections: [],
};

const RECOVERY: ServerPassportRecoveryBlock = {
  backup_status: 'unconfigured',
  filevault_recovery_key_status: 'absent',
};

const mkProviders = (
  ik: Ed25519Keypair,
  pk: Ed25519Keypair,
  opts?: {
    publisher_id?: string;
    handle?: string;
    handle_history?: ServerPassportIdentityBlock['handle_history'];
  },
): PassportBlockProviders => {
  const identity: ServerPassportIdentityBlock = {
    server_public_key: ik.public_key_b64,
    server_identity_fingerprint: ik.public_key_fingerprint,
    // D-175: publisher_id == server fingerprint. Default to it so the fixture
    // is contract-correct (the commit records the VERIFIED fingerprint, so
    // this field's value never reaches the provenance row regardless).
    publisher_id: opts?.publisher_id ?? ik.public_key_fingerprint,
    current_handle: opts?.handle ?? 'alice',
    handle_history: opts?.handle_history ?? [
      { handle: 'alice', reserved_at: 1_700_000_000_000 },
    ],
    publisher_identity_fingerprint: pk.public_key_fingerprint,
  };
  const network: ServerPassportNetworkBlock = {
    lan_urls: [],
    cert_fingerprint: 'sha256:cert',
    cert_expires_at: 1_800_000_000_000,
    derived_preset_label: 'lan_only',
    public_mcp_acknowledgement: { acknowledged: false },
    per_path: PER_PATH,
  };
  return {
    loadIdentity: () => identity,
    loadNetwork: () => network,
    loadClients: () => [],
    loadCapabilities: () => CAPABILITIES,
    loadRecovery: () => RECOVERY,
    loadKeyHealth: () => KEY_HEALTH,
  };
};

/** Mint a signed `migration_full` passport (signed by `ik`, fixed id/clock). */
const mkPassport = async (
  ik: Ed25519Keypair,
  pk: Ed25519Keypair,
  opts?: Parameters<typeof mkProviders>[2],
): Promise<ServerPassportProjection> =>
  exportServerPassport({
    providers: mkProviders(ik, pk, opts),
    serverIdentity: ik,
    audit: { log: () => {} },
    exported_by_client_id: 'wc_exporter',
    options: { profile: 'migration_full' },
    now: () => 1_700_000_000_000,
    mintId: () => 'passport-uuid-1',
  });

/** Re-sign a (possibly tampered) projection with an arbitrary key — used to
 *  isolate the fingerprint-binding check from the signature check. */
const resign = (
  p: ServerPassportProjection,
  key: Ed25519Keypair,
): ServerPassportProjection => {
  const { signature: _drop, ...unsigned } = p;
  const signature = ed25519Sign(key, canonicalJSONStringify(unsigned));
  return { ...unsigned, signature } as ServerPassportProjection;
};

const collectingAudit = (): { audit: PassportAuditEmitter; rows: ActivityEntry[] } => {
  const rows: ActivityEntry[] = [];
  return { audit: { log: (e) => { rows.push({ ...e }); } }, rows };
};

const ctx = { instance_id: 'wc_42' } as unknown as WsClient;

// ────────────────────────────────────────────────────────────────
// previewImportPassport — fingerprint binding (Codex Δ5 #1)
// ────────────────────────────────────────────────────────────────

describe('previewImportPassport — fingerprint binding', () => {
  it('accepts a well-formed migration_full passport', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const passport = await mkPassport(ik, pk);
    const r = previewImportPassport(passport);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.current_handle).toBe('alice');
      expect(r.handle_history).toHaveLength(1);
      expect(r.publisher_identity_fingerprint).toBe(pk.public_key_fingerprint);
    }
  });

  it('rejects a passport forged with a different key claiming a victim fingerprint', async () => {
    // THE attack: attacker signs with their OWN key but claims the victim's
    // server_identity_fingerprint. Signature verifies (key = attacker's
    // server_public_key), but the recomputed fingerprint of that key ≠ the
    // claimed victim fingerprint.
    const victim = generateEd25519Keypair('server_identity_key');
    const attacker = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const legit = await mkPassport(victim, pk); // server_identity_fingerprint = victim.fp
    const forged = resign(
      {
        ...legit,
        identity: {
          ...(legit.identity as ServerPassportIdentityBlock),
          server_public_key: attacker.public_key_b64, // attacker's key…
          // …but server_identity_fingerprint stays victim.fp (the lie)
        },
      } as ServerPassportProjection,
      attacker,
    );
    expect(previewImportPassport(forged)).toMatchObject({
      ok: false,
      reason: 'identity_fingerprint_mismatch',
    });
  });

  it('rejects a tampered-fingerprint passport even when re-signed by the real key', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const legit = await mkPassport(ik, pk);
    const tampered = resign(
      {
        ...legit,
        identity: {
          ...(legit.identity as ServerPassportIdentityBlock),
          server_identity_fingerprint: 'sha256:deadbeef',
        },
      } as ServerPassportProjection,
      ik,
    );
    expect(previewImportPassport(tampered)).toMatchObject({
      ok: false,
      reason: 'identity_fingerprint_mismatch',
    });
  });

  it('rejects a tampered passport that was NOT re-signed at the signature layer (binding never reached)', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const legit = await mkPassport(ik, pk);
    const tampered = {
      ...legit,
      identity: {
        ...(legit.identity as ServerPassportIdentityBlock),
        server_identity_fingerprint: 'sha256:deadbeef',
      },
    } as ServerPassportProjection;
    expect(previewImportPassport(tampered)).toMatchObject({
      ok: false,
      reason: 'signature_invalid',
    });
  });

  it('rejects a non-migration_full profile before verifying', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const support = await exportServerPassport({
      providers: mkProviders(ik, pk),
      serverIdentity: ik,
      audit: { log: () => {} },
      exported_by_client_id: 'wc_exporter',
      options: { profile: 'support_redacted' },
    });
    expect(previewImportPassport(support)).toMatchObject({
      ok: false,
      reason: 'profile_not_migration_full',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// verifyServerPassport — null-safety (Codex Δ5 #2)
// ────────────────────────────────────────────────────────────────

describe('verifyServerPassport — null-safe identity block', () => {
  it('returns a clean failure (no throw) on a null identity block', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const legit = await mkPassport(ik, pk);
    const broken = { ...legit, identity: null } as unknown as ServerPassportProjection;
    let result: ReturnType<typeof verifyServerPassport> | undefined;
    expect(() => {
      result = verifyServerPassport(broken);
    }).not.toThrow();
    expect(result).toEqual({ ok: false, reason: 'identity_block_missing_public_key' });
  });
});

// ────────────────────────────────────────────────────────────────
// commitImportedPassport
// ────────────────────────────────────────────────────────────────

describe('commitImportedPassport', () => {
  it('records verified provenance + emits a passport.imported audit row', async () => {
    const oldKey = generateEd25519Keypair('server_identity_key');
    const pubKey = generateEd25519Keypair('publisher_identity_key');
    const liveKey = generateEd25519Keypair('server_identity_key');
    const passport = await mkPassport(oldKey, pubKey);
    const { audit, rows } = collectingAudit();

    const result = await commitImportedPassport({
      passport,
      serverIdentity: liveKey,
      audit,
      imported_by_client_id: 'wc_1',
      handleState: { publisher_id: oldKey.public_key_fingerprint, current_handle: 'alice' },
      now: () => 4242,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // previous identity = the VERIFIED fingerprint, not the raw publisher_id
      expect(result.previous_publisher_id).toBe(oldKey.public_key_fingerprint);
      expect(result.previous_server_fingerprint).toBe(oldKey.public_key_fingerprint);
      expect(result.new_publisher_id).toBe(liveKey.public_key_fingerprint);
      expect(result.current_handle).toBe('alice');
      expect(result.handle_history_count).toBe(1);
      expect(result.publisher_identity_fingerprint).toBe(pubKey.public_key_fingerprint);
      expect(result.handle_reanchor_pending).toBe(true);
      expect(result.passport_id).toBe('passport-uuid-1');
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('passport.imported');
    expect(rows[0]?.target).toBe('passport-uuid-1');
    expect(rows[0]?.timestamp).toBe(4242);
    expect(rows[0]?.detail).toContain('imported_by=wc_1');
    expect(rows[0]?.detail).toContain(`prev_publisher_id=${oldKey.public_key_fingerprint}`);
    expect(rows[0]?.detail).toContain(`new_publisher_id=${liveKey.public_key_fingerprint}`);
    expect(rows[0]?.detail).toContain('handle_reanchor_pending=true');
  });

  it('records the VERIFIED fingerprint as previous_publisher_id, never the raw (spoofable) publisher_id label', async () => {
    const oldKey = generateEd25519Keypair('server_identity_key');
    const pubKey = generateEd25519Keypair('publisher_identity_key');
    const liveKey = generateEd25519Keypair('server_identity_key');
    // A passport whose raw publisher_id LABEL diverges from the signing key's
    // fingerprint. The binding only verifies `server_identity_fingerprint`, so
    // this is accepted — and the provenance MUST record the verified
    // fingerprint, not the unconstrained label (Codex Δ6 #1 regression guard).
    const passport = await mkPassport(oldKey, pubKey, { publisher_id: 'pub_attacker_label' });
    const { audit, rows } = collectingAudit();
    const result = await commitImportedPassport({
      passport, serverIdentity: liveKey, audit, imported_by_client_id: 'x', handleState: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.previous_publisher_id).toBe(oldKey.public_key_fingerprint);
      expect(result.previous_publisher_id).not.toBe('pub_attacker_label');
      expect(result.previous_server_fingerprint).toBe(oldKey.public_key_fingerprint);
    }
    expect(rows[0]?.detail).toContain(`prev_publisher_id=${oldKey.public_key_fingerprint}`);
    expect(rows[0]?.detail).not.toContain('pub_attacker_label');
  });

  it('reports handle_reanchor_pending=false when the live handle already matches', async () => {
    const oldKey = generateEd25519Keypair('server_identity_key');
    const pubKey = generateEd25519Keypair('publisher_identity_key');
    const liveKey = generateEd25519Keypair('server_identity_key');
    const passport = await mkPassport(oldKey, pubKey);
    const { audit } = collectingAudit();
    const result = await commitImportedPassport({
      passport,
      serverIdentity: liveKey,
      audit,
      imported_by_client_id: 'wc_1',
      handleState: { publisher_id: liveKey.public_key_fingerprint, current_handle: 'alice' },
    });
    expect(result.ok && result.handle_reanchor_pending).toBe(false);
  });

  it('reports handle_reanchor_pending=false with no handle state or an empty handle', async () => {
    const oldKey = generateEd25519Keypair('server_identity_key');
    const pubKey = generateEd25519Keypair('publisher_identity_key');
    const liveKey = generateEd25519Keypair('server_identity_key');
    const passport = await mkPassport(oldKey, pubKey);
    const { audit } = collectingAudit();

    const noState = await commitImportedPassport({
      passport, serverIdentity: liveKey, audit, imported_by_client_id: 'x', handleState: null,
    });
    expect(noState.ok && noState.handle_reanchor_pending).toBe(false);

    const emptyHandle = await commitImportedPassport({
      passport, serverIdentity: liveKey, audit, imported_by_client_id: 'x',
      handleState: { publisher_id: oldKey.public_key_fingerprint, current_handle: '' },
    });
    expect(emptyHandle.ok && emptyHandle.handle_reanchor_pending).toBe(false);
  });

  it('refuses a self-import (passport describes the live identity) without auditing', async () => {
    const sameKey = generateEd25519Keypair('server_identity_key');
    const pubKey = generateEd25519Keypair('publisher_identity_key');
    const passport = await mkPassport(sameKey, pubKey);
    const { audit, rows } = collectingAudit();
    const result = await commitImportedPassport({
      passport, serverIdentity: sameKey, audit, imported_by_client_id: 'x', handleState: null,
    });
    expect(result).toEqual({ ok: false, reason: 'same_identity' });
    expect(rows).toHaveLength(0);
  });

  it('propagates a verification failure without auditing', async () => {
    const oldKey = generateEd25519Keypair('server_identity_key');
    const pubKey = generateEd25519Keypair('publisher_identity_key');
    const liveKey = generateEd25519Keypair('server_identity_key');
    const wrongKey = generateEd25519Keypair('server_identity_key');
    const passport = await mkPassport(oldKey, pubKey);
    // server_public_key stays oldKey's, but signed by wrongKey → signature_invalid
    const badSig = resign(passport, wrongKey);
    const { audit, rows } = collectingAudit();
    const result = await commitImportedPassport({
      passport: badSig, serverIdentity: liveKey, audit, imported_by_client_id: 'x', handleState: null,
    });
    expect(result).toMatchObject({ ok: false, reason: 'signature_invalid' });
    expect(rows).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// handlePassportImport + makePassportImportHandlers
// ────────────────────────────────────────────────────────────────

describe('handlePassportImport', () => {
  const mkDeps = (
    liveKey: Ed25519Keypair,
    rows: ActivityEntry[],
    handleState: { publisher_id: string; current_handle: string } | null,
  ): PassportImportRpcDeps => ({
    serverIdentity: () => liveKey,
    audit: { log: (e) => { rows.push({ ...e }); } },
    loadHandleState: async () => handleState,
    now: () => 999,
  });

  it('commits a valid passport + stamps the client id into the audit row', async () => {
    const oldKey = generateEd25519Keypair('server_identity_key');
    const pubKey = generateEd25519Keypair('publisher_identity_key');
    const liveKey = generateEd25519Keypair('server_identity_key');
    const passport = await mkPassport(oldKey, pubKey);
    const rows: ActivityEntry[] = [];
    const deps = mkDeps(liveKey, rows, {
      publisher_id: oldKey.public_key_fingerprint, current_handle: 'alice',
    });
    const r = await handlePassportImport(deps, { passport }, ctx);
    expect(r.ok).toBe(true);
    expect(r.ok && r.handle_reanchor_pending).toBe(true);
    expect(rows[0]?.detail).toContain('imported_by=wc_42');
  });

  it('throws RpcError(bad_request) on malformed input (null / missing passport)', async () => {
    const liveKey = generateEd25519Keypair('server_identity_key');
    const deps = mkDeps(liveKey, [], null);
    await expect(
      handlePassportImport(deps, { passport: null } as unknown as { passport: ServerPassportProjection }, ctx),
    ).rejects.toBeInstanceOf(RpcError);
    await expect(
      handlePassportImport(deps, {} as unknown as { passport: ServerPassportProjection }, ctx),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('returns a clean {ok:false} (not a throw) for a null identity block', async () => {
    const oldKey = generateEd25519Keypair('server_identity_key');
    const pubKey = generateEd25519Keypair('publisher_identity_key');
    const liveKey = generateEd25519Keypair('server_identity_key');
    const passport = await mkPassport(oldKey, pubKey);
    const deps = mkDeps(liveKey, [], null);
    const broken = { ...passport, identity: null } as unknown as ServerPassportProjection;
    const r = await handlePassportImport(deps, { passport: broken }, ctx);
    expect(r).toMatchObject({ ok: false, reason: 'identity_block_missing_public_key' });
  });

  it('makePassportImportHandlers gates on deps + dispatches passport.import', async () => {
    expect(makePassportImportHandlers(undefined)).toBeUndefined();
    const oldKey = generateEd25519Keypair('server_identity_key');
    const pubKey = generateEd25519Keypair('publisher_identity_key');
    const liveKey = generateEd25519Keypair('server_identity_key');
    const passport = await mkPassport(oldKey, pubKey);
    const slice = makePassportImportHandlers(mkDeps(liveKey, [], null));
    expect(slice?.methods).toEqual(['passport.import']);
    const r = await slice!.handlers['passport.import']({ passport }, ctx);
    expect(r.ok).toBe(true);
  });
});

/** R26.4 Δ5 — the identity-block gate, and the two documented Codex folds that
 *  had no test.
 *
 *  ⚠ FOUND BY MUTATION (2026-09-18). `previewImportPassport`'s
 *  `identity_block_incomplete` check is four separate conditions and NONE was
 *  pinned — every fixture ships a complete block, so the whole gate could be
 *  deleted green. Two of the survivors are fixes whose own comments describe
 *  the bug they closed, which is the pattern: a thorough fix comment marks the
 *  spot a test was never written.
 *
 *  ⚠ EACH CASE BREAKS ONE FIELD ON AN OTHERWISE-VALID PASSPORT and re-signs, so
 *  the signature check cannot be what refuses it. Without the re-sign every one
 *  of these would pass for the wrong reason. */
describe('R26.4 Δ5 — the imported identity block is validated field by field', () => {
  const brokenField = async (
    mutate: (id: Record<string, unknown>) => void,
  ): Promise<ReturnType<typeof previewImportPassport>> => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const passport = await mkPassport(ik, pk);
    const id = { ...(passport.identity as unknown as Record<string, unknown>) };
    mutate(id);
    return previewImportPassport(
      resign({ ...passport, identity: id } as unknown as ServerPassportProjection, ik),
    );
  };

  it('⛔ a missing or empty publisher_id is refused', async () => {
    for (const value of [undefined, '', 42]) {
      const out = await brokenField((id) => {
        if (value === undefined) delete id.publisher_id;
        else id.publisher_id = value;
      });
      expect(out.ok, `publisher_id=${JSON.stringify(value)} was imported`).toBe(false);
      if (!out.ok) expect(out.reason).toBe('identity_block_incomplete');
    }
  });

  it('⛔ a missing or empty publisher_identity_fingerprint is refused', async () => {
    // ⚠ EMPTY IS THE INTERESTING ONE. This is the independently-rotated
    // marketplace key (I-7) whose public key the passport does NOT carry, so it
    // can never be bound cryptographically — the only thing standing between a
    // blank claim and the provenance row is this length check.
    for (const value of [undefined, '']) {
      const out = await brokenField((id) => {
        if (value === undefined) delete id.publisher_identity_fingerprint;
        else id.publisher_identity_fingerprint = value;
      });
      expect(out.ok, `fingerprint=${JSON.stringify(value)} was imported`).toBe(false);
      if (!out.ok) expect(out.reason).toBe('identity_block_incomplete');
    }
  });

  it('⛔ a handle_history that is not an array is refused', async () => {
    // It is copied and walked downstream; a non-array reaches `.map` and throws
    // inside the commit path rather than refusing cleanly at the door.
    for (const value of [undefined, 'not-an-array', {}, null]) {
      const out = await brokenField((id) => {
        if (value === undefined) delete id.handle_history;
        else id.handle_history = value;
      });
      expect(out.ok, `handle_history=${JSON.stringify(value)} was imported`).toBe(false);
      if (!out.ok) expect(out.reason).toBe('identity_block_incomplete');
    }
  });

  it('⛔ a non-string current_handle is refused', async () => {
    const out = await brokenField((id) => { id.current_handle = 7; });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('identity_block_incomplete');
  });

  it('⛔ the returned handle_history does not ALIAS the caller’s objects', async () => {
    // The preview result is handed to the commit path, which records it as
    // provenance. Sharing the entries means a later edit to the uploaded
    // passport object rewrites what was recorded as proven history.
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const passport = await mkPassport(ik, pk);
    const out = previewImportPassport(passport);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const source = (passport.identity as unknown as {
      handle_history: Array<Record<string, unknown>>;
    }).handle_history;
    if (source.length === 0) return; // nothing to alias
    const before = JSON.stringify(out.handle_history[0]);
    source[0]!.handle = 'rewritten-after-preview';
    expect(
      JSON.stringify(out.handle_history[0]),
      'the preview shared its handle-history entries with the uploaded passport',
    ).toBe(before);
  });

  it('⛔ an UNHASHABLE public key is refused — by the SIGNATURE, before the binding', async () => {
    // ⛔ THE CLAIM IS NULL TOO, AND THAT IS THE WHOLE POINT. The binding reads
    // `signerFingerprint === null || signerFingerprint !== claimed`. With an
    // unhashable key the left side is null — and against a STRING claim the
    // right side already refuses, so a fixture claiming `'sha256:whatever'`
    // passes whether or not the null arm exists. Two rules agreeing again.
    //
    // ⚠ A NULL CLAIM IS REACHABLE: the `identity_block_incomplete` gate checks
    // publisher_id, current_handle, handle_history and
    // publisher_identity_fingerprint — NOT `server_identity_fingerprint` — so
    // an uploaded JSON carrying `null` there reaches the binding untouched.
    // Without the null arm, `null !== null` is false and the passport IMPORTS:
    // an unverifiable key bound to an empty claim, recorded as proven
    // provenance.
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const passport = await mkPassport(ik, pk);
    const id = { ...(passport.identity as unknown as Record<string, unknown>) };
    id.server_public_key = 'not-a-key';
    id.server_identity_fingerprint = null;
    const out = previewImportPassport(
      resign({ ...passport, identity: id } as unknown as ServerPassportProjection, ik),
    );
    expect(out.ok, 'an unhashable public key was bound to a null claim').toBe(false);
    // ⚠ AND THE REASON IS `signature_invalid`, NOT the binding's. Writing this
    // test is what showed why: `verifyServerPassport` runs FIRST and verifies
    // against `identity.server_public_key` itself, so a key the hasher cannot
    // process is also a key that cannot verify anything. ⇒ The binding's
    // `signerFingerprint === null` arm is UNREACHABLE — not redundant with a
    // neighbouring condition, but shadowed by an earlier gate. It stays as
    // defence for a future caller that binds without verifying first; no test
    // can distinguish it, and this one records why rather than pretending to.
    if (!out.ok) expect(out.reason).toBe('signature_invalid');
  });

  it('⚠ and a real key whose claimed fingerprint is simply WRONG is refused', async () => {
    // The complement, so the case above cannot pass under "nothing ever binds".
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const passport = await mkPassport(ik, pk);
    const id = { ...(passport.identity as unknown as Record<string, unknown>) };
    id.server_identity_fingerprint = 'sha256:' + 'f'.repeat(64);
    const out = previewImportPassport(
      resign({ ...passport, identity: id } as unknown as ServerPassportProjection, ik),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('identity_fingerprint_mismatch');
  });

  it('⛔ a MALFORMED signature reports a reason rather than throwing', async () => {
    // ⚠ Codex R26.4 Δ5 #2, with no test. A throw here surfaces through the rpc
    // layer as an opaque `internal` 500, which tells the operator nothing and
    // looks like a server fault rather than a bad upload.
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const passport = await mkPassport(ik, pk);
    const out = previewImportPassport({
      ...passport,
      signature: '!!!not-base64!!!',
    } as ServerPassportProjection);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(['signature_malformed', 'signature_invalid']).toContain(out.reason);
  });
});

