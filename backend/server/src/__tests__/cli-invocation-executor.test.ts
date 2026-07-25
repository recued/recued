import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { createCliInvocationExecutor } from '../cli-invocation-executor.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

const waitForFile = async (path: string): Promise<void> => {
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(path)) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${path}`);
};

describe('cli_invocation executor', () => {
  it('runs foreground argv shell-free, interpolates scalar args, and captures stdout', async () => {
    const exec = createCliInvocationExecutor();

    const result = await exec({
      slug: 'codex',
      operation_key: 'codex.status',
      operation_id: 'recued-core/codex.status',
      args: { message: 'ready' },
      timeout_ms: 5_000,
      binding: {
        kind: 'cli_invocation',
        argv_template: [
          process.execPath,
          '-e',
          'process.stdout.write(process.argv.at(-1) ?? "")',
          '{message}',
        ],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
      },
    });

    expect(result).toMatchObject({
      mode: 'foreground',
      exit_code: 0,
      stdout: 'ready',
      stderr: '',
      stdout_truncated: false,
      stderr_truncated: false,
    });
  });

  it('runs foreground commands from the resolved cwd arg', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recued-cli-cwd-'));
    try {
      const exec = createCliInvocationExecutor();

      const result = await exec({
        slug: 'vitest',
        operation_key: 'javascript.test_run',
        operation_id: 'recued-core/vitest.javascript.test_run',
        args: { project_dir: root },
        timeout_ms: 5_000,
        binding: {
          kind: 'cli_invocation',
          cwd: { arg: '{project_dir}' },
          argv_template: [
            process.execPath,
            '-e',
            'process.stdout.write(process.cwd())',
          ],
          shape: 'text',
          exit_code_handling: 'zero_is_success',
        },
      }) as { stdout: string };

      expect(result.stdout).toBe(realpathSync(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects cwd args that do not resolve to an existing directory before spawn', async () => {
    const exec = createCliInvocationExecutor();

    await expect(exec({
      slug: 'vitest',
      operation_key: 'javascript.test_run',
      operation_id: 'recued-core/vitest.javascript.test_run',
      args: { project_dir: join(tmpdir(), 'recued-cli-cwd-missing') },
      timeout_ms: 5_000,
      binding: {
        kind: 'cli_invocation',
        cwd: { arg: '{project_dir}' },
        argv_template: [process.execPath, '-e', 'process.exit(0)'],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
      },
    })).rejects.toThrow(/cwd .* must resolve to an existing directory/);
  });

  it('rejects foreground non-success exit codes', async () => {
    const exec = createCliInvocationExecutor();

    await expect(exec({
      slug: 'codex',
      operation_key: 'codex.review',
      operation_id: 'recued-core/codex.review',
      args: {},
      timeout_ms: 5_000,
      binding: {
        kind: 'cli_invocation',
        argv_template: [process.execPath, '-e', 'process.exit(7)'],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
      },
    })).rejects.toThrow(/code 7/);
  });

  it('does not crash when a foreground child exits before reading stdin', async () => {
    const exec = createCliInvocationExecutor();

    const result = await exec({
      slug: 'codex',
      operation_key: 'codex.status',
      operation_id: 'recued-core/codex.status',
      args: { body: 'x'.repeat(1024 * 1024) },
      timeout_ms: 5_000,
      binding: {
        kind: 'cli_invocation',
        argv_template: [process.execPath, '-e', 'process.exit(0)'],
        stdin_handling: 'pipe_body',
        shape: 'text',
        exit_code_handling: 'zero_is_success',
      },
    });

    expect(result).toMatchObject({ mode: 'foreground', exit_code: 0 });
  });

  it('kills a foreground child at the timeout and rejects with the bound', async () => {
    const exec = createCliInvocationExecutor();

    await expect(exec({
      slug: 'codex',
      operation_key: 'codex.status',
      operation_id: 'recued-core/codex.status',
      args: {},
      timeout_ms: 100,
      binding: {
        kind: 'cli_invocation',
        argv_template: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
      },
    })).rejects.toThrow(/timed out after 100ms/);
  });

  it('caps captured stdout at the byte ceiling and flags truncation', async () => {
    const exec = createCliInvocationExecutor();

    const result = await exec({
      slug: 'codex',
      operation_key: 'codex.status',
      operation_id: 'recued-core/codex.status',
      args: {},
      timeout_ms: 10_000,
      binding: {
        kind: 'cli_invocation',
        argv_template: [
          process.execPath,
          '-e',
          'process.stdout.write("x".repeat(1536 * 1024))',
        ],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
      },
    }) as { stdout: string; stdout_truncated: boolean };

    expect(result.stdout_truncated).toBe(true);
    expect(result.stdout.length).toBe(1024 * 1024);
  });

  it('pipes the full args object as JSON under pipe_args stdin handling', async () => {
    const exec = createCliInvocationExecutor();

    const result = await exec({
      slug: 'codex',
      operation_key: 'codex.status',
      operation_id: 'recued-core/codex.status',
      args: { task: 'review', depth: 2 },
      timeout_ms: 5_000,
      binding: {
        kind: 'cli_invocation',
        argv_template: [
          process.execPath,
          '-e',
          'let d="";process.stdin.on("data",(c)=>{d+=c});process.stdin.on("end",()=>{process.stdout.write(d)})',
        ],
        stdin_handling: 'pipe_args',
        shape: 'text',
        exit_code_handling: 'zero_is_success',
      },
    });

    expect(result).toMatchObject({ stdout: JSON.stringify({ task: 'review', depth: 2 }) });
  });

  it('rejects missing and non-scalar template args before spawning', async () => {
    const exec = createCliInvocationExecutor();
    const call = (args: Record<string, unknown>) => exec({
      slug: 'codex',
      operation_key: 'codex.review',
      operation_id: 'recued-core/codex.review',
      args,
      timeout_ms: 5_000,
      binding: {
        kind: 'cli_invocation',
        argv_template: [process.execPath, '-e', 'process.exit(0)', '{task}'],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
      },
    });

    await expect(call({})).rejects.toThrow(/'task' is required/);
    await expect(call({ task: { nested: true } })).rejects.toThrow(/must resolve to a scalar/);
  });

  it('rejects detached jobs that declare stdin piping', async () => {
    const exec = createCliInvocationExecutor();

    await expect(exec({
      slug: 'codex',
      operation_key: 'codex.review',
      operation_id: 'recued-core/codex.review',
      args: { result_dir: '/tmp', key: 'job_1' },
      timeout_ms: 5_000,
      binding: {
        kind: 'cli_invocation',
        argv_template: [process.execPath, '-e', 'process.exit(0)'],
        stdin_handling: 'pipe_args',
        shape: 'text',
        exit_code_handling: 'zero_is_success',
        detached: {
          mode: 'runtime_managed',
          completion: {
            kind: 'marker_file',
            exit_pattern: '{result_dir}/{key}.exit.{code}',
          },
        },
      },
    })).rejects.toThrow(/requires stdin_handling none/);
  });

  it('launches runtime-managed detached jobs and writes pid, log, and exit markers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recued-cli-detached-'));
    try {
      const exec = createCliInvocationExecutor();
      const result = await exec({
        slug: 'codex',
        operation_key: 'codex.review',
        operation_id: 'recued-core/codex.review',
        args: { result_dir: root, key: 'job_1' },
        timeout_ms: 5_000,
        binding: {
          kind: 'cli_invocation',
          argv_template: [
            process.execPath,
            '-e',
            'setTimeout(() => { console.log("done"); process.exit(7); }, 20)',
          ],
          stdin_handling: 'none',
          shape: 'text',
          exit_code_handling: 'zero_is_success',
          detached: {
            mode: 'runtime_managed',
            completion: {
              kind: 'marker_file',
              exit_pattern: '{result_dir}/{key}.exit.{code}',
              log_pattern: '{result_dir}/{key}.log',
            },
            cancel: {
              kind: 'process_group',
              pid_pattern: '{result_dir}/{key}.pid',
            },
          },
        },
      });

      expect(result).toMatchObject({
        mode: 'detached',
        launched: true,
        exit_pattern: `${root}/job_1.exit.{code}`,
        log_path: `${root}/job_1.log`,
        pid_path: `${root}/job_1.pid`,
      });

      await waitForFile(join(root, 'job_1.exit.7'));
      expect(readFileSync(join(root, 'job_1.pid'), 'utf8')).toMatch(/\d+/);
      expect(readFileSync(join(root, 'job_1.log'), 'utf8')).toContain('done');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects detached marker paths that escape result_dir after interpolation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recued-cli-detached-confine-'));
    try {
      const exec = createCliInvocationExecutor();

      await expect(exec({
        slug: 'codex',
        operation_key: 'codex.review',
        operation_id: 'recued-core/codex.review',
        args: { result_dir: root, key: '../outside/job_1' },
        timeout_ms: 5_000,
        binding: {
          kind: 'cli_invocation',
          argv_template: [process.execPath, '-e', 'process.exit(0)'],
          stdin_handling: 'none',
          shape: 'text',
          exit_code_handling: 'zero_is_success',
          detached: {
            mode: 'runtime_managed',
            completion: {
              kind: 'marker_file',
              exit_pattern: '{result_dir}/{key}.exit.{code}',
              log_pattern: '{result_dir}/{key}.log',
            },
            cancel: {
              kind: 'process_group',
              pid_pattern: '{result_dir}/{key}.pid',
            },
          },
        },
      })).rejects.toThrow(/under result_dir/);

      expect(existsSync(join(root, '..', 'outside', 'job_1.pid'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects marker paths through a symlink without creating directories at its target', async () => {
    const base = mkdtempSync(join(tmpdir(), 'recued-cli-detached-symlink-'));
    const root = join(base, 'results');
    const outside = join(base, 'outside');
    try {
      mkdirSync(root, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(root, 'link'));
      const exec = createCliInvocationExecutor();

      await expect(exec({
        slug: 'codex',
        operation_key: 'codex.review',
        operation_id: 'recued-core/codex.review',
        args: { result_dir: root, key: 'link/deep/job_1' },
        timeout_ms: 5_000,
        binding: {
          kind: 'cli_invocation',
          argv_template: [process.execPath, '-e', 'process.exit(0)'],
          stdin_handling: 'none',
          shape: 'text',
          exit_code_handling: 'zero_is_success',
          detached: {
            mode: 'runtime_managed',
            completion: {
              kind: 'marker_file',
              exit_pattern: '{result_dir}/{key}.exit.{code}',
            },
            cancel: {
              kind: 'process_group',
              pid_pattern: '{result_dir}/{key}.pid',
            },
          },
        },
      })).rejects.toThrow(/under result_dir/);

      // The anchor check fires BEFORE the recursive mkdir — nothing may be
      // created at the symlink target.
      expect(existsSync(join(outside, 'deep'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('kills a detached child when the launch handshake times out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recued-cli-detached-timeout-'));
    try {
      let killed = false;
      const fakeSpawn = (() => {
        const child = new EventEmitter() as ChildProcess;
        Object.defineProperty(child, 'pid', { value: 4242 });
        child.kill = (() => {
          killed = true;
          return true;
        }) as ChildProcess['kill'];
        child.unref = (() => child) as ChildProcess['unref'];
        setTimeout(() => child.emit('spawn'), 250);
        return child;
      }) as NonNullable<Parameters<typeof createCliInvocationExecutor>[0]>['spawn'];
      const exec = createCliInvocationExecutor({ spawn: fakeSpawn, launchTimeoutMs: 100 });

      await expect(exec({
        slug: 'codex',
        operation_key: 'codex.review',
        operation_id: 'recued-core/codex.review',
        args: { result_dir: root, key: 'job_1' },
        timeout_ms: 5_000,
        binding: {
          kind: 'cli_invocation',
          argv_template: ['codex', 'exec'],
          stdin_handling: 'none',
          shape: 'text',
          exit_code_handling: 'zero_is_success',
          detached: {
            mode: 'runtime_managed',
            completion: {
              kind: 'marker_file',
              exit_pattern: '{result_dir}/{key}.exit.{code}',
              log_pattern: '{result_dir}/{key}.log',
            },
            cancel: {
              kind: 'process_group',
              pid_pattern: '{result_dir}/{key}.pid',
            },
          },
        },
      })).rejects.toThrow(/launch timed out/);
      expect(killed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// D-181 Slice 3 — progress-based stall detection on the foreground path. A
// declared `progress` contract drops the tight `timeout_ms` cap and lets the
// stall monitor govern; tuning shrinks the windows so a real hung subprocess is
// SIGKILLed in milliseconds. Without a contract the old cap is unchanged.
describe('cli_invocation foreground stall detection (D-181 slice 3)', () => {
  // k·T = 600ms — generous enough to clear node subprocess startup (~50-200ms)
  // so the "spares" case never false-stalls during boot, but short enough to
  // keep the "kills" case fast. silentHardCapMs is large so the heartbeat tests
  // exercise no_progress, not the fail-safe.
  const tinyTuning = { pollMs: 20, factorK: 3, expectedIntervalMs: 200, silentHardCapMs: 5_000 };

  it('SIGKILLs a heartbeat op that goes silent (unattended), rejects with a stall', async () => {
    const exec = createCliInvocationExecutor({ stallTuning: tinyTuning });

    await expect(exec({
      slug: 'docling',
      operation_key: 'docling.convert',
      operation_id: 'recued-core/docling.convert',
      args: {},
      // no timeout_ms cap — the monitor governs
      stepMeta: { step_id: 's1', trigger_source: 'reactive' }, // unattended
      binding: {
        kind: 'cli_invocation',
        // emits nothing, then hangs → no heartbeat for k·T → stalled.
        argv_template: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
        progress: { contract: 'heartbeat' },
      },
    })).rejects.toThrow(/killed: no_progress stall/);
  });

  it('spares a heartbeat op that keeps emitting stdout', async () => {
    const exec = createCliInvocationExecutor({ stallTuning: tinyTuning });

    const result = await exec({
      slug: 'docling',
      operation_key: 'docling.convert',
      operation_id: 'recued-core/docling.convert',
      args: {},
      stepMeta: { step_id: 's1', trigger_source: 'reactive' },
      binding: {
        kind: 'cli_invocation',
        // emits a line every 15ms for ~300ms, then exits 0 — never silent for k·T.
        argv_template: [
          process.execPath,
          '-e',
          'let n=0;const i=setInterval(()=>{process.stdout.write("tick\\n");if(++n>20){clearInterval(i);process.exit(0)}},15)',
        ],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
        progress: { contract: 'heartbeat' },
      },
    }) as { exit_code: number; progress_signal_count: number };

    expect(result.exit_code).toBe(0);
    expect(result.progress_signal_count).toBeGreaterThan(0);
  });

  it('bounds a silent op only by the generous hard cap', async () => {
    const exec = createCliInvocationExecutor({ stallTuning: { ...tinyTuning, silentHardCapMs: 200 } });

    await expect(exec({
      slug: 'pandoc',
      operation_key: 'pandoc.convert',
      operation_id: 'recued-core/pandoc.convert',
      args: {},
      stepMeta: { step_id: 's1', trigger_source: 'reactive' },
      binding: {
        kind: 'cli_invocation',
        argv_template: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
        progress: { contract: 'silent' },
      },
    })).rejects.toThrow(/killed: silent_cap stall/);
  });

  it('does NOT auto-kill an attended heartbeat op on no-progress (human governs)', async () => {
    // attended + no signals: the no-progress flag must NOT kill; only the
    // generous fail-safe (here shrunk to 250ms) eventually bounds it.
    const exec = createCliInvocationExecutor({
      stallTuning: { pollMs: 10, factorK: 2, expectedIntervalMs: 10, silentHardCapMs: 250 },
    });

    const start = Date.now();
    await expect(exec({
      slug: 'docling',
      operation_key: 'docling.convert',
      operation_id: 'recued-core/docling.convert',
      args: {},
      stepMeta: { step_id: 's1', trigger_source: 'manual' }, // attended
      binding: {
        kind: 'cli_invocation',
        argv_template: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
        progress: { contract: 'heartbeat' },
      },
    })).rejects.toThrow(/killed: silent_cap stall/);
    // k·T = 20ms would have killed an unattended op; it survived well past that.
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
  });

  it('surfaces progress_flagged on an attended op that stalled then completed', async () => {
    // attended + heartbeat + silent for k·T (=20ms) → flagged but not killed;
    // it exits 0 well before the generous cap, carrying progress_flagged.
    const exec = createCliInvocationExecutor({
      stallTuning: { pollMs: 10, factorK: 2, expectedIntervalMs: 10, silentHardCapMs: 5_000 },
    });

    const result = await exec({
      slug: 'docling',
      operation_key: 'docling.convert',
      operation_id: 'recued-core/docling.convert',
      args: {},
      stepMeta: { step_id: 's1', trigger_source: 'manual' }, // attended
      binding: {
        kind: 'cli_invocation',
        // silent for ~150ms (flags at k·T=20ms) then exits 0.
        argv_template: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 150)'],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
        progress: { contract: 'heartbeat' },
      },
    }) as { exit_code: number; progress_flagged?: boolean };

    expect(result.exit_code).toBe(0);
    expect(result.progress_flagged).toBe(true);
  });

  it('keeps the tight timeout_ms cap when no progress contract is declared', async () => {
    const exec = createCliInvocationExecutor({ stallTuning: tinyTuning });

    await expect(exec({
      slug: 'codex',
      operation_key: 'codex.status',
      operation_id: 'recued-core/codex.status',
      args: {},
      timeout_ms: 100,
      binding: {
        kind: 'cli_invocation',
        argv_template: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
        // no `progress` → unchanged behaviour
      },
    })).rejects.toThrow(/timed out after 100ms/);
  });
});

describe('cli_invocation executor — D-185 output shape', () => {
  const runWithShape = (
    script: string,
    shape: 'text' | 'json' | 'jsonl' | undefined,
  ): Promise<unknown> => {
    const exec = createCliInvocationExecutor();
    return exec({
      slug: 'gh',
      operation_key: 'gh.api',
      operation_id: 'recued-core/gh.api',
      args: {},
      timeout_ms: 5_000,
      binding: {
        kind: 'cli_invocation',
        argv_template: [process.execPath, '-e', script],
        ...(shape ? { shape } : {}),
        exit_code_handling: 'zero_is_success',
      },
    });
  };

  it('shape: json parses stdout into a typed value', async () => {
    const result = (await runWithShape(
      'process.stdout.write(JSON.stringify({ a: 1, b: [2, 3] }))',
      'json',
    )) as Record<string, unknown>;
    expect(result.stdout).toEqual({ a: 1, b: [2, 3] });
  });

  it('shape: jsonl parses each non-empty line into an array (NDJSON)', async () => {
    const result = (await runWithShape(
      'process.stdout.write(\'{"x":1}\\n{"x":2}\\n\\n{"x":3}\\n\')',
      'jsonl',
    )) as Record<string, unknown>;
    expect(result.stdout).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }]);
  });

  it('shape: text keeps the raw stdout string; omitted shape is exit-code-only (no stdout captured)', async () => {
    const asText = (await runWithShape(
      'process.stdout.write("{not json}")',
      'text',
    )) as Record<string, unknown>;
    expect(asText.stdout).toBe('{not json}');
    // D-185 Slice 3 — an OMITTED shape no longer captures stdout (exit-code-only).
    const omitted = (await runWithShape(
      'process.stdout.write("{not json}")',
      undefined,
    )) as Record<string, unknown>;
    expect(omitted.stdout).toBeUndefined();
  });

  it('shape: json rejects a malformed payload (not valid json)', async () => {
    await expect(
      runWithShape('process.stdout.write("definitely not json")', 'json'),
    ).rejects.toThrow(/not valid json/);
  });

  it('shape: json errors when stdout exceeds the realize cap (truncated), never parses partial bytes', async () => {
    // >1 MB stdout → the capture truncates → a value shape must error (declare
    // shape:'ref' for large output), not parse the partial bytes.
    await expect(
      runWithShape('process.stdout.write("x".repeat(1200000))', 'json'),
    ).rejects.toThrow(/realize cap/);
  });

  it('a non-zero exit rejects with the exit reason, not a parse error (success-path realization)', async () => {
    await expect(
      runWithShape('process.stdout.write("not json"); process.exit(7)', 'json'),
    ).rejects.toThrow(/code 7/);
  });
});
