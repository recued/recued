import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, zonedWallClockToEpochMs, PROMPT_SCHEDULE_BULK_MAX, type PromptSchedule,
  type PromptScheduleBulkAction, type PromptScheduleBulkPreview, type PromptScheduleBulkReviewItem,
  type PromptScheduleBulkApplyRequest, type PromptScheduleBulkOutcome, type PromptScheduleBulkResult } from '@recued/contracts';
import { nextCronMatch } from '@recued/scheduler';
import type { ChatKeyProvider } from './storage/chat-store.js';

export interface PromptScheduleMutationHooks { check():void; committed():void }
const bad=(message:string):never=>{throw new RpcError('bad_request',message,400);};
const changed=():never=>{throw new RpcError('conflict','This prompt or its queued work changed. Review it again before applying.',409);};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=100;
const object=(raw:unknown)=>{if(!raw||typeof raw!=='object'||Array.isArray(raw))return bad('Expected a bulk prompt request.');return raw as Record<string,unknown>;};
const action=(raw:unknown):PromptScheduleBulkAction=>{
  const a=object(raw);
  if(a.kind==='pause_until'&&Object.keys(a).every(k=>['kind','local_time'].includes(k))&&typeof a.local_time==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(a.local_time))return {kind:a.kind,local_time:a.local_time};
  if((a.kind==='pause'||a.kind==='resume')&&Object.keys(a).length===1)return {kind:a.kind};
  return bad('Choose Pause, Pause until, or Resume.');
};
const wall=(at:number,zone:string)=>{
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at);
  const read=(key:string)=>parts.find(p=>p.type===key)?.value??'';
  return `${read('year')}-${read('month')}-${read('day')}T${read('hour')}:${read('minute')}`;
};

/** Begin with the bounded unfinished queue, then find occurrences by turn.
 * A recurring prompt can retain years of completed occurrences. */
export const promptBulkWorkSql=`SELECT o.occurrence_id,o.turn_id,o.revision,q.status
  FROM chat_turn_queue q INDEXED BY chat_prompt_bulk_unfinished CROSS JOIN chat_prompt_occurrences o INDEXED BY chat_prompt_occurrences_turn
  WHERE q.session_id=@session_id AND q.status IN ('queued','running','cancelling') AND o.turn_id=q.turn_id AND o.schedule_id=@schedule_id
  UNION ALL SELECT o.occurrence_id,o.turn_id,o.revision,NULL AS status FROM chat_prompt_occurrences o INDEXED BY chat_prompt_occurrences_turn
  WHERE o.turn_id IS NULL AND o.schedule_id=@schedule_id AND o.revision=@revision ORDER BY occurrence_id`;

/** Review tokens bind configuration, clock and cancellable queue state. Each
 * successful result is stored in the SAME transaction as its clock mutation. */
