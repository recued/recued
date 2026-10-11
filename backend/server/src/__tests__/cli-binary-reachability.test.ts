/** D-182 — proactive cli-tool readiness: the spawn-free binary-on-PATH probe.
 *  Hermetic — `isExecutable` / `path` / `delimiter` / `platform` are injected, so
 *  no real filesystem or host PATH is touched. */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createCliBinaryPathResolver, createCliBinaryReachabilityProbe } from '../cli-binary-reachability.js';

describe('cli binary reachability probe', () => {
  it('finds a bare binary on a PATH dir', () => {
    const probe = createCliBinaryReachabilityProbe({
      platform: 'linux',
      path: '/usr/bin:/usr/local/bin',
      delimiter: ':',
      isExecutable: (p) => p === '/usr/local/bin/whisper',
    });
    expect(probe('whisper')).toBe(true);
  });

  it('returns false for a binary on no PATH dir', () => {
    const probe = createCliBinaryReachabilityProbe({
      platform: 'linux',
      path: '/usr/bin:/usr/local/bin',
      delimiter: ':',
      isExecutable: () => false,
    });
    expect(probe('whisper')).toBe(false);
  });

  it('checks a path-bearing entry_point directly — no PATH walk', () => {
    const seen: string[] = [];
    const probe = createCliBinaryReachabilityProbe({
      platform: 'linux',
      path: '/usr/bin',
      delimiter: ':',
      isExecutable: (p) => {
        seen.push(p);
        return p === '/opt/tool/bin/run';
      },
    });
    expect(probe('/opt/tool/bin/run')).toBe(true);
    // Resolved as-is; never joined onto a PATH dir.
    expect(seen).toEqual(['/opt/tool/bin/run']);
  });

  it('an empty tool key is never reachable', () => {
    const probe = createCliBinaryReachabilityProbe({ isExecutable: () => true });
    expect(probe('')).toBe(false);
  });

  it('on Windows, resolves a bare binary as Node starts one without a shell: .com, then .exe', () => {
    const seen: string[] = [];
    const resolve = createCliBinaryPathResolver({
      platform: 'win32',
      path: 'C:\\bin',
      delimiter: ';',
      isExecutable: (p) => {
        seen.push(p);
        return p === 'C:\\bin\\ffmpeg.exe';
      },
    });
    expect(resolve('ffmpeg')).toBe('C:\\bin\\ffmpeg.exe');
    expect(seen).toEqual(['C:\\bin\\ffmpeg.com', 'C:\\bin\\ffmpeg.exe']);
    // A name that already carries a launchable extension is taken as given.
    expect(resolve('ffmpeg.exe')).toBe('C:\\bin\\ffmpeg.exe');
  });

  it('on Windows, a .cmd or .bat script is never a match, whatever PATHEXT says (npm installs these)', () => {
    const resolve = createCliBinaryPathResolver({
      platform: 'win32',
      path: 'C:\\Users\\o\\AppData\\Roaming\\npm',
      delimiter: ';',
      isExecutable: (p) => /opencode(\.cmd|\.ps1)?$/iu.test(p),
    });
    expect(resolve('opencode')).toBeUndefined();
    expect(resolve('opencode.cmd')).toBeUndefined();
  });

  it('takes absolute PATH entries only: a relative one reads from the working folder, a repository\'s', () => {
    const probe = createCliBinaryReachabilityProbe({
      platform: 'linux',
      path: 'node_modules/.bin:./bin:/usr/bin',
      delimiter: ':',
      isExecutable: (p) => p === 'node_modules/.bin/opencode' || p === 'bin/opencode' || p === './bin/opencode',
    });
    expect(probe('opencode')).toBe(false);
  });

  it('on the real filesystem, passes over a folder named like the tool, as a launch does', () => {
    const first = mkdtempSync(join(tmpdir(), 'recued-reach-a-'));
    const second = mkdtempSync(join(tmpdir(), 'recued-reach-b-'));
    try {
      mkdirSync(join(first, 'opencode'));
      writeFileSync(join(second, 'opencode'), '#!/bin/sh\n');
      chmodSync(join(second, 'opencode'), 0o755);
      const resolve = createCliBinaryPathResolver({ platform: 'linux', path: `${first}:${second}`, delimiter: ':' });
      expect(resolve('opencode')).toBe(join(second, 'opencode'));
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('does NOT honour an empty PATH segment as CWD (deliberate — CWD-in-PATH is a footgun)', () => {
    const probe = createCliBinaryReachabilityProbe({
      platform: 'linux',
      path: ':/usr/bin', // leading empty segment = CWD on POSIX
      delimiter: ':',
      isExecutable: (p) => p === 'whisper', // as if ./whisper existed in the CWD
    });
    // The empty segment is dropped, so only /usr/bin is searched → not reachable.
    expect(probe('whisper')).toBe(false);
  });

  it('on POSIX, a bare name needs no extension (PATHEXT is Windows-only)', () => {
    const probe = createCliBinaryReachabilityProbe({
      platform: 'linux',
      path: '/usr/bin',
      delimiter: ':',
      isExecutable: (p) => p === '/usr/bin/docling',
    });
    expect(probe('docling')).toBe(true);
  });
});
