/** D-182 — cli executor failure classification.
 *
 *  Every cli failure path now rejects with a `cli_failure`-bearing error (the
 *  carrier the engine codes the step from + preserves into
 *  `details.cli_failure`), instead of a bare Error that became `NETWORK_ERROR`.
 *  These tests drive a real `node -e` subprocess (and a genuinely-missing binary)
 *  and assert the classified carrier — reason, which-tool, exit code, and the
 *  TRUE stderr tail under the content-isolation gate.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createCliInvocationExecutor } from '../cli-invocation-executor.js';
import { cleanupRunScratch } from '../execution/run-scratch.js';
import type { CliFailureDetail } from '@recued/contracts';

const execPath = process.execPath;

type Exec = ReturnType<typeof createCliInvocationExecutor>;
type CliCall = Parameters<Exec>[0];

const runIds: string[] = [];
const freshRun = (label: string): string => {
  const id = `d182-cli-fail-${label}-${runIds.length}`;
  runIds.push(id);
  return id;
};
afterEach(() => {
  for (const id of runIds.splice(0)) cleanupRunScratch(id);
});

const mkCall = (binding: unknown, over: Partial<CliCall> = {}): CliCall => ({
  slug: 'recued-core.docling.document.to_markdown',
  operation_key: 'document.to_markdown',
  operation_id: 'recued-core/document.to_markdown',
  args: {},
  timeout_ms: 5_000,
  binding,
  ...over,
} as CliCall);

/** Run a call expected to FAIL; return the classified carrier + the message.
 *  Fails the test (rather than passing spuriously) if the call resolves or the
 *  rejection carries no `cli_failure`. */
const failure = async (
  call: CliCall,
  exec: Exec = createCliInvocationExecutor(),
): Promise<CliFailureDetail & { _message: string }> => {
  let threw: unknown;
  let resolved = false;
  try {
    await exec(call);
    resolved = true;
  } catch (e) {
    threw = e;
  }
  expect(resolved, 'cli call should have rejected, not resolved').toBe(false);
  expect(threw).toBeInstanceOf(Error);
  const err = threw as Error & { cli_failure?: CliFailureDetail };
  expect(err.cli_failure, 'rejection should carry a cli_failure carrier').toBeDefined();
  return { ...(err.cli_failure as CliFailureDetail), _message: err.message };
};

