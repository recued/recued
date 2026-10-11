/** D-320 slice 2g (ruling 16) — where a pack's runs go when a connection leaves its
 *  list, in words (`connection-removal.ts`), and the Connections page's Delete
 *  dialog saying it (`renderConnectionsPage` with `deleteConfirm.effects`). */

import { describe, expect, it } from 'vitest';

import {
  connectionRemovalChanges,
  connectionRemovalRecipeChanges,
  connectionRemovalRecipeSentence,
  connectionRemovalSentence,
  type ConnectionRemovalEffect,
  type ConnectionRemovalRecipeEffect,
} from '../connection-removal.js';
import {
  initialConnectionsPageState,
  renderConnectionsPage,
  type ConnectionsDeleteConfirmState,
  type ConnectionsPageState,
} from '../connections/index.js';

const key = { connection_name: 'hubspot-key', display_name: 'Service Key' };
const app = { connection_name: 'hubspot-app', display_name: 'Sales app' };
const other = { connection_name: 'hubspot-other', display_name: 'Old portal' };

const effect = (over: Partial<ConnectionRemovalEffect>): ConnectionRemovalEffect => ({
  pack_slug: 'hubspot',
  pack_name: 'HubSpot CRM',
  slot: 'hubspot',
  members: [],
  outcome: 'unchanged',
  remaining: [],
  ...over,
});

const family = [
  { pack_slug: 'stripe-issuing', pack_name: 'Stripe Issuing' },
  { pack_slug: 'stripe-tax-climate', pack_name: 'Stripe Tax & Climate' },
];

describe('D-320 slice 2g — one sentence per pack', () => {
  it('names where the runs go, for each outcome', () => {
    expect(connectionRemovalSentence(effect({ outcome: 'moves', before: key, after: app, remaining: [app] })))
      .toBe('HubSpot CRM will run on Sales app from now on.');
    expect(connectionRemovalSentence(effect({ outcome: 'no_default', before: key, remaining: [app, other] })))
      .toBe('HubSpot CRM will have no default: its runs ask which connection to use, and scheduled runs fail until you choose one.');
    expect(connectionRemovalSentence(effect({ outcome: 'stops', before: key })))
      .toBe('HubSpot CRM will have no connection left: its runs stop until you add one.');
    expect(connectionRemovalSentence(effect({ outcome: 'unchanged', before: key, after: key, remaining: [key] })))
      .toBe('HubSpot CRM will keep running on Service Key.');
  });

  it("says an emptied registered vendor's pack goes on for the owner, on the one connection or asking", () => {
    expect(connectionRemovalSentence(effect({ outcome: 'no_list', before: key, fallback: [key] })))
      .toBe('HubSpot CRM will have no connection on its list. Scheduled runs stop; your own runs use Service Key, which can still serve it.');
    expect(connectionRemovalSentence(effect({ outcome: 'no_list', before: key, fallback: [app, other] })))
      .toBe('HubSpot CRM will have no connection on its list. Scheduled runs stop; your own runs use a connection that can still serve it, asking when several can.');
  });

  it('names a family once, its members counted, the verbs agreeing', () => {
    const holder = { pack_slug: 'stripe-v2-core', pack_name: 'Stripe v2 Core' };
    expect(connectionRemovalSentence(effect({ ...holder, members: family, outcome: 'stops', before: key })))
      .toBe('Stripe v2 Core and 2 packs that sign in through it will have no connection left: their runs stop until you add one.');
    expect(connectionRemovalSentence(effect({ ...holder, members: family.slice(0, 1), outcome: 'moves', after: app })))
      .toBe('Stripe v2 Core and 1 pack that signs in through it will run on Sales app from now on.');
    expect(connectionRemovalSentence(effect({ ...holder, members: family, outcome: 'unchanged', remaining: [app, other] })))
      .toBe('Stripe v2 Core and 2 packs that sign in through it still have no default: their runs ask which connection to use.');
  });

  it('speaks of the page\'s own pack as "This pack"', () => {
    expect(connectionRemovalSentence(effect({ outcome: 'moves', after: app }), 'This pack'))
      .toBe('This pack will run on Sales app from now on.');
  });

  it('keeps only the packs whose runs change', () => {
    const effects = [
      effect({ pack_slug: 'a', outcome: 'unchanged', after: key }),
      effect({ pack_slug: 'b', outcome: 'moves', after: app }),
      effect({ pack_slug: 'c', outcome: 'no_list', fallback: [key] }),
    ];
    expect(connectionRemovalChanges(effects).map((e) => e.pack_slug)).toEqual(['b', 'c']);
  });
});

const baseState = (overrides?: Partial<ConnectionsPageState>): ConnectionsPageState => ({
  ...initialConnectionsPageState(),
  connections: [{ name: 'hubspot-key', kind: 'api' as const, display_name: 'Service Key' }],
  ...(overrides ?? {}),
});

const confirm = (over?: Partial<ConnectionsDeleteConfirmState>): ConnectionsDeleteConfirmState => ({
  kind: 'api',
  name: 'hubspot-key',
  count: null,
  removeMirror: false,
  deleting: false,
  ...(over ?? {}),
});

