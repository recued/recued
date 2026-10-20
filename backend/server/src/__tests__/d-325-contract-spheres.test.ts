import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SituationSnapshot } from '@recued/contracts';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { mintDoorContract } from '../mint-door-contract.js';
import { projectProactiveEvent } from '../situations/event-visibility.js';
import type { SituationReadContext } from '../situations/query.js';
import { situationRevisionEvent } from '../storage/situation-store.js';
import { createPrivateAiCall } from '../private-ai-call.js';
import { createClusterSummary } from '../situations/cluster-summary.js';
import { createMetaFieldPrivacyResolver } from '../meta-field-privacy-resolver.js';
import { CANONICAL_PII_ENTITY_PRIVACY_TAGS } from '../canonical-pii-schemas.js';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); }); afterEach(() => db.close());
const grants = { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true };
const context: SituationReadContext = { owner: false, spheres: ['professional'], grants, referenceSphere: () => 'professional' };
const snapshot = (): SituationSnapshot => {
  const evidence = [{ collection: 'asset', id: 'passport' }];
  const dim = <T>(value: T) => ({ value, verdict: 'match' as const, basis: 'declared' as const, evidence });
  return { id: 'trip', state: 'new', urgency: 'floor', cluster: { id: 'trip', subjects: evidence, span: null, omitted: 0, items: [{
    ref: evidence[0]!, kind: 'asset', what: dim('Private passport value'), when: dim(null), where: dim(null), who: dim(['Sam Rivera']),
    reasons: ['related'], basis: 'declared', evidence, consequence: 'floor', updated_at: 1, sphere: 'professional',
  }] } };
};

