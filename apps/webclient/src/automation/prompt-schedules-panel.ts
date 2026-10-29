import type { ChatTurnAcceptance, PromptSchedule, PromptScheduleInput, PromptScheduleRunOutcome,
  PromptScheduleRunRequest, PromptScheduleTarget, PromptScheduleUpdate, PromptScheduleTiming, PromptSchedulePreview } from '@recued/contracts';
import { describeCron, zonedWallClockToEpochMs } from '@recued/contracts';
import { stampZone } from '@recued/ui-shared';
import { reminderWallClockValue } from '../data/reminders-surface.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { serializeChatAnswerAddress, serializeChatPlanAddress, serializeChatSessionAddress } from '../shell/route.js';
import { mountPromptSchedulePreview } from './prompt-schedule-preview.js';
import type { AutomationChip } from './by-recipe.js';

export interface PromptSchedulesPanelState {
  readonly rows: readonly PromptSchedule[];
  readonly loaded: boolean;
  readonly error: string;
}

/** Attention survives pausing future runs; the card still explains both states. */
export const promptScheduleChip = (row: PromptSchedule): AutomationChip => {
  if (row.pending_approvals?.count || row.pending_work?.status === 'needs_attention'
    || row.last_outcome?.status === 'needs_approval' || row.last_outcome?.status === 'needs_attention') return 'needs-you';
  if (row.scheduling_issue || ['failed', 'interrupted'].includes(row.last_outcome?.status ?? row.last_status ?? '')) return 'failing';
  return row.enabled ? 'on' : 'off';
};

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

