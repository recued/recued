import type { BrowserCollectViolation } from './browser-collect.js';
import { BROWSER_COLLECT_MAX_VIOLATIONS } from './browser-collect.js';
import { isBrowserControlEvidence, type BrowserControlEvidence } from './browser-controls.js';
import { isBrowserDataFailure, type BrowserDataFailure } from './browser-data-failure.js';
import { isBrowserDataSchemaStep, type BrowserDataSchemaStep } from './browser-data.js';
import { isBrowserExtractionTargets, type BrowserExtractionTargets } from './browser-extraction.js';
import { BROWSER_COMPLETED_DATA_CHARS, isBrowserCompletedData, type BrowserCompletedData } from './browser-retained-data.js';
import { isBrowserPostActionState, isBrowserConditionFailure, isBrowserReadinessFailure, isBrowserFailureObservation, type BrowserReadinessFailure, type BrowserConditionFailure, type BrowserFailureObservation, type BrowserPostActionState } from './browser-post-action.js';
import { isBrowserFieldEvidence, type BrowserFieldEvidence } from './browser-field-evidence.js';
import { BROWSER_COMPLETED_FILES_CHARS, isBrowserCompletedFile, type BrowserCompletedFile } from './browser-file-receipts.js';
export { isBrowserFieldEvidence } from './browser-field-evidence.js';
export type { BrowserEvidenceValue, BrowserEvidenceItem, BrowserFieldEvidence } from './browser-field-evidence.js';

interface ChangedLine { line?: number; text: string; truncated?: true }
export interface BrowserPageObservation {
  state: 'changed' | 'unchanged' | 'snapshot' | 'unavailable';
  comparison?: 'outline'; page?: string; requested_page?: string; url?: string; title?: string;
  loading?: boolean; source_truncated?: boolean; reason?: 'read_failed' | 'missing_html';
  changes?: { added: ChangedLine[]; removed: ChangedLine[]; added_total: number; removed_total: number; complete: boolean; next_line?: number };
  range?: { from: number; to: number; total: number; next?: number };
  field_evidence?: BrowserFieldEvidence; control_evidence?: BrowserControlEvidence; truncated?: true; omitted?: string[];
  extraction_targets?: BrowserExtractionTargets;
}
export const BROWSER_PAGE_OBSERVATION_CHARS = 4_000;
export const BROWSER_COMPLETED_READS_CHARS = 5_000;
export const BROWSER_FAILURE_DETAILS_CHARS = 12_000;
export interface BrowserCompletedRead {
  step: number;
  observation: BrowserPageObservation;
  form: 'outline' | 'text' | 'lines';
  content: string;
  truncated?: true;
}
/** Acknowledged commands may still have failed their subsequent checks.
 * Attempted commands without acknowledgements must be inspected before replay.
 * Only step numbers and counts cross this seam, never typed values or secrets. */
export interface BrowserBatchProgress {
  total_steps: number;
  failed_step: number;
  completed_steps: number[];
  effects: Array<{ step: number; attempted: number; acknowledged: number }>;
  page_state?: 'ready' | 'loading' | 'closed' | 'unknown';
  current_page?: string;
  /** Legacy read advice, accepted for stored receipts. New outcomes do not emit it. */
  next_step?: { do: 'read'; page: string; form: 'outline' };
  /** Legacy advice, accepted for stored receipts and omitted from agent projections. */
  recovery?: 'inspect_before_repeating_actions';
}
export interface BrowserFailureDetails {
  executed?: false;
  violations?: readonly BrowserCollectViolation[];
  violations_truncated?: true;
  page_observation?: BrowserPageObservation;
  batch_progress?: BrowserBatchProgress;
  post_action?: BrowserPostActionState;
  check_failure?: BrowserConditionFailure;
  ready_failure?: BrowserReadinessFailure;
  failure_observation?: BrowserFailureObservation;
  binding_mismatch?: BrowserDocumentBindingMismatch;
  navigation_boundary?: BrowserFormNavigationBoundary;
  completed_reads?: BrowserCompletedRead[];
  completed_reads_truncated?: true;
  completed_data?: BrowserCompletedData[];
  completed_data_truncated?: true;
  completed_files?: BrowserCompletedFile[];
  completed_files_truncated?: true;
  control_correction?: BrowserControlCorrection;
  control_blocked?: BrowserControlBlocked;
  control_lookup?: BrowserControlLookup;
  click_obstruction?: BrowserClickObstruction;
  data_failure?: BrowserDataFailure;
  data_schema_step?: BrowserDataSchemaStep;
}
export interface BrowserDocumentBindingMismatch {
  kind: 'document_binding_mismatch';
  source: 'host_navigation_lineage';
  executed: false;
  requested_page: string;
  page: string;
  url: string;
  refs_scope: 'document';
  ref_step: number;
}
export interface BrowserFormNavigationBoundary {
  kind: 'unobserved_form_document';
  source: 'host_navigation';
  before_page: string;
  page: string;
  after_step: number;
  pending_step: number;
}
/** Evidence about one refused click, not a claim that its batch had no effects.
 * Labels are observed page text, not an inferred advertisement classification. */
