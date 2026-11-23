import type { PromptSchedule, PromptScheduleRun, PromptScheduleRunsPage, PromptScheduleRunsRequest } from '@recued/contracts';
import { serializeChatAnswerAddress, serializeChatPlanAddress, serializeChatSessionAddress } from '../shell/route.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';

export interface PromptRunsClient { (method: 'chat.schedule.runs.list', args: PromptScheduleRunsRequest): Promise<PromptScheduleRunsPage> }
const statuses = new Set(['queued','running','cancelling','finished','needs_approval','failed','interrupted','cancelled','withdrawn','needs_attention']);
const reasons = new Set(['turn_failed','tool_failed','outcome_unknown','action_held','awaiting_execution','approval_expired','approval_declined']);
const labels: Record<PromptScheduleRun['outcome']['status'], string> = { queued:'Queued',running:'Running',cancelling:'Stopping',finished:'Finished',needs_approval:'Needs approval',
  failed:'Failed',interrupted:'Interrupted',cancelled:'Cancelled',withdrawn:'Withdrawn',needs_attention:'Needs attention' };
const id = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 300;
const at = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 8.64e15;
/** Reject wrong targets and incomplete pages before replacing a confirmed list. */
export const readPromptRunsPage = (input: unknown, row: Pick<PromptSchedule,'schedule_id'|'session_id'>): PromptScheduleRunsPage => {
  const page = input as PromptScheduleRunsPage;
  const invalid = (): never => { throw Error('The recent runs could not be confirmed. Refresh and try again.'); };
  if (!page || page.schedule_id !== row.schedule_id || page.session_id !== row.session_id || !Array.isArray(page.runs) || page.runs.length > 10
    || page.next_cursor !== null && (typeof page.next_cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(page.next_cursor))
    || page.next_cursor !== null && page.runs.length !== 10) return invalid();
  const seen = new Set<string>();
  for (const run of page.runs) {
    if (!run || !id(run.occurrence_id) || seen.has(run.occurrence_id) || run.turn_id !== null && !id(run.turn_id)
      || !Number.isSafeInteger(run.revision) || run.revision < 1 || !['scheduled','manual'].includes(run.trigger)
      || !at(run.due_at) || run.queued_at !== null && !at(run.queued_at) || typeof run.time_zone !== 'string' || run.time_zone.length > 100
      || !run.outcome || !statuses.has(run.outcome.status) || run.outcome.reason !== undefined && !reasons.has(run.outcome.reason)
      || run.outcome.message_id !== undefined && !id(run.outcome.message_id) || run.outcome.plan_id !== undefined && !id(run.outcome.plan_id)) return invalid();
    try { new Intl.DateTimeFormat('en', { timeZone:run.time_zone }).format(0); } catch { return invalid(); }
    seen.add(run.occurrence_id);
  }
  return structuredClone(page);
};

type State = { row:PromptSchedule; host:HTMLDetailsElement; summary:HTMLElement; body:HTMLElement; list:HTMLOListElement;
  status:HTMLElement; error:HTMLElement; refresh:HTMLButtonElement; more:HTMLButtonElement;
  runs:PromptScheduleRun[]; cursor:string|null; loaded:boolean; loading:'refresh'|'more'|null; epoch:number; activity:number; stale:boolean; stamp:string };
const stamp = (row:PromptSchedule) => JSON.stringify([row.last_turn_id,row.last_run_at,row.last_status,row.last_outcome,row.pending_approvals,row.pending_work]);
/** Stable disclosure nodes survive card refreshes. Only explicit Refresh resets
 * paging; background activity leaves older pages in place with a notice. */
