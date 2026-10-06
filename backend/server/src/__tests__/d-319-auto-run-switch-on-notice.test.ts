/** D-319 — the one-time notice naming the recipes on a timer the update left
 *  switched off (`auto-run-switch-on-notice.ts`).
 *
 *  Slice 2 dropped the per-recipe auto-run tables without converting them, so
 *  every auto-run recipe stays stopped after the update until its recipe is
 *  switched on. The notice names the ones Automation shows as "Not switched on"
 *  — through the SAME rule (`isNotSwitchedOn`, spied here so a private copy
 *  fails) — from current state only, once per server, ever. Over the real dish
 *  store and D-308 ledger; the audit log and the notifier are fakes. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isNotSwitchedOn, type Dish, type RecipeDefinition } from '@recued/contracts';

import {
  AUTO_RUN_SWITCH_ON_NOTICE_ID,
  autoRunRecipesNotSwitchedOn,
  autoRunSwitchOnNotice,
  noticeAutoRunSwitchOnAtBoot,
  type AutoRunSwitchOnNoticeDeps,
  type NotSwitchedOnRecipe,
} from '../auto-run-switch-on-notice.js';
import { AUTO_RUN_TIMER_REARM_ID, rearmAutoRunTimers } from '../auto-run-timer-rearm.js';
import { createDishStore, type DishStore } from '../dish-store.js';
import { createDataRepairLedger } from '../storage/data-repair-ledger.js';
import type { StoredRecipe } from '../types.js';

// A pass-through spy on the shared rule: every test runs the real one, and the
// one that overrides it proves the notice reads it rather than a copy.
vi.mock('@recued/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recued/contracts')>();
  return { ...actual, isNotSwitchedOn: vi.fn(actual.isNotSwitchedOn) };
});
const { isNotSwitchedOn: theRealRule } =
  await vi.importActual<typeof import('@recued/contracts')>('@recued/contracts');

const recipe = (
  recipe_id: string,
  over: Partial<RecipeDefinition> = {},
  name: string = recipe_id,
): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 300,
  variables: {},
  metadata: { name, description: 'test', author: 'test', supported_platforms: ['test'] },
  steps: [],
  ...over,
} as unknown as RecipeDefinition);

/** A recipe on a timer. */
const onTimer = (recipe_id: string, name?: string): RecipeDefinition =>
  recipe(recipe_id, { auto_run: { interval_ms: 60_000 } }, name);

const stored = (r: RecipeDefinition): StoredRecipe => ({
  recipe_id: r.recipe_id,
  publisher_id: 'publisher',
  version: r.version,
  recipe_hash: 'hash',
  recipe_json: JSON.stringify(r),
  source: 'inline',
  installed_at: 0,
  pack_slug: null,
});

let db: Database.Database;
let dishes: DishStore;
let minted = 0;

beforeEach(() => {
  db = new Database(':memory:');
  dishes = createDishStore(db);
  vi.mocked(isNotSwitchedOn).mockClear();
  vi.mocked(isNotSwitchedOn).mockImplementation(theRealRule);
});
afterEach(() => { db.close(); });

const dishOf = (recipe_id: string, over: Partial<Dish> = {}): Dish => {
  const dish: Dish = {
    dish_id: `dsh_${recipe_id}_${(minted += 1)}`,
    recipe_id,
    publisher_id: 'publisher',
    name: '',
    is_default: true,
    config_overlay: {},
    enabled: true,
    created_at: 1,
    ...over,
  };
  dishes.set(dish);
  return dish;
};

const sources = (rows: StoredRecipe[]) => ({
  recipeStore: { listStored: () => rows },
  dishStore: dishes,
});

