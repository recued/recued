/** D-282 B5 — a detail page is a place.
 *
 *  `#packs/<slug>/use/<lookup>/<record>` is bookmarkable, shareable, and a real
 *  Back step from the list. Two halves have to hold together for that to be
 *  true, and each fails in a different direction:
 *
 *   - WRITING it. A row action that opens a bound lookup runs it IN PLACE
 *     rather than through the run modal, so the address is built from the value
 *     the run actually used. Publishing from what the row ASKED for would let an
 *     edited modal put a URL on screen that names a record the page is not
 *     showing.
 *   - HYDRATING it. The recipe is re-derived from the roster installed NOW.
 *     `surface.lookups` membership IS that re-derivation — the same two axes
 *     (`rendersReadingSurface` + `isProvablyReadOnly`) that let a view auto-run
 *     as a tab — so a hydrated address can never do more than a tab already
 *     does, and a pack version bump that turns a lookup into an operation
 *     silently disarms every bookmark pointing at it.
 *
 *  ⛔⛔ THE REFUSALS ARE THE FEATURE. A URL is evidence of INTENT, never of
 *  safety. Every test below that asserts nothing ran is asserting that. */
import { describe, expect, it, vi } from 'vitest';
import type {
  PackListEntry,
  ServerExecuteResponse,
  ServerRecipeListEntry,
} from '@recued/contracts';

import {
  mountPackAppView,
  type MountPackAppViewOptions,
  type PackAppExecuteCaller,
} from '../packs/pack-app-view.js';
import type { PackAppRecipe, PackAppSurface } from '../packs/pack-app-model.js';

interface FakeElement {
  innerHTML: string;
  parentNode: FakeElement | null;
  children: FakeElement[];
  listeners: Map<string, Array<(event: Event) => void>>;
  attrs: Map<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeElement): FakeElement;
  removeChild(child: FakeElement): FakeElement;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  querySelector(selector: string): FakeElement | null;
  remove(): void;
}

