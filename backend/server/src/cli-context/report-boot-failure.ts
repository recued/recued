/** `recued report-boot-failure --exit-code N` — the verdict half of the outer
 *  supervisor for the `binary` channel.
 *
 *  ⛔ THIS IS MEANT TO BE RUN BY `recued.old`, NOT BY THE LIVE BINARY. The whole
 *  point of the outer supervisor is to cover a payload that cannot execute; a
 *  verdict computed by that same payload would never run. `recued-supervise`
 *  invokes the PREVIOUS binary, which is known-good by construction because it
 *  is the thing a revert restores. The rule itself lives in
 *  `update/supervised-boot-failure.ts` so the script carries none of it.
 *
 *  Exit status is the script's only input: 0 retry now (a revert happened),
 *  10 retry after a backoff, 20 nothing further to try.
 */
import { dirname, join } from 'node:path';
import type { BootTrace } from '../cli/boot-trace.js';
import { getArg } from '../cli/parse.js';
import { resolveRealmDbPath } from '../realm-db-path.js';
import {
  exitCodeFor,
  handleSupervisedBootFailure,
  SUPERVISED_GIVE_UP,
} from '../update/supervised-boot-failure.js';

export interface ReportBootFailureProfileOptions {
  args: string[];
  bootTrace: BootTrace;
  env?: NodeJS.ProcessEnv;
  /** Overridden in tests; production reads the running binary's own directory,
   *  which is where `recued`, `recued.old` and the counter all live. */
  binaryPath?: string;
  exit?: (code: number) => void;
  log?: (message: string) => void;
}

export async function runReportBootFailureProfile(
  options: ReportBootFailureProfileOptions,
): Promise<void> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const raw = getArg(options.args, 'exit-code');
  const exitCode = Number(raw);
  if (raw === undefined || !Number.isFinite(exitCode)) {
    // ⚠ REFUSE RATHER THAN DEFAULT. Counting a boot failure nobody observed is
    // how a healthy install talks itself into a revert.
    log('report-boot-failure: --exit-code <n> is required');
    exit(SUPERVISED_GIVE_UP);
    return;
  }

  // ⚠ SAME RULE AS `revert-release` AND `resolveUpdateBinaryPath`: with
  // `--bin-dir` we are the docker-thin launcher and the payload is a linux
  // `recued`; without it we ARE the binary and `process.execPath` already carries
  // the real name, including `.exe` on Windows. A directory plus a hard-coded
  // `recued` looked for a file that never exists on a Windows install.
  const binDirArg = getArg(options.args, 'bin-dir');
  const binaryPath = options.binaryPath
    ?? (binDirArg ? join(binDirArg, 'recued') : process.execPath);
  const dbPath = resolveRealmDbPath(getArg(options.args, 'db') ?? env.DB_PATH);

  const outcome = handleSupervisedBootFailure({
    binaryPath,
    dbPath,
    exitCode,
    env,
    log: (message) => log(`[supervise] ${message}`),
  });

  options.bootTrace.mark('report-boot-failure', outcome.action);
  exit(exitCodeFor(outcome));
}