describe('which recipes it names: Automation’s "Not switched on", for recipes on a timer', () => {
  it('names an installed recipe on a timer with no dish, and not one with a dish, on or off', () => {
    dishOf('digest');
    dishOf('paused', { enabled: false });
    expect(autoRunRecipesNotSwitchedOn(sources([
      stored(onTimer('brief', 'Morning brief')),
      stored(onTimer('digest', 'Daily digest')),
      // Off is the owner's switch on a dish: Automation shows the dish, Off.
      stored(onTimer('paused', 'Paused one')),
    ]))).toEqual([{ recipe_id: 'brief', name: 'Morning brief' }]);
  });

  it('names only recipes on a timer: not a manual one, nor one a trigger starts', () => {
    expect(autoRunRecipesNotSwitchedOn(sources([
      stored(recipe('manual')),
      stored(recipe('watcher', { event_triggers: [{ event: 'data.mail.*.created' }] } as never)),
      stored(onTimer('brief')),
    ])).map((r) => r.recipe_id)).toEqual(['brief']);
  });

  it('orders by name, falls back to the id for a recipe with none, and skips one it cannot read', () => {
    const unnamed = onTimer('zz-unnamed', '  ');
    const broken = { ...stored(onTimer('broken')), recipe_json: '{not json' };
    expect(autoRunRecipesNotSwitchedOn(sources([
      stored(onTimer('b', 'Stalled projects')),
      stored(unnamed),
      broken,
      stored(onTimer('a', 'Morning brief')),
    ]))).toEqual([
      { recipe_id: 'a', name: 'Morning brief' },
      { recipe_id: 'b', name: 'Stalled projects' },
      { recipe_id: 'zz-unnamed', name: 'zz-unnamed' },
    ]);
  });

  it('asks the shared rule, with each recipe and its dish count, and names what it says', () => {
    dishOf('digest');
    const rule = vi.mocked(isNotSwitchedOn);
    // Were the notice to count dishes itself, this override would not reach
    // it: the rule is inverted here, and the notice follows it.
    rule.mockImplementation((input) => (input.recipe as RecipeDefinition | undefined)?.recipe_id === 'digest');
    expect(autoRunRecipesNotSwitchedOn(sources([
      stored(onTimer('brief')),
      stored(onTimer('digest')),
    ])).map((r) => r.recipe_id)).toEqual(['digest']);
    expect(rule).toHaveBeenCalledWith(expect.objectContaining({
      recipe: expect.objectContaining({ recipe_id: 'digest' }), dishes: 1,
    }));
    expect(rule).toHaveBeenCalledWith(expect.objectContaining({
      recipe: expect.objectContaining({ recipe_id: 'brief' }), dishes: 0,
    }));
  });

  it('reads current state only: a server that still has the dropped tables is told the same', () => {
    const rows = [stored(onTimer('brief', 'Morning brief')), stored(onTimer('digest', 'Daily digest'))];
    const before = autoRunRecipesNotSwitchedOn(sources(rows));
    // 26.9.29's per-recipe tables, as a server updating straight from it may
    // still hold them: one timer on, one paused, one tripped.
    db.exec(`
      CREATE TABLE auto_run_settings (recipe_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL, dish_id TEXT);
      INSERT INTO auto_run_settings VALUES ('brief', 1, 1, NULL), ('digest', 0, 1, NULL);
      CREATE TABLE auto_run_circuit (recipe_id TEXT PRIMARY KEY, consecutive_failures INTEGER NOT NULL DEFAULT 0,
        auto_disabled INTEGER NOT NULL DEFAULT 0, last_failure_at INTEGER, last_failure_reason TEXT);
      INSERT INTO auto_run_circuit VALUES ('brief', 5, 1, 1, 'boom');
    `);
    expect(autoRunRecipesNotSwitchedOn(sources(rows))).toEqual(before);
    expect(before.map((r) => r.name)).toEqual(['Daily digest', 'Morning brief']);
  });
});

const named = (...names: string[]): NotSwitchedOnRecipe[] =>
  names.map((name, i) => ({ recipe_id: `r${i}`, name }));

