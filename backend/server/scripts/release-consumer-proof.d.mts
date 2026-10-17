import type { ReleaseManifest } from '@recued/release';

export declare const CONSUMER_PROOF_SKIP_FLAG: string;
export declare const CONSUMER_PROOF_ENV: string;
export declare const CONSUMER_PROOF_ORIGIN: string;
export declare const LIVE_INSTALLER_URL: string;
export declare const CONSUMER_PROOF_CHANNEL: string;
export declare const PREVIOUS_RELEASE_SEARCH_DEPTH: number;
export declare const UPDATE_DRIVE_SPEC: string;
export declare const UPDATE_DRIVE_CONFIG: string;
export declare const SEED_SCRIPT: string;
export declare const WEBCLIENT_INSTALL_STAMP: string;

export declare class ConsumerProofError extends Error {
  constructor(message: string, options?: { scratchDir?: string | null });
  /** The folder holding the failed leg's logs, kept for the operator. */
  scratchDir: string | null;
}

export declare const consumerProofSetting: (options?: {
  args?: readonly string[];
  env?: Record<string, string | undefined>;
}) => { skip: false } | { skip: true; reason: string };

export declare const consumerEnv: (
  base: Record<string, string | undefined>,
  set?: Record<string, string>,
) => Record<string, string>;

export type ConsumerProofFetchBytes = (
  url: string,
) => Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string }>;

export interface ConsumerProofRunResult {
  status: number | null;
  signal?: string | null;
  error?: Error;
  timedOut: boolean;
  /** The last few KB of combined output. */
  tail: string;
}

export interface ConsumerProofRunRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  logPath: string;
  timeoutMs: number;
  echo?: ((line: string) => void) | null;
}

/** Everything the legs do to the outside world. */
export interface ConsumerProofIo {
  fetchBytes: ConsumerProofFetchBytes;
  download: (
    url: string,
    destination: string,
    options?: { timeoutSeconds?: number },
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  run: (request: ConsumerProofRunRequest) => Promise<ConsumerProofRunResult>;
  version: (exe: string) => Promise<string>;
  processRunningFrom: (path: string) => Promise<boolean>;
}

export declare const runLogged: ConsumerProofIo['run'];
export declare const curlFetchBytes: (
  url: string,
  options?: { timeoutSeconds?: number },
) => ReturnType<ConsumerProofFetchBytes>;
export declare const curlDownload: ConsumerProofIo['download'];
export declare const realConsumerProofIo: ConsumerProofIo;

export interface PreviousRelease {
  version: string;
  sequence: number;
  binary: { url: string; sha256: string };
  addon: { url: string; sha256: string };
}

export declare const findPreviousRelease: (options: {
  origin: string;
  sequence: number;
  channel: string;
  version: string;
  triple: string;
  pubkey: string;
  fetchBytes?: ConsumerProofFetchBytes;
  depth?: number;
}) => Promise<PreviousRelease | null>;

export interface ConsumerProofPlan {
  version: string;
  sequence: number;
  channel: string;
  triple: string;
  installerUrl: string;
  binary: { sha256: string };
  addon: { sha256: string };
  /** The candidate's web app bundle: its file name in the release directory. */
  webclient: { file: string; sha256: string } | null;
  /** Null only for the first release on the channel. */
  previous: PreviousRelease | null;
}

export declare const planConsumerProof: (options: {
  /** The candidate, as `parseManifest` returns it. */
  manifest: ReleaseManifest;
  version: string;
  origin: string;
  prefix: string;
  pubkey: string;
  trustedPubkey: string;
  repoRoot: string;
  platform?: string;
  arch?: string;
  fetchBytes?: ConsumerProofFetchBytes;
  hasPlaywright?: (repoRoot: string) => boolean;
}) => Promise<ConsumerProofPlan>;

export declare const describeConsumerProofPlan: (plan: ConsumerProofPlan) => string;

export declare const checkWebclientTree: (options: {
  installedDir: string;
  bundle: { files?: Array<{ path: string; sha256: string }> };
  version: string;
}) => string[];

export declare const checkInstalledRelease: (options: {
  prefix: string;
  plan: ConsumerProofPlan;
  bundlePath: string | null;
  readVersion: (exe: string) => Promise<string>;
}) => Promise<string[]>;

export declare const hostFingerprint: (options?: { home?: string }) => string[];
export declare const diffFingerprints: (before: string[], after: string[]) => string[];

export declare const driveReportVerdict: (
  text: string | null | undefined,
) => { ok: boolean; passed?: number; summary: string };

export declare const runConsumerProof: (options: {
  plan: ConsumerProofPlan;
  out: string;
  repoRoot: string;
  env?: Record<string, string | undefined>;
  home?: string;
  io?: ConsumerProofIo;
  log?: (message: string) => void;
  scratchRoot?: string;
}) => Promise<{ summary: string }>;
