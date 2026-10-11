/** Connection-detail "Used by packs" — unit tests for `packsUsingConnection`,
 *  the inverse pivot of the pack-row readiness (per connection → its packs +
 *  scope coverage). */

import { describe, it, expect } from 'vitest';
import {
  requiredScopesByConnection,
  type BulkPackManifest,
  type ConnectionView,
} from '@recued/contracts';

import { packsUsingConnection, type InstalledPackScopes } from '../connections/pack-usage.js';
import { initialConnectionsPageState, renderConnectionsPage } from '../index.js';
import type { ConnectionsPageState } from '../connections/index.js';

const httpIngredient = (slug: string, connection: string): unknown => ({
  slug, kind: 'http', http: { base: 'https://x', connection },
});
const op = (opId: string, ingredient: string, required_scopes?: string[]): unknown => ({
  op: opId, ingredient, risk: 'read', approval: 'never',
  bind: { method: 'GET', path: '/' },
  ...(required_scopes !== undefined ? { required_scopes } : {}),
});
/** An installed pack as `packs.list` sends it: no manifest, and the scopes per
 *  connection slot the server lifts from it with this same helper. */
const pack = (slug: string, vendor: string, scopes: string[]): InstalledPackScopes => {
  const manifest = {
    slug,
    contents: [
      {
        type: 'composition',
        composition: {
          schema_version: 1,
          slug: `${slug}-catalog`,
          ingredients: [httpIngredient('ing', vendor)],
          operations: [op('o', 'ing', scopes)],
        },
      },
    ],
  } as unknown as BulkPackManifest;
  const bySlot = requiredScopesByConnection(manifest);
  return {
    slug,
    ...(Object.keys(bySlot).length > 0 ? { required_scopes_by_connection: bySlot } : {}),
  };
};

