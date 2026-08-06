/** Long-horizon audit — per-subsystem progress probes.
 *
 *  ⛔ Phase 0's lesson, transcribed: a GENERIC "did anything change?" probe is
 *  defeated by a handler that does PART of its job. A pruner that stamps
 *  `last_run_at`, logs a line, and deletes nothing satisfies every
 *  did-it-do-something check. So each probe below names the SPECIFIC thing
 *  that must move, and seeds work that MUST be swept.
 *
 *  Each probe is `seed → pending → (drive) → pending`. `seed()` returns how
 *  many due units it created; returning 0 makes the subsystem `undrivable`,
 *  which is a non-zero exit rather than a silent pass.
 *
 *  ⚠ Time is compressed by AGEING THE DATA, not by moving the clock. The
 *  pruners resolve `Date.now` at tick time through a `now` dep the serve path
 *  does not override, so the honest compression is to write rows whose
 *  timestamps are already past the window. Per-subsystem method is recorded in
 *  `drivenBy` and printed in the drivability map. */

// ⛔ `openDatabase` (the D-212 chokepoint) returns better-sqlite3's Database
// type, not the multiple-ciphers one. They are the same object at runtime;
// naming the wrong one is a type error the harness carried unseen because
// `tsc -b backend/server` only includes `src`.
import type Database from 'better-sqlite3';
import { RUNTIME_SCHEMA_MAP } from '@recued/config';

import type { BootedServer } from './boot.js';
import type { CycleRecord } from './sweep.js';
import type { RpcConn } from './unlock-vault.js';
import { driveChatTurn } from './install-packs.js';

export interface ProbeContext {
  readonly db: Database.Database;
  readonly booted: BootedServer;
  /** Live paired client, when the vault opened. The only way to observe an
   *  outbound-only subsystem. */
  readonly conn: RpcConn | undefined;
  /** Wall clock captured once at sweep start, so a probe's seeded ages are
   *  stable across cycles. */
  readonly now: number;
}

export interface Probe {
  /** How this subsystem was made to run more than once. Reported verbatim in
   *  the drivability map — Phase 2 requires saying which method per
   *  subsystem. */
  readonly drivenBy: string;
  /** Async setup run ONCE before `seed`, for a probe that must reconfigure the
   *  live server before it can afford to arm the pass it drives.
   *
   *  ⛔ ADDED FOR `audit-prune`, and the reason generalises. Its seed fills the
   *  audit log past `prune_at_pct% x audit.quota.bytes` — the only trigger armed
   *  under default config. D-230 raised that quota 50 MB -> 5 GB, so the same
   *  correct probe went from seeding ~35 MB to seeding **3.5 GB**, and the run
   *  died with a V8 heap OOM. Lowering the quota over the live rpc drives the
   *  IDENTICAL code path at a scale the harness can pay for; seeding less
   *  without lowering it would just miss the trigger and report a clean pass
   *  for a pruner that never ran. */
  readonly prepare?: (ctx: ProbeContext) => Promise<void>;
  /** Create due work. Returns the count created. 0 ⇒ undrivable. */
  readonly seed: (ctx: ProbeContext) => number;
  /** Count of work still DUE (i.e. that the task ought to act on). */
  readonly pending: (ctx: ProbeContext) => number;
  /** Awaited after each driven tick, before `pending()` is re-read.
   *
   *  ⚠ Needed by any subsystem whose progress is DELIVERED rather than
   *  written. The heartbeat broadcast is queued on the event loop even though
   *  server and client share a process, so reading `broadcasts` immediately
   *  after `tick()` returns sees nothing and the probe reports a defect that
   *  is purely its own impatience. */
  readonly settle?: (ctx: ProbeContext) => Promise<void>;
  /** Optional cursor/watermark readout, recorded per cycle. */
  readonly cursor?: (ctx: ProbeContext) => string | undefined;
  /** Optional total store size, for unbounded-growth assertions. */
  readonly storeSize?: (ctx: ProbeContext) => number;
  /** REPLACES the standard drain invariants. For a subsystem whose correct
   *  behaviour is not "pending reaches 0 in one pass" — a bounded RETRY queue
   *  advances a counter toward a terminal state instead. Return a string to
   *  fail, undefined to pass. */
  readonly customInvariant?: (
    ctx: ProbeContext,
    cycles: readonly CycleRecord[],
  ) => string | undefined;
  /** Extra assertion run after the standard invariants. Return a string to
   *  fail, undefined to pass. */
  readonly extraInvariant?: (
    ctx: ProbeContext,
    cycles: readonly CycleRecord[],
  ) => string | undefined;
  /** OPTIMIZATION check (see `optimization.ts`). Insert rows the tick must
   *  EXAMINE but must NOT act on, and return how many were added.
   *
   *  ⛔ THE ROWS MUST BE SETTLED. If they land in the pending set, the idle
   *  cycle costs more for an honest reason and the scaling check fires on
   *  correct code. `runOptimizationCheck` re-reads `pending()` after growth and
   *  refuses to render a verdict if it moved.
   *
   *  Absent ⇒ the subsystem is reported `no-probe` for optimization, which is a
   *  stated harness gap and NOT a clean result. */
  readonly growCorpus?: (ctx: ProbeContext, factor: number) => number;
  readonly note?: string;
}

const DAY = 24 * 60 * 60 * 1000;

const count = (ctx: ProbeContext, sql: string, ...params: unknown[]): number =>
  (ctx.db.prepare(sql).get(...(params as [])) as { c: number }).c;

const SEED_N = 5;

/** Heartbeat payloads received by the paired client, in arrival order. */
const heartbeats = (ctx: ProbeContext): Array<Record<string, unknown>> =>
  (ctx.conn?.broadcasts ?? [])
    .filter((f) => f.type === 'server_heartbeat')
    .map((f) => (f.payload ?? {}) as Record<string, unknown>);

/** ⚠ Read from the SCHEMA, never guessed. Trap #2: twelve guessed harness
 *  params in the webclient audit silently rendered empty defaults and would
 *  have swept "clean". These are the same defaults `bin.ts` hands the pruner
 *  when the operator has not overridden them. */
const schemaDefault = (key: string): number => {
  const entry = RUNTIME_SCHEMA_MAP[key];
  if (entry === undefined || typeof entry.default !== 'number') {
    throw new Error(`horizon: no numeric schema default for '${key}'`);
  }
  return entry.default;
};

