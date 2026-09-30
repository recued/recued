/** D-319 §5.1 — the recipe page's "Running as" section, as markup: one line
 *  per dish with its switch, Settings and menu; Switch on / Save settings
 *  when there is none; "+ Add another" once there is one. */

import { describe, expect, it } from 'vitest';

import type { AutoRunStatusEntry, Dish, EventTrigger, ServerSchedule } from '@recued/contracts';

import {
  RUNNING_AS_ACTION_ATTR,
  RUNNING_AS_DISH_ATTR,
  RUNNING_AS_STATUS_ATTR,
  renderRunningAs,
  startsOnItsOwn,
  type RunningAsView,
} from '../recipes/running-as.js';

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

const watcher = {
  variables: { channel: { label: 'Slack channel', type: 'text', default: '#ops' } },
  event_triggers: [{ on: 'mail_fact.shipment', fields: ['state'] }],
} as unknown as RunningAsView['recipe'];

const view = (over: Partial<RunningAsView> = {}): RunningAsView => ({
  recipe_id: 'parcels',
  recipe_name: 'Shop parcels watch',
  recipe: watcher,
  dishes: [],
  lastRuns: {},
  schedules: [],
  triggers: [],
  autoRun: [],
  can: { create: true, update: true, remove: true, run: true, schedule: true },
  busy: new Set(),
  openMenu: null,
  confirmingRemove: null,
  errors: new Map(),
  ...over,
});

const action = (name: string, dish_id?: string): string =>
  dish_id === undefined
    ? `${RUNNING_AS_ACTION_ATTR}="${name}"`
    : `${RUNNING_AS_ACTION_ATTR}="${name}" ${RUNNING_AS_DISH_ATTR}="${dish_id}"`;

describe('with no dish', () => {
  it('a recipe that starts on its own says so and offers Switch on', () => {
    const html = renderRunningAs(view());
    expect(html).toContain('Running as');
    expect(html).toContain('Not switched on. It starts when a shipment’s state changes.');
    expect(html).toContain(action('switch-on'));
    expect(html).not.toContain(action('add'));
  });

  it('a manual recipe offers Save settings — only when it has settings to save', () => {
    const manual = { variables: { note: { label: 'Note', type: 'text' } } } as unknown as RunningAsView['recipe'];
    expect(startsOnItsOwn(manual)).toBe(false);
    const html = renderRunningAs(view({ recipe: manual }));
    expect(html).toContain('No saved settings');
    expect(html).toContain(action('save-settings'));
    expect(html).not.toContain(action('switch-on'));
    expect(renderRunningAs(view({ recipe: { variables: {} } as RunningAsView['recipe'] }))).not.toContain(action('save-settings'));
  });

  it('says nothing when the dishes could not be read', () => {
    expect(renderRunningAs(view({ dishes: null }))).toBe('');
  });

  it('a host that cannot create offers no dead Switch on', () => {
    const html = renderRunningAs(view({ can: { create: false, update: true, remove: true, run: true, schedule: true } }));
    expect(html).toContain('Not switched on');
    expect(html).not.toContain(action('switch-on'));
  });
});

