// D-274 — the progress signal that needs no cooperation from the tool.
//
// `heartbeat` and `file-growth` both require the op to EMIT something: an
// unbuffered stdout cadence, or output streamed to a file as it is produced. A
// binary that buffers and writes its result in one final `write()` — the normal
// shape for `gs`, `tesseract`, `soffice`, `sox` — can satisfy neither, which is
// why 455 of 457 shipped cli ops declared no contract at all and were governed
// by their authored `timeout_ms` alone (D-274 §1).
//
// The op emits nothing; the KERNEL accounts for it anyway. This samples the
// spawned process TREE's cumulative CPU time and aggregate RSS and reports
// "moved" / "did not move". It plugs into the EXISTING `ProgressSource` seam, so
// `StallMonitor` needs no change.
//
// ⛔ REPORT-ONLY. The signal is universal but noisy — work outside the tree (a
// daemon), GPU-resident work, and iowait all read as idle. It is wired with
// `flag_only`, so it flags the active list for the watching human and NEVER
// kills. A false "looks idle" costs a glance; a false kill costs the whole run.
// See D-274 §4c / §10.

import { execFile } from 'node:child_process';
import type { ProgressSource } from './stall-monitor.js';

/** How often the tree is actually sampled. Deliberately DECOUPLED from
 *  `DEFAULT_PROGRESS_POLL_MS` (2s): the monitor polls `grewSince()` on its own
 *  fast cadence, and a spawn per poll per live run would not be acceptable. A
 *  report-only signal that flags after minutes does not need sub-minute
 *  resolution. */
export const RESOURCE_SAMPLE_MS = 15_000;

/** Minimum CPU-time advance that counts as movement. `ps -o time=` reports
 *  hundredths of a second, so 10ms is ONE tick of measurable resolution — the
 *  smallest honest threshold. Lower would claim precision the source does not
 *  have; higher would call a slow-but-working process idle. */
export const CPU_EPSILON_MS = 10;

/** Minimum RSS change (either direction) that counts as movement. One page. */
export const RSS_EPSILON_BYTES = 4_096;

/** Consecutive sampling failures before the source says so once. Three, so a
 *  single transient (a reaped pid, a momentary EAGAIN) stays quiet. */
export const FAILURES_BEFORE_WARNING = 3;

/** ⛔ The shortest window over which "did not move" is a MEANINGFUL claim.
 *
 *  `CPU_EPSILON_MS` is a measurement-resolution floor, and a floor only means
 *  something when it is a small fraction of the window: 10ms over the 15s
 *  production interval is 0.07% of a core, but 10ms over a 40ms window is 25%,
 *  which calls an ordinary busy process idle. MEASURED under load on a
 *  darwin host: a tight `while(true)` loop sampled every ~40ms accrued 0-20ms
 *  per gap, and `ps` reports in 10ms granularity, so a single gap legitimately
 *  read ZERO for a process that was pegging a core.
 *
 *  ⇒ Below this gap the source answers "moved" (unknown ⇒ progress) rather than
 *  concluding stillness it cannot actually see. At 5s the floor is 0.2% of one
 *  core. This exists so that shortening `sampleMs` cannot silently turn the
 *  detector into a false-flag generator. */
export const MIN_COMPARISON_MS = 5_000;

export interface TreeSample {
  cpu_ms: number;
  rss_bytes: number;
  /** How many processes in the tree the sample found (telemetry / tests). */
  pids: number;
}

export type TreeSampler = (pid: number) => Promise<TreeSample | null>;

/** Parse a `ps`-style cumulative CPU time: `[DD-][HH:]MM:SS[.hh]`.
 *  darwin prints `110:16.80` (minutes unbounded); linux prints `1-02:03:04`.
 *  Returns null on anything it does not recognise — an unparseable field must
 *  not silently read as zero CPU, which would look exactly like a wedged
 *  process. */
export const parsePsTime = (raw: string): number | null => {
  const s = raw.trim();
  if (s === '') return null;
  const dash = s.indexOf('-');
  let days = 0;
  let rest = s;
  if (dash > 0) {
    days = Number(s.slice(0, dash));
    rest = s.slice(dash + 1);
    if (!Number.isFinite(days)) return null;
  }
  const parts = rest.split(':');
  if (parts.length === 0 || parts.length > 3) return null;
  let seconds = 0;
  // right-to-left: seconds, minutes, hours
  const mult = [1, 60, 3_600];
  for (let i = 0; i < parts.length; i += 1) {
    const v = Number(parts[parts.length - 1 - i]);
    if (!Number.isFinite(v) || v < 0) return null;
    seconds += v * (mult[i] ?? 0);
  }
  return Math.round((seconds + days * 86_400) * 1000);
};

/** A parsed process table: who-parents-whom, plus per-pid cpu/rss. */
interface ProcessTable {
  children: Map<number, number[]>;
  stats: Map<number, { cpu: number; rss: number }>;
}

