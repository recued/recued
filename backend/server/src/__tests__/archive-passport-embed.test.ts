/** M1 slice 3 — archive runtime embeds a signed identity passport.
 *
 *  Exercises `createArchiveRuntime.runExport` against the late-bound
 *  passport-export substrate: a real Ed25519 mint when the toggle is on +
 *  the substrate is present; nothing when it's off / unavailable / throws
 *  (graceful degradation — the passport is a rider, never a backup blocker).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { generateRecoveryKey } from '@recued/crypto';
import type {
  KeyHealthBundle,
  ServerCapabilityProfile,
  ServerPassportIdentityBlock,
  ServerPassportNetworkBlock,
  ServerPassportRecoveryBlock,
} from '@recued/contracts';

import { createArchiveRuntime } from '../archive/archive-runtime.js';
import { importArchive } from '../archive/archive-import.js';
import { verifyServerPassport, type PassportBlockProviders } from '../passport/index.js';
import { createInMemoryPassportHistoryStore } from '../passport/index.js';
import type { PassportExportRpcDeps } from '../passport/export-handler.js';
import { generateEd25519Keypair, type Ed25519Keypair } from '../keys/index.js';

const FIXED_NOW = 1_700_000_000_000;

/** Minimal-but-valid passport substrate (the migration_full projection
 *  reads every block, so all six providers return a real shape). */
const makeProviders = (
  identityKey: Ed25519Keypair,
  publisherKey: Ed25519Keypair,
): PassportBlockProviders => {
  const identity: ServerPassportIdentityBlock = {
    server_public_key: identityKey.public_key_b64,
    server_identity_fingerprint: identityKey.public_key_fingerprint,
    publisher_id: identityKey.public_key_fingerprint,
    current_handle: 'alice',
    handle_history: [{ handle: 'alice', reserved_at: FIXED_NOW }],
    publisher_identity_fingerprint: publisherKey.public_key_fingerprint,
  };
  const network: ServerPassportNetworkBlock = {
    lan_urls: [],
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

const makePassportExportDeps = (
  serverIdentity: () => Ed25519Keypair,
): PassportExportRpcDeps => {
  const identityKey = serverIdentity();
  const publisherKey = generateEd25519Keypair('publisher_identity_key');
  return {
    providers: makeProviders(identityKey, publisherKey),
    serverIdentity,
    audit: { log: () => { /* swallow */ } },
    history: createInMemoryPassportHistoryStore(),
  };
};

interface Harness {
  dir: string;
  mnemonic: string;
  entropy: Buffer;
  runtime: ReturnType<typeof createArchiveRuntime>;
  close(): void;
}

const newHarness = (
  getPassportExport?: () => PassportExportRpcDeps | undefined,
): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-passport-'));
  const dbPath = join(dir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE example (k TEXT PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO example VALUES (?, ?)').run('hello', 'world');
  const { mnemonic, entropy } = generateRecoveryKey();
  const runtime = createArchiveRuntime({
    db,
    dbPath,
    dataPath: dir,
    configPath: null,
    serverVersion: '0.2.0',
    now: () => FIXED_NOW,
    requestRestart: () => { /* unused */ },
    ...(getPassportExport ? { getPassportExport } : {}),
  });
  return {
    dir, mnemonic, entropy: Buffer.from(entropy), runtime,
    close() {
      try { db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

let h: Harness;
afterEach(() => { h?.close(); });

describe('archive passport embed', () => {
  it('embeds a verifiable migration_full passport when the toggle is on + substrate present', async () => {
    const identityKey = generateEd25519Keypair('server_identity_key');
    h = newHarness(() => makePassportExportDeps(() => identityKey));
    const res = await h.runtime.runExport({ includeBlobs: false, includePassport: true, recoveryKey: h.mnemonic });

    // Manifest flags the embed…
    const manifest = await h.runtime.readManifest(res.path, h.mnemonic);
    expect(manifest.includes_passport).toBe(true);

    // …and the embedded record is a real signed migration_full passport.
    const imported = await importArchive({ archivePath: res.path, recoveryKey: h.entropy, consumerVersion: '0.2.0' });
    expect(imported.passport).toBeDefined();
    const passport = JSON.parse(imported.passport!.toString('utf8'));
    expect(passport.profile).toBe('migration_full');
    expect(verifyServerPassport(passport)).toEqual({ ok: true });
  });

  it('omits the passport when the toggle is off', async () => {
    const identityKey = generateEd25519Keypair('server_identity_key');
    h = newHarness(() => makePassportExportDeps(() => identityKey));
    const res = await h.runtime.runExport({ includeBlobs: false, includePassport: false, recoveryKey: h.mnemonic });
    const manifest = await h.runtime.readManifest(res.path, h.mnemonic);
    expect(manifest.includes_passport).toBe(false);
  });

  it('omits the passport (still exports) when no substrate is wired', async () => {
    h = newHarness(); // no getPassportExport
    const res = await h.runtime.runExport({ includeBlobs: false, includePassport: true, recoveryKey: h.mnemonic });
    expect(existsSync(res.path)).toBe(true);
    const manifest = await h.runtime.readManifest(res.path, h.mnemonic);
    expect(manifest.includes_passport).toBe(false);
  });

  it('degrades gracefully — a mint failure does not fail the backup', async () => {
    h = newHarness(() =>
      makePassportExportDeps(() => { throw new Error('identity unavailable'); }),
    );
    const res = await h.runtime.runExport({ includeBlobs: false, includePassport: true, recoveryKey: h.mnemonic });
    // Export still succeeded, just without the passport.
    expect(existsSync(res.path)).toBe(true);
    const manifest = await h.runtime.readManifest(res.path, h.mnemonic);
    expect(manifest.includes_passport).toBe(false);
  });
});