describe('what it says', () => {
  it('says nothing when every recipe on a timer is switched on', () => {
    expect(autoRunSwitchOnNotice([], 'https://home.example')).toBeNull();
  });

  it('two recipes: the update changed how recipes start, which are not switched on, and where to switch them on', () => {
    expect(autoRunSwitchOnNotice(named('Morning brief', 'Stalled projects'), null)).toEqual({
      title: '2 recipes that start on their own are not switched on',
      text: 'A recent update changed how recipes start: a recipe now runs on its own only once it is '
        + 'switched on. These recipes start on their own and are not switched on:'
        + '\n• Morning brief\n• Stalled projects'
        + '\n\nTo run them, open Automation and switch them on.',
    });
  });

  it('one recipe reads in the singular', () => {
    expect(autoRunSwitchOnNotice(named('Morning brief'), null)).toEqual({
      title: '1 recipe that starts on its own is not switched on',
      text: 'A recent update changed how recipes start: a recipe now runs on its own only once it is '
        + 'switched on. This recipe starts on its own and is not switched on:'
        + '\n• Morning brief'
        + '\n\nTo run it, open Automation and switch it on.',
    });
  });

  it('twelve: names ten, and counts the rest', () => {
    const twelve = named(...Array.from({ length: 12 }, (_, i) => `Recipe ${String(i + 1).padStart(2, '0')}`));
    const message = autoRunSwitchOnNotice(twelve, null)!;
    expect(message.title).toBe('12 recipes that start on their own are not switched on');
    expect(message.text.match(/^• Recipe \d\d$/gmu)).toHaveLength(10);
    expect(message.text).toContain('\n• Recipe 10\n• …and 2 more\n\nTo run them');
    expect(message.text).not.toContain('Recipe 11');
    // Ten names exactly: an eleventh is counted, not listed.
    expect(autoRunSwitchOnNotice(twelve.slice(0, 10), null)!.text).not.toContain('more');
    expect(autoRunSwitchOnNotice(twelve.slice(0, 11), null)!.text).toContain('\n• …and 1 more');
  });

  it('links Automation at the server’s public address, and carries no link without one', () => {
    expect(autoRunSwitchOnNotice(named('Morning brief'), 'https://home.example'))
      .toMatchObject({ link_url: 'https://home.example/#automation' });
    expect(autoRunSwitchOnNotice(named('Morning brief'), null)).not.toHaveProperty('link_url');
  });

  it('never says a recipe was running: one the owner had paused is named too', () => {
    for (const recipes of [named('Morning brief'), named('A', 'B'), named(...Array.from({ length: 12 }, (_, i) => `R${i}`))]) {
      const { title, text } = autoRunSwitchOnNotice(recipes, null)!;
      expect(`${title}\n${text}`).not.toMatch(/\b(?:was|were) running\b|\bstopped\b|\bpaused\b|\bran\b/iu);
    }
  });
});

