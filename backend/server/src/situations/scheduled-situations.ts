import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { recordFirstDigest } from './measures.js';
import { assetDateAt, calendarDayMs, shiftAssetDate, dueSpan, zonedWallClockToEpochMs,
  type ProactiveToday, type SituationCluster, type SituationDeliverySettings, type SituationDeliveryStatus, type SituationItem, type SituationResult } from '@recued/contracts';
import type { NotificationSendArgs } from '../notification-handler.js';
import type { SituationStore } from '../storage/situation-store.js';
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

export const DEFAULT_SITUATION_DELIVERY: SituationDeliverySettings = { frequency: 'weekly', weekday: 1, time: '08:00', day_of: true };
const ownerSource = { channel: 'chat', actor: 'user_self', user_id: 'owner', chat_session_id: 'scheduled-situations' } as const;
const uiContext: SituationReadContext = { owner: true, grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true } };
/** An asset's details and a trip's destination and days are read-time context,
 * not the situation: editing an attribute or a trip must not show a group again
 * as changed, and adding them to items must not make every saved group a new
 * revision. */
const CONTEXT_FIELDS: ReadonlySet<string> = new Set(['details', 'trip', 'context']);
const identity = (value: unknown): string => JSON.stringify(value, (key, field) => key === 'updated_at' || key === '__entity' || CONTEXT_FIELDS.has(key) ? undefined : field);
const withoutContext = (cluster: SituationCluster): SituationCluster =>
  ({ ...cluster, items: cluster.items.map(({ details: _details, trip: _trip, context: _context, ...item }) => item) });
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
const missedBy = (item: SituationItem, cluster: SituationCluster, named: (anchor: SituationItem) => string): string => {
  if (item.reasons.includes('last_time')) return ' · from last time';
  const value = item.when.value; const span = cluster.span; const verdict = item.when.verdict;
  if (!value || !span || (verdict !== 'near' && verdict !== 'outside')) return '';
  const opens = (other: SituationItem) => other !== item && Boolean(other.what.value) && other.when.value?.from === span.from;
  const anchor = cluster.items.find(other => opens(other) && ['booking', 'calendar', 'occasion'].includes(other.kind)) ?? cluster.items.find(opens);
  const side = value.from > span.to ? 'after' : value.to < span.from ? 'before' : null;
  return anchor && side ? ` · ${verdict === 'near' ? 'shortly' : 'well'} ${side} ${named(anchor)}` : '';
};
interface RunRow { id: string; mode: string; day: string; at: number; state: string; attempts: number; text: string; delivered_to: string }
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
  const named = (item: SituationItem): string => privateItem(item) ? 'a private reminder' : `“${item.what.value}”`;
  const dayOfAllowed =(cluster: SituationCluster): boolean => shouldSendDayOfCluster(cluster,
    id => deps.work.readCommitment(id)?.derivation === 'rule_emitted');
  deps.db.exec(`CREATE TABLE IF NOT EXISTS scheduled_situation_runs (
    id TEXT PRIMARY KEY, mode TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL DEFAULT '', delivered_to TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS scheduled_situation_seen (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, sent_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduled_situation_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, mode TEXT NOT NULL, outcome TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduled_situation_summaries (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, summary TEXT NOT NULL);`);
  // When the overview last listed each of its clusters. Only a trip's resolves, so
  // this is how retention tells a cluster that is over from one still shown. A
  // cluster from before the record began counts as listed then.
  const unrecorded = !deps.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduled_situation_listed'").get();
  deps.db.exec('CREATE TABLE IF NOT EXISTS scheduled_situation_listed (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
  if (unrecorded) deps.db.prepare("INSERT OR IGNORE INTO scheduled_situation_listed(id,at) SELECT id,? FROM situations WHERE id LIKE 'situation-%'").run(now());
  const listed = deps.db.prepare('INSERT INTO scheduled_situation_listed(id,at) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at');
  const settings = (): SituationDeliverySettings => ({ ...DEFAULT_SITUATION_DELIVERY,
    ...deps.store.readSetting<Partial<SituationDeliverySettings>>('situations.delivery', {}),
    frequency: deps.store.readSetting('digest.frequency', DEFAULT_SITUATION_DELIVERY.frequency) });
  const setSettings = (patch: Partial<SituationDeliverySettings>): void => {
    const next = { ...settings(), ...patch };
    if (!['daily', 'weekly', 'off'].includes(next.frequency) || !Number.isInteger(next.weekday) || next.weekday < 1 || next.weekday > 7
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(next.time) || typeof next.day_of !== 'boolean') throw new Error('Choose a valid overview schedule');
    deps.store.writeSetting('situations.delivery', next); deps.store.writeSetting('digest.frequency', next.frequency);
    deps.store.writeSetting('situations.schedule_changed_at', now());
  };
  const status = (): SituationDeliveryStatus => {
    const row = deps.db.prepare('SELECT * FROM scheduled_situation_runs ORDER BY at DESC,rowid DESC LIMIT 1').get() as RunRow | undefined;
    const sent = deps.db.prepare("SELECT * FROM scheduled_situation_runs WHERE state='sent' ORDER BY at DESC,rowid DESC LIMIT 1").get() as RunRow | undefined;
    const next = nextDigest();
    return { settings: settings(), last_run: row ? { at: row.at, mode: row.mode, state: row.state, text: row.text, delivered_to: JSON.parse(row.delivered_to) } : null,
      last_sent: sent ? { at: sent.at, mode: sent.mode, text: sent.text, delivered_to: JSON.parse(sent.delivered_to) } : null,
      pending: (deps.db.prepare("SELECT count(*) AS n FROM scheduled_situation_runs WHERE state IN ('pending','sending')").get() as { n: number }).n,
      uncertain: (deps.db.prepare("SELECT count(*) AS n FROM scheduled_situation_runs WHERE state='uncertain'").get() as { n: number }).n,
      ...(next === null ? {} : { next_at: next, time_zone: deps.timeZone() }) };
  };
  const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  // When the digest is due on a day, and whose run that is. Shared by the tick that sends
  // it and the status that says when it next goes, so the two cannot disagree.
  const dueTime = (config: SituationDeliverySettings): { due: string; late: boolean } => {
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
    const weekday = ((new Date(`${sendDay}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const weeklyDay = shiftAssetDate(sendDay, { amount: (weekday - config.weekday + 7) % 7, unit: 'days' }, -1);
    return weeklyDay >= changedDay ? `overview:${weeklyDay}` : null;
  };
  const changedDayIn = (zone: string): string => {
    const changedAt = deps.store.readSetting<number>('situations.schedule_changed_at', 0);
    return changedAt > 0 ? assetDateAt(changedAt, zone) : '0001-01-01';
  };
  /** §15.7 amendment — when the next digest goes, as `tickOnce` would send it: the first day
   *  from today whose run is not done yet, at its due time, or now when that has passed.
   *  Inside quiet hours it waits for their end that day, else for the next day's run. Null
   *  when the digest is off or nothing can send. */
  const nextDigest = (): number | null => {
    const config = settings();
    if (config.frequency === 'off' || stopped || !access || !deps.isVaultUnlocked()) return null;
    const at = now(); const zone = deps.timeZone(); const today = assetDateAt(at, zone);
    const { due, late } = dueTime(config); const changedDay = changedDayIn(zone);
    const done = deps.db.prepare("SELECT 1 FROM scheduled_situation_runs WHERE id=? AND state IN ('sent','skipped','uncertain')");
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    for (let offset = 0; offset <= 8; offset++) {
      const day = shiftAssetDate(today, { amount: offset, unit: 'days' });
      const run = overviewRun(config, day, late, changedDay); if (!run || done.get(run)) continue;
      const dueAt = zonedWallClockToEpochMs(`${day}T${due}`, zone); if (dueAt === null) return null;
      const from = Math.max(dueAt, at); if (!deps.isQuiet(from)) return from;
      const minute = clock.format(from); const set = Number(minute.slice(0, 2)) * 60 + Number(minute.slice(3, 5));
      const end = deps.quietEnd?.(set) ?? null;
      if (end !== null && end > set) return zonedWallClockToEpochMs(`${day}T${hhmm(end)}`, zone);
    }
    return null;
  };
  const collect = async (from: number, to: number, surface: 'today' | 'digest' | 'push', context: SituationReadContext): Promise<SituationResult> => {
    const opted = surface === 'digest' && deps.store.readSetting<string>('last_time.choice', 'unasked') === 'on';
    const readContext: SituationReadContext = { ...context, last_time_opted_in: opted,
      ...(surface === 'push' ? { projectClusterItems: items => selectDayOfClusterItems(items.filter(item => !dismissals.hides(item, now())
        && !(item.reasons.includes('missing') && item.when.value === null)), id => deps.work.readCommitment(id)?.derivation === 'rule_emitted') } : {}) };
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
  const tickOnce = async (manual = false): Promise<void> => {
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
      const previous = deps.db.prepare('SELECT * FROM scheduled_situation_runs WHERE id=?').get(id) as RunRow | undefined;
      if (previous && ['sent', 'skipped', 'uncertain'].includes(previous.state)) continue;
      const budget = (deps.db.prepare("SELECT count(*) AS n FROM scheduled_situation_attempts WHERE day=? AND mode!='manual'").get(day) as { n: number }).n;
      if (!manual && budget >= 2) continue;
      // An interrupted send is allowed one clearly marked repeat. Its second
      // uncertainty remains visible in Settings until the owner sends again.
      if (previous?.state === 'sending' && previous.attempts >= 2) {
        deps.db.prepare("UPDATE scheduled_situation_runs SET state='uncertain' WHERE id=?").run(id); continue;
      }
      const context = access.context(ownerSource, null);
      const from = dueSpan(calendarDayMs(day)!, zone).start;
      const endDay = mode === 'day_of' ? shiftAssetDate(day, { amount: 1, unit: 'days' }) : shiftAssetDate(day, { amount: 7, unit: 'days' });
      const to = dueSpan(calendarDayMs(endDay)!, zone).start - 1;
      const result = await collect(from, to, mode === 'day_of' ? 'push' : 'digest', context);
      // Scheduled pushes leave questions in Yours; clock asks remain the
      // occurrence service's responsibility, outside every inference budget.
      result.clusters = result.clusters.flatMap(cluster => {
        const items = cluster.items.filter(item => !(item.reasons.includes('missing') && item.when.value === null));
        return items.length ? [{ ...cluster, items }] : [];
      });
      for (const cluster of result.clusters) {
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
      walk: for (let cursor = 'situation-'; ;) {
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
      // busy week cannot hide a resolution beyond an arbitrary first page.
      while (resolved.length < 5) {
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
      if (mode !== 'day_of') deps.retainCited?.(shown);
      if (!shown.length && !resolved.length) {
        deps.store.writeSetting('situations.last_sent_revision', handledRevision);
        deps.db.prepare("INSERT INTO scheduled_situation_runs(id,mode,day,at,state) VALUES(?,?,?,?,'skipped') ON CONFLICT(id) DO UPDATE SET state='skipped',at=excluded.at,day=excluded.day")
          .run(id, mode, day, at); continue;
      }
      const lines: string[] = [];
      if (previous?.state === 'sending') lines.push('Repeating once because the previous delivery could not be confirmed.');
      for (const cluster of shown) {
        if (deps.memoryAllowed?.(cluster) === false) continue;
        let summary: string | undefined;
        const fingerprint = contentKey(cluster);
        const cached = deps.db.prepare('SELECT fingerprint,summary FROM scheduled_situation_summaries WHERE id=?').get(cluster.id) as { fingerprint: string; summary: string } | undefined;
        if (cached?.fingerprint === fingerprint) summary = cached.summary;
        else if (deps.summarize) {
          const currentContext = access.context(ownerSource, null);
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
        if (summary && !cluster.items.some(item => privateItem(item))) lines.push(summary);
        for (const item of cluster.items) lines.push(privateItem(item) ? 'Private reminder · open Today for the details'
          : `${item.what.value} · ${item.when_day ?? (item.when.value ? assetDateAt(item.when.value.from, zone) : 'date unknown')}${missedBy(item, cluster, named)}${item.basis === 'inferred' ? ' · Recued’s guess' : ''}`);
      }
      for (const revision of resolved) {
        const first = revision.after.cluster.items[0];
        lines.push(`Resolved · ${first && privateItem(first, true) ? 'a private reminder' : first?.what.value ?? 'Situation'}`);
      }
      const open = result.omitted + result.clusters.filter(cluster => !shown.includes(cluster)).reduce((sum, cluster) => sum + cluster.items.length, 0);
      if (open) lines.push(`Still open: ${open} more items. Open Today for the rest.`);
      if (result.partial?.length) lines.push(`Not fully checked: ${result.partial.map(collection => `${collection.replaceAll('_', ' ')}s`).join(', ')}. There were more than one read can hold, so some may be missing.`);
      const mailShown = context.grants.isVerbOpGranted('core.mail.get') && context.grants.isCollectionReadGranted('mail');
      if (mailShown) {
        for (const mailbox of deps.mailHealth?.() ?? []) lines.push(`${mailbox.name}: ${mailbox.last_success_at > 0 ? `last successful mail sync ${assetDateAt(mailbox.last_success_at, zone)} ${clock.format(mailbox.last_success_at)}` : 'mail has not synced yet'}${mailbox.needs_attention ? ' · needs attention' : ''}`);
      }
      const text = lines.join('\n').slice(0, 12_000);
      // The source and sphere grants may change during an optional model call.
      // Re-read before I/O; never release a stale wider payload.
      const fresh = await collect(from, to, mode === 'day_of' ? 'push' : 'digest', access.context(ownerSource, null));
      fresh.clusters = fresh.clusters.flatMap(cluster => {
        const items = cluster.items.filter(item => !(item.reasons.includes('missing') && item.when.value === null));
        return items.length ? [{ ...cluster, items }] : [];
      });
      const finalContext = access.context(ownerSource, null);
      if (identity(fresh) !== identity(result)
        || (mode === 'day_of' && shown.some(cluster => !dayOfAllowed(cluster)))
        || (mailShown && (!finalContext.grants.isVerbOpGranted('core.mail.get') || !finalContext.grants.isCollectionReadGranted('mail')))
        || resolved.some(revision => !wholeSituationSnapshotAllowed(revision.after, finalContext.grants, finalContext) || deps.memoryAllowed?.(revision.after.cluster) === false)) continue;
      if (stopped || !deps.isVaultUnlocked() || (!manual && deps.isQuiet(now()))) return;
      const sendAt = now(); const sendDay = assetDateAt(sendAt, zone);
      const attempt = deps.db.transaction(() => {
        const used = (deps.db.prepare("SELECT count(*) AS n FROM scheduled_situation_attempts WHERE day=? AND mode!='manual'").get(sendDay) as { n: number }).n;
        if (!manual && used >= 2) return null;
        deps.db.prepare("INSERT INTO scheduled_situation_runs(id,mode,day,at,state,text,attempts) VALUES(?,?,?,?,'sending',?,1) ON CONFLICT(id) DO UPDATE SET state='sending',text=excluded.text,attempts=attempts+1,at=excluded.at,day=excluded.day")
          .run(id, mode, sendDay, sendAt, text);
        return Number(deps.db.prepare("INSERT INTO scheduled_situation_attempts(run_id,day,at,mode,outcome) VALUES(?,?,?,?,'sending')").run(id, sendDay, sendAt, mode).lastInsertRowid);
      })();
      if (attempt === null) continue;
      let delivered: readonly string[] = [];
      try { delivered = (await deps.send({ title: mode === 'day_of' ? 'Today' : 'Coming up', text, ui_link_url: '#today' })).delivered_to; }
      catch { deps.db.prepare("UPDATE scheduled_situation_attempts SET outcome='uncertain' WHERE id=?").run(attempt); continue; }
      if (!delivered.length) {
        deps.db.prepare("UPDATE scheduled_situation_attempts SET outcome='not_delivered' WHERE id=?").run(attempt);
        deps.db.prepare("UPDATE scheduled_situation_runs SET state='pending' WHERE id=?").run(id); continue;
      }
      deps.db.transaction(() => {
        deps.db.prepare("UPDATE scheduled_situation_attempts SET outcome='delivered' WHERE id=?").run(attempt);
        deps.db.prepare("UPDATE scheduled_situation_runs SET state='sent',delivered_to=? WHERE id=?").run(JSON.stringify(delivered), id);
        for (const cluster of shown) deps.db.prepare('INSERT INTO scheduled_situation_seen(id,fingerprint,sent_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,sent_at=excluded.sent_at')
          .run(cluster.id, hash(identity(cluster)), sendAt);
        deps.store.writeSetting('situations.last_sent_at', sendAt);
        deps.store.writeSetting('situations.last_sent_revision', handledRevision);
        deps.store.measure('scheduled.push', 1, { mode, clusters: shown.length }, sendAt, id);
        if (mode !== 'manual') recordFirstDigest(deps.store, shown, sendAt);
      })();
    }
  };
  /** Retention: an overview run or attempt older than `before` goes, except a run
   * still to retry, the last run and the last sent one that Settings shows, and an
   * uncertain run no later send has followed. A cluster still new that the overview
   * has not listed since `before` goes: if it comes back it is new again. What the
   * overview kept about a situation that is gone goes with it. */
  const prune = (before: number): { overview_runs: number; overview_attempts: number; overview_clusters: number; overview_cached: number } => {
    if (!Number.isSafeInteger(before)) throw new Error('Invalid overview retention');
    return deps.db.transaction(() => ({
      overview_clusters: deps.store.dropNew((deps.db.prepare(`SELECT s.id FROM situations s LEFT JOIN scheduled_situation_listed l ON l.id=s.id
        WHERE s.id LIKE 'situation-%' AND COALESCE(l.at,s.updated_at)<?`).all(before) as { id: string }[]).map(row => row.id)),
      overview_attempts: deps.db.prepare('DELETE FROM scheduled_situation_attempts WHERE at<?').run(before).changes,
      overview_runs: deps.db.prepare(`DELETE FROM scheduled_situation_runs WHERE at<? AND state NOT IN ('pending','sending')
        AND rowid NOT IN (SELECT rowid FROM scheduled_situation_runs ORDER BY at DESC,rowid DESC LIMIT 1)
        AND rowid NOT IN (SELECT rowid FROM scheduled_situation_runs WHERE state='sent' ORDER BY at DESC,rowid DESC LIMIT 1)
        AND NOT (state='uncertain' AND NOT EXISTS (SELECT 1 FROM scheduled_situation_runs later WHERE later.state='sent' AND later.at>scheduled_situation_runs.at))`).run(before).changes,
      overview_cached: deps.db.prepare('DELETE FROM scheduled_situation_seen WHERE id NOT IN (SELECT id FROM situations)').run().changes
        + deps.db.prepare('DELETE FROM scheduled_situation_summaries WHERE id NOT IN (SELECT id FROM situations)').run().changes
        + deps.db.prepare('DELETE FROM scheduled_situation_listed WHERE id NOT IN (SELECT id FROM situations)').run().changes,
    }))();
  };
  const run = (manual = false): Promise<void> => {
    if (active) return active as Promise<void>;
    const pending = tickOnce(manual); active = pending;
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
  return { bindAccess(value: SituationAccess) { access = value; }, today, status, settings, setSettings, prune, tick,
    sendNow: () => run(true), async stop() {
      stopped = true; stops.abort();
      if (active) await settleWithin(active, STOP_GRACE_MS);
    } };
};
export type ScheduledSituations = ReturnType<typeof createScheduledSituations>;
