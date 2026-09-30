/**
 * D-315 §6 — Data → Received → Mail facts.
 *
 * What Recued read from the owner's mail, beside Form responses: a form
 * response and a mail fact are the same shape — something that arrived, kept
 * as a record, that can start a recipe (D-210, ruling 20).
 *
 * The tab keeps its own state and renders HTML strings, like the rest of the
 * Data route, which repaints with `innerHTML` and dispatches every click by
 * its action attribute. The route forwards to this module:
 *   - `render()` inside its tab panel, and `refresh()` from its loader;
 *   - clicks whose action starts with `mail-facts-`, and `change` events from a
 *     control carrying `MAIL_FACTS_FILTER_ATTR`;
 *   - focus: `captureFocus()` before a repaint, `restoreFocus()` after, by a
 *     stable key each focusable control carries (`MAIL_FACTS_FOCUS_ATTR`);
 *   - the address after the tab: `#data/mail_fact/<view>` — a third level the
 *     Data route had not needed before (§6).
 *
 * Views: **Facts** (§6.4), **Templates** (§6.1, §6.2, §7.1 —
 * `mail-fact-templates.ts`) and **Senders without a template** (§6.5 —
 * `mail-fact-senders.ts`).
 */

import {
  getMailFactBuiltinType,
  MAIL_FACT_BUILTIN_TYPES,
  MAIL_FACT_NOTICE_VARIABLE,
  MAIL_FACT_STATE_VARIABLE,
  mailFactTypeVariables,
  type MailFactEmailRef,
  type MailFactEmailStatus,
  type MailFactPass,
  type MailFactRow,
  type MailFactRowsCursor,
  type MailFactRowsPage,
  type MailFactRowsQuery,
  type MailFactRun,
  type MailFactTypeSpec,
  type MailFactValue,
  type MailFactVariableKind,
  type MailTemplate,
} from '@recued/contracts';
import { e } from '@recued/ui-shared';

import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { serializeLogsRunAddress, serializeSourceRecordAddress } from '../shell/route.js';
import {
  createMailFactTemplates,
  MAIL_FACT_TEMPLATES_STYLES,
  MAIL_FACTS_FIELD_ATTR,
  type MailFactTemplateCallers,
  type MailFactTemplates,
} from './mail-fact-templates.js';

import { createMailFactSenders, type MailFactSenderCallers, type MailFactSenders } from './mail-fact-senders.js';

export { MAIL_FACTS_FIELD_ATTR } from './mail-fact-templates.js';

export const MAIL_FACTS_HOST_ATTR = 'data-recued-mail-facts';
export const MAIL_FACTS_FILTER_ATTR = 'data-recued-mail-facts-filter';
export const MAIL_FACTS_FOCUS_ATTR = 'data-recued-mail-facts-focus';
export const MAIL_FACTS_ROW_ATTR = 'data-recued-mail-fact-row';
/** Every action this tab handles starts with this. */
export const MAIL_FACTS_ACTION_PREFIX = 'mail-facts-';

export const MAIL_FACT_VIEWS = ['facts', 'templates', 'senders'] as const;
export type MailFactView = (typeof MAIL_FACT_VIEWS)[number];

const VIEW_WORDS: Readonly<Record<MailFactView, string>> = {
  facts: 'Facts',
  templates: 'Templates',
  senders: 'Senders without a template',
};

export type MailFactsListCaller = (query: MailFactRowsQuery) => Promise<MailFactRowsPage>;

/** Every Mail facts rpc the tab calls; an absent one hides what needs it. */
export interface MailFactCallers extends MailFactTemplateCallers, MailFactSenderCallers {
  readonly listFacts?: MailFactsListCaller;
  /** The mail detail view's two actions (§6): whether an email gave facts,
   *  and whether it is a security notice. */
  readonly emailStatus?: (args: MailFactEmailRef) => Promise<MailFactEmailStatus>;
}

export interface MailFactsSurfaceDeps {
  readonly callers: MailFactCallers;
  /** The Data route's action attribute: clicks are dispatched by it. */
  readonly actionAttr: string;
  /** Repaint the route. */
  readonly render: () => void;
  /** The address after the tab changed. */
  readonly onAddressChange: () => void;
}

