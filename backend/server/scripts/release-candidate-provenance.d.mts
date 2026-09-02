export interface CandidateProvenanceInput {
  sourceRevision: string;
  manifestBytes: Uint8Array;
  version: string;
  sequence: number;
}

export interface CandidateSigningKey {
  secretSeed: Uint8Array;
  keyId: Uint8Array;
}

export declare const CANDIDATE_PROVENANCE_SCHEMA_VERSION: 1;
export declare const CANDIDATE_PROVENANCE_FILE: 'release-candidate-provenance.json';
export declare const CANDIDATE_PROVENANCE_SIG_FILE: 'release-candidate-provenance.json.minisig';
export declare const serializeCandidateProvenance: (input: CandidateProvenanceInput) => string;
export declare const signCandidateProvenance: (
  input: CandidateProvenanceInput & { key: CandidateSigningKey },
) => { json: string; sig: string };
export declare const verifyCandidateProvenance: (input: {
  provenanceBytes: Uint8Array;
  signatureText: string;
  publicKeyText: string;
  expectedSourceRevision: string;
  manifestBytes: Uint8Array;
  version: string;
  sequence: number;
}) => Record<string, unknown>;
