/** ANSWER `output_capture` — `CliOutputCaptureSpec.from_progress_answer`.
 *
 *  Claude Code prints its final answer only inside the `result` record of its
 *  `stream-json` event stream, and has no flag to write it to a file. That
 *  stream is also what the heartbeat watches, so a `from_stdout` capture would
 *  keep the whole session — every tool output — when the caller wants the
 *  answer. This arm keeps only what the `claude-stream-json` adapter read as
 *  the answer, written to a path the engine chose; like every capture arm, the
 *  bytes come back only as a `file_ref`, never as a value.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createCliInvocationExecutor } from '../cli-invocation-executor.js';

/** This suite owns its temp root, so "nothing left behind" is about a
 *  directory no sibling test writes to. */
const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'cli-answer-root-'));
const strayDirs = (): string[] =>
  readdirSync(TEMP_ROOT).filter((n) => n.startsWith('recued-cli-'));

const SESSION = '6f1c2a90-1111-4abc-8def-0123456789ab';

/** A stand-in for `claude -p --output-format stream-json`: prints the records
 *  it is given, one per line, then exits with the given code. */
const FAKE_CLAUDE =
  `const rows=JSON.parse(process.argv[1]);`
  + `for (const r of rows) process.stdout.write(JSON.stringify(r)+'\\n');`
  + `process.exit(Number(process.argv[2]));`;

const binding = (storage?: 'cas' | 'temp') => ({
  kind: 'cli_invocation' as const,
  argv_template: [process.execPath, '-e', FAKE_CLAUDE, '{rows}', '{code}'],
  shape: 'ref' as const,
  ...(storage ? { storage } : {}),
  exit_code_handling: 'zero_is_success' as const,
  progress: { contract: 'heartbeat' as const, adapter: 'claude-stream-json' as const, stall_ms: 10_000 },
  output_capture: { from_progress_answer: true, mime_type: 'text/markdown', filename: 'answer.md' },
});

const call = (rows: unknown[], code = 0, storage?: 'cas' | 'temp') => ({
  slug: 'claude-code',
  operation_key: 'claude_code.task',
  operation_id: 'recued-core/claude_code.task',
  args: { rows: JSON.stringify(rows), code: String(code) },
  timeout_ms: 0,
  binding: binding(storage),
  stepMeta: { run_id: 'run-answer-1' },
}) as unknown as Parameters<ReturnType<typeof createCliInvocationExecutor>>[0];

const init = { type: 'system', subtype: 'init', session_id: SESSION, uuid: 'i1' };
const toolUse = { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'tool_use', name: 'Bash' }] } };
const toolResult = {
  type: 'user', uuid: 'u1',
  message: { content: [{ type: 'tool_result', content: 'SECRET-TOOL-OUTPUT' }] },
};
const result = (text: string, uuid: string) =>
  ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: SESSION, uuid });

describe('cli_invocation answer output_capture', () => {
  it('keeps the LAST result as the file, and returns the session id beside it', async () => {
    const exec = createCliInvocationExecutor({ tempRoot: TEMP_ROOT });

    const out = await exec(call([
      init, toolUse, toolResult,
      // A run that waits on a background agent ends with one result per turn.
      result('launched the agent; waiting', 'r1'),
      result('# Done\n\nThe fix is in place.', 'r2'),
    ], 0, 'temp')) as Record<string, unknown> & {
      file_ref: { backing: string; path: string; filename: string; mime_type: string };
    };

    expect(out).toMatchObject({ exit_code: 0, session_id: SESSION, filename: 'answer.md', mime_type: 'text/markdown' });
    expect(out.file_ref).toMatchObject({ backing: 'temp', filename: 'answer.md', mime_type: 'text/markdown' });
    expect(readFileSync(out.file_ref.path, 'utf8')).toBe('# Done\n\nThe fix is in place.');
    // Four records counted as progress: the tool call, its result and the two
    // results — the init line is a fact, not a unit.
    expect(out.progress_signal_count).toBe(4);
    expect(strayDirs()).toEqual([]);
  });

  /** ⛔ The isolation property: the stream — answer and tool outputs alike —
   *  never becomes a value. */
  it('never puts the stream or the answer into an op-step value', async () => {
    const exec = createCliInvocationExecutor({ tempRoot: TEMP_ROOT });

    const out = await exec(call([init, toolUse, toolResult, result('ANSWER-TEXT', 'r1')], 0, 'temp')) as Record<string, unknown>;

    expect(out.stdout).toBeUndefined();
    const { file_ref: _ref, ...value } = out;
    expect(JSON.stringify(value)).not.toContain('ANSWER-TEXT');
    expect(JSON.stringify(out)).not.toContain('SECRET-TOOL-OUTPUT');
  });

  it('ingests the answer into the CAS when the op asks for cas', async () => {
    const ingested: Array<{ bytes: Buffer; filename: string; mime_type: string }> = [];
    const exec = createCliInvocationExecutor({
      tempRoot: TEMP_ROOT,
      ingestToolOutput: async (input) => {
        ingested.push(input as { bytes: Buffer; filename: string; mime_type: string });
        return { record_id: 'file:answer' };
      },
    });

    const out = await exec(call([init, result('kept in the warehouse', 'r1')], 0, 'cas')) as Record<string, unknown>;

    expect(out.file_ref).toBe('file:answer');
    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.bytes.toString('utf8')).toBe('kept in the warehouse');
    expect(ingested[0]!.filename).toBe('answer.md');
    expect(strayDirs()).toEqual([]);
  });

  it('captures an empty answer as an empty file', async () => {
    const exec = createCliInvocationExecutor({ tempRoot: TEMP_ROOT });

    const out = await exec(call([init, result('', 'r1')], 0, 'temp')) as { file_ref: { path: string } };

    expect(existsSync(out.file_ref.path)).toBe(true);
    expect(readFileSync(out.file_ref.path, 'utf8')).toBe('');
  });

  it('fails as bad_output when a clean exit carried no answer', async () => {
    const exec = createCliInvocationExecutor({ tempRoot: TEMP_ROOT });

    await expect(exec(call([init, toolUse], 0, 'temp'))).rejects.toMatchObject({
      message: expect.stringMatching(/ended without a final answer$/),
      cli_failure: { reason: 'bad_output' },
    });
    // An error result on a clean exit is not an answer; its text says why.
    await expect(exec(call([init, {
      type: 'result', subtype: 'error_max_turns', is_error: true,
      errors: ['Reached maximum number of turns (1)'], uuid: 'r1',
    }], 0, 'temp'))).rejects.toMatchObject({
      message: expect.stringMatching(/ended without a final answer: Reached maximum number of turns \(1\)$/),
      cli_failure: { reason: 'bad_output' },
    });
    expect(strayDirs()).toEqual([]);
  });

  it('names Claude Code\'s own failure when it exits non-zero with nothing on stderr', async () => {
    const exec = createCliInvocationExecutor({ tempRoot: TEMP_ROOT });

    // Measured: an API error exits 1, prints nothing on stderr, and reports
    // itself only in the result record.
    const failure = await exec(call([init, {
      type: 'result', subtype: 'success', is_error: true,
      result: 'API Error: 400 fake 400', terminal_reason: 'api_error', uuid: 'r1',
    }], 1, 'temp')).catch((err: unknown) => err) as Error & { cli_failure: Record<string, unknown> };

    expect(failure.message).toBe(`cli tool '${process.execPath}' exited with code 1: API Error: 400 fake 400`);
    expect(failure.cli_failure).toMatchObject({ reason: 'nonzero_exit', exit_code: 1 });
    expect(failure.cli_failure.stderr).toBeUndefined();
  });
});
