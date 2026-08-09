/** D-198 Memory lens — the transparent, origin-tagged memory feed rendered
 *  inside `#data` under the Data | Memory lens switch, plus (Slice 2) the
 *  owner CRUD surface: an "Add memory" compose form, per-row edit / delete for
 *  your OWN (`user_self`) entries, and a detail view that lazy-loads the full
 *  body via `memory.get`.
 *
 *  Reads `memory.list` (owner-trusted, whole-feed) and shows EVERY origin
 *  (D-198 §3 transparency), filterable by write-actor (You / Agents / System).
 *  Authorship is origin-scoped: you have full CRUD on your own `user_self`
 *  rows; engine / AI / contracted rows are view-only (no edit/delete rendered).
 *
 *  Pure render (returns HTML strings) + styles + click-/field-dispatch
 *  constants the route wires. Body previews are already clamped by the
 *  `memory.list` contract (never the full body, §5); the detail view fetches
 *  the full body on demand.
 *
 *  Spec: D-198 §4/§5 + D-198 §B Slice 1b/2. */

import type { Actor, MemoryGetResponse, MemoryImportResult, MemoryListEntry } from '@recued/contracts';

/** Origin-filter selector — the "tenancy view" over one store (D-198 §2):
 *  `all` = no filter; the rest map 1:1 to a D-161 `Actor`. */
export type MemoryOriginFilter = 'all' | 'user_self' | 'contracted_user' | 'system';

export const MEMORY_ORIGIN_FILTERS: readonly MemoryOriginFilter[] = [
  'all',
  'user_self',
  'contracted_user',
  'system',
];

/** Filter → `memory.list` `origin_actors` arg (`undefined` = whole feed). */
export const memoryFilterActors = (f: MemoryOriginFilter): Actor[] | undefined =>
  f === 'all' ? undefined : [f];

/** Click-dispatch contract with the route's `onClick` (keyed on
 *  `DATA_ROUTE_ACTION_ATTR`). The route adds one arm for this action value
 *  and reads the selected filter off `MEMORY_FILTER_VALUE_ATTR`. */
export const MEMORY_FILTER_ACTION = 'memory-filter';
export const MEMORY_FILTER_VALUE_ATTR = 'data-memory-filter';

/** The Data | Memory lens switcher (route chrome). Click dispatches through
 *  the same `actionAttr` as everything else; the route reads the target lens
 *  off `MEMORY_LENS_VALUE_ATTR`. */
export const MEMORY_LENS_SELECT_ACTION = 'select-lens';
export const MEMORY_LENS_VALUE_ATTR = 'data-memory-lens';

/** Slice 2 CRUD dispatch. `*_ROW_ID_ATTR` carries the target `memory_id`;
 *  `*_FIELD_ATTR` tags the compose-form inputs the route syncs on `input`. */
/** ⛔ The feed's page-2 door. `memory.list` returns `next_cursor` and this lens
 *  never asked for it: it requested 100 entries, ignored the cursor, and
 *  rendered nothing about there being more — so an owner with 101 memories saw
 *  100 and no way to tell. The lens header calls this feed "whole-feed", which
 *  is what it was meant to be; `data.memory` is UNBOUNDED under D-230 (owner
 *  knowledge is never pruned), so one page is never the whole feed. */
export const MEMORY_MORE_ACTION = 'memory-more';

export const MEMORY_ADD_ACTION = 'memory-add';
export const MEMORY_OPEN_ACTION = 'memory-open';
export const MEMORY_OPEN_RUN_ACTION = 'memory-open-run';
export const MEMORY_EDIT_ACTION = 'memory-edit';
export const MEMORY_DELETE_ACTION = 'memory-delete';
export const MEMORY_DELETE_CONFIRM_ACTION = 'memory-delete-confirm';
export const MEMORY_DELETE_CANCEL_ACTION = 'memory-delete-cancel';
export const MEMORY_COMPOSE_SUBMIT_ACTION = 'memory-compose-submit';
export const MEMORY_COMPOSE_CANCEL_ACTION = 'memory-compose-cancel';
export const MEMORY_COMPOSE_DISCARD_KEEP_ACTION = 'memory-compose-discard-keep';
export const MEMORY_COMPOSE_DISCARD_COMMIT_ACTION = 'memory-compose-discard-commit';
export const MEMORY_COMPOSE_DISCARD_GUARD_ATTR =
  'data-recued-memory-compose-discard-guard';
export const MEMORY_COMPOSE_DISCARD_KEEP_ATTR =
  'data-recued-memory-compose-discard-keep';
export const MEMORY_COMPOSE_DISCARD_COMMIT_ATTR =
  'data-recued-memory-compose-discard-commit';
export const MEMORY_DETAIL_CLOSE_ACTION = 'memory-detail-close';
export const MEMORY_DETAIL_HEADING_ATTR = 'data-recued-memory-detail-heading';
export const MEMORY_IMPORT_ACTION = 'memory-import';
export const MEMORY_IMPORT_SUBMIT_ACTION = 'memory-import-submit';
export const MEMORY_IMPORT_CANCEL_ACTION = 'memory-import-cancel';
export const MEMORY_IMPORT_DISCARD_KEEP_ACTION = 'memory-import-discard-keep';
export const MEMORY_IMPORT_DISCARD_COMMIT_ACTION = 'memory-import-discard-commit';
export const MEMORY_IMPORT_DISCARD_GUARD_ATTR =
  'data-recued-memory-import-discard-guard';
