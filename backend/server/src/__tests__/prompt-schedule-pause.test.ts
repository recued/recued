import Database from 'better-sqlite3';
import { afterEach,expect,it } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_RPC_METHODS,SERVER_RPC_METHODS,isReservedLocalRpc,type PromptSchedule,type PromptScheduleInput } from '@recued/contracts';
import { createChatStore,ensureChatSchema } from '../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { createChatTurnQueueStore } from '../storage/chat-turn-queue-store.js';
import type { ChatTurnQueue } from '../chat-turn-queue.js';
import { createPromptSchedules } from '../prompt-schedules.js';
import { makeChatHandlers,type ChatRpcDeps } from '../chat-handler.js';
import { seedPromptRun,seedPromptPlan } from './helpers/prompt-run-fixture.js';

const NOW=Date.parse('2026-10-31T12:00Z'),cleanup:Array<()=>void>=[];
afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
const fixture=(options:{file?:string;key?:()=>Uint8Array|null;beforePlans?:()=>Promise<void>}={})=>{
  const db=new Database(options.file??':memory:');db.pragma('foreign_keys=ON');ensureChatSchema(db);
  const store=createChatStore(db,options.key),plans=createSqliteChatPlanStore(db,options.key),queue=createChatTurnQueueStore(db,options.key);let now=NOW;
  const admissions:string[]=[];let execute!:Parameters<ChatTurnQueue['register']>[1];
  const service=createPromptSchedules({db,store,instanceId:'pause-test',now:()=>now,getKey:options.key,
    queue:{routing(){return undefined;},register(_family:string,handler:Parameters<ChatTurnQueue['register']>[1]){execute=handler;},async cancel(session:string,turn:string){queue.cancel(session,turn);},async submit(_command:unknown,id:string){admissions.push(id);return {turn_id:'admitted-'+admissions.length};}} as never,
    runTurn:async()=>{throw Error('The clock must not execute an AI request in this fixture.');},readPlans:async(session,turn)=>{await options.beforePlans?.();return plans.listForTurn(session,turn);}});
  cleanup.push(()=>{if(db.open)db.close();});
  const seed=(patch:Partial<PromptScheduleInput>={})=>service.create({title:'Kestrel briefing',prompt:'Summarize the customer renewal.',mode:'recurring',time_zone:'America/New_York',cron_expression:'0 9 * * *',...patch},crypto.randomUUID()) as Promise<PromptSchedule>;
  return {db,store,plans,queue,service,seed,admissions,execute,now:(at:number)=>{now=at;}};
};
it('previews the exact first normal run read-only and persists an idempotent pause that preserves running work and approvals',async()=>{
  const f=fixture(),saved=await f.seed(),until=Date.parse('2026-11-01T13:00Z');
  const queued=await seedPromptRun(f.db,f.store,saved,{key:'queued',due_at:NOW-2,status:'queued'});
  const running=await seedPromptRun(f.db,f.store,saved,{key:'running',due_at:NOW-1,status:'running'});
  await seedPromptPlan(f.plans,f.store,{plan_id:'retained-approval',session_id:saved.session_id,turn_id:running.turn_id,at:NOW});
  const request={schedule_id:saved.schedule_id,expected_revision:1,until_at:until},before=f.db.serialize();
  expect(await f.service.previewPause(request)).toEqual({...request,first_run_at:Date.parse('2026-11-01T14:00Z'),time_zone:'America/New_York'});expect(f.db.serialize()).toEqual(before);
  const result=await f.service.pauseUntil(request);expect(result).toMatchObject({expected_revision:1,applied_revision:2,disposition:'applied',schedule:{enabled:false,next_run_at:null,timed_pause:{until_at:until,first_run_at:Date.parse('2026-11-01T14:00Z')}}});
  expect(f.queue.get(queued.turn_id)?.status).toBe('cancelled');expect(f.queue.get(running.turn_id)?.status).toBe('running');
  expect((await f.service.get(saved.schedule_id)).pending_approvals?.plan_id).toBe('retained-approval');
  expect(await f.service.pauseUntil(request)).toMatchObject({disposition:'replayed',applied_revision:2,schedule:{revision:2}});expect(f.admissions).toEqual([]);
});
it('survives an encrypted database reopen and resumes only the current cadence after a long offline break',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'prompt-pause-reopen-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'chat.sqlite');let key:Uint8Array|null=new Uint8Array(32).fill(29);
  const f=fixture({file,key:()=>key}),saved=await f.seed({time_zone:'UTC',cron_expression:'*/5 * * * *'}),request={schedule_id:saved.schedule_id,expected_revision:1,until_at:NOW+600000};
  await f.service.pauseUntil(request);f.db.close();const reopened=fixture({file,key:()=>key});
  reopened.now(NOW+3*86400000+120000);key=null;await reopened.service.tick();key=new Uint8Array(32).fill(29);
  expect((await reopened.service.get(saved.schedule_id)).enabled).toBe(false);await reopened.service.tick();
  expect(await reopened.service.get(saved.schedule_id)).toMatchObject({enabled:true,revision:2,timed_pause:null,next_run_at:NOW+3*86400000+300000});expect(reopened.admissions).toEqual([]);
  reopened.now(NOW+3*86400000+300000);await reopened.service.tick();expect(reopened.admissions).toHaveLength(1);
  expect(await reopened.service.pauseUntil(request)).toMatchObject({disposition:'replayed',applied_revision:2,schedule:{enabled:true,revision:2}});
});
it('resumes a boundary occurrence once even when the scheduler wakes seconds late, with no replay of the paused interval',async()=>{
  const f=fixture(),saved=await f.seed({time_zone:'UTC',cron_expression:'*/5 * * * *'});await f.service.pauseUntil({schedule_id:saved.schedule_id,expected_revision:1,until_at:NOW+600000});
  f.now(NOW+599999);await f.service.tick();expect(f.admissions).toEqual([]);f.now(NOW+610000);await f.service.tick();expect(f.admissions).toHaveLength(1);await f.service.tick();expect(f.admissions).toHaveLength(1);
  expect(await f.service.get(saved.schedule_id)).toMatchObject({enabled:true,timed_pause:null,next_run_at:NOW+900000});
});
it('retains the deadline through edits, recalculates its first run, and clears it on explicit Pause or Resume now',async()=>{
  const f=fixture(),saved=await f.seed(),until=Date.parse('2026-11-02T12:00Z'),request={schedule_id:saved.schedule_id,expected_revision:1,until_at:until};
  await f.service.pauseUntil(request);const edited=(await f.service.update({schedule_id:saved.schedule_id,expected_revision:2,time_zone:'Asia/Tokyo',title:'Edited briefing'}))!;
  expect(edited).toMatchObject({enabled:false,revision:3,timed_pause:{until_at:until,first_run_at:Date.parse('2026-11-03T00:00Z')}});
  await expect(f.service.pauseUntil(request)).rejects.toMatchObject({code:'conflict'});
  await f.service.control('resume',{schedule_id:saved.schedule_id,expected_revision:3});expect((await f.service.get(saved.schedule_id)).timed_pause).toBeNull();
  const latest=await f.service.get(saved.schedule_id);await f.service.pauseUntil({schedule_id:saved.schedule_id,expected_revision:latest.revision,until_at:until});
  await f.service.control('pause',{schedule_id:saved.schedule_id});f.now(until+86400000);await f.service.tick();expect(await f.service.get(saved.schedule_id)).toMatchObject({enabled:false,timed_pause:null});
});
it('invalidates skips without changing a running turn and refuses stale, missing, managed, one-off and malformed requests',async()=>{
  const f=fixture(),saved=await f.seed(),skip=saved.skip_state!;
  await f.service.changeSkip('skip_next',{schedule_id:saved.schedule_id,expected_revision:1,expected_skip_revision:skip.revision,run_at:skip.next!.run_at});
  await f.service.pauseUntil({schedule_id:saved.schedule_id,expected_revision:1,until_at:NOW+600000});expect((await f.service.get(saved.schedule_id)).skip_state?.skipped).toBeUndefined();
  for(const raw of [{schedule_id:saved.schedule_id,expected_revision:1,until_at:NOW+600000},{schedule_id:saved.schedule_id,expected_revision:2,until_at:NOW},{schedule_id:saved.schedule_id,expected_revision:2,until_at:NaN},{schedule_id:'missing',expected_revision:1,until_at:NOW+600000}])await expect(f.service.previewPause(raw)).rejects.toBeDefined();
  const once=await f.seed({mode:'one_shot',cron_expression:undefined,run_at:new Date(NOW+60000).toISOString()});expect(once.timed_pause).toBeUndefined();await expect(f.service.pauseUntil({schedule_id:once.schedule_id,expected_revision:1,until_at:NOW+600000})).rejects.toMatchObject({code:'bad_request'});
  const managed=(await f.service.create({title:'Agenda',prompt:'Agenda',mode:'recurring',time_zone:'UTC',cron_expression:'0 9 * * *'},'agenda',false,{managed_by:'agenda'}))!;
  await expect(f.service.pauseUntil({schedule_id:managed.schedule_id,expected_revision:1,until_at:NOW+600000})).rejects.toMatchObject({code:'forbidden'});
  await f.service.control('remove',{schedule_id:saved.schedule_id});expect(f.db.prepare('SELECT * FROM chat_prompt_schedule_pauses WHERE schedule_id=?').get(saved.schedule_id)).toBeUndefined();
});
it('does not let asynchronous expiry overwrite a concurrent explicit pause',async()=>{
  let block=false,entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
  const f=fixture({beforePlans:async()=>{if(block){block=false;entered();await held;}}}),saved=await f.seed();
  await seedPromptRun(f.db,f.store,saved,{key:'done',due_at:NOW-1,answer:'Retained answer'});await f.service.pauseUntil({schedule_id:saved.schedule_id,expected_revision:1,until_at:NOW+60000});
  f.now(NOW+60000);block=true;const waking=f.service.tick();await started;await f.service.control('pause',{schedule_id:saved.schedule_id,expected_revision:2});release();await waking;
  expect(await f.service.get(saved.schedule_id)).toMatchObject({enabled:false,revision:3,timed_pause:null});expect(f.admissions).toEqual([]);
});
it('requires paired callers and an unlocked vault and registers both methods as local operations',async()=>{
  let key:Uint8Array|null=new Uint8Array(32).fill(31);const f=fixture({key:()=>key}),saved=await f.seed();
  const handlers=makeChatHandlers({store:f.store,orchestrator:{promptSchedules:f.service}} as ChatRpcDeps)!;
  for(const name of ['chat.schedule.pause_preview','chat.schedule.pause_until'] as const){
    expect(handlers.methods).toContain(name);expect(CHAT_RPC_METHODS).toContain(name);expect(SERVER_RPC_METHODS).toContain(name);expect(isReservedLocalRpc(name)).toBe(true);
    await expect(handlers.handlers[name]!({schedule_id:saved.schedule_id,expected_revision:1,until_at:NOW+60000},{instance_id:null} as never)).rejects.toMatchObject({code:'unauthorized'});
  }
  key=null;await expect(f.service.pauseUntil({schedule_id:saved.schedule_id,expected_revision:1,until_at:NOW+60000})).rejects.toThrow(/locked/i);
});

