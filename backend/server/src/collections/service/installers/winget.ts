/** D-118 Phase 3 — `winget` installer kind.
 *
 *  Windows Package Manager. `--scope user` keeps the install in
 *  the user profile (no admin elevation prompt).
 */

import { defaultSpawn } from './process.js';
import { ownSafe } from '../key-safety.js';
import {
  InstallerParamError,
  type InstallerContext,
  type InstallerKindModule,
  type InstallerOutcome,
} from './types.js';

export interface WingetParams {
  package: string;
}

export const validateWingetParams = (raw: unknown): WingetParams => {
  if (raw === null || typeof raw !== 'object') {
    throw new InstallerParamError('winget', 'params must be an object');
  }
  const params = raw as Record<string, unknown>;
  const pkg = ownSafe(params, 'package');
  if (typeof pkg !== 'string' || pkg === '') {
    throw new InstallerParamError('winget', 'package required (string)');
  }
  return { package: pkg };
};

const run = (
  argv: string[],
  ctx: InstallerContext,
): Promise<InstallerOutcome> => (ctx.spawn ?? defaultSpawn)(argv);

export const wingetInstaller: InstallerKindModule<WingetParams> = {
  install: ({ package: pkg }, ctx) =>
    run(['winget', 'install', pkg, '--scope', 'user'], ctx),
  upgrade: ({ package: pkg }, ctx) => run(['winget', 'upgrade', pkg], ctx),
  uninstall: ({ package: pkg }, ctx) => run(['winget', 'uninstall', pkg], ctx),
};
