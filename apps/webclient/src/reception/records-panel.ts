/** D-210 §4c — the reception RECORDS panel (`#reception/records`).
 *
 *  The DOM half of the read surface; `records-model.ts` owns the meaning and the header there
 *  owns the WHY. In one line: `reception.record.list` shipped in step 2a and nothing called it,
 *  so a record the drain could not hand off was invisible for its entire life — no held op for
 *  the Inbox to join, no destination row for `#data` to browse.
 *
 *  ## ⛔ Read-only, by ruling
 *
 *  D-210 §4 (owner-ruled 2026-07-17): the record is **write-once** and the owner's edits land at
 *  the APPROVE boundary in the DESTINATION. So this panel renders no mutation control, and the
 *  absence is deliberate — there is no edit rpc to call, and adding one would contradict the
 *  ruling rather than fill a gap.
 *
 *  ## Why it lives here and not in `#data`
 *
 *  `reception.record.list`'s axes are `kind` / `endpoint_id` / `outcome` — reception vocabulary,
 *  with `endpoint_id` mapping to the Endpoints section beside this one. And the rows are not a
 *  `data.*` collection: `CanonicalCollectionName` is a closed 14-member union and neither table
 *  is in it, so the `#data` explorer cannot reach them by construction (Appendix A). A `#data`
 *  tab would have been the first non-collection tab there, widening what `#data` means, to show
 *  rows whose destination `#data` already shows better.
 *
 *  ## Redaction
 *
 *  ⛔ The projection carries neither the visitor's values NOR the ciphertext to recover them
 *  (D-149 § N.6 / D-173 I-3), so there is nothing here to reveal and no reveal control to build.
 *  A booking's SLOT is not PII — it is the booking's substance, and the inbox card already shows
 *  a held booking's slot. */

import type {
  ReceptionRecordListResult,
  ReceptionRecordSummary,
} from '@recued/contracts';
import type { Conn } from '@recued/contracts';
import type { ServerRpcRegistry } from '@recued/contracts';

import {
  buildReceptionRecordsModel,
  receptionRecordsListInput,
  type ReceptionRecordRowModel,
  type ReceptionRecordsKindFilter,
  type ReceptionRecordsModel,
  type ReceptionRecordsOutcomeFilter,
} from './records-model.js';

/** Narrowed to the one read this panel owns. The wider route conn satisfies it by
 *  contravariance — no shim, and no bootstrap edit to pass a caller through. */
export type ReceptionRecordsConn = Conn<
  Pick<ServerRpcRegistry, 'reception.record.list'>
>;

export const RECEPTION_RECORDS_ROOT_ATTR = 'data-recued-reception-records';
export const RECEPTION_RECORDS_KIND_ATTR = 'data-recued-reception-records-kind';
export const RECEPTION_RECORDS_OUTCOME_ATTR = 'data-recued-reception-records-outcome';
export const RECEPTION_RECORDS_ROW_ATTR = 'data-recued-reception-records-row';
export const RECEPTION_RECORDS_UNRESOLVED_ATTR = 'data-recued-reception-records-unresolved';
export const RECEPTION_RECORDS_TRUNCATED_ATTR = 'data-recued-reception-records-truncated';
export const RECEPTION_RECORDS_EMPTY_ATTR = 'data-recued-reception-records-empty';
export const RECEPTION_RECORDS_ERROR_ATTR = 'data-recued-reception-records-error';
export const RECEPTION_RECORDS_RETRY_ATTR = 'data-recued-reception-records-retry';

/** ⛔ The copy for a row that resolved to nothing. Exported because it is the ONE sentence this
 *  whole surface exists to be able to say, and a test should pin it rather than a class name.
 *
 *  🔑 TWO of them, and the difference is a factual claim about the future. "yet" is true while
 *  something may still materialize and FALSE once the outcome is final — a `spam` row saying
 *  "yet" tells the owner to wait for something that is never coming. */
export const RECEPTION_RECORDS_UNRESOLVED_COPY = 'Nothing materialized yet';
export const RECEPTION_RECORDS_UNRESOLVED_TERMINAL_COPY = 'Nothing materialized';

