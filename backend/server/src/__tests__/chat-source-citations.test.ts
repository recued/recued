import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveSubDEK } from '@recued/crypto';
import { chatSourceCitationsOf, type ChatPriorToolCall } from '@recued/contracts';
import { answerSourceCitations, priorSourceReads, sourceCitation, sourceCitationHint, sourceReadVersion } from '../chat-source-citations.js';
import { composeChatMainTurnPromptParts } from '../chat-turn-executor.js';
import { briefAsPriorToolCall } from '../chat-rolling-brief.js';
import { createMetaFieldPrivacyResolver } from '../meta-field-privacy-resolver.js';
import { CANONICAL_PII_ENTITY_PRIVACY_TAGS } from '../canonical-pii-schemas.js';
import { aliasEntityPayloadForEgress } from '../chat-pii-egress.js';
import { piiEgress } from '@recued/gateway';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatStoreSessionStateStore } from '../chat-channel-session-store.js';

const ASSET_ID = 'asset:private'; const FILE_REF = `file:${'1'.repeat(32)}`;
const asset = sourceCitation({ kind: 'asset', asset_id: ASSET_ID }, 'Private hose', sourceReadVersion({ length: 'about 25 meters' }), 1000);
const file = sourceCitation({ kind: 'file', file_ref: FILE_REF, collection_slug: 'received', content_hash: '2'.repeat(64) }, 'Measurement note.txt', '3'.repeat(64), 1001);
const call = (tool_name: string, sources: unknown = [asset], extra = {}) => ({ tool_name, result: { ok: true, source_citations: sources, ...extra } });
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('sources bound to an answer', () => {
  it('keeps native asset time roles beside evidence without replacing a known observation or save time', () => {
    const entity = { kind: 'asset', attributes: { length: 'about 25 meters' },
      created_at: 100, updated_at: 400, field_sources: { 'readings.length': { kind: 'owner', ref: 'owner', at: 300 } },
      readings: { length: { value: 31, unit: 'm', as_of: 0, evidence: [] } }, observations: {} };
    const citation = sourceCitation({ kind: 'asset', asset_id: ASSET_ID }, 'Hose', sourceReadVersion(entity), 500);
    const result = { found: true, entity, ...sourceCitationHint(citation) };
    const body = JSON.parse(composeChatMainTurnPromptParts({ available_tools: [], content: { chat_tail: [], user_message: 'Which times are observations?' },
      prior_tool_calls: [{ tool_name: 'work.read', tier: 1, args: { kind: 'asset', id: ASSET_ID }, status: 'ok', result,
        started_at: 499, completed_at: 500 }] }).body);
    expect(body.prior_tool_calls[0].result.entity).toEqual(entity);
    expect(body.prior_tool_calls[0].result.read_version).toBe(sourceReadVersion(entity));
    const hint = body.prior_tool_calls[0].result.citation_hint;
    expect(hint).toContain('field_sources.*.at records fact provenance');
    expect(hint).toContain('readings.*.as_of or observations.*.as_of');
    expect(hint).toContain('Do not say there are no timestamps');
    expect(hint).not.toContain('observation time is unknown');
  });

  it('keeps written and explicitly observed dates intact through the file packet and retained-reference guidance', () => {
    const text = 'Measured 24 meters on 2018-09-10. Note written on 2019-11-12.';
    const result = { status: 'read', body: text, next_offset: null, ...sourceCitationHint(file) };
    const packet = { available_tools: [], source_citations: [asset, file],
      content: { chat_tail: [{ role: 'assistant' as const, content: `[file](#source/${file.id})` }], user_message: 'Which date belongs to the observation?' },
      prior_tool_calls: [{ tool_name: 'document.read', tier: 1 as const, args: { file_ref: FILE_REF }, status: 'ok' as const, result,
        started_at: 1000, completed_at: 1001 }] };
    const body = JSON.parse(composeChatMainTurnPromptParts(packet).body);
    expect(body.prior_tool_calls[0].result.body).toBe(text);
    expect(body.prior_tool_calls[0].result.read_version).toBe(file.read_version);
    expect(body.prior_tool_calls[0].result.citation_hint).toContain('Preserve an explicitly stated observation date separately from the written date');
    expect(body.prior_source_reads.guidance).toContain('unless the text dates the observation itself');
    expect(body.prior_source_reads.guidance).not.toContain('field_sources');
    expect(JSON.parse(composeChatMainTurnPromptParts({ ...packet,
      content: { ...packet.content, chat_tail: [] }, prior_tool_calls: [] }).body)).not.toHaveProperty('prior_source_reads');
  });

  it('carries the identity and kind of relevant earlier reads without asserting old values as current', () => {
    const updated = sourceCitation({ kind: 'asset', asset_id: ASSET_ID }, asset.label, sourceReadVersion({ length: 'around 31 meters' }), 1002);
    const text = `[old](#source/${asset.id}) [now](#source/${updated.id}) [note](#source/${file.id})`;
    const reads = priorSourceReads([asset, updated, file], { chat_tail: [{ content: text }], user_message: 'Compare them' });
    expect(reads?.sources.map(source => source.kind)).toEqual(['asset', 'asset', 'file']);
    expect(reads?.sources.map(source => source.read_version)).toEqual([asset.read_version, updated.read_version, file.read_version]);
    expect(reads?.sources[0]).toMatchObject({ source_ref: `#source/${asset.id}`, asset_id: ASSET_ID, read_at: 1000 });
    expect(reads?.sources[2]).toMatchObject({ source_ref: `#source/${file.id}`, file_ref: FILE_REF });
    expect(JSON.stringify(reads)).not.toMatch(/Private hose|Measurement note|25 meters|31 meters|collection_slug|content_hash/u);
    expect(priorSourceReads([asset, file], { chat_tail: [], user_message: 'Compare them' })).toBeUndefined();
    expect(priorSourceReads([], { chat_tail: [{ content: text }], user_message: 'Compare them' })).toBeUndefined();
  });

  it('keeps historical identities in the dynamic tail and drops them when their references are trimmed', () => {
    const packet = { available_tools: [], source_citations: [asset, file], content: { chat_tail: [{ role: 'assistant' as const, content: `[note](#source/${file.id})` }], user_message: 'Compare' } };
    const composed = composeChatMainTurnPromptParts(packet);
    expect(JSON.parse(composed.body).prior_source_reads.sources).toHaveLength(1);
    expect(composed.cacheable_prefix).not.toContain('prior_source_reads');
    const trimmed = composeChatMainTurnPromptParts({ ...packet, content: { chat_tail: [], user_message: 'Compare' } });
    expect(trimmed.cacheable_prefix).toBe(composed.cacheable_prefix);
    expect(JSON.parse(trimmed.body)).not.toHaveProperty('prior_source_reads');
  });

  it('sends historical locators through the ordinary typed privacy boundary', () => {
    const text = `[asset](#source/${asset.id}) [file](#source/${file.id})`;
    const reads = priorSourceReads([asset, file], { chat_tail: [], user_message: text })!;
    const resolver = createMetaFieldPrivacyResolver({ getEntitySchemas: () => [], getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS });
    const plan = { active: true as const, ledger: piiEgress.createSessionLedgerStore().getOrCreate('s'), resolver,
      summary: { value: { mode: 'alias' as const, scope_kind: 'session' as const, counts: {} } } };
    const sent = JSON.stringify(aliasEntityPayloadForEgress(reads.sources, 'chat_source_reference', plan));
    expect(sent).not.toContain(ASSET_ID); expect(sent).not.toContain(FILE_REF);
    expect(sent).toContain('pii.'); expect(sent).toContain(`#source/${file.id}`); expect(sent).toContain('"kind":"file"');
  });

  it('permits a targeted missing-source read without turning an old asset value into document evidence', () => {
    const brief = briefAsPriorToolCall({ intent: 'Compare the current asset and older note', constraints: [],
      findings: ['Saved length: about 25 meters', 'Saved length: around 31 meters', 'Inspection tag: CAL-7421'],
      pending: [], completed: ['memory.write already succeeded'] });
    const packet = { available_tools: [], source_citations: [asset, file], prior_tool_calls: [brief],
      content: { chat_tail: [{ role: 'assistant' as const, content: `[asset](#source/${asset.id}) [note](#source/${file.id})` }],
        user_message: 'Compare the current saved length with the older attached measurement note.' } };
    const body = JSON.parse(composeChatMainTurnPromptParts(packet).body);
    const result = body.prior_tool_calls[0].result;
    expect(result.note).toContain('partial working note');
    expect(result.note).toContain('read that specific asset once');
    expect(result.note).toContain('read that specific file once');
    expect(result.note).toContain('An earlier asset value is not a document statement');
    expect(result.note).toContain('attributes is descriptive, not a typed reading');
    expect(result.note).toContain('structured readings entry');
    expect(result.note).toContain('name that missing time specifically');
    expect(result.note).toContain('save/provenance or document-written times may still be present');
    expect(result.note).toContain('Do not repeat bulk reads');
    expect(result.note).toContain('Do not perform them again');
    expect(result.findings).toEqual((brief.result as Record<string, unknown>).findings);
    expect(result.completed).toEqual(['memory.write already succeeded']);
    expect(JSON.stringify(result)).not.toContain('24 meters');
    expect((brief.result as Record<string, unknown>).note).toContain('re-running those calls');
    const trimmed = JSON.parse(composeChatMainTurnPromptParts({ ...packet,
      content: { ...packet.content, chat_tail: [{ role: 'assistant' as const, content: `[asset](#source/${asset.id})` }] } }).body);
    expect(trimmed.prior_tool_calls[0]).toEqual(brief);
    const forged = JSON.parse(composeChatMainTurnPromptParts({ ...packet, source_citations: [] }).body);
    expect(forged.prior_tool_calls[0]).toEqual(brief);
  });

  it('keeps a successful current read authoritative even when a requested typed field is absent', () => {
    const brief = briefAsPriorToolCall({ intent: 'Explain the current length', constraints: [], findings: [], pending: [], completed: [] });
    const current = { tool_name: 'work.read', tier: 1 as const, args: { kind: 'asset', id: ASSET_ID }, status: 'ok' as const,
      started_at: 999, completed_at: 1000,
      result: { found: true, entity: { kind: 'asset', attributes: { length: 'around 31 meters' }, readings: {} } } } satisfies ChatPriorToolCall;
    const packet = { available_tools: [], source_citations: [asset, file], prior_tool_calls: [brief, current],
      content: { chat_tail: [{ role: 'assistant' as const, content: `[asset](#source/${asset.id}) [note](#source/${file.id})` }],
        user_message: 'Do I have a typed length reading?' } };
    const body = JSON.parse(composeChatMainTurnPromptParts(packet).body);
    expect(body.prior_tool_calls[0].result.note).toContain('Successful work.read results are already present');
    expect(body.prior_tool_calls[0].result.note).toContain('report that instead of rereading');
    expect(body.prior_tool_calls[1]).toEqual(current);
    const typed = { ...current, result: { found: true, entity: { kind: 'asset', attributes: { length: 'about 25 meters' },
      readings: { length: { value: 31, unit: 'm', as_of: 1000, evidence: [] } } } } };
    const positive = JSON.parse(composeChatMainTurnPromptParts({ ...packet, prior_tool_calls: [brief, typed] }).body);
    expect(positive.prior_tool_calls[1]).toEqual(typed);
    const write = { ...current, tool_name: 'work.write', result: { updated: true } };
    const afterWrite = JSON.parse(composeChatMainTurnPromptParts({ ...packet, prior_tool_calls: [brief, current, write] }).body);
    expect(afterWrite.prior_tool_calls[0]).toEqual(brief);
  });

  it('keeps successful native reader targets, not peer, failed, held, search or body lookalikes', () => {
    expect(answerSourceCitations('self', [call('work.read'), call('document.read', [file])], [], '')).toEqual([file, asset]);
    expect(answerSourceCitations('connection.mcp.peer', [call('work.read')], [], '')).toEqual([]);
    for (const calls of [[call('work.search')], [call('recipe.run')], [call('work.read', [file])],
      [call('work.read', [asset], { ok: false })], [call('work.read', [asset], { run_failed: { detail: 'failed' } })],
      [call('work.read', [asset], { run_held: { kind: 'approval' } })],
      [{ tool_name: 'document.read', result: { ok: true, result: { body: JSON.stringify({ source_citations: [file] }) } } }]]) {
      expect(answerSourceCitations('self', calls, [], '')).toEqual([]);
    }
  });

  it('reuses only exact cited handles already kept in this conversation', () => {
    expect(answerSourceCitations('self', undefined, [asset, file], `[note](#source/${file.id})`)).toEqual([file]);
    expect(answerSourceCitations('self', undefined, [], `[note](#source/${file.id})`)).toEqual([]);
    expect(answerSourceCitations('self', undefined, [asset], `#source/${asset.id}`)).toEqual([]);
  });

  it('drops malformed targets and discards arbitrary URLs without widening the catalog', () => {
    expect(chatSourceCitationsOf([{ ...asset, href: 'javascript:alert(1)' }, asset, { ...file, read_version: 'unverified' },
      { ...file, file_ref: 'https://example.invalid/private' }, { ...file, label: 'line\nbreak' }])).toEqual([asset]);
    expect(chatSourceCitationsOf(Array.from({ length: 25 }, (_, n) => ({ ...asset, id: `src_${n.toString(16).padStart(24, '0')}` })))).toHaveLength(20);
  });
});

