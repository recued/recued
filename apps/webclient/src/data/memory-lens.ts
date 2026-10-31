/** D-198 Memory lens — the transparent, origin-tagged memory feed rendered
 *  inside `#data` under the Data | Memory lens switch, plus (Slice 2) the
 *  owner CRUD surface: an "Add memory" compose form, per-row edit / delete for
 *  your OWN (`user_self`) entries, and a detail view that lazy-loads the full
 *  body via `memory.get`.
 *
 *  Reads `memory.list` (owner-trusted, whole-feed) and shows EVERY origin
 *  (D-198 §3 transparency), filterable by write-actor (You / Agents / System).
 *  Authorship is origin-scoped: you have full CRUD on the memories you wrote
 *  (`isOwnMemoryEntry`). An agent's note is never edited: you REPLACE it with
 *  your own version (D-198 §12, `isReplaceableEntry`) or DELETE it, erasing its
 *  text (§13). A run — engine, agent or one you started — is HIDDEN FROM AI only,
 *  because the signed audit log cannot be erased (`removeActFor`).
 *
 *  Pure render (returns HTML strings) + styles + click-/field-dispatch
 *  constants the route wires. Body previews are already clamped by the
 *  `memory.list` contract (never the full body, §5); the detail view fetches
 *  the full body on demand.
 *
 *  Spec: D-198 §4/§5 + D-198 §B Slice 1b/2. */

import type { Actor, MemoryGetResponse, MemoryImportResult, MemoryListEntry } from '@recued/contracts';
import { renderProvenance, renderReferenceLink } from '@recued/ui-shared';

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
/** D-198 §12 — the owner replaces an agent's entry with their own version
 *  (`memory.replace`): the compose form opens prefilled from that entry. */
export const MEMORY_REPLACE_ACTION = 'memory-replace';
export const MEMORY_DELETE_ACTION = 'memory-delete';
export const MEMORY_DELETE_CONFIRM_ACTION = 'memory-delete-confirm';
export const MEMORY_DELETE_CANCEL_ACTION = 'memory-delete-cancel';
/** D-198 §10 — the owner undoes an AGENT's forget (`memory.restore`). */
export const MEMORY_RESTORE_ACTION = 'memory-restore';
/** D-198 §13 — the owner marks an agent's note wrong (`memory.revoke`) and lifts that
 *  (`memory.unrevoke`). One click each, like Restore: each undoes the other. */
export const MEMORY_REVOKE_ACTION = 'memory-revoke';
export const MEMORY_UNREVOKE_ACTION = 'memory-unrevoke';
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
/** The compose form's body placeholder — and the only place the keywords
 *  convention is taught at the point of writing.
 *
 *  ⚠ THERE IS NO `keywords` FIELD, DELIBERATELY. Recall indexes `summary` +
 *  `body` as ONE document, so a `keywords:` line typed into the body is already
 *  matched exactly like any other text — measured: an entry carrying
 *  `keywords: 2FA, MFA, OTP` answers "2FA" and "MFA" at the EXACT rung, while
 *  the same entry without them is missed entirely. A structured field would buy
 *  bm25 column weighting and nothing else; what was actually missing was
 *  telling the owner the convention exists, which is a placeholder, not a
 *  schema.
 *
 *  ⚠ KEYWORDS GO LAST. `body_preview` is the first 280 characters and is what
 *  the feed row shows — a keywords line at the top makes every entry preview as
 *  a list of terms instead of its content. */
export const MEMORY_BODY_PLACEHOLDER =
  'The answer, in full.\n\nkeywords: any other words someone might search for '
  + '— abbreviations, product names, synonyms';

export const MEMORY_KEYWORDS_HINT =
  'Tip: end with a "keywords:" line. Recued searches the whole thing, so '
  + 'writing down short forms and other words for it (2FA, MFA, OTP) finds it when the '
  + 'wording differs.';

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

