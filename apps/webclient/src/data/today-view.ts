/** A read-time projection of existing records; Today owns no stored entities. */
import type {
  CollectionInstanceRow, CollectionSourceFreshness, SourceRegistration,
  WorkEntity, WorkEntityListRpcRequest, WorkEntitySourceFreshness,
  ProactiveToday, SituationBasis, SituationCluster, SituationItem, SituationReason, SituationRef, SituationWindow, Sphere,
} from '@recued/contracts';
import { isDateOnlyDue, resolveTaskListFilter, mailFollowUpTaskRef, type MailFollowUpTaskRef } from '@recued/contracts';
import { taskReplyWatchSlot } from '../mail/task-reply-watch.js';
import { e, renderActionLabel, renderTaskDueActions, renderTaskBlockers, TASK_DUE_STYLES } from '@recued/ui-shared';
import { serializeShellRoute, serializeSourceRecordAddress } from '../shell/route.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { situationRefHref } from './situation-ref-href.js';
import type { BootstrapDataRouteOptions } from './bootstrap-data-route.js';

type TodayKind = 'task' | 'commitment' | 'calendar' | 'situation';
/** `holds` (D-340 §4): states, shown at the top of Today while they hold. */
type TodayGroup = 'holds' | 'overdue' | 'today' | 'next' | 'coming_up';
interface Freshness { label: string; detail: string; warning: boolean }
export interface TodaySource {
  key: string;
  label: string;
  kind: TodayKind;
  freshness: Freshness;
  writeCapable?: boolean;
}
export interface TodayItem {
  ref?: SituationRef;
  sphere?: Sphere;
  sphereReason?: string;
  key: string;
  title: string;
  when: number;
  group: TodayGroup;
  kind: TodayKind;
  sourceKey: string;
  href: string;
  allDay?: boolean;
  ongoing?: boolean;
  direction?: string;
  unreachable?: boolean;
  taskId?: string;
  taskRef?: MailFollowUpTaskRef;
  taskDependencyIds?: readonly string[];
  taskDependenciesUncertain?: boolean;
  commitmentId?: string;
  /** D-325 §15.7 (2026-10-24) — the occurrence of a renewal: Done acknowledges it. */
  renewalOccurrenceId?: string;
  cluster?: SituationCluster;
  dateUnknown?: boolean;
  /** D-340 §4 — when a state stops holding; absent for one that holds until cleared. */
  until?: number;
}
export interface TodayTaskEdit {
  key: string;
  id: string;
  title: string;
  action: 'complete' | 'reschedule';
  value: string;
  /** The task was due on a whole DAY (`due-day.ts`). Picking another day at
   *  midnight keeps it a whole day. */
  allDay?: boolean;
  busy: boolean;
  error: string | null;
  /** Exact shortcut result; do not round its seconds through the minute input. */
  dueOverride?: number;
  clearDue?: boolean;
}
export interface TodayTaskActions {
  canComplete: boolean;
  canReschedule: boolean;
  edit: TodayTaskEdit | null;
  notice: string | null;
  canCloseCommitment?: boolean;
  commitmentBusy?: boolean;
  error?: string | null;
  /** §15.4 — the coded answers on what Recued put in a cluster. */
  canDismissSituation?: boolean;
  /** The last dismissal, which the notice offers to undo. */
  undoDismissal?: string | null;
  /** D-407 slice 2 — what the owner typed in "When is the next one?", by occasion id: Today repaints each minute
   *  and on every broadcast, and a box drawn empty again would lose it. */
  occasionDrafts?: ReadonlyMap<string, { on: string; time: string }>;
  /** D-407 slice 2 — the shell can send the answer. Without it the section is not drawn. */
  canAnswerOccasionNext?: boolean;
  /** D-343 slice 4 — "Close the day" opens the conversation for today's evening notice. */
  canCloseDay?: boolean;
  closingDay?: boolean;
  /** D-340 slice 2 (§3.7) — "Daily stream" opens the streams' settings over Today. */
  canOpenStream?: boolean;
}
/** D-343 slice 4 — Today's "Close the day" action. */
export const TODAY_CLOSE_DAY_ACTION = 'today-close-day';
/** D-340 slice 2 — Today's "Daily stream" action. */
export const TODAY_STREAM_ACTION = 'today-stream';
export interface TodaySnapshot {
  now: number;
  tomorrow: number;
  before: number;
  items: TodayItem[];
  sources: TodaySource[];
  issues: string[];
  /** ⛔ FALSE WHILE READS ARE STILL OUTSTANDING, and every claim the view makes
   *  depends on it. A partial snapshot may not say "No overdue tasks" or
   *  "Nothing due in the next seven days" — those are statements about a
   *  FINISHED read, and on a first load they would be asserted about sources
   *  that have not answered yet. */
  complete: boolean;
  proactive?: ProactiveToday;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const kindLabel = { task: 'Task', commitment: 'Commitment', calendar: 'Calendar event', situation: 'On file' };
const unknownFreshness = (): Freshness => ({ label: 'Recued does not know how old this is', detail: 'This source did not say how old its information is.', warning: true });
const localFreshness = (): Freshness => ({ label: 'Local', detail: 'Kept in Recued itself, so there is nothing to bring in.', warning: false });
const validDate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15;
const dateLabel = (value: number): string => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const syncLabel = (last: number | null | undefined): string =>
  validDate(last) ? `Last brought in ${new Date(last).toLocaleString()}.` : 'Nothing has been brought in yet.';

// An all-day event is stored as days — the UTC midnight of its first day and of
// the day after its last — by every adapter, and the calendar dispatcher holds
// every write to it (`calendar-days.ts`). ⛔ This once translated Google and
// CalDAV only, on the belief that Outlook and the local calendar carried
// instants: Outlook's all-day event showed a day early west of UTC and dropped
// out of Today once UTC midnight passed.
const localDayAsUtc = (value: number): number => {
  const date = new Date(value);
  const utc = new Date(0);
  utc.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  utc.setUTCHours(0, 0, 0, 0);
  return utc.getTime();
};
const utcDayAsLocal = (value: number): number => {
  const date = new Date(value);
  const local = new Date(0);
  local.setFullYear(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  local.setHours(0, 0, 0, 0);
  return local.getTime();
};

const workFreshness = (fresh: WorkEntitySourceFreshness | undefined, source: SourceRegistration | undefined, now: number): Freshness => {
  if (source?.sync_posture === 'read_through' || fresh?.state === 'read_through') return {
    label: 'Not included', detail: 'Recued reads this source only when you ask, so it has nothing saved for Today.', warning: true,
  };
  if (fresh === undefined) return source?.source_kind === 'builtin' ? localFreshness() : unknownFreshness();
  const state = fresh.state === 'fresh' && validDate(fresh.last_success_at)
    && fresh.stale_after_ms !== undefined && now - fresh.last_success_at > fresh.stale_after_ms
    ? 'stale' : fresh.state;
  const label = {
    local: 'Local', read_through: 'Read from source', fresh: 'Synced', stale: 'Out of date',
    degraded: 'Something went wrong', never_synced: 'Never brought in',
  }[state];
  return {
    label: fresh.list_complete === false ? `${label} · Partial sync` : label,
    detail: state === 'local' ? localFreshness().detail : syncLabel(fresh.last_success_at),
    warning: fresh.list_complete === false || state === 'stale' || state === 'degraded' || state === 'never_synced',
  };
};
const calendarFreshness = (fresh: CollectionSourceFreshness | undefined, instance: CollectionInstanceRow): Freshness => {
  if (instance.adapter_type === 'local') return localFreshness();
  if (fresh === undefined) return unknownFreshness();
  const label = fresh.degraded ? 'Something went wrong' : fresh.pending > 0 ? 'Catching up'
    : fresh.last_success_at === null ? 'Never brought in' : fresh.stale ? 'Out of date' : 'Synced';
  return { label, detail: syncLabel(fresh.last_success_at), warning: fresh.stale || fresh.degraded || fresh.pending > 0 || fresh.last_success_at === null };
};

/** Resolve once per read, including across DST; the seven-day task window includes today. */
export const todayWindow = (now: number): Pick<TodaySnapshot, 'now' | 'tomorrow' | 'before'> => {
  const today = resolveTaskListFilter({ completion: 'open', due: 'today', sort: 'due_asc' }, now);
  const week = resolveTaskListFilter({ completion: 'open', due: 'next_7_days', sort: 'due_asc' }, now);
  if (today.due.kind !== 'range' || week.due.kind !== 'range') throw new Error('Expected whole days');
  return { now, tomorrow: today.due.before, before: week.due.before };
};

const workItem = (entity: WorkEntity, window: ReturnType<typeof todayWindow>): TodayItem | null => {
  if (entity.deleted_at != null || (entity.sync_state !== 'live' && entity.sync_state !== 'stale_unreachable')) return null;
  if (entity._kind !== 'task' && entity._kind !== 'commitment') return null;
  if (entity._kind === 'task' ? entity.done : entity.lifecycle_state !== 'pending') return null;
  const due = entity._kind === 'task' ? entity.due_at : entity.promised_for_at;
  if (!validDate(due)) return null;
  // ⛔ A due at UTC midnight names a DAY (`due-day.ts`): it sits on that day
  // here, all day, and is overdue only once the day is over — not from the
  // previous evening, which is where its instant falls west of UTC.
  const allDay = isDateOnlyDue(due);
  const when = allDay ? utcDayAsLocal(due) : due;
  if (when >= window.before) return null;
  const todayStart = new Date(window.now);
  todayStart.setHours(0, 0, 0, 0);
  const overdue = allDay ? when < todayStart.getTime() : when < window.now;
  return {
    key: `${entity._kind}:${entity.id}`, title: entity._kind === 'task' ? entity.title : entity.statement,
    ref: { collection: entity._kind, id: entity.id },
    when, group: overdue ? 'overdue' : when < window.tomorrow ? 'today' : 'next',
    ...(allDay ? { allDay: true } : {}),
    kind: entity._kind, sourceKey: `work:${entity.source_id}`,
    href: serializeShellRoute('data', entity._kind, entity.id),
    ...(entity._kind === 'task' ? { taskId: entity.id, taskRef: mailFollowUpTaskRef(entity) ?? undefined } : {}),
    ...(entity._kind === 'task' && entity.blocks_task_ids.length ? { taskDependencyIds: entity.blocks_task_ids,
      taskDependenciesUncertain: entity.sync_state !== 'live' || entity.pending_write !== undefined } : {}),
    ...(entity._kind === 'commitment' ? { commitmentId: entity.id } : {}),
    ...(entity._kind === 'commitment' ? { direction: { outbound: 'You promised', inbound: 'Promised to you', internal: 'Personal commitment' }[entity.direction] } : {}),
    ...(entity.sync_state === 'stale_unreachable' ? { unreachable: true } : {}),
  };
};

/** Apply only a confirmed server response while the rest of Today refreshes. */
export const replaceTodayTask = (snapshot: TodaySnapshot, entity: Extract<WorkEntity, { _kind: 'task' }>): TodaySnapshot => {
  const item = workItem(entity, snapshot);
  const items = snapshot.items.filter(row => row.taskId !== entity.id);
  if (item) items.push(item);
  return { ...snapshot, items: items.sort((a, b) => a.when - b.when || a.key.localeCompare(b.key)) };
};

/** Read independently so a failed source cannot erase the other sources' results.
 * Limits are explicit and visible; every page reuses the same date window. */
export const loadToday = async (
  opts: Pick<BootstrapDataRouteOptions, 'spheres' | 'proactiveTodayCaller' | 'workEntitySourceListCaller' | 'workEntityListCaller' | 'collectionListInstancesCaller' | 'collectionListCaller'>,
  now: number,
  isCurrent: () => boolean = () => true,
  /** ⛔⛔ CALLED AS EACH READ SETTLES, because the four are independent and
   *  waiting for all of them hands back NOTHING while three have answered.
   *  Measured before this existed, with one calendar source unanswered and
   *  tasks + commitments already returned: 0 rows, 0 groups, a bare
   *  "Loading Today…". The same source ERRORING rendered 4 rows and an
   *  incomplete-notice — so the header's promise that "a failed source cannot
   *  erase the other sources' results" was true for a FAILURE and false for a
   *  DELAY, and D-267 put this view on the first screen of a fresh install. */
  onPartial?: (snapshot: TodaySnapshot) => void,
): Promise<TodaySnapshot> => {
  const span = todayWindow(now);
  const items: TodayItem[] = [];
  const issues: string[] = [];
  const calendarSources: TodaySource[] = [];
  let registrations: readonly SourceRegistration[] = [];
  let proactive: ProactiveToday | undefined;
  const workSources = new Map<string, { kind: 'task' | 'commitment'; fresh?: WorkEntitySourceFreshness }>();
  const fail = (scope: string, error: unknown): void => { issues.push(`${scope}: ${humanizeRpcError(error)}`); };
  /** One sorted, source-annotated view of whatever has arrived so far.
   *  ⚠ The calendar `TodaySource` objects are shared by REFERENCE, not copied:
   *  `readCalendar` keeps mutating their freshness as pages land, and a deep
   *  copy here would freeze the first page's staleness label forever. */
  const project = (complete: boolean): TodaySnapshot => {
    const sources: TodaySource[] = [...calendarSources];
    for (const source of registrations) {
      if ((source.top_tier_kind === 'task' || source.top_tier_kind === 'commitment') && !workSources.has(source.id)) {
        workSources.set(source.id, { kind: source.top_tier_kind });
      }
    }
    for (const [id, info] of workSources) {
      const registration = registrations.find((source) => source.id === id);
      sources.push({ key: `work:${id}`, kind: info.kind, label: registration?.source_label ?? id,
        writeCapable: registration?.top_tier_kind === info.kind && registration.write_capable === true
          && registration.sync_posture !== 'read_through',
        freshness: workFreshness(info.fresh, registration, now) });
    }
    const questionIds = new Set(proactive?.occurrences.filter(row => row.question).map(row => row.commitment.id));
    const projected = items.filter(item => !item.commitmentId || !questionIds.has(item.commitmentId)).map(item => ({ ...item }));
    for (const occurrence of proactive?.occurrences ?? []) {
      if (occurrence.question) continue;
      const existing = projected.find(item => item.commitmentId === occurrence.commitment.id);
      // D-325 §15.7 (2026-10-24) — an acknowledged renewal stays out of Today until its next reminder.
      if (occurrence.acknowledged) { if (existing) projected.splice(projected.indexOf(existing), 1); continue; }
      const longWindow = workItem({ ...occurrence.commitment, _kind: 'commitment' }, { ...span, before: 8.64e15 });
      const item = existing ?? (occurrence.reminders_started && longWindow && longWindow.when >= span.before
        ? { ...longWindow, group: 'coming_up' as const } : undefined);
      if (!item) continue;
      item.href = occurrence.subject_kind === 'occasion' ? serializeShellRoute('yours', 'occasions', 'occasion', occurrence.asset_id) : serializeShellRoute('yours', 'asset', occurrence.asset_id);
      if (!item.title.includes(occurrence.asset_name)) item.title += ` · ${occurrence.asset_name}`;
      if (occurrence.renewal) item.renewalOccurrenceId = occurrence.id;
      if (!existing) projected.push(item);
    }
    // D-340 §4 — a state goes to the top of Today on its own line, whatever cluster it came
    // in; the rest of its cluster is shown as before.
    const STATE_OPEN_END = 8.64e15;
    for (const cluster of proactive?.situations.clusters ?? []) for (const state of cluster.items.filter(item => item.kind === 'asset_state')) {
      const until = state.when.value?.to;
      projected.push({ key: `state:${state.ref.collection}:${state.ref.id}:${state.ref.field ?? ''}`, title: state.what.value ?? 'On file', ref: state.ref,
        when: state.when.value?.from ?? now, group: 'holds', kind: 'situation', sourceKey: 'situations', href: situationRefHref(state.ref),
        ...(until !== undefined && until < STATE_OPEN_END ? { until } : {}) });
    }
    for (const whole of proactive?.situations.clusters ?? []) {
      const rest = whole.items.filter(item => item.kind !== 'asset_state');
      if (!rest.length) continue;
      const cluster = rest.length === whole.items.length ? whole : { ...whole, items: rest };
      const calendar = cluster.items.find(item => item.ref.collection === 'calendar');
      const existing = calendar ? projected.find(item => item.key === `calendar:${calendar.ref.id}`)
        : projected.find(item => cluster.items.some(value => `${value.ref.collection}:${value.ref.id}` === item.key));
      if (existing) { existing.cluster = cluster; continue; }
      const anchor = cluster.items.find(item => item.when.value?.from === cluster.span?.from && ['calendar', 'booking', 'occasion', 'birthday'].includes(item.kind))
        ?? cluster.items.find(item => item.when.value?.from === cluster.span?.from) ?? cluster.items[0]!;
      const when = anchor.when_day ? utcDayAsLocal(Date.parse(anchor.when_day)) : cluster.span?.from ?? anchor.when.value?.from;
      projected.push({ key: `situation:${cluster.id}`, title: anchor.what.value ?? 'On file',
        ref: anchor.ref,
        when: when ?? now, group: when !== undefined && when >= span.tomorrow ? when >= span.before ? 'coming_up' : 'next' : 'today',
        kind: 'situation', sourceKey: 'situations', href: situationRefHref(anchor.ref), cluster,
        ...(anchor.when_day ? { allDay: true } : {}),
        ...(when === undefined ? { dateUnknown: true } : {}) });
    }
    if (projected.some(item => item.kind === 'situation')) sources.push({ key: 'situations', label: 'Connected records', kind: 'situation',
      freshness: { label: 'On file', detail: 'Values from the linked records; their sources may have newer information.', warning: false } });
    return { ...span, complete, ...(proactive ? { proactive } : {}),
      items: projected.sort((a, b) => a.when - b.when || a.key.localeCompare(b.key)),
      sources: sources.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key)),
      issues: [...issues, ...(proactive?.situations.partial?.length ? [`Too many ${proactive.situations.partial.map(collection => `${collection.replaceAll('_', ' ')}s`).join(', ')} to check in one read. Some may be missing.`] : [])].sort() };
  };
  const emit = (): void => { if (onPartial !== undefined && isCurrent()) onPartial(project(false)); };
  const readWork = async (kind: 'task' | 'commitment'): Promise<void> => {
    const label = kind === 'task' ? 'Tasks' : 'Commitments';
    if (opts.workEntityListCaller === undefined) { fail(label, new Error('Recued cannot reach your records.')); return; }
    const seen = new Set<string>();
    let offset = 0;
    let initialTotal: number | undefined;
    try {
      for (let page = 0; page < MAX_PAGES && isCurrent(); page++) {
        const args: WorkEntityListRpcRequest = { kind, limit: PAGE_SIZE, offset };
        if (kind === 'task') args.task_filter = {
          completion: 'open', sort: 'due_asc', due: { kind: 'range', from: -8.64e15, before: span.before },
        };
        const result = await opts.workEntityListCaller(args);
        if (!isCurrent()) return;
        initialTotal ??= result.total;
        for (const fresh of result.source_freshness ?? []) workSources.set(fresh.source_id, { kind, fresh });
        let added = 0;
        for (const entity of result.entities) {
          if (!workSources.has(entity.source_id)) workSources.set(entity.source_id, { kind });
          if (seen.has(entity.id)) continue;
          seen.add(entity.id);
          added++;
          const item = workItem(entity, span);
          if (item !== null && entity._kind === kind) items.push(item);
        }
        offset += result.entities.length;
        if (result.total !== initialTotal || added !== result.entities.length) {
          fail(label, new Error('The list changed while it was loading. Load it again to see the rest.'));
          return;
        }
        if (offset >= result.total) return;
        if (added === 0) { fail(label, new Error('The list changed while it was loading. Load it again to see the rest.')); return; }
      }
      if (isCurrent()) fail(label, new Error('Recued stopped after 100 pages. Open the full list to see more.'));
    } catch (error) { fail(label, error); }
  };
  const readCalendar = async (instance: CollectionInstanceRow): Promise<void> => {
    const source: TodaySource = { key: `calendar:${instance.slug}`, label: instance.slug, kind: 'calendar', freshness: unknownFreshness() };
    calendarSources.push(source);
    if (opts.collectionListCaller === undefined) { fail(instance.slug, new Error('Recued cannot reach your calendar.')); return; }
    const seen = new Set<string>();
    const windows = [
      { from: now, before: span.before, allDay: false },
      { from: localDayAsUtc(now), before: localDayAsUtc(span.before), allDay: true },
    ];
    let pages = 0;
    try {
      for (const window of windows) {
        let offset = 0;
        while (isCurrent()) {
          if (pages++ >= MAX_PAGES) { fail(instance.slug, new Error('Recued stopped after 100 pages. Open Calendar to see more.')); return; }
          const result = await opts.collectionListCaller({ platform: 'calendar', slug: instance.slug,
            calendar_window: { from: window.from, before: window.before }, limit: PAGE_SIZE, offset,
            filters: { is_all_day: window.allDay } });
          if (!isCurrent()) return;
          source.freshness = calendarFreshness(result.source_freshness, instance);
          let added = 0;
          for (const record of result.records) {
            if (seen.has(record.record_id)) continue;
            seen.add(record.record_id);
            added++;
            const fields = record.hot_fields;
            if (!validDate(fields.start_at) || !validDate(fields.end_at)) continue;
            const allDay = fields.is_all_day === true || fields.is_all_day === 1;
            const start = allDay ? utcDayAsLocal(fields.start_at) : fields.start_at;
            const end = allDay ? utcDayAsLocal(fields.end_at) : fields.end_at;
            if (end <= now || start >= span.before || fields.status === 'cancelled') continue;
            items.push({
              key: `${source.key}:${record.record_id}`, title: typeof fields.summary === 'string' && fields.summary.trim() ? fields.summary : 'Untitled event',
              ref: { collection: 'calendar', id: `${instance.slug}:${record.record_id}` },
              when: start, group: start < span.tomorrow ? 'today' : 'next', kind: 'calendar', sourceKey: source.key,
              href: serializeSourceRecordAddress({ tab: 'calendar', collectionSlug: instance.slug, recordId: record.record_id }),
              allDay,
              ongoing: start < now,
            });
          }
          offset += result.records.length;
          if (added !== result.records.length) { fail(instance.slug, new Error('Recued got stuck reading your calendar. Load it again to check this source.')); return; }
          if (result.records.length < PAGE_SIZE) break;
        }
      }
    } catch (error) { fail(instance.slug, error); }
  };
  const readCalendars = async (): Promise<void> => {
    if (opts.collectionListInstancesCaller === undefined) { fail('Calendars', new Error('Recued cannot reach your calendar sources.')); return; }
    try {
      const { instances } = await opts.collectionListInstancesCaller();
      const queue = instances.filter((instance) => instance.platform === 'calendar');
      // Bound simultaneous requests even for owners with many calendar accounts.
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length > 0 && isCurrent()) {
          const instance = queue.shift();
          if (instance !== undefined) await readCalendar(instance);
        }
      }));
    } catch (error) { fail('Calendars', error); }
  };
  const readSources = async (): Promise<void> => {
    try {
      if (opts.workEntitySourceListCaller === undefined) throw new Error('Recued cannot read the source names.');
      registrations = (await opts.workEntitySourceListCaller()).sources;
    } catch (error) { fail('Sources', error); }
  };
  const readProactive = async (): Promise<void> => {
    if (!opts.proactiveTodayCaller) return;
    try {
      const value = await opts.proactiveTodayCaller({ now, before: span.before });
      if (!isCurrent()) return;
      proactive = value;
      for (const row of value.occurrences) if (!workSources.has(row.commitment.source_id)) workSources.set(row.commitment.source_id, { kind: 'commitment' });
    // An older server has no Yours: Today leaves the section out rather than report it.
    } catch (error) { if (classifyRpcError(error).code !== 'unknown_method') fail('Yours and situations', error); }
  };
  // ⛔ `.then(emit)` per reader, NOT `await` in sequence: the four stay
  // concurrent (serialising them would make every load pay all four latencies)
  // and each paints the moment it lands. `readSources` emits too — it supplies
  // the source LABELS, so without it the first paint names sources by raw id.
  await Promise.all([
    readSources().then(emit),
    readWork('task').then(emit),
    readWork('commitment').then(emit),
    readCalendars().then(emit),
    ...(opts.proactiveTodayCaller ? [readProactive().then(emit)] : []),
  ]);
  const result = project(true);
  if (opts.spheres?.readMany) {
    const refs = [...new Map(result.items.flatMap(item => item.ref ? [[JSON.stringify([item.ref.collection, item.ref.id]), item.ref] as const] : [])).values()];
    const placements = new Map<string, { sphere?: Sphere; reason: string }>();
    try {
      for (let offset = 0; offset < refs.length && isCurrent(); offset += 500) for (const placement of await opts.spheres.readMany(refs.slice(offset, offset + 500)))
        placements.set(JSON.stringify([placement.ref.collection, placement.ref.id]), placement);
      result.items = result.items.map(item => { const placement = item.ref ? placements.get(JSON.stringify([item.ref.collection, item.ref.id])) : undefined;
        return placement ? { ...item, sphere: placement.sphere, sphereReason: placement.reason } : item; });
    } catch (error) { if (classifyRpcError(error).code !== 'unknown_method') result.issues.push('Sphere placements could not be read. Filters may be incomplete.'); }
  }
  return result;
};

