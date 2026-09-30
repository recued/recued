/** D-319 — one dish, said as a line: what tells it apart, what starts it,
 *  when it runs next, and its status. */

import { describe, expect, it } from 'vitest';

import type {
  AutoRunStatusEntry,
  Dish,
  EventTrigger,
  ServerSchedule,
  VariableDefault,
} from '@recued/contracts';

import {
  dishLineName,
  dishNextRun,
  dishStartsLine,
  dishStatus,
  rowsOfDish,
  settingsThatTellApart,
  type DishRows,
} from '../dish-line.js';
import { startPhrase, whatStartsIt } from '../dish-lead.js';

const dish = (over: Partial<Dish> = {}): Dish => ({
  dish_id: 'dsh_work',
  recipe_id: 'parcels',
  publisher_id: 'recued-core',
  name: '',
  is_default: true,
  config_overlay: {},
  enabled: true,
  created_at: 1,
  ...over,
});

const trigger = (over: Partial<EventTrigger> = {}): EventTrigger => ({
  trigger_id: 'trg_1',
  recipe_id: 'parcels',
  publisher_id: 'recued-core',
  pattern: 'data.mail.**.created',
  enabled: true,
  created_at: 1,
  last_fired_at: null,
  last_error: null,
  origin: 'recipe',
  dish_id: 'dsh_work',
  ...over,
} as EventTrigger);

const schedule = (over: Partial<ServerSchedule> = {}): ServerSchedule => ({
  schedule_id: 'sch_1',
  recipe_id: 'parcels',
  publisher_id: 'recued-core',
  cron_expression: '0 9 * * 1-5',
  enabled: true,
  created_at: 1,
  last_run_at: null,
  next_run_at: 5_000,
  last_status: null,
  last_error: null,
  dish_id: 'dsh_work',
  ...over,
});

const timer = (over: Partial<AutoRunStatusEntry> = {}): AutoRunStatusEntry => ({
  recipe_id: 'parcels',
  publisher_id: 'recued-core',
  dish_id: 'dsh_work',
  dish_name: '',
  recipe_name: 'Parcels',
  interval_ms: 900_000,
  dynamic: false,
  enabled: true,
  config_overlay: {},
  variables: {},
  auto_disabled: false,
  consecutive_failures: 0,
  last_failure_at: null,
  last_failure_reason: null,
  next_run_at: 3_000,
  last_started_at: null,
  last_finished_at: null,
  ...over,
});

const none: DishRows = { triggers: [], schedules: [] };

describe('dishStatus', () => {
  it('Off is the owner’s switch, whatever its rows say', () => {
    expect(dishStatus(dish({ enabled: false }), { ...none, triggers: [trigger({ last_error: 'x' })] }, undefined))
      .toEqual({ kind: 'off' });
  });

  it('a row the server stopped leaves the dish On and says it is Failing, with the reason — stopped', () => {
    expect(dishStatus(dish(), { ...none, triggers: [trigger({ enabled: false, last_error: 'Slack refused the connection' })] }, undefined))
      .toEqual({ kind: 'failing', reason: 'Slack refused the connection', stopped: true });
    expect(dishStatus(dish(), { ...none, timer: timer({ auto_disabled: true, last_failure_reason: 'No key' }) }, undefined))
      .toEqual({ kind: 'failing', reason: 'No key', stopped: true });
    expect(dishStatus(dish(), { ...none, schedules: [schedule({ enabled: false, consecutive_failures: 3, last_error: 'Gone' })] }, undefined))
      .toEqual({ kind: 'failing', reason: 'Gone', stopped: true });
  });

  it('a row whose last fire failed is Failing, not stopped; a stopped row outranks it; a paused row with no failure is not Failing', () => {
    expect(dishStatus(dish(), { ...none, triggers: [trigger({ last_error: 'Timed out' })] }, undefined))
      .toEqual({ kind: 'failing', reason: 'Timed out', stopped: false });
    expect(dishStatus(dish(), { ...none, schedules: [schedule({ last_status: 'error', last_error: null })] }, undefined))
      .toEqual({ kind: 'failing', reason: 'Its last run failed.', stopped: false });
    expect(dishStatus(dish(), {
      ...none,
      triggers: [trigger({ last_error: 'Timed out' }), trigger({ trigger_id: 't2', enabled: false, last_error: 'Refused' })],
    }, undefined)).toEqual({ kind: 'failing', reason: 'Refused', stopped: true });
    expect(dishStatus(dish(), { ...none, triggers: [trigger({ enabled: false })] }, undefined)).toEqual({ kind: 'on' });
  });

  it('a run held for approval is Waiting for you; a failed last run is Failing; else On', () => {
    expect(dishStatus(dish(), none, { run_id: 'r', started_at: 1, commit_status: 'awaiting_approval' })).toEqual({ kind: 'waiting' });
    expect(dishStatus(dish(), none, { run_id: 'r', started_at: 1, commit_status: 'failed' }))
      .toEqual({ kind: 'failing', reason: 'Its last run failed.', stopped: false });
    expect(dishStatus(dish(), none, { run_id: 'r', started_at: 1, commit_status: 'succeeded' })).toEqual({ kind: 'on' });
    expect(dishStatus(dish(), none, undefined)).toEqual({ kind: 'on' });
  });
});

