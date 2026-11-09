import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { recordFirstDigest } from './measures.js';
import { assetDateAt, calendarDayMs, PURSUIT_CLASS_ID, shiftAssetDate, dueSpan, zonedWallClockToEpochMs,
  type ProactiveToday, type SituationAgendaSettings, type SituationAgendaStatus, type SituationCloseDaySettings, type SituationCloseDayStatus,
  type SituationCluster, type SituationDeliverySettings, type SituationDeliveryStatus, type SituationDigestLookAhead, type SituationItem,
  type SituationResult, type SituationStreamKind, type SituationStreamPreview, type SituationStreamSettings, type SituationStreamStatus,
  NOTIFICATION_DELIVERY_CHANNELS, type NotificationDeliveryChannel } from '@recued/contracts';
import type { NotificationSendArgs } from '../notification-handler.js';
import type { SituationStore } from '../storage/situation-store.js';
import type { PromptSchedules } from '../prompt-schedules.js';
import type { AssetReminderService } from './asset-reminder-service.js';
import type { PromptSchedule } from '@recued/contracts';
import { AGENDA_SUGGESTIONS_KEY, SUGGESTIONS_HEAD_START_MS, SUGGESTIONS_TOOL_ROUNDS, WEEKLY_SUGGESTIONS_KEY, createAgendaSuggestions } from './agenda-suggestions.js';
import { claimPromptScheduleDone, DONE_TEXT_MAX_CHARS, promptScheduleDoneClaimed } from '../prompt-schedule-done.js';
import { isToolBudgetExhaustedAnswer } from '../chat-turn-budget.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { createOccurrenceReminderStore } from '../storage/occurrence-reminder-store.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createSituationDismissalStore } from '../storage/situation-dismissal-store.js';
import { releasedAtStop, settleWithin, STOP_GRACE_MS } from '../lifecycle/settle-within.js';
import type { SituationAccess } from './access.js';
import type { createSituationQuery, SituationReadContext } from './query.js';
import { wholeSituationSnapshotAllowed } from './event-visibility.js';
import { selectDayOfClusterItems, shouldSendDayOfCluster } from './notification-overlap-policy.js';
import { assetRenewal } from './asset-rule-timing.js';
import type { Collection } from '../collections/types.js';
import { isMirroredCollection } from '../collections/mirrored-collection.js';

export const DEFAULT_SITUATION_DELIVERY: Required<SituationDeliverySettings> = { frequency: 'weekly', weekday: 1, time: '08:00', day_of: true, look_ahead_days: 7 };
/** §15.7 amendment (2026-11-02) — the windows a digest may cover. Keyed by the contract's type,
 *  so a new length cannot be added there without being added here. */
const LOOK_AHEAD_DAYS: Readonly<Record<SituationDigestLookAhead, true>> = { 2: true, 3: true, 7: true, 14: true };
const isLookAhead = (value: unknown): value is SituationDigestLookAhead => typeof value === 'number' && Object.hasOwn(LOOK_AHEAD_DAYS, value);
/** A weekly digest covers at least a week: a shorter window leaves days no digest ever lists. */
const WEEKLY_MIN_LOOK_AHEAD = 7;
/** §15.7 amendment (2026-11-02, later) — the Agenda, off until the owner turns it on, and daily
 *  until they choose a week (2026-11-03). */
export const DEFAULT_SITUATION_AGENDA: Required<SituationAgendaSettings> = { enabled: false, time: '07:00', day: 'today', frequency: 'daily', weekday: 1, suggestions: false };
/** The Agenda's runs, daily and weekly alike. The Digest's status, send budget and retention
 *  leave them out, and the Agenda keeps its own, so the two never take each other's sends. */
const AGENDA_MODES = "('agenda','agenda_manual')";
/** D-343 slice 4 — Close the day, off until the owner turns it on, in the evening (§3.1). */
export const DEFAULT_SITUATION_CLOSE_DAY: Required<SituationCloseDaySettings> = { enabled: false, time: '21:00' };
/** Close the day's runs: kept apart from the Digest's and the Agenda's as theirs are from each other. */
const CLOSE_DAY_MODES = "('close_day','close_day_manual')";
/** D-340 slice 2 — the daily stream's runs and the weekly stream's, each a feature of its own. */
const STREAM_MODES = "('stream','stream_manual')";
const STREAM_WEEK_MODES = "('stream_week','stream_week_manual')";
/** Which feature a run is, by its mode: each keeps its own receipts, budget and retention. */
type RunFeature = 'digest' | 'agenda' | 'close_day' | 'stream' | 'stream_week';
const featureOf = (column: string): string =>
  `(CASE WHEN ${column} IN ${AGENDA_MODES} THEN 'agenda' WHEN ${column} IN ${CLOSE_DAY_MODES} THEN 'close_day'`
  + ` WHEN ${column} IN ${STREAM_MODES} THEN 'stream' WHEN ${column} IN ${STREAM_WEEK_MODES} THEN 'stream_week' ELSE 'digest' END)`;
/** D-340 slice 2 (§3.1) — a stream as it starts before anything is carried over: off, with the
 *  Agenda and Coming up checked, a week ahead, to every channel set up. */
export const DEFAULT_SITUATION_STREAM: SituationStreamSettings = { enabled: false, time: '07:30', day: 'today', weekday: 1,
  agenda: true, coming_up: true, look_ahead_days: 7, suggestions: false, due_today: false, include_private: false, reminders: false, channels: null };
/** Ruling 12 — the stream's message, by its day or its week. A reply that quotes it closes them. */
export const STREAM_DAY_TITLE = 'Your day'; export const STREAM_WEEK_TITLE = 'Your week';
const STREAM_FEATURE: Readonly<Record<SituationStreamKind, 'stream' | 'stream_week'>> = { daily: 'stream', weekly: 'stream_week' };
/** The evening notice's last line (§3.2). The model reads it in a quoted reply as the owner saw it. */
export const CLOSE_DAY_ASK = 'Reply to this with what you did.';
/** Ruling 21 — a day with nothing on still asks: the ritual keeps what was not planned too (ruling 7). */
export const CLOSE_DAY_NOTHING_ON = 'Nothing was on your agenda.';
/** A fuller day ends with a count and a link to Today. A week holds this many for each day. */
const AGENDA_MAX_LINES = 40;
/** D-338 — at most this many names on a day's birthdays or anniversaries line, then "and N more". */
const AGENDA_DATE_NAMES = 5;
/** "A", "A and B", "A, B and C", …, "A, B, C, D, E and 2 more". */
const namesLine = (names: readonly string[]): string => {
  const shown = names.slice(0, AGENDA_DATE_NAMES); const more = names.length - shown.length;
  const all = more > 0 ? [...shown, `${String(more)} more`] : shown;
  return all.length === 1 ? all[0]! : `${all.slice(0, -1).join(', ')} and ${all.at(-1)!}`;
};
const AGENDA_WEEK_DAYS = 7;
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const isIsoWeekday = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 7;
/** A local date's ISO weekday, Monday=1. */
const isoWeekdayOf = (day: string): number => ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const shiftDays = (day: string, amount: number): string => shiftAssetDate(day, { amount: Math.abs(amount), unit: 'days' }, amount < 0 ? -1 : 1);
const ownerSource = { channel: 'chat', actor: 'user_self', user_id: 'owner', chat_session_id: 'scheduled-situations' } as const;
const uiContext: SituationReadContext = { owner: true, grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true } };
/** An asset's details, a trip's destination and days, and a pursuit's recorded days are read-time
 * context, not the situation: editing an attribute or a trip must not show a group again
 * as changed, and adding them to items must not make every saved group a new
 * revision. */
const CONTEXT_FIELDS: ReadonlySet<string> = new Set(['details', 'trip', 'context', 'recorded']);
const identity = (value: unknown): string => JSON.stringify(value, (key, field) => key === 'updated_at' || key === '__entity' || CONTEXT_FIELDS.has(key) ? undefined : field);
const withoutContext = (cluster: SituationCluster): SituationCluster =>
  ({ ...cluster, items: cluster.items.map(({ details: _details, trip: _trip, context: _context, recorded: _recorded, ...item }) => item) });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** What a summary describes: the items and their values, not the verdicts a query
 * window gives them. Today and the brief read different windows, and a verdict
 * that moves with the window must neither hide a summary nor buy another one. */
const contentKey = (cluster: SituationCluster): string => hash(JSON.stringify(cluster.items
  .map(item => JSON.stringify([item.ref.collection, item.ref.id, item.ref.field ?? null, item.what.value, item.when.value, item.when_day ?? null,
    item.where.value?.key ?? null, item.who.value ?? null])).sort()));
/** How a line's date misses its group's own (§6.2), named by the item the group is anchored on,
 * as the query picks it: the lines of every group run on together, so "this" would name
 * nothing. A fit needs no words, nor does a group whose anchor is not among its lines. */
/** D-340 §4 — a state shows on Today; these messages leave it out until the daily stream
 * gives it its own first section (D-340 slice 2). */
const isState = (item: Pick<SituationItem, 'kind'>): boolean => item.kind === 'asset_state';
const missedBy = (item: SituationItem, cluster: SituationCluster, named: (anchor: SituationItem) => string): string => {
  if (item.reasons.includes('last_time')) return ' · from last time';
  const value = item.when.value; const span = cluster.span; const verdict = item.when.verdict;
  if (!value || !span || (verdict !== 'near' && verdict !== 'outside')) return '';
  const opens = (other: SituationItem) => other !== item && Boolean(other.what.value) && other.when.value?.from === span.from;
  const anchor = cluster.items.find(other => opens(other) && ['booking', 'calendar', 'occasion'].includes(other.kind)) ?? cluster.items.find(opens);
  const side = value.from > span.to ? 'after' : value.to < span.from ? 'before' : null;
  return anchor && side ? ` · ${verdict === 'near' ? 'shortly' : 'well'} ${side} ${named(anchor)}` : '';
};
interface RunRow { id: string; mode: string; day: string; at: number; state: string; attempts: number; text: string; delivered_to: string; mentions?: string }
/** D-338 §11 — a name in an Agenda's text and the record it opens in the app. */
type AgendaMention = { text: string; ref: { collection: string; id: string } };
/** The names a run kept, for its Settings preview; none for a run before them or with none. */
const mentionsOf = (row: RunRow): { mentions?: AgendaMention[] } => {
  try {
    const list: unknown = JSON.parse(row.mentions ?? '[]');
    return Array.isArray(list) && list.length ? { mentions: list as AgendaMention[] } : {};
  } catch { return {}; }
};
/** The Digest's mailbox lines: each mail account that mirrors a mailbox, with its
 *  last good sync and whether it needs attention. An SMTP-only account syncs
 *  nothing, so it is not listed (`isMirroredCollection`). */
export const mailboxHealthOf = (collections: readonly Collection[], now: number) =>
  collections.filter(collection => collection.platform === 'mail' && isMirroredCollection(collection)).map(collection => {
    const health = collection.health(); return { name: collection.slug, last_success_at: health.last_indexed_at,
      needs_attention: health.error_count_24h > 0 || health.last_indexed_at === 0 || now - health.last_indexed_at > 86_400_000 || health.auth_state === 'expired' || health.auth_state === 'unauthorized' };
  });