/** ⚠ Deliberately not "stuck" / "failed". A record seconds old is `pending` too and will drain
 *  on the next tick; the drain also leaves rows pending on purpose (stale pair, unconfirmed
 *  door, failed run) rather than materializing a fallback. "Waiting" is true of every one of
 *  those and alarming about none. */
export const RECEPTION_RECORDS_WAITING_HINT =
  'Waiting records have not been handed off yet. They carry no approval in the Inbox and no destination in Data, so this is the only place they appear.';

export interface ReceptionRecordsPanelOptions {
  host: HTMLElement;
  conn: ReceptionRecordsConn;
  document?: Document;
  now?: () => number;
}

export interface ReceptionRecordsPanelMount {
  getState(): {
    kind: ReceptionRecordsKindFilter;
    outcome: ReceptionRecordsOutcomeFilter;
    model: ReceptionRecordsModel;
    loading: boolean;
    error: string | null;
  };
  refresh(): Promise<void>;
  setKind(kind: ReceptionRecordsKindFilter): Promise<void>;
  setOutcome(outcome: ReceptionRecordsOutcomeFilter): Promise<void>;
  dispose(): void;
}

const KIND_FILTERS: ReadonlyArray<{ id: ReceptionRecordsKindFilter; label: string }> = [
  { id: 'all', label: 'All kinds' },
  { id: 'scheduling_link', label: 'Bookings' },
  { id: 'intake_form', label: 'Intake forms' },
];

const OUTCOME_FILTERS: ReadonlyArray<{ id: ReceptionRecordsOutcomeFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'waiting', label: 'Waiting' },
];

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const errMessage = (err: unknown): string =>
  err instanceof Error && err.message.length > 0
    ? err.message
    : 'Could not load reception records.';

/** Absolute, because an appointment time means nothing relative — "in 3 days" is not something
 *  you can put in a calendar. Rendered in the VIEWER's zone from a unix-ms instant, which is
 *  unambiguous; the panel formats it (not the model) so model tests stay environment-free. */
const formatSlot = (slot: { start_at: number; end_at: number; duration_minutes: number }): string => {
  const start = new Date(slot.start_at);
  const end = new Date(slot.end_at);
  let startText: string;
  let endText: string;
  try {
    startText = start.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    endText = end.toLocaleTimeString(undefined, { timeStyle: 'short' });
  } catch {
    // A runtime without full ICU still has to render something truthful.
    startText = start.toISOString();
    endText = end.toISOString();
  }
  const mins = slot.duration_minutes;
  return `${startText} to ${endText} (${String(mins)} min)`;
};

const renderResolved = (row: ReceptionRecordRowModel): string => {
  if (!row.has_resolved) {
    const copy = row.terminal
      ? RECEPTION_RECORDS_UNRESOLVED_TERMINAL_COPY
      : RECEPTION_RECORDS_UNRESOLVED_COPY;
    return `<span class="reception-records-unresolved" ${RECEPTION_RECORDS_UNRESOLVED_ATTR}>${escapeHtml(copy)}</span>`;
  }
  const parts = row.resolved.map((entry) => {
    const label = escapeHtml(entry.kind_label);
    const id = escapeHtml(entry.id);
    return `<span class="reception-records-resolved"><strong>${label}</strong> <code>${id}</code></span>`;
  });
  return parts.join('');
};

const renderRow = (row: ReceptionRecordRowModel): string => {
  const slotLine =
    row.slot !== null
      ? `<div class="reception-records-slot">${escapeHtml(formatSlot(row.slot))}</div>`
      : '';
  const waitingClass = row.waiting ? ' reception-records-row--waiting' : '';
  const recordId = escapeHtml(row.record_id);
  const endpointId = escapeHtml(row.endpoint_id);
  const kindLabel = escapeHtml(row.kind_label);
  const outcomeLabel = escapeHtml(row.outcome_label);
  const receivedLabel = escapeHtml(row.received_label);
  return `
    <li class="reception-records-row${waitingClass}" ${RECEPTION_RECORDS_ROW_ATTR}="${recordId}">
      <div class="reception-records-row-head">
        <span class="reception-records-kind">${kindLabel}</span>
        <span class="reception-records-outcome">${outcomeLabel}</span>
        <span class="reception-records-received">${receivedLabel}</span>
      </div>
      ${slotLine}
      <div class="reception-records-row-foot">
        <span class="reception-records-endpoint">Endpoint <code>${endpointId}</code></span>
        ${renderResolved(row)}
      </div>
    </li>
  `;
};

