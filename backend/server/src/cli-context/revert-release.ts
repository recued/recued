/** `recued revert-release --bin-dir <dir> --reason <text>` — the revert half of
 *  the outer supervisor for the `docker-thin` channel.
 *
 *  ⛔ THIS IS MEANT TO BE RUN BY `recued.old`, NOT BY THE LIVE BINARY, and it is
 *  the sibling of `report-boot-failure` with the DECISION removed. The two outer
 *  supervisors decide differently and both are right: the binary channel's script
 *  knows only "the payload exited N", so it hands the whole verdict over; the
 *  `docker-thin` launcher re-verifies the payload's signature on every start
 *  (I-2, because the data volume is mutable) and therefore also reverts a current
 *  binary that is MISSING or UNVERIFIABLE — a conclusion no exit code can carry.
 *  So it decides for itself and asks only for the ACT.
 *
 *  🔑 WHY IT IS A COMMAND AND NOT A FUNCTION CALL. `managed-launcher.ts` is the
 *  frozen image entrypoint: it is bundled standalone, imports nothing from the
 *  changing engine, and is rebuilt only when the verification contract itself
 *  changes (I-9). It had its own copy of the revert — and the copy DRIFTED. It
 *  restored the binary pair alone, so a `docker-thin` install whose new release
 *  had already migrated came back on the old binary against the new schema, with
 *  the new webclient in front of it, and `recued.old` consumed so nothing could
 *  retry. Moving the rule into the payload it is reverting TO is the same answer
 *  the binary channel reached, for the same reason: restating it in the frozen
 *  half is how the copies drift.
 *
 *  ⚠ NOT THE OWNER-FACING ROLLBACK. `recued update rollback` is a deliberate
 *  owner action on a healthy, stopped server, refuses while an apply is in
 *  flight, and reports at length. This is a supervisor calling for a recovery it
 *  has already decided on, and answers in an exit code.
 *
 *  Exit status: 0 reverted; 10 another update holds the host-wide lease, so come
 *  back; 20 refused or failed (nothing further this process can do — the caller
 *  halts and the operator has to look).
 */
import { dirname, join } from 'node:path';
import type { BootTrace } from '../cli/boot-trace.js';
import { getArg } from '../cli/parse.js';
import { resolveRealmDbPath } from '../realm-db-path.js';
import {
  revertStagedRelease,
  SUPERVISED_GIVE_UP,
  SUPERVISED_RETRY_AFTER_BACKOFF,
  SUPERVISED_RETRY_NOW,
} from '../update/supervised-boot-failure.js';

export interface RevertReleaseProfileOptions {
  args: string[];
  bootTrace: BootTrace;
  env?: NodeJS.ProcessEnv;
  /** Overridden in tests; production resolves the running binary's own PATH.
   *
   *  ⛔ A PATH, NOT A DIRECTORY. The revert renames `<binary>.old` over
   *  `<binary>`, and on Windows the installer lays that down as `recued.exe` —
   *  a directory plus a hard-coded `recued` looked for a file that never exists
   *  there. See `RevertReleaseInput.binaryPath`. */
  binaryPath?: string;
  exit?: (code: number) => void;
  log?: (message: string) => void;
}

export async function runRevertReleaseProfile(
  options: RevertReleaseProfileOptions,
): Promise<void> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const exit = options.exit ?? ((code: number) => process.exit(code));

  // ⛔ THE CALLER'S REASON IS REQUIRED, because it is what lands on the ledger
  // terminal and it is the only record of WHY a release was downgraded. A
  // default here would write "revert" onto every one of them and lose the
  // distinction between a crash loop and a failed signature — the two cases a
  // reader of that log most needs to tell apart.
  const reason = getArg(options.args, 'reason');
  if (reason === undefined || reason === '') {
    log('revert-release: --reason <text> is required');
    exit(SUPERVISED_GIVE_UP);
    return;
  }

  // ⛔ PASSED EXPLICITLY, NOT RE-DERIVED. `process.execPath` is right for a
  // packaged binary and WRONG the moment `recued.old` is reached through any
  // wrapper — it then looks in the wrapper's interpreter directory, finds no
  // `recued.old`, and reports "nothing to revert to" while a perfectly good one
  // sits beside the caller. Caught on the binary channel by running the real
  // script against the real verdict; the launcher knows `binDir` for certain.
  // ⚠ MIRRORS `resolveUpdateBinaryPath`, and the asymmetry is real rather than
  // sloppy: with `--bin-dir` we are the docker-thin launcher, whose payload is a
  // LINUX `recued` on the data volume, so the bare name is correct there. Without
  // it we ARE the binary, and `process.execPath` already carries the real name
  // including `.exe`.
  const binDirArg = getArg(options.args, 'bin-dir');
  const binaryPath = options.binaryPath
    ?? (binDirArg ? join(binDirArg, 'recued') : process.execPath);
  // The realm this payload was serving. The launcher forwards the SAME `--db` it
  // gives the server, so the revert can never aim at a different realm than the
  // one that failed.
  const dbPath = resolveRealmDbPath(getArg(options.args, 'db') ?? env.DB_PATH);

  const outcome = revertStagedRelease({
    binaryPath,
    dbPath,
    reason,
    env,
    log: (message) => log(`[revert] ${message}`),
  });

  options.bootTrace.mark('revert-release', outcome.status);
  if (outcome.status === 'refused') log(`[revert] refused: ${outcome.reason}`);
  if (outcome.status === 'busy') log(`[revert] not now: ${outcome.reason}`);
  // ⚠ THREE ANSWERS, NOT TWO. A held lease is the one refusal that should be
  // COME BACK rather than STOP: another install is mid-flight on this host and
  // what it leaves behind is probably the fix. Today's only caller — the
  // `docker-thin` launcher — halts on any non-zero and lets the container's
  // restart policy be the backoff, so this changes nothing yet; it is the honest
  // code for a caller that grows a retry branch.
  exit(
    outcome.status === 'reverted'
      ? SUPERVISED_RETRY_NOW
      : outcome.status === 'busy'
        ? SUPERVISED_RETRY_AFTER_BACKOFF
        : SUPERVISED_GIVE_UP,
  );
}
