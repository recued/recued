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

import { focusListTarget } from '../shell/list-preview-continuity.js';
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
const MAIL_FACT_READER_ATTR = 'data-mail-fact-reader';
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
  readonly desktopWorkspace?: () => boolean;
  readonly navigation?: {
    readonly document: Document;
    readonly owner: object;
    readonly scrollHost: () => Element | null;
  };
  /** D-325 — one thing opened by its address (a bill, a delivery Today linked to). */
  readonly onThingOpened?: (thing_id: string) => void;
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
  captureViewport(root: ParentNode): MailFactsViewport | null;
  restoreFocus(root: ParentNode, key: string | null, viewport?: MailFactsViewport | null, layoutReady?: boolean): void;
  rememberLink(event: MouseEvent, root: ParentNode): void;
  closeReaderFromKeyboard(target: Element | null): boolean;
  workspaceChanged(active: Element | null): void;
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
  /** A failed append retries this cursor, keeping every page already shown. */
  readonly failedPage: MailFactRowsCursor | null;
  readonly filters: Filters;
  readonly email: { readonly ref: MailFactEmailRef; readonly subject?: string } | null;
  /** One thing's facts, across the emails that told of it: what Today links to. */
  readonly thing: string | null;
  readonly templates: readonly MailTemplate[];
  /** The kinds of email the owner made (§4.5). */
  readonly types: readonly MailFactTypeSpec[];
}

interface MailFactsViewport {
  readonly pageTop: number | undefined;
  readonly listTop: number | undefined;
  readonly reader: { readonly id: string; readonly top: number } | null;
}

interface MailFactsVisit {
  readonly hash: string;
  readonly facts: FactsState;
  readonly pages: number;
  readonly selectedId: string | null;
  readonly openData: ReadonlySet<string>;
  readonly viewport: MailFactsViewport | null;
  readonly focus: string;
}

// The History entry only carries an ID. Mail and filters stay in this document
// and belong to the current server connection.
const mailFactsVisits = new WeakMap<Document, WeakMap<object, Map<number, MailFactsVisit>>>();
let mailFactsVisitSequence = 0;
const MAIL_FACTS_VISIT_LIMIT = 8;
const HISTORY_VISIT_KEY = 'recuedMailFactsVisit';

const mailFactsHistory = (navigation: NonNullable<MailFactsSurfaceDeps['navigation']>) => {
  const { document, owner } = navigation;
  let byOwner = mailFactsVisits.get(document);
  if (byOwner === undefined) mailFactsVisits.set(document, byOwner = new WeakMap());
  let visits = byOwner.get(owner);
  if (visits === undefined) byOwner.set(owner, visits = new Map());
  return visits;
};

const readMailFactsVisit = (navigation: MailFactsSurfaceDeps['navigation']): MailFactsVisit | undefined => {
  const view = navigation?.document.defaultView;
  if (!navigation || !view) return undefined;
  try {
    const id = view.history.state?.[HISTORY_VISIT_KEY];
    const visit = typeof id === 'number' ? mailFactsHistory(navigation).get(id) : undefined;
    return visit?.hash === view.location.hash ? visit : undefined;
  } catch {
    return undefined;
  }
};

const rememberMailFactsVisit = (
  navigation: MailFactsSurfaceDeps['navigation'],
  state: Omit<MailFactsVisit, 'hash'>,
): void => {
  const view = navigation?.document.defaultView;
  if (!navigation || !view) return;
  try {
    const { history, location } = view;
    const visits = mailFactsHistory(navigation);
    const previous = history.state;
    const previousId = previous?.[HISTORY_VISIT_KEY];
    const id = typeof previousId === 'number' && visits.get(previousId)?.hash === location.hash
      ? previousId
      : ++mailFactsVisitSequence;
    const existingState = previous !== null && typeof previous === 'object' ? previous : {};
    history.replaceState({ ...existingState, [HISTORY_VISIT_KEY]: id }, '');
    // Keep recent trips without retaining every paginated history indefinitely.
    visits.delete(id);
    visits.set(id, { ...state, hash: location.hash });
    for (const key of visits.keys()) {
      if (visits.size <= MAIL_FACTS_VISIT_LIMIT) break;
      visits.delete(key);
    }
  } catch {
    // Normal links still work in hosts with restricted History access.
  }
};

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

