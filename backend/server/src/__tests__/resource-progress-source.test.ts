// D-274 slice 2 — the OS-accounting progress source.
//
// ⚠ The wedged-process cases drive a REAL child and SIGSTOP it. That is
// deliberate: a `sleep` also consumes no CPU, so a sampler that always answered
// "idle" would pass against one. Only a process that WAS moving and then stops
// distinguishes a working sampler from a broken one.

import { describe, expect, it, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ResourceProgressSource,
  parsePsTime,
  parseUnixTable,
  parseWindowsTable,
  defaultTreeSampler,
  type TreeSample,
} from '../execution/resource-progress-source.js';

// ⛔⛔ EVERY SPAWNED BURNER CARRIES ITS OWN DEADLINE, AND IS ITS OWN PROCESS
// GROUP. Both are load-bearing, and both were learned the hard way: an earlier
// version of this file leaked 23 `for(;;)` processes — PPID 1, one spinning for
// 2h34m — which pushed the machine to load 40+, killed unrelated suites at exit
// 144, and made two other test files fail as "contention".
//
//  - `afterEach` DOES NOT RUN when the runner is SIGKILLed, so cleanup that
//    exists only there is cleanup that is absent exactly when it is needed. The
//    deadline is the only guard that survives the runner dying.
//  - a `for(;;)` loop never yields, so a `setTimeout`-based self-kill never
//    fires; the deadline has to be INSIDE the loop condition.
//  - the tree test spawns a GRANDCHILD, which SIGKILL on the parent does not
//    reach. `detached` makes the parent a group leader so `kill(-pid)` takes
//    the whole tree.
const BURN_DEADLINE_MS = 60_000;
const burnScript = (extra = ''): string =>
  `${extra}const e=Date.now()+${BURN_DEADLINE_MS};while(Date.now()<e){Math.sqrt(Math.random());}`;

const alive: ChildProcess[] = [];
const killTree = (c: ChildProcess): void => {
  if (c.pid === undefined) return;
  try { process.kill(-c.pid, 'SIGCONT'); } catch { /* not a group leader / gone */ }
  try { process.kill(-c.pid, 'SIGKILL'); } catch { /* not a group leader / gone */ }
  try { c.kill('SIGCONT'); } catch { /* already gone */ }
  try { c.kill('SIGKILL'); } catch { /* already gone */ }
};
afterEach(() => { for (const c of alive.splice(0)) killTree(c); });

