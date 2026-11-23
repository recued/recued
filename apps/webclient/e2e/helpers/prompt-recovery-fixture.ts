import Database from 'better-sqlite3';
import type { Page } from '@playwright/test';
import { RpcError, type PromptSchedule, type PromptScheduleInput, type PromptSchedulePreview, type PromptScheduleUpdate } from '@recued/contracts';
import { createChatStore, ensureChatSchema } from '../../../../backend/server/src/storage/chat-store.js';
import { createSqliteChatPlanStore } from '../../../../backend/server/src/storage/chat-plan-store.js';
import { createChatTurnQueueStore } from '../../../../backend/server/src/storage/chat-turn-queue-store.js';
import { createPromptSchedules } from '../../../../backend/server/src/prompt-schedules.js';
import { makeChatHandlers, type ChatRpcDeps } from '../../../../backend/server/src/chat-handler.js';
import { seedPromptRun,seedPromptPlan,seedPromptContinuation } from '../../../../backend/server/src/__tests__/helpers/prompt-run-fixture.js';
import type { PromptCreationRequest } from '../../src/automation/prompt-draft-recovery.js';

export const PROMPT_RECOVERY_NOW = Date.parse('2026-10-31T12:00:00Z');
/** Actual SQLite schedule creation and RPC handlers; transport and advertised
 * capabilities are controlled. No scheduled request is executed by this fixture. */