export interface BrowserClickObstruction {
  operation: 'click';
  executed: false;
  reason: 'target_occluded';
  source: 'hit_test';
  target: { tag: string; ref?: string };
  blocker: { tag: string; ref?: string; label?: string; label_truncated?: true; role?: string };
  waited_ms: number;
}
export interface BrowserClickRefusal { message: string; obstruction: BrowserClickObstruction }
export interface BrowserControlLookup {
  source: 'page_read';
  /** Eligible controls in the current interaction, excluding blocked background controls. */
  scope: 'interaction';
  page: string;
  url?: string;
  complete: boolean;
  total: number;
  controls: Array<{ ref: string; kind: string; name: string }>;
}
export interface BrowserControlCorrection {
  ref: string;
  kind: string;
  name?: string;
  requested_action: 'type';
  supported_actions: ['click'];
  source: 'fresh_kept_read';
}
/** 2026-11-21 — the element text was refused for sits behind the dialog open on the page, as the host's own fresh,
 *  whole read after the refusal shows it: the Bridge types into nothing outside an open dialog, so nothing was typed.
 *  Evidence about one refused step, not about the batch. */
export interface BrowserControlBlocked {
  ref: string;
  kind: string;
  name?: string;
  requested_action: 'type';
  blocked_by: 'dialog';
  source: 'fresh_kept_read';
}
export interface BrowserFailure { slug: string; details: BrowserFailureDetails }

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T => typeof value === 'string' && allowed.some(item => item === value);
const strings = (value: unknown, max: number, allowed: readonly string[]) => Array.isArray(value) && value.length <= max && value.every(item => oneOf(item, allowed));
const flag = (value: unknown) => value === true;
const bool = (value: unknown) => typeof value === 'boolean';
export const isBrowserDocumentBindingMismatch = (v: unknown): v is BrowserDocumentBindingMismatch => record(v)
  && keys(v, ['kind', 'source', 'executed', 'requested_page', 'page', 'url', 'refs_scope', 'ref_step'])
  && v.kind === 'document_binding_mismatch' && v.source === 'host_navigation_lineage' && v.executed === false
  && text(v.requested_page, 2_048) && /^https?:\/\//i.test(v.requested_page)
  && text(v.page, 512) && v.page.length > 0 && !/^https?:/i.test(v.page)
  && text(v.url, 2_048) && /^https?:\/\//i.test(v.url) && v.refs_scope === 'document'
  && count(v.ref_step) && v.ref_step >= 1 && v.ref_step <= 20;
export const isBrowserFormNavigationBoundary = (v: unknown): v is BrowserFormNavigationBoundary => record(v)
  && keys(v, ['kind', 'source', 'before_page', 'page', 'after_step', 'pending_step'])
  && v.kind === 'unobserved_form_document' && v.source === 'host_navigation'
  && text(v.before_page, 512) && v.before_page.length > 0 && !/^https?:/i.test(v.before_page)
  && text(v.page, 512) && v.page.length > 0 && !/^https?:/i.test(v.page) && v.before_page !== v.page
  && count(v.after_step) && v.after_step >= 1 && count(v.pending_step) && v.pending_step > v.after_step && v.pending_step <= 20;
