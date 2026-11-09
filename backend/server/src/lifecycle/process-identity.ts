/** Which process a PID names, beyond the number.
 *
 *  ⛔⛔ A PID IS NOT AN IDENTITY. The kernel gives a dead process's number to a
 *  later one: after a reboot, from the same early range, and on a machine that
 *  has run long enough for the numbers to wrap. A realm lock or pidfile left by
 *  an unclean exit (a crash, a power loss, a stop timeout's SIGKILL) then names
 *  whatever holds that number now. Measured on 26.11.3 (2026-11-06): a realm
 *  lock naming a live `sleep` on the same port made `recued serve` exit 4, which
 *  every supervisor reads as "halt", made `recued status` call the `sleep` the
 *  running server, and made `recued stop` SIGTERM it.
 *
 *  🔑 WHAT A REUSED NUMBER CANNOT SHARE IS WHEN ITS PROCESS STARTED, read here
 *  in forms no clock change moves: on Linux the start tick since boot plus the
 *  boot's id, on macOS the start stamp the kernel kept at fork, printed in UTC
 *  so the reader's zone cannot change the string. Compared for EQUALITY only,
 *  never ordered against a clock — a clock stepped between a start and a check
 *  would make any ordering lie.
 *
 *  ⚠ `null` MEANS UNKNOWN: Windows, no `ps`, a process that has already gone.
 *  Callers then fall back to the PID alone, which is what they did before this
 *  existed. Unknown never proves a holder gone. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const processStartIdentity = (
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Field 22 of `stat`, counted from the field after the command name,
      // which is parenthesised and may itself contain spaces.
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      if (start === undefined || !/^\d+$/.test(start)) return null;
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return `linux:${boot}:${start}`;
    }
    if (platform === 'darwin') {
      const started = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        env: { PATH: '/bin:/usr/bin', TZ: 'UTC', LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      }).trim();
      return started.length > 0 ? `darwin:${started}` : null;
    }
  } catch {
    // Gone, or unreadable: unknown, never "a different process".
  }
  return null;
};

/** Is `pid` provably no longer the process that recorded `recordedStart`?
 *
 *  `true` only when both sides are known and differ. A record written before
 *  start identities were kept, or a platform that cannot say, answers `false`,
 *  so the caller keeps its PID-only verdict. */
export const pidWasReused = (
  pid: number,
  recordedStart: string | undefined,
  identify: (pid: number) => string | null = processStartIdentity,
): boolean => {
  if (recordedStart === undefined || recordedStart.length === 0) return false;
  const current = identify(pid);
  return current !== null && current !== recordedStart;
};
