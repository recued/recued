import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  WEBCLIENT_BUNDLE_MANIFEST_FILENAME,
  WEBCLIENT_BUNDLE_PATH_REGEX,
  verifyWebclientBundle,
} from '@recued/contracts';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Load only a webclient build that proves which source/configuration produced
 * it and whose inner integrity manifest matches the exact bytes about to be
 * signed. Throwing keeps this helper useful at the custody boundary and in
 * focused tests without making `release-build.mjs` itself importable. */
export const loadAttestedWebclientBundle = ({
  buildDir,
  expectedSourceRevision,
  expectedCloudApex = 'recued.com',
}) => {
  const manifestPath = join(buildDir, WEBCLIENT_BUNDLE_MANIFEST_FILENAME);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`bundle manifest unreadable/malformed at ${manifestPath}: ${error?.message ?? error}`);
  }
  if (!Array.isArray(manifest?.files)) {
    throw new Error(`bundle manifest at ${manifestPath} has no "files" array`);
  }
  const attestation = manifest.build;
  if (
    attestation?.schema !== 1
    || attestation.source_revision !== expectedSourceRevision
    || attestation.source_dirty !== false
    || attestation.cloud_apex !== expectedCloudApex
    || attestation.minified !== true
  ) {
    throw new Error(
      'bundle build attestation does not match this release: expected '
        + `source ${expectedSourceRevision}, clean=true, cloud_apex=${expectedCloudApex}, minified=true`,
    );
  }

  const bundleFiles = [];
  for (const entry of manifest.files) {
    if (
      typeof entry?.path !== 'string'
      || !WEBCLIENT_BUNDLE_PATH_REGEX.test(entry.path)
    ) {
      throw new Error(`bundle manifest contains an unsafe or missing path: ${JSON.stringify(entry?.path)}`);
    }
    const abs = join(buildDir, entry.path);
    if (!existsSync(abs)) throw new Error(`bundle file listed but missing on disk: ${entry.path}`);
    const bytes = readFileSync(abs);
    bundleFiles.push({ path: entry.path, bytes, sha256: sha256(bytes) });
  }
  const verified = verifyWebclientBundle(manifest, bundleFiles);
  if (!verified.ok) {
    const detail = verified.issues
      .map((issue) => `${issue.code}${issue.path ? `:${issue.path}` : ''}`)
      .join(', ');
    throw new Error(`bundle inner integrity verification failed: ${detail}`);
  }

  return {
    manifestPath,
    archiveFiles: [
      { path: WEBCLIENT_BUNDLE_MANIFEST_FILENAME, bytes: readFileSync(manifestPath) },
      ...bundleFiles.map(({ path, bytes }) => ({ path, bytes })),
    ],
  };
};
