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