export const createPromptRunsView = (options:{ document:Document; call:PromptRunsClient; busy():boolean }) => {
  const doc = options.document, states = new Map<string,State>(); let disposed = false;
  const node = <K extends keyof HTMLElementTagNameMap>(tag:K,text:string) => { const el = doc.createElement(tag); el.textContent = text; return el; };
  const format = (value:number,zone:string) => new Date(value).toLocaleString(undefined,{ timeZone:zone,year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'shortOffset' });
  const focusKey = (state:State,part:string) => state.row.schedule_id+':history:'+part;
  const item = (state:State,run:PromptScheduleRun) => {
    const li = doc.createElement('li'); li.dataset.promptRunId = run.occurrence_id;
    const heading = doc.createElement('div'); heading.append(node('strong',labels[run.outcome.status]),node('span',run.trigger==='manual'?'Run now':'Scheduled'));
    const time = doc.createElement('time'); time.dateTime = new Date(run.queued_at??run.due_at).toISOString(); time.textContent = format(run.queued_at??run.due_at,run.time_zone);
    const timing = doc.createElement('p'); timing.append(time); li.append(heading,timing);
    if (run.trigger==='scheduled' && run.queued_at!==null && run.queued_at!==run.due_at) li.append(node('p','Scheduled for '+format(run.due_at,run.time_zone)));
    if (run.turn_id===null) li.append(node('p','Queue admission was not confirmed. Review the conversation before starting another run.'));
    const link = node('a',run.outcome.status==='needs_approval'?'Review approval':run.outcome.plan_id?'View action':'Open run');
    link.href = run.outcome.plan_id ? serializeChatPlanAddress({ sessionId:state.row.session_id,planId:run.outcome.plan_id,
      ...(run.outcome.message_id?{ messageId:run.outcome.message_id }:{}) }) : run.outcome.message_id
      ? serializeChatAnswerAddress({ sessionId:state.row.session_id,messageId:run.outcome.message_id }) : serializeChatSessionAddress({ sessionId:state.row.session_id });
    link.dataset.promptFocus = focusKey(state,run.occurrence_id); li.append(link); return li;
  };
  const paint = (state:State,renderItems=false) => {
    state.body.setAttribute('aria-label','Recent runs for '+state.row.title); state.body.setAttribute('aria-busy',String(state.loading!==null));
    state.status.textContent = state.loading==='more'?'Loading older runs…':state.loading==='refresh'?'Loading recent runs…':state.stale?'Run activity changed. Refresh to update this list.':state.loaded?state.runs.length?`${state.runs.length} recorded ${state.runs.length===1?'run':'runs'} loaded · newest first`:'No runs recorded for this prompt.':'';
    state.refresh.disabled = options.busy() || state.loading==='refresh'; state.refresh.textContent = state.loading==='refresh'?'Refreshing…':'Refresh runs';
    state.more.hidden = state.cursor===null; state.more.disabled = options.busy() || state.loading!==null; state.more.textContent = state.loading==='more'?'Loading older runs…':'Load more runs';
    if (renderItems) state.list.replaceChildren(...state.runs.map(run=>item(state,run)));
  };
  const load = async (state:State,kind:'refresh'|'more',trigger?:HTMLButtonElement) => {
    if (disposed || options.busy() || kind==='more' && (state.loading!==null || state.cursor===null)) return;
    const epoch = ++state.epoch, activity = state.activity, cursor = kind==='more'?state.cursor:undefined;
    const triggeredWithFocus = trigger!==undefined && doc.activeElement===trigger;
    const target = { schedule_id:state.row.schedule_id,...(cursor?{ cursor }:{}) };
    state.loading=kind; state.error.textContent=''; paint(state);
    try {
      const page = readPromptRunsPage(await options.call('chat.schedule.runs.list',target),state.row);
      if (disposed || epoch!==state.epoch || states.get(state.row.schedule_id)!==state) return;
      if (kind==='more' && (page.next_cursor===cursor || page.runs.some(run=>state.runs.some(old=>old.occurrence_id===run.occurrence_id))))
        throw Error('These older runs changed. Refresh recent runs before loading more.');
      const focus = triggeredWithFocus && (doc.activeElement===trigger || doc.activeElement===doc.body);
      state.runs = kind==='more'?[...state.runs,...page.runs]:page.runs; state.cursor=page.next_cursor; state.loaded=true;
      if (kind==='refresh') state.stale=state.activity!==activity;
      if (kind==='more') { state.list.append(...page.runs.map(run=>item(state,run))); paint(state); }
      else paint(state,true);
      if (kind==='more' && focus && page.runs[0]) Array.from(state.list.querySelectorAll<HTMLElement>('[data-prompt-focus]'))
        .find(el=>el.dataset.promptFocus===focusKey(state,page.runs[0]!.occurrence_id))?.focus({ preventScroll:true });
    } catch (failure) {
      if (!disposed && epoch===state.epoch && states.get(state.row.schedule_id)===state) {
        const code = classifyRpcError(failure).code; state.error.textContent = code==='unknown_method'||code==='not_configured'?'Recent runs are unavailable on this server.':humanizeRpcError(failure);
      }
    } finally { if (!disposed && epoch===state.epoch && states.get(state.row.schedule_id)===state) { state.loading=null; paint(state); } }
  };
  return {
    section(row:PromptSchedule):HTMLElement|undefined {
      if (!row.run_history_available || disposed) return;
      let state = states.get(row.schedule_id);
      if (state && (state.row.session_id!==row.session_id || state.row.created_at!==row.created_at)) { state.epoch++; states.delete(row.schedule_id); state=undefined; }
      if (!state) {
        const host = doc.createElement('details'),summary=node('summary','Recent runs'); host.className='prompt-run-history';
        summary.dataset.promptFocus=row.schedule_id+':history:summary'; host.append(summary);
        const body=doc.createElement('section'); body.setAttribute('role','region'); const status=node('p',''); status.setAttribute('role','status');
        const error=node('p',''); error.setAttribute('role','alert'); const list=doc.createElement('ol');
        const actions=doc.createElement('div'); actions.dataset.promptScheduleActions='';
        const refresh=node('button','Refresh runs'),more=node('button','Load more runs'); refresh.type=more.type='button';
        refresh.dataset.promptFocus=row.schedule_id+':history:refresh';more.dataset.promptFocus=row.schedule_id+':history:more';actions.append(refresh,more);body.append(status,error,list,actions);host.append(body);
        state={ row,host,summary,body,list,status,error,refresh,more,runs:[],cursor:null,loaded:false,loading:null,epoch:0,activity:0,stale:false,stamp:stamp(row) }; states.set(row.schedule_id,state);
        const kept=state;
        host.addEventListener('toggle',()=>{ if (host.open && !kept.loaded && kept.loading===null) void load(kept,'refresh'); });
        refresh.addEventListener('click',()=>{ void load(kept,'refresh',refresh); });more.addEventListener('click',()=>{ void load(kept,'more',more); });
      }
      const nextStamp=stamp(row); if (state.stamp!==nextStamp) { state.activity++;state.stale=true;state.stamp=nextStamp; }
      state.row=row; paint(state); return state.host;
    },
    changed(session:string) { for (const state of states.values()) if (state.row.session_id===session) { state.activity++;state.stale=true;paint(state); } },
    retain(rows:readonly PromptSchedule[]) { const ids=new Set(rows.map(row=>row.schedule_id));for (const [key,state] of states) if (!ids.has(key)) { state.epoch++;states.delete(key); } },
    dispose() { disposed=true;for (const state of states.values()) state.epoch++;states.clear(); },
  };
};
