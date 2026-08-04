/** D-210 §4c slice 2 — read lens over accepted `form_response` records.
 *
 *  This lens remains non-mutating, but the canonical destination it reads is
 *  an owner-editable working record. The sealed `reception_form_submission`
 *  stays the immutable evidence twin; editing happens through the paired Data
 *  RPCs, not through this renderer.
 *
 *  ## ⚠ Why this is a SEPARATE lens and not a fourth record `kind`
 *
 *  ⛔ **The two layers have opposite disclosure postures, and blending them would be a surprise.**
 *  `reception.record.list` is *"redacted by construction — neither the visitor's values NOR the
 *  ciphertext to recover them"* (D-149 § N.6 / D-173 I-3). A `FormResponse` carries `values` (the
 *  visitor's actual answers) and `visitor` in PLAINTEXT — deliberately, because approval is the
 *  point at which the owner has taken the content into a working record. One list mixing redacted rows with full answers would teach the owner the
 *  wrong thing about both. Two lenses, each honest about what it shows.
 *
 *  ## What moved and what did not
 *
 *  Ported verbatim: the field projection (frozen snapshot order + labels), the visitor / source
 *  labels, value + time rendering, the detail meta block, the "Automate this form" Kitchen CTA,
 *  and the manual-run automation picker.
 *
 *  ⚠ **`fileRefSearch` in the run modal is not carried.** It needs `mirrorSearchCaller`, which is
 *  a `#data`-route caller; the original already treats it as optional
 *  (`...(opts.mirrorSearchCaller !== undefined ? { fileRefSearch } : {})`), so this degrades along
 *  a path the surface already models rather than inventing one. Build trigger: the first time a
 *  form-response automation needs a file ref picked at run time. */

import {
  type Conn,
  type FormResponse,
  type FormResponseListCursor,
  type FormResponseListItem,
  type ServerRecipeListEntry,
  type ServerRpcRegistry,
} from '@recued/contracts';
import { RunModal } from '@recued/ui-shared';

import {
  buildFormResponseManualRunContext,
  findFormResponseAutomationsForResponse,
  type FormResponseAutomationRunMatch,
} from '../data/form-response-automation-run.js';
import { serializeShellRoute } from '../shell/route.js';

/** ⛔ `execute` is taken from the CONN, not plumbed as a caller from
 *  `webclient-bootstrap.ts`. The host injects a full `Conn<ServerRpcRegistry>`, so the wider
 *  registry satisfies this Pick by contravariance — the whole lens costs no bootstrap edit. */
export type ReceptionFormResponseConn = Conn<
  Pick<
    ServerRpcRegistry,
    'form_response.list' | 'form_response.get' | 'recipe.list' | 'execute'
  >
>;

export const FR_LENS_ROOT_ATTR = 'data-recued-reception-responses';
export const FR_LENS_ROW_ATTR = 'data-recued-reception-response-row';
export const FR_LENS_DETAIL_ATTR = 'data-recued-reception-response-detail';
export const FR_LENS_ACTION_ATTR = 'data-recued-reception-response-action';
export const FR_LENS_RECIPE_ATTR = 'data-recued-reception-response-recipe';
export const FR_LENS_PICKER_ATTR = 'data-recued-reception-response-picker';
export const FR_LENS_EMPTY_ATTR = 'data-recued-reception-response-empty';
export const FR_LENS_ERROR_ATTR = 'data-recued-reception-response-error';
export const FR_LENS_RETRY_ATTR = 'data-recued-reception-response-retry';
export const FR_LENS_DETAIL_RETRY_ATTR =
  'data-recued-reception-response-detail-retry';

/** ⛔ Ported verbatim from the `#data` surface — the sentence an owner reads when nothing has
 *  been accepted yet. It names WHERE the missing thing actually is, which is the only useful
 *  thing an empty state can say here. */
export const FR_LENS_EMPTY_COPY =
  'No accepted form responses yet. New submissions stay in Reception Inbox until you approve them.';

// ════════════════════════════════════════════════════════════════
// Pure projection (ported)
// ════════════════════════════════════════════════════════════════

interface FormResponseFieldView {
  readonly name: string;
  readonly label: string;
  readonly value: unknown;
}

type PickerState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly matches: ReadonlyArray<FormResponseAutomationRunMatch> };

