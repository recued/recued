/** D-320 §4 — the Connection line (`connection-lines.ts`): in the dish form
 *  (`config-editor-overlay.ts`) and the run dialog (`run-modal/`).
 *
 *  Shown only where there is a choice (two or more connections on the pack's
 *  list for a slot), it starts where the dish stands: its choice, else an old
 *  connection setting, else the pack's default. A dish saves a line the owner
 *  moved or one that was pinned; a run sends only the lines it moved. */

import { describe, expect, it, vi } from 'vitest';

import {
  CRON_PRESETS,
  type Dish,
  type RecipeDefinition,
  type ServerExecuteResponse,
  type ServerRecipeListEntry,
} from '@recued/contracts';

import {
  connectionLines,
  connectionSettings,
  dishChoiceFromLines,
  runChoiceFromLines,
  type ConnectionLineSlot,
} from '../connection-lines.js';
import { wireConfigEditorOverlay } from '../config-editor-overlay.js';
import {
  initialRunModalState,
  renderRunModal,
  wireRunModal,
  RUN_MODAL_CONNECTION_ATTR,
  type RunModalCaps,
  type RunModalExecuteCaller,
  type RunModalState,
} from '../run-modal/index.js';

const HUBSPOT: ConnectionLineSlot = {
  slot: 'hubspot',
  variables: ['hubspot'],
  connections: [
    { connection_name: 'hubspot-app', display_name: 'Sales app', is_default: false },
    { connection_name: 'hubspot-key', display_name: 'Service Key', is_default: true },
  ],
};
/** One connection: no choice to make. */
const WISE: ConnectionLineSlot = {
  slot: 'wise',
  variables: ['wise'],
  connections: [{ connection_name: 'wise-1', display_name: 'Wise', is_default: true }],
};

describe('the lines', () => {
  it('are drawn only where there is a choice, and hide every slot\'s settings', () => {
    const lines = connectionLines([HUBSPOT, WISE], {});
    expect(lines.map((line) => line.slot)).toEqual(['hubspot']);
    expect(lines[0]).toMatchObject({
      label: 'Connection',
      selected: 'hubspot-key',
      start: 'default',
      options: [
        { value: 'hubspot-app', label: 'Sales app' },
        { value: 'hubspot-key', label: 'Service Key (default)' },
      ],
    });
    expect([...connectionSettings([HUBSPOT, WISE])]).toEqual(['hubspot', 'wise']);
  });

  it("start on the dish's choice, else its old setting, else the default", () => {
    expect(connectionLines([HUBSPOT], { chosen: { hubspot: 'hubspot-app' } })[0]).toMatchObject({ selected: 'hubspot-app', start: 'chosen' });
    expect(connectionLines([HUBSPOT], { settings: { hubspot: 'hubspot-app' } })[0]).toMatchObject({ selected: 'hubspot-app', start: 'setting' });
    // A setting off the list is offered as it is, so leaving it alone keeps it.
    const stale = connectionLines([HUBSPOT], { settings: { hubspot: 'old-portal' } })[0]!;
    expect(stale).toMatchObject({ selected: 'old-portal', start: 'stale' });
    expect(stale.options.at(-1)).toEqual({ value: 'old-portal', label: "old-portal (not on the pack's list)", stale: true });
  });

  it('ask for one where the list has no default', () => {
    const noDefault = { ...HUBSPOT, connections: HUBSPOT.connections.map((c) => ({ ...c, is_default: false })) };
    const line = connectionLines([noDefault], {})[0]!;
    expect(line).toMatchObject({ selected: '', start: 'none' });
    expect(line.options[0]).toEqual({ value: '', label: 'Choose one' });
  });
});

describe('what a dish saves', () => {
  it('nothing for a line left on the default, so the dish follows it', () => {
    expect(dishChoiceFromLines(connectionLines([HUBSPOT], {}), {})).toEqual({ connections: {}, dropSettings: [] });
  });

  it('a moved line, and the settings it stands in for go', () => {
    expect(dishChoiceFromLines(connectionLines([HUBSPOT], {}), { hubspot: 'hubspot-app' }))
      .toEqual({ connections: { hubspot: 'hubspot-app' }, dropSettings: ['hubspot'] });
  });

  it('a pinned line, even on the default: it was chosen, and stays chosen', () => {
    expect(dishChoiceFromLines(connectionLines([HUBSPOT], { chosen: { hubspot: 'hubspot-key' } }), {}))
      .toEqual({ connections: { hubspot: 'hubspot-key' }, dropSettings: ['hubspot'] });
    // An old setting becomes the choice it always was.
    expect(dishChoiceFromLines(connectionLines([HUBSPOT], { settings: { hubspot: 'hubspot-key' } }), {}))
      .toEqual({ connections: { hubspot: 'hubspot-key' }, dropSettings: ['hubspot'] });
  });

  it('nothing for a stale setting left alone: it stays the setting it was', () => {
    expect(dishChoiceFromLines(connectionLines([HUBSPOT], { settings: { hubspot: 'old-portal' } }), {}))
      .toEqual({ connections: {}, dropSettings: [] });
  });
});

