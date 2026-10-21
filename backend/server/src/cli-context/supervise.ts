/** `recued supervise --bin-dir <dir> -- <serve args>` — the outer supervisor a
 *  Windows install runs (`launcher/outer-supervisor.ts`). `recued start` launches
 *  it from `recued-supervise.exe`.
 *
 *  ⛔ NODE'S OWN MODULES ONLY, which `bin-router.test.ts` checks: this process
 *  lives as long as the session, and whatever it loads from the install
 *  directory it holds open through every update. */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BootTrace } from '../cli/boot-trace.js';
import { getArg } from '../cli/parse.js';
import { liveBinaryName, runOuterSupervisor, SUPERVISE_STOP_FILE } from '../launcher/outer-supervisor.js';
import { resolveRealmDbPath } from '../realm-db-path.js';

export interface SuperviseProfileOptions {
  args: string[];
  bootTrace: BootTrace;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exit?: (code: number) => void;
  log?: (line: string) => void;
}

/** Resolves with the child's exit status. A child that cannot start at all is
 *  127, as a shell reports it, so it reads as a failed run and not a stop.
 *
 *  ⛔ `spawn` THROWS some of those instead of emitting them: a file that is not
 *  an executable (`ENOEXEC`) throws, a missing one (`ENOENT`) emits. Caught only
 *  as an event, a truncated `recued.exe` crashed the supervisor — in exactly the
 *  case it exists for. Found by `supervise-command-join.test.ts`. */
const runChild = (command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> =>
  new Promise((settle) => {
    let settled = false;
    const done = (status: number): void => {
      if (settled) return;
      settled = true;
      settle(status);
    };
    try {
      const child = spawn(command, args, { stdio: 'inherit', env, windowsHide: true });
      child.on('error', () => done(127));
      child.on('exit', (code) => done(code ?? 1));
    } catch {
      done(127);
    }
  });

export async function runSuperviseProfile(options: SuperviseProfileOptions): Promise<void> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const log = options.log ?? ((line: string) => process.stderr.write(`[supervise] ${line}\n`));
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const split = options.args.indexOf('--');
  const own = split === -1 ? options.args : options.args.slice(0, split);
  const serveArgs = split === -1 ? [] : options.args.slice(split + 1);
  // ⛔ PASSED, NOT DERIVED: `start` names the binary that ran it, which is the
  // one an update swaps, whatever it is called. `--bin-dir` names only the
  // directory, as the shell script does; `process.execPath` is this copy's.
  const payloadArg = getArg(own, 'payload');
  const payload = payloadArg !== undefined
    ? resolve(payloadArg)
    : join(resolve(getArg(own, 'bin-dir') ?? dirname(process.execPath)), liveBinaryName(platform));
  const binDir = dirname(payload);
  const previous = `${payload}.old`;
  const dbPath = resolveRealmDbPath(getArg(serveArgs, 'db') ?? env.DB_PATH, { mkdir: () => {}, note: () => {} });
  const stopFile = join(dirname(dbPath), SUPERVISE_STOP_FILE);
  // A request left from before this supervisor started was not addressed to it.
  rmSync(stopFile, { force: true });
  options.bootTrace.mark('supervise', payload);

  const code = await runOuterSupervisor({
    // `native` to the server: a launcher loop that starts it again on exit 3
    // (`lifecycle/supervisor.ts`), which is what lets Settings update it.
    runPayload: () => runChild(payload, serveArgs, { ...env, RECUED_LAUNCHER: '1' }),
    previousExists: () => existsSync(previous),
    // `--binary` names the payload exactly; a previous binary from before it
    // existed reads `--bin-dir`, which names the same file in an installed copy.
    askPrevious: (exitCode) => runChild(previous, [
      'report-boot-failure', '--exit-code', String(exitCode), '--bin-dir', binDir, '--binary', payload, '--db', dbPath,
    ], env),
    stopRequested: () => {
      if (!existsSync(stopFile)) return false;
      rmSync(stopFile, { force: true });
      return true;
    },
    sleep: (ms) => new Promise((wake) => { setTimeout(wake, ms); }),
    now: () => Date.now(),
    log,
  }, {
    // Seconds, as the shell script reads it.
    ...(env.RECUED_SUPERVISE_BACKOFF !== undefined ? { backoffMs: Number(env.RECUED_SUPERVISE_BACKOFF) * 1000 } : {}),
  });
  exit(code);
}
