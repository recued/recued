/** D-148 follow-up #6 — signing-audit wrapper bin.ts wiring.
 *
 *  Wave 3 (W3.5b / W3.9 / W3.10) introduced five HIGH_ASSURANCE_AUDIT_KINDS
 *  rows the exposure substrate emits at boot + rpc time:
 *    - exposure_path_resolution_change
 *    - exposure_preset_apply
 *    - public_mcp_acknowledged
 *    - public_mcp_revoked
 *    - exposure_reset_via_cli
 *
 *  All five went in unsigned because bin.ts had never wrapped its
 *  `auditLog` with `createSigningAuditLog`. Codex W3.10 P2 flagged
 *  the gap as cross-cutting and the follow-up wires the substrate.
 *
 *  Acceptance:
 *    1. `bootServerIdentity` places the keys file next to the db.
 *    2. First boot generates both identity keys + flushes to disk.
 *    3. Second boot reads the same keys (idempotent — no regeneration).
 *    4. `RECUED_IDENTITY_PASSPHRASE` round-trips an encrypted file.
 *    5. Each of the five high-assurance exposure actions, emitted
 *       through the wrapped audit log, carries a signature + matching
 *       fingerprint, and `verifyActivityEntry` returns ok against the
 *       live server public key.
 *    6. A non-high-assurance row routed through the same wrapper is
 *       NOT signed.
 *    7. A post-rotation emit picks up the new key automatically
 *       (substrate guarantee; spot-checked end-to-end).
 *    8. Bin.ts wraps `auditLog` with the signing wrapper at module
 *       top (text assertion against the source) — pins the wiring
 *       so a careless refactor can't drop the wrapper silently.
 */

import { describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';
import {
  bootServerIdentity,
  resolveIdentityKeysPath,
  IDENTITY_KEYS_FILENAME,
  IDENTITY_PASSPHRASE_ENV_VAR,
} from '../identity/boot.js';
import {
  createSigningAuditLog,
  verifyActivityEntry,
} from '../audit/signing.js';
import { HIGH_ASSURANCE_AUDIT_KINDS } from '@recued/contracts';

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), 'd148-w3-fu6-'));
const cleanupDir = (dir: string): void =>
  rmSync(dir, { recursive: true, force: true });

const makeBasicLog = (): AuditLogStore =>
  createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );

const baseEntry = (action: string): ActivityEntry => ({
  activity_id: `act-${action}-${Math.random().toString(36).slice(2, 8)}`,
  timestamp: 1_700_000_000_000,
  action: action as ActivityEntry['action'],
  target: 'exposure',
  detail: `kind=${action}`,
});

const WAVE_3_HIGH_ASSURANCE_ACTIONS = [
  'exposure_path_resolution_change',
  'exposure_preset_apply',
  'public_mcp_acknowledged',
  'public_mcp_revoked',
  'exposure_reset_via_cli',
] as const;

// Argon2id params for the encrypted-file test. Production callers use
// KEK_ARGON2_PARAMS (the OWASP 2024 baseline); the t=1, m=8MB, p=1 shape
// here keeps the test sub-second.
const FAST_ARGON2 = { t: 1, m: 8 * 1024, p: 1 } as const;

describe('D-148 follow-up #6 — resolveIdentityKeysPath', () => {
  it('places keys file alongside the db file', () => {
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, 'recued-server.db');
      expect(resolveIdentityKeysPath(dbPath)).toBe(join(dir, IDENTITY_KEYS_FILENAME));
    } finally {
      cleanupDir(dir);
    }
  });

  it('resolves relative db paths to absolute keys paths', () => {
    const result = resolveIdentityKeysPath('./recued-server.db');
    expect(result.endsWith(IDENTITY_KEYS_FILENAME)).toBe(true);
    // Resolved against cwd — absolute, not the original `./`.
    expect(result.startsWith('/')).toBe(true);
  });
});

