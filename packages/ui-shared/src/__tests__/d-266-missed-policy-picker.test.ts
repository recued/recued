/** D-266 — the missed-run policy picker on the Schedule tab.
 *
 *  The picker is ON the schedule, not on the recipe, and that placement
 *  is the design: the same recipe answers differently on two schedules,
 *  and it is the OWNER (who wrote the schedule) rather than the AUTHOR
 *  who knows whether a late run is worth having.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ServerRecipeListEntry, ServerSchedule } from '@recued/contracts';
import { MISSED_SCHEDULE_POLICIES, MISSED_SCHEDULE_POLICY_COPY } from '@recued/contracts';
import { wireRunModal } from '../run-modal/wire.js';
import { renderRunModal } from '../run-modal/render.js';
import { missedPolicySelectId, RUN_MODAL_MISSED_POLICY_ATTR } from '../run-modal/render.js';
import { initialRunModalState } from '../run-modal/model.js';
import { e } from '../template.js';

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

const paint = (schedules: ServerSchedule[]): string => renderRunModal(
  { ...initialRunModalState('schedule', '0 9 * * *'), schedules },
  recipeEntry(),
  { canSchedule: true, canRun: true } as never,
);

describe('D-266 — the picker renders on each schedule', () => {
  it('offers all four policies, with the schedule’s current one selected', () => {
    const html = paint([scheduleRow({ missed_policy: 'ask' })]);
    for (const policy of MISSED_SCHEDULE_POLICIES) {
      expect(html, policy).toContain(`value="${policy}"`);
      // The owner-facing copy, escaped the same way the renderer escapes it.
      expect(html, policy).toContain(e(MISSED_SCHEDULE_POLICY_COPY[policy].label));
    }
    expect(html).toContain('value="ask" selected');
  });

  it('shows "Decide for me" when the schedule declares nothing — the pre-D-266 default', () => {
    expect(paint([scheduleRow()])).toContain('value="auto" selected');
  });

  it('⛔ never labels the default "adaptive" — it adapts to cadence, not to judgement', () => {
    expect(paint([scheduleRow()]).toLowerCase()).not.toContain('adaptive');
  });

  it('carries a stable element id, so focus survives the repaint after a change', () => {
    const html = paint([scheduleRow({ schedule_id: 'sch_abc' })]);
    expect(html).toContain(`id="${missedPolicySelectId('sch_abc')}"`);
  });

  it('is ABSENT on a one-shot ROW — there is no missed cycle for a single occurrence', () => {
    const html = paint([scheduleRow({ schedule_id: 'sch_one', mode: 'one_shot', run_at: 1_800_000_000_000 })]);
    // ⚠ Assert the ROW's select, not the label text: the Add form below
    // carries the same words, so `not.toContain('If it is missed')` would
    // fail for the wrong reason and read as this rule being broken.
    expect(html).not.toContain(`id="${missedPolicySelectId('sch_one')}"`);
    expect(html).not.toContain(`${RUN_MODAL_MISSED_POLICY_ATTR}`);
  });
});

describe('D-266 — the policy is choosable WHEN THE SCHEDULE IS WRITTEN', () => {
  const addForm = (state: Partial<Parameters<typeof renderRunModal>[0]> = {}): string =>
    renderRunModal(
      { ...initialRunModalState('schedule', '0 9 * * *'), schedules: [], ...state },
      recipeEntry(),
      { canSchedule: true, canRun: true } as never,
    );

  it('offers the policy on the Add form, defaulted to "Decide for me"', () => {
    const html = addForm();
    expect(html).toContain('run-modal-new-missed-policy');
    expect(html).toContain('value="auto" selected');
  });

  it('is ABSENT when Repeat is off — a one-shot has no missed cycle', () => {
    expect(addForm({ repeat: false })).not.toContain('run-modal-new-missed-policy');
  });

  it('arms the new schedule with the chosen policy', async () => {
    const create = vi.fn(async () => ({ schedule: scheduleRow({ missed_policy: 'ask' }) }));
    const handle = wire({
      recipe: recipeEntry(),
      schedulesList: vi.fn(async () => ({ schedules: [] })),
      schedulesCreate: create,
      initialTab: 'schedule',
    });

    handle.setNewMissedPolicy('ask');
    await handle.addSchedule();

    const args = (create.mock.calls as unknown as unknown[][])[0]![0] as Record<string, unknown>;
    expect(args.missed_policy).toBe('ask');
  });

  it('⛔ OMITS the field at the default, so a pre-D-266 payload stays byte-identical', async () => {
    const create = vi.fn(async () => ({ schedule: scheduleRow() }));
    const handle = wire({
      recipe: recipeEntry(),
      schedulesList: vi.fn(async () => ({ schedules: [] })),
      schedulesCreate: create,
      initialTab: 'schedule',
    });

    await handle.addSchedule();

    const args = (create.mock.calls as unknown as unknown[][])[0]![0] as Record<string, unknown>;
    // Absent reads as 'auto' everywhere; sending it would change every
    // existing host's payload for no behavioural difference.
    expect('missed_policy' in args).toBe(false);
  });

  it('never sends it on a one-shot', async () => {
    const create = vi.fn(async () => ({ schedule: scheduleRow() }));
    const handle = wire({
      recipe: recipeEntry(),
      schedulesList: vi.fn(async () => ({ schedules: [] })),
      schedulesCreate: create,
      initialTab: 'schedule',
    });

    handle.setNewMissedPolicy('ask');
    handle.setRepeat(false);
    handle.setRunAtLocal('2026-08-03T14:30');
    await handle.addSchedule();

    const args = (create.mock.calls as unknown as unknown[][])[0]![0] as Record<string, unknown>;
    expect(args.mode).toBe('one_shot');
    expect('missed_policy' in args).toBe(false);
  });
});

describe('D-266 — choosing a policy persists it', () => {
  it('sends exactly the schedule and the policy, changing nothing else', async () => {
    const update = vi.fn(async () => ({ schedule: scheduleRow({ missed_policy: 'ask' }) }));
    const handle = wire({
      recipe: recipeEntry(),
      schedulesList: vi.fn(async () => ({ schedules: [scheduleRow()] })),
      schedulesUpdate: update,
      initialTab: 'schedule',
    });

    await handle.setMissedPolicy('s1', 'ask');

    const args = (update.mock.calls as unknown as unknown[][])[0]![0] as Record<string, unknown>;
    expect(args).toEqual({ schedule_id: 's1', missed_policy: 'ask' });
    // ⛔ Not a cron edit and not a pause: a policy change must not ride
    // along with any other field, or a stray `enabled` would pause the
    // schedule the owner was only annotating.
    expect(args.cron_expression).toBeUndefined();
    expect(args.enabled).toBeUndefined();
  });
});
