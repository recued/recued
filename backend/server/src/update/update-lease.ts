/** Cross-process mutual exclusion for update work (audit finding 5).
 *
 *  WHAT WAS WRONG. `runApply` read the ledger for an in-flight release and then,
 *  separately, appended `apply_started`; `jsonl-ledger`'s `append` is a bare
 *  `appendFileSync` with no claim of any kind. Two processes — a server and a
 *  CLI, or two CLIs — could both read "nothing in flight", both proceed, and both
 *  write the same fixed `.staged` / `.old` paths. The CLI made it worse by
 *  checking the SERVER lock once and then spending minutes resolving and
 *  downloading while holding nothing.
 *
 *  ⛔⛔ AND THE OBVIOUS PRIMITIVE DOES NOT WORK. `lifecycle/instance-lock.ts`
 *  looks like the thing to reuse, but its `claim()` is `parseLockFile()` followed
 *  by `writeFileSync()` — a check-then-act with exactly the race being fixed
 *  here. It is sound for its own job (one long-lived server, re-checked on boot)
 *  and unsound as a mutex. Hence a separate primitive rather than a shared one.
 *
 *  🔑 THE CLAIM IS `link()`, NOT `open('wx')` — AND THE DIFFERENCE IS A REAL BUG
 *  THIS FILE ONCE HAD. `wx` is atomic about CREATING the file, but the contents
 *  are written afterwards, so the lease is briefly visible EMPTY. A second
 *  process arriving in that window read it as illegible, took the
 *  reclaim-a-corrupt-lease path, UNLINKED THE WINNER'S FILE and claimed its own.
 *  Two holders, from a lock that looked atomic. Reproduced deterministically by
 *  pausing one process between the open and the write; observed in the wild as
 *  3 winners out of 8 racing processes on a machine whose timing differed from
 *  the author's, where 12 consecutive local runs had shown 0 failures.
 *
 *  ⇒ Write the payload to a temp file FIRST, then `link()` it into place.
 *  `link` is atomic and fails EEXIST, and the lease therefore never exists in a
 *  partially-written state. That in turn removes the need to reclaim an
 *  illegible lease at all — which is what closes the hole, because that reclaim
 *  path WAS the hole.
 *
 *  ⚠ 0/12 LOCAL RUNS IS NOT A PROOF OF ABSENCE. The race is timing-dependent and
 *  this machine hid it completely. What settles it is the deterministic probe of
 *  the window, not the sampled race — see `update-lease-concurrency.test.ts`.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, linkSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface UpdateLeaseHolder {
  pid: number;
  /** What the holder is doing — surfaced in the refusal, never parsed. */
  operation: string;
  /** Unix ms when the lease was taken. */
  at: number;
  /** Per-acquisition ownership proof — see `release()`. */
  token: string;
}

export interface UpdateLease {
  /** Idempotent. A re-entrant lease (same process, already holding) releases
   *  nothing — the outermost holder owns the file. */
  release(): void;
  readonly path: string;
  readonly reentrant: boolean;
  /** This acquisition's ownership proof. Empty on a re-entrant lease, which owns
   *  nothing to prove.
   *
   *  ⚠ EXPOSED FOR ONE CALLER: a lease HELD ACROSS PROCESSES. `install.sh` claims
   *  this mutex through the `update-lease` CLI verb and releases it from a trap
   *  in a later process, so it cannot keep the closure — it keeps the token. No
   *  secret: any process that can read the lease can read the token; what it
   *  proves is which ACQUISITION a releaser is talking about. */
  readonly token: string;
}

export class UpdateLeaseHeldError extends Error {
  readonly code = 'UPDATE_LEASE_HELD';
  readonly holder: UpdateLeaseHolder;
  // ⚠ ASSIGNED IN THE BODY, not a `public readonly` constructor parameter.
  // Parameter properties are not erasable syntax, so they make this module
  // unloadable by plain `node` type-stripping — and the multi-process test that
  // proves the claim atomic has to run the REAL module in REAL child processes.
  // A double with two different pids inside one process cannot prove a mutex.
  constructor(holder: UpdateLeaseHolder) {
    super(`update lease held by pid ${holder.pid} (${holder.operation})`);
    this.name = 'UpdateLeaseHeldError';
    this.holder = holder;
  }
}

export interface AcquireUpdateLeaseOptions {
  leasePath: string;
  operation: string;
  now?: () => number;
  currentPid?: () => number;
  /** Liveness. ⚠ EPERM MEANS ALIVE — the signal was refused because the process
   *  belongs to another user, which is precisely a holder we must respect. Only
   *  ESRCH means the lease is stale. Getting this backwards would let a second
   *  updater run under a live one. */
  isAlive?: (pid: number) => boolean;
}

