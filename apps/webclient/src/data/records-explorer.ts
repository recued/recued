import type {
  RecordsFriendlyRecord,
  RecordsGlobalQuotaSnapshot,
  RecordsKindSummary,
  RecordsNamespaceView,
  RecordsOutboxOverview,
  RecordsOwnerRecordDiagnostics,
  RecordsRetentionPolicy,
} from '@recued/contracts';
import { e, renderReferenceLink } from '@recued/ui-shared';

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

export interface RecordsExplorerState {
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
  retention: Readonly<Record<string, RecordsRetentionPolicy>>;
  loading: boolean;
  loadingNamespaceKey: string | null;
  loadingKind: string | null;
  error?: string;
  deletePending: boolean;
  deleting: boolean;
  exporting: boolean;
  exportingAction: RecordsExportAction | null;
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

const RECORDS_KIND_PANEL_ID = 'recued-records-kind-panel';
const recordsKindTabId = (kind: string): string =>
  `recued-records-kind-tab-${encodeURIComponent(kind)}`;

const recordsControlsLocked = (state: RecordsExplorerState): boolean =>
  state.deleting
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
  if (state.state === 'orphaned') return `orphaned · last v${state.last_version}`;
  return 'incoherent · repair required';
};

const quotaPercent = (used: number, limit: number): string =>
  limit === 0 ? (used === 0 ? '0' : '∞') : `${Math.round((used / limit) * 100)}%`;

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
        <strong>${e(namespace.owner.pack_slug)}</strong>
        <span>${e(namespace.owner.publisher)}</span>
        <small data-state="${e(namespace.state.state)}">${e(stateLabel(namespace))}</small>
      </button>`;
    }).join('')}
  </nav>`;
};

const renderQuota = (namespace: RecordsNamespaceView): string => {
  const quota = namespace.quota;
  return `<dl class="records-quota" aria-label="Records quota">
    <div><dt>Rows</dt><dd>${quota.row_count.toLocaleString()} / ${quota.row_limit.toLocaleString()} <small>${quotaPercent(quota.row_count, quota.row_limit)}</small></dd></div>
    <div><dt>Payload</dt><dd>${quota.payload_bytes.toLocaleString()} / ${quota.byte_limit.toLocaleString()} bytes <small>${quotaPercent(quota.payload_bytes, quota.byte_limit)}</small></dd></div>
    <div><dt>Event backlog</dt><dd>${quota.outbox_count.toLocaleString()} / ${quota.outbox_limit.toLocaleString()} <small>${quotaPercent(quota.outbox_count, quota.outbox_limit)}</small></dd></div>
  </dl>`;
};

