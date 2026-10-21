/** `report-boot-failure --bin-dir` names the live binary as its platform lays
 *  it down. On Windows that is `recued.exe`, beside `recued.exe.old`; the
 *  directory plus a hard-coded `recued` named a file no Windows install has,
 *  so the verdict found nothing to revert to and the broken release stayed.
 *  Windows' `recued supervise` names the binary with `--binary` and its
 *  directory with `--bin-dir`, which a previous binary from before `--binary`
 *  existed still reads.
 *
 *  Run in-process against real files: the same layout, reported as Windows and
 *  as Linux, is reverted only when the names match it. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createBootTrace } from '../cli/boot-trace.js';
import { runReportBootFailureProfile } from '../cli-context/report-boot-failure.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A Windows install whose new release cannot start, with its apply on trial. */
const windowsInstall = () => {
  const dir = mkdtempSync(join(tmpdir(), 'report-boot-failure-win-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  const data = join(dir, 'data');
  mkdirSync(join(bin, 'lib'), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(bin, 'recued.exe'), 'NEW BINARY');
  writeFileSync(join(bin, 'recued.exe.old'), 'OLD BINARY');
  writeFileSync(join(bin, 'lib', 'better_sqlite3.node'), 'NEW ADDON');
  writeFileSync(join(bin, 'lib', 'better_sqlite3.node.old'), 'OLD ADDON');
  writeFileSync(join(data, 'updates.log'), `${JSON.stringify({
    id: 'a1', kind: 'apply_started', at: 1000, from_version: '26.10.20', to_version: '26.10.21',
    channel: 'stable', trigger: 'manual', release_identity: 'stable:26.10.21', migration: false,
  })}\n`);
  const dbPath = join(data, 'recued-server.db');
  writeFileSync(dbPath, 'DB');
  return { bin, dbPath };
};

/** Three failed runs reported, as the supervisor reports them; the verdicts. */
const reportThree = async (
  bin: string,
  dbPath: string,
  platform: NodeJS.Platform,
  extra: string[] = [],
): Promise<number[]> => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.RECUED_NATIVE_BINDING;
  delete env.RECUED_WEBCLIENT_DIR;
  const verdicts: number[] = [];
  for (let run = 0; run < 3; run += 1) {
    await runReportBootFailureProfile({
      args: ['report-boot-failure', '--exit-code', '1', '--bin-dir', bin, ...extra, '--db', dbPath],
      bootTrace: createBootTrace({ entrypoint: 'test', profile: 'report-boot-failure', env: {} }),
      env,
      platform,
      exit: (code) => { verdicts.push(code); },
      log: () => {},
    });
  }
  return verdicts;
};

describe('report-boot-failure --bin-dir on a Windows install', () => {
  it('reverts recued.exe from recued.exe.old, addon with it, on the third failure', async () => {
    const { bin, dbPath } = windowsInstall();
    expect(await reportThree(bin, dbPath, 'win32')).toEqual([10, 10, 0]);
    expect(readFileSync(join(bin, 'recued.exe'), 'utf8')).toBe('OLD BINARY');
    expect(existsSync(join(bin, 'recued.exe.old'))).toBe(false);
    expect(readFileSync(join(bin, 'lib', 'better_sqlite3.node'), 'utf8')).toBe('OLD ADDON');
  });

  it('reverts the binary `--binary` names, whatever it is called', async () => {
    // Windows' supervisor names the binary `recued start` ran; the build's
    // smoke runs one called `recued-windows-arm64.exe`.
    const { bin, dbPath } = windowsInstall();
    renameSync(join(bin, 'recued.exe'), join(bin, 'recued-windows-arm64.exe'));
    renameSync(join(bin, 'recued.exe.old'), join(bin, 'recued-windows-arm64.exe.old'));
    const binary = join(bin, 'recued-windows-arm64.exe');
    expect(await reportThree(bin, dbPath, 'win32', ['--binary', binary])).toEqual([10, 10, 0]);
    expect(readFileSync(binary, 'utf8')).toBe('OLD BINARY');
  });

  it('finds nothing to revert when the same files are named as on Linux', async () => {
    const { bin, dbPath } = windowsInstall();
    expect(await reportThree(bin, dbPath, 'linux')).toEqual([10, 10, 20]);
    expect(readFileSync(join(bin, 'recued.exe'), 'utf8')).toBe('NEW BINARY');
  });
});
