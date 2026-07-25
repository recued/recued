/** D-118 Phase 3 — `go_install` installer kind.
 *
 *  `go install <pkg>@<version>` lays the binary in `$GOPATH/bin/`.
 *  `binary_name` on the manifest is required because go install
 *  doesn't surface the resulting binary name (it derives from the
 *  package's `cmd/...` directory). Uninstall removes the binary
 *  by name from `$GOPATH/bin/` via `rm`.
 */

import { defaultSpawn } from './process.js';
import { ownSafe } from '../key-safety.js';
import {
  InstallerParamError,
  type InstallerContext,
  type InstallerKindModule,
  type InstallerOutcome,
} from './types.js';

export interface GoInstallParams {
  /** Go module path, e.g. `github.com/cli/cli/v2/cmd/gh`. */
  package: string;
  /** Version pin for install. Optional; defaults to `latest`. */
  version?: string;
  /** Resulting binary name for uninstall. Required because go
   *  install doesn't print it. */
  binary_name: string;
  /** Upgrade target — overrides `version` when set. */
  target?: string;
}

export const validateGoInstallParams = (raw: unknown): GoInstallParams => {
  if (raw === null || typeof raw !== 'object') {
    throw new InstallerParamError('go_install', 'params must be an object');
  }
  const params = raw as Record<string, unknown>;
  const pkg = ownSafe(params, 'package');
  const binaryName = ownSafe(params, 'binary_name');
  const version = ownSafe(params, 'version');
  const target = ownSafe(params, 'target');
  if (typeof pkg !== 'string' || pkg === '') {
    throw new InstallerParamError('go_install', 'package required (string)');
  }
  if (
    typeof binaryName !== 'string' ||
    binaryName === ''
  ) {
    throw new InstallerParamError(
      'go_install',
      'binary_name required (string) — go install does not surface the resulting binary name',
    );
  }
  if (
    version !== undefined &&
    typeof version !== 'string'
  ) {
    throw new InstallerParamError('go_install', 'version must be a string when present');
  }
  if (
    target !== undefined &&
    typeof target !== 'string'
  ) {
    throw new InstallerParamError('go_install', 'target must be a string when present');
  }
  return {
    package: pkg,
    binary_name: binaryName,
    ...(typeof version === 'string' ? { version } : {}),
    ...(typeof target === 'string' ? { target } : {}),
  };
};

/** `$GOPATH` resolves through the user env at spawn time; absent
 *  GOPATH defaults to `~/go` per Go's own convention, which we
 *  encode here for the uninstall path. The install/upgrade paths
 *  delegate to the `go` binary itself. */
const gopathBin = (ctx: InstallerContext): string => {
  const gopath = process.env.GOPATH ?? `${process.env.HOME ?? ctx.dataPath}/go`;
  return `${gopath}/bin`;
};

export const goInstaller: InstallerKindModule<GoInstallParams> = {
  install: async ({ package: pkg, version }, ctx) => {
    const spec = version ? `${pkg}@${version}` : `${pkg}@latest`;
    return (ctx.spawn ?? defaultSpawn)(['go', 'install', spec]);
  },
  upgrade: async ({ package: pkg, target, version }, ctx) => {
    const ver = target ?? version ?? 'latest';
    return (ctx.spawn ?? defaultSpawn)(['go', 'install', `${pkg}@${ver}`]);
  },
  uninstall: async ({ binary_name }, ctx) => {
    // No interactive prompts; rm exits 0 on success, 1 on missing
    // file. Uninstall against an already-removed binary returns
    // exit_code: 1 — caller decides whether that counts as success.
    const target = `${gopathBin(ctx)}/${binary_name}`;
    return (ctx.spawn ?? defaultSpawn)(['rm', '-f', target]);
  },
};