it('keeps a manual run queued during the break eligible when the pause expires',async()=>{
  const f=fixture(),saved=await f.seed();
  await f.service.pauseUntil({schedule_id:saved.schedule_id,expected_revision:1,until_at:NOW+60000});
  const paused=await f.service.get(saved.schedule_id),manual=await seedPromptRun(f.db,f.store,paused,{key:'manual-during-pause',due_at:NOW+1,status:'queued'});
  f.now(NOW+60000);await f.service.tick();
  expect(f.queue.get(manual.turn_id)?.status).toBe('queued');
  await expect(f.execute({family:'scheduled_prompt',session_id:saved.session_id,message:paused.prompt,input:{occurrence_id:manual.occurrence_id}},manual.turn_id,()=>{},()=>{}))
    .rejects.toThrow('The clock must not execute an AI request in this fixture.');
  expect(f.queue.get(manual.turn_id)?.status).toBe('queued');
  expect((await f.service.get(saved.schedule_id)).enabled).toBe(true);
});

it('refuses an edit whose paused snapshot became active while its definition was being prepared',async()=>{
  let block=false,entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
  const f=fixture({beforePlans:async()=>{if(block){block=false;entered();await held;}}}),saved=await f.seed();
  await f.service.pauseUntil({schedule_id:saved.schedule_id,expected_revision:1,until_at:NOW+60000});
  await seedPromptRun(f.db,f.store,await f.service.get(saved.schedule_id),{key:'finished-during-pause',due_at:NOW+1,answer:'Finished manual run.'});
  block=true;const edit=f.service.update({schedule_id:saved.schedule_id,expected_revision:2,title:'Must not erase the clock'});
  const rejected=expect(edit).rejects.toMatchObject({code:'conflict'});await started;f.now(NOW+60000);await f.service.tick();release();await rejected;
  const current=await f.service.get(saved.schedule_id);expect(current).toMatchObject({enabled:true,title:saved.title,timed_pause:null});expect(current.next_run_at).not.toBeNull();
});
