import { BROWSER_POST_ACTION_CHARS, isBrowserControlEvidence, isBrowserFieldEvidence, isBrowserExtractionTargets, isBrowserInteractionTargets, isBrowserPostActionState, isBrowserFailureObservation, isBrowserReadState,
  type BrowserPostActionState, type BrowserFailureObservation, type BrowserCurrentView } from '@recued/contracts';

/** Exact fresh view only. Coverage is reduced whenever display text is trimmed. */
const currentView = (read: Record<string, unknown>, page: string | undefined): BrowserCurrentView | undefined => {
  if (read.page !== page || typeof page !== 'string' || typeof read.outline !== 'string' || !isBrowserReadState(read.read_state)
    || read.read_state.source !== 'bridge_read' || read.read_state.scope.form !== 'outline') return;
  const outline = read.outline.slice(0, 3_000);
  return { page, outline, read_state: { ...read.read_state, ...(outline.length < read.outline.length ? { truncated: true, complete: false } : {}) },
    ...(typeof read.url === 'string' && read.url.length <= 2_048 ? { url: read.url } : {}),
    ...(typeof read.title === 'string' ? { title: read.title.slice(0, 200) } : {}),
    ...(isBrowserControlEvidence(read.control_evidence) ? { control_evidence: read.control_evidence } : {}),
    ...(read.read_state.loading !== true && isBrowserFieldEvidence(read.field_evidence) ? { field_evidence: read.field_evidence } : {}),
    ...(isBrowserExtractionTargets(read.extraction_targets) && (read.read_state.loading !== true || read.extraction_targets.source_complete === false)
      ? { extraction_targets: read.extraction_targets } : {}),
    ...(isBrowserInteractionTargets(read.interaction_targets) && (read.read_state.loading !== true || read.interaction_targets.source_complete === false)
      ? { interaction_targets: read.interaction_targets } : {}) };
};
type EvidenceKey = 'control_evidence' | 'field_evidence' | 'extraction_targets' | 'interaction_targets';
export const omitBrowserViewEvidence = (view: BrowserCurrentView, key: EvidenceKey): void => {
  if (view[key] === undefined) return;
  delete view[key];
  view.omitted = [...new Set([...(view.omitted ?? []), key])];
};
const boundView = <T extends { view?: BrowserCurrentView }>(out: T): T => {
  const view = out.view;
  if (!view) return out;
  const fields = view.field_evidence, targets = view.extraction_targets, interactions = view.interaction_targets;
  // Preserve the existing outline/control budget before adding optional facts.
  // An omitted literal is never shortened or presented as an absent value.
  omitBrowserViewEvidence(view, 'field_evidence');
  omitBrowserViewEvidence(view, 'extraction_targets');
  omitBrowserViewEvidence(view, 'interaction_targets');
  if (JSON.stringify(out).length > BROWSER_POST_ACTION_CHARS) omitBrowserViewEvidence(view, 'control_evidence');
  while (JSON.stringify(out).length > BROWSER_POST_ACTION_CHARS && view.outline.length) {
    view.outline = view.outline.slice(0, Math.max(0, view.outline.length - 256));
    view.read_state = { ...view.read_state, truncated: true, complete: false };
  }
  const add = (key: EvidenceKey, attach: () => void) => {
    attach();
    const remaining = view.omitted?.filter(value => value !== key);
    if (remaining?.length) view.omitted = remaining; else delete view.omitted;
    if (JSON.stringify(out).length > BROWSER_POST_ACTION_CHARS) omitBrowserViewEvidence(view, key);
  };
  if (targets) add('extraction_targets', () => { view.extraction_targets = targets; });
  if (fields) add('field_evidence', () => { view.field_evidence = fields; });
  if (interactions) add('interaction_targets', () => { view.interaction_targets = interactions; });
  return out;
};

/** Not a completed planned read or a claim of application success. */
export const browserPostActionState = (state: Omit<BrowserPostActionState, 'view' | 'view_status' | 'reason'>,
  read?: Record<string, unknown>, reason: BrowserPostActionState['reason'] = 'read_failed'): BrowserPostActionState => {
  const unavailable: BrowserPostActionState = { ...state, view_status: 'unavailable', reason };
  if (!read) return unavailable;
  const view = currentView(read, state.current_page);
  if (!view) return { ...unavailable, reason: 'not_fresh' };
  const out = boundView<BrowserPostActionState>({ ...state, view_status: 'fresh', view });
  return isBrowserPostActionState(out) ? out : { ...unavailable, reason: 'not_fresh' };
};

/** A passive read after a failed condition with no preceding action. */
export const browserFailureObservation = (step: number, page: string, read?: Record<string, unknown>,
  reason: BrowserFailureObservation['reason'] = 'read_failed'): BrowserFailureObservation => {
  const unavailable: BrowserFailureObservation = { step, current_page: page, diagnostic_only: true, view_status: 'unavailable', reason };
  if (!read) return unavailable;
  const view = currentView(read, page);
  if (!view) return { ...unavailable, reason: 'not_fresh' };
  const out = boundView<BrowserFailureObservation>({ step, current_page: page, diagnostic_only: true, view_status: 'fresh', view });
  return isBrowserFailureObservation(out) ? out : { ...unavailable, reason: 'not_fresh' };
};
