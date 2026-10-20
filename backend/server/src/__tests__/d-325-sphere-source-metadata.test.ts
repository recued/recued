import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionSource } from '@recued/contracts';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel, type NotificationSettings, type PendingAsk } from '@recued/notification';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createYoursService } from '../situations/yours-service.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createSphereStore } from '../storage/sphere-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';

const owner: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'paired' };
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const fixture = (sphereSources?: () => Array<{ source: string; name: string }>) => {
  let measured: string[] | undefined;
  const db = new Database(':memory:', { verbose(sql) { if (measured) measured.push(String(sql)); } });
  ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const now = () => Date.parse('2026-10-17T12:00:00Z');
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now, timeZone: () => 'UTC' });
  const spheres = createSphereStore(db, work);
  const service = createYoursService({ db, work, dispatchers, occurrences, spheres, situations: createSituationStore(db), now,
    ...(sphereSources ? { sphereSources } : {}) });
  disposals.push(async () => { await service.stop(); db.close(); });
  const snapshot = async () => {
    const sql: string[] = []; measured = sql;
    try { return { value: await service.snapshot(), sql }; } finally { measured = undefined; }
  };
  const place = (source: string, sphere: 'personal' | 'professional' | null) => service.command({ action: 'sphere.source', source, sphere }, owner);
  return { db, work, spheres, service, snapshot, place };
};

describe('Yours sphere source metadata', () => {
  it('keeps source order, duplicate precedence, existing labels and exact source identities', async () => {
    const available = [
      { source: 'calendar:z', name: 'Family calendar' },
      { source: 'work:shared', name: 'Friendly work source' },
      { source: 'mail:a', name: 'Old inbox label' },
      { source: 'mail:a', name: 'Current inbox label' },
      { source: "mail:quoted' / source", name: 'Quoted inbox' },
      { source: '__proto__', name: 'Prototype label' },
    ];
    const f = fixture(() => available);
    for (const source of ['z:stored', 'work:shared', "mail:quoted' / source", '__proto__', 'a:stored']) f.spheres.setSource(source, 'professional');
    const first = (await f.snapshot()).value.sphere_sources!;
    expect(first).toEqual([
      { source: 'calendar:z', name: 'Family calendar' },
      { source: 'work:shared', name: 'work:shared', sphere: 'professional' },
      { source: 'mail:a', name: 'Current inbox label' },
      { source: "mail:quoted' / source", name: "mail:quoted' / source", sphere: 'professional' },
      { source: '__proto__', name: '__proto__', sphere: 'professional' },
      { source: 'a:stored', name: 'a:stored', sphere: 'professional' },
      { source: 'z:stored', name: 'z:stored', sphere: 'professional' },
    ]);
    expect(Object.hasOwn(first[0]!, 'sphere')).toBe(false);
    first[0]!.name = 'Changed in the returned snapshot';
    expect(available[0]!.name).toBe('Family calendar');
    expect((await f.snapshot()).value.sphere_sources?.[0]?.name).toBe('Family calendar');
  });

  it('reads source additions, updates, resets and descriptor changes on the next snapshot', async () => {
    let available = [{ source: 'mail:home', name: 'Home mail' }, { source: 'calendar:team', name: 'Team calendar' }];
    const f = fixture(() => available);
    await f.place('mail:home', 'personal'); await f.place('orphan:old', 'professional');
    const first = (await f.snapshot()).value.sphere_sources;
    expect(first).toEqual([
      { source: 'mail:home', name: 'mail:home', sphere: 'personal' },
      { source: 'calendar:team', name: 'Team calendar' },
      { source: 'orphan:old', name: 'orphan:old', sphere: 'professional' },
    ]);
    await f.place('mail:home', 'professional'); await f.place('orphan:old', null); await f.place('calendar:team', 'personal');
    available = [{ source: 'calendar:team', name: 'Renamed calendar' }, { source: 'mail:home', name: 'Renamed mail' }, { source: 'new:source', name: 'New source' }];
    expect((await f.snapshot()).value.sphere_sources).toEqual([
      { source: 'calendar:team', name: 'calendar:team', sphere: 'personal' },
      { source: 'mail:home', name: 'mail:home', sphere: 'professional' },
      { source: 'new:source', name: 'New source' },
    ]);
    await f.place('mail:home', null);
    expect((await f.snapshot()).value.sphere_sources?.[1]).toEqual({ source: 'mail:home', name: 'Renamed mail' });
    expect(first?.[0]).toEqual({ source: 'mail:home', name: 'mail:home', sphere: 'personal' });
  });

  it('reads metadata after destination delivery yields and keeps it stable across the later reply await', async () => {
    const available = [{ source: 'mail:home', name: 'Home mail' }]; const f = fixture(() => available);
    await f.place('mail:home', 'personal');
    const destinationEntered = gate(); const destinationRelease = gate();
    const repliesEntered = gate(); const repliesRelease = gate();
    let paused = true;
    const notifier = createNotificationBlock({
      askStore: createAskStore(createSQLiteCollection<PendingAsk>(f.db, 'pending_asks')),
      settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(f.db, 'notification_settings')),
      channels: [createUiChannel({ busSink: () => {} })],
    });
    f.service.bind({
      ...notifier,
      async getReminderDestinations() {
        if (paused) { destinationEntered.resolve(); await destinationRelease.promise; }
        return { destinations: [], issues: [] };
      },
      async listUnmatchedAskReplies() {
        if (paused) { repliesEntered.resolve(); await repliesRelease.promise; }
        return [];
      },
    });
    const reading = f.service.snapshot();
    try {
      await destinationEntered.promise;
      await f.place('mail:home', 'professional');
      available.push({ source: 'calendar:added', name: 'Added while waiting' });
      destinationRelease.resolve(); await repliesEntered.promise;
      await f.place('mail:home', null); repliesRelease.resolve();
      const first = await reading; paused = false;
      expect(first.sphere_sources).toEqual([
        { source: 'mail:home', name: 'mail:home', sphere: 'professional' },
        { source: 'calendar:added', name: 'Added while waiting' },
      ]);
      expect((await f.snapshot()).value.sphere_sources).toEqual(available);
    } finally { destinationRelease.resolve(); repliesRelease.resolve(); await reading; }
  });

  for (const count of [0, 1, 1001]) it(`uses one metadata SELECT for ${count} saved source placements`, async () => {
    const f = fixture();
    const sources = Array.from({ length: count }, (_, index) => `fixture:${String(index).padStart(5, '0')}`);
    f.db.transaction(() => { for (const source of [...sources].reverse()) f.spheres.setSource(source, 'personal'); })();
    const { value, sql } = await f.snapshot();
    expect(value.assets).toEqual([]); expect(value.total_assets).toBe(0);
    expect(value.sphere_sources).toEqual(sources.map(source => ({ source, name: source, sphere: 'personal' })));
    expect(sql.length).toBeGreaterThan(0);
    const metadataReads = sql.filter(statement => /\bFROM\s+sphere_sources\b/iu.test(statement));
    expect(metadataReads).toHaveLength(1);
    expect(metadataReads[0]).toMatch(/\bORDER BY source\b/iu);
    expect(metadataReads.some(statement => /\bWHERE\s+source\s*=/iu.test(statement))).toBe(false);
  });
});
