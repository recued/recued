/** Phase 1 of the two-phase LLM boot — persist the slot, then EXIT.
 *
 *  ⛔ WHY A SEPARATE PROCESS, not just a second `bootInstrumentedServer()` call.
 *  The harness's `shutdown()` stops background services and the housekeeping
 *  scheduler, but `serve()` returns no handle to the HTTP listener, so the port
 *  stays bound (phase 2 dies on EADDRINUSE) and — the part that actually
 *  matters — the phase-1 mail / calendar / storage stack stays LIVE on the same
 *  database phase 2 is auditing. Two stacks writing one db would make every
 *  subsequent progress assertion untrustworthy: a counter that moved might have
 *  been moved by the wrong server. A child process that exits leaves nothing.
 *
 *  ⛔ WHY TWO PHASES AT ALL. `wire-chat-orchestrator.ts` takes a BOOT SNAPSHOT
 *  of the LLM config and picks the default model source from it, so a
 *  `server.setLLMConfig` write in the same process is never seen by the turn
 *  router. The slot has to be in SQLite BEFORE the boot that uses it.
 *
 *  ⚠ The key is passed over argv-free stdin-free channels: it is read from
 *  `dev.env` by this child itself, never logged, never printed. The parent
 *  learns only the outcome string. */

import { bootInstrumentedServer } from './boot.js';
import { persistLlmSlot } from './install-packs.js';
import { seedReceptionRateLimiter } from './probes.js';
import { configureLlmFromDevEnv } from './llm-env.js';
import { openServerVault } from './unlock-vault.js';

const [workDir, seedDb, seedIdentity, portRaw, recoveryKeyPath, devEnvPath] = process.argv.slice(2);

const main = async (): Promise<void> => {
  const llm = configureLlmFromDevEnv(devEnvPath);
  if (!llm.configured || !llm.slot) {
    process.stdout.write(`skipped — ${llm.detail}\n`);
    return;
  }
  const port = Number(portRaw);
  await bootInstrumentedServer({
    workDir,
    seedDb,
    seedIdentity,
    port,
    preBootSeed: seedReceptionRateLimiter,
  });
  const vault = await openServerVault({ port, recoveryKeyPath });
  if (!vault.ok) {
    process.stdout.write(`vault not opened — ${vault.reason}\n`);
    return;
  }
  process.stdout.write(`${await persistLlmSlot(vault.conn, llm.slot, llm.slot2)}\n`);
  vault.conn.close();
};

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stdout.write(
      `phase 1 failed — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
