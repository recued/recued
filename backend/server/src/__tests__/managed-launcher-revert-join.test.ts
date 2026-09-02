/** The OTHER supervisor pair: the frozen `:managed` launcher driving the real
 *  `revert-release` profile.
 *
 *  ⛔ SAME REASON AS ITS SIBLING, DIFFERENT HALVES. The launcher's own tests stub
 *  the verdict out; the profile's tests call it directly. Both are green while the
 *  thing between them — a launcher that asks for a revert the profile then
 *  performs, over one realm — has never run. And the defect this closes lived
 *  exactly there: the launcher used to do the revert itself and moved the BINARY
 *  PAIR ONLY, so a migrating release came back on the old binary against the new
 *  schema, with `recued.old` consumed and the operation recorded as resolved.
 *
 *  ⚠ SPLIT OUT OF `supervisor-join.test.ts`, WHICH READS `install.sh`. Nothing
 *  here needs the installer — this pair is the docker-thin launcher and the CLI,
 *  both of which ship. Sharing a file with the shell drive meant a private-fixture
 *  reference in the other half omitted these two from the public export as well.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLauncher } from '../launcher/managed-launcher.js';
import { realmSnapshotPath } from '../update/realm-generation-snapshot.js';

const REPO = resolve(import.meta.dirname, '../../../..');
const BIN_TS = join(REPO, 'backend/server/src/bin.ts');
const TSX = join(REPO, 'node_modules/.bin/tsx');

/** The launcher's revert is driven through a POSIX shell payload. */
const RUNS_POSIX_SH = process.platform !== 'win32';

/** A payload that starts and exits non-zero every time — the crash loop the
 *  launcher's boot-failure counter exists to end. */
const CRASHING_PAYLOAD = '#!/bin/sh\nexit 1\n';

describe.runIf(RUNS_POSIX_SH)('managed-launcher × revert-release', () => {
  /** A `:managed` data volume mid-crash-loop: a current binary that always exits
   *  non-zero, and a previous one that runs the REAL profile for the revert and
   *  leaves a marker when it is later exec'd as the server. */
  const stageVolume = (dir: string, opts: { snapshot?: string }): {
    bin: string;
    data: string;
    marker: string;
  } => {
    const bin = join(dir, 'bin');
    const data = join(dir, 'data');
    mkdirSync(bin, { recursive: true });
    mkdirSync(data, { recursive: true });
    const marker = join(dir, 'restored-binary-ran');

    writeFileSync(join(bin, 'recued'), CRASHING_PAYLOAD, { mode: 0o755 });
    writeFileSync(
      join(bin, 'recued.old'),
      `#!/bin/sh\n`
        + `if [ "$1" = "revert-release" ]; then\n`
        + `  exec ${JSON.stringify(process.execPath)} ${JSON.stringify(TSX)} `
        + `${JSON.stringify(BIN_TS)} "$@"\n`
        + `fi\n`
        + `: > ${JSON.stringify(marker)}\n`
        + `exit 0\n`,
      { mode: 0o755 },
    );

    writeFileSync(
      join(data, 'updates.log'),
      `${JSON.stringify({
        id: 'a1',
        kind: 'apply_started',
        at: 1000,
        from_version: '26.9.1',
        to_version: '26.9.2',
        channel: 'stable',
        trigger: 'auto',
        release_identity: 'stable:26.9.2',
        migration: true,
      })}\n`,
    );
    writeFileSync(join(data, 'recued-server.db'), 'MIGRATED DB\n');
    if (opts.snapshot !== undefined) {
      writeFileSync(realmSnapshotPath(join(data, 'recued-server.db')), opts.snapshot);
    }
    return { bin, data, marker };
  };

  const launcherEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.RECUED_NATIVE_BINDING;
    delete env.RECUED_WEBCLIENT_DIR;
    return env;
  };

  it('reverts a crash-looping migrating release, database and all, then runs it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'launcher-join-'));
    try {
      const { bin, data, marker } = stageVolume(dir, { snapshot: 'PRE-MIGRATION DB\n' });

      const code = await runLauncher({
        binDir: bin,
        pubkey: '',                                  // pre-GA: verification bypassed
        args: ['--db', join(data, 'recued-server.db')],
        env: launcherEnv(),
        crashBackoffMs: 0,
        log: () => {},
      });

      expect(code).toBe(0);
      // The launcher went on to START the restored binary — not merely move bytes.
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(join(bin, 'recued'), 'utf8')).toContain('restored-binary-ran');
      // ⛔ THE HALF THE LAUNCHER NEVER DID. The old binary is not left reading the
      // schema the failed release wrote.
      expect(readFileSync(join(data, 'recued-server.db'), 'utf8')).toBe('PRE-MIGRATION DB\n');

      const ledger = readFileSync(join(data, 'updates.log'), 'utf8')
        .trim().split('\n').map((l) => JSON.parse(l));
      expect(ledger).toHaveLength(2);
      expect(ledger[1].kind).toBe('apply_reverted');
      expect(String(ledger[1].detail)).toContain('snapshot restored');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('halts, changing nothing, when the migrating release has no snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'launcher-join-nosnap-'));
    try {
      const { bin, data, marker } = stageVolume(dir, {});

      const code = await runLauncher({
        binDir: bin,
        pubkey: '',
        args: ['--db', join(data, 'recued-server.db')],
        env: launcherEnv(),
        crashBackoffMs: 0,
        log: () => {},
      });

      // Refused by the profile → the launcher halts rather than swapping anyway,
      // which is what used to consume `recued.old` and leave nothing to retry.
      expect(code).toBe(1);
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(join(bin, 'recued'), 'utf8')).toBe('#!/bin/sh\nexit 1\n');
      expect(existsSync(join(bin, 'recued.old'))).toBe(true);
      expect(readFileSync(join(data, 'recued-server.db'), 'utf8')).toBe('MIGRATED DB\n');
      // Still in flight: nothing was undone, so nothing may claim it was.
      expect(readFileSync(join(data, 'updates.log'), 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
