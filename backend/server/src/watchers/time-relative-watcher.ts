/** D-122 Phase 4.5 — `time-relative-watcher` server-side handler.
 *
 *  Generic temporal anchor watcher. Fires when wall-clock time crosses
 *  a declared offset relative to a field on a warehouse record:
 *
 *    `time-relative-watcher` over `data.calendar` with anchor_field
 *    `start_at`, offsets `["-3d", "-1d", "-30m"]` →
 *    fires three times per upcoming meeting — three days before,
 *    one day before, thirty minutes before.
 *
 *  Drives meeting reminders, deadline alerts, renewal nudges,
 *  anniversary triggers, follow-up windows, and similar time-anchored
 *  reactive recipes. The same watcher slug works on every collection
 *  whose records carry a timestamp field — anchor_field selects which
 *  one, offsets describe the boundary set.
 *
 *  Per-fire state is persisted in `time_relative_watcher_state` keyed
 *  on `(recipe_id, slug, record_id, offset_label)` so the same
 *  boundary fires exactly once per record per offset. The sweeper
 *  runs every `TIME_RELATIVE_SWEEP_MS` (60 s) — recipe authors don't
 *  see the sweeper directly; the watcher returns `should_run: true`
 *  on its next per-recipe tick when one or more boundaries crossed
 *  since the last fire. D-193 Recued reminder tasks are the narrow
 *  exception: while `state = "reminder_pending"`, task state is the
 *  acknowledgement marker so all-channel notification failures can retry.
 *
 *  Spec: D-122 §"Kernel ingredient gap-closure" —
 *  `time-relative-watcher`.
 *
 *  ⛔ Two fixes on a calendar (2026-10-05), both shown on the real calendar
 *  stack before they were made:
 *    - It read the 500 events with the LATEST start (the collection's
 *      generic list, `start_at DESC`). A calendar with more than 500
 *      upcoming occurrences in its 90-day expansion never fired for a
 *      meeting 20 minutes away. It now reads the window of events whose
 *      boundaries can be due, a page at a time.
 *    - It had no lookback: installed on a calendar, it fired once for every
 *      past occurrence in the warehouse, one per check. A boundary now fires
 *      only if it crossed after the recipe started watching (its first check,
 *      less `TIME_RELATIVE_FIRST_CHECK_GRACE_MS`). Downtime after that is
 *      still caught up. Uninstall forgets the start point, so a reinstall
 *      starts afresh (`forgetTimeRelativeWatcherRecipe`).
 *  The task path (D-193 reminders) is unchanged: a pending reminder is an
 *  obligation, due whenever it became due.
 *
 *  `instance` (2026-10-05) watches one calendar instead of every one, and
 *  each fire names the instance its record came from (`trigger_instance`).
 *  Three shipped recipes read the meeting's details from the calendar their
 *  setting named (default `primary`) while the trigger watched them all: a
 *  meeting elsewhere got no attendees, and a name no calendar has failed
 *  every run (calendar reads refuse an unknown instance). */

import type Database from 'better-sqlite3';
import { IngredientError, type KernelTriggerOutput } from '@recued/ingredients';
import { DAY_MS, eventSpanIn, type Task } from '@recued/contracts';
import type { CollectionRegistry } from '../collections/registry.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';

const STATE_TABLE = 'time_relative_watcher_state';
const TASK_PAGE_SIZE = 500;
/** When each recipe started watching a collection. Boundaries that crossed
 *  before it never fire. */
const ARMED_TABLE = 'time_relative_watcher_armed';
/** A recipe's watch starts this long before its first check, so a boundary
 *  that crossed in the hour before install still fires (a meeting starting in
 *  20 minutes still gets its "30 minutes before"), and nothing older does. */
export const TIME_RELATIVE_FIRST_CHECK_GRACE_MS = 60 * 60_000;
/** Calendar rows are read a page at a time, so no cap can hide one. */
const CALENDAR_PAGE_SIZE = 500;

/** Records the watcher has already fired on. The compound key prevents
 *  re-fires across server restarts (state is durable) while allowing
 *  the same recipe to use the watcher with multiple anchor_field /
 *  offset combinations under different slugs. */
export interface TimeRelativeWatcherStateRow {
  recipe_id: string;
  slug: string;
  record_id: string;
  offset_label: string;
  fired_at: number;
}

/** Raw watcher arguments as the recipe author passes them. The kernel
 *  adapter forwards `args` verbatim from the recipe's `trigger_steps`
 *  shape; this module validates. */