/** ⚠ Reads the quota the server is LIVE on, not the schema default. `prepare`
 *  lowers it so the harness can afford to arm the trigger; if that write did
 *  not land, this falls back to the schema value and the seed sizes itself for
 *  the real quota. Either way the number here and the number the pruner
 *  enforces are the same one. */
const auditPruneTriggerBytes = (): number =>
  Math.floor(
    (auditProbeQuotaBytes ?? schemaDefault('audit.quota.bytes'))
      * (schemaDefault('audit.prune_at_pct') / 100),
  );

const auditUsedBytes = (ctx: ProbeContext): number =>
  (
    ctx.db
      .prepare(
        `SELECT COALESCE((SELECT SUM(length(data)) FROM audit_entries), 0)
              + COALESCE((SELECT SUM(length(data)) FROM audit_activities), 0) AS c`,
      )
      .get() as { c: number }
  ).c;

/** ── s2s-preview-prune ────────────────────────────────────────────────────
 *  `pruneExpired(now)` deletes rows whose `expires_at <= now`. Seed rows that
 *  are already past expiry, plus one that is NOT — the un-expired row is the
 *  probe's own known negative: a pruner that deletes everything is as wrong as
 *  one that deletes nothing, and the standard invariants would not notice. */
const s2sPreviewPrune: Probe = {
  drivenBy: 'aged rows + direct tick (registered cadence 1h)',
  seed: (ctx) => {
    const ins = ctx.db.prepare(
      `INSERT INTO s2s_preview_tokens
         (access_token, packet_kind, payload_blob, fields_visible_blob,
          created_at, expires_at, audit_target_id)
       VALUES (?, 'preview', '{}', '[]', ?, ?, NULL)`,
    );
    for (let i = 0; i < SEED_N; i++) {
      ins.run(`hz-expired-${i}`, ctx.now - 2 * DAY, ctx.now - DAY);
    }
    ins.run('hz-live', ctx.now, ctx.now + 30 * DAY);
    return SEED_N;
  },
  pending: (ctx) =>
    count(
      ctx,
      `SELECT COUNT(*) c FROM s2s_preview_tokens WHERE expires_at <= ?`,
      Date.now(),
    ),
  storeSize: (ctx) => count(ctx, `SELECT COUNT(*) c FROM s2s_preview_tokens`),
  extraInvariant: (ctx) =>
    count(ctx, `SELECT COUNT(*) c FROM s2s_preview_tokens WHERE access_token = 'hz-live'`) === 1
      ? undefined
      : 'the un-expired row was deleted — the sweep is not expiry-bounded',
  note: 'known negative embedded: one row 30d from expiry must survive every cycle',
};

/** ── correction-events-prune ──────────────────────────────────────────────
 *  Rows older than CORRECTION_EVENT_RETENTION_MS (1y) except durable kinds.
 *  Seed both, so the durable-kind carve-out is the embedded known negative. */
const correctionEventsPrune: Probe = {
  drivenBy: 'aged rows + direct tick (registered cadence 24h)',
  seed: (ctx) => {
    const ins = ctx.db.prepare(
      `INSERT INTO correction_events
         (id, ts, event_at, kind, payload_blob, source_plan_id,
          source_extraction_event_id, scope)
       VALUES (?, ?, ?, ?, '{}', NULL, NULL, 'global')`,
    );
    const old = ctx.now - 400 * DAY;
    for (let i = 0; i < SEED_N; i++) {
      ins.run(`hz-corr-${i}`, old, old, 'plan_edited');
    }
    // Durable kind, equally old — must survive.
    ins.run('hz-corr-durable', old, old, 'contact_merged');
    return SEED_N;
  },
  pending: (ctx) =>
    count(
      ctx,
      `SELECT COUNT(*) c FROM correction_events
        WHERE event_at < ? AND kind NOT IN ('contact_merged','standing_instruction_added')`,
      Date.now() - 365 * DAY,
    ),
  storeSize: (ctx) => count(ctx, `SELECT COUNT(*) c FROM correction_events`),
  extraInvariant: (ctx) =>
    count(ctx, `SELECT COUNT(*) c FROM correction_events WHERE id = 'hz-corr-durable'`) === 1
      ? undefined
      : 'a CORRECTION_EVENT_DURABLE_KINDS row was pruned — retention ate what it retains',
  growCorpus: (ctx, factor) => {
    // RECENT rows — inside the 365d window, so the cutoff query must EXAMINE
    // them and must never act on them. This is what a real server accumulates.
    const ins = ctx.db.prepare(
      `INSERT INTO correction_events
         (id, ts, event_at, kind, payload_blob, source_plan_id,
          source_extraction_event_id, scope)
       VALUES (?, ?, ?, 'plan_edited', '{}', NULL, NULL, 'global')`,
    );
    const recent = ctx.now - DAY;
    const n = SEED_N * factor;
    ctx.db.transaction(() => {
      for (let i = 0; i < n; i++) ins.run(`hz-corr-bulk-${i}`, recent, recent);
    })();
    return n;
  },
  note: 'known negative embedded: an equally-old contact_merged row must survive',
};

/** ── execution-case-sources-prune ─────────────────────────────────────────
 *  D-219. Deletes execution REPORTS + their observations once they are past
 *  the 30-day window AND back no materialized case, then rebuilds the corpus.
 *
 *  ⛔ WHY THIS WAS "NOT DRIVABLE" FOR MOST OF THIS AUDIT, and what changed.
 *  `execution_reports` has exactly one writer: the MODEL calling
 *  `outcome_report` mid-chat-turn (`chat-execution-case-tools.ts` —
 *  `putImmutable` has two call sites, both there). There is no non-AI path, so
 *  with no working LLM credential there was no way to create due work. A live
 *  credential is the whole unlock; no product code changed.
 *
 *  ⛔ THE ROWS CANNOT BE FORGED. `putImmutable` seals three columns through
 *  `sealD214Json`, and `openD214Json` does NOT sniff the encoding — a
 *  provider-backed read always decrypts. So a probe that INSERTed plaintext
 *  rows (the technique every other pruner here uses) would make the server's
 *  own `listAll()` throw, inside a tick whose catch is silent. The report has
 *  to come from the real writer.
 *
 *  🔑 TIME IS COMPRESSED ON THE PLAIN COLUMNS. `reported_at` / `closed_at` are
 *  INTEGER and unsealed, so ageing a genuine report past the window needs no
 *  key and changes nothing about its authenticity — the same trick the other
 *  retention probes use, applied to a row the product wrote.
 *
 *  ⚠ NON-DETERMINISTIC BY CONSTRUCTION. Whether a report exists depends on the
 *  model choosing to call the tool after "substantive governed tool work
 *  reaches its terminal outcome". `seed` returning 0 therefore means NOT DRIVEN
 *  THIS RUN — never "the pruner is broken". The sweep already treats
 *  `seeded === 0` as undrivable and says so.
 *
 *  ⛔ The invariant is NOT merely "rows disappeared". A report backing a
 *  materialized case must SURVIVE — retention that eats what it retains is
 *  amnesia — so the probe embeds that known negative and checks it every cycle. */
