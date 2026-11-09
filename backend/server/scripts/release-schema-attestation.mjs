/** The schema check's receipt, read by the final release signer.
 *
 * ⛔ `migration` in release.config.json is typed by hand and decides what a
 * rollback does: `false` takes no snapshot of the owner's database, so a
 * rollback runs the previous binary on this release's schema. The release
 * driver's step 8 boots the staged binary and the releases a rollback can
 * return to (release/lib/schema-fingerprint.mjs), and stops a `false` one of
 * them cannot run on. But the publish is commands typed by hand, and
 * release-build signed whatever the config said, so a stop that was read past
 * shipped anyway. The check now leaves this receipt beside the binary it
 * booted, and release-build refuses to sign a `false` it does not show safe.
 *
 * Like the native build receipts, it is not a signing authority. `true` needs
 * no receipt: the snapshot covers any change.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SCHEMA_CHECK_FILE = 'recued-schema-check.json';
export const SCHEMA_CHECK_SCHEMA_VERSION = 1;

const binaryName = (triple) => `recued-${triple}${triple.startsWith('windows-') ? '.exe' : ''}`;
const addonName = (triple) => `better_sqlite3-${triple}.node`;
const floorOf = (channel) => (typeof channel?.min_supported === 'string' ? channel.min_supported : null);

const artifactRecord = (stagingDir, file) => {
  const path = join(stagingDir, file);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`no ${file} in ${stagingDir}`);
  return { file, bytes: statSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
};

export const removeSchemaCheck = ({ stagingDir }) => {
  rmSync(join(stagingDir, SCHEMA_CHECK_FILE), { force: true });
};

/** `channels` is the check's result for each channel: the `min_supported` it was run
 *  with, and each release it compared with, with the number of this release's changes
 *  to the database that release cannot run on. */
export const writeSchemaCheck = ({ stagingDir, triple, version, channels }) => {
  const receipt = {
    schema_version: SCHEMA_CHECK_SCHEMA_VERSION,
    version,
    triple,
    binary: artifactRecord(stagingDir, binaryName(triple)),
    addon: artifactRecord(stagingDir, addonName(triple)),
    channels: Object.fromEntries(Object.entries(channels).map(([name, channel]) => [name, {
      min_supported: floorOf(channel),
      compared: channel.compared.map(({ label, breaking }) => ({ label, breaking })),
    }])),
  };
  const path = join(stagingDir, SCHEMA_CHECK_FILE);
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return receipt;
};

/** Throws the first reason a channel that says `migration: false` may not be signed;
 *  returns the names of those channels, none of which needed anything when it is empty. */
export const assertMigrationFlagsChecked = ({ stagingDir, version, channels }) => {
  const unsnapshotted = Object.entries(channels ?? {}).filter(([, channel]) => channel?.migration === false);
  if (unsnapshotted.length === 0) return [];
  const rerun = 'run the schema check again (step 8 of the release, or from the repository root: '
    + `npx tsx release/lib/schema-fingerprint.mjs --version ${version}), or set "migration": true`;
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(join(stagingDir, SCHEMA_CHECK_FILE), 'utf8'));
  } catch {
    throw new Error(
      `${unsnapshotted.map(([name]) => `'${name}'`).join(' and ')} say(s) migration false, and no schema check `
        + `of these binaries is recorded (${SCHEMA_CHECK_FILE} in ${stagingDir}): ${rerun}`,
    );
  }
  if (receipt?.schema_version !== SCHEMA_CHECK_SCHEMA_VERSION) {
    throw new Error(`unsupported ${SCHEMA_CHECK_FILE} schema ${JSON.stringify(receipt?.schema_version)}: ${rerun}`);
  }
  if (receipt.version !== version) {
    throw new Error(`the recorded schema check is of ${JSON.stringify(receipt.version)}, not ${version}: ${rerun}`);
  }
  if (typeof receipt.triple !== 'string') throw new Error(`${SCHEMA_CHECK_FILE} names no binary: ${rerun}`);
  for (const [kind, file] of [['binary', binaryName(receipt.triple)], ['addon', addonName(receipt.triple)]]) {
    const recorded = receipt[kind];
    const staged = artifactRecord(stagingDir, file);
    if (recorded?.file !== file || recorded.sha256 !== staged.sha256 || recorded.bytes !== staged.bytes) {
      throw new Error(`${file} is not the file the schema check booted: ${rerun}`);
    }
  }
  for (const [name, channel] of unsnapshotted) {
    const checked = receipt.channels?.[name];
    if (!Array.isArray(checked?.compared)
      || !checked.compared.every((entry) => Number.isSafeInteger(entry?.breaking) && entry.breaking >= 0)) {
      throw new Error(`the recorded schema check does not cover channel '${name}': ${rerun}`);
    }
    if (checked.min_supported !== floorOf(channel)) {
      throw new Error(
        `channel '${name}' has min_supported ${JSON.stringify(floorOf(channel))}, and the schema check ran with `
          + `${JSON.stringify(checked.min_supported)}: ${rerun}`,
      );
    }
    const unsafe = checked.compared.filter(({ breaking }) => breaking > 0);
    if (unsafe.length > 0) {
      throw new Error(
        `channel '${name}' says migration false, but `
          + unsafe.map(({ label, breaking }) => `${label} cannot run on ${breaking} change(s)`).join(', and ')
          + ' this release makes to the database. Set "migration": true for it: an update then snapshots '
          + 'the database first, and a rollback restores it.',
      );
    }
  }
  return unsnapshotted.map(([name]) => name);
};
