export interface PublicProofTarget {
  label: string;
  url: string;
  /** The local candidate file the response must equal byte for byte. */
  file: string;
  /** `get`: download and compare every byte. `head`: exact Content-Length and an
   *  ETag equal to the file's MD5, downloading only when the ETag proves nothing. */
  method: 'get' | 'head';
  headers: string[];
  timeoutSeconds: number;
  /** A HEAD target's bound for the download it falls back to. */
  fallbackTimeoutSeconds?: number;
}

export interface PublicProofExpectation extends PublicProofTarget {
  expectedSize: number;
  expectedSha256: string;
  /** Required for a `head` target. */
  expectedMd5?: string;
}

export interface PublicProofHeadResult {
  /** The fetcher's exit status; 0 means a response was received. */
  status: number | null;
  httpCode: string;
  contentLength: number | null;
  etag: string | null;
  detail: string;
}

export type PublicProofHead = (request: {
  url: string;
  timeoutSeconds: number;
  headers: string[];
}) => PublicProofHeadResult | Promise<PublicProofHeadResult>;

export interface PublicProofFetchResult {
  /** The fetcher's exit status; 0 means a response was received. */
  status: number | null;
  httpCode: string;
  detail: string;
}

export type PublicProofFetch = (request: {
  url: string;
  destination: string;
  maxBytes: number;
  timeoutSeconds: number;
  headers: string[];
}) => PublicProofFetchResult | Promise<PublicProofFetchResult>;

export declare const PUBLIC_PROOF_MANIFEST: string;
export declare const PUBLIC_PROOF_MANIFEST_SIG: string;
export declare const PUBLIC_PROOF_METADATA_TIMEOUT_SECONDS: number;
export declare const PUBLIC_PROOF_ARTIFACT_TIMEOUT_SECONDS: number;

export declare const publicProofSettings: (
  env?: Record<string, string | undefined>,
) => { attempts: number; delayMs: number };

export declare const publicProofTargets: (input: {
  origin: string;
  /** `channel` is null for the flat legacy path. */
  manifestPaths: { channel: string | null; keyPrefix: string }[];
  artifacts: { basename: string; url: string }[];
  serverUserAgent: string;
  installerUserAgent: (channel: string) => string;
}) => PublicProofTarget[];

export declare const sha256OfFile: (path: string) => string;
export declare const md5OfFile: (path: string) => string;
export declare const etagMd5: (etag: string | null | undefined) => string | null;
export declare const curlFetchExact: (
  request: Parameters<PublicProofFetch>[0],
) => Promise<PublicProofFetchResult>;
export declare const curlHeadExact: (
  request: Parameters<PublicProofHead>[0],
) => Promise<PublicProofHeadResult>;
export declare const mapWithConcurrency: <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => R | Promise<R>,
) => Promise<R[]>;

export declare const provePublicRelease: (input: {
  targets: PublicProofExpectation[];
  attempts: number;
  delayMs: number;
  scratchDir: string;
  fetchExact?: PublicProofFetch;
  headExact?: PublicProofHead;
  sleep?: (ms: number) => void;
  /** Requests in flight at once within an attempt (default 8). */
  concurrency?: number;
}) => Promise<{
  failures: { target: PublicProofExpectation; mismatch: string }[];
  attemptsUsed: number;
  /** HEAD targets whose ETag proved nothing, so they were downloaded instead. */
  fullDownloads: number;
}>;
