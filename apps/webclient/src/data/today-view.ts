/** A read-time projection of existing records; Today owns no stored entities. */
import type {
  CollectionInstanceRow, CollectionSourceFreshness, SourceRegistration,
  WorkEntity, WorkEntityListRpcRequest, WorkEntitySourceFreshness,
} from '@recued/contracts';
import { resolveTaskListFilter } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { serializeShellRoute, serializeSourceRecordAddress } from '../shell/route.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import type { BootstrapDataRouteOptions } from './bootstrap-data-route.js';

type TodayKind = 'task' | 'commitment' | 'calendar';
type TodayGroup = 'overdue' | 'today' | 'next';
interface Freshness { label: string; detail: string; warning: boolean }
export interface TodaySource {
  key: string;
  label: string;
  kind: TodayKind;
  freshness: Freshness;
}
export interface TodayItem {
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
}
export interface TodaySnapshot {
  now: number;
  tomorrow: number;
  before: number;
  items: TodayItem[];
  sources: TodaySource[];
  issues: string[];
}

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const kindLabel = { task: 'Task', commitment: 'Commitment', calendar: 'Calendar event' };
const unknownFreshness = (): Freshness => ({ label: 'Freshness unknown', detail: 'This source did not report sync freshness.', warning: true });
const localFreshness = (): Freshness => ({ label: 'Local', detail: 'Stored directly in Recued; no external sync is needed.', warning: false });
const validDate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15;
const dateLabel = (value: number): string => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const syncLabel = (last: number | null | undefined): string =>
  validDate(last) ? `Last synced ${new Date(last).toLocaleString()}.` : 'No successful sync reported.';

// Google and CalDAV encode date-only events as UTC midnight, not instants.
// Translate only those adapters: Graph/local events already carry instants.
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
    label: 'Not included', detail: 'This source is read on demand and has no stored records for Today.', warning: true,
  };
  if (fresh === undefined) return source?.source_kind === 'builtin' ? localFreshness() : unknownFreshness();
  const state = fresh.state === 'fresh' && validDate(fresh.last_success_at)
    && fresh.stale_after_ms !== undefined && now - fresh.last_success_at > fresh.stale_after_ms
    ? 'stale' : fresh.state;
  const label = {
    local: 'Local', read_through: 'Read from source', fresh: 'Synced', stale: 'Sync stale',
    degraded: 'Sync problem', never_synced: 'Never synced',
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
  const label = fresh.degraded ? 'Sync problem' : fresh.pending > 0 ? 'Sync catching up'
    : fresh.last_success_at === null ? 'Never synced' : fresh.stale ? 'Sync stale' : 'Synced';
  return { label, detail: syncLabel(fresh.last_success_at), warning: fresh.stale || fresh.degraded || fresh.pending > 0 || fresh.last_success_at === null };
};

/** Resolve once per read, including across DST; the seven-day task window includes today. */
export const todayWindow = (now: number): Pick<TodaySnapshot, 'now' | 'tomorrow' | 'before'> => {
  const today = resolveTaskListFilter({ completion: 'open', due: 'today', sort: 'due_asc' }, now);
  const week = resolveTaskListFilter({ completion: 'open', due: 'next_7_days', sort: 'due_asc' }, now);
  if (today.due.kind !== 'range' || week.due.kind !== 'range') throw new Error('Expected calendar-day windows');
  return { now, tomorrow: today.due.before, before: week.due.before };
};

const workItem = (entity: WorkEntity, window: ReturnType<typeof todayWindow>): TodayItem | null => {
  if (entity.deleted_at != null || (entity.sync_state !== 'live' && entity.sync_state !== 'stale_unreachable')) return null;
  if (entity._kind !== 'task' && entity._kind !== 'commitment') return null;
  if (entity._kind === 'task' ? entity.done : entity.lifecycle_state !== 'pending') return null;
  const when = entity._kind === 'task' ? entity.due_at : entity.promised_for_at;
  if (!validDate(when) || when >= window.before) return null;
  return {
    key: `${entity._kind}:${entity.id}`, title: entity._kind === 'task' ? entity.title : entity.statement,
    when, group: when < window.now ? 'overdue' : when < window.tomorrow ? 'today' : 'next',
    kind: entity._kind, sourceKey: `work:${entity.source_id}`,
    href: serializeShellRoute('data', entity._kind, entity.id),
    ...(entity._kind === 'commitment' ? { direction: { outbound: 'You promised', inbound: 'Promised to you', internal: 'Personal commitment' }[entity.direction] } : {}),
    ...(entity.sync_state === 'stale_unreachable' ? { unreachable: true } : {}),
  };
};