/** Compose (create/edit/replace) form state, owned by the route, rendered here. */
export interface MemoryComposeState {
  open: boolean;
  /** `replace` (D-198 §12) writes a NEW note of yours in an agent entry's place. */
  mode: 'create' | 'edit' | 'replace';
  /** The row the form acts on: the one edited, or the agent entry a replace
   *  takes the place of. Absent when creating. */
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

const originPresentationKind = (
  actor: Actor,
): 'user' | 'agent' | 'visitor' | 'system' => {
  if (actor === 'user_self') return 'user';
  if (actor === 'contracted_user') return 'agent';
  if (actor === 'anonymous') return 'visitor';
  return 'system';
};

/** One origin renderer for both the feed and detail. The primary actor stays
 * scannable; an outside-authored row carries the server-derived attribution
 * beside it rather than being presented as the owner's own memory. */
const renderMemoryOrigin = (
  entry: Pick<MemoryListEntry, 'origin_actor' | 'attribution'>,
): string => renderProvenance({
  primary: ORIGIN_LABEL[entry.origin_actor] ?? String(entry.origin_actor),
  ...(entry.attribution === undefined
    ? {}
    : { detail: entry.attribution.label }),
  kind: originPresentationKind(entry.origin_actor),
  primaryClassName: `memory-origin-chip memory-origin-${entry.origin_actor}`,
  attributes: { 'data-origin-actor': entry.origin_actor },
});

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
  /** D-198 §13 — the agent's note whose Delete is asking how often an agent saved it,
   *  before its confirm opens. */
  checkingDeleteId?: string;
  /** D-198 §13 — for the row awaiting a delete confirm: an agent saved its claim this
   *  often (twice or more), so the confirm offers to mark it wrong instead. */
  deleteSaves?: MemoryDeleteSaves;
  /** The confirmed Delete/Forget write currently owned by one row. */
  deletingId?: string;
  /** Row-local Delete/Forget failure; keeps the confirmation retryable. */
  deleteError?: string;
  /** The owner row whose full body is loading into the Edit compose form. */
  openingEditId?: string;
  /** Row-local Edit prefill failure; keeps Edit visible and retryable. */
  editError?: { memoryId: string; message: string };
  /** D-198 §10/§13 — the row whose one-click act is in flight: Restore, Revoke or
   *  Un-revoke (a row shows at most one of them). */
  restoringId?: string;
  /** D-198 §10/§13 — that act's row-local failure; keeps its button visible and
   *  retryable. */
  restoreError?: { memoryId: string; message: string };
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

/** D-198 §10 — who forgot an entry, and the reason the agent gave. */
const forgottenNote = (
  entry: Pick<MemoryListEntry, 'forgotten_by' | 'forgotten_reason'>,
): string =>
  `Forgotten by ${entry.forgotten_by}${
    entry.forgotten_reason !== undefined ? `. Reason: ${entry.forgotten_reason}` : ''}`;

/** D-198 §10 — the line under a live entry an agent's correction touched. */
const revisionNote = (
  entry: Pick<MemoryListEntry, 'replaces' | 'replaced_by'>,
): string =>
  entry.replaced_by !== undefined
    ? '<p class="memory-row-revision">Replaced by a newer version</p>'
    : entry.replaces !== undefined
      ? '<p class="memory-row-revision">Corrects an earlier entry</p>'
      : '';

/** D-198 §13 — the line under an agent's note the owner revoked. */
const revokedNote = (entry: Pick<MemoryListEntry, 'revoked_at'>, now: number): string =>
  entry.revoked_at !== undefined
    ? `<p class="memory-row-revision">You revoked this ${e(formatRelativeTime(entry.revoked_at, now))}. `
      + 'AIs treat it as wrong and ask you before saving it again.</p>'
    : '';

/** A memory the owner WROTE — the only entry they can edit or delete. A run they
 *  started is `user_self` too and shows under You, but it is the record of a run
 *  (`run_id` — the contract's "audit-authored" marker): the server refuses to
 *  edit it and forgets it rather than deleting it, so it gets Forget like the
 *  rows others wrote. */
export const isOwnMemoryEntry = (
  entry: Pick<MemoryListEntry, 'origin_actor' | 'run_id'>,
): boolean => entry.origin_actor === 'user_self' && entry.run_id === undefined;

/** D-198 §12 — an entry the owner may replace with their own version: a note an
 *  agent saved (not the record of a run), still live, and the current version
 *  (one a newer version already replaced has that version to replace instead).
 *  The server makes the same checks; this only decides which rows offer it. */
export const isReplaceableEntry = (
  entry: Pick<MemoryListEntry, 'origin_actor' | 'run_id' | 'redacted' | 'replaced_by'>,
): boolean =>
  entry.origin_actor === 'contracted_user'
  && entry.run_id === undefined
  && entry.redacted !== true
  && entry.replaced_by === undefined;

/** D-198 §13 — an agent's note the owner may revoke (mark wrong): one they may replace,
 *  not revoked already. */
export const isRevocableEntry = (
  entry: Pick<MemoryListEntry, 'origin_actor' | 'run_id' | 'redacted' | 'replaced_by' | 'revoked_at'>,
): boolean => isReplaceableEntry(entry) && entry.revoked_at === undefined;

/** D-198 §13 — how often agents saved a note's claim (`memory.saves`), when it is twice
 *  or more. */
export interface MemoryDeleteSaves {
  saves: number;
  agents: number;
}

/** D-198 §13 — the Delete confirm's question when agents keep saving what the owner
 *  deletes. A delete is neutral, so the claim would be saved again; marked wrong, it is
 *  saved again only with the owner's say-so. */
export const memoryDeleteSavesPrompt = ({ saves, agents }: MemoryDeleteSaves): string =>
  `${agents > 1
    ? `Agents have saved this ${saves} times. Mark it wrong so they ask you first?`
    : `An agent has saved this ${saves} times. Mark it wrong so it asks you first?`} `
  + 'If you delete it, its text leaves your server; the chat it came from keeps a copy.';

/** D-198 §13 — what removing an entry does, by what the entry IS. Your note and an
 *  agent's note are DELETED (an agent's has its text erased, and the chat it was
 *  saved in keeps a copy); a run cannot be erased, because the audit log is signed,
 *  so it is HIDDEN FROM AI and your Logs still show it in full. */
interface RemoveAct {
  button: string;
  aria: string;
  prompt: string;
  verb: string;
  progress: string;
  noun: string;
}

const removeActFor = (entry: Pick<MemoryListEntry, 'origin_actor' | 'run_id'>): RemoveAct =>
  entry.run_id !== undefined
    ? {
        button: 'Hide from AI', aria: 'Hide run from AI', verb: 'hiding', progress: 'Hiding…', noun: 'run',
        prompt: 'Hide this run from AI? Your Logs still show it in full.',
      }
    : {
        button: 'Delete', aria: 'Delete memory', verb: 'deleting', progress: 'Deleting…', noun: 'memory',
        prompt: isOwnMemoryEntry(entry)
          ? 'Delete this memory?'
          : 'Delete this memory? Its text leaves your server; the chat it came from keeps a copy.',
      };

/** D-198 §13 — an agent's note the owner hid before Delete existed (a redaction with
 *  no delete and no agent forget): hidden from everyone, its text still on the
 *  server. Delete is offered so it can be erased. */
const isHiddenNoteStillOnServer = (
  entry: Pick<MemoryListEntry, 'origin_actor' | 'run_id' | 'redacted' | 'deleted_at' | 'forgotten_by'>,
): boolean =>
  entry.redacted === true
  && entry.deleted_at === undefined
  && entry.forgotten_by === undefined
  && entry.run_id === undefined
  && entry.origin_actor !== 'user_self';

/** The line a removed entry shows in place of its content. */
const removedNote = (
  entry: Pick<MemoryListEntry, 'origin_actor' | 'run_id' | 'redacted' | 'deleted_at' | 'forgotten_by' | 'forgotten_reason'>,
  now: number,
): string =>
  entry.deleted_at !== undefined
    ? `You deleted this ${formatRelativeTime(entry.deleted_at, now)}. Its text is gone from your server.`
    : entry.forgotten_by !== undefined
      ? `${forgottenNote(entry)}.`
      : entry.run_id !== undefined
        ? 'Hidden from AI. Your Logs still show this run.'
        : 'Hidden, but its text is still on your server.';

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

/** The inline Delete / Hide-from-AI confirm, in a row or the detail view (`btnClass`).
 *
 *  D-198 §13 — on an agent's note an agent has saved twice or more (`deleteSaves`), it
 *  asks whether to mark it wrong instead, and its buttons say what each does: Mark it
 *  wrong (`memory.revoke`, which undoes) or Delete. */
const renderRemoveConfirm = (
  entry: MemoryListEntry | MemoryGetResponse,
  act: RemoveAct,
  btnClass: 'memory-row-btn' | 'memory-btn',
  actionAttr: string,
  deletingId: string | undefined,
  deleteError: string | undefined,
  locked: boolean,
  deleteSaves: MemoryDeleteSaves | undefined,
): string => {
  const idAttr = `${MEMORY_ROW_ID_ATTR}="${e(entry.memory_id)}"`;
  const actionName = (label: string): string => memoryActionName(label, entry);
  const deleting = deletingId === entry.memory_id;
  const saves = deleteSaves !== undefined && isRevocableEntry(entry) ? deleteSaves : undefined;
  const markWrong = saves !== undefined
    ? `<button type="button" class="${btnClass}"
          ${actionAttr}="${MEMORY_REVOKE_ACTION}" ${idAttr}${deleting || locked
            ? ' aria-disabled="true"'
            : ''} aria-label="${actionName('Mark it wrong')}">Mark it wrong</button>`
    : '';
  // The longer question takes its own line, so its three answers stay together below it.
  const prompt = saves !== undefined
    ? `<span class="memory-row-confirm-question">${e(memoryDeleteSavesPrompt(saves))}</span>`
    : e(act.prompt);
  return `<span class="memory-row-confirm">${prompt}
        ${markWrong}<button type="button" class="${btnClass} ${btnClass}--danger"
          ${actionAttr}="${MEMORY_DELETE_CONFIRM_ACTION}" ${idAttr}${deleting
            ? ' aria-disabled="true" aria-busy="true"'
            : locked
              ? ' aria-disabled="true"'
            : ''} aria-label="${actionName(deleting
              ? `${act.progress} ${act.noun}`
              : saves !== undefined ? act.aria : `Confirm ${act.verb} ${act.noun}`)}">${deleting
                ? act.progress
                : saves !== undefined ? act.button : 'Confirm'}</button>
        <button type="button" class="${btnClass}"
          ${actionAttr}="${MEMORY_DELETE_CANCEL_ACTION}" ${idAttr}${deleting || locked
            ? ' aria-disabled="true"'
            : ''} aria-label="${actionName(`Cancel ${act.verb} ${act.noun}`)}">Cancel</button>
        ${deleteError !== undefined
          ? `<span class="memory-row-delete-error" role="alert">${e(deleteError)}</span>`
          : ''}</span>`;
};

/** The per-row action foot: the audit run link, a "View" affordance for rows
 *  carrying a full body, and — when writes are wired (§3) — Edit + Delete on the
 *  memories the owner WROTE, Replace + Delete on an agent's note (§12/§13), and
 *  Hide from AI on the record of a run, the owner's own runs included
 *  (`removeActFor`). All destructive actions are an inline two-step confirm. A row
 *  that is ALREADY removed keeps its run link, Restore on an agent's forget, and
 *  Delete on a note hidden before Delete existed. */
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
  restoringId: string | undefined,
  restoreError: { memoryId: string; message: string } | undefined,
  checkingDeleteId: string | undefined,
  deleteSaves: MemoryDeleteSaves | undefined,
): string => {
  const isOwn = isOwnMemoryEntry(entry);
  const isRedacted = entry.redacted === true;
  const idAttr = `${MEMORY_ROW_ID_ATTR}="${e(entry.memory_id)}"`;
  const actionName = (label: string): string => memoryActionName(label, entry);
  const act = removeActFor(entry);
  const confirmRemove = (): string =>
    renderRemoveConfirm(entry, act, 'memory-row-btn', actionAttr, deletingId, deleteError, locked, deleteSaves);
  const removeButton = (held: boolean): string => {
    const checking = checkingDeleteId === entry.memory_id;
    return `<button type="button" class="memory-row-btn memory-row-btn--danger" ${actionAttr}="${MEMORY_DELETE_ACTION}" ${idAttr}${checking
      ? ' aria-disabled="true" aria-busy="true"'
      : held || locked
        ? ' aria-disabled="true"'
        : ''} aria-label="${actionName(checking ? `Checking… ${act.noun}` : act.aria)}">${checking ? 'Checking…' : act.button}</button>`;
  };
  const runLink =
    entry.run_id !== undefined && entry.run_id.length > 0
      ? renderReferenceLink({
          label: 'Open run',
          referenceId: entry.run_id,
          href: runHref(entry.run_id),
          className: 'memory-row-run-link',
          ariaLabel: actionName('Open run for memory'),
          disabled: locked,
          attributes: { [actionAttr]: MEMORY_OPEN_RUN_ACTION },
        })
      : '';
  if (isRedacted) {
    // D-198 §10 — an entry an AGENT forgot can be restored; the owner's own
    // redaction cannot (nothing left to act on).
    const restoring = restoringId === entry.memory_id;
    const restore = canWrite && entry.forgotten_by !== undefined
      ? `<button type="button" class="memory-row-btn" ${actionAttr}="${MEMORY_RESTORE_ACTION}" ${idAttr}${restoring
        ? ' aria-disabled="true" aria-busy="true"'
        : locked
          ? ' aria-disabled="true"'
          : ''} aria-label="${actionName(restoring ? 'Restoring… memory' : 'Restore memory')}">${restoring ? 'Restoring…' : 'Restore'}</button>${
        restoreError?.memoryId === entry.memory_id
          ? `<span class="memory-row-restore-error" role="alert">${e(restoreError.message)}</span>`
          : ''}`
      : '';
    // §13 — a note hidden before Delete existed still has its text on the server.
    const erase = canWrite && isHiddenNoteStillOnServer(entry)
      ? (pendingDeleteId === entry.memory_id ? confirmRemove() : removeButton(false))
      : '';
    const inner = `${runLink}${restore}${erase}`;
    return inner.length > 0 ? `<div class="memory-row-foot">${inner}</div>` : '';
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
      controls = confirmRemove();
    } else if (isOwn) {
      const openingEdit = openingEditId === entry.memory_id;
      controls = `<button type="button" class="memory-row-btn"
          ${actionAttr}="${MEMORY_EDIT_ACTION}" ${idAttr}${openingEdit
            ? ' aria-disabled="true" aria-busy="true"'
            : locked
              ? ' aria-disabled="true"'
            : ''} aria-label="${actionName(openingEdit ? 'Opening… memory' : 'Edit memory')}">${openingEdit ? 'Opening…' : 'Edit'}</button>
        ${removeButton(openingEdit)}
        ${editError?.memoryId === entry.memory_id
          ? `<span class="memory-row-edit-error" role="alert">${e(editError.message)}</span>`
          : ''}`;
    } else {
      // Others' rows, and the record of any run (yours too), cannot be edited (§3).
      // An agent's note can be replaced with your own version (§12), which opens
      // the form the way Edit does, or deleted (§13); a run is hidden from AI.
      const replaceable = isReplaceableEntry(entry);
      const openingReplace = replaceable && openingEditId === entry.memory_id;
      const replace = replaceable
        ? `<button type="button" class="memory-row-btn"
          ${actionAttr}="${MEMORY_REPLACE_ACTION}" ${idAttr}${openingReplace
            ? ' aria-disabled="true" aria-busy="true"'
            : locked
              ? ' aria-disabled="true"'
            : ''} aria-label="${actionName(openingReplace ? 'Opening… memory' : 'Replace memory')}">${openingReplace ? 'Opening…' : 'Replace'}</button>`
        : '';
      // §13 — Revoke a live, current agent note; Un-revoke one you revoked. One click
      // each, sharing Restore's in-flight slot.
      const isRevoked = entry.revoked_at !== undefined;
      const toggle = isRevoked || replaceable
        ? (() => {
            const busy = restoringId === entry.memory_id;
            const [action, label, progress] = isRevoked
              ? [MEMORY_UNREVOKE_ACTION, 'Un-revoke', 'Un-revoking…']
              : [MEMORY_REVOKE_ACTION, 'Revoke', 'Revoking…'];
            return `<button type="button" class="memory-row-btn" ${actionAttr}="${action}" ${idAttr}${busy
              ? ' aria-disabled="true" aria-busy="true"'
              : openingReplace || locked
                ? ' aria-disabled="true"'
                : ''} aria-label="${actionName(busy ? `${progress} memory` : `${label} memory`)}">${busy ? progress : label}</button>${
              restoreError?.memoryId === entry.memory_id
                ? `<span class="memory-row-restore-error" role="alert">${e(restoreError.message)}</span>`
                : ''}`;
          })()
        : '';
      controls = `${replace}${toggle}${removeButton(openingReplace)}${
        replaceable && editError?.memoryId === entry.memory_id
          ? `<span class="memory-row-edit-error" role="alert">${e(editError.message)}</span>`
          : ''}`;
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
  restoringId: string | undefined,
  restoreError: { memoryId: string; message: string } | undefined,
  checkingDeleteId: string | undefined,
  deleteSaves: MemoryDeleteSaves | undefined,
): string => {
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
    ? `<p class="memory-row-redacted">${e(removedNote(entry, now))}</p>`
    : `${primary ? `<p class="memory-row-title">${e(primary)}</p>` : ''}${
        secondary ? `<p class="memory-row-preview">${e(secondary)}</p>` : ''}${revisionNote(entry)}${revokedNote(entry, now)}`;
  return `<li class="memory-row${isRedacted ? ' is-redacted' : ''}" data-origin="${e(entry.origin_actor)}">
    <div class="memory-row-head">
      ${renderMemoryOrigin(entry)}
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
      restoringId,
      restoreError,
      checkingDeleteId,
      deleteSaves,
    )}
  </li>`;
};

/** D-198 §12 — what a replace does, said where the owner decides to save it. */
export const MEMORY_REPLACE_HINT =
  'Saving puts your version in place of the agent’s: recall finds yours instead. '
  + 'Delete yours later and the agent’s comes back.';

/** The create/edit/replace compose form (an inline panel replacing the feed). */
const renderComposeForm = (
  compose: MemoryComposeState,
  actionAttr: string,
  discardGuardOpen: boolean,
): string => {
  const title = compose.mode === 'edit'
    ? 'Edit memory'
    : compose.mode === 'replace' ? 'Replace with your version' : 'New memory';
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
      ${compose.mode === 'replace' ? `<p class="memory-field-hint">${e(MEMORY_REPLACE_HINT)}</p>` : ''}
      <label class="memory-field">
        <span class="memory-field-label">Kind</span>
        <input class="memory-input" type="text" placeholder="e.g. note, preference, fact"
          value="${e(compose.kind)}" ${MEMORY_FIELD_ATTR}="kind"${readonlyAttr} />
      </label>
      <label class="memory-field">
        <span class="memory-field-label">Summary <span class="memory-field-hint">(optional)</span></span>
        <input class="memory-input" type="text" placeholder="The question this answers, in the words someone would ask it"
          value="${e(compose.summary)}" ${MEMORY_FIELD_ATTR}="summary"${readonlyAttr} />
      </label>
      <label class="memory-field">
        <span class="memory-field-label">Body</span>
        <textarea class="memory-textarea" rows="6" placeholder="${e(MEMORY_BODY_PLACEHOLDER)}" ${MEMORY_FIELD_ATTR}="body"${readonlyAttr}>${e(compose.body)}</textarea>
        <span class="memory-field-hint">${e(MEMORY_KEYWORDS_HINT)}</span>
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
  checkingDeleteId: string | undefined,
  deleteSaves: MemoryDeleteSaves | undefined,
): string => {
  const back = `<button type="button" class="memory-btn" ${actionAttr}="${MEMORY_DETAIL_CLOSE_ACTION}">← Back</button>`;
  let body: string;
  if (detail.error !== undefined) {
    body = `<p class="memory-lens-error" role="alert">${e(detail.error)}</p>`;
  } else if (detail.loading || detail.entry === undefined) {
    body = `<p class="memory-lens-loading">Loading memory…</p>`;
  } else {
    const entry = detail.entry;
    const when = formatRelativeTime(entry.event_at ?? entry.ts, now);
    const isOwn = isOwnMemoryEntry(entry);
    const isRedacted = entry.redacted === true;
    const idAttr = `${MEMORY_ROW_ID_ATTR}="${e(entry.memory_id)}"`;
    const actionName = (label: string): string => memoryActionName(label, entry);
    const act = removeActFor(entry);
    let controls = '';
    if (canWrite && !isRedacted) {
      if (pendingDeleteId === entry.memory_id) {
        controls = renderRemoveConfirm(entry, act, 'memory-btn', actionAttr, deletingId, deleteError, false, deleteSaves);
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
        // Others' rows, and the record of any run, cannot be edited (§3): an
        // agent's note can be replaced (§12) or deleted (§13); a run is hidden.
        const replaceable = isReplaceableEntry(entry);
        const openingReplace = replaceable && openingEditId === entry.memory_id;
        const replace = replaceable
          ? `<button type="button" class="memory-btn"
             ${actionAttr}="${MEMORY_REPLACE_ACTION}" ${idAttr}${openingReplace
               ? ' aria-disabled="true" aria-busy="true"'
               : ''} aria-label="${actionName(openingReplace ? 'Opening… memory' : 'Replace memory')}">${openingReplace ? 'Opening…' : 'Replace'}</button>`
          : '';
        const isRevoked = entry.revoked_at !== undefined;
        const toggle = isRevoked || replaceable
          ? `<button type="button" class="memory-btn" ${actionAttr}="${isRevoked ? MEMORY_UNREVOKE_ACTION : MEMORY_REVOKE_ACTION}" ${idAttr}${openingReplace
            ? ' aria-disabled="true"'
            : ''} aria-label="${actionName(isRevoked ? 'Un-revoke memory' : 'Revoke memory')}">${isRevoked ? 'Un-revoke' : 'Revoke'}</button>`
          : '';
        const checking = checkingDeleteId === entry.memory_id;
        controls = `${replace}${toggle}<button type="button" class="memory-btn memory-btn--danger" ${actionAttr}="${MEMORY_DELETE_ACTION}" ${idAttr}${checking
          ? ' aria-disabled="true" aria-busy="true"'
          : openingReplace
            ? ' aria-disabled="true"'
            : ''} aria-label="${actionName(checking ? `Checking… ${act.noun}` : act.aria)}">${checking ? 'Checking…' : act.button}</button>${
          replaceable && editError?.memoryId === entry.memory_id
            ? `<span class="memory-row-edit-error" role="alert">${e(editError.message)}</span>`
            : ''}`;
      }
    }
    const content = isRedacted
      ? `<p class="memory-row-redacted">${e(removedNote(entry, now))}</p>`
      : `${entry.summary !== undefined ? `<p class="memory-detail-summary">${e(entry.summary)}</p>` : ''}${
          entry.body !== undefined
            ? `<pre class="memory-detail-body">${e(entry.body)}</pre>`
            : '<p class="memory-lens-empty">This entry has no body.</p>'}${revisionNote(entry)}${revokedNote(entry, now)}`;
    body = `<div class="memory-detail-head">
        ${renderMemoryOrigin(entry)}
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
      props.checkingDeleteId,
      props.deleteSaves,
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
      props.originFilter === 'all' ? '' : ' from here'
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
          props.restoringId,
          props.restoreError,
          props.checkingDeleteId,
          props.deleteSaves,
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
.memory-row-confirm-question { min-width: 0; flex-basis: 100%; }
.memory-row-delete-error { min-width: 0; flex-basis: 100%; color: var(--danger); overflow-wrap: anywhere; }
.memory-row-edit-error { min-width: 0; flex-basis: 100%; color: var(--danger); overflow-wrap: anywhere; }
.memory-row-restore-error { min-width: 0; flex-basis: 100%; color: var(--danger); overflow-wrap: anywhere; }
.memory-row.is-redacted { opacity: 0.7; }
.memory-row-redacted { margin: 0.375rem 0 0; font-size: 0.8125rem; font-style: italic; color: var(--fg-muted); }
.memory-row-revision { margin: 0.25rem 0 0; font-size: 0.8125rem; color: var(--fg-muted); }
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
@media (max-width: 640px) {
  /* A finger's height on a phone. ⛔ 36px. */
  .data-lens-btn { min-height: 44px; }
}
@media (max-width: 520px) {
  .memory-lens-controls { align-items: stretch; flex-direction: column; }
  .memory-lens-actions { margin-left: 0; }
  .memory-lens-actions .memory-btn { flex: 1 1 auto; }
}
`;
