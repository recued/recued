/** D-129 Phase 7 — Read-side alias resolver (contracts substrate).
 *
 *  Substrate-level assertions:
 *    - `matchVendorEnrichmentAlias` rewrites `<vendor>.<entity>.<id>[.<rest>]`
 *      onto canonical `enrichment.connection.api.<vendor>.<entity>.<id>[.<rest>]`
 *      across all three D-129 entities (deal / contact / company).
 *    - target_id segments carrying dots / `@` (canonical-email contact ids)
 *      survive the cut intact via the `lastIndexOf` boundary walk.
 *    - bag form (no `<topic>`) rewrites to canonical bag form.
 *    - bare-entity refs (no `.enrichments` suffix) are NOT rewritten —
 *      the alias is enrichment-only per spec §A.7 decision §5.
 *    - unregistered vendor / entity combinations do not rewrite.
 *    - `tryRewriteVendorEnrichmentAlias` returns null on non-aliases.
 *    - `assertNoVendorPrefixClash` flags vendors that shadow reserved
 *      `data.*` sub-namespaces.
 *    - the runtime resolver collapses alias-form refs onto the
 *      canonical store at `parseRef` boundary so authors can address
 *      the same enrichment with either path.
 */

import { describe, expect, it } from 'vitest';
import {
  RESERVED_DATA_SUBNAMESPACES,
  assertNoVendorPrefixClash,
  buildConnectionVendorEntity,
  collectRefs,
  matchVendorEnrichmentAlias,
  resolveRef,
  tryRewriteVendorEnrichmentAlias,
  type ConnectionVendorEntity,
  type NamespaceStores,
} from '../index.js';

describe('D-129 Phase 7 — vendor enrichment alias rewrite', () => {
  it('returns null when the path is missing the `.enrichments` marker', () => {
    // `data.hubspot.deal.<id>.<topic>` (no `.enrichments` segment) is
    // NOT a recognised alias — bare-entity reads go through the
    // connection adapter, not through this rewrite.
    const m = matchVendorEnrichmentAlias(
      'hubspot.deal.47291.attribution_signal',
    );
    expect(m).toBeNull();
  });

  it('rewrites a deal alias with `.enrichments.<topic>` suffix', () => {
    const m = matchVendorEnrichmentAlias(
      'hubspot.deal.47291.enrichments.attribution_signal',
    );
    expect(m).not.toBeNull();
    expect(m!.vendor).toBe('hubspot');
    expect(m!.entity).toBe('deal');
    expect(m!.targetId).toBe('47291');
    expect(m!.rest).toBe('attribution_signal');
    expect(m!.canonicalPostData).toBe(
      'enrichment.connection.api.hubspot.deal.47291.attribution_signal',
    );
  });

  it('rewrites with topic + drill', () => {
    const m = matchVendorEnrichmentAlias(
      'hubspot.deal.47291.enrichments.attribution_signal.first_touch_source',
    );
    expect(m!.canonicalPostData).toBe(
      'enrichment.connection.api.hubspot.deal.47291.attribution_signal.first_touch_source',
    );
    expect(m!.rest).toBe('attribution_signal.first_touch_source');
  });

  it('rewrites a contact alias with canonical-email target_id', () => {
    const m = matchVendorEnrichmentAlias(
      'hubspot.contact.bob@x.com.enrichments.engagement_score_per_contact.score',
    );
    expect(m!.vendor).toBe('hubspot');
    expect(m!.entity).toBe('contact');
    expect(m!.targetId).toBe('bob@x.com');
    expect(m!.rest).toBe('engagement_score_per_contact.score');
    expect(m!.canonicalPostData).toBe(
      'enrichment.connection.api.hubspot.contact.bob@x.com.engagement_score_per_contact.score',
    );
  });

  it('rewrites a company alias', () => {
    const m = matchVendorEnrichmentAlias(
      'hubspot.company.99001.enrichments.lifecycle_stage_inferred',
    );
    expect(m!.canonicalPostData).toBe(
      'enrichment.connection.api.hubspot.company.99001.lifecycle_stage_inferred',
    );
  });

  it('rewrites the bag form (no topic) onto canonical bag', () => {
    const m = matchVendorEnrichmentAlias(
      'hubspot.deal.47291.enrichments',
    );
    expect(m!.targetId).toBe('47291');
    expect(m!.rest).toBe('');
    expect(m!.canonicalPostData).toBe(
      'enrichment.connection.api.hubspot.deal.47291',
    );
  });

  it('walks back to the next-earlier `.enrichments` when the rightmost match has no boundary', () => {
    // `enrichments_v2` is part of the rest, not the marker; the
    // marker is the EARLIER `.enrichments` (followed by `.`).
    const m = matchVendorEnrichmentAlias(
      'hubspot.deal.47291.enrichments.foo.enrichments_v2.bar',
    );
    expect(m!.targetId).toBe('47291');
    expect(m!.rest).toBe('foo.enrichments_v2.bar');
  });

  it('handles a target_id that contains an unrelated `enrichments` substring (no leading dot)', () => {
    // `team@enrichments.com` is the canonical email — the `enrichments`
    // substring in it has no leading `.` so `lastIndexOf` only finds
    // the real marker before `.engagement_score`.
    const m = matchVendorEnrichmentAlias(
      'hubspot.contact.team@enrichments.com.enrichments.engagement_score_per_contact.score',
    );
    expect(m!.targetId).toBe('team@enrichments.com');
    expect(m!.rest).toBe('engagement_score_per_contact.score');
  });
});

