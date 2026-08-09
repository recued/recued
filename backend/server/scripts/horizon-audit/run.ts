/** Long-horizon audit — one-command runner.
 *
 *      npx tsx backend/server/scripts/horizon-audit/run.ts
 *
 *  Boots the real server against a copy of the enrolled bench seed, captures
 *  the composition root's registrations, then drives every drivable
 *  time-driven subsystem K >= 3 cycles and asserts PROGRESS — not invocation.
 *
 *  Exit code:
 *    0  every subsystem driven, every progress invariant held
 *    1  a finding, OR a subsystem that could not be driven
 *
 *  ⛔ "Could not be driven" is a NON-ZERO exit on purpose. Not-audited must
 *  never read the same as audited-and-clean.
 *
 *  ⛔⛔ TYPECHECK THIS DIRECTORY EXPLICITLY. `tsc -b backend/server` does NOT
 *  cover it — `backend/server/tsconfig.json` has `include: ['src']`, so the
 *  harness is invisible to the usual gate and only tsx's transform catches
 *  anything, at runtime. A truncated `probes.ts` passed `tsc -b` cleanly during
 *  round 9; applying a real check then surfaced type errors the harness had
 *  carried for several rounds. Run:
 *
 *    cd backend/server && node --max-old-space-size=8192 \
 *      ../../node_modules/typescript/bin/tsc --noEmit --skipLibCheck --strict \
 *      --target es2022 --module nodenext --moduleResolution nodenext \
 *      --types node scripts/horizon-audit/run.ts
 */

import { spawnSync } from 'node:child_process';
import { resolveSeedDir, seedNotFoundMessage } from './seed-dir.js';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { bootInstrumentedServer } from './boot.js';
import { openServerVault } from './unlock-vault.js';
import { installAuditSubstrate, persistLlmSlot } from './install-packs.js';
import { seedReceptionRateLimiter } from './probes.js';
import { configureLlmFromDevEnv } from './llm-env.js';
import { staticIntervalSites, staticServiceSites } from './inventory.js';
import { runSweep } from './sweep.js';
import { report } from './report.js';

const REPO = new URL('../../../../', import.meta.url).pathname;

const main = async (): Promise<number> => {
  const workDir = process.env.HORIZON_WORKDIR
    ?? resolve(REPO, '.horizon-audit-scratch');
  const seed = resolveSeedDir(REPO);
  if (seed.dir === null) {
    console.error(seedNotFoundMessage(seed));
    return 1;
  }
  const seedDir = seed.dir;
  const seedDb = resolve(seedDir, 'seed-test.db');
  const seedIdentity = resolve(seedDir, 'seed-identity.json');
  const seedRecoveryKey = resolve(seedDir, 'seed-recovery-key.txt');
  const port = Number(process.env.HORIZON_PORT ?? 47899);
  const cycles = Number(process.env.HORIZON_CYCLES ?? 4);

  if (!existsSync(seedDb) || !existsSync(seedIdentity)) {
    console.error(
      `[horizon] enrolled seed not found under ${seedDir}\n`
      + `          expected seed-test.db + seed-identity.json\n`
      + `          set HORIZON_SEED_DIR to override.`,
    );
    return 1;
  }

  const staticIntervals = staticIntervalSites();
  const staticServices = staticServiceSites();

  // ⛔ BEFORE serve(): the LLM config is resolved during storage composition.
  const DEV_ENV_PATH = resolve(REPO, '../dev.env');
  const llm = configureLlmFromDevEnv(DEV_ENV_PATH);
  console.error(
    llm.configured ? `[horizon] llm: ${llm.detail}` : `[horizon] llm: none — ${llm.detail}`,
  );

  // ── Phase 1 (LLM only) ────────────────────────────────────────────────
  // ⛔ The chat orchestrator SNAPSHOTS the LLM config at boot and picks the
  // default model source from it, so a `setLLMConfig` write only lands for the
  // NEXT boot. Phase 1 persists the slot in a CHILD PROCESS that then exits —
  // see `llm-phase1.ts` for why in-process cannot work — and phase 2 re-boots
  // on the same database so the snapshot carries it.
  let llmPersisted = false;
  if (llm.configured && llm.slot) {
    const phase1 = spawnSync(
      process.execPath,
      [
        '--import', 'tsx',
        fileURLToPath(new URL('./llm-phase1.ts', import.meta.url)),
        workDir, seedDb, seedIdentity, String(port + 1), seedRecoveryKey, DEV_ENV_PATH,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const outcome = (phase1.stdout ?? '').trim().split('\n').pop() ?? 'no output';
    llmPersisted = outcome.includes('persisted');
    console.error(`[horizon] llm phase 1: ${outcome}`);
  }

  console.error('[horizon] booting instrumented server…');
  const booted = await bootInstrumentedServer({
    workDir,
    seedDb,
    seedIdentity,
    port,
    preBootSeed: seedReceptionRateLimiter,
    reuseWorkDir: llmPersisted,
  });
  console.error(
    `[horizon] boot complete in ${booted.capture.bootMs}ms — `
    + `${booted.capture.intervals.length} intervals, `
    + `${booted.capture.services.length} services`,
  );

  // ⛔ The seed boots SEALED (`seed.mjs`: "vault left uninitialized"). Open it
  // the way the bench does — pair + auth rpc — or every autonomous scheduler
  // tick correctly no-ops and the sweep measures the gate, not the subsystem.
  const vault = await openServerVault({
    port,
    recoveryKeyPath: seedRecoveryKey,
  });
  console.error(
    vault.ok
      ? `[horizon] vault opened via ${vault.via}`
      : `[horizon] vault NOT opened: ${vault.reason}`,
  );

  // ⛔ Install the substrate the blocked subsystems need. A records pack gives
  // the outbox its `core_record_namespaces` accounting row; a pack shipping an
  // auto_run recipe gives the auto-run roster a FRESH entry, which is built
  // with `next_run_at: now` and is therefore due immediately.
  const installs = vault.ok
    ? await installAuditSubstrate(
        vault.conn,
        resolve(REPO, 'community/packs'),
        DEV_ENV_PATH,
      )
    : [];
  for (const i of installs) {
    console.error(`[horizon] pack ${i.slug}: ${i.ok ? 'ok' : 'FAILED'} — ${i.detail}`);
  }

  let sweep;
  try {
    sweep = await runSweep({
      booted,
      cycles,
      vaultOpen: vault.ok,
      conn: vault.ok ? vault.conn : undefined,
    });
  } finally {
    if (vault.ok) vault.conn.close();
    await booted.shutdown();
  }

  const exitCode = report({
    staticIntervals,
    staticServices,
    capture: booted.capture,
    sweep,
    cycles,
    vault,
    installs,
  });
  return exitCode;
};

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    console.error('[horizon] harness failed', err);
    process.exit(2);
  });
