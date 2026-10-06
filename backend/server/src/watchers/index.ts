/** D-115 Phase 6 — server-side watcher dispatcher composition.
 *
 *  One factory that closes over the server's available deps
 *  (collectionRegistry, db, fetchFn) and returns a dispatcher compatible
 *  with `KernelDispatchers.watcher`. Each watcher slug routes to its
 *  handler; a handler whose dep is unwired throws `SERVER_NOT_REACHABLE`
 *  so reactive recipes fail cleanly in dep-less harnesses.
 *
 *  Three watchers: `time-watcher`, `time-relative-watcher` and
 *  `http-watcher`. ⛔ The mail, file, calendar, webhook and recipe
 *  watchers were RETIRED 2026-10-05 — no shipped recipe used one, and
 *  each had a replacement every shipped recipe already used: event
 *  triggers on `data.mail` / `data.file` / `data.calendar` (narrowed to
 *  the one a dish names with a `{{config.<setting>}}` pattern part),
 *  D-201 `webhook_triggers`, and `run.<recipe>.*` events. (DOM watching
 *  is NOT here either — it runs through the D-179 reactive watch-poll
 *  source, which reads via the paired Bridge; see `watch/dom-source.ts`.) */

import {
  IngredientError,
  evaluateTimeWatcher,
  type KernelDispatchers,
  type KernelWatcherSlug,
  type TimeWatcherArgs,
} from '@recued/ingredients';
import type Database from 'better-sqlite3';

import type { CollectionRegistry } from '../collections/registry.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import { handleHttpWatcher } from './http-watcher-memory.js';
import {
  handleTimeRelativeWatcher,
  type TimeRelativeWatcherArgs,
} from './time-relative-watcher.js';

export interface WatcherDispatcherDeps {
  /** Collection lookup for the time-relative watcher's anchors (calendar
   *  events, mail, files). */
  collectionRegistry?: CollectionRegistry;
  /** Test-only injection for http-watcher fetch. */
  fetchFn?: typeof fetch;
  /** Test-only clock injection, so deterministic-time harnesses can seed
   *  records relative to a fixed `now`. Production leaves this undefined —
   *  handlers fall back to `Date.now()`. */
  now?: () => number;
  /** D-269 — the zone a time window is read in: the server's resolved zone
   *  (declared, or the host's), read per call like the cron scheduler's, so a
   *  `core.watch.time` window and a cron schedule mean the same 8:00. Absent ⇒
   *  this process's own zone (a harness with no zone store). */
  serverTimeZone?: () => string | undefined;
  /** D-122 Phase 4.5 — db handle for the time-relative-watcher state
   *  table, and the page watcher's memory (`once_per_change`). Absent ⇒
   *  `time-relative-watcher` and `once_per_change` throw SERVER_NOT_REACHABLE. */
  db?: Database.Database;
  /** D-193 — work-entity task anchors for time-relative reminder recipes. */
  workEntityStore?: Pick<WorkEntityStore, 'listTasks'>;
}

type WatcherDispatcher = NonNullable<KernelDispatchers['watcher']>;

/** Narrow a dep to its non-null value, or throw SERVER_NOT_REACHABLE
 *  with a consistent message shape. */
const requireDep = <K extends keyof WatcherDispatcherDeps>(
  deps: WatcherDispatcherDeps,
  key: K,
  slug: KernelWatcherSlug,
  reason: string,
): NonNullable<WatcherDispatcherDeps[K]> => {
  const value = deps[key];
  if (value === undefined) {
    throw new IngredientError(
      'SERVER_NOT_REACHABLE',
      `${slug} unavailable — ${reason}`,
      { slug },
    );
  }
  return value as NonNullable<WatcherDispatcherDeps[K]>;
};

/** ⛔ For a watcher, `null` means "not given". Dispatch merges a manifest's declared
 *  `input` under the step's own args (`mergeManifestStepInput`), and every watcher
 *  manifest declares its optional inputs as `null`. So a step that omits one hands its
 *  watcher a `null`, while the handlers are typed with OPTIONAL fields and guard them
 *  with `!== undefined`. The null got past those guards and broke three watchers:
 *  - a meeting alert threw every minute ("Cannot read properties of null (reading
 *    'length')", time-relative's `filter`);
 *  - both web-watch page watchers refused every tick (http's `previous_etag`);
 *  - a time gate naming only its hours would have been refused.
 *  Dropped here, once, for all of them, so the casts below are true. */
const withoutNulls = (args: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null));

export const createWatcherDispatcher = (
  deps: WatcherDispatcherDeps,
): WatcherDispatcher => {
  return async ({ slug, args: given }) => {
    const args = withoutNulls(given);
    switch (slug satisfies KernelWatcherSlug) {
      case 'time-watcher':
        return evaluateTimeWatcher(
          args as TimeWatcherArgs,
          new Date(deps.now?.() ?? Date.now()),
          deps.serverTimeZone?.(),
        );
      case 'http-watcher':
        // `once_per_change` keeps the page in `deps.db` (http-watcher-memory.ts).
        return handleHttpWatcher(
          {
            ...(deps.db ? { db: deps.db } : {}),
            ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
            ...(deps.now ? { now: deps.now } : {}),
          },
          args,
        );
      case 'time-relative-watcher': {
        const db = requireDep(
          deps,
          'db',
          slug,
          'sqlite handle not configured on this server',
        );
        return handleTimeRelativeWatcher(
          {
            db,
            ...(deps.collectionRegistry ? { registry: deps.collectionRegistry } : {}),
            ...(deps.workEntityStore ? { workEntityStore: deps.workEntityStore } : {}),
            ...(deps.now ? { now: deps.now } : {}),
          },
          args as unknown as TimeRelativeWatcherArgs,
        );
      }
      default:
        // The `runtime.testTrigger` rpc boundary CASTS a `slug: string` into
        // `KernelWatcherSlug`, so an unknown / stale slug (a retired one like the
        // removed `dom-watcher` or the five retired 2026-10-05, or a typo) reaches
        // here at runtime even though the type says `never`. Fail closed with the
        // SERVER_NOT_REACHABLE those handlers document + map to a 503, rather than
        // falling through to an `undefined` return the caller dereferences.
        throw new IngredientError(
          'SERVER_NOT_REACHABLE',
          `unknown watcher slug '${String(slug)}' — not a server-handled kernel watcher`,
          { slug: String(slug) },
        );
    }
  };
};
