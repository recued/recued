/** D-192 unit-3 — the recipe reference validator dispatches `data.crm.*` /
 *  `data.<vendor>.*` aliases against the LIVE merged registry.
 *
 *  A pack-declared CRM's alias refs hard-error `crm_alias_unresolved` until
 *  the server binds the live-registry resolver; unbound (client / test) they
 *  keep failing loud, unchanged. Built-in CRMs are byte-identical either way.
 *  The builtin-vendor validator surface is covered by
 *  `d-130-phase-7-crm-alias.test.ts`; this suite adds the pack + seam case. */

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildConnectionVendorEntity,
  CONNECTION_VENDOR_ENTITIES,
  setVendorAliasRegistryResolver,
  type ConnectionVendorEntity,
  type RecipeDefinition,
} from '@recued/contracts';
import { validateRecipe } from '../validate.js';

// A pack CRM in the live merged registry only (mirrors dynamics.json).
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

const base: RecipeDefinition = {
  recipe_id: 'd-192-unit3-validate',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'D-192 unit-3 validate',
    description: 'Recipe under test for the D-192 unit-3 pack-CRM alias validator seam.',
    author: 'recued',
    supported_platforms: ['gmail'],
    tags: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'noop', transform: 'concat', values: ['ok'] }],
  output: { sidebar: [{ type: 'summary', source: 'step.noop' }] },
};

const recipeWithRef = (ref: string): RecipeDefinition => ({
  ...base,
  steps: [{ id: 's', transform: 'concat', values: [`prefix-${ref}`] }],
});

const codes = (result: { issues: Array<{ code: string }> }): string[] =>
  result.issues.map((i) => i.code);

afterEach(() => setVendorAliasRegistryResolver(null));

describe('D-192 unit-3 — validator dispatches pack CRM aliases via the live registry', () => {
  const packCrmRef =
    '{{data.crm.contact.dynamics_contact_a99.enrichments.engagement_score_per_contact}}';
  const packVendorRef =
    '{{data.dynamics.contact.dynamics_contact_a99.enrichments.engagement_score_per_contact}}';

  it('UNBOUND: a pack CRM `data.crm.*` ref hard-errors crm_alias_unresolved (the bug)', () => {
    expect(codes(validateRecipe(recipeWithRef(packCrmRef)))).toContain('crm_alias_unresolved');
  });

  it('BOUND: the pack CRM ref DISPATCHES and its scope VALIDATES (unit-3 dispatch + the valid_scopes widening)', () => {
    setVendorAliasRegistryResolver(() => liveRegistry);
    const c = codes(validateRecipe(recipeWithRef(packCrmRef)));
    // unit-3 fixed the DISPATCH: the alias substrate sees the pack vendor.
    expect(c).not.toContain('crm_alias_unresolved');
    // The valid_scopes-widening follow-on (this task) landed: the validator now
    // runs the SAME `isEnrichmentScopeSupported` widening the store's write gate
    // does, so the pack CRM's contact scope (`connection.api.dynamics.contact`)
    // — a live-registry contact-family scope of a pack vendor — is accepted for a
    // contact-anchored topic. (Was the `enrichment_scope_unsupported` tripwire.)
    expect(c).not.toContain('enrichment_scope_unsupported');
  });

  it('UNBOUND: a pack per-vendor `data.<vendor>.*` alias silently fails to validate (not registered)', () => {
    // The D-129 per-vendor alias returns null when the vendor is not in the
    // registry — no hard error, but no scope tracked either. With the live
    // registry it dispatches and the scope is validated.
    const unbound = codes(validateRecipe(recipeWithRef(packVendorRef)));
    setVendorAliasRegistryResolver(() => liveRegistry);
    const bound = codes(validateRecipe(recipeWithRef(packVendorRef)));
    // Bound run touches the dynamics scope's read_connection hint; unbound
    // does not even recognise the alias.
    expect(bound).toContain('read_connection_permission_missing');
    expect(unbound).not.toContain('read_connection_permission_missing');
  });

  it('BOUND: an unknown crm_alias segment still hard-errors (dispatch is registry-driven, not blanket-pass)', () => {
    setVendorAliasRegistryResolver(() => liveRegistry);
    expect(
      codes(validateRecipe(recipeWithRef('{{data.crm.lead.dynamics_contact_a99.enrichments.foo}}'))),
    ).toContain('crm_alias_unknown');
  });

  it('built-in CRM validates identically whether the resolver is bound or unbound', () => {
    const builtinRef =
      '{{data.crm.contact.hubspot_contact_42.enrichments.engagement_score_per_contact}}';
    expect(codes(validateRecipe(recipeWithRef(builtinRef)))).not.toContain('crm_alias_unresolved');
    setVendorAliasRegistryResolver(() => liveRegistry);
    expect(codes(validateRecipe(recipeWithRef(builtinRef)))).not.toContain('crm_alias_unresolved');
  });
});
