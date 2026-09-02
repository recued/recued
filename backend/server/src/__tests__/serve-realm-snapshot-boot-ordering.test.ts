/** Does the per-realm snapshot fire BEFORE the schema DDL?
 *
 *  The unit tests in `update/__tests__/realm-generation-snapshot.test.ts` prove
 *  the module decides correctly. They cannot prove the thing that actually
 *  matters, which is a property of the COMPOSITION ROOT: that the call sits
 *  ahead of every store constructor. Move it three lines down, past the first
 *  store, and every one of those unit tests still passes while the snapshot
 *  captures an ALREADY-MIGRATED database — a backup of the wrong moment, which
 *  is worse than none because it looks like one.
 *
 *  So this drives `composeStorageContext` itself and reads the ordering off a
 *  real destructive migration: `enrichment-store.ts` DROPs `model_used`
 *  (D-136 P2). A snapshot that still holds that column was taken first.
 */
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeConfigStore } from '@recued/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBootTrace } from '../cli/boot-trace.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import { SERVER_VERSION } from '../server-version.js';
import {
  legacyRealmSnapshotPath,
  realmReleaseMarkerPath,
  realmSnapshotPath,
  realmSnapshotMetadataPath,
  readReleaseGenerationTransition,
  releaseGenerationTransitionPath,
  writeReleaseGenerationTransition,
} from '../update/realm-generation-snapshot.js';
import { createUpdateLedger, UPDATE_LEDGER_FILE } from '../update/update-ledger.js';

let tmp: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const boot = async (dbPath: string): Promise<void> => {
  const ctx = await composeStorageContext({
    dbPath,
    bootTrace: createBootTrace({
      entrypoint: 'serve-entry',
      profile: 'serve',
      command: 'serve',
      env: {},
      now: () => 1000,
      sink: () => {},
    }),
    runtimeConfig: createRuntimeConfigStore({}),
    vaultQuotas: { perPublisherBytes: 1_000_000, totalBytes: 5_000_000 },
  });
  ctx.db.close();
};

const columns = (dbPath: string, table: string): Set<string> => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return new Set(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((r) => (r as { name: string }).name),
    );
  } finally {
    db.close();
  }
};