const e = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const humanizeFieldName = (name: string): string =>
  name
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());

/** Rebuild the accepted response in the exact field order/labels frozen with the submission.
 *  ⚠ Ported unchanged INCLUDING its tail behaviour: a value absent from a legacy/malformed
 *  snapshot stays visible under a humanized key rather than being silently dropped — on a record
 *  surface a missing answer and an unanswered question are different facts. */
export const formResponseFields = (
  response: FormResponse,
): readonly FormResponseFieldView[] => {
  const fields = response.definition_snapshot.fields;
  const declared = Array.isArray(fields) ? fields : [];
  const seen = new Set<string>();
  const out: FormResponseFieldView[] = [];
  for (const field of declared) {
    if (field === null || typeof field !== 'object' || Array.isArray(field)) continue;
    const record = field as Record<string, unknown>;
    if (typeof record.name !== 'string' || record.name.trim().length === 0) continue;
    const name = record.name;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      label:
        typeof record.label === 'string' && record.label.trim().length > 0
          ? record.label
          : humanizeFieldName(name),
      value: response.values[name],
    });
  }
  for (const key of Object.keys(response.values)) {
    if (seen.has(key)) continue;
    out.push({ name: key, label: humanizeFieldName(key), value: response.values[key] });
  }
  return out;
};

export const formResponseVisitorLabel = (
  response: Pick<FormResponseListItem, 'visitor'>,
): string =>
  typeof response.visitor.email === 'string' && response.visitor.email.length > 0
    ? response.visitor.email
    : 'Anonymous visitor';

export const formResponseSourceLabel = (
  response: FormResponse | FormResponseListItem,
): string => {
  const template = 'metadata' in response
    ? response.metadata.template_ref
    : response.template_ref;
  const source = typeof template === 'string' && template.length > 0
    ? template
    : response.form_definition_id;
  const shortName = source.split(/[/:]/).filter((part) => part.length > 0).at(-1);
  return humanizeFieldName(shortName ?? source);
};

const renderTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return e(String(timestamp));
  return `<time datetime="${e(date.toISOString())}">${e(date.toLocaleString())}</time>`;
};

const renderValue = (value: unknown): string => {
  if (value === undefined || value === null || value === '') {
    return '<span aria-label="No answer">—</span>';
  }
  if (typeof value === 'boolean') return e(value ? 'Yes' : 'No');
  if (typeof value === 'string' || typeof value === 'number') return e(String(value));
  try {
    return `<pre>${e(JSON.stringify(value, null, 2))}</pre>`;
  } catch {
    return e(String(value));
  }
};

// ════════════════════════════════════════════════════════════════
// Render
// ════════════════════════════════════════════════════════════════

const renderPicker = (state: PickerState): string => {
  if (state.status === 'idle') return '';
  if (state.status === 'loading') {
    return `<section ${FR_LENS_PICKER_ATTR}="loading"><p>Finding saved automations…</p></section>`;
  }
  if (state.status === 'error') {
    return `<section ${FR_LENS_PICKER_ATTR}="error">
      <p role="alert">${e(state.message)}</p>
      <button type="button" ${FR_LENS_ACTION_ATTR}="discover">Try again</button>
    </section>`;
  }
  return `<section ${FR_LENS_PICKER_ATTR}="ready">
    <h3 tabindex="-1">Run this response now</h3>
    <p>This is an explicit manual run. Review the prefilled routing context and recipe configuration before confirming; the acceptance event is not re-emitted.</p>
    ${state.matches.length === 0
      ? '<p>No saved automation matches this response yet. Create one in Kitchen first.</p>'
      : `<ul role="list">${state.matches.map((match) => {
          const storedName: unknown = match.entry.recipe?.metadata?.name;
          const name = typeof storedName === 'string' && storedName.trim().length > 0
            ? storedName.trim()
            : match.entry.recipe_id;
          const scope = match.scope === 'this_form'
            ? 'This form'
            : match.scope === 'all_forms'
              ? 'All forms'
              : 'Filtered match';
          return `<li>
            <div><strong>${e(name)}</strong> <code>${e(match.entry.recipe_id)}</code></div>
            <span class="reception-responses-pill">${e(scope)}</span>
            <button type="button" ${FR_LENS_ACTION_ATTR}="review"
              ${FR_LENS_RECIPE_ATTR}="${e(match.entry.recipe_id)}">Review and run</button>
          </li>`;
        }).join('')}</ul>`}
  </section>`;
};