const FILTER_KEYS = ['type', 'state', 'notice', 'template', 'complete', 'paired', 'runs'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Partial<Record<FilterKey, string>>;

const isFilterKey = (value: string | null): value is FilterKey =>
  value !== null && (FILTER_KEYS as readonly string[]).includes(value);

/** The template filter's value for facts no template read. */
const STANDARDS_ONLY = '__standards__';
const PAGE_EMAILS = 50;

export interface MailFactsSurface {
  render(): string;
  /** Load the view. `silent` keeps what is shown until the new page lands. */
  refresh(silent?: boolean): Promise<void>;
  /** A click on an action starting with `mail-facts-`; true when handled. */
  handleAction(action: string, target: HTMLElement): boolean;
  /** A `change` from a control of this tab; true when handled. */
  handleChange(target: HTMLElement): boolean;
  /** An `input` from a text field of this tab; true when handled. */
  handleInput(target: HTMLElement): boolean;
  /** The address segments after the tab. */
  addressSegments(): string[];
  /** Hydrate from an address's segments after the tab. */
  openAddress(segments: readonly string[]): void;
  /** "Facts from this email": the Facts view, showing one email's facts. */
  showEmail(email: MailFactEmailRef, subject?: string): Promise<void>;
  /** "Make a template from this email": the editor, on that email. */
  makeTemplateFrom(email: MailFactEmailRef): Promise<void>;
  /** A page walk or a load is under way: a broadcast must not replace it. */
  isBusy(): boolean;
  /** A template or kind of email being edited has changes not saved. */
  hasUnsavedChanges(): boolean;
  /** A save, a switch or a start is under way. */
  hasInFlightWork(): boolean;
  captureFocus(active: Element | null | undefined): string | null;
  restoreFocus(root: ParentNode, key: string | null): void;
  dispose(): void;
}

// ── Formatting ──────────────────────────────────────────────────────────────

const humanize = (value: string): string => {
  const spaced = value.replace(/_/g, ' ').trim();
  return spaced.length === 0 ? value : spaced[0]!.toUpperCase() + spaced.slice(1);
};

/** A kind of email: built-in, or one the owner made (§4.5). */
const typeSpec = (type: string, owned: readonly MailFactTypeSpec[]): MailFactTypeSpec | undefined =>
  getMailFactBuiltinType(type) ?? owned.find((candidate) => candidate.id === type);
const typeName = (type: string, owned: readonly MailFactTypeSpec[]): string =>
  typeSpec(type, owned)?.name ?? humanize(type.replace(/^custom_/, ''));

const dateTime = (ms: number): string => {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return date.toISOString();
  }
};

const dateOnly = (ms: number): string => {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
};

/** A value as the owner reads it: a date in their locale (a `date` is a
 *  calendar day, so it is formatted in UTC and never shifts a day), money with
 *  its currency, a file as what it is. */
const valueText = (value: MailFactValue, kind: MailFactVariableKind | undefined): string => {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') return `${value.amount} ${value.currency}`;
  if (kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
    } catch {
      return value;
    }
  }
  if (kind === 'datetime') {
    const at = Date.parse(value);
    return Number.isFinite(at) ? dateTime(at) : value;
  }
  if (kind === 'file') return 'An attachment';
  return value;
};

const PASS_LABEL: Readonly<Record<MailFactPass, string>> = {
  standard: 'Standard',
  rule: 'Your rule',
  ai: 'AI',
};

const PASS_HINT: Readonly<Record<MailFactPass, string>> = {
  standard: 'Read from markup or a pattern every sender uses',
  rule: 'Read by a rule in your template',
  ai: 'Filled in by AI',
};

/** A run's status now when the run log has it, else how its fire ended. */
const runLabel = (run: MailFactRun): { text: string; tone: 'ok' | 'wait' | 'bad' | 'plain' } => {
  switch (run.status) {
    case 'succeeded': return { text: 'Completed', tone: 'ok' };
    case 'awaiting_approval': return { text: 'Waiting for your approval', tone: 'wait' };
    case 'awaiting_peer': return { text: 'Waiting for a reply', tone: 'wait' };
    case 'pending':
    case 'running': return { text: 'Running', tone: 'wait' };
    case 'failed': return { text: 'Failed', tone: 'bad' };
    case 'cancelled':
    case 'killed': return { text: 'Stopped', tone: 'plain' };
    case 'in_doubt': return { text: 'Outcome unclear', tone: 'bad' };
    case undefined: break;
  }
  switch (run.outcome) {
    case 'completed': return { text: 'Completed', tone: 'ok' };
    case 'held': return { text: 'Held', tone: 'wait' };
    case 'declined': return { text: 'Did not act', tone: 'plain' };
    case 'total_refusal': return { text: 'Refused every item', tone: 'bad' };
    case 'failed': return { text: 'Failed', tone: 'bad' };
  }
};

// ── Rendering ───────────────────────────────────────────────────────────────

interface FactsState {
  readonly rows: readonly MailFactRow[];
  readonly next: MailFactRowsCursor | null;
  readonly loaded: boolean;
  readonly loading: boolean;
  /** A reload the owner asked for (a filter, a retry): say so over the rows. */
  readonly updating: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
  readonly filters: Filters;
  readonly email: { readonly ref: MailFactEmailRef; readonly subject?: string } | null;
  readonly templates: readonly MailTemplate[];
  /** The kinds of email the owner made (§4.5). */
  readonly types: readonly MailFactTypeSpec[];
}

