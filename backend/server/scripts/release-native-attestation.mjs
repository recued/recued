/** Hash-bound native build receipts shared by the platform builders and the
 * final release signer.
 *
 * Executable headers and embedded version strings prove shape, not operation.
 * The platform builders are the only stage that can execute their artifacts,
 * load the paired SQLite addon, speak WebSocket, and exercise daemon restart.
 * After those checks pass they write this receipt over the FINAL staged bytes.
 * release-build verifies the exact hashes, version, source revision, producer,
 * and complete check set before it creates any custody signature.
 *
 * This is a local build-pipeline receipt, not a new signing authority. The
 * custody signature remains the public trust boundary; the receipt prevents an
 * accidentally substituted, stale, or never-smoked pair from reaching it.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const NATIVE_ATTESTATION_SCHEMA_VERSION = 2;
export const REQUIRED_NATIVE_CHECKS = Object.freeze([
  'version',
  'database',
  'websocket',
  'daemon',
]);

const producerForTriple = (triple) => {
  if (triple.startsWith('linux-')) return 'build-binary-docker';
  if (triple.startsWith('macos-')) return 'build-binary-macos';
  if (triple.startsWith('windows-')) return 'build-binary-windows';
  throw new Error(`unsupported native attestation triple ${JSON.stringify(triple)}`);
};

const binaryName = (triple) => `recued-${triple}${triple.startsWith('windows-') ? '.exe' : ''}`;
const addonName = (triple) => `better_sqlite3-${triple}.node`;
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Platform trust is intentionally asymmetric. Windows artifacts are shipped
 * unsigned at the OS layer: PowerShell installs verify Minisign + manifest
 * hashes, and the validated path does not attach Mark-of-the-Web. macOS still
 * requires Developer ID + Apple notarization, so a mac receipt is publishable
 * only when it records the Accepted submission whose ticket coverage the
 * platform builder checked against these exact hash-bound bytes. */
const normalizePlatformTrust = (triple, platformTrust) => {
  if (!triple.startsWith('macos-')) {
    if (platformTrust !== undefined) {
      throw new Error(`${triple}: platform trust proof is supported only for macOS receipts`);
    }
    return undefined;
  }
  if (
    platformTrust?.kind !== 'apple-notarization'
    || platformTrust.status !== 'accepted'
    || platformTrust.ticket_coverage !== 'passed'
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
      platformTrust.submission_id ?? '',
    )
  ) {
    throw new Error(
      `${triple}: native receipt requires an Accepted Apple notarization submission `
        + 'with passed ticket coverage for the final bytes',
    );
  }
  return {
    kind: 'apple-notarization',
    status: 'accepted',
    submission_id: platformTrust.submission_id,
    ticket_coverage: 'passed',
  };
};

export const nativeAttestationFileName = (triple) => `recued-${triple}.attestation.json`;

export const resolveSourceRevision = ({ repoRoot, ref = 'HEAD' }) => {
  const revision = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(revision)) {
    throw new Error(`git returned an invalid source revision for ${ref}: ${JSON.stringify(revision)}`);
  }
  return revision;
};

export const assertSourceTreeClean = ({ repoRoot }) => {
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (dirty) {
    throw new Error(
      'native release builders require a clean source worktree so the recorded HEAD actually names the built bytes:\n'
        + dirty.split(/\r?\n/).slice(0, 12).map((line) => `  ${line}`).join('\n'),
    );
  }
};

export const removeNativeBuildAttestation = ({ stagingDir, triple }) => {
  rmSync(join(stagingDir, nativeAttestationFileName(triple)), { force: true });
};

const artifactRecord = (stagingDir, file) => {
  const path = join(stagingDir, file);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`cannot attest missing native artifact ${path}`);
  }
  return { file, bytes: statSync(path).size, sha256: sha256(path) };
};