export const createPromptScheduleBulk=(deps:{db:Database.Database;now():number;getKey?:ChatKeyProvider;get(id:string):Promise<PromptSchedule>;
  control(kind:'pause'|'resume',id:string,revision:number,hooks:PromptScheduleMutationHooks):Promise<unknown>;
  pauseUntil(id:string,revision:number,until:number,hooks:PromptScheduleMutationHooks):Promise<unknown>})=>{
  const {db,now}=deps;
  db.exec(`CREATE TABLE IF NOT EXISTS chat_prompt_bulk_requests (client_id TEXT NOT NULL,request_id TEXT NOT NULL,action TEXT NOT NULL,items TEXT NOT NULL,PRIMARY KEY(client_id,request_id));
    CREATE TABLE IF NOT EXISTS chat_prompt_bulk_results (client_id TEXT NOT NULL,request_id TEXT NOT NULL,schedule_id TEXT NOT NULL,message TEXT NOT NULL,applied_revision INTEGER NOT NULL,
      PRIMARY KEY(client_id,request_id,schedule_id),FOREIGN KEY(client_id,request_id) REFERENCES chat_prompt_bulk_requests(client_id,request_id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS chat_prompt_bulk_unfinished ON chat_turn_queue(session_id,turn_id) WHERE status IN ('queued','running','cancelling')`);
  const unlocked=async()=>{if(deps.getKey&&!await deps.getKey())throw Error('Chat vault is locked.');};
  const review=(saved:PromptSchedule,a:PromptScheduleBulkAction):PromptScheduleBulkReviewItem=>{
    const base={schedule_id:saved.schedule_id,schedule:saved};
    if(saved.managed_by!==undefined)return {schedule_id:saved.schedule_id,status:'unavailable',message:'This prompt is managed in the Agenda.'};
    const clock=db.prepare('SELECT revision,enabled,next_run_at,payload FROM chat_prompt_schedules WHERE schedule_id=?').get(saved.schedule_id) as {revision:number;enabled:number;next_run_at:number|null;payload:string}|undefined;
    if(!clock||clock.revision!==saved.revision||clock.enabled!==Number(saved.enabled))return changed();
    const work=db.prepare(promptBulkWorkSql).all({session_id:saved.session_id,schedule_id:saved.schedule_id,revision:saved.revision}) as Array<{status:string|null}>;
    const queued_runs=work.filter(w=>w.status==='queued'||w.status===null).length;
    let first_run_at:number|undefined,until_at:number|undefined;
    if(a.kind==='pause'&&!saved.enabled&&!saved.timed_pause&&!queued_runs)return {...base,status:'unchanged',message:'Already inactive.'};
    if(a.kind==='resume'){
      if(saved.enabled)return {...base,status:'unchanged',message:'Already active.'};
      if(saved.mode==='one_shot'){
        if((saved.run_at??0)<=now())return {...base,status:'unavailable',message:'Choose a new future time before resuming this one-off prompt.'};
        first_run_at=saved.run_at;
      }else first_run_at=nextCronMatch(saved.cron_expression!.split(' '),now()+60000,527040,saved.time_zone)??undefined;
      if(first_run_at===undefined)return {...base,status:'unavailable',message:'The next run could not be confirmed. Edit this prompt first.'};
    }
    if(a.kind==='pause_until'){
      if(saved.mode!=='recurring'||saved.timed_pause===undefined)return {...base,status:'unavailable',message:'Only recurring prompts support a timed pause.'};
      const at=zonedWallClockToEpochMs(a.local_time,saved.time_zone);
      if(at===null||wall(at,saved.time_zone)!==a.local_time||at<=now())return {...base,status:'unavailable',message:'Choose a future resume time that exists in this prompt’s timezone.'};
      until_at=at;first_run_at=nextCronMatch(saved.cron_expression!.split(' '),Math.ceil(at/60000)*60000,527040,saved.time_zone)??undefined;
      if(first_run_at===undefined)return {...base,status:'unavailable',message:'The first run after the break could not be confirmed.'};
    }
    const pause=db.prepare('SELECT until_at,first_run_at FROM chat_prompt_schedule_pauses WHERE schedule_id=?').get(saved.schedule_id)??null;
    const skip=db.prepare('SELECT revision,skip_id,run_at,following_run_at FROM chat_prompt_schedule_skips WHERE schedule_id=?').get(saved.schedule_id)??null;
    const review_token=hash([saved.run_request_scope,a,clock,pause,skip,work,until_at??null,first_run_at??null]);
    return {...base,status:'ready',review_token,queued_runs,...(until_at!==undefined?{until_at}:{}),...(first_run_at!==undefined?{first_run_at}:{}),
      message:a.kind==='resume'?'Resume at the reviewed next run.':a.kind==='pause_until'?'Pause until the reviewed time; missed runs stay skipped.':'Pause until you resume it.'};
  };
  const parseApply=(raw:unknown):PromptScheduleBulkApplyRequest=>{
    const a=object(raw),chosen=action(a.action);
    if(Object.keys(a).some(k=>!['request_id','action','items'].includes(k))||typeof a.request_id!=='string'||!/^[0-9a-f-]{36}$/i.test(a.request_id)||!Array.isArray(a.items)||!a.items.length||a.items.length>PROMPT_SCHEDULE_BULK_MAX)return bad('Choose a bounded reviewed selection and a stable request ID.');
    const items=a.items.map(raw=>{const item=object(raw);if(Object.keys(item).some(k=>!['schedule_id','review_token'].includes(k))||!id(item.schedule_id)||typeof item.review_token!=='string'||!/^[a-f0-9]{64}$/.test(item.review_token))return bad('Each prompt needs its original review token.');return {schedule_id:item.schedule_id,review_token:item.review_token};});
    if(new Set(items.map(i=>i.schedule_id)).size!==items.length)return bad('Each prompt can appear only once.');
    return {request_id:a.request_id,action:chosen,items};
  };
  return {
    async preview(raw:unknown):Promise<PromptScheduleBulkPreview>{
      const a=object(raw),chosen=action(a.action);
      if(Object.keys(a).some(k=>!['schedule_ids','action'].includes(k))||!Array.isArray(a.schedule_ids)||!a.schedule_ids.length||a.schedule_ids.length>PROMPT_SCHEDULE_BULK_MAX||!a.schedule_ids.every(id)||new Set(a.schedule_ids).size!==a.schedule_ids.length)return bad('Choose between 1 and 200 distinct prompts.');
      await unlocked();const items:PromptScheduleBulkReviewItem[]=[];
      for(const schedule_id of a.schedule_ids as string[])try{items.push(review(await deps.get(schedule_id),chosen));}
      catch{items.push({schedule_id,status:'unavailable',message:'This prompt could not be reviewed. Refresh and try again.'});}
      return {action:chosen,items};
    },
    async apply(raw:unknown,client:string):Promise<PromptScheduleBulkResult>{
      const input=parseApply(raw);if(!id(client))throw new RpcError('unauthorized','Bulk prompt controls require a paired client.',401);await unlocked();
      db.transaction(()=>{
        const old=db.prepare('SELECT action,items FROM chat_prompt_bulk_requests WHERE client_id=? AND request_id=?').get(client,input.request_id) as {action:string;items:string}|undefined;
        if(old){const original=JSON.parse(old.items) as PromptScheduleBulkApplyRequest['items'];
          if(old.action!==JSON.stringify(input.action)||input.items.some(i=>!original.some(o=>o.schedule_id===i.schedule_id&&o.review_token===i.review_token)))return changed();
        }else db.prepare('INSERT INTO chat_prompt_bulk_requests VALUES (?,?,?,?)').run(client,input.request_id,JSON.stringify(input.action),JSON.stringify(input.items));
      }).immediate();
      const result:PromptScheduleBulkOutcome[]=[];
      for(const item of input.items){
        const receipt=()=>db.prepare('SELECT message FROM chat_prompt_bulk_results WHERE client_id=? AND request_id=? AND schedule_id=?').get(client,input.request_id,item.schedule_id) as {message:string}|undefined;
        try{
          const old=receipt();if(old){result.push({schedule_id:item.schedule_id,status:'applied',message:old.message,replayed:true});continue;}
          const saved=await deps.get(item.schedule_id),plan=review(saved,input.action);
          if(plan.status!=='ready'||plan.review_token!==item.review_token){result.push({schedule_id:item.schedule_id,status:'needs_review',message:'The prompt or its timing changed. Review it again.'});continue;}
          const hooks:PromptScheduleMutationHooks={check:()=>{if(review(saved,input.action).review_token!==item.review_token)return changed();},committed:()=>{
            const message=input.action.kind==='pause'?'Paused until you resume it.':input.action.kind==='pause_until'?'Paused until the reviewed time.':'Resumed with the reviewed next run.';
            db.prepare('INSERT INTO chat_prompt_bulk_results VALUES (?,?,?,?,?)').run(client,input.request_id,item.schedule_id,message,saved.revision+1);
          }};
          if(input.action.kind==='pause_until')await deps.pauseUntil(item.schedule_id,saved.revision,plan.until_at!,hooks);
          else await deps.control(input.action.kind,item.schedule_id,saved.revision,hooks);
          const confirmed=receipt();result.push(confirmed?{schedule_id:item.schedule_id,status:'applied',message:confirmed.message}:{schedule_id:item.schedule_id,status:'needs_review',message:'The prompt changed before applying. Review it again.'});
        }catch(failure){
          let confirmed:{message:string}|undefined;try{confirmed=receipt();}catch{/* An unreadable receipt remains unconfirmed and must be retried with the same request. */}
          result.push(confirmed?{schedule_id:item.schedule_id,status:'applied',message:confirmed.message,replayed:true}:{schedule_id:item.schedule_id,
            status:failure instanceof RpcError&&['conflict','not_found','forbidden','bad_request'].includes(failure.code)?'needs_review':'failed',
            message:failure instanceof RpcError?'This prompt changed or is unavailable. Review it again.':'The result could not be confirmed. Retry this original change.'});
        }
      }
      return {items:result};
    },
  };
};
