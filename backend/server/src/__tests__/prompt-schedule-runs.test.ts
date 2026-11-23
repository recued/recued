import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { RpcError, CHAT_RPC_METHODS, SERVER_RPC_METHODS, isReservedLocalRpc, type PromptSchedule, type PromptScheduleInput } from '@recued/contracts';
import { createChatStore,ensureChatSchema,type ChatKeyProvider } from '../storage/chat-store.js';
import { createChatTurnQueueStore } from '../storage/chat-turn-queue-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { createHeldResultTurnStore } from '../storage/chat-held-result-store.js';
import { createPromptSchedules } from '../prompt-schedules.js';
import { makeChatHandlers,type ChatRpcDeps } from '../chat-handler.js';
import { seedPromptRun,seedPromptContinuation,seedPromptPlan } from './helpers/prompt-run-fixture.js';

const NOW=Date.parse('2026-11-01T12:00Z'),cleanups:Array<()=>void>=[];
afterEach(()=>{for(const close of cleanups.splice(0))close();});
const fixture=async(options:{ getKey?:ChatKeyProvider; beforePlans?:()=>Promise<void> }={})=>{
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');ensureChatSchema(db);const store=createChatStore(db,options.getKey);
  const plans=createSqliteChatPlanStore(db,options.getKey);createChatTurnQueueStore(db,options.getKey);let executions=0;
  const service=createPromptSchedules({ db,store,queue:{ register(){} } as never,instanceId:'prompt-history',now:()=>NOW,getKey:options.getKey,
    runTurn:async()=>{executions++;throw Error('History must never execute a request.');},
    readPlans:async(session,turn)=>{await options.beforePlans?.();return plans.listForTurn(session,turn);} });
  cleanups.push(()=>db.close());
  const seed=(title='Kestrel briefing',patch:Partial<PromptScheduleInput>={})=>service.create({ title,prompt:'Keep the exact customer context.',mode:'recurring',cron_expression:'0 9 * * *',time_zone:'America/New_York',...patch },crypto.randomUUID()) as Promise<PromptSchedule>;
  const saved=await seed();
  const run=(key:string,patch:Partial<Parameters<typeof seedPromptRun>[3]>={},row=saved)=>seedPromptRun(db,store,row,{ key,due_at:NOW-600000,...patch,...(options.getKey?{ getKey:options.getKey }:{}) });
  const plan=(id:string,turn:string,row=saved)=>seedPromptPlan(plans,store,{plan_id:id,session_id:row.session_id,turn_id:turn,at:NOW});
  return {db,store,plans,service,seed,saved,run,plan,executions:()=>executions};
};

it('pages ten at a time in recorded order, excluding new insertions and unrelated chat or schedule activity',async()=>{
  const f=await fixture(),ids:string[]=[];
  for(let n=0;n<23;n++)ids.push((await f.run('page-'+n,{ due_at:NOW-600000,queued_at:NOW+n,answer:'Answer '+n })).occurrence_id);
  const other=await f.seed('Other prompt');await f.run('other',{},other);
  await seedPromptContinuation(f.db,f.store,{session_id:f.saved.session_id,turn_id:'ordinary-chat',at:NOW+100,answer:'Not a scheduled run.'});
  const first=await f.service.runs({schedule_id:f.saved.schedule_id});expect(first.runs.map(r=>r.occurrence_id)).toEqual(ids.slice(-10).reverse());expect(first.next_cursor).not.toBeNull();
  await f.run('new-after-page',{queued_at:NOW+200});
  const second=await f.service.runs({schedule_id:f.saved.schedule_id,cursor:first.next_cursor});
  const third=await f.service.runs({schedule_id:f.saved.schedule_id,cursor:second.next_cursor});
  expect([...first.runs,...second.runs,...third.runs].map(r=>r.occurrence_id)).toEqual(ids.reverse());expect(third.next_cursor).toBeNull();
  expect(first.runs[0]).toMatchObject({trigger:'manual',queued_at:NOW+22,outcome:{status:'finished',message_id:'history-answer-page-22'}});
  expect(f.executions()).toBe(0);
});

