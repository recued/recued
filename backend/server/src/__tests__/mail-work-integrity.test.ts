/** Owner deletion, stored-row binding, locked-server copy, bounded review
 * headers and owner-readable review rejections. Real encrypted store; AI stubbed
 * except in the privacy check, which uses the actual private AI layer. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  SERVER_RPC_METHODS, isReservedLocalRpc,
  type CollectionListQuery, type CollectionRecord, type MailWorkEmailRef,
} from '@recued/contracts';
import { createMailWorkService, MAIL_WORK_MANIFEST, type MailWorkServiceDeps } from '../mail-work-service.js';
import { createMailWorkStore } from '../storage/mail-work-store.js';
import { createPreapprovalCodec, type PreapprovalCodec } from '../storage/preapproval-codec.js';
import { makeMailWorkRpcHandlers } from '../mail-work-rpc-handler.js';
import { buildRecord } from '../collections/mail/mail-collection.js';
import { mailFactAiCallThrough } from '../mail-facts/ai-pass.js';
import { createPrivateAiCall } from '../private-ai-call.js';
import { createContactStore } from '../storage/contact-store.js';
import { createContactKnownValueIndexBuilder } from '../chat-recall-index.js';
import { createMetaFieldPrivacyResolverFromLocalManifestStore } from '../meta-field-privacy-resolver.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS, CANONICAL_PII_ENTITY_SCHEMAS } from '../canonical-pii-schemas.js';
import type { WsClient } from '../ws-server.js';

const message = (id: string, at: number, body = 'Can you send the revised offer?', cc: string[] = []): CollectionRecord => {
  const { record } = buildRecord({ source_id: `provider-${id}`, rfc_message_id: `<${id}@example.test>`,
    thread_id: 'client', subject: 'Acme revised offer', from: 'client@example.test', to: ['owner@example.test'], cc,
    direction: 'inbound', folder_or_label: 'INBOX', is_read: false, is_flagged: false, has_attachments: false,
    received_at: at, body_text: body }, () => at);
  return { ...record, record_id: id, body_inline: body };
};
const seed: MailWorkEmailRef = { slug: 'work', record_id: 'seed' };
const owner = { instance_id: 'owner-browser', client_kind: 'webclient' } as WsClient;
const answer = () => ({ claims: [
  { kind: 'request', text: 'The client requests a revised offer.', basis: 'email', sources: ['mail_source_1'] },
  { kind: 'next_action', text: 'Check pricing approval with your coworker.', basis: 'inference', sources: [] },
], search_queries: ['Acme pricing'] });

let db: Database.Database;
let unlocked: boolean;
let codec: PreapprovalCodec;
let mail: Map<string, CollectionRecord>;
let ai: ReturnType<typeof vi.fn<NonNullable<MailWorkServiceDeps['ai']>>>;
let deps: MailWorkServiceDeps;
let service: ReturnType<typeof createMailWorkService>;
const follow = (title?: string) => service.create({ request_id: randomUUID(), email: seed, ...(title ? { title, separate: true } : {}) });
const stored = (id: string) => db.prepare('SELECT revision, ciphertext FROM mail_work WHERE id=?').get(id) as { revision: number; ciphertext: string } | undefined;
const rejection = (promise: Promise<unknown>) => promise.then(() => { throw new Error('Expected a rejection.'); }, (error: unknown) => error as Error & { code: string; details?: unknown });

beforeEach(() => {
  db = new Database(':memory:');
  unlocked = true;
  codec = createPreapprovalCodec(() => unlocked ? new Uint8Array(32).fill(12) : null);
  mail = new Map([['seed', message('seed', 100)], ['coworker', message('coworker', 200, 'Capacity is available.')]]);
  const collection = {
    platform: 'mail' as const, slug: 'work',
    get: (id: string) => mail.get(id) ?? null,
    list: (query: CollectionListQuery) => [...mail.values()].filter(row => row.hot_fields.thread_id === query.filters?.thread_id)
      .sort((a, b) => b.received_at - a.received_at).slice(0, query.limit),
    search: () => [...mail.values()].map(row => ({ record_id: row.record_id, hot_fields: row.hot_fields, rank: 0 })),
  };
  ai = vi.fn(async () => answer());
  deps = { store: createMailWorkStore(db, codec), body: async row => row.body_inline ?? null, ai,
    registry: { get: (platform, slug) => platform === 'mail' && slug === 'work' ? collection : undefined, list: () => [collection] } };
  service = createMailWorkService(deps);
});
afterEach(() => { db.close(); });

describe('deleting followed work', () => {
  it('removes the workbook and its reviewed sources after a revision check; following again starts new work', async () => {
    const created = await follow();
    const reviewed = await service.review(created.work.id, 1);
    await expect(service.delete({ id: created.work.id, expected_revision: 1 })).rejects.toMatchObject({ code: 'conflict' });
    expect((await service.get(created.work.id)).work).toEqual(reviewed.work);
    await expect(service.delete({ id: created.work.id, expected_revision: 2 })).resolves.toEqual({ id: created.work.id, deleted: true });
    expect(db.prepare('SELECT COUNT(*) AS rows FROM mail_work').get()).toEqual({ rows: 0 });
    await expect(service.get(created.work.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.delete({ id: created.work.id, expected_revision: 2 })).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.update({ id: created.work.id, expected_revision: 2, owner_notes: 'Too late.' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await service.list({ email: seed })).works).toEqual([]);
    const again = await follow();
    expect(again.existing_work).toBeUndefined();
    expect(again.work).toMatchObject({ revision: 1, brief: null, owner_notes: '' });
    expect(again.work.id).not.toBe(created.work.id);
    expect(again.chat_session_id).not.toBe(created.chat_session_id);
  });
  it('does not let a review that finishes after deletion write the work back', async () => {
    const created = await follow();
    let finish!: (value: unknown) => void; let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    ai.mockImplementationOnce(async () => { started(); return new Promise(resolve => { finish = resolve; }); });
    const review = rejection(service.review(created.work.id, 1));
    await entered;
    await service.delete({ id: created.work.id, expected_revision: 1 });
    finish(answer());
    expect(await review).toMatchObject({ code: 'not_found' });
    expect(db.prepare('SELECT COUNT(*) AS rows FROM mail_work').get()).toEqual({ rows: 0 });
  });
  it('is a registered owner-only RPC that MCP cannot reach', async () => {
    const slice = makeMailWorkRpcHandlers(service)!;
    const registered = SERVER_RPC_METHODS.filter(method => method.startsWith('mail.work.'));
    expect(registered).toContain('mail.work.delete');
    expect([...slice.methods].sort()).toEqual([...registered].sort());
    expect(Object.keys(slice.handlers).sort()).toEqual([...registered].sort());
    expect(registered.filter(method => !isReservedLocalRpc(method))).toEqual([]);
    const created = await follow();
    for (const client of [{}, { client_kind: 'webclient' }, { instance_id: 'agent', client_kind: 'bridge' }, { instance_id: 'cli', client_kind: 'cli' }]) {
      await expect(slice.handlers['mail.work.delete']({ id: created.work.id, expected_revision: 1 }, client as WsClient))
        .rejects.toMatchObject({ code: 'unauthorized' });
    }
    expect((await service.get(created.work.id)).work).toEqual(created.work);
    await expect(slice.handlers['mail.work.delete'](null as never, owner)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(slice.handlers['mail.work.delete']({ id: created.work.id, expected_revision: 1 }, owner))
      .resolves.toEqual({ id: created.work.id, deleted: true });
  });
});

describe('stored workbooks are bound to their rows', () => {
  it('refuses a ciphertext copied from another row, so that work is neither read nor rewritten through the wrong ID', async () => {
    const a = await follow('Delivery'); const b = await follow('Billing');
    const original = stored(a.work.id)!;
    db.prepare('UPDATE mail_work SET ciphertext=? WHERE id=?').run(original.ciphertext, b.work.id);
    await expect(service.get(b.work.id)).rejects.toMatchObject({ code: 'storage_corrupt' });
    await expect(service.update({ id: b.work.id, expected_revision: 1, owner_notes: 'Written through the wrong row.' }))
      .rejects.toMatchObject({ code: 'storage_corrupt' });
    await expect(service.delete({ id: b.work.id, expected_revision: 1 })).rejects.toMatchObject({ code: 'storage_corrupt' });
    await expect(service.list()).rejects.toMatchObject({ code: 'storage_corrupt' });
    expect(stored(a.work.id)).toEqual(original);
    expect((await service.get(a.work.id)).work).toEqual(a.work);
  });
  it('refuses an older ciphertext replayed under the current revision', async () => {
    const created = await follow();
    const first = stored(created.work.id)!;
    await service.update({ id: created.work.id, expected_revision: 1, owner_notes: 'The client withdrew the request.' });
    db.prepare('UPDATE mail_work SET ciphertext=? WHERE id=?').run(first.ciphertext, created.work.id);
    await expect(service.get(created.work.id)).rejects.toMatchObject({ code: 'storage_corrupt' });
  });
});

describe('a locked server', () => {
  it('names followed work, while pre-approval keeps its own message', async () => {
    const created = await follow();
    unlocked = false;
    const locked = { code: 'server_locked', message: 'Unlock Recued to use followed work.' };
    expect(await rejection(service.get(created.work.id))).toMatchObject(locked);
    expect(await rejection(service.list())).toMatchObject(locked);
    expect(await rejection(follow())).toMatchObject(locked);
    expect(await rejection(service.update({ id: created.work.id, expected_revision: 1, owner_notes: 'x' }))).toMatchObject(locked);
    expect(await rejection(service.delete({ id: created.work.id, expected_revision: 1 }))).toMatchObject(locked);
    expect(await rejection(Promise.resolve().then(() => service.search('Acme')))).toMatchObject(locked);
    expect(() => codec.assertUnlocked()).toThrow('Unlock Recued before using pre-approval.');
  });
  it('names followed work when the key goes away just before a review is saved', async () => {
    const created = await follow();
    ai.mockImplementationOnce(async () => { unlocked = false; return answer(); });
    expect(await rejection(service.review(created.work.id, 1))).toMatchObject({ code: 'server_locked', message: 'Unlock Recued to use followed work.' });
  });
});

describe('the review packet and its rejections', () => {
  // The audit case: long cc lists and almost no body text.
  const crowdOf = (size: number) => Array.from({ length: size }, (_, index) => `participant-${index}@crowd-${index % 7}.example`);
  const crowded = (crowd: string[]) => {
    mail.clear();
    mail.set('seed', message('seed', 100, 'Ok.', crowd));
    for (let index = 1; index <= 40; index++) mail.set(`reply-${index}`, message(`reply-${index}`, 100 + index, 'Ok.', crowd));
  };
  const promptOf = (call: number) => String(ai.mock.calls[call]![0]['llm.prompt']);
  it('bounds recipient lists outside the body budget and discloses the addresses left out', async () => {
    const crowd = crowdOf(150);
    crowded(crowd);
    const created = await follow();
    const reviewed = await service.review(created.work.id, 1);
    const sent = (JSON.parse(promptOf(0)).prior_tool_calls as Array<{ tool_name: string; result: Record<string, unknown> }>)
      .filter(call => call.tool_name === 'core.mail.get').map(call => call.result as { to: string[]; cc: string[]; to_not_shown?: number; cc_not_shown?: number });
    expect(sent).toHaveLength(41);
    for (const item of sent) {
      expect(item.cc.length).toBeLessThanOrEqual(20);
      expect(item.cc.length + (item.cc_not_shown ?? 0)).toBe(150);
      expect(item.cc.every(address => crowd.includes(address))).toBe(true);
    }
    expect(sent.flatMap(item => [...item.to, ...item.cc]).join('').length).toBeLessThanOrEqual(20_000);
    const shortened = sent.filter(item => item.cc_not_shown || item.to_not_shown);
    const omitted = sent.reduce((total, item) => total + (item.cc_not_shown ?? 0) + (item.to_not_shown ?? 0), 0);
    expect(shortened).toHaveLength(41);
    expect(reviewed.work.brief?.warnings).toContain(`${shortened.length} messages list only some of their recipients; ${omitted} addresses were not included.`);
    // The newest message gets the recipient budget first, as it gets the body budget first.
    expect(sent.at(-1)!.cc).toEqual(crowd.slice(0, 20));
    // Listing every address, this packet carried 41 × 150 of them. More recipients
    // no longer make it longer; only the counts change.
    expect(promptOf(0).length).toBeLessThan(50_000);
    crowded(crowdOf(1000));
    await service.review(created.work.id, 2);
    expect(Math.abs(promptOf(1).length - promptOf(0).length)).toBeLessThan(100);
  });
  it('keeps short recipient lists whole and says nothing about them', async () => {
    const created = await follow();
    const reviewed = await service.review(created.work.id, 1);
    const email = JSON.parse(String(ai.mock.calls[0]![0]['llm.prompt'])).prior_tool_calls[0].result;
    expect(email).toMatchObject({ from: 'client@example.test', to: ['owner@example.test'], cc: [] });
    expect(email).not.toHaveProperty('to_not_shown');
    expect(email).not.toHaveProperty('cc_not_shown');
    expect(reviewed.work.brief?.warnings.join(' ')).not.toContain('recipients');
  });
  it('drops blank suggested searches instead of discarding the review', async () => {
    const created = await follow();
    ai.mockResolvedValueOnce({ ...answer(), search_queries: ['  ', 'Acme pricing', '', 'Acme capacity', 'Acme approval', 'Acme later'] });
    const reviewed = await service.review(created.work.id, 1);
    expect(reviewed.work.brief?.search_queries).toEqual(['Acme pricing', 'Acme capacity', 'Acme approval']);
    expect(reviewed.work.brief?.claims).toHaveLength(2);
  });
  it.each([
    ['an overlong statement', 'claims[1].text', { claims: [answer().claims[0], { kind: 'question', basis: 'inference', sources: [], text: 'x'.repeat(1201) }] }],
    ['an empty statement', 'claims[0].text', { claims: [{ kind: 'question', basis: 'inference', sources: [], text: '   ' }] }],
    ['a statement that is not text', 'claims[0].text', { claims: [{ kind: 'question', basis: 'inference', sources: [], text: 42 }] }],
    ['an overlong suggested search', 'search_queries[0]', { ...answer(), search_queries: ['x'.repeat(241)] }],
    ['a suggested search that is not text', 'search_queries[1]', { ...answer(), search_queries: ['Acme pricing', 42] }],
  ])('explains %s in plain English and keeps the previous review', async (_label, field, response) => {
    const created = await follow();
    const original = await service.review(created.work.id, 1);
    ai.mockResolvedValueOnce(response);
    const error = await rejection(service.review(created.work.id, 2));
    expect(error).toMatchObject({ code: 'bad_request', details: { field } });
    expect(error.message).toMatch(/^The AI returned .+ Try the review again\. The previous review is unchanged\.$/u);
    expect(error.message).not.toMatch(/must be|characters|Review statement|Suggested search/u);
    expect((await service.get(created.work.id)).work).toEqual(original.work);
  });
});

describe('recipient bounds and privacy', () => {
  it('still protects an address the shortened list leaves out when the body names it', async () => {
    const privacyDb = new Database(':memory:');
    try {
      const contacts = createContactStore(privacyDb);
      const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore(createLocalManifestStore(privacyDb),
        CANONICAL_PII_ENTITY_SCHEMAS, CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS);
      const crowd = Array.from({ length: 30 }, (_, index) => `person-${index}@listed-${index}.example`);
      const hidden = crowd.at(-1)!;
      mail.set('seed', message('seed', 100, `Please ask ${hidden} to confirm the pilot.`, crowd));
      let sent = '';
      const privateCall = createPrivateAiCall({ resolver, getContactKnownValueIndex: createContactKnownValueIndexBuilder(() => contacts),
        execute: async (_manifest, input) => {
          sent = JSON.stringify(input);
          const packet = JSON.parse(String(input['llm.prompt']));
          const email = packet.prior_tool_calls.find((call: { tool_name: string }) => call.tool_name === 'core.mail.get').result;
          return { body: { claims: [{ kind: 'request', text: 'The client asks for a confirmation.', basis: 'email', sources: [email.source] }], search_queries: [] } };
        },
      });
      service = createMailWorkService({ ...deps, store: createMailWorkStore(privacyDb, codec), ai: mailFactAiCallThrough(privateCall, MAIL_WORK_MANIFEST) });
      const created = await follow();
      await service.review(created.work.id, created.work.revision);
      const email = JSON.parse(JSON.parse(sent)['llm.prompt']).prior_tool_calls.find((call: { tool_name: string }) => call.tool_name === 'core.mail.get').result;
      expect(email.cc).toHaveLength(20);
      expect(email.cc_not_shown).toBe(10);
      expect(sent).not.toContain(hidden);
      expect(sent).not.toMatch(/@listed-\d+\.example/u);
    } finally { privacyDb.close(); }
  });
});
