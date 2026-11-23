import { PROMPT_SCHEDULE_BULK_MAX, type PromptSchedule, type PromptScheduleBulkAction, type PromptScheduleBulkApplyRequest,
  type PromptScheduleBulkPreview, type PromptScheduleBulkPreviewRequest, type PromptScheduleBulkOutcome, type PromptScheduleBulkResult } from '@recued/contracts';
import { formatReminderTimePreview } from '../reminders/reminder-time.js';
import { promptPausePreset } from './prompt-pause-controls.js';
import { readPromptSchedules } from './prompt-search.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export interface PromptBulkClient {
  (method:'chat.schedules.bulk.preview',args:PromptScheduleBulkPreviewRequest):Promise<PromptScheduleBulkPreview>;
  (method:'chat.schedules.bulk.apply',args:PromptScheduleBulkApplyRequest):Promise<PromptScheduleBulkResult>;
}
const token=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const instant=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=8.64e15;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export const readPromptBulkRequest=(raw:unknown):PromptScheduleBulkApplyRequest=>{
  const r=raw as PromptScheduleBulkApplyRequest;
  if(!r||typeof r.request_id!=='string'||!/^[0-9a-f-]{36}$/i.test(r.request_id)||!r.action||!['pause','resume','pause_until'].includes(r.action.kind)
    ||r.action.kind==='pause_until'&&(typeof r.action.local_time!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(r.action.local_time))
    ||!Array.isArray(r.items)||!r.items.length||r.items.length>PROMPT_SCHEDULE_BULK_MAX||new Set(r.items.map(i=>i?.schedule_id)).size!==r.items.length
    ||r.items.some(i=>!i||typeof i.schedule_id!=='string'||!i.schedule_id||i.schedule_id.length>100||!token(i.review_token)))throw Error('The original bulk change could not be read.');
  return structuredClone(r);
};
export const readPromptBulkResult=(raw:unknown,ids:readonly string[]):PromptScheduleBulkResult=>{
  const r=raw as PromptScheduleBulkResult;
  if(!r||!Array.isArray(r.items)||r.items.length!==ids.length||new Set(r.items.map(i=>i?.schedule_id)).size!==ids.length
    ||r.items.some(i=>!i||!ids.includes(i.schedule_id)||!['applied','failed','needs_review'].includes(i.status)||typeof i.message!=='string'||i.message.length>2000
      ||i.replayed!==undefined&&i.replayed!==true))throw Error('The bulk change results could not be confirmed.');
  return structuredClone(r);
};
type Review={action:PromptScheduleBulkAction;ids:string[];preview?:PromptScheduleBulkPreview;request?:PromptScheduleBulkApplyRequest;
  outcomes:Map<string,PromptScheduleBulkOutcome>;loading:boolean;attempted:boolean;error?:string};

/** Selection is separate from an immutable review. An uncertain batch remains
 * recoverable in this tab; only its unresolved original items are retried. */