export interface PromptScheduleClient {
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
  onCreateClosed?: () => void;
  onStateChange?: (state: PromptSchedulesPanelState) => void;
}) => {
  const { host, call } = options, doc = host.ownerDocument;
  const zone = stampZone();
  if (!doc.head.querySelector('[data-prompt-schedule-styles]')) {
    const style = doc.createElement('style'); style.dataset.promptScheduleStyles = '';
    style.textContent = `[data-prompt-schedules]{padding:0;min-width:0;font-size:14px;color:var(--fg,inherit);line-height:1.5}
      [data-prompt-schedules] [hidden]{display:none!important}
      [data-prompt-schedules] summary{cursor:pointer;font-weight:600;padding:10px 0}
      [data-prompt-schedules] h2{font-size:17px;font-weight:650;letter-spacing:-.02em;margin:0}
      [data-prompt-schedules] .prompt-schedule-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin:0 0 16px}
      [data-prompt-schedules] .prompt-schedule-toolbar>div{display:flex;gap:8px}
      [data-prompt-schedules] article{border:1px solid var(--border,#dfe3e8);border-radius:12px;background:var(--surface,#fff);padding:20px;margin:0 0 12px}
      [data-prompt-schedules] .prompt-schedule-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px}
      [data-prompt-schedules] h3{font-size:15px;font-weight:650;margin:0;overflow-wrap:anywhere}
      [data-prompt-schedules] .prompt-schedule-status{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;padding:3px 9px;border-radius:999px;background:var(--surface-subtle,#f3f4f6);color:var(--fg-muted,#606873)}
      [data-prompt-schedules] .prompt-schedule-status::before{content:'';width:5px;height:5px;background:currentColor;border-radius:50%}
      [data-prompt-schedules] .prompt-schedule-status[data-active=true]{color:var(--accent,#087e96);background:var(--accent-weak,#e6f4f7)}
      [data-prompt-schedules] p{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}
      [data-prompt-schedules] .prompt-schedule-cadence{color:var(--fg-muted,#606873);font-size:12px;margin:4px 0 12px}
      [data-prompt-schedules] .prompt-schedule-request{line-height:1.65;margin:0 0 16px}
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
      [data-prompt-schedules] form{box-sizing:border-box;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 20px;max-width:760px;margin:16px 0 0}
      [data-prompt-schedules] form>p,[data-prompt-schedules] form>[data-prompt-schedule-actions],[data-prompt-schedules] .prompt-schedule-field-wide{grid-column:1/-1}
      [data-prompt-schedules] label{display:grid;align-content:start;gap:7px;min-width:0;font-size:12px;font-weight:600}
      [data-prompt-schedules] input,[data-prompt-schedules] textarea,[data-prompt-schedules] select{font:inherit;font-size:14px;font-weight:400;color:inherit;background:var(--surface,#fff);border:1px solid var(--border,#dfe3e8);border-radius:8px;padding:10px 12px;box-sizing:border-box;width:100%;min-width:0;min-height:42px}
      [data-prompt-schedules] textarea{min-height:112px;resize:vertical;line-height:1.6}
      [data-prompt-schedules] form>p{margin:0}
      [data-prompt-schedules] [role=alert]:empty{display:none}
      [data-prompt-schedules] [role=alert]:not(:empty){color:var(--danger,#b42318)}
      [data-prompt-schedules] button{font:inherit;font-size:12px;font-weight:600;color:inherit;background:var(--surface,#fff);border:1px solid var(--border,#dfe3e8);border-radius:7px;padding:7px 11px;min-height:36px;cursor:pointer}
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
      @media(max-width:600px){[data-prompt-schedules] form{grid-template-columns:minmax(0,1fr)}[data-prompt-schedules] article{padding:16px}[data-prompt-schedules] button{min-height:44px}[data-prompt-schedules] .prompt-schedule-card-actions>a{flex-basis:100%;justify-content:flex-start;min-height:36px}}
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
  let editorPreview: ReturnType<typeof mountPromptSchedulePreview> | undefined;
  const closePreview = () => { editorPreview?.dispose(); editorPreview = undefined; };
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
  const button = (parent: HTMLElement, label: string, action: () => void) => {
    const b = node('button', label); b.type = 'button'; b.disabled = busy;
    b.addEventListener('click', action); parent.append(b); return b;
  };
  const format = (at: number, timeZone: string) => new Date(at).toLocaleString(undefined, {
    timeZone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const render = (restoreFocus?: string) => {
    if (disposed || editing) return;
    const focus = restoreFocus ?? (doc.activeElement && host.contains?.(doc.activeElement)
      ? (doc.activeElement as HTMLElement).dataset.promptFocus : undefined);
    content.replaceChildren(); host.setAttribute('aria-busy', String(busy));
    const shown = filter === null ? rows : rows.filter(row => promptScheduleChip(row) === filter);
    heading.textContent = shown.length ? `Scheduled prompts (${shown.length})` : 'Scheduled prompts';
    const controls = doc.createElement('div');
    if (!options.hideCreate) button(controls, 'Schedule a prompt', () => edit()).dataset.promptFocus = 'create';
    button(controls, 'Refresh', () => { void refresh(); }).dataset.promptFocus = 'refresh';
    if (options.compact) { controls.className = 'prompt-schedule-toolbar'; content.append(controls); }
    else toolbar.replaceChildren(heading, controls);
    if (error) { const p = node('p', error); p.setAttribute('role', 'alert'); content.append(p); }
    if (!loaded && !error) content.append(node('p', 'Loading scheduled prompts…'));
    for (const row of shown) {
      const card = doc.createElement('article'); card.dataset.scheduleId = row.schedule_id;
      card.setAttribute('aria-label', row.title);
      const status = row.enabled ? 'Active' : row.mode === 'one_shot' && row.last_run_at !== null ? 'No future runs' : 'Paused';
      const cardHeading = doc.createElement('div'); cardHeading.className = 'prompt-schedule-heading';
      const badge = node('span', status); badge.className = 'prompt-schedule-status';
      badge.dataset.active = String(row.enabled);
      cardHeading.append(node('h3', row.title), badge); card.append(cardHeading);
      const when = row.mode === 'one_shot' ? format(row.run_at!, row.time_zone) : describeCron(row.cron_expression!);
      const cadence = node('p', `${when} · ${row.time_zone.replaceAll('_', ' ')}`); cadence.className = 'prompt-schedule-cadence';
      const request = node('p', row.prompt); request.className = 'prompt-schedule-request'; card.append(cadence, request);
      const facts = doc.createElement('dl'); facts.className = 'prompt-schedule-facts';
      const fact = (label: string, value: string) => { const item = doc.createElement('div'); item.append(node('dt', label), node('dd', value)); facts.append(item); };
      if (row.next_run_at !== null) fact('Next run', format(row.next_run_at, row.time_zone));
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
        });
        run.dataset.promptFocus = `${row.schedule_id}:run`;
        run.disabled = busy || !row.run_now_available && !retry;
        run.title = row.run_now_available || retry ? 'Run the saved request once; keep this schedule unchanged.'
          : 'Finish or review the waiting run first.';
      }
      const action = (verb: 'pause' | 'resume' | 'remove', revision = row.revision) => { void mutate(async () => {
        await call(`chat.schedule.${verb}`, { schedule_id: row.schedule_id, expected_revision: revision });
      }); };
      if (row.enabled || row.last_status === 'queued' || row.mode === 'recurring' || (row.run_at ?? 0) > Date.now()) {
        const canPause = row.enabled || row.last_status === 'queued';
        const toggle = button(actions, canPause ? 'Pause' : 'Resume', () => action(canPause ? 'pause' : 'resume'));
        toggle.dataset.promptFocus = `${row.schedule_id}:toggle`;
      }
      button(actions, 'Edit', () => edit(row)).dataset.promptFocus = `${row.schedule_id}:edit`;
      const remove = button(actions, 'Remove', () => {
        confirming = { id: row.schedule_id, revision: row.revision }; render(`${row.schedule_id}:keep`);
      }); remove.dataset.promptFocus = `${row.schedule_id}:remove`; remove.className = 'prompt-schedule-remove';
      card.append(actions);
      if (confirming?.id === row.schedule_id) {
        const revision = confirming.revision;
        const confirm = node('p', 'Remove this schedule? Its conversation stays. A turn already running can finish.');
        confirm.className = 'prompt-schedule-confirm';
        button(confirm, 'Keep schedule', () => { confirming = null; render(`${row.schedule_id}:remove`); }).dataset.promptFocus = `${row.schedule_id}:keep`;
        button(confirm, 'Remove schedule', () => action('remove', revision)).dataset.promptFocus = `${row.schedule_id}:confirm`;
        card.append(confirm);
      }
      content.append(card);
    }
    if (loaded && !shown.length) { const empty = node('p', filter !== null ? 'No scheduled prompts match this filter.' : options.compact ? 'No scheduled prompt is linked to this conversation.' : 'Run an AI request once or on a recurring schedule. Each schedule has its own conversation.'); empty.className = 'prompt-schedule-empty'; content.append(empty); }
    if (shown.length) { const note = node('p', 'Chatting in a schedule’s conversation does not change the saved request. Pausing cancels queued runs; a running turn can finish.'); note.className = 'prompt-schedule-note'; content.append(note); }
    if (focus) (Array.from(shell.querySelectorAll<HTMLElement>('[data-prompt-focus]')).find(el => el.dataset.promptFocus === focus)
      ?? shell.querySelector<HTMLElement>('[data-prompt-focus="refresh"]'))?.focus({ preventScroll: true });
  };
  const refresh = async () => {
    const request = ++seq;
    try {
      const result = await call('chat.schedules.list', session ? { session_id: session } : {});
      if (disposed || request !== seq) return;
      if (!Array.isArray(result)) throw new Error('Scheduled prompts are unavailable on this server.');
      rows = result; loaded = true; error = listError = '';
    } catch (failure) { if (!disposed && request === seq) error = listError = humanizeRpcError(failure); }
    if (!disposed && request === seq) {
      render();
      if (!busy) options.onStateChange?.({ rows, loaded, error: listError });
    }
  };
  const mutate = async (work: () => Promise<void>) => {
    if (busy || disposed) return;
    const scope = scopeVersion;
    const focus = (doc.activeElement as HTMLElement | null)?.dataset?.promptFocus;
    busy = true; error = ''; render();
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
  const edit = (row?: PromptSchedule) => {
    if (busy || disposed) return; closePreview(); editing = true; confirming = null; ++seq; content.replaceChildren();
    const scope = scopeVersion;
    if (options.compact) (shell as HTMLDetailsElement).open = true;
    if (!options.compact) { heading.textContent = row ? 'Edit scheduled prompt' : options.hideCreate ? 'Prompt details' : 'New scheduled prompt'; toolbar.replaceChildren(heading); }
    const form = doc.createElement('form'); const creation_id = crypto.randomUUID();
    const field = (label: string, el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
      const l = doc.createElement('label'), caption = node('span', label); caption.id = `schedule-field-${crypto.randomUUID()}`;
      el.setAttribute('aria-labelledby', caption.id); l.append(caption, el); form.append(l); return el;
    };
    const title = doc.createElement('input'); title.value = row?.title ?? ''; title.placeholder = 'e.g. Morning inbox briefing'; title.maxLength = 160; title.required = true; field('Title', title).parentElement!.className = 'prompt-schedule-field-wide';
    const prompt = doc.createElement('textarea'); prompt.value = row?.prompt ?? ''; prompt.placeholder = 'Describe what you want Recued to do, including the accounts or projects to use.'; prompt.maxLength = 32000; prompt.required = true; field('Request to run', prompt).parentElement!.className = 'prompt-schedule-field-wide';
    const help = node('p', 'Each schedule uses its own conversation and your current tool permissions. Actions that need your approval will still ask.'); help.className = 'prompt-schedule-note'; form.append(help);
    const mode = doc.createElement('select');
    for (const [value, label] of [['one_shot', 'Once'], ['recurring', 'Recurring']]) { const option = node('option', label!); option.value = value!; mode.append(option); }
    mode.value = row?.mode ?? 'one_shot'; mode.disabled = !!row; field('Run', mode);
    const oneOffZone = row?.mode === 'one_shot' ? row.time_zone : zone;
    const initialTime = reminderWallClockValue(row?.run_at ?? Date.now() + 3600000, oneOffZone);
    const time = doc.createElement('input'); time.type = 'datetime-local'; time.value = initialTime; field(`Date and time (${oneOffZone})`, time);
    const timing = /^(\d+) (\d+) \* \* (\*|1-5|[0-6])$/.exec(row?.cron_expression ?? '0 9 * * *');
    const frequency = doc.createElement('select');
    for (const [value, label] of [['daily', 'Every day'], ['weekdays', 'Every weekday'], ['weekly', 'Every week'], ['custom', 'Custom schedule']]) {
      const option = node('option', label!); option.value = value!; frequency.append(option);
    }
    frequency.value = !timing ? 'custom' : timing[3] === '*' ? 'daily' : timing[3] === '1-5' ? 'weekdays' : 'weekly'; field('Repeat', frequency);
    const clock = doc.createElement('input'); clock.type = 'time'; clock.value = timing ? `${timing[2]!.padStart(2, '0')}:${timing[1]!.padStart(2, '0')}` : '09:00'; field('Time', clock);
    const weekday = doc.createElement('select');
    ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].forEach((day, i) => {
      const option = node('option', day); option.value = String(i); weekday.append(option);
    });
    weekday.value = timing && /^[0-6]$/.test(timing[3]!) ? timing[3]! : '1'; field('Day of week', weekday);
    const cron = doc.createElement('input'); cron.value = row?.cron_expression ?? '0 9 * * *'; field('Custom schedule (cron)', cron);
    const cronHelp = node('p', 'Use five cron fields, with at least five minutes between occurrences.'); form.append(cronHelp);
    const timezone = doc.createElement('input'); timezone.value = row?.time_zone ?? zone; field('Recurring timezone', timezone);
    const showTiming = () => {
      const recurring = mode.value === 'recurring';
      time.parentElement!.hidden = recurring; frequency.parentElement!.hidden = !recurring;
      clock.parentElement!.hidden = !recurring || frequency.value === 'custom';
      weekday.parentElement!.hidden = !recurring || frequency.value !== 'weekly';
      cron.parentElement!.hidden = !recurring || frequency.value !== 'custom'; cronHelp.hidden = cron.parentElement!.hidden;
      timezone.parentElement!.hidden = !recurring;
      time.required = !recurring; clock.required = recurring && frequency.value !== 'custom';
      cron.required = recurring && frequency.value === 'custom'; timezone.required = recurring;
    };
    mode.addEventListener('change', showTiming); frequency.addEventListener('change', showTiming); showTiming();
    const readTiming = (): PromptScheduleTiming => {
      if (mode.value === 'one_shot') {
        const at = row?.mode === 'one_shot' && time.value === initialTime
          ? row.run_at! : zonedWallClockToEpochMs(time.value, oneOffZone);
        if (at === null || !Number.isFinite(at) || reminderWallClockValue(at, oneOffZone) !== time.value) throw new Error('Choose a valid local date and time.');
        return { mode: 'one_shot', time_zone: oneOffZone, run_at: new Date(at).toISOString() };
      }
      const [hour, minute] = clock.value.split(':').map(Number);
      const expression = frequency.value === 'custom' ? cron.value : `${minute} ${hour} * * ${frequency.value === 'daily' ? '*' : frequency.value === 'weekdays' ? '1-5' : weekday.value}`;
      return { mode: 'recurring', time_zone: timezone.value, cron_expression: expression };
    };
    const previewHost = doc.createElement('section'); form.append(previewHost);
    const preview = mountPromptSchedulePreview({ host: previewHost, readTiming, paused: row?.enabled === false,
      ...(row?.mode === 'one_shot' && !row.enabled ? { inactiveOneOffAt: row.run_at! } : {}),
      calculate: timing => call('chat.schedule.preview', timing) }); editorPreview = preview;
    for (const field of [mode, time, frequency, clock, weekday, cron, timezone]) {
      field.addEventListener('input', () => preview.refresh()); field.addEventListener('change', () => preview.refresh());
    }
    preview.refresh();
    const feedback = node('p', ''); feedback.setAttribute('role', 'alert'); form.append(feedback);
    const actions = doc.createElement('div'); actions.dataset.promptScheduleActions = '';
    const save = node('button', row ? 'Save changes' : 'Create schedule'); save.type = 'submit'; actions.append(save);
    const cancel = button(actions, 'Cancel', () => {
      closePreview(); editing = false; void refresh(); render(); if (!row) options.onCreateClosed?.();
    }); form.append(actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault(); if (busy || disposed || scope !== scopeVersion) return;
      let input: PromptScheduleInput;
      try { input = { title: title.value, prompt: prompt.value, ...readTiming() }; }
      catch (failure) { feedback.textContent = humanizeRpcError(failure); return; }
      busy = true; save.disabled = true; cancel.disabled = true; feedback.textContent = '';
      form.setAttribute('aria-busy', 'true'); save.textContent = row ? 'Saving changes…' : 'Creating schedule…';
      for (const input of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,textarea,select')) input.disabled = true;
      void (async () => {
        try {
          const { mode: _mode, ...changes } = input;
          const saved = row ? await call('chat.schedule.update', { ...changes, schedule_id: row.schedule_id, expected_revision: row.revision })
            : await call('chat.schedule.create', { ...input, creation_id });
          if (disposed || scope !== scopeVersion) return;
          closePreview(); editing = false; busy = false;
          // A newly created schedule belongs to its new conversation, not the chat it was created from.
          if (options.compact && saved && !row) {
            const ownsFocus = doc.activeElement === doc.body || host.contains(doc.activeElement);
            content.replaceChildren(node('p', 'Schedule created.'));
            const open = node('a', 'Open scheduled conversation'); open.href = `#chat/session/${encodeURIComponent(saved.session_id)}`; content.append(open);
            if (ownsFocus) open.focus();
          } else await refresh();
          if (disposed || scope !== scopeVersion) return;
          if (row) render(doc.activeElement === doc.body || host.contains(doc.activeElement) ? `${row.schedule_id}:edit` : undefined);
          if (!row) options.onCreateClosed?.();
        } catch (failure) { if (!disposed && scope === scopeVersion) feedback.textContent = humanizeRpcError(failure) + ' Your draft is kept; cancel and refresh to check the saved schedule.'; }
        finally { if (scope === scopeVersion) busy = false; save.disabled = false; cancel.disabled = false;
          form.setAttribute('aria-busy', 'false'); save.textContent = row ? 'Save changes' : 'Create schedule';
          for (const input of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,textarea,select')) input.disabled = false;
          mode.disabled = !!row;
        }
      })();
    });
    content.append(form); title.focus();
  };
  const relevantSession = (id: string) => session ? id === session : rows.some(row => row.session_id === id);
  const unsubs = [options.subscribe?.('chat.session_changed', event => {
    if (event.kind !== 'chat.session_changed' || busy) return;
    if (event.field === 'queue' && (!session || event.session_id === session)
      || (event.field === 'tool_call' || event.field === 'message') && relevantSession(event.session_id)) void refresh();
  }), ...(['chat.plan_proposed', 'chat.plan_resolved', 'chat.tool_call_completed', 'chat.message_complete'] as const)
    .map(kind => options.subscribe?.(kind, event => { if (!busy && relevantSession(event.session_id)) void refresh(); }))];
  return {
    setSession(id?: string) {
      if (initialized && session === id) return;
      closePreview(); ++scopeVersion; initialized = true; session = id; editing = false; busy = false; confirming = null; rows = []; loaded = false; error = listError = ''; render();
      options.onStateChange?.({ rows, loaded, error: listError }); void refresh();
    },
    setFilter(value: AutomationChip | null) { if (filter !== value) { filter = value; render(); } },
    pending: () => busy,
    hasDraft: () => editing,
    protectDraft() {
      if (!editing && !busy) return false;
      if (options.compact) (shell as HTMLDetailsElement).open = true;
      let notice = content.querySelector<HTMLElement>('[role="alert"]');
      if (!notice) { notice = node('p', ''); notice.setAttribute('role', 'alert'); content.prepend(notice); }
      notice.textContent = busy ? 'Wait for this schedule change to finish before switching conversations.'
        : 'Save or cancel this schedule draft before switching conversations.';
      notice.tabIndex = -1; notice.focus();
      return true;
    },
    openCreate() {
      if (editing) content.querySelector<HTMLInputElement>('input')?.focus();
      else edit();
    },
    refresh,
    dispose() { disposed = true; closePreview(); ++seq; ++scopeVersion; for (const unsub of unsubs) unsub?.(); host.remove(); },
  };
};