const defaultIsAlive = (pid: number): boolean => {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Drop a lease IFF it still carries `token`. The whole of `release()`, lifted
 *  so a releaser in a DIFFERENT process runs the same rule rather than a second
 *  copy of it.
 *
 *  ⛔ THE IDENTITY CHECK IS THE POINT. A lease reclaimed out from under us as
 *  stale carries a different token, so this can never delete a live holder's
 *  claim — which is precisely the double-unlink that produced two holders when
 *  the reclaim path was unconditional. */
export const releaseUpdateLeaseByToken = (leasePath: string, token: string): boolean => {
  if (token === '') return false;
  if (readHolder(leasePath)?.token !== token) return false;
  try {
    rmSync(leasePath, { force: true });
    return true;
  } catch {
    return false;   // already gone, or not ours to remove
  }
};

const readHolder = (path: string): UpdateLeaseHolder | null => {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<UpdateLeaseHolder>;
    if (typeof raw.pid !== 'number') return null;
    return {
      pid: raw.pid,
      operation: typeof raw.operation === 'string' ? raw.operation : 'unknown',
      at: typeof raw.at === 'number' ? raw.at : 0,
      token: typeof raw.token === 'string' ? raw.token : '',
    };
  } catch {
    // Unreadable or truncated — a half-written lease from a killed process.
    // Treated as "no legible holder" so the stale path can reclaim it.
    return null;
  }
};

/** Who is updating this install right now — or null when nobody is.
 *
 *  ⛔ THE READ SIDE OF THE MUTEX, AND IT IS NOT A CLAIM. Boot and the installer
 *  need to know an update is in flight; neither should TAKE the lease. The lease
 *  is keyed on the BINARY and is therefore host-wide, so a server holding it for
 *  its lifetime would stop every OTHER realm on the machine from updating — and
 *  running two realms on one host is a supported thing to do. They ask instead.
 *
 *  ⚠ A DEAD HOLDER IS NOT A HOLDER, and an illegible file is not either: both
 *  read as "nobody". That is the opposite of `acquireUpdateLease`'s fail-closed
 *  stance on an unreadable lease, deliberately — a WRITER refusing to proceed
 *  costs an update, while a reader refusing to proceed costs a server its boot.
 *  The claim path is what guarantees exclusion; this only reports. */
export const inspectUpdateLease = (
  leasePath: string,
  isAlive: (pid: number) => boolean = defaultIsAlive,
): UpdateLeaseHolder | null => {
  const holder = readHolder(leasePath);
  if (holder === null) return null;
  return isAlive(holder.pid) ? holder : null;
};

/** Take the lease, or throw `UpdateLeaseHeldError`.
 *
 *  Re-entrant WITHIN a process: the CLI takes it around resolve → download →
 *  apply, and `runApply` asks for it again underneath. Same pid → a no-op lease,
 *  so the inner scope cannot release the outer one's file.
 *
 *  ⚠ THE STALE RECLAIM RACES ON PURPOSE, AND THAT IS FINE. Two processes can both
 *  find a dead holder and both unlink; then both retry the `wx` open and exactly
 *  one wins. The loser sees EEXIST with a LIVE holder and refuses, which is the
 *  correct outcome. Only one reclaim attempt is made, so a pathological loop
 *  cannot spin here. */