/** Fold the subtree rooted at `pid`. Returns null when the root is absent —
 *  already reaped is UNKNOWN, not idle, and the caller fails open on null.
 *
 *  ⛔ The TREE, not the child. `soffice` re-execs, `whisper` forks, `ollama`
 *  and friends spawn workers; watching only the direct child calls a busy tree
 *  idle. A `seen` set guards the cycle a corrupt/racy table could imply. */
const foldTree = (pid: number, table: ProcessTable): TreeSample | null => {
  if (!table.stats.has(pid)) return null;
  let cpu_ms = 0;
  let rss_bytes = 0;
  let pids = 0;
  const stack = [pid];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const st = table.stats.get(cur);
    if (st) {
      cpu_ms += st.cpu;
      rss_bytes += st.rss;
      pids += 1;
    }
    for (const c of table.children.get(cur) ?? []) stack.push(c);
  }
  return { cpu_ms, rss_bytes, pids };
};

const emptyTable = (): ProcessTable => ({ children: new Map(), stats: new Map() });

const addRow = (
  table: ProcessTable, pid: number, ppid: number, cpu: number, rss: number,
): void => {
  table.stats.set(pid, { cpu, rss });
  const sib = table.children.get(ppid);
  if (sib) sib.push(pid);
  else table.children.set(ppid, [pid]);
};

/** `ps -A -o pid=,ppid=,time=,rss=` — darwin/linux. Exported for tests.
 *  ⚠ The `-o` list is deliberately minimal: `comm`/`args` would pull EVERY
 *  user's command lines (which routinely carry tokens) into this process for a
 *  signal that only needs two integers. */
export const parseUnixTable = (stdout: string): ProcessTable => {
  // ⛔⛔ DO NOT ADD `comm` OR `args` TO THE `-o` LIST ABOVE. `ps -A` spans every
  // user on the host; command lines routinely carry tokens, and pulling them in
  // would turn a two-integer liveness probe into a credential-shaped read. The
  // field list is a security boundary, not a convenience.
  const table = emptyTable();
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)$/);
    if (!m) continue;
    const cpu = parsePsTime(m[3] ?? '');
    if (cpu === null) continue;
    addRow(table, Number(m[1]), Number(m[2]), cpu, Number(m[4]) * 1024);
  }
  return table;
};

/** `Get-CimInstance Win32_Process | … | ConvertTo-Csv -NoTypeInformation`.
 *  Every cell arrives double-quoted; times are 100ns units. Exported for tests,
 *  which run it against a table RECORDED FROM A REAL WINDOWS HOST — the only
 *  honest fixture for a branch this machine cannot execute.
 *
 *  ⚠ The header is skipped by "first cell is not a number", not by dropping
 *  line 0: that holds however many preamble lines a host emits, and a header
 *  row can never masquerade as a pid. */
