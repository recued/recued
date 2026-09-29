/** Server-backed named views wrap the existing Data reader; opening a link only reads. */
import {
  SAVED_DATA_VIEW_NAME_LIMIT, parseSavedDataViewDefinition, sameSavedDataViewDefinition, savedDataViewSupportsAlerts,
  type SavedDataView, type SavedDataViewCreateRequest,
  type SavedDataViewRenameRequest, type SavedDataViewDeleteRequest,
  type SavedDataViewUpdateRequest, type SavedDataViewDefinition, type SavedDataViewRetiredResolveRequest,
} from '@recued/contracts';
import { bootstrapDataRoute, type BootstrapDataRouteOptions, type DataRoute } from './bootstrap-data-route.js';
import { stampZone } from '@recued/ui-shared';
import { serializeShellRoute } from '../shell/route.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';

export interface SavedDataViewsClient {
  /** `retired` (D-300): pack views an update replaced that the owner had set up. */
  list(): Promise<{ views: SavedDataView[]; retired?: SavedDataView[] }>;
  get(args: { id: string }): Promise<{ view: SavedDataView | null }>;
  create(args: SavedDataViewCreateRequest): Promise<{ view: SavedDataView }>;
  update(args: SavedDataViewUpdateRequest): Promise<{ view: SavedDataView }>;
  rename(args: SavedDataViewRenameRequest): Promise<{ view: SavedDataView }>;
  delete(args: SavedDataViewDeleteRequest): Promise<{ deleted: boolean }>;
  /** D-300 — resolve a retired pack view. Absent on an older host: nothing is offered. */
  resolveRetired?(args: SavedDataViewRetiredResolveRequest): Promise<{ view: SavedDataView | null }>;
}

/** D-300 — what the owner had set up on a view a pack update replaced, in their words. */
const retiredSetup = (view: SavedDataView): string => [
  ...(view.retired?.alert?.enabled ? ['an alert on it'] : []),
  ...(view.hidden ? ['hidden it'] : []),
  ...(view.review !== undefined ? ['marked what you reviewed'] : []),
].join(', ') || 'set it up';
export interface SavedDataRouteOptions extends BootstrapDataRouteOptions {
  /** D-269 step 1 — the server's resolved IANA zone for a new alert's stamp.
   *  Absent ⇒ this browser's, as before. */
  serverTimeZone?: () => string | undefined;
  savedViews: SavedDataViewsClient;
  savedViewId?: string;
  /** D-291 — which half of this module the host wants.
   *
   *  `'data'` (the default) is `#data`: the Data route plus the one control
   *  that CANNOT live anywhere else, "Save current view" — you can only save
   *  the surface you are looking at. No list.
   *
   *  `'views'` is `#views`: the list and everything that manages it, plus the
   *  Data route underneath when an id is addressed.
   *
   *  ⛔ ONE MODULE, TWO CHROMES, deliberately. The save control needs
   *  `child.currentView()` and the list does not — but they share the create
   *  editor, the conflict resolution and the notice plumbing. Splitting them
   *  into two modules would duplicate that, and a saved view whose two halves
   *  disagree is worse than one surface that renders less. */
  chrome?: 'data' | 'views';
}