describe('what a run sends', () => {
  it('only the lines it moved, and never a stale value', () => {
    const lines = connectionLines([HUBSPOT], { chosen: { hubspot: 'hubspot-app' } });
    expect(runChoiceFromLines(lines, {})).toEqual({});
    expect(runChoiceFromLines(lines, { hubspot: 'hubspot-app' })).toEqual({});
    expect(runChoiceFromLines(lines, { hubspot: 'hubspot-key' })).toEqual({ hubspot: 'hubspot-key' });
    const stale = connectionLines([HUBSPOT], { settings: { hubspot: 'old-portal' } });
    expect(runChoiceFromLines(stale, { hubspot: 'old-portal' })).toEqual({});
  });
});

// ── the dish form ──────────────────────────────────────────────────

/** A fake document whose elements keep their listeners, so Save can be clicked
 *  (`config-editor-overlay.test.ts`'s harness, trimmed). */
const overlayDoc = () => {
  const make = () => {
    const listeners = new Map<string, Array<(event: Event) => void>>();
    const el = {
      className: '', innerHTML: '', textContent: '', removed: false, listeners, attrs: new Map<string, string>(),
      setAttribute: (k: string, v: string) => el.attrs.set(k, v),
      getAttribute: (k: string) => el.attrs.get(k) ?? null,
      appendChild: (c: unknown) => c,
      addEventListener: (type: string, fn: (event: Event) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
      removeEventListener: () => undefined,
      remove: () => { el.removed = true; },
    };
    return el;
  };
  return {
    body: make(),
    head: { querySelector: () => null, appendChild: (c: unknown) => c },
    createElement: () => make(),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    activeElement: null,
  } as unknown as Document;
};

const clickSave = (element: HTMLElement): void => {
  const listeners = (element as unknown as { listeners: Map<string, Array<(event: Event) => void>> }).listeners;
  for (const listener of listeners.get('click') ?? []) {
    listener({ target: { closest: () => ({ getAttribute: () => 'confirm' }) } } as unknown as Event);
  }
};

describe('the dish form', () => {
  const variables = {
    hubspot: { label: 'HubSpot connection', type: 'connection' },
  } as unknown as Parameters<typeof wireConfigEditorOverlay>[0]['variables'];

  it('shows the line, not the setting, and does not ask for the setting', () => {
    const onConfirm = vi.fn();
    const handle = wireConfigEditorOverlay({
      document: overlayDoc(),
      title: 'Switch on',
      confirmLabel: 'Switch on',
      variables,
      currentOverlay: {},
      requireSettings: true,
      connections: { lines: connectionLines([HUBSPOT], {}), hidden: connectionSettings([HUBSPOT]) },
      onConfirm,
    });
    const html = handle.element.innerHTML;
    expect(html).toContain('data-recued-config-editor-connection="hubspot"');
    expect(html).toContain('<option value="hubspot-key" selected>Service Key (default)</option>');
    expect(html).not.toContain('HubSpot connection');
    // The empty connection setting does not stop it: the pack holds the connection.
    clickSave(handle.element);
    expect(onConfirm).toHaveBeenCalledWith({}, { connections: { hubspot: 'hubspot-key' } });
  });

  it('without lines, asks for the connection setting as before', () => {
    const onConfirm = vi.fn();
    const handle = wireConfigEditorOverlay({
      document: overlayDoc(),
      title: 'Switch on',
      confirmLabel: 'Switch on',
      variables,
      currentOverlay: {},
      requireSettings: true,
      onConfirm,
    });
    expect(handle.element.innerHTML).toContain('HubSpot connection');
    clickSave(handle.element);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

// ── the run dialog ─────────────────────────────────────────────────

const recipeEntry = (): ServerRecipeListEntry => ({
  recipe_id: 'read-the-deal',
  publisher_id: 'recued-core',
  recipe: {
    recipe_id: 'read-the-deal',
    version: 1,
    ttl: 0,
    metadata: { name: 'Read the deal', description: 'One read.', author: 'recued-core', supported_platforms: [], tags: [] },
    variables: { hubspot: { label: 'HubSpot connection', type: 'connection' } },
    prefetch_steps: [],
    steps: [],
    output: { sidebar: [] },
  } as unknown as RecipeDefinition,
} as unknown as ServerRecipeListEntry);

const dish = (dish_id: string, is_default: boolean, over: Partial<Dish> = {}): Dish => ({
  dish_id,
  recipe_id: 'read-the-deal',
  publisher_id: 'recued-core',
  name: is_default ? '' : 'Other',
  is_default,
  config_overlay: {},
  enabled: true,
  created_at: is_default ? 1 : 2,
  ...over,
});

const CAPS: RunModalCaps = { canExecute: true, canSchedule: false, canTrigger: false };

const stateWith = (over: Partial<RunModalState> = {}): RunModalState => ({
  ...initialRunModalState('run', CRON_PRESETS[0]?.expression ?? '0 9 * * *'),
  ...over,
});

const runDoc = () => {
  const make = (tag: string) => {
    const el = {
      tagName: tag.toUpperCase(), className: '', textContent: '', innerHTML: '', attrs: new Map<string, string>(),
      removed: false,
      setAttribute: (k: string, v: string) => el.attrs.set(k, v),
      getAttribute: (k: string) => el.attrs.get(k) ?? null,
      hasAttribute: (k: string) => el.attrs.has(k),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      appendChild: (c: unknown) => c,
      remove: () => { el.removed = true; },
    };
    return el;
  };
  return {
    head: { querySelector: () => null, appendChild: (c: unknown) => c },
    createElement: (tag: string) => make(tag),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Document;
};

const ran = (): ServerExecuteResponse => ({ success: true, recipe_id: 'read-the-deal', steps: [], errors: [], output: { render: [] }, duration_ms: 1 } as unknown as ServerExecuteResponse);

describe('the run dialog', () => {
  it('draws the line from the dish it runs as, in place of the setting', () => {
    const html = renderRunModal(
      stateWith({ connection_slots: [HUBSPOT], dish_id: 'dsh_main' }),
      recipeEntry(),
      CAPS,
      [dish('dsh_main', true, { connections: { hubspot: 'hubspot-app' } })],
    );
    expect(html).toContain(`${RUN_MODAL_CONNECTION_ATTR}="hubspot"`);
    expect(html).toContain('<option value="hubspot-app" selected>Sales app</option>');
    expect(html).not.toContain('HubSpot connection');
  });

  it('sends the line it moved, this run only, and nothing when left alone', async () => {
    const execute = vi.fn(async (_args: Parameters<RunModalExecuteCaller>[0]) => ran());
    const handle = wireRunModal({
      document: runDoc(),
      recipe: recipeEntry(),
      dishes: [dish('dsh_main', true)],
      execute,
      connectionSlots: async () => ({ slots: [HUBSPOT] }),
    });
    await vi.waitFor(() => expect(handle.getState().connection_slots).toEqual([HUBSPOT]));
    await handle.confirmRun();
    expect(execute.mock.calls[0]![0]).not.toHaveProperty('connections');
    handle.setConnection('hubspot', 'hubspot-app');
    await handle.confirmRun();
    expect(execute.mock.calls[1]![0]).toMatchObject({ dish_id: 'dsh_main', connections: { hubspot: 'hubspot-app' } });
  });

  it('starts again from the dish picked', async () => {
    const handle = wireRunModal({
      document: runDoc(),
      recipe: recipeEntry(),
      dishes: [dish('dsh_main', true), dish('dsh_other', false, { connections: { hubspot: 'hubspot-app' } })],
      execute: vi.fn(async (_args: Parameters<RunModalExecuteCaller>[0]) => ran()),
      connectionSlots: async () => ({ slots: [HUBSPOT] }),
    });
    await vi.waitFor(() => expect(handle.getState().connection_slots).not.toBeNull());
    handle.setConnection('hubspot', 'hubspot-app');
    handle.setDish('dsh_other');
    expect(handle.getState().connection_choice).toEqual({});
  });

  it('opens without lines when the slots cannot be read', async () => {
    const execute = vi.fn(async (_args: Parameters<RunModalExecuteCaller>[0]) => ran());
    const handle = wireRunModal({
      document: runDoc(),
      recipe: recipeEntry(),
      execute,
      connectionSlots: async () => { throw new Error('unknown_method'); },
    });
    await Promise.resolve();
    await handle.confirmRun();
    expect(handle.getState().connection_slots).toBeNull();
    expect(execute.mock.calls[0]![0]).not.toHaveProperty('connections');
  });
});
