import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatDispatchContext, PiiAliasableData } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema, type WorkEntityStore } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { runWorkEntityReadTool, runWorkEntitySearchTool, type WorkEntityReadToolsDeps } from '../work-entity-read-tools.js';
import { createMetaFieldPrivacyResolverFromLocalManifestStore } from '../meta-field-privacy-resolver.js';
import { CANONICAL_PII_ENTITY_PRIVACY_TAGS, CANONICAL_PII_ENTITY_SCHEMAS } from '../canonical-pii-schemas.js';
import { piiEgress } from '@recued/gateway';
import { createLedger } from '@recued/transforms';

let db: Database.Database; let work: WorkEntityStore;
const ctx = { execution_source: { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'fixture' } } as ChatDispatchContext;
beforeEach(() => { db = new Database(':memory:'); ensureWorkEntitySchema(db); work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work); });
afterEach(() => db.close());
const deps = (): WorkEntityReadToolsDeps => ({ getResolver: () => createWorkEntityResolver(work), getTargetedReadDeps: () => undefined,
  isCollectionReadGranted: () => true, isVerbOpGranted: () => true });

describe('D-325 native asset read and chat privacy seam', () => {
  it('searches with actual name/status and reads optional identifying strings raw under both grants', async () => {
    const asset = work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture' }, name: 'Passport',
      document_number: '00123 / anything', serial_number: 'device:001', exact_address: '14 Cedar Avenue', dates: { expires_on: '2028-02-29' } });
    const search = await runWorkEntitySearchTool(deps(), { kind: 'asset', query: 'Passport' }, ctx);
    expect(search).toMatchObject({ ok: true, result: { entities: [{ name: 'Passport', title: 'Passport', status: 'active' }] } });
    expect(JSON.stringify(search)).not.toContain('00123');
    const read = await runWorkEntityReadTool(deps(), { kind: 'asset', id: asset.id }, ctx);
    expect(read).toMatchObject({ ok: true, result: { entity: { name: 'Passport', __entity: 'asset', document_number: asset.document_number,
      serial_number: asset.serial_number, exact_address: asset.exact_address, dates: asset.dates } } });
    const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore({ slugs: () => [], getEntitySchemas: () => [], getManifest: () => null },
      CANONICAL_PII_ENTITY_SCHEMAS, undefined, CANONICAL_PII_ENTITY_PRIVACY_TAGS);
    const packet = { prior_tool_calls: [{ tool_name: 'work.read', result: read.ok ? read.result : {} }] } as PiiAliasableData;
    const tags = resolver(packet);
    expect(tags).toContainEqual({ path: 'prior_tool_calls.0.result.entity.document_number', kind: 'external_id' });
    expect(tags).toContainEqual({ path: 'prior_tool_calls.0.result.entity.serial_number', kind: 'external_id' });
    expect(tags.some(tag => tag.path === 'prior_tool_calls.0.result.entity.exact_address' && tag.kind === 'address')).toBe(true);
  });

  it('aliases each anchor’s place, coordinates and identifier wherever it sits in the list', async () => {
    const asset = work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture' }, name: 'Car', anchors: [
      { kind: 'identifier', scheme: 'vin', value: '1HGCM82633A004352' },
      { kind: 'place', name: 'Cedar garage', address: '14 Cedar Avenue', latitude: 51.50722, longitude: -0.12751 },
      { kind: 'instrument', identifier: 'GB00B03MLX29', quantity: 3 },
    ] });
    const read = await runWorkEntityReadTool(deps(), { kind: 'asset', id: asset.id }, ctx);
    const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore({ slugs: () => [], getEntitySchemas: () => [], getManifest: () => null },
      CANONICAL_PII_ENTITY_SCHEMAS, undefined, CANONICAL_PII_ENTITY_PRIVACY_TAGS);
    const packet = { prior_tool_calls: [{ tool_name: 'work.read', result: read.ok ? read.result : {} }] } as PiiAliasableData;
    const shown = JSON.stringify(piiEgress.aliasPacketForEgress({ ledger: createLedger('fixture'), packet, resolver }).aliased);
    for (const raw of ['1HGCM82633A004352', 'Cedar garage', '14 Cedar Avenue', '51.50722', '-0.12751', 'GB00B03MLX29']) expect(shown).not.toContain(raw);
    expect(shown).toContain('"scheme":"vin"'); expect(shown).toContain('"quantity":3');
  });
});
