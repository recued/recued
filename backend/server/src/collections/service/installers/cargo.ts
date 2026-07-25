/** D-118 Phase 3 — `cargo` installer kind.
 *
 *  Rust cargo install. Upgrade uses `--force` because cargo's
 *  default behavior is to refuse re-installing an existing crate.
 */

import { defaultSpawn } from './process.js';
import { ownSafe } from '../key-safety.js';
import {
  InstallerParamError,
  type InstallerContext,
  type InstallerKindModule,
  type InstallerOutcome,
} from './types.js';

export interface CargoParams {
  package: string;
}

export const validateCargoParams = (raw: unknown): CargoParams => {
  if (raw === null || typeof raw !== 'object') {
    throw new InstallerParamError('cargo', 'params must be an object');
  }
  const params = raw as Record<string, unknown>;
  const pkg = ownSafe(params, 'package');
  if (typeof pkg !== 'string' || pkg === '') {
    throw new InstallerParamError('cargo', 'package required (string)');
  }
  return { package: pkg };
};

const run = (
  argv: string[],
  ctx: InstallerContext,
): Promise<InstallerOutcome> => (ctx.spawn ?? defaultSpawn)(argv);

export const cargoInstaller: InstallerKindModule<CargoParams> = {
  install: ({ package: pkg }, ctx) => run(['cargo', 'install', pkg], ctx),
  upgrade: ({ package: pkg }, ctx) =>
    run(['cargo', 'install', '--force', pkg], ctx),
  uninstall: ({ package: pkg }, ctx) =>
    run(['cargo', 'uninstall', pkg], ctx),
};