export const installPromptRecoveryFixture = async (page: Page) => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); ensureChatSchema(db);
  const store = createChatStore(db), plans = createSqliteChatPlanStore(db); createChatTurnQueueStore(db);
  let now = PROMPT_RECOVERY_NOW, runs = 0;
  const service = createPromptSchedules({ db, store, instanceId: 'prompt-recovery-server', now: () => now,
    queue: { register() {} } as never, readPlans: (session,turn) => plans.listForTurn(session,turn),
    runTurn: async () => { runs++; throw new Error('Draft recovery must not execute a scheduled request.'); } });
  const handlers = makeChatHandlers({ store, orchestrator: { promptSchedules: service } } as ChatRpcDeps)!.handlers;
  const client = { instance_id: 'prompt-recovery-client', client_kind: 'webclient' } as never;
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [], creates: PromptCreationRequest[] = [];
  const updates: PromptScheduleUpdate[] = [];
  const bulkRequests:Array<Record<string,unknown>>=[];
  let bulkFault:'none'|'lost'|'bad-ack'='none',bulkPreviewFault:'none'|'hold'|'fail'='none',releaseBulkPreview:(()=>void)|undefined;
  let holdBulk = false, releaseBulk: (() => void) | undefined;
  const bulkFailures=new Set<string>();
  const pauseRequests:Array<Record<string,unknown>>=[];
  let pauseFault:'none'|'lost'|'bad-ack'='none',pausePreviewFault:'none'|'fail'|'hold'|'bad-ack'='none',releasePausePreview:(()=>void)|undefined;
  const historyRequests:Array<Record<string,unknown>>=[];
  let historyFault:'none'|'fail'|'hold'|'wrong-target'='none',releaseHistory:(()=>void)|undefined;
  const skipChanges: Array<{ action: 'skip_next' | 'undo_skip'; request: Record<string, unknown> }> = [];
  let skipFault: 'none' | 'lost' | 'refuse' | 'hold-before' | 'bad-ack' = 'none';
  let skipPreviewFault: 'none' | 'fail' | 'hold' | 'bad-ack' = 'none';
  let releaseSkip: (() => void) | undefined, releaseSkipPreview: (() => void) | undefined;
  let updateFault: 'none' | 'lost' | 'refuse' | 'hold-before' | 'hold-after' | 'not-applied' | 'bad-ack' = 'none';
  let releaseUpdate: (() => void) | undefined, completedUpdates = 0;
  let capability: 'current' | 'old' | 'missing' = 'current', fault: 'none' | 'lost' | 'refuse' | 'hold' | 'bad-ack' = 'none';
  let releaseCreate: (() => void) | undefined, latest: PromptSchedule | undefined, failPreview = false, failList = false, previewUnsupported = false;
  let listMode: 'normal' | 'unsupported' | 'malformed' = 'normal', holdList = false, releaseList: (() => void) | undefined;
  let afterList: (() => Promise<unknown>) | undefined;
  const overlays = new Map<string, Partial<PromptSchedule>>();
  const advertised = (row: PromptSchedule): PromptSchedule => {
    if (capability === 'current') return row;
    const { model_source_id: _model, notify_on_done: _notify, skip_state: _skip, run_history_available: _history, timed_pause: _pause, bulk_control_available: _bulk, ...legacy } = row; return legacy;
  };
  await page.exposeFunction('__promptRecoveryRpc', async (method: string, args: Record<string, unknown> = {}) => {
    if (method === 'chat.session.get') {
      const session = typeof args.session_id === 'string' ? store.getSession(args.session_id) : undefined;
      // Conversations created by the real schedule service must open under
      // their own ID; leave the harness's ordinary chat fixtures untouched.
      return session ? { result: { ...session, messages: await store.listMessages(session.id), plans: await plans.listForSession!(session.id) } } : undefined;
    }
    calls.push({ method, args: structuredClone(args) });
    try {
      const bulkOutcome=method==='chat.schedules.bulk.apply'?bulkFault:'none',bulkReviewOutcome=method==='chat.schedules.bulk.preview'?bulkPreviewFault:'none';
      if(method==='chat.schedules.bulk.apply'){bulkFault='none';bulkRequests.push(structuredClone(args));}
      if(method==='chat.schedules.bulk.preview')bulkPreviewFault='none';
      if(['chat.schedules.bulk.apply','chat.schedules.bulk.preview'].includes(method)&&capability!=='current')throw new RpcError('unknown_method','Bulk controls are unavailable.',404);
      if(bulkReviewOutcome==='fail')throw Error('The bulk review was interrupted.');
      const pauseOutcome=method==='chat.schedule.pause_until'?pauseFault:'none',pausePreviewOutcome=method==='chat.schedule.pause_preview'?pausePreviewFault:'none';
      if(method==='chat.schedule.pause_until'){pauseFault='none';pauseRequests.push(structuredClone(args));}
      if(method==='chat.schedule.pause_preview')pausePreviewFault='none';
      if(['chat.schedule.pause_until','chat.schedule.pause_preview'].includes(method)&&capability!=='current')throw new RpcError('unknown_method','Timed pauses are unavailable.',404);
      if(pausePreviewOutcome==='fail')throw Error('The pause preview was interrupted.');
      const historyOutcome=method==='chat.schedule.runs.list'?historyFault:'none';
      if(method==='chat.schedule.runs.list') {
        historyFault='none';historyRequests.push(structuredClone(args));
        if(capability!=='current') throw new RpcError('unknown_method','Recent runs are unavailable.',404);
      }
      if(historyOutcome==='fail')throw Error('The run history read was interrupted.');
      const skipAction = method === 'chat.schedule.skip_next' ? 'skip_next' : method === 'chat.schedule.undo_skip' ? 'undo_skip' : undefined;
      const changeFault = skipAction ? skipFault : 'none'; if (skipAction) { skipFault = 'none'; skipChanges.push({ action: skipAction, request: structuredClone(args) }); }
      if ((skipAction || method === 'chat.schedule.skip_preview') && capability !== 'current') throw new RpcError('unknown_method', 'Unknown scheduled skip method', 404);
      if (changeFault === 'refuse') throw new RpcError('bad_request', 'The run change was refused.', 400);
      if (changeFault === 'hold-before') await new Promise<void>(done => { releaseSkip = done; });
      const previewFault = method === 'chat.schedule.skip_preview' ? skipPreviewFault : 'none'; if (method === 'chat.schedule.skip_preview') skipPreviewFault = 'none';
      if (previewFault === 'fail') throw new Error('Skip preview temporarily unavailable.');
      let currentUpdateFault: typeof updateFault = 'none';
      if (method === 'chat.schedule.update') {
        updates.push(structuredClone(args) as unknown as PromptScheduleUpdate);
        currentUpdateFault = updateFault; updateFault = 'none';
        if (currentUpdateFault === 'refuse') throw new RpcError('bad_request', 'The edit was refused before saving.', 400);
        if (currentUpdateFault === 'not-applied') throw new RpcError('timeout', 'The update did not reach the server.', 504);
        if (currentUpdateFault === 'hold-before') await new Promise<void>(done => { releaseUpdate = done; });
        if (capability !== 'current' && (args.model_source_id !== undefined || args.notify_on_done !== undefined))
          throw new RpcError('bad_request', 'This server does not support these optional fields.', 400);
      }
      if (method === 'chat.schedules.list' && failList) { failList = false; throw new Error('The scheduled prompt refresh was interrupted.'); }
      if (method === 'chat.schedules.list' && listMode === 'unsupported') throw new RpcError('unknown_method', 'Unknown scheduled prompts method', 404);
      if (method === 'chat.schedule.preview' && (capability === 'missing' || previewUnsupported)) throw new RpcError('unknown_method', 'Unknown preview method', 404);
      if (method === 'chat.schedule.preview' && failPreview) { failPreview = false; throw new Error('Preview temporarily unavailable.'); }
      if (method === 'chat.schedule.create') {
        creates.push(structuredClone(args) as unknown as PromptCreationRequest);
        if (fault === 'refuse') { fault = 'none'; throw new RpcError('bad_request', 'The draft was refused before creation.', 400); }
        if (capability !== 'current' && (args.model_source_id !== undefined || args.notify_on_done !== undefined))
          throw new RpcError('bad_request', 'This server does not support these optional fields.', 400);
      }
      const handler = handlers[method as keyof typeof handlers] as (args: never, client: never) => Promise<unknown>;
      let result = await handler(args as never, client);
      if (method === 'chat.schedules.bulk.apply' && holdBulk) { holdBulk = false; await new Promise<void>(done => { releaseBulk = done; }); }
      if(bulkReviewOutcome==='hold')await new Promise<void>(done=>{releaseBulkPreview=done;});
      if(bulkOutcome==='lost')throw new RpcError('timeout','The bulk change reply was lost.',504);
      if(bulkOutcome==='bad-ack')result={items:[]};
      if(pausePreviewOutcome==='hold')await new Promise<void>(done=>{releasePausePreview=done;});
      if(pausePreviewOutcome==='bad-ack')result={...result as object,first_run_at:0};
      if(pauseOutcome==='lost')throw new RpcError('timeout','The timed pause reply was lost.',504);
      if(pauseOutcome==='bad-ack')result=null;
      if(historyOutcome==='hold')await new Promise<void>(done=>{releaseHistory=done;});
      if(historyOutcome==='wrong-target')result={...result as object,schedule_id:'another-prompt'};
      if (previewFault === 'hold') await new Promise<void>(done => { releaseSkipPreview = done; });
      if (previewFault === 'bad-ack') result = { ...result as object, following_run_at: 0 };
      if (changeFault === 'lost') throw new RpcError('timeout', 'The run change reply was lost.', 504);
      if (changeFault === 'bad-ack') result = null;
      if (method === 'chat.schedule.update') {
        if (currentUpdateFault === 'hold-after') await new Promise<void>(done => { releaseUpdate = done; });
        if (currentUpdateFault === 'lost') throw new RpcError('timeout', 'The update reply was lost.', 504);
        result = currentUpdateFault === 'bad-ack' ? null : advertised(result as PromptSchedule);
      }
      if (method === 'chat.schedules.list') {
        result = listMode === 'malformed' ? { items: [] } : (result as PromptSchedule[]).map(row => advertised({ ...row, ...overlays.get(row.schedule_id) }));
        const advance = afterList; afterList = undefined; await advance?.();
        if (holdList) { holdList = false; await new Promise<void>(done => { releaseList = done; }); }
      }
      if (method === 'chat.schedule.preview' && capability !== 'current') {
        const { model_choice_available: _model, notify_on_done_available: _notify, ...legacy } = result as PromptSchedulePreview; result = legacy;
      }
      if (method === 'chat.schedule.create') {
        latest = result as PromptSchedule; const outcome = fault; fault = 'none';
        if (outcome === 'hold') await new Promise<void>(done => { releaseCreate = done; });
        if (outcome === 'lost') throw new RpcError('timeout', 'The creation reply was lost.', 504);
        result = outcome === 'bad-ack' ? null : advertised(result as PromptSchedule);
      }
      return { result };
    } catch (failure) {
      return { error: { code: failure instanceof RpcError ? failure.code : 'unavailable', message: failure instanceof Error ? failure.message : String(failure) } };
    } finally { if (method === 'chat.schedule.update') completedUpdates++; }
  });
  await page.addInitScript(() => {
    Object.assign(window, { __promptHistoryReplies:0,__connectionsFixture: async (method: string, args: unknown) => {
      if(!['chat.session.get', 'chat.schedules.list', 'chat.schedule.preview', 'chat.schedule.create', 'chat.schedule.update', 'chat.schedule.pause', 'chat.schedule.resume', 'chat.schedule.remove',
        'chat.schedules.bulk.preview', 'chat.schedules.bulk.apply', 'chat.schedule.pause_preview', 'chat.schedule.pause_until', 'chat.schedule.skip_preview', 'chat.schedule.skip_next', 'chat.schedule.undo_skip', 'chat.schedule.runs.list'].includes(method))return undefined;
      const result=await(window as unknown as { __promptRecoveryRpc(method: string, args: unknown): Promise<unknown> }).__promptRecoveryRpc(method,args);
      if(method==='chat.schedule.runs.list')(window as unknown as {__promptHistoryReplies:number}).__promptHistoryReplies++;
      return result;
    } });
  });
  return { calls, creates, updates, skipChanges, historyRequests, pauseRequests, bulkRequests,
    nextBulk:(value:typeof bulkFault)=>{bulkFault=value;},nextBulkPreview:(value:typeof bulkPreviewFault)=>{bulkPreviewFault=value;},
    holdNextBulkReply: () => { holdBulk = true; }, bulkPending: () => releaseBulk !== undefined,
    releaseBulk: () => { if (!releaseBulk) throw Error('No held bulk reply.'); const done = releaseBulk; releaseBulk = undefined; done(); },
    bulkPreviewPending:()=>releaseBulkPreview!==undefined,releaseBulkPreview:()=>{if(!releaseBulkPreview)throw Error('No held bulk preview.');const done=releaseBulkPreview;releaseBulkPreview=undefined;done();},
    failBulkFor:(id:string)=>{if(!/^[a-z0-9_-]+$/i.test(id))throw Error('Invalid fixture identity.');db.exec("CREATE TRIGGER IF NOT EXISTS fail_selected_bulk BEFORE INSERT ON chat_prompt_bulk_results WHEN NEW.schedule_id='"+id+"' BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END");bulkFailures.add(id);},
    clearBulkFailure:()=>{db.exec('DROP TRIGGER IF EXISTS fail_selected_bulk');bulkFailures.clear();},
    nextPause:(value:typeof pauseFault)=>{pauseFault=value;},nextPausePreview:(value:typeof pausePreviewFault)=>{pausePreviewFault=value;},
    pausePreviewPending:()=>releasePausePreview!==undefined,releasePausePreview:()=>{if(!releasePausePreview)throw Error('No held pause preview.');const done=releasePausePreview;releasePausePreview=undefined;done();},
    pauseUntil:service.pauseUntil,tick:()=>service.tick(), runs: () => runs, setNow: (value: number) => { now = value; },
    nextHistory:(value:typeof historyFault)=>{historyFault=value;},historyPending:()=>releaseHistory!==undefined,
    releaseHistory:()=>{if(!releaseHistory)throw Error('No held history read.');const done=releaseHistory;releaseHistory=undefined;done();},
    seedRun:(row:PromptSchedule,input:Omit<Parameters<typeof seedPromptRun>[3],'getKey'>)=>seedPromptRun(db,store,row,input),
    seedPlan:(row:PromptSchedule,turn:string,id:string)=>seedPromptPlan(plans,store,{plan_id:id,session_id:row.session_id,turn_id:turn,at:now}),
    seedContinuation:(input:Parameters<typeof seedPromptContinuation>[2])=>seedPromptContinuation(db,store,input),
    nextSkip: (value: typeof skipFault) => { skipFault = value; }, nextSkipPreview: (value: typeof skipPreviewFault) => { skipPreviewFault = value; },
    skipPending: () => releaseSkip !== undefined, skipPreviewPending: () => releaseSkipPreview !== undefined,
    releaseSkip: () => { if (!releaseSkip) throw Error('No held skip.'); const done = releaseSkip; releaseSkip = undefined; done(); },
    releaseSkipPreview: () => { if (!releaseSkipPreview) throw Error('No held skip preview.'); const done = releaseSkipPreview; releaseSkipPreview = undefined; done(); },
    skip: (action: 'skip_next' | 'undo_skip', input: unknown) => service.changeSkip(action, input),
    nextUpdate: (value: typeof updateFault) => { updateFault = value; }, updatePending: () => releaseUpdate !== undefined,
    completedUpdates: () => completedUpdates,
    releaseUpdate: () => { if (!releaseUpdate) throw Error('No held update.'); const done = releaseUpdate; releaseUpdate = undefined; done(); },
    seed: async (input: Partial<PromptScheduleInput> = {}) => (await service.create({ title: 'Kestrel briefing', prompt: 'Summarize the customer renewal. Keep the exact context.',
      mode: 'recurring', time_zone: 'America/New_York', cron_expression: '15 9 * * 1-5', ...input }, crypto.randomUUID()))!,
    get: (id: string) => service.get(id),
    update: (input: PromptScheduleUpdate) => service.update(input),
    remove: (id: string) => service.control('remove', { schedule_id: id }),
    pause: (id: string) => service.control('pause', { schedule_id: id }),
    // Outcome overlays model transport metadata without executing an AI request.
    overlay: (id: string, patch: Partial<PromptSchedule>) => overlays.set(id, patch),
    listMode: (value: typeof listMode) => { listMode = value; },
    afterNextList: (advance: () => Promise<unknown>) => { afterList = advance; },
    holdNextList: () => { holdList = true; }, listPending: () => releaseList !== undefined,
    releaseList: () => { if (!releaseList) throw Error('No held list.'); const done = releaseList; releaseList = undefined; done(); },
    capabilities: (value: typeof capability) => { capability = value; },
    previewUnsupported: (value: boolean) => { previewUnsupported = value; },
    failNextPreview: () => { failPreview = true; },
    failNextList: () => { failList = true; },
    loseNextCreate: () => { fault = 'lost'; }, refuseNextCreate: () => { fault = 'refuse'; },
    holdNextCreate: () => { fault = 'hold'; }, badNextAcknowledgement: () => { fault = 'bad-ack'; },
    createPending: () => releaseCreate !== undefined,
    releaseCreate: () => { if (!releaseCreate) throw Error('No held creation.'); const done = releaseCreate; releaseCreate = undefined; done(); },
    latest: async () => latest ? service.get(latest.schedule_id) : undefined,
    pauseLatest: async () => { if (!latest) throw Error('No schedule.'); return service.control('pause', { schedule_id: latest.schedule_id }); },
    scheduleCount: () => (db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_schedules').get() as { n: number }).n,
    conversationCount: () => (db.prepare('SELECT COUNT(*) AS n FROM chat_sessions').get() as { n: number }).n,
    dispose: () => { releaseCreate?.(); releaseList?.(); releaseUpdate?.(); releaseSkip?.(); releaseSkipPreview?.(); releaseHistory?.(); releasePausePreview?.(); releaseBulkPreview?.(); releaseBulk?.(); db.close(); },
  };
};
