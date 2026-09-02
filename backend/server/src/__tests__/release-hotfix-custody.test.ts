import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertLiveInstallerParity,
  assertTaggedBaseComparator,
  recoveryInstallerPath,
} from '../../scripts/release-hotfix-custody.mjs';

const TSX = resolve(import.meta.dirname, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');
const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

const fail = (message: string): never => { throw new Error(message); };

const taggedRepo = (segments: 3 | 4): string => {
  const root = mkdtempSync(join(tmpdir(), `recued-hotfix-tag-${segments}-`));
  roots.push(root);
  mkdirSync(join(root, 'backend', 'server'), { recursive: true });
  mkdirSync(join(root, 'packages', 'release', 'src'), { recursive: true });
  writeFileSync(join(root, 'backend', 'server', 'package.json'), '{"version":"26.9.1"}\n');
  writeFileSync(
    join(root, 'packages', 'release', 'src', 'resolve.ts'),
    `export const compareVersions = (a: string, b: string): number => {\n`
      + `  const seg = (v: string): number[] => v.split('.').slice(0, ${segments}).map(Number);\n`
      + '  const left = seg(a); const right = seg(b);\n'
      + `  for (let i = 0; i < ${segments}; i += 1) {\n`
      + '    const d = (left[i] ?? 0) - (right[i] ?? 0); if (d !== 0) return d < 0 ? -1 : 1;\n'
      + '  } return 0;\n};\n',
  );
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'base'], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Release Test', GIT_AUTHOR_EMAIL: 'release@example.invalid',
      GIT_COMMITTER_NAME: 'Release Test', GIT_COMMITTER_EMAIL: 'release@example.invalid',
    },
  });
  execFileSync('git', ['tag', 'v26.9.1'], { cwd: root });
  return root;
};

describe('first four-segment publish custody', () => {
  it('executes the comparator from the actual base tag', () => {
    expect(() => assertTaggedBaseComparator({
      version: '26.9.1.1',
      repoRoot: taggedRepo(4),
      fail,
      tsxCommand: TSX,
      tsxArgsPrefix: [],
    })).not.toThrow();
  });

  it('refuses a tagged base whose comparator still truncates at three', () => {
    expect(() => assertTaggedBaseComparator({
      version: '26.9.1.1',
      repoRoot: taggedRepo(3),
      fail,
      tsxCommand: TSX,
      tsxArgsPrefix: [],
    })).toThrow(/does not execute the required four-segment comparator vectors/);
  });

  it('refuses a missing or wrongly-versioned base tag', () => {
    const root = taggedRepo(4);
    execFileSync('git', ['tag', '-d', 'v26.9.1'], { cwd: root, stdio: 'ignore' });
    expect(() => assertTaggedBaseComparator({
      version: '26.9.1.1', repoRoot: root, fail, tsxCommand: TSX, tsxArgsPrefix: [],
    })).toThrow(/does not identify a shipped 26\.9\.1 tree/);
  });
});

describe('release recovery-installer parity', () => {
  const installerTree = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'recued-installer-parity-'));
    roots.push(root);
    // ⚠ THE LAYOUT COMES FROM THE MODULE UNDER TEST. Writing `distribution/…`
    // here by hand was a second copy of the path the checker reads — and the bare
    // `distribution` literal made the export scanner omit this whole file for a
    // directory the test creates under `mkdtemp` and never reads from the repo.
    mkdirSync(dirname(recoveryInstallerPath(root, 'install.sh')), { recursive: true });
    writeFileSync(recoveryInstallerPath(root, 'install.sh'), 'posix-current\n');
    writeFileSync(recoveryInstallerPath(root, 'install.ps1'), 'windows-current\n');
    return root;
  };

  it('accepts only exact live bytes for both recovery scripts', () => {
    const root = installerTree();
    const spawn = ((_command: string, args: string[]) => ({
      status: 0,
      stdout: args.at(-1)?.endsWith('install.sh') ? 'posix-current\n' : 'windows-current\n',
      stderr: '',
    })) as never;
    expect(() => assertLiveInstallerParity({ version: '26.9.1', repoRoot: root, fail, spawn }))
      .not.toThrow();
  });

  it('fails closed when either live recovery script differs or cannot be fetched', () => {
    const root = installerTree();
    const spawn = ((_command: string, args: string[]) => ({
      status: args.at(-1)?.endsWith('install.sh') ? 0 : 22,
      stdout: 'stale\n',
      stderr: '',
    })) as never;
    expect(() => assertLiveInstallerParity({ version: '26.9.1', repoRoot: root, fail, spawn }))
      .toThrow(/published install\.sh and install\.ps1 \(could not fetch\) do not match/);
  });
});
