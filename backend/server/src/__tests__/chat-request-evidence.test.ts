import {describe, expect, it} from 'vitest';
import type {ChatMessage, ToolEntry} from '@recued/contracts';
import {requestExecutionEvidence, resolveRequestActionOutcomes} from '../chat-request-evidence.js';

const message = (id: string, turn: string, role: ChatMessage['role'], content: string, ts: number): ChatMessage => ({
  id, session_id: 's', turn_id: turn, role, content, ts, target_server: 'self',
  picker_at_send: {display_name: 'Self', signature: {server_kind: 'recued', version: 'test', instance_id: 'local'}},
  model_used: {provider: 'test', model_id: 'test'},
  contributor: role === 'user' ? 'user' : role === 'tool' ? 'tool_result' : 'model',
});
const registry = {getByName: (name: string): ToolEntry => ({name, tier: 1, description: name, arg_schema: {type: 'object'},
  topic_tags: [], concurrency_safe: false, classification: name === 'work.read' || name === 'recall.search' ? 'read' : 'write'})};
const pair = (id: string, turn: string, name = 'fixture.send_update', state: NonNullable<ChatMessage['tool_call']>['state'] = 'succeeded', result: unknown = {message_id: id}): ChatMessage[] => {
  const at = turn === 'old' ? 2 : 5;
  const call = message(id, turn, 'tool', `${name}({"text":"same payload"})`, at);
  call.tool_call = {message_id: id, session_id: 's', turn_id: turn, tool_name: name, state, started_at: at, updated_at: at + 1};
  return [call, message(`${id}:result`, turn, 'tool', `${name}: ${JSON.stringify({ok: true, result})}`, at + 1)];
};

describe('host request execution evidence', () => {
  it('retains failed attempts as unknown when no operation receipt adapter is installed', async () => {
    const history = [message('owner', 'new', 'user', 'Send the update.', 1),
      ...pair('uncertain', 'new', 'fixture.send_update', 'failed')];
    const raw = requestExecutionEvidence(history, 's', 'new', registry)!;
    const evidence = await resolveRequestActionOutcomes(raw, 's');
    expect(evidence.successful_calls_for_current_request).toEqual([]);
    expect(evidence.unsuccessful_action_attempts).toBeUndefined();
    expect(evidence.resolved_action_outcomes).toEqual([expect.objectContaining({
      invocation_id: 'uncertain', request_id: 'new', outcome: 'unknown', resolution: 'unavailable',
      attempt_state: 'failed', owner_request: expect.objectContaining({ text: 'Send the update.' }),
    })]);
    expect(evidence.resolved_action_outcomes![0]!.receipt).toBeUndefined();
    expect(evidence.coverage?.incomplete).toBe(true);
  });

  it('does not promote a receipt whose identity differs from the failed invocation', async () => {
    const raw = requestExecutionEvidence([message('owner', 'new', 'user', 'Send the update.', 1),
      ...pair('uncertain', 'new', 'fixture.send_update', 'failed')], 's', 'new', registry)!;
    const evidence = await resolveRequestActionOutcomes(raw, 's', async queries => queries.map(query => ({
      ...query, args: { text: 'another request' }, outcome: 'completed', observed_at: 9,
      receipt: { receipt_id: 'receipt', epoch: 'current', settled_at: 8 },
    })), { now: () => 10 });
    expect(evidence.resolved_action_outcomes).toEqual([expect.objectContaining({ outcome: 'unknown', resolution: 'unavailable' })]);
    expect(evidence.resolved_action_outcomes![0]!.receipt).toBeUndefined();
  });

  it('separates historical completion from a new request and preserves two identical current effects', () => {
    const old = message('old-owner', 'old', 'user', 'Send once.', 1);
    const current = message('new-owner', 'new', 'user', 'Send two new copies.', 4);
    const history = [old, ...pair('old-send', 'old'), current, ...pair('new-send-1', 'new'), ...pair('new-send-2', 'new')];
    const evidence = requestExecutionEvidence(history, 's', 'new', registry)!;
    expect(evidence.current_request.request_id).toBe('new');
    expect(evidence.earlier_requests.map(r => r.request_id)).toEqual(['old']);
    expect(evidence.successful_actions_for_earlier_requests.map(r => r.invocation_id)).toEqual(['old-send']);
    expect(evidence.successful_calls_for_current_request.map(r => r.invocation_id)).toEqual(['new-send-1', 'new-send-2']);
    expect(evidence.successful_calls_for_current_request.every(r => r.completed_for_request_id === 'new')).toBe(true);
  });

  it('does not turn assistant claims, held/failed calls, recall or mismatched result rows into completed effects', () => {
    const current = message('owner', 'new', 'user', 'Check the outcome.', 1);
    const wrongTurn = pair('wrong-turn', 'new'); wrongTurn[1]!.turn_id = 'other';
    const wrongSession = pair('wrong-session', 'new'); wrongSession[1]!.session_id = 'other';
    const history = [current, message('claim', 'new', 'assistant', 'Everything was sent.', 2),
      ...pair('held', 'new', 'fixture.send_update', 'held'), ...pair('failed', 'new', 'fixture.send_update', 'failed'),
      ...pair('queued', 'new', 'fixture.send_update', 'succeeded', {awaiting_approval: true}),
      ...pair('recall', 'new', 'recall.search'), ...wrongTurn, ...wrongSession, ...pair('read', 'new', 'work.read')];
    expect(requestExecutionEvidence(history, 's', 'new', registry)!.successful_calls_for_current_request.map(r => r.invocation_id)).toEqual(['read']);
  });

  it('pairs identical unfolded questions with their own recorded answers and preserves their earlier request identity', () => {
    const question = 'What is that duration in minutes?';
    const history = [message('q1', 'first', 'user', question, 1),
      message('a1', 'first', 'assistant', '10.14 minutes.', 2),
      message('q2', 'second', 'user', question, 3),
      message('a2', 'second', 'assistant', '5.29 minutes.', 4),
      message('q3', 'now', 'user', 'Read another reference.', 5)];
    const evidence = requestExecutionEvidence(history, 's', 'now', registry, [question])!;
    expect(evidence.earlier_requests.map(r => r.request_id)).toEqual(['first', 'second']);
    expect(evidence.recorded_assistant_replies).toEqual([
      {request_id: 'first', message_id: 'a1', text: '10.14 minutes.', recorded_at: 2},
      {request_id: 'second', message_id: 'a2', text: '5.29 minutes.', recorded_at: 4},
    ]);
  });

  it('keeps recorded replies distinct from successful effects and excludes recall answer text', () => {
    const history = [message('q1', 'old', 'user', 'Send when I say continue.', 1),
      message('a1', 'old', 'assistant', 'I have sent it.', 2),
      message('q2', 'private', 'user', 'Look up the private record.', 3), ...pair('recall', 'private', 'recall.search'),
      message('a2', 'private', 'assistant', 'Private recalled answer.', 7),
      message('q3', 'now', 'user', 'Do not send yet.', 8)];
    const evidence = requestExecutionEvidence(history, 's', 'now', registry,
      ['Send when I say continue.', 'Look up the private record.'])!;
    expect(evidence.recorded_assistant_replies.map(r => r.message_id)).toEqual(['a1']);
    expect(evidence.successful_calls_for_current_request).toEqual([]);
    expect(evidence.successful_actions_for_earlier_requests).toEqual([]);
  });
});