const select = (
  key: FilterKey,
  label: string,
  current: string | undefined,
  options: readonly (readonly [value: string, label: string])[],
): string => `
  <label class="mail-facts-filter">
    <span>${e(label)}</span>
    <select ${MAIL_FACTS_FILTER_ATTR}="${key}" ${MAIL_FACTS_FOCUS_ATTR}="filter:${key}">
      <option value="">Any</option>
      ${options.map(([value, text]) =>
        `<option value="${e(value)}"${value === current ? ' selected' : ''}>${e(text)}</option>`).join('')}
    </select>
  </label>`;

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const renderFilters = (state: FactsState): string => {
  const chosen = state.filters.type !== undefined ? typeSpec(state.filters.type, state.types) : undefined;
  const every: readonly MailFactTypeSpec[] = [...(MAIL_FACT_BUILTIN_TYPES as readonly MailFactTypeSpec[]), ...state.types];
  const types = every.map((spec) => [spec.id, spec.name] as const);
  const states = chosen?.states ?? unique(every.flatMap((spec) => spec.states)).sort();
  const notices = chosen?.notices ?? unique(every.flatMap((spec) => spec.notices)).sort();
  const templates = state.templates
    .filter((template) => chosen === undefined || template.type === chosen.id)
    .map((template) => [template.template_id, template.name] as const);
  return `
    <div class="mail-facts-filters" role="group" aria-label="Filter facts">
      ${select('type', 'Type', state.filters.type, types)}
      ${select('state', 'State', state.filters.state, states.map((s) => [s, humanize(s)] as const))}
      ${notices.length > 0
        ? select('notice', 'Notice', state.filters.notice, notices.map((n) => [n, humanize(n)] as const))
        : ''}
      ${select('template', 'Read by', state.filters.template, [
        [STANDARDS_ONLY, 'Standard markup only'],
        ...templates,
      ])}
      ${select('complete', 'Values', state.filters.complete, [['yes', 'All required read'], ['no', 'Some missing']])}
      ${select('paired', 'Pairing', state.filters.paired, [['paired', 'Paired'], ['unpaired', 'Unpaired']])}
      ${select('runs', 'Recipes', state.filters.runs, [['yes', 'Started a recipe'], ['no', 'Started none']])}
    </div>`;
};

const renderValues = (row: MailFactRow, owned: readonly MailFactTypeSpec[]): string => {
  const spec = typeSpec(row.fact.type, owned);
  const kinds = new Map<string, MailFactVariableKind>(
    spec !== undefined ? mailFactTypeVariables(spec).map((variable) => [variable.name, variable.kind]) : [],
  );
  const variables = spec !== undefined ? [...kinds.keys()] : Object.keys(row.fact.variables);
  const refused = new Map(row.fact.refused.map((refusal) => [refusal.variable, refusal.reason]));
  const items = variables
    .filter((name) => name !== MAIL_FACT_STATE_VARIABLE && name !== MAIL_FACT_NOTICE_VARIABLE)
    .map((name) => {
      const value = row.fact.variables[name];
      const pass = row.fact.passes[name];
      const why = refused.get(name);
      if (value !== null && value !== undefined) {
        return `
          <div class="mail-facts-value">
            <dt>${e(humanize(name))}</dt>
            <dd><span class="mail-facts-value-text">${e(valueText(value, kinds.get(name)))}</span>${pass !== undefined
              ? ` <span class="mail-facts-pass" data-pass="${e(pass)}" title="${e(PASS_HINT[pass])}">${e(PASS_LABEL[pass])}</span>`
              : ''}</dd>
          </div>`;
      }
      if (why !== undefined) {
        return `
          <div class="mail-facts-value" data-missing="true">
            <dt>${e(humanize(name))}</dt>
            <dd><span class="mail-facts-pass" data-pass="refused">Refused</span> ${e(why)}</dd>
          </div>`;
      }
      if (row.fact.missing.includes(name)) {
        return `
          <div class="mail-facts-value" data-missing="true">
            <dt>${e(humanize(name))}</dt>
            <dd><span class="mail-facts-pass" data-pass="missing">Missing</span></dd>
          </div>`;
      }
      return '';
    })
    .join('');
  // What was refused from its data — a card number, an alias the AI left, data
  // over the cap — is shown like a refused value: nothing is dropped unsaid.
  const refusedData = row.fact.refused
    .filter((refusal) => refusal.variable === 'data' || refusal.variable.startsWith('data.') || refusal.variable.startsWith('data['))
    .map((refusal) => `
      <div class="mail-facts-value" data-missing="true">
        <dt>${e(refusal.variable === 'data' ? 'Data' : `Data ${refusal.variable.replace(/^data[.]?/, '')}`)}</dt>
        <dd><span class="mail-facts-pass" data-pass="refused">Refused</span> ${e(refusal.reason)}</dd>
      </div>`)
    .join('');
  const all = items + refusedData;
  return all.length === 0 ? '' : `<dl class="mail-facts-values">${all}</dl>`;
};

/** §4.3 — a fact waits for its template's AI before it joins its thing; one
 *  the AI could not read says why. A waiting fact is not an unpaired one. */
const waitingForAi = (row: MailFactRow): boolean => row.fact.ai?.state === 'waiting';
const unpaired = (row: MailFactRow): boolean => row.thing === null && !waitingForAi(row);

