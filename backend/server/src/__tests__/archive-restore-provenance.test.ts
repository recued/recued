/** M5 S1 — import-side restore provenance: stage marker + post-restart commit.
 *
 *  Covers the two halves of `archive/restore-provenance.ts`:
 *   - `stageRestoreProvenanceMarker` — replace-or-CLEAR-FIRST: writes this
 *     restore's passport, OR drops a prior restore's stale marker when this
 *     archive carries no (parseable) passport (Codex S1 HIGH), and degrades a
 *     write FAILURE to no-marker rather than stale-marker (Codex S1 MEDIUM,
 *     pinned with an injected `writeFileSync` failure).
 *   - `commitRestoreProvenanceAtBoot` — records the old→new lineage from a
 *     real signed passport, no-ops on a same-identity (same-realm) restore,
 *     and is fail-open: it CLEARS the marker in every outcome (recorded /
 *     same_identity / verification reject / thrown error) and never throws.
 *
 *  Uses REAL passport crypto (no mock of the verified `commitImportedPassport`,
 *  which is exhaustively covered in `r26-4-passport-import.test.ts`) so the
 *  marker JSON round-trip is proven to preserve a verifiable passport. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Wrap `writeFileSync` so one test can deterministically simulate a marker
// write failure (ENOSPC / EACCES) while every other fs op passes through.
let failWrites = false;
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (failWrites) throw new Error('ENOSPC: simulated marker write failure');
      return actual.writeFileSync(...args);
    },
  };
});

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  KeyHealthBundle,
  PathRole,
  ServerCapabilityProfile,
  ServerPassportIdentityBlock,
  ServerPassportNetworkBlock,
  ServerPassportProjection,
  ServerPassportRecoveryBlock,
} from '@recued/contracts';
import { canonicalJSONStringify } from '@recued/contracts';
import type { ActivityEntry } from '@recued/storage';

import {
  ed25519Sign,
  generateEd25519Keypair,
  type Ed25519Keypair,
} from '../keys/index.js';
import {
  exportServerPassport,
  type PassportAuditEmitter,
  type PassportBlockProviders,
} from '../passport/index.js';
import {
  RESTORE_PROVENANCE_IMPORTED_BY,
  commitRestoreProvenanceAtBoot,
  restoreProvenanceMarkerPath,
  stageRestoreProvenanceMarker,
} from '../archive/restore-provenance.js';

// ────────────────────────────────────────────────────────────────
// Passport fixtures (minimal; mirror r26-4-passport-import.test.ts)
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
): PassportBlockProviders => {
  const identity: ServerPassportIdentityBlock = {
    server_public_key: ik.public_key_b64,
    server_identity_fingerprint: ik.public_key_fingerprint,
    publisher_id: ik.public_key_fingerprint,
    current_handle: 'alice',
    handle_history: [{ handle: 'alice', reserved_at: 1_700_000_000_000 }],
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

/** Mint a signed `migration_full` passport (signed by `ik`). */
const mkPassport = (
  ik: Ed25519Keypair,
  pk: Ed25519Keypair,
): Promise<ServerPassportProjection> =>
  exportServerPassport({
    providers: mkProviders(ik, pk),
    serverIdentity: ik,
    audit: { log: () => {} },
    exported_by_client_id: 'archive-embed',
    options: { profile: 'migration_full' },
    now: () => 1_700_000_000_000,
    mintId: () => 'passport-uuid-1',
  });

/** Re-sign a projection with an arbitrary key (to forge a bad signature). */
const resign = (
  p: ServerPassportProjection,
  key: Ed25519Keypair,
): ServerPassportProjection => {
  const { signature: _drop, ...unsigned } = p;
  const signature = ed25519Sign(key, canonicalJSONStringify(unsigned));
  return { ...unsigned, signature } as ServerPassportProjection;
};

const passportBytes = (p: ServerPassportProjection): Buffer =>
  Buffer.from(JSON.stringify(p), 'utf8');

const collectingAudit = (): { audit: PassportAuditEmitter; rows: ActivityEntry[] } => {
  const rows: ActivityEntry[] = [];
  return { audit: { log: (e) => { rows.push({ ...e }); } }, rows };
};

// ────────────────────────────────────────────────────────────────