describe('once per server, ever, at boot', () => {
  const ID = AUTO_RUN_SWITCH_ON_NOTICE_ID;
  const ACTIVITY = `data-repair:${ID}`;

  // The re-arm runs first at every boot and switched nothing on here: the
  // notice waits for its row (see 'at boot, from the re-arm's ledger row').
  beforeEach(() => {
    createDataRepairLedger(db).record({
      repair_id: AUTO_RUN_TIMER_REARM_ID,
      applied_at: 1,
      summary: { path: 'nothing', rearmed: [], kept_off: [], tripped: [], left: [] },
    });
  });

  const deps = (
    rows: StoredRecipe[],
    over: Partial<AutoRunSwitchOnNoticeDeps> = {},
  ) => {
    const ledger = createDataRepairLedger(db);
    const logActivity = vi.fn(async (_entry: unknown): Promise<void> => undefined);
    const notify = vi.fn(async (_message: unknown, _channels?: unknown, _extras?: unknown): Promise<void> => undefined);
    return {
      ...sources(rows),
      ledger,
      auditLog: { logActivity },
      notifier: { notify },
      publicBaseUrl: null,
      now: () => 42,
      logActivity,
      notify,
      ...over,
    };
  };

  it('tells the owner once: the history row under a fixed id, then the ledger, then the push', async () => {
    const d = deps([stored(onTimer('brief', 'Morning brief')), stored(onTimer('stalled', 'Stalled projects'))]);
    let ledgerAtHistory: unknown = 'unread';
    let noticedAtPush: unknown = 'unread';
    d.logActivity.mockImplementation(async () => { ledgerAtHistory = d.ledger.get(ID); });
    d.notify.mockImplementation(async () => { noticedAtPush = d.ledger.get(ID)?.noticed_at; });

    expect(await noticeAutoRunSwitchOnAtBoot(d)).toEqual({ outcome: 'noticed', named: 2, switched_on: 0 });

    expect(d.logActivity).toHaveBeenCalledTimes(1);
    const entry = d.logActivity.mock.calls[0]![0] as Record<string, unknown>;
    expect(entry).toMatchObject({ activity_id: ACTIVITY, timestamp: 42, action: 'notification_fired', target: ID });
    expect(JSON.parse(entry.detail as string)).toEqual({
      ...autoRunSwitchOnNotice([
        { recipe_id: 'brief', name: 'Morning brief' },
        { recipe_id: 'stalled', name: 'Stalled projects' },
      ], null),
      // The owner's own screens open Automation even with no public address.
      link_url: '#automation',
    });
    expect(ledgerAtHistory, 'the history row comes before the ledger').toBeNull();
    expect(noticedAtPush, 'the push comes after the ledger').toBe(42);
    expect(d.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: '2 recipes that start on their own are not switched on' }),
      undefined,
      { persisted_activity_id: ACTIVITY, ui_link_url: '#automation' },
    );
    expect(d.ledger.get(ID)).toMatchObject({
      applied_at: 42,
      noticed_at: 42,
      summary: { not_switched_on: [
        { recipe_id: 'brief', name: 'Morning brief' },
        { recipe_id: 'stalled', name: 'Stalled projects' },
      ] },
    });
  });

  it('a server that recorded it under the shipped id is never told again: the id is persisted, not renamed', async () => {
    // ⛔ The literal, not the constant: every server keeps its row under this
    // id, so a new one would tell every owner a second time.
    createDataRepairLedger(db).record({
      repair_id: 'd319-auto-run-switch-on-notice-v1', applied_at: 1, summary: { not_switched_on: [] },
    });
    const d = deps([stored(onTimer('brief'))]);
    expect(await noticeAutoRunSwitchOnAtBoot(d)).toEqual({ outcome: 'done', named: 0, switched_on: 0 });
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('never tells again once the ledger has its row, even with more to say', async () => {
    const rows = [stored(onTimer('brief'))];
    await noticeAutoRunSwitchOnAtBoot(deps(rows));
    rows.push(stored(onTimer('another')));
    const again = deps(rows);
    expect(await noticeAutoRunSwitchOnAtBoot(again)).toEqual({ outcome: 'done', named: 0, switched_on: 0 });
    expect(again.logActivity).not.toHaveBeenCalled();
    expect(again.notify).not.toHaveBeenCalled();
  });

  it('with nothing to say, records its row and says nothing, and a later boot stays silent', async () => {
    dishOf('brief');
    const rows = [stored(onTimer('brief')), stored(recipe('manual'))];
    const d = deps(rows);
    expect(await noticeAutoRunSwitchOnAtBoot(d)).toEqual({ outcome: 'nothing_to_say', named: 0, switched_on: 0 });
    expect(d.logActivity).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
    expect(d.ledger.get(ID)).toMatchObject({ noticed_at: 42, summary: { not_switched_on: [] } });

    // A recipe installed later is not the update's doing.
    rows.push(stored(onTimer('installed-later')));
    const later = deps(rows);
    expect(await noticeAutoRunSwitchOnAtBoot(later)).toEqual({ outcome: 'done', named: 0, switched_on: 0 });
    expect(later.notify).not.toHaveBeenCalled();
  });

  it('with no notifier it waits and writes no ledger row; a boot that has one tells what is true then', async () => {
    const rows = [stored(onTimer('brief', 'Morning brief')), stored(onTimer('digest', 'Daily digest'))];
    const quiet = deps(rows, { notifier: undefined });
    expect(await noticeAutoRunSwitchOnAtBoot(quiet)).toEqual({ outcome: 'waiting', named: 0, switched_on: 0 });
    expect(quiet.ledger.get(ID)).toBeNull();
    expect(quiet.logActivity).not.toHaveBeenCalled();

    // Between the two boots the owner switched one on.
    dishOf('digest');
    const next = deps(rows);
    expect(await noticeAutoRunSwitchOnAtBoot(next)).toEqual({ outcome: 'noticed', named: 1, switched_on: 0 });
    expect(next.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('\n• Morning brief\n\n') }),
      undefined,
      expect.anything(),
    );
    expect(next.notify.mock.calls[0]![0]).not.toMatchObject({ text: expect.stringContaining('Daily digest') });
  });

  it('a boot that dies before the history row is written tells the owner at the next one', async () => {
    const rows = [stored(onTimer('brief'))];
    const dying = deps(rows);
    dying.logActivity.mockRejectedValueOnce(new Error('disk full'));
    await expect(noticeAutoRunSwitchOnAtBoot(dying)).rejects.toThrow(/disk full/u);
    expect(dying.ledger.get(ID)).toBeNull();
    expect(dying.notify).not.toHaveBeenCalled();

    const next = deps(rows);
    expect(await noticeAutoRunSwitchOnAtBoot(next)).toEqual({ outcome: 'noticed', named: 1, switched_on: 0 });
    expect(next.notify).toHaveBeenCalledTimes(1);
  });

  it('a failed push is not a failed notice: the history row is the record', async () => {
    const rejected = deps([stored(onTimer('brief'))]);
    rejected.notify.mockRejectedValueOnce(new Error('offline'));
    expect(await noticeAutoRunSwitchOnAtBoot(rejected)).toEqual({ outcome: 'noticed', named: 1, switched_on: 0 });
    expect(rejected.ledger.get(ID)?.noticed_at).toBe(42);

    db.prepare('DELETE FROM data_repairs WHERE repair_id = ?').run(ID);
    const thrown = deps([stored(onTimer('brief'))]);
    thrown.notify.mockImplementationOnce(() => { throw new Error('closed'); });
    expect(await noticeAutoRunSwitchOnAtBoot(thrown)).toEqual({ outcome: 'noticed', named: 1, switched_on: 0 });
  });

  it('links Automation at the public address when the server has one', async () => {
    const d = deps([stored(onTimer('brief'))], { publicBaseUrl: 'https://home.example' });
    await noticeAutoRunSwitchOnAtBoot(d);
    expect(d.notify).toHaveBeenCalledWith(
      expect.objectContaining({ link_url: 'https://home.example/#automation' }),
      undefined,
      { persisted_activity_id: ACTIVITY, ui_link_url: '#automation' },
    );
    const entry = d.logActivity.mock.calls[0]![0] as { detail: string };
    expect(JSON.parse(entry.detail)).toMatchObject({ link_url: 'https://home.example/#automation' });
  });
});