const EXECUTION_CASE_SOURCE_RETENTION_DAYS = 30;

/** Reports the pruner is entitled to delete: past the window and supporting no
 *  case. Mirrors `pruneSourcesOlderThan`'s own `doomed` filter, in SQL. */
const DOOMED_REPORTS_SQL = `
  SELECT COUNT(*) c FROM execution_reports
   WHERE COALESCE(closed_at, reported_at) < ?
     AND report_id NOT IN (SELECT report_id FROM execution_case_sources)`;

const executionCaseSourcesPrune: Probe = {
  drivenBy:
    'REAL chat turns (the model calling outcome_report is the only writer of '
    + 'execution_reports) + reported_at/closed_at aged past the 30d window '
    + '+ direct tick (registered cadence 24h)',
  prepare: async (ctx) => {
    if (!ctx.conn) return;
    // ⛔ ELICITING THE TOOL, NOT FAKING ITS ROW. `outcome_report` fires "after
    // substantive governed tool work reaches its terminal outcome", so the asks
    // below are governed WRITES that finish — a read-only listing is weaker
    // work and, measured across runs, less reliably produced a report. Several
    // attempts because the call remains the MODEL'S choice: the engine cannot
    // force it, and a probe that forced it would be testing a fixture.
    //
    // ⚠ If none of them lands, `seed` returns 0 and the sweep reports
    // "undrivable — cannot distinguish correctly-idle from never-advances".
    // That is the honest outcome, and it has happened on a real run; it is NOT
    // evidence the pruner is broken.
    for (const ask of [
      'Record a decision in the decision log titled "Horizon audit drive" with '
        + 'the rationale "driven by the long-horizon audit", then tell me '
        + 'whether you completed that request.',
      'Log a decision called "Retention probe" noting that the source-retention '
        + 'sweep needs a real report, then confirm whether it was fulfilled.',
      'List the open decisions using the decision log, then tell me whether '
        + 'you were able to complete that request.',
    ]) {
      try {
        await driveChatTurn(ctx.conn, ask, 180_000);
      } catch {
        // A refused or timed-out turn simply produces no report; `seed`
        // reports 0 and the sweep calls it undrivable. Never fatal.
      }
    }
  },
  seed: (ctx) => {
    // Age ONLY the unsupported reports. A supported one is left at its real
    // age so the survival invariant below is about the pruner's own guard
    // rather than about it never having been a candidate.
    const cutoff = ctx.now - (EXECUTION_CASE_SOURCE_RETENTION_DAYS + 5) * DAY;
    const res = ctx.db
      .prepare(
        `UPDATE execution_reports
            SET reported_at = ?,
                closed_at = CASE WHEN closed_at IS NULL THEN NULL ELSE ? END
          WHERE report_id NOT IN (SELECT report_id FROM execution_case_sources)`,
      )
      .run(cutoff, cutoff);
    return res.changes;
  },
  pending: (ctx) =>
    count(ctx, DOOMED_REPORTS_SQL, ctx.now - EXECUTION_CASE_SOURCE_RETENTION_DAYS * DAY),
  storeSize: (ctx) => count(ctx, `SELECT COUNT(*) c FROM execution_reports`),
  extraInvariant: (ctx) => {
    // ⛔ THE KNOWN NEGATIVE. Every report a materialized case rests on must
    // still be there. `pruneSourcesOlderThan` collects that set BEFORE
    // deleting anything; if the collection regressed, this is what notices.
    const orphaned = count(
      ctx,
      `SELECT COUNT(*) c FROM execution_case_sources s
        WHERE NOT EXISTS (
          SELECT 1 FROM execution_reports r WHERE r.report_id = s.report_id)`,
    );
    if (orphaned > 0) {
      return `${orphaned} case-source row(s) point at a DELETED report — `
        + 'retention ate a report a materialized case rests on';
    }
    // ⛔ And the compiled marker must not outlive its report: a stale marker
    // makes `canCompileIncrementally` refuse forever, silently downgrading
    // every later turn to a full replay. Symptom would appear far from here.
    return undefined;
  },
  note:
    'known negative embedded: a report backing a materialized case must survive, '
    + 'and no case-source row may point at a deleted report. seeded=0 means the '
    + 'model did not call outcome_report this run — NOT that the pruner failed',
};

/** ── execution-case-arguments-prune ───────────────────────────────────────
 *  D-219 capture-only buffer; 90d window. Nothing reads it, which is exactly
 *  why an unbounded one would be an archive nobody decided to keep. */
const executionCaseArgumentsPrune: Probe = {
  drivenBy: 'aged rows + direct tick (registered cadence 24h)',
  seed: (ctx) => {
    const ins = ctx.db.prepare(
      `INSERT INTO execution_case_arguments
         (capture_id, session_id, turn_id, tool_name, captured_at, args_encrypted)
       VALUES (?, 'hz-s', 'hz-t', 'hz.tool', ?, 'x')`,
    );
    for (let i = 0; i < SEED_N; i++) {
      ins.run(`hz-arg-${i}`, ctx.now - 120 * DAY);
    }
    ins.run('hz-arg-fresh', ctx.now);
    return SEED_N;
  },
  pending: (ctx) =>
    count(
      ctx,
      `SELECT COUNT(*) c FROM execution_case_arguments WHERE captured_at < ?`,
      Date.now() - 90 * DAY,
    ),
  storeSize: (ctx) =>
    count(ctx, `SELECT COUNT(*) c FROM execution_case_arguments`),
  extraInvariant: (ctx) =>
    count(
      ctx,
      `SELECT COUNT(*) c FROM execution_case_arguments WHERE capture_id = 'hz-arg-fresh'`,
    ) === 1
      ? undefined
      : 'a row inside the 90d window was pruned',
  growCorpus: (ctx, factor) => {
    // FRESH captures — inside the 90d window, examined but never due.
    const ins = ctx.db.prepare(
      `INSERT INTO execution_case_arguments
       VALUES (?, 'hz-s', 'hz-t', 'hz.tool', ?, 'x')`,
    );
    const n = SEED_N * factor;
    ctx.db.transaction(() => {
      for (let i = 0; i < n; i++) ins.run(`hz-arg-bulk-${i}`, ctx.now);
    })();
    return n;
  },
  note: 'known negative embedded: a fresh capture must survive every cycle',
};