/** Moved to `situation-ref-href.ts` (D-338 §11), where the toast and Settings reach it too. */
export { situationRefHref };
/** The four coded answers (§15.4) go on what Recued computed or inferred. A
 * record the owner keeps has its own actions (Done, Cancel), not these. */
export const SITUATION_DISMISSALS = [['not_now', 'Not now'], ['not_this_one', 'Not this one'], ['never_this_kind', 'Never this kind'], ['wrong', 'That’s wrong']] as const;
const renderDismissals = (cluster: SituationCluster, index: number, actionAttr: string, busy: boolean): string => {
  const title = cluster.items[index]!.what.value ?? 'this item';
  return `<div class="today-cluster-dismiss" role="group" aria-label="${e(`Answer: ${title}`)}">${SITUATION_DISMISSALS.map(([code, label]) =>
    `<button type="button" ${actionAttr}="today-situation-dismiss" data-today-dismiss-cluster="${e(cluster.id)}" data-today-dismiss-item="${index}" data-today-dismiss="${code}" aria-label="${e(`${label}: ${title}`)}"${busy ? ' disabled' : ''}>${label}</button>`).join('')}</div>`;
};
/** A link that opens a cluster item reports the open (Option A, §8). A situation row's own
 * link opens the item it was made from, so it reports that item too. */
