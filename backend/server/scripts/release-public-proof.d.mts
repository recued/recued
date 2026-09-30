export interface PublicProofTarget {
  label: string;
  url: string;
  /** The local candidate file the response must equal byte for byte. */
  file: string;
  headers: string[];
  timeoutSeconds: number;
}

export interface PublicProofExpectation extends PublicProofTarget {
  expectedSize: number;
  expectedSha256: string;
}

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
}) => PublicProofFetchResult;

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
export declare const curlFetchExact: PublicProofFetch;

export declare const provePublicRelease: (input: {
  targets: PublicProofExpectation[];
  attempts: number;
  delayMs: number;
  scratchDir: string;
  fetchExact?: PublicProofFetch;
  sleep?: (ms: number) => void;
}) => {
  failures: { target: PublicProofExpectation; mismatch: string }[];
  attemptsUsed: number;
};
