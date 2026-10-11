/** D-321 slice 2 — the pure half of the version check: reading a version from
 *  what a probe printed, the tested range, its wording in a refusal, the owner's
 *  choice and its stamp, and the code a refusal carries.
 *
 *  The probe outputs are the ones measured on 2026-10-09 (spec § 2), with
 *  throwaway HOME, XDG, `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. */

import { describe, expect, it } from 'vitest';
import {
  CLI_FAILURE_REASONS,
  ERROR_ATTRIBUTION,
  ERROR_MESSAGES,
  classifyAutomationFailure,
  cliFailureErrorCode,
  cliToolVersionHash,
  describeTestedRange,
  effectiveToolVersionOutside,
  isCliFailureDetail,
  isToolVersionTested,
  readOwnerToolVersionRow,
  readToolVersion,
  renderInstallHints,
  testedMajor,
  cliInstallSystemOf,
  cliToolPolicyOfRuntime,
  readCliProbe,
  readCliToolVersionPolicy,
  type CliToolVersionPolicy,
} from '../index.js';

describe('the installed version, read from what the probe printed', () => {
  it.each([
    ['opencode', '1.18.35\n', '', '1.18.35'],
    ['pi', '1.1.0\n', '', '1.1.0'],
    ['codex', 'codex-cli 0.161.0\n', '', '0.161.0'],
    ['claude', '2.1.296 (Claude Code)\n', '', '2.1.296'],
    ['magick', 'Version: ImageMagick 7.1.2-31 Q16-HDRI aarch64 23189 https://imagemagick.org\nCopyright: (C) 1999 ImageMagick Studio LLC\n', '', '7.1.2'],
    ['node', 'v20.11.1\n', '', '20.11.1'],
    ['go', 'go version go1.22.0 darwin/arm64\n', '', '1.22.0'],
  ])('%s', (_tool, stdout, stderr, version) => {
    expect(readToolVersion(stdout, stderr)).toBe(version);
  });

  it('reads stderr when stdout has no version, and only the first line that is not blank', () => {
    expect(readToolVersion('', 'codex-cli 0.161.0\n')).toBe('0.161.0');
    expect(readToolVersion('\n  \nversion 3.4.5\n9.9.9\n', '')).toBe('3.4.5');
    expect(readToolVersion('usage: tool [options]\n', '1.2.3\n')).toBe('1.2.3');
    // stdout first: a number on stderr is read only when stdout's first line has none.
    expect(readToolVersion('1.18.35\n', 'warning: config 9.9.9\n')).toBe('1.18.35');
  });

  it('reads only the first line of each stream, so a version further down is not taken', () => {
    expect(readToolVersion('a banner\n1.2.3\n', '')).toBeUndefined();
  });

  it('keeps four numbers at most, and refuses a number longer than nine digits', () => {
    expect(readToolVersion('1.2.3.4.5\n', '')).toBe('1.2.3.4');
    expect(readToolVersion('build 1234567890.1\n', '')).toBeUndefined();
  });

  it('reads nothing from a line with no dotted number', () => {
    expect(readToolVersion('tool 7\n', 'ok\n')).toBeUndefined();
    expect(readToolVersion('', '')).toBeUndefined();
  });
});

describe('the tested range', () => {
  const OPENCODE = { from: '1.18.35', before: '2.0.0' };

  it('includes from and excludes before', () => {
    expect(isToolVersionTested('1.18.35', OPENCODE)).toBe(true);
    expect(isToolVersionTested('1.99.0', OPENCODE)).toBe(true);
    expect(isToolVersionTested('1.18.34', OPENCODE)).toBe(false);
    expect(isToolVersionTested('1.15.13', OPENCODE)).toBe(false);
    expect(isToolVersionTested('2.0.0', OPENCODE)).toBe(false);
    expect(isToolVersionTested('2.0.1', OPENCODE)).toBe(false);
  });

  it('is open above when it has no before (a tool still at 0.x)', () => {
    expect(isToolVersionTested('0.161.0', { from: '0.161.0' })).toBe(true);
    expect(isToolVersionTested('5.0.0', { from: '0.161.0' })).toBe(true);
    expect(isToolVersionTested('0.160.9', { from: '0.161.0' })).toBe(false);
  });

  it('reads in words: next major, open, and any other', () => {
    expect(describeTestedRange(OPENCODE)).toBe('1.x versions from 1.18.35');
    expect(describeTestedRange({ from: '2.1.296', before: '3.0.0' })).toBe('2.x versions from 2.1.296');
    expect(describeTestedRange({ from: '2.1.296', before: '3' })).toBe('2.x versions from 2.1.296');
    expect(describeTestedRange({ from: '0.161.0' })).toBe('versions from 0.161.0');
    expect(describeTestedRange({ from: '1.2.0', before: '1.5.0' })).toBe('versions from 1.2.0 and below 1.5.0');
    expect(describeTestedRange({ from: '1.2.0', before: '3.0.0' })).toBe('versions from 1.2.0 and below 3.0.0');
  });
});

