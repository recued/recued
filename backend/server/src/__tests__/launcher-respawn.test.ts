/** ⛔⛔ THE LAUNCHER'S RETRY LOOP DID NOT LOOP, AND EVERYTHING BELIEVED IT DID.
 *
 *  `recued-server-launcher.sh` opens with `set -eo pipefail` and then runs the
 *  server as a BARE command in a `while true` body. Under `set -e` an unhandled
 *  non-zero exits the shell, so the script ran the server exactly ONCE and died
 *  the moment it exited 3 — every branch of its `case` was unreachable for a
 *  non-zero status, and the whole retry contract the file exists for did nothing.
 *
 *  ⚠ IT WAS BELIEVED BY READING. D-188 excluded `native` from the supervised
 *  modes with a wrong stated reason ("bare process") but the right practical
 *  one. Then I read the loop, reported that it respawns, and the owner decided
 *  `native` is supervised on that evidence. Reading the loop says it retries;
 *  RUNNING it said otherwise. This file is the difference.
 *
 *  🔑 `native` in `SUPERVISOR_MODES_THAT_RESPAWN` now rests on these assertions:
 *  the webclient shows a Restart button for `native`, and `update.apply` no
 *  longer refuses there — both are wrong the moment this script stops looping. */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LAUNCHER = resolve(
  import.meta.dirname,
  '../../scripts/recued-server-launcher.sh',
);

describe('recued-server-launcher.sh honours the exit-code contract', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'recued-launcher-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** A stand-in server. Counts its boots in a file so the script's own respawns
   *  are observable from outside, then exits with `code` until `stopAfter`. */
  const stubBinary = (code: number, stopAfter: number): string => {
    const counter = join(dir, 'boots.txt');
    const path = join(dir, 'stub.sh');
    writeFileSync(
      path,
      '#!/bin/sh\n'
      + `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}\n`
      + 'echo "boot $n"\n'
      + `[ "$n" -ge ${stopAfter} ] && exit 0\n`
      + `exit ${code}\n`,
    );
    chmodSync(path, 0o755);
    return path;
  };

  const run = (bin: string) =>
    spawnSync('bash', [LAUNCHER], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        RECUED_SERVER_BIN: bin,
        RECUED_LAUNCHER_BACKOFF_MS: '20',
      },
    });

  it('⛔ RESPAWNS on 3 (restart requested) — the property `native` rests on', () => {
    const r = run(stubBinary(3, 3));
    // Three boots means it came back twice on its own. Before the fix this was
    // 1: the script died on the first non-zero without reaching its `case`.
    expect(r.stdout).toContain('boot 3');
    expect((r.stdout.match(/restart requested \(3\)\. Respawning\./g) ?? [])).toHaveLength(2);
    expect(r.status).toBe(0);
  });

  it('respawns on an ordinary crash too', () => {
    const r = run(stubBinary(1, 2));
    expect(r.stdout).toContain('boot 2');
    expect(r.stdout).toMatch(/exited 1\. Respawning\./);
    expect(r.status).toBe(0);
  });

  it('STOPS on 0 without respawning — a clean shutdown is not a restart', () => {
    const r = run(stubBinary(0, 1));
    expect(r.stdout).toContain('boot 1');
    expect(r.stdout).not.toContain('boot 2');
    expect(r.stdout).toMatch(/exited cleanly \(0\)\. Stopping\./);
    expect(r.status).toBe(0);
  });

  it('STOPS on 4 (lock held) and exits 4 — another instance owns the port', () => {
    // ⚠ Looping here would fight the instance that legitimately holds the lock,
    // forever, which is why 4 is its own branch rather than "any non-zero".
    const r = run(stubBinary(4, 99));
    expect(r.stdout).toContain('boot 1');
    expect(r.stdout).not.toContain('boot 2');
    expect(r.stdout).toMatch(/lock held \(4\)/);
    expect(r.status).toBe(4);
  });
});
