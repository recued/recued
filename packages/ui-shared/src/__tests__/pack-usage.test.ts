/** Connection-detail "Used by packs" — unit tests for `packsUsingConnection`,
 *  the inverse pivot of the pack-row readiness (per connection → its packs +
 *  scope coverage). */

import { describe, it, expect } from 'vitest';
import type { BulkPackManifest, ConnectionView } from '@recued/contracts';

import { packsUsingConnection } from '../connections/pack-usage.js';
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
const pack = (slug: string, vendor: string, scopes: string[]): BulkPackManifest =>
  ({
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
  }) as unknown as BulkPackManifest;

describe('packsUsingConnection', () => {
  it('lists packs that declare the vendor, each with coverage vs granted (sorted)', () => {
    const manifests = [
      pack('b-pack', 'hubspot', ['crm.objects.deals.read']),
      pack('a-pack', 'hubspot', ['crm.objects.deals.write']),
    ];
    const usage = packsUsingConnection(manifests, 'hubspot', ['crm.objects.deals.read']);
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
    const manifests = [
      pack('hs', 'hubspot', ['a']),
      pack('sf', 'salesforce', ['api']),
    ];
    expect(packsUsingConnection(manifests, 'hubspot', ['a']).map((u) => u.pack_slug))
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

    it('still excludes a bound pack that declares no scope-bearing op on the vendor', () => {
      // bound but not vendor-declaring → nothing to show coverage for (unchanged).
      const usage = packsUsingConnection(
        [pack('sync-pack', 'onedrive', ['Files.Read'])],
        'onedrive',
        ['Files.Read'],
        ['sync-pack', 'ghost-pack'],
      );
      expect(usage.map((u) => u.pack_slug)).toEqual(['sync-pack']);
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
      installedPackManifests: [
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
      // no installedPackManifests
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
      installedPackManifests: [
        pack('sync-pack', 'onedrive', ['Files.Read']),
        pack('backup-pack', 'onedrive', ['Files.Read']), // same vendor, NOT bound → excluded
      ],
    };
    const html = renderConnectionsPage(state);
    expect(html).toContain('sync-pack');
    expect(html).not.toContain('backup-pack');
  });

  it('omits the section for a same-vendor connection with no bound packs (grant-precise, not vendor-match)', () => {
    const state: ConnectionsPageState = {
      ...initialConnectionsPageState(),
      connections: [onedriveConn('onedrive_personal', [])], // bound to nothing
      installedPackManifests: [pack('sync-pack', 'onedrive', ['Files.Read'])], // vendor-match WOULD show this
    };
    expect(renderConnectionsPage(state)).not.toContain('Used by packs');
  });
});
