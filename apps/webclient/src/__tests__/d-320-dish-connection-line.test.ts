/** D-320 §4 — the dish form's Connection line (`recipes/dish-form.ts`), and what
 *  a dish's Save sends.
 *
 *  The form itself is the shared settings form; what it is given and what the
 *  dish form makes of its answer are the dish form's. So the shared form is
 *  stood in for here, to read the options it is handed and to answer as the owner
 *  would: the line left alone, or moved. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Dish, ServerRecipeListEntry } from '@recued/contracts';
import type { ConnectionLineSlot } from '@recued/ui-shared';

type OverlayOptions = {
  variables: Record<string, unknown>;
  connections?: { lines: ReadonlyArray<{ slot: string; selected: string }>; hidden: ReadonlySet<string> };
  onConfirm: (config: Record<string, unknown>, extras: Record<string, unknown>) => void | Promise<void>;
};

const captured: OverlayOptions[] = [];
vi.mock('@recued/ui-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recued/ui-shared')>();
  return {
    ...actual,
    wireConfigEditorOverlay: (opts: OverlayOptions) => {
      captured.push(opts);
      return { element: {} as HTMLElement, hasInFlightWork: () => false, destroy: () => undefined };
    },
  };
});

const { openDishForm } = await import('../recipes/dish-form.js');
const { runMustBeGiven } = await import('../recipes/bootstrap-recipes-route.js');

const HUBSPOT: ConnectionLineSlot = {
  slot: 'hubspot',
  variables: ['hubspot'],
  connections: [
    { connection_name: 'hubspot-app', display_name: 'Sales app', is_default: false },
    { connection_name: 'hubspot-key', display_name: 'Service Key', is_default: true },
  ],
};
/** One connection on the list: no line, its setting still left out. */
const WISE: ConnectionLineSlot = {
  slot: 'wise',
  variables: ['wise'],
  connections: [{ connection_name: 'wise-1', display_name: 'Wise', is_default: true }],
};

const entry = {
  recipe_id: 'read-the-deal',
  publisher_id: 'recued-core',
  recipe: {
    recipe_id: 'read-the-deal',
    metadata: { name: 'Read the deal' },
    variables: {
      hubspot: { label: 'HubSpot connection', type: 'connection' },
      wise: { label: 'Wise connection', type: 'connection' },
      note: { label: 'Note', type: 'string', optional: true },
    },
    steps: [],
  },
} as unknown as ServerRecipeListEntry;

const dish = (over: Partial<Dish> = {}): Dish => ({
  dish_id: 'dsh_main',
  recipe_id: 'read-the-deal',
  publisher_id: 'recued-core',
  name: '',
  is_default: true,
  config_overlay: { note: 'x' },
  enabled: true,
  created_at: 1,
  ...over,
});

const open = (args: {
  mode: 'settings' | 'switch-on';
  dish?: Dish;
  start: Record<string, unknown>;
  slots?: ReadonlyArray<ConnectionLineSlot>;
}) => {
  const update = vi.fn(async (_args: Record<string, unknown>) => ({ dish: args.dish ?? dish() }));
  const create = vi.fn(async (_args: Record<string, unknown>) => ({ dish: dish() }));
  openDishForm({
    document: {} as Document,
    mode: args.mode,
    entry,
    dishes: args.dish !== undefined ? [args.dish] : [],
    ...(args.dish !== undefined ? { dish: args.dish } : {}),
    start: args.start,
    callers: { update, create },
    ...(args.slots !== undefined ? { connectionSlots: args.slots } : {}),
    onClose: () => undefined,
  });
  return { update, create, options: captured.at(-1)! };
};

beforeEach(() => {
  captured.length = 0;
});

describe("D-320 — the dish form's Connection line", () => {
  it('draws a line where there is a choice and leaves every connection setting out', () => {
    const { options } = open({ mode: 'settings', dish: dish(), start: { note: 'x' }, slots: [HUBSPOT, WISE] });
    expect(options.connections?.lines.map((line) => [line.slot, line.selected])).toEqual([['hubspot', 'hubspot-key']]);
    expect([...(options.connections?.hidden ?? [])]).toEqual(['hubspot', 'wise']);
  });

  it('saves a moved line on the dish, and drops the setting it stands in for', async () => {
    const start = { note: 'x', hubspot: 'hubspot-key' };
    const { options, update } = open({ mode: 'settings', dish: dish({ config_overlay: start }), start, slots: [HUBSPOT] });
    await options.onConfirm({ ...start }, { connections: { hubspot: 'hubspot-app' } });
    expect(update).toHaveBeenCalledWith({
      dish_id: 'dsh_main',
      config_overlay: { note: 'x' },
      connections: { hubspot: 'hubspot-app' },
    });
  });

  it('clears no choice it could not show, and keeps one for a slot without a line', async () => {
    const pinned = dish({ connections: { wise: 'wise-old' } });
    const { options, update } = open({ mode: 'settings', dish: pinned, start: { note: 'x' }, slots: [HUBSPOT, WISE] });
    await options.onConfirm({ note: 'x' }, { connections: { hubspot: 'hubspot-key' } });
    expect(update).toHaveBeenCalledWith({ dish_id: 'dsh_main', config_overlay: { note: 'x' }, connections: { wise: 'wise-old' } });
  });

  it('sends no choice at all when the slots could not be read, so it clears none', async () => {
    const pinned = dish({ connections: { hubspot: 'hubspot-app' } });
    const { options, update } = open({ mode: 'settings', dish: pinned, start: { note: 'x' } });
    expect(options.connections).toBeUndefined();
    await options.onConfirm({ note: 'x' }, {});
    expect(update.mock.calls[0]![0]).not.toHaveProperty('connections');
  });

  it('clears the choice when the line goes back to following the default', async () => {
    // Nothing chosen and the default left alone: the dish follows the default.
    const { options, update } = open({ mode: 'settings', dish: dish(), start: { note: 'x' }, slots: [HUBSPOT] });
    await options.onConfirm({ note: 'x' }, { connections: { hubspot: 'hubspot-key' } });
    expect(update).toHaveBeenCalledWith({ dish_id: 'dsh_main', config_overlay: { note: 'x' }, connections: null });
  });

  it('a first dish is made with its moved line', async () => {
    const { options, create } = open({ mode: 'switch-on', start: {}, slots: [HUBSPOT] });
    await options.onConfirm({}, { connections: { hubspot: 'hubspot-app' } });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ connections: { hubspot: 'hubspot-app' } }));
  });
});

describe('D-320 — "Run once as this" never waits on a connection setting', () => {
  it('a connection setting is not a value a run has to be given', () => {
    expect(runMustBeGiven({ label: 'HubSpot', type: 'connection' } as never)).toBe(false);
    expect(runMustBeGiven({ label: 'Deal', type: 'string' } as never)).toBe(true);
  });
});