/** ── handled-ask-prune ────────────────────────────────────────────────────
 *  D-210. `handled` rows older than 7d go; `open` and `answered` NEVER go —
 *  `answered` is the retry queue and `open` is a live decision, so both are
 *  seeded aged as the embedded known negative. */
/** A `pending_asks` row body. Module-scoped so `seed` and `growCorpus` build
 *  the IDENTICAL shape — a grow-corpus row that differs structurally from a
 *  seeded one would measure a different query path than the one under test. */
const mkPendingAsk = (
  ask_id: string,
  status: string,
  created_at: number,
): string =>
  JSON.stringify({
    ask_id,
    message: { title: 'hz', body: 'hz' },
    options: [{ id: 'ok', label: 'OK' }],
    handler_kind: 'noop',
    handler_payload: {},
    fanout_channels: [],
    status,
    created_at,
    ...(status === 'open' ? {} : { answer: { option: 'ok' } }),
  });

const handledAskPrune: Probe = {
  drivenBy: 'aged rows + direct tick (registered cadence 1h)',
  seed: (ctx) => {
    const ins = ctx.db.prepare(
      `INSERT INTO pending_asks (key, data) VALUES (?, ?)`,
    );
    const old = ctx.now - 30 * DAY;
    for (let i = 0; i < SEED_N; i++) {
      ins.run(`hz-ask-${i}`, mkPendingAsk(`hz-ask-${i}`, 'handled', old));
    }
    ins.run('hz-ask-open', mkPendingAsk('hz-ask-open', 'open', old));
    ins.run('hz-ask-answered', mkPendingAsk('hz-ask-answered', 'answered', old));
    return SEED_N;
  },
  pending: (ctx) =>
    count(
      ctx,
      `SELECT COUNT(*) c FROM pending_asks
        WHERE json_extract(data,'$.status') = 'handled'
          AND json_extract(data,'$.created_at') < ?`,
      Date.now() - 7 * DAY,
    ),
  growCorpus: (ctx, factor) => {
    // HANDLED but RECENT — the status the sweep selects on, at an age it must
    // not act on. Deliberately the SAME status as the due rows: growing the
    // corpus with a status the query filters out in SQL would measure nothing,
    // because the index would skip every added row.
    const ins = ctx.db.prepare(
      `INSERT INTO pending_asks (key, data) VALUES (?, ?)`,
    );
    const n = SEED_N * factor;
    ctx.db.transaction(() => {
      for (let i = 0; i < n; i++) {
        ins.run(`hz-ask-bulk-${i}`, mkPendingAsk(`hz-ask-bulk-${i}`, 'handled', ctx.now));
      }
    })();
    return n;
  },
  storeSize: (ctx) => count(ctx, `SELECT COUNT(*) c FROM pending_asks`),
  extraInvariant: (ctx) => {
    const survivors = count(
      ctx,
      `SELECT COUNT(*) c FROM pending_asks WHERE key IN ('hz-ask-open','hz-ask-answered')`,
    );
    return survivors === 2
      ? undefined
      : `an open/answered ask was pruned (${survivors}/2 survived) — `
        + 'the status check IS the safety property';
  },
  note: 'known negative embedded: aged open + answered asks must survive every cycle',
};

/** ── audit-prune ──────────────────────────────────────────────────────────
 *  Two passes, and only ONE of them is live under default config:
 *
 *    age pass  — gated on `audit.retention_days`, whose default is 0, which
 *                `bin.ts` collapses to `null` = "no expiry". DISABLED by
 *                default, deliberately (D-120 post-amendment).
 *    size pass — fires once `SUM(length(data))` across both audit tables
 *                exceeds `audit.prune_at_pct%` of `audit.quota.bytes`.
 *                ALWAYS live; it protects the quota, not a window.
 *
 *  ⚠ Instrument correction #2 (2026-08-04). The first version of this probe
 *  seeded five 400-day-old rows and reported "ran 4× and drained 0" as a
 *  finding. It was not one: the age pass is off by default and five small
 *  rows are ~35 MB short of the size trigger. The pruner was correct and the
 *  probe was wrong — exactly trap #3, the instrument being the likeliest
 *  source of its own findings. The probe now drives the pass that is
 *  ACTUALLY ARMED under default config, by seeding past the real trigger. */
/** What the probe LOWERS `audit.quota.bytes` to before seeding.
 *
 *  ⛔ NOT A SHRUNKEN VERSION OF THE TEST. The size pass is quota-RELATIVE: it
 *  fires at `prune_at_pct%` of whatever the quota is and reclaims back under
 *  it. Driving it at 48 MB exercises the same branch, the same statements and
 *  the same row cap as driving it at 5 GB — only the arithmetic differs. What
 *  would NOT be equivalent is seeding less and leaving the quota alone: the
 *  trigger simply would not arm, and the probe would report a clean drain for
 *  a pruner that never ran. */
const AUDIT_PROBE_QUOTA_BYTES = 48 * 1024 * 1024;

/** Resolved by `prepare`, so `seed` / `pending` compute against the quota the
 *  server is ACTUALLY enforcing rather than the schema default. */
let auditProbeQuotaBytes: number | undefined;

