/** D-118 Phase 3 — `pip` installer kind.
 *
 *  pip user-site install (`--user`). The `user: true` field on the
 *  manifest is mandatory and asserted — the registry never installs
 *  to system site-packages (would require sudo).
 */

import { defaultSpawn } from './process.js';
import { ownSafe } from '../key-safety.js';
import {
  InstallerParamError,
  type InstallerContext,
  type InstallerKindModule,
  type InstallerOutcome,
} from './types.js';

export interface PipParams {
  package: string;
  /** Always `true` — system-wide installs need sudo and aren't
   *  in scope for D-118. Validated to surface the explicit
   *  acknowledgement on every manifest. */
  user: true;
}

export const validatePipParams = (raw: unknown): PipParams => {
  if (raw === null || typeof raw !== 'object') {
    throw new InstallerParamError('pip', 'params must be an object');
  }
  const params = raw as Record<string, unknown>;
  const pkg = ownSafe(params, 'package');
  const user = ownSafe(params, 'user');
  if (typeof pkg !== 'string' || pkg === '') {
    throw new InstallerParamError('pip', 'package required (string)');
  }
  if (user !== true) {
    throw new InstallerParamError('pip', 'user: true required');
  }
  return { package: pkg, user: true };
};

const run = (
  argv: string[],
  ctx: InstallerContext,
): Promise<InstallerOutcome> => (ctx.spawn ?? defaultSpawn)(argv);

export const pipInstaller: InstallerKindModule<PipParams> = {
  install: ({ package: pkg }, ctx) =>
    run(['pip', 'install', '--user', pkg], ctx),
  upgrade: ({ package: pkg }, ctx) =>
    run(['pip', 'install', '--user', '--upgrade', pkg], ctx),
  // pip uninstall is non-interactive with -y; the manifest never
  // declares interactive mode for any installer.
  uninstall: ({ package: pkg }, ctx) =>
    run(['pip', 'uninstall', '-y', pkg], ctx),
};