let dir: string;
beforeEach(() => {
  failWrites = false;
  dir = mkdtempSync(join(tmpdir(), 'recued-restore-prov-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A stand-in "passport" buffer for stage-only tests (the stager doesn't verify
// — it just embeds the parsed object; only the boot commit verifies).
const fakePassportBytes = (tag: string): Buffer =>
  Buffer.from(JSON.stringify({ tag, profile: 'migration_full' }), 'utf8');

describe('stageRestoreProvenanceMarker', () => {
  it('writes a marker carrying the passport + a restored_at stamp', () => {
    stageRestoreProvenanceMarker(dir, fakePassportBytes('A'), { now: () => 1_111 });
    const markerPath = restoreProvenanceMarkerPath(dir);
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    expect(marker.v).toBe(1);
    expect(marker.restored_at).toBe(1_111);
    expect(marker.passport.tag).toBe('A');
  });

  it('replaces an existing marker with the newer restore passport', () => {
    stageRestoreProvenanceMarker(dir, fakePassportBytes('A'), { now: () => 1 });
    stageRestoreProvenanceMarker(dir, fakePassportBytes('B'), { now: () => 2 });
    const marker = JSON.parse(readFileSync(restoreProvenanceMarkerPath(dir), 'utf8'));
    expect(marker.passport.tag).toBe('B');
    expect(marker.restored_at).toBe(2);
  });

  it('CLEARS a prior marker when the new restore carries no passport (Codex S1 HIGH)', () => {
    stageRestoreProvenanceMarker(dir, fakePassportBytes('A'));
    expect(existsSync(restoreProvenanceMarkerPath(dir))).toBe(true);
    // A second committed restore from a no-passport archive must not leave the
    // FIRST archive's passport behind for the boot to record.
    stageRestoreProvenanceMarker(dir, undefined);
    expect(existsSync(restoreProvenanceMarkerPath(dir))).toBe(false);
  });

  it('CLEARS a prior marker when the new passport is unparseable, without throwing', () => {
    stageRestoreProvenanceMarker(dir, fakePassportBytes('A'));
    const warn = vi.fn();
    expect(() =>
      stageRestoreProvenanceMarker(dir, Buffer.from('not json {{', 'utf8'), { warn }),
    ).not.toThrow();
    expect(existsSync(restoreProvenanceMarkerPath(dir))).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('is a no-op (no marker, no throw) when there is no passport and no prior marker', () => {
    expect(() => stageRestoreProvenanceMarker(dir, undefined)).not.toThrow();
    expect(existsSync(restoreProvenanceMarkerPath(dir))).toBe(false);
  });

  it('a with-passport write FAILURE leaves no stale prior marker (Codex S1 MEDIUM)', () => {
    // Prior committed restore A leaves a marker.
    stageRestoreProvenanceMarker(dir, fakePassportBytes('A'), { now: () => 1 });
    expect(existsSync(restoreProvenanceMarkerPath(dir))).toBe(true);
    // Restore B (with passport) but the marker write fails. Clear-first unlinks
    // A's marker BEFORE the failing write, so the outcome is NO provenance
    // rather than A's stale passport committed against B's db.
    const warn = vi.fn();
    failWrites = true;
    expect(() =>
      stageRestoreProvenanceMarker(dir, fakePassportBytes('B'), { now: () => 2, warn }),
    ).not.toThrow();
    failWrites = false;
    expect(existsSync(restoreProvenanceMarkerPath(dir))).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe('commitRestoreProvenanceAtBoot', () => {
  it('is a no-op when no marker is present (audit untouched)', async () => {
    const { audit, rows } = collectingAudit();
    const liveKey = generateEd25519Keypair('server_identity_key');
    await commitRestoreProvenanceAtBoot({
      dataPath: dir,
      serverIdentity: () => liveKey,
      audit,
    });
    expect(rows).toHaveLength(0);
  });

  it('records the old→new lineage from a staged passport, then clears the marker', async () => {
    const oldKey = generateEd25519Keypair('server_identity_key');
    const pubKey = generateEd25519Keypair('publisher_identity_key');
    const liveKey = generateEd25519Keypair('server_identity_key');
    const passport = await mkPassport(oldKey, pubKey);
    stageRestoreProvenanceMarker(dir, passportBytes(passport), { now: () => 1 });

    const { audit, rows } = collectingAudit();
    await commitRestoreProvenanceAtBoot({
      dataPath: dir,
      serverIdentity: () => liveKey,
      audit,
      now: () => 4_242,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('passport.imported');
    expect(rows[0]?.target).toBe('passport-uuid-1');
    expect(rows[0]?.timestamp).toBe(4_242);
    expect(rows[0]?.detail).toContain(`imported_by=${RESTORE_PROVENANCE_IMPORTED_BY}`);
    expect(rows[0]?.detail).toContain(`prev_publisher_id=${oldKey.public_key_fingerprint}`);
    expect(rows[0]?.detail).toContain(`new_publisher_id=${liveKey.public_key_fingerprint}`);
    // Marker cleared after a successful commit.
    expect(existsSync(restoreProvenanceMarkerPath(dir))).toBe(false);
  });

  it('a same-identity (same-realm) restore is a no-op + clears the marker silently', async () => {
    const sameKey = generateEd25519Keypair('server_identity_key');
    const pubKey = generateEd25519Keypair('publisher_identity_key');
    const passport = await mkPassport(sameKey, pubKey);
    stageRestoreProvenanceMarker(dir, passportBytes(passport));

    const { audit, rows } = collectingAudit();
    const warn = vi.fn();
    await commitRestoreProvenanceAtBoot({
      dataPath: dir,
      serverIdentity: () => sameKey, // live identity == passport's identity
      audit,
      warn,
    });
    expect(rows).toHaveLength(0); // no false lineage row
    expect(warn).not.toHaveBeenCalled(); // same_identity is a silent no-op
    expect(existsSync(restoreProvenanceMarkerPath(dir))).toBe(false);
  });

  it('clears the marker + does not record on a verification reject (forged signature)', async () => {
    const oldKey = generateEd25519Keypair('server_identity_key');
    const pubKey = generateEd25519Keypair('publisher_identity_key');
    const liveKey = generateEd25519Keypair('server_identity_key');
    const wrongKey = generateEd25519Keypair('server_identity_key');
    const passport = await mkPassport(oldKey, pubKey);
    // server_public_key stays oldKey's but signed by wrongKey → signature_invalid.
    stageRestoreProvenanceMarker(dir, passportBytes(resign(passport, wrongKey)));

    const { audit, rows } = collectingAudit();
    const warn = vi.fn();
    await commitRestoreProvenanceAtBoot({
      dataPath: dir,
      serverIdentity: () => liveKey,
      audit,
      warn,
    });
    expect(rows).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    expect(existsSync(restoreProvenanceMarkerPath(dir))).toBe(false);
  });

  it('clears the marker + does not throw on a malformed marker (unrecognised version)', async () => {
    writeFileSync(
      restoreProvenanceMarkerPath(dir),
      JSON.stringify({ v: 99, passport: { junk: true } }),
      'utf8',
    );
    const { audit, rows } = collectingAudit();
    const liveKey = generateEd25519Keypair('server_identity_key');
    const warn = vi.fn();
    await expect(
      commitRestoreProvenanceAtBoot({
        dataPath: dir,
        serverIdentity: () => liveKey,
        audit,
        warn,
      }),
    ).resolves.toBeUndefined();
    expect(rows).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    expect(existsSync(restoreProvenanceMarkerPath(dir))).toBe(false);
  });

  it('is fail-open: clears the marker + does not throw when the audit sink throws', async () => {
    const oldKey = generateEd25519Keypair('server_identity_key');
    const pubKey = generateEd25519Keypair('publisher_identity_key');
    const liveKey = generateEd25519Keypair('server_identity_key');
    const passport = await mkPassport(oldKey, pubKey);
    stageRestoreProvenanceMarker(dir, passportBytes(passport));

    const throwingAudit: PassportAuditEmitter = {
      log: () => { throw new Error('audit store down'); },
    };
    const warn = vi.fn();
    await expect(
      commitRestoreProvenanceAtBoot({
        dataPath: dir,
        serverIdentity: () => liveKey,
        audit: throwingAudit,
        warn,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    // Never wedge / never infinite-retry: the marker is cleared even on error.
    expect(existsSync(restoreProvenanceMarkerPath(dir))).toBe(false);
  });
});