const renderDetail = (
  response: FormResponse,
  picker: PickerState,
  canRun: boolean,
): string => {
  const fields = formResponseFields(response);
  const discovering = picker.status === 'loading';
  return `
    <section ${FR_LENS_DETAIL_ATTR}="${e(response.submission_id)}">
      <button type="button" ${FR_LENS_ACTION_ATTR}="close">← Back to form responses</button>
      <div class="reception-responses-header">
        <h2 tabindex="-1">${e(formResponseVisitorLabel(response))}</h2>
        <span class="reception-responses-pill">Accepted</span>
      </div>
      <dl class="reception-responses-meta">
        <div><dt>Form</dt><dd>${e(formResponseSourceLabel(response))}</dd></div>
        <div><dt>Form definition</dt><dd>${e(response.form_definition_id)}</dd></div>
        <div><dt>Endpoint</dt><dd>${e(response.endpoint_id)}</dd></div>
        <div><dt>Submitted</dt><dd>${renderTime(response.submitted_at)}</dd></div>
        <div><dt>Accepted</dt><dd>${renderTime(response.accepted_at)}</dd></div>
        <div><dt>Reference</dt><dd>${e(response.submission_id)}</dd></div>
      </dl>
      <div class="reception-responses-automation">
        <div>
          <strong>Continue with an automation</strong>
          <span>Start a Kitchen recipe for future owner-accepted responses from this form. The draft reads full answers only when it runs.</span>
        </div>
        <div class="reception-responses-automation-actions">
          <a href="${e(serializeShellRoute('kitchen', 'new', 'form-response', response.form_definition_id))}">Automate this form</a>
          ${canRun
            ? `<button type="button" ${FR_LENS_ACTION_ATTR}="discover"${discovering
              ? ' aria-disabled="true" aria-busy="true"'
              : ''}>${discovering ? 'Finding automations…' : 'Run this response'}</button>`
            : ''}
        </div>
      </div>
      ${renderPicker(picker)}
      <h3>Answers</h3>
      ${fields.length === 0
        ? '<p>This response contains no submitted values.</p>'
        : `<dl class="reception-responses-fields">${fields.map((field) => `
            <div data-form-response-field="${e(field.name)}">
              <dt>${e(field.label)}</dt>
              <dd>${renderValue(field.value)}</dd>
            </div>`).join('')}</dl>`}
    </section>
  `;
};

const renderList = (
  responses: readonly FormResponseListItem[],
  hasMore: boolean,
  loadingMore: boolean,
): string => `
  <section>
    <h2 tabindex="-1">Form responses <span class="reception-responses-pill">read-only</span></h2>
    ${responses.length === 0
      ? `<p ${FR_LENS_EMPTY_ATTR}>${e(FR_LENS_EMPTY_COPY)}</p>`
      : `<ul class="reception-responses-list" role="list">${responses.map((response) => `
          <li ${FR_LENS_ROW_ATTR}="${e(response.submission_id)}">
            <button type="button" ${FR_LENS_ACTION_ATTR}="open"
              ${FR_LENS_RECIPE_ATTR}="${e(response.submission_id)}">
              <strong>${e(formResponseVisitorLabel(response))}</strong>
              <span>${e(formResponseSourceLabel(response))}</span>
              <span>${renderTime(response.accepted_at)}</span>
            </button>
          </li>`).join('')}</ul>`}
    ${hasMore
      ? `<button type="button" ${FR_LENS_ACTION_ATTR}="load-more" aria-disabled="${loadingMore ? 'true' : 'false'}">${
          loadingMore ? 'Loading…' : 'Load more'
        }</button>`
      : ''}
  </section>
`;

