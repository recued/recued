import { isBrowserReadState, type BrowserReadState } from './browser-read-state.js';
import { isBrowserControlEvidence, type BrowserControlEvidence } from './browser-controls.js';
import { isBrowserFieldEvidence, type BrowserFieldEvidence } from './browser-field-evidence.js';
import { isBrowserExtractionTargets, type BrowserExtractionTargets } from './browser-extraction.js';
import { isBrowserInteractionTargets, type BrowserInteractionTargets } from './browser-interactions.js';

export interface BrowserCurrentView {
  page: string; url?: string; title?: string; outline: string; read_state: BrowserReadState;
  control_evidence?: BrowserControlEvidence; field_evidence?: BrowserFieldEvidence; extraction_targets?: BrowserExtractionTargets;
  interaction_targets?: BrowserInteractionTargets;
  omitted?: Array<'control_evidence' | 'field_evidence' | 'extraction_targets' | 'interaction_targets'>;
}
export interface BrowserConditionMatchCounts {
  matched: number;
  visible: number;
  text_matched: number;
}
export const isBrowserConditionMatchCounts = (value: unknown): value is BrowserConditionMatchCounts => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const counts = value as Record<string, unknown>;
  return Object.keys(counts).length === 3 && ['matched', 'visible', 'text_matched'].every(key => Object.hasOwn(counts, key) && Number.isSafeInteger(counts[key]) && Number(counts[key]) >= 0)
    && Number(counts.text_matched) <= Number(counts.visible) && Number(counts.visible) <= Number(counts.matched);
};
export const browserConditionMatchState = (counts: BrowserConditionMatchCounts): 'absent' | 'hidden' | 'text_mismatch' | 'present' =>
  counts.matched === 0 ? 'absent' : counts.visible === 0 ? 'hidden' : counts.text_matched === 0 ? 'text_mismatch' : 'present';
export interface BrowserConditionFailure {
  step: number;
  status: 'failed';
  kind: 'condition_not_met';
  selector: string;
  selector_truncated?: true;
  until: 'shown' | 'gone';
  text?: string;
  text_truncated?: true;
  timeout_ms: number;
  waited_ms?: number;
  /** Legacy Bridges report only found:false, not DOM match/visibility counts. */
  match_state: 'unknown' | ReturnType<typeof browserConditionMatchState>;
  match_counts?: BrowserConditionMatchCounts;
}
export interface BrowserReadinessFailure {
  step: number;
  status: 'failed';
  kind: 'readiness_not_established';
  timeout_ms: number;
}
export interface BrowserFailureObservation {
  step: number;
  diagnostic_only: true;
  current_page: string;
  view_status: 'fresh' | 'unavailable';
  view?: BrowserCurrentView;
  reason?: 'read_failed' | 'not_fresh' | 'cancelled';
}

/** A passive observation after an action, independent of whether a later check
 * passed or the application accepted the requested operation. No replay token. */
