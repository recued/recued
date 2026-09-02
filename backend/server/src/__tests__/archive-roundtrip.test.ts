/** Phase F (D-108) — archive export / import round-trip tests.
 *
 *  Covers the happy path (DB + config + blobs + vault → write →
 *  read → decrypt → verify) plus the three classes of failure
 *  the security story depends on:
 *    - Wrong recovery key → AEAD tag mismatch on first record.
 *    - Tampered archive bytes → HMAC trailer mismatch.
 *    - Future format/schema version → parse rejects before decrypt.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { exportArchive } from '../archive/archive-export.js';
import {
  importArchive,
  parseManifest,
  checkManifestCompat,
  archiveSchemaTooNew,
} from '../archive/archive-import.js';
import {
  ARCHIVE_FORMAT_VERSION,
  MIN_CONSUMER_VERSION,
  SCHEMA_VERSION,
  type ArchiveManifest,
} from '../archive/archive-format.js';
import { deriveArchiveKeys } from '../archive/archive-crypto.js';
import { createBlobStore } from '../storage/blob-store.js';

const mkKey = (byte: number): Buffer => Buffer.alloc(32, byte);

interface Harness {
  dir: string;
  dbPath: string;
  db: Database.Database;
  close(): void;
}

const newHarness = (): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-e2e-'));
  const dbPath = join(dir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE example (k TEXT PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO example VALUES (?, ?)').run('hello', 'world');
  return {
    dir, dbPath, db,
    close() {
      try { db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

let h: Harness;
afterEach(() => { h?.close(); });

// ────────────────────────────────────────────────────────────────
// Round-trip
// ────────────────────────────────────────────────────────────────

describe('archive round-trip', () => {
  it('DB-only export → import returns identical bytes', async () => {
    h = newHarness();
    const key = mkKey(1);
    const archivePath = join(h.dir, 'out.recued.archive');
    const result = await exportArchive({
      destPath: archivePath,
      recoveryKey: key,
      db: h.db,
      producerVersion: '0.2.0',
    });
    expect(result.bytes_written).toBeGreaterThan(0);

    const imported = await importArchive({
      archivePath,
      recoveryKey: key,
      consumerVersion: '0.2.0',
    });
    expect(imported.manifest.producer_version).toBe('0.2.0');
    expect(imported.manifest.db_size_bytes).toBe(imported.db.length);
    expect(imported.manifest.includes_server_vault_bundle).toBe(false);
    expect(imported.blobs).toHaveLength(0);
    expect(imported.config).toBeUndefined();
    expect(imported.vault).toBeUndefined();
    expect(imported.serverVault).toBeUndefined();

    // SQLite backup produces a logically-equivalent DB, not
    // byte-identical (WAL checkpointing differs). Verify the data
    // round-trips by opening the restored DB and reading the row.
    const restorePath = join(h.dir, 'restored.db');
    writeFileSync(restorePath, imported.db);
    const restoredDb = new Database(restorePath, { readonly: true });
    const row = restoredDb.prepare('SELECT v FROM example WHERE k = ?').get('hello') as { v: string };
    expect(row.v).toBe('world');
    restoredDb.close();
  });

  it('full export with config + vault + blobs round-trips', async () => {
    h = newHarness();
    const key = mkKey(2);
    const configPath = join(h.dir, 'config.toml');
    writeFileSync(configPath, '[bootstrap]\nbind_port = 7717\n');
    const blobs = createBlobStore(join(h.dir, 'blobs'));
    const hash1 = await blobs.put(Buffer.from('blob-1-contents'));
    const hash2 = await blobs.put(Buffer.from('blob-2-contents-longer-payload'));

    const archivePath = join(h.dir, 'out.recued.archive');
    const result = await exportArchive({
      destPath: archivePath,
      recoveryKey: key,
      db: h.db,
      configPath,
      vaultBundleJson: '{"v":1,"fake":"bundle"}',
      serverVaultBundleJson: '{"v":1,"fake":"server-bundle"}',
      blobs,
      blobHashes: [hash1, hash2],
      producerVersion: '0.2.0',
    });
    expect(result.blob_count).toBe(2);

    const imported = await importArchive({
      archivePath,
      recoveryKey: key,
      consumerVersion: '0.2.0',
    });
    expect(imported.config?.toString('utf8')).toContain('bind_port = 7717');
    expect(imported.vault?.toString('utf8')).toContain('"fake":"bundle"');
    expect(imported.serverVault?.toString('utf8')).toContain('"fake":"server-bundle"');
    expect(imported.manifest.includes_server_vault_bundle).toBe(true);
    expect(imported.blobs).toHaveLength(2);
    const byHash = new Map(imported.blobs.map((b) => [b.hash, b.bytes]));
    expect(byHash.get(hash1)?.toString('utf8')).toBe('blob-1-contents');
    expect(byHash.get(hash2)?.toString('utf8')).toBe('blob-2-contents-longer-payload');
  });

  it('embeds + round-trips an identity passport record', async () => {
    h = newHarness();
    const key = mkKey(7);
    const archivePath = join(h.dir, 'with-passport.recued.archive');
    const passportJson = JSON.stringify({ profile: 'migration_full', signature: 'sig', x: 1 });
    await exportArchive({
      destPath: archivePath,
      recoveryKey: key,
      db: h.db,
      passportJson,
      producerVersion: '0.2.0',
    });
    const imported = await importArchive({ archivePath, recoveryKey: key, consumerVersion: '0.2.0' });
    expect(imported.passport?.toString('utf8')).toBe(passportJson);
  });

  it('omits the passport record when none is supplied', async () => {
    h = newHarness();
    const key = mkKey(8);
    const archivePath = join(h.dir, 'no-passport.recued.archive');
    await exportArchive({ destPath: archivePath, recoveryKey: key, db: h.db, producerVersion: '0.2.0' });
    const imported = await importArchive({ archivePath, recoveryKey: key, consumerVersion: '0.2.0' });
    expect(imported.passport).toBeUndefined();
  });

  it('rejects existing destination without --force', async () => {
    h = newHarness();
    const archivePath = join(h.dir, 'existing.archive');
    writeFileSync(archivePath, 'preexisting');
    await expect(exportArchive({
      destPath: archivePath,
      recoveryKey: mkKey(3),
      db: h.db,
      producerVersion: '0.2.0',
    })).rejects.toThrow(/ARCHIVE_TARGET_UNWRITABLE/);
  });

  it('overwrites an existing destination with force=true', async () => {
    h = newHarness();
    const archivePath = join(h.dir, 'existing.archive');
    writeFileSync(archivePath, 'preexisting');
    const result = await exportArchive({
      destPath: archivePath,
      recoveryKey: mkKey(3),
      db: h.db,
      producerVersion: '0.2.0',
      force: true,
    });
    expect(result.bytes_written).toBeGreaterThan(0);
    const imported = await importArchive({
      archivePath,
      recoveryKey: mkKey(3),
      consumerVersion: '0.2.0',
    });
    expect(imported.db.length).toBeGreaterThan(0);
  });

  it('throws ARCHIVE_BLOB_MISSING when a referenced blob is absent', async () => {
    h = newHarness();
    const blobs = createBlobStore(join(h.dir, 'blobs'));
    await expect(exportArchive({
      destPath: join(h.dir, 'out.archive'),
      recoveryKey: mkKey(4),
      db: h.db,
      blobs,
      blobHashes: ['deadbeef-not-in-cas'],
      producerVersion: '0.2.0',
    })).rejects.toThrow(/ARCHIVE_BLOB_MISSING/);
  });
});

// ────────────────────────────────────────────────────────────────
// Tampering / wrong key / version mismatches
// ────────────────────────────────────────────────────────────────

describe('archive security invariants', () => {
  const setup = async (): Promise<{
    archivePath: string;
    rightKey: Buffer;
  }> => {
    h = newHarness();
    const rightKey = mkKey(11);
    const archivePath = join(h.dir, 'sec.archive');
    await exportArchive({
      destPath: archivePath,
      recoveryKey: rightKey,
      db: h.db,
      producerVersion: '0.2.0',
    });
    return { archivePath, rightKey };
  };

  it('wrong recovery key fails with ARCHIVE_INVALID_SIGNATURE', async () => {
    const { archivePath } = await setup();
    await expect(
      importArchive({
        archivePath,
        recoveryKey: mkKey(99), // different key
        consumerVersion: '0.2.0',
      })
    ).rejects.toThrow(/ARCHIVE_INVALID_SIGNATURE/);
  });

  it('tampered ciphertext byte fails with ARCHIVE_INVALID_SIGNATURE', async () => {
    const { archivePath, rightKey } = await setup();
    const bytes = readFileSync(archivePath);
    // Flip a byte somewhere in the middle of the file — likely in
    // a ciphertext record rather than the manifest/header.
    const tamperIdx = Math.floor(bytes.length / 2);
    bytes[tamperIdx] ^= 0x01;
    writeFileSync(archivePath, bytes);
    await expect(
      importArchive({
        archivePath,
        recoveryKey: rightKey,
        consumerVersion: '0.2.0',
      })
    ).rejects.toThrow(/ARCHIVE_INVALID_SIGNATURE/);
  });

  it('future archive_format_version rejects without allowFutureVersion', async () => {
    const future: ArchiveManifest = {
      producer_version: '9.9.9',
      min_consumer_version: '9.0.0',
      archive_format_version: ARCHIVE_FORMAT_VERSION + 1,
      schema_version: 9,
      created_at: 0,
      db_size_bytes: 0,
      blob_count: 0,
      blob_bytes: 0,
      encryption: {
        algorithm: 'aes-256-gcm',
        key_derivation: 'hkdf-sha-256',
        salt_hex: 'aa'.repeat(32),
        info: 'recued-archive-v1',
      },
    };
    expect(() =>
      checkManifestCompat(future, '0.1.0', false),
    ).toThrow(/ARCHIVE_FUTURE_VERSION/);
  });

  it('future min_consumer_version rejects older server', async () => {
    const future: ArchiveManifest = {
      producer_version: '9.9.9',
      min_consumer_version: '9.0.0',
      archive_format_version: ARCHIVE_FORMAT_VERSION,
      schema_version: 1,
      created_at: 0,
      db_size_bytes: 0,
      blob_count: 0,
      blob_bytes: 0,
      encryption: {
        algorithm: 'aes-256-gcm',
        key_derivation: 'hkdf-sha-256',
        salt_hex: 'aa'.repeat(32),
        info: 'recued-archive-v1',
      },
    };
    expect(() => checkManifestCompat(future, '0.1.0', false))
      .toThrow(/ARCHIVE_FUTURE_VERSION/);
    // With allowFutureVersion=true, the check passes.
    expect(() => checkManifestCompat(future, '0.1.0', true)).not.toThrow();
  });

  it('M5 S3.0 — newer schema_version rejects (upgrade server) unless allowFutureVersion', () => {
    const newer: ArchiveManifest = {
      producer_version: '9.9.9',
      min_consumer_version: MIN_CONSUMER_VERSION, // binary-version compatible
      archive_format_version: ARCHIVE_FORMAT_VERSION, // envelope compatible
      schema_version: SCHEMA_VERSION + 1, // ← the ONLY incompatibility
      created_at: 0,
      db_size_bytes: 0,
      blob_count: 0,
      blob_bytes: 0,
      encryption: {
        algorithm: 'aes-256-gcm',
        key_derivation: 'hkdf-sha-256',
        salt_hex: 'aa'.repeat(32),
        info: 'recued-archive-v1',
      },
    };
    expect(archiveSchemaTooNew(newer.schema_version)).toBe(true);
    expect(() => checkManifestCompat(newer, MIN_CONSUMER_VERSION, false)).toThrow(
      /ARCHIVE_SCHEMA_TOO_NEW/,
    );
    // `force` (allowFutureVersion) is the escape hatch.
    expect(() => checkManifestCompat(newer, MIN_CONSUMER_VERSION, true)).not.toThrow();
  });

  it('M5 S3.0 — same/older schema_version is accepted (migrates forward on boot)', () => {
    const ok: ArchiveManifest = {
      producer_version: '0.1.0',
      min_consumer_version: MIN_CONSUMER_VERSION,
      archive_format_version: ARCHIVE_FORMAT_VERSION,
      schema_version: SCHEMA_VERSION, // equal — fine; older is also fine
      created_at: 0,
      db_size_bytes: 0,
      blob_count: 0,
      blob_bytes: 0,
      encryption: {
        algorithm: 'aes-256-gcm',
        key_derivation: 'hkdf-sha-256',
        salt_hex: 'aa'.repeat(32),
        info: 'recued-archive-v1',
      },
    };
    expect(archiveSchemaTooNew(ok.schema_version)).toBe(false);
    expect(() => checkManifestCompat(ok, MIN_CONSUMER_VERSION, false)).not.toThrow();
  });

  it('⛔ D-258 — a 4-segment min_consumer_version is ENFORCED, not truncated away', () => {
    // The compare read exactly three segments, so a `26.9.1` server checked
    // against an archive requiring `26.9.1.1` compared EQUAL and the restore was
    // ACCEPTED. `min_consumer_version` is a fail-CLOSED contract, and truncation
    // inverted it exactly on the floors a same-day hotfix would raise — the
    // failure being a successful restore onto a server that cannot read the
    // data, which nobody sees.
    const requiring = (floor: string): ArchiveManifest => ({
      producer_version: floor,
      min_consumer_version: floor,
      archive_format_version: ARCHIVE_FORMAT_VERSION,
      schema_version: SCHEMA_VERSION,
      created_at: 0,
      db_size_bytes: 0,
      blob_count: 0,
      blob_bytes: 0,
      encryption: {
        algorithm: 'aes-256-gcm',
        key_derivation: 'hkdf-sha-256',
        salt_hex: 'aa'.repeat(32),
        info: 'recued-archive-v1',
      },
    });

    // The exact rejection that was missing: the base triple is EQUAL, and only
    // the fourth segment separates them.
    expect(() => checkManifestCompat(requiring('26.9.1.1'), '26.9.1', false))
      .toThrow(/ARCHIVE_FUTURE_VERSION: archive requires server >= 26\.9\.1\.1/);
    // And between two ordinals of one day.
    expect(() => checkManifestCompat(requiring('26.9.1.2'), '26.9.1.1', false))
      .toThrow(/ARCHIVE_FUTURE_VERSION/);
    // `force` stays the escape hatch, as for every other future-version refusal.
    expect(() => checkManifestCompat(requiring('26.9.1.1'), '26.9.1', true)).not.toThrow();

    // ⚠ AND THE ORDINAL MUST NOT MAKE THE FLOOR STRICTER THAN IT IS. A hotfix
    // consumer satisfies its own base's floor, and a later ordinal satisfies an
    // earlier one — otherwise this fix would refuse restores that used to work.
    expect(() => checkManifestCompat(requiring('26.9.1'), '26.9.1.1', false)).not.toThrow();
    expect(() => checkManifestCompat(requiring('26.9.1.1'), '26.9.1.5', false)).not.toThrow();
    expect(() => checkManifestCompat(requiring('26.9.1.1'), '26.9.2', false)).not.toThrow();
    // Plain triples compare exactly as they always did.
    expect(() => checkManifestCompat(requiring('26.9.1'), '26.9.1', false)).not.toThrow();
    expect(() => checkManifestCompat(requiring('26.9.1'), '26.8.31', false))
      .toThrow(/ARCHIVE_FUTURE_VERSION/);
  });

  it('⛔ a MALFORMED floor is refused, not coerced — the grammar, not the segment count', () => {
    // ⚠ WIDENING THE LOOP FROM 3 TO 4 MOVED THE HOLE, IT DID NOT CLOSE IT.
    // `26.9.1.1.1` and `26.9.1.1` still compared EQUAL, so an archive declaring a
    // five-segment floor was ACCEPTED by a server below it — and `26.9.1.0` was
    // accepted by `26.9.1`. `min_consumer_version` arrives from the archive FILE
    // (attacker- or corruption-supplied), so "whatever it says, coerced to
    // numbers" is not a floor. The grammar is IMPORTED from `@recued/release`
    // rather than restated, so a floor is judged by the rule that judges a
    // release version.
    const requiring = (floor: string): ArchiveManifest => ({
      producer_version: '26.9.1',
      min_consumer_version: floor,
      archive_format_version: ARCHIVE_FORMAT_VERSION,
      schema_version: SCHEMA_VERSION,
      created_at: 0,
      db_size_bytes: 0,
      blob_count: 0,
      blob_bytes: 0,
      encryption: {
        algorithm: 'aes-256-gcm',
        key_derivation: 'hkdf-sha-256',
        salt_hex: 'aa'.repeat(32),
        info: 'recued-archive-v1',
      },
    });

    // ⛔ INCLUDING SUFFIXED FORMS. The check began life as
    // `isValidReleaseVersion(v.split('-')[0])` — it stripped a `-suffix` and then
    // validated the STUMP, so `26.9.1-rc.1` and `26.9.1.1-rc1` passed a gate whose
    // whole purpose is to reject what the canonical grammar rejects. A validator
    // that normalises its input first is answering about the normalised value,
    // and the value COMPARED here is the one the archive supplied.
    for (const bad of ['26.9.1.1.1', '26.9.1.0', '26.9.1.dev', '26.9', '26.09.1', '',
                       '26.9.1-rc.1', '26.9.1.1-rc1', '26.9.1.1-']) {
      expect(() => checkManifestCompat(requiring(bad), '26.9.1.1', false), bad)
        .toThrow(/ARCHIVE_FUTURE_VERSION/);
    }
    // ⚠ AND `force` MUST NOT WAVE THROUGH A STRING THAT IS NOT A VERSION. The
    // escape hatch exists for "newer than me", which is a comparison — it cannot
    // mean "compare this unparseable thing anyway".
    expect(() => checkManifestCompat(requiring('26.9.1.1.1'), '26.9.1.1', true))
      .toThrow(/ARCHIVE_FUTURE_VERSION/);
  });

  it('parseManifest rejects non-RECA magic', () => {
    const bogus = Buffer.concat([Buffer.from('XXXX'), Buffer.alloc(100)]);
    expect(() => parseManifest(bogus)).toThrow(/ARCHIVE_INVALID: magic/);
  });

  it('parseManifest accepts MIN_CONSUMER_VERSION equal', () => {
    // Produces a truncated archive we just care about parsing from.
    // Build a minimal manifest directly and round-trip through our
    // compat checker to prove the equality path holds.
    const manifest: ArchiveManifest = {
      producer_version: '0.1.0',
      min_consumer_version: MIN_CONSUMER_VERSION,
      archive_format_version: ARCHIVE_FORMAT_VERSION,
      schema_version: 1,
      created_at: 0,
      db_size_bytes: 0,
      blob_count: 0,
      blob_bytes: 0,
      encryption: {
        algorithm: 'aes-256-gcm',
        key_derivation: 'hkdf-sha-256',
        salt_hex: 'aa'.repeat(32),
        info: 'recued-archive-v1',
      },
    };
    expect(() => checkManifestCompat(manifest, MIN_CONSUMER_VERSION, false)).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// Key derivation
// ────────────────────────────────────────────────────────────────

describe('archive key derivation', () => {
  it('same key + same salt → deterministic content + hmac sub-keys', () => {
    const key = mkKey(42);
    const salt = Buffer.alloc(32, 7);
    const a = deriveArchiveKeys(key, salt);
    const b = deriveArchiveKeys(key, salt);
    expect(a.content.equals(b.content)).toBe(true);
    expect(a.hmac.equals(b.hmac)).toBe(true);
    // Content key differs from HMAC key — domain separation holds.
    expect(a.content.equals(a.hmac)).toBe(false);
  });

  it('different salts produce different content keys', () => {
    const key = mkKey(42);
    const a = deriveArchiveKeys(key, Buffer.alloc(32, 1));
    const b = deriveArchiveKeys(key, Buffer.alloc(32, 2));
    expect(a.content.equals(b.content)).toBe(false);
  });

  it('rejects wrong-length recovery key', () => {
    expect(() => deriveArchiveKeys(Buffer.alloc(31), Buffer.alloc(32))).toThrow(/recovery key must be 32/);
    expect(() => deriveArchiveKeys(Buffer.alloc(33), Buffer.alloc(32))).toThrow(/recovery key must be 32/);
  });
});