describe('D-148 follow-up #6 — bootServerIdentity (first boot)', () => {
  it('generates both identity keys + flushes to disk + reports created:true', async () => {
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, 'recued-server.db');
      const booted = await bootServerIdentity({
        dbPath,
        passphrase: null,
        env: {},
      });
      expect(booted.created).toBe(true);
      expect(booted.filePath).toBe(join(dir, IDENTITY_KEYS_FILENAME));
      expect(existsSync(booted.filePath)).toBe(true);
      const server = booted.identity.serverIdentityKey();
      expect(server.key_class).toBe('server_identity_key');
      expect(typeof server.public_key_b64).toBe('string');
      expect(server.public_key_fingerprint.startsWith('sha256:')).toBe(true);
      const publisher = booted.identity.publisherIdentityKey();
      expect(publisher.key_class).toBe('publisher_identity_key');
      expect(publisher.public_key_fingerprint).not.toBe(server.public_key_fingerprint);
    } finally {
      cleanupDir(dir);
    }
  });

  it('second boot reloads the same keys (idempotent — created:false)', async () => {
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, 'recued-server.db');
      const first = await bootServerIdentity({ dbPath, passphrase: null, env: {} });
      const second = await bootServerIdentity({ dbPath, passphrase: null, env: {} });
      expect(second.created).toBe(false);
      expect(second.identity.serverIdentityKey().public_key_fingerprint)
        .toBe(first.identity.serverIdentityKey().public_key_fingerprint);
      expect(second.identity.publisherIdentityKey().public_key_fingerprint)
        .toBe(first.identity.publisherIdentityKey().public_key_fingerprint);
    } finally {
      cleanupDir(dir);
    }
  });
});

describe('D-148 follow-up #6 — passphrase resolution', () => {
  it('reads RECUED_IDENTITY_PASSPHRASE from the supplied env', async () => {
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, 'recued-server.db');
      const env: NodeJS.ProcessEnv = {
        [IDENTITY_PASSPHRASE_ENV_VAR]: 'correct horse battery staple',
      };
      const booted = await bootServerIdentity({
        dbPath,
        env,
        argon2_params: FAST_ARGON2,
      });
      const fingerprint = booted.identity.serverIdentityKey().public_key_fingerprint;
      // File should be AEAD-sealed (encrypted: true marker).
      const doc = JSON.parse(readFileSync(booted.filePath, 'utf8'));
      expect(doc.encrypted).toBe(true);
      // Re-boot with the same passphrase loads the same identity.
      const reloaded = await bootServerIdentity({
        dbPath,
        env,
        argon2_params: FAST_ARGON2,
      });
      expect(reloaded.identity.serverIdentityKey().public_key_fingerprint)
        .toBe(fingerprint);
    } finally {
      cleanupDir(dir);
    }
  });

  it('passphrase: null overrides env-var lookup (cleartext file)', async () => {
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, 'recued-server.db');
      const env: NodeJS.ProcessEnv = {
        [IDENTITY_PASSPHRASE_ENV_VAR]: 'should-be-ignored',
      };
      const booted = await bootServerIdentity({ dbPath, env, passphrase: null });
      const doc = JSON.parse(readFileSync(booted.filePath, 'utf8'));
      expect(doc.encrypted).toBe(false);
    } finally {
      cleanupDir(dir);
    }
  });

  it('explicit passphrase overrides env-var lookup', async () => {
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, 'recued-server.db');
      const env: NodeJS.ProcessEnv = {
        [IDENTITY_PASSPHRASE_ENV_VAR]: 'env-passphrase',
      };
      const booted = await bootServerIdentity({
        dbPath,
        env,
        passphrase: 'explicit-passphrase',
        argon2_params: FAST_ARGON2,
      });
      // Reloading with `env-passphrase` would fail; explicit must match.
      await expect(
        bootServerIdentity({
          dbPath,
          env,
          argon2_params: FAST_ARGON2,
        }),
      ).rejects.toThrow(/decryption failed/);
      const reloaded = await bootServerIdentity({
        dbPath,
        env,
        passphrase: 'explicit-passphrase',
        argon2_params: FAST_ARGON2,
      });
      expect(reloaded.identity.serverIdentityKey().public_key_fingerprint)
        .toBe(booted.identity.serverIdentityKey().public_key_fingerprint);
    } finally {
      cleanupDir(dir);
    }
  });
});