const spinner = (): ChildProcess => {
  const c = spawn(process.execPath, ['-e', burnScript()], { stdio: 'ignore', detached: true });
  alive.push(c);
  return c;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** Drive until `n` further samples have landed. ⚠ `grewSince()` both ANSWERS
 *  and KICKS, so a helper that calls it twice drives two samples — which is why
 *  the failure-count tests below assert on `stats`, not on call counts. */
const driveSamples = async (src: ResourceProgressSource, n: number): Promise<void> => {
  const target = src.stats.samples + n;
  for (let i = 0; i < 400 && src.stats.samples < target; i += 1) {
    src.grewSince();
    await sleep(5);
  }
};

/** Drive one complete sample and wait for it to land. */
const nextSample = async (src: ResourceProgressSource): Promise<boolean> => {
  const before = src.stats.samples;
  src.grewSince();
  for (let i = 0; i < 200 && src.stats.samples === before; i += 1) await sleep(25);
  return src.grewSince();
};

describe('parsePsTime', () => {
  it('parses the darwin MM:SS.hh form, minutes unbounded', () => {
    expect(parsePsTime('0:01.01')).toBe(1_010);
    expect(parsePsTime('110:16.80')).toBe(110 * 60_000 + 16_800);
  });

  it('parses the linux [DD-]HH:MM:SS form', () => {
    expect(parsePsTime('01:02:03')).toBe((3_600 + 120 + 3) * 1000);
    expect(parsePsTime('1-02:03:04')).toBe((86_400 + 3_600 * 2 + 180 + 4) * 1000);
  });

  it('returns null — never 0 — for anything unrecognised', () => {
    // ⛔ 0 would read as "this process has used no CPU", which is exactly the
    // wedged signature. An unparseable field must not be able to fake it.
    for (const bad of ['', '  ', '-', 'abc', '1:2:3:4', 'x:01']) {
      expect(parsePsTime(bad)).toBeNull();
    }
  });
});

describe('ResourceProgressSource — real process tree', () => {
  it('reports movement for a spinning child, and NOT for a SIGSTOPped one', async () => {
    const child = spinner();
    // ⚠ GAP, NOT CADENCE, is what makes the spinning half honest. `ps` reports
    // 10ms steps, so over a 40ms window a spinning child can read 0 under load
    // (measured). 500ms gives a 2%-of-a-core process a 10ms advance — a margin
    // wide enough that this is a real assertion, not a coin flip.
    const GAP = 500;
    // ⚠ THE PRODUCTION RSS RULE, DELIBERATELY. A stopped process's RSS is the OS's to change:
    // under memory pressure (sweeps run with swap in use) the kernel pages it out. At
    // e98b086fc, while a shrink still counted, this case read still for a whole window and
    // then "moved" in the next with the child stopped; d28e6d9a4 held it to CPU alone. Only
    // growth counts now (D-274 §4a, amended 2026-10-09), so it runs on the default rule
    // again. The boundaries are pinned on a scripted sampler below.
    const src = new ResourceProgressSource({
      pid: child.pid as number, sampleMs: 0, minComparisonMs: 100,
    });

    await nextSample(src);                  // baseline
    await sleep(GAP);
    expect(await nextSample(src)).toBe(true);   // spinning ⇒ CPU advanced

    child.kill('SIGSTOP');
    // ⚠ A STOP IS NOT STILLNESS AT ONCE: CPU time accrued just before it can still reach
    // `ps` on a later read. That is the machine catching up, not the child running, so
    // wait for the first still window (bounded), then require stillness over a fresh one.
    let still = false;
    for (let i = 0; i < 20 && !still; i += 1) {
      await sleep(GAP);
      still = !(await nextSample(src));
    }
    expect(still, `a SIGSTOPped child never read as still within ${String(20 * GAP)}ms`).toBe(true);
    await sleep(GAP);
    expect(await nextSample(src)).toBe(false);  // ⇒ the wedged signature (0 CPU, always), held

    child.kill('SIGCONT');
    await sleep(GAP);
    await nextSample(src);
    await sleep(GAP);
    expect(await nextSample(src)).toBe(true);   // and it recovers
  }, 30_000);

  it('sums the TREE, not just the direct child', async () => {
    // A parent that idles while its child burns CPU is the `soffice` re-exec
    // shape. Watching only the direct child would call this tree idle.
    const grandchild = burnScript().replace(/'/g, "\\'");
    const parent = spawn(
      process.execPath,
      ['-e', `require('child_process').spawn(process.execPath,['-e','${grandchild}'],{stdio:'ignore'});`
        + `const e=Date.now()+${BURN_DEADLINE_MS};const t=setInterval(()=>{if(Date.now()>e){clearInterval(t);process.exit(0);}},250);`],
      { stdio: 'ignore', detached: true },
    );
    alive.push(parent);
    await sleep(400);
    const sample = await defaultTreeSampler(parent.pid as number);
    expect(sample).not.toBeNull();
    expect((sample as TreeSample).pids).toBeGreaterThanOrEqual(2);

    const src = new ResourceProgressSource({
      pid: parent.pid as number, sampleMs: 0, minComparisonMs: 100,
    });
    await nextSample(src);
    await sleep(500);
    expect(await nextSample(src)).toBe(true);
  }, 30_000);
});

describe('ResourceProgressSource — fail-open', () => {
  const failing = new Error('no ps here');

  it('answers TRUE before the first sample lands', () => {
    const src = new ResourceProgressSource({ pid: 1, sampleMs: 0, minComparisonMs: 0, sampler: async () => null });
    expect(src.grewSince()).toBe(true);
  });

  it('warns ONCE when sampling is persistently blind, and only after 3 in a row', async () => {
    // ⛔ Fail-open is silent. A server with no `ps` flags nothing, forever, with
    // nothing saying so — indistinguishable from a server where nothing stalls.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const src = new ResourceProgressSource({ pid: 1, sampleMs: 0, minComparisonMs: 0, sampler: async () => null });
      await driveSamples(src, 2);
      expect(src.stats.consecutive_failures).toBe(2);
      expect(warn).not.toHaveBeenCalled();          // two transients stay quiet
      await driveSamples(src, 1);
      expect(src.stats.consecutive_failures).toBe(3);
      expect(warn).toHaveBeenCalledTimes(1);        // says it exactly at the threshold
      await driveSamples(src, 10);
      expect(src.stats.consecutive_failures).toBe(13);
      expect(warn).toHaveBeenCalledTimes(1);        // and never repeats
    } finally { warn.mockRestore(); }
  });

  it('a successful sample resets the consecutive-failure run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let mode: 'fail' | 'ok' = 'fail';
      const src = new ResourceProgressSource({
        pid: 1, sampleMs: 0, minComparisonMs: 0,
        sampler: async () => (mode === 'fail' ? null : { cpu_ms: 1, rss_bytes: 1, pids: 1 }),
      });
      await driveSamples(src, 2);
      expect(src.stats.consecutive_failures).toBe(2);
      mode = 'ok'; await driveSamples(src, 1);
      expect(src.stats.consecutive_failures).toBe(0);   // the run restarts
      mode = 'fail'; await driveSamples(src, 2);
      expect(src.stats.consecutive_failures).toBe(2);
      expect(warn).not.toHaveBeenCalled();              // so the threshold is not reached
    } finally { warn.mockRestore(); }
  });

  it('answers TRUE when the sampler throws', async () => {
    const src = new ResourceProgressSource({
      pid: 1, sampleMs: 0, minComparisonMs: 0,
      sampler: () => Promise.reject(failing),
    });
    expect(await nextSample(src)).toBe(true);
    expect(src.stats.failures).toBeGreaterThan(0);
  });

  it('answers TRUE when the tree cannot be seen (null sample)', async () => {
    const src = new ResourceProgressSource({ pid: 999_999, sampleMs: 0, minComparisonMs: 0, sampler: async () => null });
    expect(await nextSample(src)).toBe(true);
  });

  it('a transient failure does not manufacture movement on the next success', async () => {
    // ⛔ The baseline must survive a failed sample. If a failure retired it, the
    // next success would have nothing to compare against, answer "unknown ⇒
    // progress", and a tree that was idle across the whole window would read as
    // moving — the failure would launder a stall into progress.
    let n = 0;
    const still: TreeSample = { cpu_ms: 1_000, rss_bytes: 10_000, pids: 1 };
    const src = new ResourceProgressSource({
      pid: 1, sampleMs: 0, minComparisonMs: 0,
      sampler: async () => { n += 1; return n === 2 ? null : still; },
    });
    await nextSample(src);                      // 1: baseline
    await nextSample(src);                      // 2: failure  ⇒ true, baseline kept
    expect(await nextSample(src)).toBe(false);  // 3: compares against the KEPT baseline
  });

  it('counts a below-epsilon CPU advance as stillness, and RSS growth — never a shrink — as movement', async () => {
    let cur: TreeSample = { cpu_ms: 0, rss_bytes: 1_000_000, pids: 1 };
    const src = new ResourceProgressSource({
      pid: 1, sampleMs: 0, minComparisonMs: 0, cpuEpsilonMs: 10, rssEpsilonBytes: 4_096,
      sampler: async () => cur,
    });
    await nextSample(src);                              // baseline
    cur = { cpu_ms: 5, rss_bytes: 1_000_000, pids: 1 }; // +5ms  — under epsilon
    expect(await nextSample(src)).toBe(false);
    cur = { cpu_ms: 10, rss_bytes: 1_000_000, pids: 1 }; // +5ms  — still under
    expect(await nextSample(src)).toBe(false);
    cur = { cpu_ms: 10, rss_bytes: 1_100_000, pids: 1 }; // RSS grew
    expect(await nextSample(src)).toBe(true);
    // ⛔ A SHRINK IS THE OS's, NOT THE TREE's: a process that is not running at all loses
    // resident pages under memory pressure. Counted, every trim restarted the stall clock,
    // so a wedged op the OS kept paging out never flagged.
    cur = { cpu_ms: 10, rss_bytes: 600_000, pids: 1 };   // shrank 500 KB, CPU flat
    expect(await nextSample(src)).toBe(false);
    cur = { cpu_ms: 10, rss_bytes: 604_095, pids: 1 };   // grew one byte short of a page
    expect(await nextSample(src)).toBe(false);
    cur = { cpu_ms: 10, rss_bytes: 608_191, pids: 1 };   // grew exactly a page
    expect(await nextSample(src)).toBe(true);
    cur = { cpu_ms: 40, rss_bytes: 608_191, pids: 1 };   // +30ms — over epsilon
    expect(await nextSample(src)).toBe(true);
  });
});