export const writeNativeBuildAttestation = ({
  stagingDir,
  triple,
  version,
  sourceRevision,
  producer,
  checks = REQUIRED_NATIVE_CHECKS,
  platformTrust,
}) => {
  const expectedProducer = producerForTriple(triple);
  if (producer !== expectedProducer) {
    throw new Error(`${triple} receipt producer must be ${expectedProducer}, got ${JSON.stringify(producer)}`);
  }
  if (typeof version !== 'string' || !version) throw new Error('native receipt version is required');
  if (!/^[0-9a-f]{40,64}$/.test(sourceRevision ?? '')) {
    throw new Error(`native receipt source revision is invalid: ${JSON.stringify(sourceRevision)}`);
  }
  const checkSet = new Set(checks);
  const missing = REQUIRED_NATIVE_CHECKS.filter((check) => !checkSet.has(check));
  if (missing.length > 0) throw new Error(`native receipt is missing passed checks: ${missing.join(', ')}`);
  const normalizedPlatformTrust = normalizePlatformTrust(triple, platformTrust);

  const receipt = {
    schema_version: NATIVE_ATTESTATION_SCHEMA_VERSION,
    triple,
    version,
    source_revision: sourceRevision,
    producer,
    binary: artifactRecord(stagingDir, binaryName(triple)),
    addon: artifactRecord(stagingDir, addonName(triple)),
    checks: Object.fromEntries(REQUIRED_NATIVE_CHECKS.map((check) => [check, 'passed'])),
    ...(normalizedPlatformTrust === undefined
      ? {}
      : { platform_trust: normalizedPlatformTrust }),
  };
  const path = join(stagingDir, nativeAttestationFileName(triple));
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return receipt;
};

export const assertNativeBuildAttestation = ({
  stagingDir,
  triple,
  version,
  sourceRevision,
}) => {
  const file = nativeAttestationFileName(triple);
  const path = join(stagingDir, file);
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `${triple}: missing or unreadable ${file}; the platform builder must smoke the final binary/addon pair `
        + `before release-build may sign it (${err?.message ?? err})`,
    );
  }
  const expectedProducer = producerForTriple(triple);
  if (receipt?.schema_version !== NATIVE_ATTESTATION_SCHEMA_VERSION) {
    throw new Error(`${triple}: unsupported native receipt schema ${JSON.stringify(receipt?.schema_version)}`);
  }
  if (receipt.triple !== triple || receipt.producer !== expectedProducer) {
    throw new Error(
      `${triple}: native receipt identity mismatch (triple ${JSON.stringify(receipt.triple)}, `
        + `producer ${JSON.stringify(receipt.producer)}; expected ${expectedProducer})`,
    );
  }
  if (receipt.version !== version) {
    throw new Error(`${triple}: native receipt version ${JSON.stringify(receipt.version)} does not match ${JSON.stringify(version)}`);
  }
  if (receipt.source_revision !== sourceRevision) {
    throw new Error(
      `${triple}: native receipt source ${JSON.stringify(receipt.source_revision)} does not match signer source ${sourceRevision}`,
    );
  }
  for (const check of REQUIRED_NATIVE_CHECKS) {
    if (receipt.checks?.[check] !== 'passed') {
      throw new Error(`${triple}: native receipt does not prove the ${check} smoke check passed`);
    }
  }
  normalizePlatformTrust(triple, receipt.platform_trust);
  for (const [kind, expectedFile] of [
    ['binary', binaryName(triple)],
    ['addon', addonName(triple)],
  ]) {
    const recorded = receipt[kind];
    if (recorded?.file !== expectedFile) {
      throw new Error(`${triple}: native receipt ${kind} names ${JSON.stringify(recorded?.file)}, expected ${expectedFile}`);
    }
    const actual = artifactRecord(stagingDir, expectedFile);
    if (recorded.bytes !== actual.bytes || recorded.sha256 !== actual.sha256) {
      throw new Error(
        `${triple}: ${expectedFile} changed after its functional smoke `
          + `(receipt ${recorded.sha256 ?? 'no hash'}/${recorded.bytes ?? 'no size'}, `
          + `staged ${actual.sha256}/${actual.bytes})`,
      );
    }
  }
  return receipt;
};
