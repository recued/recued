/** D-118 Phase 3 — installer registry public surface. */

export {
  DownloadShaMismatchError,
  InstallerParamError,
  runInstaller,
  type InstallerAction,
  type InstallerContext,
  type InstallerOutcome,
} from './dispatcher.js';
export { defaultSpawn } from './process.js';
export type { SpawnFn, SpawnOptions, SpawnResult } from './types.js';
