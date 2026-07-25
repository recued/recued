/** D-118 Phase 6 — one-shot spawn helper for `service-invoke`.
 *
 *  Distinct from the supervisor's `defaultSpawnProcess`
 *  (long-running, pid + onExit tracked for crash recovery) and the
 *  installer's `defaultSpawn` (no timeout). This helper:
 *
 *    - Runs argv with `shell: false` + `stdio: ['ignore', 'pipe',
 *      'pipe']` (decision #9).
 *    - Captures stdout + stderr into one combined line array, capped
 *      at `SERVICE_INVOKE_STDOUT_CAP_BYTES` (1 MiB) with a truncation
 *      marker when the cap is hit.
 *    - Enforces a hard `timeout_ms` deadline — SIGKILL on expiry,
 *      surfacing as `{ exit_code: -9, timed_out: true }` so the
 *      dispatcher can classify it as a failed invoke.
 *    - Reports wall-clock `duration_ms` from spawn-start to exit.
 */
import { spawn as nodeSpawn } from 'node:child_process';

import { SERVICE_INVOKE_STDOUT_CAP_BYTES } from '@recued/contracts';

import type { InvokeSpawnResult, SpawnInvokeFn } from './types.js';

const TRUNCATION_MARKER =
  `[stdout truncated at ${SERVICE_INVOKE_STDOUT_CAP_BYTES} bytes]`;

export const defaultSpawnInvoke: SpawnInvokeFn = (argv, opts) =>
  new Promise<InvokeSpawnResult>((resolve) => {
    if (argv.length === 0) {
      resolve({
        exit_code: -1,
        log_lines: ['empty argv'],
        stdout_truncated: false,
        duration_ms: 0,
        timed_out: false,
      });
      return;
    }
    const started = Date.now();
    const [cmd, ...rest] = argv;
    const env = opts.env ? { ...process.env, ...opts.env } : process.env;
    let child;
    try {
      child = nodeSpawn(cmd, rest, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        cwd: opts.cwd,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        exit_code: -1,
        log_lines: [message],
        stdout_truncated: false,
        duration_ms: Date.now() - started,
        timed_out: false,
      });
      return;
    }

    const lines: string[] = [];
    let bytesCaptured = 0;
    let truncated = false;
    let timedOut = false;
    const partials = { stdout: '', stderr: '' };

    const ingest = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      if (truncated) return;
      const text = chunk.toString('utf8');
      const concat = partials[stream] + text;
      const last = concat.lastIndexOf('\n');
      if (last < 0) {
        partials[stream] = concat;
        return;
      }
      const ready = concat.slice(0, last);
      partials[stream] = concat.slice(last + 1);
      for (const line of ready.split('\n')) {
        const sized = Buffer.byteLength(line, 'utf8') + 1;
        if (bytesCaptured + sized > SERVICE_INVOKE_STDOUT_CAP_BYTES) {
          if (!truncated) {
            lines.push(TRUNCATION_MARKER);
            truncated = true;
          }
          return;
        }
        bytesCaptured += sized;
        lines.push(line);
      }
    };

    child.stdout?.on('data', (c: Buffer) => { ingest(c, 'stdout'); });
    child.stderr?.on('data', (c: Buffer) => { ingest(c, 'stderr'); });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, opts.timeout_ms);

    const settle = (code: number | null): void => {
      clearTimeout(timer);
      if (partials.stdout !== '') lines.push(partials.stdout);
      if (partials.stderr !== '') lines.push(partials.stderr);
      resolve({
        exit_code: timedOut ? -9 : code ?? -1,
        log_lines: lines,
        stdout_truncated: truncated,
        duration_ms: Date.now() - started,
        timed_out: timedOut,
      });
    };

    child.on('error', (err: Error) => {
      lines.push(err.message);
      settle(-1);
    });
    child.on('close', (code) => { settle(code); });
  });