const e = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
export const savedDataViewHref = (id: string): string => serializeShellRoute('views', id);
const settingsSummary = (definition: SavedDataViewDefinition): string => {
  const labels: Record<SavedDataViewDefinition['tab'], string> = {
    today: 'Today',
    search: 'Search', contact: 'Contacts', task: 'Tasks', note: 'Notes', commitment: 'Commitments',
    project: 'Projects', booking: 'Bookings', mail: 'Mail', calendar: 'Calendar', files: 'Files',
    webhook: 'Webhook deliveries', memory: 'Memory', records: 'Records', form_response: 'Form responses',
    annotation: 'Annotations', link: 'Links', shared: 'Shared',
  };
  const parts = [labels[definition.tab]];
  if ('query' in definition) parts.push(definition.query ? `Search: “${definition.query}”` : 'No search text');
  if ('source_id' in definition) {
    parts.push(`Source: ${definition.source_id ?? 'All sources'}`);
    if (definition.tab === 'booking') parts.push(`Lifecycle: ${definition.booking_lifecycle}`);
    if (definition.tab === 'task') {
      const filters = definition.task_filters;
      parts.push(({ all: 'All tasks', open: 'Open tasks', completed: 'Completed tasks' })[filters?.completion ?? 'all']);
      parts.push(({ all: 'Any time', overdue: 'Overdue', today: 'Today', next_7_days: 'Next seven days' })[filters?.due ?? 'all']);
      parts.push(filters?.sort === 'due_asc' ? 'Due date — earliest first' : 'Open first');
    }
  }
  if ('collection_slug' in definition) parts.push(`Source: ${definition.collection_slug ?? 'None selected'}`);
  if (definition.tab === 'records') {
    parts.push(definition.owner === null ? 'No pack selected'
      : `Pack: ${definition.owner.publisher}/${definition.owner.pack_slug}`, `Kind: ${definition.entity ?? 'None selected'}`);
    const operators = { eq: '=', ne: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥', in: 'is any of', prefix: 'starts with' };
    const filters = Object.entries(definition.filters ?? {}).map(([field, filter]) =>
      filter.op === 'is_null' ? `${field} ${filter.value ? 'is not set' : 'is set'}`
        : `${field} ${operators[filter.op]} ${JSON.stringify(filter.value)}`);
    parts.push(filters.length ? `Filters: ${filters.join('; ')}` : 'No field filters');
    const sort = definition.sort ?? 'id';
    parts.push(`Sort: ${sort.startsWith('-') ? `${sort.slice(1)} descending` : `${sort} ascending`}`);
  }
  if (definition.tab === 'memory') parts.push(({ all: 'All origins', user_self: 'You', contracted_user: 'Agents', system: 'System' })[definition.origin]);
  return parts.join(' · ');
};
const alertSummary = (view: SavedDataView): string => {
  const alert = view.alert;
  if (!alert) return 'Alerts off';
  if (!alert.enabled) return 'Alerts paused';
  const status = alert.status === 'unavailable'
    ? `Alerts waiting for your ${view.definition.tab === 'records' ? 'records' : 'tasks'}` : 'Alerts on';
  return `${status}${view.definition.tab === 'task' ? ` · ${alert.time_zone}` : ''}${alert.last_checked_at === null ? ''
    : ` · Checked ${new Date(alert.last_checked_at).toLocaleString()}`}`;
};
const alertControls = (view: SavedDataView, disabled: boolean, pendingId: string | null, explain = false): string => {
  if (!savedDataViewSupportsAlerts(view.definition)) return '';
  const action = !view.alert ? 'Notify me' : view.alert.enabled ? 'Pause alerts' : 'Resume alerts';
  const pending = pendingId === view.id;
  const label = pending ? !view.alert ? 'Turning on alerts…' : view.alert.enabled ? 'Pausing alerts…' : 'Resuming alerts…' : action;
  const state = !view.alert ? 'off' : !view.alert.enabled ? 'paused' : view.alert.status === 'unavailable' ? 'waiting' : 'on';
  const summary = alertSummary(view).split(' · ');
  return `<div class="saved-data-alert" data-view-alert="${e(view.id)}" aria-busy="${pending}">
    <span class="saved-data-alert-state" data-alert-state="${state}">${e(summary[0]!)}</span>
    <button type="button" data-view-action="alert" data-view-id="${e(view.id)}"
      aria-label="${e(label)} for ${e(view.name)}" ${disabled ? 'disabled' : ''}>${label}</button>
    ${summary.length > 1 ? `<span class="saved-data-alert-detail">${e(summary.slice(1).join(' · '))}</span>` : ''}
    ${explain && state === 'waiting' ? `<p class="saved-data-alert-help">Open this view to check its ${view.definition.tab === 'records' ? 'pack and filters' : 'source and filters'}. Alerts resume when the data is available.</p>` : ''}
  </div>`;
};
const STYLES = `
  .saved-data-header { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; }
  .saved-data-header h1 { margin:0; font-size:20px; font-weight:650; }
  .saved-data-tools { min-width:0; max-width:var(--wc-content-max, 1080px); margin:0 auto; padding:16px 16px 0; color:var(--fg); }
  .saved-data-tools details { border:1px solid var(--border); border-radius:8px; padding:8px 12px; background:var(--surface-subtle); }
  .saved-data-tools a { color:var(--accent); overflow-wrap:anywhere; }
  /* D-291 - the way out of Data to the saved-view list. Sized like the
     header's button so the two read as one row, not a button with a stray
     link. NOTE: no backticks in here - this block is a template literal. */
  .saved-data-header .saved-data-views-link { align-content:center; min-height:44px; padding:8px 12px; }
  .saved-data-tools p { line-height:1.45; }
  .saved-data-tools :focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
  .saved-data-tools summary { cursor:pointer; min-height:44px; display:list-item; align-content:center; }
  .saved-data-tools ul { list-style:none; padding:0; margin:8px 0; }
  .saved-data-tools li, .saved-data-editor { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:8px 0; }
  .saved-data-tools li a { flex:1; min-width:120px; overflow-wrap:anywhere; padding:10px 0; }
  .saved-data-tools button, .saved-data-header button, .saved-data-tools input { min-height:44px; font:inherit; }
  .saved-data-tools button, .saved-data-header button { padding:8px 12px; border:1px solid var(--border); border-radius:6px; color:inherit; background:var(--surface); cursor:pointer; }
  .saved-data-tools button:disabled, .saved-data-header button:disabled { opacity:.6; cursor:default; }
  .saved-data-tools input { max-width:100%; min-width:0; box-sizing:border-box; padding:8px; border:1px solid var(--border); border-radius:6px; color:var(--fg); background:var(--bg); }
  .saved-data-tools label { display:grid; gap:4px; min-width:0; }
  .saved-data-tools [role=alert], .saved-data-tools [role=status] { overflow-wrap:anywhere; }
  .saved-data-tools .saved-data-confirm { flex-basis:100%; }
  /* D-289 — the pack group. Sized from the panel's own scale, not fresh
     literals: an unstyled class inside a styled panel is the defect
     bootstrap-stats-route records, where markup rendered flush and as
     bullet points beside neighbours that did not. */
  .saved-data-pack-heading { margin:16px 0 2px; font-size:13px; font-weight:650; }
  .saved-data-pack-help { margin:0 0 4px; color:var(--muted, #667085); font-size:13px; }
  .saved-data-pack-views li[data-view-hidden] { opacity:.62; }
  .saved-data-pack-name { flex:1; min-width:120px; overflow-wrap:anywhere; padding:10px 0; }
  .saved-data-pack-origin { color:var(--muted, #667085); font-size:12px; white-space:nowrap; }
  /* D-300 — a pack update replaced a view the owner had set up. */
  .saved-data-retired { display:flex; flex-direction:column; gap:8px; margin:12px 0; }
  .saved-data-retired-item { padding:10px 12px; border:1px solid var(--warn, #b54708); border-left-width:3px;
    border-radius:9px; background:var(--warn-bg, transparent); }
  .saved-data-retired-item p { margin:0 0 8px; overflow-wrap:anywhere; }
  .saved-data-opened { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .saved-data-modified { font-weight:600; }
  .saved-data-alert { display:flex; flex-wrap:wrap; gap:8px; align-items:center; flex-basis:100%; min-width:0; }
  .saved-data-alert span { overflow-wrap:anywhere; }
  .saved-data-alert-state { display:inline-flex; padding:4px 8px; border:1px solid var(--border); border-radius:6px; font-size:12px; font-weight:600; }
  .saved-data-alert-state[data-alert-state=on] { color:var(--accent); background:var(--surface-subtle, var(--surface)); }
  .saved-data-alert-state[data-alert-state=waiting] { background:var(--warn-soft); }
  .saved-data-alert-detail { flex-basis:100%; color:var(--muted); font-size:12px; }
  .saved-data-alert-help { flex-basis:100%; margin:0 0 8px; color:var(--muted); font-size:13px; }
  .saved-data-opened > .saved-data-alert-help { margin-top:0; }
  .saved-data-conflict { border:1px solid var(--border); border-radius:8px; padding:12px; overflow-wrap:anywhere; }
  @media (max-width:600px) { .saved-data-tools li a { flex-basis:100%; } }
`;

export const bootstrapSavedDataRoute = (opts: SavedDataRouteOptions) => {
  const doc = opts.document ?? document;
  if (doc.head.querySelector('style[data-saved-data-styles]') === null) {
    const style = doc.createElement('style');
    style.setAttribute('data-saved-data-styles', '');
    style.textContent = STYLES;
    doc.head.appendChild(style);
  }
  const frame = doc.createElement('div');
  frame.setAttribute('data-saved-data-route', '');
  const tools = doc.createElement('div');
  const content = doc.createElement('div');
  tools.className = 'saved-data-tools';
  tools.setAttribute('data-saved-data-views', '');
  frame.appendChild(tools);
  frame.appendChild(content);
  opts.root.appendChild(frame);
  let child: DataRoute | null = null;
  let disposed = false;
  let views: SavedDataView[] = [];
  /** D-300 — views a pack update replaced that the owner had set up. */
  let retired: SavedDataView[] = [];
  let listing = false;
  let listError: string | null = null;
  let actionError: string | null = null;
  let notice: string | null = null;
  let busy = false;
  let pendingAlertId: string | null = null;
  let edit: { kind: 'create' | 'rename'; view: SavedDataView | null; name: string } | null = null;
  let deleting: SavedDataView | null = null;
  let listOpen = false;
  let listSeq = 0;
  let loadSeq = 0;
  let loadError: string | null = null;
  let selectedView: SavedDataView | null = null;
  // A newer revision stays separate until the owner explicitly reviews/replaces it.
  let conflictView: SavedDataView | null = null;
  let lastDefinition: SavedDataViewDefinition | null = null;
  let pending: Promise<void> = Promise.resolve();

  const focus = (selector: string): void => tools.querySelector?.<HTMLElement>(selector)?.focus();
  // A completed view write must not pull focus out of a Data action started
  // while it was settling. Native disabled controls may leave focus on body.
  const canFocusCompletion = (): boolean => doc.activeElement == null
    || doc.activeElement === doc.body || tools.contains?.(doc.activeElement) === true;
  const chrome = opts.chrome ?? 'data';
  /** ⛔ THE SAVE CONTROL FOLLOWS THE CHILD, NOT THE CHROME. It is hidden only
   *  when there is no data surface mounted to save — bare `#views`, which is a
   *  list and nothing else. Keying it on `selectedView === null` instead looked
   *  equivalent and was not: a bookmark DELETED IN ANOTHER BROWSER detaches to
   *  `selectedView = null` while its filters stay on screen, and hiding the
   *  button there strands the owner with settings they can see, cannot save,
   *  and lose on the next navigation. Caught by the e2e, not by a unit test. */
  const render = (): void => {
    if (disposed) return;
    const active = doc.activeElement as HTMLInputElement | null;
    const nameFocused = active?.hasAttribute('data-view-name') === true;
    const selection = nameFocused ? [active.selectionStart, active.selectionEnd] : null;
    const action = active?.getAttribute('data-view-action');
    const id = active?.getAttribute('data-view-id');
    const definition = child?.currentView() ?? null;
    const canSave = !busy && definition !== null;
    const modified = selectedView !== null && lastDefinition !== null
      && !sameSavedDataViewDefinition(lastDefinition, selectedView.definition);
    // D-289 — two groups, because they answer to different people: the owner
    // owns their own views outright, and a pack owns its views' name and
    // settings. Mixing them would put Rename/Delete beside rows where those
    // controls are refused. Hidden pack views stay LISTED (sorted last) — the
    // only way back from Hide is a row you can still see.
    const ownViews = views.filter((view) => view.pack === undefined);
    const packViews = views.filter((view) => view.pack !== undefined)
      .sort((a, b) => Number(a.hidden ?? false) - Number(b.hidden ?? false));
    listOpen = tools.querySelector?.('details')?.open ?? listOpen;
    tools.innerHTML = `
      <header class="saved-data-header"><h1 class="data-title" data-recued-data-route-heading>${chrome === 'views' ? 'Saved views' : 'Data'}</h1>
        ${child === null ? '' : `<button type="button" data-view-action="new" ${canSave ? '' : 'disabled'}>${selectedView === null ? 'Save current view' : 'Save as new'}</button>`}
        ${chrome === 'data' ? `<a class="saved-data-views-link" href="${e(serializeShellRoute('views'))}">Saved views</a>` : ''}</header>
      ${chrome === 'views' && retired.length > 0 && opts.savedViews.resolveRetired !== undefined
        ? `<section class="saved-data-retired" data-view-retired-list aria-label="Views a pack update replaced">
        ${retired.map((view) => `<div class="saved-data-retired-item" data-view-retired="${e(view.id)}" role="alert">
          <p>⚠ The ${e(view.pack?.slug ?? 'pack')} update replaced “${e(view.name)}”, and you had ${e(retiredSetup(view))}.</p>
          ${(view.retired?.replacements ?? []).map((next) => `<button type="button" data-view-action="retired-apply" data-view-id="${e(view.id)}" data-view-to="${e(next.id)}" ${busy ? 'disabled' : ''}>Set up “${e(next.name)}” the same way</button>`).join('')}
          <button type="button" data-view-action="retired-keep" data-view-id="${e(view.id)}" ${busy ? 'disabled' : ''}>Keep it as my own view</button>
          <button type="button" data-view-action="retired-dismiss" data-view-id="${e(view.id)}" ${busy ? 'disabled' : ''}>Dismiss</button>
        </div>`).join('')}
      </section>` : ''}
      ${chrome === 'data' ? '' : `<details ${listOpen ? 'open' : ''}><summary>Saved views${views.length ? ` (${views.length})` : ''}</summary>
        <p>Open a view to reload its current records on this server.</p>
        ${views.some(view => savedDataViewSupportsAlerts(view.definition)) ? '<p>Alerts notify you when additional tasks or records match the saved filters. Checks run every minute while this server runs. Enabling or resuming starts from the current matches.</p>' : ''}
        ${listing ? '<p role="status">Loading saved views…</p>' : ''}
        ${listError === null ? '' : `<p role="alert">${e(listError)}</p>`}
        <button type="button" data-view-action="refresh" ${listing || busy ? 'disabled' : ''}>Refresh saved views</button>
        ${views.length === 0 && !listing && listError === null ? '<p>No saved views yet.</p>' : ''}
        <ul>${ownViews.map((view) => `<li>
          <a href="${e(savedDataViewHref(view.id))}" data-view-action="open" data-view-id="${e(view.id)}">${e(view.name)}</a>
          <button type="button" data-view-action="rename" data-view-id="${e(view.id)}" aria-label="Rename ${e(view.name)}" ${busy ? 'disabled' : ''}>Rename</button>
          <button type="button" data-view-action="delete" data-view-id="${e(view.id)}" aria-label="Delete ${e(view.name)}" ${busy ? 'disabled' : ''}>Delete</button>
          ${alertControls(view, busy, pendingAlertId)}
        </li>`).join('')}</ul>
        ${packViews.length === 0 ? '' : `<h3 class="saved-data-pack-heading">From packs</h3>
        <p class="saved-data-pack-help">A pack sets these names and settings, and resets them when it updates. Hide one to drop it from your list — hiding is yours and survives the update.</p>
        <ul class="saved-data-pack-views">${packViews.map((view) => `<li ${view.hidden ? 'data-view-hidden=""' : ''}>
          ${view.hidden
            ? `<span class="saved-data-pack-name">${e(view.name)}</span>`
            : `<a href="${e(savedDataViewHref(view.id))}" data-view-action="open" data-view-id="${e(view.id)}">${e(view.name)}</a>`}
          <span class="saved-data-pack-origin">From ${e(view.pack!.slug)}</span>
          ${view.hidden ? '<span class="saved-data-pack-origin">Hidden</span>' : ''}
          <button type="button" data-view-action="hide" data-view-id="${e(view.id)}" aria-label="${view.hidden ? 'Show' : 'Hide'} ${e(view.name)}" ${busy ? 'disabled' : ''}>${pendingAlertId === view.id ? '…' : view.hidden ? 'Show' : 'Hide'}</button>
          ${view.hidden ? '' : alertControls(view, busy, pendingAlertId)}
        </li>`).join('')}</ul>`}
      </details>`}
      ${selectedView === null ? '' : `<div class="saved-data-opened"><p>Opened from <a href="${e(savedDataViewHref(selectedView.id))}" data-view-action="open" data-view-id="${e(selectedView.id)}">${e(selectedView.name)}</a></p>
        ${modified ? '<span class="saved-data-modified" data-view-modified>Modified</span>' : ''}
        <button type="button" data-view-action="update" ${canSave && modified && conflictView === null ? '' : 'disabled'}>Update view</button>
        ${alertControls(selectedView, busy || conflictView !== null, pendingAlertId, true)}
        ${savedDataViewSupportsAlerts(selectedView.definition) ? `<p class="saved-data-alert-help">${modified
          ? 'Your unsaved filter changes are not monitored. Update view to use them for alerts.'
          : 'Checks run every minute while this server is running. Turning alerts on or resuming starts from the current matches.'}</p>` : ''}</div>`}
      ${conflictView === null ? '' : `<div class="saved-data-conflict" role="group" aria-label="Review saved view changes">
        <p>This view changed in another browser. Review its saved settings before replacing them, or save your settings as a new view.</p>
        <p><strong>Currently saved as “${e(conflictView.name)}”:</strong> ${e(settingsSummary(conflictView.definition))}</p>
        ${savedDataViewSupportsAlerts(conflictView.definition) ? `<p>${e(alertSummary(conflictView))}</p>` : ''}
        ${lastDefinition === null ? '' : `<p><strong>Your settings:</strong> ${e(settingsSummary(lastDefinition))}</p>`}
        <button type="button" data-view-action="replace" ${canSave ? '' : 'disabled'}>Replace saved settings</button>
      </div>`}
      ${edit === null ? '' : `<form class="saved-data-editor" data-view-editor>
        <label>View name<input data-view-name name="view-name" maxlength="${SAVED_DATA_VIEW_NAME_LIMIT}" value="${e(edit.name)}" required ${busy ? 'disabled' : ''}></label>
        <button type="submit" data-view-action="save" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : 'Save view'}</button>
        <button type="button" data-view-action="cancel" ${busy ? 'disabled' : ''}>Cancel</button>
      </form>`}
      ${deleting === null ? '' : `<div class="saved-data-confirm" role="group" aria-label="Delete saved view">
        <p>Delete “${e(deleting.name)}”? Its records will stay.</p>
        <button type="button" data-view-action="confirm-delete" ${busy ? 'disabled' : ''}>${busy ? 'Deleting…' : 'Delete view'}</button>
        <button type="button" data-view-action="cancel" ${busy ? 'disabled' : ''}>Cancel</button>
      </div>`}
      ${actionError === null ? '' : `<p role="alert" tabindex="-1" data-view-error>${e(actionError)}</p>`}
      ${notice === null ? '' : `<p role="status" tabindex="-1" data-view-notice>${e(notice)}</p>`}`;
    if (nameFocused) {
      const input = tools.querySelector<HTMLInputElement>('[data-view-name]');
      input?.focus({ preventScroll: true });
      if (selection !== null) input?.setSelectionRange(selection[0] ?? 0, selection[1] ?? 0);
    } else if (action !== null && action !== undefined) {
      const candidates = Array.from(tools.querySelectorAll<HTMLElement>('[data-view-action]'));
      candidates.find((element) => element.getAttribute('data-view-action') === action
        && element.getAttribute('data-view-id') === id)?.focus({ preventScroll: true });
    }
  };

  const refreshViews = async (): Promise<void> => {
    const seq = ++listSeq;
    listing = true;
    listError = null;
    render();
    try {
      const result = await opts.savedViews.list();
      if (disposed || seq !== listSeq) return;
      views = result.views;
      retired = result.retired ?? [];
      if (selectedView !== null) {
        const latest = views.find((view) => view.id === selectedView?.id);
        if (latest === undefined) {
          notice = `“${selectedView.name}” was deleted in another browser. You can save your current settings as a new view.`;
          selectedView = null; conflictView = null;
          child?.detachSavedView();
        } else if (latest.revision > selectedView.revision) conflictView = latest;
        else if (latest.revision === selectedView.revision) selectedView = latest;
      }
      if (edit?.view != null) {
        const latest = views.find((view) => view.id === edit?.view?.id);
        if (latest === undefined) edit = null;
        else if (latest.revision !== edit.view.revision) {
          edit = { ...edit, view: latest };
          actionError = `The current name is “${latest.name}”. Review your name and save again.`;
        }
      }
      if (deleting !== null) deleting = views.find((view) => view.id === deleting?.id) ?? null;
    } catch (error) {
      if (disposed || seq !== listSeq) return;
      listError = humanizeRpcError(error);
    } finally {
      if (!disposed && seq === listSeq) { listing = false; render(); }
    }
  };
  const showLoadError = (message: string): void => {
    child?.dispose();
    child = null;
    loadError = message;
    content.innerHTML = `<section data-recued-data-route><p role="alert">${e(message)}</p>
      <button type="button" data-view-load-retry>Retry saved view</button> <a href="#data">Browse Data</a></section>`;
    render();
  };
  const mountData = (view?: SavedDataView): DataRoute => {
    child?.dispose();
    child = null;
    content.innerHTML = '';
    selectedView = view ?? null;
    conflictView = null; lastDefinition = null;
    const options: BootstrapDataRouteOptions = { ...opts, root: content, hideHeading: true,
      onViewChange: (definition) => {
        if (definition !== null) lastDefinition = definition;
        opts.onViewChange?.(definition);
        render();
      },
    };
    if (view !== undefined) {
      options.savedView = view;
      options.initialTab = view.definition.tab;
      delete options.initialEntityId;
      delete options.initialCollectionSlug;
      if ('collection_slug' in view.definition && view.definition.collection_slug !== null) {
        options.initialCollectionSlug = view.definition.collection_slug;
      }
    }
    child = bootstrapDataRoute(options);
    render();
    return child;
  };
  const loadView = async (): Promise<void> => {
    const id = opts.savedViewId;
    if (id === undefined) {
      // ⛔ `#views` WITH NO ID MOUNTS NOTHING UNDERNEATH. The bare views surface
      // is the list; mounting a Data route beneath it would run four collection
      // reads to paint a Contacts table nobody asked for, under a heading that
      // says "Saved views".
      if (chrome === 'views') { render(); return; }
      await mountData().whenLoaded();
      return;
    }
    const seq = ++loadSeq;
    loadError = null;
    child?.dispose();
    child = null;
    content.innerHTML = '<section data-recued-data-route aria-busy="true"><p role="status">Loading saved view…</p></section>';
    render();
    try {
      const { view } = await opts.savedViews.get({ id });
      if (disposed || seq !== loadSeq) return;
      if (view === null) { showLoadError('This server does not have that saved view any more.'); return; }
      const definition = parseSavedDataViewDefinition(view.definition);
      if (view.id !== id || definition === null) { showLoadError('This saved view has settings this version of Recued cannot open.'); return; }
      // ⛔ A PRE-D-290 "Today" VIEW MEANT "take me to Today", and Today is its
      // own route now. Mounting it here would set `initialTab = 'today'`, which
      // is no longer a `DataTabId`, so the Data route would fall back to
      // Contacts — the owner presses "My day" and lands on their contact list,
      // with nothing anywhere saying why. Send them where they meant to go.
      if (definition.tab === 'today') {
        const target = serializeShellRoute('today');
        const view_ = doc.defaultView;
        if (view_ !== null && view_ !== undefined) view_.location.hash = target;
        return;
      }
      await mountData({ ...view, definition }).whenLoaded();
    } catch (error) {
      if (!disposed && seq === loadSeq) showLoadError(humanizeRpcError(error));
    }
  };

  const save = async (): Promise<void> => {
    if (busy || edit === null) return;
    const editing = edit;
    const definition = child?.currentView();
    if (editing.kind === 'create' && (definition === null || definition === undefined)) {
      actionError = 'Go back to a list or a search before you save a view.'; render(); return;
    }
    if (!editing.name.trim()) { actionError = 'Give this view a name.'; render(); return; }
    busy = true;
    actionError = null;
    render();
    try {
      const result = editing.view !== null
        ? await opts.savedViews.rename({ id: editing.view.id, expected_revision: editing.view.revision, name: editing.name })
        : await opts.savedViews.create({ name: editing.name, definition: definition! });
      if (disposed) return;
      views = [...views.filter((view) => view.id !== result.view.id), result.view]
        .sort((a, b) => a.name.localeCompare(b.name));
      listSeq += 1;
      listing = false;
      edit = null;
      if (selectedView?.id === result.view.id) {
        if (editing.view?.revision === selectedView.revision) {
          selectedView = result.view; conflictView = null;
          child?.bindSavedView(result.view);
        } else conflictView = result.view;
      }
      notice = `Saved “${result.view.name}”. Open it from Saved views.`;
    } catch (error) {
      if (!disposed) actionError = humanizeRpcError(error);
    } finally {
      if (!disposed) {
        const returnFocus = canFocusCompletion();
        busy = false; render();
        if (edit === null && returnFocus) focus('[data-view-notice]');
      }
    }
  };
  const update = async (replace: boolean): Promise<void> => {
    const base = replace ? conflictView : selectedView;
    const definition = child?.currentView();
    if (busy || base === null || definition == null
      || (!replace && (conflictView !== null || sameSavedDataViewDefinition(definition, base.definition)))) return;
    if (child?.hasInFlightWork()) {
      actionError = 'Finish what you are doing before you change a saved view.'; render(); return;
    }
    busy = true; actionError = null; notice = null;
    render();
    try {
      // Freeze both the reviewed revision and settings before awaiting the write.
      const { view } = await opts.savedViews.update({ id: base.id, expected_revision: base.revision, definition });
      if (disposed) return;
      views = [...views.filter((entry) => entry.id !== view.id), view].sort((a, b) => a.name.localeCompare(b.name));
      listSeq += 1; listing = false;
      selectedView = view; conflictView = null;
      child?.bindSavedView(view);
      notice = `Updated “${view.name}”. Its bookmark stays the same.`;
    } catch (error) {
      if (disposed) return;
      actionError = humanizeRpcError(error);
      const code = classifyRpcError(error).code;
      if (code === 'conflict' || code === 'not_found') await refreshViews();
    } finally {
      if (!disposed) {
        const returnFocus = canFocusCompletion();
        busy = false; render();
        if (notice !== null && returnFocus) focus('[data-view-notice]');
      }
    }
  };
  const remove = async (): Promise<void> => {
    if (busy || deleting === null) return;
    const view = deleting;
    busy = true;
    actionError = null;
    render();
    try {
      const result = await opts.savedViews.delete({ id: view.id, expected_revision: view.revision });
      if (disposed) return;
      if (!result.deleted) throw new Error('The view was not deleted. Load your saved views again and try once more.');
      views = views.filter((entry) => entry.id !== view.id);
      listSeq += 1;
      listing = false;
      deleting = null;
      notice = `Deleted “${view.name}”.`;
      if (selectedView?.id === view.id) {
        selectedView = null; conflictView = null;
        child?.detachSavedView();
      }
    } catch (error) {
      if (!disposed) actionError = humanizeRpcError(error);
    } finally {
      if (!disposed) {
        const returnFocus = canFocusCompletion();
        busy = false; render();
        if (deleting === null && returnFocus) focus('[data-view-notice]');
      }
    }
  };
  /** D-289 — the owner's dismissal of a pack view.
   *
   *  ⛔ HIDE, NOT DELETE, AND THE DIFFERENCE IS WHO OWNS THE ROW. The pack sets
   *  the name and settings and re-asserts them on every update, so a Delete
   *  here would be undone by the next install — D-145 PA10's rule is not to
   *  render a control the substrate reverses. Hiding is the owner's, and the
   *  install path steps around it. */
  const toggleHidden = async (view: SavedDataView): Promise<void> => {
    if (busy || view.pack === undefined) return;
    busy = true; pendingAlertId = view.id; actionError = null; notice = null; render();
    const hidden = view.hidden !== true;
    try {
      const { view: saved } = await opts.savedViews.update({
        id: view.id, expected_revision: view.revision, hidden,
      });
      views = views.map((entry) => (entry.id === saved.id ? saved : entry));
      notice = hidden
        ? `Hid “${saved.name}”. It stays hidden when ${view.pack.slug} updates.`
        : `Showing “${saved.name}” again.`;
    } catch (error) {
      actionError = humanizeRpcError(error);
    } finally {
      busy = false; pendingAlertId = null; render();
    }
  };

  /** D-300 — the owner's answer to a view a pack update replaced. */
  const resolveRetiredView = async (
    view: SavedDataView,
    action: 'retired-apply' | 'retired-keep' | 'retired-dismiss',
    toId: string | null,
  ): Promise<void> => {
    const resolve = opts.savedViews.resolveRetired;
    if (busy || resolve === undefined) return;
    const next = view.retired?.replacements.find((replacement) => replacement.id === toId);
    if (action === 'retired-apply' && next === undefined) return;
    busy = true; actionError = null; notice = null; render();
    try {
      await resolve(action === 'retired-apply'
        ? { id: view.id, action: 'apply', to_id: next!.id }
        : { id: view.id, action: action === 'retired-keep' ? 'keep' : 'dismiss' });
      if (disposed) return;
      retired = retired.filter((entry) => entry.id !== view.id);
      notice = action === 'retired-apply'
        ? `Set up “${next!.name}” the way “${view.name}” was.`
        : action === 'retired-keep'
          ? `Kept “${view.name}” as your own view.`
          : `Dismissed “${view.name}”.`;
    } catch (error) {
      if (disposed) return;
      actionError = humanizeRpcError(error);
    } finally {
      if (!disposed) {
        busy = false;
        pending = refreshViews();
      }
    }
  };

  const toggleAlert = async (view: SavedDataView): Promise<void> => {
    if (busy || !savedDataViewSupportsAlerts(view.definition)) return;
    busy = true; pendingAlertId = view.id; actionError = null; notice = null; render();
    const enabled = !view.alert?.enabled;
    try {
      const { view: saved } = await opts.savedViews.update({ id: view.id, expected_revision: view.revision,
        // D-269 — the SERVER's zone. This alert is evaluated by a server-side
        // sweep with no client attached, so the browser's zone was never right;
        // and because the value is FROZEN at first enable, an alert switched on
        // from a laptop abroad carried the travel zone for good.
        alert: { enabled, time_zone: view.alert?.time_zone ?? stampZone(opts.serverTimeZone) },
      });
      if (disposed) return;
      views = [...views.filter(entry => entry.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name));
      listSeq += 1; listing = false;
      if (selectedView?.id === saved.id) {
        if (selectedView.revision === view.revision) {
          selectedView = saved; conflictView = null; child?.bindSavedView(saved);
        } else conflictView = saved;
      }
      notice = enabled ? `Alerts on for “${saved.name}”. You’ll be notified when another ${saved.definition.tab === 'records' ? 'record' : 'task'} matches its saved filters.`
        : `Alerts paused for “${saved.name}”.`;
    } catch (error) {
      if (disposed) return;
      actionError = humanizeRpcError(error);
      const code = classifyRpcError(error).code;
      if (code === 'conflict' || code === 'not_found') await refreshViews();
    } finally {
      if (!disposed) {
        const returnFocus = canFocusCompletion();
        busy = false; pendingAlertId = null; render();
        if (notice !== null && returnFocus) focus('[data-view-notice]');
        else if (actionError !== null && returnFocus) focus('[data-view-error]');
      }
    }
  };
  const click = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    const control = target?.closest<HTMLElement>('[data-view-action]');
    if (control === null || control === undefined) return;
    const action = control.getAttribute('data-view-action');
    if (action === 'save') return; // native form submission also supports Enter
    if (busy) { event.preventDefault(); return; }
    if (action === 'open') {
      if (child !== null && (child.hasInFlightWork() || child.currentView() === null)) {
        event.preventDefault(); actionError = 'Finish or close what you are doing before you open a saved view.'; render();
      } else if (doc.defaultView?.location.hash === control.getAttribute('href')) {
        event.preventDefault(); pending = loadView();
      }
      return;
    }
    event.preventDefault();
    actionError = null;
    notice = null;
    if (action === 'refresh') { pending = refreshViews(); return; }
    if (action === 'update' || action === 'replace') { pending = update(action === 'replace'); return; }
    if (action === 'cancel') { edit = null; deleting = null; render(); focus('[data-view-action="new"]'); return; }
    if (action === 'confirm-delete') { pending = remove(); return; }
    if (action === 'retired-apply' || action === 'retired-keep' || action === 'retired-dismiss') {
      const replaced = retired.find((entry) => entry.id === control.getAttribute('data-view-id'));
      if (replaced) pending = resolveRetiredView(replaced, action, control.getAttribute('data-view-to'));
      return;
    }
    const view = views.find((entry) => entry.id === control.getAttribute('data-view-id'));
    if (action === 'hide') {
      if (view) pending = toggleHidden(view);
      return;
    }
    if (action === 'alert') {
      const targetView = control.closest('.saved-data-opened') !== null ? selectedView : view;
      if (targetView) pending = toggleAlert(targetView);
      return;
    }
    if (action === 'new') {
      if (child?.currentView() == null || child.hasInFlightWork()) {
        actionError = 'Go back to a list or a search before you save a view.'; render(); return;
      }
      edit = { kind: 'create', view: null, name: '' }; deleting = null;
    } else if (view !== undefined && action === 'rename') {
      edit = { kind: 'rename', view, name: view.name }; deleting = null;
    } else if (view !== undefined && action === 'delete') {
      deleting = view; edit = null;
    }
    render();
    focus(edit === null ? '[data-view-action="confirm-delete"]' : '[data-view-name]');
  };
  const input = (event: Event): void => {
    const target = event.target as HTMLInputElement | null;
    if (edit !== null && target?.hasAttribute('data-view-name')) edit.name = target.value;
  };
  const submit = (event: Event): void => { event.preventDefault(); pending = save(); };
  const keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || busy || (edit === null && deleting === null)) return;
    event.preventDefault(); edit = null; deleting = null; actionError = null;
    render(); focus('[data-view-action="new"]');
  };
  const retry = (event: Event): void => {
    if ((event.target as HTMLElement | null)?.hasAttribute('data-view-load-retry')) pending = loadView();
  };
  tools.addEventListener('click', click);
  tools.addEventListener('input', input);
  tools.addEventListener('submit', submit);
  tools.addEventListener('keydown', keydown);
  content.addEventListener('click', retry);
  pending = Promise.all([loadView(), refreshViews()]).then(() => {});
  return {
    whenLoaded: async () => { await pending; await child?.whenLoaded(); },
    getRecoveryContextFreshness: (): 'current' | 'unavailable' =>
      disposed || child === null || loadError !== null || listError !== null
        ? 'unavailable' : child.getRecoveryContextFreshness(),
    refresh: () => {
      const listing = refreshViews();
      if (loadError !== null) pending = Promise.all([loadView(), listing]).then(() => {});
      else {
        child?.refresh();
        pending = Promise.all([listing, child?.whenLoaded()]).then(() => {});
      }
    },
    hasInFlightWork: () => busy || child?.hasInFlightWork() === true,
    inFlightWorkPrompt: () => busy ? 'You are part-way through changing a saved view. Leave anyway?' : child?.inFlightWorkPrompt() ?? null,
    hasUnsavedChanges: () => child?.hasUnsavedChanges() === true,
    unsavedChangesPrompt: () => child?.unsavedChangesPrompt() ?? null,
    dispose: () => {
      disposed = true; listSeq += 1; loadSeq += 1;
      child?.dispose();
      tools.removeEventListener('click', click); tools.removeEventListener('input', input);
      tools.removeEventListener('submit', submit); content.removeEventListener('click', retry);
      tools.removeEventListener('keydown', keydown);
      frame.remove();
    },
  };
};