describe('one line per dish', () => {
  it('the only dish: no name to invent, its settings, what starts it, its switch, Settings and a menu', () => {
    const html = renderRunningAs(view({ dishes: [dish({ config_overlay: { channel: '#ops' } })] }));
    expect(html).not.toContain('running-as-name');
    expect(html).toContain('Slack channel: #ops');
    expect(html).toContain('Starts when a shipment’s state changes');
    expect(html).toContain(`${action('toggle-off', 'dsh_work')}`);
    expect(html).toContain('role="switch" aria-checked="true" aria-label="Shop parcels watch"');
    expect(html).toContain(action('settings', 'dsh_work'));
    expect(html).toContain(action('menu', 'dsh_work'));
    expect(html).toContain(action('add'));
    expect(html).toContain('Never run');
  });

  it('two dishes: each named, the main one first and marked, each showing the setting that differs', () => {
    const html = renderRunningAs(view({
      dishes: [
        dish({ dish_id: 'dsh_home', is_default: false, name: 'Home mailbox', created_at: 2, config_overlay: { channel: '#home' } }),
        dish({ config_overlay: { channel: '#ops' } }),
      ],
    }));
    expect(html.indexOf('dsh_work')).toBeLessThan(html.indexOf('dsh_home'));
    expect(html).toContain('<span class="running-as-name">Main</span>');
    expect(html).toContain('<span class="running-as-name">Home mailbox</span>');
    expect(html).toContain('Slack channel: #ops');
    expect(html).toContain('Slack channel: #home');
  });

  it('an off dish offers to switch on; its schedule adds to what starts it; next run is its soonest', () => {
    const schedule = {
      schedule_id: 'sch_1', recipe_id: 'parcels', publisher_id: 'recued-core', cron_expression: '0 9 * * 1-5',
      enabled: true, created_at: 1, last_run_at: null, next_run_at: Date.UTC(2026, 9, 5, 9), last_status: null,
      last_error: null, dish_id: 'dsh_work',
    } as ServerSchedule;
    const on = renderRunningAs(view({ dishes: [dish()], schedules: [schedule] }));
    expect(on).toContain('Starts when a shipment’s state changes and weekdays at 9:00 AM');
    expect(on).toContain('next ');
    const off = renderRunningAs(view({ dishes: [dish({ enabled: false })], schedules: [schedule] }));
    expect(off).toContain(action('toggle-on', 'dsh_work'));
    expect(off).toContain(`${RUNNING_AS_STATUS_ATTR}="off"`);
    expect(off).not.toContain('next ');
  });

  it('a dish whose trigger the server stopped is On and Failing, with the reason and where to see why', () => {
    const trigger = {
      trigger_id: 't', recipe_id: 'parcels', publisher_id: 'recued-core', pattern: 'x', enabled: false,
      created_at: 1, last_fired_at: 2, last_error: 'Slack refused the connection', origin: 'recipe', dish_id: 'dsh_work',
    } as EventTrigger;
    const html = renderRunningAs(view({ dishes: [dish()], triggers: [trigger], failureHref: '#automation/parcels' }));
    expect(html).toContain(`${RUNNING_AS_STATUS_ATTR}="failing"`);
    expect(html).toContain('Failing');
    expect(html).toContain('Slack refused the connection');
    expect(html).toContain('href="#automation/parcels"');
    expect(html).toContain('role="switch" aria-checked="true"');
    // Stopped by the server: switching it on again restarts it.
    expect(html).toContain(action('rearm', 'dsh_work'));
    expect(html).toContain('Start again');
  });

  it('a dish whose last run failed is Failing but not stopped: nothing to restart', () => {
    const html = renderRunningAs(view({
      dishes: [dish()],
      lastRuns: { dsh_work: { run_id: 'r1', started_at: Date.UTC(2026, 8, 29, 9, 12), commit_status: 'failed' } },
    }));
    expect(html).toContain(`${RUNNING_AS_STATUS_ATTR}="failing"`);
    expect(html).toContain('Its last run failed.');
    expect(html).not.toContain(action('rearm', 'dsh_work'));
  });

  it('a timer is the dish’s: its next run shows on the dish', () => {
    const timer = { dish_id: 'dsh_work', enabled: true, auto_disabled: false, consecutive_failures: 0, next_run_at: Date.UTC(2026, 9, 5, 9, 15) } as AutoRunStatusEntry;
    const html = renderRunningAs(view({
      recipe: { auto_run: { interval_ms: 900_000 } } as RunningAsView['recipe'],
      dishes: [dish()],
      autoRun: [timer],
    }));
    expect(html).toContain('Runs every 15 minutes');
    expect(html).toContain('next ');
  });
});

describe('the menu and removing', () => {
  it('opens with Run once as this, Add a schedule, Make this the main one and Remove — main only for a second dish', () => {
    const dishes = [dish(), dish({ dish_id: 'dsh_home', is_default: false, name: 'Home', created_at: 2 })];
    const main = renderRunningAs(view({ dishes, openMenu: 'dsh_work' }));
    expect(main).toContain('role="menu"');
    expect(main).toContain(action('run', 'dsh_work'));
    expect(main).toContain(action('schedule', 'dsh_work'));
    expect(main).not.toContain(action('make-main', 'dsh_work'));
    expect(main).toContain(action('remove', 'dsh_work'));
    const second = renderRunningAs(view({ dishes, openMenu: 'dsh_home' }));
    expect(second).toContain(action('make-main', 'dsh_home'));
    expect(renderRunningAs(view({ dishes }))).not.toContain('role="menu"');
  });

  it('Remove asks first, saying what goes with it', () => {
    const html = renderRunningAs(view({
      dishes: [dish({ name: 'Work mailbox' })],
      confirmingRemove: 'dsh_work',
    }));
    expect(html).toContain('Remove Work mailbox? Its triggers and schedules go with it.');
    expect(html).toContain(action('remove-confirm', 'dsh_work'));
    expect(html).toContain(action('remove-cancel', 'dsh_work'));
  });

  it('a dish with a change in flight is busy; its error shows on its line', () => {
    const html = renderRunningAs(view({
      dishes: [dish()],
      busy: new Set(['dsh_work']),
      errors: new Map([['dsh_work', 'Recued could not switch it off.']]),
    }));
    expect(html).toContain('Switching…');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Recued could not switch it off.');
  });

  it('a host with no callers renders the lines with no dead controls', () => {
    const html = renderRunningAs(view({
      dishes: [dish()],
      can: { create: false, update: false, remove: false, run: false, schedule: false },
    }));
    expect(html).toContain('running-as-line');
    expect(html).not.toContain(RUNNING_AS_ACTION_ATTR);
  });
});