describe("D-320 slice 2g — the Delete dialog says what changes for the owner's packs", () => {
  it('says nothing of packs when the host cannot ask', () => {
    expect(renderConnectionsPage(baseState({ deleteConfirm: confirm() }))).not.toContain('data-connections-delete-effects');
  });

  it('says it is checking while it loads, and that it could not when it failed', () => {
    const loading = renderConnectionsPage(baseState({ deleteConfirm: confirm({ effects: { status: 'loading' } }) }));
    expect(loading).toContain('data-connections-delete-effects="loading"');
    expect(loading).toContain('Checking what changes for your packs');
    const failed = renderConnectionsPage(baseState({ deleteConfirm: confirm({ effects: { status: 'failed' } }) }));
    expect(failed).toContain('data-connections-delete-effects="failed"');
    expect(failed).toContain('Could not check what changes for your packs.');
  });

  it('lists each pack whose runs change, in one sentence each, and leaves out the rest', () => {
    const html = renderConnectionsPage(baseState({
      deleteConfirm: confirm({
        effects: {
          status: 'ready',
          packs: [
            effect({ pack_slug: 'hubspot', outcome: 'moves', before: key, after: app }),
            effect({ pack_slug: 'deal-desk', pack_name: 'Deal Desk', outcome: 'unchanged', before: app, after: app }),
            effect({ pack_slug: 'sales-aug', pack_name: 'Sales <Augmentation>', outcome: 'stops', before: key }),
          ],
        },
      }),
    }));
    expect(html).toContain('What changes for your packs');
    expect(html).toContain('data-delete-effect="moves" data-delete-effect-pack="hubspot">HubSpot CRM will run on Sales app from now on.');
    expect(html).toContain('data-delete-effect="stops" data-delete-effect-pack="sales-aug">Sales &lt;Augmentation&gt; will have no connection left');
    expect(html).not.toContain('Deal Desk');
  });

  it("lists a recipe whose runs stop where its packs' do not", () => {
    const html = renderConnectionsPage(baseState({
      deleteConfirm: confirm({
        effects: {
          status: 'ready',
          packs: [effect({ outcome: 'unchanged', before: app, after: app })],
          recipes: [recipe({ outcome: 'stops', before: one })],
        },
      }),
    }));
    expect(html).toContain('data-connections-delete-effects="ready"');
    expect(html).toContain('data-delete-effect="stops" data-delete-effect-recipe="workspace-map-shortcut">Workspace map reads both');
  });

  it('says nothing more when no pack changes', () => {
    const html = renderConnectionsPage(baseState({
      deleteConfirm: confirm({ effects: { status: 'ready', packs: [effect({ outcome: 'unchanged', after: app })] } }),
    }));
    expect(html).not.toContain('data-connections-delete-effects');
  });
});

// ── D-320 audit — a recipe reading two or more packs' lists ──────────────────

const one = { connection_name: 'sc-one', display_name: 'Shortcut one' };
const two = { connection_name: 'sc-two', display_name: 'Shortcut two' };

const recipe = (over: Partial<ConnectionRemovalRecipeEffect>): ConnectionRemovalRecipeEffect => ({
  recipe_id: 'workspace-map-shortcut',
  recipe_name: 'Workspace map',
  slot: 'shortcut',
  packs: [
    { pack_slug: 'shortcut-planning', pack_name: 'Shortcut Planning' },
    { pack_slug: 'shortcut-workspace', pack_name: 'Shortcut Workspace' },
  ],
  outcome: 'unchanged',
  remaining: [],
  ...over,
});

describe('D-320 audit — one sentence per recipe reading several lists', () => {
  it('names where its runs go, saying it needs a connection on both lists', () => {
    expect(connectionRemovalRecipeSentence(recipe({ outcome: 'stops', before: one })))
      .toBe("Workspace map reads both Shortcut Planning's and Shortcut Workspace's lists, and no connection will be on both: its runs stop until one is.");
    expect(connectionRemovalRecipeSentence(recipe({ outcome: 'moves', before: one, after: two, remaining: [two] })))
      .toBe("Workspace map reads both Shortcut Planning's and Shortcut Workspace's lists, and will run on Shortcut two, the connection on both, from now on.");
    expect(connectionRemovalRecipeSentence(recipe({ outcome: 'no_default', before: one, remaining: [one, two] })))
      .toBe("Workspace map reads both Shortcut Planning's and Shortcut Workspace's lists, and no connection on both will be its default: scheduled runs fail until you choose one.");
    expect(connectionRemovalRecipeSentence(recipe({ outcome: 'unchanged', before: one, after: one, remaining: [one] })))
      .toBe('Workspace map will keep running on Shortcut one.');
  });

  it('names three or more lists by their packs', () => {
    const three = recipe({
      outcome: 'stops',
      before: one,
      packs: [
        { pack_slug: 'a', pack_name: 'A' },
        { pack_slug: 'b', pack_name: 'B' },
        { pack_slug: 'c', pack_name: 'C' },
      ],
    });
    expect(connectionRemovalRecipeSentence(three))
      .toBe('Workspace map reads the lists of A, B and C, and no connection will be on all of them: its runs stop until one is.');
  });

  it('keeps only the recipes whose runs change, and none from a server before it', () => {
    expect(connectionRemovalRecipeChanges([
      recipe({ outcome: 'stops', before: one }),
      recipe({ recipe_id: 'kept', outcome: 'unchanged', before: one, after: one }),
    ]).map((r) => r.recipe_id)).toEqual(['workspace-map-shortcut']);
    expect(connectionRemovalRecipeChanges(undefined)).toEqual([]);
  });
});
