/** ⛔⛔ THREE REALMS ON ONE MACHINE IN TWENTY-FIVE MINUTES.
 *
 *  The default was `./recued-server.db`, repeated at eleven call sites, so the
 *  realm a command opened depended on the operator's working directory. On a
 *  live droplet 2026-08-31 that produced `/recued-server.db` (systemd, cwd=/),
 *  `/root/recued-server.db`, and `/usr/local/lib/recued/recued-server.db` — and
 *  the systemd unit came up on a database it had just created, printed a fresh
 *  pairing code, and reported success. The owner's realm looked lost.
 *
 *  These drive the resolver with injected deps rather than the real filesystem:
 *  the whole defect is a decision about WHICH path, and a decision is exactly
 *  what a pure function can be pinned on. */

import { describe, expect, it } from 'vitest';

import { resolveRealmDbPath, standardRealmDbPath } from '../realm-db-path.js';

const linuxRoot = (present: string[] = []) => ({
  platform: 'linux' as NodeJS.Platform,
  env: {},
  homedir: () => '/root',
  uid: () => 0,
  exists: (p: string) => present.includes(p),
  mkdir: () => {},
  note: () => {},
});

describe('the realm database path is a decision, not a side effect of cwd', () => {
  it('an explicit --db/DB_PATH wins verbatim, even when the standard exists', () => {
    const deps = linuxRoot(['/var/lib/recued/recued-server.db']);
    // The operator named a path; that IS the answer to the question this asks.
    expect(resolveRealmDbPath('/tmp/mine.db', deps)).toBe('/tmp/mine.db');
  });

  it('uses the standard path when it exists, whatever the cwd', () => {
    // ⛔ NO `cwd` IS PASSED, AND THAT IS THE ASSERTION. `RealmPathDeps` has no
    // such input — "the one default per platform. No CWD anywhere in it." — so
    // handing the resolver a cwd it never reads would prove nothing about the
    // property this names, while type-checking as an excess property and failing
    // the release's `typecheck:tests` gate. Being unable to express the cwd IS
    // the guarantee; a real cwd drive belongs in a test that chdir's.
    const std = '/var/lib/recued/recued-server.db';
    expect(resolveRealmDbPath(undefined, linuxRoot([std]))).toBe(std);
  });

  it('an absent designated path means a NEW realm, not a refusal', () => {
    // A pure refusal is unshippable: on a new machine the designated path is
    // always absent, so refusing would mean no realm could ever be created.
    const made: string[] = [];
    const notes: string[] = [];
    const deps = {
      ...linuxRoot([]),
      mkdir: (p: string) => { made.push(p); },
      note: (m: string) => { notes.push(m); },
    };
    expect(resolveRealmDbPath(undefined, deps)).toBe('/var/lib/recued/recued-server.db');
    expect(made).toContain('/var/lib/recued');
    // Worth one log line — the silence around a realm being born is what cost
    // three realms on one machine — and nothing more than a line.
    expect(notes.join('\n')).toContain('/var/lib/recued/recued-server.db');
    expect(notes).toHaveLength(1);
  });

  it('a database in ANOTHER directory is ignored, never consulted', () => {
    // No multi-location scan: the only paths that matter are the explicit one
    // and the designated one. `/recued-server.db` here is the droplet's stray.
    const deps = linuxRoot(['/recued-server.db', '/root/recued-server.db']);
    expect(resolveRealmDbPath(undefined, deps)).toBe('/var/lib/recued/recued-server.db');
    expect(() => resolveRealmDbPath(undefined, deps)).not.toThrow();
  });

  it('one default per platform, none of them derived from cwd', () => {
    expect(standardRealmDbPath(linuxRoot())).toBe('/var/lib/recued/recued-server.db');
    expect(standardRealmDbPath({ ...linuxRoot(), uid: () => 1000, homedir: () => '/home/a' }))
      .toBe('/home/a/.local/share/recued/recued-server.db');
    expect(standardRealmDbPath({
      platform: 'linux', env: { XDG_DATA_HOME: '/xdg' }, uid: () => 1000, homedir: () => '/home/a',
    })).toBe('/xdg/recued/recued-server.db');
    expect(standardRealmDbPath({ platform: 'darwin', env: {}, homedir: () => '/Users/a' }))
      .toBe('/Users/a/Library/Application Support/recued/recued-server.db');
    expect(standardRealmDbPath({
      platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, homedir: () => 'C:\\Users\\a',
    })).toContain('recued');
  });
});
