/** A watcher step that omits an optional argument runs as if it were absent.
 *
 *  ⛔ WHY THIS EXISTS. Dispatch merges an ingredient manifest's declared `input`
 *  under the step's own args (`mergeManifestStepInput`), and every watcher
 *  manifest declares its optional inputs as `null`. So a step that omits
 *  `filter` reaches its watcher with `filter: null`, while the handlers are typed
 *  `filter?: string` and guard it with `!== undefined`. Found by driving a live
 *  server: "Meeting alerts before each event" failed every minute with "Cannot
 *  read properties of null (reading 'length')". The web-watch pack's two page
 *  watchers threw "previous_etag must be a string if provided" on every tick,
 *  and every unit test passed, because each one hand-built the watcher's args
 *  and never included the manifest's nulls.
 *
 *  So each case here merges the REAL kernel manifest exactly as dispatch does,
 *  and goes through the real dispatcher. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeManifestStepInput } from '@recued/ingredients';

import type { CollectionRegistry } from '../../collections/registry.js';
import type { Collection } from '../../collections/types.js';
import { KERNEL_MANIFESTS } from '../../kernel-manifests.js';
import { createWatcherDispatcher } from '../index.js';
import { ensureTimeRelativeWatcherSchema } from '../time-relative-watcher.js';

const NOW = 1_700_000_000_000;

/** The args a watcher receives for a step that passes `stepArgs`: the manifest's
 *  declared inputs under them, as `mergeManifestStepInput` builds them. */
const dispatched = (slug: string, stepArgs: Record<string, unknown>): Record<string, unknown> => {
  const manifest = KERNEL_MANIFESTS.find((m) => m.slug === slug);
  if (!manifest) throw new Error(`no kernel manifest ${slug}`);
  return mergeManifestStepInput(manifest.input, stepArgs, { trustedSurfaceDispatch: false });
};

const calendar = (records: Record<string, unknown>[]): CollectionRegistry => {
  const collection = { platform: 'calendar', slug: 'primary', list: () => records } as unknown as Collection;
  return {
    register: () => undefined,
    get: () => collection,
    unregister: () => false,
    list: () => [collection],
    dispose: async () => undefined,
  };
};

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

describe('a watcher step that omits an optional argument', () => {
  it('the premise: dispatch hands the watcher null for every input the step omits', () => {
    expect(dispatched('time-relative-watcher', { collection: 'data.calendar' })).toMatchObject({ filter: null });
    expect(dispatched('http-watcher', { target_url: 'https://example.com' })).toMatchObject({ previous_etag: null });
  });

  it('⛔ time-relative: no filter means no filter, and the meeting alert fires', async () => {
    const db = new Database(':memory:');
    dbs.push(db);
    ensureTimeRelativeWatcherSchema(db);
    // A meeting 30 minutes away, and a -1h alert: its boundary passed 30 minutes ago.
    const watch = createWatcherDispatcher({
      db, collectionRegistry: calendar([{ _id: 'evt-1', hot_fields: { start_at: NOW + 30 * 60_000 } }]), now: () => NOW,
    });
    const out = await watch({
      slug: 'time-relative-watcher',
      args: dispatched('time-relative-watcher', {
        collection: 'data.calendar', anchor_field: 'start_at', offsets: ['-1h'], recipe_id: 'time-alert-before-event',
      }),
    });
    expect(out).toMatchObject({ should_run: true, trigger_record_id: 'evt-1', trigger_offset: '-1h' });
  });

  it('⛔ http: no previous etag means a first look, not a refusal', async () => {
    const fetchFn = (async () => new Response('<p>price: 10</p>', {
      status: 200, headers: { etag: '"v1"' },
    })) as unknown as typeof fetch;
    const watch = createWatcherDispatcher({ fetchFn, now: () => NOW });
    const out = await watch({
      slug: 'http-watcher',
      // As web-watch's recipes pass it: a hash cursor, and no etag.
      args: dispatched('http-watcher', { target_url: 'https://example.com/pricing', previous_hash: undefined }),
    });
    expect(out).toMatchObject({ should_run: true });
  });

  it('time: a gate that names only its hours runs on every weekday', async () => {
    const watch = createWatcherDispatcher({ now: () => NOW });
    const out = await watch({ slug: 'time-watcher', args: dispatched('time-watcher', { start_hour: 0, end_hour: 24 }) });
    expect(out).toMatchObject({ should_run: true });
  });
});
