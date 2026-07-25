/** D-182 — proactive cli-tool readiness: the spawn-free binary-on-PATH probe.
 *  Hermetic — `isExecutable` / `path` / `delimiter` / `platform` are injected, so
 *  no real filesystem or host PATH is touched. */

import { describe, expect, it } from 'vitest';

import { createCliBinaryReachabilityProbe } from '../cli-binary-reachability.js';

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

  it('on Windows, resolves a bare binary via a PATHEXT suffix', () => {
    const probe = createCliBinaryReachabilityProbe({
      platform: 'win32',
      path: 'C:\\bin',
      delimiter: ';',
      pathext: '.EXE;.CMD',
      // endsWith (not ===) so the assertion survives the host path separator.
      isExecutable: (p) => p.endsWith('ffmpeg.EXE'),
    });
    expect(probe('ffmpeg')).toBe(true);
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
      pathext: '.EXE', // ignored on POSIX
      isExecutable: (p) => p === '/usr/bin/docling',
    });
    expect(probe('docling')).toBe(true);
  });
});