describe('D-182 — cli executor failure classification', () => {
  it('a missing binary → not_found, naming the op (slug/operation_id) and the tool (argv[0])', async () => {
    const det = await failure(mkCall({
      kind: 'cli_invocation',
      argv_template: ['recued-no-such-binary-xyzzy'],
      shape: 'text',
      exit_code_handling: 'zero_is_success',
    }));
    expect(det).toMatchObject({
      reason: 'not_found',
      slug: 'recued-core.docling.document.to_markdown',
      operation_id: 'recued-core/document.to_markdown',
      tool: 'recued-no-such-binary-xyzzy',
    });
    expect(det._message).toMatch(/not found/);
  });

  it('a non-zero exit → nonzero_exit, carrying the exit code and the stderr the tool printed', async () => {
    const det = await failure(mkCall({
      kind: 'cli_invocation',
      argv_template: [execPath, '-e', "process.stderr.write('the real error'); process.exit(3)"],
      shape: 'text',
      exit_code_handling: 'zero_is_success',
    }));
    expect(det).toMatchObject({ reason: 'nonzero_exit', exit_code: 3, stderr: 'the real error' });
  });

  it('a custom success_codes set still classifies a code outside it as nonzero_exit', async () => {
    const det = await failure(mkCall({
      kind: 'cli_invocation',
      argv_template: [execPath, '-e', 'process.exit(1)'],
      shape: 'text',
      exit_code_handling: { success_codes: [0, 2] },
    }));
    expect(det).toMatchObject({ reason: 'nonzero_exit', exit_code: 1 });
  });

  it('carries the TRUE stderr tail (the END), not a slice of the head, when stderr overruns the cap', async () => {
    // ~8 KB of filler then the real error at the very end → the head-biased 1 MiB
    // capture would slice filler; the tail buffer must surface FINAL_ERROR_MARKER.
    const script =
      "process.stderr.write('A'.repeat(8000)); process.stderr.write('FINAL_ERROR_MARKER'); process.exit(1)";
    const det = await failure(mkCall({
      kind: 'cli_invocation',
      argv_template: [execPath, '-e', script],
      shape: 'text',
      exit_code_handling: 'zero_is_success',
    }));
    expect(det.reason).toBe('nonzero_exit');
    expect(det.stderr_truncated).toBe(true);
    expect(det.stderr).toMatch(/FINAL_ERROR_MARKER$/);
    expect((det.stderr ?? '').length).toBeLessThanOrEqual(4096);
  });

  it('an input_materialize op WITHHOLDS its stderr from the carrier (D-172 content isolation)', async () => {
    // A literal (non-CAS) source arg passes through to the subprocess unchanged,
    // but the op stays `input_materialize` so its stderr — which could echo the
    // input file's bytes — must never land in the actor-readable carrier.
    const det = await failure(mkCall({
      kind: 'cli_invocation',
      argv_template: [execPath, '-e', "process.stderr.write('SECRET FILE BYTES'); process.exit(1)"],
      input_materialize: { kind: 'file_ref', arg: 'source' },
      exit_code_handling: 'zero_is_success',
    }, { args: { source: '/tmp/not-a-cas-ref.pdf' } }));
    expect(det).toMatchObject({ reason: 'nonzero_exit', exit_code: 1 });
    expect(det.stderr).toBeUndefined();
  });

  it('a tight-timeout SIGKILL → timeout, exit_code -9', async () => {
    const det = await failure(mkCall({
      kind: 'cli_invocation',
      argv_template: [execPath, '-e', 'setTimeout(() => {}, 10000)'],
      shape: 'text',
      exit_code_handling: 'zero_is_success',
    }, { timeout_ms: 100 }));
    expect(det).toMatchObject({ reason: 'timeout', exit_code: -9 });
  });

  it('an empty resolved argv → spawn_error (a cli config fault, not a network error)', async () => {
    const det = await failure(mkCall({
      kind: 'cli_invocation',
      argv_template: [],
      shape: 'text',
      exit_code_handling: 'zero_is_success',
    }));
    expect(det.reason).toBe('spawn_error');
  });

  it('a shape:json op whose stdout is not valid JSON → bad_output (tool exited 0)', async () => {
    const det = await failure(mkCall({
      kind: 'cli_invocation',
      argv_template: [execPath, '-e', "process.stdout.write('not json at all')"],
      shape: 'json',
      exit_code_handling: 'zero_is_success',
    }));
    expect(det).toMatchObject({ reason: 'bad_output', exit_code: 0 });
    expect(det._message).toMatch(/not valid json/);
  });

  it('an output_capture op that produces no file → bad_output (exit 0, unusable output)', async () => {
    const id = freshRun('nofile');
    const det = await failure(mkCall({
      kind: 'cli_invocation',
      // exits cleanly but writes nothing into the engine-owned output dir
      argv_template: [execPath, '-e', 'process.exit(0)', '{out_dir}'],
      shape: 'ref',
      storage: 'temp',
      exit_code_handling: 'zero_is_success',
      output_capture: { dir_arg: 'out_dir', mime_type: 'text/markdown' },
    }, { stepMeta: { run_id: id } as CliCall['stepMeta'] }));
    expect(det).toMatchObject({ reason: 'bad_output', tool: execPath });
    expect(det._message).toMatch(/produced no/);
  });

  it('a detached launch against a missing binary → not_found', async () => {
    const id = freshRun('detached-missing');
    const det = await failure(mkCall({
      kind: 'cli_invocation',
      argv_template: ['recued-no-such-binary-detached'],
      shape: 'text',
      exit_code_handling: 'zero_is_success',
      detached: {
        mode: 'runtime_managed',
        completion: { exit_pattern: '{result_dir}/job.exit.{code}' },
      },
    }, { args: { result_dir: `/tmp/${id}` } }));
    expect(det).toMatchObject({ reason: 'not_found', tool: 'recued-no-such-binary-detached' });
  });
});
