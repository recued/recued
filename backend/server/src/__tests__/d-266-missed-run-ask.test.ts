/** D-266 — `Ask me` raised as a real ask.
 *
 *  The card on the Automation page reaches only an owner who opens it.
 *  Raising the question through the notification block is what makes
 *  `Ask me` reach a device — and it is deliberately an ASK rather than a
 *  notification beside one, because the block already guarantees exactly
 *  one message per channel: a chat transport that takes the ask does not
 *  also get a notice in the same conversation.
 *
 *  The two properties worth defending are both about the ask NOT
 *  outliving or outnumbering its subject:
 *
 *   1. one open ask at a time — the tick runs every minute and the misses
 *      stay outstanding until answered, so a per-tick raise is a prompt a
 *      minute;
 *   2. a miss can resolve ITSELF when the next regular cycle fires, and an
 *      ask left open after that asks the owner to decide something the
 *      clock already decided.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildMissedRunReport, type MissedRunReport } from '@recued/scheduler';
import { createScheduleStore } from '../schedule-store.js';
import { createScheduler } from '../scheduler.js';
import { answerMissed } from '../schedule-handler.js';
import {
  createMissedRunAsk,
  hasMissedRunAskSurface,
  MISSED_RUNS_ASK_KIND,
  type MissedRunAskNotifier,
} from '../missed-run-ask.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 3, 15, 12, 0, 37).getTime();
const at = (daysAgo: number) => new Date(2026, 3, 15 - daysAgo, 7, 0, 0).getTime();

let db: Database.Database;
let store: ReturnType<typeof createScheduleStore>;

const seed = (over: Record<string, unknown>) => store.set({
  schedule_id: 's1',
  recipe_id: 'morning-brief',
  publisher_id: 'recued-core',
  cron_expression: '0 7 * * *',
  enabled: true,
  created_at: 0,
  last_run_at: at(30),
  prev_run_at: at(31),
  next_run_at: null,
  last_status: 'success',
  last_error: null,
  missed_policy: 'ask',
  ...over,
} as never);

beforeEach(() => {
  db = new Database(':memory:');
  store = createScheduleStore(db);
});
afterEach(() => { db.close(); });

/** A notifier double that behaves like the block for the two things this
 *  module depends on: asks stay OPEN until cancelled, and `listOpenAsks`
 *  returns them with their persisted handler payload. */
const fakeNotifier = () => {
  const open = new Map<string, { handler_kind: string; handler_payload: Record<string, unknown> }>();
  const raised: { title: string; text: string; link_url?: string }[] = [];
  let handler: ((p: Record<string, unknown>, a: { option: string }) => void) | null = null;
  let n = 0;
  const notifier: MissedRunAskNotifier = {
    async ask(message, _options, h) {
      const ask_id = `ask-${++n}`;
      raised.push(message);
      open.set(ask_id, { handler_kind: h.kind, handler_payload: h.payload });
      return { ask_id };
    },
    async cancelAsk(ask_id) {
      return open.delete(ask_id) ? 'cancelled' : 'not_open';
    },
    async listOpenAsks() {
      return [...open.entries()].map(([ask_id, v]) => ({ ask_id, ...v }));
    },
    registerAskHandler(_kind, fn) { handler = fn; },
  };
  return {
    notifier, raised, open,
    answer: (option: string) => {
      const [, v] = [...open.entries()][0]!;
      handler?.(v.handler_payload, { option });
    },
  };
};

const mkAsk = (fake: ReturnType<typeof fakeNotifier>) => createMissedRunAsk({
  notifier: fake.notifier,
  answer: ({ answer, recipe_ids }) =>
    void answerMissed({ store, now: () => NOW }, { answer, recipe_ids }),
  recipeName: (id) => (id === 'morning-brief' ? 'Morning brief' : undefined),
  link: '#automation/schedules',
});

const report = () => buildMissedRunReport(store.list(), NOW);

