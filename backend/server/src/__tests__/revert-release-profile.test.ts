/** `recued revert-release` — the CLI half the `docker-thin` launcher calls.
 *
 *  ⚠ THE PROFILE'S OWN CONTRACT, NOT THE REVERT ITSELF. What the revert does is
 *  `revertStagedRelease`'s business and is covered there; what this owns is the
 *  argument it refuses without, and the exit codes the launcher branches on. Both
 *  are the kind of thing a join test cannot isolate and a unit test of the
 *  transaction never sees.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BootTrace } from '../cli/boot-trace.js';
import { runRevertReleaseProfile } from '../cli-context/revert-release.js';
import {
  SUPERVISED_GIVE_UP,
  SUPERVISED_RETRY_NOW,
} from '../update/supervised-boot-failure.js';

const noopTrace = {
  mark: () => {},
  markImport: () => {},
  markDbOpenAttempted: () => {},
} as unknown as BootTrace;

describe('runRevertReleaseProfile', () => {
  let dir: string;
  let binaryDir: string;
  let dataDir: string;
  const live = () => join(binaryDir, 'recued');
  const db = () => join(dataDir, 'recued-server.db');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'revert-cli-'));
    binaryDir = join(dir, 'bin');
    dataDir = join(dir, 'data');
    mkdirSync(binaryDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(live(), 'BROKEN PAYLOAD', 'utf8');
    writeFileSync(`${live()}.old`, 'KNOWN-GOOD PAYLOAD', 'utf8');
    writeFileSync(db(), 'REALM', 'utf8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = async (args: string[]): Promise<{ code: number; out: string }> => {
    let code = -1;
    const lines: string[] = [];
    await runRevertReleaseProfile({
      args: ['revert-release', ...args],
      bootTrace: noopTrace,
      env: {},
      exit: (c) => { code = c; },
      log: (m) => lines.push(m),
    });
    return { code, out: lines.join('\n') };
  };

  it('reverts and reports the retry-now code the launcher acts on', async () => {
    const { code } = await run(['--bin-dir', binaryDir, '--db', db(), '--reason', 'current binary missing']);
    expect(code).toBe(SUPERVISED_RETRY_NOW);
    expect(readFileSync(live(), 'utf8')).toBe('KNOWN-GOOD PAYLOAD');
  });

  // ⛔ THE REASON IS THE ONLY RECORD OF WHY A RELEASE WAS DOWNGRADED, and the two
  // supervisors revert for causes that read very differently in a log: a crash
  // loop, or a binary that failed its signature. A default here would write the
  // same sentence onto both and lose the distinction exactly where someone is
  // reading the ledger to find out what happened.
  it('refuses without a --reason, changing nothing', async () => {
    const { code, out } = await run(['--bin-dir', binaryDir, '--db', db()]);
    expect(code).toBe(SUPERVISED_GIVE_UP);
    expect(out).toMatch(/--reason/);
    expect(readFileSync(live(), 'utf8')).toBe('BROKEN PAYLOAD');
    expect(existsSync(`${live()}.old`)).toBe(true);
  });

  // The launcher halts on any non-zero, and this is the case it must halt on:
  // reverting would put the old binary on a schema the failed release migrated.
  it('gives up when the revert would be unsafe', async () => {
    const ledger = join(dataDir, 'updates.log');
    writeFileSync(ledger, `${JSON.stringify({
      id: 'a1', kind: 'apply_started', at: 1, from_version: '26.9.1', to_version: '26.9.2',
      channel: 'stable', trigger: 'auto', release_identity: 'stable:26.9.2', migration: true,
    })}\n`);   // …and no snapshot beside it

    const { code, out } = await run(['--bin-dir', binaryDir, '--db', db(), '--reason', 'crash loop']);
    expect(code).toBe(SUPERVISED_GIVE_UP);
    expect(out).toMatch(/refused/);
    expect(readFileSync(live(), 'utf8')).toBe('BROKEN PAYLOAD');
    // Still in flight: nothing was undone, so nothing may claim it was.
    expect(readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});
