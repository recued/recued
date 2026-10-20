import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNER_CONTRACT_ID, parseSituationQueryInput, ownerOnlyAdjustedAuthorDefault, type ExecutionSource, type SituationFact } from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import type { EntityPromptPart, TurnContext } from '@recued/middleware';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createSituationQuery } from '../situations/query.js';
import { createSituationAccess, type SituationAccess } from '../situations/access.js';
import { createSituationPrefetch, SITUATION_PREFETCH_MAX_BYTES } from '../situations/prefetch.js';
import { situationModelProjection } from '../situations/model-projection.js';
import { createMetaFieldPrivacyResolver } from '../meta-field-privacy-resolver.js';
import { CANONICAL_PII_ENTITY_PRIVACY_TAGS } from '../canonical-pii-schemas.js';
import { renderEntityPartsForEgress, type PiiEgressPlan } from '../chat-pii-egress.js';
import { buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createKernelAdapter } from '@recued/ingredients';
import { createContactStore } from '../storage/contact-store.js';
import { createSituationNamedPeople } from '../situations/named-people.js';
import { writeFileSync } from 'node:fs';

const at = Date.parse('2026-10-17T12:00:00Z');
const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', user_id: 'owner', chat_session_id: 's' };
const input = { time: { from: at, to: at + 86_400_000 } };
const fact = (id: string, patch: Partial<SituationFact> = {}): SituationFact => ({ ref: { collection: 'asset', id }, title: 'Passport',
  kind: 'asset_rule', basis: 'declared', when: input.time, act_by: at, people: [], subjects: [], related: [],
  evidence: [{ collection: 'asset', id }], updated_at: at, consequence: 'routine', ...patch });
let db: Database.Database; let contracts: ContractStore;
beforeEach(() => { db = new Database(':memory:'); contracts = createContractStore(db, { now: () => at }); });
afterEach(() => db.close());
const drive = (facts = [fact('a')]) => {
  const read = vi.fn(() => facts);
  const query = createSituationQuery({ now: () => at, sources: [{ id: 'assets', collection: 'asset', verb_op: 'core.work-entity.read', read }],
    sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }) });
  return { read, access: createSituationAccess({ contracts, query, now: () => at, isVaultUnlocked: () => true }) };
};
const grant = (id: string, entry: string, value: boolean) => createContractGrantEntryStore(contracts).set(id, entry, value, at);
const door = (spheres?: ('personal' | 'professional')[]): Extract<ExecutionSource, { channel: 'mcp' }> => {
  const def = createContractDefinitionStore(contracts, { now: () => at }).mint({ minted_by: 'owner', display_name: 'Work door', scope: {},
    ...(spheres ? { read_spheres: spheres } : {}) });
  return { channel: 'mcp', actor: 'contracted_user', agent_id: 'agent', tool_call_id: 'call', mcp_token_id: 'token', contract_id: def.contract_id };
};
const context = (text: string, source: ExecutionSource = owner) => {
  const parts: EntityPromptPart[] = [];
  const ctx = { source, history: [{ role: 'user', text }], prompt: { contribute: (part: EntityPromptPart) => parts.push(part) } } as unknown as TurnContext;
  return { ctx, parts };
};
const prefetch = async (access: SituationAccess, text: string) => {
  const result = context(text); await createSituationPrefetch({ getAccess: () => access }).prompt!(result.ctx); return result.parts;
};

