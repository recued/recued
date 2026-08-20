/** D-120 Phase 3 — link-emission predicates + ref parsing.
 *
 *  Phase 3 ships:
 *    - `AccessKind` union + `EntityTouch` shape
 *    - `EmittedLink` structural carrier between engine + caller
 *    - `SIDECAR_COLLECTIONS` set + `isSidecarCollection`
 *    - `shouldLink` predicate (sidecar / foreach / scan filter)
 *    - `parseDataEntityRef` helper
 *
 *  All four are pure data + functions — engine wiring + server SQL
 *  insert paths are covered separately under `packages/engine/...`
 *  and `backend/server/src/__tests__/...`.
 */

import { describe, expect, it } from 'vitest';
import {
  isSidecarCollection,
  parseDataEntityRef,
  shouldLink,
  SIDECAR_COLLECTIONS,
  type AccessKind,
  type EmittedLink,
  type EntityTouch,
} from '../index.js';

describe('D-120 Phase 3 — sidecar collections', () => {
  it('treats annotation collection (singular + plural) as sidecar', () => {
    expect(isSidecarCollection('annotation')).toBe(true);
    expect(isSidecarCollection('annotations')).toBe(true);
  });

  it('treats link collection (singular + plural) as sidecar', () => {
    expect(isSidecarCollection('link')).toBe(true);
    expect(isSidecarCollection('links')).toBe(true);
  });

  it('does not classify warehouse collections as sidecar', () => {
    for (const col of ['mail', 'calendar', 'file', 'contact', 'deal', 'service']) {
      expect(isSidecarCollection(col)).toBe(false);
    }
  });

  it('exposes the registered set membership for inspection', () => {
    expect(SIDECAR_COLLECTIONS.has('annotation')).toBe(true);
    expect(SIDECAR_COLLECTIONS.has('mail')).toBe(false);
  });
});

describe('D-120 Phase 3 — shouldLink predicate', () => {
  const access: AccessKind = 'read';

  it('emits for ordinary read access on warehouse collection', () => {
    expect(shouldLink('mail', access)).toBe(true);
  });

  it('skips sidecar collections (annotation / link) regardless of access', () => {
    expect(shouldLink('annotation', 'read')).toBe(false);
    expect(shouldLink('annotation', 'write')).toBe(false);
    expect(shouldLink('link', 'read')).toBe(false);
    expect(shouldLink('annotations', 'read')).toBe(false);
  });

  it('skips foreach iteration reads (parent scan carries causality)', () => {
    expect(shouldLink('mail', 'foreach_item')).toBe(false);
    expect(shouldLink('deal', 'foreach_item')).toBe(false);
  });

  it('skips pure transform filter scans (derivable structurally)', () => {
    expect(shouldLink('mail', 'filter_scan')).toBe(false);
    expect(shouldLink('contact', 'filter_scan')).toBe(false);
  });

  it('emits write access on a warehouse collection', () => {
    expect(shouldLink('deal', 'write')).toBe(true);
  });
});