const renderGlobalQuota = (quota: RecordsGlobalQuotaSnapshot | null): string => {
  if (quota === null) return '';
  return `<dl class="records-quota records-global-quota" aria-label="Global Records quota">
    <div><dt>All Records rows</dt><dd>${quota.row_count.toLocaleString()} / ${quota.row_limit.toLocaleString()} <small>${quotaPercent(quota.row_count, quota.row_limit)}</small></dd></div>
    <div><dt>All payload</dt><dd>${quota.payload_bytes.toLocaleString()} / ${quota.byte_limit.toLocaleString()} bytes <small>${quotaPercent(quota.payload_bytes, quota.byte_limit)}</small></dd></div>
    <div><dt>Migration reserve</dt><dd>${quota.reserved_payload_bytes.toLocaleString()} bytes</dd></div>
    <div><dt>All event backlog</dt><dd>${quota.outbox_count.toLocaleString()} / ${quota.outbox_limit.toLocaleString()} <small>${quotaPercent(quota.outbox_count, quota.outbox_limit)}</small></dd></div>
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
      ${e(kind.kind)} <span>${kind.rows.toLocaleString()}</span>
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
  if (state.records.length === 0) return '<p class="records-empty">No records in this kind.</p>';
  return `<div class="records-table-scroll" data-recued-scroll-rail><table class="records-table">
    <thead><tr>${fields.map((field) => `<th>${e(field.key)}${field.privacy ? `<small>${e(field.privacy)}</small>` : ''}</th>`).join('')}<th>Revision</th></tr></thead>
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
      return `<div><dt>${e(field.key)} ${field.privacy ? `<small class="records-pii-tag">${e(field.privacy)}</small>` : ''}</dt>
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
        ? `${state.diagnostics.incoming.length} incoming relationship${state.diagnostics.incoming.length === 1 ? '' : 's'} will be checked and may restrict deletion.`
        : 'No incoming relationships are present in the current reverse index.'}</p>
      <button type="button" data-action="${RECORDS_CONFIRM_DELETE_ACTION}" ${state.deleting ? 'aria-disabled="true" aria-busy="true"' : recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}>${state.deleting ? 'Deleting…' : 'Delete record'}</button>
      <button type="button" data-action="${RECORDS_CANCEL_DELETE_ACTION}" ${recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}>Cancel</button></div>`
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
      <span>Oldest pending: ${e(renderAge(outbox.oldest_pending_age_ms))}</span>
      <span>Total retries: ${outbox.total_retries.toLocaleString()}</span>
      <span>Delivered evidence: ${outbox.delivered.toLocaleString()}</span>
      <button type="button" data-action="${RECORDS_REFRESH_OUTBOX_ACTION}" ${recordsControlsLocked(state) || state.outboxRefreshing ? 'aria-disabled="true"' : ''} ${state.outboxRefreshing ? 'aria-busy="true"' : ''}>${state.outboxRefreshing ? 'Refreshing…' : 'Refresh drain status'}</button>
    </div>
    <p class="records-help">The durable worker drains admitted deliveries automatically. A pending event can be explicitly retired to dead-letter evidence when recovery cannot proceed.</p>
    ${outbox.events.length === 0 ? '<p class="records-empty">No event evidence in this view.</p>' : `<ol class="records-outbox-events">${outbox.events.map((item) => {
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
              <button type="button" data-action="${RECORDS_CONFIRM_RETIRE_EVENT_ACTION}" ${RECORDS_EVENT_ID_ATTR}="${e(item.event.event_id)}" ${retiring ? 'aria-disabled="true" aria-busy="true"' : recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}>${retiring ? 'Retiring…' : 'Retire event'}</button>
              <button type="button" data-action="${RECORDS_CANCEL_RETIRE_EVENT_ACTION}" ${recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}>Cancel</button></div>`
          : `<button type="button" data-action="${RECORDS_RETIRE_EVENT_ACTION}" ${RECORDS_EVENT_ID_ATTR}="${e(item.event.event_id)}" ${recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}>Retire pending event…</button>` : ''}
      </li>`;
    }).join('')}</ol>`}
  </details>`;
};

const renderPurge = (state: RecordsExplorerState, namespace: RecordsNamespaceView): string => {
  if (!state.canPurge || namespace.state.state !== 'orphaned') return '';
  const fullRef = namespaceKey(namespace);
  if (!state.purgePending) {
    return `<button type="button" class="records-danger" data-action="${RECORDS_PURGE_ACTION}">Purge retained Records…</button>`;
  }
  return `<div class="records-delete-confirm records-purge-confirm" role="alert">
    <p>This permanently removes all retained rows, event evidence, policies, and migration receipts for <strong>${e(fullRef)}</strong>. Export first if recovery may be needed.</p>
    <label>Type the full pack reference to confirm
      <input ${RECORDS_PURGE_CONFIRMATION_ATTR} autocomplete="off" spellcheck="false" placeholder="${e(fullRef)}"
        value="${e(state.purgeConfirmation)}" ${recordsControlsLocked(state) ? 'readonly aria-disabled="true"' : ''}>
    </label>
    <button type="button" data-action="${RECORDS_CONFIRM_PURGE_ACTION}" ${state.purging ? 'aria-disabled="true" aria-busy="true"' : recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}>${state.purging ? 'Purging…' : 'Permanently purge'}</button>
    <button type="button" data-action="${RECORDS_CANCEL_PURGE_ACTION}" ${recordsControlsLocked(state) ? 'aria-disabled="true"' : ''}>Cancel</button>
  </div>`;
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

export const renderRecordsExplorer = (state: RecordsExplorerState): string => {
  const namespace = state.selectedNamespace;
  const policy = state.selectedKind === null ? undefined : state.retention[state.selectedKind];
  return `<section class="records-explorer" data-recued-records-explorer>
    <header class="records-heading"><div><span>Pack-owned storage</span><h2>Records</h2>
      <p>Friendly, schema-checked records owned by installed packs. Writes stay in pack recipes; this owner surface can inspect, export, and delete.</p></div>
      ${namespace && state.canExport ? `<div class="records-export-actions">${renderExportButton(state, RECORDS_EXPORT_PACK_ACTION, 'Export pack JSON')}
        ${renderExportButton(state, RECORDS_EXPORT_PACK_CSV_ACTION, 'Export pack CSV')}</div>` : ''}
    </header>
    ${renderGlobalQuota(state.globalQuota)}
    ${state.error && state.detail === null ? `<p role="alert">${e(state.error)}</p>` : ''}
    ${state.loading ? '<p aria-live="polite">Loading Records…</p>' : ''}
    <div class="records-layout">${renderNamespaceNav(state)}
      <section class="records-content" aria-label="Record contents">${namespace === null ? '' : `<section class="records-pack-summary"><div><h3>${e(namespace.owner.pack_slug)}</h3><p>${e(namespace.owner.publisher)} · ${e(stateLabel(namespace))}</p>${renderPurge(state, namespace)}</div>${renderQuota(namespace)}</section>
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
              ${state.detail ? renderDetail(state) : renderList(state)}
            </div>`}`}</section>
    </div>
  </section>`;
};

