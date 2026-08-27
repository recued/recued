/** D-198 Slice 5 — the generic schema-driven collection explorer.
 *
 *  Restores the D-119 Warehouse explorer (lost with the Bridge extension): a
 *  browsable list → detail over the adapter-backed warehouse collections
 *  (`mail` / `calendar` / `file` / `webhook` / `service`), replacing the current
 *  raw-id `data.timeline` drill-down (which required you to already know a record
 *  id). GENERIC over `COLLECTION_DISPLAY_SCHEMAS` — a collection's `primary_field`
 *  / `summary_fields` / `detail_renderer` drive the rows + the record detail, so
 *  adding a future adapter collection gets explorer UI for free. No bespoke UI
 *  per collection.
 *
 *  Read path (all server-wired, callers added at mount): `collection.listInstances`
 *  → the `(platform, slug)` instances → `collection.list` → the records →
 *  `collection.get` → one record's full detail. Read-only: these rows are
 *  adapter-synced server-side (`origin_actor: 'system'`), never user-authored, so
 *  there's no CRUD surface (unlike the Memory lens / Owned tabs).
 *
 *  Pure render (HTML strings) + styles + click-dispatch constants the route
 *  wires — mirrors `memory-lens.ts`.
 *
 *  Spec: D-198 §4 + D-198 §B Slice 5. */

import {
  getCollectionDisplaySchema,
  readDisplayField,
  type CanonicalCollectionName,
  type CollectionInstanceRow,
  type CollectionRecord,
} from '@recued/contracts';
import { renderReferenceIdentity } from '@recued/ui-shared';

/** Click-dispatch contract with the route's `onClick` (keyed on
 *  `DATA_ROUTE_ACTION_ATTR`). The route adds one arm per action value. */
export const COLLECTION_SELECT_INSTANCE_ACTION = 'collection-select-instance';
export const COLLECTION_OPEN_RECORD_ACTION = 'collection-open-record';
export const COLLECTION_DETAIL_CLOSE_ACTION = 'collection-detail-close';
export const COLLECTION_RETRY_ACTION = 'collection-retry';
export const COLLECTION_DETAIL_RETRY_ACTION = 'collection-detail-retry';
/** `slug` of the instance the user picked / the `record_id` of the opened row. */
export const COLLECTION_INSTANCE_SLUG_ATTR = 'data-collection-slug';
export const COLLECTION_RECORD_ID_ATTR = 'data-collection-record';
/** Programmatic focus target for an exact record deep-link. */
export const COLLECTION_DETAIL_HEADING_ATTR =
  'data-recued-collection-detail-heading';
export const COLLECTION_RETRY_ATTR = 'data-recued-collection-retry';
export const COLLECTION_DETAIL_RETRY_ATTR =
  'data-recued-collection-detail-retry';

/** The open record detail — the lazy `collection.get` result for one record. */
export interface CollectionExplorerDetailState {
  record_id: string;
  loading: boolean;
  /** The resolved record (`collection.get` returns `null` for a vanished id). */
  record?: CollectionRecord | null;
  error?: string;
}

