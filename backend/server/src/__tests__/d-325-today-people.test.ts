/**
 * D-325 §15.4 — Today names the people its items carry. An item keeps their ids
 * (§6.2), so the composed server looks each one up in the owner's contacts: by
 * contact id, then by address.
 *
 * Real throughout the composed half: the collection context's Yours service, its
 * situation query and the contact store.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntimeConfigStore } from '@recued/config';
import { afterEach, describe, expect, it } from 'vitest';

import { createBootTrace } from '../cli/boot-trace.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import { createExecutionLateBoundRefs } from '../serve/compose-execution-context.js';
import { unlockServerVault } from './helpers/unlocked-vault.js';

const DAY = 86_400_000;

describe('D-325 — Today names the people on its items', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('gives a birthday’s person by name from the composed contact store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-today-people-')); dirs.push(dir);
    const dbPath = join(dir, 'server.db');
    const runtimeConfig = createRuntimeConfigStore({});
    const storage = await composeStorageContext({ dbPath, runtimeConfig,
      bootTrace: createBootTrace({ entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {} }),
      vaultQuotas: { perPublisherBytes: 1_000_000, totalBytes: 5_000_000 } });
    try {
      const app = composeAppContext({ db: storage.db, dbPath, envLlmConfig: storage.envLlmConfig, gateRegistry: storage.gateRegistry,
        auditLog: storage.auditLog, eventBus: storage.eventBus, serverInstanceId: storage.serverInstanceId, recipeStore: storage.recipeStore,
        pairedInstances: storage.pairedInstances, workEntityStore: storage.workEntityStoreRef, chatLateBound: createExecutionLateBoundRefs() });
      await unlockServerVault(app.keys!);
      const collection = composeCollectionContext({ db: storage.db, dbPath, runtimeConfig, manifests: storage.manifests,
        baseVault: storage.baseVault, auditLog: storage.auditLog, cacheBlobs: app.cacheBlobs, warehouseBus: app.warehouseBus,
        contactStore: app.contactStoreRef, mailFactStore: storage.mailFactStoreRef, gateRegistry: storage.gateRegistry,
        accountStore: storage.accountStore, eventBus: storage.eventBus, keys: app.keys, connectionStore: app.connectionStoreRef,
        workEntityStore: storage.workEntityStoreRef, enrichmentCascade: app.enrichmentCascadeRef });
      const now = Date.now(); const soon = new Date(now + 3 * DAY);
      const ana = app.contactStoreRef!.upsertManual({ email: 'ana@example.test', name: 'Ana Lima',
        birthday: `--${String(soon.getUTCMonth() + 1).padStart(2, '0')}-${String(soon.getUTCDate()).padStart(2, '0')}` });
      const today = await collection.yours!.today({ now, before: now + 7 * DAY });
      expect(today.situations.clusters.flatMap(cluster => cluster.items).flatMap(item => item.who.value ?? [])).toContain(ana.contact_id);
      expect(today.people).toEqual({ [ana.contact_id!]: 'Ana Lima' });
    } finally { storage.db.close(); }
  });
});