/** Read independently so a failed source cannot erase the other sources' results.
 * Limits are explicit and visible; every page reuses the same date window. */
export const loadToday = async (
  opts: Pick<BootstrapDataRouteOptions, 'workEntitySourceListCaller' | 'workEntityListCaller' | 'collectionListInstancesCaller' | 'collectionListCaller'>,
  now: number,
  isCurrent: () => boolean = () => true,
): Promise<TodaySnapshot> => {
  const snapshot: TodaySnapshot = { ...todayWindow(now), items: [], sources: [], issues: [] };
  let registrations: readonly SourceRegistration[] = [];
  const workSources = new Map<string, { kind: 'task' | 'commitment'; fresh?: WorkEntitySourceFreshness }>();
  const fail = (scope: string, error: unknown): void => { snapshot.issues.push(`${scope}: ${humanizeRpcError(error)}`); };
  const readWork = async (kind: 'task' | 'commitment'): Promise<void> => {
    const label = kind === 'task' ? 'Tasks' : 'Commitments';
    if (opts.workEntityListCaller === undefined) { fail(label, new Error('Records are unavailable.')); return; }
    const seen = new Set<string>();
    let offset = 0;
    let initialTotal: number | undefined;
    try {
      for (let page = 0; page < MAX_PAGES && isCurrent(); page++) {
        const args: WorkEntityListRpcRequest = { kind, limit: PAGE_SIZE, offset };
        if (kind === 'task') args.task_filter = {
          completion: 'open', sort: 'due_asc', due: { kind: 'range', from: -8.64e15, before: snapshot.before },
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
          const item = workItem(entity, snapshot);
          if (item !== null && entity._kind === kind) snapshot.items.push(item);
        }
        offset += result.entities.length;
        if (result.total !== initialTotal || added !== result.entities.length) {
          fail(label, new Error('The list changed while loading. Refresh to check remaining records.'));
          return;
        }
        if (offset >= result.total) return;
        if (added === 0) { fail(label, new Error('The list changed while loading. Refresh to check remaining records.')); return; }
      }
      if (isCurrent()) fail(label, new Error('The read reached its 100-page limit. Open the original list for more.'));
    } catch (error) { fail(label, error); }
  };
  const readCalendar = async (instance: CollectionInstanceRow): Promise<void> => {
    const source: TodaySource = { key: `calendar:${instance.slug}`, label: instance.slug, kind: 'calendar', freshness: unknownFreshness() };
    snapshot.sources.push(source);
    if (opts.collectionListCaller === undefined) { fail(instance.slug, new Error('Calendar records are unavailable.')); return; }
    const seen = new Set<string>();
    const dateOnlyAdapter = instance.adapter_type === 'gcal' || instance.adapter_type === 'caldav';
    const windows = dateOnlyAdapter ? [
      { from: now, before: snapshot.before, allDay: false },
      { from: localDayAsUtc(now), before: localDayAsUtc(snapshot.before), allDay: true },
    ] : [{ from: now, before: snapshot.before }];
    let pages = 0;
    try {
      for (const window of windows) {
        let offset = 0;
        while (isCurrent()) {
          if (pages++ >= MAX_PAGES) { fail(instance.slug, new Error('The calendar read reached its 100-page limit. Open Calendar for more.')); return; }
          const result = await opts.collectionListCaller({ platform: 'calendar', slug: instance.slug,
            calendar_window: { from: window.from, before: window.before }, limit: PAGE_SIZE, offset,
            ...('allDay' in window ? { filters: { is_all_day: window.allDay } } : {}) });
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
            const start = allDay && dateOnlyAdapter ? utcDayAsLocal(fields.start_at) : fields.start_at;
            const end = allDay && dateOnlyAdapter ? utcDayAsLocal(fields.end_at) : fields.end_at;
            if (end <= now || start >= snapshot.before || fields.status === 'cancelled') continue;
            snapshot.items.push({
              key: `${source.key}:${record.record_id}`, title: typeof fields.summary === 'string' && fields.summary.trim() ? fields.summary : 'Untitled event',
              when: start, group: start < snapshot.tomorrow ? 'today' : 'next', kind: 'calendar', sourceKey: source.key,
              href: serializeSourceRecordAddress({ tab: 'calendar', collectionSlug: instance.slug, recordId: record.record_id }),
              allDay,
              ongoing: start < now,
            });
          }
          offset += result.records.length;
          if (added !== result.records.length) { fail(instance.slug, new Error('Calendar pagination did not advance consistently. Refresh to check this source.')); return; }
          if (result.records.length < PAGE_SIZE) break;
        }
      }
    } catch (error) { fail(instance.slug, error); }
  };
  const readCalendars = async (): Promise<void> => {
    if (opts.collectionListInstancesCaller === undefined) { fail('Calendars', new Error('Calendar sources are unavailable.')); return; }
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
      if (opts.workEntitySourceListCaller === undefined) throw new Error('Source labels are unavailable.');
      registrations = (await opts.workEntitySourceListCaller()).sources;
    } catch (error) { fail('Sources', error); }
  };
  await Promise.all([readSources(), readWork('task'), readWork('commitment'), readCalendars()]);
  for (const source of registrations) {
    if ((source.top_tier_kind === 'task' || source.top_tier_kind === 'commitment') && !workSources.has(source.id)) {
      workSources.set(source.id, { kind: source.top_tier_kind });
    }
  }
  for (const [id, info] of workSources) {
    const registration = registrations.find((source) => source.id === id);
    snapshot.sources.push({ key: `work:${id}`, kind: info.kind, label: registration?.source_label ?? id,
      freshness: workFreshness(info.fresh, registration, now) });
  }
  snapshot.items.sort((a, b) => a.when - b.when || a.key.localeCompare(b.key));
  snapshot.sources.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  snapshot.issues.sort();
  return snapshot;
};

