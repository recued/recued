/** D-118 Phase 4 — `pid_file` checker.
 *
 *  Semantics (spec line 486): file exists + contains integer pid +
 *  `kill(pid, 0)` succeeds. Three things must all hold for
 *  `passed: true`; any failure surfaces a specific `detail` so
 *  the operator can tell a stale pidfile (file exists, process
 *  gone) from a missing pidfile (file never written).
 */
import type { ServiceCheckResult } from '@recued/contracts';

import {
  CheckerParamError,
  type CheckerContext,
  type CheckerKindModule,
} from './types.js';
import { withDefaults } from './process.js';

export interface PidFileParams {
  path: string;
}

const validate = (raw: unknown): PidFileParams => {
  if (raw === null || typeof raw !== 'object') {
    throw new CheckerParamError('pid_file', 'params must be an object');
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.path !== 'string' || p.path === '') {
    throw new CheckerParamError('pid_file', 'path required (string)');
  }
  return { path: p.path };
};

const check = async (
  params: PidFileParams,
  ctx: CheckerContext,
): Promise<ServiceCheckResult> => {
  const io = withDefaults(ctx);
  if (!(await io.stat(params.path))) {
    return { passed: false, detail: `${params.path} not found` };
  }
  let text;
  try {
    text = await io.readText(params.path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { passed: false, detail: `${params.path} unreadable: ${msg}` };
  }
  const trimmed = text.trim();
  const pid = Number(trimmed);
  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      passed: false,
      detail: `${params.path} does not contain a positive integer pid`,
    };
  }
  if (!io.kill0(pid)) {
    return { passed: false, detail: `pid ${pid} is not alive (stale pidfile)` };
  }
  return { passed: true, detail: `pid ${pid} alive` };
};

export const pidFileChecker: CheckerKindModule<PidFileParams> = {
  validate,
  check,
};
