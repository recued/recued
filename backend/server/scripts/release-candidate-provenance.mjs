/** Custody-signed binding between a retained release directory and its source.
 *
 * A manifest signature proves who authorized the manifest; it does not name the
 * Git revision whose publisher/build policy produced it. This private handoff
 * record signs the exact manifest hash together with source revision, version,
 * and sequence. It stays in the retained candidate directory and is never a
 * public release-feed object. */
import { createHash } from 'node:crypto';
import { signArtifact, verify } from '@recued/release';

export const CANDIDATE_PROVENANCE_SCHEMA_VERSION = 1;
export const CANDIDATE_PROVENANCE_FILE = 'release-candidate-provenance.json';
export const CANDIDATE_PROVENANCE_SIG_FILE = `${CANDIDATE_PROVENANCE_FILE}.minisig`;

const SOURCE_REVISION_RE = /^[0-9a-f]{40,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const manifestSha256 = (manifestBytes) =>
  createHash('sha256').update(manifestBytes).digest('hex');

export const serializeCandidateProvenance = ({
  sourceRevision,
  manifestBytes,
  version,
  sequence,
}) => {
  const revision = String(sourceRevision ?? '').toLowerCase();
  if (!SOURCE_REVISION_RE.test(revision)) {
    throw new Error(`invalid candidate source revision ${JSON.stringify(sourceRevision)}`);
  }
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('candidate provenance version is required');
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`candidate provenance sequence must be a positive safe integer (got ${sequence})`);
  }
  return `${JSON.stringify({
    schema_version: CANDIDATE_PROVENANCE_SCHEMA_VERSION,
    source_revision: revision,
    manifest_sha256: manifestSha256(manifestBytes),
    sequence,
    version,
  })}\n`;
};

export const signCandidateProvenance = ({
  sourceRevision,
  manifestBytes,
  version,
  sequence,
  key,
}) => {
  const json = serializeCandidateProvenance({
    sourceRevision,
    manifestBytes,
    version,
    sequence,
  });
  return {
    json,
    sig: signArtifact({
      content: Buffer.from(json, 'utf8'),
      fileName: CANDIDATE_PROVENANCE_FILE,
      version,
      key,
    }),
  };
};

const parseCandidateProvenance = (bytes) => {
  let value;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (err) {
    throw new Error(`candidate provenance is not JSON: ${err?.message ?? err}`);
  }
  const keys = Object.keys(value ?? {}).sort();
  const expectedKeys = [
    'manifest_sha256',
    'schema_version',
    'sequence',
    'source_revision',
    'version',
  ];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error('candidate provenance has missing or unrecognized fields');
  }
  if (
    value.schema_version !== CANDIDATE_PROVENANCE_SCHEMA_VERSION
    || !SOURCE_REVISION_RE.test(value.source_revision ?? '')
    || !SHA256_RE.test(value.manifest_sha256 ?? '')
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 1
    || typeof value.version !== 'string'
    || value.version.length === 0
  ) {
    throw new Error('candidate provenance fields are invalid');
  }
  return value;
};

export const verifyCandidateProvenance = ({
  provenanceBytes,
  signatureText,
  publicKeyText,
  expectedSourceRevision,
  manifestBytes,
  version,
  sequence,
}) => {
  let signatureOk = false;
  try {
    signatureOk = verify({
      content: provenanceBytes,
      signatureText,
      publicKeyText,
    }).ok;
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) throw new Error('candidate provenance signature does not verify under the release custody key');

  const provenance = parseCandidateProvenance(provenanceBytes);
  const expectedRevision = String(expectedSourceRevision ?? '').toLowerCase();
  if (provenance.source_revision !== expectedRevision) {
    throw new Error(
      `candidate source revision ${provenance.source_revision} does not match ${expectedRevision}`,
    );
  }
  const expectedManifestHash = manifestSha256(manifestBytes);
  if (provenance.manifest_sha256 !== expectedManifestHash) {
    throw new Error('candidate provenance does not bind the exact manifest.json bytes');
  }
  if (provenance.version !== version || provenance.sequence !== sequence) {
    throw new Error(
      `candidate provenance names ${provenance.version} sequence ${provenance.sequence}, `
        + `not ${version} sequence ${sequence}`,
    );
  }
  return provenance;
};
