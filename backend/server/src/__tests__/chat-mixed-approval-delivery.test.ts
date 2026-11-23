import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import type { InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { BRIEF_INSTRUCTION, __clearSessionBriefs, __clearUnfoldedUserMessages } from '../chat-rolling-brief.js';

it('suppresses mixed-release planning prose and delivers the approval reply without a send effect', async () => {
  const db = new Database(':memory:');
  try {
    ensureChatSchema(db); const key = new Uint8Array(32).fill(8), chat = createChatStore(db, () => key), plans = createSqliteChatPlanStore(db, () => key);
    chat.createSession({ id: 'mixed', now: 1 }); chat.setRollingBriefEnabled(true);
    let phase = 0, ids = 0, time = 100, effects = 0, mainCalls = 0;
    const args = { to: 'ops@example.test', body: 'Updated' }, seen: any[] = [];
    const tool: ToolEntry = { name: 'mail.send', tier: 1, classification: 'write', description: 'Send email', arg_schema: { type: 'object' }, topic_tags: ['mail'], concurrency_safe: false };
    const registry: InternalToolRegistry = { list: () => [tool], listByTier: () => [tool], getByName: n => n === tool.name ? tool : null,
      subscribeRefresh: () => () => {}, dispatch: async () => { effects++; return { ok: true, result: { sent: true } }; } };
    const orchestrator = createChatOrchestrator({ chatStore: chat, registry, planApprovalStore: plans,
      readPendingApprovalRows: s => plans.readPendingEvidenceRows(s), readCompletedHeldActionRows: s => plans.readCompletedHeldEvidenceRows(s),
      selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'mixed' }, broadcast: { emit: () => {} }, mintId: () => 'mixed-' + (++ids), now: () => ++time,
      executeAiCall: async (_manifest, input) => {
        const p = JSON.parse(String(input['llm.prompt']));
        if (String(input['llm.system_prompt']).startsWith(BRIEF_INSTRUCTION)) throw new Error('This fixture does not force a fold');
        if (!phase) return { body: { response: 'Mail changes are held.', events: [], tool_calls: [] } };
        mainCalls++; seen.push(p);
        return { body: mainCalls === 1 ? { response: 'Sending the email now.', events: [], tool_calls: [{ tool: 'mail.send', args }] }
          : { response: 'Waiting for your approval to send the email.', events: [], tool_calls: [] } };
      } });
    await orchestrator.runTurn({ session_id: 'mixed', message: 'Hold mail changes until MAIL GO.', picker_state: { current: 'self' } });
    phase++;
    const result = await orchestrator.runTurn({ session_id: 'mixed', message: 'MAIL GO. Send an email to ops@example.test with body "Updated".', picker_state: { current: 'self' } });
    // Current Chat ends an entirely held round with its native approval reply.
    // The planner's earlier Sending prose never becomes the saved reply.
    expect(mainCalls).toBe(1); expect(effects).toBe(0);
    const pending = await plans.listPending('mixed'); expect(pending).toHaveLength(1); expect(pending[0]!.args).toEqual(args);
    expect(pending[0]!.consumed_at).toBeUndefined();
    // Nothing reads the owner's request before a turn (the owner, 2026-11-18: the brief only summarises).
    expect(seen[0].response_purpose).toBeUndefined(); expect(seen[0].request_execution_context?.current_assignment).toBeUndefined();
    const replies = (await chat.listMessages('mixed')).filter(m => m.turn_id === result.turn_id && m.role === 'assistant');
    expect(replies).toHaveLength(1);
    expect(replies[0]!.content).toMatch(/^Waiting for your approval:/);
    expect(replies[0]!.content).not.toContain('Sending the email now.');
  } finally { db.close(); __clearSessionBriefs(); __clearUnfoldedUserMessages(); }
});
