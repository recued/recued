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
import { createContactStore } from '../storage/contact-store.js';
import { situationPersonName } from '../situations/model-projection.js';
import { workEntityReadToolsDeps, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createPiiEgressPlanForSession, wrapExecuteAiCallForPii } from '../chat-pii-egress.js';
import { createMetaFieldPrivacyResolver } from '../meta-field-privacy-resolver.js';
import { createContactKnownValueIndexBuilder } from '../chat-recall-index.js';

let db: Database.Database; let work: WorkEntityStore;
const ctx = { execution_source: { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'fixture' } } as ChatDispatchContext;
beforeEach(() => { db = new Database(':memory:'); ensureWorkEntitySchema(db); work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work); });
afterEach(() => db.close());
const deps = (): WorkEntityReadToolsDeps => ({ getResolver: () => createWorkEntityResolver(work), getTargetedReadDeps: () => undefined,
  isCollectionReadGranted: () => true, isVerbOpGranted: () => true });

describe('D-325 native asset read and chat privacy seam', () => {
  it('names the holder beside the id as the person the model was asked about, within the caller\'s reach', async () => {
    // `holder_contact` is a contact id: beside "Ana’s passport" it could not tell a model
    // that the holder is the `pii.Person2` it was asked about (the same split as `who`).
    const contacts = createContactStore(db); const ana = contacts.upsertManual({ email: 'ana.lin@example.test', name: 'Ana Lin' }, 1);
    const asset = work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture' }, name: 'Ana’s passport',
      holder_contact: ana.contact_id! });
    /** The read scope's shape (`createReadScope`): the owner's, a contract without contact
     *  grants, or one restricted to spheres the holder's contact is not in. */
    const scope = (kind: 'owner' | 'no contact grants' | 'contact out of reach') => ({ limited: kind === 'contact out of reach',
      context: { owner: kind !== 'contact out of reach', grants: { isVerbOpGranted: () => kind !== 'no contact grants',
        isCollectionReadGranted: (collection: string) => collection !== 'contact' || kind !== 'no contact grants', isTopicReadGranted: () => true } },
      allows: (ref: { collection: string }) => ref.collection !== 'contact', cleanWork: <T,>(row: T) => row });
    const read = (kind?: Parameters<typeof scope>[0]) => runWorkEntityReadTool({ ...deps(), personName: situationPersonName(contacts),
      ...(kind ? { getReadScope: () => scope(kind) as never } : {}) }, { kind: 'asset', id: asset.id }, ctx);
    const owned = await read('owner');
    expect(owned).toMatchObject({ ok: true, result: { entity: { holder_contact: ana.contact_id, holder_name: 'Ana Lin' } } });
    for (const kind of ['no contact grants', 'contact out of reach', undefined] as const) {
      const result = await read(kind);
      expect(result.ok, String(kind)).toBe(true);
      expect(JSON.stringify(result), String(kind)).not.toContain('Ana Lin');
    }
    // The chat's own wiring names the holder from its contact store.
    expect(workEntityReadToolsDeps({ getContactStore: () => contacts } as unknown as ChatToolHandlerDeps).personName?.(ana.contact_id!)).toBe('Ana Lin');
    // Through the chat's real egress plan: one alias for the question and the holder.
    const plan = createPiiEgressPlanForSession({ ledgerStore: piiEgress.createSessionLedgerStore(),
      resolver: createMetaFieldPrivacyResolver({ getEntitySchemas: () => [], getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS }),
      getContactKnownValueIndex: createContactKnownValueIndexBuilder(() => contacts) }, 's', 'chat');
    let sent = '';
    await wrapExecuteAiCallForPii(async (_manifest, request) => { sent = String(request['llm.prompt']); return { body: { response: 'ok', events: [], tool_calls: [] } }; }, plan)(
      {} as never, { 'llm.prompt': JSON.stringify({ user_message: 'Ana Lin flies on Monday. Is her passport valid?',
        prior_tool_calls: [{ tool_name: 'work.read', tier: 1, args: {}, status: 'ok', result: owned.ok ? owned.result : {} }] }) });
    expect(sent).not.toMatch(/Ana Lin|ana\.lin@example\.test/u);
    const packet = JSON.parse(sent) as { user_message: string; prior_tool_calls: Array<{ result: { entity: { holder_name: string; holder_contact: string } } }> };
    const holder = packet.prior_tool_calls[0]!.result.entity;
    expect(holder.holder_name).toMatch(/^pii\.Person\d+$/u);
    expect(packet.user_message).toBe(`${holder.holder_name} flies on Monday. Is her passport valid?`);
  });

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

  it('scans what the owner typed into settings and attributes as content, as a situation’s details are scanned', async () => {
    const asset = work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture' }, name: 'Passport',
      settings: { nationality: 'CN', reminders_muted: false }, attributes: { lent_to: 'Lent to Sam Rivera', copies: 2, notes: { kept_by: 'Sam Rivera' } } });
    const read = await runWorkEntityReadTool(deps(), { kind: 'asset', id: asset.id }, ctx);
    const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore({ slugs: () => [], getEntitySchemas: () => [], getManifest: () => null },
      CANONICAL_PII_ENTITY_SCHEMAS, undefined, CANONICAL_PII_ENTITY_PRIVACY_TAGS);
    // The same turn names Sam Rivera as a person elsewhere: a contact the model read.
    const packet = { prior_tool_calls: [{ tool_name: 'contact.read', result: { __entity: 'contact', name: 'Sam Rivera' } },
      { tool_name: 'work.read', result: read.ok ? read.result : {} }] } as PiiAliasableData;
    expect(resolver(packet)).toEqual(expect.arrayContaining([{ path: 'prior_tool_calls.1.result.entity.attributes', kind: 'content' },
      { path: 'prior_tool_calls.1.result.entity.settings', kind: 'content' }]));
    const shown = JSON.stringify(piiEgress.aliasPacketForEgress({ ledger: createLedger('fixture'), packet, resolver }).aliased);
    expect(shown).not.toContain('Sam Rivera'); expect(shown).toContain('"lent_to":"Lent to pii.');
    expect(shown).toContain('"kept_by":"pii.'); expect(shown).toContain('"copies":2');
    expect(shown).toContain('"nationality":"CN"'); expect(shown).toContain('"reminders_muted":false');
  });
});