describe('per-realm snapshot ordering at the composition root', () => {
  it('captures the database BEFORE a destructive migration drops a column', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'realm-boot-'));
    const dbPath = join(tmp, 'server.db');

    // Boot once so the schema exists the way this binary builds it.
    await boot(dbPath);
    expect(columns(dbPath, 'data_enrichment').has('model_used')).toBe(false);

    // Now age the realm: give it back the legacy column this release drops, and
    // clear the marker so the next boot is "a realm meeting an unfamiliar
    // binary" — which is exactly the stop / back up / update / restore case.
    const aged = new Database(dbPath);
    aged.exec('ALTER TABLE data_enrichment ADD COLUMN model_used TEXT');
    aged.close();
    rmSync(realmReleaseMarkerPath(dbPath));
    rmSync(realmSnapshotPath(dbPath), { force: true });

    await boot(dbPath);

    // The live database migrated, as it must.
    expect(columns(dbPath, 'data_enrichment').has('model_used')).toBe(false);

    // ⛔ And the snapshot holds the state BEFORE that drop. This is the whole
    // assertion: it can only be true if the snapshot ran ahead of store setup.
    const snapshot = realmSnapshotPath(dbPath);
    expect(existsSync(snapshot)).toBe(true);
    expect(columns(snapshot, 'data_enrichment').has('model_used')).toBe(true);
  });

  it('does not re-snapshot a realm rebooting on the same release', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'realm-boot-same-'));
    const dbPath = join(tmp, 'server.db');

    await boot(dbPath);
    rmSync(realmSnapshotPath(dbPath), { force: true });
    await boot(dbPath);

    // An ordinary restart is not a generation change, so it costs no copy — and
    // more importantly cannot overwrite a snapshot a rollback still needs.
    expect(existsSync(realmSnapshotPath(dbPath))).toBe(false);
  });

  it('reconstructs and scopes a deployed N-1 migration snapshot before store DDL', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'realm-boot-n-minus-one-'));
    const dbPath = join(tmp, 'server.db');
    const binaryPath = join(tmp, 'bin', 'recued');
    vi.stubEnv('RECUED_DISTRIBUTION_CHANNEL', 'docker-thin');
    vi.stubEnv('RECUED_BIN_DIR', join(tmp, 'bin'));

    await boot(dbPath);
    const aged = new Database(dbPath);
    aged.exec('ALTER TABLE data_enrichment ADD COLUMN model_used TEXT');
    aged.close();

    const legacy = legacyRealmSnapshotPath(dbPath);
    copyFileSync(dbPath, legacy);
    // Keep the same-release marker from the earlier visit. A deployed N-1
    // binary does not know how to update this scoped sidecar, so the in-flight
    // apply proof must take precedence over that stale shortcut.
    rmSync(realmSnapshotPath(dbPath), { force: true });
    rmSync(realmSnapshotMetadataPath(dbPath), { force: true });
    rmSync(releaseGenerationTransitionPath(binaryPath), { force: true });
    createUpdateLedger(join(tmp, UPDATE_LEDGER_FILE)).append({
      id: 'deployed-n-minus-one-apply',
      kind: 'apply_started',
      at: 1,
      from_version: '26.8.31',
      to_version: SERVER_VERSION,
      channel: 'stable',
      trigger: 'manual',
      release_identity: `stable:${SERVER_VERSION}`,
      migration: true,
      snapshot_ref: legacy,
    });

    await boot(dbPath);

    const scoped = realmSnapshotPath(dbPath);
    expect(existsSync(legacy)).toBe(false);
    expect(columns(scoped, 'data_enrichment').has('model_used')).toBe(true);
    expect(columns(dbPath, 'data_enrichment').has('model_used')).toBe(false);
    expect(readReleaseGenerationTransition(binaryPath)).toMatchObject({
      from_version: '26.8.31',
      to_version: SERVER_VERSION,
      migration: true,
    });
  });

  it('does not let a sibling realm inherit a current apply from the shared ledger', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'realm-boot-sibling-ledger-'));
    const a = join(tmp, 'a.db');
    const b = join(tmp, 'b.db');
    const binaryPath = join(tmp, 'bin', 'recued');
    vi.stubEnv('RECUED_DISTRIBUTION_CHANNEL', 'docker-thin');
    vi.stubEnv('RECUED_BIN_DIR', join(tmp, 'bin'));

    await boot(a);
    await boot(b);
    const aged = new Database(b);
    aged.exec('ALTER TABLE data_enrichment ADD COLUMN model_used TEXT');
    aged.close();
    rmSync(realmReleaseMarkerPath(b), { force: true });
    rmSync(realmSnapshotPath(b), { force: true });
    rmSync(realmSnapshotMetadataPath(b), { force: true });

    const transition = {
      schema: 1 as const,
      from_version: '26.8.31',
      to_version: SERVER_VERSION,
      migration: true,
    };
    writeReleaseGenerationTransition(binaryPath, transition);
    createUpdateLedger(join(tmp, UPDATE_LEDGER_FILE)).append({
      id: 'realm-a-current-apply',
      kind: 'apply_started',
      at: 1,
      from_version: transition.from_version,
      to_version: transition.to_version,
      channel: 'stable',
      trigger: 'manual',
      release_identity: `stable:${SERVER_VERSION}`,
      migration: true,
      snapshot_ref: realmSnapshotPath(a),
    });

    await boot(b);

    expect(columns(b, 'data_enrichment').has('model_used')).toBe(false);
    expect(columns(realmSnapshotPath(b), 'data_enrichment').has('model_used')).toBe(true);
  });
});