describe("the owner's choice, and its stamp", () => {
  const REFUSE: CliToolVersionPolicy = { tested: { from: '1.18.35', before: '2.0.0' }, outside: 'refuse' };
  const stamp = cliToolVersionHash(REFUSE);

  it('no choice: the pack default applies', () => {
    expect(effectiveToolVersionOutside(REFUSE, undefined))
      .toEqual({ outside: 'refuse', source: 'pack', stale_owner_choice: false });
  });

  it('a choice made for the version block the pack declares now wins', () => {
    expect(effectiveToolVersionOutside(REFUSE, { outside: 'warn', version_hash: stamp }))
      .toEqual({ outside: 'warn', source: 'owner', stale_owner_choice: false });
  });

  it.each([
    ['a range that moved', { tested: { from: '2.0.0', before: '3.0.0' }, outside: 'refuse' }],
    ['a range that lost its end', { tested: { from: '1.18.35' }, outside: 'refuse' }],
    ['a default that changed', { tested: { from: '1.18.35', before: '2.0.0' }, outside: 'warn' }],
  ] as const)('a choice made before %s is stale, and the pack default applies', (_label, now) => {
    expect(cliToolVersionHash(now)).not.toBe(stamp);
    expect(effectiveToolVersionOutside(now, { outside: 'warn', version_hash: stamp }))
      .toEqual({ outside: now.outside, source: 'pack', stale_owner_choice: true });
  });

  it('a Refuse made before any change still applies: only a Warn lapses (D-321 audit)', () => {
    // A pack update must never be what lets an untested version run where the
    // owner refused it: nothing is stricter than Refuse.
    const warnByDefault: CliToolVersionPolicy = { tested: { from: '2.0.0', before: '3.0.0' }, outside: 'warn' };
    expect(cliToolVersionHash(warnByDefault)).not.toBe(stamp);
    expect(effectiveToolVersionOutside(warnByDefault, { outside: 'refuse', version_hash: stamp }))
      .toEqual({ outside: 'refuse', source: 'owner', stale_owner_choice: false });
  });

  it('the stamp does not depend on key order', () => {
    expect(cliToolVersionHash({ outside: 'refuse', tested: { before: '2.0.0', from: '1.18.35' } })).toBe(stamp);
  });

  it('a stored row that does not parse is no choice', () => {
    expect(readOwnerToolVersionRow({ outside: 'warn', version_hash: stamp })).toEqual({ outside: 'warn', version_hash: stamp });
    expect(readOwnerToolVersionRow({ outside: 'allow', version_hash: stamp })).toBeUndefined();
    expect(readOwnerToolVersionRow({ outside: 'warn', version_hash: 'abc' })).toBeUndefined();
    expect(readOwnerToolVersionRow({ outside: 'warn' })).toBeUndefined();
    expect(readOwnerToolVersionRow(null)).toBeUndefined();
    expect(readOwnerToolVersionRow(['warn'])).toBeUndefined();
  });
});

