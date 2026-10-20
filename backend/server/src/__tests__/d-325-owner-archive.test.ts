import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdArchive } from '../commands/archive.js';
import { importArchive } from '../archive/archive-import.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';

it('runs two unattended encrypted archive exports to owner storage using an external key file and restores each snapshot', async () => {
  const realm = mkdtempSync(join(tmpdir(), 'd325-archive-realm-')); const offsite = mkdtempSync(join(tmpdir(), 'd325-owner-storage-'));
  const key = Buffer.alloc(32, 5); const keyFile = join(offsite, 'recovery.key'); writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}); const dbPath = join(realm, 'recued-server.db');
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath); ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
    const source = { kind: 'owner' as const, ref: 'owner:local' };
    const asset = work.writeAsset({ source_id: 'recued.asset', source, name: 'Private passport', document_number: 'PRIVATE-D325-ARCHIVE-12345', dates: { expires_on: '2027-04-17' },
      readings: { battery: { value: 50, unit: '%', as_of: 90, evidence: [] } },
      observations: { damage: { active: false, certainty: 'confirmed', as_of: 90, evidence: [], source: 'owner' } } }, 100);
    for (const path of ['readings.battery', 'observations.damage']) {
      const value = path.startsWith('readings.') ? asset.readings.battery! : asset.observations.damage!;
      work.allowAssetAutomaticUpdates({ id: asset.id, path, expected: { value, source: asset.field_sources[path]! } }, 150);
    }
    // Each invocation has the same non-interactive input as a cron/launchd job.
    // The key remains an operator-owned file outside the server database.
    const deps = { dbPath, dataPath: realm, configPath: null, serverVersion: '0.2.0' };
    const first = join(offsite, 'first.recued.archive'); const second = join(offsite, 'second.recued.archive');
    await cmdArchive(deps, ['export', first, `--key-file=${keyFile}`]);
    work.writeAsset({ id: asset.id, source_id: asset.source_id, source, dates: { expires_on: '2029-04-17' } }, 200);
    await cmdArchive(deps, ['export', second, `--key-file=${keyFile}`]);
    expect(readFileSync(first).includes(Buffer.from('PRIVATE-D325-ARCHIVE-12345'))).toBe(false);
    expect(readFileSync(second).includes(Buffer.from(key.toString('hex')))).toBe(false);
    for (const [path, expected] of [[first, '2027-04-17'], [second, '2029-04-17']]) {
      const imported = await importArchive({ archivePath: path!, recoveryKey: key, consumerVersion: '0.2.0' });
      const restored = new Database(imported.db); try {
        const restoredWork = createWorkEntityStore(restored); const restoredAsset = restoredWork.readAsset(asset.id)!;
        expect(restoredAsset.dates.expires_on).toBe(expected);
        expect(restoredAsset.automatic_updates).toEqual({ 'readings.battery': 150, 'observations.damage': 150 });
        expect(restoredWork.assetObservationHandoffs(asset.id)).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: 'readings.battery', value: asset.readings.battery, source: asset.field_sources['readings.battery'] }),
          expect.objectContaining({ path: 'observations.damage', value: asset.observations.damage, source: asset.field_sources['observations.damage'] }),
        ]));
      } finally { restored.close(); }
    }
    expect(log.mock.calls.flat().join(' ')).not.toContain(key.toString('hex'));
    await expect(importArchive({ archivePath: second, recoveryKey: Buffer.alloc(32, 7), consumerVersion: '0.2.0' })).rejects.toThrow();
  } finally { db?.close(); key.fill(0); log.mockRestore(); rmSync(realm, { recursive: true, force: true }); rmSync(offsite, { recursive: true, force: true }); }
});