const obstructionElement = (value: unknown, blocker = false): boolean => record(value)
  && keys(value, blocker ? ['tag', 'ref', 'label', 'label_truncated', 'role'] : ['tag', 'ref'])
  && text(value.tag, 64) && /^[a-z][a-z0-9._:-]*$/.test(value.tag)
  && optional(value.ref, ref => typeof ref === 'string' && /^e[1-9]\d{0,8}$/.test(ref))
  && optional(value.label, label => text(label, 80) && label.trim().length > 0)
  && optional(value.label_truncated, flag) && (value.label_truncated !== true || text(value.label, 80) && value.label.length === 80)
  && optional(value.role, role => text(role, 48) && role.trim().length > 0);
export const isBrowserClickObstruction = (value: unknown): value is BrowserClickObstruction => record(value)
  && keys(value, ['operation', 'executed', 'reason', 'source', 'target', 'blocker', 'waited_ms'])
  && value.operation === 'click' && value.executed === false && value.reason === 'target_occluded' && value.source === 'hit_test'
  && obstructionElement(value.target) && obstructionElement(value.blocker, true) && count(value.waited_ms);
export const isBrowserClickRefusal = (value: unknown): value is BrowserClickRefusal => record(value)
  && keys(value, ['message', 'obstruction']) && text(value.message, 512) && value.message.trim().length > 0
  && isBrowserClickObstruction(value.obstruction);
export const isBrowserControlLookup = (value: unknown): value is BrowserControlLookup => record(value)
  && keys(value, ['source', 'scope', 'page', 'url', 'complete', 'total', 'controls']) && value.source === 'page_read' && value.scope === 'interaction'
  && text(value.page, 512) && value.page.length > 0 && optional(value.url, url => text(url, 2_048))
  && bool(value.complete) && count(value.total) && Array.isArray(value.controls) && value.controls.length <= 6
  && value.controls.every(control => record(control) && keys(control, ['ref', 'kind', 'name'])
    && text(control.ref, 32) && /^e\d+$/.test(control.ref) && text(control.kind, 48) && text(control.name, 160))
  && value.total >= value.controls.length && (!value.complete || value.total === value.controls.length);
export const isBrowserControlCorrection = (value: unknown): value is BrowserControlCorrection => record(value)
  && keys(value, ['ref', 'kind', 'name', 'requested_action', 'supported_actions', 'source'])
  && text(value.ref, 32) && /^e\d+$/.test(value.ref) && text(value.kind, 48) && optional(value.name, name => text(name, 160))
  && value.requested_action === 'type' && value.source === 'fresh_kept_read'
  && Array.isArray(value.supported_actions) && value.supported_actions.length === 1 && value.supported_actions[0] === 'click';
export const isBrowserControlBlocked = (value: unknown): value is BrowserControlBlocked => record(value)
  && keys(value, ['ref', 'kind', 'name', 'requested_action', 'blocked_by', 'source'])
  && text(value.ref, 32) && /^e\d+$/.test(value.ref) && text(value.kind, 48) && optional(value.name, name => text(name, 160))
  && value.requested_action === 'type' && value.blocked_by === 'dialog' && value.source === 'fresh_kept_read';

const progress = (value: unknown): value is BrowserBatchProgress => {
  if (!record(value) || !keys(value, ['total_steps', 'failed_step', 'completed_steps', 'effects', 'page_state', 'current_page', 'next_step', 'recovery'])
    || !count(value.total_steps) || value.total_steps < 1 || value.total_steps > 20
    || !count(value.failed_step) || value.failed_step < 1 || value.failed_step > value.total_steps
    || !optional(value.recovery, value => value === 'inspect_before_repeating_actions')
    || !optional(value.page_state, value => oneOf(value, ['ready', 'loading', 'closed', 'unknown']))
    || !optional(value.current_page, value => text(value, 512) && value.length > 0)
    || value.current_page !== undefined && !oneOf(value.page_state, ['ready', 'loading', 'unknown'])) return false;
  const failed = value.failed_step, total = value.total_steps;
  if (value.next_step !== undefined && (!record(value.next_step) || !keys(value.next_step, ['do', 'page', 'form'])
    || value.next_step.do !== 'read' || value.next_step.form !== 'outline' || value.page_state !== 'ready'
    || typeof value.current_page !== 'string' || value.next_step.page !== value.current_page
    || !Array.isArray(value.effects) || value.effects.some(effect => !record(effect) || effect.attempted !== effect.acknowledged))) return false;
  return Array.isArray(value.completed_steps) && value.completed_steps.length < value.total_steps
    && value.completed_steps.every((step, i, all) => count(step) && step > 0 && step < failed && (i === 0 || step > all[i - 1]))
    && Array.isArray(value.effects) && value.effects.length <= value.total_steps
    && value.effects.every((effect, i, all) => record(effect) && keys(effect, ['step', 'attempted', 'acknowledged'])
      && count(effect.step) && effect.step > 0 && effect.step <= total && (i === 0 || effect.step > all[i - 1].step)
      && count(effect.attempted) && effect.attempted > 0 && effect.attempted <= 64
      && count(effect.acknowledged) && effect.acknowledged <= effect.attempted);
};

