/** `recued supervise` over real processes: the profile's wiring of the loop to
 *  what it starts. `outer-supervisor.test.ts` covers the loop's decisions with
 *  both ends scripted; this covers the seam it scripts away — the arguments and
 *  environment each child gets, the exit status read back, and the stop file.
 *
 *  The payload and the previous binary are shell scripts named as on this
 *  platform (`recued`, `recued.old`); Windows' `.exe` names are the one
 *  difference, held by `liveBinaryName`. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createBootTrace } from '../cli/boot-trace.js';
import { runSuperviseProfile } from '../cli-context/supervise.js';
import { liveBinaryName, SUPERVISE_STOP_FILE } from '../launcher/outer-supervisor.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A realm and a bin directory. The payload exits with `statuses` in turn,
 *  logging each run; `onRun(realm)` is shell run before it exits. */
const install = (opts: {
  statuses: number[];
  onRun?: (realm: string) => string;
  previousExit?: number;
  payload?: boolean;
  /** The payload's file name, when not this platform's installed one. */
  name?: string;
}) => {
  const root = mkdtempSync(join(tmpdir(), 'recued-supervise-'));
  dirs.push(root);
  const binDir = join(root, 'bin');
  const realm = join(root, 'realm');
  mkdirSync(binDir);
  mkdirSync(realm);
  const dbPath = join(realm, 'recued-server.db');
  const script = (path: string, body: string): void => {
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  if (opts.payload !== false) {
    const cases = opts.statuses.map((status, i) => `${i + 1}) code=${status};;`).join(' ');
    script(join(binDir, opts.name ?? liveBinaryName(process.platform)), [
      `n=$(cat '${binDir}/runs' 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > '${binDir}/runs'`,
      `echo "launcher=$RECUED_LAUNCHER args=$*" >> '${binDir}/payload.log'`,
      opts.onRun?.(realm) ?? '',
      `case "$n" in ${cases} *) code=99;; esac`,
      'exit "$code"',
    ].join('\n'));
  }
  script(`${join(binDir, opts.name ?? liveBinaryName(process.platform))}.old`, [
    `echo "$*" >> '${binDir}/previous.log'`,
    `exit ${opts.previousExit ?? 0}`,
  ].join('\n'));
  const read = (name: string): string[] => {
    const path = join(binDir, name);
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : [];
  };
  return { binDir, realm, dbPath, read, payloadPath: join(binDir, opts.name ?? liveBinaryName(process.platform)) };
};

const supervise = async (binDir: string, dbPath: string, payload?: string): Promise<number> => {
  let status: number | undefined;
  await runSuperviseProfile({
    args: ['supervise', ...(payload ? ['--payload', payload] : ['--bin-dir', binDir]), '--', '--port', '7799', '--db', dbPath],
    bootTrace: createBootTrace({ entrypoint: 'test', profile: 'supervise', env: {} }),
    env: { ...process.env, RECUED_LAUNCHER: undefined },
    exit: (code) => { status = code; },
    log: () => {},
  });
  if (status === undefined) throw new Error('the supervisor never exited');
  return status;
};

describe('recued supervise, over real processes', () => {
  it('runs the server as a supervised one with its own arguments, and asks the previous binary about a failure', async () => {
    const r = install({ statuses: [3, 1, 0] });
    expect(await supervise(r.binDir, r.dbPath)).toBe(0);
    expect(r.read('payload.log')).toEqual(Array.from({ length: 3 }, () =>
      `launcher=1 args=--port 7799 --db ${r.dbPath}`));
    expect(r.read('previous.log')).toEqual([
      `report-boot-failure --exit-code 1 --bin-dir ${r.binDir} --binary ${r.payloadPath} --db ${r.dbPath}`,
    ]);
  });

  it('stops for good when `recued stop` left its request, without asking about the abrupt end', async () => {
    // The payload leaves the request itself, as `recued stop` does just before ending it.
    const r = install({ statuses: [1, 0], onRun: (realm) => `touch '${join(realm, SUPERVISE_STOP_FILE)}'` });
    expect(await supervise(r.binDir, r.dbPath)).toBe(0);
    expect(r.read('payload.log')).toHaveLength(1);
    expect(r.read('previous.log')).toEqual([]);
    expect(existsSync(join(r.realm, SUPERVISE_STOP_FILE))).toBe(false);
  });

  it('runs the binary `start` names, whatever it is called, and asks that name plus .old', async () => {
    // The build's smoke runs `recued-windows-arm64.exe`; deriving `recued.exe`
    // beside it ran nothing, and the supervisor halted at once.
    const r = install({ statuses: [1, 0], name: 'recued-windows-arm64' });
    expect(await supervise(r.binDir, r.dbPath, r.payloadPath)).toBe(0);
    expect(r.read('payload.log')).toHaveLength(2);
    expect(r.read('previous.log')).toEqual([
      `report-boot-failure --exit-code 1 --bin-dir ${r.binDir} --binary ${r.payloadPath} --db ${r.dbPath}`,
    ]);
  });

  it('ignores a request left from before it started', async () => {
    const r = install({ statuses: [3, 0] });
    writeFileSync(join(r.realm, SUPERVISE_STOP_FILE), '');
    expect(await supervise(r.binDir, r.dbPath)).toBe(0);
    expect(r.read('payload.log')).toHaveLength(2);
  });

  it('asks about a server that cannot be executed at all, and exits with its status when the verdict gives up', async () => {
    const r = install({ statuses: [], payload: false, previousExit: 20 });
    expect(await supervise(r.binDir, r.dbPath)).toBe(127);
    expect(r.read('previous.log')).toEqual([
      `report-boot-failure --exit-code 127 --bin-dir ${r.binDir} --binary ${r.payloadPath} --db ${r.dbPath}`,
    ]);
  });
});