describe('what it says about the recipes the re-arm switched on', () => {
  it('only those: none ran on its own since the update, each does now, and how to stop one', () => {
    expect(autoRunSwitchOnNotice([], null, named('Morning brief', 'Stalled projects'))).toEqual({
      title: '2 recipes that start on their own were switched on',
      text: 'A recent update changed how recipes start: a recipe now runs on its own only once it is '
        + 'switched on. These recipes had not run on their own since then, and are switched on now:'
        + '\n• Morning brief\n• Stalled projects'
        + '\n\nIf one should not run on its own, open Automation and switch it off.',
    });
    expect(autoRunSwitchOnNotice([], null, named('Morning brief'))).toEqual({
      title: '1 recipe that starts on its own was switched on',
      text: 'A recent update changed how recipes start: a recipe now runs on its own only once it is '
        + 'switched on. This recipe had not run on its own since then, and is switched on now:'
        + '\n• Morning brief'
        + '\n\nIf it should not run on its own, open Automation and switch it off.',
    });
  });

  it('both: the switched-on ones first, then the ones that are not, and what to do with each', () => {
    expect(autoRunSwitchOnNotice(named('Daily digest'), 'https://home.example', named('Morning brief', 'Stalled projects'))).toEqual({
      title: 'An update changed how recipes start',
      text: 'A recent update changed how recipes start: a recipe now runs on its own only once it is '
        + 'switched on. These recipes had not run on their own since then, and are switched on now:'
        + '\n• Morning brief\n• Stalled projects'
        + '\n\nThis recipe starts on its own and is not switched on:\n• Daily digest'
        + '\n\nOpen Automation to switch on the ones that are not, or to switch off one that should not run on its own.',
      link_url: 'https://home.example/#automation',
    });
  });

  it('each list names ten and counts the rest', () => {
    const twelve = named(...Array.from({ length: 12 }, (_, i) => `Recipe ${String(i + 1).padStart(2, '0')}`));
    const text = autoRunSwitchOnNotice(twelve, null, twelve)!.text;
    expect(text.match(/^• Recipe \d\d$/gmu)).toHaveLength(20);
    expect(text.match(/\n• …and 2 more/gu)).toHaveLength(2);
  });

  it('never says what is not true of one the owner had paused: not "back on", "again", "were running"', () => {
    for (const on of [named('A'), named('A', 'B')]) {
      for (const off of [[], named('C')]) {
        const { title, text } = autoRunSwitchOnNotice(off, null, on)!;
        expect(`${title}\n${text}`).not.toMatch(/\b(?:was|were) running\b|\bback on\b|\bagain\b|\bpaused\b|\bran\b/iu);
      }
    }
  });
});

