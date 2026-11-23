import { mountTimezonePicker, TIMEZONE_PICKER_STYLES, type TimezonePicker } from '../timezone-picker.js';
import type { ChatTurnAcceptance, PromptSchedule, PromptScheduleInput, PromptScheduleRunOutcome,
  PromptScheduleRunRequest, PromptScheduleTarget, PromptScheduleUpdate, PromptScheduleTiming, PromptSchedulePreview } from '@recued/contracts';
import { isChatModelSourceId, zonedWallClockToEpochMs, type ChatModelSourceId } from '@recued/contracts';
import { stampZone, renderActionLabel, type IconName } from '@recued/ui-shared';
import { reminderWallClockValue } from '../data/reminders-surface.js';
import { renderSearchHighlights } from '../data/search-excerpt.js';
import { promptSearchTimingText } from './prompt-search-timing.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { serializeChatAnswerAddress, serializeChatPlanAddress, serializeChatSessionAddress } from '../shell/route.js';
import { mountPromptSchedulePreview } from './prompt-schedule-preview.js';
import { describePromptCron, PROMPT_WEEKDAY_NAMES, readPromptRepeat } from './prompt-repeat.js';
import type { AutomationChip } from './by-recipe.js';
import { createPromptDraftCheckpoint, promptDraftRequest, promptDraftTiming, promptDraftUpdate, promptEditOriginal, type PromptEditOriginal, type PromptCreationRequest,
  type PromptDraftEntry, type PromptDraftValues, type PromptRecoveryStore } from './prompt-draft-recovery.js';
import { promptRecoveryView } from './prompt-recovery-view.js';
import { checkPromptEdit, comparePromptEdits, mergePromptEdits, type PromptEditComparison } from './prompt-edit-recovery.js';
import { promptEditComparisonView } from './prompt-edit-comparison-view.js';
import { createPromptSkipControls, type PromptSkipClient } from './prompt-skip-controls.js';
import { createPromptBulkControls, type PromptBulkClient } from './prompt-bulk-controls.js';
import { createPromptPauseControls, type PromptPauseClient } from './prompt-pause-controls.js';
import { createPromptRunsView, type PromptRunsClient } from './prompt-runs-view.js';
import { promptMatchesQuery, promptScheduleChip, promptScheduleHref, promptScheduleIdentity, readPromptSchedules, type PromptSelection } from './prompt-search.js';
export { promptScheduleChip } from './prompt-search.js';
import { createTriggerPreapprovalSupport, mountTriggerPreapprovalPanel, type TriggerPreapprovalPanelCallers,
  type TriggerPreapprovalPanelMount, type TriggerPreapprovalSupport } from '../contracts/trigger-preapproval-panel.js';

/** D-344 slice D — a schedule's model, named as Settings → AI / Models names the sources. */
const SCHEDULE_MODEL_LABELS: Record<ChatModelSourceId, string> = {
  slot_1: 'Slot 1: fast',
  slot_2: 'Slot 2: better, slower thinking',
  free_pool: 'Free pool',
};
const SCHEDULE_MODEL_CHOICES: ReadonlyArray<readonly [string, string]> = [
  ['', 'Chat default'], ['slot_1', SCHEDULE_MODEL_LABELS.slot_1], ['slot_2', SCHEDULE_MODEL_LABELS.slot_2],
  ['free_pool', SCHEDULE_MODEL_LABELS.free_pool],
];

export interface PromptSchedulesPanelState {
  readonly rows: readonly PromptSchedule[];
  readonly loaded: boolean;
  readonly error: string;
}

const outcomeLabels: Record<PromptScheduleRunOutcome['status'], string> = {
  queued: 'Queued', running: 'Running', cancelling: 'Stopping', finished: 'Finished',
  needs_approval: 'Needs approval', failed: 'Failed', interrupted: 'Interrupted',
  cancelled: 'Cancelled', withdrawn: 'Withdrawn', needs_attention: 'Needs attention',
};
const outcomeReasons: Record<NonNullable<PromptScheduleRunOutcome['reason']>, string> = {
  turn_failed: 'The request could not finish. Open the conversation for details.',
  tool_failed: 'An action or lookup reported an error. Review the response before trying again.',
  outcome_unknown: 'The run was interrupted. Check what completed before running it again.',
  action_held: 'An action is waiting. Open the conversation for details.',
  awaiting_execution: 'An approved action has not run yet. Open the conversation for details.',
  approval_expired: 'An approval expired before the action ran.',
  approval_declined: 'An action was declined and did not run.',
};

export interface PromptScheduleClient extends PromptSkipClient, PromptRunsClient, PromptPauseClient, PromptBulkClient {
  (method: 'chat.schedules.list', args: { session_id?: string }): Promise<PromptSchedule[]>;
  (method: 'chat.schedule.create', args: PromptScheduleInput & { creation_id: string }): Promise<PromptSchedule | null>;
  (method: 'chat.schedule.update', args: PromptScheduleUpdate): Promise<PromptSchedule | null>;
  (method: 'chat.schedule.run_now', args: PromptScheduleRunRequest): Promise<ChatTurnAcceptance>;
  (method: 'chat.schedule.preview', args: PromptScheduleTiming): Promise<PromptSchedulePreview>;
  (method: 'chat.schedule.pause' | 'chat.schedule.resume' | 'chat.schedule.remove', args: PromptScheduleTarget): Promise<PromptSchedule | null>;
}

