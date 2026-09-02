import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Prove a hotfix's actual BASE TAG executes four-segment ordering. This is an
 *  effectful publish-boundary check, separate from the forward-looking version
 *  floor in version-guard.mjs. `spawn`/tsx command injection exists only so the
 *  decision can be driven against temporary tagged repositories in tests. */
export const assertTaggedBaseComparator = ({
  version,
  repoRoot,
  fail,
  spawn = spawnSync,
  tsxCommand = 'npx',
  tsxArgsPrefix = ['tsx'],
}) => {
  const baseVersion = version.split('.').slice(0, 3).join('.');
  const baseTag = `v${baseVersion}`;
  const taggedPackage = spawn(
    'git',
    ['show', `${baseTag}:backend/server/package.json`],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  let taggedVersion = '';
  try { taggedVersion = JSON.parse(taggedPackage.stdout ?? '').version; } catch { taggedVersion = ''; }
  if (taggedPackage.status !== 0 || taggedVersion !== baseVersion) {
    fail(
      `${version} is a hotfix on ${baseVersion}, but ${baseTag} does not identify a shipped ${baseVersion} tree.\n`
        + '  The base must be cut and tagged before a suffix can be visible to servers running it.',
    );
    return;
  }

  const probeRoot = mkdtempSync(join(tmpdir(), 'recued-hotfix-tag-'));
  try {
    const archive = spawn(
      'git',
      ['archive', '--format=tar', baseTag, 'packages/release'],
      { cwd: repoRoot, encoding: null, maxBuffer: 64 * 1024 * 1024 },
    );
    if (archive.status !== 0 || !archive.stdout) {
      fail(`${baseTag}: could not archive the tagged release comparator for execution`);
      return;
    }
    const extracted = spawn('tar', ['-xf', '-', '-C', probeRoot], {
      input: archive.stdout,
      encoding: 'utf8',
    });
    if (extracted.status !== 0) {
      fail(`${baseTag}: could not extract the tagged release comparator: ${extracted.stderr ?? ''}`);
      return;
    }
    const moduleUrl = pathToFileURL(join(probeRoot, 'packages', 'release', 'src', 'resolve.ts')).href;
    const vectors = [
      [`${baseVersion}.1`, baseVersion, 1],
      [baseVersion, `${baseVersion}.1`, -1],
      [`${baseVersion}.2`, `${baseVersion}.1`, 1],
      [`${baseVersion}.1`, `${baseVersion}.1`, 0],
    ];
    const source = [
      'void (async () => {',
      `  const { compareVersions } = await import(${JSON.stringify(moduleUrl)});`,
      `  const vectors = ${JSON.stringify(vectors)};`,
      '  for (const [a, b, want] of vectors) {',
      '    const got = Math.sign(compareVersions(a, b));',
      '    if (got !== want) { console.error(`${a} vs ${b}: got ${got}, want ${want}`); process.exit(9); }',
      '  }',
      '})().catch((error) => { console.error(error); process.exit(10); });',
    ].join('\n');
    const probed = spawn(tsxCommand, [...tsxArgsPrefix, '--eval', source], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (probed.status !== 0) {
      fail(
        `${baseTag} does not execute the required four-segment comparator vectors.\n`
          + `  ${String(probed.stderr || probed.stdout || 'tag probe failed').trim()}`,
      );
    }
  } finally {
    try { rmSync(probeRoot, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
  }
};

/** The separately deployed recovery installers, and where they live in this tree.
 *
 *  ⛔ ONE DEFINITION, EXPORTED. The parity check below reads these paths and its
 *  test writes them into a temporary tree; two hand-written copies of one layout
 *  is how a moved file leaves a green test asserting nothing. Exporting it also
 *  keeps the literal `distribution` — a private export root — out of the test,
 *  which was otherwise omitted from the public tree for a directory it creates
 *  itself under `mkdtemp` and never reads from the repository. */
export const RECOVERY_INSTALLER_NAMES = ['install.sh', 'install.ps1'];

/** Where `name` (one of {@link RECOVERY_INSTALLER_NAMES}) lives under a tree root. */
export const recoveryInstallerPath = (repoRoot, name) =>
  join(repoRoot, 'distribution', 'install', name);

/** Prove the separately deployed recovery scripts are the bytes from this tree
 *  before publishing any release. A release is not recoverable merely because
 *  its binary feed is current: broken hosts enter through these independently
 *  deployed scripts. */
export const assertLiveInstallerParity = ({
  version,
  repoRoot,
  fail,
  spawn = spawnSync,
  baseUrl = 'https://recued.com',
}) => {
  const stale = [];
  for (const name of RECOVERY_INSTALLER_NAMES) {
    const localPath = recoveryInstallerPath(repoRoot, name);
    const live = spawn('curl', ['-fsSL', '-m', '20', `${baseUrl}/${name}`], { encoding: 'utf8' });
    if (live.status !== 0) stale.push(`${name} (could not fetch)`);
    else if (live.stdout !== readFileSync(localPath, 'utf8')) stale.push(name);
  }
  if (stale.length > 0) {
    fail(
      `the published ${stale.join(' and ')} do not match this tree for release ${version}.\n`
        + '  Deploy the recovery installers first. The binary feed and installer endpoint are separate\n'
        + '  deployments; issuing a release while they differ leaves its bootstrap/repair path stale.',
    );
  }
};