const openAttrs = (actionAttr: string, cluster: SituationCluster, index: number): string =>
  ` ${actionAttr}="today-situation-open" data-today-open-cluster="${e(cluster.id)}" data-today-open-item="${index}"`;
const rowOpenAttrs = (item: TodayItem, actionAttr: string): string => {
  const ref = item.ref; const index = ref && item.cluster ? item.cluster.items.findIndex(value => value.ref.collection === ref.collection && value.ref.id === ref.id) : -1;
  return index < 0 ? '' : openAttrs(actionAttr, item.cluster!, index);
};
const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
/** Why an item is here and how Recued knows it (§6.2), in the owner's words. */
const REASON_WORDS: Record<SituationReason, string> = { due: 'due', collides: 'overlaps something else', related: 'connected to this', missing: 'something is missing', last_time: 'from last time',
  // Never on Today, which only looks forward; worded for whatever else shows an item.
  ended: 'already happened',
  // D-340 §4 — a state; Today lifts these to its top band, so this words any other view.
  holds: 'holds for now',
  // D-342 §5 — never on Today: only the Agenda suggestions' own read lists pursuits.
  pursuing: 'what you are working toward' };
const BASIS_WORDS: Record<SituationBasis, string> = { declared: 'From your records', derived: 'Worked out from your records', inferred: 'Recued’s guess' };
const reasonText = (item: SituationItem): string => {
  // Today reads each group again by its own items, so all of them are connected; the group says so.
  const reasons = item.reasons.length > 1 ? item.reasons.filter(reason => reason !== 'related') : item.reasons;
  return [capitalized(reasons.map(reason => (REASON_WORDS as Record<string, string>)[reason] ?? reason.replaceAll('_', ' ')).join(', ')),
    (BASIS_WORDS as Record<string, string>)[item.basis] ?? item.basis].filter(Boolean).join(' · ');
};
/** How an item misses its group's own time, place or people (§6.2). A fit needs no words,
 * and an unknown value says so itself. */
