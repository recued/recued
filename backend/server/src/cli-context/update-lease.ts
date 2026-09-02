/** `recued update-lease claim|release` — the host-wide update mutex, for a
 *  caller that is not a Node process.
 *
 *  ⛔⛔ WHY THIS EXISTS: install.sh READ THE LEASE AND NEVER TOOK IT, and the
 *  comment explaining that was half a good argument. It said claiming correctly
 *  means the atomic `link()` dance in `update-lease.ts`, and that "a second
 *  implementation of a mutex in shell is worth less than no implementation — it
 *  would look like exclusion while racing differently". Both true. The
 *  conclusion — so read only — is what left the gap: the already-current repair
 *  path writes the anti-replay floor, may replace the whole webclient bundle,
 *  configures autostart and exits, all under `$PREFIX`, holding nothing.
 *
 *  🔑 THE THIRD OPTION IS TO CALL THE RULE. Not a second mutex, not no mutex —
 *  the one implementation, invoked. Same answer `managed-launcher.ts` reached
 *  when its private copy of the revert drifted: move the rule into the payload
 *  and have the frozen half ask for the ACT.
 *
 *  ⛔ THE HOLDER IS THE CALLER, NOT THIS PROCESS. `--pid` is written into the
 *  lease, so liveness is judged against the shell that will still be running
 *  when this command has exited. Claiming under our own pid would produce a
 *  lease that is stale the instant it is taken — the exact opposite of the
 *  guarantee — and every subsequent actor would reclaim it.
 *
 *  ⚠ SO THE CLAIM DELIBERATELY DOES NOT RELEASE ON EXIT. The lease file must
 *  outlive this process; the caller releases it from its own trap, quoting the
 *  token printed on stdout. If the caller dies instead, the pid is dead and the
 *  standard stale-reclaim path takes over — which is the same recovery every
 *  other holder gets.
 *
 *  Exit status — claim: 0 taken (token on stdout); 10 held by a live process
 *  (the caller should stand down and try later); 20 not takeable at all
 *  (unwritable directory, bad arguments). Release: always 0 — a releaser that
 *  fails is a lease that will be reclaimed as stale, never a reason to fail the
 *  caller's own work.
 */
import { dirname } from 'node:path';
import type { BootTrace } from '../cli/boot-trace.js';
import { getArg, parsePositionals } from '../cli/parse.js';
import {
  acquireUpdateLease,
  releaseUpdateLeaseByToken,
  updateLeasePathFor,
  UpdateLeaseHeldError,
} from '../update/update-lease.js';

/** Shared with the supervisor verbs: 0 go, 10 come back, 20 stop. */
export const LEASE_TAKEN = 0;
export const LEASE_HELD = 10;
export const LEASE_UNAVAILABLE = 20;

export interface UpdateLeaseProfileOptions {
  args: string[];
  bootTrace: BootTrace;
  exit?: (code: number) => void;
  log?: (message: string) => void;
  /** stdout — the token, and nothing else, so `$(…)` captures it directly. */
  out?: (text: string) => void;
}

export async function runUpdateLeaseProfile(options: UpdateLeaseProfileOptions): Promise<void> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const out = options.out ?? ((text: string) => process.stdout.write(text));
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const action = parsePositionals(options.args)[1];
  // ⛔ PASSED, NOT DERIVED. `process.execPath` is right for a packaged binary and
  // wrong the moment this is reached through a wrapper — the same trap the revert
  // verb documents. The installer knows its own $PREFIX for certain.
  const binDir = getArg(options.args, 'bin-dir');
  if (binDir === undefined || binDir === '') {
    log('update-lease: --bin-dir <dir> is required');
    exit(LEASE_UNAVAILABLE);
    return;
  }
  const leasePath = updateLeasePathFor(`${binDir.replace(/\/+$/, '')}/recued`);

  if (action === 'release') {
    const token = getArg(options.args, 'token') ?? '';
    const dropped = releaseUpdateLeaseByToken(leasePath, token);
    options.bootTrace.mark('update-lease', dropped ? 'released' : 'not-ours');
    exit(LEASE_TAKEN);
    return;
  }

  if (action !== 'claim') {
    log('update-lease: expected `claim` or `release`');
    exit(LEASE_UNAVAILABLE);
    return;
  }

  const pidText = getArg(options.args, 'pid');
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) {
    log('update-lease: --pid <pid> is required, and must be the CALLER\'s pid');
    exit(LEASE_UNAVAILABLE);
    return;
  }

  try {
    const lease = acquireUpdateLease({
      leasePath,
      operation: getArg(options.args, 'operation') ?? 'install',
      currentPid: () => pid,
    });
    // ⚠ A RE-ENTRANT LEASE HAS NO TOKEN and owns nothing to release. That is the
    // honest answer to "this caller already holds it": go ahead, release nothing.
    options.bootTrace.mark('update-lease', lease.reentrant ? 'reentrant' : 'claimed');
    out(lease.token);
    exit(LEASE_TAKEN);
  } catch (err) {
    if (err instanceof UpdateLeaseHeldError) {
      log(`update-lease: held by pid ${err.holder.pid} (${err.holder.operation})`);
      options.bootTrace.mark('update-lease', 'held');
      exit(LEASE_HELD);
      return;
    }
    log(`update-lease: cannot take the lease at ${leasePath}: `
      + `${err instanceof Error ? err.message : String(err)}`);
    options.bootTrace.mark('update-lease', 'unavailable');
    exit(LEASE_UNAVAILABLE);
  }
}
