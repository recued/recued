import { zonedWallClockToEpochMs, type PromptSchedule, type PromptSchedulePauseRequest,
  type PromptSchedulePausePreview, type PromptSchedulePauseResult } from '@recued/contracts';
import { reminderWallClockValue, formatReminderTimePreview } from '../reminders/reminder-time.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { readPromptSchedules } from './prompt-search.js';

export interface PromptPauseClient {
  (method:'chat.schedule.pause_preview',args:PromptSchedulePauseRequest):Promise<PromptSchedulePausePreview>;
  (method:'chat.schedule.pause_until',args:PromptSchedulePauseRequest):Promise<PromptSchedulePauseResult>;
}
const instant=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=8.64e15;
export const promptPausePreset = (days:1|7,now:number,zone:string) => {
  const today=reminderWallClockValue(now,zone).slice(0,10);
  return new Date(Date.parse(today+'T00:00Z')+days*86400000).toISOString().slice(0,10)+'T09:00';
};
type Choice={row:PromptSchedule;value:string;request?:PromptSchedulePauseRequest;preview?:PromptSchedulePausePreview;loading:boolean;error?:string};
/** Preview the chosen instant, and retain an uncertain mutation's exact request
 * in this tab. A later refresh cannot silently choose a different deadline. */
export const createPromptPauseControls=(options:{document:Document;call:PromptPauseClient;busy():boolean;redraw(focus?:string):void;
  refresh():Promise<void>;mutate(work:()=>Promise<void>):Promise<void>;opening():void})=>{
  const doc=options.document,memory=new Map<string,PromptSchedulePauseRequest>();let current:Choice|undefined,epoch=0,disposed=false,timer:ReturnType<typeof setTimeout>|undefined;
  const key=(row:PromptSchedule)=>'recued:prompt-pause:'+encodeURIComponent(row.run_request_scope??row.session_id)+':'+encodeURIComponent(row.schedule_id);
  const read=(row:PromptSchedule)=>{
    const name=key(row);if(memory.has(name))return memory.get(name);
    try{const a=JSON.parse(doc.defaultView?.sessionStorage.getItem(name)??'null') as PromptSchedulePauseRequest;
      if(a&&a.schedule_id===row.schedule_id&&Number.isSafeInteger(a.expected_revision)&&a.expected_revision>0&&instant(a.until_at)){
        const request={schedule_id:a.schedule_id,expected_revision:a.expected_revision,until_at:a.until_at};memory.set(name,request);return request;
      }
    }catch{/* Live revisions still guard every mutation. */}
    return;
  };
  const remember=(row:PromptSchedule,request:PromptSchedulePauseRequest)=>{memory.set(key(row),request);try{doc.defaultView?.sessionStorage.setItem(key(row),JSON.stringify(request));}catch{/* Keep the exact request in memory. */}};
  const forget=(row:PromptSchedule,request:PromptSchedulePauseRequest)=>{
    if(JSON.stringify(read(row))!==JSON.stringify(request))return;
    memory.delete(key(row));try{if(doc.defaultView?.sessionStorage.getItem(key(row))===JSON.stringify(request))doc.defaultView.sessionStorage.removeItem(key(row));}catch{/* Persisted retries remain revision guarded. */}
  };
  const close=()=>{current=undefined;epoch++;};
  const node=<K extends keyof HTMLElementTagNameMap>(tag:K,text:string)=>{const n=doc.createElement(tag);n.textContent=text;return n;};
  const button=(host:HTMLElement,text:string,focus:string,action:()=>void)=>{const b=node('button',text);b.type='button';b.disabled=options.busy();b.dataset.promptFocus=focus;b.addEventListener('click',action);host.append(b);return b;};
  const preview=async(choice:Choice)=>{
    const mine=++epoch;choice.preview=undefined;choice.error=undefined;
    const at=zonedWallClockToEpochMs(choice.value,choice.row.time_zone);
    if(at===null||reminderWallClockValue(at,choice.row.time_zone)!==choice.value||at<=Date.now()){
      choice.loading=false;choice.request=undefined;choice.error='Choose a future time that exists in this prompt’s timezone.';options.redraw();return;
    }
    choice.request={schedule_id:choice.row.schedule_id,expected_revision:choice.row.revision,until_at:at};choice.loading=true;options.redraw();
    try{
      const result=await options.call('chat.schedule.pause_preview',choice.request);
      if(disposed||current!==choice||mine!==epoch)return;
      if(!result||result.schedule_id!==choice.request.schedule_id||result.expected_revision!==choice.request.expected_revision||result.until_at!==at
        ||result.time_zone!==choice.row.time_zone||!instant(result.first_run_at)||result.first_run_at<at)throw Error('The resume time and first run could not be confirmed.');
      choice.preview=result;
    }catch(failure){if(!disposed&&current===choice&&mine===epoch)choice.error=humanizeRpcError(failure);}
    finally{if(!disposed&&current===choice&&mine===epoch){choice.loading=false;options.redraw();}}
  };
  const change=(row:PromptSchedule,request:PromptSchedulePauseRequest)=>{
    if(disposed||options.busy())return;remember(row,request);close();
    void options.mutate(async()=>{
      try{
        const result=await options.call('chat.schedule.pause_until',request),saved=readPromptSchedules([result?.schedule])[0];
        if(!saved||saved.schedule_id!==row.schedule_id||saved.session_id!==row.session_id||result.expected_revision!==request.expected_revision
          ||result.applied_revision!==request.expected_revision+1||saved.revision<result.applied_revision||!['applied','replayed'].includes(result.disposition))
          throw Error('This timed pause could not be confirmed.');
        forget(row,request);
      }catch(failure){
        const definitive=['bad_request','invalid_args','conflict','not_found','unauthorized','forbidden','unknown_method','not_configured'].includes(classifyRpcError(failure).code??'');
        if(definitive){forget(row,request);await options.refresh();}
        throw Error(humanizeRpcError(failure)+(definitive?' Review the current prompt before trying again.':' Check the original pause before choosing another time.'));
      }
    });
  };
  return {
    close,
    render(row:PromptSchedule,card:HTMLElement,actions:HTMLElement){
      if(disposed)return;const prefix=row.schedule_id+':pause:',pending=read(row);
      if(pending){button(actions,'Check timed pause',prefix+'check',()=>change(row,pending));return;}
      if(row.timed_pause===undefined)return;
      button(actions,row.timed_pause?'Change resume time':'Pause until…',prefix+'open',()=>{
        options.opening();current={row,value:row.timed_pause?reminderWallClockValue(row.timed_pause.until_at,row.time_zone):promptPausePreset(1,Date.now(),row.time_zone),loading:false};
        options.redraw(prefix+'time');void preview(current);
      });
      if(current?.row.schedule_id!==row.schedule_id)return;
      const choice=current,group=node('section','');group.className='prompt-schedule-confirm';group.setAttribute('role','region');group.setAttribute('aria-label','Pause recurring prompt');
      const stale=row.revision!==choice.row.revision;
      group.append(node('h4','Pause until'),node('p','Choose the end of the break. The prompt resumes at its normal cadence; missed runs stay skipped.'));
      const label=node('label','Resume time ('+choice.row.time_zone+')'),input=doc.createElement('input');input.type='datetime-local';input.value=choice.value;input.dataset.promptFocus=prefix+'time';
      input.addEventListener('change',()=>{choice.value=input.value;void preview(choice);});label.append(input);group.append(label);
      const presets=node('div','');presets.dataset.promptScheduleActions='';
      for(const [days,text] of [[1,'Tomorrow at 9am'],[7,'Next week at 9am']] as const)button(presets,text,prefix+'preset-'+days,()=>{choice.value=promptPausePreset(days,Date.now(),choice.row.time_zone);void preview(choice);});group.append(presets);
      if(choice.loading){const status=node('p','Checking the first run after the break…');status.setAttribute('role','status');group.append(status);}
      if(choice.preview){
        for(const [text,at] of [['Paused until: ',choice.preview.until_at],['First run: ',choice.preview.first_run_at]] as const){const p=node('p',text),time=node('time',formatReminderTimePreview(at,choice.preview.time_zone));time.dateTime=new Date(at).toISOString();p.append(time);group.append(p);}
        group.append(node('p','Queued runs will be cancelled. A run already in progress can finish, and existing approvals stay in Chat.'));
      }
      if(stale||choice.error){const error=node('p',stale?'This prompt changed. Close this preview and review its current timing.':choice.error!);error.setAttribute('role','alert');group.append(error);}
      button(group,'Keep current timing',prefix+'keep',()=>{close();options.redraw(prefix+'open');});
      const apply=button(group,'Pause this prompt',prefix+'confirm',()=>{if(choice.request)change(row,choice.request);});
      apply.disabled=options.busy()||choice.loading||stale||!!choice.error||!choice.preview||!choice.request||choice.request.until_at<=Date.now();
      if(choice.error&&!stale)button(group,'Retry pause preview',prefix+'retry',()=>{void preview(choice);});card.append(group);
    },
    watch(rows:readonly PromptSchedule[]){clearTimeout(timer);const next=rows.map(row=>row.timed_pause?.until_at).filter((at):at is number=>at!==undefined&&at>Date.now()).sort((a,b)=>a-b)[0];
      if(next!==undefined)timer=setTimeout(()=>{if(!disposed&&!options.busy())void options.refresh();},Math.min(next-Date.now()+5,2147483647));},
    dispose(){disposed=true;close();clearTimeout(timer);},
  };
};