describe('rowsOfDish and dishNextRun', () => {
  it('takes only the dish’s own rows', () => {
    const rows = rowsOfDish('dsh_work', {
      triggers: [trigger(), trigger({ trigger_id: 'trg_2', dish_id: 'dsh_home' })],
      schedules: [schedule(), schedule({ schedule_id: 'sch_2', dish_id: 'dsh_home' })],
      autoRun: [timer({ dish_id: 'dsh_home' }), timer()],
    });
    expect(rows.triggers.map((row) => row.trigger_id)).toEqual(['trg_1']);
    expect(rows.schedules.map((row) => row.schedule_id)).toEqual(['sch_1']);
    expect(rows.timer?.dish_id).toBe('dsh_work');
  });

  it('is the soonest of its schedules and its timer that are on; nothing when the dish is off', () => {
    expect(dishNextRun(dish(), { triggers: [], schedules: [schedule()], timer: timer() })).toBe(3_000);
    expect(dishNextRun(dish(), { triggers: [], schedules: [schedule()], timer: timer({ enabled: false }) })).toBe(5_000);
    expect(dishNextRun(dish(), { triggers: [], schedules: [schedule({ enabled: false })], timer: timer({ auto_disabled: true }) })).toBeNull();
    expect(dishNextRun(dish({ enabled: false }), { triggers: [], schedules: [schedule()] })).toBeNull();
  });
});

describe('dishStartsLine', () => {
  const watcher = { event_triggers: [{ on: 'mail_fact.shipment', fields: ['state'] }] } as never;

  it('says the recipe’s own start and the dish’s schedules', () => {
    expect(dishStartsLine(watcher, [])).toBe('Starts when a shipment’s state changes');
    expect(dishStartsLine(watcher, [schedule()])).toBe('Starts when a shipment’s state changes and weekdays at 9:00 AM');
  });

  it('a recipe that starts on nothing of its own runs on its schedules, or when the owner runs it', () => {
    expect(dishStartsLine({}, [])).toBe('Runs when you run it');
    expect(dishStartsLine({}, [schedule(), schedule({ schedule_id: 'b', cron_expression: '0 9 * * 1-5' })]))
      .toBe('Runs weekdays at 9:00 AM');
    expect(dishStartsLine({ auto_run: { interval_ms: 900_000 } }, [])).toBe('Runs every 15 minutes');
  });

  it('the phrase and the sentence say the same thing', () => {
    expect(whatStartsIt(watcher)).toBe(`It ${startPhrase(watcher)}.`);
  });
});

describe('settingsThatTellApart', () => {
  const variables = {
    channel: { label: 'Slack channel', type: 'text', default: '#ops' },
    template: { label: 'Mail template', type: 'mail_template' },
    token: { label: 'Token', type: 'secret' },
    limit: 10,
  } as unknown as Record<string, VariableDefault>;

  it('with several dishes, shows only the settings whose values differ', () => {
    const work = dish({ config_overlay: { channel: '#ops', limit: 10 } });
    const home = dish({ dish_id: 'dsh_home', is_default: false, name: 'Home', config_overlay: { channel: '#home' } });
    const shown = settingsThatTellApart(variables, [work, home]);
    expect(shown.get('dsh_work')).toEqual([{ key: 'channel', label: 'Slack channel', text: '#ops' }]);
    expect(shown.get('dsh_home')).toEqual([{ key: 'channel', label: 'Slack channel', text: '#home' }]);
  });

  it('with one dish, its first few settings that show a value — never a secret', () => {
    const shown = settingsThatTellApart(variables, [dish({ config_overlay: { token: 'sk-live-123' } })]);
    expect(shown.get('dsh_work')).toEqual([
      { key: 'channel', label: 'Slack channel', text: '#ops' },
      { key: 'limit', label: 'Limit', text: '10' },
    ]);
  });

  it('a mail template shows by the name the host looks up', () => {
    const a = dish({ config_overlay: { template: 'mtpl_a' } });
    const b = dish({ dish_id: 'dsh_b', config_overlay: { template: 'mtpl_b' } });
    const names: Record<string, string> = { mtpl_a: 'Amazon shipments', mtpl_b: 'Shop parcels' };
    const shown = settingsThatTellApart(variables, [a, b], {
      valueText: (_key, type, value) => (type === 'mail_template' ? names[String(value)] ?? null : null),
    });
    expect(shown.get('dsh_b')).toEqual([{ key: 'template', label: 'Mail template', text: 'Shop parcels' }]);
  });
});

describe('dishLineName', () => {
  it('the only dish needs no name; among several an unnamed one is the main one', () => {
    expect(dishLineName(dish(), 1)).toBeNull();
    expect(dishLineName(dish({ name: 'Work mailbox' }), 1)).toBe('Work mailbox');
    expect(dishLineName(dish(), 2)).toBe('Main');
    expect(dishLineName(dish({ is_default: false }), 2)).toBe('Unnamed');
  });
});