describe('D-325 contract sphere boundaries and retained choices', () => {
  it.each(['after', 'before', 'prior'])('withholds a hidden contact retained in the %s situation snapshot', part => {
    const after = snapshot(); after.cluster.items[0]!.who.value = [];
    const before = snapshot(); before.cluster.items[0]!.who.value = [];
    const hidden = snapshot(); hidden.cluster.items[0]!.who.value = ['private-person'];
    const event = situationRevisionEvent({ revision: 2, situation_id: 'trip', at: 2, cause: { source: 'fixture' }, changed_fields: ['cluster'],
      before: part === 'before' ? hidden : before, after: part === 'after' ? hidden : after });
    if (part === 'prior') event.prev = { ...event.prev, prior: hidden };
    const scoped = { ...context, referenceSphere: (ref: { collection: string }) => ref.collection === 'contact' ? 'personal' as const : 'professional' as const };
    const projected = projectProactiveEvent(event, grants, scoped);
    expect(JSON.stringify(projected)).not.toMatch(/private-person|Private passport value/);
  });
  it('withholds retained contact values when the subscriber lacks the contact grant', () => {
    const value = snapshot(); const denied = { ...grants, isCollectionReadGranted: (collection: string) => collection !== 'contact' };
    const event = situationRevisionEvent({ revision: 1, situation_id: 'trip', at: 1, cause: { source: 'fixture' }, changed_fields: ['cluster'], before: null, after: value });
    expect(JSON.stringify(projectProactiveEvent(event, denied, { owner: true, grants: denied }))).not.toContain('Sam Rivera');
  });
  it('retains a privacy scope through a real derived-door re-mint and intersects multiple predecessors', () => {
    const store = createContractStore(db); const definitionStore = createContractDefinitionStore(store);
    const mint = (read_spheres: ('personal' | 'professional')[]) => definitionStore.mint({ minted_by: 'owner', display_name: 'Scoped door', scope: {}, read_spheres });
    const work = mint(['professional']); const home = mint(['personal']);
    definitionStore.revoke(work.contract_id, 'rebound');
    const deps = { definitionStore, grantEntryStore: createContractGrantEntryStore(store), now: () => 10 };
    const capability = { operation_ids: ['core.situation.read'], ingredient_ids: [], connection_names: [] } as never;
    const replace = (ids: string[]) => mintDoorContract({ door: 'reception', recipeId: 'fixture', capability, mintedBy: 'owner', previousContractIds: ids }, deps).contract_id;
    expect(definitionStore.get(replace([work.contract_id]))?.read_spheres).toEqual(['professional']);
    expect(definitionStore.get(replace([work.contract_id, home.contract_id]))?.read_spheres).toEqual([]);
    expect(definitionStore.get(replace(['missing-old-door']))?.read_spheres).toEqual([]);
  });
  it('checks both asset snapshots and a retained prior before giving a scoped subscriber values', () => {
    const event = { platform: 'work', slug: 'asset', entity_type: 'item', event_kind: 'updated', record_id: 'asset', at: 1,
      changed_fields: ['sphere', 'document_number'], record: { sphere: 'professional', document_number: 'new-secret' },
      prev: { record: { sphere: 'personal', document_number: 'old-secret' } } } as const;
    expect(JSON.stringify(projectProactiveEvent(event as never, grants, context))).not.toContain('secret');
    const allowed = { ...event, prev: { record: { sphere: 'professional', document_number: 'old-secret' } } };
    expect(JSON.stringify(projectProactiveEvent(allowed as never, grants, context))).toContain('old-secret');
    expect(JSON.stringify(projectProactiveEvent({ ...allowed, prev: { ...allowed.prev, prior: { sphere: 'personal', document_number: 'oldest-secret' } } } as never, grants, context))).not.toContain('secret');
  });
  it('judges a scoped subscriber’s asset by its resolved placement, so a pin or a source placement counts', () => {
    const event = { platform: 'work', slug: 'asset', entity_type: 'item', event_kind: 'updated', record_id: 'car', at: 1,
      changed_fields: ['name'], record: { sphere: 'professional', document_number: 'secret' } } as const;
    // Pinned personal from Data: the record still carries its derived sphere.
    expect(JSON.stringify(projectProactiveEvent(event as never, grants, { ...context, referenceSphere: () => 'personal' }))).not.toContain('secret');
    // Unsorted on the record, professional through its source's placement.
    const placed = { ...event, record: { document_number: 'secret' } };
    expect(JSON.stringify(projectProactiveEvent(placed as never, grants, { ...context, referenceSphere: () => 'professional' }))).toContain('secret');
  });
  it('gives a scoped subscriber an asset without the references a scoped read strips', () => {
    const car = { id: 'car', name: 'Company car', sphere: 'professional', holder_contact: 'family@example.test', belongs_to: 'house',
      source_extension_blob: { vendor: 'raw' } };
    const event = { platform: 'work', slug: 'asset', entity_type: 'item', event_kind: 'updated', record_id: 'car', at: 1,
      changed_fields: ['name'], record: car, prev: { record: car, prior: car } } as const;
    const placement = (ref: { collection: string; id: string }) => ref.collection === 'asset' && ref.id === 'car' ? 'professional' as const : 'personal' as const;
    const projected = projectProactiveEvent(event as never, grants, { ...context, referenceSphere: placement });
    const text = JSON.stringify(projected);
    expect(text).toContain('Company car');
    expect(text).not.toMatch(/family@example\.test|"house"|vendor/u);
    expect(JSON.stringify(projectProactiveEvent(event as never, grants, { owner: true, grants }))).toContain('family@example.test');
  });
  it('withholds a situation when either snapshot, any evidence source, or an unknown sphere is outside the contract', () => {
    const after = snapshot(); const before = snapshot(); before.cluster.items[0]!.sphere = 'personal';
    const event = situationRevisionEvent({ revision: 2, situation_id: 'trip', at: 2, cause: { source: 'fixture' }, changed_fields: ['cluster'], before, after });
    expect(JSON.stringify(projectProactiveEvent(event, grants, context))).not.toContain('Private passport value');
    before.cluster.items[0]!.sphere = 'professional';
    expect(JSON.stringify(projectProactiveEvent({ ...event, prev: { ...event.prev, record: before } }, grants, context))).toContain('Private passport value');
    const denied = { ...grants, isCollectionReadGranted: (collection: string) => collection !== 'asset' };
    expect(JSON.stringify(projectProactiveEvent(event, denied, { ...context, grants: denied }))).not.toContain('Private passport value');
    const unknown = snapshot(); delete unknown.cluster.items[0]!.sphere;
    expect(JSON.stringify(projectProactiveEvent({ ...event, record: unknown as never }, grants, context))).not.toContain('Private passport value');
    expect(() => projectProactiveEvent({ ...event, record: { cluster: { items: [{}], subjects: [] } } }, grants, context)).not.toThrow();
  });
  it('runs the authority recheck after real privacy preparation and makes no provider call on a revoke', async () => {
    const execute = vi.fn(async () => ({ body: { highlight_position: 0 } }));
    const resolver = createMetaFieldPrivacyResolver({ getEntitySchemas: () => [], getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS });
    const call = createPrivateAiCall({ execute, resolver });
    const summary = createClusterSummary({ call, ready: () => 'any' });
    let checks = 0;
    await expect(summary(snapshot().cluster, () => ++checks === 1)).rejects.toThrow(/permissions changed/);
    expect(checks).toBe(2); expect(execute).not.toHaveBeenCalled();
  });
});