const renderAi = (row: MailFactRow, owned: readonly MailFactTypeSpec[]): string => {
  const ai = row.fact.ai;
  if (ai === undefined) return '';
  if (ai.state === 'waiting') {
    return `<p class="mail-facts-ai" data-ai="waiting" role="status">Reading with AI… It joins its ${e(typeName(row.fact.type, owned).toLowerCase())}, and can start recipes, once the AI has read it.</p>`;
  }
  if (ai.state === 'not_read') {
    return `<p class="mail-facts-ai" data-ai="not_read">The AI did not read it: ${e(ai.reason)}. It went on with what the rules read.</p>`;
  }
  return '';
};

const renderFact = (
  row: MailFactRow,
  templates: readonly MailTemplate[],
  owned: readonly MailFactTypeSpec[],
  actionAttr: string,
  dataOpen: boolean,
): string => {
  const own = row.fact.variables[MAIL_FACT_STATE_VARIABLE];
  const now = row.thing?.variables[MAIL_FACT_STATE_VARIABLE] ?? own;
  const notice = row.fact.variables[MAIL_FACT_NOTICE_VARIABLE];
  const template = row.fact.template_id === null
    ? null
    : templates.find((candidate) => candidate.template_id === row.fact.template_id);
  const readBy = row.fact.template_id === null
    ? 'Read from standard markup'
    : template !== undefined && template !== null
      ? `Read by ${template.name}`
      : 'Read by a template since deleted';
  const data = row.fact.data;
  const hasData = data !== null && data !== undefined
    && !(typeof data === 'object' && Object.keys(data as object).length === 0);
  return `
    <div class="mail-facts-heading">
      <span class="data-pill">${e(typeName(row.fact.type, owned))}</span>
      ${typeof now === 'string'
        ? `<span class="mail-facts-state"><span class="mail-facts-sr">${row.thing !== null ? 'State now: ' : 'State: '}</span>${e(humanize(now))}</span>`
        : ''}
      ${typeof notice === 'string' ? `<span class="mail-facts-notice">${e(humanize(notice))}</span>` : ''}
    </div>
    ${row.thing !== null && typeof own === 'string' && own !== now
      ? `<p class="mail-facts-subtle">This email said: ${e(humanize(own))}</p>`
      : ''}
    ${renderValues(row, owned)}
    ${renderAi(row, owned)}
    ${unpaired(row)
      ? `<p class="mail-facts-unpaired">Unpaired: not joined to a ${e(typeName(row.fact.type, owned).toLowerCase())} and not used by recipes. It may be the same one a template of yours read from this email, and Recued cannot tell which.</p>`
      : ''}
    <p class="mail-facts-subtle">${e(readBy)}</p>
    ${hasData
      ? `<details class="mail-facts-data"${dataOpen ? ' open' : ''}>
          <summary ${actionAttr}="mail-facts-data-toggle" data-fact-id="${e(row.fact.fact_id)}" ${MAIL_FACTS_FOCUS_ATTR}="data:${e(row.fact.fact_id)}">Data</summary>
          <pre>${e(JSON.stringify(data, null, 2))}</pre>
        </details>`
      : ''}`;
};

const renderMail = (row: MailFactRow): string => {
  const email = row.email;
  const place = row.of_email.count > 1
    ? `<span class="mail-facts-place">${row.of_email.index} of ${row.of_email.count} from this email</span>`
    : '';
  if (email === null) {
    // A removed mailbox keeps the mail it stored, and its facts with it.
    const why = row.mailbox_removed === true ? 'Its mailbox was removed from this server.' : 'The email is no longer stored.';
    return `<p class="mail-facts-subtle">${why}</p>${place}`;
  }
  const href = serializeSourceRecordAddress({ tab: 'mail', collectionSlug: email.slug, recordId: email.record_id });
  return `
    <a class="mail-facts-subject" href="${e(href)}" ${MAIL_FACTS_FOCUS_ATTR}="mail:${e(row.fact.fact_id)}">${e(email.subject.length > 0 ? email.subject : '(no subject)')}</a>
    <span class="mail-facts-from">${e(email.from)}</span>
    <span class="mail-facts-subtle">${e(dateTime(email.at))}</span>
    ${place}
    ${email.goes_at !== undefined
      ? `<span class="mail-facts-subtle mail-facts-goes">Goes with its email after ${e(dateOnly(email.goes_at))}</span>`
      : ''}`;
};