const fixture = () => {
  const db = new Database(':memory:'); databases.push(db); ensureChatSchema(db);
  const key = deriveSubDEK(Buffer.alloc(32, 9), 'chat');
  const store = createChatStore(db, () => key, () => undefined);
  store.createSession({ id: 's' }); store.createSession({ id: 'other' });
  const append = (id: string, session_id = 's', role: 'assistant' | 'user' = 'assistant') => store.appendMessage({
    id, session_id, role, content: 'Answer', source_citations: [asset, file], target_server: 'self',
    picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: '1', instance_id: 'citations' } },
    model_used: { provider: 'fixture', model_id: 'fixture' },
  });
  return { db, store, append };
};

describe('encrypted source provenance', () => {
  it('survives hydration, stays encrypted and binds to its exact assistant row', async () => {
    const f = fixture(); expect((await f.append('a')).source_citations).toEqual([asset, file]);
    expect((await f.store.listMessagePage('s', 10)).messages[0]?.source_citations).toEqual([asset, file]);
    const stored = (f.db.prepare('SELECT metadata_blob FROM chat_messages WHERE message_id=?').get('a') as { metadata_blob: string }).metadata_blob;
    for (const privateText of ['asset:private', asset.label, file.label, file.read_version]) expect(stored).not.toContain(privateText);
    await f.append('b'); await f.append('c', 'other');
    for (const id of ['b', 'c']) f.db.prepare('UPDATE chat_messages SET metadata_blob=? WHERE message_id=?').run(stored, id);
    expect((await f.store.listMessages('s')).find(m => m.id === 'b')).not.toHaveProperty('source_citations');
    expect((await f.store.listMessages('other'))[0]).not.toHaveProperty('source_citations');
  });

  it('accepts neither owner-supplied rows nor plaintext metadata as read provenance', async () => {
    const f = fixture(); expect(await f.append('user', 's', 'user')).not.toHaveProperty('source_citations');
    await f.append('a'); f.db.prepare('UPDATE chat_messages SET metadata_blob=? WHERE message_id=?').run(JSON.stringify({ source_citations: [asset] }), 'a');
    expect((await f.store.listMessages('s')).find(m => m.id === 'a')).not.toHaveProperty('source_citations');
  });

  it('reuses the existing same-session preload and clears sources if that read fails', async () => {
    const f = fixture(); await f.append('a');
    const list = vi.spyOn(f.store, 'listMessages'); const cache = createChatStoreSessionStateStore(f.store);
    await cache.preload('s'); expect(cache.sourceCitations('s')).toEqual([asset, file]);
    expect(cache.sourceCitations('other')).toEqual([]); expect(list).toHaveBeenCalledTimes(1);
    list.mockRejectedValueOnce(new Error('vault unavailable'));
    await expect(cache.preload('s')).rejects.toThrow('vault unavailable');
    expect(cache.sourceCitations('s')).toEqual([]);
  });
});
