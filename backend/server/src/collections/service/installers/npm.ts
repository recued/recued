/** D-118 Phase 3 — `npm` installer kind.
 *
 *  npm global install (`-g`) with `NPM_CONFIG_PREFIX` redirected to
 *  `<dataPath>/npm-prefix/` so the install never requires sudo on
 *  default-prefix setups. Per spec line 440.
 *
 *  Upgrade target syntax: `<package>@<version>` — the `target`
 *  field on the manifest's `upgrade[]` entry feeds this. When
 *  absent, upgrade is a no-op-equivalent re-install of the
 *  current pin.
 */

import { join } from 'node:path';

import { defaultSpawn } from './process.js';
import { ownSafe } from '../key-safety.js';
import {
  InstallerParamError,
  type InstallerContext,
  type InstallerKindModule,
  type InstallerOutcome,
} from './types.js';

export interface NpmParams {
  package: string;
  /** Manifest carries `global: true` to make explicit that this
   *  installer never does local node_modules installs. Validated
   *  for shape but kept on the params for audit visibility. */
  global?: true;
  /** Optional pin for upgrade — `<package>@<version>`. */
  target?: string;
}

export const validateNpmParams = (raw: unknown): NpmParams => {
  if (raw === null || typeof raw !== 'object') {
    throw new InstallerParamError('npm', 'params must be an object');
  }
  const params = raw as Record<string, unknown>;
  const pkg = ownSafe(params, 'package');
  const global = ownSafe(params, 'global');
  const target = ownSafe(params, 'target');
  if (typeof pkg !== 'string' || pkg === '') {
    throw new InstallerParamError('npm', 'package required (string)');
  }
  if (global !== undefined && global !== true) {
    throw new InstallerParamError('npm', 'global must be true when present');
  }
  if (
    target !== undefined &&
    (typeof target !== 'string' || target === '')
  ) {
    throw new InstallerParamError('npm', 'target must be a non-empty string when present');
  }
  return {
    package: pkg,
    ...(global === true ? { global: true as const } : {}),
    ...(typeof target === 'string' ? { target } : {}),
  };
};

const npmEnv = (ctx: InstallerContext): Record<string, string> => ({
  NPM_CONFIG_PREFIX: join(ctx.dataPath, 'npm-prefix'),
});

const run = (
  argv: string[],
  ctx: InstallerContext,
): Promise<InstallerOutcome> =>
  (ctx.spawn ?? defaultSpawn)(argv, { env: npmEnv(ctx) });

export const npmInstaller: InstallerKindModule<NpmParams> = {
  install: ({ package: pkg }, ctx) => run(['npm', 'install', '-g', pkg], ctx),
  upgrade: ({ package: pkg, target }, ctx) => {
    const spec = target ? `${pkg}@${target}` : pkg;
    return run(['npm', 'install', '-g', spec], ctx);
  },
  uninstall: ({ package: pkg }, ctx) => run(['npm', 'uninstall', '-g', pkg], ctx),
};
