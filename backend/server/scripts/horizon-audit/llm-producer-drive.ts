/** Drive an OWN-WALK AI housekeeping producer against a REAL credential.
 *
 *      npx tsx backend/server/scripts/horizon-audit/llm-producer-drive.ts
 *      LLM_TASK=enrichment.company LLM_TOPIC=company  …same, other producer
 *
 *  ⛔ WHY THIS EXISTS. The AI-producer path had NO live verification. Every
 *  other lane either saw it ERROR (no satisfiable pool) or gate off by trust, so
 *  "the producer runs and writes a row" was never actually observed — and the
 *  scheduler fix that turns an unsatisfiable pool into a YIELD is only correct
 *  if a SATISFIABLE pool still produces. A yield that is really a silent
 *  failure and a yield that is a correct wait look identical from the outside.
 *
 *  Measured on the bench seed with Qwen in slot_1:
 *      status=complete (38.9s) · data_enrichment[lifecycle_stage_inferred] 0 -> 2
 *      model=openai-compatible:qwen3.7-plus
 *
 *  ⛔ OPT-IN, AND DELIBERATELY NOT PART OF `run.ts`. It spends real tokens and
 *  takes ~40s for two records. `run.ts` must stay free to run on every round.
 *
 *  ⚠ TWO PRECONDITIONS THE PRODUCT REQUIRES, both set here and READ BACK.
 *  Neither is a default:
 *    - `housekeeping_config.allow_byok_background = 1`. The row does not exist
 *      until the config store first reads it, so a bare UPDATE matches NOTHING
 *      and the master switch stays off — which then looks exactly like the
 *      resolver refusing a good credential. Upsert, then read back.
 *    - `enrichment_trust` for the topic at `trust_state='auto'`.
 *
 *  ⚠ The credential is taken from `dev.env` and is NEVER printed — only the
 *  provider/model label and the transport's verdict, via `preflightSlot`.
 *
 *  ⚠ `llm_config` stays EMPTY on this path and that is correct: an
 *  env-configured slot (`RECUED_LLM_*`) is resolved at runtime and never
 *  persisted. Checked, because an empty table looked like a missing credential.
 */
import { resolve } from 'node:path';
import { bootInstrumentedServer } from './boot.js';
import { seedReceptionRateLimiter } from './probes.js';
import { resolveSeedDir, seedNotFoundMessage } from './seed-dir.js';
import { configureLlmFromDevEnv, preflightSlot } from './llm-env.js';
import { openDatabase } from '../../src/open-database.js';

const REPO = resolve(import.meta.dirname, '../../../..');
const SEED = resolveSeedDir(REPO);
if (SEED.dir === null) { console.error(seedNotFoundMessage(SEED)); process.exit(1); }

const TASK = process.env.LLM_TASK ?? 'enrichment.lifecycle_stage_inferred';
const TOPIC = process.env.LLM_TOPIC ?? 'lifecycle_stage_inferred';