export interface CollectionExplorerProps {
  /** The active canonical collection — drives the display schema. */
  collection: CanonicalCollectionName;
  /** Instances of this collection's platform (from `collection.listInstances`,
   *  filtered to `platform === collection` by the route). */
  instances: readonly CollectionInstanceRow[];
  /** The selected instance's `slug` (null → the picker when >1; the route
   *  auto-selects when exactly 1). */
  selectedSlug: string | null;
  /** Records for the selected instance (from `collection.list`). */
  records: readonly CollectionRecord[];
  /** The open record detail (from `collection.get`), or null/absent = the list. */
  detail?: CollectionExplorerDetailState | null;
  /** True only when the open detail failed an available `collection.get`. */
  detailRetryable?: boolean;
  /** Keeps the failed detail and its Retry action visible while a fresh exact
   * read settles. */
  detailRetrying?: boolean;
  /** Pre-rendered controls slotted into the record-detail bar, beside "← Back".
   *  The route builds them; the explorer only renders the string (kept generic).
   *  The Files tab passes its D-172 "Download file" button here so a browsed
   *  file's bytes are reachable from the record detail. Rendered ONLY in the
   *  detail view (the list view never shows it). */
  detailActionsHtml?: string;
  /** D-210 step 3 — pre-rendered timeline section slotted BELOW the record's
   *  fields (the event's move history: D-120 write links + the D-119
   *  `scheduled-from` origin). Generic string slot like `detailActionsHtml` —
   *  the route builds it (via `renderTimelineSection`) and populates it for a
   *  calendar record; the explorer only renders the string. Rendered ONLY in
   *  the detail view. */
  detailTimelineHtml?: string;
  /** D-198 Phase 2 — the `annotation` / `link` provenance collections are single
   *  GLOBAL collections (no per-account instances, no platform/slug). When true,
   *  the explorer skips the instance bar + the platform-only "Nothing connected"
   *  / "Choose an instance" empty states and renders the records as the one
   *  collection's contents. */
  singleCollection?: boolean;
  loading: boolean;
  error?: string;
  /** True only for a failed read. Guidance and missing-wiring messages remain
   * alerts without offering a retry that cannot help. */
  retryable?: boolean;
  /** Keeps a failed list read visible and its Retry action focusable while a
   * fresh instance/list attempt settles. */
  retrying?: boolean;
  /** Wall-clock now for relative-time formatting (tests pass a fixed value). */
  now: number;
  /** The route's action-attribute name (`DATA_ROUTE_ACTION_ATTR`). */
  actionAttr: string;
}

const e = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Relative time — symmetric over past + future. Calendar `start_at` / `end_at`
 *  are usually in the FUTURE; without the future branch every upcoming event
 *  read "just now" (a negative delta stayed under the 45s floor). Past →
 *  "…ago", future → "in …", far out either way → an absolute date. */
const formatRelativeTime = (epochMs: number, now: number): string => {
  const deltaSec = Math.round((now - epochMs) / 1000);
  if (!Number.isFinite(deltaSec)) return '';
  const future = deltaSec < 0;
  const rel = (value: string): string => (future ? `in ${value}` : `${value} ago`);
  const absSec = Math.abs(deltaSec);
  if (absSec < 45) return 'just now';
  const mins = Math.round(absSec / 60);
  if (mins < 60) return rel(`${mins}m`);
  const hours = Math.round(mins / 60);
  if (hours < 24) return rel(`${hours}h`);
  const days = Math.round(hours / 24);
  if (days < 30) return rel(`${days}d`);
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
};

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** Humanize a schema field name for a label: `mime_type` → "Mime type",
 *  `received_at` → "Received". Trailing `_at` (a timestamp) drops for brevity. */