export interface BrowserActionTarget {
  source: 'kept_read';
  ref: string;
  tag: string;
  type?: string;
  label?: string;
  /** Origin/path only; no credentials, query or fragment. */
  href?: string;
}
export const isBrowserActionTarget = (value: unknown): value is BrowserActionTarget => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(key => ['source', 'ref', 'tag', 'type', 'label', 'href'].includes(key))
    && v.source === 'kept_read' && typeof v.ref === 'string' && /^e[1-9]\d{0,8}$/.test(v.ref)
    && typeof v.tag === 'string' && /^[a-z][a-z0-9:-]{0,47}$/.test(v.tag)
    && (v.type === undefined || typeof v.type === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(v.type))
    && (v.label === undefined || typeof v.label === 'string' && v.label.length <= 160)
    && (v.href === undefined || typeof v.href === 'string' && v.href.length <= 512 && (() => {
      try { const url = new URL(v.href as string); return ['http:', 'https:'].includes(url.protocol)
        && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
    })());
};
export interface BrowserPostActionState {
  target?: BrowserActionTarget;
  after_step: number;
  action_status: 'acknowledged' | 'refused' | 'uncertain';
  /** Actual latest predicate outcome; unknown when its result was not observed.
   * A subsequent read/data failure does not change an earlier passed check. */
  check_status: 'passed' | 'failed' | 'unknown' | 'not_requested';
  application_outcome: 'unverified';
  before_page: string;
  current_page?: string;
  transition: 'same_document' | 'new_document' | 'unknown';
  view_status: 'fresh' | 'unavailable';
  view?: BrowserCurrentView;
  reason?: 'delivery_uncertain' | 'page_loading' | 'page_closed' | 'read_failed' | 'not_fresh' | 'cancelled';
}
export const BROWSER_POST_ACTION_CHARS = 5_000;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(k => allowed.includes(k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const step = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 1 && Number(v) <= 20;
export const isBrowserCurrentView = (v: unknown): v is BrowserCurrentView => object(v)
  && keys(v, ['page', 'url', 'title', 'outline', 'read_state', 'control_evidence', 'field_evidence', 'extraction_targets', 'interaction_targets', 'omitted']) && text(v.page, 512) && !/^https?:/i.test(v.page)
  && (v.url === undefined || text(v.url, 2_048)) && (v.title === undefined || typeof v.title === 'string' && v.title.length <= 200)
  && typeof v.outline === 'string' && v.outline.length <= 3_000 && isBrowserReadState(v.read_state)
  && v.read_state.source === 'bridge_read' && v.read_state.scope.form === 'outline'
  && (v.control_evidence === undefined || isBrowserControlEvidence(v.control_evidence))
  && (v.field_evidence === undefined || v.read_state.loading !== true && isBrowserFieldEvidence(v.field_evidence))
  && (v.extraction_targets === undefined || isBrowserExtractionTargets(v.extraction_targets)
    && (v.read_state.loading !== true || v.extraction_targets.source_complete === false))
  && (v.interaction_targets === undefined || isBrowserInteractionTargets(v.interaction_targets)
    && (v.read_state.loading !== true || v.interaction_targets.source_complete === false))
  && (v.omitted === undefined || Array.isArray(v.omitted) && v.omitted.length > 0 && v.omitted.length <= 4
    && v.omitted.every((key, index, all) => typeof key === 'string' && ['control_evidence', 'field_evidence', 'extraction_targets', 'interaction_targets'].includes(key)
      && all.indexOf(key) === index && v[key] === undefined));
export const isBrowserConditionFailure = (v: unknown): v is BrowserConditionFailure => object(v)
  && keys(v, ['step', 'status', 'kind', 'selector', 'selector_truncated', 'until', 'text', 'text_truncated', 'timeout_ms', 'waited_ms', 'match_state', 'match_counts'])
  && step(v.step) && v.status === 'failed' && v.kind === 'condition_not_met' && text(v.selector, 1_000)
  && (v.selector_truncated === undefined || v.selector_truncated === true && typeof v.selector === 'string' && v.selector.length === 1_000)
  && ['shown', 'gone'].includes(String(v.until)) && (v.text === undefined || text(v.text, 256))
  && (v.text_truncated === undefined || v.text_truncated === true && typeof v.text === 'string' && v.text.length === 256)
  && typeof v.timeout_ms === 'number' && Number.isFinite(v.timeout_ms) && v.timeout_ms > 0 && Number(v.timeout_ms) <= 10_000
  && (v.waited_ms === undefined || Number.isSafeInteger(v.waited_ms) && Number(v.waited_ms) >= 0 && Number(v.waited_ms) <= 120_000)
  && (v.match_counts === undefined ? v.match_state === 'unknown'
    : isBrowserConditionMatchCounts(v.match_counts) && v.match_state === browserConditionMatchState(v.match_counts)
      && (v.until === 'shown' ? v.match_counts.text_matched === 0 : v.match_counts.text_matched > 0));
export const isBrowserReadinessFailure = (v: unknown): v is BrowserReadinessFailure => object(v)
  && keys(v, ['step', 'status', 'kind', 'timeout_ms']) && step(v.step) && v.status === 'failed' && v.kind === 'readiness_not_established'
  && typeof v.timeout_ms === 'number' && Number.isFinite(v.timeout_ms) && v.timeout_ms > 0 && v.timeout_ms <= 10_000;
export const isBrowserFailureObservation = (v: unknown): v is BrowserFailureObservation => object(v)
  && keys(v, ['step', 'diagnostic_only', 'current_page', 'view_status', 'view', 'reason'])
  && step(v.step) && v.diagnostic_only === true && text(v.current_page, 512) && !/^https?:/i.test(v.current_page)
  && (v.view_status === 'fresh' ? v.reason === undefined && isBrowserCurrentView(v.view) && v.view.page === v.current_page
    : v.view_status === 'unavailable' && v.view === undefined && ['read_failed', 'not_fresh', 'cancelled'].includes(String(v.reason)))
  && JSON.stringify(v).length <= BROWSER_POST_ACTION_CHARS;
export const isBrowserPostActionState = (v: unknown): v is BrowserPostActionState => {
  if (!object(v) || !keys(v, ['target', 'after_step', 'action_status', 'check_status', 'application_outcome', 'before_page', 'current_page', 'transition', 'view_status', 'view', 'reason'])
    || v.target !== undefined && !isBrowserActionTarget(v.target)
    || !Number.isSafeInteger(v.after_step) || Number(v.after_step) < 1 || Number(v.after_step) > 20
    || !['acknowledged', 'refused', 'uncertain'].includes(String(v.action_status))
    || !['passed', 'failed', 'unknown', 'not_requested'].includes(String(v.check_status)) || v.application_outcome !== 'unverified'
    || !text(v.before_page, 512) || /^https?:/i.test(v.before_page)
    || v.current_page !== undefined && (!text(v.current_page, 512) || /^https?:/i.test(v.current_page))
    || !['same_document', 'new_document', 'unknown'].includes(String(v.transition))) return false;
  if (v.view_status === 'unavailable') return v.view === undefined
    && ['delivery_uncertain', 'page_loading', 'page_closed', 'read_failed', 'not_fresh', 'cancelled'].includes(String(v.reason))
    && JSON.stringify(v).length <= BROWSER_POST_ACTION_CHARS;
  const view = v.view;
  return v.view_status === 'fresh' && v.reason === undefined && v.action_status !== 'uncertain'
    && isBrowserCurrentView(view) && view.page === v.current_page
    && (v.transition === 'same_document' ? view.page === v.before_page : v.transition === 'new_document' && view.page !== v.before_page)
    && JSON.stringify(v).length <= BROWSER_POST_ACTION_CHARS;
};
