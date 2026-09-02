export type NativeCheck = 'version' | 'database' | 'websocket' | 'daemon';

export interface NativeAttestationOptions {
  stagingDir: string;
  triple: string;
  version: string;
  sourceRevision: string;
}

export interface WriteNativeAttestationOptions extends NativeAttestationOptions {
  producer: 'build-binary-docker' | 'build-binary-macos' | 'build-binary-windows';
  checks?: readonly NativeCheck[];
  platformTrust?: {
    kind: 'apple-notarization';
    status: 'accepted';
    submission_id: string;
    ticket_coverage: 'passed';
  };
}

export declare const NATIVE_ATTESTATION_SCHEMA_VERSION: 2;
export declare const REQUIRED_NATIVE_CHECKS: readonly NativeCheck[];
export declare const nativeAttestationFileName: (triple: string) => string;
export declare const resolveSourceRevision: (options: { repoRoot: string; ref?: string }) => string;
export declare const assertSourceTreeClean: (options: { repoRoot: string }) => void;
export declare const removeNativeBuildAttestation: (options: {
  stagingDir: string;
  triple: string;
}) => void;
export declare const writeNativeBuildAttestation: (
  options: WriteNativeAttestationOptions,
) => Record<string, unknown>;
export declare const assertNativeBuildAttestation: (
  options: NativeAttestationOptions,
) => Record<string, unknown>;
