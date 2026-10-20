/** The normal handler, approval resumer and Chat dispatch, with local stores. */
import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ChatDispatchResult, InternalToolRegistry, RecipeDefinition, ToolEntry, ExecutionSource, ContractSnapshot } from '@recued/contracts';
import { createOrdinaryLocalMutations } from '../ordinary-local-mutations.js';
import { createGatedActionStore, createSqliteGatedActionCompareAndSet,
  createSqliteGatedActionChangeClock, GATED_ACTION_TABLE, type GatedActionRecord,
  reconcileInterruptedGatedActionsAtBoot } from '../gated-action-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { handleExecute } from '../execute-handler.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { createChatOrchestrator, type ChatBroadcastEmitter } from '../chat-orchestrator.js';
import { calendarChatUpdateInput } from '../collections/calendar/chat-update-input.js';
import { resourceFixture } from './preapproval-resources-fixture.js';

export const ordinaryLocalFixture = async (previous?: Parameters<typeof resourceFixture>[0]) => {
  const f = await resourceFixture(previous);
  const local = createOrdinaryLocalMutations(f.db, () => f.clock.now);
  f.execution.localMutations = local;
  f.execution.commitStore = local.wrapStore(f.execution.commitStore!);
  const clock = createSqliteGatedActionChangeClock(f.db);
  f.execution.gatedActionStore = createGatedActionStore(createSQLiteCollection<GatedActionRecord>(f.db, GATED_ACTION_TABLE), {
    now: () => f.clock.now, compareAndSet: createSqliteGatedActionCompareAndSet(f.db),
    nextChangeSeq: clock.nextChangeSeq, changeClock: clock.snapshot, localMutationReceipt: local.forAction,
  });
  f.execution.preflightNotifier = f.block;
  f.contracts.put('owner_operation', ['calendar-update', 'calendar-update'], { approval: 'always', op_hash: 'fixture-review' });
  f.contracts.put('owner_operation', ['calendar-delete', 'calendar-delete'], { approval: 'always', op_hash: 'fixture-review' });
  const hold = async (steps: RecipeDefinition['steps'], origin?: { source: ExecutionSource; contract_snapshot?: ContractSnapshot; grant: string }, config: Record<string, unknown> = {}) => {
    f.save(steps);
    const result = await handleExecute(f.execution, { recipe_id: f.recipe.recipe_id, config, execution_source: origin?.source ?? f.origin.source,
      ...(origin?.contract_snapshot ? { contract_snapshot: origin.contract_snapshot } : {}) },
    origin ? { granted_by_recipe: origin.grant } : {});
    if (!result.awaiting_approval || !result.action_ref) throw new Error('Expected an ordinary owner approval: ' + JSON.stringify(result));
    const action = (await f.execution.gatedActionStore!.get(result.action_ref))!;
    if (!action) throw new Error('Missing action: ' + JSON.stringify({ result, actions: await f.execution.gatedActionStore!.list(),
      raw: f.db.prepare('SELECT data FROM ' + GATED_ACTION_TABLE).all() }));
    const checkpoint = (await f.execution.checkpointStore!.listByRun(action.run_id))[0]!;
    return { result, action, checkpoint,
      resume: () => createPreflightResumer({ getExecuteDeps: () => f.execution, auditLog: f.execution.auditLog!,
        gatedActionStore: f.execution.gatedActionStore }).resumeRun(checkpoint,
      { recipe_id: checkpoint.recipe_id, gated_step_id: checkpoint.gated_step_id }) };
  };
  const recover = async () => {
    await reconcileInterruptedGatedActionsAtBoot(f.execution.gatedActionStore!);
    return f.execution.commitStore!.sweepPendingToInDoubt();
  };
  const chat = async () => {
    ensureChatSchema(f.db);
    const chatKey = { value: new Uint8Array(32).fill(8) as Uint8Array | null };
    const store = createChatStore(f.db, () => chatKey.value);
    const session_id = randomUUID(); store.createSession({ id: session_id, now: f.clock.now });
    const plans = createSqliteChatPlanStore(f.db, () => chatKey.value, () => f.clock.now);
    const events: Array<Parameters<ChatBroadcastEmitter['emit']>[0]> = [];
    const entry: ToolEntry = { name: 'calendar.update', tier: 1, description: 'Update local event',
      arg_schema: { type: 'object' }, topic_tags: ['calendar'], classification: 'write', concurrency_safe: false };
    const invoke = vi.fn(async (_name: string, args: unknown): Promise<ChatDispatchResult> => ({ ok: true,
      result: await f.execution.executorConfig.kernelDispatchers!.calendarUpdate!(calendarChatUpdateInput(args as Record<string, unknown>)) }));
    const registry: InternalToolRegistry = { list: () => [entry], listByTier: tier => tier === 1 ? [entry] : [],
      getByName: name => name === entry.name ? entry : null, dispatch: invoke, subscribeRefresh: () => () => {} };
    const authority = { allowed: true };
    const orchestrator = createChatOrchestrator({ chatStore: store, registry, broadcast: { emit: event => events.push(event) },
      auditLog: f.execution.auditLog!, selfSignature: { server_kind: 'recued', version: '1.0.0', instance_id: 'ordinary-local-test' },
      planApprovalStore: plans, getResourceReview: () => f.execution.executorConfig.resourceReview,
      validateLocalMutation: () => { if (!authority.allowed) throw new Error('Original Chat permission revoked'); }, now: () => f.clock.now });
    const args = { calendar_id: 'local', source_id: 'meeting', summary: 'Chat reviewed meeting' };
    const dispatch = (turn_id: string) => orchestrator.dispatch.dispatchTool({ session_id, turn_id,
      tool_name: entry.name, arg_values: args, picker_target: 'self' });
    await dispatch('proposal');
    const proposal = (await plans.listPending(session_id))[0]!;
    if (!proposal) throw new Error('Expected a Chat approval');
    await plans.resolve(proposal.plan_id, 'approved', f.clock.now);
    return { plans, store, session_id, proposal, dispatch, invoke, events, chatKey, authority };
  };
  return { ...f, hold, recover, local, chat,
    reopenOrdinary: async () => { await f.close(); return ordinaryLocalFixture({ dir: f.dir, clock: f.clock, token: f.token }); } };
};
