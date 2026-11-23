import Database from 'better-sqlite3';
import { afterEach,expect,it } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_RPC_METHODS,SERVER_RPC_METHODS,isReservedLocalRpc,type PromptSchedule,type PromptScheduleBulkAction,type PromptScheduleBulkApplyRequest,type PromptScheduleInput } from '@recued/contracts';
import { createChatStore,ensureChatSchema,type ChatKeyProvider } from '../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { createChatTurnQueueStore } from '../storage/chat-turn-queue-store.js';
import { createPromptSchedules } from '../prompt-schedules.js';
import { promptBulkWorkSql } from '../prompt-schedule-bulk.js';
import { makeChatHandlers,type ChatRpcDeps } from '../chat-handler.js';
import { seedPromptRun } from './helpers/prompt-run-fixture.js';

const NOW=Date.parse('2026-10-31T12:00Z'),cleanup:Array<()=>void>=[];
afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
const fixture=(options:{file?:string;instanceId?:string;key?:ChatKeyProvider;beforePlans?:()=>Promise<void>}={})=>{
  const db=new Database(options.file??':memory:');db.pragma('foreign_keys=ON');ensureChatSchema(db);
  const store=createChatStore(db,options.key),plans=createSqliteChatPlanStore(db,options.key),queue=createChatTurnQueueStore(db,options.key);let now=NOW;
  const service=createPromptSchedules({db,store,instanceId:options.instanceId??'bulk-test',getKey:options.key,now:()=>now,queue:{register(){}} as never,
    runTurn:async()=>{throw Error('Bulk controls must never execute an AI request.');},readPlans:async(session,turn)=>{await options.beforePlans?.();return plans.listForTurn(session,turn);}});
  cleanup.push(()=>{if(db.open)db.close();});
  const seed=(title:string,patch:Partial<PromptScheduleInput>={})=>service.create({title,prompt:'Summarize the customer renewal.',mode:'recurring',time_zone:'America/New_York',cron_expression:'0 9 * * *',...patch},crypto.randomUUID()) as Promise<PromptSchedule>;
  const request=async(rows:PromptSchedule[],action:PromptScheduleBulkAction):Promise<PromptScheduleBulkApplyRequest>=>{
    const review=await service.bulk.preview({schedule_ids:rows.map(r=>r.schedule_id),action});return {request_id:crypto.randomUUID(),action,items:review.items.filter(i=>i.status==='ready').map(i=>({schedule_id:i.schedule_id,review_token:i.review_token!}))};
  };
  return {db,store,queue,service,seed,request,now:(at:number)=>{now=at;}};
};