describe('D-120 Phase 3 — parseDataEntityRef', () => {
  it('parses a fully-qualified entity ref', () => {
    expect(parseDataEntityRef('data', 'mail.msg-abc.subject')).toEqual({
      collection: 'mail',
      entity_id: 'msg-abc',
    });
  });

  it('returns just (collection, id) for two-segment paths', () => {
    expect(parseDataEntityRef('data', 'deal.42')).toEqual({
      collection: 'deal',
      entity_id: '42',
    });
  });

  it('right-anchors dotted entity ids before sidecar tags', () => {
    expect(parseDataEntityRef('data', 'contact.john.doe@x.com.annotations.note')).toEqual({
      collection: 'contact',
      entity_id: 'john.doe@x.com',
    });
    expect(parseDataEntityRef('data', 'contact.john.doe@x.com.links')).toEqual({
      collection: 'contact',
      entity_id: 'john.doe@x.com',
    });
  });

  it('strips sidecar and field tails for non-dotted entity ids', () => {
    expect(parseDataEntityRef('data', 'mail.msg-abc.subject')).toEqual({
      collection: 'mail',
      entity_id: 'msg-abc',
    });
    expect(parseDataEntityRef('data', 'mail.msg-abc.annotations')).toEqual({
      collection: 'mail',
      entity_id: 'msg-abc',
    });
  });

  it('keeps single-segment entity ids when no sidecar tag is present', () => {
    expect(parseDataEntityRef('data', 'contact.some-id')).toEqual({
      collection: 'contact',
      entity_id: 'some-id',
    });
    expect(parseDataEntityRef('data', 'contact.some-id.profile.email')).toEqual({
      collection: 'contact',
      entity_id: 'some-id',
    });
  });

  it('returns null for collection-root refs without an entity id', () => {
    expect(parseDataEntityRef('data', 'mail')).toBeNull();
    expect(parseDataEntityRef('data', '')).toBeNull();
  });

  it('returns null for non-data namespaces', () => {
    expect(parseDataEntityRef('config', 'threshold')).toBeNull();
    expect(parseDataEntityRef('step', 'list_unread.0.id')).toBeNull();
    expect(parseDataEntityRef('vault', 'hubspot.token')).toBeNull();
    expect(parseDataEntityRef('shared', 'contact.some-id')).toBeNull();
    expect(parseDataEntityRef('audit', 'contact.some-id')).toBeNull();
    expect(parseDataEntityRef('memory', 'contact.some-id')).toBeNull();
  });

  // Round-12 audit fix (T1 § 8.2, driven from the dist build): 500 distinct
  // enrichment reads collapsed onto ONE provenance target because the parser
  // took `segs[1]` — the SCOPE — as the entity id. A derived-fact ref must key
  // on the record the fact is about.
  describe('derived-fact refs key on the record, not the scope', () => {
    it('keys an enrichment ref on the underlying record', () => {
      expect(parseDataEntityRef('data', 'enrichment.mail.msg-abc.summary')).toEqual({
        collection: 'mail',
        entity_id: 'msg-abc',
      });
      expect(
        parseDataEntityRef('data', 'enrichment.mail.msg-abc.summary.confidence'),
      ).toEqual({ collection: 'mail', entity_id: 'msg-abc' });
    });

    it('handles dotted target ids via the topic anchor', () => {
      expect(
        parseDataEntityRef('data', 'enrichment.contact.jane.doe@x.com.behavioral_signature'),
      ).toEqual({ collection: 'contact', entity_id: 'jane.doe@x.com' });
    });

    it('returns null — not a scope-collapsed pair — for platform-reference scopes', () => {
      // D-128 platform-reference rows live on the vendor, not in a local
      // warehouse collection; a missing edge is honest, a mis-keyed one is not.
      expect(
        parseDataEntityRef('data', 'enrichment.connection.api.hubspot.deal.d-1.deal_health_score'),
      ).toBeNull();
    });

    it('returns null for topic-less or malformed enrichment refs', () => {
      expect(parseDataEntityRef('data', 'enrichment.mail.msg-abc')).toBeNull();
      expect(parseDataEntityRef('data', 'enrichment.mail')).toBeNull();
      expect(parseDataEntityRef('data', 'enrichment')).toBeNull();
      expect(parseDataEntityRef('data', 'enrichment.mail.not_a_registry_topic_x')).toBeNull();
    });

    it('returns null for vendor read-side aliases and the crm lens', () => {
      expect(
        parseDataEntityRef('data', 'crm.deal.hubspot_deal_1.enrichments.deal_health_score'),
      ).toBeNull();
      expect(
        parseDataEntityRef('data', 'hubspot.deal.d-1.enrichments.deal_health_score'),
      ).toBeNull();
      expect(
        parseDataEntityRef('data', 'salesforce.opportunity.o-1.enrichments.deal_health_score'),
      ).toBeNull();
      // Fail-closed backstop: a vendor alias namespace added AFTER the literal
      // list still short-circuits on the alias grammar's own `enrichments` marker.
      expect(
        parseDataEntityRef('data', 'pipedrive.deal.d-9.enrichments.deal_health_score'),
      ).toBeNull();
    });
  });

  it('skips the D-103 user-writable data.shared.* tier', () => {
    expect(parseDataEntityRef('data', 'shared.deal.42')).toBeNull();
  });

  it('skips memory + audit (non-warehouse data namespaces)', () => {
    expect(parseDataEntityRef('data', 'memory.run-1')).toBeNull();
    expect(parseDataEntityRef('data', 'audit.run-1')).toBeNull();
  });
});

describe('D-120 Phase 3 — EntityTouch / EmittedLink shape', () => {
  it('EntityTouch carries collection + entity_id + access', () => {
    const t: EntityTouch = {
      collection: 'mail',
      entity_id: 'msg-1',
      access: 'read',
    };
    expect(t.collection).toBe('mail');
    expect(t.access).toBe('read');
  });

  it('EmittedLink carries kind + step_id + ts alongside the touch fields', () => {
    const link: EmittedLink = {
      step_id: 'classify',
      collection: 'mail',
      entity_id: 'msg-1',
      access: 'read',
      kind: 'execution.action',
      ts: 1714099200000,
    };
    expect(link.kind).toBe('execution.action');
    expect(link.step_id).toBe('classify');
  });
});