const fieldLabel = (field: string): string => {
  const base = field.endsWith('_at') ? field.slice(0, -3) : field;
  const spaced = base.replace(/_/g, ' ').trim();
  return spaced.length === 0 ? field : spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** Whether a field name denotes a timestamp we should render as relative time. */
const isTimeField = (field: string): boolean =>
  field.endsWith('_at') || field === 'mtime' || field === 'modified_at';

/** Format one display-field value for a row / the detail field list. Numbers on
 *  a time field render relative; `size` renders as bytes; everything else is
 *  coerced to a compact string (objects → JSON, so a nested value still shows). */
const formatFieldValue = (field: string, value: unknown, now: number): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' && isTimeField(field)) return formatRelativeTime(value, now);
  if ((field === 'size' || field === 'size_bytes') && typeof value === 'number') {
    return formatBytes(value);
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/** The record's title = the first of the schema's title fields present on the
 *  record (`primary_field`, then `primary_field_fallbacks` in order), falling
 *  back to the `record_id` so a row with none of them still identifies itself.
 *
 *  The chain exists because one canonical collection can hold several record
 *  SHAPES — `file` covers a watched-folder entry (`path`) and an inbound upload
 *  (`filename`, no `path`). With a single field the second shape titled every
 *  row with its 32-hex id, which reads as an id column rather than as a field
 *  the record happens to lack. `record_id` stays the last resort, not the
 *  routine answer. */
const recordTitle = (
  record: CollectionRecord,
  titleFields: readonly string[],
): string => {
  for (const field of titleFields) {
    const raw = readDisplayField(record as unknown as Record<string, unknown>, field);
    const title = typeof raw === 'string' ? raw : raw === undefined ? '' : String(raw);
    if (title.length > 0) return title;
  }
  return record.record_id;
};

/** One list row — the primary field as title + the summary fields as sub-text. */
const renderRow = (
  record: CollectionRecord,
  titleFields: readonly string[],
  summaryFields: readonly string[],
  now: number,
  actionAttr: string,
): string => {
  const title = recordTitle(record, titleFields);
  const summary = summaryFields
    .map((f) => {
      const val = formatFieldValue(
        f,
        readDisplayField(record as unknown as Record<string, unknown>, f),
        now,
      );
      return val.length > 0
        ? `<span class="col-explorer-field"><span class="col-explorer-field-label">${e(fieldLabel(f))}</span>${e(val)}</span>`
        : '';
    })
    .filter((s) => s.length > 0)
    .join('');
  return `<li class="col-explorer-row">
    <button type="button" class="col-explorer-row-btn" ${actionAttr}="${COLLECTION_OPEN_RECORD_ACTION}" ${COLLECTION_RECORD_ID_ATTR}="${e(record.record_id)}">
      <span class="col-explorer-row-title">${e(title)}</span>
      ${summary ? `<span class="col-explorer-row-summary">${summary}</span>` : ''}
    </button>
  </li>`;
};

/** The instance selector — a chip per `(platform, slug)` instance. Only rendered
 *  when there's more than one (a single instance is auto-selected by the route). */
const renderInstanceBar = (
  instances: readonly CollectionInstanceRow[],
  selectedSlug: string | null,
  actionAttr: string,
): string => {
  if (instances.length <= 1) return '';
  const chips = instances
    .map((inst) => {
      const active = inst.slug === selectedSlug;
      const label = `${inst.adapter_type} · ${inst.slug}`;
      return `<button type="button" class="col-explorer-instance-chip${active ? ' is-active' : ''}"
        ${actionAttr}="${COLLECTION_SELECT_INSTANCE_ACTION}" ${COLLECTION_INSTANCE_SLUG_ATTR}="${e(inst.slug)}"
        aria-pressed="${active ? 'true' : 'false'}">${e(label)}</button>`;
    })
    .join('');
  return `<div class="col-explorer-instances" role="group" aria-label="Choose an instance">${chips}</div>`;
};

/** The per-record detail — a schema-driven field list + the body (inline text)
 *  or a size note (CAS blob) + the raw hot-fields JSON. Generic over the
 *  collection; the `detail_renderer` hint refines the body presentation later. */
const renderDetail = (
  detail: CollectionExplorerDetailState,
  collection: CanonicalCollectionName,
  titleFields: readonly string[],
  summaryFields: readonly string[],
  now: number,
  actionAttr: string,
  detailRetryable: boolean,
  detailRetrying: boolean,
  detailActionsHtml: string,
  /** Single-collection (provenance) records carry no bytes and set source_id ===
   *  record_id, so their Size / Source-id / Modified meta rows are always empty
   *  or redundant. Trim them ONLY here — platform records keep the full meta
   *  (a legit 0-byte file still shows "Size: 0 B", etc.). */
  compact: boolean,
  /** D-210 step 3 — pre-rendered timeline section, slotted below the fields.
   *  Empty for every collection the route doesn't populate it for (calendar
   *  today). */
  detailTimelineHtml: string,
): string => {
  const back = `<button type="button" class="col-explorer-btn" ${actionAttr}="${COLLECTION_DETAIL_CLOSE_ACTION}">← Back</button>`;
  let body: string;
  if (detail.error !== undefined) {
    body = `<div class="col-explorer-recovery">
      <p class="col-explorer-error" role="alert">${e(detail.error)}</p>
      ${detailRetryable
        ? `<button type="button" class="col-explorer-btn"
          ${actionAttr}="${COLLECTION_DETAIL_RETRY_ACTION}" ${COLLECTION_DETAIL_RETRY_ATTR}
          ${detailRetrying ? 'aria-disabled="true" aria-busy="true"' : ''}>${
            detailRetrying ? 'Retrying…' : 'Retry'
          }</button>`
        : ''}
    </div>`;
  } else if (detail.loading || detail.record === undefined) {
    body = `<p class="col-explorer-loading">Loading record…</p>`;
  } else if (detail.record === null) {
    body = `<p class="col-explorer-empty">This record no longer exists.</p>`;
  } else {
    const record = detail.record;
    const rec = record as unknown as Record<string, unknown>;
    const title = recordTitle(record, titleFields);
    // Field list: the schema's summary fields + the always-present meta.
    const metaFields: Array<[string, string]> = [
      ...summaryFields.map(
        (f) => [fieldLabel(f), formatFieldValue(f, readDisplayField(rec, f), now)] as [string, string],
      ),
    ];
    const appendMetaField = (
      label: string,
      value: string,
      collisionLabel: string,
    ): void => {
      const existing = metaFields.find(
        ([candidate, candidateValue]) =>
          candidate === label && candidateValue.length > 0,
      );
      if (existing?.[1] === value) return;
      metaFields.push([existing === undefined ? label : collisionLabel, value]);
    };
    // In compact (single-collection) mode, drop the rows that are always
    // redundant / empty there: Received (no timestamp → 0), Modified (===
    // Received), Size (0), Source id (=== record_id). Platform records keep
    // them all (received_at is always a real ingest stamp).
    if (!compact || record.received_at > 0) {
      appendMetaField(
        'Received',
        formatRelativeTime(record.received_at, now),
        'Added to Recued',
      );
    }
    if (!compact || record.modified_at !== record.received_at) {
      appendMetaField(
        'Modified',
        formatRelativeTime(record.modified_at, now),
        'Last updated',
      );
    }
    if (!compact || record.size_bytes > 0) {
      appendMetaField(
        'Size',
        formatBytes(record.size_bytes),
        'Stored body size',
      );
    }
    if (!compact || record.source_id !== record.record_id) {
      metaFields.push(['Source id', record.source_id]);
    }
    // The record_id is the only handle a recipe can reference a stored record by
    // — `{{config.invoice_template}}` resolving to a `file:<32 hex>` is how
    // officecli's `document.template_fill` names the template it fills.
    //
    // ⚠ An uploaded file's id is ALREADY on screen today, but only by accident:
    // the `file` display schema declares `primary_field: 'path'`, inbound
    // records (`DataFileHotFields`) carry filename/mime_type/size and no `path`,
    // so `recordTitle` falls through to its `record_id` fallback. That is a
    // coincidence of two shapes sharing one schema (a watched-folder file DOES
    // have `path`) — the moment the schema gains a fallback chain and titles
    // these rows by filename, the id disappears. Stating it explicitly makes the
    // handle survive that fix rather than depend on the bug.
    //
    // `Source id` is not a substitute: for a webclient upload it is the upload
    // SESSION id (`session.upload_id`), and in compact mode it is dropped
    // precisely because it equals record_id.
    metaFields.push(['Record id', record.record_id]);
    const fields = metaFields
      .filter(([, v]) => typeof v === 'string' && v.length > 0)
      .map(
        ([label, v]) =>
          `<div class="col-explorer-detail-field"><dt>${e(label)}</dt><dd>${
            label === 'Record id' || label === 'Source id'
              ? renderReferenceIdentity({ value: v })
              : e(v)
          }</dd></div>`,
      )
      .join('');
    const bodyBlock =
      typeof record.body_inline === 'string' && record.body_inline.length > 0
        ? `<pre class="col-explorer-detail-body">${e(record.body_inline)}</pre>`
        : record.blob_hash !== undefined
          ? `<p class="col-explorer-empty">Large body (${e(formatBytes(record.size_bytes))}) — stored out of line.</p>`
          : '';
    let raw = '';
    try {
      raw = JSON.stringify(record.hot_fields ?? {}, null, 2);
    } catch {
      raw = '';
    }
    body = `<div class="col-explorer-detail-head">
        <span class="col-explorer-detail-scope">${e(collection)}</span>
        <h2 class="col-explorer-detail-title" ${COLLECTION_DETAIL_HEADING_ATTR} tabindex="-1">${e(title)}</h2>
      </div>
      ${fields ? `<dl class="col-explorer-detail-fields">${fields}</dl>` : ''}
      ${bodyBlock}
      ${raw && raw !== '{}' ? `<details class="col-explorer-detail-raw"><summary>Raw fields</summary><pre>${e(raw)}</pre></details>` : ''}`;
  }
  return `<section class="col-explorer-detail" aria-label="Record detail">
    <div class="col-explorer-detail-bar">${back}${detailActionsHtml}</div>
    ${body}
    ${detailTimelineHtml}
  </section>`;
};

export const renderCollectionExplorer = (props: CollectionExplorerProps): string => {
  const schema = getCollectionDisplaySchema(props.collection);
  // Defensive: an unknown collection (deep link with a bad name) → json defaults.
  // The title chain is primary → declared fallbacks; `recordTitle` supplies the
  // `record_id` last resort itself, so an unknown collection resolves to an
  // empty chain rather than needing `record_id` spelled in here.
  const titleFields = schema
    ? [schema.primary_field, ...(schema.primary_field_fallbacks ?? [])]
    : [];
  const summaryFields = schema?.summary_fields ?? [];
  const detail = props.detail ?? null;

  // View stack: detail > list.
  if (detail !== null) {
    return `<section class="col-explorer" data-recued-collection-explorer>${renderDetail(
      detail,
      props.collection,
      titleFields,
      summaryFields,
      props.now,
      props.actionAttr,
      props.detailRetryable ?? false,
      props.detailRetrying ?? false,
      props.detailActionsHtml ?? '',
      props.singleCollection ?? false,
      props.detailTimelineHtml ?? '',
    )}</section>`;
  }

  const instanceBar = props.singleCollection
    ? ''
    : renderInstanceBar(props.instances, props.selectedSlug, props.actionAttr);

  let body: string;
  if (props.error !== undefined) {
    body = `<div class="col-explorer-recovery">
      <p class="col-explorer-error" role="alert">${e(props.error)}</p>
      ${props.retryable
        ? `<button type="button" class="col-explorer-btn"
          ${props.actionAttr}="${COLLECTION_RETRY_ACTION}" ${COLLECTION_RETRY_ATTR}
          ${props.retrying ? 'aria-disabled="true" aria-busy="true"' : ''}>${
            props.retrying ? 'Retrying…' : 'Retry'
          }</button>`
        : ''}
    </div>`;
  } else if (!props.singleCollection && props.instances.length === 0) {
    body = `<p class="col-explorer-empty">Nothing connected for ${e(props.collection)} yet.</p>`;
  } else if (!props.singleCollection && props.selectedSlug === null && props.instances.length > 1) {
    body = `<p class="col-explorer-empty">Choose an instance above to browse its records.</p>`;
  } else if (props.loading && props.records.length === 0) {
    body = `<p class="col-explorer-loading">Loading records…</p>`;
  } else if (props.records.length === 0) {
    body = `<p class="col-explorer-empty">No records in this collection yet.</p>`;
  } else {
    body = `<ul class="col-explorer-list" role="list">${props.records
      .map((r) => renderRow(r, titleFields, summaryFields, props.now, props.actionAttr))
      .join('')}</ul>`;
  }

  return `<section class="col-explorer" data-recued-collection-explorer>
    ${instanceBar}
    ${body}
  </section>`;
};

export const COLLECTION_EXPLORER_STYLES = `
.col-explorer { min-width: 0; display: flex; flex-direction: column; gap: 0.75rem; }
.col-explorer-recovery { display: grid; justify-items: start; gap: 0.5rem; }
.col-explorer-btn {
  font: inherit; font-size: 0.8125rem; padding: 0.375rem 0.75rem;
  border: 1px solid var(--border); border-radius: 0.375rem;
  background: var(--surface); color: var(--fg); cursor: pointer;
}
.col-explorer-btn[aria-disabled="true"] { cursor: wait; opacity: 0.65; }
.col-explorer-instances { min-width: 0; display: flex; flex-wrap: wrap; gap: 0.375rem; }
.col-explorer-instance-chip {
  min-width: 0; max-width: 100%; overflow-wrap: anywhere; text-align: left;
  font: inherit; font-size: 0.8125rem; padding: 0.25rem 0.625rem; border-radius: 999px;
  border: 1px solid var(--border); background: transparent; color: var(--fg-muted); cursor: pointer;
}
.col-explorer-instance-chip.is-active { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.col-explorer-list { min-width: 0; list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.375rem; }
.col-explorer-row { min-width: 0; }
.col-explorer-row-btn {
  min-width: 0;
  width: 100%; text-align: left; display: flex; flex-direction: column; gap: 0.25rem;
  font: inherit; padding: 0.625rem 0.75rem; border: 1px solid var(--border);
  border-radius: 0.5rem; background: var(--surface); color: var(--fg); cursor: pointer;
}
.col-explorer-row-btn:hover { background: var(--surface-sunk); }
.col-explorer-row-title {
  min-width: 0;
  font-size: 0.875rem; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.col-explorer-row-summary { min-width: 0; display: flex; flex-wrap: wrap; gap: 0.75rem; font-size: 0.8125rem; color: var(--fg-muted); }
.col-explorer-field { min-width: 0; max-width: 100%; display: inline-flex; flex-wrap: wrap; gap: 0.3125rem; align-items: baseline; overflow-wrap: anywhere; }
.col-explorer-field-label { font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--fg-muted); }
.col-explorer-detail { display: flex; flex-direction: column; gap: 0.625rem; }
.col-explorer-detail-bar { margin-bottom: 0.25rem; display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap; }
.col-explorer-detail-head { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
.col-explorer-detail-scope {
  font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
  padding: 0.125rem 0.5rem; border-radius: 0.375rem; background: var(--surface-sunk); color: var(--fg-muted);
}
.col-explorer-detail-title { min-height: 24px; margin: 0; font-size: 0.9375rem; font-weight: 600; word-break: break-word; }
.col-explorer-detail-title:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.col-explorer-detail-fields { margin: 0; display: grid; grid-template-columns: minmax(6rem, auto) 1fr; gap: 0.25rem 0.75rem; }
.col-explorer-detail-field { display: contents; }
.col-explorer-detail-field dt { font-size: 0.75rem; font-weight: 600; color: var(--fg-muted); }
.col-explorer-detail-field dd { margin: 0; font-size: 0.8125rem; color: var(--fg); word-break: break-word; }
.col-explorer-detail-body {
  margin: 0; font: inherit; font-size: 0.875rem; white-space: pre-wrap; word-break: break-word;
  background: var(--surface-sunk); border-radius: 0.5rem; padding: 0.75rem; color: var(--fg); max-height: 24rem; overflow: auto;
}
.col-explorer-detail-raw summary {
  min-height: 36px; display: inline-flex; align-items: center;
  font-size: 0.8125rem; color: var(--fg-muted); cursor: pointer;
}
.col-explorer-detail-raw pre {
  margin: 0.375rem 0 0; font-size: 0.75rem; white-space: pre-wrap; word-break: break-word;
  background: var(--surface-sunk); border-radius: 0.5rem; padding: 0.625rem; color: var(--fg-muted);
}
.col-explorer-empty, .col-explorer-loading, .col-explorer-error { color: var(--fg-muted); font-size: 0.875rem; }
.col-explorer-error { color: var(--danger); }
@media (max-width: 360px) {
  .col-explorer-instance-chip { width: 100%; border-radius: 0.5rem; }
}
`;
