/** A loaded conversation shows its stored tool rows the way the live one shows
 *  the same calls — folded into the answer that lists them — instead of their
 *  recall-format bodies, which read as raw JSON (live drive, 2026-10-04). */

import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatToolCall } from '@recued/contracts';

import { describeToolRow, planToolRows, readToolResult, toolNameOfRow } from '../chat/tool-rows.js';

const base = {
  session_id: 'chat_1', contributor: 'model' as const, target_server: 'self' as const,
  picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued' as const, version: '1', instance_id: 'i' } },
  model_used: { provider: 'local', model_id: 'm' },
};
const TOOL = 'recued-core/control-device-home-assistant';
const RESULT = JSON.stringify({ recipe_id: 'control-device-home-assistant', success: true,
  output: { render: [{ type: 'summary', data: { fields: [
    { label: 'Result', value: 'Done: Home Assistant reports lock.kitchen_door is now unlocked' },
    { label: 'Devices matched', value: 1 },
  ] } }, { type: 'json', data: { private: true } }] } });

const toolRow = (id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ ...base, id, role: 'tool', content, turn_id: 't1', ts: 1, ...extra });
const answer = (id: string, calls: Partial<ChatToolCall>[], turn_id = 't1'): ChatMessage => ({
  ...base, id, role: 'assistant', content: 'Queued it.', turn_id, ts: 2,
  tool_calls: calls.map((call) => ({ tool_name: TOOL, tier: 2, args: {}, status: 'ok', started_at: 1, ...call })),
});
const callRecord = (run_id?: string) => ({ message_id: 'tool:a', session_id: 'chat_1', turn_id: 't1',
  tool_name: TOOL, state: 'succeeded' as const, started_at: 1, updated_at: 3,
  ...(run_id !== undefined ? { run_id } : {}) });

describe('a loaded conversation folds tool rows into the answer that lists them', () => {
  it('folds a call and its result when the answer lists the call', () => {
    const plan = planToolRows([
      toolRow('tool:a', `${TOOL}({"action":"turn_off"})`, { tool_call: callRecord('run-1') }),
      toolRow('tool:a:result', `${TOOL}: ${RESULT}`),
      answer('m1', [{ run_id: 'run-1' }]),
    ]);
    expect([...plan.folded].sort()).toEqual(['tool:a', 'tool:a:result']);
    expect(plan.late_results.size).toBe(0);
  });

  it('shows a late result under the answer that dispatched that run, named as the answer names it', () => {
    const plan = planToolRows([
      toolRow('tool:a', `${TOOL}({"action":"unlock"})`, { tool_call: callRecord('run-1') }),
      answer('m1', [{ run_id: 'run-1' }]),
      toolRow('settle:run-1', `control-device-home-assistant: ${RESULT}`, { ts: 9 }),
    ]);
    expect(plan.folded.has('settle:run-1')).toBe(true);
    expect(plan.late_results.get('m1')).toEqual([{ message_id: 'settle:run-1', run_id: 'run-1',
      tool_name: TOOL, text: `control-device-home-assistant: ${RESULT}` }]);
  });

  it('keeps a call no answer lists as a row of its own, carrying its result for the details', () => {
    // An interrupted turn: the call was saved, the answer never was.
    const interrupted = planToolRows([
      toolRow('tool:a', `${TOOL}({"action":"unlock"})`, { tool_call: callRecord('run-1') }),
      toolRow('tool:a:result', `${TOOL}: ${RESULT}`),
    ]);
    expect([...interrupted.folded]).toEqual(['tool:a:result']);
    expect(interrupted.result_text_by_call.get('tool:a')).toBe(`${TOOL}: ${RESULT}`);
    // An answer in the same turn that does NOT list it: folding would lose it.
    const unlisted = planToolRows([
      toolRow('tool:a', `${TOOL}({"action":"unlock"})`, { tool_call: callRecord('run-1') }),
      answer('m1', [{ tool_name: 'mail.search', run_id: 'run-other' }]),
    ]);
    expect(unlisted.folded.has('tool:a')).toBe(false);
    // A late result whose answer is outside the loaded window stays visible too.
    const orphanSettle = planToolRows([toolRow('settle:run-9', `x: ${RESULT}`, { turn_id: 'gone' })]);
    expect(orphanSettle.folded.size).toBe(0);
    expect(orphanSettle.late_results.size).toBe(0);
  });

  it('folds the older one-row-per-call format into its answer', () => {
    const plan = planToolRows([
      answer('m1', [{ tool_name: 'mail.search' }]),
      toolRow('m1:tool:0', 'mail.search({"q":"rent"}): {"ok":true}'),
    ]);
    expect([...plan.folded]).toEqual(['m1:tool:0']);
  });
});

describe('a tool result read for a person', () => {
  it('leads with the recipe\'s own summary fields and keeps the raw body', () => {
    const readable = readToolResult(`control-device-home-assistant: ${RESULT}`);
    expect(readable.summary).toEqual([
      { label: 'Result', value: 'Done: Home Assistant reports lock.kitchen_door is now unlocked' },
      { label: 'Devices matched', value: '1' },
    ]);
    expect(readable.raw).toContain('"private": true');
    // A chat tool result wraps the run as `{ ok, result }`.
    expect(readToolResult(`${TOOL}: ${JSON.stringify({ ok: true, result: JSON.parse(RESULT) })}`).summary)
      .toHaveLength(2);
  });

  it('shows a refusal\'s message, and the raw body as written when it does not parse', () => {
    expect(readToolResult('x: {"denied":true,"message":"The owner denied the pending operation."}'))
      .toMatchObject({ summary: [], message: 'The owner denied the pending operation.' });
    const capped = readToolResult('x: {"recipe_id":"r","output":{"render":[…');
    expect(capped).toEqual({ summary: [], raw: '{"recipe_id":"r","output":{"render":[…' });
  });

  it('names a lone row in a sentence', () => {
    expect(describeToolRow(toolRow('tool:a', `${TOOL}({"action":"unlock"})`, { tool_call: callRecord() })))
      .toBe(`Called ${TOOL}`);
    expect(describeToolRow(toolRow('tool:a:result', `${TOOL}: {}`))).toBe(`The result from ${TOOL}`);
    expect(describeToolRow(toolRow('settle:r', 'control-device: {}'))).toBe('A later result from control-device');
    expect(toolNameOfRow('mail.search({"q":"a: b"}): {}')).toBe('mail.search');
  });
});
