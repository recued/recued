import type {
  RecordsChangeFeed,
  RecordsEventPointer,
  RecordsFriendlyRecord,
  RecordsGlobalQuotaSnapshot,
  RecordsKindSummary,
  RecordsNamespaceView,
  RecordsOutboxOverview,
  RecordsOwnerRecordDiagnostics,
  RecordsRetentionPolicy,
  SavedDataViewReview,
} from '@recued/contracts';
// One byte formatter for the whole product — B / KB / MB / GB / TB. These
// numbers are quota ceilings (`1_000_000`) and payload totals, and both read as
// digit soup at `.toLocaleString()` width.
import { formatPressureBytes, isRecordsQuotaUnlimited, recordFieldLabel } from '@recued/contracts';
import { e, renderReferenceLink } from '@recued/ui-shared';
import { recordsFieldLabel, recordsViewHasDraft, renderRecordsViewControls, type RecordsBrowseState } from './records-view-controls.js';

export const RECORDS_SELECT_NAMESPACE_ACTION = 'records-select-namespace';
export const RECORDS_SELECT_KIND_ACTION = 'records-select-kind';
export const RECORDS_OPEN_RECORD_ACTION = 'records-open-record';
export const RECORDS_CLOSE_RECORD_ACTION = 'records-close-record';
export const RECORDS_DELETE_RECORD_ACTION = 'records-delete-record';
export const RECORDS_CONFIRM_DELETE_ACTION = 'records-confirm-delete';
export const RECORDS_CANCEL_DELETE_ACTION = 'records-cancel-delete';
export const RECORDS_EXPORT_PACK_ACTION = 'records-export-pack';
export const RECORDS_EXPORT_KIND_ACTION = 'records-export-kind';
export const RECORDS_EXPORT_PACK_CSV_ACTION = 'records-export-pack-csv';
export const RECORDS_EXPORT_KIND_CSV_ACTION = 'records-export-kind-csv';
export const RECORDS_OPEN_REFERENCE_ACTION = 'records-open-reference';
export const RECORDS_TOGGLE_OUTBOX_ACTION = 'records-toggle-outbox';
export const RECORDS_REFRESH_OUTBOX_ACTION = 'records-refresh-outbox';
export const RECORDS_RETIRE_EVENT_ACTION = 'records-retire-event';
export const RECORDS_CONFIRM_RETIRE_EVENT_ACTION = 'records-confirm-retire-event';
export const RECORDS_CANCEL_RETIRE_EVENT_ACTION = 'records-cancel-retire-event';
export const RECORDS_TOGGLE_CHANGES_ACTION = 'records-toggle-changes';
export const RECORDS_REFRESH_CHANGES_ACTION = 'records-refresh-changes';
export const RECORDS_MARK_REVIEWED_ACTION = 'records-mark-reviewed';
export const RECORDS_PURGE_ACTION = 'records-purge';
export const RECORDS_CONFIRM_PURGE_ACTION = 'records-confirm-purge';
export const RECORDS_CANCEL_PURGE_ACTION = 'records-cancel-purge';
export const RECORDS_NAMESPACE_ATTR = 'data-records-namespace';
export const RECORDS_KIND_ATTR = 'data-records-kind';
export const RECORDS_KIND_PANEL_ATTR = 'data-records-kind-panel';
export const RECORDS_ID_ATTR = 'data-records-id';
export const RECORDS_EVENT_ID_ATTR = 'data-records-event-id';
export const RECORDS_PURGE_CONFIRMATION_ATTR = 'data-records-purge-confirmation';

export type RecordsExportAction =
  | typeof RECORDS_EXPORT_PACK_ACTION
  | typeof RECORDS_EXPORT_PACK_CSV_ACTION
  | typeof RECORDS_EXPORT_KIND_ACTION
  | typeof RECORDS_EXPORT_KIND_CSV_ACTION;

export interface RecordsExplorerState extends RecordsBrowseState {
  namespaces: readonly RecordsNamespaceView[];
  globalQuota: RecordsGlobalQuotaSnapshot | null;
  selectedNamespace: RecordsNamespaceView | null;
  kinds: readonly RecordsKindSummary[];
  selectedKind: string | null;
  records: readonly RecordsFriendlyRecord[];
  detail: RecordsFriendlyRecord | null;
  diagnostics: RecordsOwnerRecordDiagnostics | null;
  outbox: RecordsOutboxOverview | null;
  outboxOpen: boolean;
  outboxRefreshing: boolean;
  /** P2/F2 — changes since the bound saved view's review mark, or the most
   *  recent page when nothing is marked yet. `null` before the first read. */
  changes: RecordsChangeFeed | null;
  changesOpen: boolean;
  changesRefreshing: boolean;
  /** The bound saved view's mark. `null` when no Records view is bound, which
   *  is also when {@link canMarkReviewed} is false — the mark has nowhere to live. */
  reviewMark: SavedDataViewReview | null;
  canMarkReviewed: boolean;
  markingReviewed: boolean;
  retention: Readonly<Record<string, RecordsRetentionPolicy>>;
  loading: boolean;
  loadingNamespaceKey: string | null;
  loadingKind: string | null;
  error?: string;
  deletePending: boolean;
  deleting: boolean;
  exporting: boolean;
  exportingAction: RecordsExportAction | null;
  /** The shared importer is uploading, running or refreshing this workspace. */
  importBusy?: boolean;
  retiringEventId: string | null;
  retiringEventBusy: boolean;
  purgePending: boolean;
  purgeConfirmation: string;
  purging: boolean;
  canDelete: boolean;
  canExport: boolean;
  canRetireEvents: boolean;
  canPurge: boolean;
}

const namespaceKey = (ns: RecordsNamespaceView): string =>
  `${ns.owner.publisher}/${ns.owner.pack_slug}`;

/** The pack as the owner knows it: its manifest name ("Decision Log") when the server sent one,
 *  else its slug made readable ("Decision log"). ⛔ A label only — `namespaceKey` stays the
 *  identity (the record header, the purge confirmation, every data attribute). */
const packLabel = (ns: RecordsNamespaceView): string => {
  const name = typeof ns.display_name === 'string' ? ns.display_name.trim() : '';
  return name !== '' ? name : recordFieldLabel(ns.owner.pack_slug);
};

const RECORDS_KIND_PANEL_ID = 'recued-records-kind-panel';
const recordsKindTabId = (kind: string): string =>
  `recued-records-kind-tab-${encodeURIComponent(kind)}`;

const recordsControlsLocked = (state: RecordsExplorerState): boolean =>
  state.importBusy === true
  || state.deleting
  || state.retiringEventBusy
  || state.purging
  || state.loadingNamespaceKey !== null
  || state.loadingKind !== null;