const factState = (row: MailFactRow) =>
  row.thing?.variables[MAIL_FACT_STATE_VARIABLE] ?? row.fact.variables[MAIL_FACT_STATE_VARIABLE];

const renderFactStatus = (row: MailFactRow): string => {
  const now = factState(row);
  const notice = row.fact.variables[MAIL_FACT_NOTICE_VARIABLE];
  const state = typeof now === 'string'
    ? `<span class="mail-facts-state"><span class="mail-facts-sr">${row.thing !== null ? 'State now: ' : 'State: '}</span>${e(humanize(now))}</span>`
    : '';
  return state + (typeof notice === 'string' ? `<span class="mail-facts-notice">${e(humanize(notice))}</span>` : '');
};

const renderFactValues = (
  row: MailFactRow,
  templates: readonly MailTemplate[],
  owned: readonly MailFactTypeSpec[],
): string => {
  const own = row.fact.variables[MAIL_FACT_STATE_VARIABLE];
  const template = row.fact.template_id === null
    ? null
    : templates.find((candidate) => candidate.template_id === row.fact.template_id);
  const readBy = row.fact.template_id === null
    ? 'Read from standard markup'
    : template !== undefined && template !== null
      ? `Read by ${template.name}`
      : 'Read by a template since deleted';
  return `
    ${row.thing !== null && typeof own === 'string' && own !== factState(row)
      ? `<p class="mail-facts-subtle">This email said: ${e(humanize(own))}</p>`
      : ''}
    ${renderValues(row, owned)}
    ${renderAi(row, owned)}
    ${unpaired(row)
      ? `<p class="mail-facts-unpaired">Unpaired: not joined to a ${e(typeName(row.fact.type, owned).toLowerCase())} and not used by recipes. It may be the same one a template of yours read from this email, and Recued cannot tell which.</p>`
      : ''}
    <p class="mail-facts-subtle">${e(readBy)}</p>`;
};

