/** @recued/release — D-178 Release & Update Substrate.
 *
 *  The signed-release primitives shared across the update consumers (server
 *  self-updater + thin-image launcher) and the CI signer. Slice 1: the minisign
 *  integrity boundary (I-2) + the release-manifest shape (§ Release manifest).
 *  Slice 2 adds the pure resolution layer (anti-replay / freshness / channel
 *  resolution / local rollout); the server check rpc + apply machinery layer
 *  on top in later slices.
 */

export {
  generateKeypair,
  parsePublicKey,
  parseSignature,
  publicKeyFromSeed,
  publicKeyText,
  sign,
  verify,
  type Keypair,
  type ParsedPublicKey,
  type ParsedSignature,
  type VerifyResult,
} from './minisign.js';

export {
  isDockerArtifact,
  MANIFEST_SCHEMA_VERSION,
  ManifestError,
  parseManifest,
  PLATFORMS,
  type Artifact,
  type BinaryArtifact,
  type ChannelName,
  type ChannelRelease,
  type DockerArtifact,
  type Platform,
  type ReleaseManifest,
} from './manifest.js';

export {
  binaryFileName,
  currentPlatformTriple,
  resolvePlatformTriple,
  type NodeArch,
  type NodePlatform,
} from './target.js';

export {
  artifactTrustedComment,
  assembleManifest,
  manifestTrustedComment,
  serializeManifest,
  signArtifact,
  signManifest,
  signWebclientArchive,
  type ChannelInput,
  type ManifestInput,
  type SignedManifest,
  type SignKey,
} from './assemble.js';

export {
  selectInstallArtifact,
  type InstallSelection,
  type InstallSelectionResult,
  type SelectInstallInput,
} from './install.js';

export {
  assertReleaseKeyValid,
  releaseKeyStatus,
  ReleaseKeyError,
  signingKeyMatchesPin,
  type ReleaseKeyStatus,
} from './release-key.js';

export {
  compareVersions,
  DEFAULT_FRESHNESS_GRACE_MS,
  inRolloutCohort,
  resolveRelease,
  type ReleaseResolution,
  type ResolveInput,
} from './resolve.js';

export {
  isSafeWebclientPath,
  packWebclientArchive,
  unpackWebclientArchive,
  WEBCLIENT_ARCHIVE_SCHEMA,
  webclientArchiveFileName,
  webclientArtifactTrustedComment,
  type UnpackWebclientArchiveResult,
  type WebclientArchiveFile,
} from './webclient-archive.js';
