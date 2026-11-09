/** D-321 — a program the server's PATH does not reach, found where installers
 *  put programs (`cli-path-diagnosis.ts`; internal design notes § 2.1).
 *  A LaunchAgent's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`, so a program from
 *  Homebrew, pipx or npm read "Not installed" and the page offered to install it
 *  again. */

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findProgramOutsidePath, installerRepairCommand, programOutsidePath } from '../cli-path-diagnosis.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A home with one runnable program in `~/.local/bin`, where pipx puts it. */
const homeWith = (name: string): { home: string; file: string } => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'recued-d321-outside-')));
  homes.push(home);
  const dir = join(home, '.local', 'bin');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  return { home, file };
};

const TOOL = 'recued-d321-stub-tool';

describe.skipIf(process.platform === 'win32')("D-321 — a program outside the server's PATH", () => {
  it('is found in a usual install folder that the PATH leaves out', () => {
    const { home, file } = homeWith(TOOL);
    expect(findProgramOutsidePath(TOOL, { home, path: '/usr/bin:/bin:/usr/sbin:/sbin', platform: 'darwin' })).toBe(file);
  });

  it('is not reported when its folder is on the PATH, or when the pack names it by path', () => {
    const { home, file } = homeWith(TOOL);
    const onPath = `/usr/bin:${join(home, '.local', 'bin')}`;
    expect(findProgramOutsidePath(TOOL, { home, path: onPath, platform: 'linux' })).toBeUndefined();
    expect(findProgramOutsidePath(file, { home, path: '/usr/bin', platform: 'darwin' })).toBeUndefined();
  });

  it("offers the installer re-run, on the server's own channel, only when the installer started the server", () => {
    const { home, file } = homeWith(TOOL);
    const base = { home, path: '/usr/bin:/bin', platform: 'darwin' as const };
    expect(programOutsidePath(TOOL, { ...base, startedByInstaller: () => false })).toEqual({ found_at: file });
    expect(programOutsidePath(TOOL, { ...base, startedByInstaller: () => true, channel: 'edge' })).toEqual({
      found_at: file,
      repair: 'curl -fsSL https://recued.com/install.sh | RECUED_CHANNEL=edge sh',
    });
    // A plain re-run means stable; a channel that is not one is never written into the command.
    expect(installerRepairCommand('stable')).toBe('curl -fsSL https://recued.com/install.sh | sh');
    expect(installerRepairCommand('edge; rm -rf ~')).toBe('curl -fsSL https://recued.com/install.sh | sh');
  });
});
