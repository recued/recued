/** D-115 Phase 6 — server-side watcher dispatcher composition.
 *
 *  One factory that closes over the server's available deps
 *  (auditLog, collectionRegistry, calendarWatcherCursors,
 *  webhookQueue, fetchFn) and returns a dispatcher compatible with
 *  `KernelDispatchers.watcher`. Each watcher slug routes to its
 *  handler; a handler whose dep is unwired throws `SERVER_NOT_REACHABLE`
 *  so reactive recipes fail cleanly in dep-less harnesses.
 *
 *  Phase A wired `time-watcher`, `recipe-watcher`, `http-watcher`
 *  alongside the existing `calendar-watcher` (D-117 Phase 8).
 *  Phase B added `mail-watcher` + `file-watcher` (warehouse
 *  readers). Phase C wires `webhook-watcher` via the in-memory
 *  queue fed by the `/hook/{recipe_id}/{slug}` HTTP listener.
 *  (DOM watching is NOT here — it runs through the D-179 reactive
 *  watch-poll source, which reads via the paired Bridge; see
 *  `watch/dom-source.ts`.)
 *
 *  Calendar routes through the same `collectionRegistry` path as
 *  mail + file — the registry mirror registered by
 *  `registerCalendarCollections` keys live `CalendarCollection`s
 *  under `(platform='calendar', slug)`. The watcher cursor store
 *  is calendar-specific (per-recipe `changed_since` high-watermark)
 *  and is threaded as its own dep. */

import {
  IngredientError,
  evaluateHttpWatcher,
  evaluateRecipeWatcher,
  evaluateTimeWatcher,
  type HttpWatcherArgs,
  type KernelDispatchers,
  type KernelWatcherSlug,
  type RecipeWatcherArgs,
  type TimeWatcherArgs,
} from '@recued/ingredients';
import type { AuditLogStore } from '@recued/storage';
import type Database from 'better-sqlite3';

import type { CalendarCollection } from '../collections/calendar/calendar-collection.js';
import type { CalendarWatcherCursorStore } from '../collections/calendar/watcher-cursor-store.js';
import { handleCalendarWatcher } from '../collections/calendar/calendar-watcher.js';
import type { CollectionRegistry } from '../collections/registry.js';
import { handleFileWatcher } from '../collections/file/file-watcher.js';
import { handleMailWatcher } from '../collections/mail/mail-watcher.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import {
  handleWebhookWatcher,
  type WebhookWatcherQueue,
} from './webhook-watcher.js';
import {
  handleTimeRelativeWatcher,
  type TimeRelativeWatcherArgs,
} from './time-relative-watcher.js';

export interface WatcherDispatcherDeps {
  /** Optional — audit log may be absent in dbless CLI contexts.
   *  `recipe-watcher` throws SERVER_NOT_REACHABLE when missing;
   *  other watchers don't depend on it. */
  auditLog?: AuditLogStore;
  /** Collection lookup for mail + file + calendar watchers. Absent ⇒
   *  those watchers throw SERVER_NOT_REACHABLE. */
  collectionRegistry?: CollectionRegistry;
  /** Per-recipe `changed_since` cursor store for calendar-watcher.
   *  Absent ⇒ calendar-watcher throws SERVER_NOT_REACHABLE. */
  calendarWatcherCursors?: CalendarWatcherCursorStore;
  /** Queue fed by the `/hook/{recipe_id}/{slug}` HTTP listener.
   *  Absent ⇒ `webhook-watcher` throws SERVER_NOT_REACHABLE. */
  webhookQueue?: WebhookWatcherQueue;
  /** Test-only injection for http-watcher fetch. */
  fetchFn?: typeof fetch;
  /** Test-only clock injection. Threaded into calendar-watcher so
   *  deterministic-time harnesses (the Phase 10 e2e suite) can seed
   *  events relative to a fixed `now`. Production leaves this
   *  undefined — handlers fall back to `Date.now()`. */
  now?: () => number;
  /** D-122 Phase 4.5 — db handle for the time-relative-watcher state
   *  table. Absent ⇒ `time-relative-watcher` throws SERVER_NOT_REACHABLE. */
  db?: Database.Database;
  /** D-193 — work-entity task anchors for time-relative reminder recipes. */
  workEntityStore?: Pick<WorkEntityStore, 'listTasks'>;
}

type WatcherDispatcher = NonNullable<KernelDispatchers['watcher']>;

/** Narrow a dep to its non-null value, or throw SERVER_NOT_REACHABLE
 *  with a consistent message shape. The five collection / queue /
 *  cursor-store watchers all share this guard. */
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

export const createWatcherDispatcher = (
  deps: WatcherDispatcherDeps,
): WatcherDispatcher => {
  return async ({ slug, args }) => {
    switch (slug satisfies KernelWatcherSlug) {
      case 'time-watcher':
        return evaluateTimeWatcher(args as TimeWatcherArgs);
      case 'recipe-watcher': {
        const auditLog = requireDep(
          deps,
          'auditLog',
          slug,
          'audit log not initialised on this server',
        );
        return evaluateRecipeWatcher(args as unknown as RecipeWatcherArgs, {
          auditLog,
        });
      }
      case 'http-watcher':
        return evaluateHttpWatcher(args as unknown as HttpWatcherArgs, {
          fetchFn: deps.fetchFn,
        });
      case 'calendar-watcher': {
        const registry = requireDep(
          deps,
          'collectionRegistry',
          slug,
          'collection registry not configured on this server',
        );
        const cursors = requireDep(
          deps,
          'calendarWatcherCursors',
          slug,
          'calendar collections not configured on this server',
        );
        return handleCalendarWatcher(
          {
            getCollection: (s) =>
              registry.get('calendar', s) as CalendarCollection | undefined,
            cursors,
            ...(deps.now ? { now: deps.now } : {}),
          },
          args,
        );
      }
      case 'mail-watcher': {
        const registry = requireDep(
          deps,
          'collectionRegistry',
          slug,
          'collection registry not configured on this server',
        );
        return handleMailWatcher(
          { getCollection: (s) => registry.get('mail', s) },
          args,
        );
      }
      case 'file-watcher': {
        const registry = requireDep(
          deps,
          'collectionRegistry',
          slug,
          'collection registry not configured on this server',
        );
        return handleFileWatcher(
          { getCollection: (s) => registry.get('file', s) },
          args,
        );
      }
      case 'webhook-watcher': {
        const queue = requireDep(
          deps,
          'webhookQueue',
          slug,
          '/hook listener not mounted (set webhook_port>0 + public_reachable=true)',
        );
        return handleWebhookWatcher({ queue }, args);
      }
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
        // The `runtime.runWatcher` / `runtime.testTrigger` rpc boundary CASTS a
        // `slug: string` into `KernelWatcherSlug`, so an unknown / stale slug (a
        // retired one like the removed `dom-watcher`, or a typo) reaches here at
        // runtime even though the type says `never`. Fail closed with the
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