const renderFilters = (
  kind: ReceptionRecordsKindFilter,
  outcome: ReceptionRecordsOutcomeFilter,
): string => {
  const kindButtons = KIND_FILTERS.map((filter) => {
    const active = filter.id === kind ? ' reception-records-chip--active' : '';
    return `<button type="button" class="reception-records-chip${active}" ${RECEPTION_RECORDS_KIND_ATTR}="${filter.id}">${escapeHtml(filter.label)}</button>`;
  }).join('');
  const outcomeButtons = OUTCOME_FILTERS.map((filter) => {
    const active = filter.id === outcome ? ' reception-records-chip--active' : '';
    return `<button type="button" class="reception-records-chip${active}" ${RECEPTION_RECORDS_OUTCOME_ATTR}="${filter.id}">${escapeHtml(filter.label)}</button>`;
  }).join('');
  return `
    <div class="reception-records-filters">
      <div class="reception-records-chipset">${kindButtons}</div>
      <div class="reception-records-chipset">${outcomeButtons}</div>
    </div>
  `;
};

export const RECEPTION_RECORDS_STYLES = `
.reception-records-shell { display: grid; gap: 16px; color: var(--fg); }
.reception-records-intro { max-width: 660px; margin: 0; color: var(--fg-muted); font-size: 13px; line-height: 1.55; }
.reception-records-filters { display: flex; flex-wrap: wrap; gap: 10px; }
.reception-records-chipset { display: inline-flex; gap: 4px; padding: 4px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-sunk); }
.reception-records-chip { appearance: none; min-height: 30px; padding: 5px 12px; border: 0; border-radius: 7px; background: transparent; color: var(--fg-muted); font-size: 12px; font-weight: 640; cursor: pointer; }
.reception-records-chip:hover { color: var(--fg); }
.reception-records-chip--active { background: var(--surface); color: var(--fg); box-shadow: 0 1px 3px rgba(24, 24, 27, 0.10); }
.reception-records-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.reception-records-row { display: grid; gap: 6px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 11px; background: var(--surface); }
.reception-records-row--waiting { border-color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
.reception-records-row-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; }
.reception-records-kind { font-size: 13px; font-weight: 680; }
.reception-records-outcome { font-size: 11px; font-weight: 640; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.reception-records-received { margin-left: auto; font-size: 12px; color: var(--fg-muted); }
.reception-records-slot { font-size: 13px; }
.reception-records-row-foot { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--fg-muted); }
.reception-records-unresolved { font-style: italic; }
.reception-records-note { margin: 0; font-size: 12px; color: var(--fg-muted); }
.reception-records-error { padding: 10px 12px; border: 1px solid var(--danger); border-radius: 9px; font-size: 13px; }
`;