export const createScheduledSituations = (deps: {
  db: Database.Database; store: SituationStore; work: WorkEntityStore; query: ReturnType<typeof createSituationQuery>;
  timeZone: () => string; isVaultUnlocked: () => boolean; isQuiet: (at: number) => boolean;
  /** `quietHoursEndFor`: when a send set for this minute of day may go, if it
   *  falls inside quiet hours. Absent ⇒ each send waits only for its own time. */
  quietEnd?: (minute: number) => number | null;
  overview: () => Promise<Omit<ProactiveToday, 'situations' | 'occurrences'>>;
  send: (message: NotificationSendArgs) => Promise<{ delivered_to: readonly string[] }>;
  mailHealth?: () => Array<{ name: string; last_success_at: number; needs_attention: boolean }>;
  summarize?: (cluster: SituationCluster, authorize?: () => boolean) => Promise<string | undefined>;
  retainCited?: (clusters: readonly SituationCluster[]) => void;
  memoryAllowed?: (cluster: SituationCluster) => boolean;
  /** A person's name as the owner's contacts give it, for an id an item's `who` carries. */
  personName?: (id: string) => string | undefined;
  /** Whether a calendar event (by its record id) has fresh Meeting preparation notes, for the
   *  Agenda's "prep notes ready". Absent ⇒ the Agenda never says so. */
  prepNotesReady?: (calendarRecordId: string) => boolean;
  /** D-338 slice 3 — the scheduled prompts the Agenda's AI suggestions run as. Late, because the
   *  chat is composed first; absent ⇒ the suggestions are never set up. */
  promptSchedules?: () => PromptSchedules | undefined;
  /** D-340 slice 3 — the owner's reminders, which the daily stream carries when it is asked to. */
  reminders?: Pick<AssetReminderService, 'streamReminders' | 'sendWithStream'>;
  now?: () => number;
}) => {
  const now = deps.now ?? Date.now; let access: SituationAccess | undefined; let active: Promise<unknown> | undefined; let stopped = false;
  const occurrences = createAssetOccurrenceStore(deps.db); const points = createOccurrenceReminderStore(deps.db);
  const dismissals = createSituationDismissalStore(deps.db);
  // What an item's own reminder keeps private stays out of every message the brief
  // sends, as there: a sensitive asset, and an occasion with people in it
  // (asset-reminder-service, occasion-clock-service). Today, in the app, names them.
  // `gone` is what a record no longer on file counts as: a resolution's stored line
  // may outlive its record (a deleted occasion leaves none), so it is private there.
  const occasions = createProactiveHistoryStore(deps.db, createProactiveProposalStore(deps.db));
  const privateRecord = (ref: { collection: string; id: string }, gone = false): boolean => {
    if (ref.collection === 'asset') { const asset = deps.work.readAsset(ref.id); return asset ? asset.settings.sensitive === true : gone; }
    if (ref.collection === 'occasion') { const occasion = occasions.occasion(ref.id); return occasion ? occasion.people.length > 0 : gone; }
    const row = ref.collection === 'commitment' ? occurrences.byCommitment(ref.id) : null;
    return row ? privateRecord({ collection: row.subject_kind === 'occasion' ? 'occasion' : 'asset', id: row.asset_id }, gone) : false;
  };
  /** An item is private when it, or a record it cites, is: a trip check cites the visas it lists. */
  const privateItem = (item: SituationItem, gone = false): boolean => privateRecord(item.ref, gone) || item.evidence.some(ref => privateRecord(ref, gone));
  // D-338 — what the owner's notifications call a private item: the menu that holds it (the owner,
  // asked whether "Private reminder" told them anything: "Reminder in Yours", to match the menu).
  const named = (item: SituationItem, hides: (item: SituationItem) => boolean = privateItem): string =>
    hides(item) ? 'a reminder in Yours' : `“${item.what.value}”`;
  /** D-340 slice 5 (§3.4) — what a message keeps private: every private item, unless the stream it
   *  goes in includes private items, which then names them in every part. */
  const hiderFor = (names = false) => (item: SituationItem, gone = false): boolean => !names && privateItem(item, gone);
  const dayOfAllowed =(cluster: SituationCluster): boolean => shouldSendDayOfCluster(cluster,
    id => deps.work.readCommitment(id)?.derivation === 'rule_emitted');
  deps.db.exec(`CREATE TABLE IF NOT EXISTS scheduled_situation_runs (
    id TEXT PRIMARY KEY, mode TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL DEFAULT '', delivered_to TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS scheduled_situation_seen (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, sent_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduled_situation_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, mode TEXT NOT NULL, outcome TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduled_situation_summaries (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, summary TEXT NOT NULL);`);
  // D-338 §11 — the names an Agenda's text links in the app, kept with its run for Settings.
  if (!(deps.db.prepare('PRAGMA table_info(scheduled_situation_runs)').all() as { name: string }[]).some(column => column.name === 'mentions')) {
    deps.db.exec("ALTER TABLE scheduled_situation_runs ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]'");
  }
  // When the overview last listed each of its clusters. Only a trip's resolves, so
  // this is how retention tells a cluster that is over from one still shown. A
  // cluster from before the record began counts as listed then.
  const unrecorded = !deps.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduled_situation_listed'").get();
  deps.db.exec('CREATE TABLE IF NOT EXISTS scheduled_situation_listed (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
  if (unrecorded) deps.db.prepare("INSERT OR IGNORE INTO scheduled_situation_listed(id,at) SELECT id,? FROM situations WHERE id LIKE 'situation-%'").run(now());
  const listed = deps.db.prepare('INSERT INTO scheduled_situation_listed(id,at) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at');
  // What the owner chose. An older server stored a field it did not know as it came, so a
  // window that is not one of the choices reads as the default.
  const chosen = (): Required<SituationDeliverySettings> => {
    const value = { ...DEFAULT_SITUATION_DELIVERY, ...deps.store.readSetting<Partial<SituationDeliverySettings>>('situations.delivery', {}),
      frequency: deps.store.readSetting('digest.frequency', DEFAULT_SITUATION_DELIVERY.frequency) };
    return isLookAhead(value.look_ahead_days) ? value : { ...value, look_ahead_days: DEFAULT_SITUATION_DELIVERY.look_ahead_days };
  };
  // What the digest does. The frequency is also written alone (`yours.change` `settings.update`),
  // so a weekly digest is held to a week here, where every send and the status read it, and a
  // daily choice of fewer days comes back when the digest is daily again.
  const settings = (): Required<SituationDeliverySettings> => {
    const value = chosen();
    return value.frequency === 'weekly' && value.look_ahead_days < WEEKLY_MIN_LOOK_AHEAD ? { ...value, look_ahead_days: WEEKLY_MIN_LOOK_AHEAD } : value;
  };
  const setSettings = (patch: Partial<SituationDeliverySettings>): void => {
    const next = { ...chosen(), ...patch };
    if (!['daily', 'weekly', 'off'].includes(next.frequency) || !Number.isInteger(next.weekday) || next.weekday < 1 || next.weekday > 7
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(next.time) || typeof next.day_of !== 'boolean' || !isLookAhead(next.look_ahead_days)) throw new Error('Choose a valid overview schedule');
    // Asked for outright, a weekly digest shorter than a week is refused rather than quietly
    // lengthened; a frequency changed alone keeps the window, which `settings` reads as above.
    if (patch.look_ahead_days !== undefined && next.frequency === 'weekly' && next.look_ahead_days < WEEKLY_MIN_LOOK_AHEAD)
      throw new Error(`A weekly digest looks at least ${WEEKLY_MIN_LOOK_AHEAD} days ahead`);
    deps.store.writeSetting('situations.delivery', next); deps.store.writeSetting('digest.frequency', next.frequency);
    deps.store.writeSetting('situations.schedule_changed_at', now());
  };
  // The Agenda's settings: each field as written, or its default when it is not one Recued accepts.
  // Settings saved before the weekly choice name no frequency, and read as daily.
  const agendaSettings = (): Required<SituationAgendaSettings> => {
    const stored = deps.store.readSetting<Partial<SituationAgendaSettings>>('situations.agenda', {});
    return { enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULT_SITUATION_AGENDA.enabled,
      time: typeof stored.time === 'string' && HHMM.test(stored.time) ? stored.time : DEFAULT_SITUATION_AGENDA.time,
      day: stored.day === 'today' || stored.day === 'tomorrow' ? stored.day : DEFAULT_SITUATION_AGENDA.day,
      frequency: stored.frequency === 'daily' || stored.frequency === 'weekly' ? stored.frequency : DEFAULT_SITUATION_AGENDA.frequency,
      weekday: isIsoWeekday(stored.weekday) ? stored.weekday : DEFAULT_SITUATION_AGENDA.weekday,
      suggestions: typeof stored.suggestions === 'boolean' ? stored.suggestions : DEFAULT_SITUATION_AGENDA.suggestions };
  };
  /** D-338 — whether the Agenda lists `day` that morning or the evening before: a daily one lists
   *  every day so, and a weekly one the first day of its week (its weekday, or the day after when
   *  its week starts tomorrow). The "Due today" note leaves such a day to it. A weekly Agenda's
   *  other days keep their note: it listed them days before. */
  const agendaListsDay = (day: string): boolean => {
    const agenda = agendaSettings();
    if (!agenda.enabled) return false;
    if (agenda.frequency !== 'weekly') return true;
    const sent = agenda.day === 'today' ? day : shiftDays(day, -1);
    return ((new Date(`${sent}T00:00:00Z`).getUTCDay() + 6) % 7) + 1 === agenda.weekday;
  };
  // A save that names only some fields keeps the rest: a client from before the weekly choice
  // sends three, and a weekly agenda stays weekly.
  const setAgenda = (patch: Partial<SituationAgendaSettings>): void => {
    const next = { ...agendaSettings(), ...patch };
    if (typeof next.enabled !== 'boolean' || typeof next.time !== 'string' || !HHMM.test(next.time) || (next.day !== 'today' && next.day !== 'tomorrow')
      || (next.frequency !== 'daily' && next.frequency !== 'weekly') || !isIsoWeekday(next.weekday) || typeof next.suggestions !== 'boolean')
      throw new Error('Choose a valid agenda schedule');
    deps.store.writeSetting('situations.agenda', { enabled: next.enabled, time: next.time, day: next.day, frequency: next.frequency,
      weekday: next.weekday, suggestions: next.suggestions });
    deps.store.writeSetting('situations.agenda_changed_at', now());
  };
  // D-343 slice 4 — Close the day's settings, as the Agenda's are kept: each field as written, or its
  // default when it is not one Recued accepts.
  const closeDaySettings = (): Required<SituationCloseDaySettings> => {
    const stored = deps.store.readSetting<Partial<SituationCloseDaySettings>>('situations.close_day', {});
    return { enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULT_SITUATION_CLOSE_DAY.enabled,
      time: typeof stored.time === 'string' && HHMM.test(stored.time) ? stored.time : DEFAULT_SITUATION_CLOSE_DAY.time };
  };
  const setCloseDay = (patch: Partial<SituationCloseDaySettings>): void => {
    const next = { ...closeDaySettings(), ...patch };
    if (typeof next.enabled !== 'boolean' || typeof next.time !== 'string' || !HHMM.test(next.time)) throw new Error('Choose a valid time to close the day');
    deps.store.writeSetting('situations.close_day', { enabled: next.enabled, time: next.time });
    deps.store.writeSetting('situations.close_day_changed_at', now());
  };
  // D-340 slice 2 — the streams (§3.1, ruling 11): the daily one and the weekly one, each its own
  // schedule. Each field as written, or its default when it is not one Recued accepts.
  const STREAMS_KEY = 'situations.streams';
  const storedStreams = (): Partial<Record<SituationStreamKind, Partial<SituationStreamSettings>>> | null =>
    deps.store.readSetting<Partial<Record<SituationStreamKind, Partial<SituationStreamSettings>>> | null>(STREAMS_KEY, null);
  /** Whether the streams took over from the Agenda and Coming up (§3.6): from then on they send, and
   *  the Agenda's and the Digest's own ticks do not. The server takes over when it starts. */
  const streamsActive = (): boolean => storedStreams() !== null;
  const isChannel = (value: unknown): value is NotificationDeliveryChannel =>
    typeof value === 'string' && (NOTIFICATION_DELIVERY_CHANNELS as readonly string[]).includes(value);
  const streamSettings = (kind: SituationStreamKind): SituationStreamSettings => {
    const stored = storedStreams()?.[kind] ?? {}; const base = DEFAULT_SITUATION_STREAM;
    const flag = (key: 'enabled' | 'agenda' | 'coming_up' | 'suggestions' | 'due_today' | 'include_private' | 'reminders'): boolean =>
      typeof stored[key] === 'boolean' ? stored[key] : base[key];
    const ahead = isLookAhead(stored.look_ahead_days) ? stored.look_ahead_days : base.look_ahead_days;
    return { enabled: flag('enabled'), time: typeof stored.time === 'string' && HHMM.test(stored.time) ? stored.time : base.time,
      day: stored.day === 'today' || stored.day === 'tomorrow' ? stored.day : base.day, weekday: isIsoWeekday(stored.weekday) ? stored.weekday : base.weekday,
      agenda: flag('agenda'), coming_up: flag('coming_up'),
      look_ahead_days: kind === 'weekly' && ahead < WEEKLY_MIN_LOOK_AHEAD ? WEEKLY_MIN_LOOK_AHEAD : ahead,
      suggestions: flag('suggestions'), due_today: kind === 'daily' && flag('due_today'), include_private: flag('include_private'),
      // D-340 slice 3 — the day's reminders go in a daily stream that lists that day.
      reminders: kind === 'daily' && stored.day !== 'tomorrow' && flag('reminders'),
      channels: Array.isArray(stored.channels) && stored.channels.length > 0 && stored.channels.every(isChannel) ? [...new Set(stored.channels)] : null };
  };
  const streamChangedAt = (kind: SituationStreamKind): number => deps.store.readSetting<number>(`situations.stream_changed_at.${kind}`, 0);
  /** A save names what it changes and keeps the rest. A run whose time came before it is not caught
   *  up, as the Agenda's is not. */
  const setStream = (kind: SituationStreamKind, patch: Partial<SituationStreamSettings>): void => {
    if (kind !== 'daily' && kind !== 'weekly') throw new Error('Choose the daily or the weekly stream');
    if (!streamsActive()) throw new Error('This server has no streams yet');
    const next: SituationStreamSettings = { ...streamSettings(kind), ...patch };
    if (typeof next.enabled !== 'boolean' || typeof next.time !== 'string' || !HHMM.test(next.time) || (next.day !== 'today' && next.day !== 'tomorrow')
      || !isIsoWeekday(next.weekday) || [next.agenda, next.coming_up, next.suggestions, next.due_today, next.include_private, next.reminders].some(value => typeof value !== 'boolean')
      || !isLookAhead(next.look_ahead_days) || !(next.channels === null || (Array.isArray(next.channels) && next.channels.length > 0
        && next.channels.every(isChannel) && new Set(next.channels).size === next.channels.length)))
      throw new Error('Choose a valid stream schedule');
    if (kind === 'weekly' && next.look_ahead_days < WEEKLY_MIN_LOOK_AHEAD) throw new Error(`A weekly stream looks at least ${WEEKLY_MIN_LOOK_AHEAD} days ahead`);
    if (kind === 'weekly' && next.due_today) throw new Error('Due today goes with the daily stream');
    // D-340 slice 3 (§3.5) — reminders belong to a day, so they go in the daily stream, and only one
    // that lists that day: a stream that lists tomorrow goes the evening before.
    if (kind === 'weekly' && next.reminders) throw new Error('Reminders go with the daily stream');
    if (next.reminders && next.day === 'tomorrow') throw new Error('Reminders go with a stream that lists today');
    deps.store.writeSetting(STREAMS_KEY, { daily: streamSettings('daily'), weekly: streamSettings('weekly'), [kind]: next });
    deps.store.writeSetting(`situations.stream_changed_at.${kind}`, now());
  };
  // D-338 slice 3 — the state of a feature's own scheduled run at or after an instant (the Agenda's,
  // or a stream's): what its suggestions wait on, and say nothing after when it sent nothing. A Send
  // now is not one.
  const runSince = (mode: string) => (at: number): 'sent' | 'skipped' | 'pending' | undefined => {
    const row = deps.db.prepare('SELECT state FROM scheduled_situation_runs WHERE mode=? AND at>=? ORDER BY at DESC,rowid DESC LIMIT 1')
      .get(mode, at) as { state: string } | undefined;
    if (!row) return undefined;
    return row.state === 'sent' || row.state === 'uncertain' ? 'sent' : row.state === 'pending' || row.state === 'sending' ? 'pending' : 'skipped';
  };
  const suggestionsOf = (key: string, agendaRunSince: (at: number) => 'sent' | 'skipped' | 'pending' | undefined) => createAgendaSuggestions({
    db: deps.db, schedules: deps.promptSchedules ?? (() => undefined), key,
    readSetting: (name, fallback) => deps.store.readSetting(name, fallback),
    writeSetting: (name, value) => { deps.store.writeSetting(name, value); },
    timeZone: deps.timeZone, agendaRunSince });
  // The Agenda's suggestions, which are the daily stream's once the streams take over (D-340 §3.6:
  // they carry over with their conversation), and the weekly stream's own.
  const agendaSuggestions = suggestionsOf(AGENDA_SUGGESTIONS_KEY, at => runSince(streamsActive() ? 'stream' : 'agenda')(at));
  const weeklySuggestions = suggestionsOf(WEEKLY_SUGGESTIONS_KEY, runSince('stream_week'));
  const streamSuggestions: Readonly<Record<SituationStreamKind, typeof agendaSuggestions>> = { daily: agendaSuggestions, weekly: weeklySuggestions };
  /** A stream as the Agenda's settings word it: what its AI suggestions read, and its span. They
   *  come only with its Agenda. */
  // D-340 slice 4 — a stream's suggestions start ahead of it (`head_start`, §3.3).
  const asAgenda = (kind: SituationStreamKind, stream: SituationStreamSettings): Required<SituationAgendaSettings> & { names_private: boolean; head_start: true } => ({
    enabled: stream.enabled, time: stream.time, day: stream.day, frequency: kind, weekday: stream.weekday, suggestions: stream.agenda && stream.suggestions,
    names_private: stream.include_private, head_start: true });
  // One feature's runs: the Digest's (its due-day notes and Send now included), the Agenda's,
  // Close the day's (D-343 slice 4), or a stream's (D-340 slice 2).
  const runsOf = (feature: RunFeature) => `${featureOf('mode')}='${feature}'`;
  const receipts = (feature: RunFeature) => {
    const named = feature === 'agenda' || feature === 'stream' || feature === 'stream_week';
    const row = deps.db.prepare(`SELECT * FROM scheduled_situation_runs WHERE ${runsOf(feature)} ORDER BY at DESC,rowid DESC LIMIT 1`).get() as RunRow | undefined;
    const sent = deps.db.prepare(`SELECT * FROM scheduled_situation_runs WHERE ${runsOf(feature)} AND state='sent' ORDER BY at DESC,rowid DESC LIMIT 1`).get() as RunRow | undefined;
    return { last_run: row ? { at: row.at, mode: row.mode, state: row.state, text: row.text, delivered_to: JSON.parse(row.delivered_to) as string[], ...(named ? mentionsOf(row) : {}) } : null,
      last_sent: sent ? { at: sent.at, mode: sent.mode, text: sent.text, delivered_to: JSON.parse(sent.delivered_to) as string[], ...(named ? mentionsOf(sent) : {}) } : null,
      pending: (deps.db.prepare(`SELECT count(*) AS n FROM scheduled_situation_runs WHERE ${runsOf(feature)} AND state IN ('pending','sending')`).get() as { n: number }).n,
      uncertain: (deps.db.prepare(`SELECT count(*) AS n FROM scheduled_situation_runs WHERE ${runsOf(feature)} AND state='uncertain'`).get() as { n: number }).n };
  };
  const agendaStatus = (): SituationAgendaStatus => {
    const active = streamsActive(); const next = active ? null : nextAgenda();
    const conversation = active ? undefined : agendaSuggestions.conversation();
    return { settings: agendaSettings(), ...receipts('agenda'), ...(next === null ? {} : { next_at: next, time_zone: deps.timeZone() }),
      ...(conversation !== undefined ? { suggestions_session_id: conversation } : {}), close_day: closeDayStatus(),
      ...(active ? { streams: { daily: streamStatus('daily'), weekly: streamStatus('weekly') } } : {}) };
  };
  const streamStatus = (kind: SituationStreamKind): SituationStreamStatus => {
    const next = nextStream(kind); const conversation = streamSuggestions[kind].conversation();
    return { settings: streamSettings(kind), ...receipts(STREAM_FEATURE[kind]), ...(next === null ? {} : { next_at: next, time_zone: deps.timeZone() }),
      ...(conversation !== undefined ? { suggestions_session_id: conversation } : {}) };
  };
  const status = (): SituationDeliveryStatus => {
    if (streamsActive()) return { settings: settings(), ...receipts('digest'), streams: true };
    const next = nextDigest();
    return { settings: settings(), ...receipts('digest'), ...(next === null ? {} : { next_at: next, time_zone: deps.timeZone() }) };
  };
  const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  // When the digest is due on a day, and whose run that is. Shared by the tick that sends
  // it and the status that says when it next goes, so the two cannot disagree.
  const dueTime = (config: { time: string }): { due: string; late: boolean } => {
    // A time inside quiet hours goes out when they end: by its own time alone, an
    // evening time in a window past midnight never came round.
    const set = Number(config.time.slice(0, 2)) * 60 + Number(config.time.slice(3, 5));
    const end = deps.quietEnd?.(set) ?? null;
    return { due: end === null ? config.time : hhmm(end), late: end !== null && end < set };
  };
  const overviewRun = (config: SituationDeliverySettings, day: string, late: boolean, changedDay: string): string | null => {
    if (config.frequency === 'daily') return `overview:${day}`;
    if (config.frequency !== 'weekly') return null;
    // Carried past midnight, a weekly send goes the morning after its day, not
    // the morning of it.
    const sendDay = late ? shiftAssetDate(day, { amount: 1, unit: 'days' }, -1) : day;
    const weekday = isoWeekdayOf(sendDay);
    const weeklyDay = shiftAssetDate(sendDay, { amount: (weekday - config.weekday + 7) % 7, unit: 'days' }, -1);
    return weeklyDay >= changedDay ? `overview:${weeklyDay}` : null;
  };
  const changedDayIn = (zone: string): string => {
    const changedAt = deps.store.readSetting<number>('situations.schedule_changed_at', 0);
    return changedAt > 0 ? assetDateAt(changedAt, zone) : '0001-01-01';
  };
  /** §15.7 amendment — when a run set for `time` next goes, as `tickOnce` would send it: the
   *  first day from today whose run (`runFor`) is not done yet, at its due time, or now when that
   *  has passed. Inside quiet hours it waits for their end that day, else for the next day's
   *  run. Null when nothing can send. The Digest and the Agenda both read it. */
  const nextRunAt = (time: string, runFor: (day: string, late: boolean, zone: string) => string | null): number | null => {
    if (stopped || !access || !deps.isVaultUnlocked()) return null;
    const at = now(); const zone = deps.timeZone(); const today = assetDateAt(at, zone);
    const { due, late } = dueTime({ time });
    const done = deps.db.prepare("SELECT 1 FROM scheduled_situation_runs WHERE id=? AND state IN ('sent','skipped','uncertain')");
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    for (let offset = 0; offset <= 8; offset++) {
      const day = shiftAssetDate(today, { amount: offset, unit: 'days' });
      const run = runFor(day, late, zone); if (!run || done.get(run)) continue;
      const dueAt = zonedWallClockToEpochMs(`${day}T${due}`, zone); if (dueAt === null) return null;
      const from = Math.max(dueAt, at); if (!deps.isQuiet(from)) return from;
      const minute = clock.format(from); const set = Number(minute.slice(0, 2)) * 60 + Number(minute.slice(3, 5));
      const end = deps.quietEnd?.(set) ?? null;
      if (end !== null && end > set) return zonedWallClockToEpochMs(`${day}T${hhmm(end)}`, zone);
    }
    return null;
  };
  const nextDigest = (): number | null => {
    const config = settings();
    if (config.frequency === 'off') return null;
    const changedDay = changedDayIn(deps.timeZone());
    return nextRunAt(config.time, (day, late) => overviewRun(config, day, late, changedDay));
  };
  /** The days a run lists, from `start` up to `end`. A daily run belongs to the day it goes
   *  (`slot`) and lists that day or the next; carried past midnight by quiet hours, it lists that
   *  morning's day either way. §15.7 amendment (2026-11-03): a weekly run belongs to the latest of
   *  its weekdays, counted from the day before when carried past midnight as the Digest's is, and
   *  lists seven days from that day or the next; carried past midnight, from that morning. */
  const agendaSpan = (agenda: Required<SituationAgendaSettings>, day: string, late: boolean): { slot: string; start: string; end: string } => {
    if (agenda.frequency === 'daily') {
      const start = agenda.day === 'tomorrow' && !late ? shiftDays(day, 1) : day;
      return { slot: day, start, end: shiftDays(start, 1) };
    }
    const sendDay = late ? shiftDays(day, -1) : day;
    const slot = shiftDays(sendDay, -((isoWeekdayOf(sendDay) - agenda.weekday + 7) % 7));
    const start = late || agenda.day === 'tomorrow' ? shiftDays(slot, 1) : slot;
    return { slot, start, end: shiftDays(start, AGENDA_WEEK_DAYS) };
  };
  // One agenda a day, keyed by the day it goes, as a daily digest is; a weekly one keyed by its
  // weekday until the next. A run whose time came before the owner last changed the Agenda is not
  // caught up: turned on in the evening, it starts with the next one rather than going at once.
  // One missed while the server was down still goes, a day's later that day and a week's later
  // that week, and lists only the days still to come.
  const agendaRun = (day: string, late: boolean, zone: string): { id: string; from: string; end: string } | null => {
    const agenda = agendaSettings(); const span = agendaSpan(agenda, day, late); const weekly = agenda.frequency === 'weekly';
    // When it fell due: a weekly time carried past midnight, the morning after its weekday.
    const dueAt = zonedWallClockToEpochMs(`${weekly && late ? shiftDays(span.slot, 1) : span.slot}T${dueTime(agenda).due}`, zone);
    if (dueAt === null || dueAt < deps.store.readSetting<number>('situations.agenda_changed_at', 0)) return null;
    return { id: weekly ? `agenda_week:${span.slot}` : `agenda:${span.slot}`, from: span.start > day ? span.start : day, end: span.end };
  };
  const nextAgenda = (): number | null => {
    const agenda = agendaSettings();
    return agenda.enabled ? nextRunAt(agenda.time, (day, late, zone) => agendaRun(day, late, zone)?.id ?? null) : null;
  };
  /** D-343 slice 4 — the evening notice for a day goes on that day, keyed by the day it closes.
   *  Carried past midnight by quiet hours it goes the next morning, still about the day before. A
   *  run whose time came before the owner last changed Close the day is not caught up: turned on at
   *  22:00, it starts the next evening, as the Agenda does. */
  const closeDayRun = (day: string, late: boolean, zone: string): { id: string; day: string } | null => {
    const dueAt = zonedWallClockToEpochMs(`${day}T${dueTime(closeDaySettings()).due}`, zone);
    if (dueAt === null || dueAt < deps.store.readSetting<number>('situations.close_day_changed_at', 0)) return null;
    const closes = late ? shiftDays(day, -1) : day;
    return { id: `close_day:${closes}`, day: closes };
  };
  const nextCloseDay = (): number | null => {
    const closing = closeDaySettings();
    return closing.enabled ? nextRunAt(closing.time, (day, late, zone) => closeDayRun(day, late, zone)?.id ?? null) : null;
  };
  const closeDayStatus = (): SituationCloseDayStatus => {
    const next = nextCloseDay();
    return { settings: closeDaySettings(), ...receipts('close_day'), ...(next === null ? {} : { next_at: next, time_zone: deps.timeZone() }) };
  };
  /** D-340 slice 2 — a stream's runs, as the Agenda's are: one a day keyed by the day it goes, a
   *  weekly one by its weekday until the next; not caught up when its time came before the owner
   *  last changed it, or before the streams took over. */
  const streamRun = (kind: SituationStreamKind, day: string, late: boolean, zone: string): { id: string; from: string; end: string } | null => {
    const stream = streamSettings(kind); const span = agendaSpan(asAgenda(kind, stream), day, late);
    const dueAt = zonedWallClockToEpochMs(`${kind === 'weekly' && late ? shiftDays(span.slot, 1) : span.slot}T${dueTime(stream).due}`, zone);
    if (dueAt === null || dueAt < streamChangedAt(kind)) return null;
    return { id: `${STREAM_FEATURE[kind]}:${span.slot}`, from: span.start > day ? span.start : day, end: span.end };
  };
  /** D-340 slice 4 (§3.3) — the stream run that suggestions due at `due_at` start ahead of: the one on
   *  the day the stream goes, or the morning after when quiet hours carry its time past midnight. */
  const streamRunAhead = (kind: SituationStreamKind, due_at: number): { id: string; from: string; end: string } | null => {
    const zone = deps.timeZone(); const { late } = dueTime(streamSettings(kind));
    const day = assetDateAt(due_at + SUGGESTIONS_HEAD_START_MS, zone);
    return streamRun(kind, late ? shiftDays(day, 1) : day, late, zone);
  };
  /** D-340 slice 4 — what reads a scheduled run's answer, and the server's public address for "Talk it
   *  over": the chat is composed after the scheduler, so it is bound once it is. */
  let answers: { readAnswer(session_id: string, message_id: string): Promise<{ role: string; content: string } | undefined>;
    publicBaseUrl?(): string | null } | undefined;
  /** A stream's suggestions' latest run, finished with an answer: never a Run now, which the owner
   *  started in the app, nor one that ran out of its rounds before it finished. */
  const finishedSuggestions = async (kind: SituationStreamKind): Promise<{ text: string; session_id: string; schedule_id: string;
    turn_id: string; due_at: number } | null> => {
    const schedule_id = streamSuggestions[kind].scheduleId(); const schedules = deps.promptSchedules?.();
    if (!schedule_id || !schedules || !answers) return null;
    try {
      const schedule = await schedules.get(schedule_id);
      const outcome = schedule.last_outcome; const turn_id = schedule.last_turn_id;
      if (outcome?.status !== 'finished' || !turn_id || !outcome.message_id) return null;
      const run = deps.db.prepare('SELECT occurrence_id, due_at FROM chat_prompt_occurrences WHERE schedule_id=? AND turn_id=?')
        .get(schedule_id, turn_id) as { occurrence_id: string; due_at: number } | undefined;
      if (!run || run.occurrence_id.startsWith(`${schedule_id}:manual:`)) return null;
      const answer = await answers.readAnswer(schedule.session_id, outcome.message_id);
      if (!answer || answer.role !== 'assistant' || !answer.content.trim() || isToolBudgetExhaustedAnswer(answer.content)) return null;
      return { text: answer.content.trim(), session_id: schedule.session_id, schedule_id, turn_id, due_at: run.due_at };
    } catch { return null; }
  };
  /** D-340 slice 4 (§3.3) — what a stream's run (`ahead`) carries of them: the run they started ahead
   *  of, not sent on its own already, nor carried by an earlier message. */
  const suggestionsFor = async (kind: SituationStreamKind, ahead: string) => {
    const run = await finishedSuggestions(kind);
    if (!run || streamRunAhead(kind, run.due_at)?.id !== ahead) return null;
    try { if (promptScheduleDoneClaimed(deps.db, run.schedule_id, run.turn_id)) return null; } catch { return null; }
    return run;
  };
  /** D-340 slice 4 (§3.3) — for Today: the daily stream's suggestions for the stream that goes today
   *  (they start ahead of it), whatever carried them, with their conversation. */
  const todaySuggestions = async (): Promise<{ text: string; session_id: string; day: string } | undefined> => {
    if (!streamsActive()) return undefined;
    const stream = streamSettings('daily');
    if (!stream.agenda || !stream.suggestions) return undefined;
    const run = await finishedSuggestions('daily'); const zone = deps.timeZone(); const today = assetDateAt(now(), zone);
    if (!run || assetDateAt(run.due_at + SUGGESTIONS_HEAD_START_MS, zone) !== today) return undefined;
    const chars = Array.from(run.text);
    return { text: chars.length > DONE_TEXT_MAX_CHARS ? `${chars.slice(0, DONE_TEXT_MAX_CHARS).join('')}…` : run.text,
      session_id: run.session_id, day: today };
  };
  /** D-340 slice 3 — whether the daily stream will carry the owner's reminders still to go today: on,
   *  with Reminders, and its run for today still to come or still being sent. A run that settled
   *  (sent, skipped, given up) holds nothing more: a reminder due after it goes on its own. */
  const holdsReminders = (): boolean => {
    if (!streamsActive()) return false;
    const stream = streamSettings('daily');
    if (!stream.enabled || !stream.reminders) return false;
    const zone = deps.timeZone(); const day = assetDateAt(now(), zone);
    const run = streamRun('daily', day, dueTime(stream).late, zone);
    if (!run) return false;
    const state = (deps.db.prepare('SELECT state FROM scheduled_situation_runs WHERE id=?').get(run.id) as { state: string } | undefined)?.state;
    return state === undefined || state === 'pending' || state === 'sending';
  };
  const nextStream = (kind: SituationStreamKind): number | null => {
    const stream = streamSettings(kind);
    return streamsActive() && stream.enabled ? nextRunAt(stream.time, (day, late, zone) => streamRun(kind, day, late, zone)?.id ?? null) : null;
  };
  const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
  /** D-340 §3.6 — once, when the server starts: the streams take over from the Agenda and Coming up,
   *  each carrying over what the owner had, and from then on only the streams send.
   *  - The daily stream takes a daily Agenda's time and day, and a daily Coming up becomes its part;
   *    with no daily Agenda, Coming up's time is its time. Due today stays with it.
   *  - A weekly Agenda or Coming up becomes the weekly stream, the Agenda's weekday and time first.
   *  - AI suggestions carry over with their Agenda, and their conversation with them.
   *  - Each goes to every channel set up, as before, and neither is caught up the day it takes over.
   *  - A stream that folds in a Coming up that went at another time says so in its first message. */
  const takeOverStreams = (): void => {
    if (streamsActive()) return;
    const agenda = agendaSettings(); const digest = settings();
    const carried = (kind: SituationStreamKind): SituationStreamSettings => {
      const own = agenda.enabled && agenda.frequency === kind; const comingUp = digest.frequency === kind;
      const stream: SituationStreamSettings = { ...DEFAULT_SITUATION_STREAM, agenda: own, coming_up: comingUp, suggestions: own && agenda.suggestions,
        look_ahead_days: kind === 'weekly' && digest.look_ahead_days < WEEKLY_MIN_LOOK_AHEAD ? WEEKLY_MIN_LOOK_AHEAD : digest.look_ahead_days,
        due_today: kind === 'daily' && digest.day_of };
      if (own) return { ...stream, enabled: true, time: agenda.time, day: agenda.day, weekday: agenda.weekday };
      if (comingUp || stream.due_today) return { ...stream, enabled: true, time: digest.time, day: 'today', weekday: digest.weekday };
      return stream;
    };
    const daily = carried('daily'); const weekly = carried('weekly'); const at = now();
    if (daily.agenda && daily.coming_up && digest.time !== daily.time) {
      deps.store.writeSetting('situations.stream_fold_note.daily', `Coming up now arrives with your Agenda at ${daily.time}.`);
    }
    if (weekly.agenda && weekly.coming_up && (digest.time !== weekly.time || digest.weekday !== weekly.weekday)) {
      deps.store.writeSetting('situations.stream_fold_note.weekly',
        `Coming up now arrives with your weekly Agenda, on ${WEEKDAY_NAMES[weekly.weekday - 1]!} at ${weekly.time}.`);
    }
    // A weekly Agenda's suggestions were kept under the Agenda's key: they are the weekly stream's now.
    if (weekly.suggestions) {
      deps.store.writeSetting(WEEKLY_SUGGESTIONS_KEY, deps.store.readSetting(AGENDA_SUGGESTIONS_KEY, {}));
      deps.store.writeSetting(AGENDA_SUGGESTIONS_KEY, {});
    }
    deps.store.writeSetting(STREAMS_KEY, { daily, weekly });
    deps.store.writeSetting('situations.stream_changed_at.daily', at); deps.store.writeSetting('situations.stream_changed_at.weekly', at);
  };
  const collect = async (from: number, to: number, surface: 'today' | 'digest' | 'push', context: SituationReadContext): Promise<SituationResult> => {
    const opted = surface === 'digest' && deps.store.readSetting<string>('last_time.choice', 'unasked') === 'on';
    const readContext: SituationReadContext = { ...context, last_time_opted_in: opted,
      ...(surface === 'push' ? { projectClusterItems: items => selectDayOfClusterItems(items.filter(item => !dismissals.hides(item, now())
        && !isState(item) && !(item.reasons.includes('missing') && item.when.value === null)), id => deps.work.readCommitment(id)?.derivation === 'rule_emitted') } : {}) };
    const result = await deps.query({ time: { from, to }, surface, include_last_time: opted }, readContext);
    // Each cluster asks again with its own date, place and people. The general
    // week cannot answer whether a near miss fits this particular trip.
    for (const cluster of result.clusters) {
      const when = cluster.span ?? { from, to }; const place = cluster.items.find(item => item.where.value)?.where.value;
      const people = [...new Set(cluster.items.flatMap(item => item.who.value ?? []))];
      const second = await deps.query({ time: when, subjects: cluster.subjects.length ? cluster.subjects : cluster.items.map(item => item.ref),
        ...(place ? { place } : {}), ...(people.length ? { people } : {}), surface, include_last_time: opted }, readContext);
      const refreshed = second.clusters.find(row => row.id === cluster.id);
      if (refreshed) Object.assign(cluster, refreshed);
    }
    // §15.4 — what the owner dismissed stays off the surfaces that interrupt them.
    const at = now();
    result.clusters = result.clusters.flatMap(cluster => {
      const items = cluster.items.filter(item => !dismissals.hides(item, at));
      return items.length ? [items.length === cluster.items.length ? cluster : { ...cluster, items }] : [];
    });
    return result;
  };
  const today = async (input: { now: number; before: number }): Promise<ProactiveToday> => {
    if (!deps.isVaultUnlocked()) throw new Error('Unlock Recued to open Today');
    if (!Number.isSafeInteger(input.now) || !Number.isSafeInteger(input.before) || input.before <= input.now
      || input.before - input.now > 14 * 86_400_000) throw new Error('Invalid Today window');
    const situations = await collect(input.now, input.before - 1, 'today', uiContext);
    const questionIds = new Set(occurrences.all().filter(row => row.question).flatMap(row => row.commitment_id ? [row.commitment_id] : []));
    situations.clusters = situations.clusters.flatMap(cluster => {
      const items = cluster.items.filter(item => !questionIds.has(item.ref.id)
        && !(item.kind === 'asset_rule' && item.reasons.includes('missing') && item.when.value === null));
      return items.length ? [{ ...cluster, items }] : [];
    });
    // Canonical commitments are returned by reference, never a second lifecycle
    // in a reminder row. The client decides its own local-day group.
    const visibleOccurrences: ProactiveToday['occurrences'] = [];
    const history = createProactiveHistoryStore(deps.db, createProactiveProposalStore(deps.db));
    for (const row of occurrences.all()) {
      if (!row.commitment_id) continue;
      if (row.subject_kind === 'occasion') {
        const commitment = deps.work.readCommitment(row.commitment_id); const occasion = history.occasion(row.asset_id);
        if (!commitment || commitment.lifecycle_state !== 'pending' || !occasion || occasion.source_active === false) continue;
        // The query already applied contact marks, date/place suppressions and
        // source permissions; this is a link to that same visible obligation.
        if (!situations.clusters.some(cluster => cluster.items.some(item => item.ref.collection === 'commitment' && item.ref.id === commitment.id))) continue;
        visibleOccurrences.push({ id: row.id, asset_id: row.asset_id, asset_name: occasion.title, subject_kind: 'occasion', question: false,
          reminders_started: points.control(row.id).last_notified_on !== null, commitment, ...(occasion.sphere ? { sphere: occasion.sphere } : {}) }); continue;
      }
      const commitment = deps.work.readCommitment(row.commitment_id); const asset = deps.work.readAssetEffective(row.asset_id);
      if (!commitment || commitment.lifecycle_state !== 'pending' || !asset) continue;
      // §15.7 (2026-10-24) — a renewal says so, and whether the owner acknowledged its latest reminder.
      const rule = asset.rules.find(item => item.id === row.rule_id); const renewal = rule ? assetRenewal(asset, rule) : null;
      visibleOccurrences.push({ id: row.id, asset_id: row.asset_id, asset_name: asset.name, question: row.question,
        reminders_started: points.control(row.id).last_notified_on !== null, commitment,
        ...(asset.sphere_override ?? asset.sphere ? { sphere: asset.sphere_override ?? asset.sphere } : {}),
        ...(renewal?.current === row.cycle ? { renewal, ...(points.acknowledged(row.id) ? { acknowledged: true as const } : {}) } : {}) });
    }
    const summaries: Record<string, string> = {};
    for (const cluster of situations.clusters) {
      const cached = deps.db.prepare('SELECT fingerprint,summary FROM scheduled_situation_summaries WHERE id=?').get(cluster.id) as { fingerprint: string; summary: string } | undefined;
      if (cached?.fingerprint === contentKey(cluster)) summaries[cluster.id] = cached.summary;
    }
    // An item names people by id (§6.2); Today shows the names.
    const ids = new Set(situations.clusters.flatMap(cluster => cluster.items.flatMap(item => item.who.value ?? [])));
    const people = deps.personName ? Object.fromEntries([...ids].flatMap(id => { const name = deps.personName!(id); return name ? [[id, name]] : []; })) : undefined;
    return { ...await deps.overview(), situations, occurrences: visibleOccurrences, ...(Object.keys(summaries).length ? { summaries } : {}), ...(people ? { people } : {}) };
  };
  type DigestMode = 'overview' | 'day_of' | 'manual';
  /** What the Digest says for one of its modes on `day`: Coming up (`overview`), Due today
   *  (`day_of`) or a Send now (`manual`). D-340 slice 2: also a stream's Coming up and Due today.
   *  The groups that changed since they were last sent (a due-day note at most two, and only what it
   *  may interrupt for), what was resolved, what is still open, and the mailboxes' health. Null when
   *  there is nothing to say; the resolutions it walked past are then handled. Unless `dryRun` (a
   *  preview, which asks no model and marks nothing), it keeps the groups it read and asks a model for
   *  each one's summary, as the Digest always has. `unchanged` reads the window again before the
   *  send, since grants can change during a model call, and `commit` marks what was sent once it went. */
  const digestPart = async (mode: DigestMode, day: string, lookAheadDays: number, context: SituationReadContext,
    options: { dryRun?: boolean; leaveOut?: (item: SituationItem) => boolean; resolutions?: false; namesPrivate?: boolean } = {})
    : Promise<{ lines: string[]; items: number; unchanged: () => Promise<boolean>; commit: (sendAt: number, runId: string) => void } | null> => {
    const { dryRun = false, leaveOut } = options; const hides = hiderFor(options.namesPrivate);
    const zone = deps.timeZone(); const at = now();
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const from = dueSpan(calendarDayMs(day)!, zone).start;
    // A due-day note covers its day; a digest, scheduled or sent now, the days the owner chose.
    const endDay = shiftAssetDate(day, { amount: mode === 'day_of' ? 1 : lookAheadDays, unit: 'days' });
    const to = dueSpan(calendarDayMs(endDay)!, zone).start - 1;
    // Scheduled pushes leave questions in Yours; clock asks remain the
    // occurrence service's responsibility, outside every inference budget.
    const read = async (readContext: SituationReadContext): Promise<SituationResult> => {
      const result = await collect(from, to, mode === 'day_of' ? 'push' : 'digest', readContext);
      result.clusters = result.clusters.flatMap(cluster => {
        const items = cluster.items.filter(item => !isState(item) && !(item.reasons.includes('missing') && item.when.value === null) && !leaveOut?.(item));
        return items.length ? [{ ...cluster, items }] : [];
      });
      return result;
    };
    const result = await read(context);
    if (!dryRun) for (const cluster of result.clusters) {
      const current = deps.store.get(cluster.id);
      deps.store.save({ ...current?.snapshot, id: cluster.id, state: current?.snapshot.state === 'resolved' ? 'new' : current?.snapshot.state ?? 'new', cluster: withoutContext(cluster),
        urgency: cluster.items.some(item => item.consequence === 'floor') ? 'floor' : mode === 'day_of' ? 'day_of' : 'routine' },
      { source: 'scheduled-situations' }, at);
      listed.run(cluster.id, at);
    }
    const changed = result.clusters.filter(cluster => {
      const row = deps.db.prepare('SELECT fingerprint FROM scheduled_situation_seen WHERE id=?').get(cluster.id) as { fingerprint: string } | undefined;
      return row?.fingerprint !== hash(identity(cluster));
    });
    // Meaningful resolutions are changes too. A trip ends with its source
    // span; its independent unresolved commitments keep their own identities.
    // Its own clusters only: their ids share a prefix, so they sort together.
    if (!dryRun) walk: for (let cursor = 'situation-'; ;) {
      const page = deps.store.walk(cursor, 500); if (!page.length) break;
      for (const entry of page) {
        if (!entry.snapshot.id.startsWith('situation-')) break walk;
        if (entry.snapshot.state !== 'resolved' && entry.snapshot.cluster.span && entry.snapshot.cluster.span.to < at
          && entry.snapshot.cluster.items.some(item => ['booking', 'calendar'].includes(item.kind))) {
          deps.store.save({ ...entry.snapshot, state: 'resolved' }, { source: 'scheduled-situations' }, at);
        }
      }
      cursor = page.at(-1)!.snapshot.id; if (page.length < 500) break;
    }
    const resolved: import('@recued/contracts').SituationRevision[] = [];
    let handledRevision = deps.store.readSetting<number>('situations.last_sent_revision', 0);
    // Walk in feed order and keep unsent resolutions behind the cursor. A
    // busy week cannot hide a resolution beyond an arbitrary first page. A stream's Due today says
    // none: they are Coming up's, and its cursor stays where it was.
    while (options.resolutions !== false && resolved.length < 5) {
      const page = deps.store.revisionsAfter(handledRevision, 1000); if (!page.length) break;
      for (const revision of page) {
        handledRevision = revision.revision;
        if (revision.after.state === 'resolved' && revision.after.id.startsWith('situation-')
          && wholeSituationSnapshotAllowed(revision.after, context.grants, context) && (deps.memoryAllowed?.(revision.after.cluster) ?? true)) resolved.push(revision);
        if (resolved.length === 5) break;
      }
      if (page.length < 1000) break;
    }
    const shown = changed.filter(cluster => mode !== 'day_of' || dayOfAllowed(cluster)).slice(0, mode === 'day_of' ? 2 : 5);
    if (!dryRun && mode !== 'day_of') deps.retainCited?.(shown);
    if (!shown.length && !resolved.length) {
      if (!dryRun) deps.store.writeSetting('situations.last_sent_revision', handledRevision);
      return null;
    }
    const lines: string[] = []; let items = 0;
    for (const cluster of shown) {
      if (deps.memoryAllowed?.(cluster) === false) continue;
      let summary: string | undefined;
      const fingerprint = contentKey(cluster);
      const cached = deps.db.prepare('SELECT fingerprint,summary FROM scheduled_situation_summaries WHERE id=?').get(cluster.id) as { fingerprint: string; summary: string } | undefined;
      if (cached?.fingerprint === fingerprint) summary = cached.summary;
      else if (deps.summarize && !dryRun) {
        const currentContext = access!.context(ownerSource, null);
        if (!wholeSituationSnapshotAllowed({ id: cluster.id, state: 'new', cluster, urgency: 'routine' }, currentContext.grants, currentContext)) continue;
        try { summary = await deps.summarize(cluster, () => {
          // A stop starts no model call: the brief goes without the summary.
          if (stopped || !deps.isVaultUnlocked()) return false;
          const latest = access!.context(ownerSource, null);
          return wholeSituationSnapshotAllowed({ id: cluster.id, state: 'new', cluster, urgency: 'routine' }, latest.grants, latest)
            && (deps.memoryAllowed?.(cluster) ?? true);
        }); } catch { /* Values remain usable without a model. */ }
        if (summary) deps.db.prepare('INSERT INTO scheduled_situation_summaries(id,fingerprint,summary) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,summary=excluded.summary').run(cluster.id, fingerprint, summary);
      }
      // A model's summary of a group may name what its lines keep private.
      if (summary && !cluster.items.some(item => hides(item))) lines.push(summary);
      for (const item of cluster.items) lines.push(hides(item) ? 'Reminder in Yours'
        : `${item.what.value} · ${item.when_day ?? (item.when.value ? assetDateAt(item.when.value.from, zone) : 'date unknown')}${missedBy(item, cluster, anchor => named(anchor, hides))}${item.basis === 'inferred' ? ' · Recued’s guess' : ''}`);
      items += cluster.items.length;
    }
    for (const revision of resolved) {
      const first = revision.after.cluster.items[0];
      lines.push(`Resolved · ${first && hides(first, true) ? 'a reminder in Yours' : first?.what.value ?? 'Situation'}`);
      items += 1;
    }
    const open = result.omitted + result.clusters.filter(cluster => !shown.includes(cluster)).reduce((sum, cluster) => sum + cluster.items.length, 0);
    if (open) lines.push(`Still open: ${open} more items. Open Today for the rest.`);
    if (result.partial?.length) lines.push(`Not fully checked: ${result.partial.map(collection => `${collection.replaceAll('_', ' ')}s`).join(', ')}. There were more than one read can hold, so some may be missing.`);
    const mailShown = context.grants.isVerbOpGranted('core.mail.get') && context.grants.isCollectionReadGranted('mail');
    if (mailShown) {
      for (const mailbox of deps.mailHealth?.() ?? []) lines.push(`${mailbox.name}: ${mailbox.last_success_at > 0 ? `last successful mail sync ${assetDateAt(mailbox.last_success_at, zone)} ${clock.format(mailbox.last_success_at)}` : 'mail has not synced yet'}${mailbox.needs_attention ? ' · needs attention' : ''}`);
    }
    return { lines, items,
      // The source and sphere grants may change during an optional model call.
      // Re-read before I/O; never release a stale wider payload.
      unchanged: async () => {
        const fresh = await read(access!.context(ownerSource, null));
        const finalContext = access!.context(ownerSource, null);
        return !(identity(fresh) !== identity(result)
          || (mode === 'day_of' && shown.some(cluster => !dayOfAllowed(cluster)))
          || (mailShown && (!finalContext.grants.isVerbOpGranted('core.mail.get') || !finalContext.grants.isCollectionReadGranted('mail')))
          || resolved.some(revision => !wholeSituationSnapshotAllowed(revision.after, finalContext.grants, finalContext) || deps.memoryAllowed?.(revision.after.cluster) === false));
      },
      commit: (sendAt, runId) => {
        for (const cluster of shown) deps.db.prepare('INSERT INTO scheduled_situation_seen(id,fingerprint,sent_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,sent_at=excluded.sent_at')
          .run(cluster.id, hash(identity(cluster)), sendAt);
        deps.store.writeSetting('situations.last_sent_at', sendAt);
        deps.store.writeSetting('situations.last_sent_revision', handledRevision);
        deps.store.measure('scheduled.push', 1, { mode, clusters: shown.length }, sendAt, runId);
        if (mode !== 'manual') recordFirstDigest(deps.store, shown, sendAt);
      } };
  };
  const digestTick = async (manual = false): Promise<void> => {
    if (stopped || !access || !deps.isVaultUnlocked()) return;
    const at = now(); const zone = deps.timeZone(); const day = assetDateAt(at, zone); const config = settings();
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const minute = clock.format(at);
    const { due, late } = dueTime(config);
    if (!manual && minute < due) return;
    if (!manual && deps.isQuiet(at)) return;
    const overview = overviewRun(config, day, late, changedDayIn(zone));
    const tasks: Array<{ id: string; mode: string }> = manual ? [{ id: `manual:${randomUUID()}`, mode: 'manual' }] : [
      ...(overview ? [{ id: overview, mode: 'overview' }] : []),
      ...(config.day_of ? [{ id: `day_of:${day}`, mode: 'day_of' }] : []),
    ];
    if (!manual) {
      const pending = deps.db.prepare("SELECT * FROM scheduled_situation_runs WHERE state IN ('pending','sending') ORDER BY at DESC,rowid DESC").all() as RunRow[];
      for (const mode of ['overview', 'day_of']) {
        const allowed = mode === 'overview' ? config.frequency !== 'off' : config.day_of;
        const sameMode = pending.filter(row => row.mode === mode);
        const retry = allowed ? sameMode[0] : undefined;
        if (retry) {
          const index = tasks.findIndex(task => task.mode === mode);
          if (index < 0) tasks.push({ id: retry.id, mode }); else tasks[index] = { id: retry.id, mode };
        }
        // A delayed overview is regenerated from the current window. Earlier
        // known failures coalesce; an unknown send remains a visible receipt.
        for (const older of sameMode.filter(row => row.id !== retry?.id)) deps.db.prepare("UPDATE scheduled_situation_runs SET state=? WHERE id=?")
          .run(older.state === 'sending' ? 'uncertain' : 'superseded', older.id);
      }
    }
    for (const { mode, id } of tasks) {
      if (stopped || !deps.isVaultUnlocked() || (!manual && deps.isQuiet(now()))) return;
      // D-338 — a day the Agenda lists that morning or the evening before is left to it: the note
      // would repeat what the Agenda already lists.
      if (mode === 'day_of' && agendaListsDay(day)) continue;
      const previous = deps.db.prepare('SELECT * FROM scheduled_situation_runs WHERE id=?').get(id) as RunRow | undefined;
      if (previous && ['sent', 'skipped', 'uncertain'].includes(previous.state)) continue;
      const budget = (deps.db.prepare(`SELECT count(*) AS n FROM scheduled_situation_attempts WHERE day=? AND mode!='manual' AND ${runsOf('digest')}`).get(day) as { n: number }).n;
      if (!manual && budget >= 2) continue;
      // An interrupted send is allowed one clearly marked repeat. Its second
      // uncertainty remains visible in Settings until the owner sends again.
      if (previous?.state === 'sending' && previous.attempts >= 2) {
        deps.db.prepare("UPDATE scheduled_situation_runs SET state='uncertain' WHERE id=?").run(id); continue;
      }
      const part = await digestPart(mode as DigestMode, day, config.look_ahead_days, access.context(ownerSource, null));
      if (!part) {
        deps.db.prepare("INSERT INTO scheduled_situation_runs(id,mode,day,at,state) VALUES(?,?,?,?,'skipped') ON CONFLICT(id) DO UPDATE SET state='skipped',at=excluded.at,day=excluded.day")
          .run(id, mode, day, at); continue;
      }
      const lines = [...previous?.state === 'sending' ? ['Repeating once because the previous delivery could not be confirmed.'] : [], ...part.lines];
      const text = lines.join('\n').slice(0, 12_000);
      if (!(await part.unchanged())) continue;
      if (stopped || !deps.isVaultUnlocked() || (!manual && deps.isQuiet(now()))) return;
      const sendAt = now(); const sendDay = assetDateAt(sendAt, zone);
      const attempt = deps.db.transaction(() => {
        const used = (deps.db.prepare(`SELECT count(*) AS n FROM scheduled_situation_attempts WHERE day=? AND mode!='manual' AND ${runsOf('digest')}`).get(sendDay) as { n: number }).n;
        if (!manual && used >= 2) return null;
        deps.db.prepare("INSERT INTO scheduled_situation_runs(id,mode,day,at,state,text,attempts) VALUES(?,?,?,?,'sending',?,1) ON CONFLICT(id) DO UPDATE SET state='sending',text=excluded.text,attempts=attempts+1,at=excluded.at,day=excluded.day")
          .run(id, mode, sendDay, sendAt, text);
        return Number(deps.db.prepare("INSERT INTO scheduled_situation_attempts(run_id,day,at,mode,outcome) VALUES(?,?,?,?,'sending')").run(id, sendDay, sendAt, mode).lastInsertRowid);
      })();
      if (attempt === null) continue;
      let delivered: readonly string[] = [];
      // D-338 — "Due today", not "Today": that is the screen's name.
      try { delivered = (await deps.send({ title: mode === 'day_of' ? 'Due today' : 'Coming up', text, ui_link_url: '#today' })).delivered_to; }
      catch { deps.db.prepare("UPDATE scheduled_situation_attempts SET outcome='uncertain' WHERE id=?").run(attempt); continue; }
      if (!delivered.length) {
        deps.db.prepare("UPDATE scheduled_situation_attempts SET outcome='not_delivered' WHERE id=?").run(attempt);
        deps.db.prepare("UPDATE scheduled_situation_runs SET state='pending' WHERE id=?").run(id); continue;
      }
      deps.db.transaction(() => {
        deps.db.prepare("UPDATE scheduled_situation_attempts SET outcome='delivered' WHERE id=?").run(attempt);
        deps.db.prepare("UPDATE scheduled_situation_runs SET state='sent',delivered_to=? WHERE id=?").run(JSON.stringify(delivered), id);
        part.commit(sendAt, id);
      })();
    }
  };
  const dayTitle = (day: string): string =>
    new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(Date.parse(`${day}T00:00:00Z`));
  /** §15.7 amendment (2026-11-02, later) — the Agenda's lines for its days, from `from` up to `end`,
   *  in time order, all-day first: everything Today would show on each, recurring events
   *  included, and repeated whether or not it changed. Read through the same gated query as the
   *  Digest, whole: every group and every item (`everyItem`). What the owner dismissed stays off,
   *  as it does on every surface that interrupts them, and what an item's own reminder keeps
   *  private reads "Reminder in Yours". On the day it goes, what has already ended is left out:
   *  the query drops what is over (`valid_until`) before anything relates to it. An open task
   *  whose time has passed is not over, so it stays. Amended 2026-11-03: a week goes a day at a
   *  time, each under its date, and a day with nothing on is left out. Something that lasts
   *  several days is on each of them. D-343 slice 4: a day being closed (`throughTheDay`) keeps
   *  what is already over, so the evening notice lists the whole day. */
  const agendaLines = async (from: string, end: string, context: SituationReadContext,
    options: { throughTheDay?: true; namesPrivate?: boolean } = {}): Promise<{ lines: string[]; mentions: AgendaMention[]; items: number }> => {
    const zone = deps.timeZone(); const at = now(); const hides = hiderFor(options.namesPrivate);
    const startOf = (day: string) => dueSpan(calendarDayMs(day)!, zone).start;
    const result = await deps.query({ time: { from: startOf(from), to: startOf(end) - 1 }, surface: 'today' },
      { ...context, everyItem: true, ...(options.throughTheDay ? { throughTheDay: true } : {}) });
    const questions = new Set(occurrences.all().filter(row => row.question).flatMap(row => row.commitment_id ? [row.commitment_id] : []));
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const items = result.clusters.flatMap(cluster => deps.memoryAllowed?.(cluster) === false ? [] : cluster.items)
      .filter(item => item.when.value && !isState(item) && !questions.has(item.ref.id) && !dismissals.hides(item, at));
    const several = shiftDays(from, 1) < end; const lines: string[] = []; const mentions: AgendaMention[] = []; let itemCount = 0;
    for (let day = from; day < end; day = shiftDays(day, 1)) {
      const start = startOf(day); const stop = startOf(shiftDays(day, 1));
      const seen = new Set<string>(); const rows: Array<{ allDay: boolean; at: number; line: string; title: string; rank?: number; mentions?: AgendaMention[] }> = [];
      // D-338 — the day's birthdays and anniversaries from the owner's contacts go on one line each
      // (the owner: "one line for two pieces: birthday: ... anniversaries: ...(only if have)"). Every
      // contact's dates are in the Agenda, and a line each opened the day with them.
      // In the app each name opens its contact (D-338 §11: "make the names clickable").
      const dates = { birthday: [] as AgendaMention[], anniversary: [] as AgendaMention[] };
      for (const item of items) {
        const when = item.when.value!; const key = JSON.stringify([item.ref.collection, item.ref.id, item.ref.field ?? null]);
        // On the day: a point inside it, or a span that overlaps it. The query's own window
        // reaches back for what is overdue, and a line belongs to its own day only.
        const point = when.from === when.to;
        if (seen.has(key) || (point ? when.from < start || when.from >= stop : when.from >= stop || when.to <= start)) continue;
        seen.add(key);
        const allDay = item.when_day !== undefined || (!point && when.from <= start && when.to >= stop);
        if (item.ref.collection === 'contact' && (item.kind === 'birthday' || item.kind === 'anniversary') && !hides(item)) {
          // The contact source titles it `<name> · <kind>`.
          const title = item.what.value ?? ''; const suffix = ` · ${item.kind}`;
          dates[item.kind].push({ text: title.endsWith(suffix) ? title.slice(0, -suffix.length) : title,
            ref: { collection: 'contact', id: item.ref.id } }); continue;
        }
        const label = allDay ? 'All day ·' : when.from < start ? `Until ${clock.format(when.to)} ·` : clock.format(when.from);
        // A calendar item's id is `<calendar>:<record id>`; its prep notes are keyed by the record id.
        const prepared = item.ref.collection === 'calendar' && deps.prepNotesReady?.(item.ref.id.slice(item.ref.id.indexOf(':') + 1)) === true;
        const title = hides(item) ? 'Reminder in Yours'
          : `${item.what.value}${prepared ? ' · prep notes ready' : ''}${item.basis === 'inferred' ? ' · Recued’s guess' : ''}`;
        rows.push({ allDay, at: allDay ? start : when.from, line: `${label} ${title}`, title });
      }
      for (const [rank, kind, one, many] of [[0, 'birthday', 'Birthday', 'Birthdays'], [1, 'anniversary', 'Anniversary', 'Anniversaries']] as const) {
        // One a person: two people of one name are both there.
        const people = [...new Map(dates[kind].map(person => [person.ref.id, person])).values()].sort((a, b) => a.text.localeCompare(b.text));
        if (people.length) rows.push({ allDay: true, at: start, rank, title: many, mentions: people.slice(0, AGENDA_DATE_NAMES),
          line: `${people.length === 1 ? one : many}: ${namesLine(people.map(person => person.text))}` });
      }
      if (!rows.length) continue;
      itemCount += rows.length;
      // All-day first, the day's birthdays and anniversaries leading them.
      rows.sort((a, b) => Number(b.allDay) - Number(a.allDay) || (a.rank ?? 2) - (b.rank ?? 2) || a.at - b.at || a.title.localeCompare(b.title));
      if (several) lines.push(...lines.length ? [''] : [], dayTitle(day));
      lines.push(...rows.slice(0, AGENDA_MAX_LINES).map(row => row.line));
      mentions.push(...rows.slice(0, AGENDA_MAX_LINES).flatMap(row => row.mentions ?? []));
      if (rows.length > AGENDA_MAX_LINES) lines.push(`And ${rows.length - AGENDA_MAX_LINES} more${several ? ' that day' : ''}. Open Today for the rest.`);
    }
    return { lines, mentions, items: itemCount };
  };
  /** D-342 §3, D-343 §3.2 — the owner's active pursuits marked "Ask me in the evening"
   *  (`settings.evening`), by name. A private one is named only as "a pursuit in Yours". */
  const eveningPursuits = (): Array<{ id: string; name: string; private: boolean }> =>
    deps.work.listAssets({ asset_class: { id: PURSUIT_CLASS_ID, match: 'only' }, limit: 200 })
      .filter(asset => asset.deleted_at == null && (asset.status === 'active' || asset.status === 'lent') && asset.settings.evening === true)
      .map(asset => ({ id: asset.id, name: asset.name, private: asset.settings.sensitive === true }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  /** D-343 slice 4 (§3.2) — the evening notice for `day`: "Close the day · Sat 7 Nov", the day's
   *  lines as the Agenda writes them, the whole day (what is over included), the pursuits asked
   *  about in the evening, and the one line that asks. Plain text, no model call (ruling 12). A
   *  day with nothing on still asks (ruling 21). In the app each pursuit's name opens it. */
  const closeDayNotice = async (day: string, context: SituationReadContext): Promise<{ title: string; text: string; mentions: AgendaMention[] }> => {
    // D-340 slice 5 — it goes where the daily stream goes, and names what that stream names.
    const names = streamsActive() && streamSettings('daily').include_private;
    const { lines, mentions } = await agendaLines(day, shiftDays(day, 1), context, { throughTheDay: true, namesPrivate: names });
    const pursuits = eveningPursuits();
    const named = pursuits.map(pursuit => pursuit.private && !names ? 'a pursuit in Yours' : pursuit.name);
    const text = [...lines.length ? lines : [CLOSE_DAY_NOTHING_ON],
      ...pursuits.length ? ['', `${pursuits.length === 1 ? 'Pursuit' : 'Pursuits'}: ${namesLine(named)}`] : [], '', CLOSE_DAY_ASK].join('\n');
    const linked = pursuits.slice(0, AGENDA_DATE_NAMES).flatMap(pursuit => pursuit.private && !names ? []
      : [{ text: pursuit.name, ref: { collection: 'asset', id: pursuit.id } }]);
    return { title: `Close the day · ${dayTitle(day)}`, text, mentions: [...mentions, ...linked] };
  };
  /** One run of a day's message, the Agenda's, Close the day's (D-343 slice 4) or a stream's (D-340
   *  slice 2): built, then sent with the Digest's receipts — a run marked `sending` with its attempt
   *  counted before the send, one marked repeat after a send cut short, then uncertain — on a budget
   *  of its own (`feature`'s scheduled mode), so no feature spends another's two sends a day. `build`
   *  answers null for a run with nothing to send. A stream's message goes to its channels, reads
   *  again before it goes whether what it holds still stands (`unchanged`; the next tick builds it
   *  anew if not), and marks what it sent once it went (`commit`). */
  const sendDayMessage = async (id: string, mode: string, feature: 'agenda' | 'close_day' | 'stream' | 'stream_week',
    build: () => Promise<{ title: string; lines: string[]; mentions: AgendaMention[]; channels?: NotificationDeliveryChannel[] | null;
      unchanged?: () => Promise<boolean>; commit?: (sendAt: number) => void;
      /** D-340 slice 3 — sends it some other way than `send`. `final`: what it handed on retries on its
       *  own, so this run is not sent again, and stays uncertain if nothing went at once. `stale`: what
       *  it holds changed, so the next tick builds it again. */
      deliver?: (message: { title: string; text: string; mentions: AgendaMention[] }) => Promise<{ delivered_to: readonly string[]; final?: boolean; stale?: boolean }>;
    } | null>): Promise<void> => {
    const manual = mode !== feature; const zone = deps.timeZone();
    const previous = deps.db.prepare('SELECT * FROM scheduled_situation_runs WHERE id=?').get(id) as RunRow | undefined;
    if (previous && ['sent', 'skipped', 'uncertain'].includes(previous.state)) return;
    const used = (day: string) => (deps.db.prepare('SELECT count(*) AS n FROM scheduled_situation_attempts WHERE day=? AND mode=?').get(day, feature) as { n: number }).n;
    if (!manual && used(assetDateAt(now(), zone)) >= 2) return;
    if (previous?.state === 'sending' && previous.attempts >= 2) {
      deps.db.prepare("UPDATE scheduled_situation_runs SET state='uncertain' WHERE id=?").run(id); return;
    }
    const built = await build();
    if (stopped || !deps.isVaultUnlocked() || (!manual && deps.isQuiet(now()))) return;
    if (built === null) {
      deps.db.prepare("INSERT INTO scheduled_situation_runs(id,mode,day,at,state) VALUES(?,?,?,?,'skipped') ON CONFLICT(id) DO UPDATE SET state='skipped',at=excluded.at,day=excluded.day")
        .run(id, mode, assetDateAt(now(), zone), now()); return;
    }
    const { title, mentions } = built; const lines = [...built.lines];
    if (previous?.state === 'sending') lines.unshift('Repeating once because the previous delivery could not be confirmed.');
    const text = lines.join('\n').slice(0, 12_000);
    if (built.unchanged && !(await built.unchanged())) return;
    if (stopped || !deps.isVaultUnlocked() || (!manual && deps.isQuiet(now()))) return;
    const sendAt = now(); const sendDay = assetDateAt(sendAt, zone);
    const attempt = deps.db.transaction(() => {
      if (!manual && used(sendDay) >= 2) return null;
      deps.db.prepare("INSERT INTO scheduled_situation_runs(id,mode,day,at,state,text,attempts,mentions) VALUES(?,?,?,?,'sending',?,1,?) ON CONFLICT(id) DO UPDATE SET state='sending',text=excluded.text,mentions=excluded.mentions,attempts=attempts+1,at=excluded.at,day=excluded.day")
        .run(id, mode, sendDay, sendAt, text, JSON.stringify(mentions));
      return Number(deps.db.prepare("INSERT INTO scheduled_situation_attempts(run_id,day,at,mode,outcome) VALUES(?,?,?,?,'sending')").run(id, sendDay, sendAt, mode).lastInsertRowid);
    })();
    if (attempt === null) return;
    let delivered: readonly string[] = []; let final = false;
    try {
      const result: { delivered_to: readonly string[]; final?: boolean } = built.deliver ? await built.deliver({ title, text, mentions })
        : await deps.send({ title, text, ui_link_url: '#today', ...(mentions.length ? { mentions } : {}),
          ...(built.channels ? { channels: built.channels } : {}) });
      delivered = result.delivered_to; final = result.final === true;
    } catch { deps.db.prepare("UPDATE scheduled_situation_attempts SET outcome='uncertain' WHERE id=?").run(attempt); return; }
    if (!delivered.length) {
      deps.db.prepare("UPDATE scheduled_situation_attempts SET outcome='not_delivered' WHERE id=?").run(attempt);
      deps.db.prepare('UPDATE scheduled_situation_runs SET state=? WHERE id=?').run(final ? 'uncertain' : 'pending', id); return;
    }
    deps.db.transaction(() => {
      deps.db.prepare("UPDATE scheduled_situation_attempts SET outcome='delivered' WHERE id=?").run(attempt);
      deps.db.prepare("UPDATE scheduled_situation_runs SET state='sent',delivered_to=? WHERE id=?").run(JSON.stringify(delivered), id);
      built.commit?.(sendAt);
    })();
  };
  /** One Agenda run, titled with its day, or its first and last. A day with nothing on sends nothing. */
  const sendAgenda = (id: string, mode: 'agenda' | 'agenda_manual', from: string, end: string): Promise<void> =>
    sendDayMessage(id, mode, 'agenda', async () => {
      const { lines, mentions } = await agendaLines(from, end, access!.context(ownerSource, null));
      if (!lines.length) return null;
      const last = shiftDays(end, -1);
      return { title: `Agenda · ${last === from ? dayTitle(from) : `${dayTitle(from)} to ${dayTitle(last)}`}`, lines, mentions };
    });
  /** D-343 slice 4 — one evening notice, for the day it closes. It always has something to send.
   *  D-343 §3.1: once the streams take over, it goes to the daily stream's channels. */
  const sendCloseDay = (id: string, mode: 'close_day' | 'close_day_manual', day: string): Promise<void> =>
    sendDayMessage(id, mode, 'close_day', async () => {
      const notice = await closeDayNotice(day, access!.context(ownerSource, null));
      return { title: notice.title, lines: notice.text.split('\n'), mentions: notice.mentions,
        ...(streamsActive() ? { channels: streamSettings('daily').channels } : {}) };
    });
  /** D-340 §3.2, §4 — what holds on `day`, the daily stream's first part, a line each: the state's
   *  title, and until when if it ends that day. A private one only with Include private items (D-340
   *  slice 5), and what the owner dismissed stays off, as on every surface that interrupts them. */
  const stateLines = async (day: string, context: SituationReadContext, namesPrivate = false): Promise<string[]> => {
    const hides = hiderFor(namesPrivate);
    const zone = deps.timeZone(); const at = now();
    const start = dueSpan(calendarDayMs(day)!, zone).start; const stop = dueSpan(calendarDayMs(shiftDays(day, 1))!, zone).start;
    const result = await deps.query({ time: { from: start, to: stop - 1 }, surface: 'today' }, { ...context, everyItem: true });
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const seen = new Set<string>(); const lines: string[] = [];
    for (const item of result.clusters.flatMap(cluster => deps.memoryAllowed?.(cluster) === false ? [] : cluster.items)) {
      const key = JSON.stringify([item.ref.collection, item.ref.id, item.ref.field ?? null]);
      if (!isState(item) || hides(item) || dismissals.hides(item, at) || seen.has(key)) continue;
      seen.add(key);
      const until = item.when.value?.to;
      lines.push(`${item.what.value}${until !== undefined && until > start && until < stop ? ` · until ${clock.format(until)}` : ''}`);
    }
    return lines;
  };
  /** D-340 §3.2 — a stream's message for its days, in this order: what holds today (daily, under no
   *  heading, ruling 10), the Agenda, what is due that day (daily, when it lists no Agenda), and Coming
   *  up for the days after the Agenda's (or from its day, with no Agenda), each but the first under its heading. A part with nothing in it is left out, and a message
   *  with none is not sent. "Your day · Sat 7 Nov" or "Your week · Mon 2 Nov to Sun 8 Nov" (ruling
   *  12). A Coming up folded into it from another time says so once (§3.6). `dryRun`, the preview,
   *  asks no model and marks nothing. */
  const streamMessage = async (kind: SituationStreamKind, span: { from: string; end: string }, context: SituationReadContext, dryRun: boolean,
    ahead: string | null) => {
    const stream = streamSettings(kind); const sections: string[][] = []; const mentions: AgendaMention[] = [];
    const counts = { states: 0, agenda: 0, due_today: 0, coming_up: 0, reminders: 0, suggestions: 0 };
    const parts: Array<NonNullable<Awaited<ReturnType<typeof digestPart>>>> = [];
    if (kind === 'daily') {
      const states = await stateLines(span.from, context, stream.include_private);
      if (states.length) { sections.push(states); counts.states = states.length; }
    }
    // D-340 slice 4 (§3.2, §3.3) — the AI suggestions, when they finished before it went: under what
    // holds today, ending with "Talk it over", their conversation. A reply quoting them works too.
    const suggestions = stream.agenda && stream.suggestions && ahead !== null ? await suggestionsFor(kind, ahead) : null;
    if (suggestions) {
      const chars = Array.from(suggestions.text);
      const text = chars.length > DONE_TEXT_MAX_CHARS ? `${chars.slice(0, DONE_TEXT_MAX_CHARS).join('')}…` : suggestions.text;
      const base = answers?.publicBaseUrl?.();
      sections.push(['Suggestions', ...text.split('\n'), base
        ? `Talk it over: ${base.replace(/\/+$/u, '')}/#chat/session/${encodeURIComponent(suggestions.session_id)}`
        : 'Talk it over: reply to this message, or open Today in Recued.']);
      counts.suggestions = 1;
    }
    if (stream.agenda) {
      const agenda = await agendaLines(span.from, span.end, context, { namesPrivate: stream.include_private });
      if (agenda.lines.length) { sections.push(['Agenda', ...agenda.lines]); mentions.push(...agenda.mentions); counts.agenda = agenda.items; }
    }
    // D-340 slice 3 (§3.1) — the day's reminders, by number, as their buttons are numbered: in the
    // daily stream that lists their day, the owner's, never one that went at once.
    const reminders = kind === 'daily' && stream.reminders && deps.reminders
      ? deps.reminders.streamReminders({ namesPrivate: stream.include_private, day: span.from }) : [];
    // §3.2 — Due today is redundant beside Reminders, as it is beside the Agenda.
    if (kind === 'daily' && stream.due_today && !stream.agenda && !reminders.length) {
      const due = await digestPart('day_of', span.from, 1, context, { dryRun, resolutions: false, namesPrivate: stream.include_private });
      const today = span.from === assetDateAt(now(), deps.timeZone());
      if (due) { sections.push([today ? 'Due today' : 'Due tomorrow', ...due.lines]); parts.push(due); counts.due_today = due.items; }
    }
    if (reminders.length) {
      sections.push(['Reminders', ...reminders.flatMap((reminder, index) => [`${index + 1}. ${reminder.ask.message.title ?? 'Reminder'}`, reminder.ask.message.text])]);
      counts.reminders = reminders.length;
    }
    if (stream.coming_up) {
      // The days after the Agenda's: what it lists is not repeated under Coming up in the same message,
      // including what the read brings in from before its window because it is not over yet.
      const zone = deps.timeZone(); const listed = { from: dueSpan(calendarDayMs(span.from)!, zone).start, to: dueSpan(calendarDayMs(span.end)!, zone).start };
      const onAgenda = (item: SituationItem): boolean => item.when.value !== null
        && (item.when.value.from === item.when.value.to ? item.when.value.from >= listed.from && item.when.value.from < listed.to
          : item.when.value.from < listed.to && item.when.value.to > listed.from);
      const coming = await digestPart('overview', stream.agenda ? span.end : span.from, stream.look_ahead_days, context,
        { dryRun, namesPrivate: stream.include_private, ...(stream.agenda ? { leaveOut: onAgenda } : {}) });
      if (coming) { sections.push(['Coming up', ...coming.lines]); parts.push(coming); counts.coming_up = coming.items; }
    }
    const last = shiftDays(span.end, -1);
    const title = kind === 'daily' ? `${STREAM_DAY_TITLE} · ${dayTitle(span.from)}` : `${STREAM_WEEK_TITLE} · ${dayTitle(span.from)} to ${dayTitle(last)}`;
    const note = deps.store.readSetting<string>(`situations.stream_fold_note.${kind}`, '');
    const lines = sections.length ? [...note ? [note, ''] : [], ...sections.flatMap((section, index) => [...index ? [''] : [], ...section])] : [];
    return { title, lines, mentions, counts, parts, note, reminders, suggestions };
  };
  /** D-340 slice 2 — one run of a stream, to its channels. Once it went, its Coming up and Due today
   *  count as sent, and its fold note has been said. */
  const sendStream = (kind: SituationStreamKind, id: string, mode: string, span: { from: string; end: string }, ahead: string | null): Promise<void> =>
    sendDayMessage(id, mode, STREAM_FEATURE[kind], async () => {
      const message = await streamMessage(kind, span, access!.context(ownerSource, null), false, ahead);
      if (!message.lines.length) return null;
      const channels = streamSettings(kind).channels; const carrier = deps.reminders;
      return { title: message.title, lines: message.lines, mentions: message.mentions, channels,
        // D-340 slice 3 — with reminders, one ask delivery carries this message to its messengers and
        // email, each reminder with its buttons; the app's card, and a channel that takes no reminder,
        // get it as before. Handed on, it retries on its own.
        ...(message.reminders.length && carrier ? { deliver: async ({ title, text, mentions }: { title: string; text: string; mentions: AgendaMention[] }) => {
          const carried = await carrier.sendWithStream({ reminders: message.reminders, lead: { title, text }, channels });
          if (carried?.stale) return { delivered_to: [], stale: true };
          const rest = carried ? carried.other_channels : channels;
          const sent = rest !== null && rest.length === 0 ? { delivered_to: [] as readonly string[] }
            : await deps.send({ title, text, ui_link_url: '#today', ...(mentions.length ? { mentions } : {}), ...(rest !== null ? { channels: rest } : {}) });
          return { delivered_to: [...new Set([...carried?.delivered ?? [], ...sent.delivered_to])], final: carried !== null };
        } } : {}),
        unchanged: async () => (await Promise.all(message.parts.map(part => part.unchanged()))).every(Boolean),
        commit: sendAt => {
          for (const part of message.parts) part.commit(sendAt, id);
          if (message.note) deps.store.writeSetting(`situations.stream_fold_note.${kind}`, '');
          // D-340 slice 4 — carried inside it, the suggestions do not go again on their own.
          if (message.suggestions) claimPromptScheduleDone(deps.db, message.suggestions.schedule_id, message.suggestions.turn_id, 'included', sendAt);
        } };
    });
  /** D-340 §3.7 — a stream's next message as it would go now, for the preview on Today: the days of
   *  its next run (or, while it is off, the days it would list if it went now), how many lines each
   *  part holds, and its text. Nothing is sent, marked or asked of a model. */
  const streamPreview = async (kind: SituationStreamKind): Promise<SituationStreamPreview> => {
    if (!access || !deps.isVaultUnlocked()) throw new Error('Unlock Recued to preview your stream');
    const stream = streamSettings(kind); const zone = deps.timeZone(); const next = nextStream(kind);
    const day = assetDateAt(next ?? now(), zone);
    const span = agendaSpan(asAgenda(kind, next === null ? { ...stream, weekday: isoWeekdayOf(day) } : stream), day, false);
    const message = await streamMessage(kind, { from: span.start, end: span.end }, access.context(ownerSource, null), true,
      streamRun(kind, day, dueTime(stream).late, zone)?.id ?? null);
    return { title: message.title, counts: message.counts, text: message.lines.join('\n').slice(0, 12_000),
      ...(next === null ? {} : { next_at: next, time_zone: zone }) };
  };
  /** D-340 slice 2 — a stream's part of a tick, or its Send now: what it would list if it went now,
   *  today or tomorrow, and a week as if today were its weekday. As the Agenda's: a run still waiting
   *  from an earlier day or week is not sent late. */
  const streamTick = async (kind: SituationStreamKind, manual: boolean): Promise<void> => {
    if (stopped || !access || !deps.isVaultUnlocked() || !streamsActive()) return;
    const stream = streamSettings(kind); const at = now(); const zone = deps.timeZone(); const day = assetDateAt(at, zone);
    const feature = STREAM_FEATURE[kind];
    if (manual) {
      const span = agendaSpan(asAgenda(kind, { ...stream, weekday: isoWeekdayOf(day) }), day, false);
      // D-340 slice 4 — it carries the suggestions today's run would.
      await sendStream(kind, `${feature}_manual:${randomUUID()}`, `${feature}_manual`, { from: span.start, end: span.end },
        streamRun(kind, day, dueTime(stream).late, zone)?.id ?? null); return;
    }
    const { due, late } = dueTime(stream);
    const current = stream.enabled ? streamRun(kind, day, late, zone) : null;
    for (const older of deps.db.prepare("SELECT id,state FROM scheduled_situation_runs WHERE mode=? AND state IN ('pending','sending')").all(feature) as Array<Pick<RunRow, 'id' | 'state'>>) {
      if (older.id !== current?.id) deps.db.prepare('UPDATE scheduled_situation_runs SET state=? WHERE id=?').run(older.state === 'sending' ? 'uncertain' : 'superseded', older.id);
    }
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (!current || clock.format(at) < due || deps.isQuiet(at)) return;
    await sendStream(kind, current.id, feature, current, current.id);
  };
  /** The Agenda's part of a tick, or its Send now. What a run lists is `agendaSpan`'s. An agenda
   *  still waiting from an earlier day, or from an earlier week or the other frequency, is not
   *  sent late: a known failure is superseded, an unknown send stays uncertain. */
  const agendaTick = async (manual: boolean): Promise<void> => {
    if (stopped || !access || !deps.isVaultUnlocked()) return;
    const agenda = agendaSettings(); const at = now(); const zone = deps.timeZone(); const day = assetDateAt(at, zone);
    const { due, late } = dueTime(agenda);
    if (manual) {
      // Send now lists what the agenda would if it went now: today or tomorrow, and a week as if
      // today were its weekday, so it shows all seven days on any day.
      const span = agendaSpan({ ...agenda, weekday: isoWeekdayOf(day) }, day, false);
      await sendAgenda(`agenda_manual:${randomUUID()}`, 'agenda_manual', span.start, span.end); return;
    }
    const current = agenda.enabled ? agendaRun(day, late, zone) : null;
    for (const older of deps.db.prepare("SELECT id,state FROM scheduled_situation_runs WHERE mode='agenda' AND state IN ('pending','sending')").all() as Array<Pick<RunRow, 'id' | 'state'>>) {
      if (older.id !== current?.id) deps.db.prepare('UPDATE scheduled_situation_runs SET state=? WHERE id=?').run(older.state === 'sending' ? 'uncertain' : 'superseded', older.id);
    }
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (!current || clock.format(at) < due || deps.isQuiet(at)) return;
    await sendAgenda(current.id, 'agenda', current.from, current.end);
  };
  /** D-343 slice 4 — Close the day's part of a tick, or its Send now (today, at once). As the
   *  Agenda's: an evening notice still waiting from an earlier day is not sent late. */
  const closeDayTick = async (manual: boolean): Promise<void> => {
    if (stopped || !access || !deps.isVaultUnlocked()) return;
    const closing = closeDaySettings(); const at = now(); const zone = deps.timeZone(); const day = assetDateAt(at, zone);
    if (manual) { await sendCloseDay(`close_day_manual:${randomUUID()}`, 'close_day_manual', day); return; }
    const { due, late } = dueTime(closing);
    const current = closing.enabled ? closeDayRun(day, late, zone) : null;
    for (const older of deps.db.prepare("SELECT id,state FROM scheduled_situation_runs WHERE mode='close_day' AND state IN ('pending','sending')").all() as Array<Pick<RunRow, 'id' | 'state'>>) {
      if (older.id !== current?.id) deps.db.prepare('UPDATE scheduled_situation_runs SET state=? WHERE id=?').run(older.state === 'sending' ? 'uncertain' : 'superseded', older.id);
    }
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (!current || clock.format(at) < due || deps.isQuiet(at)) return;
    await sendCloseDay(current.id, 'close_day', current.day);
  };
  /** D-338 — whether the Agenda's AI suggestions have anything to look at: the Agenda's own run for
   *  the time they fall due, and what it lists. A day it would send nothing for gets no run at all
   *  (no model call, nothing in their conversation); a run whose time came before the owner last
   *  changed the Agenda, or with the Agenda off, neither. Without the vault or the owner's access it
   *  cannot tell, and the run goes as before: its notice still waits on the Agenda (`agendaDoneGate`). */
  const agendaRunGate = async (schedule: PromptSchedule, due_at: number): Promise<'run' | 'skip'> => {
    if (schedule.managed_by !== 'agenda') return 'run';
    if (stopped || !access || !deps.isVaultUnlocked()) return 'run';
    if (streamsActive()) {
      // D-340 slice 2 — a stream's suggestions: its own run for the time they fall due, and what its
      // Agenda lists. The weekly stream's schedule is its own; every other is the daily one's.
      const kind: SituationStreamKind = weeklySuggestions.owns(schedule.schedule_id) ? 'weekly' : 'daily';
      const stream = streamSettings(kind);
      if (!stream.enabled || !stream.agenda) return 'skip';
      // D-340 slice 4 — they are for the stream run they start ahead of.
      const run = streamRunAhead(kind, due_at);
      if (!run) return 'skip';
      const settled = (deps.db.prepare('SELECT state FROM scheduled_situation_runs WHERE id=?').get(run.id) as { state: string } | undefined)?.state;
      if (settled === 'sent' || settled === 'uncertain') return 'run';
      if (settled === 'skipped' || settled === 'superseded') return 'skip';
      return (await agendaLines(run.from, run.end, access.context(ownerSource, null))).lines.length > 0 ? 'run' : 'skip';
    }
    const agenda = agendaSettings();
    if (!agenda.enabled) return 'skip';
    const zone = deps.timeZone(); const { late } = dueTime(agenda);
    // A time quiet hours carry past midnight goes the morning after, as the Agenda's tick has it.
    const day = assetDateAt(due_at, zone); const run = agendaRun(late ? shiftDays(day, 1) : day, late, zone);
    if (!run) return 'skip';
    const settled = (deps.db.prepare('SELECT state FROM scheduled_situation_runs WHERE id=?').get(run.id) as { state: string } | undefined)?.state;
    if (settled === 'sent' || settled === 'uncertain') return 'run';
    if (settled === 'skipped' || settled === 'superseded') return 'skip';
    return (await agendaLines(run.from, run.end, access.context(ownerSource, null))).lines.length > 0 ? 'run' : 'skip';
  };
  /** D-338 — the suggestions' schedule follows what it should be on the Agenda's own clock, with no
   *  save: a request a Recued update reworded, a server zone that moved. Its failure holds neither
   *  run; it is counted once a day (`agenda_suggestions.refresh_failed`) and tried again next tick. */
  const refreshSuggestions = async (): Promise<void> => {
    if (stopped || !deps.isVaultUnlocked()) return;
    try {
      // D-340 slice 2 — once the streams take over, each stream's suggestions follow that stream.
      if (!streamsActive()) await agendaSuggestions.refresh(agendaSettings());
      else for (const kind of ['daily', 'weekly'] as const) await streamSuggestions[kind].refresh(asAgenda(kind, streamSettings(kind)));
    } catch {
      deps.store.measure('agenda_suggestions.refresh_failed', 1, {}, now(), `agenda-suggestions-refresh-failed:${assetDateAt(now(), deps.timeZone())}`);
    }
  };
  type TickKind = 'tick' | 'digest' | 'agenda' | 'close_day' | 'stream_daily' | 'stream_weekly';
  const tickOnce = async (kind: TickKind): Promise<void> => {
    if (kind === 'tick') await refreshSuggestions();
    // Each feature runs on its own: a Digest that fails does not hold the day's Agenda, nor either
    // the evening notice. A Send now runs its own feature only. D-340 slice 2: once the streams take
    // over, they send in place of the Digest and the Agenda.
    try {
      if (streamsActive()) {
        try { if (kind === 'tick' || kind === 'stream_daily') await streamTick('daily', kind === 'stream_daily'); }
        finally { if (kind === 'tick' || kind === 'stream_weekly') await streamTick('weekly', kind === 'stream_weekly'); }
      } else {
        try { if (kind === 'tick' || kind === 'digest') await digestTick(kind === 'digest'); }
        finally { if (kind === 'tick' || kind === 'agenda') await agendaTick(kind === 'agenda'); }
      }
    } finally { if (kind === 'tick' || kind === 'close_day') await closeDayTick(kind === 'close_day'); }
  };
  /** Retention: an overview run or attempt older than `before` goes, except a run
   * still to retry, the last run and the last sent one that Settings shows (the Digest's
   * and the Agenda's each), and an uncertain run no later send of its own feature has
   * followed. A cluster still new that the overview
   * has not listed since `before` goes: if it comes back it is new again. What the
   * overview kept about a situation that is gone goes with it. */
  const prune = (before: number): { overview_runs: number; overview_attempts: number; overview_clusters: number; overview_cached: number } => {
    if (!Number.isSafeInteger(before)) throw new Error('Invalid overview retention');
    return deps.db.transaction(() => ({
      overview_clusters: deps.store.dropNew((deps.db.prepare(`SELECT s.id FROM situations s LEFT JOIN scheduled_situation_listed l ON l.id=s.id
        WHERE s.id LIKE 'situation-%' AND COALESCE(l.at,s.updated_at)<?`).all(before) as { id: string }[]).map(row => row.id)),
      overview_attempts: deps.db.prepare('DELETE FROM scheduled_situation_attempts WHERE at<?').run(before).changes,
      overview_runs: deps.db.prepare(`DELETE FROM scheduled_situation_runs WHERE at<? AND state NOT IN ('pending','sending')
        ${(['digest', 'agenda', 'close_day', 'stream', 'stream_week'] as const).map(feature => `
        AND rowid NOT IN (SELECT rowid FROM scheduled_situation_runs WHERE ${runsOf(feature)} ORDER BY at DESC,rowid DESC LIMIT 1)
        AND rowid NOT IN (SELECT rowid FROM scheduled_situation_runs WHERE ${runsOf(feature)} AND state='sent' ORDER BY at DESC,rowid DESC LIMIT 1)`).join('')}
        AND NOT (state='uncertain' AND NOT EXISTS (SELECT 1 FROM scheduled_situation_runs later WHERE later.state='sent' AND later.at>scheduled_situation_runs.at
          AND ${featureOf('later.mode')} = ${featureOf('scheduled_situation_runs.mode')}))`).run(before).changes,
      overview_cached: deps.db.prepare('DELETE FROM scheduled_situation_seen WHERE id NOT IN (SELECT id FROM situations)').run().changes
        + deps.db.prepare('DELETE FROM scheduled_situation_summaries WHERE id NOT IN (SELECT id FROM situations)').run().changes
        + deps.db.prepare('DELETE FROM scheduled_situation_listed WHERE id NOT IN (SELECT id FROM situations)').run().changes,
    }))();
  };
  const run = (kind: TickKind = 'tick'): Promise<void> => {
    if (active) return active as Promise<void>;
    const pending = tickOnce(kind); active = pending;
    void pending.finally(() => { if (active === pending) active = undefined; }).catch(() => {}); return pending;
  };
  /** ⛔ A STOP DOES NOT WAIT FOR THE SEND. A run reads the window twice, may
   *  ask a model for each group's summary and then sends through every channel
   *  (30 s a messenger, 30 to 120 s an email), and a drain step has 5 s while
   *  the process exits right after the drain anyway. Nothing is lost by it:
   *  `stopped` sends nothing more and starts no model call, and a run is marked
   *  `sending` with its attempt counted BEFORE its send, so a send cut short is
   *  found as `sending` by the first tick after the restart and repeated once,
   *  saying so ("Repeating once because the previous delivery could not be
   *  confirmed."), or shown as uncertain in Settings after a second try. A run
   *  stopped before its send marked nothing, and is built again then. */
  const stops = new AbortController();
  /** The tick, settled no later than `STOP_GRACE_MS` after `stop`: the
   *  interval that runs it waits for what it returns, inside the same drain
   *  step as `stop`. The run itself goes on. */
  const tick = (): Promise<void> => {
    // Stopped: no new run, and the one in progress is `stop`'s to wait for.
    if (stopped) return Promise.resolve();
    return releasedAtStop(run(), stops.signal, undefined);
  };
  return { bindAccess(value: SituationAccess) { access = value; }, today, status, settings, setSettings, agendaStatus, agendaSettings, setAgenda, prune, tick,
    // D-338 — the rule the Agenda and the digest hide a title by, lent to what a model reads.
    isPrivateItem: (item: SituationItem): boolean => privateItem(item),
    // D-340 slice 5 — whether the notice a reply quotes names private items: "Your day" and Close the
    // day by the daily stream's choice, "Your week" by the weekly one's.
    namesPrivateIn: (title: string): boolean => streamsActive() && (/^Your week · /u.test(title) ? streamSettings('weekly').include_private
      : /^(?:Your day|Close the day) · /u.test(title) && streamSettings('daily').include_private),
    // D-342 §5 — the suggestions' own run reads the owner's active pursuits beside the day: the
    // Agenda's, or either stream's once the streams take over.
    readsPursuits: (source: Parameters<typeof agendaSuggestions.isOwnRun>[0]): boolean =>
      agendaSuggestions.isOwnRun(source) || weeklySuggestions.isOwnRun(source),
    // D-338 slice 3 — after a save: the suggestions' schedule follows the Agenda's settings.
    syncAgendaSuggestions: () => agendaSuggestions.sync(agendaSettings()),
    // The done notices of either stream's suggestions wait on that stream's own run.
    agendaDoneGate: ((schedule, occurrence) => (weeklySuggestions.owns(schedule.schedule_id) ? weeklySuggestions : agendaSuggestions)
      .doneGate(schedule, occurrence)) as typeof agendaSuggestions.doneGate,
    agendaRunGate,
    // D-340 slice 2 — the streams: taking over from the Agenda and Coming up (once, at start), their
    // settings, status, preview and Send now, and their suggestions kept in step after a save.
    streamsActive, takeOverStreams, streamSettings, setStream, streamStatus, streamPreview, holdsReminders,
    // D-340 slice 4 — the suggestions inside the stream: what reads their answers, Today's copy of them,
    // and their run's own tool rounds (ruling 9).
    bindSuggestionAnswers: (reader: NonNullable<typeof answers>) => { answers = reader; }, todaySuggestions,
    suggestionsToolRounds: (source: Parameters<typeof agendaSuggestions.isOwnRun>[0]): number | undefined =>
      agendaSuggestions.isOwnRun(source) || weeklySuggestions.isOwnRun(source) ? SUGGESTIONS_TOOL_ROUNDS : undefined,
    sendStreamNow: (kind: SituationStreamKind) => run(kind === 'weekly' ? 'stream_weekly' : 'stream_daily'),
    syncStreamSuggestions: (kind: SituationStreamKind) => streamSuggestions[kind].sync(asAgenda(kind, streamSettings(kind))),
    // D-343 slice 4 — Close the day: its settings, status and Send now, the notice for today that
    // Today's "Close the day" opens (owner's own read), and the pursuits asked about in the evening.
    closeDaySettings, setCloseDay, closeDayStatus, sendCloseDayNow: () => run('close_day'),
    closeDayNoticeToday: async (): Promise<{ title: string; text: string }> => {
      if (!access || !deps.isVaultUnlocked()) throw new Error('Unlock Recued to close the day');
      const { title, text } = await closeDayNotice(assetDateAt(now(), deps.timeZone()), access.context(ownerSource, null));
      return { title, text };
    },
    eveningPursuits,
    sendNow: () => run('digest'), sendAgendaNow: () => run('agenda'), async stop() {
      stopped = true; stops.abort();
      if (active) await settleWithin(active, STOP_GRACE_MS);
    } };
};
export type ScheduledSituations = ReturnType<typeof createScheduledSituations>;