it('uses each occurrence snapshot and its own outcome and answer after schedule edits',async()=>{
  const f=await fixture(),clock=await f.run('clock',{trigger:'scheduled',due_at:NOW-3600000,queued_at:NOW-1800000,answer:'Earlier briefing.'});
  const edited=(await f.service.update({schedule_id:f.saved.schedule_id,expected_revision:1,time_zone:'Europe/Paris',prompt:'Updated customer context.'}))!;
  const manual=await f.run('failed',{status:'failed',due_at:NOW,answer:'A failed attempt.'},edited);
  const page=await f.service.runs({schedule_id:f.saved.schedule_id});
  expect(page.runs).toMatchObject([{occurrence_id:manual.occurrence_id,trigger:'manual',revision:2,time_zone:'Europe/Paris',outcome:{status:'failed',reason:'turn_failed',message_id:manual.message_id}},
    {occurrence_id:clock.occurrence_id,trigger:'scheduled',revision:1,time_zone:'America/New_York',due_at:NOW-3600000,queued_at:NOW-1800000,outcome:{status:'finished',message_id:clock.message_id}}]);
  expect(JSON.stringify(page)).not.toContain(f.saved.prompt);expect(JSON.stringify(page)).not.toContain('Updated customer context.');
});

it('keeps older approvals on their own occurrence, including folded continuations, and excludes ordinary chat plans',async()=>{
  const f=await fixture(),old=await f.run('old',{answer:'Original answer.'}),recent=await f.run('recent',{answer:'Most recent answer.'});
  const carried=createHeldResultTurnStore(f.db,()=>NOW);carried.record({session_id:f.saved.session_id,turn_id:'carry-old',run_id:'carried-run',origin_turn_id:old.turn_id});
  await seedPromptContinuation(f.db,f.store,{session_id:f.saved.session_id,turn_id:'fold-target',at:NOW+2,answer:'Continued answer.'});carried.fold(['carry-old'],'fold-target');
  await f.plan('approval-for-old','fold-target');await f.plan('ordinary-plan','ordinary-owner-turn');
  const other=await f.seed('Other schedule'),otherRun=await f.run('other-run',{},other);await f.plan('other-plan',otherRun.turn_id,other);
  const page=await f.service.runs({schedule_id:f.saved.schedule_id});
  expect(page.runs).toHaveLength(2);expect(page.runs.find(r=>r.occurrence_id===recent.occurrence_id)?.outcome).toMatchObject({status:'finished',message_id:recent.message_id});
  expect(page.runs.find(r=>r.occurrence_id===old.occurrence_id)?.outcome).toEqual({status:'needs_approval',plan_id:'approval-for-old',message_id:'message-approval-for-old'});
  await f.plans.resolve('approval-for-old','cancelled',NOW+3);
  carried.record({session_id:f.saved.session_id,turn_id:'carry-final',run_id:'final-carried-run',origin_turn_id:'carry-old'});
  await seedPromptContinuation(f.db,f.store,{session_id:f.saved.session_id,turn_id:'carry-final',at:NOW+5,answer:'All decisions reviewed.'});
  const after=await f.service.runs({schedule_id:f.saved.schedule_id});
  expect(after.runs.find(r=>r.occurrence_id===old.occurrence_id)?.outcome).toMatchObject({status:'finished',message_id:'answer-carry-final'});
});

it('shows active approved work until its receipt completes, then links the continuation answer',async()=>{
  const f=await fixture(),root=await f.run('work',{answer:'Approval requested.'});await f.plan('approved-work',root.turn_id);
  await f.plans.resolve('approved-work','approved',NOW);await f.plans.consumeForDispatch!('approved-work',NOW+1,'dispatch');
  const carried=createHeldResultTurnStore(f.db,()=>NOW);carried.record({session_id:f.saved.session_id,turn_id:'work-result',run_id:'work-run',origin_turn_id:root.turn_id});
  await seedPromptContinuation(f.db,f.store,{session_id:f.saved.session_id,turn_id:'work-result',at:NOW+3,answer:'Final response after the action.'});
  expect((await f.service.runs({schedule_id:f.saved.schedule_id})).runs[0]?.outcome).toMatchObject({status:'running',plan_id:'approved-work'});
  await f.plans.recordExecution!('approved-work',{status:'completed',turn_id:'dispatch',result_ref:'result'});
  expect((await f.service.runs({schedule_id:f.saved.schedule_id})).runs[0]?.outcome).toMatchObject({status:'finished',message_id:'answer-work-result'});
});

