/** The JOIN for Windows' supervisor: the real `recued supervise` driving the real
 *  `report-boot-failure`, over real files — the counterpart of
 *  `supervisor-join.test.ts`, whose shell script this command stands in for.
 *
 *  The seam is where the shell pair broke while both halves were green (the
 *  verdict looked for the binary in the wrong directory), so this crosses it for
 *  real: a payload that cannot execute, an apply on trial, and the previous
 *  binary answering through the CLI entrypoint. It passes when the restored
 *  binary actually RUNS, not when bytes moved.
 *
 *  Names are this platform's (`recued`, `recued.old`); Windows' `.exe` names
 *  are held by `report-boot-failure-windows-names.test.ts`. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createBootTrace } from '../cli/boot-trace.js';
import { runSuperviseProfile } from '../cli-context/supervise.js';
import { BOOT_FAILURE_COUNTER_FILE } from '../update/boot-failure-counter.js';

const REPO = resolve(import.meta.dirname, '../../../..');
const BIN_TS = join(REPO, 'backend/server/src/bin.ts');
const TSX = join(REPO, 'node_modules/.bin/tsx');

describe.runIf(process.platform !== 'win32')('recued supervise × report-boot-failure', () => {
  it('reverts a payload that cannot execute, and the restored binary runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'supervise-command-join-'));
    try {
      const bin = join(dir, 'bin');
      const data = join(dir, 'data');
      mkdirSync(join(bin, 'lib'), { recursive: true });
      mkdirSync(data, { recursive: true });
      const dbPath = join(data, 'recued-server.db');
      const ran = join(dir, 'restored-binary-ran');
      // Passed every byte check and still cannot execute: the case only an
      // outer supervisor can see.
      writeFileSync(join(bin, 'recued'), 'THIS IS NOT AN EXECUTABLE\n', { mode: 0o755 });
      writeFileSync(join(bin, 'lib', 'better_sqlite3.node'), 'NEW ADDON\n');
      writeFileSync(join(bin, 'lib', 'better_sqlite3.node.old'), 'OLD ADDON\n');
      // The previous binary: the REAL CLI for the verdict, a marker for the serve path.
      writeFileSync(join(bin, 'recued.old'), [
        '#!/bin/sh',
        'if [ "$1" = "report-boot-failure" ]; then',
        `  exec ${JSON.stringify(process.execPath)} ${JSON.stringify(TSX)} ${JSON.stringify(BIN_TS)} "$@"`,
        'fi',
        `echo "$*" > ${JSON.stringify(ran)}`,
        'exit 0',
      ].join('\n'), { mode: 0o755 });
      writeFileSync(join(data, 'updates.log'), `${JSON.stringify({
        id: 'a1', kind: 'apply_started', at: 1000, from_version: '26.10.20', to_version: '26.10.21',
        channel: 'stable', trigger: 'manual', release_identity: 'stable:26.10.21', migration: false,
      })}\n`);
      writeFileSync(dbPath, 'DB\n');

      // Hermetic: the revert resolves the addon and bundle it restores through these.
      const env: NodeJS.ProcessEnv = { ...process.env, RECUED_SUPERVISE_BACKOFF: '0' };
      delete env.RECUED_NATIVE_BINDING;
      delete env.RECUED_WEBCLIENT_DIR;
      let status: number | undefined;
      await runSuperviseProfile({
        args: ['supervise', '--bin-dir', bin, '--', '--port', '7799', '--db', dbPath, '--require-enrolled'],
        bootTrace: createBootTrace({ entrypoint: 'test', profile: 'supervise', env: {} }),
        env,
        exit: (code) => { status = code; },
        log: () => {},
      });

      // ⛔ THE ASSERTION THAT MATTERS: the supervisor went on to start the
      // restored binary, with the server's own arguments, and it ran.
      expect(status).toBe(0);
      expect(readFileSync(ran, 'utf8').trim()).toBe(`--port 7799 --db ${dbPath} --require-enrolled`);
      expect(existsSync(join(bin, 'recued.old'))).toBe(false);
      expect(readFileSync(join(bin, 'lib', 'better_sqlite3.node'), 'utf8')).toBe('OLD ADDON\n');
      expect(existsSync(join(bin, BOOT_FAILURE_COUNTER_FILE))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