describe('D-325 one situation tool and independent bounded prefetch', () => {
  it('qualifies bounded matching on versioned golden and held-out prompts, including known irrelevant name hits', async () => {
    const rows = [fact('passport-ana', { title: 'Passport · Ana' }), fact('passport-child', { title: 'Passport · Child' }),
      fact('boiler', { title: 'Boiler service' }), fact('insurance', { title: 'Travel insurance', place: { key: 'city:lisbon', name: 'Lisbon' } })];
    const corpus = [
      ['golden', 'When should I renew my passport?', true, true], ['golden', 'Is the boiler service due?', true, true],
      ['golden', 'Check travel insurance for Lisbon', true, true], ['golden', 'Explain quantum mechanics', false, false],
      ['golden', 'What is the population of Lisbon?', true, false], ['golden', 'Please draft a recipe for soup', false, false],
      ['held_out', 'Show my passport expiry', true, true], ['held_out', 'Any boiler service I should arrange?', true, true],
      ['held_out', 'What is on file for Lisbon?', true, true], ['held_out', 'Translate good morning into French', false, false],
      ['held_out', 'Define passport for a school essay', true, false], ['held_out', 'Summarize photos from last time', false, false],
    ] as const;
    const receipts = [];
    for (const [split, prompt, expectedHit, relevant] of corpus) {
      const { access } = drive(rows); const started = performance.now(); const parts = await prefetch(access, prompt); const lookup_ms = performance.now() - started;
      expect(parts.length > 0, prompt).toBe(expectedHit);
      const resolver = createMetaFieldPrivacyResolver({ getEntitySchemas: () => [], getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS });
      const plan: PiiEgressPlan = { active: true, ledger: piiEgress.createSessionLedgerStore().getOrCreate(prompt), resolver,
        summary: { value: { mode: 'alias', scope_kind: 'session', counts: {} } } };
      const block = renderEntityPartsForEgress(parts, plan, [prompt]).join('\n');
      expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(SITUATION_PREFETCH_MAX_BYTES);
      expect(parts.reduce((sum, part) => sum + part.payload.length, 0)).toBeLessThanOrEqual(3);
      receipts.push({ version: 'd325-prefetch.v1', split, prompt, expected_hit: expectedHit, relevant, lookup_ms, block, bytes: Buffer.byteLength(block, 'utf8'),
        items: parts.reduce((sum, part) => sum + part.payload.length, 0) });
    }
    if (process.env.D325_PREFETCH_REPORT) writeFileSync(process.env.D325_PREFETCH_REPORT, JSON.stringify(receipts, null, 2));
  });
  it('resolves people from the local name index only behind contact grants and sphere fences, retaining ambiguity', async () => {
    const contacts = createContactStore(db); contacts.upsertManual({ email: 'ana@example.test', name: 'Ana Morgan' }, at);
    contacts.upsertManual({ email: 'ana2@example.test', name: 'Ana Smith' }, at);
    const ids = ['ana@example.test', 'ana2@example.test'].map(email => contacts.get(email)!.contact_id ?? email);
    const named = vi.fn(createSituationNamedPeople(contacts)); let contactRead = true;
    const query = createSituationQuery({ now: () => at, namedPeople: named,
      sourceForCollection: collection => ({ collection, verb_op: collection === 'contact' ? 'core.contact.resolve' : 'core.work-entity.read' }),
      sources: [{ id: 'assets', collection: 'asset', verb_op: 'core.work-entity.read', read: () => ids.map((id, index) => fact(`document-${index}`, { title: `Document ${index}`, people: [id], sphere: 'professional' })) }] });
    const context = { owner: true, grants: { isVerbOpGranted: () => true, isCollectionReadGranted: (collection: string) => collection !== 'contact' || contactRead, isTopicReadGranted: () => true } };
    const input = { time: at, text: 'What should Ana prepare?', surface: 'prefetch' as const };
    const result = await query(input, context); expect(result.clusters.flatMap(row => row.items)).toHaveLength(2); expect(result.ambiguous[0]!.choices).toHaveLength(2);
    named.mockClear(); contactRead = false; expect((await query(input, context)).clusters).toEqual([]); expect(named).not.toHaveBeenCalled();
    contactRead = true; expect((await query(input, { ...context, owner: false, spheres: ['professional'], referenceSphere: ref => ref.collection === 'contact' ? 'personal' : 'professional' })).clusters).toEqual([]);
    expect((await query({ ...input, text: 'Unrelated aardvark' }, context)).clusters).toEqual([]);
  });
  it('defaults only the owner on, preserving the author-default data.asset axis', () => {
    for (const entry of ['core.situation.read', 'core.situation.prefetch', 'primitive.situation.query']) {
      expect(ownerOnlyAdjustedAuthorDefault(entry, OWNER_CONTRACT_ID, true)).toBe(true);
      expect(ownerOnlyAdjustedAuthorDefault(entry, 'door', true)).toBe(false);
    }
    expect(ownerOnlyAdjustedAuthorDefault('data.asset', 'door', true)).toBe(true);
  });
  it('keeps episodes and occasions the owner’s until a contract is given them explicitly', async () => {
    // ⛔ Their source op is the tool grant itself, and `data.episode` / `data.occasion`
    // defaulted to allowed, so granting a door the tool handed it the owner's history.
    const item = (collection: 'episode' | 'occasion', id: string) => fact(id, { ref: { collection, id }, title: id, evidence: [{ collection, id }] });
    const episodes = vi.fn(() => [item('episode', 'dinner')]); const occasions = vi.fn(() => [item('occasion', 'anniversary')]);
    const query = createSituationQuery({ now: () => at, sources: [
      { id: 'episodes', collection: 'episode', verb_op: 'core.situation.read', read: episodes },
      { id: 'occasions', collection: 'occasion', verb_op: 'core.situation.read', read: occasions }],
    sourceForCollection: collection => ({ verb_op: 'core.situation.read', collection }) });
    const access = createSituationAccess({ contracts, query, now: () => at, isVaultUnlocked: () => true });
    const source = door(); grant(source.contract_id, 'core.situation.read', true);
    expect((await access.read(input, source)).clusters).toEqual([]);
    expect(episodes).not.toHaveBeenCalled(); expect(occasions).not.toHaveBeenCalled();
    expect((await access.read(input, owner)).clusters.flatMap(cluster => cluster.items)).toHaveLength(2);
    grant(source.contract_id, 'data.episode', true);
    expect((await access.read(input, source)).clusters.flatMap(cluster => cluster.items.map(row => row.ref.id))).toEqual(['dinner']);
  });
  it('requires the tool grant and both source axes before a record or count is read', async () => {
    const { access, read } = drive(); const source = door();
    await expect(access.read(input, source)).rejects.toThrow(/core.situation.read/); expect(read).not.toHaveBeenCalled();
    grant(source.contract_id, 'core.situation.read', true);
    // Work itself is separately owner-default-only.
    expect(await access.read(input, source)).toEqual({ clusters: [], omitted: 0, ambiguous: [] }); expect(read).not.toHaveBeenCalled();
    grant(source.contract_id, 'core.work-entity.read', true); grant(source.contract_id, 'data.asset', false);
    expect((await access.read(input, source)).omitted).toBe(0); expect(read).not.toHaveBeenCalled();
    grant(source.contract_id, 'data.asset', true); expect((await access.read(input, source)).clusters).toHaveLength(1);
  });
  it('uses the live contract sphere restriction and withholds unknowns before counts', async () => {
    const { access } = drive([fact('work', { sphere: 'professional' }), fact('home', { sphere: 'personal' }), fact('unknown')]);
    const source = door(['professional']); grant(source.contract_id, 'core.situation.read', true); grant(source.contract_id, 'core.work-entity.read', true);
    const result = await access.read(input, source);
    expect(result.clusters.flatMap(cluster => cluster.items.map(item => item.ref.id))).toEqual(['work']); expect(result.omitted).toBe(0);
    createContractDefinitionStore(contracts).setReadSpheres(source.contract_id, []);
    expect((await access.read(input, source)).clusters).toHaveLength(0);
    createContractDefinitionStore(contracts).setReadSpheres(source.contract_id, null);
    expect((await access.read(input, source)).clusters).toHaveLength(3);
  });
  it('does not turn a dead door, bound owner sentinel, or missing source into owner access', async () => {
    const { access, read } = drive(); const source = door();
    grant(source.contract_id, 'core.situation.read', true);
    createContractDefinitionStore(contracts).revoke(source.contract_id, 'owner revoked');
    for (const candidate of [source, { ...source, contract_id: OWNER_CONTRACT_ID }, { ...owner, contract_id: source.contract_id }, undefined]) {
      await expect(access.read(input, candidate)).rejects.toThrow(/governing|authenticated/);
    }
    expect(read).not.toHaveBeenCalled();
  });
  it('honors owner revokes for authenticated owner recipes and direct HID', async () => {
    const { access } = drive();
    const scheduled: ExecutionSource = { channel: 'schedule', actor: 'system', cron: '* * * * *', source_recipe: 'fixture', contract_id: OWNER_CONTRACT_ID };
    expect((await access.read(input, scheduled)).clusters).toHaveLength(1);
    grant(OWNER_CONTRACT_ID, 'core.situation.read', false);
    await expect(access.read(input, scheduled)).rejects.toThrow(/core.situation.read/);
    await expect(access.read(input, { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'paired' })).rejects.toThrow(/core.situation.read/);
  });
  it('keeps alias and tool grants independent in both directions', async () => {
    const { access } = drive(); grant(OWNER_CONTRACT_ID, 'core.situation.read', false);
    expect(await prefetch(access, 'What about my passport?')).toHaveLength(1);
    grant(OWNER_CONTRACT_ID, 'core.situation.read', true); grant(OWNER_CONTRACT_ID, 'core.situation.prefetch', false);
    expect(await prefetch(access, 'passport')).toEqual([]);
    expect((await access.read(input, owner)).clusters).toHaveLength(1);
  });
  it('adds no part on a miss or prose-only message, and matches a named place in a full sentence', async () => {
    const { access } = drive([fact('trip', { title: 'Hotel booking', place: { key: 'city:lisbon', name: 'Lisbon' } })]);
    expect(await prefetch(access, 'the and for')).toEqual([]); expect(await prefetch(access, 'Unrelated aardvark')).toEqual([]);
    const parts = await prefetch(access, "What's the population of Lisbon?");
    expect(parts).toHaveLength(1); expect(parts[0]!.render(parts[0]!.payload)).toContain('Hotel booking');
    expect(parts[0]!.payload[0]!.where).toMatchObject({ verdict: 'match', value: { name: 'Lisbon' } });
  });
  it('never prefetches episodes or last-time suggestions and keeps ambiguity explicit', async () => {
    const { access } = drive([fact('a'), fact('b'), fact('last', { last_time: true })]);
    const parts = await prefetch(access, 'Passport'); expect(parts[0]!.payload).toHaveLength(2);
    expect(parts[0]!.payload.every(row => row.ambiguous === true)).toBe(true);
    expect(JSON.stringify(parts)).not.toContain('last_time');
  });
  it('returns within the budget, aborts the lookup, and contributes nothing late', async () => {
    let signal: AbortSignal | undefined;
    const access = { prefetch: (_text: string, _source: unknown, pending: AbortSignal) => { signal = pending; return new Promise(() => {}); } } as SituationAccess;
    const { ctx, parts } = context('Passport');
    await createSituationPrefetch({ getAccess: () => access, budget_ms: 5 }).prompt!(ctx);
    expect(signal?.aborted).toBe(true); expect(parts).toEqual([]);
  });
  it('stops a scan that blocks synchronously at the next stage once the budget passes', async () => {
    // A never-settling promise cannot show this: a timer only fires between
    // synchronous chunks, so each source here holds the thread past the budget.
    const read: string[] = [];
    const query = createSituationQuery({ now: () => at, sources: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, collection: 'asset', verb_op: 'core.work-entity.read',
      read: () => { read.push(id); const until = performance.now() + 30; while (performance.now() < until); return [fact(id)]; } })),
      sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }) });
    const { ctx, parts } = context('Passport');
    await createSituationPrefetch({ getAccess: () => createSituationAccess({ contracts, query, now: () => at, isVaultUnlocked: () => true }), budget_ms: 10 }).prompt!(ctx);
    expect(parts).toEqual([]); expect(read.length).toBeLessThanOrEqual(2);
  });
  it('caps structured bytes and items without using a generic middleware switch', async () => {
    const { access } = drive(Array.from({ length: 30 }, (_, i) => fact(String(i), { title: `Passport ${i}` })));
    const parts = await prefetch(access, 'Passport'); expect(parts[0]!.payload.length).toBeLessThanOrEqual(3);
    expect(Buffer.byteLength(JSON.stringify(parts[0]!.payload))).toBeLessThanOrEqual(SITUATION_PREFETCH_MAX_BYTES);
  });
  it('aliases structured values at the real egress gather and drops them without an effective privacy plan', async () => {
    const { access } = drive([fact('passport-private-id', { title: 'Passport for Sam Rivera', people: ['Sam Rivera'],
      place: { key: 'label:14 cedar avenue', name: '14 Cedar Avenue' } })]);
    const parts = await prefetch(access, 'Passport');
    const resolver = createMetaFieldPrivacyResolver({ getEntitySchemas: () => [], getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS });
    const plan: PiiEgressPlan = { active: true, ledger: piiEgress.createSessionLedgerStore().getOrCreate('s'), resolver,
      summary: { value: { mode: 'alias', scope_kind: 'session', counts: {} } } };
    const rendered = renderEntityPartsForEgress(parts, plan).join('\n');
    expect(rendered).not.toContain('14 Cedar Avenue'); expect(rendered).not.toContain('Sam Rivera'); expect(rendered).not.toContain('passport-private-id');
    expect(rendered).toContain('pii.'); expect(rendered).not.toContain('__entity');
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(SITUATION_PREFETCH_MAX_BYTES);
    expect(renderEntityPartsForEgress(parts, undefined)).toEqual([]);
    expect(renderEntityPartsForEgress(parts, { ...plan, resolver: piiEgress.noopFieldPrivacyResolver })).toEqual([]);
    const result = situationModelProjection(await access.read(input, owner));
    expect(resolver(result as never).some(field => field.path.endsWith('who.value') && field.kind === 'name')).toBe(true);
  });
  it('rejects caller-forged surface, owner, sphere, recall, and malformed bounds', () => {
    for (const patch of [{ surface: 'digest' }, { include_last_time: true }, { owner: true }, { spheres: ['personal'] },
      { time: { from: at, to: at - 1 } }, { limit_items: 4 }, { people: 'owner' }, { subjects: [{ collection: 'asset' }] }]) {
      expect(() => parseSituationQueryInput({ ...input, ...patch })).toThrow(/Invalid situation/);
    }
  });
  it('registers one real native handler, with an explicit non-retriable permission refusal', async () => {
    const { access } = drive(); const handlers = buildChatTier1Handlers({ getSituationAccess: () => access } as ChatToolHandlerDeps);
    const ctx = { execution_source: owner } as never;
    expect(await handlers['situation.query']!(input, ctx)).toMatchObject({ ok: true, result: { clusters: [{ items: [{ what: { value: 'Passport' } }] }] } });
    grant(OWNER_CONTRACT_ID, 'core.situation.read', false);
    expect(await handlers['situation.query']!(input, ctx)).toMatchObject({ ok: true, result: { refused: true, hint: expect.stringContaining('do not retry') } });
  });
  it('forwards only the engine source through the recipe kernel', async () => {
    const { access } = drive(); const read = vi.fn((raw, source) => access.read(raw, source));
    const adapter = createKernelAdapter({ situationQuery: read });
    const call = { slug: 'situation-query', input, output: {}, risk_tier: 'read', manifest_version: 1, stepMeta: { execution_source: owner } } as never;
    expect(await adapter(call)).toMatchObject({ clusters: [{ items: [{ what: { value: 'Passport' } }] }] });
    expect(read).toHaveBeenCalledWith(input, owner);
  });
});
