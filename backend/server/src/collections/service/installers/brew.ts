/** D-118 Phase 3 — `brew` installer kind.
 *
 *  macOS Homebrew, user-scope (no sudo). Symmetric install /
 *  upgrade / uninstall mapping to the corresponding `brew` argv.
 */

import { defaultSpawn } from './process.js';
import { ownSafe } from '../key-safety.js';
import {
  InstallerParamError,
  type InstallerContext,
  type InstallerKindModule,
  type InstallerOutcome,
} from './types.js';

export interface BrewParams {
  /** Homebrew package name. */
  package: string;
}

export const validateBrewParams = (raw: unknown): BrewParams => {
  if (raw === null || typeof raw !== 'object') {
    throw new InstallerParamError('brew', 'params must be an object');
  }
  const params = raw as Record<string, unknown>;
  const pkg = ownSafe(params, 'package');
  if (typeof pkg !== 'string' || pkg === '') {
    throw new InstallerParamError('brew', 'package required (string)');
  }
  return { package: pkg };
};

const run = (
  argv: string[],
  ctx: InstallerContext,
): Promise<InstallerOutcome> => (ctx.spawn ?? defaultSpawn)(argv);

export const brewInstaller: InstallerKindModule<BrewParams> = {
  install: ({ package: pkg }, ctx) => run(['brew', 'install', pkg], ctx),
  upgrade: ({ package: pkg }, ctx) => run(['brew', 'upgrade', pkg], ctx),
  uninstall: ({ package: pkg }, ctx) => run(['brew', 'uninstall', pkg], ctx),
};
