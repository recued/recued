// The retired Consolidated note's own rows (a note citing a recorded or prepared reply) went with it (2026-11-19).
import { expect, it } from 'vitest';
import { withoutUnsuccessfulAttemptEchoes } from '../chat-request-evidence.js';
import { groundingCorpusFromPacket, ungroundedArgumentsInCall } from '../tool-argument-grounding.js';
const identifier = 'evt_unverified_739ba1';
const assertion = `The earlier change to ${identifier} is unresolved.`;
const ownerText = `Check the event with source_id "${identifier}".`;
const recalled = (kind: 'user' | 'assistant' | 'tool', content: string) => ({
  source: 'interaction', kind, item_id: 'old-message', completeness: 'complete', content,
});
const recallCall = (matches: unknown[]) => ({ tool_name: 'recall.search', status: 'ok',
  result: { ok: true, matches } });
const eligible = (packet: unknown) => {
  const body = withoutUnsuccessfulAttemptEchoes(JSON.stringify(packet));
  return ungroundedArgumentsInCall({ source_id: identifier }, groundingCorpusFromPacket(body),
    { tool: 'calendar.get', packet: body }).length === 0;
};
it.each([
  ['recent reply', { chat_tail: [{ role: 'assistant', content: assertion }] }],
  ['recorded reply', { request_execution_context: { recorded_assistant_replies: [{ text: assertion }] } }],
  ['prepared reply', { request_execution_context: { prepared_assistant_reply: { text: assertion } } }],
  ['recalled reply', { recall_context: [recallCall([recalled('assistant', assertion)])] }],
  ['nested recalled reply', { recall_context: [recallCall([recalled('tool', 'recall.search: '
    + JSON.stringify({ ok: true, result: { ok: true, matches: [recalled('assistant', assertion)] } }))])] }],
] as const)('does not turn an identifier repeated in a %s into source evidence', (_name, packet) => {
  const before = JSON.stringify(packet);
  expect(eligible(packet)).toBe(false);
  expect(JSON.stringify(packet)).toBe(before);
  expect(before).toContain(identifier); // The model still receives the reply.
});

it.each([
  ['current owner request', { user_message: ownerText }],
  ['earlier owner request', { request_execution_context: { earlier_requests: [{ text: ownerText }] } }],
  ['owner message in recent chat', { chat_tail: [{ role: 'user', content: ownerText }] }],
  ['recalled owner request', { recall_context: [recallCall([recalled('user', ownerText)])] }],
  ['successful lookup', { prior_tool_calls: [{ tool_name: 'calendar.search', status: 'ok',
    result: { events: [{ source_id: identifier }] } }] }],
  ['recalled successful lookup', { recall_context: [recallCall([recalled('tool', 'calendar.search: '
    + JSON.stringify({ ok: true, result: { events: [{ source_id: identifier }] } }))])] }],
] as const)('keeps identifier authority from a %s alongside an unsupported assistant claim', (_name, evidence) => {
  expect(eligible({ ...evidence, chat_tail: [{ role: 'assistant', content: assertion },
    ...('chat_tail' in evidence ? evidence.chat_tail : [])] })).toBe(true);
});