export const acquireUpdateLease = (opts: AcquireUpdateLeaseOptions): UpdateLease => {
  const {
    leasePath,
    operation,
    now = () => Date.now(),
    currentPid = () => process.pid,
    isAlive = defaultIsAlive,
  } = opts;
  const pid = currentPid();
  // Proves OWNERSHIP, which a pid cannot: after a stale reclaim two processes can
  // share a pid's worth of belief about the same path. `release()` unlinks only
  // when the file still carries OUR token, so a lease that was reclaimed out from
  // under us is never deleted by us.
  const token = randomBytes(12).toString('hex');

  const noop: UpdateLease = { release: () => {}, path: leasePath, reentrant: true, token: '' };

  const tryClaim = (): UpdateLease | null => {
    const staging = `${leasePath}.claim.${pid}.${token}`;
    writeFileSync(
      staging,
      JSON.stringify({ pid, operation, at: now(), token } satisfies UpdateLeaseHolder),
    );
    try {
      // ⛔ ATOMIC, AND THE FILE IS ALREADY COMPLETE. This is the whole fix: no
      // observer can ever see a half-written lease, so no observer can mistake
      // one for corruption and remove it.
      linkSync(staging, leasePath);
    } catch (err) {
      rmSync(staging, { force: true });
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return null;
    }
    rmSync(staging, { force: true });
    // Read back before believing it. Cheap, and it turns any residual
    // double-unlink into a detected loss rather than a silent second holder.
    if (readHolder(leasePath)?.token !== token) return null;
    let released = false;
    return {
      path: leasePath,
      reentrant: false,
      token,
      release: () => {
        if (released) return;
        released = true;
        releaseUpdateLeaseByToken(leasePath, token);   // ⛔ ONLY IF IT IS STILL OURS.
      },
    };
  };

  const first = tryClaim();
  if (first) return first;

  const holder = readHolder(leasePath);
  // ⛔⛔ AN ILLEGIBLE LEASE IS A REFUSAL, NEVER A RECLAIM. Reclaiming one is
  // precisely how this file produced two holders: an empty file is what a
  // mid-claim lease used to look like. With `link()` the lease is always
  // complete the instant it exists, so anything unreadable is either a foreign
  // file or a lease from a build that predates this fix — neither is something
  // to delete on a guess. Fail closed and let a human decide.
  if (holder === null) {
    throw new UpdateLeaseHeldError({
      pid: -1,
      operation: `unreadable lease file at ${leasePath}`,
      at: 0,
      token: '',
    });
  }
  if (holder.pid === pid) return noop;                    // re-entrant
  if (isAlive(holder.pid)) throw new UpdateLeaseHeldError(holder);

  // ⛔⛔⛔ RECLAIMING A DEAD HOLDER IS ITSELF A CRITICAL SECTION, AND MY FIRST
  // VERSION GOT THE REASONING WRONG. It said: "both finders may unlink, but only
  // one can win the `link`, and the loser then sees a LIVE holder and refuses."
  // That is false, because the loser unlinks AFTER the winner has claimed:
  //
  //     A and B both observe stale S (dead)
  //     A: rm S      -> link -> A holds
  //     B: rm A'S LEASE -> link -> B holds        ← two holders
  //
  // The read-back inside `tryClaim` does not catch it either: A's read-back
  // passes before B unlinks. An unconditional `rm` based on an EARLIER
  // observation is the whole bug.
  //
  // 🔑 TWO THINGS FIX IT, AND BOTH ARE NEEDED. Reclaimers are serialised through
  // a second `wx` lock so only one may be in this section at a time; and the
  // unlink is made CONDITIONAL ON IDENTITY — the file must still carry the exact
  // token we judged stale. A fresh holder has a different token, so it can never
  // be the thing we remove.
  //
  // ⚠ IF A RECLAIMER DIES HOLDING THE RECLAIM LOCK, RECLAMATION STOPS. That is
  // deliberate: the alternative is a recursive staleness check with the same race
  // one level down. The lease then needs a human, and the refusal below says so —
  // fail closed, which is the behaviour a lock owes.
  const reclaimPath = `${leasePath}.reclaim`;
  let reclaimFd: number;
  try {
    reclaimFd = openSync(reclaimPath, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Another process is reclaiming, or one died mid-reclaim. Either way this
    // process must not touch the lease.
    throw new UpdateLeaseHeldError({
      pid: holder.pid,
      operation:
        `${holder.operation} (a stale lease is being reclaimed by another process; if none is `
        + `running, remove ${reclaimPath})`,
      at: holder.at,
      token: holder.token,
    });
  }
  try {
    // Re-verify UNDER the reclaim lock: the file must still be the SAME dead
    // lease we judged. Anything else — a new holder, a vanished file, one that
    // came back to life — means this reclaim is no longer ours to make.
    const current = readHolder(leasePath);
    if (current === null || current.token !== holder.token || isAlive(current.pid)) {
      throw new UpdateLeaseHeldError(current ?? holder);
    }
    rmSync(leasePath, { force: true });
    const second = tryClaim();
    if (second) return second;
    throw new UpdateLeaseHeldError(
      readHolder(leasePath) ?? { pid: -1, operation: 'unknown', at: 0, token: '' },
    );
  } finally {
    closeSync(reclaimFd);
    try { rmSync(reclaimPath, { force: true }); } catch { /* best-effort */ }
  }
};


/** Where the lease for a given update target lives.
 *
 *  ⛔⛔ IT GUARDS THE EXECUTABLE, NOT THE REALM. The lease used to sit beside each
 *  realm's database — one derivation in `release-config.ts` keyed on `dataDir`,
 *  another in `cli-context/update.ts` keyed on the db path. But the thing two
 *  updaters collide over is the shared executable and its fixed `.staged` /
 *  `.old` siblings, and a host can run SEVERAL realms against ONE binary. Two
 *  realms therefore held two different locks while racing the same three paths,
 *  which is not exclusion at all — it is two locks and no mutex.
 *
 *  Keyed on the binary's directory, so every process that could mutate that
 *  executable contends for the same file, whatever realm it was started for. */
export const updateLeasePathFor = (binaryPath: string): string =>
  join(dirname(binaryPath), 'recued-update.lock');
