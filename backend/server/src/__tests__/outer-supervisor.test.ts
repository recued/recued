/** The loop `recued supervise` runs on Windows (`launcher/outer-supervisor.ts`).
 *
 *  Each arm scripts the payload's exit statuses and the previous binary's
 *  verdicts, and asserts what the loop did with them: how often it ran the
 *  payload, whether it asked, and what it exited with. The seam with the real
 *  processes is `supervise-profile.test.ts`. */
import { describe, expect, it } from 'vitest';

import {
  runOuterSupervisor,
  SUPERVISE_VERDICT_RETRY_AFTER_BACKOFF,
  SUPERVISE_VERDICT_RETRY_NOW,
  type OuterSupervisorDeps,
} from '../launcher/outer-supervisor.js';

const GIVE_UP = 20;

/** `runs` is each payload run as [exit status, how long it ran]. A stop is
 *  requested after the run whose index `stopAfter` names. */
const harness = (opts: {
  runs: Array<[number, number]>;
  verdicts?: number[];
  previous?: boolean;
  stopAfter?: number;
}) => {
  let clock = 0;
  let ran = 0;
  const asked: number[] = [];
  const slept: number[] = [];
  const logged: string[] = [];
  const deps: OuterSupervisorDeps = {
    runPayload: async () => {
      const run = opts.runs[ran];
      if (run === undefined) throw new Error(`the payload was run a ${ran + 1}th time`);
      ran += 1;
      clock += run[1];
      return run[0];
    },
    previousExists: () => opts.previous ?? true,
    askPrevious: async (code) => {
      asked.push(code);
      const verdict = opts.verdicts?.[asked.length - 1];
      if (verdict === undefined) throw new Error(`asked about ${code} with no verdict scripted`);
      return verdict;
    },
    stopRequested: () => opts.stopAfter !== undefined && ran - 1 === opts.stopAfter,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    now: () => clock,
    log: (line) => { logged.push(line); },
  };
  return { deps, asked, slept, logged, ran: () => ran };
};

describe('the Windows outer supervisor', () => {
  it('starts the server again when it asks to (exit 3), and stops with it on a clean exit', async () => {
    const h = harness({ runs: [[3, 120_000], [3, 120_000], [0, 120_000]] });
    expect(await runOuterSupervisor(h.deps)).toBe(0);
    expect(h.ran()).toBe(3);
    expect(h.asked).toEqual([]);
  });

  it('halts without asking when another instance owns the realm (exit 4)', async () => {
    const h = harness({ runs: [[4, 2_000]] });
    expect(await runOuterSupervisor(h.deps)).toBe(0);
    expect(h.asked).toEqual([]);
    expect(h.logged.join('\n')).toContain('another instance owns this realm');
  });

  it('reads a stop as a stop: a hard-ended server is neither asked about nor started again', async () => {
    // `recued stop` ends the server with a crash's status on Windows.
    const h = harness({ runs: [[3, 90_000], [1, 90_000]], stopAfter: 1 });
    expect(await runOuterSupervisor(h.deps)).toBe(0);
    expect(h.ran()).toBe(2);
    expect(h.asked).toEqual([]);
  });

  it('asks the previous binary about a failed run, and starts again at once after a revert', async () => {
    const h = harness({ runs: [[1, 1_000], [0, 60_000]], verdicts: [SUPERVISE_VERDICT_RETRY_NOW] });
    expect(await runOuterSupervisor(h.deps)).toBe(0);
    expect(h.asked).toEqual([1]);
    expect(h.slept).toEqual([]);
  });

  it('waits out the backoff when the verdict says so', async () => {
    const h = harness({
      runs: [[1, 1_000], [0, 60_000]],
      verdicts: [SUPERVISE_VERDICT_RETRY_AFTER_BACKOFF],
    });
    expect(await runOuterSupervisor(h.deps, { backoffMs: 5_000 })).toBe(0);
    expect(h.slept).toEqual([5_000]);
  });

  it('gives up with the server\'s status when the verdict does', async () => {
    const h = harness({ runs: [[7, 1_000]], verdicts: [GIVE_UP] });
    expect(await runOuterSupervisor(h.deps)).toBe(7);
  });

  it('counts a server that cannot start at all as a failed run', async () => {
    const h = harness({ runs: [[127, 0], [0, 60_000]], verdicts: [SUPERVISE_VERDICT_RETRY_NOW] });
    expect(await runOuterSupervisor(h.deps)).toBe(0);
    expect(h.asked).toEqual([127]);
  });

  it('halts with the status when there is no previous binary to ask', async () => {
    const h = harness({ runs: [[1, 1_000]], previous: false });
    expect(await runOuterSupervisor(h.deps)).toBe(1);
    expect(h.asked).toEqual([]);
  });

  it('halts a server that keeps stopping within a minute of starting', async () => {
    const h = harness({ runs: Array.from({ length: 5 }, () => [3, 1_000] as [number, number]) });
    expect(await runOuterSupervisor(h.deps, { maxRapidStarts: 5 })).toBe(1);
    expect(h.ran()).toBe(5);
    expect(h.logged.join('\n')).toContain('5 times in a row');
  });

  it('lets a server that runs a while restart without ever using the cap up', async () => {
    // A daily update restarts it every day; no cap on starts may count those.
    const runs: Array<[number, number]> = [
      ...Array.from({ length: 12 }, () => [3, 86_400_000] as [number, number]),
      [0, 60_000],
    ];
    const h = harness({ runs });
    expect(await runOuterSupervisor(h.deps, { maxRapidStarts: 5 })).toBe(0);
    expect(h.ran()).toBe(13);
  });
});