const schedulerWith = (
  fired: string[],
  // ⚠ THE REAL TYPE, not `(r: never)`. A `never` parameter satisfies the
  // optional field by being assignable to nothing, runs green under
  // vitest, and fails `typecheck:tests` — which is in `npm run ci` while
  // the suite is not. Second time in this session; the fix is to name
  // the type the seam actually declares.
  onMissedRuns?: (report: MissedRunReport) => void | Promise<void>,
) =>
  createScheduler({
    store,
    executeDeps: {
      recipeStore: { get: (id: string) => ({ recipe_id: id, version: 1, steps: [] }), size: () => 1 },
      executorConfig: { manifests: { get: () => undefined, size: () => 0 }, vault: {} },
      baseVault: {}, instanceId: 'server-test-1',
    } as unknown as ExecuteHandlerDeps,
    now: () => NOW,
    execute: (async (_d: unknown, req: { recipe_id: string }) => {
      fired.push(req.recipe_id);
      return { success: true, steps: [], errors: [] };
    }) as never,
    ...(onMissedRuns ? { onMissedRuns } : {}),
  });

describe('D-266 — the missed-run ask', () => {
  it('raises ONE ask naming the recipe and its missed count', async () => {
    seed({});
    const fake = fakeNotifier();
    await mkAsk(fake).project(report());

    expect(fake.raised).toHaveLength(1);
    expect(fake.raised[0]!.text).toContain('Morning brief');
    // 29 full cycles BEYOND the catch-up on offer ⇒ 30 missed runs.
    expect(fake.raised[0]!.text).toContain('missed 30');
    // The per-recipe answer lives on the page; the ask's own options are
    // all-or-nothing by design.
    expect(fake.raised[0]!.link_url).toBe('#automation/schedules');
  });

  it('⛔ does NOT raise a second ask while one is open — one per wake, not one per tick', async () => {
    seed({});
    const fake = fakeNotifier();
    const ask = mkAsk(fake);
    for (let i = 0; i < 5; i += 1) await ask.project(report());
    expect(fake.raised).toHaveLength(1);
  });

  it('raises nothing when nothing is waiting', async () => {
    seed({ missed_policy: 'auto' });
    const fake = fakeNotifier();
    await mkAsk(fake).project(report());
    expect(fake.raised).toEqual([]);
  });

  it('⛔ CANCELS an ask whose misses resolved THEMSELVES', async () => {
    seed({});
    const fake = fakeNotifier();
    const ask = mkAsk(fake);
    await ask.project(report());
    expect(fake.open.size).toBe(1);

    // The next regular cycle fires — no answer given, question moot.
    store.updateRun('s1', { last_run_at: NOW });
    await ask.project(report());

    expect(fake.open.size).toBe(0);
    // And it does not re-raise for the thing it just cancelled.
    expect(fake.raised).toHaveLength(1);
  });

  it('keeps the ask standing while ANY of its subjects is still waiting', async () => {
    seed({ schedule_id: 's1', recipe_id: 'brief' });
    seed({ schedule_id: 's2', recipe_id: 'sweep' });
    const fake = fakeNotifier();
    const ask = mkAsk(fake);
    await ask.project(report());
    expect(fake.open.size).toBe(1);

    store.updateRun('s1', { last_run_at: NOW }); // one of the two resolves
    await ask.project(report());
    // Re-raising for the remainder would cost a SECOND prompt for one
    // question; the standing ask still names something real.
    expect(fake.open.size).toBe(1);
    expect(fake.raised).toHaveLength(1);
  });

  it("answering 'run' grants the catch-up the next tick fires", async () => {
    seed({});
    const fake = fakeNotifier();
    const ask = mkAsk(fake);
    ask.register();
    await ask.project(report());

    fake.answer('run');
    expect(store.get('s1')!.missed_answer)
      .toEqual({ at: NOW - (NOW % 60_000), answer: 'run' });

    const fired: string[] = [];
    await schedulerWith(fired).tick();
    expect(fired).toEqual(['morning-brief']);
  });

  it("answering 'skip' runs nothing and records the skip", async () => {
    seed({});
    const fake = fakeNotifier();
    const ask = mkAsk(fake);
    ask.register();
    await ask.project(report());

    fake.answer('skip');
    expect(store.get('s1')!.last_status).toBe('skipped');

    const fired: string[] = [];
    await schedulerWith(fired).tick();
    expect(fired).toEqual([]);

    // ⛔ AND THE QUESTION IS GONE. Without this the answered ask is
    // cancelled and the very next tick raises an identical one — an
    // endless prompt, on the option D-266 says must not become the first
    // one an owner turns off. The suite asserted the row and not the
    // question until an audit drove it.
    expect(report().entries).toEqual([]);
    await ask.project(report());
    expect(fake.raised).toHaveLength(1);
  });

  it('ignores an option it does not recognise rather than guessing', async () => {
    seed({});
    const fake = fakeNotifier();
    const ask = mkAsk(fake);
    ask.register();
    await ask.project(report());

    fake.answer('later');
    expect(store.get('s1')!.missed_answer).toBeUndefined();
    expect(store.get('s1')!.last_status).toBe('success');
  });

  it('⛔ a notifier failure never fails the tick that fires schedules', async () => {
    seed({});
    const ask = createMissedRunAsk({
      notifier: {
        async ask() { throw new Error('channel down'); },
        async cancelAsk() { return 'not_open'; },
        async listOpenAsks() { return []; },
        registerAskHandler() {},
      },
      answer: () => {},
    });
    await expect(ask.project(report())).resolves.toBeUndefined();
  });
});

