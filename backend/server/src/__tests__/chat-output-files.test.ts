import { describe, expect, it, vi } from 'vitest';
import type { AIOutput, InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { answerOutputAttachments, outputFilesFromResults } from '../chat-output-files.js';
import { runChatTurn } from '../chat-turn-executor.js';
import { ungroundedArgumentsInCall } from '../tool-argument-grounding.js';

const first = 'file:' + 'a'.repeat(32), second = 'file:' + 'b'.repeat(32);
const artifact = (ref: string) => ({ record_id: ref, filename: 'output.csv', mime_type: 'text/csv', sha256: 'c'.repeat(64), size_bytes: 24 });
const result = { ok: true as const, result: { success: true, output: { render: [
  { type: 'file_artifact', data: artifact(first) }, { type: 'file_artifact', data: artifact(second) },
] } } };
const answer = (files?: string[]): AIOutput => ({ response: 'The requested CSV is attached.', events: [], tool_calls: [], ...(files ? { output_files: files } : {}) });

it('selects only the requested completed artifact and refuses invented, held and failed outputs', () => {
  expect(answerOutputAttachments('self', answer([second]), [{ result }])).toEqual([{ file_id: second, media_class: 'document', content_hash: 'c'.repeat(64) }]);
  expect(answerOutputAttachments('self', answer([first, 'file:' + 'd'.repeat(32)]), [{ result }])).toEqual([]);
  expect(answerOutputAttachments('connection.mcp.peer', answer([first]), [{ result }])).toEqual([]);
  for (const invalid of [{ ...result, run_held: {} }, { ...result, run_failed: {} },
    { ok: true, result: { ...result.result, success: false } }, { ok: true, result: { body: result.result } }]) {
    expect(outputFilesFromResults([{ result: invalid }])).toEqual([]);
  }
});

const runExport = async (replies: AIOutput[], repairFailure?: 'length' | 'provider') => {
  const entry: ToolEntry = { name: 'make-export', tier: 2, description: 'Create CSV files', arg_schema: {},
    topic_tags: ['file'], classification: 'write', risk_tier: 'write', concurrency_safe: false };
  const registry: InternalToolRegistry = { list: () => [entry], listByTier: () => [entry], getByName: () => entry,
    dispatch: async () => result, subscribeRefresh: () => () => {} };
  const dispatchTool = vi.fn(async () => result);
  const outputs: AIOutput[] = [{ response: '', events: [], tool_calls: [{ tool: entry.name, args: {} }] }, ...replies];
  const executeAiCall = vi.fn(async () => {
    const body = outputs.shift();
    if (!outputs.length && repairFailure === 'provider') throw new Error('simulated repair provider failure');
    return !outputs.length && repairFailure === 'length' ? { body: { response: 42 }, finish_reason: 'length' as const } : { body };
  });
  const emit = vi.fn();
  const run = await runChatTurn({ session_id: 's', turn_id: 't', picker_target: 'self', dispatch_peer_name: null,
    available_tools: [{ recipe_slug: entry.name, args_schema: {} }], content: { chat_tail: [], user_message: 'Make a CSV export.' },
    correction_context: [], model_layer: 'byok' }, { registry, dispatchTool, executeAiCall, emit, now: () => 1 } as never);
  return { run, dispatchTool, executeAiCall, emit };
};

it.each([true, false])('repairs a missing final selection once; valid repair: %s', async valid => {
  const { run, dispatchTool, executeAiCall } = await runExport([answer(), answer([valid ? second : 'file:' + 'd'.repeat(32)])]);
  expect(dispatchTool).toHaveBeenCalledTimes(1);
  expect(executeAiCall).toHaveBeenCalledTimes(3);
  expect(answerOutputAttachments('self', run.final_ai_output, run.tool_results)).toEqual(valid
    ? [{ file_id: second, media_class: 'document', content_hash: 'c'.repeat(64) }] : []);
  if (!valid) expect(run.assistant_content).toMatch(/not been delivered/);
});

it.each(['length', 'provider'] as const)('preserves the %s failure when file-selection repair cannot finish', async failure => {
  const { run, dispatchTool, executeAiCall, emit } = await runExport([answer(), answer([second])], failure);
  expect(dispatchTool).toHaveBeenCalledTimes(1);
  expect(executeAiCall).toHaveBeenCalledTimes(3);
  expect(answerOutputAttachments('self', run.final_ai_output, run.tool_results)).toEqual([]);
  expect(emit.mock.calls.some(([event]) => event.event?.termination_reason === (failure === 'provider' ? 'aborted' : 'output_unreadable'))).toBe(true);
  expect(run.assistant_content).not.toContain('could not select a verified output');
  if (failure === 'provider') expect(run.tool_loop_failure?.detail).toContain('simulated repair provider failure');
});

describe('CSV schema names at the grounding boundary', () => {
  const packet = JSON.stringify({ prior_tool_calls: [{ status: 'ok', result: { success: true, output: { render: [
    { type: 'json', data: { source: { file_ref: first }, columns: ['email', 'full_name'] } },
  ] } } }] });
  const context = { tool: 'recued-core/select-csv-columns', packet };
  it('permits an observed column and an authored column label without exempting other sources or identifiers', () => {
    expect(ungroundedArgumentsInCall({ source: first, columns: ['full_name'], names: ['first_name'] }, packet, context)).toEqual([]);
    expect(ungroundedArgumentsInCall({ source: second, columns: ['full_name'] }, packet, context)).toHaveLength(1);
    expect(ungroundedArgumentsInCall({ contact_id: 'full_name' }, packet, context)).toHaveLength(1);
    expect(ungroundedArgumentsInCall({ source: first, columns: ['last_name'] }, packet, context)).toHaveLength(1);
    expect(ungroundedArgumentsInCall({ source: first, columns: ['__first__'] }, packet, context)).toHaveLength(1);
    expect(ungroundedArgumentsInCall({ source: first, columns: ['full_name'] }, packet, { ...context, packet: '{}' })).toHaveLength(1);
    expect(ungroundedArgumentsInCall({ recipe_id: context.tool, config: { source: first, columns: ['full_name'] } }, packet,
      { ...context, tool: 'recipe.run' })).toEqual([]);
    expect(ungroundedArgumentsInCall({ source: first, mappings: [{ as: 'first_name',
      expression: { op: 'trim', input: { column: 'full_name' } } }] }, packet,
      { ...context, tool: 'recued-core/map-csv-columns' })).toEqual([]);
    expect(ungroundedArgumentsInCall({ source: first, by: [{ column: 'full_name' }] }, packet,
      { ...context, tool: 'recued-core/sort-csv-rows' })).toEqual([]);
    expect(ungroundedArgumentsInCall({ source: first, mappings: [{ as: 'label', expression: { value: 'full_name' } }] }, packet,
      { ...context, tool: 'recued-core/map-csv-columns' })).toHaveLength(1);
  });
});


it('grounds a CSV header from the native first text page, not a later row/page or another tool', () => {
  const ref = 'file:' + 'a'.repeat(32);
  const read = { status: 'read', converter: 'text', offset: 0, file_ref: ref, content_hash: 'c'.repeat(64),
    body: '\uFEFF"region","full_name"\nWest,Sam\n', next_offset: null, text_incomplete: false };
  const check = (result: Record<string, unknown>, tool_name = 'document.read') => {
    const packet = JSON.stringify({ prior_tool_calls: [{ tool_name, status: 'ok', result }] });
    return ungroundedArgumentsInCall({ source: ref, columns: ['full_name'] }, packet,
      { tool: 'recued-core/select-csv-columns', packet });
  };
  expect(check(read)).toEqual([]);
  expect(check({ ...read, body: 'region,full_name\n', next_offset: 17, text_incomplete: true })).toEqual([]);
  for (const invalid of [{ ...read, offset: 200 }, { ...read, body: 'region,name\nWest,full_name\n' },
    { ...read, body: 'region,"full_name', next_offset: 17, text_incomplete: true }, { ...read, file_ref: 'file:' + 'b'.repeat(32) }]) {
    expect(check(invalid)).toHaveLength(1);
  }
  expect(check(read, 'tools.search')).toHaveLength(1);
});


it('keeps the verified file selection when an optional review omits it', async () => {
  vi.stubEnv('RECUED_VERIFY_PASS', 'neutral');
  try {
    const { run, executeAiCall } = await runExport([answer([second]), answer()]);
    expect(executeAiCall).toHaveBeenCalledTimes(3);
    expect(answerOutputAttachments('self', run.final_ai_output, run.tool_results)).toEqual([
      { file_id: second, media_class: 'document', content_hash: 'c'.repeat(64) },
    ]);
  } finally { vi.unstubAllEnvs(); }
});
