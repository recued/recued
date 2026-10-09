/** Where this install's binary and its channel live — pure env + path logic.
 *
 *  ⛔ A LEAF ON PURPOSE. These two lived in `release-config.ts`, which imports
 *  `open-database.ts`, which imports the native SQLite addon AT MODULE INIT. So
 *  anything that needed a binary path also loaded the addon — and the one caller
 *  that most needs these paths is the recovery for an install whose addon is
 *  MISSING. It could not have asked without dying on the question.
 *
 *  ⚠ `release-config` re-exports both, so every existing importer is unchanged
 *  and there is still one definition. */
import type { DistributionChannel } from './update-mode-store.js';
import { join } from 'node:path';
import { updateLeasePathFor } from './update-lease.js';

/** The distribution channel, defaulting to `binary` when unset — no production
 *  package stamps the variable, so the default is what most installs resolve. */
export const resolveDistributionChannel = (env: NodeJS.ProcessEnv): DistributionChannel => {
  switch (env.RECUED_DISTRIBUTION_CHANNEL) {
    case 'docker-baked': return 'docker-baked';
    case 'docker-thin': return 'docker-thin';
    case 'source': return 'source';
    default: return 'binary';
  }
};

/** The binary an update would swap.
 *
 *  On `docker-thin` the server runs UNDER the launcher (the seed shim execs
 *  `node …/bin.js`), so `process.execPath` is the Node runtime and NOT the binary
 *  on the data volume the launcher verify-and-execs.
 *
 *  ⚠ ON EVERY OTHER CHANNEL THIS ANSWERS `process.execPath`, WHICH IS ONLY THE
 *  SERVER WHEN THE SERVER IS THE EXECUTABLE. Under `node …/bin.js` it is the
 *  NODE RUNTIME — `/usr/local/bin/node` in the images. That is correct for a
 *  packaged binary and meaningless for a delegated channel, so callers that turn
 *  this into a writable path must first ask `SELF_APPLY_CHANNELS`. */
export const resolveUpdateBinaryPath = (env: NodeJS.ProcessEnv): string =>
  resolveDistributionChannel(env) === 'docker-thin'
    ? join(env.RECUED_BIN_DIR ?? '/data/bin', 'recued')
    : process.execPath;

/** Channels whose binary lives on a writable volume and self-applies (I-8):
 *  `binary` (GA host binary) + `docker-thin` (the `:managed` self-updating
 *  image with the binary on the data volume). `docker-baked` (immutable image —
 *  the host re-pulls) and `source` (notify-only) DON'T self-apply a binary, so
 *  `update.apply` returns `not-applicable` there.
 *
 *  ⛔ LIVES HERE, NOT IN `release-config.ts`, FOR THE REASON AT THE TOP OF THIS
 *  FILE. `bin.ts` must consult it BEFORE the module graph that loads the native
 *  addon — the early-boot swap reconcile is the one caller that runs when the
 *  addon is missing, and importing `release-config` to ask would drag
 *  `open-database` in and die on the question. `release-config` re-exports it,
 *  so every existing importer is unchanged and there is still one definition. */
export const SELF_APPLY_CHANNELS: ReadonlySet<DistributionChannel> =
  new Set<DistributionChannel>(['binary', 'docker-thin']);

/** Where THIS install's update lease lives — or `null` when the process runs no
 *  executable of its own to key one on.
 *
 *  ⛔ THE `binary` CHANNEL RUN UNPACKAGED. `binary` is the default, so a source
 *  checkout, an npm install and the Homebrew formula (which wraps the npm package)
 *  resolve it while `process.execPath` is the OWNER'S NODE, and the lease lands
 *  beside their Node. Under a system Node that folder is root's: the boot's claim
 *  threw EACCES and the server died before its banner, the crash the baked image
 *  had before it declared its channel (`Dockerfile`). And every unpackaged install
 *  on one Node shared the file, so one install's lease stopped another from
 *  starting ("an update is in progress", exit 4). Nothing updates such an install
 *  in place — the apply builder (`release-config.ts`) and the CLI verbs
 *  (`cli-context/update.ts`) refuse it before they derive a path — so there is no
 *  update to exclude, and no lease.
 *
 *  `isPackagedBinary` is `runningAsPackagedBinary` in production; only `node:sea`
 *  can answer it (`packaged-binary.ts`), and passing it in keeps this file pure.
 *
 *  Every other case is `updateLeasePathFor(resolveUpdateBinaryPath(env))`, the
 *  derivation the CLI verbs use, so the server and a CLI still meet at one file. */
export const updateLeasePathForInstall = (
  env: NodeJS.ProcessEnv,
  isPackagedBinary: () => boolean,
): string | null =>
  resolveDistributionChannel(env) === 'binary' && !isPackagedBinary()
    ? null
    : updateLeasePathFor(resolveUpdateBinaryPath(env));