describe('D-266 — a block without the ask surface degrades, never crashes', () => {
  it('⛔ the boot probe rejects a partial block rather than calling into it', async () => {
    // The shape of the failure this guards: `register()` is the first
    // EAGER call the boot makes on the notification block, so a supplier
    // missing a method fails at STARTUP and takes the runtime with it —
    // not at the method, later, in a feature nobody was using.
    // ⚠ THE REAL PREDICATE, imported — an inline copy here would assert
    // that the copy works and tell us nothing about the boot.
    expect(hasMissedRunAskSurface({ recoverPendingAsks: async () => undefined }))
      .toBe(false);
    expect(hasMissedRunAskSurface(fakeNotifier().notifier)).toBe(true);
    expect(hasMissedRunAskSurface(undefined)).toBe(false);
    // Each method is individually load-bearing: dropping any ONE must
    // fail the probe, or a partial block still reaches an eager call.
    const full = fakeNotifier().notifier as unknown as Record<string, unknown>;
    for (const method of ['ask', 'cancelAsk', 'listOpenAsks', 'registerAskHandler']) {
      const missing = { ...full };
      delete missing[method];
      expect(hasMissedRunAskSurface(missing), method).toBe(false);
    }
  });
});

describe('D-266 — the scheduler hands the report over every tick', () => {
  it('calls the seam with what is waiting, AFTER its own writes', async () => {
    seed({});
    const seen: MissedRunReport[] = [];
    const fired: string[] = [];
    await schedulerWith(fired, async (report) => { seen.push(report); }).tick();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.entries.map((e) => e.recipe_id)).toEqual(['morning-brief']);
  });

  it('⛔ calls the seam even when NOTHING is waiting — that is how a stale ask gets cancelled', async () => {
    seed({ missed_policy: 'auto', last_run_at: at(1), prev_run_at: at(2) });
    const seen: MissedRunReport[] = [];
    const fired: string[] = [];
    await schedulerWith(fired, async (report) => { seen.push(report); }).tick();

    expect(fired).toEqual(['morning-brief']); // the catch-up ran
    expect(seen).toHaveLength(1);             // and the seam still fired
  });

  it('a throwing seam does not fail the tick', async () => {
    seed({ missed_policy: 'catch_up' });
    const fired: string[] = [];
    const sched = schedulerWith(fired, async () => { throw new Error('nope'); });
    await expect(sched.tick()).resolves.toBeDefined();
    expect(fired).toEqual(['morning-brief']);
  });
});