describe('the refusal is a coded error', () => {
  it('untested_version carries CLI_TOOL_VERSION_UNTESTED; broken carries CLI_TOOL_FAILED', () => {
    expect(cliFailureErrorCode('untested_version')).toBe('CLI_TOOL_VERSION_UNTESTED');
    expect(cliFailureErrorCode('broken')).toBe('CLI_TOOL_FAILED');
    expect(cliFailureErrorCode('not_found')).toBe('CLI_TOOL_NOT_FOUND');
    expect(CLI_FAILURE_REASONS).toEqual(expect.arrayContaining(['untested_version', 'broken']));
    expect(isCliFailureDetail({ reason: 'untested_version', version: '2.0.1', tested: { from: '1.18.35' } })).toBe(true);
    expect(isCliFailureDetail({ reason: 'broken' })).toBe(true);
  });

  it("is the owner's to act on, like a missing tool, so an automation stops at the first one", () => {
    expect(ERROR_ATTRIBUTION.CLI_TOOL_VERSION_UNTESTED).toBe('choice');
    expect(ERROR_MESSAGES.CLI_TOOL_VERSION_UNTESTED).toContain('choose Warn');
    expect(classifyAutomationFailure({ code: 'CLI_TOOL_VERSION_UNTESTED' }))
      .toEqual({ kind: 'failure', stop: 'first_failure', basis: 'attribution_choice' });
  });
});

describe('install commands, written for the server and never run (slice 3)', () => {
  const OPENCODE = { from: '1.18.35', before: '2.0.0' };

  it('ask for the tested major where the manager can, and not for an open range', () => {
    expect(testedMajor(OPENCODE)).toBe(1);
    expect(testedMajor({ from: '0.161.0' })).toBeUndefined();
    expect(testedMajor({ from: '1.2.0', before: '1.5.0' })).toBeUndefined();
    const all = (manager: string, pkg: string, tested?: { from: string; before?: string }) =>
      renderInstallHints([{ manager, package: pkg }], 'linux', tested).commands;
    expect(all('npm', 'opencode-ai', OPENCODE)).toEqual(['npm install -g opencode-ai@1']);
    expect(all('npm', '@openai/codex', { from: '0.161.0' })).toEqual(['npm install -g @openai/codex']);
    expect(all('pip', 'markitdown', OPENCODE)).toEqual(['pip install "markitdown==1.*"']);
    expect(all('pipx', 'markitdown', OPENCODE)).toEqual(['pipx install "markitdown==1.*"']);
    expect(all('cargo', 'ripgrep', OPENCODE)).toEqual(['cargo install ripgrep --version "^1"']);
    expect(all('go', 'example.com/tool/cmd/tool', OPENCODE)).toEqual(['go install example.com/tool/cmd/tool@v1']);
    expect(all('go', 'example.com/tool/cmd/tool')).toEqual(['go install example.com/tool/cmd/tool@latest']);
    // A system package manager cannot be asked for a major: the page shows the range beside it.
    expect(all('apt', 'ffmpeg', OPENCODE)).toEqual(['sudo apt install ffmpeg']);
    expect(all('dnf', 'ffmpeg', OPENCODE)).toEqual(['sudo dnf install ffmpeg']);
    expect(all('brew', 'node@20', OPENCODE)).toEqual(['brew install node@20']);
  });

  it('show a hint only where its manager runs and its systems allow', () => {
    const hints = [
      { manager: 'brew', package: 'ffmpeg' },
      { manager: 'winget', package: 'Gyan.FFmpeg' },
      { manager: 'scoop', package: 'ffmpeg' },
      { manager: 'apt', package: 'ffmpeg' },
      { manager: 'npm', package: 'ffmpeg-cli', systems: ['windows'] },
      { docs: 'https://ffmpeg.org/download.html' },
    ];
    expect(renderInstallHints(hints, 'macos').commands).toEqual(['brew install ffmpeg']);
    expect(renderInstallHints(hints, 'linux').commands).toEqual(['brew install ffmpeg', 'sudo apt install ffmpeg']);
    // npm is not shown on Windows, even for a hint that names it: npm installs a
    // tool there as `.cmd` scripts, which no action can start (D-321 audit).
    expect(renderInstallHints(hints, 'windows').commands).toEqual([
      'winget install Gyan.FFmpeg', 'scoop install ffmpeg',
    ]);
    expect(renderInstallHints(hints, 'windows').docs).toEqual(['https://ffmpeg.org/download.html']);
    expect(renderInstallHints([{ manager: 'npm', package: 'opencode-ai' }], 'windows').commands).toEqual([]);
  });

  it('never show an entry that does not pass, whatever a stored catalog carries', () => {
    const shown = renderInstallHints([
      { manager: 'curl', package: 'https://example.com/install.sh' },
      // A manager not on the list, with a package name that would pass.
      { manager: 'curl', package: 'evil-tool' },
      { manager: 'constructor', package: 'evil-tool' },
      { manager: '__proto__', package: 'evil-tool' },
      { manager: 'npm', package: '; rm -rf ~' },
      { manager: 'npm', package: '--global-style' },
      { manager: 'npm', package: 'ok-tool', systems: ['plan9'] },
      { manager: 'npm', package: 'ok-tool', systems: 'linux' },
      { docs: 'http://example.com/docs' },
      { docs: 'https://user:secret@example.com/docs' },
      { docs: 'not a url' },
      null,
      'npm install -g evil',
      ['npm', 'evil'],
    ], 'linux');
    expect(shown).toEqual({ commands: [], docs: [] });
  });

  it('list each command once, in the order the pack gives them', () => {
    expect(renderInstallHints([
      { manager: 'npm', package: 'a' },
      { manager: 'npm', package: 'a', systems: ['linux'] },
      { manager: 'pip', package: 'b' },
    ], 'linux').commands).toEqual(['npm install -g a', 'pip install b']);
    expect(renderInstallHints(undefined, 'linux')).toEqual({ commands: [], docs: [] });
  });

  it("the server's system comes from its platform", () => {
    expect(cliInstallSystemOf('darwin')).toBe('macos');
    expect(cliInstallSystemOf('win32')).toBe('windows');
    expect(cliInstallSystemOf('linux')).toBe('linux');
    expect(cliInstallSystemOf('freebsd')).toBe('linux');
  });
});