const whenFit = (item: SituationItem, span: SituationWindow | null): string => {
  const value = item.when.value; const verdict = item.when.verdict;
  // A last-time item is judged by its season, not by the gap.
  if (!value || !span || (verdict !== 'near' && verdict !== 'outside') || item.reasons.includes('last_time')) return '';
  const side = value.from > span.to ? 'after' : value.to < span.from ? 'before' : null;
  return side ? `${verdict === 'near' ? 'shortly' : 'well'} ${side} this` : '';
};
const WHERE_FIT: Partial<Record<string, string>> = { outside: 'not where this is' };
const WHO_FIT: Partial<Record<string, string>> = { near: 'some of the people in this', outside: 'none of the people in this' };
const fitted = (value: string, fit: string | undefined): string => fit ? `${value} · ${fit}` : value;
/** An item names people by id; a server older than the names map, or a contact since
 * removed, leaves one that is counted, never shown. An address is its own name. */
const peopleText = (ids: readonly string[], people: ReadonlyMap<string, string> | undefined): string => {
  const named = ids.flatMap(id => { const name = people?.get(id) ?? (id.includes('@') ? id : undefined); return name ? [name] : []; });
  const unnamed = ids.length - named.length;
  const rest = !unnamed ? [] : [people ? `${unnamed} ${unnamed === 1 ? 'person' : 'people'} no longer in your contacts` : unnamed === 1 ? 'a contact' : `${unnamed} contacts`];
  return named.length ? [...named, ...rest].join(', ') : capitalized(rest.join(', '));
};
/** A record an item rests on, as Data names it. */
const SOURCE_WORDS: Partial<Record<string, string>> = { calendar: 'Calendar event', mail: 'Email', mail_fact: 'Mail fact', memory: 'Memory note', history_trace: 'Retained evidence' };
const sourceLinks = (evidence: SituationItem['evidence']): string =>
  [...new Map(evidence.map(ref => [JSON.stringify([ref.collection, ref.id]), ref])).values()]
    .map(ref => `<a href="${e(situationRefHref(ref))}">${e(SOURCE_WORDS[ref.collection] ?? capitalized(ref.collection.replaceAll('_', ' ')))}</a>`).join(', ');