export interface TimeRelativeWatcherArgs {
  collection: string;
  anchor_field: string;
  offsets: string[];
  filter?: string;
  /** Collection path: watch only this instance (a calendar's name under
   *  Connections). Empty or absent: every instance of the platform
   *  (2026-10-05; before, always every instance). */
  instance?: string;
  /** Implicit — supplied by the engine on each call. */
  recipe_id: string;
  /** Keys this step's ledger and start point within the recipe. ⚠ The
   *  engine does NOT supply it (only `recipe_id` is injected); absent, it
   *  is `time-relative-watcher`. */
  slug?: string;
}

export interface TimeRelativeWatcherDeps {
  db: Database.Database;
  registry?: CollectionRegistry;
  /** D-193 — work-entity task anchors for reminders. */
  workEntityStore?: Pick<WorkEntityStore, 'listTasks'>;
  now?: () => number;
  /** The owner's zone: an all-day event's day begins at its local midnight
   *  there. Absent, UTC. */
  timeZone?: () => string | undefined;
}

const isRecuedReminderTask = (record: unknown): boolean => {
  if (!record || typeof record !== 'object') return false;
  const blob = (record as { source_extension_blob?: unknown }).source_extension_blob;
  return !!blob
    && typeof blob === 'object'
    && (blob as { kind?: unknown }).kind === 'recued_reminder';
};

const isPendingRecuedReminderTask = (record: unknown): boolean =>
  isRecuedReminderTask(record)
  && (record as { state?: unknown }).state === 'reminder_pending'
  && (record as { done?: unknown }).done !== true;

/** Output shape — the same `KernelTriggerOutput` envelope every watcher
 *  returns, plus per-fire metadata when a boundary crossed. */
export interface TimeRelativeWatcherOutput extends KernelTriggerOutput {
  fired: boolean;
  trigger_record_id: string | null;
  trigger_record: Record<string, unknown> | null;
  trigger_offset: string | null;
  anchor_at: number | null;
  /** The instance the fired record is in (a calendar's name), so the recipe
   *  reads its details from the right calendar. Null on the task path. */
  trigger_instance: string | null;
}

// ────────────────────────────────────────────────────────────────
// Schema
// ────────────────────────────────────────────────────────────────

export const ensureTimeRelativeWatcherSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
      recipe_id    TEXT NOT NULL,
      slug         TEXT NOT NULL,
      record_id    TEXT NOT NULL,
      offset_label TEXT NOT NULL,
      fired_at     INTEGER NOT NULL,
      PRIMARY KEY (recipe_id, slug, record_id, offset_label)
    );

    CREATE INDEX IF NOT EXISTS idx_trw_recipe
      ON ${STATE_TABLE} (recipe_id, slug, fired_at DESC);

    CREATE TABLE IF NOT EXISTS ${ARMED_TABLE} (
      recipe_id    TEXT NOT NULL,
      slug         TEXT NOT NULL,
      armed_at     INTEGER NOT NULL,
      scope        TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (recipe_id, slug)
    );
  `);
  // `scope` (the watched instance) came a commit after the table.
  const columns = db.prepare(`PRAGMA table_info(${ARMED_TABLE})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'scope')) {
    db.exec(`ALTER TABLE ${ARMED_TABLE} ADD COLUMN scope TEXT NOT NULL DEFAULT ''`);
  }
};

/** Drop a recipe's firing ledger and its start point. Run when the recipe is
 *  uninstalled (`recipe-owned-state.ts`): a reinstall starts watching afresh,
 *  instead of resuming from its first install and firing everything since. */
export const forgetTimeRelativeWatcherRecipe = (db: Database.Database, recipe_id: string): void => {
  ensureTimeRelativeWatcherSchema(db);
  db.prepare(`DELETE FROM ${STATE_TABLE} WHERE recipe_id = ?`).run(recipe_id);
  db.prepare(`DELETE FROM ${ARMED_TABLE} WHERE recipe_id = ?`).run(recipe_id);
};

// ────────────────────────────────────────────────────────────────
// Offset parsing
// ────────────────────────────────────────────────────────────────

/** Parse a time offset string into milliseconds. Accepts:
 *    `-3d`, `+30m`, `-1h`, `+12h`, `-7d`, `0s`
 *  Returns the signed millisecond delta. Throws on malformed input. */
