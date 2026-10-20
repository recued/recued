import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRecoveryKey } from '@recued/crypto';
import { migrateDatabaseSchema, readDatabaseSchema } from '../database-schema.js';
import { openApplicationDatabase } from '../open-application-database.js';
import { createInstanceLock } from '../lifecycle/instance-lock.js';
import { realmSnapshotPath } from '../update/realm-generation-snapshot.js';
import { exportArchive, uint32BE } from '../archive/archive-export.js';
import { importArchive, parseManifest } from '../archive/archive-import.js';
import { createArchiveHmac, deriveArchiveKeys, encryptRecord } from '../archive/archive-crypto.js';
import { FILE_NAMES, HMAC_LEN, MAGIC, type ArchiveManifest } from '../archive/archive-format.js';
import { applyRestore, stageRestore, discardStagedRestore } from '../archive/archive-restore.js';
import { createArchiveRuntime, isLiveWarehouseEmpty } from '../archive/archive-runtime.js';

const dirs: string[] = [];
const handles: Database.Database[] = [];
const dir = (): string => { const path = mkdtempSync(join(tmpdir(), 'recued-schema-archive-')); dirs.push(path); return path; };
afterEach(() => {
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});
const makeSource = async (managed: boolean) => {
  const root = dir(); const path = join(root, 'source.db'); const archivePath = join(root, 'source.recued.archive');
  const db = new Database(path); handles.push(db);
  db.exec("CREATE TABLE owner_rows (body TEXT NOT NULL); INSERT INTO owner_rows VALUES ('keep this row')");
  if (managed) migrateDatabaseSchema(db);
  const recovery = generateRecoveryKey(); const key = Buffer.from(recovery.entropy);
  const exported = await exportArchive({ db, destPath: archivePath, recoveryKey: key, producerVersion: '0.2.0' });
  return { root, path, db, archivePath, key, mnemonic: recovery.mnemonic, exported };
};
const makeTarget = () => {
  const dataPath = dir(); const dbPath = join(dataPath, 'target.db');
  const db = new Database(dbPath); handles.push(db);
  db.exec("CREATE TABLE original_rows (body TEXT); INSERT INTO original_rows VALUES ('original live data')");
  const runtime = createArchiveRuntime({ db, dbPath, dataPath, configPath: null, serverVersion: '0.2.0',
    requestRestart: () => { throw new Error('Schema fixture must not request a restart'); } });
  return { db, runtime, targets: { dbPath, dataPath, configPath: null } };
};

/** Re-sign a deliberately inconsistent fixture. This proves that the schema
 * gate checks the authenticated payload, rather than merely catching tamper. */
const changeManifestVersion = (path: string, key: Buffer, version: number): void => {
  const bytes = readFileSync(path); const parsed = parseManifest(bytes);
  const manifest = { ...parsed.manifest, schema_version: version };
  const json = Buffer.from(JSON.stringify(manifest));
  const body = Buffer.concat([MAGIC, uint32BE(json.length), json, bytes.subarray(parsed.offsetAfter, -HMAC_LEN)]);
  const keys = deriveArchiveKeys(key, Buffer.from(manifest.encryption.salt_hex, 'hex'));
  const hmac = createArchiveHmac(keys.hmac); hmac.update(body);
  writeFileSync(path, Buffer.concat([body, hmac.finalize()]));
};