const lines = (value: unknown): boolean => Array.isArray(value) && value.length <= 16 && value.every(line => record(line)
  && keys(line, ['line', 'text', 'truncated']) && optional(line.line, count) && text(line.text, 200) && optional(line.truncated, flag));

/** Only the bounded shape produced by an ordinary browser read may cross the
 * error seam. Unknown fields are refused rather than spreading adapter details. */
export const isBrowserPageObservation = (value: unknown): value is BrowserPageObservation => {
  if (!record(value) || !keys(value, ['state', 'comparison', 'page', 'requested_page', 'url', 'title', 'loading', 'source_truncated',
    'reason', 'changes', 'range', 'field_evidence', 'control_evidence', 'extraction_targets', 'truncated', 'omitted'])) return false;
  if (!oneOf(value.state, ['changed', 'unchanged', 'snapshot', 'unavailable'])
    || !optional(value.page, value => text(value, 512)) || !optional(value.requested_page, value => text(value, 512))
    || !optional(value.url, value => text(value, 2_048)) || !optional(value.title, value => text(value, 200))
    || !optional(value.loading, bool) || !optional(value.source_truncated, bool) || !optional(value.truncated, flag)
    || !optional(value.omitted, value => strings(value, 8, ['page', 'url', 'title', 'title_suffix', 'range', 'field_evidence', 'control_evidence', 'extraction_targets', 'changes']))) return false;
  if (value.state === 'unavailable') {
    if (!oneOf(value.reason, ['read_failed', 'missing_html']) || !keys(value, ['state', 'requested_page', 'reason'])) return false;
  } else if (!bool(value.loading) || !bool(value.source_truncated) || value.reason !== undefined || value.requested_page !== undefined
    || (value.state === 'snapshot' ? value.comparison !== undefined : value.comparison !== 'outline')) return false;
  if (!optional(value.field_evidence, isBrowserFieldEvidence) || value.loading === true && value.field_evidence !== undefined) return false;
  if (!optional(value.control_evidence, isBrowserControlEvidence) || value.loading === true && value.control_evidence !== undefined) return false;
  if (value.extraction_targets !== undefined) {
    if (!isBrowserExtractionTargets(value.extraction_targets)) return false;
    if ((value.loading === true || value.source_truncated === true)
      && (value.extraction_targets.source_complete || value.extraction_targets.tables_complete)) return false;
  }
  if (!optional(value.changes, delta => record(delta) && keys(delta, ['added', 'removed', 'added_total', 'removed_total', 'complete', 'next_line'])
    && lines(delta.added) && lines(delta.removed) && count(delta.added_total) && count(delta.removed_total)
    && bool(delta.complete) && optional(delta.next_line, count))) return false;
  if (!optional(value.range, range => record(range) && keys(range, ['from', 'to', 'total', 'next'])
    && count(range.from) && count(range.to) && count(range.total) && optional(range.next, count))) return false;
  return JSON.stringify(value).length <= BROWSER_PAGE_OBSERVATION_CHARS;
};

const violations = (value: unknown): value is readonly BrowserCollectViolation[] => Array.isArray(value)
  && value.length > 0 && value.length <= BROWSER_COLLECT_MAX_VIOLATIONS && value.every(item => record(item)
    && keys(item, ['path', 'code', 'message', 'expected_type', 'min', 'max', 'received'])
    && text(item.path, 128) && /^steps\[\d+\]\.[A-Za-z_][A-Za-z0-9_.]*$/.test(item.path)
    && oneOf(item.code, ['invalid_value', 'required', 'invalid_type', 'out_of_range']) && text(item.message, 256)
    && optional(item.expected_type, value => value === 'integer') && optional(item.min, count) && optional(item.max, count)
    && optional(item.received, value => typeof value === 'number' && Number.isFinite(value)));