const renderRawData = (row: MailFactRow, actionAttr: string, open: boolean, label: string): string => {
  const data = row.fact.data;
  if (data == null || typeof data === 'object' && Object.keys(data).length === 0) return '';
  const id = e(row.fact.fact_id);
  return `<details class="mail-facts-data"${open ? ' open' : ''}>
    <summary ${actionAttr}="mail-facts-data-toggle" data-fact-id="${id}" ${MAIL_FACTS_FOCUS_ATTR}="data:${id}">${label}</summary>
    <pre>${e(JSON.stringify(data, null, 2))}</pre>
  </details>`;
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
  <li class="mail-facts-row" tabindex="-1" ${MAIL_FACTS_FOCUS_ATTR}="row:${e(row.fact.fact_id)}" ${MAIL_FACTS_ROW_ATTR}="${e(row.fact.fact_id)}"${unpaired(row) ? ' data-unpaired="true"' : ''}${waitingForAi(row) ? ' data-ai="waiting"' : ''}>
    <div class="mail-facts-cell mail-facts-cell-mail">
      <span class="mail-facts-cell-label">Matched mail</span>
      ${renderMail(row)}
    </div>
    <div class="mail-facts-cell mail-facts-cell-fact">
      <span class="mail-facts-cell-label">Fact</span>
      <div class="mail-facts-heading">
        <span class="data-pill">${e(typeName(row.fact.type, owned))}</span>
        ${renderFactStatus(row)}
      </div>
      ${renderFactValues(row, templates, owned)}
      ${renderRawData(row, actionAttr, openData.has(row.fact.fact_id), 'Data')}
    </div>
    <div class="mail-facts-cell mail-facts-cell-runs">
      <span class="mail-facts-cell-label">Triggered recipes</span>
      ${renderRuns(row)}
    </div>
  </li>`;

const renderCompactRow = (row: MailFactRow, state: FactsState, actionAttr: string, selected: boolean): string => {
  const id = e(row.fact.fact_id);
  const status = factState(row);
  const statusLabel = typeof status === 'string' ? humanize(status) : waitingForAi(row) ? 'Reading with AI' : unpaired(row) ? 'Unpaired' : '';
  const subject = row.email === null ? 'Email unavailable' : row.email.subject || '(no subject)';
  return `<li class="mail-facts-compact-row" ${MAIL_FACTS_ROW_ATTR}="${id}">
    <button type="button" class="mail-facts-row-button" ${actionAttr}="mail-facts-open-fact" data-fact-id="${id}"
      ${MAIL_FACTS_FOCUS_ATTR}="row:${id}"${selected ? ' aria-current="true"' : ''}${state.updating ? ' aria-disabled="true"' : ''}>
      <span class="mail-facts-compact-summary">
        <span class="mail-facts-compact-subject" title="${e(subject)}">${e(subject)}</span>
        ${statusLabel ? `<span class="data-pill" title="${e(statusLabel)}">${e(statusLabel)}</span>` : ''}
      </span>
      <span class="mail-facts-compact-meta mail-facts-subtle">
        <span>${e(typeName(row.fact.type, state.types))}</span>
        <span>${e(dateTime(row.email?.at ?? row.fact.email_at))}</span>
      </span>
    </button>
  </li>`;
};

const renderFactReader = (row: MailFactRow, state: FactsState, actionAttr: string, openData: ReadonlySet<string>): string => {
  const id = e(row.fact.fact_id);
  return `<section class="mail-facts-reader work-entity-reader--inline" aria-label="Fact details">
    <header class="mail-facts-reader-header">
      <h3 tabindex="-1" ${MAIL_FACTS_FOCUS_ATTR}="reader:${id}">${e(typeName(row.fact.type, state.types))}</h3>
      <button type="button" class="data-button" ${actionAttr}="mail-facts-close-fact" ${MAIL_FACTS_FOCUS_ATTR}="close-fact">Close fact</button>
    </header>
    <div class="mail-facts-reader-body" ${MAIL_FACT_READER_ATTR}="${id}">
      <section class="mail-facts-reader-section">
        <h4>Extracted values</h4>
        <div class="mail-facts-heading">${renderFactStatus(row)}</div>
        ${renderFactValues(row, state.templates, state.types)}
      </section>
      <section class="mail-facts-reader-section">
        <h4>Source email</h4>
        ${renderMail(row)}
      </section>
      <section class="mail-facts-reader-section">
        <h4>Triggered recipes</h4>
        ${renderRuns(row)}
      </section>
      ${renderRawData(row, actionAttr, openData.has(row.fact.fact_id), 'Raw data')}
    </div>
  </section>`;
};

const hasFilters = (state: FactsState): boolean =>
  state.email !== null || state.thing !== null || FILTER_KEYS.some((key) => state.filters[key] !== undefined);

/** The one thing a view shows, as its own facts name it: "Bill: Acme Power". */
const thingHeading = (state: FactsState): string => {
  const thing = state.rows.find((row) => row.thing !== null)?.thing;
  if (thing === undefined || thing === null) return 'One item';
  const label = [thing.variables.issuer, thing.variables.merchant, thing.variables.provider, thing.variables.carrier]
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  return `${typeName(thing.type, state.types)}${label !== undefined ? `: ${label}` : ''}`;
};

const renderFacts = (
  state: FactsState,
  actionAttr: string,
  available: boolean,
  openData: ReadonlySet<string>,
  workspace?: { readonly selectedId: string | null },
): string => {
  if (!available) {
    return `<p class="mail-facts-subtle">This server cannot list mail facts.</p>`;
  }
  const body = !state.loaded
    ? '<p class="mail-facts-subtle" aria-live="polite">Loading facts…</p>'
    : state.rows.length === 0 && state.error === null
      ? `<p class="mail-facts-empty">${state.thing !== null
          ? 'This item is no longer stored.'
          : hasFilters(state)
          ? 'No facts match.'
          : 'No facts yet. Recued reads them from saved mail, including your first sync: parcels, orders, bills and bookings that senders mark up in a standard way, requests you mail to your own +tag address, and anything a template of yours reads.'}</p>`
      : `
        ${workspace === undefined ? `<div class="mail-facts-columns" aria-hidden="true">
          <span>Matched mail</span><span>Fact</span><span>Triggered recipes</span>
        </div>` : ''}
        <ul class="mail-facts-list" role="list">
          ${state.rows.map((row) => workspace === undefined
            ? renderRow(row, state.templates, state.types, actionAttr, openData)
            : renderCompactRow(row, state, actionAttr, row.fact.fact_id === workspace.selectedId)).join('')}
        </ul>`;
  const footer = state.next !== null || state.rows.length > 0
    ? `<div class="data-list-footer">
        <span class="data-list-count" role="status" tabindex="-1" ${MAIL_FACTS_FOCUS_ATTR}="list-count">${state.rows.length} ${state.rows.length === 1 ? 'fact' : 'facts'} shown</span>
        ${state.next !== null ? `<button type="button" class="data-button" ${actionAttr}="mail-facts-load-more"
          ${MAIL_FACTS_FOCUS_ATTR}="load-more"${state.loadingMore || state.loading || (state.error !== null && state.failedPage === null) ? ' aria-disabled="true"' : ''}${state.loadingMore ? ' aria-busy="true"' : ''}>
          ${state.loadingMore ? 'Loading…' : 'Load more'}
        </button>` : ''}
      </div>` : '';
  const selected = workspace === undefined ? undefined : state.rows.find((row) => row.fact.fact_id === workspace.selectedId);
  return `
    ${state.thing !== null
      ? `<div class="mail-facts-email-filter" data-mail-facts-thing="${e(state.thing)}">
          <span>${state.loaded && state.rows.length > 0 ? `<strong>${e(thingHeading(state))}</strong>, every email that told of it` : 'One item'}</span>
          <button type="button" class="data-button" ${actionAttr}="mail-facts-show-all"
            ${MAIL_FACTS_FOCUS_ATTR}="show-all">Show all facts</button>
        </div>`
      : state.email !== null
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
          <button type="button" class="data-button" ${actionAttr}="mail-facts-retry" ${MAIL_FACTS_FOCUS_ATTR}="retry"${state.loading || state.loadingMore ? ' aria-disabled="true" aria-busy="true"' : ''}>${state.loading || state.loadingMore ? 'Retrying…' : 'Try again'}</button></p>`
      : ''}
    ${state.loaded && state.updating ? '<p class="mail-facts-subtle" aria-live="polite">Updating…</p>' : ''}
    ${workspace !== undefined && state.rows.length > 0
      ? `<div class="mail-facts-workspace work-entity-list-workspace">
          <div class="mail-facts-workspace-list">${body}${footer}</div>
          ${selected === undefined
            ? '<p class="mail-facts-reader-empty work-entity-reader--inline">Select a fact to review it.</p>'
            : renderFactReader(selected, state, actionAttr, openData)}
        </div>`
      : `${body}${footer}`}`;
};

// ── The surface ─────────────────────────────────────────────────────────────

const queryOf = (state: FactsState, before?: MailFactRowsCursor): MailFactRowsQuery => {
  // One email's facts are all of them: its screen shows no filters, so none
  // may apply unseen. They wait for "Show all facts".
  const filters: Filters = state.email !== null || state.thing !== null ? {} : state.filters;
  if (state.thing !== null) return { limit: PAGE_EMAILS, thing_id: state.thing, ...(before !== undefined ? { before } : {}) };
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
  const visit = readMailFactsVisit(deps.navigation);
  const desktop = () => deps.desktopWorkspace?.() === true;
  let view: MailFactView = 'facts';
  let facts: FactsState = visit?.facts ?? {
    rows: [],
    next: null,
    loaded: false,
    loading: false,
    updating: false,
    loadingMore: false,
    error: null,
    failedPage: null,
    filters: {},
    email: null,
    thing: null,
    templates: [],
    types: [],
  };
  let seq = 0;
  let pages = visit?.pages ?? 0;
  let selectedId = visit?.selectedId ?? null;
  let returning = visit;
  let skipInitialRead = visit !== undefined && !visit.facts.loading;
  let disposed = false;
  let pendingFocus: string | null = null;
  /** Read replies can redirect only a control that still owns this view's focus. */
  let pendingReadFocus: { key: string; from: readonly string[]; view: MailFactView } | null = null;
  const pageFocusKey = (rows: readonly MailFactRow[], next: MailFactRowsCursor | null): string => {
    if (desktop() && rows[0]) return `row:${rows[0].fact.fact_id}`;
    const mail = rows.find(row => row.email !== null);
    return mail !== undefined ? `mail:${mail.fact.fact_id}` : next !== null ? 'load-more' : 'list-count';
  };
  /** The facts whose Data the owner opened: kept open across live refreshes. */
  const openData = new Set(visit?.openData);

  const captureViewport = (root: ParentNode): MailFactsViewport | null => {
    if (!root.querySelector?.(`[${MAIL_FACTS_HOST_ATTR}="facts"]`)) return null;
    const list = root.querySelector?.('.mail-facts-workspace-list .mail-facts-list');
    const pane = root.querySelector?.(`[${MAIL_FACT_READER_ATTR}]`);
    const id = pane?.getAttribute(MAIL_FACT_READER_ATTR);
    return {
      pageTop: deps.navigation?.scrollHost()?.scrollTop,
      listTop: list?.scrollTop,
      reader: pane && id != null ? { id, top: pane.scrollTop } : null,
    };
  };

  const closeReader = (): boolean => {
    if (selectedId === null) return false;
    pendingFocus = `row:${selectedId}`;
    selectedId = null;
    deps.render();
    return true;
  };

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
    focus: (key, from) => {
      if (from === undefined) pendingFocus = key;
      else pendingReadFocus = { key, from: [from], view: 'senders' };
    },
    makeTemplate: (email) => {
      pendingFocus = 'ed:title';
      void makeTemplateFrom(email);
    },
    canMakeTemplate: callers.readEmail !== undefined && callers.createTemplate !== undefined,
  });

  const loadFacts = async (silent: boolean, retry = false): Promise<void> => {
    const listFacts = callers.listFacts;
    if (listFacts === undefined) return;
    const mine = ++seq;
    pendingReadFocus = null;
    facts = { ...facts, loading: true, updating: !silent, loadingMore: false, failedPage: null, error: silent || retry ? facts.error : null };
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
      if (selectedId !== null && !page.rows.some(row => row.fact.fact_id === selectedId)) selectedId = null;
      pages = 1;
      if (retry) pendingReadFocus = { key: pageFocusKey(page.rows, facts.next), from: ['retry'], view: 'facts' };
    } catch (error) {
      if (disposed || mine !== seq) return;
      facts = { ...facts, loaded: true, loading: false, updating: false, error: humanizeRpcError(error) };
    }
    deps.render();
  };

  const loadMore = async (): Promise<void> => {
    const listFacts = callers.listFacts;
    const before = facts.failedPage ?? facts.next;
    if (listFacts === undefined || before === null || facts.loadingMore || facts.loading
      || (facts.error !== null && facts.failedPage === null)) return;
    const mine = ++seq;
    pendingReadFocus = null;
    facts = { ...facts, loadingMore: true };
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
        failedPage: null,
      };
      pages += 1;
      pendingReadFocus = { key: pageFocusKey(added, facts.next), from: ['load-more', 'retry'], view: 'facts' };
    } catch (error) {
      if (disposed || mine !== seq) return;
      facts = { ...facts, loadingMore: false, failedPage: before, error: humanizeRpcError(error) };
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
    render: () => {
      const workspace = view === 'facts' && desktop() ? { selectedId } : undefined;
      return `<section class="mail-facts" ${MAIL_FACTS_HOST_ATTR}="${view}">
        <header class="mail-facts-header">
          <h2 class="data-section-title">Mail facts</h2>
          ${workspace === undefined ? '' : renderViews()}
        </header>
        ${workspace === undefined ? renderViews() : ''}
        ${view === 'facts'
          ? `${workspace === undefined ? '<p class="mail-facts-intro">What Recued read from your mail: each fact, the email it came from, and the recipes it started.</p>' : ''}
            ${renderFacts(facts, deps.actionAttr, callers.listFacts !== undefined, openData, workspace)}`
          : view === 'templates' ? templates.render() : senders.render()}
      </section>`;
    },

    refresh: async (silent = false) => {
      if (view === 'facts' && skipInitialRead) {
        skipInitialRead = false;
        return;
      }
      await (view === 'facts' ? loadFacts(silent) : view === 'templates' ? templates.refresh(silent) : senders.refresh(silent));
    },

    handleAction: (action, target) => {
      if (!action.startsWith(MAIL_FACTS_ACTION_PREFIX)) return false;
      if (action === 'mail-facts-view') {
        const next = target.getAttribute('data-view');
        if ((MAIL_FACT_VIEWS as readonly string[]).includes(next ?? '')) switchView(next as MailFactView);
      } else if (view === 'templates') {
        templates.handleAction(action, target);
      } else if (view === 'senders') {
        senders.handleAction(action, target);
      } else if (action === 'mail-facts-open-fact') {
        const id = target.getAttribute('data-fact-id');
        if (desktop() && id !== null && !facts.updating && facts.rows.some(row => row.fact.fact_id === id)) {
          selectedId = id;
          pendingFocus = `reader:${id}`;
          deps.render();
        }
      } else if (action === 'mail-facts-close-fact') {
        closeReader();
      } else if (action === 'mail-facts-data-toggle') {
        // The browser opens or shuts it; the set keeps it so across repaints.
        const id = target.getAttribute('data-fact-id') ?? '';
        if (openData.has(id)) openData.delete(id);
        else openData.add(id);
      } else if (action === 'mail-facts-load-more') {
        void loadMore();
      } else if (action === 'mail-facts-retry') {
        if (!facts.loading && !facts.loadingMore) {
          if (facts.failedPage !== null) void loadMore();
          else void loadFacts(false, true);
        }
      } else if (action === 'mail-facts-show-all') {
        const wasThing = facts.thing !== null;
        facts = { ...facts, email: null, thing: null, rows: [], next: null, loaded: false };
        selectedId = null;
        pendingFocus = 'filter:type';
        if (wasThing) deps.onAddressChange();
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
      selectedId = null;
      pendingFocus = `filter:${key}`;
      void loadFacts(false);
      return true;
    },

    handleInput: (target) => view === 'templates' && templates.handleInput(target),

    addressSegments: () => (view === 'templates' ? [view, ...templates.addressSegments()]
      : view === 'facts' && facts.thing !== null ? ['thing', facts.thing] : [view]),

    openAddress: (segments) => {
      if (visit !== undefined) return;
      const wanted = segments[0];
      // `#data/mail_fact/thing/<id>`: Today's link to one item opens that item.
      if (wanted === 'thing' && segments[1] !== undefined && segments[1].length > 0) {
        view = 'facts';
        facts = { ...facts, thing: segments[1], email: null, rows: [], next: null, loaded: false };
        deps.onThingOpened?.(segments[1]);
        return;
      }
      view = (MAIL_FACT_VIEWS as readonly string[]).includes(wanted ?? '') ? (wanted as MailFactView) : 'facts';
      if (view === 'templates') templates.openAddress(segments.slice(1));
    },

    makeTemplateFrom: (email) => {
      pendingFocus = 'ed:title';
      return makeTemplateFrom(email);
    },

    showEmail: async (email, subject) => {
      view = 'facts';
      selectedId = null;
      pendingFocus = 'show-all';
      facts = {
        ...facts,
        email: { ref: email, ...(subject !== undefined ? { subject } : {}) },
        thing: null,
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
        : view === 'senders' ? senders.isBusy() : facts.loading || facts.loadingMore || facts.failedPage !== null || pages > 1,

    hasUnsavedChanges: () => templates.hasUnsavedChanges(),

    hasInFlightWork: () => templates.hasInFlightWork() || senders.hasInFlightWork(),

    captureFocus: (active) => {
      const key = (active as HTMLElement | null | undefined)?.getAttribute?.(MAIL_FACTS_FOCUS_ATTR);
      return typeof key === 'string' && key.length > 0 ? key : null;
    },

    captureViewport,

    restoreFocus: (root, key, viewport = null, layoutReady = true) => {
      if (disposed) return;
      // Data's initial loading paint has different toolbar height. Apply the
      // saved offset after the normal layout has settled.
      const arrival = layoutReady ? returning : undefined;
      if (arrival) returning = undefined;
      const position = arrival?.viewport ?? viewport;
      const list = root.querySelector?.('.mail-facts-workspace-list .mail-facts-list');
      if (list) {
        if (pendingFocus?.startsWith('filter:')) list.scrollTop = 0;
        else if (position?.listTop !== undefined) list.scrollTop = position.listTop;
      }
      const pane = root.querySelector?.(`[${MAIL_FACT_READER_ATTR}]`);
      if (pane && position?.reader?.id === pane.getAttribute(MAIL_FACT_READER_ATTR)) pane.scrollTop = position.reader.top;
      const scrollHost = position?.pageTop === undefined ? null : deps.navigation?.scrollHost();
      if (scrollHost && position?.pageTop !== undefined) scrollHost.scrollTop = position.pageTop;
      const request = pendingReadFocus;
      pendingReadFocus = null;
      const readOwned = request !== null && request.view === view && key !== null && request.from.includes(key);
      const wanted = arrival?.focus ?? pendingFocus ?? (readOwned ? request.key : key);
      if (wanted === null) return;
      const control = (value: string): HTMLElement | null | undefined => root.querySelector?.(
        `[${MAIL_FACTS_FOCUS_ATTR}="${value.replace(/["\\]/g, '\\$&')}"]`,
      ) as HTMLElement | null | undefined;
      const previousId = position?.reader?.id;
      const readerFocus = wanted === 'close-fact' || wanted.startsWith('reader:')
        || wanted.startsWith('mail:') || wanted.startsWith('run:') || wanted.startsWith('data:');
      const found = control(wanted) ?? (readerFocus && previousId !== undefined ? control(`row:${previousId}`) : null)
        ?? (arrival || readOwned || readerFocus && previousId !== undefined
          ? (view === 'facts' ? control('list-count') : null) ?? control(`view:${view}`) : null);
      if (found !== null && found !== undefined) {
        // Putting focus back after a repaint must not move the page; moving it
        // somewhere new (the box a clicked value opens) must bring it into view.
        if (arrival || pendingFocus === null && !readOwned) focusListTarget(found);
        else found.focus?.({ preventScroll: false });
        pendingFocus = null;
      } else if (pendingFocus !== null && !facts.loading && !facts.loadingMore) {
        pendingFocus = null;
      }
    },

    rememberLink: (event, root) => {
      if (view !== 'facts' || !facts.loaded || event.button !== 0 || event.defaultPrevented
        || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      const focus = anchor?.getAttribute(MAIL_FACTS_FOCUS_ATTR);
      if (!focus || !(focus.startsWith('mail:') || focus.startsWith('run:'))) return;
      rememberMailFactsVisit(deps.navigation, {
        facts: { ...facts, loadingMore: false },
        pages, selectedId, openData: new Set(openData), viewport: captureViewport(root), focus,
      });
    },

    closeReaderFromKeyboard: (target) => desktop()
      && target?.closest?.('.mail-facts-reader, .mail-facts-row-button[aria-current="true"]') != null && closeReader(),

    workspaceChanged: (active) => {
      if (view !== 'facts') return;
      if (desktop()) {
        const focusedRow = active?.closest?.(`[${MAIL_FACTS_ROW_ATTR}]`)?.getAttribute(MAIL_FACTS_ROW_ATTR);
        if (focusedRow != null) selectedId = focusedRow;
      }
      deps.render();
    },

    dispose: () => {
      disposed = true;
      pendingReadFocus = null;
      templates.dispose();
      senders.dispose();
    },
  };
};

/** The tab's styles, scoped to its host; injected with the Data route's. */
export const MAIL_FACTS_STYLES = `
[${MAIL_FACTS_HOST_ATTR}] { min-width: 0; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-header { margin:0 0 12px; min-width:0; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-header > .data-section-title { margin:0; font-size:20px; font-weight:600; line-height:1.2; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-intro { margin: 0 0 12px; color: var(--muted); font-size: 13px; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-filters {
  display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; min-width:0; margin:0 0 16px;
}
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-filter { display:grid; gap:6px; min-width:0; font-size:12px; font-weight:600; line-height:1.4; color:var(--muted); }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-filter select { box-sizing:border-box; width:100%; min-width:0; max-width:100%; min-height:var(--wc-control-h,44px); padding:0 10px; border:1px solid var(--border-strong); border-radius:var(--wc-radius,9px); font:inherit; font-size:13px; font-weight:400; color:var(--fg); background:var(--surface); }
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
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-views { display:flex; flex-wrap:wrap; gap:6px; min-width:0; margin:0 0 16px; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-views > .data-button { min-width:0; max-width:100%; min-height:var(--wc-control-h,44px); padding:0 10px; border-radius:var(--wc-radius,9px); font-weight:600; overflow-wrap:anywhere; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-views .data-button[aria-pressed="true"] {
  border-color: var(--accent); color: var(--accent); background: var(--accent-weak);
}
[${MAIL_FACTS_HOST_ATTR}="facts"] .mail-facts-header:has(.mail-facts-views) {
  display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px 16px;
}
[${MAIL_FACTS_HOST_ATTR}="facts"] .mail-facts-header .mail-facts-views { margin:0; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-workspace {
  /* Reserve room for the Data heading, collection controls, and filters. */
  --mail-facts-pane-height:clamp(16rem, calc(100dvh - var(--wc-header-height,64px) - var(--wc-connection-banner-h,0px) - 23.5rem), 42rem);
}
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-workspace-list {
  display:flex; flex-direction:column; min-width:0; max-height:var(--mail-facts-pane-height);
}
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-workspace-list .mail-facts-list {
  min-height:0; overflow:auto; padding:3px; scrollbar-width:thin;
}
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-workspace-list .data-list-footer { flex-shrink:0; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-compact-row { min-width:0; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-row-button {
  display:grid; gap:4px; width:100%; min-width:0; padding:8px 10px;
  border:1px solid var(--border); border-radius:var(--wc-radius,9px); background:var(--surface);
  color:var(--fg); font:inherit; font-size:13px; line-height:1.35; text-align:start; cursor:pointer;
}
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-row-button:hover { border-color:var(--border-strong); background:var(--surface-subtle); }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-row-button[aria-current="true"] {
  background:var(--accent-weak); box-shadow:inset 3px 0 var(--accent);
}
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-compact-summary { display:grid; grid-template-columns:minmax(0,1fr) fit-content(45%); align-items:center; gap:8px; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-compact-summary > * { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-compact-subject { font-weight:600; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-compact-meta { display:flex; flex-wrap:wrap; gap:1px 8px; overflow-wrap:anywhere; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-workspace > .mail-facts-reader {
  display:flex; flex-direction:column; max-height:var(--mail-facts-pane-height); overflow:hidden; background:var(--surface);
}
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-reader-empty { margin:0; padding:16px; color:var(--muted); }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-reader-header {
  display:flex; align-items:center; justify-content:space-between; gap:12px; flex-shrink:0;
  padding:12px 16px; border-bottom:1px solid var(--border);
}
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-reader-header h3 { margin:0; font-size:18px; min-width:0; overflow-wrap:anywhere; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-reader-header .data-button { flex-shrink:0; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-reader-body {
  display:grid; grid-auto-rows:max-content; gap:16px; padding:16px; min-height:0; min-width:0; overflow:auto; scrollbar-width:thin;
}
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-reader-section { display:grid; gap:4px; min-width:0; overflow-wrap:anywhere; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-reader-section + .mail-facts-reader-section { padding-top:12px; border-top:1px solid var(--border); }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-reader-section h4 { margin:0; font-size:14px; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-reader .mail-facts-heading:empty { display:none; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-reader .mail-facts-heading .mail-facts-notice { margin:0; padding:1px 8px; border-radius:999px; }
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-reader .mail-facts-data pre { max-height:none; overflow:visible; }
${MAIL_FACT_TEMPLATES_STYLES(MAIL_FACTS_HOST_ATTR)}
[${MAIL_FACTS_HOST_ATTR}] .mail-facts-subjects { margin: 0; padding-left: 18px; font-size: 13px; overflow-wrap: anywhere; }
@media (max-width: 720px) {
  [${MAIL_FACTS_HOST_ATTR}] .mail-facts-columns { display: none; }
  [${MAIL_FACTS_HOST_ATTR}] .mail-facts-row { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  [${MAIL_FACTS_HOST_ATTR}] .mail-facts-cell-label { display: block; }
}
@media (max-width:1100px) {
  [${MAIL_FACTS_HOST_ATTR}] .mail-facts-filters { grid-template-columns:repeat(2,minmax(0,1fr)); }
}
@media (max-width:380px) {
  [${MAIL_FACTS_HOST_ATTR}] .mail-facts-filters { grid-template-columns:minmax(0,1fr); }
}
`;
