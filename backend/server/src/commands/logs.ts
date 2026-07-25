/** `recued-server logs [-f]` — read (or follow) the daemon log file.
 *
 *  Log file lives next to the DB in `recued-server.log`. Follow mode
 *  spawns `tail -f`; otherwise prints the last 50 lines and returns.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface LogsCommandDeps {
  dbPath: string;
  follow: boolean;
}

export async function cmdLogs(deps: LogsCommandDeps): Promise<void> {
  const logFile = join(dirname(resolve(deps.dbPath)), 'recued-server.log');
  if (!existsSync(logFile)) { console.log(`No log file at ${logFile}`); return; }

  if (deps.follow) {
    const { spawn: spawnProc } = await import('node:child_process');
    const tail = spawnProc('tail', ['-f', '-n', '50', logFile], { stdio: 'inherit' });
    process.on('SIGINT', () => { tail.kill(); process.exit(0); });
  } else {
    const content = readFileSync(logFile, 'utf-8');
    const lines = content.split('\n');
    const last = lines.slice(-51, -1);
    console.log(last.join('\n'));
  }
}
