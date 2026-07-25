/** D-192 unit-3 — LIVE vendor-registry injection for the pure read-side
 *  alias resolvers (`parseRef`'s `data.crm.*` + `data.<vendor>.*` rewrites).
 *
 *  A pack-declared CRM exists only in the LIVE merged registry
 *  (`liveVendorRegistry(localManifestStore)`), never in the frozen builtin
 *  `CONNECTION_VENDOR_ENTITIES`. Before this fix, its alias refs never
 *  rewrote onto the canonical enrichment store and resolved to undefined.
 *  With the server-bound resolver they dispatch; unbound (client / test) the
 *  frozen builtin is used, so built-in vendors are byte-identical.
 *
 *  The runtime resolver collapse for the BUILTIN vendors is covered by
 *  `d-130-phase-7-crm-aliases.test.ts`; this suite adds the pack-vendor +
 *  injection-seam behaviour. */

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildConnectionVendorEntity,
  CONNECTION_VENDOR_ENTITIES,
  matchCrmAlias,
  resolveRef,
  setVendorAliasRegistryResolver,
  activeVendorAliasRegistry,
  type ConnectionVendorEntity,
  type NamespaceStores,
} from '../index.js';

// A pack-declared CRM vendor lifted into the live merged registry (mirrors
// `community/packs/dynamics.json`'s `crm_alias:'contact'` contact entity).
// Deliberately ABSENT from CONNECTION_VENDOR_ENTITIES.
const dynamicsContact: ConnectionVendorEntity = buildConnectionVendorEntity({
  vendor: 'dynamics',
  entity: 'contact',
  display_name: 'Dynamics Contact',
  crm_alias: 'contact',
  meta_fields: [{ key: 'email', type: 'string', description: 'primary email' }],
});
const liveRegistry: ReadonlyArray<ConnectionVendorEntity> = [
  ...CONNECTION_VENDOR_ENTITIES,
  dynamicsContact,
];

// The host only ever populates the canonical D-128 enrichment path; every
// alias form must rewrite onto it. Carries one builtin (hubspot) + one pack
// (dynamics) record.
const stores: NamespaceStores = {
  vault: {},
  config: {},
  context: {},
  meta: {},
  step: {},
  data: {
    enrichment: {
      connection: {
        api: {
          hubspot: {
            contact: {
              hubspot_contact_42: {
                engagement_score_per_contact: { score: 91 },
              },
            },
          },
          dynamics: {
            contact: {
              dynamics_contact_a99: {
                engagement_score_per_contact: { score: 73 },
              },
            },
          },
        },
      },
    },
  },
};

afterEach(() => setVendorAliasRegistryResolver(null));

describe('D-192 unit-3 — activeVendorAliasRegistry injection seam', () => {
  it('returns the frozen builtin when unbound', () => {
    expect(activeVendorAliasRegistry()).toBe(CONNECTION_VENDOR_ENTITIES);
  });

  it('returns the bound live registry once a resolver is set', () => {
    setVendorAliasRegistryResolver(() => liveRegistry);
    expect(activeVendorAliasRegistry()).toBe(liveRegistry);
  });

  it('resets to the builtin when set back to null', () => {
    setVendorAliasRegistryResolver(() => liveRegistry);
    setVendorAliasRegistryResolver(null);
    expect(activeVendorAliasRegistry()).toBe(CONNECTION_VENDOR_ENTITIES);
  });
});

describe('D-192 unit-3 — pack CRM alias resolves only with the live registry', () => {
  const crmRef =
    '{{data.crm.contact.dynamics_contact_a99.enrichments.engagement_score_per_contact.score}}';
  const vendorRef =
    '{{data.dynamics.contact.dynamics_contact_a99.enrichments.engagement_score_per_contact.score}}';

  it('UNBOUND: the cross-vendor `data.crm.*` alias for a pack CRM stays unresolved (the bug)', () => {
    // dynamics is absent from the frozen builtin → no dispatch → the alias
    // never rewrites → walks the empty `data.crm` tree → undefined.
    expect(resolveRef(crmRef, stores)).toBeUndefined();
  });

  it('UNBOUND: the per-vendor `data.<vendor>.*` alias for a pack CRM stays unresolved too', () => {
    expect(resolveRef(vendorRef, stores)).toBeUndefined();
  });

  it('BOUND: the cross-vendor `data.crm.*` alias resolves to the canonical record', () => {
    setVendorAliasRegistryResolver(() => liveRegistry);
    expect(resolveRef(crmRef, stores)).toBe(73);
  });

  it('BOUND: the per-vendor `data.<vendor>.*` alias resolves to the same record', () => {
    setVendorAliasRegistryResolver(() => liveRegistry);
    expect(resolveRef(vendorRef, stores)).toBe(73);
  });
});

describe('D-192 unit-3 — built-in CRMs are byte-identical either way', () => {
  const builtinRef =
    '{{data.crm.contact.hubspot_contact_42.enrichments.engagement_score_per_contact.score}}';

  it('a builtin (hubspot) resolves whether the resolver is unbound or bound', () => {
    expect(resolveRef(builtinRef, stores)).toBe(91); // unbound → frozen builtin
    setVendorAliasRegistryResolver(() => liveRegistry);
    expect(resolveRef(builtinRef, stores)).toBe(91); // bound → live superset
  });

  it('matchCrmAlias with an explicit registry is unchanged by the seam (builtin null, live dispatches)', () => {
    // The helper still honours an explicit registry arg; the seam only
    // changes the default the two callers pass.
    expect(matchCrmAlias('crm.contact.dynamics_contact_a99.enrichments.foo')).toBeNull();
    const m = matchCrmAlias('crm.contact.dynamics_contact_a99.enrichments.foo', liveRegistry);
    expect(m?.vendor).toBe('dynamics');
    expect(m?.entity).toBe('contact');
  });
});
