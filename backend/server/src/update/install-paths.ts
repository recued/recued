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
 *  on the data volume the launcher verify-and-execs. */
export const resolveUpdateBinaryPath = (env: NodeJS.ProcessEnv): string =>
  resolveDistributionChannel(env) === 'docker-thin'
    ? join(env.RECUED_BIN_DIR ?? '/data/bin', 'recued')
    : process.execPath;