describe('ResourceProgressSource — a tree whose members change', () => {
  it('counts a child starting or ending as movement, even as both sums fall', async () => {
    // ⛔ `ps` drops a reaped child's CPU and memory from the tree's totals, so a busy child
    // exiting as the next starts makes both FALL while work goes on (measured 2,760 ms and
    // 3.84 GB down to 0 and 3 MB across one exit). Growth alone would call that window still.
    let cur: TreeSample = { cpu_ms: 2_760, rss_bytes: 3_840_000_000, pids: 2, members: [10, 11] };
    const src = new ResourceProgressSource({
      pid: 10, sampleMs: 0, minComparisonMs: 0, sampler: async () => cur,
    });
    await nextSample(src);                                                    // baseline
    cur = { cpu_ms: 40, rss_bytes: 60_000_000, pids: 2, members: [10, 12] };  // 11 done, 12 new
    expect(await nextSample(src)).toBe(true);
    cur = { cpu_ms: 40, rss_bytes: 60_000_000, pids: 2, members: [10, 12] };  // same tree, idle
    expect(await nextSample(src)).toBe(false);
    cur = { cpu_ms: 40, rss_bytes: 50_000_000, pids: 1, members: [10] };      // 12 ended
    expect(await nextSample(src)).toBe(true);
    cur = { cpu_ms: 40, rss_bytes: 40_000_000, pids: 1, members: [10] };      // the OS trims it
    expect(await nextSample(src)).toBe(false);
  });

  it('treats a sample without members as no change, not as one', async () => {
    let cur: TreeSample = { cpu_ms: 10, rss_bytes: 1_000, pids: 1, members: [10] };
    const src = new ResourceProgressSource({
      pid: 10, sampleMs: 0, minComparisonMs: 0, sampler: async () => cur,
    });
    await nextSample(src);
    cur = { cpu_ms: 10, rss_bytes: 1_000, pids: 1 };
    expect(await nextSample(src)).toBe(false);
  });
});

