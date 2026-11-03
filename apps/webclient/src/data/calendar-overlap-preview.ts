import { allDayEventDays, DAY_MS, type CalendarOverlapRequest, type CalendarOverlapResult } from '@recued/contracts';
import { e, renderActionLabel } from '@recued/ui-shared';
import { classifyRpcError } from '../shell/rpc-error-copy.js';

export type CalendarOverlapCaller = (request: CalendarOverlapRequest) => Promise<CalendarOverlapResult>;

const validTimestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Math.abs(Number(value)) <= 8.64e15;

/** Read-only, generation-bound state. Updating this host never replaces a time input. */
export const createCalendarOverlapPreview = (deps: {
  call?: CalendarOverlapCaller; id: 'create' | 'edit'; actionAttr: string; retryAction: string;
}) => {
  let request: CalendarOverlapRequest | null = null, key = '', generation = 0;
  let result: CalendarOverlapResult | null = null;
  let state: 'idle' | 'loading' | 'ready' | 'error' | 'unsupported' = 'idle';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let host: HTMLElement | null = null, disposed = false;
  const date = (at: number, zone: string) => new Intl.DateTimeFormat(undefined, {
    timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(at);
  const syncDate = (at: number, zone: string) => new Intl.DateTimeFormat(undefined, {
    timeZone: zone, dateStyle: 'medium', timeStyle: 'short',
  }).format(at);
  const range = (event: CalendarOverlapResult['events'][number], zone: string) => {
    if (!event.is_all_day) return `${date(event.start_at, zone)} – ${date(event.end_at, zone)}`;
    const days = allDayEventDays(event);
    return `All day · ${days.first}${days.first === days.last ? '' : ` – ${days.last}`}`;
  };
  const content = (): string => {
    const qualification = '<p class="calendar-overlap-muted">From events saved on this server. Connected calendars may have newer changes. This does not reserve the time.</p>';
    let body = '';
    if (state === 'idle') body = '<p>Choose valid times to check other events.</p>';
    if (state === 'loading') body = '<p role="status">Checking saved events…</p>';
    if (state === 'unsupported') body = '<p>Update your Recued server to check other events here.</p>';
    if (state === 'error') body = `<p>Other events could not be checked. You can still save.</p><button type="button" class="data-button" ${deps.actionAttr}="${deps.retryAction}">${renderActionLabel('refresh', 'Retry check')}</button>`;
    if (state === 'ready' && result) {
      const partial = result.truncated || !result.sources.length || result.sources.some(source => source.status === 'stale' || source.status === 'unavailable');
      const list = (events: CalendarOverlapResult['events']) =>
        `<ul class="calendar-overlap-events">${events.map(event => `<li><strong>${e(event.summary)}</strong><span>${e(event.calendars.join(' · '))}</span><span>${e(range(event, result!.timezone))}</span></li>`).join('')}</ul>`;
      body = result.events.length
        ? list(result.events.slice(0, 3))
        : `<p>${partial ? 'No overlapping events found in the data checked.' : 'No overlapping saved events found.'}</p>`;
      if (result.events.length > 3) body += `<details class="calendar-overlap-more"><summary>Show ${result.events.length - 3} more saved events</summary>${list(result.events.slice(3))}</details>`;
      const warnings = result.sources.filter(source => source.status === 'stale' || source.status === 'unavailable');
      if (warnings.length) body += `<ul class="calendar-overlap-notices">${warnings.map(source => `<li>${e(source.name)}: ${source.status === 'unavailable' ? 'could not be read' : 'sync is incomplete or out of date'}${source.last_synced_at === null ? '; no successful sync recorded' : `; last synced ${e(syncDate(source.last_synced_at, result!.timezone))}`}.</li>`).join('')}</ul>`;
      if (!result.sources.length) body += '<p class="calendar-overlap-muted">No saved calendars were available to check.</p>';
      if (result.truncated) body += '<p class="calendar-overlap-muted">This preview is incomplete. More saved events may overlap.</p>';
      body += `<p class="calendar-overlap-muted">Times in ${e(result.timezone)}.</p>`;
    }
    return `<h4>Other events at this time</h4>${body}${qualification}`;
  };
  const paint = () => { if (host?.isConnected) host.innerHTML = content(); };
  const retire = () => { generation++; if (timer !== undefined) clearTimeout(timer); timer = undefined; result = null; };
  const check = async () => {
    if (!request || !deps.call || disposed) return;
    const mine = generation, wanted = request;
    try {
      const value = await deps.call(wanted);
      if (disposed || mine !== generation) return;
      if (!value || value.start_at !== wanted.start_at || value.end_at !== wanted.end_at
        || value.is_all_day !== wanted.is_all_day || value.timezone !== wanted.timezone
        || !validTimestamp(value.checked_at) || typeof value.truncated !== 'boolean'
        || !Array.isArray(value.events) || !Array.isArray(value.sources)
        || value.events.some(event => !event || !validTimestamp(event.start_at) || !validTimestamp(event.end_at)
          || event.end_at <= event.start_at || typeof event.is_all_day !== 'boolean'
          || typeof event.summary !== 'string' || !Array.isArray(event.calendars)
          || event.calendars.some(name => typeof name !== 'string'))
        || value.sources.some(source => !source || typeof source.name !== 'string'
          || !['local', 'synced', 'stale', 'unavailable'].includes(source.status)
          || source.last_synced_at !== null && !validTimestamp(source.last_synced_at))) throw new Error('Invalid preview');
      result = value; state = 'ready';
    } catch (cause) {
      if (disposed || mine !== generation) return;
      result = null; state = classifyRpcError(cause).code === 'unknown_method' ? 'unsupported' : 'error';
    }
    paint();
  };
  return {
    update(next: CalendarOverlapRequest | null): void {
      if (disposed || !deps.call) return;
      if (next && (!validTimestamp(next.start_at) || !validTimestamp(next.end_at)
        || next.end_at <= next.start_at || next.end_at - next.start_at > 366 * DAY_MS)) next = null;
      const nextKey = next ? JSON.stringify(next) : '';
      if (nextKey === key) return;
      retire(); key = nextKey; request = next; state = next ? 'loading' : 'idle'; paint();
      if (next) timer = setTimeout(() => { timer = undefined; void check(); }, 200);
    },
    retry(): void {
      if (!request || disposed) return;
      retire(); state = 'loading'; paint(); void check();
    },
    reset(): void { retire(); key = ''; request = null; state = 'idle'; host = null; },
    dispose(): void { this.reset(); disposed = true; },
    render(): string {
      return deps.call ? `<section class="calendar-overlap" aria-label="Other events at this time" data-calendar-overlap-preview="${deps.id}">${content()}</section>` : '';
    },
    mount(root: ParentNode): void {
      if (deps.call) host = root.querySelector?.<HTMLElement>(`[data-calendar-overlap-preview="${deps.id}"]`) ?? null;
    },
  };
};

export const CALENDAR_OVERLAP_STYLES = `
.calendar-overlap { display:grid; gap:.5rem; min-width:0; padding:.875rem 1rem; border:1px solid var(--border); border-radius:.5rem; background:var(--surface); font-size:.8125rem; line-height:1.5; overflow-wrap:anywhere; }
.calendar-overlap h4, .calendar-overlap p { margin:0; }
.calendar-overlap h4 { font-size:.8125rem; font-weight:600; }
.calendar-overlap .data-button { justify-self:start; }
.calendar-overlap-muted, .calendar-overlap-events span, .calendar-overlap-notices { color:var(--fg-muted); }
.calendar-overlap-events { display:grid; gap:.625rem; list-style:none; padding:0; margin:0; }
.calendar-overlap-events li { display:grid; gap:.125rem; }
.calendar-overlap-more > summary { cursor:pointer; color:var(--fg-muted); }
.calendar-overlap-more > ul { margin-top:.625rem; }
.calendar-overlap-notices { margin:0; padding-left:1.125rem; }
`;