describe('D-148 follow-up #6 — high-assurance signing flow end-to-end', () => {
  // Sanity check that every action we exercise is actually in the
  // closed set. If a future change drops one of these, this guards
  // the exposure-substrate audit-signing contract.
  it('every Wave 3 action is in HIGH_ASSURANCE_AUDIT_KINDS', () => {
    for (const action of WAVE_3_HIGH_ASSURANCE_ACTIONS) {
      expect(HIGH_ASSURANCE_AUDIT_KINDS.has(action)).toBe(true);
    }
  });

  it.each(WAVE_3_HIGH_ASSURANCE_ACTIONS)(
    'signs %s row + verify ok against the live server public key',
    async (action) => {
      const dir = makeTempDir();
      try {
        const dbPath = join(dir, 'recued-server.db');
        const booted = await bootServerIdentity({ dbPath, passphrase: null, env: {} });
        const underlying = makeBasicLog();
        const wrapped = createSigningAuditLog(underlying, {
          getServerIdentity: () => booted.identity.serverIdentityKey(),
        });
        await wrapped.logActivity(baseEntry(action));
        const rows = await underlying.listActivities();
        const row = rows.find((r) => r.action === action);
        expect(row).toBeDefined();
        expect(typeof row?.signature).toBe('string');
        expect(row?.signature?.length).toBeGreaterThan(0);
        expect(row?.signer_fingerprint).toBe(
          booted.identity.serverIdentityKey().public_key_fingerprint,
        );
        // Verify against the live server public key.
        const result = verifyActivityEntry(
          row!,
          booted.identity.serverIdentityKey().public_key_b64,
        );
        expect(result.ok).toBe(true);
        // Reserve flag pinned (signing wrapper pre-pins reserve:true so the
        // signed bytes match the stored bytes).
        expect(row?.reserve).toBe(true);
      } finally {
        cleanupDir(dir);
      }
    },
  );

  it('non-high-assurance row passes through unsigned', async () => {
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, 'recued-server.db');
      const booted = await bootServerIdentity({ dbPath, passphrase: null, env: {} });
      const underlying = makeBasicLog();
      const wrapped = createSigningAuditLog(underlying, {
        getServerIdentity: () => booted.identity.serverIdentityKey(),
      });
      // `install` is NOT in HIGH_ASSURANCE_AUDIT_KINDS.
      await wrapped.logActivity(baseEntry('install'));
      const rows = await underlying.listActivities();
      const row = rows.find((r) => r.action === 'install');
      expect(row?.signature).toBeUndefined();
      expect(row?.signer_fingerprint).toBeUndefined();
    } finally {
      cleanupDir(dir);
    }
  });

  it('post-rotation emit picks up the new key automatically', async () => {
    const dir = makeTempDir();
    try {
      const dbPath = join(dir, 'recued-server.db');
      const booted = await bootServerIdentity({ dbPath, passphrase: null, env: {} });
      const underlying = makeBasicLog();
      const wrapped = createSigningAuditLog(underlying, {
        getServerIdentity: () => booted.identity.serverIdentityKey(),
      });
      const beforePub = booted.identity.serverIdentityKey().public_key_b64;
      await wrapped.logActivity(baseEntry('exposure_preset_apply'));
      await booted.identity.rotateServerIdentity();
      const afterPub = booted.identity.serverIdentityKey().public_key_b64;
      expect(afterPub).not.toBe(beforePub);
      await wrapped.logActivity(baseEntry('exposure_reset_via_cli'));
      const rows = await underlying.listActivities();
      const pre = rows.find((r) => r.action === 'exposure_preset_apply');
      const post = rows.find((r) => r.action === 'exposure_reset_via_cli');
      expect(verifyActivityEntry(pre!, beforePub).ok).toBe(true);
      expect(verifyActivityEntry(pre!, afterPub).ok).toBe(false);
      expect(verifyActivityEntry(post!, afterPub).ok).toBe(true);
      expect(verifyActivityEntry(post!, beforePub).ok).toBe(false);
    } finally {
      cleanupDir(dir);
    }
  });
});