export const MEMORY_IMPORT_DISCARD_KEEP_ATTR =
  'data-recued-memory-import-discard-keep';
export const MEMORY_IMPORT_DISCARD_COMMIT_ATTR =
  'data-recued-memory-import-discard-commit';
export const MEMORY_EXPORT_ACTION = 'memory-export';
export const MEMORY_ROW_ID_ATTR = 'data-memory-id';
export const MEMORY_FIELD_ATTR = 'data-memory-field';
const MEMORY_LENS_HEADING_ID = 'recued-memory-lens-heading';

/** Compose (create/edit) form state, owned by the route, rendered here. */
export interface MemoryComposeState {
  open: boolean;
  mode: 'create' | 'edit';
  /** The edited row's id (edit mode only). */
  editId?: string;
  kind: string;
  summary: string;
  body: string;
  submitting: boolean;
  error?: string;
}

/** Detail-view state — the lazy `memory.get` result for one entry. */
export interface MemoryDetailState {
  memory_id: string;
  loading: boolean;
  entry?: MemoryGetResponse;
  error?: string;
}

/** Import-panel state — a pasted `{ entries: [...] }` (or bare array) JSON body
 *  fed to `memory.import`. `result` holds the per-outcome tally on success. */
export interface MemoryImportState {
  open: boolean;
  text: string;
  submitting: boolean;
  error?: string;
  result?: MemoryImportResult;
}

export const renderLensSwitcher = (
  lens: 'data' | 'memory',
  actionAttr: string,
  disabled = false,
): string => {
  const btn = (value: 'data' | 'memory', label: string): string => {
    const active = lens === value;
    return `<button type="button" class="data-lens-btn${active ? ' is-active' : ''}"
      ${actionAttr}="${MEMORY_LENS_SELECT_ACTION}" ${MEMORY_LENS_VALUE_ATTR}="${value}"
      aria-pressed="${active ? 'true' : 'false'}"${disabled
        ? ' aria-disabled="true"'
        : ''}>${label}</button>`;
  };
  return `<div class="data-lens-switch" role="group" aria-label="Data or Memory">${btn('data', 'Data')}${btn('memory', 'Memory')}</div>`;
};

const FILTER_LABEL: Record<MemoryOriginFilter, string> = {
  all: 'All',
  user_self: 'You',
  contracted_user: 'Agents',
  system: 'System',
};

const ORIGIN_LABEL: Record<Actor, string> = {
  user_self: 'You',
  contracted_user: 'Agent',
  system: 'System',
  anonymous: 'External',
};

export interface MemoryLensProps {
  entries: readonly MemoryListEntry[];
  originFilter: MemoryOriginFilter;
  loading: boolean;
  error?: string;
  /** Wall-clock now for relative-time formatting (tests pass a fixed value). */
  now: number;
  /** The route's action-attribute name (`DATA_ROUTE_ACTION_ATTR`). */
  actionAttr: string;
  /** Route hash for a run's audit detail — `#logs/<run_id>`. */
  runHref: (run_id: string) => string;
  /** Slice 2 — the compose form state (absent/closed = the feed list). */
  compose?: MemoryComposeState;
  /** Local review shown before a populated compose draft is discarded. */
  composeDiscardGuard?: boolean;
  /** Slice 2 — the open detail view (absent = the feed list). */
  detail?: MemoryDetailState | null;
  /** Slice 3 — the open import panel (absent/closed = the feed list). */
  importPanel?: MemoryImportState;
  /** Local review shown before populated import JSON is discarded. */
  importDiscardGuard?: boolean;
  /** The origin chip whose replacement feed is loading. */
  filteringOrigin?: MemoryOriginFilter;
  /** Slice 3 — an export walk is in flight. */
  exporting?: boolean;
  /** True when the server reported a `next_cursor` — there is another page. */
  hasMore?: boolean;
  /** A Load-more read is in flight. */
  loadingMore?: boolean;
  /** Slice 2 — the row awaiting a delete confirm (inline two-step). */
  pendingDeleteId?: string;
  /** The confirmed Delete/Forget write currently owned by one row. */
  deletingId?: string;
  /** Row-local Delete/Forget failure; keeps the confirmation retryable. */
  deleteError?: string;
  /** The owner row whose full body is loading into the Edit compose form. */
  openingEditId?: string;
  /** Row-local Edit prefill failure; keeps Edit visible and retryable. */
  editError?: { memoryId: string; message: string };
  /** Slice 2 — whether the owner CRUD callers are wired; gates the write
   *  affordances (Add / Edit / Delete). Absent = read-only (no affordances). */
  canWrite?: boolean;
}