export const createPromptBulkControls=(options:{document:Document;call:PromptBulkClient;busy():boolean;redraw(focus?:string):void;
  mutate(work:()=>Promise<void>):Promise<void>;opening():void;storagePrefix?:string;selectionLabel?:(count:number)=>string;applying?:()=>boolean})=>{
  const doc=options.document,selected=new Set<string>();let rows:readonly PromptSchedule[]=[],review:Review|undefined,scope='',storageError='',unreadable=false,forgetting=false,epoch=0,disposed=false;
  const key=()=> (options.storagePrefix??'recued:prompt-bulk:')+encodeURIComponent(scope);
  const node=<K extends keyof HTMLElementTagNameMap>(tag:K,text:string)=>{const el=doc.createElement(tag);el.textContent=text;return el;};
  const button=(host:HTMLElement,text:string,focus:string,action:()=>void)=>{const b=node('button',text);b.type='button';b.disabled=options.busy();b.dataset.promptFocus='bulk:'+focus;b.addEventListener('click',()=>{if(!disposed&&!options.busy())action();});host.append(b);return b;};
  const save=()=>{
    if(!scope||!review?.request)return;
    try{doc.defaultView?.sessionStorage.setItem(key(),JSON.stringify({request:review.request,outcomes:[...review.outcomes.values()]}));storageError='';}
    catch{storageError='This tab could not save the recovery copy. Keep this page open until the remaining changes are confirmed.';}
  };
  const clear=()=>{if(scope)try{doc.defaultView?.sessionStorage.removeItem(key());}catch{/* A replay of a retained receipt is safe. */}review=undefined;storageError='';unreadable=forgetting=false;epoch++;};
  const restore=()=>{
    try{
      const raw=doc.defaultView?.sessionStorage.getItem(key());if(!raw)return;const saved=JSON.parse(raw),request=readPromptBulkRequest(saved.request);
      const outcomes=readPromptBulkResult({items:saved.outcomes},saved.outcomes.map((i:PromptScheduleBulkOutcome)=>i.schedule_id)).items;
      if(outcomes.some(i=>!request.items.some(item=>item.schedule_id===i.schedule_id)))throw Error('Wrong bulk result target.');
      review={action:request.action,ids:request.items.map(i=>i.schedule_id),request,outcomes:new Map(outcomes.map(i=>[i.schedule_id,i])),attempted:true,loading:false};
    }catch{unreadable=true;storageError='The earlier bulk recovery copy could not be read. Review the prompts individually before forgetting this copy.';}
  };
  const load=async(current:Review)=>{
    const mine=++epoch;current.loading=true;current.error=undefined;current.preview=undefined;options.redraw();
    try{
      const result=await options.call('chat.schedules.bulk.preview',{action:current.action,schedule_ids:current.ids});
      if(disposed||review!==current||mine!==epoch)return;
      if(!result||!same(result.action,current.action)||!Array.isArray(result.items)||result.items.length!==current.ids.length
        ||new Set(result.items.map(i=>i?.schedule_id)).size!==current.ids.length)throw Error('The selected prompts could not be reviewed.');
      for(const item of result.items){
        if(!item||!current.ids.includes(item.schedule_id)||!['ready','unchanged','unavailable'].includes(item.status)||typeof item.message!=='string'
          ||item.queued_runs!==undefined&&(!Number.isSafeInteger(item.queued_runs)||item.queued_runs<0))throw Error('The selected prompts could not be reviewed.');
        if(item.schedule){const parsed=readPromptSchedules([item.schedule])[0];if(!parsed||parsed.schedule_id!==item.schedule_id)throw Error('The reviewed prompt identity could not be confirmed.');}
        if(item.status==='ready'&&(!token(item.review_token)||!item.schedule||item.schedule.bulk_control_available!==true
          ||current.action.kind==='pause_until'&&(!instant(item.until_at)||!instant(item.first_run_at)||item.first_run_at<item.until_at)
          ||current.action.kind==='resume'&&!instant(item.first_run_at)))throw Error('The exact timing of this bulk change could not be confirmed.');
      }
      current.preview=structuredClone(result);
    }catch(failure){if(!disposed&&review===current&&mine===epoch)current.error=humanizeRpcError(failure);}
    finally{if(!disposed&&review===current&&mine===epoch){current.loading=false;options.redraw();}}
  };
  const begin=(kind:PromptScheduleBulkAction['kind'])=>{
    if(disposed||options.busy()||review||!selected.size||storageError)return;
    options.opening();const first=rows.find(row=>selected.has(row.schedule_id));
    review={ids:[...selected],action:kind==='pause_until'?{kind,local_time:promptPausePreset(1,Date.now(),first?.time_zone??'UTC')}:{kind},outcomes:new Map(),loading:true,attempted:false};
    options.redraw('review');void load(review);
  };
  const apply=(current:Review)=>{
    if(disposed||review!==current||options.busy()||current.loading)return;
    if(!current.request){const items=current.preview?.items.filter(i=>i.status==='ready').map(i=>({schedule_id:i.schedule_id,review_token:i.review_token!}))??[];
      if(!items.length)return;current.request={request_id:crypto.randomUUID(),action:structuredClone(current.action),items};}
    const items=current.request.items.filter(i=>!['applied','needs_review'].includes(current.outcomes.get(i.schedule_id)?.status??''));if(!items.length)return;
    current.attempted=true;save();const request={...current.request,items};
    void options.mutate(async()=>{
      try{
        const reply=readPromptBulkResult(await options.call('chat.schedules.bulk.apply',structuredClone(request)),items.map(i=>i.schedule_id));
        if(disposed||review!==current)return;for(const outcome of reply.items)current.outcomes.set(outcome.schedule_id,outcome);current.error=undefined;
      }catch(failure){if(disposed||review!==current)return;current.error=humanizeRpcError(failure);
        for(const item of items)current.outcomes.set(item.schedule_id,{schedule_id:item.schedule_id,status:'failed',message:'The result is unconfirmed. Retry the original change.'});
      }
      if(!disposed&&review===current){save();options.redraw('results');}
    });
  };
  return {
    renderToolbar(all:readonly PromptSchedule[],shown:readonly PromptSchedule[]):HTMLElement|undefined{
      rows=all;const nextScope=all.find(row=>row.bulk_control_available)?.run_request_scope;
      if(nextScope&&nextScope!==scope){scope=nextScope;review=undefined;selected.clear();epoch++;storageError='';unreadable=forgetting=false;restore();}
      if(!review)for(const id of selected)if(!all.some(row=>row.schedule_id===id))selected.delete(id);
      if(!all.some(row=>row.bulk_control_available)&&!review&&!storageError)return;
      const section=node('section','');section.className='prompt-bulk-toolbar';section.setAttribute('role','region');section.setAttribute('aria-label','Bulk scheduled prompt controls');
      const visible=shown.filter(row=>row.bulk_control_available),outside=[...selected].filter(id=>!shown.some(row=>row.schedule_id===id)).length;
      const status=node('p',`${selected.size} selected${outside?' · '+outside+' outside this filter':''}`);status.setAttribute('role','status');section.append(status);
      const actions=node('div','');actions.dataset.promptScheduleActions='';section.append(actions);
      const select=button(actions,options.selectionLabel?.(visible.length)??`Select all ${visible.length} matching prompts`,'all',()=>{for(const row of visible)selected.add(row.schedule_id);options.redraw('all');});select.disabled=options.busy()||!!review||!visible.length||!!storageError;
      if(selected.size){const reset=button(actions,'Clear selection','clear',()=>{selected.clear();options.redraw('all');});reset.disabled=options.busy()||!!review;
        if(!review){button(actions,'Pause selected','pause',()=>begin('pause'));button(actions,'Pause until selected…','until',()=>begin('pause_until'));button(actions,'Resume selected','resume',()=>begin('resume'));}}
      if(storageError){const error=node('p',storageError);error.setAttribute('role','alert');section.append(error);
        if(unreadable&&!forgetting)button(section,'Forget unreadable recovery','forget',()=>{forgetting=true;options.redraw('forget-confirm');});
        else if(unreadable){section.append(node('p','Forgetting this local copy keeps any changes already made on the server.'));
          button(section,'Keep recovery copy','forget-keep',()=>{forgetting=false;options.redraw('forget');});
          button(section,'Forget local copy','forget-confirm',()=>{try{doc.defaultView?.sessionStorage.removeItem(key());unreadable=forgetting=false;storageError='';options.redraw('all');}catch{storageError='The recovery copy could not be cleared. Try again after reloading this tab.';options.redraw();}});
        }
      }
      if(review){
        const current=review,group=node('section','');group.setAttribute('role','region');group.setAttribute('aria-label','Review selected scheduled prompts');group.tabIndex=-1;group.dataset.promptFocus='bulk:review';group.className='prompt-bulk-review';
        group.append(node('h3',current.action.kind==='pause_until'?'Pause selected until':current.action.kind==='pause'?'Pause selected prompts':'Resume selected prompts'));
        if(current.action.kind==='pause_until'&&!current.attempted){const label=node('label','Resume date and time (in each prompt’s timezone)'),input=doc.createElement('input');input.type='datetime-local';input.value=current.action.local_time;input.dataset.promptFocus='bulk:time';
          input.addEventListener('change',()=>{current.action={kind:'pause_until',local_time:input.value};void load(current);});label.append(input);group.append(label);}
        if(current.loading){const loading=node('p','Reviewing the selected prompts…');loading.setAttribute('role','status');group.append(loading);}
        if(current.error){const error=node('p',current.error);error.setAttribute('role','alert');group.append(error);}
        const list=node('ol','');
        for(const id of current.ids){const item=current.preview?.items.find(i=>i.schedule_id===id),row=item?.schedule??all.find(row=>row.schedule_id===id),outcome=current.outcomes.get(id),li=node('li','');li.dataset.promptBulkId=id;
          li.append(node('strong',row?.title??id),node('p',outcome?(outcome.status==='applied'?'Confirmed':outcome.status==='needs_review'?'Needs a new review':'Unconfirmed')+': '+outcome.message:item?.message??'Waiting for review.'));
          if(row)li.append(node('p',row.time_zone));
          if(row&&item){for(const [label,at] of [['Paused until: ',item.until_at],['First run: ',item.first_run_at]] as const)if(at!==undefined){const text=node('p',label),time=node('time',formatReminderTimePreview(at,row.time_zone));time.dateTime=new Date(at).toISOString();text.append(time);li.append(text);}
            if(item.status==='ready')li.append(node('p',`${item.queued_runs??0} queued ${(item.queued_runs??0)===1?'run':'runs'} will be cancelled. Running work can finish; existing approvals stay in Chat.`));
            const details=node('details','');details.append(node('summary','Saved request'),node('p',row.prompt));li.append(details);}
          list.append(li);}
        group.append(list);const ready=current.preview?.items.filter(i=>i.status==='ready').length??0;
        if(!current.attempted){const cancel=button(group,'Keep current schedules','cancel',()=>{clear();options.redraw('all');});cancel.disabled=options.busy();
          const submit=button(group,`Apply ${ready} changes`,'apply',()=>apply(current));submit.disabled=options.busy()||current.loading||!!current.error||!ready;
          if(current.error)button(group,'Retry bulk review','review-retry',()=>{void load(current);});
        }else{
          const unresolved=current.request!.items.filter(i=>!['applied','needs_review'].includes(current.outcomes.get(i.schedule_id)?.status??'')).length;
          const status=node('p',options.applying?.()?'Applying scheduled prompt changes…':`${[...current.outcomes.values()].filter(i=>i.status==='applied').length} confirmed · ${unresolved} unresolved`);status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.tabIndex=-1;status.dataset.promptFocus='bulk:results';group.append(status);
          if(unresolved){group.append(node('p','Retries use the original reviewed requests for unresolved prompts.'));button(group,'Retry unresolved changes','retry',()=>apply(current));}
          else button(group,'Done','done',()=>{const remaining=current.ids.filter(id=>current.outcomes.get(id)?.status==='needs_review');clear();selected.clear();for(const id of remaining)selected.add(id);options.redraw('all');});
        }
        section.append(group);
      }
      return section;
    },
    checkbox(row:PromptSchedule):HTMLElement|undefined{
      if(!row.bulk_control_available)return;const label=node('label',' Select'),input=doc.createElement('input');input.type='checkbox';input.checked=selected.has(row.schedule_id);input.disabled=options.busy()||!!review||!!storageError;
      input.setAttribute('aria-label','Select '+row.title);input.dataset.promptFocus=row.schedule_id+':bulk:select';input.addEventListener('change',()=>{if(disposed||options.busy()||review||storageError)return;if(input.checked)selected.add(row.schedule_id);else selected.delete(row.schedule_id);options.redraw(input.dataset.promptFocus);});label.prepend(input);label.className='prompt-bulk-select';return label;
    },
    closePreview(){if(review&&!review.attempted){review=undefined;epoch++;}},
    resetSelection(){selected.clear();if(!review?.attempted)clear();},
    dispose(){disposed=true;epoch++;},
  };
};