const readReceipts = (value: unknown, completed: readonly number[]): value is BrowserCompletedRead[] => Array.isArray(value)
  && value.length <= 8 && value.every((read, i, all) => record(read) && keys(read, ['step', 'observation', 'form', 'content', 'truncated'])
    && count(read.step) && completed.includes(read.step) && (i === 0 || read.step > all[i - 1].step)
    && isBrowserPageObservation(read.observation) && read.observation.state === 'snapshot' && typeof read.observation.page === 'string'
    && oneOf(read.form, ['outline', 'text', 'lines']) && text(read.content, 3_000) && optional(read.truncated, flag))
  && JSON.stringify(value).length <= BROWSER_COMPLETED_READS_CHARS;

const dataReceipts = (value: unknown, completed: readonly number[]): value is BrowserCompletedData[] => Array.isArray(value)
  && value.length <= 8 && value.every((item, index, all) => isBrowserCompletedData(item) && completed.includes(item.step)
    && (index === 0 || item.step >= all[index - 1].step)
    && all.findIndex(other => other.step === item.step && other.data_ref === item.data_ref) === index)
  && JSON.stringify(value).length <= BROWSER_COMPLETED_DATA_CHARS;

/** Explicit carrier, like cli_failure: the engine never forwards arbitrary
 * IngredientError.details. This decoder performs no browser I/O or model call. */
