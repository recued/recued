import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNER_CONTRACT_ID, parseSituationQueryInput, ownerOnlyAdjustedAuthorDefault, type ExecutionSource, type SituationFact } from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import type { EntityPromptPart, TurnContext } from '@recued/middleware';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createSituationQuery, SituationScanBoundError } from '../situations/query.js';
import { createSituationAccess, type SituationAccess } from '../situations/access.js';
import { createSituationPrefetch, renderSituationPrefetch, SITUATION_PREFETCH_MAX_BYTES } from '../situations/prefetch.js';
import { situationModelProjection } from '../situations/model-projection.js';
import { createMetaFieldPrivacyResolver } from '../meta-field-privacy-resolver.js';
import { CANONICAL_PII_ENTITY_PRIVACY_TAGS } from '../canonical-pii-schemas.js';
import { createPiiEgressPlanForSession, renderEntityPartsForEgress, wrapExecuteAiCallForPii, type PiiEgressPlan } from '../chat-pii-egress.js';
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
/** The lookup's budget is real time, which a loaded machine can spend before a
 *  correct lookup finishes: six copies of this file run at once failed 5 times,
 *  each with no block (2026-10-21). A test not about the budget holds the clock
 *  still, so the budget's timer never fires and no time passes. The budget tests
 *  run on the real clock. */