export const TODAY_VIEW_STYLES = `
.today-view { max-width:960px; margin-top:18px; }
.today-header { display:flex; justify-content:space-between; align-items:start; gap:16px; }
.today-header h2 { margin:0 0 6px; font-size:22px; }
.today-view p { color:var(--muted); line-height:1.5; }
.today-header p { margin:0 0 12px; }
.today-refresh { min-height:36px; flex-shrink:0; padding:6px 12px; font:inherit; font-size:13px; color:var(--fg); background:var(--surface); border:1px solid var(--border); border-radius:8px; cursor:pointer; }
.today-refresh[aria-disabled="true"] { opacity:.6; cursor:wait; }
.today-sources { margin:12px 0 22px; }
.today-sources summary { cursor:pointer; }
.today-sources ul, .today-list { list-style:none; padding:0; }
.today-sources li { display:flex; flex-wrap:wrap; gap:8px; padding:5px 0; }
.today-group h3 { display:flex; gap:10px; align-items:center; font-size:16px; margin:24px 0 6px; }
.today-count { font-size:12px; font-weight:400; opacity:.7; }
.today-row { display:grid; grid-template-columns:145px minmax(0,1fr); gap:12px; padding:14px 0; border-bottom:1px solid var(--border, #303642); }
.today-row time { font-size:13px; color:var(--muted); }
.today-row a { color:var(--fg); overflow-wrap:anywhere; text-decoration:none; }
.today-row a:hover { text-decoration:underline; }
.today-meta { display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; margin-top:6px; font-size:12px; color:var(--muted); overflow-wrap:anywhere; }
.today-freshness { font-size:12px; padding:2px 6px; border:1px solid var(--border, #303642); border-radius:4px; }
.today-freshness[data-warning] { color:var(--fg); background:var(--warn-soft); font-weight:600; }
.today-notice { padding:10px 12px; border-left:3px solid var(--warn); background:var(--surface-sunk); }
@media (max-width:540px) { .today-row { grid-template-columns:minmax(0,1fr); gap:6px; } }
`;