export const RECEPTION_RESPONSES_STYLES = `
[${FR_LENS_ROOT_ATTR}] { display: grid; gap: 14px; color: var(--fg); }
[${FR_LENS_ROOT_ATTR}] h2 { font-size: 15px; font-weight: 680; margin: 0; }
[${FR_LENS_ROOT_ATTR}] h3 { font-size: 13px; font-weight: 660; margin: 14px 0 6px; }
.reception-responses-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: var(--surface-sunk); color: var(--fg-muted); font-size: 11px; font-weight: 640; }
.reception-responses-list { display: grid; gap: 8px; margin: 12px 0 0; padding: 0; list-style: none; }
.reception-responses-list li { border: 1px solid var(--border); border-radius: 11px; background: var(--surface); }
.reception-responses-list button { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; width: 100%; padding: 12px 14px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.reception-responses-list span { color: var(--fg-muted); font-size: 12px; }
.reception-responses-header { display: flex; align-items: center; gap: 10px; }
.reception-responses-meta, .reception-responses-fields { display: grid; gap: 8px; margin: 12px 0; }
.reception-responses-meta dt, .reception-responses-fields dt { color: var(--fg-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.reception-responses-meta dd, .reception-responses-fields dd { margin: 2px 0 0; font-size: 13px; }
.reception-responses-automation { display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; padding: 12px 14px; border: 1px solid var(--border); border-radius: 11px; background: var(--surface-sunk); }
.reception-responses-automation span { display: block; color: var(--fg-muted); font-size: 12px; }
.reception-responses-automation-actions { display: flex; gap: 8px; align-items: center; }
[${FR_LENS_ROOT_ATTR}] pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
`;

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export interface ReceptionFormResponseLensOptions {
  host: HTMLElement;
  conn: ReceptionFormResponseConn;
  document?: Document;
  /** Absent ⇒ the manual-run picker is not offered (the original's `canRunAutomation`). */
  enableManualRun?: boolean;
}

export interface ReceptionFormResponseLensMount {
  getState(): {
    responses: readonly FormResponseListItem[];
    detailId: string | null;
    loading: boolean;
    error: string | null;
  };
  refresh(): Promise<void>;
  open(submissionId: string): Promise<void>;
  dispose(): void;
}

const errMessage = (err: unknown): string =>
  err instanceof Error && err.message.length > 0
    ? err.message
    : 'Could not load form responses.';