const renderRuns = (row: MailFactRow): string => {
  if (row.runs.length === 0) {
    return `<p class="mail-facts-subtle">${waitingForAi(row)
      ? 'Recipes wait until the AI has read it.'
      : row.thing === null ? 'An unpaired fact starts no recipe.' : 'No recipe ran on it.'}</p>`;
  }
  return `
    <ul class="mail-facts-runs" role="list">
      ${row.runs.map((run, index) => {
        const label = runLabel(run);
        const name = e(run.recipe_name ?? run.recipe_id);
        return `
          <li>
            ${run.run_id !== undefined
              ? `<a href="${e(serializeLogsRunAddress({ runId: run.run_id }))}" ${MAIL_FACTS_FOCUS_ATTR}="run:${e(row.fact.fact_id)}:${index}">${name}</a>`
              : `<span>${name}</span>`}
            ${run.recipe_name === undefined ? '<span class="mail-facts-subtle">no longer installed</span>' : ''}
            <span class="mail-facts-run-state" data-tone="${label.tone}">${e(label.text)}</span>
            <span class="mail-facts-subtle">${e(dateTime(run.at))}</span>
          </li>`;
      }).join('')}
    </ul>`;
};

const renderRow = (
  row: MailFactRow,
  templates: readonly MailTemplate[],
  owned: readonly MailFactTypeSpec[],
  actionAttr: string,
  openData: ReadonlySet<string>,
): string => `
  <li class="mail-facts-row" ${MAIL_FACTS_ROW_ATTR}="${e(row.fact.fact_id)}"${unpaired(row) ? ' data-unpaired="true"' : ''}${waitingForAi(row) ? ' data-ai="waiting"' : ''}>
    <div class="mail-facts-cell mail-facts-cell-mail">
      <span class="mail-facts-cell-label">Matched mail</span>
      ${renderMail(row)}
    </div>
    <div class="mail-facts-cell mail-facts-cell-fact">
      <span class="mail-facts-cell-label">Fact</span>
      ${renderFact(row, templates, owned, actionAttr, openData.has(row.fact.fact_id))}
    </div>
    <div class="mail-facts-cell mail-facts-cell-runs">
      <span class="mail-facts-cell-label">Triggered recipes</span>
      ${renderRuns(row)}
    </div>
  </li>`;

const hasFilters = (state: FactsState): boolean =>
  state.email !== null || FILTER_KEYS.some((key) => state.filters[key] !== undefined);