describe('database schema in backup, preview and restore', () => {
  it.each([false, true])('exports the actual database version without upgrading the source (managed=%s)', async managed => {
    const source = await makeSource(managed);
    expect(source.exported.manifest.schema_version).toBe(managed ? 3 : 2);
    expect(source.db.pragma('user_version', { simple: true })).toBe(managed ? 3 : 0);
    const imported = await importArchive({ archivePath: source.archivePath, recoveryKey: source.key, consumerVersion: '0.2.0' });
    const copy = join(source.root, 'payload.db'); writeFileSync(copy, imported.db);
    const db = new Database(copy, { readonly: true }); handles.push(db);
    expect(readDatabaseSchema(db).version).toBe(imported.manifest.schema_version);
  });

  it('takes the application snapshot before the first registered migration and keeps it across reopen', async () => {
    const source = await makeSource(false); source.db.close();
    const env = { ...process.env, RECUED_DISTRIBUTION_CHANNEL: 'docker-thin', RECUED_BIN_DIR: source.root };
    const db = await openApplicationDatabase({ dbPath: source.path, env }); handles.push(db);
    expect(readDatabaseSchema(db).version).toBe(3);
    const snapshot = realmSnapshotPath(source.path);
    const previous = new Database(snapshot, { readonly: true }); handles.push(previous);
    expect(previous.pragma('user_version', { simple: true })).toBe(0);
    expect(previous.prepare('SELECT body FROM owner_rows').get()).toEqual({ body: 'keep this row' });
    expect(previous.prepare("SELECT name FROM sqlite_master WHERE name='database_schema_migrations'").get()).toBeUndefined();
    previous.close(); const bytes = readFileSync(snapshot); db.close();
    const reopened = await openApplicationDatabase({ dbPath: source.path, env }); handles.push(reopened);
    expect(readFileSync(snapshot)).toEqual(bytes);
    expect(readDatabaseSchema(reopened).migrations).toHaveLength(1);
  });

  it.each([false, true])('shares only a current schema with a live server and preserves its snapshot lifecycle (managed=%s)', async managed => {
    const source = await makeSource(managed); source.db.close();
    // The test's live parent stands in as the lock owner. No process is signaled
    // beyond kill(pid, 0), and the lock lives only in this disposable directory.
    const lock = createInstanceLock({ lockPath: join(source.root, 'recued-server.lock'), currentPid: () => process.ppid });
    lock.claim({ boot_at: Date.now(), bind_port: 9876 });
    const env = { ...process.env, RECUED_DISTRIBUTION_CHANNEL: 'docker-thin', RECUED_BIN_DIR: source.root };
    if (managed) {
      const db = await openApplicationDatabase({ dbPath: source.path, env }); handles.push(db);
      expect(readDatabaseSchema(db).version).toBe(3);
    } else {
      await expect(openApplicationDatabase({ dbPath: source.path, env })).rejects.toThrow(/DATABASE_SCHEMA_UPGRADE_SERVER_LIVE/);
      const db = new Database(source.path, { readonly: true }); handles.push(db);
      expect(db.pragma('user_version', { simple: true })).toBe(0);
    }
    expect(readdirSync(source.root).some(name => name.startsWith('update-snapshot.'))).toBe(false);
    lock.release();
  });

  it('keeps migration receipts out of the fresh-server user-content guard', () => {
    const db = new Database(':memory:'); handles.push(db); migrateDatabaseSchema(db);
    expect(isLiveWarehouseEmpty(db)).toBe(true);
    db.exec('CREATE TABLE future_owner_content (body TEXT); INSERT INTO future_owner_content VALUES (\'content\')');
    expect(isLiveWarehouseEmpty(db)).toBe(false);
  });

  it.each([false, true])('rejects authenticated manifest/payload disagreement in preview and both restore paths (managed=%s)', async managed => {
    const source = await makeSource(managed); const target = makeTarget();
    changeManifestVersion(source.archivePath, source.key, managed ? 2 : 3);
    // Parsing and authenticating this fixture succeeds; the independent schema
    // check is what must refuse it.
    await expect(importArchive({ archivePath: source.archivePath, recoveryKey: source.key, consumerVersion: '0.2.0' })).resolves.toBeDefined();
    await expect(target.runtime.readManifest(source.archivePath, source.mnemonic)).rejects.toThrow(/ARCHIVE_SCHEMA_MISMATCH/);
    const before = readFileSync(target.targets.dbPath);
    const options = { archivePath: source.archivePath, recoveryKey: source.key, consumerVersion: '0.2.0' };
    await expect(stageRestore(target.targets, options)).rejects.toThrow(/ARCHIVE_SCHEMA_MISMATCH/);
    await expect(applyRestore(target.targets, options)).rejects.toThrow(/ARCHIVE_SCHEMA_MISMATCH/);
    expect(readFileSync(target.targets.dbPath)).toEqual(before);
    expect(target.db.prepare('SELECT body FROM original_rows').get()).toEqual({ body: 'original live data' });
    expect(readdirSync(target.targets.dataPath).filter(name => /staging-|restore-.*tmp/.test(name))).toEqual([]);
  });

  it('upgrades the staged legacy database before it can replace the live file', async () => {
    const source = await makeSource(false); const target = makeTarget();
    const staged = await stageRestore(target.targets, { archivePath: source.archivePath, recoveryKey: source.key, consumerVersion: '0.2.0' });
    const probe = new Database(staged.stagingPath, { readonly: true }); handles.push(probe);
    expect(readDatabaseSchema(probe).version).toBe(3);
    expect(probe.prepare('SELECT body FROM owner_rows').get()).toEqual({ body: 'keep this row' });
    expect(target.db.prepare('SELECT body FROM original_rows').get()).toEqual({ body: 'original live data' });
    probe.close(); discardStagedRestore(staged.stagingPath, staged.displacedBlobs);
    expect(source.db.pragma('user_version', { simple: true })).toBe(0);
  });

  it('aborts a staged migration failure with live data untouched and no partial staging file', async () => {
    const source = await makeSource(false); const target = makeTarget();
    source.db.exec('CREATE TABLE event_triggers (trigger_id TEXT PRIMARY KEY)');
    const brokenArchive = join(source.root, 'broken.recued.archive');
    await exportArchive({ db: source.db, destPath: brokenArchive, recoveryKey: source.key, producerVersion: '0.2.0' });
    await expect(stageRestore(target.targets, { archivePath: brokenArchive, recoveryKey: source.key, consumerVersion: '0.2.0' })).rejects.toThrow(/recipe_id/);
    expect(target.db.prepare('SELECT body FROM original_rows').get()).toEqual({ body: 'original live data' });
    expect(readdirSync(target.targets.dataPath).filter(name => name.includes('staging-'))).toEqual([]);
  });

  it('still validates Records coherence for supported schemas before showing a preview', async () => {
    const source = await makeSource(true); const target = makeTarget();
    source.db.exec('CREATE TABLE core_records (unexpected TEXT)');
    const broken = join(source.root, 'incoherent.recued.archive');
    await exportArchive({ db: source.db, destPath: broken, recoveryKey: source.key, producerVersion: '0.2.0' });
    await expect(target.runtime.readManifest(broken, source.mnemonic)).rejects.toThrow(/records_restore_incoherent/);
  });

  it('previews a genuinely future database read-only but refuses its restore even with force', async () => {
    const source = await makeSource(true); const target = makeTarget(); source.db.close();
    const future = new Database(source.path); future.pragma('user_version = 99');
    // Its Records layout is deliberately unknown to this binary. Only generic
    // row counts and version agreement may be inspected; it cannot be restored.
    future.exec('CREATE TABLE core_records (future_body TEXT)'); future.close();
    const payload = readFileSync(source.path);
    const manifest: ArchiveManifest = { ...source.exported.manifest, schema_version: 99, db_size_bytes: payload.length };
    const json = Buffer.from(JSON.stringify(manifest));
    const keys = deriveArchiveKeys(source.key, Buffer.from(manifest.encryption.salt_hex, 'hex'));
    const encrypted = encryptRecord(keys.content, payload); const name = Buffer.from(FILE_NAMES.db);
    const body = Buffer.concat([MAGIC, uint32BE(json.length), json, uint32BE(name.length), name, uint32BE(encrypted.length), encrypted]);
    const hmac = createArchiveHmac(keys.hmac); hmac.update(body);
    const futurePath = join(source.root, 'future.recued.archive'); writeFileSync(futurePath, Buffer.concat([body, hmac.finalize()]));
    expect((await target.runtime.readManifest(futurePath, source.mnemonic)).schema_version).toBe(99);
    await expect(stageRestore(target.targets, { archivePath: futurePath, recoveryKey: source.key, consumerVersion: '0.2.0', allowFutureVersion: true })).rejects.toThrow(/DATABASE_SCHEMA_TOO_NEW/);
    expect(target.db.prepare('SELECT body FROM original_rows').get()).toEqual({ body: 'original live data' });
  });
});