export const RECORDS_EXPLORER_STYLES = `
  .records-explorer{display:grid;gap:18px;min-width:0}.records-heading{display:flex;justify-content:space-between;gap:20px;align-items:end}.records-heading>*{min-width:0}.records-heading h2{margin:2px 0}.records-heading p{max-width:760px;margin:6px 0;color:var(--muted,#667085)}
  .records-explorer button{box-sizing:border-box;min-height:36px;padding:7px 10px;border:1px solid var(--border,#d0d5dd);border-radius:6px;background:var(--surface,#fff);color:var(--fg,#101828);font:inherit;font-size:13px;line-height:1.2;cursor:pointer}.records-explorer button:hover:not([aria-disabled=true]){border-color:var(--border-strong,var(--border,#98a2b3));background:var(--surface-sunk,var(--surface-subtle,#f7f8fa))}.records-explorer button:focus-visible,.records-explorer summary:focus-visible{outline:2px solid var(--accent,#315efb);outline-offset:1px}.records-explorer summary{box-sizing:border-box;min-height:36px;padding:8px 4px;border-radius:6px;cursor:pointer}.records-explorer input{box-sizing:border-box;min-height:38px;padding:7px 9px;border:1px solid var(--border,#d0d5dd);border-radius:6px;background:var(--surface,#fff);color:var(--fg,#101828);font:inherit}
  .records-layout{display:grid;grid-template-columns:minmax(190px,260px) minmax(0,1fr);gap:18px;min-width:0}.records-layout>.records-content{min-width:0}.records-namespace-nav{display:grid;gap:8px;align-content:start;min-width:0}.records-namespace{text-align:left;display:grid;gap:2px;min-width:0;padding:10px;border:1px solid var(--border,#d0d5dd);border-radius:8px;background:transparent}.records-namespace[data-active=true]{border-color:var(--accent,#315efb);background:var(--surface-subtle,#f5f7ff)}.records-namespace strong,.records-namespace span,.records-namespace small{overflow-wrap:anywhere}.records-namespace span,.records-namespace small{color:var(--muted,#667085)}
  .records-pack-summary{display:flex;justify-content:space-between;gap:16px;align-items:start;min-width:0}.records-pack-summary>*{min-width:0}.records-pack-summary h3{margin:0}.records-pack-summary p{margin:4px 0}.records-pack-summary h3,.records-pack-summary p{overflow-wrap:anywhere}.records-quota{display:flex;gap:14px;margin:0;flex-wrap:wrap}.records-quota div{display:grid}.records-quota dt,.records-quota small{color:var(--muted,#667085);font-size:12px}.records-quota dd{margin:0}
  .records-kind-nav{display:flex;gap:6px;flex-wrap:wrap;margin:16px 0}.records-kind-nav button{max-width:100%;min-width:0;overflow-wrap:anywhere}.records-kind-nav button[aria-selected=true]{border-color:var(--accent,#315efb)}.records-kind-nav span{opacity:.7}.records-kind-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;min-width:0;margin:8px 0}.records-kind-toolbar>*{min-width:0}.records-kind-toolbar>span{overflow-wrap:anywhere}.records-export-actions{display:flex;gap:6px;flex-wrap:wrap;min-width:0}.records-explorer .records-ref-link,.records-explorer .records-ref-link:hover:not([aria-disabled=true]){border:0;padding:0;max-width:100%;min-width:0;background:transparent;color:var(--accent,#315efb);text-decoration:underline;overflow-wrap:anywhere;cursor:pointer;text-align:left}.records-danger{color:#b42318;border-color:#fda29b}
  .records-table-scroll{max-width:100%;min-width:0;overflow:auto}.records-table{width:100%;border-collapse:collapse}.records-table th,.records-table td{text-align:left;padding:9px;border-bottom:1px solid var(--border,#e4e7ec);vertical-align:top;max-width:240px}.records-table th small{display:block;font-weight:400}.records-table tbody tr{cursor:pointer}.records-table tbody tr:hover{background:var(--surface-subtle,#f7f8fa)}.records-row-open{margin-left:8px}.records-pii-tag{display:inline-block;margin-left:5px;padding:1px 4px;border-radius:4px;background:#fff0cc;color:#7a4c00;font-size:10px}.records-empty{color:var(--muted,#667085)}
  .records-explorer button[aria-disabled=true]{cursor:wait;opacity:.7}.records-detail{display:grid;gap:14px;min-width:0}.records-detail>*{min-width:0}.records-detail header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;min-width:0}.records-detail header>div{min-width:0}.records-detail header>button{flex:0 0 auto}.records-detail header small,.records-detail h3{overflow-wrap:anywhere}.records-detail h3{margin:2px 0}.records-detail dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:8px;min-width:0}.records-detail dl div{min-width:0;padding:10px;border:1px solid var(--border,#e4e7ec);border-radius:7px}.records-detail dt{font-weight:600}.records-detail dt,.records-detail dl div>small{overflow-wrap:anywhere}.records-detail dd{margin:5px 0;white-space:pre-wrap;overflow-wrap:anywhere}.records-detail-meta{color:var(--muted,#667085);font-size:13px;overflow-wrap:anywhere}.records-detail details{min-width:0}.records-detail pre{box-sizing:border-box;max-width:100%;min-width:0;overflow:auto;max-height:340px}.records-delete-confirm{min-width:0;border:1px solid #d92d20;padding:12px;border-radius:8px;overflow-wrap:anywhere}.records-delete-confirm button+button{margin-left:8px}.records-relationship-impact li,.records-relationship-impact code{overflow-wrap:anywhere}.records-relationship-impact ul,.records-outbox-events{margin:6px 0;padding-left:22px}.records-outbox{min-width:0;margin:14px 0;padding:10px;border:1px solid var(--border,#e4e7ec);border-radius:8px}.records-outbox>*{min-width:0}.records-outbox summary{overflow-wrap:anywhere}.records-outbox-summary{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:10px}.records-outbox-events{display:grid;gap:8px;min-width:0}.records-outbox-events>li{min-width:0;padding:8px;border-bottom:1px solid var(--border,#e4e7ec);overflow-wrap:anywhere}.records-outbox-events>li>*{min-width:0}.records-outbox-events>li>div:first-child{display:grid;gap:3px}.records-outbox-event-heading{display:flex;align-items:baseline;gap:4px;flex-wrap:wrap;min-width:0}.records-outbox-event-heading>*{min-width:0}.records-outbox-event-heading>span{display:inline-flex;align-items:baseline;gap:4px;max-width:100%}.records-outbox-events details{min-width:0}.records-outbox-events small,.records-help{color:var(--muted,#667085)}.records-outbox-events strong,.records-outbox-events small,.records-outbox-events p,.records-outbox-events code{overflow-wrap:anywhere}.records-purge-confirm{margin-top:10px}.records-purge-confirm label{display:grid;gap:4px;margin:8px 0}.records-purge-confirm input{width:100%;max-width:360px;min-width:0}
  @media(max-width:760px){.records-layout{grid-template-columns:1fr}.records-heading,.records-pack-summary{display:grid}.records-quota{display:grid}}
`;