const renderFreshness = (freshness: Freshness): string => `<span class="today-freshness"${freshness.warning ? ' data-warning' : ''} title="${e(freshness.detail)}">${e(freshness.label)}</span>`;
export const renderToday = (snapshot: TodaySnapshot | null, loading: boolean, actionAttr: string, sourcesOpen?: boolean): string => {
  const warning = snapshot !== null && (snapshot.issues.length > 0 || snapshot.sources.some((source) => source.freshness.warning)
    || snapshot.items.some((item) => item.unreachable));
  const sources = new Map(snapshot?.sources.map((source) => [source.key, source]));
  const sourceWarnings = snapshot?.sources.filter((source) => source.freshness.warning).length ?? 0;
  const groups: Array<{ id: TodayGroup; label: string; empty: string }> = [
    { id: 'overdue', label: 'Overdue', empty: 'No overdue tasks or commitments.' },
    { id: 'today', label: 'Today', empty: 'Nothing else due or upcoming today.' },
    { id: 'next', label: 'Next seven days', empty: 'Nothing else in the next seven days.' },
  ];
  return `<section class="today-view" data-today-view aria-busy="${loading}">
    <header class="today-header"><div><h2>Today</h2>
      <p>Tasks, commitments, and calendar events in one place.</p>
      ${snapshot === null ? '' : `<p>Seven-day window: ${e(dateLabel(snapshot.now))}–${e(dateLabel(snapshot.before - 1))} · Your local time</p>`}
    </div><button type="button" class="today-refresh" ${actionAttr}="refresh-today" aria-disabled="${loading}">Refresh</button></header>
    ${snapshot === null ? '<p role="status">Loading Today…</p>' : `
      <p class="today-updated">${loading ? 'Refreshing… Previous results shown.' : `Checked ${e(new Date(snapshot.now).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}`}</p>
      ${warning ? `<div class="today-notice" role="status"><p>Some sources may be missing or out of date. Results below may be incomplete.</p>${snapshot.issues.map((issue) => `<p>${e(issue)}</p>`).join('')}</div>` : ''}
      <details class="today-sources"${sourcesOpen ? ' open' : ''}><summary>Sources · ${snapshot.sources.length}${sourceWarnings > 0 ? ` · ${sourceWarnings} need attention` : ''}</summary><ul>
      ${snapshot.sources.map((source) => `<li><span>${e(source.label)} · ${e(kindLabel[source.kind])}</span>${renderFreshness(source.freshness)}<span>${e(source.freshness.detail)}</span></li>`).join('')}
      </ul></details>
      ${groups.map((group) => {
        const items = snapshot.items.filter((item) => item.group === group.id);
        return `<section class="today-group" data-today-group="${group.id}" aria-labelledby="today-group-${group.id}">
          <h3 id="today-group-${group.id}">${group.label}<span class="today-count">${items.length}</span></h3>
          ${items.length === 0 ? `<p>${warning ? 'No items found in the available data.' : group.empty}</p>` : `<ul class="today-list">${items.map((item) => {
            const source = sources.get(item.sourceKey);
            const when = `${dateLabel(item.when)} · ${item.allDay ? 'All day' : new Date(item.when).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
            return `<li class="today-row" data-today-item="${e(item.key)}"><time datetime="${e(new Date(item.when).toISOString())}">${e(when)}${item.ongoing ? ' · In progress' : ''}</time><div>
              <a href="${e(item.href)}">${e(item.title)}</a><div class="today-meta"><span>${e(kindLabel[item.kind])}</span><span>${e(source?.label ?? item.sourceKey)}</span>
              ${item.direction === undefined ? '' : `<span>${e(item.direction)}</span>`}${renderFreshness(item.unreachable ? { label: 'Source unreachable', detail: 'This record may be out of date.', warning: true } : source?.freshness ?? unknownFreshness())}
              </div></div></li>`;
          }).join('')}</ul>`}</section>`;
      }).join('')}`}
  </section>`;
};