const renderCluster = (cluster: SituationCluster | undefined, summary?: string, answers?: { actionAttr: string; busy: boolean }, people?: ReadonlyMap<string, string>): string => !cluster ? '' : `${summary ? `<p class="today-cluster-summary" data-today-cluster-summary>${e(summary)}</p>` : ''}<ul class="today-cluster" data-today-cluster="${e(cluster.id)}">${cluster.items.map((item, index) =>
  `<li><a href="${e(situationRefHref(item.ref))}"${answers ? openAttrs(answers.actionAttr, cluster, index) : ''}>${e(item.what.value ?? 'Unknown')}</a>
    <span data-today-reasons>${e(reasonText(item))}</span>
    <dl><dt>When</dt><dd data-today-verdict="${e(item.when.verdict)}">${e(fitted(item.when_day ? new Date(item.when_day).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }) : item.when.value ? dateLabel(item.when.value.from) : 'No date', whenFit(item, cluster.span)))}</dd>
    <dt>Where</dt><dd data-today-verdict="${e(item.where.verdict)}">${e(item.where.value ? fitted(item.where.value.name, WHERE_FIT[item.where.verdict]) : 'Not recorded')}</dd>
    <dt>Who</dt><dd data-today-verdict="${e(item.who.verdict)}">${e(item.who.value?.length ? fitted(peopleText(item.who.value, people), WHO_FIT[item.who.verdict]) : 'Not recorded')}</dd></dl>
    ${item.evidence.length ? `<div>Sources: ${sourceLinks(item.evidence)}</div>` : ''}
    ${answers && item.basis !== 'declared' ? renderDismissals(cluster, index, answers.actionAttr, answers.busy) : ''}</li>`).join('')}
  ${cluster.omitted ? `<li>${cluster.omitted} more related items</li>` : ''}</ul>`;

export const TODAY_VIEW_STYLES = `
${TASK_DUE_STYLES}
.today-action { display:inline-flex; align-items:center; justify-content:center; gap:6px; }
.today-action > svg { flex-shrink:0; }
.today-view { max-width:960px; margin-top:var(--wc-space-lg, 24px); font-size:var(--wc-font-body, 14px); }
.today-reminder-summary h2 { font-size:16px; }
.today-reminder-summary > div { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px; }
.today-reminder-summary p { font-size:12px; }
.today-header { display:flex; justify-content:space-between; align-items:start; gap:16px; margin-bottom:12px; }
.today-header h2 { margin:0 0 8px; font-size:var(--wc-font-title, 28px); font-weight:600; line-height:1.15; letter-spacing:-.025em; }
.today-header-actions { display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
.today-suggestions { margin:12px 0 16px; padding:12px 16px; border:1px solid var(--border); border-radius:10px; background:var(--surface); }
.today-suggestions h3 { margin:0 0 6px; font-size:15px; }
.today-view .today-suggestions-text { margin:0 0 8px; color:var(--fg); white-space:pre-wrap; }
.today-view p { color:var(--muted); line-height:1.5; }
.today-header p { margin:0; }
.today-toolbar { display:flex; flex-wrap:wrap; align-items:start; justify-content:space-between; gap:8px 16px; margin:12px 0; }
.today-status-cluster { display:flex; flex-wrap:wrap; align-items:center; gap:4px 12px; }
.today-status-cluster p { margin:0; font-size:var(--wc-font-small,12px); }
.today-scope-controls { display:grid; grid-template-columns:minmax(0,10rem) minmax(0,1fr); align-items:end; gap:8px 16px; min-width:0; }
.today-scope-controls > label { display:grid; gap:4px; min-width:0; font-size:var(--wc-font-small,12px); }
.today-scope-controls select { min-width:0; width:100%; height:var(--wc-control-h,40px); }
.today-scope-controls .today-sources { min-width:0; margin:0; }
.today-scope-controls .today-sources summary { min-height:var(--wc-control-h,40px); align-content:center; }
@media(max-width:380px) { .today-scope-controls { grid-template-columns:minmax(0,1fr); width:100%; } }
.today-header p + p, .today-updated { font-size:var(--wc-font-small, 12px); }
.today-view > label { display:inline-flex; align-items:center; flex-wrap:wrap; gap:var(--wc-space-sm, 8px); font-size:var(--wc-font-small, 12px); }
.today-refresh { min-height:var(--wc-control-h, 38px); flex-shrink:0; padding:6px 12px; font:inherit; font-size:13px; color:var(--fg); background:var(--surface); border:1px solid var(--border); border-radius:var(--wc-radius, 9px); cursor:pointer; }
.today-refresh[aria-disabled="true"] { opacity:.6; cursor:wait; }
.today-sources { margin:var(--wc-space-md, 16px) 0; font-size:var(--wc-font-small, 12px); }
.today-sources summary { cursor:pointer; color:var(--fg-muted); }
.today-sources ul, .today-list { list-style:none; padding:0; }
.today-sources li { display:flex; flex-wrap:wrap; gap:8px; padding:5px 0; }
.today-group { margin-top:var(--wc-space-lg, 24px); border-top:1px solid var(--border); }
.today-group h3 { display:flex; gap:var(--wc-space-sm, 8px); align-items:center; font-size:15px; font-weight:600; margin:16px 0 8px; }
.today-count { font-size:var(--wc-font-small, 12px); font-weight:400; color:var(--fg-muted); font-variant-numeric:tabular-nums; }
.today-row { display:grid; grid-template-columns:145px minmax(0,1fr); gap:var(--wc-space-md, 16px); padding:16px 0; border-bottom:1px solid var(--border); }
.today-row time { font-size:13px; color:var(--muted); }
.today-row a { color:var(--fg); overflow-wrap:anywhere; text-decoration:none; }
.today-row a:hover { text-decoration:underline; }
.today-cluster { display:grid; gap:12px; margin-top:12px; padding-left:20px; font-size:13px; }
.today-cluster li > span { display:block; color:var(--muted); margin-top:4px; }
.today-cluster dl { display:grid; grid-template-columns:55px 1fr; gap:4px 10px; }
.today-cluster dt,.today-cluster dd { margin:0; }
.today-cluster-summary { margin:12px 0 0; font-weight:600; }
.today-cluster-dismiss { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
.today-cluster-dismiss button { min-height:44px; }
.today-meta { display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; margin-top:6px; font-size:12px; color:var(--muted); overflow-wrap:anywhere; }
.today-freshness { font-size:12px; padding:2px 6px; border:1px solid var(--border, #303642); border-radius:4px; }
.today-freshness[data-warning] { color:var(--fg); background:var(--warn-soft); font-weight:600; }
.today-notice { margin:12px 0; padding:10px 12px; border-left:3px solid var(--warn); background:var(--surface-sunk); }
.today-empty { display:grid; justify-items:start; gap:var(--wc-space-sm, 8px); margin:24px 0 4px; padding:16px 0; }
.today-empty-lead { margin:0; font-size:15px; color:var(--fg); }
.today-empty-sub { margin:0; font-size:13px; }
.today-empty-create { min-height:38px; padding:7px 14px; font:inherit; font-size:13px; font-weight:650; color:var(--on-accent); background:var(--accent); border:1px solid var(--accent); border-radius:8px; cursor:pointer; }
.today-commitment-actions, .today-task-actions, .today-task-editor, .today-occasion-next-fields { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:10px; min-width:0; }
.today-task-editor { border:1px solid var(--border); border-radius:8px; padding:12px; background:var(--surface-subtle, var(--surface)); border-inline-start:3px solid var(--accent); }
.today-task-editor p { flex-basis:100%; margin:0; overflow-wrap:anywhere; }
.today-task-editor .today-task-editor-title { color:var(--fg); font-weight:650; }
.today-task-editor .today-task-hint { font-size:12px; }
.today-occasion-next-fields { align-items:end; }
.today-task-editor label, .today-occasion-next-fields label { display:grid; gap:5px; min-width:0; max-width:100%; }
.today-commitment-actions button, .today-task-actions button, .today-task-editor button, .today-task-editor input, .today-occasion-next-fields button, .today-occasion-next-fields input { box-sizing:border-box; min-height:44px; max-width:100%; min-width:0; padding:7px 10px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--fg); font:inherit; font-size:13px; }
.today-commitment-actions button, .today-task-actions button, .today-task-editor button, .today-occasion-next-fields button { cursor:pointer; }
.today-task-editor .today-task-primary, .today-occasion-next-fields .today-task-primary { background:var(--accent); color:var(--on-accent); border-color:var(--accent); font-weight:600; }
.today-commitment-actions button[aria-disabled=true], .today-task-actions button[aria-disabled=true], .today-task-editor button[aria-disabled=true], .today-occasion-next-fields button[aria-disabled=true] { opacity:.6; cursor:default; }
.today-task-actions button:not([aria-disabled=true]):hover, .today-commitment-actions button:not([disabled]):hover { border-color:var(--accent); }
.today-task-actions > a { min-height:44px; display:inline-flex; align-items:center; padding:0 4px; font-size:13px; color:var(--accent); }
.today-task-actions > a[aria-disabled=true] { opacity:.6; }
@media(max-width:540px) { .today-task-actions > .task-due-actions { flex-basis:100%; } }
.today-view :focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
.today-view [data-today-task-notice] { border-inline-start:3px solid var(--accent); padding:10px 12px; background:var(--surface-subtle, var(--surface)); color:var(--fg); overflow-wrap:anywhere; }
.today-task-editor [role=alert] { color:var(--danger, var(--fg)); }
@media (max-width:540px) { .today-row { grid-template-columns:minmax(0,1fr); gap:6px; } }
/* A finger's height on a phone. ⛔ Refresh was 36px, and the Sources row only as tall as its text. */
@media (max-width:640px) { .today-refresh { min-height:44px; } .today-sources summary { box-sizing:border-box; min-height:44px; padding-block:12px; } }

/* Keep the stacked reading order and the same native fields across resizes. */
.today-layout, .today-priority, .today-later, .today-attention { display:contents; }
@media (min-width:1280px) and (hover:hover) and (pointer:fine) {
  .today-notice p { margin:0; }
  .today-notice p + p { margin-block-start:var(--wc-space-sm, 8px); }
  .today-layout:has(> .today-attention) {
    display:grid;
    /* Extra height from the side panels goes to the second row. */
    grid-template:
      "priority attention" auto
      "later    attention" 1fr / minmax(0, 2fr) minmax(19rem, 1fr);
    align-items:start;
    gap:0 var(--wc-space-lg, 24px);
    margin-block-start:var(--wc-space-md, 16px);
  }
  .today-layout:has(> .today-attention) > .today-priority { display:block; grid-area:priority; min-width:0; }
  .today-layout:has(> .today-attention) > .today-later { display:block; grid-area:later; min-width:0; }
  .today-layout:has(> .today-attention) > .today-priority > .today-group:first-child { margin-block-start:0; }
  .today-attention { display:grid; grid-area:attention; gap:var(--wc-space-md, 16px); min-width:0; }
  .today-attention > .today-reminders {
    margin:0;
    padding:var(--wc-space-md, 16px);
    border:1px solid var(--border);
    border-radius:var(--wc-radius-lg, 14px);
    background:var(--surface);
    overflow-wrap:anywhere;
  }
  .today-attention > .today-reminders > header {
    --wc-font-title:16px;
    display:grid;
    grid-template-columns:minmax(0, 1fr) auto;
    align-items:start;
    gap:var(--wc-space-sm, 8px);
    margin:0;
  }
  .today-attention > .today-reminders > header > div { display:block; }
  .today-attention h2 { margin:0; font-size:var(--wc-font-title); font-weight:600; line-height:1.25; }
  .today-attention > .today-reminders > header p { margin:4px 0 0; font-size:var(--wc-font-small, 12px); line-height:1.35; }
  .today-attention > .today-reminders > p:last-child { margin-block-end:0; }
  .today-attention .today-list { margin:0; }
  .today-attention .today-row { grid-template-columns:minmax(0, 1fr); gap:2px; padding-block:8px; }
  .today-attention .today-row:last-child { padding-block-end:0; border-bottom:0; }
  .today-attention .today-row p { margin-block:4px 0; }
  .today-attention p.today-meta { display:block; line-height:1.35; }
  .today-attention p.today-meta time { font:inherit; }
  .today-attention .today-task-actions { margin-block-start:6px; }
  .today-attention .today-group { margin-block-start:var(--wc-space-sm, 8px); }
  .today-attention .today-group h3 { margin-block:12px 0; }
}
`;

