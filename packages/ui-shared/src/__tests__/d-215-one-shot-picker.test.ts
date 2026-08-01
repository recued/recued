/** D-215 slice 5 — the Repeat toggle, the one-shot payload, and mode-first
 *  cadence rendering.
 *
 *  🔑 This is the slice that makes § 4.8's flow work at all. Before it,
 *  `mode: 'one_shot'` was supported by the SERVER and reachable from NO UI:
 *  `RunModalSchedulesCreateCaller` required `cron_expression` and the
 *  Schedule tab offered CRON presets only.
 *
 *  ⛔ And the trap the toggle surfaces: a one-shot's `cron_expression` is
 *  SYNTHESIZED by the server from `run_at` and is a VALID ANNUAL cron, so
 *  passing it to `describeCron` renders `30 14 3 8 *` — a recurring rule
 *  that does not exist. Cadence must branch on `mode` FIRST.
 *
 *  Spec: D-215 § 4.8.1.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ServerRecipeListEntry, ServerSchedule } from '@recued/contracts';
import { wireRunModal } from '../run-modal/wire.js';
import { renderRunModal } from '../run-modal/render.js';
import { initialRunModalState } from '../run-modal/model.js';

const recipeEntry = (): ServerRecipeListEntry => ({
  recipe_id: 'daily-brief',
  publisher_id: 'recued-core',
  version: 1,
  recipe_hash: 'h',
  recipe: {
    recipe_id: 'daily-brief',
    version: 1,
    ttl: 60,
    metadata: { name: 'Daily brief', description: 'd', author: 'a', supported_platforms: [] },
    variables: {},
    prefetch_steps: [],
    steps: [],
    output: { sidebar: [] },
  },
  source: 'pair-sync',
  installed_at: 1_700_000_000_000,
} as unknown as ServerRecipeListEntry);

const scheduleRow = (over: Partial<ServerSchedule> = {}): ServerSchedule => ({
  schedule_id: 's1',
  recipe_id: 'daily-brief',
  publisher_id: 'recued-core',
  cron_expression: '0 9 * * *',
  enabled: true,
  created_at: 1_700_000_000_000,
  last_run_at: null,
  next_run_at: null,
  last_status: null,
  last_error: null,
  ...over,
} as ServerSchedule);

// The suite's node env has no DOM; the modal only needs createElement +
// body/head appenders to paint into.
const makeDoc = () => {
  const mk = (tag: string): Record<string, unknown> => {
    const el: Record<string, unknown> = {
      tagName: tag.toUpperCase(),
      innerHTML: '',
      children: [] as unknown[],
      setAttribute: () => {},
      getAttribute: () => null,
      hasAttribute: () => false,
      appendChild: (c: unknown) => { (el.children as unknown[]).push(c); return c; },
      removeChild: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      remove: () => {},
      focus: () => {},
    };
    return el;
  };
  const body = mk('body');
  return {
    body,
    head: { querySelector: () => null, appendChild: (el: unknown) => el },
    createElement: (t: string) => mk(t),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
};

const wire = (opts: Parameters<typeof wireRunModal>[0]) =>
  wireRunModal({ document: makeDoc() as unknown as Document, ...opts });

describe('D-215 slice 5 — Repeat off creates a ONE-SHOT', () => {
  it('sends mode + run_at, and NO cron_expression', async () => {
    const create = vi.fn(async () => ({ schedule: scheduleRow() }));
    const handle = wire({
      recipe: recipeEntry(),
      schedulesList: vi.fn(async () => ({ schedules: [] })),
      schedulesCreate: create,
      initialTab: 'schedule',
    });

    handle.setRepeat(false);
    handle.setRunAtLocal('2026-08-03T14:30');
    await handle.addSchedule();

    const args = (create.mock.calls as unknown as unknown[][])[0]![0] as Record<string, unknown>;
    expect(args.mode).toBe('one_shot');
    // The SERVER synthesizes the expression from run_at — a caller that
    // sends one would be inventing a cadence.
    expect(args.cron_expression).toBeUndefined();
    expect(typeof args.run_at).toBe('number');
  });

  it('resolves the picked wall clock against the BROWSER zone, not the server', async () => {
    // § 4.6: a zone-less wall clock parsed server-side lands in the SERVER's
    // zone. Resolving at the picker and shipping epoch ms is the fix, so
    // `run_at` is an instant by the time it leaves.
    const create = vi.fn(async () => ({ schedule: scheduleRow() }));
    const handle = wire({
      recipe: recipeEntry(),
      schedulesList: vi.fn(async () => ({ schedules: [] })),
      schedulesCreate: create,
    });
    handle.setRepeat(false);
    handle.setRunAtLocal('2026-08-03T14:30');
    await handle.addSchedule();

    const args = (create.mock.calls as unknown as unknown[][])[0]![0] as { run_at: number };
    expect(args.run_at).toBe(new Date('2026-08-03T14:30').getTime());
  });

  it('⛔ refuses to create with no time picked, rather than sending a bad one', async () => {
    const create = vi.fn(async () => ({ schedule: scheduleRow() }));
    const handle = wire({
      recipe: recipeEntry(),
      schedulesList: vi.fn(async () => ({ schedules: [] })),
      schedulesCreate: create,
    });
    handle.setRepeat(false);
    await handle.addSchedule();

    expect(create).not.toHaveBeenCalled();
    expect(handle.getState().schedule_error).toMatch(/date and time/i);
  });

  it('refuses an unparseable time', async () => {
    const create = vi.fn(async () => ({ schedule: scheduleRow() }));
    const handle = wire({
      recipe: recipeEntry(),
      schedulesList: vi.fn(async () => ({ schedules: [] })),
      schedulesCreate: create,
    });
    handle.setRepeat(false);
    handle.setRunAtLocal('not-a-date');
    await handle.addSchedule();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('D-215 slice 5 — Repeat on is byte-identical to before', () => {
  it('omits mode entirely and sends cron_expression', async () => {
    // The contract reads absent as recurring. Sending mode:'recurring'
    // would change every pre-slice-5 payload for no behavioural gain —
    // and did break three existing tests before this was corrected.
    const create = vi.fn(async () => ({ schedule: scheduleRow() }));
    const handle = wire({
      recipe: recipeEntry(),
      schedulesList: vi.fn(async () => ({ schedules: [] })),
      schedulesCreate: create,
    });
    handle.setPreset('0 9 * * *');
    await handle.addSchedule();

    expect(create).toHaveBeenCalledWith({
      recipe_id: 'daily-brief',
      publisher_id: 'recued-core',
      cron_expression: '0 9 * * *',
    });
  });

  it('an EXPLICITLY empty preset still creates nothing', async () => {
    // ⚠ The modal seeds `CRON_PRESETS[0]` by default, so "no preset" is a
    // state the owner has to reach deliberately — an earlier version of
    // this test asserted on a fresh modal and passed for the wrong reason
    // (it was creating, with the seeded default).
    const create = vi.fn(async () => ({ schedule: scheduleRow() }));
    const handle = wire({
      recipe: recipeEntry(),
      schedulesList: vi.fn(async () => ({ schedules: [] })),
      schedulesCreate: create,
    });
    handle.setPreset('');
    await handle.addSchedule();
    expect(create).not.toHaveBeenCalled();
  });

  it('a fresh modal seeds the first CRON preset, so Add works immediately', async () => {
    const create = vi.fn(async () => ({ schedule: scheduleRow() }));
    const handle = wire({
      recipe: recipeEntry(),
      schedulesList: vi.fn(async () => ({ schedules: [] })),
      schedulesCreate: create,
    });
    await handle.addSchedule();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('defaults to Repeat ON — a fresh modal behaves as it always did', () => {
    const handle = wire({
      recipe: recipeEntry(),
      schedulesList: vi.fn(async () => ({ schedules: [] })),
    });
    expect(handle.getState().repeat).toBe(true);
  });
});

describe('D-215 slice 5 — cadence rendering branches on MODE first', () => {
  const paint = (schedules: ServerSchedule[]): string => {
    const doc = makeDoc();
    wireRunModal({
      document: doc as unknown as Document,
      recipe: recipeEntry(),
      schedulesList: async () => ({ schedules }),
      initialTab: 'schedule',
    });
    return renderRunModal(
      {
        ...initialRunModalState('schedule', '0 9 * * *'),
        schedules,
      } as never,
      recipeEntry(),
      { canRun: true, canSchedule: true, canTrigger: false, canPickFiles: false } as never,
    );
  };

  it('⛔ a ONE-SHOT never prints its synthesized cron', () => {
    // `30 14 3 8 *` is what the server synthesizes for 2026-08-03 14:30.
    // It is a VALID ANNUAL cron, so describeCron returns it verbatim — the
    // row would read as a yearly rule that does not exist.
    const html = paint([scheduleRow({
      mode: 'one_shot',
      cron_expression: '30 14 3 8 *',
      run_at: new Date('2026-08-03T14:30').getTime(),
    } as Partial<ServerSchedule>)]);

    expect(html).not.toContain('30 14 3 8 *');
    expect(html).toContain('Once');
  });

  it('a one-shot with no run_at says so rather than printing a cron', () => {
    const html = paint([scheduleRow({
      mode: 'one_shot', cron_expression: '30 14 3 8 *',
    } as Partial<ServerSchedule>)]);
    expect(html).not.toContain('30 14 3 8 *');
    expect(html).toContain('time not set');
  });

  it('a RECURRING row still shows its cadence and expression', () => {
    const html = paint([scheduleRow({ cron_expression: '0 9 * * *' })]);
    expect(html).toContain('0 9 * * *');
    expect(html).not.toContain('Once —');
  });
});