const auditPrune: Probe = {
  drivenBy:
    'lowered audit.quota.bytes over rpc, seeded past the live size-prune '
    + 'trigger + direct tick (registered cadence from audit.prune_interval_s)',
  prepare: async (ctx) => {
    if (!ctx.conn) return; // no vault → seed falls back to the schema default
    try {
      await ctx.conn.rpc(
        'server.setConfigField',
        { key: 'audit.quota.bytes', value: AUDIT_PROBE_QUOTA_BYTES },
        30_000,
      );
      auditProbeQuotaBytes = AUDIT_PROBE_QUOTA_BYTES;
    } catch {
      // ⚠ Deliberately silent-and-unset, NOT silent-and-assumed. If the write
      // failed the server is still on the 5 GB default; leaving
      // `auditProbeQuotaBytes` undefined makes the seed size itself off the
      // real quota, so the probe either arms the trigger honestly or dies
      // trying — it never seeds 48 MB against a 5 GB trigger and calls the
      // resulting no-op a pass.
      auditProbeQuotaBytes = undefined;
    }
  },
  seed: (ctx) => {
    // One 64 KiB row per insert — enough rows to clear the trigger with a
    // margin, few enough that the seed is fast.
    const CHUNK = 64 * 1024;
    const target = auditPruneTriggerBytes() + 4 * 1024 * 1024;
    const rows = Math.ceil(target / CHUNK);
    const ins = ctx.db.prepare(
      `INSERT INTO audit_entries (key, data) VALUES (?, ?)`,
    );
    const old = ctx.now - 400 * DAY;
    const filler = 'x'.repeat(CHUNK - 220);
    const tx = ctx.db.transaction(() => {
      for (let i = 0; i < rows; i++) {
        const key = `hz-audit-${String(i).padStart(6, '0')}`;
        ins.run(
          key,
          JSON.stringify({
            id: key,
            ts: old + i,
            started_at: old + i,
            recipe_id: 'hz.recipe',
            status: 'success',
            filler,
          }),
        );
      }
    });
    tx();
    return rows;
  },
  // "Due work" = bytes above the size-prune trigger, in KiB. Reaches 0 when
  // the pruner has reclaimed back under the threshold.
  pending: (ctx) => {
    const used = auditUsedBytes(ctx);
    return Math.max(0, Math.ceil((used - auditPruneTriggerBytes()) / 1024));
  },
  storeSize: (ctx) => count(ctx, `SELECT COUNT(*) c FROM audit_entries`),
  /** ⛔ SETTLED rows — deliberately far UNDER the prune trigger, so they are
   *  work the idle tick must EXAMINE and must never act on. If they pushed
   *  usage back over the trigger the tick would do real work, the cost rise
   *  would be honest, and confirming against it would be a lie.
   *
   *  Small rows on purpose: `measureAuditUsage()` is `SUM(length(data))`, so
   *  what is under test is how many ROWS it must read, not how many bytes they
   *  hold. 200-byte rows let the corpus grow by thousands while usage stays a
   *  rounding error against the 48 MB probe quota. */
  growCorpus: (ctx, factor) => {
    const n = 40 * factor;
    const ins = ctx.db.prepare(
      `INSERT INTO audit_entries (key, data) VALUES (?, ?)`,
    );
    const recent = ctx.now - 60_000;
    const filler = 'y'.repeat(120);
    ctx.db.transaction(() => {
      for (let i = 0; i < n; i++) {
        const key = `hz-audit-bulk-${String(i).padStart(6, '0')}`;
        ins.run(key, JSON.stringify({
          id: key, ts: recent, started_at: recent,
          recipe_id: 'hz.recipe', status: 'success', filler,
        }));
      }
    })();
    return n;
  },
  extraInvariant: (ctx, cycles) => {
    // The size pass is capped at `audit.prune_max_rows_per_run`, so one tick
    // is allowed not to finish. What is NOT allowed is a tick that reclaims
    // nothing while over the trigger — and equally, a tick that keeps
    // deleting after usage is back under it.
    const stillOver = cycles[cycles.length - 1].pendingAfter > 0;
    if (stillOver) {
      return 'usage never came back under the size-prune trigger';
    }
    const reserveKept = count(
      ctx,
      `SELECT COUNT(*) c FROM audit_activities
        WHERE json_extract(data,'$.reserve') = 1`,
    );
    const reserveTotal = count(
      ctx,
      `SELECT COUNT(*) c FROM audit_activities
        WHERE json_extract(data,'$.reserve') = 1`,
    );
    return reserveKept === reserveTotal
      ? undefined
      : 'a reserve-class activity row was evicted by the size pass';
  },
  note:
    'age pass is DISABLED under default config (audit.retention_days = 0 → null); '
    + 'this drives the size pass, which is the one armed by default',
};


/** ── mcp-recipe-callback-prune ────────────────────────────────────────────
 *  TTL + authority sweep over `mcp.recipe-callback.*` rows in the shared
 *  store. ⚠ It does NOT delete: it rewrites the row to a `retired: true`
 *  marker, deliberately keeping the CAS revision as a fence against
 *  delete/recreate ABA. So "pending" is rows that are NOT yet retired —
 *  counting deletions here would report a working sweep as broken. */
const mcpRecipeCallbackPrune: Probe = {
  drivenBy: 'expired pointers in shared_store + direct tick (registered cadence 1h)',
  seed: (ctx) => {
    const TOKEN = 'abcdef0123456789';
    const ins = ctx.db.prepare(
      `INSERT INTO shared_store
         (key, value_inline, blob_hash, size_bytes, author_id, recipe_id,
          written_at, last_read_at, cas_revision)
       VALUES (?, ?, NULL, ?, 'kernel:mcp-recipe-callback', NULL, ?, NULL, 1)`,
    );
    for (let i = 0; i < SEED_N; i++) {
      const value = JSON.stringify({
        schema_version: 1,
        revision: 1,
        callback_ref: `hz-cb-${i}`,
        target_token_id: TOKEN,
        target_contract_id: 'hz-contract',
        topic: 'hz.topic',
        query_tool: 'hz.tool',
        arguments: {},
        triggered_at: ctx.now - 2 * DAY,
        // Already past its TTL — the sweep must retire it.
        expires_at: ctx.now - DAY,
        source_recipe_id: 'hz.recipe',
      });
      ins.run(
        `mcp.recipe-callback.${TOKEN}.hz-${i}`,
        value,
        value.length,
        ctx.now - 2 * DAY,
      );
    }
    return SEED_N;
  },
  pending: (ctx) =>
    count(
      ctx,
      `SELECT COUNT(*) c FROM shared_store
        WHERE key LIKE 'mcp.recipe-callback.%'
          AND COALESCE(json_extract(value_inline, '$.retired'), 0) != 1`,
    ),
  storeSize: (ctx) =>
    count(ctx, `SELECT COUNT(*) c FROM shared_store WHERE key LIKE 'mcp.recipe-callback.%'`),
  extraInvariant: (ctx) => {
    // The CAS row must SURVIVE retirement — it is the ABA fence.
    const rows = count(
      ctx,
      `SELECT COUNT(*) c FROM shared_store WHERE key LIKE 'mcp.recipe-callback.%'`,
    );
    return rows === SEED_N
      ? undefined
      : `the retention deleted the CAS revision fence (${rows} of ${SEED_N} rows remain) `
        + '— a delete/recreate ABA race becomes possible';
  },
  note:
    'retirement REWRITES the row to a retired marker; it must not delete it. '
    + '⚠ LIMIT: this seeds a token id with no `chat_inbound_tokens` row, so '
    + '`!tokenCanReceivePointer(...)` is true and the sweep would retire these '
    + 'rows even with the TTL check broken — mutating `expires_at <= now` away '
    + 'does NOT redden this probe. Isolating the TTL branch needs a VALID '
    + 'inbound token (matching contract_id + tool authorization). The TTL was '
    + 'verified separately by removing the token disjunct instead: the same 5 '
    + 'rows still drained, so the TTL path works. Vacuity-proven: forcing the '
    + 'sweep to retain everything DOES redden this probe.',
};