/** D-267 — the Today zero-state's one action. Today is now what bare `#data`
 *  resolves to, so on a fresh install it is the first look an owner gets at
 *  their own warehouse; three empty group headings were an accurate answer to a
 *  question nobody had asked yet. ⚠ The lead line does NOT claim emptiness when
 *  a source failed — "nothing due" and "nothing answered" are different facts,
 *  and it does not render at all until the read is COMPLETE, or a fresh install
 *  would be told "nothing due" by a snapshot still waiting on three sources.
 *  ⛔ The whole block is gated on `canCreate`: a host with no Create opener
 *  wired (embedded + test mounts) renders none of it rather than a button that
 *  does nothing, which is the one outcome worse than no button. */
export const TODAY_CREATE_ACTION = 'today-create';

const renderFreshness = (freshness: Freshness): string => `<span class="today-freshness"${freshness.warning ? ' data-warning' : ''} title="${e(freshness.detail)}">${e(freshness.label)}</span>`;
export const writableTodayTask = (snapshot: TodaySnapshot | null, key: string): TodayItem | undefined =>
  snapshot?.items.find(item => item.key === key && item.kind === 'task' && item.taskId !== undefined
    && !item.unreachable && snapshot.sources.some(source => source.key === item.sourceKey && source.writeCapable === true));

const renderTaskEditor = (actions: TodayTaskActions | undefined, actionAttr: string): string => {
  const edit = actions?.edit;
  if (!edit) return '';
  const locked = edit.busy ? ' aria-disabled="true"' : '';
  return `<div class="today-task-editor" data-today-task-editor id="today-task-editor" role="group" aria-labelledby="today-task-editor-title" aria-busy="${edit.busy}">
    <p class="today-task-editor-title" id="today-task-editor-title" role="status">${edit.clearDue ? 'Clear due date for' : edit.action === 'reschedule' ? 'Reschedule' : edit.busy ? 'Completing' : 'Complete'} “${e(edit.title)}”${edit.busy ? '…' : ''}</p>
    ${edit.action === 'reschedule' && !edit.clearDue ? `<label>New due date and time
      <input type="datetime-local" ${actionAttr}="today-task-due" aria-describedby="today-task-time-help" value="${e(edit.value)}"${edit.busy ? ' disabled' : ''}>
    </label><p class="today-task-hint" id="today-task-time-help">Changes this task’s due date. Times use your device’s time zone.</p>` : edit.clearDue ? '<p class="today-task-hint">Remove this task’s due date. The task will remain in Data → Tasks.</p>' : ''}
    ${edit.error ? `<p role="alert" tabindex="-1" data-today-task-error>${e(edit.error)}</p>` : ''}
    ${edit.action === 'reschedule' || edit.error ? `<button type="button" class="today-task-primary today-action" ${actionAttr}="today-task-save"${locked}>${renderActionLabel(edit.action === 'reschedule' ? 'save' : 'refresh', edit.busy ? 'Saving…' : edit.clearDue ? 'Clear date' : edit.action === 'reschedule' ? 'Save due date' : 'Try again')}</button>` : ''}
    <button type="button" ${actionAttr}="today-task-cancel"${locked}>${edit.action === 'reschedule' ? 'Cancel' : 'Close'}</button>
  </div>`;
};