describe('parseWindowsTable — against a table RECORDED FROM A REAL WINDOWS HOST', () => {
  // ⚠ This machine is darwin and can never execute the Windows branch. The
  // fixture is the exact stdout of `WINDOWS_PS_COMMAND` on Windows 11 /
  // PowerShell 5.1, captured over SSH on 2026-09-18, with a deliberately nested
  // powershell tree so the walk has real descendants to find. A hand-written
  // fixture here would test my assumptions about PowerShell, not the parser.
  const raw = readFileSync(
    join(fileURLToPath(new URL('./fixtures/', import.meta.url)), 'windows-process-table.csv'),
    'utf8',
  );
  const ROOT = 1132;
  const REAL_SUBTREE = [1132, 2852, 4580, 3024];

  it('parses the quoted CSV and skips the header without dropping a data row', () => {
    const table = parseWindowsTable(raw);
    // 139 real processes were live; the header must not become a pid, and no
    // data row may be lost to the header skip.
    expect(table.stats.size).toBe(139);
    expect(table.stats.has(Number.NaN)).toBe(false);
    expect([...table.stats.keys()].every((k) => Number.isInteger(k))).toBe(true);
  });

  it('walks the real nested tree, not just the direct child', () => {
    const table = parseWindowsTable(raw);
    const seen = new Set<number>();
    const stack = [ROOT];
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const c of table.children.get(cur) ?? []) stack.push(c);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([...REAL_SUBTREE].sort((a, b) => a - b));
    expect(seen.size).toBeGreaterThan(1); // the whole point: descendants exist
  });

  it('converts 100ns KernelModeTime+UserModeTime to milliseconds', () => {
    const table = parseWindowsTable(raw);
    // pid 4 (System) as recorded: KernelModeTime 647343750 (100ns), UserModeTime
    // 0 => 64734.375ms, rounded. ⚠ The first draft of this assertion carried a
    // value hand-copied from an EARLIER probe run of the same host and went red
    // — which is the fixture doing its job: a recorded table disagrees with a
    // remembered number, a hand-written one would have agreed with it.
    expect(table.stats.get(4)?.cpu).toBe(Math.round(647_343_750 / 10_000));
    expect(table.stats.get(4)?.rss).toBe(356_352);
  });

  it('a comment/preamble line can never masquerade as a process', () => {
    const withNoise = `# a comment line\n\n${raw}`;
    expect(parseWindowsTable(withNoise).stats.size).toBe(parseWindowsTable(raw).stats.size);
  });
});