const e = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Relative time, mirroring the entity-detail panel's `formatRelativeTime`. */
const formatRelativeTime = (epochMs: number, now: number): string => {
  const deltaSec = Math.round((now - epochMs) / 1000);
  if (!Number.isFinite(deltaSec)) return '';
  if (deltaSec < 45) return 'just now';
  const mins = Math.round(deltaSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
};

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

type MemoryActionTarget = Pick<
  MemoryListEntry,
  'memory_id' | 'origin_actor' | 'kind' | 'summary'
> & {
  body_preview?: string;
  body?: string;
};

const memoryActionSubject = (entry: MemoryActionTarget): string => {
  const visible = entry.summary?.trim()
    || entry.body_preview?.trim()
    || entry.body?.trim()
    || `${ORIGIN_LABEL[entry.origin_actor] ?? String(entry.origin_actor)} ${entry.kind}`;
  const compact = visible.replace(/\s+/g, ' ');
  return compact.length > 80 ? `${compact.slice(0, 79)}…` : compact;
};

const memoryActionName = (
  label: string,
  entry: MemoryActionTarget,
): string => e(`${label} ${memoryActionSubject(entry)} (${entry.memory_id})`);

const renderFilterChip = (
  filter: MemoryOriginFilter,
  active: MemoryOriginFilter,
  actionAttr: string,
  disabled: boolean,
  busy: boolean,
): string => {
  const isActive = filter === active;
  return `<button type="button" class="memory-filter-chip${isActive ? ' is-active' : ''}"
    ${actionAttr}="${MEMORY_FILTER_ACTION}" ${MEMORY_FILTER_VALUE_ATTR}="${e(filter)}"
    aria-pressed="${isActive ? 'true' : 'false'}"${disabled
      ? ' aria-disabled="true"'
      : ''}${busy ? ' aria-busy="true"' : ''}>${e(FILTER_LABEL[filter])}${busy
        ? '…'
        : ''}</button>`;
};

/** The per-row action foot: the audit run link, a "View" affordance for rows
 *  carrying a full body, and — when writes are wired (§3) — Edit + Delete on the
 *  owner's OWN rows, or **Forget** (redact) on others' rows (engine / AI /
 *  contracted). All destructive actions are an inline two-step confirm. A row
 *  that is ALREADY redacted keeps only its run link (nothing left to act on). */
const renderRowFoot = (
  entry: MemoryListEntry,
  actionAttr: string,
  runHref: (id: string) => string,
  pendingDeleteId: string | undefined,
  deletingId: string | undefined,
  deleteError: string | undefined,
  openingEditId: string | undefined,
  editError: { memoryId: string; message: string } | undefined,
  canWrite: boolean,
  locked: boolean,
): string => {
  const isOwn = entry.origin_actor === 'user_self';
  const isRedacted = entry.redacted === true;
  const idAttr = `${MEMORY_ROW_ID_ATTR}="${e(entry.memory_id)}"`;
  const actionName = (label: string): string => memoryActionName(label, entry);
  const destructiveVerb = isOwn ? 'deleting' : 'forgetting';
  const destructiveProgress = isOwn ? 'Deleting…' : 'Forgetting…';
  const runLink =
    entry.run_id !== undefined && entry.run_id.length > 0
      ? `<a class="memory-row-run-link" href="${e(runHref(entry.run_id))}"
          ${actionAttr}="${MEMORY_OPEN_RUN_ACTION}" aria-label="${actionName('Open run for memory')}"${locked
            ? ' aria-disabled="true"'
            : ''}>Open run</a>`
      : '';
  if (isRedacted) {
    return runLink.length > 0 ? `<div class="memory-row-foot">${runLink}</div>` : '';
  }
  const openBtn =
    entry.has_body === true
      ? `<button type="button" class="memory-row-btn" ${actionAttr}="${MEMORY_OPEN_ACTION}" ${idAttr}${locked
        ? ' aria-disabled="true"'
        : ''} aria-label="${actionName('View memory')}">View</button>`
      : '';
  let controls = '';
  if (canWrite) {
    if (pendingDeleteId === entry.memory_id) {
      const prompt = isOwn ? 'Delete this memory?' : 'Forget this memory?';
      const deleting = deletingId === entry.memory_id;
      controls = `<span class="memory-row-confirm">${prompt}
        <button type="button" class="memory-row-btn memory-row-btn--danger"
          ${actionAttr}="${MEMORY_DELETE_CONFIRM_ACTION}" ${idAttr}${deleting
            ? ' aria-disabled="true" aria-busy="true"'
            : locked
              ? ' aria-disabled="true"'
            : ''} aria-label="${actionName(deleting
              ? `${destructiveProgress} memory`
              : `Confirm ${destructiveVerb} memory`)}">${deleting ? destructiveProgress : 'Confirm'}</button>
        <button type="button" class="memory-row-btn"
          ${actionAttr}="${MEMORY_DELETE_CANCEL_ACTION}" ${idAttr}${deleting || locked
            ? ' aria-disabled="true"'
            : ''} aria-label="${actionName(`Cancel ${destructiveVerb} memory`)}">Cancel</button>
        ${deleteError !== undefined
          ? `<span class="memory-row-delete-error" role="alert">${e(deleteError)}</span>`
          : ''}</span>`;
    } else if (isOwn) {
      const openingEdit = openingEditId === entry.memory_id;
      controls = `<button type="button" class="memory-row-btn"
          ${actionAttr}="${MEMORY_EDIT_ACTION}" ${idAttr}${openingEdit
            ? ' aria-disabled="true" aria-busy="true"'
            : locked
              ? ' aria-disabled="true"'
            : ''} aria-label="${actionName(openingEdit ? 'Opening… memory' : 'Edit memory')}">${openingEdit ? 'Opening…' : 'Edit'}</button>
        <button type="button" class="memory-row-btn memory-row-btn--danger"
          ${actionAttr}="${MEMORY_DELETE_ACTION}" ${idAttr}${openingEdit || locked
            ? ' aria-disabled="true"'
            : ''} aria-label="${actionName('Delete memory')}">Delete</button>
        ${editError?.memoryId === entry.memory_id
          ? `<span class="memory-row-edit-error" role="alert">${e(editError.message)}</span>`
          : ''}`;
    } else {
      // Others' rows are view + redact only (§3) — no edit.
      controls = `<button type="button" class="memory-row-btn memory-row-btn--danger" ${actionAttr}="${MEMORY_DELETE_ACTION}" ${idAttr}${locked
        ? ' aria-disabled="true"'
        : ''} aria-label="${actionName('Forget memory')}">Forget</button>`;
    }
  }
  const inner = `${runLink}${openBtn}${controls}`;
  return inner.length > 0 ? `<div class="memory-row-foot">${inner}</div>` : '';
};

const renderRow = (
  entry: MemoryListEntry,
  now: number,
  actionAttr: string,
  runHref: (id: string) => string,
  pendingDeleteId: string | undefined,
  deletingId: string | undefined,
  deleteError: string | undefined,
  openingEditId: string | undefined,
  editError: { memoryId: string; message: string } | undefined,
  canWrite: boolean,
  locked: boolean,
): string => {
  const origin = ORIGIN_LABEL[entry.origin_actor] ?? String(entry.origin_actor);
  const summary = entry.summary ?? '';
  const bodyPreview = entry.body_preview ?? '';
  // The summary (the author's short label) leads; the body preview rides below
  // when a distinct summary occupies the title. A row with only a body shows
  // that body as the primary line (no summary to headline it).
  const primary = summary.length > 0 ? summary : bodyPreview;
  const secondary = summary.length > 0 && bodyPreview.length > 0 ? bodyPreview : '';
  const isRedacted = entry.redacted === true;
  const size = !isRedacted && entry.size_bytes !== undefined ? formatBytes(entry.size_bytes) : '';
  const when = formatRelativeTime(entry.event_at ?? entry.ts, now);
  // A redacted row still displays (transparency, §3) — origin / kind / time
  // stay; its content is replaced with a muted "Redacted" marker.
  const bodyLines = isRedacted
    ? '<p class="memory-row-redacted">Redacted</p>'
    : `${primary ? `<p class="memory-row-title">${e(primary)}</p>` : ''}${
        secondary ? `<p class="memory-row-preview">${e(secondary)}</p>` : ''}`;
  return `<li class="memory-row${isRedacted ? ' is-redacted' : ''}" data-origin="${e(entry.origin_actor)}">
    <div class="memory-row-head">
      <span class="memory-origin-chip memory-origin-${e(entry.origin_actor)}">${e(origin)}</span>
      <span class="memory-row-kind">${e(entry.kind)}</span>
      ${size ? `<span class="memory-row-size">${e(size)}</span>` : ''}
      <span class="memory-row-time">${e(when)}</span>
    </div>
    ${bodyLines}
    ${renderRowFoot(
      entry,
      actionAttr,
      runHref,
      pendingDeleteId,
      deletingId,
      deleteError,
      openingEditId,
      editError,
      canWrite,
      locked,
    )}
  </li>`;
};

/** The create/edit compose form (an inline panel replacing the feed). */
const renderComposeForm = (
  compose: MemoryComposeState,
  actionAttr: string,
  discardGuardOpen: boolean,
): string => {
  const title = compose.mode === 'edit' ? 'Edit memory' : 'New memory';
  const err = compose.error !== undefined
    ? `<p class="memory-compose-error" role="alert">${e(compose.error)}</p>`
    : '';
  const editorStateAttr = discardGuardOpen
    ? ' inert aria-hidden="true"'
    : '';
  const readonlyAttr = compose.submitting ? ' readonly' : '';
  const discardGuard = discardGuardOpen
    ? `<section ${MEMORY_COMPOSE_DISCARD_GUARD_ATTR}
        role="alertdialog" aria-modal="true"
        aria-labelledby="memory-compose-discard-title"
        aria-describedby="memory-compose-discard-description"
        tabindex="-1">
        <h3 id="memory-compose-discard-title">Discard your memory changes?</h3>
        <p id="memory-compose-discard-description">Your unfinished changes will be lost.</p>
        <div class="memory-compose-discard-actions">
          <button type="button" class="memory-btn"
            ${actionAttr}="${MEMORY_COMPOSE_DISCARD_KEEP_ACTION}"
            ${MEMORY_COMPOSE_DISCARD_KEEP_ATTR}>Keep editing</button>
          <button type="button" class="memory-btn memory-btn--danger"
            ${actionAttr}="${MEMORY_COMPOSE_DISCARD_COMMIT_ACTION}"
            ${MEMORY_COMPOSE_DISCARD_COMMIT_ATTR}>Discard changes</button>
        </div>
      </section>`
    : '';
  return `<section class="memory-compose" role="form" aria-label="${e(title)}">
    ${discardGuard}
    <div class="memory-compose-editor"${editorStateAttr}>
      <header class="memory-compose-head"><h3 class="memory-compose-title">${e(title)}</h3></header>
      <label class="memory-field">
        <span class="memory-field-label">Kind</span>
        <input class="memory-input" type="text" placeholder="e.g. note, preference, fact"
          value="${e(compose.kind)}" ${MEMORY_FIELD_ATTR}="kind"${readonlyAttr} />
      </label>
      <label class="memory-field">
        <span class="memory-field-label">Summary <span class="memory-field-hint">(optional)</span></span>
        <input class="memory-input" type="text" value="${e(compose.summary)}" ${MEMORY_FIELD_ATTR}="summary"${readonlyAttr} />
      </label>
      <label class="memory-field">
        <span class="memory-field-label">Body</span>
        <textarea class="memory-textarea" rows="6" ${MEMORY_FIELD_ATTR}="body"${readonlyAttr}>${e(compose.body)}</textarea>
      </label>
      ${err}
      <footer class="memory-compose-actions">
        <button type="button" class="memory-btn memory-compose-cancel"
          ${actionAttr}="${MEMORY_COMPOSE_CANCEL_ACTION}"${compose.submitting
            ? ' aria-disabled="true"'
            : ''}>Cancel</button>
        <button type="button" class="memory-btn memory-btn--primary"
          ${actionAttr}="${MEMORY_COMPOSE_SUBMIT_ACTION}"${compose.submitting
            ? ' aria-disabled="true" aria-busy="true"'
            : ''}>${compose.submitting ? 'Saving…' : 'Save'}</button>
      </footer>
    </div>
  </section>`;
};

/** The import panel — paste an exported `{ entries: [...] }` (or bare array)
 *  JSON body; on success shows the merged/inserted/deduped/skipped tally. */
const renderImportPanel = (
  state: MemoryImportState,
  actionAttr: string,
  discardGuardOpen: boolean,
): string => {
  const err = state.error !== undefined
    ? `<p class="memory-compose-error" role="alert">${e(state.error)}</p>`
    : '';
  const tally = state.result !== undefined
    ? `<p class="memory-import-result" role="status">Imported — merged ${state.result.merged}, inserted ${state.result.inserted}, deduped ${state.result.deduped}, skipped ${state.result.skipped}.</p>`
    : '';
  const editorStateAttr = discardGuardOpen
    ? ' inert aria-hidden="true"'
    : '';
  const readonlyAttr = state.submitting ? ' readonly' : '';
  const discardGuard = discardGuardOpen
    ? `<section ${MEMORY_IMPORT_DISCARD_GUARD_ATTR}
        role="alertdialog" aria-modal="true"
        aria-labelledby="memory-import-discard-title"
        aria-describedby="memory-import-discard-description"
        tabindex="-1">
        <h3 id="memory-import-discard-title">Discard this import draft?</h3>
        <p id="memory-import-discard-description">Your pasted JSON will be lost.</p>
        <div class="memory-import-discard-actions">
          <button type="button" class="memory-btn"
            ${actionAttr}="${MEMORY_IMPORT_DISCARD_KEEP_ACTION}"
            ${MEMORY_IMPORT_DISCARD_KEEP_ATTR}>Keep editing</button>
          <button type="button" class="memory-btn memory-btn--danger"
            ${actionAttr}="${MEMORY_IMPORT_DISCARD_COMMIT_ACTION}"
            ${MEMORY_IMPORT_DISCARD_COMMIT_ATTR}>Discard draft</button>
        </div>
      </section>`
    : '';
  return `<section class="memory-compose" role="form" aria-label="Import memory">
    ${discardGuard}
    <div class="memory-import-editor"${editorStateAttr}>
      <header class="memory-compose-head"><h3 class="memory-compose-title">Import memory</h3></header>
      <p class="memory-field-hint">Paste exported memory JSON — a <code>{ "entries": [ … ] }</code> object or a bare array. Your own entries merge by id; shared entries dedupe by content.</p>
      <label class="memory-field">
        <span class="memory-field-label">JSON</span>
        <textarea class="memory-textarea" rows="8" ${MEMORY_FIELD_ATTR}="import" placeholder='{ "entries": [ … ] }'${readonlyAttr}>${e(state.text)}</textarea>
      </label>
      ${err}
      ${tally}
      <footer class="memory-compose-actions">
        <button type="button" class="memory-btn memory-import-cancel"
          ${actionAttr}="${MEMORY_IMPORT_CANCEL_ACTION}"${state.submitting
            ? ' aria-disabled="true"'
            : ''}>Close</button>
        <button type="button" class="memory-btn memory-btn--primary"
          ${actionAttr}="${MEMORY_IMPORT_SUBMIT_ACTION}"${state.submitting
            ? ' aria-disabled="true" aria-busy="true"'
            : ''}>${state.submitting ? 'Importing…' : 'Import'}</button>
      </footer>
    </div>
  </section>`;
};

/** The detail view — full body (lazy `memory.get`), + Edit/Delete for own rows. */
const renderDetail = (
  detail: MemoryDetailState,
  now: number,
  actionAttr: string,
  pendingDeleteId: string | undefined,
  deletingId: string | undefined,
  deleteError: string | undefined,
  openingEditId: string | undefined,
  editError: { memoryId: string; message: string } | undefined,
  canWrite: boolean,
): string => {
  const back = `<button type="button" class="memory-btn" ${actionAttr}="${MEMORY_DETAIL_CLOSE_ACTION}">← Back</button>`;
  let body: string;
  if (detail.error !== undefined) {
    body = `<p class="memory-lens-error" role="alert">${e(detail.error)}</p>`;
  } else if (detail.loading || detail.entry === undefined) {
    body = `<p class="memory-lens-loading">Loading memory…</p>`;
  } else {
    const entry = detail.entry;
    const origin = ORIGIN_LABEL[entry.origin_actor] ?? String(entry.origin_actor);
    const when = formatRelativeTime(entry.event_at ?? entry.ts, now);
    const isOwn = entry.origin_actor === 'user_self';
    const isRedacted = entry.redacted === true;
    const idAttr = `${MEMORY_ROW_ID_ATTR}="${e(entry.memory_id)}"`;
    const actionName = (label: string): string => memoryActionName(label, entry);
    const destructiveVerb = isOwn ? 'deleting' : 'forgetting';
    const destructiveProgress = isOwn ? 'Deleting…' : 'Forgetting…';
    let controls = '';
    if (canWrite && !isRedacted) {
      if (pendingDeleteId === entry.memory_id) {
        const prompt = isOwn ? 'Delete this memory?' : 'Forget this memory?';
        const deleting = deletingId === entry.memory_id;
        controls = `<span class="memory-row-confirm">${prompt}
            <button type="button" class="memory-btn memory-btn--danger"
              ${actionAttr}="${MEMORY_DELETE_CONFIRM_ACTION}" ${idAttr}${deleting
                ? ' aria-disabled="true" aria-busy="true"'
                : ''} aria-label="${actionName(deleting
                  ? `${destructiveProgress} memory`
                  : `Confirm ${destructiveVerb} memory`)}">${deleting ? destructiveProgress : 'Confirm'}</button>
            <button type="button" class="memory-btn"
              ${actionAttr}="${MEMORY_DELETE_CANCEL_ACTION}" ${idAttr}${deleting
                ? ' aria-disabled="true"'
                : ''} aria-label="${actionName(`Cancel ${destructiveVerb} memory`)}">Cancel</button>
            ${deleteError !== undefined
              ? `<span class="memory-row-delete-error" role="alert">${e(deleteError)}</span>`
              : ''}</span>`;
      } else if (isOwn) {
        const openingEdit = openingEditId === entry.memory_id;
        controls = `<button type="button" class="memory-btn"
             ${actionAttr}="${MEMORY_EDIT_ACTION}" ${idAttr}${openingEdit
               ? ' aria-disabled="true" aria-busy="true"'
               : ''} aria-label="${actionName(openingEdit ? 'Opening… memory' : 'Edit memory')}">${openingEdit ? 'Opening…' : 'Edit'}</button>
           <button type="button" class="memory-btn memory-btn--danger"
             ${actionAttr}="${MEMORY_DELETE_ACTION}" ${idAttr}${openingEdit
               ? ' aria-disabled="true"'
               : ''} aria-label="${actionName('Delete memory')}">Delete</button>
           ${editError?.memoryId === entry.memory_id
             ? `<span class="memory-row-edit-error" role="alert">${e(editError.message)}</span>`
             : ''}`;
      } else {
        // Others' rows are view + redact only (§3).
        controls = `<button type="button" class="memory-btn memory-btn--danger" ${actionAttr}="${MEMORY_DELETE_ACTION}" ${idAttr} aria-label="${actionName('Forget memory')}">Forget</button>`;
      }
    }
    const content = isRedacted
      ? '<p class="memory-row-redacted">This memory has been redacted.</p>'
      : `${entry.summary !== undefined ? `<p class="memory-detail-summary">${e(entry.summary)}</p>` : ''}${
          entry.body !== undefined
            ? `<pre class="memory-detail-body">${e(entry.body)}</pre>`
            : '<p class="memory-lens-empty">This entry has no body.</p>'}`;
    body = `<div class="memory-detail-head">
        <span class="memory-origin-chip memory-origin-${e(entry.origin_actor)}">${e(origin)}</span>
        <span class="memory-row-kind">${e(entry.kind)}</span>
        <span class="memory-row-time">${e(when)}</span>
      </div>
      ${content}
      ${controls ? `<footer class="memory-detail-actions">${controls}</footer>` : ''}`;
  }
  return `<section class="memory-detail" aria-label="Memory detail">
    <div class="memory-detail-bar">${back}</div>
    <h3 class="memory-detail-title" ${MEMORY_DETAIL_HEADING_ATTR} tabindex="-1">Memory detail</h3>
    ${body}
  </section>`;
};

const renderMemoryLensFrame = (content: string): string => `
  <section class="memory-lens" data-recued-memory-lens
    aria-labelledby="${MEMORY_LENS_HEADING_ID}">
    <h2 class="memory-lens-title" id="${MEMORY_LENS_HEADING_ID}">Memory</h2>
    ${content}
  </section>`;

export const renderMemoryLens = (props: MemoryLensProps): string => {
  const canWrite = props.canWrite ?? false;
  const detail = props.detail ?? null;
  const compose = props.compose;

  // View stack: detail > compose > list.
  if (detail !== null) {
    return renderMemoryLensFrame(renderDetail(
      detail,
      props.now,
      props.actionAttr,
      props.pendingDeleteId,
      props.deletingId,
      props.deleteError,
      props.openingEditId,
      props.editError,
      canWrite,
    ));
  }
  if (compose !== undefined && compose.open) {
    return renderMemoryLensFrame(renderComposeForm(
      compose,
      props.actionAttr,
      props.composeDiscardGuard === true,
    ));
  }
  if (props.importPanel !== undefined && props.importPanel.open) {
    return renderMemoryLensFrame(renderImportPanel(
      props.importPanel,
      props.actionAttr,
      props.importDiscardGuard === true,
    ));
  }

  const exporting = props.exporting === true;
  const filteringOrigin = props.filteringOrigin ?? null;
  const listLocked = exporting || filteringOrigin !== null;
  const chips = MEMORY_ORIGIN_FILTERS.map((f) =>
    renderFilterChip(
      f,
      props.originFilter,
      props.actionAttr,
      listLocked,
      filteringOrigin === f,
    ),
  ).join('');
  const addBtn = canWrite
    ? `<div class="memory-lens-actions">
        <button type="button" class="memory-btn"
          ${props.actionAttr}="${MEMORY_EXPORT_ACTION}"${exporting
            ? ' aria-disabled="true" aria-busy="true"'
            : listLocked
              ? ' aria-disabled="true"'
            : ''}>${exporting ? 'Exporting…' : 'Export'}</button>
        <button type="button" class="memory-btn"
          ${props.actionAttr}="${MEMORY_IMPORT_ACTION}"${listLocked
            ? ' aria-disabled="true"'
            : ''}>Import</button>
        <button type="button" class="memory-btn memory-btn--primary"
          ${props.actionAttr}="${MEMORY_ADD_ACTION}"${listLocked
            ? ' aria-disabled="true"'
            : ''}>Add memory</button>
      </div>`
    : '';

  let body: string;
  if (props.error !== undefined) {
    body = `<p class="memory-lens-error" role="alert">${e(props.error)}</p>`;
  } else if (props.loading && props.entries.length === 0) {
    body = `<p class="memory-lens-loading">Loading memory…</p>`;
  } else if (props.entries.length === 0) {
    body = `<p class="memory-lens-empty">No memory entries${
      props.originFilter === 'all' ? '' : ' for this origin'
    } yet.</p>`;
  } else {
    body = `<ul class="memory-list" role="list">${props.entries
      .map((entry) =>
        renderRow(
          entry,
          props.now,
          props.actionAttr,
          props.runHref,
          props.pendingDeleteId,
          props.deletingId,
          props.deleteError,
          props.openingEditId,
          props.editError,
          canWrite,
          listLocked,
        ),
      )
      .join('')}</ul>${
      // ⚠ Rendered only when the SERVER said there is more. Showing the button
      // unconditionally would invite a click that returns nothing, which reads
      // as a broken feed rather than the end of one.
      props.hasMore === true
        ? `<button type="button" class="memory-btn memory-more"
             ${props.actionAttr}="${MEMORY_MORE_ACTION}"
             aria-disabled="${props.loadingMore === true ? 'true' : 'false'}"${
               props.loadingMore === true || listLocked ? ' disabled' : ''
             }>${props.loadingMore === true ? 'Loading…' : 'Load more'}</button>`
        : ''
    }`;
  }

  return renderMemoryLensFrame(`
    <div class="memory-lens-controls">
      <div class="memory-filter-chips" role="group" aria-label="Filter memory by origin">${chips}</div>
      ${addBtn}
    </div>
    ${body}
  `);
};

export const MEMORY_LENS_STYLES = `
.memory-more { margin-top: 0.5rem; }
.data-lens-switch { display: inline-flex; gap: 0.25rem; padding: 0.25rem; background: var(--surface-sunk); border-radius: 0.5rem; margin: 0.5rem 0; }
.data-lens-btn {
  box-sizing: border-box; min-height: 36px; display: inline-flex; align-items: center; justify-content: center;
  font: inherit; font-size: 0.875rem; font-weight: 600; padding: 0.3125rem 0.875rem;
  border: none; border-radius: 0.375rem; background: transparent; color: var(--fg-muted); cursor: pointer;
}
.data-lens-btn.is-active { background: var(--surface); color: var(--fg-strong); box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
.memory-lens { display: flex; flex-direction: column; gap: 0.75rem; min-width: 0; }
.memory-lens-title { margin: 0; font-size: 15px; font-weight: 650; color: var(--fg-strong); }
.memory-lens-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; min-width: 0; }
.memory-filter-chips { display: flex; flex-wrap: wrap; gap: 0.375rem; min-width: 0; }
.memory-lens-actions { margin-left: auto; display: flex; flex-wrap: wrap; gap: 0.375rem; min-width: 0; }
.memory-import-result { margin: 0; font-size: 0.8125rem; color: var(--fg-muted); overflow-wrap: anywhere; }
.memory-filter-chip {
  box-sizing: border-box; min-height: 36px; display: inline-flex; align-items: center; justify-content: center;
  font: inherit; font-size: 0.8125rem; padding: 0.25rem 0.625rem; border-radius: 999px;
  border: 1px solid var(--border); background: transparent; color: var(--fg-muted);
  cursor: pointer;
}
.memory-filter-chip.is-active {
  background: var(--accent); border-color: var(--accent); color: var(--on-accent);
}
.memory-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; }
.memory-row { min-width: 0; border: 1px solid var(--border); border-radius: 0.5rem; padding: 0.625rem 0.75rem; }
.memory-row-head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; min-width: 0; }
.memory-origin-chip {
  font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
  padding: 0.125rem 0.5rem; border-radius: 0.375rem; background: var(--surface-sunk);
  color: var(--fg-muted);
}
.memory-origin-user_self { background: var(--accent-weak); color: var(--accent); }
.memory-origin-contracted_user { background: #fef3c7; color: #92400e; }
.memory-row-kind { min-width: 0; font-size: 0.8125rem; color: var(--fg-muted); overflow-wrap: anywhere; }
.memory-row-size { font-size: 0.75rem; color: var(--fg-muted); }
.memory-row-time { font-size: 0.75rem; color: var(--fg-muted); margin-left: auto; }
.memory-row-title { margin: 0.375rem 0 0; font-size: 0.875rem; font-weight: 500; color: var(--fg-strong); overflow-wrap: anywhere; }
.memory-row-preview {
  margin: 0.25rem 0 0; font-size: 0.8125rem; color: var(--fg-muted);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere;
}
.memory-row-foot { margin-top: 0.375rem; display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; min-width: 0; }
.memory-row-run-link {
  box-sizing: border-box; min-height: 36px; display: inline-flex; align-items: center;
  font-size: 0.8125rem; padding: 0.1875rem 0.625rem; border: 1px solid var(--border-strong);
  border-radius: 0.375rem; background: var(--surface); color: var(--accent); text-decoration: none;
}
.memory-row-run-link:hover { background: var(--surface-sunk); text-decoration: none; }
.memory-row-btn, .memory-btn {
  box-sizing: border-box; min-height: 36px; display: inline-flex; align-items: center; justify-content: center;
  font: inherit; font-size: 0.8125rem; padding: 0.1875rem 0.625rem; border-radius: 0.375rem;
  border: 1px solid var(--border-strong); background: var(--surface); color: var(--fg-strong); cursor: pointer;
}
.memory-row-btn:hover, .memory-btn:hover { background: var(--surface-sunk); }
.memory-btn--primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.memory-btn--primary:hover { filter: brightness(0.95); background: var(--accent); }
.memory-row-btn--danger, .memory-btn--danger { color: var(--danger); border-color: var(--danger); }
.memory-row-confirm { max-width: 100%; min-width: 0; font-size: 0.8125rem; color: var(--fg-muted); display: inline-flex; align-items: center; gap: 0.375rem; flex-wrap: wrap; overflow-wrap: anywhere; }
.memory-row-delete-error { min-width: 0; flex-basis: 100%; color: var(--danger); overflow-wrap: anywhere; }
.memory-row-edit-error { min-width: 0; flex-basis: 100%; color: var(--danger); overflow-wrap: anywhere; }
.memory-row.is-redacted { opacity: 0.7; }
.memory-row-redacted { margin: 0.375rem 0 0; font-size: 0.8125rem; font-style: italic; color: var(--fg-muted); }
.memory-compose, .memory-detail { display: flex; flex-direction: column; gap: 0.625rem; min-width: 0; }
.memory-compose-editor, .memory-import-editor { display: flex; flex-direction: column; gap: 0.625rem; min-width: 0; }
.memory-compose-title { margin: 0; font-size: 1rem; }
.memory-field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.memory-field-label { font-size: 0.8125rem; font-weight: 600; color: var(--fg-muted); }
.memory-field-hint { font-weight: 400; color: var(--fg-muted); }
.memory-input, .memory-textarea {
  box-sizing: border-box; width: 100%; min-width: 0; font: inherit; font-size: 0.875rem; padding: 0.4375rem 0.625rem; border-radius: 0.375rem;
  border: 1px solid var(--border-strong); background: var(--surface); color: var(--fg);
}
.memory-textarea { resize: vertical; min-height: 5rem; }
.memory-compose-actions, .memory-detail-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: flex-end; min-width: 0; }
.memory-compose-error { color: var(--danger); font-size: 0.8125rem; margin: 0; overflow-wrap: anywhere; }
[${MEMORY_COMPOSE_DISCARD_GUARD_ATTR}] {
  display: grid; gap: 0.625rem; padding: 0.875rem;
  border: 1px solid var(--danger); border-radius: 0.5rem; background: var(--danger-weak);
}
[${MEMORY_COMPOSE_DISCARD_GUARD_ATTR}] h3,
[${MEMORY_COMPOSE_DISCARD_GUARD_ATTR}] p { margin: 0; }
.memory-compose-discard-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
[${MEMORY_IMPORT_DISCARD_GUARD_ATTR}] {
  display: grid; gap: 0.625rem; padding: 0.875rem;
  border: 1px solid var(--danger); border-radius: 0.5rem; background: var(--danger-weak);
}
[${MEMORY_IMPORT_DISCARD_GUARD_ATTR}] h3,
[${MEMORY_IMPORT_DISCARD_GUARD_ATTR}] p { margin: 0; }
.memory-import-discard-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.memory-detail-bar { margin-bottom: 0.25rem; }
.memory-detail-title { margin: 0; font-size: 1rem; color: var(--fg-strong); }
.memory-detail-head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; min-width: 0; }
.memory-detail-summary { margin: 0; font-size: 0.9375rem; font-weight: 600; color: var(--fg-strong); overflow-wrap: anywhere; }
.memory-detail-body {
  box-sizing: border-box; width: 100%; max-width: 100%; min-width: 0; margin: 0; font: inherit; font-size: 0.875rem; white-space: pre-wrap; overflow-wrap: anywhere;
  background: var(--surface-sunk); border-radius: 0.5rem; padding: 0.75rem; color: var(--fg);
}
.memory-field-hint, .memory-lens-empty, .memory-lens-loading, .memory-lens-error { overflow-wrap: anywhere; }
.memory-lens-empty, .memory-lens-loading, .memory-lens-error { color: var(--fg-muted); font-size: 0.875rem; }
.memory-lens-error { color: var(--danger); }
@media (max-width: 520px) {
  .memory-lens-controls { align-items: stretch; flex-direction: column; }
  .memory-lens-actions { margin-left: 0; }
  .memory-lens-actions .memory-btn { flex: 1 1 auto; }
}
`;
