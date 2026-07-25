/** D-118 Phase 3 — `scoop` installer kind.
 *
 *  Windows Scoop, user-scope. Note that scoop's "upgrade" verb is
 *  `update` (the only kind in the registry where install ≠ upgrade
 *  by name).
 */

import { defaultSpawn } from './process.js';
import { ownSafe } from '../key-safety.js';
import {
  InstallerParamError,
  type InstallerContext,
  type InstallerKindModule,
  type InstallerOutcome,
} from './types.js';

export interface ScoopParams {
  package: string;
}

export const validateScoopParams = (raw: unknown): ScoopParams => {
  if (raw === null || typeof raw !== 'object') {
    throw new InstallerParamError('scoop', 'params must be an object');
  }
  const params = raw as Record<string, unknown>;
  const pkg = ownSafe(params, 'package');
  if (typeof pkg !== 'string' || pkg === '') {
    throw new InstallerParamError('scoop', 'package required (string)');
  }
  return { package: pkg };
};

const run = (
  argv: string[],
  ctx: InstallerContext,
): Promise<InstallerOutcome> => (ctx.spawn ?? defaultSpawn)(argv);

export const scoopInstaller: InstallerKindModule<ScoopParams> = {
  install: ({ package: pkg }, ctx) => run(['scoop', 'install', pkg], ctx),
  upgrade: ({ package: pkg }, ctx) => run(['scoop', 'update', pkg], ctx),
  uninstall: ({ package: pkg }, ctx) => run(['scoop', 'uninstall', pkg], ctx),
};
