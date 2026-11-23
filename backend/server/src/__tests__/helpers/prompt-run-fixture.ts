import type Database from 'better-sqlite3';
import type { ChatQueuedTurnStatus, PromptSchedule } from '@recued/contracts';
import { planApproval } from '@recued/gateway';
import type { createSqliteChatPlanStore } from '../../storage/chat-plan-store.js';
import { encodeChatContentForStorage, type ChatKeyProvider, type ChatStore } from '../../storage/chat-store.js';

/** Retained run metadata and answers, without executing an AI request. */
export const seedPromptRun = async (db:Database.Database, store:ChatStore, saved:PromptSchedule, input:{
  key:string; trigger?:'scheduled'|'manual'; due_at:number; queued_at?:number; status?:ChatQueuedTurnStatus;
  admit?:boolean; unlinked?:boolean; answer?:string; getKey?:ChatKeyProvider;
}) => {
  const occurrence_id=input.trigger==='scheduled'?`${saved.schedule_id}:${saved.revision}:${input.due_at}`:`${saved.schedule_id}:manual:${input.key}`;
  const turn_id='history-turn-'+input.key, message_id='history-answer-'+input.key;
  const payload=await encodeChatContentForStorage(JSON.stringify(saved),{ session_id:saved.session_id,message_id:'occurrence:'+occurrence_id },input.getKey);
  if (input.admit!==false) {
    const command=await encodeChatContentForStorage(JSON.stringify({ family:'scheduled_prompt',session_id:saved.session_id,message:saved.prompt,input:{ occurrence_id } }),
      { session_id:saved.session_id,message_id:turn_id },input.getKey);
    db.prepare(`INSERT INTO chat_turn_queue (turn_id,session_id,family,status,fingerprint,payload,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(turn_id,saved.session_id,'scheduled_prompt',input.status??'completed','fixture',command,input.queued_at??input.due_at);
    db.prepare('INSERT INTO chat_turn_submissions (session_id,submission_id,turn_id,fingerprint) VALUES (?,?,?,?)')
      .run(saved.session_id,occurrence_id,turn_id,'fixture');
    if (input.answer!==undefined) await store.appendMessage({ id:message_id,session_id:saved.session_id,turn_id,role:'assistant',content:input.answer,
      target_server:'self',picker_at_send:{ display_name:'Self',signature:{ server_kind:'recued',version:'fixture',instance_id:'run-history' } },
      model_used:{ provider:'local',model_id:'fixture' },ts:(input.queued_at??input.due_at)+1 });
  }
  db.prepare('INSERT INTO chat_prompt_occurrences VALUES (?,?,?,?,?,?,?)').run(occurrence_id,saved.schedule_id,saved.session_id,saved.revision,input.due_at,
    input.admit===false||input.unlinked?null:turn_id,payload);
  return { occurrence_id,turn_id,message_id };
};

export const seedPromptContinuation = async (db:Database.Database,store:ChatStore,input:{ session_id:string;turn_id:string;at:number;answer?:string;status?:ChatQueuedTurnStatus }) => {
  db.prepare(`INSERT INTO chat_turn_queue (turn_id,session_id,family,status,fingerprint,payload,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(input.turn_id,input.session_id,'held_result',input.status??'completed','fixture','fixture',input.at);
  if (input.answer!==undefined) await store.appendMessage({ id:'answer-'+input.turn_id,session_id:input.session_id,turn_id:input.turn_id,role:'assistant',content:input.answer,
    target_server:'self',picker_at_send:{ display_name:'Self',signature:{ server_kind:'recued',version:'fixture',instance_id:'run-history' } },
    model_used:{ provider:'local',model_id:'fixture' },ts:input.at+1 });
};

export const seedPromptPlan = async (plans:ReturnType<typeof createSqliteChatPlanStore>,store:ChatStore,input:{plan_id:string;session_id:string;turn_id:string;at:number}) => {
  const args={to:'owner@example.com',body:input.plan_id};
  await plans.put({plan_id:input.plan_id,session_id:input.session_id,turn_id:input.turn_id,tool:'mail.send',tier:1,classification:'write',
    args,args_hash:planApproval.computePlanArgsHash(args),status:'proposed',created_at:input.at});
  const message_id='message-'+input.plan_id;
  await store.appendMessage({id:message_id,session_id:input.session_id,turn_id:input.turn_id,role:'assistant',content:'Approval for '+input.plan_id,target_server:'self',
    picker_at_send:{display_name:'Self',signature:{server_kind:'recued',version:'fixture',instance_id:'run-history'}},model_used:{provider:'local',model_id:'fixture'},ts:input.at});
  await plans.linkTurnToMessage!(input.session_id,input.turn_id,message_id);return message_id;
};