const getPath = (record: RecordsFriendlyRecord, path: string): unknown => {
  let current: unknown = record;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const displayValue = (value: unknown, longText = false): string => {
  if (value === null) return 'null';
  if (value === undefined) return '—';
  const rendered = typeof value === 'string'
    ? value
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  return longText && rendered.length > 100 ? `${rendered.slice(0, 100)}…` : rendered;
};

const stateLabel = (namespace: RecordsNamespaceView): string => {
  const state = namespace.state;
  if (state.state === 'ready') return `ready · v${state.version}`;
  if (state.state === 'migrating') return `migrating · v${state.from_version} → v${state.target_version}`;
  if (state.state === 'orphaned') return `has no owner · last v${state.last_version}`;
  return 'does not add up · needs fixing';
};

const quotaPercent = (used: number, limit: number): string =>
  limit === 0 ? (used === 0 ? '0' : '∞') : `${Math.round((used / limit) * 100)}%`;

const count = (n: number): string => n.toLocaleString();

/** "12 / 5,000,000 · 0%" against a limit; "12 · no limit" when none is set. ⛔ An unset limit
 *  arrives as `RECORDS_QUOTA_NO_LIMIT`, a number that printed as "9,007,199,254,740,991" rows
 *  and "8192.00 TB" (the global limits have no default). */
const quotaUsage = (used: number, limit: number, format: (n: number) => string): string =>
  isRecordsQuotaUnlimited(limit)
    ? `${format(used)} <small>no limit</small>`
    : `${format(used)} / ${format(limit)} <small>${quotaPercent(used, limit)}</small>`;

const renderNamespaceNav = (state: RecordsExplorerState): string => {
  if (state.namespaces.length === 0) {
    return '<p class="records-empty">No pack-owned Records are installed or retained.</p>';
  }
  const selected = state.selectedNamespace === null ? '' : namespaceKey(state.selectedNamespace);
  return `<nav class="records-namespace-nav" aria-label="Records packs">
    ${state.namespaces.map((namespace) => {
      const key = namespaceKey(namespace);
      const loading = state.loadingNamespaceKey === key;
      return `<button type="button" class="records-namespace" data-active="${key === selected ? 'true' : 'false'}"
        ${recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}
        ${loading ? 'aria-busy="true"' : ''}
        data-action="${RECORDS_SELECT_NAMESPACE_ACTION}" ${RECORDS_NAMESPACE_ATTR}="${e(key)}">
        <strong>${e(packLabel(namespace))}</strong>
        <span>by ${e(namespace.owner.publisher)}</span>
        <small data-state="${e(namespace.state.state)}">${e(stateLabel(namespace))}</small>
      </button>`;
    }).join('')}
  </nav>`;
};

const renderQuota = (namespace: RecordsNamespaceView): string => {
  const quota = namespace.quota;
  return `<dl class="records-quota" aria-label="Records quota">
    <div><dt>Rows</dt><dd>${quotaUsage(quota.row_count, quota.row_limit, count)}</dd></div>
    <div><dt>Payload</dt><dd>${quotaUsage(quota.payload_bytes, quota.byte_limit, formatPressureBytes)}</dd></div>
    <div><dt>Event backlog</dt><dd>${quotaUsage(quota.outbox_count, quota.outbox_limit, count)}</dd></div>
  </dl>`;
};

const renderGlobalQuota = (quota: RecordsGlobalQuotaSnapshot | null): string => {
  if (quota === null) return '';
  return `<dl class="records-quota records-global-quota" aria-label="Global Records quota">
    <div><dt>All Records rows</dt><dd>${quotaUsage(quota.row_count, quota.row_limit, count)}</dd></div>
    <div><dt>All payload</dt><dd>${quotaUsage(quota.payload_bytes, quota.byte_limit, formatPressureBytes)}</dd></div>
    <div><dt>Migration reserve</dt><dd>${formatPressureBytes(quota.reserved_payload_bytes)}</dd></div>
    <div><dt>All event backlog</dt><dd>${quotaUsage(quota.outbox_count, quota.outbox_limit, count)}</dd></div>
  </dl>`;
};

const renderKindNav = (state: RecordsExplorerState): string => {
  const tabStop = state.kinds.some((kind) => kind.kind === state.selectedKind)
    ? state.selectedKind
    : state.kinds[0]?.kind ?? null;
  return `<div class="records-kind-nav" role="tablist" aria-label="Record kinds">
    ${state.kinds.map((kind) => `<button type="button" role="tab"
      id="${e(recordsKindTabId(kind.kind))}"
      ${state.selectedKind === null ? '' : `aria-controls="${RECORDS_KIND_PANEL_ID}"`}
      data-action="${RECORDS_SELECT_KIND_ACTION}" ${RECORDS_KIND_ATTR}="${e(kind.kind)}"
      ${recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}
      ${state.loadingKind === kind.kind ? 'aria-busy="true"' : ''}
      aria-selected="${kind.kind === state.selectedKind ? 'true' : 'false'}"
      tabindex="${kind.kind === tabStop ? '0' : '-1'}">
      ${e(recordFieldLabel(kind.kind))} <span>${kind.rows.toLocaleString()}</span>
    </button>`).join('')}
  </div>`;
};

const referenceTarget = (value: unknown): { entity: string; id: string } | null => {
  if (typeof value !== 'string') return null;
  const separator = value.indexOf('/');
  if (separator <= 0 || separator !== value.lastIndexOf('/')) return null;
  try {
    const id = decodeURIComponent(value.slice(separator + 1));
    return id.length === 0 ? null : { entity: value.slice(0, separator), id };
  } catch {
    return null;
  }
};

const renderReference = (value: unknown, locked = false): string => {
  const target = referenceTarget(value);
  if (target === null) return e(displayValue(value));
  return renderReferenceLink({
    label: displayValue(value),
    referenceId: typeof value === 'string' ? value : undefined,
    action: { attribute: 'data-action', value: RECORDS_OPEN_REFERENCE_ACTION },
    disabled: locked,
    className: 'records-ref-link',
    attributes: {
      [RECORDS_KIND_ATTR]: target.entity,
      [RECORDS_ID_ATTR]: target.id,
    },
  });
};

const renderCell = (
  record: RecordsFriendlyRecord,
  field: NonNullable<RecordsExplorerState['selectedNamespace']>['schema']['entities'][string]['fields'][number],
): string => {
  const value = field.kind === 'id' ? record.id : getPath(record, field.key);
  const classified = field.privacy !== undefined;
  const shown = classified ? '••••' : displayValue(value, field.kind === 'text');
  return `<td data-field="${e(field.key)}"${classified ? ' data-masked="true"' : ''}>
    <span>${classified || field.kind !== 'ref' ? e(shown) : renderReference(value)}</span>
    ${classified ? `<small class="records-pii-tag">${e(field.privacy!)}</small>` : ''}
  </td>`;
};

const renderList = (state: RecordsExplorerState): string => {
  const namespace = state.selectedNamespace;
  const kind = state.selectedKind;
  if (namespace === null || kind === null) return '<p class="records-empty">Choose a pack and record kind.</p>';
  const entity = namespace.schema.entities[kind];
  if (entity === undefined) return '<p role="alert">The installed schema no longer contains this kind.</p>';
  const fields = entity.fields.slice(0, 6);
  if (state.records.length === 0) {
    const filtered = Object.keys(state.view.filters ?? {}).length > 0;
    const locked = recordsControlsLocked(state) || state.exporting || state.outboxRefreshing
      || state.changesRefreshing || state.markingReviewed;
    return `<div class="records-empty-state"><p class="records-empty">${state.loading ? 'Loading results…'
      : state.error ? 'No records are shown. Check the message above.'
      : filtered ? 'No records match the applied filters.' : 'No records in this kind.'}</p>
      ${filtered && !state.loading ? `<button type="button" data-action="records-clear-filters"${locked ? ' aria-disabled="true"' : ''}>Clear filters</button>` : ''}
    </div>`;
  }
  return `<div class="records-table-scroll" data-recued-scroll-rail><table class="records-table">
    <thead><tr>${fields.map((field) => `<th scope="col">${e(recordsFieldLabel(field))}${field.privacy ? `<small>${e(field.privacy)}</small>` : ''}</th>`).join('')}<th scope="col">Revision</th></tr></thead>
    <tbody>${state.records.map((record) => `<tr data-action="${RECORDS_OPEN_RECORD_ACTION}"
      ${RECORDS_ID_ATTR}="${e(record.id)}">${fields.map((field) => renderCell(record, field)).join('')}
      <td>v${record._record.version} · r${record._record.revision}
        <button type="button" class="records-row-open" data-action="${RECORDS_OPEN_RECORD_ACTION}"
          ${RECORDS_ID_ATTR}="${e(record.id)}" aria-label="Open record ${e(record.id)}"
          ${recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}>Open</button></td></tr>`).join('')}</tbody>
  </table></div>`;
};

const renderDetail = (state: RecordsExplorerState): string => {
  const record = state.detail;
  const namespace = state.selectedNamespace;
  const kind = state.selectedKind;
  if (record === null || namespace === null || kind === null) return '';
  const entity = namespace.schema.entities[kind];
  if (entity === undefined) return '';
  return `<section class="records-detail" aria-labelledby="records-detail-title">
    <header><div><small>${e(namespaceKey(namespace))} / ${e(kind)}</small><h3 id="records-detail-title" tabindex="-1">${e(record.id)}</h3></div>
      <button type="button" data-action="${RECORDS_CLOSE_RECORD_ACTION}" ${recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}>Back</button></header>
    <dl>${entity.fields.map((field) => {
      const value = field.kind === 'id' ? record.id : getPath(record, field.key);
      return `<div><dt>${e(recordsFieldLabel(field))} ${field.privacy ? `<small class="records-pii-tag">${e(field.privacy)}</small>` : ''}</dt>
        <dd>${field.kind === 'ref' ? renderReference(value, recordsControlsLocked(state)) : e(displayValue(value))}</dd><small>${e(field.kind)} · ${e(field.slot)}${field.required ? ' · required' : ''}</small></div>`;
    }).join('')}</dl>
    <div class="records-detail-meta">Pack version ${record._record.version} · revision ${record._record.revision} · created ${new Date(record._record.created_at).toISOString()} · updated ${new Date(record._record.updated_at).toISOString()}</div>
    ${state.diagnostics?.incoming.length ? `<section class="records-relationship-impact"><h4>Records that reference this row</h4><ul>${state.diagnostics.incoming.map((impact) =>
      `<li>${renderReference(`${impact.source_entity}/${encodeURIComponent(impact.source_id)}`, recordsControlsLocked(state))}
        through <code>${e(impact.source_field)}</code></li>`).join('')}</ul></section>` : ''}
    <details><summary>Advanced raw-slot diagnostics</summary><pre>${e(JSON.stringify({
      schema: entity,
      friendly_record: record,
      raw_slots: state.diagnostics?.raw_slots ?? null,
      relationships: state.diagnostics === null ? null : {
        outgoing: state.diagnostics.outgoing,
        incoming: state.diagnostics.incoming,
      },
    }, null, 2))}</pre></details>
    ${state.error ? `<p role="alert">${e(state.error)}</p>` : ''}
    ${!state.canDelete ? '' : state.deletePending ? `<div class="records-delete-confirm" role="alert"><p>Delete this record permanently? ${state.diagnostics?.incoming.length
        ? `${state.diagnostics.incoming.length} incoming relationship${state.diagnostics.incoming.length === 1 ? '' : 's'} will be checked, and may stop you deleting this.`
        : 'Nothing else points at this record.'}</p>
      <div class="records-detail-delete-actions">
        <button type="button" data-action="${RECORDS_CONFIRM_DELETE_ACTION}" ${state.deleting ? 'aria-disabled="true" aria-busy="true"' : recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}>${state.deleting ? 'Deleting…' : 'Delete record'}</button>
        <button type="button" data-action="${RECORDS_CANCEL_DELETE_ACTION}" ${recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}>Cancel</button>
      </div></div>`
      : `<button type="button" data-action="${RECORDS_DELETE_RECORD_ACTION}" ${recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}>Delete record…</button>`}
  </section>`;
};

const renderAge = (milliseconds: number | undefined): string => {
  if (milliseconds === undefined) return 'none';
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const changeVerb = (type: RecordsEventPointer['type']): string =>
  type === 'record.created' ? 'Created' : type === 'record.deleted' ? 'Deleted' : 'Changed';

/** P2/F2 — what changed since the owner last said they had looked.
 *
 *  ⛔ THE COUNT DISCLOSES WHEN IT IS CLIPPED. The feed is one bounded page, so
 *  `changes.length` is a page size, not a total. Rendering it bare would report
 *  "100 changes" over a backlog of five thousand — the reviewer would believe
 *  they had seen everything. `has_more` turns it into "100+". */
const renderChanges = (state: RecordsExplorerState): string => {
  const feed = state.changes;
  if (feed === null) return '';
  const count = feed.changes.length;
  const locked = recordsControlsLocked(state);
  const busy = state.changesRefreshing || state.markingReviewed;
  const plural = count === 1 ? '' : 's';
  // ⚠ SAY WHICH END. The feed walks FORWARD from the mark, so an unmarked view
  // is showing the OLDEST page of the pack's history, not its most recent
  // changes — and "What changed" reads as "lately" unless it says otherwise.
  const headline = count === 0
    ? (state.reviewMark === null ? 'No changes recorded' : 'Nothing new since you last reviewed')
    : `${count.toLocaleString()}${feed.has_more ? '+' : ''} change${plural}`
      + (state.reviewMark === null ? ', oldest first' : ' since you last reviewed');
  // ⛔ `changesOpen` ALONE. The outbox forces itself open on dead letters —
  // an exceptional state. Having changes is the ORDINARY state here, so the
  // same trick made the panel impossible to collapse: every re-render put the
  // `open` attribute back the moment the owner clicked it shut.
  return `<details class="records-changes" ${state.changesOpen ? 'open' : ''}>
    <summary data-action="${RECORDS_TOGGLE_CHANGES_ACTION}" ${locked ? 'aria-disabled="true"' : ''}>What changed · ${e(headline)}</summary>
    <div class="records-changes-summary">
      ${state.reviewMark === null
        ? `<span>${state.canMarkReviewed
            ? 'Not reviewed yet.'
            : 'Open this pack through a saved view to keep a review mark.'}</span>`
        : `<span>Last reviewed ${e(renderAge(Date.now() - state.reviewMark.reviewed_at))} ago</span>`}
      <div class="records-change-actions">
        <button type="button" data-action="${RECORDS_REFRESH_CHANGES_ACTION}" ${locked || busy ? 'aria-disabled="true"' : ''} ${state.changesRefreshing ? 'aria-busy="true"' : ''}>${state.changesRefreshing ? 'Refreshing…' : 'Check again'}</button>
        ${state.canMarkReviewed
          ? `<button type="button" data-action="${RECORDS_MARK_REVIEWED_ACTION}" ${locked || busy || feed.next === undefined ? 'aria-disabled="true"' : ''} ${state.markingReviewed ? 'aria-busy="true"' : ''}>${state.markingReviewed ? 'Marking…' : 'Mark reviewed'}</button>`
          : ''}
      </div>
    </div>
    ${count === 0 ? '' : `<ol class="records-change-events" role="list">${feed.changes.map((change) => `<li>
      <div class="records-change-heading"><strong>${e(changeVerb(change.type))}</strong>
        <span><span aria-hidden="true">·</span> ${renderReference(`${change.entity}/${encodeURIComponent(change.id)}`, locked)}</span></div>
      ${change.changed_fields.length === 0 ? '' : `<small>${e(change.changed_fields.join(', '))}</small>`}
      <small>${e(renderAge(Date.now() - change.created_at))} ago</small>
    </li>`).join('')}</ol>`}
    ${feed.has_more ? '<p class="records-help">More changes than fit one page. Mark reviewed to work through them.</p>' : ''}
  </details>`;
};

const renderOutbox = (state: RecordsExplorerState): string => {
  const outbox = state.outbox;
  if (outbox === null) return '';
  const outboxOpen =
    state.outboxOpen
    || state.retiringEventId !== null
    || outbox.dead_letter > 0;
  return `<details class="records-outbox" ${outboxOpen ? 'open' : ''}>
    <summary data-action="${RECORDS_TOGGLE_OUTBOX_ACTION}" ${recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}>Watcher delivery · ${outbox.pending.toLocaleString()} pending · ${outbox.dead_letter.toLocaleString()} dead-lettered</summary>
    <div class="records-outbox-summary">
      <dl class="records-outbox-metrics">
        <div><dt>Oldest pending</dt><dd>${e(renderAge(outbox.oldest_pending_age_ms))}</dd></div>
        <div><dt>Total retries</dt><dd>${outbox.total_retries.toLocaleString()}</dd></div>
        <div><dt>Delivered evidence</dt><dd>${outbox.delivered.toLocaleString()}</dd></div>
      </dl>
      <button type="button" data-action="${RECORDS_REFRESH_OUTBOX_ACTION}" ${recordsControlsLocked(state) || state.outboxRefreshing ? 'aria-disabled="true"' : ''} ${state.outboxRefreshing ? 'aria-busy="true"' : ''}>${state.outboxRefreshing ? 'Refreshing…' : 'Check again'}</button>
    </div>
    <p class="records-help">The durable worker drains admitted deliveries automatically. A pending event can be explicitly retired to dead-letter evidence when recovery cannot proceed.</p>
    ${outbox.events.length === 0 ? '<p class="records-empty">No event evidence in this view.</p>' : `<ol class="records-outbox-events" role="list">${outbox.events.map((item) => {
      const pending = item.status === 'pending';
      const confirming = state.retiringEventId === item.event.event_id;
      const retiring = confirming && state.retiringEventBusy;
      return `<li data-status="${e(item.status)}"><div><div class="records-outbox-event-heading"><strong>${e(item.event.type)}</strong><span><span aria-hidden="true">·</span> ${renderReference(`${item.event.entity}/${encodeURIComponent(item.event.id)}`, recordsControlsLocked(state))}</span></div>
        <small>${e(item.status)} · ${item.retry_count} retries · ${new Date(item.event.created_at).toISOString()}</small>
        ${item.error ? `<p role="alert">${e(item.error)}</p>` : ''}</div>
        ${item.deliveries.length ? `<details><summary>${item.deliveries.length} delivery target${item.deliveries.length === 1 ? '' : 's'}</summary><ul>${item.deliveries.map((delivery) =>
          `<li><code>${e(delivery.recipe_id)}</code> · ${e(delivery.status)} · ${delivery.retry_count} retries${delivery.error ? ` · ${e(delivery.error)}` : ''}</li>`).join('')}</ul></details>` : ''}
        ${pending && state.canRetireEvents ? confirming
          ? `<div class="records-delete-confirm" role="alert"><p>Retire this exact pending event? It will not run and will remain dead-letter audit evidence.</p>
              <div class="records-event-actions">
                <button type="button" data-action="${RECORDS_CONFIRM_RETIRE_EVENT_ACTION}" ${RECORDS_EVENT_ID_ATTR}="${e(item.event.event_id)}" ${retiring ? 'aria-disabled="true" aria-busy="true"' : recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}>${retiring ? 'Retiring…' : 'Retire event'}</button>
                <button type="button" data-action="${RECORDS_CANCEL_RETIRE_EVENT_ACTION}" ${recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}>Cancel</button>
              </div></div>`
          : `<button type="button" data-action="${RECORDS_RETIRE_EVENT_ACTION}" ${RECORDS_EVENT_ID_ATTR}="${e(item.event.event_id)}" ${recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}>Retire pending event…</button>` : ''}
      </li>`;
    }).join('')}</ol>`}
  </details>`;
};

const renderPurge = (state: RecordsExplorerState, namespace: RecordsNamespaceView): string => {
  if (!state.canPurge || namespace.state.state !== 'orphaned') return '';
  const fullRef = namespaceKey(namespace);
  if (!state.purgePending) {
    return `<div class="records-purge"><button type="button" class="records-danger" data-action="${RECORDS_PURGE_ACTION}">Purge retained Records…</button></div>`;
  }
  return `<div class="records-purge"><div class="records-delete-confirm records-purge-confirm" role="alert">
    <p>This permanently removes all retained rows, event evidence, policies, and migration receipts for <strong>${e(fullRef)}</strong>. Export first if recovery may be needed.</p>
    <label>Type the full pack reference to confirm
      <input ${RECORDS_PURGE_CONFIRMATION_ATTR} autocomplete="off" spellcheck="false" placeholder="${e(fullRef)}"
        value="${e(state.purgeConfirmation)}" ${recordsControlsLocked(state) ? 'readonly aria-disabled="true"' : ''}>
    </label>
    <div class="records-purge-actions">
      <button type="button" data-action="${RECORDS_CONFIRM_PURGE_ACTION}" ${state.purging ? 'aria-disabled="true" aria-busy="true"' : recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}>${state.purging ? 'Purging…' : 'Delete everything for good'}</button>
      <button type="button" data-action="${RECORDS_CANCEL_PURGE_ACTION}" ${recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}>Cancel</button>
    </div>
  </div></div>`;
};

const renderExportButton = (
  state: RecordsExplorerState,
  action: RecordsExportAction,
  label: string,
): string => {
  const ownsExport = state.exportingAction === action;
  const unavailable = state.exporting || recordsControlsLocked(state);
  return `<button type="button" data-action="${action}"
    ${unavailable ? 'aria-disabled="true"' : ''}
    ${ownsExport ? 'aria-busy="true"' : ''}>${ownsExport ? 'Exporting…' : label}</button>`;
};

export const renderRecordsExplorer = (state: RecordsExplorerState, importPanel = ''): string => {
  const namespace = state.selectedNamespace;
  const browsingLocked = state.loading || recordsControlsLocked(state) || state.exporting || state.outboxRefreshing;
  const pagingLocked = browsingLocked || recordsViewHasDraft(state);
  const policy = state.selectedKind === null ? undefined : state.retention[state.selectedKind];
  return `<section class="records-explorer" data-recued-records-explorer>
    <header class="records-heading"><div><span>Pack-owned storage</span><h2>Records</h2>
      <p>Inspect, export, and delete pack-owned records, or import a CSV through a supported pack recipe.</p></div>
      ${namespace && state.canExport ? `<div class="records-export-actions">${renderExportButton(state, RECORDS_EXPORT_PACK_ACTION, 'Export pack JSON')}
        ${renderExportButton(state, RECORDS_EXPORT_PACK_CSV_ACTION, 'Export pack CSV')}</div>` : ''}
    </header>
    ${renderGlobalQuota(state.globalQuota)}
    ${state.error && state.detail === null ? `<p role="alert">${e(state.error)}</p>` : ''}
    ${state.loading ? '<p aria-live="polite">Loading Records…</p>' : ''}
    <div class="records-layout">${renderNamespaceNav(state)}
      <section class="records-content" aria-label="Record contents">${namespace === null ? '' : `<section class="records-pack-summary"><div><h3>${e(packLabel(namespace))}</h3><p>by ${e(namespace.owner.publisher)} · ${e(stateLabel(namespace))}</p></div>${renderQuota(namespace)}${renderPurge(state, namespace)}</section>
        ${importPanel}
        ${renderChanges(state)}
        ${renderOutbox(state)}
        ${renderKindNav(state)}
        ${state.selectedKind === null
          ? renderList(state)
          : `<div class="records-kind-panel" ${RECORDS_KIND_PANEL_ATTR}=""
              id="${RECORDS_KIND_PANEL_ID}" role="tabpanel"
              aria-labelledby="${e(recordsKindTabId(state.selectedKind))}">
              <div class="records-kind-toolbar"><span>Retention: ${e(policy?.mode ?? 'keep')}${policy?.days ? ` · ${policy.days} days` : ''}${policy?.legal_hold ? ' · legal hold' : ''}</span>
                ${state.canExport ? `<div class="records-export-actions">${renderExportButton(state, RECORDS_EXPORT_KIND_ACTION, 'Export kind JSON')}
                  ${renderExportButton(state, RECORDS_EXPORT_KIND_CSV_ACTION, 'Export kind CSV')}</div>` : ''}</div>
              ${state.detail ? renderDetail(state) : `${namespace.schema.entities[state.selectedKind]
                ? renderRecordsViewControls(state, namespace.schema.entities[state.selectedKind]!, browsingLocked) : ''}
                ${renderList(state)}
                <nav class="records-pagination" aria-label="Records pages">
                  <span role="status">Page ${state.page} · ${state.records.length} records</span>
                  <div class="records-page-actions">
                    <button type="button" data-action="records-prev-page"${pagingLocked || !state.prevCursor ? ' aria-disabled="true"' : ''}>Previous page</button>
                    <button type="button" data-action="records-next-page"${pagingLocked || !state.nextCursor ? ' aria-disabled="true"' : ''}>Next page</button>
                  </div>
                  <button type="button" data-action="records-first-page"${pagingLocked ? ' aria-disabled="true"' : ''}>Refresh results</button>
                </nav>`}
            </div>`}`}</section>
    </div>
  </section>`;
};

export const RECORDS_EXPLORER_STYLES = `
  .records-import{display:grid;gap:16px;margin:16px 0;padding:16px;border:1px solid var(--border,#d0d5dd);border-radius:var(--wc-radius,9px);background:var(--surface,#fff);min-width:0;overflow-wrap:anywhere}.records-import h4,.records-import p{margin:0}.records-import>section{display:grid;gap:12px;min-width:0}
  .records-import-heading{display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px;min-width:0}.records-import-heading>div:first-child{flex:1 1 20rem;min-width:0}.records-import-heading h4,.records-import-result>h4{font-size:16px;font-weight:600;line-height:1.3}.records-import-heading p{margin-top:6px;font-size:13px;line-height:1.5;color:var(--muted)}
  .records-import-heading>.records-export-actions{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;flex:0 1 12rem;max-width:100%;min-width:0}
  .records-explorer .records-import button[data-action="records-import-open"],.records-explorer .records-import>button[data-action="records-import-retry"]{width:100%;min-width:0;min-height:var(--wc-control-h,44px);padding:0 12px;border-radius:var(--wc-radius,9px);font-weight:600;line-height:1.3;white-space:normal;overflow-wrap:anywhere}
  .records-explorer .records-import button[data-action="records-import-open"],.records-explorer .records-import button[data-action="records-import-open"]:hover:not([aria-disabled=true]){border-color:var(--accent,#087f8c);background:var(--accent,#087f8c);color:var(--on-accent,#fff)}
  .records-explorer .records-import>button[data-action="records-import-retry"]{justify-self:start;width:auto;max-width:100%}.records-import>p,.records-import-result>p{font-size:13px;line-height:1.5;color:var(--muted)}.records-import>[role="alert"]{color:var(--danger,#dc2626)}
  .records-import-result{padding-top:16px;border-top:1px solid var(--border,#d0d5dd)}
  @container records-content (max-width:34rem){.records-import-heading{display:grid;grid-template-columns:minmax(0,1fr)}.records-import-heading>.records-export-actions{width:100%}}
  .records-applied-view{display:grid;gap:6px;min-width:0;margin:12px 0;font-size:13px;overflow-wrap:anywhere}.records-applied-view p{margin:0}.records-applied-filters{display:flex;flex-wrap:wrap;gap:6px;min-width:0;margin:0;padding:0;list-style:none}.records-applied-filters li{box-sizing:border-box;min-width:0;max-width:100%;padding:5px 8px;border:1px solid var(--border,#e4e7ec);border-radius:6px;white-space:pre-wrap}.records-empty-state{min-width:0;overflow-wrap:anywhere}
  .records-view-controls{container:records-filters / inline-size;display:grid;gap:12px;margin:16px 0;min-width:0}
  .records-filter-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) auto;align-items:end;gap:12px;min-width:0}
  .records-filter-row>button{grid-column:4;justify-self:end}
  .records-view-actions{display:flex;align-items:end;gap:12px;flex-wrap:wrap;min-width:0}
  .records-view-tools{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:end;gap:8px;flex:1 1 260px;min-width:0}
  .records-view-apply-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;flex:1 1 350px;min-width:0}
  .records-view-controls label{display:grid;gap:6px;min-width:0;max-width:100%;font-size:12px;font-weight:600;line-height:1.4;color:var(--muted)}
  .records-explorer .records-view-controls :is(input,select){box-sizing:border-box;width:100%;min-width:0;min-height:var(--wc-control-h,44px);padding:0 10px;border:1px solid var(--border-strong);border-radius:var(--wc-radius,9px);background:var(--surface);color:var(--fg);font:inherit;font-size:13px;font-weight:400}
  .records-explorer .records-view-controls button{min-height:var(--wc-control-h,44px);padding:0 12px;border-radius:var(--wc-radius,9px);font-weight:600;white-space:normal;overflow-wrap:anywhere}
  .records-view-apply-actions>button{width:100%;min-width:0}
  .records-view-controls .records-help{margin:0;font-size:13px;line-height:1.5;overflow-wrap:anywhere}
  .records-view-controls button:disabled{opacity:.6;cursor:default}
  .records-pagination{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,16rem) auto;align-items:center;gap:8px 12px;min-width:0;margin-top:16px;padding-top:12px;border-top:1px solid var(--border,#d0d5dd)}
  .records-pagination>span{min-width:0;font-size:12px;line-height:1.5;color:var(--muted);overflow-wrap:anywhere}
  .records-page-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;min-width:0}
  .records-explorer .records-pagination button{width:100%;min-width:0;min-height:var(--wc-control-h,44px);padding:0 8px;border-radius:var(--wc-radius,9px);font-weight:600;line-height:1.3;white-space:normal;overflow-wrap:anywhere}
  @container records-content (max-width:34rem){.records-pagination{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.records-pagination>span{grid-column:1/-1}.records-page-actions{grid-column:span 2}}
  @container records-filters (max-width:34rem){.records-filter-row{grid-template-columns:repeat(2,minmax(0,1fr))}.records-filter-row>button{grid-column:2;width:100%}}
  @container records-filters (max-width:22rem){.records-filter-row{grid-template-columns:minmax(0,1fr)}.records-filter-row>button{grid-column:1}}
  .records-explorer{display:grid;gap:18px;min-width:0;container:records-explorer / inline-size}
  .records-heading{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px 20px;min-width:0}
  .records-heading>*{min-width:0}.records-heading>div:first-child{flex:1 1 20rem}
  .records-heading>div>span{font-size:12px;font-weight:600;color:var(--muted)}
  .records-heading h2{margin:4px 0 0;font-size:20px;font-weight:600;line-height:1.2}
  .records-heading p{max-width:48rem;margin:6px 0 0;font-size:13px;line-height:1.5;color:var(--muted,#667085)}
  .records-explorer button{box-sizing:border-box;min-height:36px;padding:7px 10px;border:1px solid var(--border,#d0d5dd);border-radius:6px;background:var(--surface,#fff);color:var(--fg,#101828);font:inherit;font-size:13px;line-height:1.2;cursor:pointer}.records-explorer button:hover:not([aria-disabled=true]){border-color:var(--border-strong,var(--border,#98a2b3));background:var(--surface-sunk,var(--surface-subtle,#f7f8fa))}.records-explorer button:focus-visible,.records-explorer summary:focus-visible{outline:2px solid var(--accent,#315efb);outline-offset:1px}.records-explorer summary{box-sizing:border-box;min-height:36px;padding:8px 4px;border-radius:6px;cursor:pointer}.records-explorer input{box-sizing:border-box;min-height:38px;padding:7px 9px;border:1px solid var(--border,#d0d5dd);border-radius:6px;background:var(--surface,#fff);color:var(--fg,#101828);font:inherit}
  .records-layout{display:grid;grid-template-columns:minmax(190px,260px) minmax(0,1fr);gap:18px;min-width:0}.records-layout>.records-content{min-width:0}.records-namespace-nav{display:grid;gap:8px;align-content:start;min-width:0}.records-namespace{text-align:left;display:grid;gap:2px;min-width:0;padding:10px;border:1px solid var(--border,#d0d5dd);border-radius:8px;background:transparent}.records-namespace[data-active=true]{border-color:var(--accent,#315efb);background:var(--surface-subtle,#f5f7ff)}.records-namespace strong,.records-namespace span,.records-namespace small{overflow-wrap:anywhere}.records-namespace span,.records-namespace small{color:var(--muted,#667085)}
  .records-pack-summary{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px 20px;align-items:start;min-width:0}.records-pack-summary>*{min-width:0}.records-pack-summary>div:first-child{flex:1 1 12rem}.records-pack-summary>.records-quota{flex:1 1 22rem}
  .records-pack-summary h3{margin:0;font-size:16px;font-weight:600;line-height:1.3}.records-pack-summary p{margin:4px 0 0;font-size:13px;line-height:1.5;color:var(--muted,#667085)}.records-pack-summary h3,.records-pack-summary p{overflow-wrap:anywhere}
  .records-quota{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 16px;min-width:0;margin:0}.records-quota div{display:grid;align-content:start;gap:4px;min-width:0}.records-quota dt,.records-quota small{color:var(--muted,#667085);font-size:12px;line-height:1.4}.records-quota dt{overflow-wrap:anywhere}.records-quota dd{margin:0;font-size:13px;line-height:1.5;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.records-quota dd small{display:inline-block}
  .records-global-quota{grid-template-columns:repeat(4,minmax(0,1fr));padding:12px 16px;border:1px solid var(--border,#d0d5dd);border-radius:var(--wc-radius,9px);background:var(--surface-subtle,#f7f8fa)}
  @container records-explorer (max-width:40rem){.records-global-quota{grid-template-columns:repeat(2,minmax(0,1fr));padding:12px}}
  @container records-content (max-width:27rem){.records-pack-summary>.records-quota{grid-template-columns:repeat(2,minmax(0,1fr))}}
  .records-kind-nav{box-sizing:border-box;display:flex;gap:4px;flex-wrap:wrap;width:fit-content;max-width:100%;min-width:0;margin:16px 0;padding:4px;border-radius:var(--wc-radius,9px);background:var(--surface-subtle,#f7f8fa)}
  .records-explorer .records-kind-nav>button{display:flex;align-items:center;justify-content:center;gap:6px;max-width:100%;min-width:0;min-height:var(--wc-control-h,44px);padding:0 12px;border-color:transparent;border-radius:var(--wc-radius,9px);background:transparent;color:var(--muted);font-weight:600;line-height:1.3;white-space:normal;overflow-wrap:anywhere}
  .records-explorer .records-kind-nav>button[aria-selected=true]{border-color:var(--border,#d0d5dd);background:var(--surface,#fff);color:var(--fg,#101828)}
  .records-kind-nav span{min-width:0;font-size:12px;font-weight:500;font-variant-numeric:tabular-nums}
  .records-kind-toolbar{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;min-width:0;margin:12px 0}.records-kind-toolbar>*{min-width:0}.records-kind-toolbar>span{font-size:12px;line-height:1.5;color:var(--muted);overflow-wrap:anywhere}.records-export-actions{display:flex;gap:6px;flex-wrap:wrap;min-width:0}.records-explorer .records-ref-link,.records-explorer .records-ref-link:hover:not([aria-disabled=true]){border:0;padding:0;max-width:100%;min-width:0;background:transparent;color:var(--accent,#315efb);text-decoration:underline;overflow-wrap:anywhere;cursor:pointer;text-align:left}.records-danger{color:#b42318;border-color:#fda29b}
  .records-content{container:records-content / inline-size}
  .records-explorer :is(.records-heading,.records-kind-toolbar)>.records-export-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;flex:0 1 20rem;max-width:100%}
  .records-heading>.records-export-actions{width:min(100%,20rem);justify-self:end}
  .records-explorer :is(.records-heading,.records-kind-toolbar)>.records-export-actions>button{width:100%;min-width:0;min-height:var(--wc-control-h,44px);padding:0 12px;border-radius:var(--wc-radius,9px);font-weight:600;line-height:1.3;white-space:normal;overflow-wrap:anywhere}
  @container records-content (max-width:27rem){.records-kind-toolbar>.records-export-actions{flex-basis:100%;width:100%}}
  @media(max-width:600px){.records-explorer :is(.records-heading,.records-kind-toolbar)>.records-export-actions{flex-basis:100%;width:100%}}
  .records-table-scroll{max-width:100%;min-width:0;overflow:auto}.records-table{width:100%;border-collapse:collapse}.records-table th,.records-table td{text-align:left;padding:9px;border-bottom:1px solid var(--border,#e4e7ec);vertical-align:top;max-width:240px}.records-table th small{display:block;font-weight:400}.records-table tbody tr{cursor:pointer}.records-table tbody tr:hover{background:var(--surface-subtle,#f7f8fa)}.records-row-open{margin-left:8px}.records-pii-tag{display:inline-block;margin-left:5px;padding:1px 4px;border-radius:4px;background:#fff0cc;color:#7a4c00;font-size:10px}.records-empty{color:var(--muted,#667085)}
  .records-explorer button[aria-disabled=true]{cursor:wait;opacity:.7}.records-detail{display:grid;gap:14px;min-width:0}.records-detail>*{min-width:0}.records-detail header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;min-width:0}.records-detail header>div{min-width:0}.records-detail header>button{flex:0 0 auto}.records-detail header small,.records-detail h3{overflow-wrap:anywhere}.records-detail h3{margin:2px 0}.records-detail dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:8px;min-width:0}.records-detail dl div{min-width:0;padding:10px;border:1px solid var(--border,#e4e7ec);border-radius:7px}.records-detail dt{font-weight:600}.records-detail dt,.records-detail dl div>small{overflow-wrap:anywhere}.records-detail dd{margin:5px 0;white-space:pre-wrap;overflow-wrap:anywhere}.records-detail-meta{color:var(--muted,#667085);font-size:13px;overflow-wrap:anywhere}.records-detail details{min-width:0}.records-detail pre{box-sizing:border-box;max-width:100%;min-width:0;overflow:auto;max-height:340px}.records-delete-confirm{min-width:0;border:1px solid #d92d20;padding:12px;border-radius:8px;overflow-wrap:anywhere}.records-delete-confirm button+button{margin-left:8px}.records-relationship-impact li,.records-relationship-impact code{overflow-wrap:anywhere}.records-relationship-impact ul,.records-outbox-events{margin:6px 0;padding-left:22px}.records-changes,.records-outbox{min-width:0;margin:14px 0;padding:10px;border:1px solid var(--border,#e4e7ec);border-radius:8px}.records-changes>*{min-width:0}.records-changes summary{overflow-wrap:anywhere}.records-changes-summary{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:10px}.records-change-events{display:grid;gap:8px;min-width:0;margin:6px 0;padding-left:22px}.records-change-events>li{min-width:0;padding:8px;border-bottom:1px solid var(--border,#e4e7ec);overflow-wrap:anywhere;display:grid;gap:3px}.records-change-heading{display:flex;align-items:baseline;gap:4px;flex-wrap:wrap;min-width:0}.records-change-events small{color:var(--muted,#667085);overflow-wrap:anywhere}.records-outbox>*{min-width:0}.records-outbox summary{overflow-wrap:anywhere}.records-outbox-summary{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:10px}.records-outbox-events{display:grid;gap:8px;min-width:0}.records-outbox-events>li{min-width:0;padding:8px;border-bottom:1px solid var(--border,#e4e7ec);overflow-wrap:anywhere}.records-outbox-events>li>*{min-width:0}.records-outbox-events>li>div:first-child{display:grid;gap:3px}.records-outbox-event-heading{display:flex;align-items:baseline;gap:4px;flex-wrap:wrap;min-width:0}.records-outbox-event-heading>*{min-width:0}.records-outbox-event-heading>span{display:inline-flex;align-items:baseline;gap:4px;max-width:100%}.records-outbox-events details{min-width:0}.records-outbox-events small,.records-help{color:var(--muted,#667085)}.records-outbox-events strong,.records-outbox-events small,.records-outbox-events p,.records-outbox-events code{overflow-wrap:anywhere}.records-purge-confirm{margin-top:10px}.records-purge-confirm label{display:grid;gap:4px;margin:8px 0}.records-purge-confirm input{width:100%;max-width:360px;min-width:0}
  .records-changes,.records-outbox{margin:16px 0;padding:8px 12px;border-radius:var(--wc-radius,9px)}
  .records-changes>summary,.records-outbox>summary,.records-outbox-events summary{min-height:var(--wc-control-h,44px);padding:8px 0;font-size:13px;font-weight:600;line-height:1.5}
  .records-changes-summary,.records-outbox-summary{align-items:center;gap:12px;margin:12px 0 0}.records-changes-summary>span{flex:1 1 15rem;font-size:13px;line-height:1.5;color:var(--muted);overflow-wrap:anywhere}
  .records-change-actions{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:8px;flex:0 1 20rem;max-width:100%;min-width:0}.records-change-actions:has(>button:only-child){flex-basis:9rem}
  .records-explorer :is(.records-changes,.records-outbox) button:not(.records-ref-link){min-width:0;min-height:var(--wc-control-h,44px);padding:0 12px;border-radius:var(--wc-radius,9px);font-weight:600;line-height:1.3;white-space:normal;overflow-wrap:anywhere}.records-change-actions>button,.records-event-actions>button{width:100%}
  .records-outbox-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;flex:1 1 22rem;min-width:0;margin:0}.records-outbox-metrics>div{display:grid;align-content:start;gap:4px;min-width:0}.records-outbox-metrics dt{font-size:12px;line-height:1.4;color:var(--muted);overflow-wrap:anywhere}.records-outbox-metrics dd{margin:0;font-size:13px;font-weight:500;line-height:1.5;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
  .records-outbox-summary>button{flex:0 0 9rem;width:9rem;justify-self:end}
  :is(.records-changes,.records-outbox)>.records-help{margin:12px 0 0;font-size:13px;line-height:1.5;overflow-wrap:anywhere}
  .records-change-events,.records-outbox-events{gap:8px;margin:12px 0 0;padding:0;list-style:none}.records-change-events>li,.records-outbox-events>li{gap:6px;padding:12px;border:0;border-radius:var(--wc-radius,9px);background:var(--surface-subtle,#f7f8fa);font-size:13px;line-height:1.5}.records-change-events small,.records-outbox-events small{font-size:12px;line-height:1.5}.records-outbox-events p{margin:0}.records-outbox-events>li>button{justify-self:start;max-width:100%}
  @container records-content (max-width:34rem){.records-changes-summary,.records-outbox-summary{display:grid;grid-template-columns:minmax(0,1fr)}.records-change-actions{width:100%}}
  @container records-content (max-width:27rem){.records-outbox-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.records-outbox-summary>button{width:100%}}
  .records-detail{gap:16px}.records-detail header small{font-size:12px;line-height:1.5;color:var(--muted)}.records-detail h3{margin:4px 0 0;font-size:18px;font-weight:600;line-height:1.3}
  .records-explorer .records-detail header>button{min-height:var(--wc-control-h,44px);padding:0 12px;border-radius:var(--wc-radius,9px);font-weight:600}
  .records-detail>dl{grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:12px;margin:0}.records-detail>dl>div{display:grid;align-content:start;gap:6px;padding:12px;border-radius:var(--wc-radius,9px);background:var(--surface,#fff)}
  .records-detail>dl dt{font-size:12px;font-weight:600;line-height:1.4;color:var(--muted)}.records-detail>dl dd{margin:0;font-size:14px;line-height:1.5}.records-detail>dl>div>small{font-size:12px;line-height:1.4;color:var(--muted)}
  .records-detail-meta{padding:12px;border-radius:var(--wc-radius,9px);background:var(--surface-subtle,#f7f8fa);font-size:12px;line-height:1.6}
  .records-detail .records-relationship-impact h4{margin:0;font-size:13px;font-weight:600;line-height:1.5}.records-detail .records-relationship-impact li{font-size:13px;line-height:1.5}
  .records-detail>details{padding:8px 12px;border:1px solid var(--border,#d0d5dd);border-radius:var(--wc-radius,9px)}.records-detail>details>summary{min-height:var(--wc-control-h,44px);padding:8px 0;font-size:13px;font-weight:600;line-height:1.5}.records-detail>details>pre{margin:8px 0 0;font-size:12px;line-height:1.5}
  :is(.records-detail,.records-outbox,.records-purge) .records-delete-confirm{display:grid;gap:12px;padding:16px;border-color:var(--danger,#dc2626);border-radius:var(--wc-radius,9px);background:var(--danger-weak,#fef2f2)}:is(.records-detail,.records-outbox,.records-purge) .records-delete-confirm p{margin:0;font-size:13px;line-height:1.5}
  .records-detail-delete-actions,.records-event-actions,.records-purge-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;width:min(100%,22rem);min-width:0}:is(.records-detail,.records-outbox,.records-purge) .records-delete-confirm button+button{margin-left:0}
  .records-explorer .records-detail :is([data-action="records-delete-record"],.records-detail-delete-actions>button){min-width:0;min-height:var(--wc-control-h,44px);padding:0 12px;border-radius:var(--wc-radius,9px);font-weight:600;line-height:1.3;white-space:normal;overflow-wrap:anywhere}
  .records-detail>[data-action="records-delete-record"]{justify-self:start;max-width:100%}
  .records-explorer :is(.records-detail,.records-outbox,.records-purge) :is([data-action="records-delete-record"],[data-action="records-confirm-delete"],[data-action="records-retire-event"],[data-action="records-confirm-retire-event"],[data-action="records-purge"],[data-action="records-confirm-purge"]){border-color:var(--danger,#dc2626);background:var(--surface,#fff);color:var(--danger,#dc2626)}
  .records-explorer :is(.records-detail,.records-outbox,.records-purge) :is([data-action="records-delete-record"],[data-action="records-confirm-delete"],[data-action="records-retire-event"],[data-action="records-confirm-retire-event"],[data-action="records-purge"],[data-action="records-confirm-purge"]):hover:not([aria-disabled=true]){border-color:var(--danger,#dc2626);background:var(--danger-weak,#fef2f2)}
  .records-purge{display:grid;flex:1 0 100%;min-width:0}.records-purge>button{justify-self:start;max-width:100%}.records-purge-confirm{margin-top:0}
  .records-purge-confirm label{gap:6px;min-width:0;max-width:32rem;margin:0;font-size:12px;font-weight:600;line-height:1.4;color:var(--muted)}
  .records-explorer .records-purge input{box-sizing:border-box;width:100%;max-width:32rem;min-width:0;height:var(--wc-control-h,44px);min-height:var(--wc-control-h,44px);padding:0 10px;border-color:var(--border-strong,var(--border));border-radius:var(--wc-radius,9px);font:inherit;font-size:13px;font-weight:400}
  .records-explorer .records-purge button{min-width:0;min-height:var(--wc-control-h,44px);padding:0 12px;border-radius:var(--wc-radius,9px);font-weight:600;line-height:1.3;white-space:normal;overflow-wrap:anywhere}
  .records-purge-actions{width:min(100%,32rem)}.records-purge-actions>button{width:100%}
  @container records-content (max-width:22rem){.records-purge-actions{grid-template-columns:minmax(0,1fr)}}
  @media(max-width:760px){.records-layout{grid-template-columns:1fr}.records-heading,.records-pack-summary{display:grid}.records-quota{display:grid}}
`;