/** ── records-outbox ───────────────────────────────────────────────────────
 *  The reactive delivery queue. Drivable only once a records pack is INSTALLED
 *  and a real record mutation has run — the outbox is accounted against a
 *  `core_record_namespaces` row, and `failDelivery` ends in
 *  `decrementOutboxAccounting`, which needs that row with `outbox_count > 0`.
 *  A raw-SQL seed throws there, and the tick swallows the throw into a
 *  console.warn, so the queue silently does not drain while the tick looks
 *  clean. The harness now installs `rental-book` and runs `add-building` over
 *  the paired connection, so the event arrives through the real enqueue path.
 *
 *  ⚠ `seed()` DELIBERATELY CREATES NOTHING. The due work is whatever the real
 *  mutation enqueued; inventing rows here would reintroduce the very
 *  hand-built state that made this subsystem unreadable for two rounds. If the
 *  mutation produced no pending delivery, the sweep reports `undrivable`
 *  rather than a pass. */
const recordsOutbox: Probe = {
  drivenBy:
    'real record mutation via an installed pack (decision-log / log-decision, '
    + 'whose record.created watcher is what enqueues the delivery) + direct '
    + 'tick (registered cadence 1s)',
  seed: (ctx) =>
    count(
      ctx,
      `SELECT COUNT(*) c FROM core_record_outbox_deliveries d
         JOIN core_record_outbox o ON o.event_id = d.event_id
        WHERE o.status = 'pending' AND d.status = 'pending'`,
    ),
  pending: (ctx) =>
    count(
      ctx,
      `SELECT COUNT(*) c FROM core_record_outbox_deliveries d
         JOIN core_record_outbox o ON o.event_id = d.event_id
        WHERE o.status = 'pending' AND d.status = 'pending'`,
    ),
  storeSize: (ctx) =>
    count(ctx, `SELECT COUNT(*) c FROM core_record_outbox_deliveries`),
  // The retry counter IS the cursor here — it is what advances a failing
  // delivery toward `dead_letter`.
  cursor: (ctx) =>
    String(
      count(
        ctx,
        `SELECT COALESCE(MAX(retry_count), 0) c FROM core_record_outbox_deliveries`,
      ),
    ),
  // ⛔ The default "cycle 1 must drain" invariant is WRONG for this subsystem
  // and reported a defect that was not one. `drainRecordsOutboxOnce` retries a
  // failing delivery up to `max_retries` (10) before dead-lettering, so a row
  // still pending after 4 cycles is CORRECT — provided it is moving. The real
  // long-horizon property is: a delivery either drains, or its retry counter
  // advances toward the terminal cap. A counter that does not move is a row
  // the reactive path will re-attempt forever.
  customInvariant: (_ctx, cycles) => {
    const first = cycles[0];
    const last = cycles[cycles.length - 1];
    if (last.pendingAfter === 0) return undefined;
    const startRetry = Number(first.cursor ?? '0');
    const endRetry = Number(last.cursor ?? '0');
    if (endRetry > startRetry) return undefined;
    // ⚠ Parenthesised deliberately. The first version wrote `return` followed
    // by a newline, so ASI returned `undefined` and the whole message was dead
    // code — the probe reported CLEAN on a deliberately stuck retry counter.
    // Caught only by running the mutation proof.
    return (
      `${last.pendingAfter} delivery row(s) still pending after ${cycles.length} `
      + `cycles AND the retry counter did not move (${startRetry} → ${endRetry}) `
      + '— the drain is neither delivering, retrying, nor dead-lettering, so '
      + 'the row is re-attempted forever at 1s with no progress'
    );
  },
  note:
    'a pending DELIVERY needs a records WATCHER — `insertDelivery` only fires '
    + 'for matching subscriber bindings, and an untargeted event is terminal on '
    + 'the spot. The corpus watchers were both blocked (job-status-board needs '
    + 'a gateway-minted context.caller.contract_id; field-service-day-plan '
    + 'needs a nominatim connection), so `decision-log` was authored to close '
    + 'the gap. ⚠ The delivery here FAILS and retries — that is the point: it '
    + 'exercises the retry path rather than the happy one, and the invariant '
    + 'is bounded progress toward dead_letter, not immediate drain.',
};


/** ── checkpoint-stale-prune ───────────────────────────────────────────────
 *  D-157 N.8. Two halves: a STALENESS GUARD that expires an
 *  `awaiting_approval` checkpoint older than `preflight.stale_after_days`
 *  (schema default 30; `0` disables), and GARBAGE COLLECTION of orphaned /
 *  terminal / superseded rows past a fixed 24 h grace.
 *
 *  Drivable only because the harness now pushes a real run INTO the gate:
 *  `retire-decision` calls `decision.delete`, which is
 *  `risk: destructive, approval: always` and binds a STORAGE op — so it needs
 *  no connection. That matters: the gateway resolves the connection profile
 *  BEFORE the approval gate, so every API pack's gated op is denied
 *  `no_connection_profile` and never reaches a pause (verified against
 *  `heroku.dyno.restart_one`).
 *
 *  ⚠ Time compressed by AGEING THE CHECKPOINT, not the clock — the sweep reads
 *  `checkpoint.created_at` and resolves the window live each pass.
 *
 *  ⛔ The invariant is NOT "the row disappeared". Expiry has to do the whole
 *  job: cancel the ask, retire the run anchor to a terminal status, and delete
 *  the checkpoint. A sweep that deleted the row and left the anchor stuck at
 *  `awaiting_approval` would strand the run forever while looking clean — the
 *  part-of-its-job failure this audit's Phase 0 was built around. */