export const parseWindowsTable = (stdout: string): ProcessTable => {
  const table = emptyTable();
  for (const line of stdout.split('\n')) {
    const cells = line.trim().replace(/"/g, '').split(',');
    if (cells.length < 5) continue;
    const pid = Number(cells[0]);
    const ppid = Number(cells[1]);
    const kt = Number(cells[2]);
    const ut = Number(cells[3]);
    const ws = Number(cells[4]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    if (!Number.isFinite(kt) || !Number.isFinite(ut)) continue;
    addRow(table, pid, ppid, Math.round((kt + ut) / 10_000), Number.isFinite(ws) ? ws : 0);
  }
  return table;
};

const runSampler = (
  cmd: string, args: readonly string[], timeout: number,
  parse: (stdout: string) => ProcessTable, pid: number,
): Promise<TreeSample | null> =>
  new Promise((resolve) => {
    execFile(cmd, [...args], { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(foldTree(pid, parse(stdout)));
    });
  });

const unixSampler: TreeSampler = (pid) =>
  runSampler('ps', ['-A', '-o', 'pid=,ppid=,time=,rss='], 5_000, parseUnixTable, pid);

/** Costlier to spawn (~100-300ms) — acceptable at a 15s cadence, which is part
 *  of why the cadence is slow. Verified against PowerShell 5.1 on a real
 *  Windows host, 2026-09-18. */
const WINDOWS_PS_COMMAND =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize | ConvertTo-Csv -NoTypeInformation';

const windowsSampler: TreeSampler = (pid) =>
  runSampler(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PS_COMMAND],
    10_000, parseWindowsTable, pid,
  );

export const defaultTreeSampler: TreeSampler =
  process.platform === 'win32' ? windowsSampler : unixSampler;

export interface ResourceProgressSourceOptions {
  pid: number;
  sampleMs?: number;
  cpuEpsilonMs?: number;
  /** Override the meaningful-window floor (tests). See `MIN_COMPARISON_MS`. */
  minComparisonMs?: number;
  rssEpsilonBytes?: number;
  sampler?: TreeSampler;
  now?: () => number;
}

/** A `ProgressSource` backed by OS process accounting.
 *
 *  ⛔ FAIL-OPEN, DELIBERATELY. Every path that does not KNOW the tree is idle
 *  answers `true` (progress): before the first sample lands, while a sample is
 *  in flight, and whenever sampling fails (no `ps`, permissions, already
 *  reaped). An absent measurement and a measured zero look identical to the
 *  caller and must not be conflated — a sampler that cannot see is not evidence
 *  that nothing is happening. */
export class ResourceProgressSource implements ProgressSource {
  private readonly pid: number;
  private readonly sampleMs: number;
  private readonly cpuEpsilonMs: number;
  private readonly minComparisonMs: number;
  private readonly rssEpsilonBytes: number;
  private readonly sampler: TreeSampler;
  private readonly now: () => number;

  private previous: TreeSample | null = null;
  private previousAt = 0;
  private moved = true;           // unknown ⇒ progress
  private lastSampleStartedAt = 0;
  private inFlight = false;
  private samples = 0;
  private failures = 0;
  private consecutiveFailures = 0;

  constructor(opts: ResourceProgressSourceOptions) {
    this.pid = opts.pid;
    this.sampleMs = opts.sampleMs ?? RESOURCE_SAMPLE_MS;
    this.cpuEpsilonMs = opts.cpuEpsilonMs ?? CPU_EPSILON_MS;
    this.minComparisonMs = opts.minComparisonMs ?? MIN_COMPARISON_MS;
    this.rssEpsilonBytes = opts.rssEpsilonBytes ?? RSS_EPSILON_BYTES;
    this.sampler = opts.sampler ?? defaultTreeSampler;
    this.now = opts.now ?? Date.now;
  }

  /** Telemetry only — never execution authority. */
  get stats(): { samples: number; failures: number; consecutive_failures: number } {
    return {
      samples: this.samples,
      failures: this.failures,
      consecutive_failures: this.consecutiveFailures,
    };
  }

  /** Called by `StallMonitor.poll()` on the monitor's own fast cadence. It
   *  never blocks: it kicks an async sample when one is due and answers from
   *  the most recent completed comparison. */
  grewSince(): boolean {
    const now = this.now();
    if (!this.inFlight && now - this.lastSampleStartedAt >= this.sampleMs) {
      this.inFlight = true;
      this.lastSampleStartedAt = now;
      void this.sample();
    }
    return this.moved;
  }

  private async sample(): Promise<void> {
    try {
      const current = await this.sampler(this.pid);
      this.samples += 1;
      if (current === null) {
        // Could not see the tree. Unknown ⇒ progress; do NOT retire the
        // baseline, so a transient failure cannot manufacture a false "moved"
        // on the next successful sample by comparing against nothing.
        this.failures += 1;
        this.consecutiveFailures += 1;
        // ⚠ FAIL-OPEN IS SILENT, AND A PERMANENTLY-BLIND SAMPLER IS INVISIBLE.
        // If `ps` is absent (a minimal container), or PowerShell is locked
        // down, every sample fails, every poll answers "progress", and the op
        // simply never flags — degrading to exactly the pre-D-274 behaviour
        // with nothing anywhere saying so. Say it ONCE per source, so an
        // operator can tell a quiet server from a deaf one.
        if (this.consecutiveFailures === FAILURES_BEFORE_WARNING) {
          console.warn(
            `[d-274] resource progress sampling has failed ${FAILURES_BEFORE_WARNING}x in a row on `
            + `${process.platform} (pid ${this.pid}); stall flagging is inert for this run. `
            + 'The op is still bounded by its authored timeout_ms.',
          );
        }
        this.moved = true;
        return;
      }
      this.consecutiveFailures = 0;
      const prev = this.previous;
      const prevAt = this.previousAt;
      const at = this.now();
      this.previous = current;
      this.previousAt = at;
      if (prev === null) {
        // First successful sample: there is nothing to compare against, so we
        // cannot claim movement OR stillness. Unknown ⇒ progress.
        this.moved = true;
        return;
      }
      if (at - prevAt < this.minComparisonMs) {
        // The window is too short for the resolution floor to mean anything
        // (see MIN_COMPARISON_MS). Keep the NEW baseline — the next comparison
        // should span from here, not from a stale point — but do not claim
        // stillness we cannot see.
        this.moved = true;
        return;
      }
      const cpuAdvanced = current.cpu_ms - prev.cpu_ms >= this.cpuEpsilonMs;
      const rssChanged = Math.abs(current.rss_bytes - prev.rss_bytes) >= this.rssEpsilonBytes;
      this.moved = cpuAdvanced || rssChanged;
    } catch {
      this.failures += 1;
      this.moved = true;
    } finally {
      this.inFlight = false;
    }
  }
}
