/** D-118 Phase 3 — default spawn helper for installers.
 *
 *  Every installer subprocess runs through this wrapper so the
 *  argv / stdio / capture invariants stay in one place. Loaded by
 *  `dispatcher.ts` as the default `ctx.spawn` when callers don't
 *  inject one (tests do).
 *
 *  Stdio shape matches D-118 load-bearing decision #9:
 *    - stdin → 'ignore' (never piped, no REPL hangs).
 *    - stdout + stderr → 'pipe' (captured + bounded).
 *
 *  Output is captured into one combined `log_lines` array in
 *  arrival order. Bounded at 1 MiB total (matches
 *  `SERVICE_INVOKE_STDOUT_CAP_BYTES`); a truncation marker line is
 *  appended once the cap is hit and further data is discarded.
 */

import { spawn as nodeSpawn } from 'node:child_process';

import { SERVICE_INVOKE_STDOUT_CAP_BYTES } from '@recued/contracts';

import type { SpawnFn, SpawnOptions, SpawnResult } from './types.js';

const TRUNCATION_MARKER =
  `[stdout truncated at ${SERVICE_INVOKE_STDOUT_CAP_BYTES} bytes]`;

/** Default spawn implementation. Returns once the child exits;
 *  surfaces spawn-time errors (binary missing, permission denied)
 *  as `exit_code: -1` with the error message in `log_lines` so
 *  callers don't need to branch on a separate error path. */
export const defaultSpawn: SpawnFn = (
  argv: string[],
  opts: SpawnOptions = {},
): Promise<SpawnResult> =>
  new Promise<SpawnResult>((resolve) => {
    if (argv.length === 0) {
      resolve({ exit_code: -1, log_lines: ['empty argv'] });
      return;
    }
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
      resolve({ exit_code: -1, log_lines: [message] });
      return;
    }

    const lines: string[] = [];
    let bytesCaptured = 0;
    let truncated = false;
    /** Decoder state — one buffer per stream so partial UTF-8 at
     *  chunk boundaries doesn't fragment lines. */
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
        // Don't drop legitimately-empty lines — they convey
        // structure in some installer outputs.
        const sized = Buffer.byteLength(line, 'utf8') + 1; // +1 for newline
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

    child.on('error', (err: Error) => {
      // Either spawn-itself failed (rare; mostly caught above) or
      // the child died before start. Surface as exit -1.
      lines.push(err.message);
      resolve({ exit_code: -1, log_lines: lines });
    });
    child.on('close', (code: number | null) => {
      // Flush any unterminated partial lines so callers don't
      // miss the last bit of output (common for installers that
      // skip a trailing newline).
      if (partials.stdout !== '') lines.push(partials.stdout);
      if (partials.stderr !== '') lines.push(partials.stderr);
      resolve({ exit_code: code ?? -1, log_lines: lines });
    });
  });
