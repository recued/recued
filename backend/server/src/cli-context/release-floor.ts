/** `recued release-floor raise --bin-dir <dir> --sequence <n>` — advance the
 *  install-wide anti-replay floor UNDER ITS LOCK, for a caller that is not a
 *  Node process.
 *
 *  ⛔⛔ WHY: I ADDED A SECOND WRITER AND LEFT IT OUTSIDE THE LOCK. When the server
 *  became a writer of `.release-sequence`, `install.sh` kept its own
 *  read-compare-rename. I wrote in `host-sequence-floor.ts` that this was bounded
 *  — "both writers only ever RAISE, each write is atomic, so the file never moves
 *  backwards" — and that is FALSE. It never goes below what THAT WRITER read,
 *  which is a different claim:
 *
 *      floor = 100
 *      shell  reads 100, decides 200 is higher            (no lock)
 *      server takes the lock, writes 300, releases
 *      shell  renames 200 into place                      -> floor is now 200
 *
 *  An atomic rename prevents a TORN file, not a lost update. The floor moved
 *  backwards from 300 to 200, and a replayed manifest at 250 is accepted again.
 *
 *  🔑 SAME ANSWER AS THE LEASE: CALL THE RULE. `advanceHostSequenceFloor` already
 *  does the read-modify-write under `<floor>.lock`; the shell asks it rather than
 *  growing a second copy of the compare.
 *
 *  ⚠ CONTENTION IS RETRIED, BRIEFLY, RATHER THAN REPORTED. The critical section
 *  is a read and a rename — microseconds — so a busy lock means another process
 *  is mid-advance on the same file and will be gone almost immediately. Handing
 *  `contended` back to a shell whose only fallback is the unlocked write it just
 *  stopped doing would put the race back exactly where it was found.
 *
 *  Exit status: 0 the floor is at or above `--sequence`; 20 it could not be
 *  written (unwritable prefix, bad arguments, or still contended after retries).
 *  Never fatal to a caller — the floor is a hardening measure, not a gate on
 *  whether an owner gets their server.
 */
import type { BootTrace } from '../cli/boot-trace.js';
import { getArg, parsePositionals } from '../cli/parse.js';
import {
  advanceHostSequenceFloor,
  hostSequenceFloorPathFor,
  readHostSequenceFloor,
} from '../update/host-sequence-floor.js';

export const FLOOR_RAISED = 0;
export const FLOOR_UNAVAILABLE = 20;

/** Bounded, because a caller that cannot make progress must still finish. */
const CONTENDED_ATTEMPTS = 5;
const CONTENDED_PAUSE_MS = 40;

export interface ReleaseFloorProfileOptions {
  args: string[];
  bootTrace: BootTrace;
  exit?: (code: number) => void;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export async function runReleaseFloorProfile(options: ReleaseFloorProfileOptions): Promise<void> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  if (parsePositionals(options.args)[1] !== 'raise') {
    log('release-floor: expected `raise`');
    exit(FLOOR_UNAVAILABLE);
    return;
  }
  const binDir = getArg(options.args, 'bin-dir');
  if (binDir === undefined || binDir === '') {
    log('release-floor: --bin-dir <dir> is required');
    exit(FLOOR_UNAVAILABLE);
    return;
  }
  const sequence = Number(getArg(options.args, 'sequence'));
  if (!Number.isInteger(sequence) || sequence < 0) {
    log('release-floor: --sequence <n> must be a non-negative integer');
    exit(FLOOR_UNAVAILABLE);
    return;
  }

  const floorPath = hostSequenceFloorPathFor(binDir.replace(/\/+$/, ''));
  for (let attempt = 1; ; attempt += 1) {
    const outcome = advanceHostSequenceFloor(floorPath, sequence);
    if (outcome === 'advanced' || outcome === 'unchanged') {
      options.bootTrace.mark('release-floor', outcome);
      exit(FLOOR_RAISED);
      return;
    }
    if (outcome === 'contended' && attempt < CONTENDED_ATTEMPTS) {
      await sleep(CONTENDED_PAUSE_MS);
      continue;
    }
    // ⚠ REPORT WHERE THE FLOOR ACTUALLY IS. "Could not raise it to 200" reads as
    // "the floor is unprotected"; it may well already be 300 because the process
    // we lost to put it there, which is not a problem at all.
    log(`release-floor: could not raise the floor to ${sequence} (${outcome}); `
      + `it currently reads ${readHostSequenceFloor(floorPath)}`);
    options.bootTrace.mark('release-floor', outcome);
    exit(FLOOR_UNAVAILABLE);
    return;
  }
}