const main = async (): Promise<void> => {
  const llm = configureLlmFromDevEnv(resolve(REPO, '../dev.env'));
  console.log(`LLM: ${llm.detail}`);
  if (!llm.configured || !llm.slot) { console.error('no credential'); process.exit(1); }
  const pre = await preflightSlot(llm.slot);
  console.log(`preflight: ${pre.ok ? 'OK' : 'FAIL'} — ${pre.detail}`);
  if (!pre.ok) process.exit(1);

  const booted = await bootInstrumentedServer({
    workDir: resolve(REPO, '.horizon-audit-scratch/llm-live'),
    seedDb: resolve(SEED.dir!, 'seed-test.db'),
    seedIdentity: resolve(SEED.dir!, 'seed-identity.json'),
    port: 47933,
    preBootSeed: seedReceptionRateLimiter,
  });

  const db = await openDatabase(booted.dbPath);
  const before = db.prepare(
    `SELECT COUNT(*) AS n FROM data_enrichment WHERE topic = ?`,
  ).get(TOPIC) as { n: number };

  // Permit BYOK for background work + trust the topic. Without the first, the
  // producer resolves forceLayer 'free' and the (empty) free pool cannot serve
  // it — which is the condition that used to ERROR.
  // ⚠ UPSERT, not UPDATE. The singleton row does not exist until the config
  // store first reads it, so a bare UPDATE silently matched nothing and the
  // master switch stayed off — which then looked exactly like the resolver
  // refusing a good credential. Read back below.
  db.prepare(
    `INSERT INTO housekeeping_config (
       id, preset, cycle_budget_ms, cycle_interval_minutes,
       allow_byok_background, updated_at)
     VALUES ('singleton', 'balanced', 120000, 5, 1, ?)
     ON CONFLICT(id) DO UPDATE SET allow_byok_background = 1`,
  ).run(Date.now());
  db.prepare(
    `INSERT INTO enrichment_trust (topic, trust_state, pool_policy, updated_at)
     VALUES (?, 'auto', 'byok_only', ?)
     ON CONFLICT(topic) DO UPDATE SET trust_state='auto', pool_policy='byok_only', updated_at=excluded.updated_at`,
  ).run(TOPIC, Date.now());
  // ⚠ READ BACK what was written. A write that silently did not apply looks
  // exactly like a resolver that refused a good credential.
  const cfg = db.prepare(
    `SELECT allow_byok_background FROM housekeeping_config WHERE id = 'singleton'`,
  ).get();
  const tr = db.prepare(
    `SELECT topic, trust_state, pool_policy FROM enrichment_trust WHERE topic = ?`,
  ).get(TOPIC);
  const llmRows = db.prepare(
    `SELECT key FROM llm_config WHERE key NOT LIKE 'usage.%' AND key NOT LIKE 'pool_usage.%'`,
  ).all() as Array<{ key: string }>;
  console.log(`config.allow_byok_background = ${JSON.stringify(cfg)}`);
  console.log(`enrichment_trust            = ${JSON.stringify(tr)}`);
  console.log(`llm_config keys             = ${llmRows.map((r) => r.key).join(', ') || '(none)'}`);
  db.close();

  const scheduler = booted.housekeepingScheduler;
  if (!scheduler) {
    // ⛔ Non-zero, never a quiet skip: a run that could not drive the producer
    // must not read like a run that drove it and found nothing.
    console.error('no housekeeping scheduler on the booted server — nothing driven');
    await booted.shutdown();
    process.exit(1);
  }

  const t0 = Date.now();
  const res = await scheduler.runOnce({ task_id: TASK, budget_ms: 120_000 });
  const per = res.per_task[0];
  console.log(`\nRun-Now ${TASK}: status=${per?.status ?? '?'} `
    + `yield_reason=${(per as { yield_reason?: string } | undefined)?.yield_reason ?? '-'} `
    + `(${Date.now() - t0}ms)`);
  console.log(`cycle: stepped=${res.tasks_stepped} complete=${res.tasks_complete} `
    + `yielded=${res.tasks_yielded} errored=${res.tasks_errored}`);

  const db2 = await openDatabase(booted.dbPath);
  const after = db2.prepare(
    `SELECT COUNT(*) AS n FROM data_enrichment WHERE topic = ?`,
  ).get(TOPIC) as { n: number };
  const sample = db2.prepare(
    `SELECT target_id, authored_by, model_id FROM data_enrichment WHERE topic = ? LIMIT 3`,
  ).all(TOPIC) as Array<{ target_id: string; authored_by: string; model_id: string | null }>;
  const errs = db2.prepare(
    `SELECT last_status, consecutive_errors, last_error, last_yield_reason
       FROM housekeeping_state WHERE task_id = ?`,
  ).get(TASK);
  db2.close();

  console.log(`\ndata_enrichment[${TOPIC}]: ${before.n} -> ${after.n}`);
  for (const r of sample) console.log(`   ${r.target_id}  by=${r.authored_by}  model=${r.model_id ?? '-'}`);
  console.log(`housekeeping_state: ${JSON.stringify(errs)}`);
  await booted.shutdown();
};

main().then(() => process.exit(0)).catch((e: unknown) => { console.error(e); process.exit(1); });