export const mountReceptionRecordsPanel = (
  opts: ReceptionRecordsPanelOptions,
): ReceptionRecordsPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountReceptionRecordsPanel: no document available - pass opts.document for non-browser environments',
    );
  }
  const now = opts.now ?? (() => Date.now());
  const root = doc.createElement('div');
  root.setAttribute(RECEPTION_RECORDS_ROOT_ATTR, '');
  opts.host.appendChild(root);

  const emptyModel = buildReceptionRecordsModel({
    records: [],
    truncated: false,
    kind: 'all',
    outcome: 'all',
    now: now(),
  });

  let kind: ReceptionRecordsKindFilter = 'all';
  let outcome: ReceptionRecordsOutcomeFilter = 'all';
  let model: ReceptionRecordsModel = emptyModel;
  let loading = true;
  let error: string | null = null;
  let disposed = false;
  // ⚠ Generation guard — filter clicks can land while an earlier fetch is in flight, and the
  // slower response must not paint over the newer filter's answer.
  let generation = 0;

  const render = (): void => {
    if (disposed) return;
    const summary = loading
      ? 'Loading records...'
      : model.total === 0
        ? ''
        : `${String(model.total)} shown, ${String(model.waiting_count)} waiting`;
    const errorBlock =
      error !== null
        ? `<div class="reception-records-error" ${RECEPTION_RECORDS_ERROR_ATTR}>${escapeHtml(error)} <button type="button" ${RECEPTION_RECORDS_RETRY_ATTR}>Retry</button></div>`
        : '';
    // ⛔ Truncation is SURFACED, never swallowed — on a reception list "I see all of them" has
    // to be either true or visibly false (contract note on `truncated`).
    const truncatedBlock = model.truncated
      ? `<p class="reception-records-note" ${RECEPTION_RECORDS_TRUNCATED_ATTR}>More records exist than are shown. Narrow the filters to see the rest.</p>`
      : '';
    let body: string;
    if (loading) {
      body = '';
    } else if (error !== null && model.total === 0) {
      // ⛔ NEVER the empty copy on a failed load. "No reception records yet" and "I could not
      // ask" are opposite claims, and the owner acts on the first one. The error block above is
      // the whole message. (A refresh that fails while rows are already shown keeps them — the
      // banner says the reload failed, the rows are still the last truth we had.)
      body = '';
    } else if (model.total === 0) {
      const copy =
        model.empty_reason === 'filtered_out'
          ? 'No records match these filters.'
          : 'No reception records yet. Bookings and intake submissions appear here as they arrive.';
      body = `<p class="reception-records-note" ${RECEPTION_RECORDS_EMPTY_ATTR}>${escapeHtml(copy)}</p>`;
    } else {
      body = `<ul class="reception-records-list">${model.rows.map(renderRow).join('')}</ul>`;
    }
    // Injected per render like the inbox panel does — `innerHTML` replaces the whole subtree,
    // so the style element has to be part of it.
    root.innerHTML = `
      <style>${RECEPTION_RECORDS_STYLES}</style>
      <div class="reception-records-shell">
        <p class="reception-records-intro">${escapeHtml(RECEPTION_RECORDS_WAITING_HINT)}</p>
        ${renderFilters(kind, outcome)}
        ${errorBlock}
        <p class="reception-records-note">${escapeHtml(summary)}</p>
        ${truncatedBlock}
        ${body}
      </div>
    `;
  };

  const load = async (): Promise<void> => {
    const mine = ++generation;
    loading = true;
    error = null;
    render();
    try {
      const result: ReceptionRecordListResult = await opts.conn(
        'reception.record.list',
        receptionRecordsListInput({ kind, outcome }),
      );
      if (disposed || mine !== generation) return;
      const records: ReadonlyArray<ReceptionRecordSummary> = result.records;
      model = buildReceptionRecordsModel({
        records,
        truncated: result.truncated,
        kind,
        outcome,
        now: now(),
      });
      loading = false;
      render();
    } catch (err) {
      if (disposed || mine !== generation) return;
      loading = false;
      error = errMessage(err);
      render();
    }
  };

  const onClick = (ev: Event): void => {
    const target = ev.target as HTMLElement | null;
    if (target === null || typeof target.getAttribute !== 'function') return;
    const nextKind = target.getAttribute(RECEPTION_RECORDS_KIND_ATTR);
    if (nextKind !== null) {
      kind = nextKind as ReceptionRecordsKindFilter;
      void load();
      return;
    }
    const nextOutcome = target.getAttribute(RECEPTION_RECORDS_OUTCOME_ATTR);
    if (nextOutcome !== null) {
      outcome = nextOutcome as ReceptionRecordsOutcomeFilter;
      void load();
      return;
    }
    if (target.getAttribute(RECEPTION_RECORDS_RETRY_ATTR) !== null) {
      void load();
    }
  };

  root.addEventListener('click', onClick);
  void load();

  return {
    getState: () => ({ kind, outcome, model, loading, error }),
    refresh: () => load(),
    setKind: (next) => {
      kind = next;
      return load();
    },
    setOutcome: (next) => {
      outcome = next;
      return load();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      root.removeEventListener('click', onClick);
      root.remove();
    },
  };
};