export const readBrowserFailure = (error: unknown): BrowserFailure | undefined => {
  if (!record(error) || !oneOf(error.code, ['DOM_SELECTOR_MISSING', 'DOM_SELECTOR_NOT_FOUND', 'DOM_WRITE_FAILED', 'DOM_PAGE_NOT_MATCHING', 'DOM_CHECK_FAILED',
    'ACTION_DELIVERY_UNCERTAIN', 'INGREDIENT_ADAPTER_ALL_FAILED', 'INGREDIENT_SCOPE_INSUFFICIENT', 'ROLE_RESTRICTION'])) return undefined;
  const value = error.browser_failure;
  if (!record(value) || !keys(value, ['slug', 'details']) || !oneOf(value.slug, ['dom-act', 'dom-write', 'dom-click', 'dom-wait', 'dom-scroll'])) return undefined;
  const details = value.details;
  if (!record(details) || !keys(details, ['executed', 'violations', 'violations_truncated', 'page_observation', 'batch_progress', 'post_action', 'check_failure', 'ready_failure', 'failure_observation', 'binding_mismatch', 'navigation_boundary', 'completed_reads', 'completed_reads_truncated', 'completed_data', 'completed_data_truncated', 'completed_files', 'completed_files_truncated', 'control_correction', 'control_blocked', 'control_lookup', 'click_obstruction', 'data_failure', 'data_schema_step'])
    || !optional(details.executed, value => value === false)
    || !optional(details.violations_truncated, flag) || !optional(details.violations, violations)
    || !optional(details.page_observation, isBrowserPageObservation) || !optional(details.batch_progress, progress)
    || !optional(details.post_action, isBrowserPostActionState)
    || !optional(details.check_failure, isBrowserConditionFailure) || !optional(details.ready_failure, isBrowserReadinessFailure) || !optional(details.failure_observation, isBrowserFailureObservation)
    || !optional(details.binding_mismatch, isBrowserDocumentBindingMismatch) || !optional(details.navigation_boundary, isBrowserFormNavigationBoundary)
    || !optional(details.completed_reads_truncated, flag) || !optional(details.completed_data_truncated, flag) || !optional(details.control_correction, isBrowserControlCorrection)
    || !optional(details.control_blocked, isBrowserControlBlocked)
    || !optional(details.control_lookup, isBrowserControlLookup) || !optional(details.click_obstruction, isBrowserClickObstruction)
    || !optional(details.data_failure, isBrowserDataFailure) || !optional(details.data_schema_step, isBrowserDataSchemaStep)) return undefined;
  if (details.check_failure !== undefined && (!isBrowserConditionFailure(details.check_failure) || value.slug !== 'dom-act'
    || error.code !== 'DOM_CHECK_FAILED' || !progress(details.batch_progress) || details.check_failure.step !== details.batch_progress.failed_step)) return undefined;
  if (details.ready_failure !== undefined && (!isBrowserReadinessFailure(details.ready_failure) || value.slug !== 'dom-act'
    || error.code !== 'DOM_CHECK_FAILED' || !progress(details.batch_progress) || details.ready_failure.step !== details.batch_progress.failed_step
    || details.check_failure !== undefined || details.binding_mismatch !== undefined || details.navigation_boundary !== undefined)) return undefined;
  if (details.failure_observation !== undefined && (!isBrowserFailureObservation(details.failure_observation) || value.slug !== 'dom-act'
    || !progress(details.batch_progress) || details.failure_observation.step !== details.batch_progress.failed_step
    || details.batch_progress.current_page !== details.failure_observation.current_page
    || !isBrowserConditionFailure(details.check_failure) && !isBrowserReadinessFailure(details.ready_failure) && !isBrowserDocumentBindingMismatch(details.binding_mismatch)
    || details.post_action !== undefined)) return undefined;
  if (details.binding_mismatch !== undefined && (!isBrowserDocumentBindingMismatch(details.binding_mismatch) || value.slug !== 'dom-act'
    || error.code !== 'DOM_SELECTOR_MISSING' || !progress(details.batch_progress) || details.batch_progress.current_page !== details.binding_mismatch.page
    || details.batch_progress.completed_steps.length !== 0 || details.batch_progress.effects.length !== 0
    || details.binding_mismatch.ref_step > details.batch_progress.total_steps || details.post_action !== undefined
    || details.navigation_boundary !== undefined || details.check_failure !== undefined)) return undefined;
  const boundary = details.navigation_boundary;
  if (boundary !== undefined && (!isBrowserFormNavigationBoundary(boundary) || value.slug !== 'dom-act'
    || error.code !== 'DOM_CHECK_FAILED' || !progress(details.batch_progress)
    || boundary.pending_step !== details.batch_progress.failed_step
    || boundary.page !== details.batch_progress.current_page
    || !details.batch_progress.completed_steps.includes(boundary.after_step)
    || !details.batch_progress.effects.some(effect => effect.step === boundary.after_step && effect.attempted > 0 && effect.attempted === effect.acknowledged)
    || details.check_failure !== undefined)) return undefined;
  if (details.data_schema_step !== undefined && (details.executed !== false || value.slug !== 'dom-act' || error.code !== 'DOM_SELECTOR_MISSING')) return undefined;
  if (details.data_failure !== undefined && (value.slug !== 'dom-act' || error.code !== 'DOM_CHECK_FAILED')) return undefined;
  if (details.post_action !== undefined && (!isBrowserPostActionState(details.post_action) || !progress(details.batch_progress) || value.slug !== 'dom-act'
    || details.post_action.after_step > details.batch_progress.failed_step)) return undefined;
  if (isBrowserPostActionState(details.post_action) && progress(details.batch_progress)) {
    const post = details.post_action;
    const effect = details.batch_progress.effects.find(effect => effect.step === post.after_step);
    if (!effect || post.action_status === 'acknowledged' && effect.attempted !== effect.acknowledged
      || post.action_status !== 'acknowledged' && effect.attempted === effect.acknowledged) return undefined;
  }
  if (record(details.batch_progress) && details.batch_progress.next_step !== undefined
    && ['ACTION_DELIVERY_UNCERTAIN', 'DOM_PAGE_NOT_MATCHING'].includes(String(error.code))) return undefined;
  if (details.click_obstruction !== undefined && (error.code !== 'DOM_WRITE_FAILED'
    || !oneOf(value.slug, ['dom-click', 'dom-act']))) return undefined;
  if (details.control_lookup !== undefined && error.code !== 'DOM_SELECTOR_NOT_FOUND') return undefined;
  if (details.control_correction !== undefined && error.code !== 'DOM_WRITE_FAILED') return undefined;
  if (details.completed_reads !== undefined) {
    if (!progress(details.batch_progress) || !readReceipts(details.completed_reads, details.batch_progress.completed_steps)) return undefined;
  } else if (details.completed_reads_truncated !== undefined) return undefined;
  if (details.completed_data !== undefined) {
    if (!progress(details.batch_progress) || !dataReceipts(details.completed_data, details.batch_progress.completed_steps)) return undefined;
  } else if (details.completed_data_truncated !== undefined) return undefined;
  if (details.completed_files !== undefined) {
    const files = details.completed_files, batch = details.batch_progress;
    if (!progress(batch) || !Array.isArray(files) || files.length > 8
      || !files.every(file => isBrowserCompletedFile(file) && file.step <= batch.failed_step)
      || JSON.stringify(files).length > BROWSER_COMPLETED_FILES_CHARS
      || !optional(details.completed_files_truncated, flag)) return undefined;
  } else if (details.completed_files_truncated !== undefined) return undefined;
  if ((details.completed_reads === undefined ? 0 : JSON.stringify(details.completed_reads).length)
    + (details.completed_data === undefined ? 0 : JSON.stringify(details.completed_data).length) > BROWSER_COMPLETED_READS_CHARS) return undefined;
  if (details.executed === false && (value.slug !== 'dom-act' || error.code !== 'DOM_SELECTOR_MISSING' || details.page_observation !== undefined)
    || details.violations !== undefined && details.executed !== false
    || details.violations_truncated !== undefined && details.violations === undefined
    || details.batch_progress !== undefined && (value.slug !== 'dom-act' || details.executed !== undefined)
    || details.executed === undefined && details.page_observation === undefined && details.batch_progress === undefined && details.control_correction === undefined
      && details.control_lookup === undefined && details.click_obstruction === undefined && details.data_failure === undefined) return undefined;
  if (JSON.stringify(details).length > BROWSER_FAILURE_DETAILS_CHARS) return undefined;
  return { slug: value.slug, details: {
    ...(details.executed === false ? { executed: false as const } : {}),
    ...(violations(details.violations) ? { violations: details.violations } : {}),
    ...(details.violations_truncated === true ? { violations_truncated: true as const } : {}),
    ...(isBrowserPageObservation(details.page_observation) ? { page_observation: details.page_observation } : {}),
    ...(progress(details.batch_progress) ? { batch_progress: details.batch_progress } : {}),
    ...(isBrowserPostActionState(details.post_action) ? { post_action: details.post_action } : {}),
    ...(isBrowserConditionFailure(details.check_failure) ? { check_failure: details.check_failure } : {}),
    ...(isBrowserReadinessFailure(details.ready_failure) ? { ready_failure: details.ready_failure } : {}),
    ...(isBrowserFailureObservation(details.failure_observation) ? { failure_observation: details.failure_observation } : {}),
    ...(isBrowserDocumentBindingMismatch(details.binding_mismatch) ? { binding_mismatch: details.binding_mismatch } : {}),
    ...(isBrowserFormNavigationBoundary(details.navigation_boundary) ? { navigation_boundary: details.navigation_boundary } : {}),
    ...(progress(details.batch_progress) && readReceipts(details.completed_reads, details.batch_progress.completed_steps) ? { completed_reads: details.completed_reads } : {}),
    ...(details.completed_reads_truncated === true ? { completed_reads_truncated: true as const } : {}),
    ...(progress(details.batch_progress) && dataReceipts(details.completed_data, details.batch_progress.completed_steps) ? { completed_data: details.completed_data } : {}),
    ...(details.completed_data_truncated === true ? { completed_data_truncated: true as const } : {}),
    ...(Array.isArray(details.completed_files) ? { completed_files: details.completed_files as BrowserCompletedFile[] } : {}),
    ...(details.completed_files_truncated === true ? { completed_files_truncated: true as const } : {}),
    ...(isBrowserControlCorrection(details.control_correction) ? { control_correction: details.control_correction } : {}),
    ...(isBrowserControlBlocked(details.control_blocked) ? { control_blocked: details.control_blocked } : {}),
    ...(isBrowserControlLookup(details.control_lookup) ? { control_lookup: details.control_lookup } : {}),
    ...(isBrowserClickObstruction(details.click_obstruction) ? { click_obstruction: details.click_obstruction } : {}),
    ...(isBrowserDataFailure(details.data_failure) ? { data_failure: details.data_failure } : {}),
    ...(isBrowserDataSchemaStep(details.data_schema_step) ? { data_schema_step: details.data_schema_step } : {}),
  } };
};
