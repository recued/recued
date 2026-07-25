/** D-118 Phase 3 — installer dispatcher.
 *
 *  `runInstaller(kind, action, params, ctx)` is the only public
 *  entry point for the installer registry. The dispatcher:
 *
 *    1. Refuses unknown kinds (closed registry — every legal kind
 *       lives in `SERVICE_INSTALL_KINDS` per Phase 1 contracts).
 *    2. Validates params against the per-kind schema. Manifest
 *       authoring errors fail loud with `InstallerParamError`.
 *    3. Calls the right action handler.
 *    4. Returns the uniform `InstallerOutcome`.
 *
 *  All eight spawn-based kinds reuse `defaultSpawn` from
 *  `process.ts`; the `download` kind has its own fetch + verify
 *  + atomic-replace path. Tests inject `ctx.spawn` / `ctx.fetch`
 *  to assert argv + IO without launching real subprocesses.
 *
 *  This module is the boundary between "installer code" and the
 *  Phase 7 enroll rpc handlers. Audit emission happens at the
 *  caller — installers stay focused on doing the work + returning
 *  the outcome.
 */

import {
  SERVICE_INSTALL_KINDS,
  type ServiceInstallKind,
} from '@recued/contracts';

import { brewInstaller, validateBrewParams } from './brew.js';
import { cargoInstaller, validateCargoParams } from './cargo.js';
import {
  dockerPullInstaller,
  validateDockerPullParams,
} from './docker-pull.js';
import { downloadInstaller, validateDownloadParams } from './download.js';
import { goInstaller, validateGoInstallParams } from './go-install.js';
import { npmInstaller, validateNpmParams } from './npm.js';
import { pipInstaller, validatePipParams } from './pip.js';
import { scoopInstaller, validateScoopParams } from './scoop.js';
import { wingetInstaller, validateWingetParams } from './winget.js';
import {
  InstallerParamError,
  type InstallerAction,
  type InstallerContext,
  type InstallerOutcome,
} from './types.js';

/** Polymorphic registry entry — each kind has its own params shape
 *  but the dispatcher routes them uniformly. The validator + module
 *  always agree on the params shape per kind; outside the registry,
 *  callers see the unified `runInstaller(kind, action, raw, ctx)`
 *  signature. The internal `unknown` type in the entry shape just
 *  defers the per-kind narrowing to the validator. */
interface RegistryEntry {
  module: {
    install: (params: never, ctx: InstallerContext) => Promise<InstallerOutcome>;
    upgrade: (params: never, ctx: InstallerContext) => Promise<InstallerOutcome>;
    uninstall: (params: never, ctx: InstallerContext) => Promise<InstallerOutcome>;
  };
  validate: (raw: unknown) => unknown;
}

/** Registry — closed map from kind to module. New kinds: append
 *  here AND to `SERVICE_INSTALL_KINDS` in contracts. The `satisfies`
 *  clause keeps the two in sync (every kind in the contract enum
 *  must have a registry entry). */
const REGISTRY = {
  brew: { module: brewInstaller, validate: validateBrewParams },
  scoop: { module: scoopInstaller, validate: validateScoopParams },
  winget: { module: wingetInstaller, validate: validateWingetParams },
  npm: { module: npmInstaller, validate: validateNpmParams },
  pip: { module: pipInstaller, validate: validatePipParams },
  cargo: { module: cargoInstaller, validate: validateCargoParams },
  go_install: { module: goInstaller, validate: validateGoInstallParams },
  docker_pull: { module: dockerPullInstaller, validate: validateDockerPullParams },
  download: { module: downloadInstaller, validate: validateDownloadParams },
} satisfies Record<ServiceInstallKind, RegistryEntry>;

const isKnownKind = (kind: string): kind is ServiceInstallKind =>
  (SERVICE_INSTALL_KINDS as readonly string[]).includes(kind);

/** Public entry point. Closed registry — unknown kinds throw
 *  `InstallerParamError` rather than silently no-op-ing. */
export const runInstaller = async (
  kind: string,
  action: InstallerAction,
  rawParams: unknown,
  ctx: InstallerContext,
): Promise<InstallerOutcome> => {
  if (!isKnownKind(kind)) {
    throw new InstallerParamError(
      kind as ServiceInstallKind,
      `unknown install kind — must be one of ${SERVICE_INSTALL_KINDS.join(', ')}`,
    );
  }
  const entry = REGISTRY[kind];
  const params = entry.validate(rawParams);
  // Type punning is safe because the validate fn returns the
  // params shape the module expects.
  const handler = entry.module[action] as (
    p: unknown,
    c: InstallerContext,
  ) => Promise<InstallerOutcome>;
  return handler(params, ctx);
};

export type { InstallerAction, InstallerContext, InstallerOutcome } from './types.js';
export {
  DownloadShaMismatchError,
  InstallerParamError,
} from './types.js';