const fakeElement = (): FakeElement => {
  const element: FakeElement = {
    innerHTML: '',
    parentNode: null,
    children: [],
    listeners: new Map(),
    attrs: new Map(),
    setAttribute(name, value) { element.attrs.set(name, value); },
    getAttribute(name) { return element.attrs.get(name) ?? null; },
    appendChild(child) { child.parentNode = element; element.children.push(child); return child; },
    removeChild(child) {
      const index = element.children.indexOf(child);
      if (index < 0) throw new Error('not a child');
      element.children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener(type, listener) {
      element.listeners.set(type, [...(element.listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      element.listeners.set(
        type,
        (element.listeners.get(type) ?? []).filter((entry) => entry !== listener),
      );
    },
    querySelector() { return null; },
    remove() { element.parentNode?.removeChild(element); },
  };
  return element;
};

const settle = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const recipeEntry = (
  recipeId: string,
  variables: Record<string, unknown>,
): ServerRecipeListEntry => ({
  recipe_id: recipeId,
  publisher_id: 'recued-core',
  version: 1,
  recipe_hash: `hash-${recipeId}`,
  recipe: {
    recipe_id: recipeId, version: 1, ttl: 0,
    metadata: {
      name: recipeId, description: '', author: 'recued-core',
      supported_platforms: [], tags: [],
    },
    variables, prefetch_steps: [], steps: [], requires: [],
    output: { render: [] },
  },
  source: 'bundled',
  installed_at: 0,
} as unknown as ServerRecipeListEntry);

const listEntry = recipeEntry('list-buildings', {});
/** One required variable — the shape a single URL segment can express. */
const detailEntry = recipeEntry('show-building', {
  building: { label: 'Connection', type: 'connection', default: '' },
  id: { label: 'The building', type: 'string' },
});
/** Two required variables — nothing a single segment can say. */
const spanEntry = recipeEntry('show-span', {
  from: { label: 'From', type: 'string' },
  to: { label: 'To', type: 'string' },
});

const item = (entry: ServerRecipeListEntry): PackAppRecipe => ({
  recipe_id: entry.recipe_id,
  name: entry.recipe_id,
  description: '',
  entry,
});

const surfaceWith = (
  lookups: ServerRecipeListEntry[],
  operations: ServerRecipeListEntry[] = [],
): PackAppSurface => ({
  views: [item(listEntry)],
  lookups: lookups.map(item),
  operations: operations.map(item),
  automations: [],
  missing: [],
});

const pack = { slug: 'rental-book', name: 'Rental book', description: '' } as unknown as PackListEntry;

const listResult = (): ServerExecuteResponse => ({
  recipe_id: 'list-buildings', recipe_hash: 'hash-list-buildings', success: true,
  steps: [], errors: [],
  output: {
    render: [{
      type: 'table',
      data: {
        rows: [{ id: 'bld_42', name: 'Mill Court' }],
      },
      record_columns: {
        entity: 'building',
        columns: [
          { field: 'id', label: 'Id', kind: 'id' },
          { field: 'name', label: 'Name', kind: 'string' },
        ],
      },
    }],
  },
} as unknown as ServerExecuteResponse);

/** A list whose rows carry an Open control pointing at `show-building`. */
const listWithRowAction = (
  targetRecipeId: string,
  config: Record<string, unknown>,
  context?: Record<string, unknown>,
): ServerExecuteResponse => ({
  recipe_id: 'list-buildings', recipe_hash: 'hash-list-buildings', success: true,
  steps: [], errors: [],
  output: {
    render: [{
      type: 'button',
      data: {
        kind: 'recipe.run',
        label: 'Open',
        recipe_id: targetRecipeId,
        config,
        ...(context === undefined ? {} : { context }),
      },
    }],
  },
} as unknown as ServerExecuteResponse);

const detailResult = (): ServerExecuteResponse => ({
  recipe_id: 'show-building', recipe_hash: 'hash-show-building', success: true,
  steps: [], errors: [],
  output: { render: [{ type: 'summary', data: { fields: [{ label: 'Name', value: 'Mill Court' }] } }] },
} as unknown as ServerExecuteResponse);

const mount = (
  execute: PackAppExecuteCaller,
  options: Partial<Pick<
    MountPackAppViewOptions,
    'surface' | 'installedRecipes' | 'openRunModal' | 'initialViewId' | 'initialTarget' | 'onOpenLookup'
  >> = {},
) => {
  const host = fakeElement();
  const doc = {
    createElement: () => fakeElement(),
    defaultView: { confirm: () => true },
  } as unknown as Document;
  const view = mountPackAppView({
    host: host as unknown as HTMLElement,
    document: doc,
    pack,
    surface: options.surface ?? surfaceWith([detailEntry]),
    execute,
    installedRecipes: options.installedRecipes ?? [listEntry, detailEntry],
    ...(options.openRunModal !== undefined ? { openRunModal: options.openRunModal } : {}),
    ...(options.initialViewId !== undefined ? { initialViewId: options.initialViewId } : {}),
    ...(options.initialTarget !== undefined ? { initialTarget: options.initialTarget } : {}),
    ...(options.onOpenLookup !== undefined ? { onOpenLookup: options.onOpenLookup } : {}),
  });
  return { host, root: host.children[0]!, view };
};

const emitAction = (root: FakeElement, action: string, attrs: Record<string, string>): void => {
  const control = {
    getAttribute: (name: string) =>
      name === 'data-recued-recipes-action' ? action : attrs[name] ?? null,
  };
  const target = {
    closest: (selector: string) => (selector.includes(`="${action}"`) ? control : null),
  };
  for (const listener of root.listeners.get('click') ?? []) {
    listener({ target } as unknown as Event);
  }
};

const pressRowAction = (root: FakeElement): void => {
  emitAction(root, 'run-result-action', {
    'data-recued-recipes-result-action': 'result-action-0',
  });
};

describe('D-282 B5 — hydrating a bookmarked lookup address', () => {
  it('runs the lookup with the addressed record, stacked over the list', async () => {
    const execute = vi.fn<PackAppExecuteCaller>(async (args) => (
      args.recipe_id === 'list-buildings' ? listResult() : detailResult()
    ));
    const rig = mount(execute, { initialViewId: 'show-building', initialTarget: 'bld_42' });
    await settle();

    // The list ran FIRST — it is what the detail returns to, and on a cold load
    // there is nothing else behind the record.
    expect(execute.mock.calls.map((call) => call[0]!.recipe_id))
      .toEqual(['list-buildings', 'show-building']);
    expect(execute.mock.calls[1]![0]).toEqual({
      recipe_id: 'show-building',
      config: { id: 'bld_42' },
    });
    expect(rig.view.hydratedLookup()).toEqual({ recipe_id: 'show-building', target: 'bld_42' });
    // The tab underneath is the browse view, because a lookup is not a tab.
    expect(rig.view.activeViewId()).toBe('list-buildings');

    // ⛔⛔ THIS IS THE ASSERTION THE ORDER CHECK ABOVE DOES NOT MAKE, and I only
    // found that by mutating the code: dropping the chain leaves the two calls
    // in the SAME order and still passes it, because both dispatch
    // synchronously. What the chain actually buys is the panel UNDERNEATH — the
    // lookup captures the list as its `previous` only if the list has already
    // resolved. Without it, a cold-loaded detail has no way back to the list at
    // all, which is the whole point of following the link.
    expect(rig.root.innerHTML).toContain('Mill Court');
    emitAction(rig.root, 'restore-result-panel', {});
    await settle();
    expect(rig.root.innerHTML).toContain('Id');
    rig.view.dispose();
  });

  /** ⛔⛔ THE STALE-BOOKMARK CASE, AND THE REASON THE WHOLE FEATURE IS GATED ON
   *  A RE-DERIVATION. The URL is unchanged; the pack was upgraded and the
   *  recipe now WRITES. Nothing may run, and the host must be told the address
   *  was refused so it can rewrite it. */
  it('refuses an address whose recipe is now an operation', async () => {
    const execute = vi.fn<PackAppExecuteCaller>(async () => listResult());
    const rig = mount(execute, {
      surface: surfaceWith([], [detailEntry]),
      initialViewId: 'show-building',
      initialTarget: 'bld_42',
    });
    await settle();

    expect(execute.mock.calls.map((call) => call[0]!.recipe_id)).toEqual(['list-buildings']);
    expect(rig.view.hydratedLookup()).toBeNull();
    rig.view.dispose();
  });

  it('refuses an address naming a recipe this server no longer has', async () => {
    const execute = vi.fn<PackAppExecuteCaller>(async () => listResult());
    const rig = mount(execute, {
      surface: surfaceWith([]),
      installedRecipes: [listEntry],
      initialViewId: 'show-building',
      initialTarget: 'bld_42',
    });
    await settle();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(rig.view.hydratedLookup()).toBeNull();
    rig.view.dispose();
  });

  /** ⛔ ONE SEGMENT CANNOT SAY WHICH OF TWO ARGUMENTS IT FILLS, and filling the
   *  first would run a different query than the address appears to describe. */
  it('refuses a lookup that needs more than one argument', async () => {
    const execute = vi.fn<PackAppExecuteCaller>(async () => listResult());
    const rig = mount(execute, {
      surface: surfaceWith([spanEntry]),
      installedRecipes: [listEntry, spanEntry],
      initialViewId: 'show-span',
      initialTarget: 'bld_42',
    });
    await settle();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(rig.view.hydratedLookup()).toBeNull();
    rig.view.dispose();
  });

  /** ⛔⛔ TARGETED — the record comes from PAGE CONTEXT, which a hash cannot
   *  carry. Binding the one variable and running anyway would execute the
   *  lookup with half its input, failing inside the recipe rather than here
   *  where the reason is legible.
   *
   *  ⚠ THE FIXTURE IS THE DISCRIMINATING ONE, and that took measuring. This
   *  recipe declares EXACTLY ONE required variable, so the arity clause passes
   *  and only the targeting clause can refuse it. (It also costs nothing in
   *  practice: 0 of the corpus's 99 row-action targets are blocked this way —
   *  the config prong needs an op reading `{{config.x}}` as its `id` directly,
   *  and the generated details all route through a trim step.) */
  it('refuses a lookup whose record comes from page context', async () => {
    const targeted = recipeEntry('show-open-tab', { id: { label: 'Id', type: 'string' } });
    (targeted.recipe as unknown as { steps: unknown[] }).steps = [
      { id: 'read', transform: 'trim', input: '{{context.entity_id}}' },
    ];
    const execute = vi.fn<PackAppExecuteCaller>(async () => listResult());
    const rig = mount(execute, {
      surface: surfaceWith([targeted]),
      installedRecipes: [listEntry, targeted],
      initialViewId: 'show-open-tab',
      initialTarget: 'tab_1',
    });
    await settle();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(rig.view.hydratedLookup()).toBeNull();
    rig.view.dispose();
  });

  /** ⛔ A MALFORMED VARIABLE BOUNDARY FAILS CLOSED. `requiredVariables` returns
   *  null rather than an empty list, so "we cannot read the declaration" never
   *  reads as "it takes no input" — the same discipline `needsAnArgument` uses
   *  to decide whether something may be an auto-run tab. */
  it('refuses a lookup whose variable declaration cannot be read', async () => {
    const malformed = recipeEntry('show-broken', {});
    (malformed.recipe as unknown as { variables: unknown }).variables = ['id'];
    const execute = vi.fn<PackAppExecuteCaller>(async () => listResult());
    const rig = mount(execute, {
      surface: surfaceWith([malformed]),
      installedRecipes: [listEntry, malformed],
      initialViewId: 'show-broken',
      initialTarget: 'anything',
    });
    await settle();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(rig.view.hydratedLookup()).toBeNull();
    rig.view.dispose();
  });

  it('ignores a blank target rather than running the lookup on nothing', async () => {
    const execute = vi.fn<PackAppExecuteCaller>(async () => listResult());
    const rig = mount(execute, { initialViewId: 'show-building', initialTarget: '   ' });
    await settle();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(rig.view.hydratedLookup()).toBeNull();
    rig.view.dispose();
  });
});

describe('D-282 B5 — a row action publishes the address it opened', () => {
  it('runs a bound lookup in place and reports the record', async () => {
    const execute = vi.fn<PackAppExecuteCaller>(async (args) => (
      args.recipe_id === 'list-buildings'
        ? listWithRowAction('show-building', { id: 'bld_42' })
        : detailResult()
    ));
    const onOpenLookup = vi.fn();
    const openRunModal = vi.fn();
    const rig = mount(execute, { onOpenLookup, openRunModal });
    await settle();

    pressRowAction(rig.root);
    await settle();

    // In place — the modal is the collector for arguments an address cannot
    // express, and this one has none left to collect.
    expect(openRunModal).not.toHaveBeenCalled();
    expect(execute.mock.calls[1]![0]).toEqual({
      recipe_id: 'show-building',
      config: { id: 'bld_42' },
    });
    expect(onOpenLookup).toHaveBeenCalledWith({ recipe_id: 'show-building', target: 'bld_42' });

    // …and leaving the detail puts the list's own address back.
    emitAction(rig.root, 'restore-result-panel', {});
    await settle();
    expect(onOpenLookup).toHaveBeenLastCalledWith(null);
    rig.view.dispose();
  });

  /** ⚠ THE ADDRESS IS PUBLISHED ON THE WAY OUT OF A SUCCESSFUL RUN. A hash
   *  naming a record nothing could load is a bookmark that fails twice — once
   *  now, and again for whoever it is sent to. */
  it('publishes nothing when the lookup fails', async () => {
    const execute = vi.fn<PackAppExecuteCaller>(async (args) => {
      if (args.recipe_id === 'list-buildings') {
        return listWithRowAction('show-building', { id: 'bld_42' });
      }
      throw new Error('no such building');
    });
    const onOpenLookup = vi.fn();
    const rig = mount(execute, { onOpenLookup });
    await settle();

    pressRowAction(rig.root);
    await settle();

    expect(onOpenLookup).not.toHaveBeenCalled();
    expect(rig.root.innerHTML).toContain('no such building');
    rig.view.dispose();
  });

  /** ⛔⛔ AN OPERATION KEEPS THE MODAL, AND KEEPS IT UNCONDITIONALLY. A URL that
   *  can replay a write is a URL that acts; this is the boundary that keeps the
   *  address bar out of that business. */
  it('sends an operation through the run modal and publishes no address', async () => {
    const execute = vi.fn<PackAppExecuteCaller>(async () => (
      listWithRowAction('show-building', { id: 'bld_42' })
    ));
    const onOpenLookup = vi.fn();
    const openRunModal = vi.fn();
    const rig = mount(execute, {
      surface: surfaceWith([], [detailEntry]),
      onOpenLookup,
      openRunModal,
    });
    await settle();

    pressRowAction(rig.root);
    await settle();

    expect(openRunModal).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(onOpenLookup).not.toHaveBeenCalled();
    rig.view.dispose();
  });

  /** An action carrying page context is asking for more than the record id, and
   *  a hash cannot carry the rest. The modal still collects it. */
  it('sends a context-carrying action through the run modal', async () => {
    const execute = vi.fn<PackAppExecuteCaller>(async () => (
      listWithRowAction('show-building', { id: 'bld_42' }, { entity_id: 'row-1' })
    ));
    const onOpenLookup = vi.fn();
    const openRunModal = vi.fn();
    const rig = mount(execute, { onOpenLookup, openRunModal });
    await settle();

    pressRowAction(rig.root);
    await settle();

    expect(openRunModal).toHaveBeenCalledTimes(1);
    expect(onOpenLookup).not.toHaveBeenCalled();
    rig.view.dispose();
  });

  /** An action whose key is not the one the lookup declares would be refused by
   *  the server (`UNDECLARED_CONFIG_ARGUMENT`). It is not runnable in place, and
   *  the modal is where the mismatch becomes visible rather than silent. */
  it('sends an action whose key the lookup does not declare through the modal', async () => {
    const execute = vi.fn<PackAppExecuteCaller>(async () => (
      listWithRowAction('show-building', { building_id: 'bld_42' })
    ));
    const openRunModal = vi.fn();
    const onOpenLookup = vi.fn();
    const rig = mount(execute, { openRunModal, onOpenLookup });
    await settle();

    pressRowAction(rig.root);
    await settle();

    expect(openRunModal).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(onOpenLookup).not.toHaveBeenCalled();
    rig.view.dispose();
  });
});
