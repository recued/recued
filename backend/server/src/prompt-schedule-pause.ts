import type Database from 'better-sqlite3';
import { RpcError, type PromptSchedule, type PromptSchedulePauseRequest } from '@recued/contracts';
import type { PromptScheduleMutationHooks } from './prompt-schedule-bulk.js';
import { nextCronMatch } from '@recued/scheduler';

type State = { schedule_id:string; until_at:number|null; first_run_at:number|null; last_request:string|null; applied_revision:number|null };
const bad = (message:string):never => { throw new RpcError('bad_request',message,400); };
const conflict = ():never => { throw new RpcError('conflict','This prompt changed. Refresh and review its timing before pausing it.',409); };
const firstRun = (saved:PromptSchedule,at:number) => {
  const first=nextCronMatch(saved.cron_expression!.split(' '),Math.ceil(at/60000)*60000,527040,saved.time_zone);
  if(first===null)return bad('The first run after this pause could not be confirmed. Choose an earlier resume time or edit the schedule.');
  return first;
};

/** One durable deadline and exact-operation receipt per prompt. Expiry enables
 * the normal clock at a current occurrence, never at an accumulated backlog. */
export const createPromptSchedulePause = (deps:{db:Database.Database;now():number;get(id:string):Promise<PromptSchedule>;
  cancelQueued(id:string):void;invalidateSkip(id:string):void;changed(action:string,id:string,revision:number,session:string):void}) => {
  const {db,now}=deps;
  db.exec(`CREATE TABLE IF NOT EXISTS chat_prompt_schedule_pauses (
    schedule_id TEXT PRIMARY KEY REFERENCES chat_prompt_schedules(schedule_id) ON DELETE CASCADE,
    until_at INTEGER,first_run_at INTEGER,last_request TEXT,applied_revision INTEGER
  ); CREATE INDEX IF NOT EXISTS chat_prompt_schedule_pause_due ON chat_prompt_schedule_pauses(until_at)`);
  const read=(id:string)=>db.prepare('SELECT * FROM chat_prompt_schedule_pauses WHERE schedule_id=?').get(id) as State|undefined;
  const clock=(id:string)=>db.prepare('SELECT revision,enabled FROM chat_prompt_schedules WHERE schedule_id=?').get(id) as {revision:number;enabled:number}|undefined;
  const parse=(raw:unknown):PromptSchedulePauseRequest=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return bad('Expected a timed pause.');
    const a=raw as Record<string,unknown>;
    if(Object.keys(a).some(k=>!['schedule_id','expected_revision','until_at'].includes(k))||typeof a.schedule_id!=='string'||!a.schedule_id.trim()||a.schedule_id.length>100
      ||!Number.isSafeInteger(a.expected_revision)||Number(a.expected_revision)<1||!Number.isSafeInteger(a.until_at)||Number(a.until_at)<0||Number(a.until_at)>8.64e15)
      return bad('The prompt, current revision and exact resume time are required.');
    return {schedule_id:a.schedule_id,expected_revision:Number(a.expected_revision),until_at:Number(a.until_at)};
  };
  const owner=(saved:PromptSchedule)=>{
    if(saved.managed_by!==undefined)throw new RpcError('forbidden','This schedule belongs to the Agenda. Review it on the Agenda card.',403);
    if(saved.mode!=='recurring')return bad('Only recurring prompts can pause until a chosen time.');
  };
  const check=(request:PromptSchedulePauseRequest,saved:PromptSchedule)=>{
    owner(saved);
    const current=clock(request.schedule_id);
    if(!current)throw new RpcError('not_found','This scheduled prompt no longer exists.',404);
    if(current.revision!==saved.revision||current.revision!==request.expected_revision)return conflict();
    if(request.until_at<=now())return bad('Choose a future resume time.');
  };
  let cursor=0;
  return {
    parse,
    view(saved:PromptSchedule):PromptSchedule['timed_pause'] {
      if(saved.mode!=='recurring'||saved.managed_by!==undefined)return;
      const state=read(saved.schedule_id);
      return !saved.enabled&&state?.until_at!==null&&state?.until_at!==undefined&&state.first_run_at!==null
        ? {until_at:state.until_at,first_run_at:state.first_run_at}:null;
    },
    clear(id:string){db.prepare('DELETE FROM chat_prompt_schedule_pauses WHERE schedule_id=?').run(id);},
    edited(saved:PromptSchedule){
      const state=read(saved.schedule_id);
      if(state?.until_at!=null)db.prepare('UPDATE chat_prompt_schedule_pauses SET first_run_at=?,last_request=NULL,applied_revision=NULL WHERE schedule_id=?')
        .run(firstRun(saved,state.until_at),saved.schedule_id);
      else db.prepare('DELETE FROM chat_prompt_schedule_pauses WHERE schedule_id=?').run(saved.schedule_id);
    },
    async preview(raw:unknown){
      const request=parse(raw),saved=await deps.get(request.schedule_id);check(request,saved);
      const first_run_at=firstRun(saved,request.until_at);check(request,saved);
      return {...request,first_run_at,time_zone:saved.time_zone};
    },
    async change(raw:unknown,hooks?:PromptScheduleMutationHooks){
      const request=parse(raw),saved=await deps.get(request.schedule_id),fingerprint=JSON.stringify(request);owner(saved);
      const result=db.transaction(()=>{
        const previous=read(request.schedule_id);
        if(previous?.last_request===fingerprint&&previous.applied_revision!==null)return {revision:previous.applied_revision,replayed:true};
        hooks?.check();
        check(request,saved);const first=firstRun(saved,request.until_at);check(request,saved);
        deps.cancelQueued(saved.schedule_id);deps.invalidateSkip(saved.schedule_id);
        db.prepare('UPDATE chat_prompt_schedules SET enabled=0,revision=revision+1,next_run_at=NULL WHERE schedule_id=?').run(saved.schedule_id);
        const revision=request.expected_revision+1;
        db.prepare(`INSERT INTO chat_prompt_schedule_pauses VALUES (?,?,?,?,?) ON CONFLICT(schedule_id) DO UPDATE SET
          until_at=excluded.until_at,first_run_at=excluded.first_run_at,last_request=excluded.last_request,applied_revision=excluded.applied_revision`)
          .run(saved.schedule_id,request.until_at,first,fingerprint,revision);
        hooks?.committed();
        return {revision,replayed:false};
      }).immediate();
      if(!result.replayed)deps.changed('pause_until',saved.schedule_id,result.revision,saved.session_id);
      return {schedule:await deps.get(saved.schedule_id),expected_revision:request.expected_revision,applied_revision:result.revision,
        disposition:result.replayed?'replayed' as const:'applied' as const};
    },
    async wake(closed:()=>boolean){
      const batch=()=>db.prepare(`SELECT rowid AS position,* FROM chat_prompt_schedule_pauses WHERE until_at<=? AND rowid>? ORDER BY rowid LIMIT 100`)
        .all(now(),cursor) as Array<State&{position:number}>;
      let rows=batch();if(!rows.length&&cursor){cursor=0;rows=batch();}
      for(const state of rows){
        if(closed())return;cursor=state.position;
        try{
          const saved=await deps.get(state.schedule_id);
          if(saved.mode!=='recurring'||saved.managed_by!==undefined)continue;
          const resumed=db.transaction(()=>{
            const current=clock(state.schedule_id),pause=read(state.schedule_id);
            if(closed()||!current||current.enabled!==0||current.revision!==saved.revision||pause?.until_at!==state.until_at||state.until_at!>now())return false;
            // Keep an occurrence in the current minute eligible when the clock
            // wakes seconds after expiry; older missed minutes are discarded.
            const at=Math.max(state.until_at!,Math.floor(now()/60000)*60000);
            const first=firstRun(saved,at);
            // Expiry advances eligibility, not the saved configuration. Manual
            // runs admitted during the break must keep their valid revision.
            db.prepare('UPDATE chat_prompt_schedules SET enabled=1,next_run_at=? WHERE schedule_id=?').run(first,state.schedule_id);
            db.prepare('UPDATE chat_prompt_schedule_pauses SET until_at=NULL,first_run_at=NULL WHERE schedule_id=?').run(state.schedule_id);
            return true;
          }).immediate();
          if(resumed)deps.changed('resumed_after_pause',saved.schedule_id,saved.revision,saved.session_id);
        }catch{/* An unavailable vault or one unreadable prompt cannot prevent other deadlines from resuming. */}
      }
    },
  };
};