const clockStill = async (run: () => Promise<void> | void): Promise<void> => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try { await run(); } finally { vi.useRealTimers(); }
};
const prefetch = async (access: SituationAccess, text: string) => {
  const result = context(text); await clockStill(() => createSituationPrefetch({ getAccess: () => access }).prompt!(result.ctx)); return result.parts;
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
  it('says how many matching items it left out, so a capped list does not read as all of them', async () => {
    // D-167: a model given a block stopped calling tools, so three rows of five
    // read as the five unless the block says otherwise.
    const rowsOf = (block: string) => block.split('\n').filter(line => line.startsWith('{'));
    const parts = await prefetch(drive(Array.from({ length: 5 }, (_, i) => fact(`p${i}`, { title: `Passport ${i}` }))).access, 'Passport');
    const block = parts[0]!.render(parts[0]!.payload); const shown = rowsOf(block).length;
    expect(shown).toBeGreaterThan(0); expect(shown).toBeLessThan(5);
    expect(block).toContain(`Shown here: ${shown} of the 5 matching items on file. ${5 - shown} ${5 - shown === 1 ? 'is' : 'are'} not listed.`);
    const all = await prefetch(drive([fact('a'), fact('b', { title: 'Passport · Child' })]).access, 'Passport');
    const whole = all[0]!.render(all[0]!.payload);
    expect(rowsOf(whole)).toHaveLength(2); expect(whole).not.toMatch(/Shown here|not listed|too large/);
  });
  it('measures the rows it showed apart from everything the message matched', async () => {
    const measured: Array<[string, number]> = []; const result = context('Passport');
    await clockStill(() => createSituationPrefetch({ getAccess: () => drive(Array.from({ length: 5 }, (_, i) => fact(`p${i}`, { title: `Passport ${i}` }))).access,
      measure: (name, value) => { measured.push([name, value]); } }).prompt!(result.ctx));
    const shown = result.parts[0]!.payload.length; expect(shown).toBeLessThan(5);
    expect(measured.filter(([name]) => name.endsWith('_items'))).toEqual([['prefetch.shown_items', shown], ['prefetch.matched_items', 5]]);
  });
  it('says when a source was too large to search in full', async () => {
    const query = createSituationQuery({ now: () => at, sources: [
      { id: 'assets', collection: 'asset', verb_op: 'core.work-entity.read', read: () => [fact('a')] },
      { id: 'tasks', collection: 'task', verb_op: 'core.work-entity.read', read: () => { throw new SituationScanBoundError('over the bound'); } }],
    sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }) });
    const parts = await prefetch(createSituationAccess({ contracts, query, now: () => at, isVaultUnlocked: () => true }), 'Passport');
    const block = parts[0]!.render(parts[0]!.payload);
    expect(block).toContain('Some sources were too large to search in full, so more may match.'); expect(block).not.toContain('Shown here');
  });
  it('keeps the count line inside the byte cap, counting a row it displaces', () => {
    const rowsOf = (block: string) => block.split('\n').filter(line => line.startsWith('{'));
    const header = Buffer.byteLength(renderSituationPrefetch([{ v: '' }], 1, false), 'utf8') - Buffer.byteLength('{"v":""}', 'utf8');
    // Three rows that fill the cap to within 10 bytes; each line is its JSON plus a newline.
    const room = SITUATION_PREFETCH_MAX_BYTES - 10 - header; const each = Math.floor(room / 3);
    const rows = [each, each, room - 2 * each].map(size => ({ v: 'x'.repeat(size - 9) }));
    expect(rowsOf(renderSituationPrefetch(rows, 3, false))).toHaveLength(3);
    const block = renderSituationPrefetch(rows, 4, true);
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(SITUATION_PREFETCH_MAX_BYTES);
    expect(rowsOf(block)).toHaveLength(2);
    expect(block).toContain('Shown here: 2 of the 4 matching items on file. 2 are not listed.');
    expect(block).toContain('Some sources were too large to search in full');
    // A row too large for the cap is skipped, and counted as not listed.
    const skipped = renderSituationPrefetch([{ v: 'a' }, { v: 'x'.repeat(SITUATION_PREFETCH_MAX_BYTES) }, { v: 'b' }], 3, false);
    expect(rowsOf(skipped)).toHaveLength(2); expect(skipped).toContain('Shown here: 2 of the 3 matching items on file. 1 is not listed.');
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

describe('a place the owner typed stays as typed in their own messages', () => {
  /** One packet through the chat's egress wrapper; returns what the model was sent. */
  const sendThroughEgress = async (packet: Record<string, unknown>, options: { parts?: readonly EntityPromptPart[];
    seed?: Record<string, string>; recalled?: readonly piiEgress.CandidateValueSeed[] } = {}) => {
    const { recalled } = options;
    const plan = createPiiEgressPlanForSession({ ledgerStore: piiEgress.createSessionLedgerStore(),
      resolver: createMetaFieldPrivacyResolver({ getEntitySchemas: () => [], getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS }),
      // The cross-session recall reharvest, wired as the chat orchestrator wires it: these are
      // the values it read from the earlier sessions a recall returned.
      ...(recalled ? { createCandidateContributor: () => ({ contribute: async () => ({ candidates: recalled, partial: false,
        joined_source_session_ids: [], decrypted_rows: 0, decrypted_bytes: 0 }) }),
      getRecallJoinedPieces: () => [], hasRegisteredRecall: () => true } : {}) },
    's', 'chat', recalled ? new Map() as TurnContext['state'] : undefined);
    // Values a lookup or tool result put in the session ledger earlier: key = privacy kind.
    if (options.seed) piiEgress.aliasPacketForEgress({ ledger: plan.ledger, packet: options.seed, mode: 'alias',
      resolver: () => Object.keys(options.seed!).map(kind => ({ path: kind, kind: kind as 'address' })) });
    let sent = '';
    await wrapExecuteAiCallForPii(async (_manifest, request) => { sent = String(request['llm.prompt']); return { body: { response: 'ok', events: [], tool_calls: [] } }; },
      plan, undefined, options.parts ?? [])({} as never, { 'llm.prompt': JSON.stringify(packet) });
    // No hold mark ever reaches the model.
    expect(sent).not.toMatch(/[\uE000-\uE003]/u);
    return JSON.parse(sent) as { user_message: string; chat_tail: Array<{ role: string; content: string }>; prefetch_context?: string[];
      recall_context?: unknown };
  };
  /** A recall of an earlier session, as `recall_context` carries it. */
  const recalledSession = (text: string) => [{ tool_name: 'memory.search', tier: 1, args: {}, status: 'ok', started_at: at, completed_at: at,
    result: { entries: [{ output_string: text, run_id: 'r1' }] } }];

  it('keeps the place in the question while the lookup block aliases the record\'s place', async () => {
    // Measured (D-325 bench, 2026-10-21): this went out as "Which country is pii.Address1 the capital of?".
    const question = 'Which country is Lisbon the capital of?';
    const parts = await prefetch(drive([fact('insurance', { title: 'Travel insurance', place: { key: 'city:lisbon', name: 'Lisbon' } })]).access, question);
    expect(parts).toHaveLength(1);
    const sent = await sendThroughEgress({ chat_tail: [], user_message: question }, { parts });
    expect(sent.user_message).toBe(question);
    expect(JSON.stringify(sent.prefetch_context)).not.toContain('Lisbon');
    expect(JSON.stringify(sent.prefetch_context)).toMatch(/pii\.Address\d/u);
  });

  it('keeps it when a tool result, not the block, seeded the place in the same request', async () => {
    // The direct pass seeds the result's place and used to content-scan the
    // question in the same call, before any hold could see the place.
    const question = 'Recommend some sights to see in Porto';
    const sent = await sendThroughEgress({ chat_tail: [], user_message: question, prior_tool_calls: [{ tool_name: 'work.read', tier: 1, status: 'ok',
      args: { kind: 'asset', id: 'cover' }, started_at: at, completed_at: at,
      result: { entity: { title: 'Car insurance', anchors: [{ __entity: 'asset_anchor', kind: 'place', name: 'Porto' }] } } }] });
    expect(sent.user_message).toBe(question);
    expect(JSON.stringify(sent)).toMatch(/"name":"pii\.Address\d"/u);
  });
  it('still aliases every other kind the owner types, and a longer value that contains the place', async () => {
    const sent = await sendThroughEgress({ chat_tail: [], user_message: 'Email ana@acme.com and Ana Silva at Lisbon Insurance Ltd about Lisbon' },
      { seed: { email: 'ana@acme.com', name: 'Ana Silva', org: 'Lisbon Insurance Ltd', address: 'Lisbon' } });
    expect(sent.user_message).not.toMatch(/ana@acme\.com|Ana Silva|Lisbon Insurance Ltd/u);
    expect(sent.user_message).toMatch(/ about Lisbon$/u);
  });

  it('keeps it in the owner\'s earlier turns, not in the assistant\'s', async () => {
    const sent = await sendThroughEgress({ chat_tail: [{ role: 'user', content: 'I fly to Lisbon on Friday.' },
      { role: 'assistant', content: 'Your travel insurance covers Lisbon.' }], user_message: 'What should I pack?' }, { seed: { address: 'Lisbon' } });
    expect(sent.chat_tail[0]!.content).toBe('I fly to Lisbon on Friday.');
    expect(sent.chat_tail[1]!.content).not.toContain('Lisbon');
  });

  it('leaves a place touching an email to the content pass, so the email is aliased whole', async () => {
    const sent = await sendThroughEgress({ chat_tail: [], user_message: 'Write to lisbon@acme.com today' },
      { seed: { email: 'ana@acme.com', address: 'Lisbon' } });
    expect(sent.user_message).not.toMatch(/acme\.com|lisbon@/iu);
  });

  it('keeps it when a recall of an earlier session brought the place, which the ledger did not hold', async () => {
    // Probe (2026-10-21): the recall reharvest ran before the hold, so this went
    // out as "Which country is pii.Address1 the capital of?" after the fix above.
    const question = 'Which country is Lisbon the capital of?';
    const sent = await sendThroughEgress({ chat_tail: [{ role: 'user', content: 'I fly to Lisbon on Friday.' },
      { role: 'assistant', content: 'Your travel insurance covers Lisbon.' }], user_message: question,
    recall_context: recalledSession('Booked the Lisbon trip insurance.') }, { recalled: [{ kind: 'address', value: 'Lisbon' }] });
    expect(sent.user_message).toBe(question);
    expect(sent.chat_tail[0]!.content).toBe('I fly to Lisbon on Friday.');
    expect(sent.chat_tail[1]!.content).not.toContain('Lisbon');
    expect(JSON.stringify(sent.recall_context)).not.toContain('Lisbon');
    expect(JSON.stringify(sent.recall_context)).toMatch(/pii\.Address\d/u);
  });

  it('still aliases a recalled name the owner types, and a recalled value that contains the place', async () => {
    const sent = await sendThroughEgress({ chat_tail: [], user_message: 'Did Ana Silva at Lisbon Insurance Ltd answer about Lisbon?',
      recall_context: recalledSession('Ana Silva wrote from Lisbon Insurance Ltd.') },
    { recalled: [{ kind: 'name', value: 'Ana Silva' }, { kind: 'org', value: 'Lisbon Insurance Ltd' }, { kind: 'address', value: 'Lisbon' }] });
    expect(sent.user_message).not.toMatch(/Ana Silva|Lisbon Insurance Ltd/u);
    expect(sent.user_message).toMatch(/ about Lisbon\?$/u);
  });
});