const renderFacts = (state: FactsState, actionAttr: string, available: boolean, openData: ReadonlySet<string>): string => {
  if (!available) {
    return `<p class="mail-facts-subtle">This server cannot list mail facts.</p>`;
  }
  const body = !state.loaded
    ? '<p class="mail-facts-subtle" aria-live="polite">Loading facts…</p>'
    : state.rows.length === 0 && state.error === null
      ? `<p class="mail-facts-empty">${hasFilters(state)
          ? 'No facts match.'
          : 'No facts yet. Recued reads them from new mail: parcels, orders, bills and bookings that senders mark up in a standard way, requests you mail to your own +tag address, and anything a template of yours reads.'}</p>`
      : `
        <div class="mail-facts-columns" aria-hidden="true">
          <span>Matched mail</span><span>Fact</span><span>Triggered recipes</span>
        </div>
        <ul class="mail-facts-list" role="list">
          ${state.rows.map((row) => renderRow(row, state.templates, state.types, actionAttr, openData)).join('')}
        </ul>`;
  return `
    ${state.email !== null
      ? `<div class="mail-facts-email-filter">
          <span>Facts from one email${state.email.subject !== undefined && state.email.subject.length > 0
            ? `: <strong>${e(state.email.subject)}</strong>`
            : ''}</span>
          <button type="button" class="data-button" ${actionAttr}="mail-facts-show-all"
            ${MAIL_FACTS_FOCUS_ATTR}="show-all">Show all facts</button>
        </div>`
      : renderFilters(state)}
    ${state.error !== null
      ? `<p class="mail-facts-error" role="alert">${e(state.error)}
          <button type="button" class="data-button" ${actionAttr}="mail-facts-retry" ${MAIL_FACTS_FOCUS_ATTR}="retry">Try again</button></p>`
      : ''}
    ${state.loaded && state.updating ? '<p class="mail-facts-subtle" aria-live="polite">Updating…</p>' : ''}
    ${body}
    ${state.next !== null
      ? `<div class="data-list-footer">
          <span class="data-list-count">${state.rows.length} ${state.rows.length === 1 ? 'fact' : 'facts'} shown</span>
          <button type="button" class="data-button" ${actionAttr}="mail-facts-load-more"
            ${MAIL_FACTS_FOCUS_ATTR}="load-more"${state.loadingMore || state.loading ? ' aria-disabled="true"' : ''}${state.loadingMore ? ' aria-busy="true"' : ''}>
            ${state.loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>`
      : ''}`;
};

// ── The surface ─────────────────────────────────────────────────────────────

const queryOf = (state: FactsState, before?: MailFactRowsCursor): MailFactRowsQuery => {
  // One email's facts are all of them: its screen shows no filters, so none
  // may apply unseen. They wait for "Show all facts".
  const filters: Filters = state.email !== null ? {} : state.filters;
  return {
    limit: PAGE_EMAILS,
    ...(filters.type !== undefined ? { type: filters.type } : {}),
    ...(filters.state !== undefined ? { state: filters.state } : {}),
    ...(filters.notice !== undefined ? { notice: filters.notice } : {}),
    ...(filters.template !== undefined
      ? { template_id: filters.template === STANDARDS_ONLY ? null : filters.template }
      : {}),
    ...(filters.complete !== undefined ? { complete: filters.complete === 'yes' } : {}),
    ...(filters.paired !== undefined ? { unpaired: filters.paired === 'unpaired' } : {}),
    ...(filters.runs !== undefined ? { has_run: filters.runs === 'yes' } : {}),
    ...(state.email !== null ? { email: state.email.ref } : {}),
    ...(before !== undefined ? { before } : {}),
  };
};

export const createMailFactsSurface = (deps: MailFactsSurfaceDeps): MailFactsSurface => {
  const { callers } = deps;
  let view: MailFactView = 'facts';
  let facts: FactsState = {
    rows: [],
    next: null,
    loaded: false,
    loading: false,
    updating: false,
    loadingMore: false,
    error: null,
    filters: {},
    email: null,
    templates: [],
    types: [],
  };
  let seq = 0;
  let pages = 0;
  let disposed = false;
  let pendingFocus: string | null = null;
  /** The facts whose Data the owner opened: kept open across live refreshes. */
  const openData = new Set<string>();

  const templates: MailFactTemplates = createMailFactTemplates({
    callers,
    actionAttr: deps.actionAttr,
    render: () => deps.render(),
    onAddressChange: () => deps.onAddressChange(),
    focus: (key) => { pendingFocus = key; },
  });

  const makeTemplateFrom = async (email: MailFactEmailRef): Promise<void> => {
    view = 'templates';
    await templates.openFromEmail(email);
  };

  const senders: MailFactSenders = createMailFactSenders({
    callers,
    actionAttr: deps.actionAttr,
    render: () => deps.render(),
    focus: (key) => { pendingFocus = key; },
    makeTemplate: (email) => {
      pendingFocus = 'ed:title';
      void makeTemplateFrom(email);
    },
    canMakeTemplate: callers.readEmail !== undefined && callers.createTemplate !== undefined,
  });

  const loadFacts = async (silent: boolean): Promise<void> => {
    const listFacts = callers.listFacts;
    if (listFacts === undefined) return;
    const mine = ++seq;
    facts = { ...facts, loading: true, updating: !silent, loadingMore: false, error: silent ? facts.error : null };
    if (!silent) deps.render();
    try {
      const [page, named, owned] = await Promise.all([
        listFacts(queryOf(facts)),
        callers.listTemplates?.().then((result) => result.templates).catch(() => facts.templates)
          ?? Promise.resolve(facts.templates),
        callers.listTypes?.().then((result) => result.types).catch(() => facts.types)
          ?? Promise.resolve(facts.types),
      ]);
      if (disposed || mine !== seq) return;
      facts = {
        ...facts,
        rows: page.rows,
        next: page.next_cursor ?? null,
        loaded: true,
        loading: false,
        updating: false,
        error: null,
        templates: named,
        types: owned,
      };
      pages = 1;
    } catch (error) {
      if (disposed || mine !== seq) return;
      facts = { ...facts, loaded: true, loading: false, updating: false, error: humanizeRpcError(error) };
    }
    deps.render();
  };

  const loadMore = async (): Promise<void> => {
    const listFacts = callers.listFacts;
    if (listFacts === undefined || facts.next === null || facts.loadingMore || facts.loading) return;
    const mine = ++seq;
    const before = facts.next;
    facts = { ...facts, loadingMore: true };
    pendingFocus = 'load-more';
    deps.render();
    try {
      const page = await listFacts(queryOf(facts, before));
      if (disposed || mine !== seq) return;
      const seen = new Set(facts.rows.map((row) => row.fact.fact_id));
      const added = page.rows.filter((row) => !seen.has(row.fact.fact_id));
      facts = {
        ...facts,
        rows: [...facts.rows, ...added],
        next: page.next_cursor ?? null,
        loadingMore: false,
        error: null,
      };
      pages += 1;
      // Keep the owner's place: the first new row's email, or the button.
      pendingFocus = added[0] !== undefined && added[0].email !== null
        ? `mail:${added[0].fact.fact_id}`
        : facts.next !== null ? 'load-more' : null;
    } catch (error) {
      if (disposed || mine !== seq) return;
      facts = { ...facts, loadingMore: false, error: humanizeRpcError(error) };
    }
    deps.render();
  };

  const switchView = (next: MailFactView): void => {
    if (next === view) return;
    view = next;
    pendingFocus = `view:${next}`;
    deps.onAddressChange();
    deps.render();
    void (next === 'facts' ? loadFacts(false) : next === 'templates' ? templates.refresh(false) : senders.refresh(false));
  };

  const renderViews = (): string => `
    <div class="mail-facts-views" role="group" aria-label="Mail facts views">
      ${MAIL_FACT_VIEWS.map((candidate) => `
        <button type="button" class="data-button" ${deps.actionAttr}="mail-facts-view" data-view="${candidate}"
          ${MAIL_FACTS_FOCUS_ATTR}="view:${candidate}" aria-pressed="${candidate === view ? 'true' : 'false'}">${VIEW_WORDS[candidate]}</button>`).join('')}
    </div>`;

  return {
    render: () => `
      <section class="mail-facts" ${MAIL_FACTS_HOST_ATTR}="${view}">
        <div class="data-contact-toolbar">
          <h2 class="data-section-title">Mail facts</h2>
        </div>
        ${renderViews()}
        ${view === 'facts'
          ? `<p class="mail-facts-intro">What Recued read from your mail: each fact, the email it came from, and the recipes it started.</p>
            ${renderFacts(facts, deps.actionAttr, callers.listFacts !== undefined, openData)}`
          : view === 'templates' ? templates.render() : senders.render()}
      </section>`,

    refresh: (silent = false) =>
      view === 'facts' ? loadFacts(silent) : view === 'templates' ? templates.refresh(silent) : senders.refresh(silent),

    handleAction: (action, target) => {
      if (!action.startsWith(MAIL_FACTS_ACTION_PREFIX)) return false;
      if (action === 'mail-facts-view') {
        const next = target.getAttribute('data-view');
        if ((MAIL_FACT_VIEWS as readonly string[]).includes(next ?? '')) switchView(next as MailFactView);
      } else if (view === 'templates') {
        templates.handleAction(action, target);
      } else if (view === 'senders') {
        senders.handleAction(action, target);
      } else if (action === 'mail-facts-data-toggle') {
        // The browser opens or shuts it; the set keeps it so across repaints.
        const id = target.getAttribute('data-fact-id') ?? '';
        if (openData.has(id)) openData.delete(id);
        else openData.add(id);
      } else if (action === 'mail-facts-load-more') {
        void loadMore();
      } else if (action === 'mail-facts-retry') {
        pendingFocus = 'retry';
        void loadFacts(false);
      } else if (action === 'mail-facts-show-all') {
        facts = { ...facts, email: null, rows: [], next: null, loaded: false };
        pendingFocus = 'filter:type';
        void loadFacts(false);
      }
      return true;
    },

    handleChange: (target) => {
      if (target.getAttribute(MAIL_FACTS_FIELD_ATTR) !== null) return view === 'templates' && templates.handleChange(target);
      const key = target.getAttribute(MAIL_FACTS_FILTER_ATTR);
      if (!isFilterKey(key)) return false;
      const raw = (target as HTMLSelectElement).value ?? '';
      const next: Filters = { ...facts.filters };
      if (raw.length === 0) delete next[key];
      else next[key] = raw;
      // A state, notice or template of another type no longer applies.
      if (key === 'type' && next.type !== undefined) {
        const spec = typeSpec(next.type, facts.types);
        if (next.state !== undefined && !(spec?.states ?? []).includes(next.state)) delete next.state;
        if (next.notice !== undefined && !(spec?.notices ?? []).includes(next.notice)) delete next.notice;
        if (next.template !== undefined && next.template !== STANDARDS_ONLY
          && facts.templates.find((t) => t.template_id === next.template)?.type !== next.type) {
          delete next.template;
        }
      }
      facts = { ...facts, filters: next };
      pendingFocus = `filter:${key}`;
      void loadFacts(false);
      return true;
    },

    handleInput: (target) => view === 'templates' && templates.handleInput(target),

    addressSegments: () => (view === 'templates' ? [view, ...templates.addressSegments()] : [view]),

    openAddress: (segments) => {
      const wanted = segments[0];
      view = (MAIL_FACT_VIEWS as readonly string[]).includes(wanted ?? '') ? (wanted as MailFactView) : 'facts';
      if (view === 'templates') templates.openAddress(segments.slice(1));
    },

    makeTemplateFrom: (email) => {
      pendingFocus = 'ed:title';
      return makeTemplateFrom(email);
    },

    showEmail: async (email, subject) => {
      view = 'facts';
      pendingFocus = 'show-all';
      facts = {
        ...facts,
        email: { ref: email, ...(subject !== undefined ? { subject } : {}) },
        rows: [],
        next: null,
        loaded: false,
      };
      deps.onAddressChange();
      await loadFacts(false);
    },

    isBusy: () =>
      view === 'templates'
        ? templates.isBusy()
        : view === 'senders' ? senders.isBusy() : facts.loading || facts.loadingMore || pages > 1,

    hasUnsavedChanges: () => templates.hasUnsavedChanges(),

    hasInFlightWork: () => templates.hasInFlightWork() || senders.hasInFlightWork(),

    captureFocus: (active) => {
      const key = (active as HTMLElement | null | undefined)?.getAttribute?.(MAIL_FACTS_FOCUS_ATTR);
      return typeof key === 'string' && key.length > 0 ? key : null;
    },

    restoreFocus: (root, key) => {
      const wanted = pendingFocus ?? key;
      if (wanted === null) return;
      const found = root.querySelector?.(`[${MAIL_FACTS_FOCUS_ATTR}="${wanted.replace(/["\\]/g, '\\$&')}"]`) as
        | HTMLElement
        | null
        | undefined;
      if (found !== null && found !== undefined) {
        // Putting focus back after a repaint must not move the page; moving it
        // somewhere new (the box a clicked value opens) must bring it into view.
        found.focus?.({ preventScroll: pendingFocus === null });
        pendingFocus = null;
      } else if (pendingFocus !== null && !facts.loading && !facts.loadingMore) {
        pendingFocus = null;
      }
    },

    dispose: () => {
      disposed = true;
      templates.dispose();
      senders.dispose();
    },
  };
};

/** The tab's styles, scoped to its host; injected with the Data route's. */
export const MAIL_FACTS_STYLES = `
[${MAIL_FACTS_HOST_ATTR}] { min-width: 0; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-intro { margin: 0 0 12px; color: var(--muted); font-size: 13px; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-filters {
  display: flex; flex-wrap: wrap; gap: 8px 12px; margin: 0 0 12px;
}
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-filter { display: grid; gap: 2px; font-size: 12px; color: var(--muted); min-width: 0; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-filter select { max-width: 100%; font: inherit; font-size: 13px; color: var(--fg); }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-email-filter {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 12px; font-size: 13px;
}
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-email-filter strong { overflow-wrap: anywhere; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-columns {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 1fr); gap: 16px;
  padding: 0 10px 4px; font-size: 12px; font-weight: 600; color: var(--muted);
}
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-row {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 1fr); gap: 16px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 10px; min-width: 0;
}
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-row[data-unpaired="true"] { border-style: dashed; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-cell { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-cell-label { display: none; font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-subject { font-weight: 600; overflow-wrap: anywhere; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-subject,
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-runs a { color: var(--accent); text-decoration: none; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-subject:hover,
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-subject:focus-visible,
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-runs a:hover,
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-runs a:focus-visible { text-decoration: underline; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-from { font-size: 13px; overflow-wrap: anywhere; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-subtle, [${MAIL_FACTS_HOST_ATTR}] .mail-facts-place { margin: 0; font-size: 12px; color: var(--muted); }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-place { font-weight: 600; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-state { font-weight: 600; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-notice { font-size: 12px; border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-sr {
  position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
}
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-values { display: grid; gap: 2px; margin: 4px 0; font-size: 13px; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-value { display: grid; grid-template-columns: minmax(0, 9em) minmax(0, 1fr); gap: 8px; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-value dt { color: var(--muted); overflow-wrap: anywhere; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-value dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-pass {
  display: inline-block; font-size: 11px; line-height: 1.5; border-radius: 4px; padding: 0 5px;
  border: 1px solid var(--border); color: var(--muted); white-space: nowrap;
}
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-pass[data-pass="rule"] { border-color: var(--accent); color: var(--accent); }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-pass[data-pass="ai"] { border-style: dashed; color: var(--fg); }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-pass[data-pass="missing"],
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-pass[data-pass="refused"] { border-color: var(--danger); color: var(--danger); }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-unpaired { margin: 4px 0; font-size: 12px; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-ai { margin: 4px 0; font-size: 12px; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-ai[data-ai="not_read"] { color: var(--danger); }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-data summary { cursor: pointer; font-size: 12px; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-data pre {
  margin: 4px 0 0; max-height: 240px; overflow: auto; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere;
}
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-runs { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; font-size: 13px; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-runs li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; min-width: 0; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-runs a, [${MAIL_FACTS_HOST_ATTR}] .mail-facts-runs li > span:first-child { overflow-wrap: anywhere; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-run-state { font-size: 12px; font-weight: 600; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-run-state[data-tone="bad"] { color: var(--danger); }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-run-state[data-tone="wait"] { color: var(--muted); }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-error { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--danger); }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-notice { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-notice p { margin: 0; flex: 1 1 240px; }
/* A recipe's template, shown and not edited: its rules update with the recipe. */
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-readonly { margin: 0; padding: 0; border: 0; min-width: 0; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-empty { color: var(--muted); max-width: 60ch; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-views { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-views .data-button[aria-pressed="true"] {
  border-color: var(--accent); color: var(--accent); background: var(--accent-weak);
}
${MAIL_FACT_TEMPLATES_STYLES(MAIL_FACTS_HOST_ATTR)}
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-subjects { margin: 0; padding-left: 18px; font-size: 13px; overflow-wrap: anywhere; }
@media (max-width: 720px) {
  [${MAIL_FACTS_HOST_ATTR}] .mail-facts-filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  [${MAIL_FACTS_HOST_ATTR}] .mail-facts-filter select { width: 100%; }
  [${MAIL_FACTS_HOST_ATTR}] .mail-facts-columns { display: none; }
  [${MAIL_FACTS_HOST_ATTR}] .mail-facts-row { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  [${MAIL_FACTS_HOST_ATTR}] .mail-facts-cell-label { display: block; }
}
`;
