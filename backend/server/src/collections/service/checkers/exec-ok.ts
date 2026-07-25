/** D-118 Phase 4 — `exec_ok` checker.
 *
 *  Semantics (spec line 487): `spawn(shell: false)` + exit code
 *  ∈ `exit_codes_ok` (default `[0]`). `timeout_ms` defaults to
 *  5 s — same ceiling as `http_ok`; checks aren't long-running
 *  workloads.
 *
 *  Child stdio is `['ignore', 'ignore', 'ignore']` — stdin
 *  `/dev/null` so REPL-shaped binaries (`python`, `node`, `mysql`
 *  without a query) fail fast with EOF instead of hanging until
 *  the timeout, per decision #9. Stdout/stderr capture is
 *  skipped outright because checkers only observe exit codes.
 */
import type { ServiceCheckResult } from '@recued/contracts';

import {
  CheckerParamError,
  type CheckerContext,
  type CheckerKindModule,
} from './types.js';
import { withDefaults } from './process.js';

export interface ExecOkParams {
  argv: string[];
  exit_codes_ok: number[];
  timeout_ms: number;
}

const DEFAULT_EXIT_CODES_OK = [0];
const DEFAULT_TIMEOUT_MS = 5_000;

const validate = (raw: unknown): ExecOkParams => {
  if (raw === null || typeof raw !== 'object') {
    throw new CheckerParamError('exec_ok', 'params must be an object');
  }
  const p = raw as Record<string, unknown>;
  if (
    !Array.isArray(p.argv) ||
    p.argv.length === 0 ||
    !p.argv.every((s) => typeof s === 'string' && s !== '')
  ) {
    throw new CheckerParamError(
      'exec_ok',
      'argv required — non-empty array of non-empty strings',
    );
  }

  let exit_codes_ok = DEFAULT_EXIT_CODES_OK;
  if (p.exit_codes_ok !== undefined) {
    if (
      !Array.isArray(p.exit_codes_ok) ||
      p.exit_codes_ok.length === 0 ||
      !p.exit_codes_ok.every((c) => typeof c === 'number' && Number.isInteger(c))
    ) {
      throw new CheckerParamError(
        'exec_ok',
        'exit_codes_ok must be a non-empty array of integers',
      );
    }
    exit_codes_ok = p.exit_codes_ok as number[];
  }

  let timeout_ms = DEFAULT_TIMEOUT_MS;
  if (p.timeout_ms !== undefined) {
    if (
      typeof p.timeout_ms !== 'number' ||
      !Number.isFinite(p.timeout_ms) ||
      p.timeout_ms <= 0
    ) {
      throw new CheckerParamError(
        'exec_ok',
        'timeout_ms must be a positive number',
      );
    }
    timeout_ms = p.timeout_ms;
  }

  return { argv: p.argv as string[], exit_codes_ok, timeout_ms };
};

const check = async (
  params: ExecOkParams,
  ctx: CheckerContext,
): Promise<ServiceCheckResult> => {
  const io = withDefaults(ctx);
  const { exit_code } = await io.spawnWithTimeout(params.argv, params.timeout_ms);
  if (exit_code === -9) {
    return {
      passed: false,
      detail: `${params.argv[0]} timed out after ${params.timeout_ms}ms`,
    };
  }
  if (exit_code === -1) {
    return {
      passed: false,
      detail: `${params.argv[0]} failed to spawn`,
    };
  }
  if (params.exit_codes_ok.includes(exit_code)) {
    return { passed: true, detail: `${params.argv[0]} exit ${exit_code}` };
  }
  return {
    passed: false,
    detail: `${params.argv[0]} exit ${exit_code} (not in [${params.exit_codes_ok.join(', ')}])`,
  };
};

export const execOkChecker: CheckerKindModule<ExecOkParams> = {
  validate,
  check,
};
