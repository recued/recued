/** D-118 Phase 4 — `binary_in_path` checker.
 *
 *  Semantics (spec line 482): `which <binary>` returns exit 0.
 *  We resolve by scanning `process.env.PATH` ourselves rather
 *  than spawning `which`/`where` — portable, doesn't depend on
 *  the tool being installed, and lets tests mock the probe via
 *  a single `whichBinary` seam.
 */
import type { ServiceCheckResult } from '@recued/contracts';

import {
  CheckerParamError,
  type CheckerContext,
  type CheckerKindModule,
} from './types.js';
import { withDefaults } from './process.js';

export interface BinaryInPathParams {
  binary: string;
}

const validate = (raw: unknown): BinaryInPathParams => {
  if (raw === null || typeof raw !== 'object') {
    throw new CheckerParamError('binary_in_path', 'params must be an object');
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.binary !== 'string' || p.binary === '') {
    throw new CheckerParamError('binary_in_path', 'binary required (string)');
  }
  return { binary: p.binary };
};

const check = async (
  params: BinaryInPathParams,
  ctx: CheckerContext,
): Promise<ServiceCheckResult> => {
  const io = withDefaults(ctx);
  const found = await io.whichBinary(params.binary);
  return found
    ? { passed: true, detail: `${params.binary} found on PATH` }
    : { passed: false, detail: `${params.binary} not found on PATH` };
};

export const binaryInPathChecker: CheckerKindModule<BinaryInPathParams> = {
  validate,
  check,
};