export const parseOffsetMs = (raw: string): number => {
  const trimmed = String(raw).trim();
  const match = /^([+-]?)(\d+)([smhd])$/.exec(trimmed);
  if (!match) {
    throw new Error(`time_relative_watcher_offset_invalid: ${raw}`);
  }
  const sign = match[1] === '-' ? -1 : 1;
  const n = Number(match[2]);
  const unit = match[3];
  const unitMs = unit === 's' ? 1_000
    : unit === 'm' ? 60_000
    : unit === 'h' ? 3_600_000
    : unit === 'd' ? 86_400_000
    : 0;
  if (unitMs === 0) {
    throw new Error(`time_relative_watcher_offset_invalid: ${raw}`);
  }
  return sign * n * unitMs;
};

// ────────────────────────────────────────────────────────────────
// Handler
// ────────────────────────────────────────────────────────────────

/** Drives one watcher tick. Looks up records in the configured
 *  collection, evaluates each anchor_field against every offset,
 *  fires the first boundary that crossed since the last sweep, and
 *  marks it as fired so a subsequent tick advances to the next
 *  boundary.
 *
 *  Returns `should_run: false` when no boundary crossed; the reactive
 *  scheduler then sleeps until the next tick. */
export const handleTimeRelativeWatcher = async (
  deps: TimeRelativeWatcherDeps,
  args: TimeRelativeWatcherArgs,
): Promise<TimeRelativeWatcherOutput> => {
  ensureTimeRelativeWatcherSchema(deps.db);
  validateArgs(args);

  const now = (deps.now ?? Date.now)();
  const slug = args.slug ?? 'time-relative-watcher';
  const findFiredStmt = deps.db.prepare(
    `SELECT 1 FROM ${STATE_TABLE}
       WHERE recipe_id = ? AND slug = ? AND record_id = ? AND offset_label = ?`,
  );
  const recordFireStmt = deps.db.prepare(
    `INSERT OR REPLACE INTO ${STATE_TABLE}
       (recipe_id, slug, record_id, offset_label, fired_at)
       VALUES (?, ?, ?, ?, ?)`,
  );
  // D-193 audit follow-on — the prior attempt time for a reminder fire
  // key. Reminders bypass the exactly-once ledger (they retry until
  // delivered), so the fire row records the LAST attempt instead; the
  // task scan uses it to fire the least-recently-attempted reminder.
  const findFiredAtStmt = deps.db.prepare(
    `SELECT fired_at FROM ${STATE_TABLE}
       WHERE recipe_id = ? AND slug = ? AND record_id = ? AND offset_label = ?`,
  );
  const noFire = (): TimeRelativeWatcherOutput => ({
    should_run: false,
    fired: false,
    trigger_record_id: null,
    trigger_record: null,
    trigger_offset: null,
    anchor_at: null,
    trigger_instance: null,
  });

  /** `floor`: boundaries that crossed before it are not fired (a collection
   *  watch's start point; the task path passes none). `instance`: where the
   *  record was found, handed to the recipe. */
  const zone = deps.timeZone?.();
  /** ⛔ An all-day calendar event's start and end are DAYS (`calendar-days.ts`):
   *  it starts at the local midnight of its first day where the owner is, not
   *  at the UTC midnight it is stored at. Read as stored, "a day before" a
   *  holiday fired at 4 pm two days before it in Los Angeles. */
  const anchorOf = (record: unknown): number | null => {
    const anchor = readAnchor(record, args.anchor_field);
    if (anchor === null || (args.anchor_field !== 'start_at' && args.anchor_field !== 'end_at')) return anchor;
    const hot = (record as { hot_fields?: Record<string, unknown> }).hot_fields;
    if (hot === undefined || (hot.is_all_day !== true && hot.is_all_day !== 1)) return anchor;
    if (typeof hot.start_at !== 'number' || typeof hot.end_at !== 'number') return anchor;
    const span = eventSpanIn({ start_at: hot.start_at, end_at: hot.end_at, is_all_day: true }, zone);
    return args.anchor_field === 'start_at' ? span.start : span.end;
  };

  const evaluateRecord = (
    record: unknown,
    floor = Number.NEGATIVE_INFINITY,
    instance: string | null = null,
  ): TimeRelativeWatcherOutput | null => {
    const anchor = anchorOf(record);
    if (anchor === null) return null;

    // Optional filter — recipe authors gate by hot_fields. The full
    // engine condition vocabulary lives in `@recued/contracts`'s
    // `parseCondition` but the watcher fires before the recipe body
    // so we keep the filter expression minimal: skip when filter is
    // present and the substring isn't found in the JSON
    // serialization. Recipe authors who need richer gating compose
    // a `skip_when` on the recipe body itself.
    if (args.filter !== undefined && args.filter.length > 0) {
      const obj = record as { hot_fields?: unknown };
      const blob = JSON.stringify(obj.hot_fields ?? record);
      if (!blob.includes(args.filter)) return null;
    }

    for (const offsetLabel of args.offsets) {
      const offsetMs = parseOffsetMs(offsetLabel);
      const targetAt = anchor + offsetMs;
      // Boundary "crossed" iff target_at is at or before now. The
      // per-`(recipe, slug, record, offset)` state table prevents
      // double-fires across ticks + server restarts.
      // ⛔ And not before the recipe started watching (`floor`). Without it
      // a watcher installed onto an active warehouse fired once for every
      // boundary already behind it: a calendar's whole retained past, one
      // meeting per check (2026-10-05).
      if (targetAt > now) continue;
      if (targetAt < floor) continue;
      const recordId = readRecordId(record);
      if (!recordId) continue;
      const fired = findFiredStmt.get(args.recipe_id, slug, recordId, offsetLabel);
      if (fired) continue;
      recordFireStmt.run(args.recipe_id, slug, recordId, offsetLabel, now);
      return {
        should_run: true,
        fired: true,
        trigger_record_id: recordId,
        trigger_record: normalizeTriggerRecord(record),
        trigger_offset: offsetLabel,
        anchor_at: anchor,
        trigger_instance: instance,
      };
    }
    return null;
  };

  // A due, pending reminder's fire candidacy + the time it was last
  // attempted (`0` = never attempted → highest retry priority). Mirrors
  // evaluateRecord's anchor / filter / offset gates but does NOT write
  // the ledger — the caller fires only the winning (least-recently-
  // attempted) candidate and records that one.
  const reminderFireCandidate = (
    record: unknown,
  ): { recordId: string; offsetLabel: string; anchor: number; priorFiredAt: number } | null => {
    const anchor = anchorOf(record);
    if (anchor === null) return null;
    if (args.filter !== undefined && args.filter.length > 0) {
      const obj = record as { hot_fields?: unknown };
      const blob = JSON.stringify(obj.hot_fields ?? record);
      if (!blob.includes(args.filter)) return null;
    }
    const recordId = readRecordId(record);
    if (!recordId) return null;
    for (const offsetLabel of args.offsets) {
      const targetAt = anchor + parseOffsetMs(offsetLabel);
      if (targetAt > now) continue;
      const row = findFiredAtStmt.get(args.recipe_id, slug, recordId, offsetLabel) as
        | { fired_at?: number }
        | undefined;
      const priorFiredAt = row && typeof row.fired_at === 'number' ? row.fired_at : 0;
      return { recordId, offsetLabel, anchor, priorFiredAt };
    }
    return null;
  };

  if (collectionNameToWorkEntityKind(args.collection) === 'task') {
    if (!deps.workEntityStore) return noFire();
    // D-193 audit follow-on — reminder retries are FAIR. A pending
    // reminder that can't deliver (every channel failing) must not
    // head-of-line-block the other due reminders: instead of firing the
    // first due pending reminder every tick, fire the one attempted
    // least recently (never-attempted first). Task state stays the
    // delivery ack, so an undeliverable reminder simply round-robins
    // with the rest until it delivers or leaves `reminder_pending`.
    // Non-reminder task watches keep exactly-once + return-on-first.
    let bestReminder:
      | { record: unknown; recordId: string; offsetLabel: string; anchor: number; priorFiredAt: number }
      | null = null;
    for (let offset = 0; ; offset += TASK_PAGE_SIZE) {
      const records = deps.workEntityStore
        .listTasks({ sync_states: ['live'], limit: TASK_PAGE_SIZE, offset })
        .map(taskToWatcherRecord);
      for (const record of records) {
        const isReminder = args.filter === 'recued_reminder' && isRecuedReminderTask(record);
        if (isReminder) {
          if (!isPendingRecuedReminderTask(record)) continue;
          const cand = reminderFireCandidate(record);
          if (cand && (bestReminder === null || cand.priorFiredAt < bestReminder.priorFiredAt)) {
            bestReminder = { record, ...cand };
          }
          continue;
        }
        const out = evaluateRecord(record);
        if (out) return out;
      }
      if (records.length < TASK_PAGE_SIZE) break;
    }
    if (bestReminder) {
      recordFireStmt.run(args.recipe_id, slug, bestReminder.recordId, bestReminder.offsetLabel, now);
      return {
        should_run: true,
        fired: true,
        trigger_record_id: bestReminder.recordId,
        trigger_record: normalizeTriggerRecord(bestReminder.record),
        trigger_offset: bestReminder.offsetLabel,
        anchor_at: bestReminder.anchor,
        trigger_instance: null,
      };
    }
    return noFire();
  }

  // The collection comes from the registry; the collection name in
  // the watcher arg follows the warehouse-explorer naming
  // (`'data.calendar'` / `'data.mail'`). Strip the prefix to map onto
  // `(platform, slug)`. For the single-instance derived-from-source
  // contact collection, `data.contact` resolves to platform `'contact'`,
  // slug `'default'` — same convention the contact-store uses.
  const platform = collectionNameToPlatform(args.collection);
  if (!platform) {
    throw new IngredientError(
      'BAD_INPUT',
      `time-relative-watcher: unsupported collection '${args.collection}'`,
      { slug: args.slug ?? 'time-relative-watcher' },
    );
  }
  if (!deps.registry) {
    throw new IngredientError(
      'SERVER_NOT_REACHABLE',
      'time-relative-watcher unavailable — collection registry not configured on this server',
      { slug },
    );
  }

  // Walk every registered instance of the platform — most users have
  // one, but the multi-account case (two IMAP boxes, two calendars)
  // wants a single watcher to span them — or only the one `instance` names.
  const only = args.instance !== undefined && args.instance !== '' ? args.instance : undefined;
  const instances = deps.registry.list()
    .filter((c) => c.platform === platform && (only === undefined || c.slug === only));

  if (instances.length === 0) {
    // Collection isn't enrolled — recipe author misconfigured. Return
    // should_run: false rather than throwing; reactive recipes
    // tolerate missing collections (they may install later).
    return noFire();
  }

  // Where this recipe's watch starts: its first check, less the grace. It
  // starts again when what it watches changes (another calendar named), or
  // the newly watched calendar's past since the first install would replay.
  const scope = only ?? '';
  const armed = deps.db.prepare(
    `SELECT armed_at, scope FROM ${ARMED_TABLE} WHERE recipe_id = ? AND slug = ?`,
  ).get(args.recipe_id, slug) as { armed_at: number; scope: string } | undefined;
  const floor = armed !== undefined && armed.scope === scope
    ? armed.armed_at
    : now - TIME_RELATIVE_FIRST_CHECK_GRACE_MS;
  if (armed === undefined || armed.scope !== scope) {
    deps.db.prepare(
      `INSERT INTO ${ARMED_TABLE} (recipe_id, slug, armed_at, scope) VALUES (?, ?, ?, ?)
         ON CONFLICT (recipe_id, slug) DO UPDATE SET armed_at = excluded.armed_at, scope = excluded.scope`,
    ).run(args.recipe_id, slug, floor, scope);
  }

  // A calendar is read a page at a time. ⛔ Its generic list is the 500
  // events with the LATEST start, so a single bounded read missed every
  // upcoming meeting once more than 500 lay further ahead. When the anchor
  // is the event's start or end, only events whose boundary can fall in
  // [floor, now] are read: anchor in [floor - max(offset), now - min(offset)],
  // which the overlap window (`start_at < before`, `end_at > from`) contains.
  // An all-day event is stored at UTC midnights, up to 14 hours from the
  // local midnights it is anchored at: a day either side reads every one.
  const offsetsMs = args.offsets.map(parseOffsetMs);
  const window = platform === 'calendar'
    && (args.anchor_field === 'start_at' || args.anchor_field === 'end_at')
    ? { from: floor - Math.max(...offsetsMs) - 1 - DAY_MS, before: now - Math.min(...offsetsMs) + 1 + DAY_MS }
    : undefined;

  for (const collection of instances) {
    if (platform === 'calendar') {
      for (let offset = 0; ; offset += CALENDAR_PAGE_SIZE) {
        const records = collection.list({
          platform: collection.platform,
          slug: collection.slug,
          ...(window ? { calendar_window: window } : {}),
          limit: CALENDAR_PAGE_SIZE,
          offset,
        });
        for (const record of records) {
          const out = evaluateRecord(record, floor, collection.slug);
          if (out) return out;
        }
        if (records.length < CALENDAR_PAGE_SIZE) break;
      }
      continue;
    }
    // ⚠ Other collections keep one bounded read of recent records (no
    // shipped recipe watches them; a mailbox can be too big to page per tick).
    const records = collection.list({
      platform: collection.platform,
      slug: collection.slug,
      limit: 500,
    });
    for (const record of records) {
      const out = evaluateRecord(record, floor, collection.slug);
      if (out) return out;
    }
  }

  return noFire();
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const validateArgs = (args: TimeRelativeWatcherArgs): void => {
  if (args.instance !== undefined && typeof args.instance !== 'string') {
    throw new IngredientError(
      'BAD_INPUT',
      `time-relative-watcher: instance must be text (got ${JSON.stringify(args.instance)})`,
      { slug: args.slug ?? 'time-relative-watcher' },
    );
  }
  if (typeof args.collection !== 'string' || args.collection.length === 0) {
    throw new IngredientError(
      'BAD_INPUT',
      'time-relative-watcher: collection is required',
      { slug: args.slug ?? 'time-relative-watcher' },
    );
  }
  if (typeof args.anchor_field !== 'string' || args.anchor_field.length === 0) {
    throw new IngredientError(
      'BAD_INPUT',
      'time-relative-watcher: anchor_field is required',
      { slug: args.slug ?? 'time-relative-watcher' },
    );
  }
  if (!Array.isArray(args.offsets) || args.offsets.length === 0) {
    throw new IngredientError(
      'BAD_INPUT',
      'time-relative-watcher: offsets must be a non-empty array',
      { slug: args.slug ?? 'time-relative-watcher' },
    );
  }
  for (const offset of args.offsets) {
    if (typeof offset !== 'string') {
      throw new IngredientError(
        'BAD_INPUT',
        `time-relative-watcher: offset must be a string (got ${typeof offset})`,
        { slug: args.slug ?? 'time-relative-watcher' },
      );
    }
    parseOffsetMs(offset); // throws on malformed
  }
  if (typeof args.recipe_id !== 'string' || args.recipe_id.length === 0) {
    throw new IngredientError(
      'BAD_INPUT',
      'time-relative-watcher: recipe_id is required (engine-injected)',
      { slug: args.slug ?? 'time-relative-watcher' },
    );
  }
};

const collectionNameToPlatform = (raw: string): string | null => {
  const stripped = raw.startsWith('data.') ? raw.slice(5) : raw;
  if (stripped === 'mail' || stripped === 'calendar'
    || stripped === 'contact' || stripped === 'file') {
    return stripped;
  }
  return null;
};

const collectionNameToWorkEntityKind = (raw: string): 'task' | null => {
  const stripped = raw.startsWith('data.work.')
    ? raw.slice('data.work.'.length)
    : raw.startsWith('data.')
      ? raw.slice(5)
      : raw.startsWith('work.')
        ? raw.slice(5)
        : raw;
  return stripped === 'task' ? 'task' : null;
};

const readRecordId = (record: unknown): string | null => {
  if (record === null || typeof record !== 'object') return null;
  const obj = record as Record<string, unknown>;
  if (typeof obj._id === 'string' && obj._id.length > 0) return obj._id;
  if (typeof obj.id === 'string' && obj.id.length > 0) return obj.id;
  if (typeof obj.record_id === 'string' && obj.record_id.length > 0) return obj.record_id;
  return null;
};

const readAnchor = (record: unknown, field: string): number | null => {
  if (record === null || typeof record !== 'object') return null;
  const obj = record as Record<string, unknown>;
  // Hot-fields-first probe — the warehouse pattern stores time fields
  // there. Fall back to the top-level so contact rows (whose
  // `last_interaction` lives at the row level, not inside hot_fields)
  // still resolve.
  const hot = obj.hot_fields as Record<string, unknown> | undefined;
  if (hot && typeof hot[field] === 'number') return hot[field] as number;
  if (typeof obj[field] === 'number') return obj[field] as number;
  return null;
};

const taskToWatcherRecord = (task: Task): Record<string, unknown> => ({
  _id: task.id,
  _collection: 'task',
  _kind: 'task',
  ...task,
});

const normalizeTriggerRecord = (record: unknown): Record<string, unknown> | null => {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
  return record as Record<string, unknown>;
};