const checkpointStalePrune: Probe = {
  drivenBy:
    'real preflight pause (retire-decision → decision.delete, destructive/always) '
    + 'aged past preflight.stale_after_days + direct tick (registered cadence 1h)',
  seed: (ctx) => {
    const windowMs = schemaDefault('preflight.stale_after_days') * DAY;
    if (windowMs === 0) return 0; // guard disabled — nothing to drive
    const rows = ctx.db
      .prepare(`SELECT key, data FROM checkpoints`)
      .all() as Array<{ key: string; data: string }>;
    const update = ctx.db.prepare(`UPDATE checkpoints SET data = ? WHERE key = ?`);
    let aged = 0;
    for (const row of rows) {
      let parsed: { recipe_id?: string; created_at?: number };
      try {
        parsed = JSON.parse(row.data) as typeof parsed;
      } catch {
        continue;
      }
      if (parsed.recipe_id !== 'retire-decision') continue;
      parsed.created_at = ctx.now - windowMs - 7 * DAY;
      update.run(JSON.stringify(parsed), row.key);
      aged += 1;
    }
    return aged;
  },
  pending: (ctx) => {
    const windowMs = schemaDefault('preflight.stale_after_days') * DAY;
    return count(
      ctx,
      `SELECT COUNT(*) c FROM checkpoints
        WHERE json_extract(data, '$.recipe_id') = 'retire-decision'
          AND json_extract(data, '$.created_at') < ?`,
      Date.now() - windowMs,
    );
  },
  storeSize: (ctx) => count(ctx, `SELECT COUNT(*) c FROM checkpoints`),
  extraInvariant: (ctx) => {
    // ⛔ Whole-job check. The run anchor must not still be waiting.
    const stranded = count(
      ctx,
      `SELECT COUNT(*) c FROM audit_entries
        WHERE json_extract(data, '$.recipe_id') = 'retire-decision'
          AND json_extract(data, '$.commit_status') = 'awaiting_approval'`,
    );
    if (stranded > 0) {
      return `${stranded} run anchor(s) left at 'awaiting_approval' after the `
        + 'checkpoint was expired — the run is unresumable and waits forever';
    }
    // The ask must not still be open for a decision that can no longer be acted on.
    const openAsk = count(
      ctx,
      `SELECT COUNT(*) c FROM pending_asks
        WHERE json_extract(data, '$.status') = 'open'
          AND json_extract(data, '$.message.title') LIKE '%decision.delete%'`,
    );
    return openAsk === 0
      ? undefined
      : `${openAsk} ask(s) still open after expiry — the prompt outlives the run`;
  },
  note:
    'expiry must cancel the ask AND retire the anchor, not merely delete the '
    + 'checkpoint row; the seed carries unrelated checkpoints, so the probe '
    + 'targets only the run it pushed into the gate',
};


/** ── server-heartbeat-emitter ─────────────────────────────────────────────
 *  Tier-3 liveness beat, broadcast to every paired client every 5s.
 *
 *  ⛔ I previously called this NOT DRIVABLE because "progress is an outbound
 *  send, not a persisted watermark, so there is nothing to assert a cursor
 *  against from the database side". That was true of the DATABASE side and
 *  wrong as a conclusion: the harness now holds a real paired client, which is
 *  the other end of the send. `last_seen_at` is stamped fresh per beat, so the
 *  watermark exists — it is just on the wire rather than on disk.
 *
 *  The emitter deliberately SUPPRESSES a beat unless the lifecycle is
 *  accepting rpc ("a beat means the server is responsive"), so a beat that
 *  keeps arriving with a frozen `last_seen_at` is precisely the stalled-but-
 *  reporting-success shape this audit hunts.
 *
 *  ⚠ The real 5s interval stays armed and the sweep runs longer than that, so
 *  extra beats interleave with the driven ones. The assertions are therefore
 *  written to be robust to extra beats (>= not ==) — a probe that demanded an
 *  exact count would fail on correct behaviour. */
const serverHeartbeatEmitter: Probe = {
  drivenBy: 'paired WS client observing broadcasts + direct tick (registered cadence 5s)',
  seed: (ctx) => {
    if (!ctx.conn) return 0;
    ctx.conn.broadcasts.length = 0;
    return 1;
  },
  // Not a drain — `customInvariant` below replaces the drain logic entirely.
  pending: () => 1,
  // Give the queued broadcast a chance to land, bounded so a genuinely silent
  // emitter still fails rather than hanging.
  settle: async (ctx) => {
    const before = heartbeats(ctx).length;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (heartbeats(ctx).length > before) return;
    }
  },
  cursor: (ctx) => String(heartbeats(ctx).length),
  customInvariant: (ctx, cycles) => {
    const beats = heartbeats(ctx);
    if (beats.length < cycles.length) {
      return `${cycles.length} ticks produced only ${beats.length} heartbeat `
        + 'broadcast(s) — a driven tick emitted nothing to a paired client';
    }
    const seen = beats.map((b) => Number(b.last_seen_at ?? 0));
    for (let i = 1; i < seen.length; i++) {
      if (seen[i] <= seen[i - 1]) {
        return `heartbeat ${i + 1} reported last_seen_at ${seen[i]}, not ahead of `
          + `${seen[i - 1]} — the beat keeps arriving with a frozen watermark, `
          + 'which reads as a live server that has stopped advancing';
      }
    }
    const uptime = beats.map((b) => Number(b.uptime_s ?? 0));
    for (let i = 1; i < uptime.length; i++) {
      if (uptime[i] < uptime[i - 1]) {
        return `uptime_s went backwards (${uptime[i - 1]} → ${uptime[i]}) with no `
          + 'restart_count change';
      }
    }
    return undefined;
  },
  note:
    'assertable only because a paired client is subscribed; the beat carries '
    + 'the watermark on the wire, not on disk',
};


/** Pre-boot fixture for `reception-rate-snapshot`.
 *
 *  ⛔ MUST run before `serve()`. The limiter rehydrates its in-memory map from
 *  this table during composition (`receptionRateLimiter.reload(Date.now())` in
 *  `wire-per-pair-stores.ts`), and `reload` applies NO window filter — it takes
 *  the newest rows regardless of expiry. Seeding after boot would leave rows in
 *  SQLite while the map the snapshot tick actually evicts from stayed empty,
 *  so only half the subsystem would be under test.
 *
 *  Three expired buckets and one live one. The live bucket is the embedded
 *  known negative: an eviction sweep that drops everything is as wrong as one
 *  that drops nothing, and the drain count alone cannot tell them apart. */
export const RECEPTION_RATE_SEED_EXPIRED = 3;