it('reviews only the selected prompts without writes, and reports inactive, managed and missing entries explicitly',async()=>{
  const f=fixture(),active=await f.seed('Active'),paused=await f.seed('Paused'),outside=await f.seed('Unselected');await f.service.control('pause',{schedule_id:paused.schedule_id});
  const managed=(await f.service.create({title:'Agenda',prompt:'Private managed request',mode:'recurring',time_zone:'UTC',cron_expression:'0 9 * * *'},'managed',false,{managed_by:'agenda'}))!;
  const ids=[active.schedule_id,paused.schedule_id,managed.schedule_id,'missing'],before=f.db.serialize();
  const review=await f.service.bulk.preview({schedule_ids:ids,action:{kind:'pause'}});expect(f.db.serialize()).toEqual(before);
  expect(review.items.map(i=>i.status)).toEqual(['ready','unchanged','unavailable','unavailable']);expect(review.items[2]?.schedule).toBeUndefined();expect(JSON.stringify(review)).not.toContain('Private managed request');
  const request={request_id:crypto.randomUUID(),action:review.action,items:review.items.filter(i=>i.review_token).map(i=>({schedule_id:i.schedule_id,review_token:i.review_token!}))};
  expect((await f.service.bulk.apply(request,'owner')).items).toMatchObject([{schedule_id:active.schedule_id,status:'applied'}]);
  expect(await f.service.get(active.schedule_id)).toMatchObject({enabled:false,revision:2});expect(await f.service.get(outside.schedule_id)).toMatchObject({enabled:true,revision:1});
});
it('resolves the same wall time on each prompt clock, previews exact first runs and refuses nonexistent local times',async()=>{
  const f=fixture(),ny=await f.seed('New York'),tokyo=await f.seed('Tokyo',{time_zone:'Asia/Tokyo'}),once=await f.seed('One-off',{mode:'one_shot',cron_expression:undefined,run_at:new Date(NOW+60000).toISOString()});
  const action={kind:'pause_until',local_time:'2026-11-02T09:00'} as const,preview=await f.service.bulk.preview({schedule_ids:[ny.schedule_id,tokyo.schedule_id,once.schedule_id],action});
  expect(preview.items).toMatchObject([{until_at:Date.parse('2026-11-02T14:00Z'),first_run_at:Date.parse('2026-11-02T14:00Z')},{until_at:Date.parse('2026-11-02T00:00Z'),first_run_at:Date.parse('2026-11-02T00:00Z')},{status:'unavailable'}]);
  const request=await f.request([ny,tokyo],action);expect((await f.service.bulk.apply(request,'owner')).items.every(i=>i.status==='applied')).toBe(true);
  expect(await f.service.get(ny.schedule_id)).toMatchObject({enabled:false,timed_pause:{until_at:preview.items[0]!.until_at}});
  const gap=await f.service.bulk.preview({schedule_ids:[ny.schedule_id,tokyo.schedule_id],action:{kind:'pause_until',local_time:'2027-03-14T02:30'}});expect(gap.items.map(i=>i.status)).toEqual(['unavailable','ready']);
});
it('confirms durable results after an encrypted reopen without repeating changes, and scopes request identities to the paired client',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'prompt-bulk-reopen-'));cleanup.push(()=>rmSync(dir,{force:true,recursive:true}));const file=join(dir,'chat.sqlite'),key=()=>new Uint8Array(32).fill(41);
  const f=fixture({file,key}),saved=await f.seed('Briefing'),request=await f.request([saved],{kind:'pause'});await f.service.bulk.apply(request,'first-client');const unsubmitted=await f.request([await f.service.get(saved.schedule_id)],{kind:'resume'});f.db.close();
  const next=fixture({file,key,instanceId:'replacement-server'});expect((await next.service.bulk.apply(request,'first-client')).items).toMatchObject([{status:'applied',replayed:true}]);expect((await next.service.get(saved.schedule_id)).revision).toBe(2);
  expect((await next.service.bulk.apply(unsubmitted,'first-client')).items).toMatchObject([{status:'needs_review'}]);
  expect((await next.service.bulk.apply(request,'second-client')).items).toMatchObject([{status:'needs_review'}]);
  await next.service.control('remove',{schedule_id:saved.schedule_id});expect((await next.service.bulk.apply(request,'first-client')).items).toMatchObject([{status:'applied',replayed:true}]);
});
it('rolls a clock mutation back with a failed receipt, retains successful siblings and retries only the unresolved subset',async()=>{
  const f=fixture(),rows=await Promise.all(['First','Second','Third'].map(n=>f.seed(n))),second=rows[1]!;
  const queued=await seedPromptRun(f.db,f.store,second,{key:'queued',due_at:NOW-1,status:'queued'}),request=await f.request(rows,{kind:'pause'});
  f.db.exec(`CREATE TRIGGER fail_bulk_receipt BEFORE INSERT ON chat_prompt_bulk_results WHEN NEW.schedule_id='${second.schedule_id}' BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END`);
  const result=await f.service.bulk.apply(request,'owner');expect(result.items.map(i=>i.status)).toEqual(['applied','failed','applied']);expect((await f.service.get(second.schedule_id)).revision).toBe(1);expect(f.queue.get(queued.turn_id)?.status).toBe('queued');
  f.db.exec('DROP TRIGGER fail_bulk_receipt');const retry={...request,items:request.items.filter(i=>i.schedule_id===second.schedule_id)};expect((await f.service.bulk.apply(retry,'owner')).items).toMatchObject([{schedule_id:second.schedule_id,status:'applied'}]);
  for(const row of rows)expect((await f.service.get(row.schedule_id)).revision).toBe(2);expect(f.queue.get(queued.turn_id)?.status).toBe('cancelled');
  expect((await f.service.bulk.apply(request,'owner')).items.every(i=>i.replayed)).toBe(true);
});
it('refuses edits, skipped clocks and newly queued work that appeared after review',async()=>{
  const f=fixture(),rows=await Promise.all(['Edited','Skipped','New work'].map(n=>f.seed(n))),request=await f.request(rows,{kind:'pause'});
  await f.service.update({schedule_id:rows[0]!.schedule_id,expected_revision:1,title:'Changed after review'});
  const skipped=rows[1]!;await f.service.changeSkip('skip_next',{schedule_id:skipped.schedule_id,expected_revision:1,expected_skip_revision:skipped.skip_state!.revision,run_at:skipped.skip_state!.next!.run_at});
  const work=await seedPromptRun(f.db,f.store,rows[2]!,{key:'new',due_at:NOW,status:'queued'});expect((await f.service.bulk.apply(request,'owner')).items.map(i=>i.status)).toEqual(['needs_review','needs_review','needs_review']);
  for(const row of rows)expect((await f.service.get(row.schedule_id)).enabled).toBe(true);expect(f.queue.get(work.turn_id)?.status).toBe('queued');
});
it('checks the queue again inside the mutation transaction after asynchronous reads',async()=>{
  let active=false,calls=0,entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
  const f=fixture({beforePlans:async()=>{if(active&&++calls===2){entered();await held;}}}),saved=await f.seed('Racing prompt');
  await seedPromptRun(f.db,f.store,saved,{key:'earlier',due_at:NOW-1,answer:'Earlier answer.'});const request=await f.request([saved],{kind:'pause'});
  active=true;const pending=f.service.bulk.apply(request,'owner');await started;const added=await seedPromptRun(f.db,f.store,saved,{key:'racing',due_at:NOW,status:'queued'});release();
  expect((await pending).items).toMatchObject([{status:'needs_review'}]);expect(await f.service.get(saved.schedule_id)).toMatchObject({enabled:true,revision:1});expect(f.queue.get(added.turn_id)?.status).toBe('queued');
});
it('previews Resume eligibility and clears a timed deadline only for the confirmed selection',async()=>{
  const f=fixture(),timed=await f.seed('Timed'),future=await f.seed('Future one-off',{mode:'one_shot',cron_expression:undefined,run_at:new Date(NOW+86400000).toISOString()}),past=await f.seed('Past one-off',{mode:'one_shot',cron_expression:undefined,run_at:new Date(NOW+60000).toISOString()}),active=await f.seed('Already active');
  await f.service.pauseUntil({schedule_id:timed.schedule_id,expected_revision:1,until_at:NOW+86400000});for(const row of [future,past])await f.service.control('pause',{schedule_id:row.schedule_id});f.now(NOW+120000);
  const preview=await f.service.bulk.preview({schedule_ids:[timed,future,past,active].map(r=>r.schedule_id),action:{kind:'resume'}});expect(preview.items.map(i=>i.status)).toEqual(['ready','ready','unavailable','unchanged']);expect(preview.items[0]?.first_run_at).toBe(Date.parse('2026-10-31T13:00Z'));
  const request=await f.request([timed,future,past,active],{kind:'resume'});expect((await f.service.bulk.apply(request,'owner')).items.every(i=>i.status==='applied')).toBe(true);
  expect(await f.service.get(timed.schedule_id)).toMatchObject({enabled:true,timed_pause:null,revision:3});expect(await f.service.get(past.schedule_id)).toMatchObject({enabled:false,revision:2});
});
it('validates bounded unique reviews, immutable request membership, paired callers and vault state',async()=>{
  let key:Uint8Array|null=new Uint8Array(32).fill(47);const f=fixture({key:()=>key}),saved=await f.seed('Private'),request=await f.request([saved],{kind:'pause'});
  for(const ids of [[],[saved.schedule_id,saved.schedule_id],Array.from({length:201},(_,i)=>String(i))])await expect(f.service.bulk.preview({schedule_ids:ids,action:{kind:'pause'}})).rejects.toMatchObject({code:'bad_request'});
  await f.service.bulk.apply(request,'owner');await expect(f.service.bulk.apply({...request,action:{kind:'resume'}},'owner')).rejects.toMatchObject({code:'conflict'});
  const another=await f.seed('Another'),other=await f.request([another],{kind:'pause'});await expect(f.service.bulk.apply({...other,request_id:request.request_id},'owner')).rejects.toMatchObject({code:'conflict'});
  const handlers=makeChatHandlers({store:f.store,orchestrator:{promptSchedules:f.service}} as ChatRpcDeps)!;
  for(const method of ['chat.schedules.bulk.preview','chat.schedules.bulk.apply'] as const){expect(handlers.methods).toContain(method);expect(CHAT_RPC_METHODS).toContain(method);expect(SERVER_RPC_METHODS).toContain(method);expect(isReservedLocalRpc(method)).toBe(true);const denied=method==='chat.schedules.bulk.preview'?handlers.handlers[method]!({schedule_ids:[saved.schedule_id],action:{kind:'pause'}},{instance_id:null} as never):handlers.handlers[method]!(request,{instance_id:null} as never);await expect(denied).rejects.toMatchObject({code:'unauthorized'});}
  key=null;await expect(f.service.bulk.apply(request,'owner')).rejects.toThrow(/locked/i);await expect(f.service.bulk.preview({schedule_ids:[saved.schedule_id],action:{kind:'pause'}})).rejects.toThrow(/locked/i);
});

it('finds current work through unfinished-queue and turn indexes instead of scanning completed occurrence history',async()=>{
  const f=fixture(),saved=await f.seed('Long-lived briefing');
  const detail=(f.db.prepare('EXPLAIN QUERY PLAN '+promptBulkWorkSql).all({session_id:saved.session_id,schedule_id:saved.schedule_id,revision:saved.revision}) as Array<{detail:string}>).map(row=>row.detail).join('\n');
  expect(detail).toContain('chat_prompt_bulk_unfinished');expect(detail).toContain('chat_prompt_occurrences_turn');expect(detail).not.toMatch(/SCAN (?:o|q)\b/);
});
