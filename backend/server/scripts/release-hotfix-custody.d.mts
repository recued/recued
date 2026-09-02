import type { SpawnSyncReturns, SpawnSyncOptionsWithBufferEncoding, SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

type Spawn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding | SpawnSyncOptionsWithBufferEncoding,
) => SpawnSyncReturns<string> | SpawnSyncReturns<Buffer>;

export declare const RECOVERY_INSTALLER_NAMES: readonly string[];

export declare const recoveryInstallerPath: (repoRoot: string, name: string) => string;

export declare const assertTaggedBaseComparator: (input: {
  version: string;
  repoRoot: string;
  fail: (message: string) => void;
  spawn?: Spawn;
  tsxCommand?: string;
  tsxArgsPrefix?: string[];
}) => void;

export declare const assertLiveInstallerParity: (input: {
  version: string;
  repoRoot: string;
  fail: (message: string) => void;
  spawn?: Spawn;
  baseUrl?: string;
}) => void;