describe('packsUsingConnection', () => {
  it('lists packs that declare the vendor, each with coverage vs granted (sorted)', () => {
    const packs = [
      pack('b-pack', 'hubspot', ['crm.objects.deals.read']),
      pack('a-pack', 'hubspot', ['crm.objects.deals.write']),
    ];
    const usage = packsUsingConnection(packs, 'hubspot', ['crm.objects.deals.read']);
    expect(usage.map((u) => u.pack_slug)).toEqual(['a-pack', 'b-pack']); // sorted
    // a-pack needs write (not granted) → under-scoped; b-pack needs read → covered.
    expect(usage[0]).toMatchObject({
      pack_slug: 'a-pack',
      needed: ['crm.objects.deals.write'],
      coverage: { known: true, covered: false, missing: ['crm.objects.deals.write'] },
    });
    expect(usage[1].coverage).toEqual({ known: true, covered: true, missing: [] });
  });

  it('ignores packs that declare a different vendor', () => {
    const packs = [
      pack('hs', 'hubspot', ['a']),
      pack('sf', 'salesforce', ['api']),
    ];
    expect(packsUsingConnection(packs, 'hubspot', ['a']).map((u) => u.pack_slug))
      .toEqual(['hs']);
  });

  it('reports unknown coverage (soft) when granted is undefined', () => {
    const usage = packsUsingConnection([pack('hs', 'hubspot', ['a'])], 'hubspot', undefined);
    expect(usage[0].coverage).toEqual({ known: false, covered: false, missing: [] });
  });

  it('returns [] when no installed pack uses the vendor', () => {
    expect(packsUsingConnection([pack('hs', 'hubspot', ['a'])], 'slack', [])).toEqual([]);
    expect(packsUsingConnection([], 'hubspot', ['a'])).toEqual([]);
  });

  describe('D-194 #6 — boundPackSlugs narrows to the specific connection', () => {
    const twoOnedrivePacks = [
      pack('sync-pack', 'onedrive', ['Files.Read']),
      pack('backup-pack', 'onedrive', ['Files.Read']),
    ];

    it('restricts vendor-match to packs granted on THIS connection', () => {
      // The S-1 fix: onedrive_work's list shows only the pack granted on it,
      // not every onedrive pack.
      const usage = packsUsingConnection(twoOnedrivePacks, 'onedrive', ['Files.Read'], ['sync-pack']);
      expect(usage.map((u) => u.pack_slug)).toEqual(['sync-pack']);
    });

    it('falls back to vendor-match when boundPackSlugs is undefined (dbless / legacy)', () => {
      const usage = packsUsingConnection(twoOnedrivePacks, 'onedrive', ['Files.Read']);
      expect(usage.map((u) => u.pack_slug)).toEqual(['backup-pack', 'sync-pack']);
    });

    it('shows nothing when the connection has no bound packs (empty set, not undefined)', () => {
      expect(packsUsingConnection(twoOnedrivePacks, 'onedrive', ['Files.Read'], [])).toEqual([]);
    });

    it('names a bound pack that is not installed nowhere', () => {
      const usage = packsUsingConnection(
        [pack('sync-pack', 'onedrive', ['Files.Read'])],
        'onedrive',
        ['Files.Read'],
        ['sync-pack', 'ghost-pack'],
      );
      expect(usage.map((u) => u.pack_slug)).toEqual(['sync-pack']);
    });

    // D-320 §4 — a pack whose list holds the connection is named even when it
    // needs no scope (an API key's pack), and the default is marked. This
    // reverses D-194 #6's "a bound pack declaring no scope-bearing op is
    // excluded": the list is what "Used by packs" names now, not coverage alone.
    it('names a bound pack that needs no scope, and marks the default', () => {
      const usage = packsUsingConnection(
        [pack('sync-pack', 'onedrive', ['Files.Read']), { slug: 'wise-core' }],
        'onedrive',
        ['Files.Read'],
        ['sync-pack', 'wise-core'],
        ['wise-core'],
      );
      expect(usage).toEqual([
        { pack_slug: 'sync-pack', pack_name: 'sync-pack', members: [], needed: ['Files.Read'], coverage: expect.objectContaining({ covered: true }) },
        { pack_slug: 'wise-core', pack_name: 'wise-core', members: [], needed: [], coverage: expect.anything(), is_default: true },
      ]);
    });
  });

  describe('D-320 slice 2h — by name, a family once', () => {
    it('names each pack by its name, falling back to its slug', () => {
      const usage = packsUsingConnection(
        [{ slug: 'wise-core', name: 'Wise Core' }, { slug: 'nameless' }],
        'wise',
        undefined,
        ['wise-core', 'nameless'],
      );
      expect(usage.map((u) => [u.pack_slug, u.pack_name])).toEqual([['nameless', 'nameless'], ['wise-core', 'Wise Core']]);
    });

    it('folds each member into its holder, its scopes with it, so a missing one still shows', () => {
      const usage = packsUsingConnection(
        [
          { ...pack('hs-core', 'hubspot', ['crm.objects.deals.read']), name: 'HubSpot Core' },
          { ...pack('hs-deals', 'hubspot', ['crm.objects.deals.write']), name: 'HubSpot Deals' },
          { ...pack('hs-notes', 'hubspot', []), name: 'HubSpot Notes' },
        ],
        'hubspot',
        ['crm.objects.deals.read'],
        ['hs-core', 'hs-deals', 'hs-notes'],
        ['hs-core', 'hs-deals', 'hs-notes'],
        { 'hs-deals': 'hs-core', 'hs-notes': 'hs-core' },
      );
      expect(usage).toEqual([{
        pack_slug: 'hs-core',
        pack_name: 'HubSpot Core',
        members: ['HubSpot Deals', 'HubSpot Notes'],
        needed: ['crm.objects.deals.read', 'crm.objects.deals.write'],
        coverage: expect.objectContaining({ covered: false, missing: ['crm.objects.deals.write'] }),
        is_default: true,
      }]);
    });

    it('keeps a member whose holder is not on the connection as its own line', () => {
      const usage = packsUsingConnection(
        [{ slug: 'wise-quotes', name: 'Wise Quotes' }],
        'wise',
        undefined,
        ['wise-quotes'],
        [],
        { 'wise-quotes': 'wise-core' },
      );
      expect(usage.map((u) => [u.pack_name, u.members])).toEqual([['Wise Quotes', []]]);
    });
  });
});