describe('D-129 Phase 7 — alias non-matches', () => {
  it('returns null for the bare entity (no `.enrichments` suffix)', () => {
    expect(matchVendorEnrichmentAlias('hubspot.deal.47291')).toBeNull();
    expect(tryRewriteVendorEnrichmentAlias('hubspot.deal.47291')).toBeNull();
  });

  it('returns null for an unregistered vendor', () => {
    expect(
      matchVendorEnrichmentAlias('unknownvendor.deal.42.enrichments.foo'),
    ).toBeNull();
  });

  it('returns null for a registered vendor with an unregistered entity', () => {
    expect(
      matchVendorEnrichmentAlias('hubspot.foobar.42.enrichments.score'),
    ).toBeNull();
  });

  it('returns null for warehouse + memory paths', () => {
    expect(matchVendorEnrichmentAlias('mail.msg-1.subject')).toBeNull();
    expect(matchVendorEnrichmentAlias('memory.run-1.commit_status')).toBeNull();
    expect(matchVendorEnrichmentAlias('shared.deal.42')).toBeNull();
  });

  it('returns null for canonical paths (handled by the enrichment scanner)', () => {
    expect(
      matchVendorEnrichmentAlias(
        'enrichment.connection.api.hubspot.deal.47291.attribution_signal',
      ),
    ).toBeNull();
  });

  it('returns null when the alias has no target_id (`.enrichments` immediately after entity)', () => {
    expect(matchVendorEnrichmentAlias('hubspot.deal..enrichments.foo')).toBeNull();
  });

  it('returns null when vendor / entity segment fails the identifier regex', () => {
    expect(matchVendorEnrichmentAlias('Hubspot.deal.42.enrichments.x')).toBeNull();
    expect(matchVendorEnrichmentAlias('hubspot.Deal.42.enrichments.x')).toBeNull();
    expect(matchVendorEnrichmentAlias('1hub.deal.42.enrichments.x')).toBeNull();
  });
});