describe('at boot, from the re-arm\'s ledger row', () => {
  const rearmRow = (summary: unknown) =>
    createDataRepairLedger(db).record({ repair_id: AUTO_RUN_TIMER_REARM_ID, applied_at: 1, summary });

  const boot = (rows: StoredRecipe[]) => {
    const notify = vi.fn(async (_message: unknown, _channels?: unknown, _extras?: unknown): Promise<void> => undefined);
    return {
      ...sources(rows),
      ledger: createDataRepairLedger(db),
      auditLog: { logActivity: vi.fn(async (_entry: unknown): Promise<void> => undefined) },
      notifier: { notify },
      publicBaseUrl: null,
      now: () => 42,
      notify,
    };
  };

  it('waits, recording nothing, until the re-arm has recorded its row; then names what it switched on', async () => {
    dishOf('brief');
    const rows = [stored(onTimer('brief', 'Morning brief')), stored(onTimer('digest', 'Daily digest'))];
    // The re-arm failed on this boot (or has not run): its row is absent.
    const early = boot(rows);
    expect(await noticeAutoRunSwitchOnAtBoot(early)).toEqual({ outcome: 'waiting', named: 0, switched_on: 0 });
    expect(early.ledger.get(AUTO_RUN_SWITCH_ON_NOTICE_ID)).toBeNull();
    expect(early.auditLog.logActivity).not.toHaveBeenCalled();
    expect(early.notify).not.toHaveBeenCalled();

    // The next boot's re-arm switches the brief on; the notice now names it.
    rearmRow({
      path: 'recovered',
      rearmed: [{ recipe_id: 'brief', dish_id: 'dsh_b', name: 'Morning brief' }],
      kept_off: [], tripped: [], left: [],
    });
    const next = boot(rows);
    expect(await noticeAutoRunSwitchOnAtBoot(next)).toEqual({ outcome: 'noticed', named: 1, switched_on: 1 });
    expect(next.notify.mock.calls[0]![0]).toMatchObject({
      title: 'An update changed how recipes start',
      text: expect.stringContaining('switched on now:\n• Morning brief\n\nThis recipe starts on its own and is not switched on:\n• Daily digest'),
    });
  });

  it('names what the recovery path switched on — sorted by name — and records it', async () => {
    dishOf('stalled');
    dishOf('brief');
    rearmRow({
      path: 'recovered',
      rearmed: [
        { recipe_id: 'stalled', dish_id: 'dsh_s', name: 'Stalled projects' },
        { recipe_id: 'brief', dish_id: 'dsh_b', name: 'Morning brief' },
      ],
      kept_off: [], tripped: [], left: [],
    });
    const d = boot([stored(onTimer('brief', 'Morning brief')), stored(onTimer('stalled', 'Stalled projects'))]);
    expect(await noticeAutoRunSwitchOnAtBoot(d)).toEqual({ outcome: 'noticed', named: 0, switched_on: 2 });
    expect(d.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '2 recipes that start on their own were switched on',
        text: expect.stringContaining(':\n• Morning brief\n• Stalled projects\n\n'),
      }),
      undefined,
      expect.anything(),
    );
    expect(d.ledger.get(AUTO_RUN_SWITCH_ON_NOTICE_ID)?.summary).toEqual({
      not_switched_on: [],
      switched_on: [{ recipe_id: 'brief', name: 'Morning brief' }, { recipe_id: 'stalled', name: 'Stalled projects' }],
    });
  });

  for (const path of ['converted', 'nothing'] as const) {
    it(`the ${path} path took nothing as running: nothing is named as switched on`, async () => {
      dishOf('brief');
      rearmRow({
        path, rearmed: [{ recipe_id: 'brief', dish_id: 'dsh_b', name: 'Morning brief' }], kept_off: [], tripped: [], left: [],
      });
      const d = boot([stored(onTimer('brief', 'Morning brief')), stored(onTimer('digest', 'Daily digest'))]);
      expect(await noticeAutoRunSwitchOnAtBoot(d)).toEqual({ outcome: 'noticed', named: 1, switched_on: 0 });
      expect(d.notify.mock.calls[0]![0]).toMatchObject({ title: '1 recipe that starts on its own is not switched on' });
      expect(JSON.stringify(d.notify.mock.calls[0]![0])).not.toContain('Morning brief');
    });
  }

  it('over the real repair: the recipe it switched on and the one with no dish, in one notice', async () => {
    dishOf('brief');
    const rows = [stored(onTimer('brief', 'Morning brief')), stored(onTimer('digest', 'Daily digest'))];
    // No old tables here: this server ran 26.9.30, so the repair takes the brief as running.
    expect(rearmAutoRunTimers({
      db, ledger: createDataRepairLedger(db), recipeStore: { listStored: () => rows }, dishStore: dishes, now: () => 1,
    }).summary.path).toBe('recovered');
    const d = boot(rows);
    expect(await noticeAutoRunSwitchOnAtBoot(d)).toEqual({ outcome: 'noticed', named: 1, switched_on: 1 });
    expect(d.notify.mock.calls[0]![0]).toMatchObject({
      title: 'An update changed how recipes start',
      text: expect.stringMatching(/switched on now:\n• Morning brief\n\nThis recipe starts on its own and is not switched on:\n• Daily digest\n/u),
    });
  });
});
