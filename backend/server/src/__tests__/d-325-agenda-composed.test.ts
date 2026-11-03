/**
 * D-325 §15.7 amendment (2026-11-02, later) — the Agenda, as the server composes it.
 *
 * The scheduler's own tests hand it a `prepNotesReady` stub. This one runs the composed
 * half for real: the app context's enrichment store, the collection context's situation
 * query over a real calendar table, and the reader the composition root gives the
 * scheduler. A dropped wire there reads "Morning briefing" with no "prep notes ready",
 * and every stubbed test stays green.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntimeConfigStore } from '@recued/config';
import type { CanonicalEvent, PreparationNotesValue } from '@recued/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { createBootTrace } from '../cli/boot-trace.js';
import type { Collection } from '../collections/types.js';
import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import { createExecutionLateBoundRefs } from '../serve/compose-execution-context.js';
import { createSituationAccess } from '../situations/access.js';
import { createServerTimeZoneStore } from '../storage/server-timezone-store.js';
import { unlockServerVault } from './helpers/unlocked-vault.js';

const prep: PreparationNotesValue = { summary: 'Prep brief: agree the week’s priorities.', key_points: ['Budget is still open'],
  attendees_considered: ['ana@example.com'], corpus_size: 3, computed_at: 1 };

describe('D-325 — the composed Agenda reads the calendar and the prep notes the server keeps', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('lists tomorrow’s meetings in time order and says which have prep notes ready', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-agenda-')); dirs.push(dir);
    const dbPath = join(dir, 'server.db');
    const runtimeConfig = createRuntimeConfigStore({});
    const storage = await composeStorageContext({ dbPath, runtimeConfig,
      bootTrace: createBootTrace({ entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {} }),
      vaultQuotas: { perPublisherBytes: 1_000_000, totalBytes: 5_000_000 } });
    try {
      const db = storage.db!;
      createServerTimeZoneStore(db).write('fixed', 'UTC', Date.now());
      const app = composeAppContext({ db, dbPath, envLlmConfig: storage.envLlmConfig, gateRegistry: storage.gateRegistry,
        auditLog: storage.auditLog, eventBus: storage.eventBus, serverInstanceId: storage.serverInstanceId, recipeStore: storage.recipeStore,
        pairedInstances: storage.pairedInstances, workEntityStore: storage.workEntityStoreRef, chatLateBound: createExecutionLateBoundRefs() });
      await unlockServerVault(app.keys!);
      // As `start-post-storage-app-collection-execution-runtime` passes them.
      const collection = composeCollectionContext({ db, dbPath, runtimeConfig, manifests: storage.manifests,
        baseVault: storage.baseVault, auditLog: storage.auditLog, cacheBlobs: app.cacheBlobs, warehouseBus: app.warehouseBus,
        contactStore: app.contactStoreRef, mailFactStore: storage.mailFactStoreRef, gateRegistry: storage.gateRegistry,
        accountStore: storage.accountStore, eventBus: storage.eventBus, keys: app.keys, connectionStore: app.connectionStoreRef,
        workEntityStore: storage.workEntityStoreRef, enrichmentCascade: app.enrichmentCascadeRef,
        ...(app.enrichmentStoreRef ? { enrichmentStore: app.enrichmentStoreRef } : {}) });
      const scheduled = collection.scheduledSituations!;
      // As `compose-execution-context` binds it.
      scheduled.bindAccess(createSituationAccess({ contracts: app.contractStoreRef!, query: collection.querySituation!,
        ...(collection.spheres ? { spheres: collection.spheres } : {}), isVaultUnlocked: app.isVaultUnlocked ?? (() => false) }));
      // One calendar, as an enrolled one appears to the situation sources: by platform and slug.
      collection.collectionRegistry.register({ platform: 'calendar', slug: 'work' } as unknown as Collection);
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      const at = (hhmm: string) => Date.parse(`${tomorrow}T${hhmm}:00Z`);
      const table = createCalendarTable({ db, slug: 'work' });
      const event = (source_id: string, summary: string, from: string, to: string, recurring?: string): CanonicalEvent => ({
        source_id, ical_uid: `uid-${source_id}`, calendar_id: 'primary', summary, start_at: at(from), end_at: at(to), timezone: 'UTC',
        is_all_day: false, status: 'confirmed', created_at: 1, updated_at: 1, ...(recurring ? { recurring_event_id: recurring } : {}) });
      table.upsert({ event: event('jog', 'Jogging', '06:30', '07:15', 'jog-series'), size_bytes: 0 });
      table.upsert({ event: event('briefing', 'Morning briefing', '09:00', '09:30', 'briefing-series'), size_bytes: 0 });
      table.upsert({ event: event('lunch', 'Lunch with Ana', '12:30', '13:30'), size_bytes: 0 });
      // `upsert` returns the row it replaced; the new one is read back.
      const briefing = table.listSnapshots({ limit: 10 }).find(row => row.event.source_id === 'briefing')!;
      app.enrichmentStoreRef!.upsert({ topic: 'preparation_notes', scope: 'calendar', target_id: briefing.record_id, value: prep,
        authored_by: 'housekeeping:preparation_notes' });

      scheduled.setAgenda({ day: 'tomorrow' }); await scheduled.sendAgendaNow();
      expect(scheduled.agendaStatus().last_run!.text.split('\n'))
        .toEqual(['06:30 Jogging', '09:00 Morning briefing · prep notes ready', '12:30 Lunch with Ana']);

      // §15.7 amendment (2026-11-03): a week reads the same calendar over seven days, a day at a time.
      const later = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
      table.upsert({ event: { ...event('dentist', 'Dentist', '10:00', '10:30'), start_at: Date.parse(`${later}T10:00:00Z`),
        end_at: Date.parse(`${later}T10:30:00Z`) }, size_bytes: 0 });
      const title = (day: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
        .format(Date.parse(`${day}T00:00:00Z`));
      scheduled.setAgenda({ frequency: 'weekly' }); await scheduled.sendAgendaNow();
      expect(scheduled.agendaStatus().last_run!.text.split('\n')).toEqual([title(tomorrow), '06:30 Jogging', '09:00 Morning briefing · prep notes ready',
        '12:30 Lunch with Ana', '', title(later), '10:00 Dentist']);
    } finally { storage.db?.close(); }
  });
});