/** One persistent panel for Chat and Automation. Edits survive background refreshes. */
export const mountPromptSchedulesPanel = (options: {
  host: HTMLElement; call: PromptScheduleClient; compact?: boolean;
  subscribe?: BroadcastSubscriber['on'];
  hideCreate?: boolean;
  recovery?: PromptRecoveryStore;
  selection?: PromptSelection;
  /** The containing route distinguishes its automatic focus from owner input. */
  canFocusSelection?: () => boolean;
  initialQuery?: string;
  openSchedule?: (row: PromptSchedule) => void;
  onCreateClosed?: (keptId?: string) => void;
  onStateChange?: (state: PromptSchedulesPanelState) => void;
  /** D-341 slice B3 — each card's "What it may do without asking": the prompt's standing
   *  pre-approvals. Absent (or compact) ⇒ no section. */
  triggerPreapprovals?: TriggerPreapprovalPanelCallers;
}) => {
  const { host, call } = options, doc = host.ownerDocument;
  const zone = stampZone();
  if (!doc.head.querySelector('[data-prompt-schedule-styles]')) {
    const style = doc.createElement('style'); style.dataset.promptScheduleStyles = '';
    style.textContent = `
      ${TIMEZONE_PICKER_STYLES}[data-prompt-schedules]{padding:0;min-width:0;font-size:14px;color:var(--fg,inherit);line-height:1.5}
      [data-prompt-schedules] [hidden]{display:none!important}
      [data-prompt-schedules] summary{cursor:pointer;font-weight:600;padding:10px 0}
      [data-prompt-schedules] h2{font-size:17px;font-weight:650;letter-spacing:-.02em;margin:0}
      [data-prompt-schedules] .prompt-schedule-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin:0 0 16px}
      [data-prompt-schedules] .prompt-schedule-toolbar>div{display:flex;gap:8px}
      [data-prompt-schedules] article{border:1px solid var(--border,#dfe3e8);border-radius:12px;background:var(--surface,#fff);padding:20px;margin:0 0 12px}
      [data-prompt-schedules] .prompt-schedule-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px}
      [data-prompt-schedules] h3{font-size:15px;font-weight:650;margin:0;overflow-wrap:anywhere}
      [data-prompt-schedules] h4{font-size:14px;margin:0;overflow-wrap:anywhere}
      [data-prompt-schedules] .prompt-schedule-status{max-width:100%;overflow-wrap:anywhere;display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;padding:3px 9px;border-radius:999px;background:var(--surface-subtle,#f3f4f6);color:var(--fg-muted,#606873)}
      [data-prompt-schedules] .prompt-schedule-status::before{content:'';width:5px;height:5px;background:currentColor;border-radius:50%}
      [data-prompt-schedules] .prompt-schedule-status[data-active=true]{color:var(--accent,#087e96);background:var(--accent-weak,#e6f4f7)}
      [data-prompt-schedules] p{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}
      [data-prompt-schedules] .prompt-schedule-cadence{color:var(--fg-muted,#606873);font-size:12px;margin:4px 0 12px}
      [data-prompt-schedules] .prompt-schedule-request{line-height:1.65;margin:0 0 16px}
      [data-prompt-schedules] mark{background:var(--accent-weak,#e4f2f6);color:inherit;border-radius:2px}
      [data-prompt-schedules] .prompt-schedule-facts{display:flex;flex-wrap:wrap;gap:12px 32px;margin:0 0 16px;font-size:12px}
      [data-prompt-schedules] dt{font-size:11px;color:var(--fg-muted,#606873);margin-bottom:3px}
      [data-prompt-schedules] dd{margin:0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
      [data-prompt-schedules] .prompt-schedule-note{font-size:12px;color:var(--fg-muted,#606873);line-height:1.6}
      [data-prompt-schedules] .prompt-schedule-outcome[data-attention=true]{color:var(--danger,#b42318)}
      [data-prompt-schedules] .prompt-schedule-approval{font-size:12px;font-weight:600;color:var(--accent,#087e96)}
      [data-prompt-schedules] .prompt-schedule-preview{grid-column:1/-1;border:1px solid var(--border,#dfe3e8);border-radius:8px;padding:12px;background:var(--surface-subtle,#f3f4f6);min-width:0;min-height:100px;box-sizing:border-box}
      [data-prompt-schedules] .prompt-schedule-preview h3{font-size:12px;margin:0;font-weight:600;overflow-wrap:anywhere}
      [data-prompt-schedules] .prompt-schedule-preview ol{list-style:none;margin:8px 0;padding:0;display:grid;gap:5px;font-size:12px;font-variant-numeric:tabular-nums}
      [data-prompt-schedules] .prompt-schedule-preview p{margin:8px 0 0}
      [data-prompt-schedules] .prompt-schedule-preview button{margin-top:8px}
      [data-prompt-schedules] .prompt-schedule-card-actions{padding-top:14px;border-top:1px solid var(--border,#dfe3e8);justify-content:flex-end}
      [data-prompt-schedules] .prompt-schedule-card-actions>a{margin-right:auto;font-weight:600;text-decoration:none}
      [data-prompt-schedules] .prompt-schedule-confirm input{box-sizing:border-box;display:block;width:100%;max-width:360px;margin:8px 0;padding:10px}
      [data-prompt-schedules] .prompt-bulk-toolbar{margin:12px 0;padding:12px;border:1px solid var(--border,#dfe3e8);border-radius:8px}
      [data-prompt-schedules] .prompt-bulk-review{margin-top:12px;overflow-wrap:anywhere}
      [data-prompt-schedules] .prompt-bulk-review ol{padding-left:20px}
      [data-prompt-schedules] .prompt-bulk-review li{border-top:1px solid var(--border,#dfe3e8);padding:12px 0}
      [data-prompt-schedules] .prompt-bulk-review input{box-sizing:border-box;width:100%;max-width:360px;margin:8px 0;padding:10px}
      [data-prompt-schedules] .prompt-bulk-select{display:inline-flex;align-items:center;gap:8px;min-height:44px;font-size:12px;margin-bottom:8px;cursor:pointer}
      [data-prompt-schedules] .prompt-bulk-select input{width:18px;height:18px;padding:0;margin:0}
      [data-prompt-schedules] .prompt-run-history{margin-top:12px;border-top:1px solid var(--border,#dfe3e8)}
      [data-prompt-schedules] .prompt-run-history ol{list-style:none;padding:0;margin:8px 0}
      [data-prompt-schedules] .prompt-run-history li{padding:12px 0;border-top:1px solid var(--border,#dfe3e8);overflow-wrap:anywhere}
      [data-prompt-schedules] .prompt-run-history li>div{display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between}
      [data-prompt-schedules] .prompt-run-history li p{font-size:12px;color:var(--fg-muted,#606873);margin:4px 0}
      [data-prompt-schedules] .prompt-run-history a{display:inline-flex;align-items:center;min-height:36px}
      [data-prompt-schedules] form{box-sizing:border-box;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 20px;max-width:760px;margin:16px 0 0}
      [data-prompt-schedules] .prompt-edit-review{grid-column:1/-1;min-width:0}
      [data-prompt-schedules] .prompt-edit-comparison fieldset{border:1px solid var(--border);border-radius:8px;padding:12px;margin:12px 0;min-width:0}
      [data-prompt-schedules] .prompt-edit-values{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
      [data-prompt-schedules] .prompt-edit-values p{max-height:12rem;overflow:auto}
      @media(max-width:600px){[data-prompt-schedules] .prompt-edit-values{grid-template-columns:minmax(0,1fr)}}
      [data-prompt-schedules] form>p,[data-prompt-schedules] form>[data-prompt-schedule-actions],[data-prompt-schedules] .prompt-schedule-field-wide{grid-column:1/-1}
      [data-prompt-schedules] label{display:grid;align-content:start;gap:7px;min-width:0;font-size:12px;font-weight:600}
      [data-prompt-schedules] label.prompt-schedule-check{display:flex;align-items:center;gap:8px;justify-content:flex-start}
      [data-prompt-schedules] label.prompt-schedule-check input{width:auto;min-height:0;padding:0;margin:0;flex:none}
      [data-prompt-schedules] label.prompt-schedule-check[hidden]{display:none}
      [data-prompt-schedules] .prompt-schedule-days{grid-column:1/-1;min-width:0;margin:0;padding:12px;border:1px solid var(--border,#dfe3e8);border-radius:8px}
      [data-prompt-schedules] .prompt-schedule-days>div{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:4px 12px}
      [data-prompt-schedules] .prompt-schedule-days label{min-height:44px;cursor:pointer}
      [data-prompt-schedules] input,[data-prompt-schedules] textarea,[data-prompt-schedules] select{font:inherit;font-size:14px;font-weight:400;color:inherit;background:var(--surface,#fff);border:1px solid var(--border,#dfe3e8);border-radius:8px;padding:10px 12px;box-sizing:border-box;width:100%;min-width:0;min-height:42px}
      [data-prompt-schedules] textarea{min-height:112px;resize:vertical;line-height:1.6}
      [data-prompt-schedules] form>p{margin:0}
      [data-prompt-schedules] [role=alert]:empty{display:none}
      [data-prompt-schedules] [role=alert]:not(:empty){color:var(--danger,#b42318)}
      [data-prompt-schedules] button{font:inherit;font-size:12px;font-weight:600;color:inherit;background:var(--surface,#fff);border:1px solid var(--border,#dfe3e8);border-radius:7px;padding:7px 11px;min-height:36px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px}
      [data-prompt-schedules] button svg[aria-hidden=true]{flex:none}
      [data-prompt-schedules] button:hover{background:var(--surface-subtle,#f3f4f6)}
      [data-prompt-schedules] button[type=submit]{background:var(--accent,#087e96);border-color:var(--accent,#087e96);color:var(--on-accent,#fff);padding:10px 16px;min-height:42px}
      [data-prompt-schedules] .prompt-schedule-remove{color:var(--fg-muted,#606873);border-color:transparent;background:transparent}
      [data-prompt-schedules] .prompt-schedule-remove:hover{color:var(--danger,#b42318);background:color-mix(in srgb,var(--danger,#b42318) 7%,transparent)}
      [data-prompt-schedules] button:disabled{opacity:.5;cursor:wait}
      [data-prompt-schedules] :is(button,a,input,select,textarea):focus-visible{outline:2px solid var(--accent,#087e96);outline-offset:2px}
      [data-prompt-schedule-actions]{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
      [data-prompt-schedules] .prompt-schedule-empty{border:1px dashed var(--border,#dfe3e8);border-radius:12px;padding:24px;color:var(--fg-muted,#606873);font-size:13px;background:var(--surface,#fff)}
      [data-prompt-schedules] .prompt-schedule-confirm{margin:14px 0 0;padding:12px;border-radius:8px;background:var(--surface-subtle,#f3f4f6);font-size:13px}
      [data-prompt-schedules] .prompt-schedule-confirm button{margin:8px 8px 0 0}
      [data-prompt-schedule-compact]>div{max-height:45vh;overflow:auto;padding:4px 2px}
      [data-prompt-schedule-compact] article{padding:14px}
      @media(max-width:600px){[data-prompt-schedules] form{grid-template-columns:minmax(0,1fr)}[data-prompt-schedules] article{padding:16px}[data-prompt-schedules] button{min-height:44px}[data-prompt-schedules] summary{min-height:44px;box-sizing:border-box;padding-block:11.5px}[data-prompt-schedules] .prompt-schedule-card-actions>a{flex-basis:100%;justify-content:flex-start;min-height:36px}}
      @media(prefers-reduced-motion:no-preference){[data-prompt-schedules] button{transition:background .15s,color .15s}}`;
    doc.head.append(style);
  }
  host.dataset.promptSchedules = '';
  const shell = doc.createElement(options.compact ? 'details' : 'section');
  if (options.compact) shell.dataset.promptScheduleCompact = '';
  const heading = doc.createElement(options.compact ? 'summary' : 'h2'); heading.textContent = 'Scheduled prompts';
  const toolbar = doc.createElement('div'); toolbar.className = 'prompt-schedule-toolbar';
  if (options.compact) shell.append(heading); else { toolbar.append(heading); shell.append(toolbar); }
  const content = doc.createElement('div'); shell.append(content); host.append(shell);
  let session: string | undefined, initialized = false, disposed = false, busy = false, seq = 0;
  let scopeVersion = 0;
  let confirming: { id: string; revision: number } | null = null;
  let rows: PromptSchedule[] = [], error = '', editing = false, loaded = false;
  let listError = '', filter: AutomationChip | null = null;
  let query = options.initialQuery ?? '', selectionIdentity = options.selection?.identity, selectionError = '', selectionFocus = Boolean(options.selection), interacted = false;
  let keptCreationDraftId: string | undefined;
  const markInteraction = () => { interacted = true; };
  host.addEventListener('pointerdown', markInteraction, true); host.addEventListener('keydown', markInteraction, true);
  const searchLabel = doc.createElement('label'); searchLabel.className = 'prompt-schedule-field-wide';
  const searchCaption = doc.createElement('span'); searchCaption.textContent = 'Search scheduled prompts';
  const searchInput = doc.createElement('input'); searchInput.type = 'search'; searchInput.maxLength = 200; searchInput.value = query;
  searchInput.dataset.promptFocus = 'search'; searchInput.setAttribute('aria-label', 'Search scheduled prompts'); searchLabel.append(searchCaption, searchInput);
  searchInput.addEventListener('input', () => { query = searchInput.value; render('search'); });
  let recoveryError = '', discarding: PromptDraftEntry | undefined, captureDraft: (() => void) | undefined;
  const checkpoint = createPromptDraftCheckpoint({ store: options.recovery, changed: () => {
    const status = content.querySelector('[data-prompt-draft-status]'); if (status) status.textContent = checkpoint.message();
  } });
  const flushDraft = () => { captureDraft?.(); return checkpoint.flush(); };
  const flushOnLeave = () => { if (!disposed) flushDraft(); };
  doc.defaultView?.addEventListener('pagehide', flushOnLeave); doc.defaultView?.addEventListener('beforeunload', flushOnLeave);
  let editorPreview: ReturnType<typeof mountPromptSchedulePreview> | undefined;
  let editorZonePicker: TimezonePicker | undefined;
  const closePreview = () => { editorZonePicker?.dispose(); editorZonePicker = undefined; editorPreview?.dispose(); editorPreview = undefined; };
  /** D-341 slice B3 — each card's "What it may do without asking", by schedule: kept across the
   *  renders that rebuild every card (moved into the new one, open or not, mid-grant or not). */
  const preapprovalSections = new Map<string, { host: HTMLDetailsElement; panel: TriggerPreapprovalPanelMount | null }>();
  // Hidden on a server from before pre-approvals, asked once for the panel.
  let preapprovalSupport: TriggerPreapprovalSupport | null = null;
  const preapprovalSection = (schedule_id: string): HTMLDetailsElement | null => {
    const callers = options.triggerPreapprovals;
    if (callers === undefined || options.compact) return null;
    const kept = preapprovalSections.get(schedule_id);
    if (kept !== undefined) return kept.host;
    const section = doc.createElement('details');
    (preapprovalSupport ??= createTriggerPreapprovalSupport((args) => callers.choices(args)))
      .show(section, { kind: 'prompt_schedule', schedule_id });
    section.dataset.promptSchedulePreapprovals = schedule_id;
    section.append(node('summary', 'What it may do without asking'));
    const item: { host: HTMLDetailsElement; panel: TriggerPreapprovalPanelMount | null } = { host: section, panel: null };
    preapprovalSections.set(schedule_id, item);
    section.addEventListener('toggle', () => {
      if (!section.open || item.panel !== null || disposed || !host.contains?.(section)) return;
      item.panel = mountTriggerPreapprovalPanel({
        host: section, trigger: { kind: 'prompt_schedule', schedule_id }, callers, document: doc,
        ...(options.subscribe !== undefined ? { subscribe: options.subscribe } : {}),
      });
    });
    return section;
  };
  const dropPreapprovalSections = (keep: ReadonlySet<string>): void => {
    for (const [schedule_id, item] of preapprovalSections) {
      if (keep.has(schedule_id) || item.panel?.pending() === true) continue;
      item.panel?.dispose();
      preapprovalSections.delete(schedule_id);
    }
  };
  const runRequests = new Map<string, PromptScheduleRunRequest>();
  const readRunRequest = (key: string, row: PromptSchedule): PromptScheduleRunRequest | undefined => {
    const remembered = runRequests.get(key);
    if (remembered) return remembered;
    try {
      const saved = JSON.parse(doc.defaultView?.sessionStorage.getItem(key) ?? 'null') as Partial<PromptScheduleRunRequest> | null;
      if (saved?.schedule_id === row.schedule_id && saved.expected_revision === row.revision
        && typeof saved.submission_id === 'string' && saved.submission_id.length > 0 && saved.submission_id.length <= 128) {
        const request = { schedule_id: row.schedule_id, expected_revision: row.revision, submission_id: saved.submission_id };
        runRequests.set(key, request); return request;
      }
    } catch { /* The in-memory request still protects retries when storage is unavailable. */ }
    return undefined;
  };
  const rememberRunRequest = (key: string, request?: PromptScheduleRunRequest) => {
    if (request) runRequests.set(key, request); else runRequests.delete(key);
    try {
      if (request) doc.defaultView?.sessionStorage.setItem(key, JSON.stringify(request));
      else doc.defaultView?.sessionStorage.removeItem(key);
    } catch { /* The request remains in memory until the server acknowledges it. */ }
  };
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text: string) => {
    const el = doc.createElement(tag); el.textContent = text; return el;
  };
  const button = (parent: HTMLElement, label: string, action: () => void, icon?: IconName) => {
    const b = node('button', label); b.type = 'button'; b.disabled = busy;
    if (icon) b.innerHTML = renderActionLabel(icon, label);
    b.addEventListener('click', action); parent.append(b); return b;
  };
  const format = (at: number, timeZone: string) => new Date(at).toLocaleString(undefined, {
    timeZone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const render = (restoreFocus?: string) => {
    if (disposed || editing) return;
    const selection = doc.activeElement === searchInput ? [searchInput.selectionStart, searchInput.selectionEnd] : undefined;
    const focus = restoreFocus ?? (doc.activeElement && host.contains?.(doc.activeElement)
      ? (doc.activeElement as HTMLElement).dataset.promptFocus : undefined);
    content.replaceChildren(); host.setAttribute('aria-busy', String(busy));
    const filtered = filter === null ? rows : rows.filter(row => promptScheduleChip(row) === filter);
    const shown = options.selection ? selectionError ? [] : rows.filter(row => row.schedule_id === options.selection!.id)
      : filtered.filter(row => promptMatchesQuery(row, query));
    heading.textContent = options.selection ? 'Scheduled prompt' : query.trim() ? `Scheduled prompts (${shown.length} of ${filtered.length})`
      : shown.length ? `Scheduled prompts (${shown.length})` : 'Scheduled prompts';
    const controls = doc.createElement('div');
    if (!options.hideCreate && !options.selection) button(controls, 'Schedule a prompt', () => edit(), 'schedule').dataset.promptFocus = 'create';
    button(controls, 'Refresh', () => { selectionIdentity = undefined; selectionError = ''; void refresh(); }, 'refresh').dataset.promptFocus = 'refresh';
    if (options.compact) { controls.className = 'prompt-schedule-toolbar'; content.append(controls); }
    else toolbar.replaceChildren(heading, controls);
    if (error) { const p = node('p', error); p.setAttribute('role', 'alert'); content.append(p); }
    if (!loaded && !error) content.append(node('p', 'Loading scheduled prompts…'));
    if (!options.compact && !options.selection) content.append(searchLabel);
    if (selectionError) { const notice = node('p', selectionError); notice.setAttribute('role', 'alert'); notice.tabIndex = -1; notice.dataset.promptSelectionError = ''; content.append(notice); }
    const bulkToolbar = bulk?.renderToolbar(rows, shown); if (bulkToolbar) content.append(bulkToolbar);
    const recoveries = promptRecoveryView({ document: doc, store: options.recovery, disabled: busy, error: recoveryError, confirming: discarding,
      scheduleId: options.selection?.id, creationDraftId: keptCreationDraftId,
      resume: entry => { if (!resumeDraft(entry.id, entry)) { recoveryError = 'This recovery copy changed or is no longer available. Review the current drafts.'; render(); } },
      confirm: entry => { const id = entry?.id ?? discarding?.id; discarding = entry; render(id ? 'draft-' + (entry ? 'keep:' : 'discard:') + id : undefined); },
      remove: entry => {
        if (JSON.stringify(options.recovery?.get(entry.id)) !== JSON.stringify(entry) || !options.recovery?.remove(entry.id)) {
          recoveryError = 'This recovery copy changed or could not be discarded. Review the current drafts and try again.'; discarding = undefined; render(); return;
        }
        recoveryError = ''; discarding = undefined; render('create'); options.onStateChange?.({ rows, loaded, error: listError });
      } });
    if (recoveries) content.append(recoveries);
    for (const row of shown) {
      const card = doc.createElement('article'); card.dataset.scheduleId = row.schedule_id;
      card.setAttribute('aria-label', row.title);
      const selectionBox = bulk?.checkbox(row); if (selectionBox) card.append(selectionBox);
      const status = row.timed_pause ? row.timed_pause.until_at <= Date.now() ? 'Resuming…' : 'Paused' : row.enabled ? 'Active' : row.mode === 'one_shot' && row.last_run_at !== null ? 'No future runs' : 'Paused';
      const cardHeading = doc.createElement('div'); cardHeading.className = 'prompt-schedule-heading';
      const badge = node('span', status); badge.className = 'prompt-schedule-status';
      badge.dataset.active = String(row.enabled);
      const title = node('h3', row.title); title.tabIndex = -1; title.dataset.promptFocus = row.schedule_id + ':heading';
      if (query.trim() && !options.selection) title.innerHTML = renderSearchHighlights(row.title, query);
      cardHeading.append(title, badge); card.append(cardHeading);
      const when = row.mode === 'one_shot' ? format(row.run_at!, row.time_zone) : describePromptCron(row.cron_expression!);
      const cadence = node('p', `${when} · ${row.time_zone.replaceAll('_', ' ')}`); cadence.className = 'prompt-schedule-cadence';
      const request = node('p', row.prompt); request.className = 'prompt-schedule-request'; card.append(cadence, request);
      if (query.trim() && !options.selection) {
        cadence.innerHTML = renderSearchHighlights(promptSearchTimingText(row, query), query);
        request.innerHTML = renderSearchHighlights(row.prompt, query);
      }
      const facts = doc.createElement('dl'); facts.className = 'prompt-schedule-facts';
      const fact = (label: string, value: string) => { const item = doc.createElement('div'); item.append(node('dt', label), node('dd', value)); facts.append(item); };
      if (row.timed_pause) { fact('Paused until', format(row.timed_pause.until_at, row.time_zone)); fact('First run after break', format(row.timed_pause.first_run_at, row.time_zone)); }
      if (row.next_run_at !== null) fact('Next run', format(row.next_run_at, row.time_zone));
      if (row.notify_on_done === true) fact('When done', 'Notifies you');
      if (row.model_source_id) fact('Model', SCHEDULE_MODEL_LABELS[row.model_source_id]);
      const outcome = row.last_outcome;
      const lastStatus = outcome?.status ?? (row.last_status === 'completed' ? 'finished' : row.last_status);
      if (lastStatus) fact('Last run', `${outcomeLabels[lastStatus]}${row.last_run_at === null ? '' : ` · ${format(row.last_run_at, row.time_zone)}`}`);
      if (facts.childElementCount) card.append(facts);
      if (row.scheduling_issue) {
        const note = node('p', 'Scheduling delayed. Recued could not confirm this run was queued and will check again while the schedule is active.');
        note.className = 'prompt-schedule-note prompt-schedule-outcome'; note.dataset.attention = 'true'; card.append(note);
      }
      const pending = row.pending_approvals;
      const waiting = row.pending_work;
      if (pending) {
        const note = node('p', `${pending.count === 1 ? '1 action needs' : `${pending.count} actions need`} your approval.`);
        note.className = 'prompt-schedule-approval'; card.append(note);
      }
      const reason = waiting?.reason ?? outcome?.reason ?? (lastStatus === 'failed' ? 'turn_failed' : lastStatus === 'interrupted' ? 'outcome_unknown' : undefined);
      const explanation = waiting?.status === 'running' ? 'An action is still running.' : reason ? outcomeReasons[reason] : lastStatus === 'needs_approval' && !pending
        ? 'An action is waiting for your approval.' : undefined;
      if (explanation) {
        const note = node('p', explanation); note.className = 'prompt-schedule-note prompt-schedule-outcome';
        note.dataset.attention = String(['failed', 'interrupted', 'needs_attention'].includes(waiting?.status ?? lastStatus ?? '')); card.append(note);
      }
      const actions = doc.createElement('div'); actions.dataset.promptScheduleActions = ''; actions.className = 'prompt-schedule-card-actions';
      const target = pending ?? waiting ?? outcome;
      const open = node('a', pending || lastStatus === 'needs_approval' ? 'Review approval' : waiting ? 'View waiting run' : outcome?.message_id || outcome?.plan_id ? 'View last run' : 'Open conversation');
      open.href = target?.plan_id ? serializeChatPlanAddress({ sessionId: row.session_id, planId: target.plan_id,
        ...(target.message_id ? { messageId: target.message_id } : {}) })
        : target?.message_id ? serializeChatAnswerAddress({ sessionId: row.session_id, messageId: target.message_id })
          : serializeChatSessionAddress({ sessionId: row.session_id });
      open.dataset.promptFocus = `${row.schedule_id}:open`; actions.append(open);
      if (!options.compact && !options.selection) {
        const details = node('a', 'Details'); details.href = promptScheduleHref(row.schedule_id); details.dataset.promptFocus = row.schedule_id + ':details';
        details.addEventListener('click', event => {
          if (event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !options.openSchedule) return;
          event.preventDefault(); if (!busy) options.openSchedule(row);
        }); actions.append(details);
      }
      if (row.run_now_available !== undefined) {
        const key = `recued:prompt-run-now:${row.run_request_scope ?? row.session_id}:${row.schedule_id}:${row.revision}`;
        const retry = !!readRunRequest(key, row);
        const run = button(actions, retry ? 'Retry Run now' : 'Run now', () => {
          const request = readRunRequest(key, row) ?? { schedule_id: row.schedule_id,
            expected_revision: row.revision, submission_id: crypto.randomUUID() };
          rememberRunRequest(key, request);
          void mutate(async () => {
            try {
              const receipt = await call('chat.schedule.run_now', request);
              if (typeof receipt?.turn_id !== 'string' || !receipt.turn_id) throw new Error('The server did not confirm this run.');
              rememberRunRequest(key);
            } catch (failure) {
              if (['bad_request', 'conflict', 'not_found', 'unauthorized', 'forbidden', 'unknown_method', 'not_configured']
                .includes(classifyRpcError(failure).code ?? '')) {
                rememberRunRequest(key); await refresh(); throw failure;
              }
              throw new Error(`${humanizeRpcError(failure)} Retry Run now will use the same request.`);
            }
          });
        }, 'play');
        run.dataset.promptFocus = `${row.schedule_id}:run`;
        run.disabled = busy || !row.run_now_available && !retry;
        run.title = row.run_now_available || retry ? 'Run the saved request once; keep this schedule unchanged.'
          : 'Finish or review the waiting run first.';
      }
      skips.render(row, card, actions);
      const action = (verb: 'pause' | 'resume' | 'remove', revision = row.revision) => { void mutate(async () => {
        await call(`chat.schedule.${verb}`, { schedule_id: row.schedule_id, expected_revision: revision });
      }); };
      if (row.enabled || row.last_status === 'queued' || row.mode === 'recurring' || (row.run_at ?? 0) > Date.now()) {
        const canPause = row.enabled || row.last_status === 'queued';
        const toggle = button(actions, canPause ? 'Pause' : row.timed_pause ? 'Resume now' : 'Resume', () => action(canPause ? 'pause' : 'resume'), canPause ? undefined : 'play');
        toggle.dataset.promptFocus = `${row.schedule_id}:toggle`;
      }
      pauses.render(row, card, actions);
      button(actions, 'Edit', () => edit(row), 'rename').dataset.promptFocus = `${row.schedule_id}:edit`;
      button(actions, 'Duplicate', () => edit(undefined, undefined, row), 'copy').dataset.promptFocus = `${row.schedule_id}:duplicate`;
      const remove = button(actions, 'Remove', () => {
        confirming = { id: row.schedule_id, revision: row.revision }; render(`${row.schedule_id}:keep`);
      }, 'delete'); remove.dataset.promptFocus = `${row.schedule_id}:remove`; remove.className = 'prompt-schedule-remove';
      card.append(actions);
      const preapprovals = preapprovalSection(row.schedule_id);
      if (preapprovals !== null) card.append(preapprovals);
      const history = runHistory.section(row); if (history) card.append(history);
      if (confirming?.id === row.schedule_id) {
        const revision = confirming.revision;
        const confirm = node('p', 'Remove this schedule? Its conversation stays. A turn already running can finish.');
        confirm.className = 'prompt-schedule-confirm';
        button(confirm, 'Keep schedule', () => { confirming = null; render(`${row.schedule_id}:remove`); }).dataset.promptFocus = `${row.schedule_id}:keep`;
        button(confirm, 'Remove schedule', () => action('remove', revision), 'delete').dataset.promptFocus = `${row.schedule_id}:confirm`;
        card.append(confirm);
      }
      content.append(card);
    }
    dropPreapprovalSections(new Set(rows.map(row => row.schedule_id)));
    runHistory.retain(rows); pauses.watch(rows);
    if (loaded && !shown.length && !selectionError) { const empty = node('p', query.trim() ? 'No saved scheduled prompts match this search and filter.' : filter !== null ? 'No scheduled prompts match this filter.' : options.compact ? 'No scheduled prompt is linked to this conversation.' : 'Run an AI request once or on a recurring schedule. Each schedule has its own conversation.'); empty.className = 'prompt-schedule-empty'; content.append(empty); }
    if (shown.length) { const note = node('p', 'Chatting in a schedule’s conversation does not change the saved request. Pausing cancels queued runs; a running turn can finish.'); note.className = 'prompt-schedule-note'; content.append(note); }
    if (focus) (Array.from(shell.querySelectorAll<HTMLElement>('[data-prompt-focus]')).find(el => el.dataset.promptFocus === focus)
      ?? shell.querySelector<HTMLElement>('[data-prompt-focus="refresh"]'))?.focus({ preventScroll: true });
    if (selection && doc.activeElement === searchInput && selection[0] !== null && selection[1] !== null) searchInput.setSelectionRange(selection[0]!, selection[1]!);
    skips.watch(shown);
  };
  const readRows = async () => {
    const request = ++seq;
    try {
      const result = await call('chat.schedules.list', session ? { session_id: session } : {});
      if (disposed || request !== seq) return;
      if (!Array.isArray(result)) throw new Error('Scheduled prompts are unavailable on this server.');
      rows = options.selection ? readPromptSchedules(result) : result; loaded = true; error = listError = '';
      if (options.selection) {
        const selected = rows.find(row => row.schedule_id === options.selection!.id);
        selectionError = !selected ? 'This scheduled prompt no longer exists. Go back or refresh to check again.'
          : selectionIdentity !== undefined && promptScheduleIdentity(selected) !== selectionIdentity
            ? 'This scheduled prompt changed. Refresh to review its current details.' : '';
        if (!selectionError) selectionIdentity = undefined;
      }
    } catch (failure) { if (!disposed && request === seq) error = listError = humanizeRpcError(failure); }
    if (!disposed && request === seq) {
      render();
      const mayFocusSelection = !interacted && (options.canFocusSelection?.()
        ?? (doc.activeElement === doc.body || doc.activeElement === doc.documentElement || doc.activeElement === host.parentElement));
      if (selectionFocus && selectionError) {
        selectionFocus = false;
        if (mayFocusSelection)
          content.querySelector<HTMLElement>('[data-prompt-selection-error]')?.focus({ preventScroll: true });
      }
      if (selectionFocus && loaded && !selectionError && !error) {
        selectionFocus = false;
        if (mayFocusSelection)
          focusSchedule(options.selection!.id, 'heading');
      }
      if (!busy) options.onStateChange?.({ rows, loaded, error: listError });
    }
  };
  let latestRefresh = Promise.resolve();
  const refresh = () => latestRefresh = readRows();
  const focusSchedule = (id: string, part = 'details'): boolean => {
    const control = Array.from(shell.querySelectorAll<HTMLElement>('[data-prompt-focus]')).find(el => el.dataset.promptFocus === id + ':' + part);
    control?.focus({ preventScroll: true }); return Boolean(control);
  };
  const mutate = async (work: () => Promise<void>) => {
    if (busy || disposed) return;
    const scope = scopeVersion;
    const focus = (doc.activeElement as HTMLElement | null)?.dataset?.promptFocus;
    skips.close(); pauses.close(); busy = true; error = ''; render();
    try {
      await work(); if (disposed || scope !== scopeVersion) return;
      confirming = null; await refresh();
    }
    catch (failure) { if (!disposed && scope === scopeVersion) error = humanizeRpcError(failure); }
    finally {
      if (!disposed && scope === scopeVersion) {
        busy = false;
        render(doc.activeElement === doc.body || host.contains(doc.activeElement) ? focus : undefined);
        // Let the parent hide a filtered card after its controls can return focus.
        options.onStateChange?.({ rows, loaded, error: listError });
      }
    }
  };
  const skips = createPromptSkipControls({ document: doc, call, busy: () => busy, blocked: () => busy || editing,
    redraw: render, refresh, mutate });
  const pauses = createPromptPauseControls({ document: doc, call, busy: () => busy, redraw: render, refresh, mutate, opening: () => skips.close() });
  const bulk = !options.compact && !options.selection ? createPromptBulkControls({ document: doc, call, busy: () => busy, redraw: render, mutate, opening: () => { skips.close(); pauses.close(); } }) : undefined;
  const runHistory = createPromptRunsView({ document: doc, call, busy: () => busy });
  const edit = (row?: PromptSchedule, restored?: PromptDraftEntry, copy?: PromptSchedule) => {
    if (busy || disposed) return;
    skips.close(); pauses.close();
    flushDraft(); checkpoint.suspend(); captureDraft = undefined;
    recoveryError = ''; discarding = undefined;
    closePreview(); editing = true; confirming = null; ++seq; content.replaceChildren();
    const scope = scopeVersion;
    const preset = row ?? copy;
    let needsCheck = Boolean(restored && restored.status !== 'editing'), submitted = restored?.values.request ?? null;
    const original: PromptEditOriginal | null = row ? promptEditOriginal(restored?.original ?? row) : null;
    let submittedUpdate = restored?.values.updateRequest;
    let editChecking = false, editChecked = !restored, editReview: PromptEditComparison | undefined, editMissing = false, retryReady = false;
    let checkSequence = 0;
    if (options.compact) (shell as HTMLDetailsElement).open = true;
    if (!options.compact) { heading.textContent = row ? 'Edit scheduled prompt' : copy ? 'Duplicate scheduled prompt' : options.hideCreate ? 'Prompt details' : 'New scheduled prompt'; toolbar.replaceChildren(heading); }
    const form = doc.createElement('form'); const creation_id = restored?.values.creationId ?? crypto.randomUUID();
    if (options.recovery) {
      const status = node('p', ''); status.dataset.promptDraftStatus = ''; status.setAttribute('role', 'status'); form.append(status);
    }
    const field = (label: string, el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
      const l = doc.createElement('label'), caption = node('span', label); caption.id = `schedule-field-${crypto.randomUUID()}`;
      el.setAttribute('aria-labelledby', caption.id); l.append(caption, el); form.append(l); return el;
    };
    const title = doc.createElement('input'); title.value = restored?.values.title ?? (copy ? copy.title.slice(0, 153).replace(/[\uD800-\uDBFF]$/, '') + ' (copy)' : preset?.title ?? ''); title.placeholder = 'e.g. Morning inbox briefing'; title.maxLength = 160; title.required = true; field('Title', title).parentElement!.className = 'prompt-schedule-field-wide';
    const prompt = doc.createElement('textarea'); prompt.value = restored?.values.prompt ?? preset?.prompt ?? ''; prompt.placeholder = 'Describe what you want Recued to do, including the accounts or projects to use.'; prompt.maxLength = 32000; prompt.required = true; field('Request to run', prompt).parentElement!.className = 'prompt-schedule-field-wide';
    if (copy) { const note = node('p', copy.mode === 'one_shot' ? 'Review this copy and choose a new date and time before creating its schedule.' : 'Review this copy before creating its schedule.'); note.className = 'prompt-schedule-note'; form.append(note); }
    const help = node('p', 'Each schedule uses its own conversation and your current tool permissions. Actions that need your approval will still ask.'); help.className = 'prompt-schedule-note'; form.append(help);
    if (row?.mode === 'recurring') form.append(node('p', 'Changing the timing or timezone clears any skipped run.'));
    const mode = doc.createElement('select');
    for (const [value, label] of [['one_shot', 'Once'], ['recurring', 'Recurring']]) { const option = node('option', label!); option.value = value!; mode.append(option); }
    mode.value = restored?.values.mode ?? preset?.mode ?? 'one_shot'; mode.disabled = !!row; field('Run', mode);
    const oneOffZone = restored?.values.oneOffZone ?? (preset?.mode === 'one_shot' ? preset.time_zone : zone);
    const initialTime = reminderWallClockValue(row?.run_at ?? Date.now() + 3600000, oneOffZone);
    const time = doc.createElement('input'); time.type = 'datetime-local'; time.value = restored?.values.time ?? (copy ? '' : initialTime); field(`Date and time (${oneOffZone})`, time);
    let chosenTime = time.value, chosenAt = restored ? restored.values.chosenAt : copy ? null : row?.mode === 'one_shot' ? row.run_at! : zonedWallClockToEpochMs(time.value, oneOffZone);
    const timing = readPromptRepeat(preset?.cron_expression ?? '0 9 * * *');
    const frequency = doc.createElement('select');
    for (const [value, label] of [['daily', 'Every day'], ['weekdays', 'Every weekday'], ['weekly', 'Every week'], ['selected_days', 'Selected weekdays'], ['monthly', 'Every month'], ['custom', 'Custom schedule']]) {
      const option = node('option', label!); option.value = value!; frequency.append(option);
    }
    frequency.value = restored?.values.frequency ?? timing.frequency; field('Repeat', frequency);
    const clock = doc.createElement('input'); clock.type = 'time'; clock.value = restored?.values.clock ?? timing.clock; field('Time', clock);
    const weekday = doc.createElement('select');
    PROMPT_WEEKDAY_NAMES.forEach((day, i) => {
      const option = node('option', day); option.value = String(i); weekday.append(option);
    });
    weekday.value = restored?.values.weekday ?? timing.weekday; field('Day of week', weekday);
    const days = doc.createElement('fieldset'); days.className = 'prompt-schedule-days'; days.append(node('legend', 'Days of week'));
    const dayChoices = doc.createElement('div'); days.append(dayChoices); form.append(days);
    const selected = restored?.values.selectedWeekdays ?? (restored ? [restored.values.weekday] : timing.selectedWeekdays);
    const dayInputs = [1, 2, 3, 4, 5, 6, 0].map(day => {
      const label = doc.createElement('label'); label.className = 'prompt-schedule-check'; const input = doc.createElement('input'); input.type = 'checkbox'; input.value = String(day); input.checked = selected.includes(input.value);
      label.append(input, node('span', PROMPT_WEEKDAY_NAMES[day]!)); dayChoices.append(label); return input;
    });
    const monthDay = doc.createElement('input'); monthDay.type = 'number'; monthDay.min = '1'; monthDay.max = '31'; monthDay.step = '1';
    monthDay.value = restored?.values.monthDay ?? timing.monthDay; field('Day of month', monthDay);
    const monthHelp = node('p', 'For days 29–31, months without that date are skipped.'); monthHelp.className = 'prompt-schedule-note';
    monthHelp.id = `schedule-month-help-${crypto.randomUUID()}`; monthDay.setAttribute('aria-describedby', monthHelp.id); form.append(monthHelp);
    const cron = doc.createElement('input'); cron.value = restored?.values.cron ?? preset?.cron_expression ?? '0 9 * * *'; field('Custom schedule (cron)', cron);
    const cronHelp = node('p', 'Use five cron fields, with at least five minutes between occurrences.'); form.append(cronHelp);
    const timezone = doc.createElement('input'); timezone.value = restored?.values.timezone ?? preset?.time_zone ?? zone; field('Recurring timezone', timezone);
    editorZonePicker = mountTimezonePicker({ document: doc, host: timezone.parentElement!, input: timezone, label: 'Recurring timezone', retained: [preset?.time_zone ?? zone] });
    // D-338 slice 2 — offered once the server says it can notify: a schedule it sent names the
    // field, or the timing preview says so. A server before it refuses the field in a save.
    let notifyNamed = !restored && typeof preset?.notify_on_done === 'boolean' || rows.some(saved => typeof saved.notify_on_done === 'boolean');
    const notifyLabel = doc.createElement('label'); notifyLabel.className = 'prompt-schedule-check prompt-schedule-field-wide';
    notifyLabel.dataset.promptScheduleNotify = '';
    const notify = doc.createElement('input'); notify.type = 'checkbox'; notify.checked = restored?.values.notify ?? preset?.notify_on_done === true;
    notifyLabel.append(notify, node('span', 'Notify me when it’s done'));
    const notifyHelp = node('p', 'Sends its answer to your notification channels, such as Telegram or email, each time a run finishes.');
    notifyHelp.className = 'prompt-schedule-note';
    form.append(notifyLabel, notifyHelp);
    const capabilityNote = node('p', ''); capabilityNote.setAttribute('role', 'status'); form.append(capabilityNote);
    const showCapabilities = () => { capabilityNote.textContent = !notifyNamed && notify.checked
      ? 'This server has not confirmed support for your saved notification choice. Turn it off to use the server default, or keep this draft.'
      : !modelNamed && model.value ? 'This server has not confirmed support for your saved model choice. Choose Chat default, or keep this draft.' : ''; };
    const showNotify = () => { notifyLabel.hidden = !notifyNamed && !notify.checked; notifyHelp.hidden = notifyLabel.hidden; };
    showNotify();
    // D-344 slice D — the model its runs use, offered once the server says it takes one: a schedule
    // it sent names the field, or the timing preview says so. A server before it refuses the field.
    let modelNamed = !restored && preset?.model_source_id !== undefined || rows.some(saved => saved.model_source_id !== undefined);
    const model = doc.createElement('select');
    for (const [value, label] of SCHEDULE_MODEL_CHOICES) { const option = node('option', label); option.value = value; model.append(option); }
    model.value = restored?.values.model ?? preset?.model_source_id ?? ''; model.dataset.promptScheduleModel = '';
    field('Model', model);
    const showModel = () => { model.parentElement!.hidden = !modelNamed && !model.value; };
    showModel(); showCapabilities();
    const readValues = (): PromptDraftValues => {
      if (time.value !== chosenTime) { chosenTime = time.value; chosenAt = zonedWallClockToEpochMs(time.value, oneOffZone); }
      return { title: title.value, prompt: prompt.value, mode: mode.value === 'recurring' ? 'recurring' : 'one_shot', oneOffZone, time: time.value, chosenAt,
        frequency: frequency.value as PromptDraftValues['frequency'], clock: clock.value, weekday: weekday.value, cron: cron.value, timezone: timezone.value,
        selectedWeekdays: dayInputs.filter(input => input.checked).map(input => input.value).sort(), monthDay: monthDay.value,
        model: isChatModelSourceId(model.value) ? model.value : '', notify: notify.checked, creationId: creation_id, request: submitted,
        ...(submittedUpdate ? { updateRequest: submittedUpdate } : {}) };
    };
    {
      checkpoint.begin(readValues(), restored, original);
      // A populated copy is already owner input, even before a field changes.
      if (copy) checkpoint.flush(true);
      captureDraft = () => { if (!busy && !needsCheck && !disposed && scope === scopeVersion) checkpoint.capture(readValues()); };
      const status = form.querySelector('[data-prompt-draft-status]'); if (status) status.textContent = checkpoint.message();
    }
    form.addEventListener('input', () => { captureDraft?.(); showCapabilities(); });
    form.addEventListener('change', () => { captureDraft?.(); showCapabilities(); });
    const showTiming = () => {
      const recurring = mode.value === 'recurring';
      time.parentElement!.hidden = recurring; frequency.parentElement!.hidden = !recurring;
      clock.parentElement!.hidden = !recurring || frequency.value === 'custom';
      weekday.parentElement!.hidden = !recurring || frequency.value !== 'weekly';
      days.hidden = !recurring || frequency.value !== 'selected_days';
      monthDay.parentElement!.hidden = !recurring || frequency.value !== 'monthly'; monthHelp.hidden = monthDay.parentElement!.hidden;
      cron.parentElement!.hidden = !recurring || frequency.value !== 'custom'; cronHelp.hidden = cron.parentElement!.hidden;
      timezone.parentElement!.hidden = !recurring; if (!recurring) editorZonePicker?.close();
      time.required = !recurring; clock.required = recurring && frequency.value !== 'custom';
      cron.required = recurring && frequency.value === 'custom'; timezone.required = recurring;
      monthDay.required = recurring && frequency.value === 'monthly';
      // Inactive numeric controls must not block another cadence's submission.
      monthDay.disabled = busy || needsCheck || !recurring || frequency.value !== 'monthly';
    };
    mode.addEventListener('change', showTiming); frequency.addEventListener('change', showTiming); showTiming();
    const readTiming = (): PromptScheduleTiming => {
      if (!row) {
        if (needsCheck && submitted) return { mode: submitted.mode, time_zone: submitted.time_zone,
          ...(submitted.mode === 'one_shot' ? { run_at: submitted.run_at } : { cron_expression: submitted.cron_expression }) };
        return promptDraftTiming(readValues());
      }
      return promptDraftTiming(readValues());
    };
    const previewHost = doc.createElement('section'); form.append(previewHost);
    const preview = mountPromptSchedulePreview({ host: previewHost, readTiming, paused: row?.enabled === false,
      ...(row?.mode === 'one_shot' && !row.enabled ? { inactiveOneOffAt: row.run_at! } : {}),
      calculate: async timing => {
        const result = await call('chat.schedule.preview', timing);
        if (disposed || scope !== scopeVersion) return result;
        if (result.notify_on_done_available === true && !notifyNamed) { notifyNamed = true; showNotify(); }
        if (result.model_choice_available === true && !modelNamed) { modelNamed = true; showModel(); }
        showCapabilities();
        return result;
      } }); editorPreview = preview;
    for (const field of [mode, time, frequency, clock, weekday, days, monthDay, cron, timezone]) {
      field.addEventListener('input', () => preview.refresh()); field.addEventListener('change', () => preview.refresh());
    }
    preview.refresh();
    const feedback = node('p', needsCheck ? row ? 'This update was interrupted. Check the saved settings before retrying.' : 'This save was interrupted. Check its original request before creating another schedule.' : ''); feedback.setAttribute('role', 'alert'); feedback.tabIndex = -1; form.append(feedback);
    const editReviewHost = doc.createElement('div'); editReviewHost.className = 'prompt-edit-review'; if (row) form.append(editReviewHost);
    const actions = doc.createElement('div'); actions.dataset.promptScheduleActions = '';
    const save = node('button', row ? 'Save changes' : 'Create schedule'); save.type = 'submit'; actions.append(save);
    const saveIcon = row ? 'save' : 'schedule';
    save.innerHTML = renderActionLabel(saveIcon, row ? 'Save changes' : 'Create schedule');
    const keep = options.recovery ? button(actions, 'Keep draft for later', () => {
      if (busy || disposed) return;
      captureDraft?.(); const id = checkpoint.id();
      if (!checkpoint.keepForLater()) { feedback.textContent = 'Your latest draft could not be confirmed in this tab. Keep this form open and try again.'; keep?.focus(); return; }
      if (!row) keptCreationDraftId = id;
      captureDraft = undefined; closePreview(); editing = false; render('draft-resume:' + id); options.onCreateClosed?.(id);
    }) : undefined;
    const cancel = button(actions, 'Cancel', () => {
      if (busy || disposed) return;
      if (!checkpoint.discard()) { feedback.textContent = 'This recovery copy could not be discarded. Keep this form open and try again.'; cancel.focus(); return; }
      captureDraft = undefined; closePreview(); editing = false; void refresh(); render(copy ? `${copy.schedule_id}:duplicate` : undefined); if (!row && !copy) options.onCreateClosed?.();
    }); form.append(actions);
    const updateControls = () => {
      for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,textarea,select')) {
        if (!editReviewHost.contains(control)) control.disabled = busy || needsCheck;
      }
      mode.disabled = busy || needsCheck || !!row; save.disabled = busy || editChecking || !!row && !needsCheck && (!editChecked || !!editReview || editMissing); cancel.disabled = busy; if (keep) keep.disabled = busy;
      monthDay.disabled = busy || needsCheck || mode.value !== 'recurring' || frequency.value !== 'monthly';
      cancel.hidden = needsCheck && Boolean(options.recovery);
      form.setAttribute('aria-busy', String(busy));
      save.innerHTML = renderActionLabel(saveIcon, busy ? row ? 'Saving changes…' : 'Creating schedule…' : needsCheck ? 'Check save' : row ? 'Save changes' : 'Create schedule');
    };
    const liveEdit = () => !disposed && scope === scopeVersion && editing && form.isConnected;
    const readCurrent = async () => {
      const list = readPromptSchedules(await call('chat.schedules.list', {}));
      if (!liveEdit()) return;
      rows = session ? list.filter(item => item.session_id === session) : list; loaded = true; error = listError = '';
      const current = list.find(item => item.schedule_id === original!.schedule_id);
      // A fresh row is capability evidence even when this server predates
      // timing previews. The persisted original is never used for that.
      if (current?.model_source_id !== undefined) { modelNamed = true; showModel(); }
      if (typeof current?.notify_on_done === 'boolean') { notifyNamed = true; showNotify(); }
      showCapabilities();
      options.onStateChange?.({ rows, loaded, error: listError });
      return current;
    };
    const copyCurrent = (expected: PromptDraftEntry | null): boolean => !options.recovery || !!expected
      && JSON.stringify(options.recovery.get(expected.id)) === JSON.stringify(expected);
    const finishEdit = async (saved: PromptSchedule) => {
      captureDraft = undefined; checkpoint.suspend(); submittedUpdate = undefined; needsCheck = false; closePreview(); editing = false; busy = false;
      rows = [saved, ...rows.filter(item => item.schedule_id !== saved.schedule_id)];
      render(`${saved.schedule_id}:edit`); options.onStateChange?.({ rows, loaded, error: listError });
    };
    const confirmEdit = async (saved: PromptSchedule): Promise<boolean> => {
      const ticket = checkpoint.startAttempt(readValues());
      if (ticket?.blocked) { feedback.textContent = 'The recovery copy changed or could not be updated. Keep this form open and try again.'; return false; }
      checkpoint.settle(ticket, 'confirmed'); await finishEdit(saved); return true;
    };
    const paintEditReview = (focus = false) => {
      if (!row) return;
      editReviewHost.replaceChildren();
      if (editChecking) editReviewHost.append(node('p', 'Checking the saved scheduled prompt…'));
      if (editReview) {
        const comparison = editReview;
        editReviewHost.append(promptEditComparisonView({ document: doc, comparison, disabled: busy || editChecking,
          prepare: () => { void prepareEdit(comparison); } }));
      }
      const recheck = button(editReviewHost, 'Recheck saved prompt', () => { void checkSavedEdit(); }); recheck.disabled = busy || editChecking;
      recheck.dataset.promptRecheck = '';
      if (needsCheck && retryReady && !editReview && !editMissing) {
        button(editReviewHost, 'Retry original save', () => { void submitEdit(true); }).disabled = busy || editChecking;
      }
      if (focus) (editReviewHost.querySelector<HTMLElement>('[data-prompt-comparison-heading]') ?? feedback)?.focus({ preventScroll: true });
      updateControls();
    };
    const acceptCurrent = (current: PromptSchedule | undefined, focus = false) => {
      const state = checkPromptEdit(original!, current, needsCheck ? submittedUpdate : undefined);
      editChecked = true; editMissing = state === 'missing' || state === 'replaced'; retryReady = state === 'unchanged' && needsCheck;
      editReview = state === 'changed' && current ? comparePromptEdits(original!, readValues(), current) : undefined;
      if (state === 'missing') feedback.textContent = 'This scheduled prompt no longer exists. Your local edits are kept; they cannot update another schedule.';
      else if (state === 'replaced') feedback.textContent = 'This recovery copy no longer names the same scheduled prompt. Your local edits are kept.';
      else if (state === 'changed') feedback.textContent = 'The saved scheduled prompt changed. Compare the versions before preparing a draft.';
      else if (needsCheck) feedback.textContent = state === 'matches' ? 'The saved settings match these edits. Choose Check save to confirm and close this copy.'
        : 'The saved settings are still unchanged. Retry original save uses the same request and revision; only one update can apply.';
      else feedback.textContent = '';
      paintEditReview(focus); return state;
    };
    const checkSavedEdit = async (confirm = false) => {
      if (!original || busy || editChecking) return;
      const initiator = doc.activeElement, recheckOwnedFocus = editReviewHost.contains(initiator);
      const mine = ++checkSequence; editChecking = true; paintEditReview();
      try {
        const current = await readCurrent(); if (!liveEdit() || mine !== checkSequence) return;
        const state = acceptCurrent(current);
        if (confirm && state === 'matches' && current) { await confirmEdit(current); return; }
      } catch (failure) {
        if (liveEdit() && mine === checkSequence) { editChecked = false; retryReady = false; feedback.textContent = humanizeRpcError(failure) + ' Your edits are kept. Recheck before saving.'; }
      } finally {
        if (liveEdit() && mine === checkSequence) {
          editChecking = false; paintEditReview();
          if (confirm && editReview && (doc.activeElement === initiator || doc.activeElement === doc.body)) paintEditReview(true);
          else if (recheckOwnedFocus && doc.activeElement === doc.body) (editReviewHost.querySelector<HTMLElement>('[data-prompt-comparison-heading]')
            ?? editReviewHost.querySelector<HTMLElement>('[data-prompt-recheck]'))?.focus({ preventScroll: true });
        }
      }
    };
    const prepareEdit = async (comparison: PromptEditComparison) => {
      if (!original || busy || editChecking || comparison !== editReview) return;
      captureDraft?.();
      if (!flushDraft()) { feedback.textContent = 'Your latest edits could not be kept. Keep this form open and try again.'; return; }
      const expected = checkpoint.current();
      if (!copyCurrent(expected)) { feedback.textContent = 'This recovery copy changed. Your open edits have not replaced it.'; return; }
      busy = true; paintEditReview();
      try {
        const current = await readCurrent(); if (!liveEdit()) return;
        if (!copyCurrent(expected)) throw Error('This recovery copy changed. Reopen its current version before preparing edits.');
        if (!current || promptScheduleIdentity(current) !== promptScheduleIdentity(comparison.current)) { acceptCurrent(current, doc.activeElement === doc.body || form.contains(doc.activeElement)); return; }
        const values = mergePromptEdits(comparison); if (!values) return;
        if (options.recovery && !checkpoint.rebase(current, values)) throw Error('The prepared draft could not be kept. Your previous recovery copy is still available.');
        const prepared = checkpoint.current();
        captureDraft = undefined; checkpoint.suspend(); busy = false;
        // No write to the server: this prepares an editable, freshly based
        // form. Saving remains a separate explicit action and fresh read.
        edit(current, prepared ?? { id: 'pdr_' + crypto.randomUUID(), sourceId: 'scheduled_prompt', original: promptEditOriginal(current),
          revision: 1, updatedAt: Date.now(), status: 'editing', values });
      } catch (failure) { if (liveEdit()) { feedback.textContent = humanizeRpcError(failure); if (doc.activeElement === doc.body || form.contains(doc.activeElement)) feedback.focus({ preventScroll: true }); } }
      finally { if (liveEdit()) { const ownsFocus = doc.activeElement === doc.body || form.contains(doc.activeElement); busy = false; paintEditReview(ownsFocus && !!editReview); } }
    };
    const submitEdit = async (retry = false) => {
      if (!original || busy || editChecking) return;
      if (needsCheck && !retry) { await checkSavedEdit(true); return; }
      let request: PromptScheduleUpdate;
      try {
        if (!retry && (notify.checked && !notifyNamed || model.value && !modelNamed)) throw Error('This server has not confirmed support for your saved choices. Use its defaults explicitly, or keep this draft.');
        if (!title.value.trim() || !prompt.value.trim()) throw Error('Enter a title and a request to run.');
        request = retry && submittedUpdate ? structuredClone(submittedUpdate) : promptDraftUpdate(readValues(), original, { model: modelNamed, notify: notifyNamed });
      } catch (failure) { feedback.textContent = humanizeRpcError(failure); return; }
      const wasChecking = needsCheck;
      let ticket: ReturnType<typeof checkpoint.startAttempt>, dispatched = false;
      busy = true; feedback.textContent = ''; paintEditReview();
      try {
        const current = await readCurrent(); if (!liveEdit()) return;
        const state = checkPromptEdit(original, current, retry ? request : undefined);
        if (state === 'matches' && current && retry) { await confirmEdit(current); return; }
        if (state !== 'unchanged') { acceptCurrent(current, doc.activeElement === doc.body || form.contains(doc.activeElement)); return; }
        submittedUpdate = request; ticket = checkpoint.startAttempt(readValues());
        if (ticket?.blocked) { if (!wasChecking) submittedUpdate = undefined; feedback.textContent = 'The save could not start because its recovery copy changed or could not be updated. Keep this form open and try again.'; return; }
        needsCheck = true; updateControls(); dispatched = true;
        const reply = await call('chat.schedule.update', request);
        const saved = readPromptSchedules([reply])[0];
        if (!saved || checkPromptEdit(original, saved, request) !== 'matches') throw Error('The updated scheduled prompt could not be confirmed.');
        checkpoint.settle(ticket, 'confirmed');
        if (liveEdit()) await finishEdit(saved);
      } catch (failure) {
        if (dispatched) {
          const refused = !wasChecking && ['bad_request', 'invalid_args', 'conflict', 'not_found', 'forbidden', 'unauthorized', 'unknown_method', 'not_configured'].includes(classifyRpcError(failure).code ?? '');
          checkpoint.settle(ticket, refused ? 'refused' : 'unknown'); needsCheck = !refused; if (refused) { submittedUpdate = undefined; editChecked = false; }
        } else editChecked = false;
        if (liveEdit()) feedback.textContent = humanizeRpcError(failure) + (needsCheck ? ' Check the saved settings before retrying this original update.' : ' Your local edits are kept. Recheck the saved prompt before trying again.');
      } finally {
        if (liveEdit()) { busy = false; paintEditReview(); if (doc.activeElement === doc.body || form.contains(doc.activeElement)) (editReviewHost.querySelector<HTMLElement>('[data-prompt-comparison-heading]') ?? feedback).focus({ preventScroll: true }); }
      }
    };
    for (const kind of ['input', 'change']) form.addEventListener(kind, event => {
      if (!editReview || editReviewHost.contains(event.target as Node)) return;
      editReview = comparePromptEdits(original!, readValues(), editReview.current); paintEditReview();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault(); if (busy || disposed || scope !== scopeVersion) return;
      if (row) { void submitEdit(); return; }
      let sent: PromptCreationRequest;
      try {
        if (!needsCheck && (notify.checked && !notifyNamed || model.value && !modelNamed)) {
          feedback.textContent = 'This server has not confirmed support for your saved choices. Use its defaults explicitly, or keep this draft.'; return;
        }
        if (!title.value.trim() || !prompt.value.trim()) { feedback.textContent = 'Enter a title and a request to run.'; (!title.value.trim() ? title : prompt).focus(); return; }
        sent = needsCheck && submitted ? structuredClone(submitted) : promptDraftRequest(readValues(), { model: modelNamed, notify: notifyNamed });
      }
      catch (failure) { feedback.textContent = humanizeRpcError(failure); return; }
      const checking = needsCheck;
      submitted = sent; const ticket = checkpoint.startAttempt(readValues());
      if (ticket?.blocked) { if (!needsCheck) submitted = null; feedback.textContent = 'The save could not start because its recovery copy could not be updated. Keep this form open and try again.'; save.focus(); return; }
      busy = true; feedback.textContent = ''; updateControls();
      void (async () => {
        try {
          const saved = await call('chat.schedule.create', sent);
          {
            if (!saved || !saved.schedule_id || !saved.session_id || saved.managed_by !== undefined
              || saved.title !== sent!.title || saved.prompt !== sent!.prompt || saved.mode !== sent!.mode || saved.time_zone !== sent!.time_zone
              || sent!.mode === 'one_shot' && saved.run_at !== Date.parse(sent!.run_at!)
              || sent!.mode === 'recurring' && saved.cron_expression !== sent!.cron_expression
              || sent!.model_source_id !== undefined && saved.model_source_id !== sent!.model_source_id
              || sent!.notify_on_done !== undefined && saved.notify_on_done !== sent!.notify_on_done) throw new Error('The saved schedule could not be confirmed.');
            checkpoint.settle(ticket, 'confirmed');
          }
          if (disposed || scope !== scopeVersion) return;
          captureDraft = undefined; checkpoint.suspend();
          if (saved) rows = [saved, ...rows.filter(item => item.schedule_id !== saved.schedule_id)];
          closePreview(); editing = false; busy = false;
          // A newly created schedule belongs to its new conversation, not the chat it was created from.
          if (options.compact && saved) {
            const ownsFocus = doc.activeElement === doc.body || host.contains(doc.activeElement);
            content.replaceChildren(node('p', 'Schedule created.'));
            const open = node('a', 'Open scheduled conversation'); open.href = `#chat/session/${encodeURIComponent(saved.session_id)}`; content.append(open);
            if (ownsFocus) open.focus();
          } else await refresh();
          if (disposed || scope !== scopeVersion) return;
          options.onCreateClosed?.();
          if (options.selection) options.openSchedule?.(saved);
        } catch (failure) {
          {
            const code = classifyRpcError(failure).code;
            const refused = !checking && code !== null && ['bad_request', 'invalid_args', 'forbidden', 'unauthorized', 'unknown_method', 'not_configured'].includes(code);
            checkpoint.settle(ticket, refused ? 'refused' : 'unknown'); needsCheck = !refused; if (refused) submitted = null;
          }
          if (!disposed && scope === scopeVersion) feedback.textContent = humanizeRpcError(failure) + (needsCheck
            ? ' Check this original save before creating another schedule.' : ' Your draft is kept; cancel and refresh to check the saved schedule.');
        }
        finally {
          if (scope === scopeVersion) busy = false; updateControls();
          const active = doc.activeElement;
          if (!disposed && scope === scopeVersion && editing && form.isConnected && (!active || active === doc.body || form.contains(active))) save.focus();
        }
      })();
    });
    content.append(form); updateControls(); (needsCheck ? save : title).focus();
    if (row) { paintEditReview(); if (restored) void checkSavedEdit(); }
  };
  const resumeDraft = (id: string, expected?: PromptDraftEntry): boolean => {
    if (disposed || editing || busy || !options.recovery) return false;
    const entry = options.recovery.get(id);
    if (!entry || expected && JSON.stringify(entry) !== JSON.stringify(expected)) return false;
    discarding = undefined; recoveryError = '';
    const original = entry.original;
    edit(original ? { ...original, next_run_at: null, last_run_at: null, last_turn_id: null, last_status: null } : undefined, entry); return true;
  };
  const relevantSession = (id: string) => session ? id === session : rows.some(row => row.session_id === id);
  const unsubs = [options.subscribe?.('chat.session_changed', event => {
    if (event.kind !== 'chat.session_changed' || busy) return;
    runHistory.changed(event.session_id);
    if (event.field === 'queue' && (!session || event.session_id === session)
      || (event.field === 'tool_call' || event.field === 'message') && relevantSession(event.session_id)) void refresh();
  }), ...(['chat.plan_proposed', 'chat.plan_resolved', 'chat.tool_call_completed', 'chat.message_complete'] as const)
    .map(kind => options.subscribe?.(kind, event => { if (!busy && relevantSession(event.session_id)) { runHistory.changed(event.session_id); void refresh(); } }))];
  return {
    setSession(id?: string) {
      if (initialized && session === id) return;
      skips.close(); pauses.close();
      flushDraft(); checkpoint.suspend(); captureDraft = undefined;
      closePreview(); ++scopeVersion; initialized = true; session = id; editing = false; busy = false; confirming = null; rows = []; loaded = false; error = listError = ''; render();
      options.onStateChange?.({ rows, loaded, error: listError }); void refresh();
    },
    setFilter(value: AutomationChip | null) { if (filter !== value) { filter = value; render(); } },
    pending: () => busy,
    hasDraft: () => editing,
    hasSearch: () => Boolean(query.trim()),
    getQuery: () => query,
    setQuery(value: string) { query = value; searchInput.value = value; render(); },
    focusSchedule,
    hasRecoveries: () => { const read = options.recovery?.inspect?.(); return Boolean(recoveryError) || (read ? read.unavailable || read.entries.length > 0 : Boolean(options.recovery?.list().length)); },
    resumeDraft, flush: flushDraft,
    showRecoveryNotice(message: string) { recoveryError = message; render(); },
    protectDraft() {
      if (!editing && !busy) return false;
      if (options.compact) (shell as HTMLDetailsElement).open = true;
      let notice = content.querySelector<HTMLElement>('[role="alert"]');
      if (!notice) { notice = node('p', ''); notice.setAttribute('role', 'alert'); content.prepend(notice); }
      notice.textContent = busy ? 'Wait for this schedule change to finish before switching conversations.'
        : options.recovery ? 'Save, keep for later, or cancel this schedule draft before switching conversations.' : 'Save or cancel this schedule draft before switching conversations.';
      notice.tabIndex = -1; notice.focus();
      return true;
    },
    openCreate() {
      if (editing) content.querySelector<HTMLInputElement>('input')?.focus();
      else edit();
    },
    refresh,
    /** Reuse the list's request fence and repaint before navigating. A stale
     * selection never exposes controls for a changed or replacement schedule. */
    async resolveSchedule(selected: PromptSchedule): Promise<PromptSchedule | null> {
      const pending = refresh(), request = seq;
      await pending;
      if (disposed || request !== seq) return null;
      if (listError) throw new Error(listError);
      const fresh = readPromptSchedules(rows).find(row => row.schedule_id === selected.schedule_id);
      if (!fresh) throw new Error('This scheduled prompt was removed. Coming up has been refreshed.');
      if (promptScheduleIdentity(fresh) !== promptScheduleIdentity(selected))
        throw new Error('This scheduled prompt changed. Review its refreshed details before opening it.');
      return fresh;
    },
    whenLoaded: () => latestRefresh,
    dispose() {
      bulk?.dispose();
      pauses.dispose();
      runHistory.dispose();
      skips.dispose();
      host.removeEventListener('pointerdown', markInteraction, true); host.removeEventListener('keydown', markInteraction, true);
      flushDraft(); checkpoint.suspend(); captureDraft = undefined;
      doc.defaultView?.removeEventListener('pagehide', flushOnLeave); doc.defaultView?.removeEventListener('beforeunload', flushOnLeave);
      disposed = true; closePreview(); ++seq; ++scopeVersion; for (const unsub of unsubs) unsub?.();
      for (const item of preapprovalSections.values()) item.panel?.dispose();
      preapprovalSections.clear(); host.remove();
    },
  };
};
