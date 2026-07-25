/** D-118 Phase 4 — `file_exists` checker.
 *
 *  Semantics (spec line 483): `fs.stat(path)` succeeds. Checks
 *  existence only — readability, executability, size, type
 *  (file vs dir) are out of scope. Templates that care about
 *  "binary is executable" use `exec_ok` with a `--version`
 *  invocation instead.
 */
import type { ServiceCheckResult } from '@recued/contracts';

import {
  CheckerParamError,
  type CheckerContext,
  type CheckerKindModule,
} from './types.js';
import { withDefaults } from './process.js';

export interface FileExistsParams {
  path: string;
}

const validate = (raw: unknown): FileExistsParams => {
  if (raw === null || typeof raw !== 'object') {
    throw new CheckerParamError('file_exists', 'params must be an object');
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.path !== 'string' || p.path === '') {
    throw new CheckerParamError('file_exists', 'path required (string)');
  }
  return { path: p.path };
};

const check = async (
  params: FileExistsParams,
  ctx: CheckerContext,
): Promise<ServiceCheckResult> => {
  const io = withDefaults(ctx);
  const ok = await io.stat(params.path);
  return ok
    ? { passed: true, detail: `${params.path} exists` }
    : { passed: false, detail: `${params.path} not found` };
};

export const fileExistsChecker: CheckerKindModule<FileExistsParams> = {
  validate,
  check,
};