describe('D-129 Phase 7 — runtime resolver collapse', () => {
  // Canonical store seeded as if the per-pair enrichment store hydrated
  // the runtime — the alias-form ref must walk into the same record.
  // (Email-keyed contact ids carry dots that `walkPath` can't traverse
  // through naive dot-splitting; canonical-email contact rows are
  // surfaced via `enrichmentOrFetch` rather than `resolveRef`. The
  // path-level rewrite is covered by the matcher tests above; runtime
  // tests use dot-free target_ids to exercise `walkPath`.)
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
              deal: {
                '47291': {
                  attribution_signal: {
                    direction: 'inbound',
                    first_touch_source: 'partner-referral',
                  },
                  meta: { name: 'Acme Q3 expansion', amount: 50_000 },
                },
              },
              contact: {
                'c-77': {
                  engagement_score_per_contact: {
                    score: 72,
                    trajectory: 'rising',
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  it('alias deal-topic ref resolves to the canonical record', () => {
    expect(
      resolveRef(
        '{{data.hubspot.deal.47291.enrichments.attribution_signal}}',
        stores,
      ),
    ).toEqual({ direction: 'inbound', first_touch_source: 'partner-referral' });
  });

  it('alias and canonical resolve to the same record', () => {
    const aliasResult = resolveRef(
      '{{data.hubspot.deal.47291.enrichments.attribution_signal.first_touch_source}}',
      stores,
    );
    const canonicalResult = resolveRef(
      '{{data.enrichment.connection.api.hubspot.deal.47291.attribution_signal.first_touch_source}}',
      stores,
    );
    expect(aliasResult).toBe('partner-referral');
    expect(aliasResult).toBe(canonicalResult);
  });

  it('alias on a contact id resolves through the canonical store', () => {
    expect(
      resolveRef(
        '{{data.hubspot.contact.c-77.enrichments.engagement_score_per_contact.score}}',
        stores,
      ),
    ).toBe(72);
  });

  it('alias `meta.<field>` drill resolves to the canonical meta snapshot', () => {
    // Decision §5 in P7 close: `meta` is a sibling field on the
    // enrichment row, accessed via `<topic>.meta.<field>`. The alias
    // rewrites onto canonical and `walkPath` traverses the same tree.
    expect(
      resolveRef(
        '{{data.hubspot.deal.47291.enrichments.attribution_signal.first_touch_source}}',
        stores,
      ),
    ).toBe('partner-referral');
  });

  it('returns undefined for a missing alias entry', () => {
    expect(
      resolveRef(
        '{{data.hubspot.deal.99999.enrichments.attribution_signal}}',
        stores,
      ),
    ).toBeUndefined();
  });

  it('does not rewrite the bare entity (alias is enrichment-only)', () => {
    // `data.hubspot.deal.47291` walks the (empty) `data.hubspot` store
    // and resolves to undefined — the alias ONLY fires when the path
    // contains `.enrichments`. This is the spec §A.7 decision §5
    // contract.
    expect(
      resolveRef('{{data.hubspot.deal.47291}}', stores),
    ).toBeUndefined();
  });

  it('collectRefs collapses an alias ref onto the canonical path (works for email ids too)', () => {
    // collectRefs runs the same `parseRef` collapse `resolveRef` does,
    // so the path-level alias rewrite is observable for any
    // target_id shape — including canonical-email contact ids whose
    // dots would otherwise be split during walkPath traversal.
    const refs = collectRefs({
      a: '{{data.hubspot.contact.bob@x.com.enrichments.engagement_score_per_contact.score}}',
      b: '{{data.enrichment.connection.api.hubspot.contact.bob@x.com.engagement_score_per_contact.score}}',
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      ns: 'data',
      path: 'enrichment.connection.api.hubspot.contact.bob@x.com.engagement_score_per_contact.score',
    });
  });
});

describe('D-129 Phase 7 — reserved-prefix clash detection', () => {
  it('exposes the reserved set as a closed list', () => {
    expect(RESERVED_DATA_SUBNAMESPACES.has('memory')).toBe(true);
    expect(RESERVED_DATA_SUBNAMESPACES.has('mail')).toBe(true);
    expect(RESERVED_DATA_SUBNAMESPACES.has('enrichment')).toBe(true);
    expect(RESERVED_DATA_SUBNAMESPACES.has('hubspot')).toBe(false);
  });

  it('flags a vendor entry whose name shadows a reserved sub-namespace', () => {
    const bogus: ConnectionVendorEntity = buildConnectionVendorEntity({
      vendor: 'mail',
      entity: 'message',
      display_name: 'Mail Message (BOGUS)',
      meta_fields: [{ key: 'name', type: 'string', description: 'placeholder' }],
    });
    const issues = assertNoVendorPrefixClash([bogus]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/vendor 'mail' shadows a reserved data\.\* sub-namespace/);
    expect(issues[0]).toMatch(/data\.mail\.<entity>\.<id>\.enrichments\.<topic>' would clash/);
  });

  it('passes a registry whose vendors do not shadow reserved sub-namespaces', () => {
    const ok: ConnectionVendorEntity = buildConnectionVendorEntity({
      vendor: 'hubspot',
      entity: 'deal',
      display_name: 'HubSpot Deal',
      meta_fields: [{ key: 'name', type: 'string', description: 'placeholder' }],
    });
    expect(assertNoVendorPrefixClash([ok])).toEqual([]);
  });

  it('flags multiple shadowing entries with their indexes', () => {
    const a: ConnectionVendorEntity = buildConnectionVendorEntity({
      vendor: 'memory',
      entity: 'entry',
      display_name: 'Memory entry (BOGUS)',
      meta_fields: [{ key: 'name', type: 'string', description: 'placeholder' }],
    });
    const b: ConnectionVendorEntity = buildConnectionVendorEntity({
      vendor: 'enrichment',
      entity: 'topic',
      display_name: 'Enrichment topic (BOGUS)',
      meta_fields: [{ key: 'name', type: 'string', description: 'placeholder' }],
    });
    const issues = assertNoVendorPrefixClash([a, b]);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/^\[0\] vendor 'memory'/);
    expect(issues[1]).toMatch(/^\[1\] vendor 'enrichment'/);
  });
});
