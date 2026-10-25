/**
 * D-325 — the situation tool's `people` are the people a model can name. A model
 * names people as the owner does, by name or address, and never sees a contact's
 * id; an item holds ids. Live, asked whether Ana Lin had what she needed for a
 * trip, the model passed `people: ["Ana Lin"]`, every item came back with the
 * holder `outside`, and it answered that her passport and visa were someone
 * else's.
 *
 * Real throughout the composed half: the collection context's situation query,
 * its contact source and the contact store.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntimeConfigStore } from '@recued/config';
import type { SituationQuery } from '@recued/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { createBootTrace } from '../cli/boot-trace.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import { createExecutionLateBoundRefs } from '../serve/compose-execution-context.js';
import type { SituationReadContext } from '../situations/query.js';
import { unlockServerVault } from './helpers/unlocked-vault.js';

const DAY = 86_400_000;
const annual = (at: number): string => { const day = new Date(at);
  return `--${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate()).padStart(2, '0')}`; };
const owner = (denied: string[] = []): SituationReadContext => ({ owner: true, grants: { isVerbOpGranted: () => true,
  isCollectionReadGranted: (collection: string) => !denied.includes(collection), isTopicReadGranted: () => true } });

describe('D-325 — a situation query names people as the owner does', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  const compose = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-situation-people-')); dirs.push(dir);
    const dbPath = join(dir, 'server.db');
    const runtimeConfig = createRuntimeConfigStore({});
    const storage = await composeStorageContext({ dbPath, runtimeConfig,
      bootTrace: createBootTrace({ entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {} }),
      vaultQuotas: { perPublisherBytes: 1_000_000, totalBytes: 5_000_000 } });
    const app = composeAppContext({ db: storage.db, dbPath, envLlmConfig: storage.envLlmConfig, gateRegistry: storage.gateRegistry,
      auditLog: storage.auditLog, eventBus: storage.eventBus, serverInstanceId: storage.serverInstanceId, recipeStore: storage.recipeStore,
      pairedInstances: storage.pairedInstances, workEntityStore: storage.workEntityStoreRef, chatLateBound: createExecutionLateBoundRefs() });
    await unlockServerVault(app.keys!);
    const collection = composeCollectionContext({ db: storage.db, dbPath, runtimeConfig, manifests: storage.manifests,
      baseVault: storage.baseVault, auditLog: storage.auditLog, cacheBlobs: app.cacheBlobs, warehouseBus: app.warehouseBus,
      contactStore: app.contactStoreRef, mailFactStore: storage.mailFactStoreRef, gateRegistry: storage.gateRegistry,
      accountStore: storage.accountStore, eventBus: storage.eventBus, keys: app.keys, connectionStore: app.connectionStoreRef,
      workEntityStore: storage.workEntityStoreRef, enrichmentCascade: app.enrichmentCascadeRef });
    const now = Date.now();
    const person = (email: string, name: string, inDays: number) => app.contactStoreRef!.upsertManual({ email, name, birthday: annual(now + inDays * DAY) });
    const query = (patch: Partial<SituationQuery>, context = owner()) =>
      collection.querySituation!({ time: { from: now, to: now + 7 * DAY }, surface: 'tool', ...patch }, context);
    const whoOf = async (patch: Partial<SituationQuery>, context?: SituationReadContext) => Object.fromEntries((await query(patch, context))
      .clusters.flatMap(cluster => cluster.items).map(item => [item.who.value?.[0], item.who.verdict]));
    return { storage, person, query, whoOf };
  };

  it("matches the person by name, address or id, and puts everyone else outside", async () => {
    const { storage, person, whoOf } = await compose();
    try {
      const ana = person('ana.lin@example.test', 'Ana Lin', 3); const bob = person('bob.stone@example.test', 'Bob Stone', 4);
      for (const asked of ['Ana Lin', 'ana.lin@example.test', ana.contact_id!]) {
        expect(await whoOf({ people: [asked] }), asked).toEqual({ [ana.contact_id!]: 'match', [bob.contact_id!]: 'outside' });
      }
      expect(await whoOf({ people: ['Ana Lin', 'Bob Stone'] })).toEqual({ [ana.contact_id!]: 'near', [bob.contact_id!]: 'near' });
    } finally { storage.db.close(); }
  });

  it('rules nobody out by a name no contact holds', async () => {
    const { storage, person, whoOf } = await compose();
    try {
      const ana = person('ana.lin@example.test', 'Ana Lin', 3);
      expect(await whoOf({ people: ['Carla Dunn'] })).toEqual({ [ana.contact_id!]: 'unknown' });
      expect(await whoOf({ people: ['Ana Lin', 'Carla Dunn'] })).toEqual({ [ana.contact_id!]: 'near' });
    } finally { storage.db.close(); }
  });

  it('reaches past the span for the person named', async () => {
    const { storage, person, query } = await compose();
    try {
      const ana = person('ana.lin@example.test', 'Ana Lin', 40);
      const refs = async (patch: Partial<SituationQuery>) => (await query(patch)).clusters.flatMap(cluster => cluster.items).map(item => item.ref.id);
      expect(await refs({})).toEqual([]);
      expect(await refs({ people: ['Ana Lin'] })).toEqual([ana.contact_id]);
    } finally { storage.db.close(); }
  });

  it('asks which one when a name holds several people with items', async () => {
    const { storage, person, query } = await compose();
    try {
      const lin = person('ana.lin@example.test', 'Ana Lin', 3); const smith = person('ana.smith@example.test', 'Ana Smith', 5);
      const ambiguous = (await query({ people: ['Ana'] })).ambiguous;
      expect(ambiguous).toEqual([{ name: 'Ana', choices: expect.arrayContaining([
        expect.objectContaining({ collection: 'contact', id: lin.contact_id }), expect.objectContaining({ collection: 'contact', id: smith.contact_id })]) }]);
      expect((await query({ people: ['Ana Lin'] })).ambiguous).toEqual([]);
    } finally { storage.db.close(); }
  });
});