describe('D-325 asset search by its holder\'s name', () => {
  // Live (2026-10-24, qwen3.7-plus), "Open Maya Chen's passport record" was searched as
  // "Maya Chen" and "Maya Chen passport": both found nothing, though she holds one.
  const ownerOrigin = { origin_actor: 'user_self' as const, origin_surface: 'client_rpc' as const };
  const grants = { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true };
  /** The read scope's shape (`createReadScope`) for the owner, and the ways a caller
   *  may not be told who holds what. */
  const scopes = {
    owner: { limited: false, context: { owner: true, grants }, allows: () => true, cleanWork: <T,>(row: T) => row },
    'no contact read': { limited: false, context: { owner: false, grants: { ...grants, isCollectionReadGranted: (collection: string) => collection !== 'contact' } },
      allows: () => true, cleanWork: <T,>(row: T) => row },
    'no contact verb': { limited: false, context: { owner: false, grants: { ...grants, isVerbOpGranted: () => false } }, allows: () => true, cleanWork: <T,>(row: T) => row },
    'contact out of reach': { limited: true, context: { owner: false, grants }, allows: (ref: { collection: string }) => ref.collection !== 'contact',
      cleanWork: <T,>(row: T) => row },
  };
  /** Two assets both named "Passport": only each one's holder says whose it is. */
  const passports = () => {
    const contacts = createContactStore(db);
    const maya = contacts.upsertManual({ email: 'maya.chen@example.test', name: 'Maya Chen' }, 1);
    const lena = contacts.upsertManual({ email: 'lena.park@example.test', name: 'Lena Park' }, 1);
    const passport = (holder: string, now: number) => work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture' },
      name: 'Passport', holder_contact: holder }, now);
    passport(maya.contact_id!, 10); passport(lena.contact_id!, 20);
    return { contacts, maya };
  };
  const search = (contacts: ReturnType<typeof createContactStore>, args: Record<string, unknown>, scope?: keyof typeof scopes) =>
    runWorkEntitySearchTool({ ...deps(), personName: situationPersonName(contacts), ...(scope ? { getReadScope: () => scopes[scope] as never } : {}) }, args, ctx);
  type Found = { total: number; hint?: string; entities: Array<{ title?: string; holder_name?: string }> };
  const found = (result: Awaited<ReturnType<typeof search>>): Found => {
    if (!result.ok) throw new Error(`search failed: ${JSON.stringify(result)}`);
    return result.result as Found;
  };
  const holders = (result: Awaited<ReturnType<typeof search>>) => found(result).entities.map(entity => entity.holder_name);

  it('takes the holder\'s name with the asset\'s own words, every word in one or the other, and names each holder', async () => {
    const { contacts } = passports();
    expect(holders(await search(contacts, { kind: 'asset', query: 'Maya Chen passport' }, 'owner'))).toEqual(['Maya Chen']);
    expect(holders(await search(contacts, { kind: 'asset', query: 'Maya' }, 'owner'))).toEqual(['Maya Chen']);
    // The index's own grammar: a trailing `*` matches a prefix of the name too.
    expect(holders(await search(contacts, { kind: 'asset', query: 'Len*' }, 'owner'))).toEqual(['Lena Park']);
    // Found by its title alone, each still says whose it is (newest first).
    expect(holders(await search(contacts, { kind: 'asset', query: 'passport' }, 'owner'))).toEqual(['Lena Park', 'Maya Chen']);
    // ALL the words, as for any search: a word in neither finds nothing.
    const neither = found(await search(contacts, { kind: 'asset', query: 'Maya Chen visa' }, 'owner'));
    expect(neither.total).toBe(0); expect(neither.hint).toContain('2 asset(s) exist');
  });

  it('matches and names a holder only for a caller who may read that contact', async () => {
    const { contacts, maya } = passports();
    for (const scope of ['no contact read', 'no contact verb', 'contact out of reach', undefined] as const) {
      const byName = await search(contacts, { kind: 'asset', query: 'Maya Chen passport' }, scope);
      expect(found(byName).total, String(scope)).toBe(0);
      const byTitle = await search(contacts, { kind: 'asset', query: 'passport' }, scope);
      expect(found(byTitle).total, String(scope)).toBe(2);
      // The miss hint echoes the query as sent, so the leak to look for is a holder.
      expect(JSON.stringify([byName, byTitle]), String(scope)).not.toMatch(/holder_name|Lena Park/u);
    }
    // A holder the owner marked is named nowhere, so no search finds her by name.
    contacts.upsertManual({ email: maya.email, privacy_marks: ['hidden'] }, 2, ownerOrigin);
    expect(found(await search(contacts, { kind: 'asset', query: 'Maya' }, 'owner')).total).toBe(0);
    expect(holders(await search(contacts, { kind: 'asset', query: 'passport' }, 'owner'))).toEqual(['Lena Park', undefined]);
  });

  it('points a search of another kind at the asset the holder\'s name finds', async () => {
    const { contacts } = passports();
    expect(found(await search(contacts, { kind: 'note', query: 'Maya Chen passport' }, 'owner')).hint)
      .toContain('The same words match 1 asset: search with kind "asset"');
    expect(JSON.stringify(await search(contacts, { kind: 'note', query: 'Maya Chen passport' }, 'no contact read'))).not.toContain('match 1 asset');
  });

  it('sends the holder\'s name as the alias the question gave her, through the chat\'s real egress plan', async () => {
    const { contacts } = passports();
    const result = await search(contacts, { kind: 'asset', query: 'Maya Chen passport' }, 'owner');
    const plan = createPiiEgressPlanForSession({ ledgerStore: piiEgress.createSessionLedgerStore(),
      resolver: createMetaFieldPrivacyResolver({ getEntitySchemas: () => [], getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS }),
      getContactKnownValueIndex: createContactKnownValueIndexBuilder(() => contacts) }, 's', 'chat');
    let sent = '';
    await wrapExecuteAiCallForPii(async (_manifest, request) => { sent = String(request['llm.prompt']); return { body: { response: 'ok', events: [], tool_calls: [] } }; }, plan)(
      {} as never, { 'llm.prompt': JSON.stringify({ user_message: 'Maya Chen flies on Monday. Is her passport valid?',
        prior_tool_calls: [{ tool_name: 'work.search', tier: 1, args: { kind: 'asset', query: 'Maya Chen passport' }, status: 'ok', result: result.ok ? result.result : {} }] }) });
    expect(sent).not.toMatch(/Maya Chen|maya\.chen@example\.test/u);
    const packet = JSON.parse(sent) as { user_message: string; prior_tool_calls: Array<{ result: { entities: Array<{ holder_name: string }> } }> };
    const alias = packet.prior_tool_calls[0]!.result.entities[0]!.holder_name;
    expect(alias).toMatch(/^pii\.Person\d+(?:\.\S+)?$/u);
    expect(packet.user_message).toBe(`${alias} flies on Monday. Is her passport valid?`);
  });
});