describe('a stored catalog, checked again where it is used (D-321 audit)', () => {
  it('reads a range only when it is one', () => {
    expect(readCliToolVersionPolicy({ tested: { from: '1.18.35', before: '2.0.0' }, outside: 'refuse' }))
      .toEqual({ tested: { from: '1.18.35', before: '2.0.0' }, outside: 'refuse' });
    expect(readCliToolVersionPolicy({ tested: { from: '0.161.0' }, outside: 'warn' }))
      .toEqual({ tested: { from: '0.161.0' }, outside: 'warn' });
    for (const bad of [
      undefined, null, 'refuse', [], {},
      { outside: 'refuse' },
      { tested: null, outside: 'refuse' },
      { tested: { before: '2.0.0' }, outside: 'refuse' },
      { tested: { from: 1 }, outside: 'refuse' },
      { tested: { from: '1.x' }, outside: 'refuse' },
      { tested: { from: '2.0.0', before: '1.0.0' }, outside: 'refuse' },
      { tested: { from: '1.0.0', before: 2 }, outside: 'refuse' },
      { tested: { from: '1.0.0' }, outside: 'maybe' },
    ]) {
      expect(readCliToolVersionPolicy(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('reads a probe only when it is a list of words', () => {
    expect(readCliProbe(['opencode', '--version'])).toEqual(['opencode', '--version']);
    for (const bad of [undefined, 'opencode --version', [], [''], ['opencode', 3], {}]) {
      expect(readCliProbe(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('gives the gateway a range only with its probe, and hints only as a list', () => {
    const version = { tested: { from: '1.18.35', before: '2.0.0' }, outside: 'refuse' };
    expect(cliToolPolicyOfRuntime({ cli_version: version, cli_probe: ['opencode', '--version'], cli_install: [] }))
      .toEqual({ tool_version: { probe: ['opencode', '--version'], version }, tool_install: [] });
    expect(cliToolPolicyOfRuntime({ cli_version: version })).toEqual({});
    expect(cliToolPolicyOfRuntime({ cli_version: { tested: {} }, cli_probe: ['opencode', '--version'] })).toEqual({});
    expect(cliToolPolicyOfRuntime({ cli_install: 'npm install -g evil' })).toEqual({});
    expect(cliToolPolicyOfRuntime(undefined)).toEqual({});
  });

  it('never throws on install hints or a range that are not what they should be', () => {
    // Before the audit, these threw: inside a launch's error handler, that stopped the server.
    for (const hints of ['npm install -g evil', 42, { manager: 'npm' }, null]) {
      expect(renderInstallHints(hints, 'linux')).toEqual({ commands: [], docs: [] });
    }
    const broken = { from: 3, before: '2.0.0' } as unknown as CliToolVersionPolicy['tested'];
    expect(renderInstallHints([{ manager: 'npm', package: 'opencode-ai' }], 'linux', broken).commands)
      .toEqual(['npm install -g opencode-ai']);
  });
});
