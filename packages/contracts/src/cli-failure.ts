// D-182 — cli (local-binary) executor failure classification.
//
// A `kind: 'cli'` op shells out to a local binary (whisper / docling / ffmpeg /
// codex …). Every failure used to reject a BARE `Error`, so the engine coded it
// the catch-all `NETWORK_ERROR` (reads to an agent as a connectivity problem) and
// the tool's own stderr was discarded. This module is the structural carrier that
// lets the executor classify a failure once — missing binary vs ran-and-failed vs
// timed-out — and have every downstream surface (the step error code, the Runs
// feed, the chat errors[]) read that classification WITHOUT string-matching a
// message. Mirrors the D-181 `heavy_op` (`HeavyOpKillTelemetry`) carrier pattern.

import type { RecipeErrorCode } from './errors.js';

/** Why a cli invocation failed, classified at the executor. Disjoint from the
 *  D-181 stall/kill telemetry (`heavy_op`): a stall-kill rejects BEFORE the
 *  exit-code check, so a single failure carries at most one of the two.
 *    - `not_found`    — the binary isn't on PATH (spawn `ENOENT`); the tool may
 *                       not be installed, or was removed by the user. The proactive
 *                       readiness probe (a later slice) reports the SAME state
 *                       before a run.
 *    - `spawn_error`  — the process couldn't start for another reason (`EACCES`
 *                       not-executable, `EPERM`, an empty resolved argv, …).
 *    - `nonzero_exit` — the tool ran but exited outside its declared success codes.
 *    - `timeout`      — the tight foreground `timeout_ms` cap SIGKILLed it (an op
 *                       with no D-181 progress contract). The progress-contract
 *                       stall/silent-cap path stays on `heavy_op`, not here.
 *    - `bad_output`   — the tool exited successfully but its output was unusable:
 *                       an `output_capture` op produced no file / too many files /
 *                       an oversized file, or a `shape: 'json'|'jsonl'` op's stdout
 *                       didn't parse / overran the realize cap. */
export type CliFailureReason =
  | 'not_found'
  | 'spawn_error'
  | 'nonzero_exit'
  | 'timeout'
  | 'bad_output';

/** Closed set of every `CliFailureReason`, in canonical order. */
export const CLI_FAILURE_REASONS: readonly CliFailureReason[] = [
  'not_found',
  'spawn_error',
  'nonzero_exit',
  'timeout',
  'bad_output',
] as const;

/** Structured cli-failure carrier the executor attaches to the rejected error
 *  (`err.cli_failure`); the engine preserves it onto
 *  `RecipeError.details.cli_failure` (the same carrier pattern as
 *  `details.heavy_op`) so every surface reads the classification structurally. */
export interface CliFailureDetail {
  reason: CliFailureReason;
  /** The cli ingredient slug (`<publisher>.<pack>.<operation>`) — becomes the
   *  step error's `source.ingredient_slug` so a failure names WHICH op failed
   *  (previously hard-coded `null`). */
  slug?: string;
  /** The resolved op id. */
  operation_id?: string;
  /** The binary the op shells out to (`argv[0]`, e.g. `whisper`) — the
   *  human-readable "which tool" for the failure message + the readiness story. */
  tool?: string;
  /** The tool's exit code — `nonzero_exit` (the failing code), `timeout` (`-9`,
   *  SIGKILLed), `bad_output` (the accepted success code, usually `0`). */
  exit_code?: number;
  /** The TAIL of the tool's captured stderr — the actual diagnostic, previously
   *  discarded on every reject path. ABSENT for an `input_materialize` op (D-172
   *  I-4 content isolation: a materialize op's stderr can echo the input file's
   *  bytes, so it must never reach an actor-readable value). */
  stderr?: string;
  /** True when more stderr existed than the carried tail (or the capture cap hit). */
  stderr_truncated?: boolean;
}

/** Map a Node spawn-error `code` to a cli failure reason. `ENOENT` ⇒ the binary
 *  isn't on PATH (`not_found`, the actionable "install it" case); anything else
 *  (`EACCES` / `EPERM` / …) ⇒ a generic `spawn_error`. */
export const cliSpawnErrorReason = (code: unknown): CliFailureReason =>
  code === 'ENOENT' ? 'not_found' : 'spawn_error';

/** The `RecipeErrorCode` a cli failure reason carries. A missing binary gets its
 *  own `CLI_TOOL_NOT_FOUND` (the actionable case, and the run-time twin of the
 *  proactive readiness state); every other cli fault is `CLI_TOOL_FAILED`. Both
 *  REPLACE the historical `NETWORK_ERROR` mislabel — an agent reading the code in
 *  chat now sees a tool problem, not a network one. */
export const cliFailureErrorCode = (reason: CliFailureReason): RecipeErrorCode =>
  reason === 'not_found' ? 'CLI_TOOL_NOT_FOUND' : 'CLI_TOOL_FAILED';

/** Narrow an unknown value (a thrown error's `cli_failure`, or a
 *  `RecipeError.details.cli_failure`) to the carrier — structural, so the
 *  downstream surfaces never string-match a message. */
export const isCliFailureDetail = (value: unknown): value is CliFailureDetail =>
  value !== null
  && typeof value === 'object'
  && CLI_FAILURE_REASONS.includes((value as CliFailureDetail).reason);
