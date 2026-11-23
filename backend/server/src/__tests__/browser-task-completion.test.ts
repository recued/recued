import { describe, expect, it, vi } from 'vitest';
import type { AIOutput, InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { BROWSER_COMPLETION_GUIDANCE, BROWSER_COMPLETION_INCOMPLETE, BROWSER_COMPLETION_REPAIR,
  createBrowserTaskCompletion } from '../browser-task-completion.js';
import { CHAT_MAIN_TURN_SYSTEM_PROMPT, runChatTurn } from '../chat-turn-executor.js';
import type { ExecuteChatAiCall } from '../chat-orchestrator.js';

const request = 'Save the changed record, then open it and verify the saved values.';
const save = 'Save the changed record', verify = 'open it and verify the saved values';
const pending = (requirement: string) => ({ requirement, status: 'pending' });
const confirmed = (requirement: string, call: number, quote: string) => ({ requirement, status: 'confirmed', evidence: [{ call, quote }] });
const output = (progress?: unknown, tools = false): AIOutput => ({ response: tools ? '' : 'Finished.', events: [],
  tool_calls: tools ? [{ tool: 'recued-core/act-on-web-page', args: {} }] : [],
  ...(progress === undefined ? {} : { browser_task_progress: progress }) });
const saved = { tool_name: 'recued-core/act-on-web-page', status: 'ok', result: { success: true,
  output: { render: [{ data: { steps: ['saved the changed record'], outline: 'Record list: the new value' } }] } } };
const reopened = { ...saved, result: { success: true, output: { render: [{ data: { outline: 'Record detail: the saved value' } }] } } };
const packet = (...calls: unknown[]) => JSON.stringify({ prior_tool_calls: calls });

describe('turn-local browser completion checks', () => {
  it('pins omitted requirements and allows a complete, source-linked final without another model call', () => {
    const guard = createBrowserTaskCompletion(request);
    expect(guard.check(output([pending(save), pending(verify)], true), packet())).toBe('continue');
    expect(guard.check(output([confirmed(save, 0, 'saved the changed record')], true), packet(saved))).toBe('continue');
    expect(guard.context().requirements).toEqual([{ requirement: save, status: 'confirmed' }, pending(verify)]);
    expect(guard.check(output([confirmed(save, 0, 'saved the changed record'),
      confirmed(verify, 1, 'Record detail: the saved value')]), packet(saved, reopened))).toBe('complete');
  });

  it('repairs an early final once and never drops a pending verification to make it pass', () => {
    const guard = createBrowserTaskCompletion(request);
    guard.check(output([pending(save), pending(verify)], true), packet());
    const incomplete = output([confirmed(save, 0, 'saved the changed record')]);
    expect(guard.check(incomplete, packet(saved))).toBe('repair');
    expect(guard.context().requirements).toContainEqual(pending(verify));
    expect(guard.check(incomplete, packet(saved))).toBe('unverified');
  });

  it.each(['failed', 'held', 'omitted', 'arguments', 'invented', 'wrong-index'])(
    'refuses an unsupported confirmation: %s', mode => {
      const guard = createBrowserTaskCompletion(save);
      const result = mode === 'held' ? { ...saved.result, run_held: {} }
        : mode === 'omitted' ? { __omitted: true, preview: 'saved the changed record' }
          : mode === 'failed' ? { ...saved.result, success: false } : saved.result;
      const call = { ...saved, result: mode === 'arguments' ? { success: true } : result,
        args: { quote: 'saved the changed record' } };
      expect(guard.check(output([confirmed(save, mode === 'wrong-index' ? 1 : 0,
        mode === 'invented' ? 'a result nobody returned' : 'saved the changed record')]), packet(call))).toBe('repair');
      expect(guard.context().requirements).toEqual([pending(save)]);
    });

  it('rejects model-invented requirements and duplicate rows, and accepts an honest unverified end', () => {
    const guard = createBrowserTaskCompletion(save);
    expect(guard.check(output([pending('Delete the record')], true), packet())).toBe('continue');
    expect(guard.context().requirements).toEqual([]);
    expect(guard.check(output([pending(save), pending(save)]), packet())).toBe('repair');
    expect(guard.check(output([{ requirement: save, status: 'unverified' }]), packet())).toBe('unverified');
  });

  it('can retain the user requirements an explicit follow-up refers to', () => {
    const guard = createBrowserTaskCompletion('Continue that task.', [request]);
    expect(guard.check(output([pending(save), pending(verify)], true), packet())).toBe('continue');
    expect(guard.context().requirements).toEqual([pending(save), pending(verify)]);
  });

  it('checks citations against fitted source positions and excludes nested omission previews', () => {
    for (const calls of [[saved], [{ ...reopened, result: { success: true, output: {
      __omitted: true, preview: 'Record detail: the saved value' } } }]]) {
      const guard = createBrowserTaskCompletion(verify);
      expect(guard.check(output([confirmed(verify, 0, 'Record detail: the saved value')]), packet(...calls))).toBe('repair');
    }
    const guard = createBrowserTaskCompletion(verify);
    expect(guard.check(output([confirmed(verify, 0, 'Record detail: the saved value')]), packet({ ...reopened,
      result: { success: true, output: { duplicate_read: { note: 'Record detail: the saved value' } } } }))).toBe('repair');
  });
});

const run = async (replies: AIOutput[], browser = true, failRepair?: 'provider' | 'length', participate = true) => {
  const entry: ToolEntry = { name: 'recued-core/act-on-web-page', tier: 2, description: 'Act in browser', arg_schema: {},
    classification: 'write', risk_tier: 'write', concurrency_safe: false, topic_tags: ['browser'] };
  const inspect: ToolEntry = { ...entry, name: 'recued-core/inspect-web-page', classification: 'read', risk_tier: 'read' };
  const registry: InternalToolRegistry = { list: () => [entry, inspect], listByTier: () => [entry, inspect],
    getByName: name => name === inspect.name ? inspect : name === entry.name ? entry : null,
    dispatch: async () => ({ ok: true, result: saved.result }), subscribeRefresh: () => () => {} };
  const packets: Record<string, unknown>[] = [], prompts: string[] = [];
  const executeAiCall = vi.fn<ExecuteChatAiCall>(async (_manifest, input) => {
    packets.push(JSON.parse(String(input['llm.prompt']))); prompts.push(String(input['llm.system_prompt']));
    const body = replies.shift();
    if (replies.length === 0 && failRepair === 'provider') throw new Error('simulated completion repair failure');
    return replies.length === 0 && failRepair === 'length' ? { body: { response: 42 }, finish_reason: 'length' as const } : { body };
  });
  const dispatchTool = vi.fn(async ({ tool_name }: { tool_name: string }) => ({ ok: true as const,
    result: tool_name === inspect.name ? { outline: 'Record list before any edit' } : saved.result }));
  const emit = vi.fn();
  const result = await runChatTurn({ session_id: 's', turn_id: 't', picker_target: 'self', dispatch_peer_name: null,
    available_tools: [{ recipe_slug: entry.name, args_schema: {} }], content: { chat_tail: [], user_message: save },
    correction_context: [], model_layer: 'byok', system_prompt: CHAT_MAIN_TURN_SYSTEM_PROMPT,
    ...(participate ? { browser_task_completion: true } : {}),
    ...(browser ? { named_pages: [{ tool_name: inspect.name, page: 'https://example.org/' }] } : {}) },
  { registry, dispatchTool, executeAiCall, emit, now: () => 1 } as never);
  return { result, executeAiCall, dispatchTool, packets, prompts, emit };
};

it('integrates checklist retention into the real loop without an extra clean-path model call', async () => {
  const f = await run([output([pending(save)], true), output([confirmed(save, 1, 'saved the changed record')])]);
  expect(f.result.assistant_content).toBe('Finished.');
  expect(f.executeAiCall).toHaveBeenCalledTimes(2);
  expect(f.dispatchTool.mock.calls.map(([call]) => call.tool_name)).toEqual(['recued-core/inspect-web-page', 'recued-core/act-on-web-page']);
  expect(f.prompts[0]).toContain(BROWSER_COMPLETION_GUIDANCE);
  expect(f.packets[1]!.browser_task_context).toMatchObject({ requirements: [pending(save)] });
});

it('withholds an unsupported final, bounds correction to one call, and performs no recovery action itself', async () => {
  const f = await run([output([pending(save)], true), output(), output()]);
  expect(f.executeAiCall).toHaveBeenCalledTimes(3);
  expect(f.dispatchTool.mock.calls.filter(([call]) => call.tool_name === 'recued-core/act-on-web-page')).toHaveLength(1);
  expect(f.packets[2]!.output_feedback).toContain(BROWSER_COMPLETION_REPAIR);
  expect(f.result.assistant_content).toBe(BROWSER_COMPLETION_INCOMPLETE);
  expect(JSON.stringify(f.emit.mock.calls)).not.toContain('Finished.');
});

it('keeps ordinary non-browser replies on their existing path', async () => {
  const f = await run([output()], false);
  expect(f.executeAiCall).toHaveBeenCalledTimes(1);
  expect(f.result.assistant_content).toBe('Finished.');
  expect(f.prompts[0]).not.toContain(BROWSER_COMPLETION_GUIDANCE);
});

it('keeps gateway-style callers without the owner-Chat policy flag on their existing contract', async () => {
  const f = await run([output([pending(save)], true), output()], true, undefined, false);
  expect(f.executeAiCall).toHaveBeenCalledTimes(2);
  expect(f.result.assistant_content).toBe('Finished.');
  expect(f.prompts[0]).not.toContain(BROWSER_COMPLETION_GUIDANCE);
});

it.each(['provider', 'length'] as const)('retains the actual %s failure when completion correction cannot finish', async failure => {
  const f = await run([output([pending(save)], true), output(), output()], true, failure);
  expect(f.executeAiCall).toHaveBeenCalledTimes(3);
  expect(f.dispatchTool.mock.calls.filter(([call]) => call.tool_name === 'recued-core/act-on-web-page')).toHaveLength(1);
  expect(f.result.assistant_content).not.toBe(BROWSER_COMPLETION_INCOMPLETE);
  expect(f.result.assistant_content).toContain(failure === 'provider' ? 'provider failed' : 'output limit');
});
