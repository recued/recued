import { describe, expect, it } from 'vitest';

import { CLI_PROGRESS_ADAPTERS, CLI_PROGRESS_ANSWER_ADAPTERS } from '@recued/contracts';

import { createCliProgressAdapter } from '../execution/cli-progress-adapters.js';

describe('D-259 semantic CLI progress adapters', () => {
  it('keeps stdout/stderr line framing separate while sharing yt-dlp monotonic state', () => {
    const adapter = createCliProgressAdapter('yt-dlp-progress');

    expect(adapter.push(Buffer.from('[download] 10'), 'stdout')).toBe(0);
    // An interleaved diagnostic must not splice into stdout's partial line.
    expect(adapter.push(Buffer.from('warning: retrying\n'), 'stderr')).toBe(0);
    expect(adapter.push(Buffer.from('.0% of 1MiB\n'), 'stdout')).toBe(1);
    // A duplicate percentage on the other stream is still the same semantic
    // unit, not a second heartbeat.
    expect(adapter.push(Buffer.from('[download] 10.0% of 1MiB\n'), 'stderr')).toBe(0);
    expect(adapter.push(Buffer.from('[download] 11.0% of 1MiB\n'), 'stderr')).toBe(1);
    expect(adapter.end()).toBe(0);
  });

  it('counts only completed Codex units, not arbitrary JSONL output', () => {
    const adapter = createCliProgressAdapter('codex-jsonl');
    expect(adapter.push(Buffer.from('{"type":"item.started","item":{"id":"a"}}\n'))).toBe(0);
    expect(adapter.push(Buffer.from('{"type":"item.completed","item":{"id":"a"}}\n'))).toBe(1);
    expect(adapter.push(Buffer.from('{"type":"item.completed","item":{"id":"a"}}\n'))).toBe(0);
    expect(adapter.push(Buffer.from('{"type":"turn.completed"}'))).toBe(0);
    expect(adapter.end()).toBe(1);
  });

  it('decodes JSONL across split UTF-8 code points and suppresses repeated terminal records', () => {
    const adapter = createCliProgressAdapter('codex-jsonl');
    const row = Buffer.from('{"type":"item.completed","item":{"id":"café"}}\n');
    const codePoint = row.indexOf(Buffer.from('é'));

    expect(adapter.push(row.subarray(0, codePoint + 1), 'stdout')).toBe(0);
    expect(adapter.push(row.subarray(codePoint + 1), 'stdout')).toBe(1);
    expect(adapter.push(Buffer.from('{"type":"turn.completed"}\n'), 'stdout')).toBe(1);
    expect(adapter.push(Buffer.from('{"type":"turn.completed"}\n'), 'stdout')).toBe(0);
    expect(adapter.push(Buffer.from('{"type":"turn.failed"}\n'), 'stdout')).toBe(0);
    expect(adapter.end()).toBe(0);
  });

  it('reports the Codex session id from thread.started as a fact, not as progress', () => {
    const adapter = createCliProgressAdapter('codex-jsonl');
    expect(adapter.facts?.()).toEqual({});
    expect(adapter.push(Buffer.from(
      '{"type":"thread.started","thread_id":"01a11547-8fbc-7fe0-a797-15386c92c9db"}\n',
    ))).toBe(0);
    // The first id wins: a later thread line cannot re-point the resume.
    expect(adapter.push(Buffer.from(
      '{"type":"thread.started","thread_id":"02b22658-9acd-8af1-b8a8-26497d93daec"}\n',
    ))).toBe(0);
    expect(adapter.push(Buffer.from('{"type":"item.completed","item":{"id":"a"}}\n'))).toBe(1);
    expect(adapter.facts?.()).toEqual({ session_id: '01a11547-8fbc-7fe0-a797-15386c92c9db' });
  });

  it('⛔ refuses a thread id that is not id-shaped — it becomes an argv token of resume', () => {
    for (const bad of ['--config=sandbox_mode="danger-full-access"', '-1', 'not hex at all', 'x'.repeat(65), '']) {
      const adapter = createCliProgressAdapter('codex-jsonl');
      adapter.push(Buffer.from(`${JSON.stringify({ type: 'thread.started', thread_id: bad })}\n`));
      expect(adapter.facts?.(), bad).toEqual({});
    }
  });

  it('only the agent adapters report facts', () => {
    expect(createCliProgressAdapter('yt-dlp-progress').facts).toBeUndefined();
    expect(createCliProgressAdapter('ffmpeg-progress').facts).toBeUndefined();
    expect(createCliProgressAdapter('claude-stream-json').facts?.()).toEqual({});
    expect(createCliProgressAdapter('pi-json').facts?.()).toEqual({});
    expect(createCliProgressAdapter('opencode-json').facts?.()).toEqual({});
  });

  it('reads an answer only through the adapters the contract names as answer-bearing', () => {
    // The validators admit `output_capture.from_progress_answer` only for these
    // names; a name here whose host code reads no answer would let an op pass
    // validation and then fail every run with nothing to capture.
    for (const name of CLI_PROGRESS_ADAPTERS) {
      const reads = createCliProgressAdapter(name).answer !== undefined;
      expect(reads, name).toBe((CLI_PROGRESS_ANSWER_ADAPTERS as readonly string[]).includes(name));
    }
  });

  // Records as Claude Code 2.1.292 prints them under `-p --output-format
  // stream-json --verbose` (measured; content trimmed).
  const SESSION = '6f1c2a90-1111-4abc-8def-0123456789ab';
  const claudeRow = (row: Record<string, unknown>): Buffer => Buffer.from(`${JSON.stringify(row)}\n`);
  const init = (sessionId: string = SESSION): Buffer =>
    claudeRow({ type: 'system', subtype: 'init', session_id: sessionId, uuid: `init-${sessionId}` });

  it('counts completed Claude Code units, not the session announcement or timer pings', () => {
    const adapter = createCliProgressAdapter('claude-stream-json');
    expect(adapter.push(claudeRow({ type: 'system', subtype: 'ui_invalidate', uuid: 'u0' }))).toBe(0);
    expect(adapter.push(init())).toBe(0);
    expect(adapter.push(claudeRow({ type: 'assistant', uuid: 'u1', message: { content: [{ type: 'tool_use' }] } }))).toBe(1);
    // A running command: `task_started` after ~3 s, then a `tool_progress` every
    // 30 s whether or not the command advances — a hung one pings too.
    expect(adapter.push(claudeRow({ type: 'system', subtype: 'task_started', uuid: 'u2' }))).toBe(0);
    expect(adapter.push(claudeRow({ type: 'tool_progress', uuid: 'u3', parent_tool_use_id: 'toolu_1' }))).toBe(0);
    expect(adapter.push(claudeRow({ type: 'system', subtype: 'task_notification', uuid: 'u4' }))).toBe(1);
    expect(adapter.push(claudeRow({ type: 'user', uuid: 'u5', message: { content: [{ type: 'tool_result' }] } }))).toBe(1);
    // A subagent's own steps stream through with `parent_tool_use_id`.
    expect(adapter.push(claudeRow({ type: 'assistant', uuid: 'u6', parent_tool_use_id: 'toolu_2' }))).toBe(1);
    // The same record twice is one unit.
    expect(adapter.push(claudeRow({ type: 'assistant', uuid: 'u6', parent_tool_use_id: 'toolu_2' }))).toBe(0);
    expect(adapter.push(claudeRow({ type: 'system', subtype: 'informational', uuid: 'u7' }))).toBe(0);
    expect(adapter.push(Buffer.from('not json\n'))).toBe(0);
    expect(adapter.push(claudeRow({ type: 'result', subtype: 'success', is_error: false, result: 'done', uuid: 'u8' }))).toBe(1);
    expect(adapter.end()).toBe(0);
  });

  it('reports the Claude Code session id from init as a fact; the first one wins', () => {
    const adapter = createCliProgressAdapter('claude-stream-json');
    adapter.push(init());
    // The turn that follows a background task re-announces the session; a
    // different id there must not re-point the resume.
    adapter.push(init('0b9c6f6e-2222-4abc-8def-0123456789ab'));
    expect(adapter.facts?.()).toEqual({ session_id: SESSION });
  });

  it('⛔ refuses a session id that is not a UUID — it becomes the value of --resume', () => {
    for (const bad of ['--dangerously-skip-permissions', '-1', 'my session title', `${SESSION}x`, '']) {
      const adapter = createCliProgressAdapter('claude-stream-json');
      adapter.push(claudeRow({ type: 'system', subtype: 'init', session_id: bad }));
      expect(adapter.facts?.(), bad).toEqual({});
    }
  });

  it('answers with the LAST result: a run that waits on a background agent ends with two', () => {
    const adapter = createCliProgressAdapter('claude-stream-json');
    adapter.push(init());
    // Measured: both results arrive at the end, the turn that launched the agent first.
    adapter.push(claudeRow({ type: 'result', subtype: 'success', is_error: false, result: 'launched the agent; waiting', uuid: 'r1' }));
    adapter.push(claudeRow({ type: 'result', subtype: 'success', is_error: false, result: 'the real answer', uuid: 'r2' }));
    expect(adapter.answer?.()).toBe('the real answer');
    expect(adapter.failure?.()).toBeUndefined();
  });

  it('keeps an empty answer as an answer', () => {
    const adapter = createCliProgressAdapter('claude-stream-json');
    adapter.push(claudeRow({ type: 'result', subtype: 'success', is_error: false, result: '', uuid: 'r1' }));
    expect(adapter.answer?.()).toBe('');
  });

  it('reports Claude Code\'s own failure, which it prints only in the result record', () => {
    // Measured: an API error exits 1 with nothing on stderr; the reason is here.
    const apiError = createCliProgressAdapter('claude-stream-json');
    apiError.push(claudeRow({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 400 bad request', terminal_reason: 'api_error' }));
    expect(apiError.answer?.()).toBeUndefined();
    expect(apiError.failure?.()).toBe('API Error: 400 bad request');
    // `errors` wins over `result` when present.
    const unknown = createCliProgressAdapter('claude-stream-json');
    unknown.push(claudeRow({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [`No conversation found with session ID: ${SESSION}`] }));
    expect(unknown.failure?.()).toBe(`No conversation found with session ID: ${SESSION}`);
    const maxTurns = createCliProgressAdapter('claude-stream-json');
    maxTurns.push(claudeRow({ type: 'result', subtype: 'error_max_turns', is_error: true }));
    expect(maxTurns.failure?.()).toBe('error_max_turns');
    // Bounded: the text rides an error message.
    const long = createCliProgressAdapter('claude-stream-json');
    long.push(claudeRow({ type: 'result', is_error: true, result: 'x'.repeat(5000) }));
    expect(long.failure?.()).toHaveLength(1000);
  });

  it('⛔ will not answer with an earlier result when a later record was dropped for size', () => {
    const adapter = createCliProgressAdapter('claude-stream-json');
    adapter.push(claudeRow({ type: 'result', subtype: 'success', is_error: false, result: 'launched the agent; waiting', uuid: 'r1' }));
    // The true final result, over the 1 MiB line cap: dropped by the reader.
    adapter.push(Buffer.from(`{"type":"result","result":"${'y'.repeat(1024 * 1024)}"}\n`));
    expect(adapter.answer?.()).toBeUndefined();
    expect(adapter.failure?.()).toMatch(/dropped after the last result/);
    // A result kept after the drop is the answer again.
    adapter.push(claudeRow({ type: 'result', subtype: 'success', is_error: false, result: 'after', uuid: 'r3' }));
    expect(adapter.answer?.()).toBe('after');
  });

  it('⛔ will not answer when the final record is cut off at the end of the stream', () => {
    const adapter = createCliProgressAdapter('claude-stream-json');
    adapter.push(claudeRow({ type: 'result', subtype: 'success', is_error: false, result: 'first', uuid: 'r1' }));
    adapter.push(Buffer.from(`{"type":"result","result":"${'z'.repeat(1024 * 1024)}`));
    adapter.end();
    expect(adapter.answer?.()).toBeUndefined();
  });

  // Records as pi 1.1.0 prints them under `--mode json` (measured; content
  // trimmed). A run: header, agent_start, a system/user/assistant message each
  // as start+end, tool execution, turn_end, agent_end, agent_settled.
  const PI_SESSION = '01a11b4f-1758-760c-a2ce-9fe74f6adc68';
  const piRow = (row: Record<string, unknown>): Buffer => Buffer.from(`${JSON.stringify(row)}\n`);
  const piHeader = (id: string = PI_SESSION): Buffer =>
    piRow({ type: 'session', version: 3, id, timestamp: '2026-10-08T11:38:50.585Z', cwd: '/repo' });
  const piAssistant = (stopReason: string, text: string, extra: Record<string, unknown> = {}): Buffer =>
    piRow({ type: 'message_end', message: {
      role: 'assistant', stopReason, api: 'anthropic-messages',
      content: [{ type: 'thinking', thinking: 'THOUGHT' }, { type: 'text', text }], ...extra,
    } });
  const piSettled = (aborted = false): Buffer => piRow({ type: 'agent_settled', aborted });

  it('counts completed pi units, not the header, deltas or a running command\'s output', () => {
    const adapter = createCliProgressAdapter('pi-json');
    expect(adapter.push(piHeader())).toBe(0);
    expect(adapter.push(piRow({ type: 'agent_start' }))).toBe(0);
    expect(adapter.push(piRow({ type: 'turn_start' }))).toBe(0);
    expect(adapter.push(piRow({ type: 'message_end', message: { role: 'system', content: 'sys' } }))).toBe(0);
    expect(adapter.push(piRow({ type: 'message_end', message: { role: 'user', content: 'task' } }))).toBe(0);
    expect(adapter.push(piRow({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: '{' } }))).toBe(0);
    expect(adapter.push(piAssistant('toolUse', ''))).toBe(1);
    expect(adapter.push(piRow({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash' }))).toBe(0);
    // Measured: one update per output chunk of a running command — and none
    // at all while it is silent. Output is bytes, not a finished unit.
    expect(adapter.push(piRow({ type: 'tool_execution_update', toolCallId: 't1', partialResult: { content: [{ type: 'text', text: 'first\n' }] } }))).toBe(0);
    expect(adapter.push(piRow({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', isError: false }))).toBe(1);
    expect(adapter.push(piRow({ type: 'message_end', message: { role: 'toolResult', toolCallId: 't1', content: [] } }))).toBe(1);
    expect(adapter.push(piRow({ type: 'turn_end', toolResults: [] }))).toBe(1);
    expect(adapter.push(piAssistant('stop', 'done'))).toBe(1);
    expect(adapter.push(piRow({ type: 'agent_end', messages: [], willRetry: false }))).toBe(0);
    expect(adapter.push(Buffer.from('not json\n'))).toBe(0);
    expect(adapter.push(piSettled())).toBe(1);
    expect(adapter.end()).toBe(0);
    expect(adapter.answer?.()).toBe('done');
  });

  it('reports the pi session id from its header as a fact; the first one wins', () => {
    const adapter = createCliProgressAdapter('pi-json');
    adapter.push(piHeader());
    adapter.push(piHeader('01a11b4f-2902-701b-bda6-15a7a404a533'));
    expect(adapter.facts?.()).toEqual({ session_id: PI_SESSION });
  });

  it('⛔ refuses a pi session id that is not a whole UUID — `--session` also takes a path or a PARTIAL id', () => {
    for (const bad of ['--no-approve', '-1', '01a11b4f', '/tmp/session.jsonl', `${PI_SESSION}x`, '']) {
      const adapter = createCliProgressAdapter('pi-json');
      adapter.push(piHeader(bad));
      expect(adapter.facts?.(), bad).toEqual({});
    }
  });

  it('answers with the LAST assistant message, text blocks only, once pi has settled', () => {
    const adapter = createCliProgressAdapter('pi-json');
    adapter.push(piHeader());
    adapter.push(piAssistant('toolUse', 'Let me look.'));
    adapter.push(piAssistant('stop', 'The fix is in place.'));
    // Not settled yet: an automatic retry or a queued message could still follow.
    expect(adapter.answer?.()).toBeUndefined();
    adapter.push(piSettled());
    expect(adapter.answer?.()).toBe('The fix is in place.');
    expect(adapter.failure?.()).toBeUndefined();
    // More work in the same invocation un-settles it.
    adapter.push(piRow({ type: 'agent_start' }));
    expect(adapter.answer?.()).toBeUndefined();
    // A model that stopped at its output limit still answered.
    const length = createCliProgressAdapter('pi-json');
    length.push(piAssistant('length', 'cut short'));
    length.push(piSettled());
    expect(length.answer?.()).toBe('cut short');
    const empty = createCliProgressAdapter('pi-json');
    empty.push(piAssistant('stop', ''));
    empty.push(piSettled());
    expect(empty.answer?.()).toBe('');
  });

  it('reports pi\'s own failure: a failed model call EXITS 0 and says so only in the stream', () => {
    // Measured: a 400 from the model — exit 0, stopReason `error`, the reason in errorMessage.
    const apiError = createCliProgressAdapter('pi-json');
    apiError.push(piHeader());
    apiError.push(piAssistant('error', '', { errorMessage: '400 {"type":"error","error":{"message":"fake 400"}}' }));
    apiError.push(piSettled());
    expect(apiError.answer?.()).toBeUndefined();
    expect(apiError.failure?.()).toBe('400 {"type":"error","error":{"message":"fake 400"}}');
    // Measured: an unreachable model is retried 3× (2, 4, 8 s), then reported twice.
    const down = createCliProgressAdapter('pi-json');
    down.push(piRow({ type: 'auto_retry_end', success: false, attempt: 3, finalError: 'Connection error.' }));
    expect(down.failure?.()).toBe('Connection error.');
    const aborted = createCliProgressAdapter('pi-json');
    aborted.push(piAssistant('stop', 'partial'));
    aborted.push(piSettled(true));
    expect(aborted.answer?.()).toBeUndefined();
    expect(aborted.failure?.()).toBe('pi aborted the run');
    const pending = createCliProgressAdapter('pi-json');
    pending.push(piAssistant('toolUse', 'running a command'));
    pending.push(piSettled());
    expect(pending.answer?.()).toBeUndefined();
    expect(pending.failure?.()).toBe("pi stopped with 'toolUse'");
    const unsettled = createCliProgressAdapter('pi-json');
    unsettled.push(piHeader());
    unsettled.push(piAssistant('stop', 'never settled'));
    expect(unsettled.failure?.()).toBe('pi stopped before it settled');
  });

  it('falls back to what pi said on stderr when it printed no event at all', () => {
    // Measured: `--session <id>` from another folder asks on stderr whether to
    // fork, reads the answer from stdin, and exits 0 with nothing on stdout.
    const adapter = createCliProgressAdapter('pi-json');
    adapter.push(Buffer.from('\x1b[33mSession found in different project: /other\x1b[39m\n'), 'stderr');
    adapter.push(Buffer.from('Fork this session into current directory? [y/N] '), 'stderr');
    adapter.end();
    expect(adapter.answer?.()).toBeUndefined();
    expect(adapter.failure?.()).toBe(
      'Session found in different project: /other; Fork this session into current directory? [y/N]',
    );
  });

  it('⛔ never reads an event off pi\'s stderr — and a dropped stderr line is not a dropped answer', () => {
    const adapter = createCliProgressAdapter('pi-json');
    adapter.push(piAssistant('stop', 'the answer'), 'stdout');
    expect(adapter.push(Buffer.from('{"type":"agent_settled","aborted":false}\n'), 'stderr')).toBe(0);
    expect(adapter.answer?.()).toBeUndefined();
    adapter.push(Buffer.from(`${'x'.repeat(1024 * 1024 + 1)}\n`), 'stderr');
    adapter.push(piSettled(), 'stdout');
    expect(adapter.answer?.()).toBe('the answer');
    // A dropped STDOUT record after the answer may have been the real last one.
    adapter.push(Buffer.from(`{"type":"message_end","message":{"role":"assistant","content":"${'y'.repeat(1024 * 1024)}"}}\n`), 'stdout');
    expect(adapter.answer?.()).toBeUndefined();
    expect(adapter.failure?.()).toMatch(/dropped after the last assistant message/);
  });

  // Records as opencode 1.15.13 prints them under `run --format json`
  // (measured; content trimmed). Each names its session; a tool is printed
  // only once it is done.
  const OC_SESSION = 'ses_ee4ac606bffea6jVlfAfpKeXJS';
  const ocRow = (type: string, part: Record<string, unknown> = {}, sessionID: string = OC_SESSION): Buffer =>
    Buffer.from(`${JSON.stringify({ type, timestamp: 1791459827814, sessionID, part: { sessionID, ...part } })}\n`);

  it('counts completed opencode units — text, a finished tool, a finished step — once each', () => {
    const adapter = createCliProgressAdapter('opencode-json');
    expect(adapter.push(ocRow('step_start', { id: 'prt_1', type: 'step-start' }))).toBe(0);
    expect(adapter.push(ocRow('tool_use', { id: 'prt_2', type: 'tool', tool: 'bash', state: { status: 'completed' } }))).toBe(1);
    expect(adapter.push(ocRow('tool_use', { id: 'prt_2', type: 'tool', tool: 'bash', state: { status: 'completed' } }))).toBe(0);
    expect(adapter.push(ocRow('step_finish', { id: 'prt_3', type: 'step-finish', reason: 'tool-calls' }))).toBe(1);
    expect(adapter.push(ocRow('step_start', { id: 'prt_4', type: 'step-start' }))).toBe(0);
    expect(adapter.push(ocRow('text', { id: 'prt_5', type: 'text', text: 'TOOL-ANSWER' }))).toBe(1);
    expect(adapter.push(ocRow('reasoning', { id: 'prt_6' }))).toBe(0);
    expect(adapter.push(Buffer.from('not json\n'))).toBe(0);
    expect(adapter.push(ocRow('step_finish', { id: 'prt_7', type: 'step-finish', reason: 'stop' }))).toBe(1);
    expect(adapter.end()).toBe(0);
    expect(adapter.answer?.()).toBe('TOOL-ANSWER');
    expect(adapter.facts?.()).toEqual({ session_id: OC_SESSION });
  });

  it('⛔ refuses an opencode session id that is not id-shaped — it becomes the value of --session', () => {
    for (const bad of ['--dangerously-skip-permissions', '-1', 'ses_short', 'ses_../../etc', `${OC_SESSION}!`, '']) {
      const adapter = createCliProgressAdapter('opencode-json');
      adapter.push(ocRow('step_start', { id: 'p1' }, bad));
      expect(adapter.facts?.(), bad).toEqual({});
    }
  });

  it('answers with the text of the LAST step that finished stop or length — never a mid-turn step', () => {
    const adapter = createCliProgressAdapter('opencode-json');
    adapter.push(ocRow('step_start', { id: 'a1' }));
    adapter.push(ocRow('text', { id: 'a2', text: "I'll run the tests." }));
    adapter.push(ocRow('step_finish', { id: 'a3', reason: 'tool-calls' }));
    expect(adapter.answer?.()).toBeUndefined();
    adapter.push(ocRow('step_start', { id: 'a4' }));
    adapter.push(ocRow('text', { id: 'a5', text: 'All tests pass.' }));
    adapter.push(ocRow('text', { id: 'a6', text: 'Nothing else changed.' }));
    adapter.push(ocRow('step_finish', { id: 'a7', reason: 'stop' }));
    expect(adapter.answer?.()).toBe('All tests pass.\n\nNothing else changed.');
    const length = createCliProgressAdapter('opencode-json');
    length.push(ocRow('step_start', { id: 'b1' }));
    length.push(ocRow('text', { id: 'b2', text: 'cut' }));
    length.push(ocRow('step_finish', { id: 'b3', reason: 'length' }));
    expect(length.answer?.()).toBe('cut');
  });

  it('⛔ a subagent\'s records never decide the answer', () => {
    const adapter = createCliProgressAdapter('opencode-json');
    adapter.push(ocRow('step_start', { id: 'c1' }));
    adapter.push(ocRow('step_start', { id: 'c2' }, 'ses_ee4ac606bffea6jVlfAfpKeXJZ'));
    adapter.push(ocRow('text', { id: 'c3', text: 'subagent says' }, 'ses_ee4ac606bffea6jVlfAfpKeXJZ'));
    adapter.push(ocRow('step_finish', { id: 'c4', reason: 'stop' }, 'ses_ee4ac606bffea6jVlfAfpKeXJZ'));
    expect(adapter.answer?.()).toBeUndefined();
    adapter.push(ocRow('text', { id: 'c5', text: 'parent says' }));
    adapter.push(ocRow('step_finish', { id: 'c6', reason: 'stop' }));
    expect(adapter.answer?.()).toBe('parent says');
    expect(adapter.facts?.()).toEqual({ session_id: OC_SESSION });
  });

  it('reports opencode\'s own failure: a failed model call EXITS 0 with an error record', () => {
    const adapter = createCliProgressAdapter('opencode-json');
    adapter.push(Buffer.from(`${JSON.stringify({ type: 'error', sessionID: OC_SESSION, error: {
      name: 'APIError', data: { message: 'fake 400', statusCode: 400, isRetryable: false, responseBody: 'BODY' },
    } })}\n`));
    expect(adapter.answer?.()).toBeUndefined();
    expect(adapter.failure?.()).toBe('APIError 400: fake 400');
    // An error after a finished answer still fails the run.
    const late = createCliProgressAdapter('opencode-json');
    late.push(ocRow('step_start', { id: 'd1' }));
    late.push(ocRow('text', { id: 'd2', text: 'answer' }));
    late.push(ocRow('step_finish', { id: 'd3', reason: 'stop' }));
    late.push(Buffer.from(`${JSON.stringify({ type: 'error', sessionID: OC_SESSION, error: { name: 'UnknownError' } })}\n`));
    expect(late.answer?.()).toBeUndefined();
    expect(late.failure?.()).toBe('UnknownError');
  });

  it('says why an opencode run ended without an answer when only stderr knows', () => {
    // Measured: a permission opencode would ask about is refused headless,
    // which ends the run after a `tool-calls` step; the reason is on stderr.
    const refused = createCliProgressAdapter('opencode-json');
    refused.push(ocRow('step_start', { id: 'e1' }));
    refused.push(ocRow('tool_use', { id: 'e2', state: { status: 'error' } }));
    refused.push(ocRow('step_finish', { id: 'e3', reason: 'tool-calls' }));
    refused.push(Buffer.from('\x1b[93m\x1b[1m! \x1b[0mpermission requested: external_directory (/outside/*); auto-rejecting\n'), 'stderr');
    expect(refused.answer?.()).toBeUndefined();
    expect(refused.failure?.()).toBe('! permission requested: external_directory (/outside/*); auto-rejecting');
    const quiet = createCliProgressAdapter('opencode-json');
    quiet.push(ocRow('step_start', { id: 'f1' }));
    quiet.push(ocRow('step_finish', { id: 'f2', reason: 'tool-calls' }));
    expect(quiet.failure?.()).toBe("opencode's last step finished with 'tool-calls'");
    // Measured: a --session of another folder is continued THERE, with nothing
    // printed; and an unreachable model host is retried with nothing printed.
    const silent = createCliProgressAdapter('opencode-json');
    silent.end();
    expect(silent.failure?.()).toBe('opencode printed no events; it does that when the session belongs to another folder, or while it cannot reach its model host');
  });

  it('bounds an unterminated record and resumes only after its delimiter', () => {
    const adapter = createCliProgressAdapter('yt-dlp-progress');
    expect(adapter.push(Buffer.alloc(1024 * 1024 + 1, 'x'))).toBe(0);
    // This valid-looking suffix is still part of the discarded oversized row.
    expect(adapter.push(Buffer.from('[download] 50.0% of 1MiB'))).toBe(0);
    // The newline ends the discarded row; the next complete record is eligible.
    expect(adapter.push(Buffer.from('\n[download] 51.0% of 1MiB\n'))).toBe(1);
    expect(adapter.end()).toBe(0);
  });
});
