/** Long-horizon audit — the report.
 *
 *  ⛔ Prints the drivability map FIRST and exits non-zero when anything was
 *  not driven. The webclient sweep once printed ✓ for 55 surfaces that never
 *  mounted and summarised as one finding; the shape of this output exists to
 *  make that impossible — `AUDITED` is a count of subsystems whose progress
 *  invariant actually ran, not a count of subsystems that did not complain. */

import type { BootCapture } from './boot.js';
import type { StaticIntervalSite, StaticServiceSite } from './inventory.js';
import type { SweepResult } from './sweep.js';

const pad = (s: string, n: number): string => s.padEnd(n, ' ');

export const report = (input: {
  staticIntervals: readonly StaticIntervalSite[];
  staticServices: readonly StaticServiceSite[];
  capture: BootCapture;
  sweep: SweepResult;
  cycles: number;
  vault: { ok: boolean; via?: string; reason?: string };
  installs: readonly { slug: string; ok: boolean; detail: string }[];
}): number => {
  const {
    staticIntervals, staticServices, capture, sweep, cycles, vault, installs,
  } = input;
  const out: string[] = [];

  // ── Phase 1: inventory, static vs runtime ────────────────────────────
  out.push('');
  out.push('══ PHASE 1 — INVENTORY (static source scan vs instrumented boot) ══');
  out.push('');
  const runtimeNames = new Set(capture.intervals.map((i) => i.name));
  const staticNames = new Set(staticIntervals.map((s) => s.name));

  out.push(`interval registration sites in source : ${staticIntervals.length}`);
  out.push(`intervals registered at boot          : ${capture.intervals.length}`);
  out.push(`service registrations in source       : ${staticServices.length}`);
  out.push(`services registered at boot           : ${capture.services.length}`);
  out.push('');

  const neverStarted = [...staticNames].filter((n) => !runtimeNames.has(n)).sort();
  if (neverStarted.length > 0) {
    out.push('⚠ DECLARED IN SOURCE BUT NOT REGISTERED AT BOOT:');
    for (const n of neverStarted) {
      const site = staticIntervals.find((s) => s.name === n);
      out.push(`   ${pad(n, 38)} ${site?.file}:${site?.line}`);
    }
    out.push('  (gated on an absent dep, or genuinely unreachable — verify each)');
    out.push('');
  }

  const counts = new Map<string, number>();
  for (const i of capture.intervals) counts.set(i.name, (counts.get(i.name) ?? 0) + 1);
  const doubled = [...counts.entries()].filter(([, c]) => c > 1);
  if (doubled.length > 0) {
    out.push('⛔ REGISTERED MORE THAN ONCE AT BOOT:');
    for (const [n, c] of doubled) out.push(`   ${pad(n, 38)} ×${c}`);
    out.push('');
  }

  const svcCounts = new Map<string, number>();
  for (const s of capture.services) svcCounts.set(s.name, (svcCounts.get(s.name) ?? 0) + 1);
  const svcDoubled = [...svcCounts.entries()].filter(([, c]) => c > 1);
  if (svcDoubled.length > 0) {
    out.push('⛔ SERVICE REGISTERED MORE THAN ONCE AT BOOT:');
    for (const [n, c] of svcDoubled) out.push(`   ${pad(n, 38)} ×${c}`);
    out.push('');
  }

  out.push('registered intervals (boot order):');
  for (const i of capture.intervals) {
    const mins = (i.intervalMs / 60000).toFixed(i.intervalMs < 60000 ? 2 : 0);
    out.push(
      `   ${pad(i.name, 38)} every ${pad(`${mins}m`, 9)}`
      + `${i.fireImmediate ? ' fireImmediate' : ''}`,
    );
  }
  out.push('');
  out.push('registered services (boot order):');
  for (const s of capture.services) {
    out.push(`   ${pad(s.name, 38)} ${s.kind}`);
  }
  out.push('');

  // ── Phase 2/3: drivability + sweep ───────────────────────────────────
  out.push(`══ PHASE 2/3 — DRIVABILITY + ${cycles}-CYCLE SWEEP ══`);
  out.push('');
  out.push(
    vault.ok
      ? `vault: OPEN (via ${vault.via}) — autonomous ticks are ungated`
      : `vault: SEALED — ${vault.reason}`,
  );
  out.push('');
  const audited = sweep.subsystems.filter(
    (s) => s.verdict === 'clean' || s.verdict === 'finding',
  );
  const findings = sweep.subsystems.filter((s) => s.verdict === 'finding');
  const undrivable = sweep.subsystems.filter((s) => s.verdict === 'undrivable');
  const notDrivable = sweep.subsystems.filter((s) => s.verdict === 'not-drivable');
  const noProbe = sweep.subsystems.filter((s) => s.verdict === 'no-probe');

  for (const s of sweep.subsystems) {
    const mark = s.verdict === 'clean'
      ? '✓'
      : s.verdict === 'finding'
        ? '⛔'
        : s.verdict === 'undrivable'
          ? '⚠'
          : s.verdict === 'not-drivable'
            ? '⊘'
            : '·';
    out.push(`${mark} ${pad(s.name, 38)} ${pad(s.verdict, 11)} ${s.drivenBy}`);
    for (const c of s.cycles) {
      out.push(
        `      cycle ${c.cycle}: due ${c.pendingBefore} → ${c.pendingAfter}`
        + ` (drained ${c.deleted})`
        + `${c.cursor !== undefined ? ` cursor=${c.cursor}` : ''}`
        + `${c.storeSize !== undefined ? ` size=${c.storeSize}` : ''}`
        + ` ${c.wallMs}ms`
        + `${c.error ? ` ERROR ${c.error}` : ''}`,
      );
    }
    if (s.failedInvariant) out.push(`      ⛔ INVARIANT: ${s.failedInvariant}`);
    if (s.note) out.push(`      note: ${s.note}`);
    for (const e of s.tickErrors) out.push(`      tick error: ${e}`);
  }
  for (const i of installs) {
    out.push(`substrate: pack ${i.slug} — ${i.ok ? 'installed' : 'FAILED'} (${i.detail})`);
  }
  if (installs.length > 0) out.push('');

  // ── cron scheduler ───────────────────────────────────────────────────
  const cron = sweep.cronScheduler;
  out.push('── cron scheduler (cursor: schedules.next_run_at) ──');
  if (!cron.ran) {
    out.push(`⚠ NOT DRIVEN: ${cron.reason}`);
  } else {
    for (const c of cron.cycles) {
      out.push(
        `   cycle ${c.cycle}: fired ${c.fired.length}`
        + ` next_run_at=${c.nextRunAt} last_run_at=${c.lastRunAt}`
        + ` status=${c.lastStatus ?? '-'} ${c.wallMs}ms`
        + `${c.error ? ` ERROR ${c.error}` : ''}`,
      );
    }
    if (cron.findings.length === 0) {
      out.push('   ✓ fired once, advanced the cursor, did not re-fire');
    }
    for (const f of cron.findings) out.push(`   ⛔ ${f}`);
  }
  out.push('');

  // ── auto-run scheduler ───────────────────────────────────────────────
  const ar = sweep.autoRun;
  out.push('── auto-run scheduler (circuit-breaker convergence) ──');
  if (!ar.ran) {
    out.push(`⚠ NOT DRIVEN: ${ar.reason}`);
    for (const c of ar.cycles) {
      out.push(
        `   (observed) cycle ${c.cycle}: roster ${c.rosterSize} fired ${c.fired}`
        + ` circuit_rows=${c.circuitRows} auto_disabled=${c.autoDisabled}`,
      );
    }
  } else {
    for (const c of ar.cycles) {
      out.push(
        `   cycle ${c.cycle}: roster ${c.rosterSize} fired ${c.fired}`
        + ` skip(overlap ${c.skippedOverlap}, circuit ${c.skippedCircuit})`
        + ` circuit_rows=${c.circuitRows} auto_disabled=${c.autoDisabled}`
        + ` ${c.wallMs}ms${c.error ? ` ERROR ${c.error}` : ''}`,
      );
    }
    if (ar.findings.length === 0) {
      out.push('   ✓ roster stable, circuit state converged');
    }
    for (const f of ar.findings) out.push(`   ⛔ ${f}`);
  }
  out.push('');

  // ── housekeeping scheduler ───────────────────────────────────────────
  const hk = sweep.housekeeping;
  out.push('── housekeeping scheduler (44-task registry, shared cycle budget) ──');
  if (!hk.ran) {
    out.push(`⚠ NOT DRIVEN: ${hk.reason}`);
  } else {
    out.push(`   registered tasks: ${hk.registeredTasks}`);
    for (const c of hk.cycles) {
      out.push(
        `   cycle ${c.cycle}: stepped ${c.stepped} `
        + `(complete ${c.complete}, yield ${c.yielded}, error ${c.errored}) `
        + `${c.durationMs}ms`,
      );
    }
    const never = hk.outcomes.filter((o) => o.verdict === 'never-stepped');
    const errored = hk.outcomes.filter((o) => o.verdict === 'errored');
    const stepped = hk.outcomes.filter((o) => o.verdict === 'stepped');
    const gated = hk.outcomes.filter((o) => o.verdict === 'gated-off');
    out.push(
      `   stepped ${stepped.length} · gated-off-but-runnable ${gated.length} `
      + `· never-stepped ${never.length} · errored ${errored.length}`,
    );
    if (gated.length > 0) {
      out.push(
        '   · gated off the idle cycle by per-topic trust (D-132), verified '
        + 'runnable via Run-Now — NOT a finding:',
      );
      out.push(`      ${gated.map((o) => o.task_id).join(', ')}`);
    }
    if (never.length > 0) {
      out.push('   ⛔ NEVER STEPPED (named, never summarised to a count):');
      for (const o of never) {
        out.push(`      ${pad(o.task_id, 46)} ${o.runNowError ?? o.kind}`);
      }
    }
    for (const o of errored) {
      out.push(
        `   ⛔ ERRORED ${pad(o.task_id, 40)} errors=${o.consecutiveErrors} `
        + `${o.lastError ?? ''}`,
      );
    }
  }
  out.push('');

  if (capture.unhandledRejections.length > 0) {
    out.push('⛔ UNHANDLED REJECTIONS DURING BOOT/SWEEP:');
    for (const r of capture.unhandledRejections) {
      out.push(`   ${r instanceof Error ? r.stack ?? r.message : String(r)}`);
    }
    out.push('');
  }

  // ── optimization ─────────────────────────────────────────────────────
  const opt = sweep.optimization;
  const optFindings = (opt ?? []).filter((o) => o.verdict === 'finding');
  const optUnchecked = (opt ?? []).filter((o) => o.verdict === 'not-observed');
  out.push('── OPTIMIZATION — does an idle cycle scale with the corpus? ──');
  if (opt === undefined) {
    out.push(
      '   ⛔ WITHHELD — the SQL meter could not be proven live. A dead meter '
      + 'reads 0 statements, which would score every subsystem as perfectly '
      + 'optimized.',
    );
  } else {
    for (const o of opt) {
      const mark = o.verdict === 'finding' ? '⛔' : o.verdict === 'clean' ? '✓' : '·';
      out.push(`   ${mark} ${o.name.padEnd(34)} ${o.detail}`);
    }
  }
  out.push('');

  // ── summary ──────────────────────────────────────────────────────────
  out.push('══ SUMMARY ══');
  out.push(`  AUDITED (invariant actually ran) : ${audited.length}`);
  out.push(`  findings                         : ${findings.length}`);
  out.push(`  housekeeping findings            : ${hk.findings.length}`);
  out.push(`  cron-scheduler findings          : ${cron.findings.length}`);
  out.push(`  auto-run findings                : ${ar.findings.length}`);
  out.push(`  NOT AUDITED — undrivable         : ${undrivable.length}`);
  out.push(`  NOT AUDITED — not drivable (why) : ${notDrivable.length}`);
  out.push(`  NOT AUDITED — no probe written   : ${noProbe.length}`);
  out.push(`  optimization findings            : ${optFindings.length}`);
  out.push(
    '  NOT OPTIMIZATION-CHECKED         : '
    + (opt === undefined ? 'ALL (meter not live)' : String(optUnchecked.length)),
  );
  out.push(`  boot-time unhandled rejections   : ${capture.unhandledRejections.length}`);
  out.push('');

  const notAudited = undrivable.length + notDrivable.length + noProbe.length
    + (hk.ran ? 0 : 1) + (cron.ran ? 0 : 1) + (ar.ran ? 0 : 1);
  if (notAudited > 0) {
    out.push(`⚠ ${notAudited} subsystem(s) NOT AUDITED — exiting non-zero.`);
    out.push('  "not audited" must never read the same as "audited, clean".');
  }
  if (optUnchecked.length > 0 || opt === undefined) {
    out.push(
      `⚠ ${opt === undefined ? 'every' : String(optUnchecked.length)} subsystem(s) `
      + 'NOT OBSERVED by the optimization check — same rule as everywhere else '
      + 'here: "not observed" must never read the same as "observed, clean".',
    );
  }
  for (const f of hk.findings) out.push(`⛔ ${f}`);
  for (const o of optFindings) out.push(`⛔ OPTIMIZATION ${o.name}: ${o.detail}`);

  console.log(out.join('\n'));

  for (const f of cron.findings) out.push(`⛔ ${f}`);
  for (const f of ar.findings) out.push(`⛔ ${f}`);

  return findings.length > 0
    || hk.findings.length > 0
    || cron.findings.length > 0
    || ar.findings.length > 0
    || notAudited > 0
    || optFindings.length > 0
    || optUnchecked.length > 0
    || opt === undefined
    || doubled.length > 0
    ? 1
    : 0;
};