export const mountReceptionFormResponseLens = (
  opts: ReceptionFormResponseLensOptions,
): ReceptionFormResponseLensMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountReceptionFormResponseLens: no document available - pass opts.document for non-browser environments',
    );
  }
  const canRun = opts.enableManualRun ?? true;
  const root = doc.createElement('div');
  root.setAttribute(FR_LENS_ROOT_ATTR, '');
  opts.host.appendChild(root);

  let responses: readonly FormResponseListItem[] = [];
  let cursor: FormResponseListCursor | null = null;
  let loadingMore = false;
  let detailId: string | null = null;
  let detail: FormResponse | null = null;
  let loadingDetail = false;
  let retryingDetail = false;
  let picker: PickerState = { status: 'idle' };
  let loading = true;
  let retryingList = false;
  let error: string | null = null;
  let disposed = false;
  let generation = 0;
  let runModal: RunModal.RunModalHandle | null = null;

  type ResponseFocusTarget =
    | { kind: 'discover' }
    | { kind: 'detail-back' }
    | { kind: 'detail-heading' }
    | { kind: 'detail-retry' }
    | { kind: 'list-heading' }
    | { kind: 'list-retry' }
    | { kind: 'load-more' }
    | { kind: 'picker-heading' }
    | { kind: 'picker-retry' }
    | { kind: 'row'; submissionId: string };

  const queryOne = (selector: string): HTMLElement | null => {
    // The compact unit-test DOM stores `innerHTML` without parsing it. Browsers provide this
    // query API; keeping it optional preserves those string-rendering tests.
    const querySelector = (
      root as HTMLElement & {
        querySelector?: (selectors: string) => Element | null;
      }
    ).querySelector;
    return typeof querySelector === 'function'
      ? querySelector.call(root, selector) as HTMLElement | null
      : null;
  };

  const responseFocusElement = (target: ResponseFocusTarget): HTMLElement | null => {
    if (target.kind === 'discover') {
      return queryOne(
        `.reception-responses-automation-actions [${FR_LENS_ACTION_ATTR}="discover"]`,
      );
    }
    if (target.kind === 'detail-back') {
      return queryOne(`[${FR_LENS_ACTION_ATTR}="close"]`);
    }
    if (target.kind === 'detail-heading') {
      return queryOne(`[${FR_LENS_DETAIL_ATTR}] h2`);
    }
    if (target.kind === 'detail-retry') {
      return queryOne(`[${FR_LENS_DETAIL_RETRY_ATTR}]`);
    }
    if (target.kind === 'list-heading') {
      return queryOne('section > h2');
    }
    if (target.kind === 'list-retry') {
      return queryOne(`[${FR_LENS_RETRY_ATTR}]`);
    }
    if (target.kind === 'load-more') {
      return queryOne(`[${FR_LENS_ACTION_ATTR}="load-more"]`);
    }
    if (target.kind === 'picker-heading') {
      return queryOne(`[${FR_LENS_PICKER_ATTR}="ready"] h3`);
    }
    if (target.kind === 'picker-retry') {
      return queryOne(
        `[${FR_LENS_PICKER_ATTR}="error"] [${FR_LENS_ACTION_ATTR}="discover"]`,
      );
    }
    const querySelectorAll = (
      root as HTMLElement & {
        querySelectorAll?: (selectors: string) => NodeListOf<Element>;
      }
    ).querySelectorAll;
    const rows = typeof querySelectorAll === 'function'
      ? Array.from(querySelectorAll.call(root, `[${FR_LENS_ACTION_ATTR}="open"]`))
      : [];
    const exact = rows.find(
      (row) => row.getAttribute(FR_LENS_RECIPE_ATTR) === target.submissionId,
    );
    return (exact as HTMLElement | undefined) ?? queryOne('section > h2');
  };

  const ownsResponseFocus = (target: ResponseFocusTarget): boolean => {
    const activeElement = (doc as Document & { activeElement?: Element | null }).activeElement;
    return activeElement != null && activeElement === responseFocusElement(target);
  };

  const restoreResponseFocus = (target: ResponseFocusTarget | null): void => {
    if (target === null) return;
    responseFocusElement(target)?.focus?.({ preventScroll: true });
  };

  const activePaginationFocus = (): ResponseFocusTarget | null => {
    const activeElement = (doc as Document & { activeElement?: Element | null }).activeElement;
    if (activeElement == null) return null;
    const contains = (
      root as HTMLElement & { contains?: (other: Node | null) => boolean }
    ).contains;
    if (typeof contains === 'function' && !contains.call(root, activeElement)) return null;
    const action = activeElement.getAttribute(FR_LENS_ACTION_ATTR);
    if (action === 'load-more') return { kind: 'load-more' };
    if (action !== 'open') return null;
    const submissionId = activeElement.getAttribute(FR_LENS_RECIPE_ATTR);
    return submissionId === null ? null : { kind: 'row', submissionId };
  };

  const render = (focus: ResponseFocusTarget | null = null): void => {
    if (disposed) return;
    const listLoadFailed = error !== null
      && detailId === null
      && responses.length === 0;
    const retryStateAttrs = retryingList
      ? ' aria-disabled="true" aria-busy="true"'
      : '';
    const retryLabel = retryingList ? 'Retrying…' : 'Retry';
    const listRetry = `<button type="button" ${FR_LENS_ACTION_ATTR}="retry-list" ${FR_LENS_RETRY_ATTR}${retryStateAttrs}>${retryLabel}</button>`;
    const detailRetryStateAttrs = retryingDetail
      ? ' aria-disabled="true" aria-busy="true"'
      : '';
    const detailRetryLabel = retryingDetail ? 'Retrying…' : 'Retry';
    const detailRetry = `<button type="button" ${FR_LENS_ACTION_ATTR}="retry-detail" ${FR_LENS_DETAIL_RETRY_ATTR}${detailRetryStateAttrs}>${detailRetryLabel}</button>`;
    const errorBlock = error === null
      ? ''
      : listLoadFailed
        ? `<div ${FR_LENS_ERROR_ATTR} role="${retryingList ? 'status' : 'alert'}">${e(error)} ${listRetry}</div>`
        : `<p ${FR_LENS_ERROR_ATTR} role="${retryingDetail ? 'status' : 'alert'}">${e(error)}</p>`;
    let body: string;
    if (loading) {
      body = '<p>Loading form responses…</p>';
    } else if (detailId !== null) {
      body = loadingDetail && !retryingDetail
        ? `<section ${FR_LENS_DETAIL_ATTR}="${e(detailId)}">
             <button type="button" ${FR_LENS_ACTION_ATTR}="close">← Back to form responses</button>
             <p>Loading response…</p>
           </section>`
        : detail === null
          ? `<section ${FR_LENS_DETAIL_ATTR}="${e(detailId)}">
               <button type="button" ${FR_LENS_ACTION_ATTR}="close">← Back to form responses</button>
               <p>${error === null
                 ? 'This form response was not found.'
                 : 'Could not load this form response. Try again or return to the list.'}</p>
               ${error === null ? '' : detailRetry}
             </section>`
          : renderDetail(detail, picker, canRun);
    } else if (error !== null && responses.length === 0) {
      // ⛔ Never the empty copy on a failed load — "no responses yet" and "I could not ask" are
      // opposite claims (the same defect the records panel's test forbids).
      body = '';
    } else {
      body = renderList(responses, cursor !== null, loadingMore);
    }
    root.innerHTML = `<style>${RECEPTION_RESPONSES_STYLES}</style>${errorBlock}${body}`;
    restoreResponseFocus(focus);
  };

  const load = async (retryFocus = false): Promise<void> => {
    const mine = ++generation;
    const pendingFocus: ResponseFocusTarget | null = retryFocus
      && ownsResponseFocus({ kind: 'list-retry' })
        ? { kind: 'list-retry' }
        : null;
    loading = true;
    retryingList = retryFocus;
    if (!retryFocus) error = null;
    render(pendingFocus);
    try {
      const result = await opts.conn('form_response.list', {});
      if (disposed || mine !== generation) return;
      const shouldAdvanceFocus = pendingFocus !== null
        && ownsResponseFocus(pendingFocus);
      responses = result.responses;
      cursor = result.next_cursor ?? null;
      loading = false;
      retryingList = false;
      error = null;
      render(shouldAdvanceFocus ? { kind: 'list-heading' } : null);
    } catch (err) {
      if (disposed || mine !== generation) return;
      const shouldRestoreFocus = pendingFocus !== null
        && ownsResponseFocus(pendingFocus);
      loading = false;
      retryingList = false;
      error = errMessage(err);
      render(shouldRestoreFocus ? pendingFocus : null);
    }
  };

  const loadMore = async (): Promise<void> => {
    if (cursor === null || loadingMore) return;
    loadingMore = true;
    error = null;
    const pendingFocus: ResponseFocusTarget = { kind: 'load-more' };
    let firstAppendedId: string | null = null;
    render(pendingFocus);
    try {
      // ⛔ `before`, not `cursor` — the query's keyset field is EXCLUSIVE and named for what
      // it means. A wrong key here silently returns page 1 again (an infinite "Load more").
      const result = await opts.conn('form_response.list', { before: cursor });
      if (disposed) return;
      firstAppendedId = result.responses[0]?.submission_id ?? null;
      responses = [...responses, ...result.responses];
      cursor = result.next_cursor ?? null;
    } catch (err) {
      if (disposed) return;
      error = errMessage(err);
    } finally {
      if (!disposed) {
        const focus = activePaginationFocus();
        loadingMore = false;
        // Opening a row while pagination is in flight makes the detail renderer the new owner.
        // Keep the appended cache, but do not rebuild that detail underneath the user's focus.
        if (detailId === null) {
          render(
            focus?.kind === 'load-more' && cursor === null
              ? { kind: 'row', submissionId: firstAppendedId ?? '' }
              : focus,
          );
        }
      }
    }
  };

  const open = async (
    submissionId: string,
    focusDetail = false,
    retryFocus = false,
  ): Promise<void> => {
    const pendingFocus: ResponseFocusTarget | null = retryFocus
      ? ownsResponseFocus({ kind: 'detail-retry' })
        ? { kind: 'detail-retry' }
        : null
      : focusDetail
        ? { kind: 'detail-back' }
        : null;
    detailId = submissionId;
    detail = null;
    picker = { status: 'idle' };
    loadingDetail = true;
    retryingDetail = retryFocus;
    if (!retryFocus) error = null;
    render(pendingFocus);
    try {
      const result = await opts.conn('form_response.get', { submission_id: submissionId });
      if (disposed || detailId !== submissionId) return;
      detail = result.response ?? null;
      error = null;
    } catch (err) {
      if (disposed || detailId !== submissionId) return;
      error = errMessage(err);
    } finally {
      if (!disposed && detailId === submissionId) {
        const shouldAdvanceFocus = pendingFocus !== null
          && ownsResponseFocus(pendingFocus);
        loadingDetail = false;
        retryingDetail = false;
        render(
          shouldAdvanceFocus
            ? detail === null
              ? error === null
                ? { kind: 'detail-back' }
                : pendingFocus
              : { kind: 'detail-heading' }
            : null,
        );
      }
    }
  };

  const close = (): void => {
    const returnId = detailId;
    detailId = null;
    detail = null;
    loadingDetail = false;
    retryingDetail = false;
    picker = { status: 'idle' };
    error = null;
    render(returnId === null ? null : { kind: 'row', submissionId: returnId });
  };

  const discover = async (): Promise<void> => {
    if (detail === null || picker.status === 'loading') return;
    const anchor = detail;
    picker = { status: 'loading' };
    const pendingFocus: ResponseFocusTarget = { kind: 'discover' };
    render(pendingFocus);
    try {
      const result = await opts.conn('recipe.list');
      if (disposed || detail !== anchor) return;
      const entries: ReadonlyArray<ServerRecipeListEntry> = result.recipes;
      // ⚠ Arg order is (recipes, response) — I had it backwards first, and BOTH params are
      // object-ish so a swap would have typechecked in a looser signature.
      picker = {
        status: 'ready',
        matches: findFormResponseAutomationsForResponse(entries, anchor),
      };
    } catch (err) {
      if (disposed || detail !== anchor) return;
      picker = { status: 'error', message: errMessage(err) };
    } finally {
      if (!disposed && detail === anchor) {
        const shouldAdvanceFocus = ownsResponseFocus(pendingFocus);
        render(
          shouldAdvanceFocus
            ? picker.status === 'ready'
              ? { kind: 'picker-heading' }
              : picker.status === 'error'
                ? { kind: 'picker-retry' }
                : pendingFocus
            : null,
        );
      }
    }
  };

  const review = (recipeId: string): void => {
    if (runModal !== null || detail === null || picker.status !== 'ready') return;
    const match = picker.matches.find((candidate) => candidate.entry.recipe_id === recipeId);
    if (match === undefined) return;
    try {
      const handle = RunModal.wireRunModal({
        recipe: match.entry,
        document: doc,
        initialTab: 'run',
        // Sourced from the conn — see the header: no bootstrap caller is plumbed for this lens.
        execute: (args) =>
          opts.conn('execute', { ...args, trigger_source: 'manual' }) as never,
        onClose: () => {
          if (runModal === handle) runModal = null;
        },
      });
      handle.setContextValues(buildFormResponseManualRunContext(detail));
      runModal = handle;
      const portal = (doc as { body?: HTMLElement }).body ?? opts.host;
      portal.appendChild(handle.element);
    } catch (err) {
      picker = { status: 'error', message: errMessage(err) };
      render();
    }
  };

  const onClick = (ev: Event): void => {
    const target = ev.target as HTMLElement | null;
    if (target === null || typeof target.getAttribute !== 'function') return;
    const action = target.getAttribute(FR_LENS_ACTION_ATTR);
    if (action === null) return;
    if (action === 'open') {
      const id = target.getAttribute(FR_LENS_RECIPE_ATTR);
      if (id !== null) void open(id, true);
      return;
    }
    if (action === 'close') return close();
    if (action === 'retry-detail') {
      if (loadingDetail || detailId === null) return;
      return void open(detailId, false, true);
    }
    if (action === 'retry-list') {
      if (loading) return;
      return void load(true);
    }
    if (action === 'load-more') return void loadMore();
    if (action === 'discover') return void discover();
    if (action === 'review') {
      const recipeId = target.getAttribute(FR_LENS_RECIPE_ATTR);
      if (recipeId !== null) review(recipeId);
    }
  };

  root.addEventListener('click', onClick);
  void load();

  return {
    getState: () => ({ responses, detailId, loading, error }),
    refresh: () => load(),
    open,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      root.removeEventListener('click', onClick);
      runModal?.destroy();
      root.remove();
    },
  };
};