describe('parseUnixTable', () => {
  it('parses the darwin ps shape and converts rss KB to bytes', () => {
    const t = parseUnixTable(['    1     0  29:49.02  23328', '  534     1  10:40.78  54736'].join('\n'));
    expect(t.stats.get(1)).toEqual({ cpu: parsePsTime('29:49.02'), rss: 23_328 * 1024 });
    expect(t.children.get(1)).toEqual([534]);
  });

  it('drops a row whose time field is unparseable rather than scoring it zero CPU', () => {
    // ⛔ Zero CPU IS the wedged signature. An unreadable field must not fake it.
    expect(parseUnixTable('  900     1  bogus  1000').stats.has(900)).toBe(false);
  });
});

describe('MIN_COMPARISON_MS — stillness is only claimable over a meaningful window', () => {
  it('answers TRUE (unknown) when two samples are closer than the floor', async () => {
    // ⛔ MEASURED, not theorised: a tight while(true) loop sampled every ~40ms on
    // a loaded darwin host accrued 0-20ms per gap, and `ps` reports in 10ms
    // steps — so one gap read ZERO for a process pegging a core. A 10ms epsilon
    // is 0.07% of a core over the 15s production window and 25% over a 40ms one.
    // Below the floor the source must not claim stillness it cannot see.
    const still: TreeSample = { cpu_ms: 1_000, rss_bytes: 10_000, pids: 1 };
    let clock = 0;
    const src = new ResourceProgressSource({
      pid: 1, sampleMs: 0, minComparisonMs: 5_000,
      now: () => clock, sampler: async () => still,
    });
    await driveSamples(src, 1);            // baseline at t=0
    clock = 100;                            // 100ms later — far under the floor
    expect(await nextSample(src)).toBe(true);   // genuinely still, but UNKNOWABLE
  });

  it('claims stillness once the window is wide enough', async () => {
    const still: TreeSample = { cpu_ms: 1_000, rss_bytes: 10_000, pids: 1 };
    let clock = 0;
    const src = new ResourceProgressSource({
      pid: 1, sampleMs: 0, minComparisonMs: 5_000,
      now: () => clock, sampler: async () => still,
    });
    await driveSamples(src, 1);
    clock = 6_000;                          // past the floor
    expect(await nextSample(src)).toBe(false);
  });

  it('a short window advances the baseline, so the NEXT comparison spans from there', async () => {
    // Keeping the stale baseline would let a long-idle stretch be judged against
    // a point minutes back and flag on the wrong window.
    let cpu = 1_000; let clock = 0;
    const src = new ResourceProgressSource({
      pid: 1, sampleMs: 0, minComparisonMs: 1_000,
      now: () => clock, sampler: async () => ({ cpu_ms: cpu, rss_bytes: 10_000, pids: 1 }),
    });
    await driveSamples(src, 1);                       // baseline t=0 cpu=1000
    clock = 100; cpu = 5_000; await driveSamples(src, 1);  // short window, cpu jumped
    clock = 1_200;                                     // > floor from t=100
    expect(await nextSample(src)).toBe(false);         // compared against t=100, not t=0
  });
});