it('binds asset citations to a successful current read and changes the version after an owner correction', async () => {
  const asset = work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture' }, name: 'Hose', attributes: { length: 'about 25 meters' } });
  const first = await runWorkEntityReadTool(deps(), { kind: 'asset', id: asset.id }, ctx);
  expect(first).toMatchObject({ ok: true, source_citations: [{ kind: 'asset', asset_id: asset.id, label: 'Hose' }],
    result: { source_ref: expect.stringMatching(/^#source\/src_[a-f0-9]{24}$/u) } });
  if (!first.ok) throw new Error('Expected read');
  work.writeAsset({ ...asset, source: { kind: 'owner', ref: 'correction' }, attributes: { length: 'around 31 meters' } });
  const second = await runWorkEntityReadTool(deps(), { kind: 'asset', id: asset.id }, ctx);
  if (!second.ok) throw new Error('Expected corrected read');
  expect(second.source_citations?.[0]?.read_version).not.toBe(first.source_citations?.[0]?.read_version);
  expect(second.source_citations?.[0]?.id).not.toBe(first.source_citations?.[0]?.id);
  const denied = await runWorkEntityReadTool({ ...deps(), isCollectionReadGranted: () => false }, { kind: 'asset', id: asset.id }, ctx);
  expect(denied).not.toHaveProperty('source_citations');
  expect(await runWorkEntityReadTool(deps(), { kind: 'asset', id: 'missing' }, ctx)).not.toHaveProperty('source_citations');
});