describe('renderConnectionsPage — "Used by packs" connection-detail section', () => {
  const apiConn = (granted?: string[]): ConnectionView =>
    ({
      name: 'hubspot', kind: 'api', display_name: 'HubSpot',
      vendor: 'hubspot',
      ...(granted !== undefined ? { granted_scopes: granted } : {}),
    }) as unknown as ConnectionView;

  it('renders the section on an api connection with under-scoped coverage', () => {
    const state: ConnectionsPageState = {
      ...initialConnectionsPageState(),
      connections: [apiConn(['crm.objects.deals.read'])],
      installedPacks: [
        pack('sales-pack', 'hubspot', ['crm.objects.deals.read', 'crm.objects.deals.write']),
      ],
    };
    const html = renderConnectionsPage(state);
    expect(html).toContain('Used by packs');
    expect(html).toContain('sales-pack');
    expect(html).toContain('missing crm.objects.deals.write');
    expect(html).toContain('data-pack-usage-tone="warn"');
  });

  it('omits the section when no installed pack uses the connection', () => {
    const state: ConnectionsPageState = {
      ...initialConnectionsPageState(),
      connections: [apiConn(['a'])],
      // no installedPacks
    };
    expect(renderConnectionsPage(state)).not.toContain('Used by packs');
  });

  // D-194 #6 — the page passes ConnectionView.bound_pack_slugs through so the
  // list is connection-precise (grant-match), not vendor-match.
  const onedriveConn = (name: string, bound: string[]): ConnectionView =>
    ({
      name, kind: 'api', display_name: name,
      vendor: 'onedrive', granted_scopes: ['Files.Read'],
      bound_pack_slugs: bound,
    }) as unknown as ConnectionView;

  it('lists ONLY the connection\'s bound packs, not every vendor pack', () => {
    const state: ConnectionsPageState = {
      ...initialConnectionsPageState(),
      connections: [onedriveConn('onedrive_work', ['sync-pack'])],
      installedPacks: [
        pack('sync-pack', 'onedrive', ['Files.Read']),
        pack('backup-pack', 'onedrive', ['Files.Read']), // same vendor, NOT bound → excluded
      ],
    };
    const html = renderConnectionsPage(state);
    expect(html).toContain('sync-pack');
    expect(html).not.toContain('backup-pack');
  });

  it('D-320 — names a pack on the list with no scope, says nothing of coverage, and marks its default', () => {
    const wise = {
      name: 'wise-business', kind: 'api', display_name: 'Wise',
      bound_pack_slugs: ['wise-core', 'wise-payouts'],
      default_for_pack_slugs: ['wise-core'],
    } as unknown as ConnectionView;
    const state: ConnectionsPageState = {
      ...initialConnectionsPageState(),
      connections: [wise], // no vendor: the packs on its list are still named
      installedPacks: [{ slug: 'wise-core' }, { slug: 'wise-payouts' }],
    };
    const html = renderConnectionsPage(state);
    expect(html).toContain('Used by packs');
    expect(html).toContain('<span class="connections-pack-usage-name">wise-core</span> <span class="connections-pack-usage-default" data-pack-usage-default>· its default</span>');
    expect(html).toContain('<span class="connections-pack-usage-name">wise-payouts</span></li>');
    expect(html).not.toContain('Recued has not checked');
  });

  it('D-320 slice 2h — names packs by name, a family once, its members counted', () => {
    const wise = {
      name: 'wise-business', kind: 'api', display_name: 'Wise',
      bound_pack_slugs: ['wise-core', 'wise-quotes', 'wise-transfers'],
      default_for_pack_slugs: ['wise-core', 'wise-quotes', 'wise-transfers'],
      pack_holders: { 'wise-quotes': 'wise-core', 'wise-transfers': 'wise-core' },
    } as unknown as ConnectionView;
    const html = renderConnectionsPage({
      ...initialConnectionsPageState(),
      connections: [wise],
      installedPacks: [
        { slug: 'wise-core', name: 'Wise Core' },
        { slug: 'wise-quotes', name: 'Wise Quotes' },
        { slug: 'wise-transfers', name: 'Wise <Transfers>' },
      ],
    });
    expect(html).toContain('<span class="connections-pack-usage-name">Wise Core</span>');
    expect(html).toContain('data-pack-usage-members="2" title="Wise &lt;Transfers&gt;, Wise Quotes">and 2 packs that sign in through it</span>');
    expect(html).not.toContain('data-pack-usage="wise-quotes"');
  });

  it('D-320 slice 2h — opens the API group with the grids placeholder only when the host mounts them', () => {
    const state: ConnectionsPageState = { ...initialConnectionsPageState(), connections: [apiConn(['a'])] };
    expect(renderConnectionsPage({ ...state, signInGrids: true })).toContain('data-recued-signin-grids-host');
    expect(renderConnectionsPage(state)).not.toContain('data-recued-signin-grids-host');
    const mcpOnly: ConnectionsPageState = {
      ...initialConnectionsPageState(),
      connections: [{ name: 'gh', kind: 'mcp', display_name: 'GitHub' } as unknown as ConnectionView],
    };
    expect(renderConnectionsPage({ ...mcpOnly, signInGrids: true })).not.toContain('data-recued-signin-grids-host');
  });

  it('omits the section for a same-vendor connection with no bound packs (grant-precise, not vendor-match)', () => {
    const state: ConnectionsPageState = {
      ...initialConnectionsPageState(),
      connections: [onedriveConn('onedrive_personal', [])], // bound to nothing
      installedPacks: [pack('sync-pack', 'onedrive', ['Files.Read'])], // vendor-match WOULD show this
    };
    expect(renderConnectionsPage(state)).not.toContain('Used by packs');
  });
});