describe('D-148 follow-up #6 — serve signing source pin', () => {
  // Text-level assertions against the serve/storage source so a careless refactor
  // can't drop the signing wrapper silently OR re-introduce the eager
  // module-top boot Codex W3.FU6 P2 flagged. The wiring is hard to
  // exercise via integration tests (the serve entry has no test-friendly entry
  // point); the source pin is the lightweight backstop.
  it('imports the boot + signing substrate', () => {
    const storagePath = new URL('../serve/compose-storage-context.ts', import.meta.url).pathname;
    const source = readFileSync(storagePath, 'utf8');
    expect(source).toMatch(/import\s*\{\s*bootServerIdentity[^}]*\}\s*from\s*['"]\.\.\/identity\/boot\.js['"]/);
    expect(source).toMatch(/import\s*\{\s*createSigningAuditLog\s*\}\s*from\s*['"]\.\.\/audit\/signing\.js['"]/);
  });

  it('publishes the signed audit log through the drain-owned wrapper', () => {
    const storagePath = new URL('../serve/compose-storage-context.ts', import.meta.url).pathname;
    const source = readFileSync(storagePath, 'utf8');
    expect(source).toMatch(/createSigningAuditLog\(\s*baseAuditLog\s*,/);
    expect(source).toMatch(/createDrainableAuditLog\(signingAuditLog\)/);
    // The final drain-owned reference is named `auditLog` so every existing
    // emit site gets both signing and terminal-flush ownership unchanged.
    expect(source).toMatch(
      /const\s+auditLog:\s*AuditLogStore\s*=\s*drainableAuditLog\.auditLog/,
    );
  });

  it('defers identity boot until after the lifecycle lock claim', () => {
    const storagePath = new URL('../serve/compose-storage-context.ts', import.meta.url).pathname;
    const postStoragePath = new URL(
      '../serve/start-post-storage-app-collection-execution-runtime.ts',
      import.meta.url,
    ).pathname;
    const lifecycleRecoveryPath = new URL(
      '../serve/start-lifecycle-recovery-pre-listener-runtime.ts',
      import.meta.url,
    ).pathname;
    const bootRecoveryPath = new URL('../serve/start-boot-recovery-and-adapters.ts', import.meta.url).pathname;
    const storageSource = readFileSync(storagePath, 'utf8');
    const postStorageSource = readFileSync(postStoragePath, 'utf8');
    const lifecycleRecoverySource = readFileSync(lifecycleRecoveryPath, 'utf8');
    const bootRecoverySource = readFileSync(bootRecoveryPath, 'utf8');
    // Eager module-top `await bootServerIdentity(...)` would re-introduce
    // Codex W3.FU6 P2 #1 + P2 #2. The boot must be inside a helper that
    // the recovery bridge invokes after `composeServeLifecycle` claims the lock.
    expect(storageSource).not.toMatch(/^const\s+serverIdentityBoot\b.*=\s*db\s*\?\s*await\s+bootServerIdentity/m);
    expect(storageSource).toMatch(/const\s+bootSigningIdentity\s*=\s*async\b/);
    expect(postStorageSource).toMatch(/const\s+bootSigningIdentity\s*=\s*async\b/);
    expect(postStorageSource).toMatch(/recovery:\s*\{[\s\S]*?bootSigningIdentity,/);
    expect(bootRecoverySource).toMatch(/await bootSigningIdentity\(\);/);

    const lifecycleIdx = lifecycleRecoverySource.indexOf('await composeServeLifecycle({');
    const recoveryIdx = lifecycleRecoverySource.indexOf('await startBootRecoveryAndAdapters({');
    expect(lifecycleIdx).toBeGreaterThan(0);
    expect(recoveryIdx).toBeGreaterThan(lifecycleIdx);
  });

  it('thunk throws when a high-assurance row is emitted before identity boot', async () => {
    // Mirror of the bin.ts thunk shape: a signing wrapper whose
    // `getServerIdentity` throws before the ref is wired. Confirms the
    // loud-failure invariant the bin.ts comment promises.
    const underlying = makeBasicLog();
    let identity: ReturnType<Awaited<ReturnType<typeof bootServerIdentity>>['identity']['serverIdentityKey']> | undefined;
    const wrapped = createSigningAuditLog(underlying, {
      getServerIdentity: () => {
        if (!identity) throw new Error('signing identity not yet wired');
        return identity;
      },
    });
    await expect(wrapped.logActivity(baseEntry('exposure_preset_apply'))).rejects.toThrow(
      /signing identity not yet wired/,
    );
    // Non-high-assurance rows are unaffected — the thunk isn't called.
    await expect(wrapped.logActivity(baseEntry('install'))).resolves.toBeUndefined();
  });

  it('help text no longer says "signing wiring pending"', () => {
    const helpPath = new URL('../commands/help.ts', import.meta.url).pathname;
    const source = readFileSync(helpPath, 'utf8');
    expect(source).not.toMatch(/signing\s+wiring\s+pending/i);
    expect(source).toMatch(/signed audit row/i);
  });
});