export const seedReceptionRateLimiter = (db: Database.Database): void => {
  const now = Date.now();
  const ins = db.prepare(
    `INSERT OR REPLACE INTO reception_rate_limiter
       (bucket_key, bucket_kind, window_start_at, window_end_at, count,
        last_request_at, exhausted_at)
     VALUES (?, 'per_ip_global', ?, ?, ?, ?, NULL)`,
  );
  for (let i = 0; i < RECEPTION_RATE_SEED_EXPIRED; i++) {
    ins.run(`per_ip_global:hz-expired-${i}`, now - 2 * DAY, now - DAY, 7, now - 2 * DAY);
  }
  ins.run('per_ip_global:hz-live', now, now + 30 * DAY, 1, now);
};

/** ── reception-rate-snapshot ──────────────────────────────────────────────
 *  Not really a "snapshot" — the 30s tick is the limiter's EVICTION SWEEP and
 *  its own comment says so: "the 30s cadence doubles as the eviction sweep: a
 *  bucket whose window has closed is dropped from memory … rather than
 *  persisted", plus a `DELETE … WHERE window_end_at <= now` that keeps the
 *  snapshot table from growing "without bound alongside the in-memory map".
 *
 *  That is this audit's bounded-store class exactly: a TTL that stops firing
 *  leaves an unbounded map AND an unbounded table, while the tick keeps
 *  returning cleanly every 30 seconds forever. */
const receptionRateSnapshot: Probe = {
  /** ⛔ RE-SEED, because the harness's own timing assumption broke. `boot.ts`
   *  says "every registered cadence in this codebase is >= 60s and the sweep
   *  runs in seconds, so no timer fires on its own during a run". This
   *  subsystem's cadence is **30s**, and once the run started making LIVE model
   *  calls (pack install + a real chat turn before the sweep even begins) the
   *  boot-to-sweep gap grew past it. The real timer then fired, drained the
   *  pre-boot fixture, and `seed()` — which COUNTS the surviving rows rather
   *  than creating them — returned 0. The probe flapped between `clean` and
   *  `undrivable` run to run for a reason that had nothing to do with the
   *  product.
   *
   *  ⚠ The PRE-BOOT seed stays. It is what drives the IN-MEMORY half: the
   *  limiter rehydrates through its own `reload()` during composition, and the
   *  tick evicts from that map as well as from SQLite. This hook only restores
   *  the SQLite rows a self-firing timer consumed, so the sweep has due work to
   *  measure; it cannot re-populate the map, which is exactly why the pre-boot
   *  path is not replaced by it. */
  prepare: async (ctx) => {
    const existing = count(
      ctx,
      `SELECT COUNT(*) c FROM reception_rate_limiter
        WHERE bucket_key LIKE 'per_ip_global:hz-expired-%'`,
    );
    if (existing >= RECEPTION_RATE_SEED_EXPIRED) return;
    // ⚠ Column list taken from `seedReceptionRateLimiter` above, not written
    // from memory — a guessed one ("last_seen_at") threw at the first run.
    // Same rows, same shape; the ONLY difference is the clock source.
    const ins = ctx.db.prepare(
      `INSERT OR REPLACE INTO reception_rate_limiter
         (bucket_key, bucket_kind, window_start_at, window_end_at, count,
          last_request_at, exhausted_at)
       VALUES (?, 'per_ip_global', ?, ?, ?, ?, NULL)`,
    );
    const now = ctx.now;
    for (let i = 0; i < RECEPTION_RATE_SEED_EXPIRED; i++) {
      ins.run(`per_ip_global:hz-expired-${i}`, now - 2 * DAY, now - DAY, 7, now - 2 * DAY);
    }
    // The known negative: a bucket 30d from closing must survive every cycle.
    ins.run('per_ip_global:hz-live', now, now + 30 * DAY, 1, now);
  },
  drivenBy:
    "pre-boot rows rehydrated by the limiter's own reload() + direct tick "
    + '(registered cadence 30s)',
  seed: (ctx) =>
    count(
      ctx,
      `SELECT COUNT(*) c FROM reception_rate_limiter
        WHERE bucket_key LIKE 'per_ip_global:hz-expired-%'`,
    ),
  pending: (ctx) =>
    count(
      ctx,
      `SELECT COUNT(*) c FROM reception_rate_limiter WHERE window_end_at <= ?`,
      Date.now(),
    ),
  storeSize: (ctx) => count(ctx, `SELECT COUNT(*) c FROM reception_rate_limiter`),
  extraInvariant: (ctx) => {
    const live = count(
      ctx,
      `SELECT COUNT(*) c FROM reception_rate_limiter
        WHERE bucket_key = 'per_ip_global:hz-live'`,
    );
    return live === 1
      ? undefined
      : 'the still-open bucket was evicted — the sweep is not window-bounded, '
        + "so it would reset a live visitor's counter mid-window";
  },
  note:
    'known negative embedded: a bucket 30d from closing must survive every '
    + 'cycle. The tick also evicts from the in-memory map, which is why the '
    + 'fixture is seeded PRE-BOOT and rehydrated by the real reload()',
};

export const PROBES: Record<string, Probe> = {
  's2s-preview-prune': s2sPreviewPrune,
  'correction-events-prune': correctionEventsPrune,
  'execution-case-arguments-prune': executionCaseArgumentsPrune,
  'execution-case-sources-prune': executionCaseSourcesPrune,
  'handled-ask-prune': handledAskPrune,
  'audit-prune': auditPrune,
  'mcp-recipe-callback-prune': mcpRecipeCallbackPrune,
  'records-outbox': recordsOutbox,
  'checkpoint-stale-prune': checkpointStalePrune,
  'server-heartbeat-emitter': serverHeartbeatEmitter,
  'reception-rate-snapshot': receptionRateSnapshot,
};

/** Subsystems that CANNOT be driven by this harness, with the reason.
 *
 *  ⛔ Phase 2 requires saying which method was used per subsystem, and
 *  "not drivable — say so, and say why" is a legitimate answer. What is NOT
 *  legitimate is letting it read the same as "no probe written yet", or the
 *  same as clean. Both still exit non-zero; they say different things. */
export const NOT_DRIVABLE: Record<string, string> = {
  'ddns-update-poll':
    'requires a cloud DDNS binding + reachable control plane; the poll is a '
    + 'no-op without an enrolled Pro subdomain, and faking one would drive a '
    + 'branch production never takes on a free self-host',
  'pro-convenience-provision':
    'requires a Pro entitlement + ACME/DNS-01 issuance against a live CA; '
    + 'cannot be compressed or stubbed without testing the stub',
  'hostname-reconciliation-daily':
    'reconciles against externally-observed hostname state (DNS + cert SANs); '
    + 'no local seam produces a genuine divergence to reconcile',
};