/** D-340 slice 4 (§3.3) — the day's AI suggestions at the top, as the daily stream carries them, with
 *  "Talk it over": their conversation, where acting on one is a chat turn. Nothing before they finish. */
const renderSuggestions = (suggestions: ProactiveToday['suggestions']): string => suggestions === undefined ? ''
  : `<section class="today-suggestions" data-today-suggestions aria-labelledby="today-suggestions-title"><h3 id="today-suggestions-title">Suggestions</h3>
    <p class="today-suggestions-text">${e(suggestions.text)}</p>
    <a href="#chat/session/${e(encodeURIComponent(suggestions.session_id))}" data-today-suggestions-talk>Talk it over</a></section>`;

/** D-407 slice 2 — "When is the next one?" for each occasion that comes back whenever the last one says and waits for
 *  its next date: its date here, or "No next one". Nothing is drawn when none waits, or from a server before slice 2. */
export const TODAY_OCCASION_NEXT_SAVE = 'today-occasion-next-save';
const localIsoDay = (at: number): string => { const day = new Date(at);
  return `${String(day.getFullYear())}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`; };
export const TODAY_OCCASION_NEXT_NONE = 'today-occasion-next-none';
const renderOccasionsWaiting = (waiting: ProactiveToday['occasions_waiting'], actionAttr: string, busy: boolean, today: string,
  drafts?: ReadonlyMap<string, { on: string; time: string }>): string =>
  !waiting?.length ? '' : `<section class="today-group today-occasion-next" data-today-occasion-next aria-labelledby="today-occasion-next-title">
    <h3 id="today-occasion-next-title">When is the next one?<span class="today-count">${waiting.length}</span></h3>
    <ul class="today-list">${waiting.map((row) => `<li class="today-row" data-today-occasion="${e(row.id)}"><div>
      <a href="#yours/occasions/occasion/${e(encodeURIComponent(row.id))}">${e(row.title)}</a>
      <span class="today-meta">last <time datetime="${e(row.last_on)}">${e(new Date(`${row.last_on}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }))}</time></span>
      <div class="today-occasion-next-fields"><label class="today-occasion-next-date">Date of the next one <input type="date" data-today-occasion-next-on="${e(row.id)}" min="${e(today)}" value="${e(drafts?.get(row.id)?.on ?? '')}"${busy ? ' disabled' : ''}></label>
      <label class="today-occasion-next-date">Time (optional) <input type="time" data-today-occasion-next-time="${e(row.id)}" value="${e(drafts?.get(row.id)?.time ?? '')}"${busy ? ' disabled' : ''}></label>
      <button type="button" class="today-task-primary today-action" ${actionAttr}="${TODAY_OCCASION_NEXT_SAVE}" data-today-occasion-id="${e(row.id)}"${busy ? ' aria-disabled="true"' : ''}>Save</button>
      <button type="button" ${actionAttr}="${TODAY_OCCASION_NEXT_NONE}" data-today-occasion-id="${e(row.id)}"${busy ? ' aria-disabled="true"' : ''}>No next one</button></div>
    </div></li>`).join('')}</ul></section>`;

/** D-340 §4 — what holds today, one line each above the groups, under no title (D-340
 * ruling 10). Nothing is drawn when nothing holds. */
const renderStates = (states: readonly TodayItem[]): string => states.length === 0 ? ''
  : `<section class="today-states" data-today-states aria-label="What holds today"><ul class="today-list">${states.map((state) =>
    `<li class="today-row" data-today-item="${e(state.key)}"><div><a href="${e(state.href)}">${e(state.title)}</a>${state.until === undefined ? ''
      : ` <span class="today-meta">until <time datetime="${e(new Date(state.until).toISOString())}">${e(new Date(state.until).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}</time></span>`}</div></li>`).join('')}</ul></section>`;

export type TodaySphereFilter = 'all' | 'personal' | 'professional' | 'unsorted';
export const renderToday = (snapshot: TodaySnapshot | null, loading: boolean, actionAttr: string, sourcesOpen?: boolean, canCreate?: boolean, actions?: TodayTaskActions, sphereFilter: TodaySphereFilter = 'all', attentionHtml = ''): string => {
  if (snapshot && sphereFilter !== 'all') snapshot = { ...snapshot, items: snapshot.items.filter(item => sphereFilter === 'unsorted' ? item.sphere === undefined && item.sphereReason !== undefined : item.sphere === sphereFilter) };
  const warning = snapshot !== null && (snapshot.issues.length > 0 || snapshot.sources.some((source) => source.freshness.warning)
    || snapshot.items.some((item) => item.unreachable));
  const sources = new Map(snapshot?.sources.map((source) => [source.key, source]));
  const people = snapshot?.proactive?.people ? new Map(Object.entries(snapshot.proactive.people)) : undefined;
  const sourceWarnings = snapshot?.sources.filter((source) => source.freshness.warning).length ?? 0;
  const groups: Array<{ id: TodayGroup; label: string; empty: string }> = [
    { id: 'overdue', label: 'Overdue', empty: 'Nothing is late.' },
    { id: 'today', label: 'Today', empty: 'Nothing else is due today.' },
    { id: 'next', label: 'Next seven days', empty: 'Nothing else in the next seven days.' },
    { id: 'coming_up', label: 'Coming up', empty: 'No later items have started reminding.' },
  ];
  const urgent = groups.filter(group => (group.id === 'overdue' || group.id === 'today') && snapshot?.items.some(item => item.group === group.id));
  const renderGroups = (selected: typeof groups): string => {
    if (!snapshot) return '';
    return selected.map(group => {
        const items = snapshot.items.filter((item) => item.group === group.id);
        return `<section class="today-group" data-today-group="${group.id}" aria-labelledby="today-group-${group.id}">
          <h3 id="today-group-${group.id}">${group.label}<span class="today-count">${items.length}</span></h3>
          ${items.length === 0 ? `<p>${snapshot.complete === false ? 'Still loading…' : warning ? 'Recued found nothing.' : group.empty}</p>` : `<ul class="today-list">${items.map((item) => {
            const source = sources.get(item.sourceKey);
            const when = item.dateUnknown ? 'Date unknown' : `${dateLabel(item.when)} · ${item.allDay ? 'All day' : new Date(item.when).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
            const whenMarkup = item.dateUnknown ? '<span>Date unknown</span>' : `<time datetime="${e(new Date(item.when).toISOString())}">${e(when)}${item.ongoing ? ' · In progress' : ''}</time>`;
            return `<li class="today-row" data-today-item="${e(item.key)}">${whenMarkup}<div>
              <a href="${e(item.href)}"${actions?.canDismissSituation ? rowOpenAttrs(item, actionAttr) : ''}>${e(item.title)}</a><div class="today-meta"><span>${e(kindLabel[item.kind])}</span><span>${e(source?.label ?? item.sourceKey)}</span>
              ${item.sphereReason === undefined ? '' : `<span data-item-sphere title="${e(item.sphereReason)}">${item.sphere === 'personal' ? 'Personal' : item.sphere === 'professional' ? 'Work' : 'Unsorted'} · ${e(item.sphereReason)}</span>`}
              ${item.direction === undefined ? '' : `<span>${e(item.direction)}</span>`}${item.kind === 'situation' ? '' : renderFreshness(item.unreachable ? { label: 'Recued cannot reach this source', detail: 'This may be out of date.', warning: true } : source?.freshness ?? unknownFreshness())}
              </div>${taskReplyWatchSlot(item.taskRef)}${item.taskId && item.taskDependencyIds ? renderTaskBlockers(item.taskId, item.taskDependencyIds, item.taskDependenciesUncertain || source?.freshness.warning === true) : ''}${renderCluster(item.cluster, item.cluster ? snapshot.proactive?.summaries?.[item.cluster.id] : undefined,
                actions?.canDismissSituation ? { actionAttr, busy: actions.commitmentBusy === true } : undefined, people)}${actions && item.taskId !== undefined && !item.unreachable && source?.writeCapable ? `<div class="today-task-actions">
                ${actions.canComplete ? `<button type="button" ${actionAttr}="today-task-complete" data-today-task="${e(item.key)}" aria-label="Complete ${e(item.title)}"${actions.edit ? ' aria-disabled="true"' : ''}>${actions.edit?.key === item.key && actions.edit.busy && actions.edit.action === 'complete' ? 'Completing…' : 'Complete'}</button>` : ''}
                <a ${actions.edit ? 'aria-disabled="true"' : `href="${e(item.href)}"`} aria-label="Open task: ${e(item.title)}">Open task</a>
                ${actions.canReschedule ? renderTaskDueActions({ actionAttr, prefix: 'today-task-due',
                  taskKey: item.key, title: item.title, hasDue: true, disabled: actions.edit !== null,
                  pickAction: 'today-task-reschedule', pickExpanded: actions.edit?.key === item.key && actions.edit.action === 'reschedule' }) : ''}
              </div>` : ''}${actions?.canCloseCommitment && item.commitmentId && !item.unreachable && source?.writeCapable ? `<div class="today-commitment-actions">
                <button type="button" ${actionAttr}="today-commitment-fulfill" data-today-task="${e(item.key)}" aria-label="Done: ${e(item.title)}"${actions.commitmentBusy ? ' disabled' : ''}>Done</button>
                <button type="button" ${actionAttr}="today-commitment-cancel" data-today-task="${e(item.key)}" aria-label="Cancel: ${e(item.title)}"${actions.commitmentBusy ? ' disabled' : ''}>Cancel</button>
              </div>` : ''}${actions?.edit?.key === item.key ? renderTaskEditor(actions, actionAttr) : ''}</div></li>`;
          }).join('')}</ul>`}</section>`;

    }).join('');
  };
  return `<section class="today-view" data-today-view aria-busy="${loading}">
    <header class="today-header"><div><h2>Today</h2>
      <p>Tasks, commitments, and calendar events in one place.</p>
    </div><div class="today-header-actions">${actions?.canOpenStream === true && snapshot?.proactive?.stream === true
      ? `<button type="button" class="today-action" ${actionAttr}="${TODAY_STREAM_ACTION}" data-today-stream-open aria-haspopup="dialog">Daily stream</button>` : ''}${actions?.canCloseDay === true && snapshot?.proactive?.close_day === true
      ? `<button type="button" class="today-action" ${actionAttr}="${TODAY_CLOSE_DAY_ACTION}" data-today-close-day aria-disabled="${actions.closingDay === true}">${actions.closingDay === true ? 'Opening…' : 'Close the day'}</button>` : ''}<button type="button" class="today-refresh today-action" ${actionAttr}="refresh-today" aria-disabled="${loading}">${renderActionLabel('refresh', 'Refresh')}</button></div></header>
    ${snapshot?.proactive?.phone_ready === false ? '<p role="status">Reminders currently reach only the app. <a href="#connections">Connect a phone channel</a>.</p>' : ''}
    ${actions?.notice ? `<p role="status" tabindex="-1" data-today-task-notice>${e(actions.notice)}${actions.undoDismissal
      ? ` <button type="button" class="today-action" ${actionAttr}="today-situation-restore" data-today-dismissal="${e(actions.undoDismissal)}">${renderActionLabel('undo', 'Undo')}</button>` : ''}</p>` : ''}
    ${actions?.error ? `<p role="alert" tabindex="-1" data-today-task-error>${e(actions.error)}</p>` : ''}
    ${actions?.edit && !snapshot?.items.some(item => item.key === actions.edit?.key) ? renderTaskEditor(actions, actionAttr) : ''}
    ${snapshot === null ? `<p role="status">Loading Today…</p>${attentionHtml}` : `
      <div class="today-toolbar"><div class="today-status-cluster">
      <p class="today-window">Seven-day window: ${e(dateLabel(snapshot.now))}–${e(dateLabel(snapshot.before - 1))} · Your local time</p>
      <p class="today-updated" role="status">${snapshot.complete === false
        ? 'Still reading your sources. Here is what has come in so far.'
        : loading ? 'Loading again. These are the old results.'
        : `Checked ${e(new Date(snapshot.now).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}`}</p>
      </div><div class="today-scope-controls">
      <label>Sphere <select data-today-sphere aria-label="Today sphere">${[['all', 'All spheres'], ['personal', 'Personal'], ['professional', 'Work'], ['unsorted', 'Unsorted']].map(([value, title]) => `<option value="${value}"${value === sphereFilter ? ' selected' : ''}>${title}</option>`).join('')}</select></label>
      <details class="today-sources"${sourcesOpen ? ' open' : ''}><summary>Sources · ${snapshot.sources.length}${sourceWarnings > 0 ? ` · ${sourceWarnings} need attention` : ''}</summary><ul>
      ${snapshot.sources.map((source) => `<li><span>${e(source.label)} · ${e(kindLabel[source.kind])}</span>${renderFreshness(source.freshness)}<span>${e(source.freshness.detail)}</span></li>`).join('')}
      </ul></details></div></div>
      ${warning ? `<div class="today-notice" role="status"><p>Some sources may be missing or out of date. Results below may be incomplete.</p>${snapshot.issues.map((issue) => `<p>${e(issue)}</p>`).join('')}</div>` : ''}
      <div class="today-layout">
        <div class="today-priority">${renderGroups(urgent)}</div>
        ${attentionHtml ? `<div class="today-attention">${attentionHtml}</div>` : ''}
        <div class="today-later">
          ${snapshot.items.length === 0 && snapshot.complete && canCreate === true ? `<div class="today-empty" data-today-empty>
            <p class="today-empty-lead">${warning
              ? 'The sources that answered had nothing to show.'
              : 'Nothing is due in the next seven days.'}</p>
            <button type="button" class="today-empty-create" ${actionAttr}="${TODAY_CREATE_ACTION}">Capture something</button>
            <p class="today-empty-sub">A task, a note, a contact, or something you promised. No setup needed — it stays on this server.</p>
          </div>` : ''}
          ${renderSuggestions(snapshot.proactive?.suggestions)}
          ${actions?.canAnswerOccasionNext === true
            ? renderOccasionsWaiting(snapshot.proactive?.occasions_waiting, actionAttr, actions.commitmentBusy === true, localIsoDay(snapshot.now), actions.occasionDrafts) : ''}
          ${renderStates(snapshot.items.filter((item) => item.group === 'holds'))}
          ${renderGroups(groups.filter(group => !urgent.includes(group)))}
          ${snapshot.proactive?.proposal_count ? `<p data-today-proposals><a href="#yours/proposals">${snapshot.proactive.proposal_count} proposals and questions wait</a>${snapshot.proactive.newest_proposal ? ` · ${e(snapshot.proactive.newest_proposal.title)}` : ''}</p>` : ''}
          ${snapshot.proactive?.unmatched_replies.length ? `<section data-today-unmatched><h3>Unmatched replies</h3><p>These replies changed nothing. <a href="#yours/proposals">Review in Yours</a>.</p><ul>${snapshot.proactive.unmatched_replies.map(reply => `<li><p>${e(reply.text)}</p><p>${e(reply.reason.replaceAll('_', ' '))}</p></li>`).join('')}</ul></section>` : ''}
        </div>
      </div>`}
  </section>`;
};