it('recovers a lost admission link from its durable submission receipt and leaves unconfirmed admission explicit without writes',async()=>{
  const f=await fixture(),accepted=await f.run('accepted',{status:'queued',unlinked:true}),unknown=await f.run('unconfirmed',{admit:false});
  const before=f.db.serialize();const page=await f.service.runs({schedule_id:f.saved.schedule_id});
  expect(page.runs).toMatchObject([{occurrence_id:unknown.occurrence_id,turn_id:null,queued_at:null,outcome:{status:'needs_attention',reason:'outcome_unknown'}},
    {occurrence_id:accepted.occurrence_id,turn_id:accepted.turn_id,outcome:{status:'queued'}}]);
  expect(f.db.serialize()).toEqual(before);expect(f.executions()).toBe(0);
});

it('rejects cross-prompt, malformed and deleted-anchor cursors instead of silently restarting pagination',async()=>{
  const f=await fixture();for(let n=0;n<11;n++)await f.run('cursor-'+n);
  const first=await f.service.runs({schedule_id:f.saved.schedule_id}),other=await f.seed('Other prompt');
  await expect(f.service.runs({schedule_id:other.schedule_id,cursor:first.next_cursor})).rejects.toMatchObject({code:'bad_request'});
  for(const cursor of ['', 'not-json', 'x'.repeat(1025)])await expect(f.service.runs({schedule_id:f.saved.schedule_id,cursor})).rejects.toMatchObject({code:'bad_request'});
  f.db.prepare('DELETE FROM chat_prompt_occurrences WHERE occurrence_id=?').run(first.runs.at(-1)!.occurrence_id);
  await expect(f.service.runs({schedule_id:f.saved.schedule_id,cursor:first.next_cursor})).rejects.toMatchObject({code:'conflict'});
});

it('requires paired callers and an unlocked vault and refuses managed, missing or concurrently removed prompts',async()=>{
  let key:Uint8Array|null=new Uint8Array(32).fill(43),block=false,release!:()=>void,started!:()=>void;
  const entered=new Promise<void>(done=>{started=done;});
  const held=new Promise<void>(done=>{release=done;});const f=await fixture({getKey:()=>key,beforePlans:async()=>{if(block){block=false;started();await held;}}});
  const seeded=await f.run('private',{answer:'Retained answer.'});
  const slice=makeChatHandlers({store:f.store,orchestrator:{promptSchedules:f.service}} as ChatRpcDeps)!;
  const method='chat.schedule.runs.list';expect(slice.methods).toContain(method);expect(CHAT_RPC_METHODS).toContain(method);expect(SERVER_RPC_METHODS).toContain(method);expect(isReservedLocalRpc(method)).toBe(true);
  await expect(slice.handlers[method]!({schedule_id:f.saved.schedule_id},{instance_id:null} as never)).rejects.toMatchObject({code:'unauthorized'});
  key=null;await expect(f.service.runs({schedule_id:f.saved.schedule_id})).rejects.toThrow(/locked/i);key=new Uint8Array(32).fill(43);
  const managed=(await f.service.create({title:'Agenda',prompt:'Agenda request',mode:'recurring',time_zone:'UTC',cron_expression:'0 9 * * *'},'managed',false,{managed_by:'agenda'}))!;
  expect(managed.run_history_available).toBeUndefined();await expect(f.service.runs({schedule_id:managed.schedule_id})).rejects.toMatchObject({code:'forbidden'});
  await expect(f.service.runs({schedule_id:'missing'})).rejects.toMatchObject({code:'not_found'});
  block=true;const reading=f.service.runs({schedule_id:f.saved.schedule_id});await entered;
  await f.service.control('remove',{schedule_id:f.saved.schedule_id});release();await expect(reading).rejects.toMatchObject({code:'not_found'});
  expect(seeded.occurrence_id).toContain(f.saved.schedule_id);expect(f.executions()).toBe(0);
});
