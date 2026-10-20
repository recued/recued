import type { ChatMessage, ChatPlanRecord } from '@recued/contracts';

/** A persisted confirmation, with the caller's old uncertainty retained. */
export const ordinaryLocalChatFixture = (now: number, confirmed = true): { messages: ChatMessage[]; plans: ChatPlanRecord[] } => ({
  messages: [{ id: 'message_local_confirmed', session_id: 'chat_1', turn_id: 'proposal_local',
    role: 'assistant', contributor: 'model', content: 'The reviewed Calendar change has a saved confirmation.', target_server: 'self',
    picker_at_send: { display_name: 'This server', signature: { server_kind: 'recued', version: '1.0.0', instance_id: 'local-proof-fixture' } },
    model_used: { provider: 'local', model_id: 'fixture' }, ts: now - 60_000 }],
  plans: [{ plan: { plan_id: 'plan_local_confirmed', session_id: 'chat_1', turn_id: 'proposal_local',
    tool: 'calendar.update', tier: 1, classification: 'write', args: { calendar_id: 'local', source_id: 'meeting', summary: 'Reviewed meeting' },
    args_hash: 'aaaaaaaaaaaaaaaa', status: 'approved', created_at: now - 60_000, resolved_at: now - 50_000, consumed_at: now - 40_000 },
    message_id: 'message_local_confirmed', execution: confirmed ? { status: 'completed', turn_id: 'execution_local',
      result_ref: 'local-mutation:lmr_77777777-7777-4777-8777-777777777777', recovered_from: 'unknown',
      local_receipt: { receipt_id: 'lmr_77777777-7777-4777-8777-777777777777', kind: 'local_calendar', committed_at: now - 40_000 } }
      : { status: 'unknown', turn_id: 'execution_local' },
    payload_available: true }],
});
