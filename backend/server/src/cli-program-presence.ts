/** D-346 A — whether the program a cli catalog launches is on this server, read
 *  as its launch would read it, and never run (D-321 decision 6).
 *
 *  The launch (`cli-invocation-executor.ts`) starts the location the owner set for
 *  the program while it names that program (`cli-owner-location.ts`), else the
 *  file the shared resolver finds for its name over the PATH an action gets
 *  (`envForOthers`). This answers with the same two reads, so a run refused here
 *  is one whose launch would have failed `not_found`, and one let through is one
 *  whose launch finds a file.
 *
 *  ⚠ A file that is there but would not start (a script whose interpreter is
 *  missing) counts as there: that is the step's to report, as `broken`, with
 *  what to do about it. Only a program that is gone refuses a run up front. */

import { createCliBinaryPathResolver } from './cli-binary-reachability.js';
import { ownerLocationFor } from './cli-owner-location.js';
import { envForOthers } from './supervision/env-for-others.js';

/** True when the program `binary`, launched by catalog `catalog`, is there. */
export type ProgramPresence = (catalog: string, binary: string) => boolean;

export interface ProgramPresenceOptions {
  /** The owner's location row for a catalog's program (`OWNER_TOOL_PATH_SCOPE`).
   *  Absent: the PATH lookup alone. */
  readOwnerToolPath?: (ingredientId: string) => unknown;
  /** Default: the shared resolver over the PATH an action gets, read per call. */
  resolveBinary?: (target: string) => string | undefined;
  /** Default: `process.platform`. */
  platform?: NodeJS.Platform;
}

/** PATH as an action's child sees it; Windows variable names are
 *  case-insensitive (the launch reads it the same way). */
const pathOf = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string => {
  if (platform !== 'win32') return env.PATH ?? '';
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return key === undefined ? '' : (env[key] ?? '');
};

export const createProgramPresence = (options: ProgramPresenceOptions = {}): ProgramPresence => {
  const platform = options.platform ?? process.platform;
  const resolve = options.resolveBinary
    ?? ((target: string) => createCliBinaryPathResolver({ path: pathOf(envForOthers(), platform), platform })(target));
  return (catalog, binary) => {
    const set = ownerLocationFor(options.readOwnerToolPath, catalog, binary, platform);
    return resolve(set ?? binary) !== undefined;
  };
};
