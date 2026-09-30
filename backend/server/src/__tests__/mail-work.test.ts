import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollectionRecord, CollectionListQuery, CollectionSearchQuery } from '@recued/contracts';
import { createMailWorkService, type MailWorkServiceDeps } from '../mail-work-service.js';
import { createMailWorkStore } from '../storage/mail-work-store.js';
import { createPreapprovalCodec, type PreapprovalCodec } from '../storage/preapproval-codec.js';
import { makeMailWorkRpcHandlers } from '../mail-work-rpc-handler.js';
import { buildRecord } from '../collections/mail/mail-collection.js';
import type { WsClient } from '../ws-server.js';

const message = (id: string, thread = 'client', body = 'Can you send the revised offer?', at = 100): CollectionRecord => {
  const { record } = buildRecord({ source_id: `provider-${id}`, rfc_message_id: `<${id}@example.test>`,
    thread_id: thread, subject: 'Acme revised offer', from: 'client@example.test', to: ['owner@example.test'], cc: [],
    direction: 'inbound', folder_or_label: 'INBOX', is_read: false, is_flagged: false, has_attachments: false,
    received_at: at, body_text: body }, () => at);
  // Keep fixture IDs readable; hot fields/dates come from the production writer.
  return { ...record, record_id: id, body_inline: body };
};
let db: Database.Database;
let directory: string;
let unlocked: boolean;
let codec: PreapprovalCodec;
let store: ReturnType<typeof createMailWorkStore>;
let mail: Map<string, CollectionRecord>;
let second: Map<string, CollectionRecord>;
let ai: ReturnType<typeof vi.fn<NonNullable<MailWorkServiceDeps['ai']>>>;
let deps: MailWorkServiceDeps;
let service: ReturnType<typeof createMailWorkService>;
const answer = () => ({ claims: [
  { kind: 'request', text: 'The client requests a revised offer.', basis: 'email', sources: ['mail_source_1'] },
  { kind: 'next_action', text: 'Check pricing approval with your coworker.', basis: 'inference', sources: [] },
], search_queries: ['Acme pricing'] });
const collection = (slug: string, rows: Map<string, CollectionRecord>) => ({
  platform: 'mail' as const, slug,
  get: (id: string) => rows.get(id) ?? null,
  list: (query: CollectionListQuery) => [...rows.values()].filter(row => row.hot_fields.thread_id === query.filters?.thread_id)
    .sort((a, b) => b.received_at - a.received_at).slice(0, query.limit),
  search: vi.fn((_query: CollectionSearchQuery) => [...rows.values()].map(row => ({ record_id: row.record_id, hot_fields: row.hot_fields, rank: 0 }))),
});
const create = (request_id = randomUUID()) => service.create({ request_id, email: { slug: 'work', record_id: 'seed' }, goal: 'Find a workable offer. The exact solution is still open.', separate: true });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mail-work-'));
  db = new Database(join(directory, 'realm.db'));
  unlocked = true;
  codec = createPreapprovalCodec(() => unlocked ? new Uint8Array(32).fill(12) : null);
  store = createMailWorkStore(db, codec);
  mail = new Map([['seed', message('seed')], ['coworker', message('coworker', 'internal', 'Capacity is available; pricing is pending.', 200)]]);
  second = new Map([['seed', message('seed', 'client', 'Different account; unrelated matter.', 300)]]);
  const collections = [collection('work', mail), collection('personal', second)];
  ai = vi.fn(async () => answer());
  deps = { store, registry: { get: (platform, slug) => platform === 'mail' ? collections.find(item => item.slug === slug) : undefined,
    list: () => collections }, body: async row => row.body_inline ?? null, ai };
  service = createMailWorkService(deps);
});
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

describe('following work from email', () => {
  it('reuses an exact conversation on another click and keeps resolved work resolved', async () => {
    const first = await service.create({ request_id: randomUUID(), email: { slug: 'work', record_id: 'seed' } });
    await service.update({ id: first.work.id, expected_revision: 1, status: 'resolved', resolution_note: 'Finished.' });
    mail.set('reply', message('reply', 'client', 'Thank you.', 500));
    const again = await service.create({ request_id: randomUUID(), email: { slug: 'work', record_id: 'reply' } });
    expect(again).toMatchObject({ existing_work: true, chat_session_id: first.chat_session_id, work: { id: first.work.id, status: 'resolved' } });
    expect((await service.list({ email: { slug: 'work', record_id: 'reply' } })).works.map(work => work.id)).toEqual([first.work.id]);
    expect((await service.list({ email: { slug: 'personal', record_id: 'seed' } })).works).toEqual([]);
    expect(ai).not.toHaveBeenCalled();
  });
  it('concurrent clicks from separate tabs produce one work and Chat identity', async () => {
    const results = await Promise.all([
      service.create({ request_id: randomUUID(), email: { slug: 'work', record_id: 'seed' } }),
      service.create({ request_id: randomUUID(), email: { slug: 'work', record_id: 'seed' } }),
    ]);
    expect(results[0]!.work.id).toBe(results[1]!.work.id);
    expect((await service.list()).works).toHaveLength(1);
  });
  it('requires a choice when several investigations share the exact conversation', async () => {
    const first = await create(); const secondWork = await create();
    expect((await service.list({ email: { slug: 'work', record_id: 'seed' } })).works.map(work => work.id).sort())
      .toEqual([first.work.id, secondWork.work.id].sort());
    await expect(service.create({ request_id: randomUUID(), email: { slug: 'work', record_id: 'seed' } }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect((await create()).work.id).not.toBe(first.work.id);
  });
  it('looks beyond the first list page and does not match by subject alone', async () => {
    const first = await create();
    for (let index = 0; index < 31; index++) {
      const id = `other-${index}`;
      mail.set(id, message(id, id));
      await service.create({ request_id: randomUUID(), email: { slug: 'work', record_id: id } });
    }
    expect((await service.list({ email: { slug: 'work', record_id: 'seed' } })).works.map(work => work.id)).toEqual([first.work.id]);
  });
  it('reports whether an investigation has started without creating or submitting Chat work', async () => {
    let started = false;
    service = createMailWorkService({ ...deps, hasInvestigation: async () => started });
    const first = await create();
    expect((await service.get(first.work.id)).investigation_started).toBe(false);
    started = true;
    expect((await service.get(first.work.id)).investigation_started).toBe(true);
    expect(ai).not.toHaveBeenCalled();
  });
  it('persists encrypted, survives reopening, and retries creation without duplicating work', async () => {
    const request = randomUUID();
    const [first, retry] = await Promise.all([create(request), create(request)]);
    expect(retry).toEqual(first);
    expect(first.work).toMatchObject({ revision: 1, status: 'active', brief: null });
    expect(first.chat_session_id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-8[\da-f]{3}-[\da-f]{12}$/);
    expect(JSON.stringify(db.prepare('SELECT * FROM mail_work').all())).not.toContain('Acme');
    const restarted = createMailWorkService({ ...deps, store: createMailWorkStore(db, codec) });
    expect((await restarted.get(first.work.id)).work).toEqual(first.work);
    expect((await restarted.get(first.work.id)).chat_session_id).toBe(first.chat_session_id);
    expect((await restarted.list()).works).toHaveLength(1);
    await expect(service.create({ request_id: request, email: { slug: 'personal', record_id: 'seed' } })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('allows multiple matters in one thread and keeps mailbox identity distinct', async () => {
    const a = await create(); const b = await create();
    expect(a.work.id).not.toBe(b.work.id);
    expect(a.chat_session_id).not.toBe(b.chat_session_id);
    const linked = await service.update({ id: a.work.id, expected_revision: 1, link_email: { slug: 'personal', record_id: 'seed' } });
    expect(linked.work.threads).toHaveLength(2);
    expect(linked.chat_session_id).toBe(a.chat_session_id);
    expect(linked.sources.map(source => source.slug).sort()).toEqual(['personal', 'work']);
    expect((await service.get(b.work.id)).work.threads).toHaveLength(1);
  });
  it('reconstructs linked conversations with validated evidence, without resolving or executing anything', async () => {
    const created = await create();
    const linked = await service.update({ id: created.work.id, expected_revision: 1, link_email: { slug: 'work', record_id: 'coworker' } });
    const result = await service.review(linked.work.id, linked.work.revision);
    expect(result.work.status).toBe('active');
    expect(result.needs_review).toBe(false);
    expect(result.work.brief?.claims[0]?.evidence).toEqual([{ slug: 'work', record_id: 'coworker' }]);
    const packet = JSON.parse(String(ai.mock.calls[0]![0]['llm.prompt']));
    expect(packet.prior_tool_calls).toHaveLength(3);
    expect(packet.prior_tool_calls[0].result.body_text).toContain('Can you send');
    expect(packet.prior_tool_calls[0].result).toHaveProperty('attachment_content_included', false);
    expect(packet.prior_tool_calls[0].result.date).toBe(new Date(mail.get('seed')!.received_at).toISOString());
    expect(packet.prior_tool_calls[0].result.received_at_iso).toBe(packet.prior_tool_calls[0].result.date);
    expect(packet.prior_tool_calls[2].result.desired_outcome).toContain('still open');
    expect(result.work.brief?.warnings.join(' ')).toContain('offline');
  });
  it('detects new, edited and removed mail but ignores read flags and preserves the saved review', async () => {
    const created = await create();
    const reviewed = await service.review(created.work.id, 1);
    const seed = mail.get('seed')!;
    mail.set('seed', { ...seed, modified_at: 500, hot_fields: { ...seed.hot_fields, is_read: true, labels: ['read'] } });
    expect((await service.get(created.work.id)).needs_review).toBe(false);
    mail.set('reply', message('reply', 'client', 'We agree to the revised scope.', 1000));
    const changed = await service.get(created.work.id);
    expect(changed.needs_review).toBe(true);
    expect(changed.sources.find(source => source.record_id === 'reply')?.changed).toBe(true);
    expect(changed.work.brief).toEqual(reviewed.work.brief);
    mail.delete('reply');
    mail.set('seed', { ...seed, body_inline: 'A changed request.' });
    expect((await service.get(created.work.id)).needs_review).toBe(true);
    mail.delete('seed');
    expect((await service.get(created.work.id)).warnings.join(' ')).toMatch(/missing|no longer/);
  });
  it('uses explicit owner resolution and permits reopening without changing a commitment', async () => {
    const created = await create();
    await expect(service.update({ id: created.work.id, expected_revision: 1, status: 'resolved' })).rejects.toMatchObject({ code: 'bad_request' });
    const resolved = await service.update({ id: created.work.id, expected_revision: 1, status: 'resolved', resolution_note: 'Client accepted by phone.' });
    expect(resolved.work.status).toBe('resolved');
    await expect(service.review(created.work.id, 2)).rejects.toMatchObject({ code: 'bad_request' });
    expect((await service.update({ id: created.work.id, expected_revision: 2, status: 'active' })).work.status).toBe('active');
  });
  it('keeps the owner explanation while work is resolved, including context-only edits', async () => {
    const created = await create();
    const resolved = await service.update({ id: created.work.id, expected_revision: 1, status: 'resolved', resolution_note: 'Client accepted by phone.' });
    await expect(service.update({ id: created.work.id, expected_revision: 2, resolution_note: '  ', owner_notes: 'New context.' }))
      .rejects.toMatchObject({ code: 'bad_request' });
    expect((await service.get(created.work.id)).work).toEqual(resolved.work);
    expect((await service.update({ id: created.work.id, expected_revision: 2, status: 'active', resolution_note: '' })).work.status).toBe('active');
  });
  it('detects changed effective dates on production-shaped mail without a date hot field', async () => {
    const seed = mail.get('seed')!;
    expect(seed.hot_fields).not.toHaveProperty('date');
    const created = await create();
    const reviewed = await service.review(created.work.id, 1);
    mail.set('seed', { ...seed, received_at: 500 });
    const changed = await service.get(created.work.id);
    expect(changed.needs_review).toBe(true);
    expect(changed.sources[0]?.changed).toBe(true);
    expect(changed.work.brief).toEqual(reviewed.work.brief);
  });
  it('invalidates an old review after context changes and lets the owner correct conversation links', async () => {
    const created = await create();
    const reviewed = await service.review(created.work.id, 1);
    const same = await service.update({ id: created.work.id, expected_revision: 2, goal: reviewed.work.goal, owner_notes: '' });
    expect(same.needs_review).toBe(false);
    const linked = await service.update({ id: created.work.id, expected_revision: 3, link_email: { slug: 'work', record_id: 'coworker' } });
    const corrected = await service.update({ id: created.work.id, expected_revision: 4, unlink_thread: linked.work.threads[1]!, owner_notes: 'This is for a separate sale.' });
    expect(corrected.work.threads).toHaveLength(1);
    expect(corrected.needs_review).toBe(true);
    await expect(service.update({ id: created.work.id, expected_revision: 5, unlink_thread: corrected.work.threads[0]! })).rejects.toMatchObject({ code: 'bad_request' });
  });
  it('grounds the review in the work name and prior owner resolution, and invalidates changes to either', async () => {
    const created = await create();
    await service.update({ id: created.work.id, expected_revision: 1, title: 'Only the warranty question',
      status: 'resolved', resolution_note: 'The warranty request was declined by phone.' });
    await service.update({ id: created.work.id, expected_revision: 2, status: 'active' });
    await service.review(created.work.id, 3);
    const packet = JSON.parse(String(ai.mock.calls[0]![0]['llm.prompt']));
    expect(packet.prior_tool_calls.find((call: { tool_name: string }) => call.tool_name === 'mail.work.owner_context').result).toMatchObject({
      title: 'Only the warranty question', resolution_note: 'The warranty request was declined by phone.',
    });
    expect((await service.update({ id: created.work.id, expected_revision: 4, title: 'The delivery question instead' })).needs_review).toBe(true);
    await service.review(created.work.id, 5);
    expect((await service.update({ id: created.work.id, expected_revision: 6, resolution_note: 'Earlier decision withdrawn.' })).needs_review).toBe(true);
  });
  it('paginates work with identical timestamps without dropping entries', async () => {
    service = createMailWorkService({ ...deps, now: () => 1000 });
    for (let index = 0; index < 32; index++) await create();
    const first = await service.list();
    const last = await service.list({ before: first.next_cursor! });
    expect(first.works).toHaveLength(30); expect(last.works).toHaveLength(2);
    expect(new Set([...first.works, ...last.works].map(work => work.id)).size).toBe(32);
  });
});

describe('review integrity and boundaries', () => {
  it.each([['completion_condition', 'owner'], ['completion_condition', 'email'], ['next_action', 'owner'], ['next_action', 'email']] as const)('labels %s proposals as inference even when the model calls them %s facts', async (kind, basis) => {
    const created = await create();
    const sources = basis === 'email' ? ['mail_source_1'] : [];
    ai.mockResolvedValueOnce({ claims: [{ kind, basis, sources,
      text: 'A signed order would complete the work.' }], search_queries: [] });
    const reviewed = await service.review(created.work.id, created.work.revision);
    expect(reviewed.work.brief?.claims).toEqual([{ kind, basis: 'inference',
      text: 'A signed order would complete the work.', evidence: basis === 'email' ? [{ slug: 'work', record_id: 'seed' }] : [] }]);
    expect(reviewed.work.status).toBe('active');
  });
  it('explains an unrestored private reference and preserves the previous review', async () => {
    const created = await create();
    const original = await service.review(created.work.id, 1);
    ai.mockResolvedValueOnce({ claims: [{ kind: 'request', basis: 'email', sources: ['mail_source_1'],
      text: 'pii.person1@client.test requested the pilot.' }], search_queries: [] });
    await expect(service.review(created.work.id, 2)).rejects.toMatchObject({ code: 'bad_request',
      message: expect.stringContaining('private reference that could not be matched back') });
    expect((await service.get(created.work.id)).work).toEqual(original.work);
  });
  it('accepts a faithful claim that says PII or names a pii.* file', async () => {
    const created = await create();
    const text = 'Send the redacted pii.csv file; it will not contain any PII.';
    ai.mockResolvedValueOnce({ claims: [{ kind: 'next_action', basis: 'inference', sources: [], text }],
      search_queries: ['PII. export'] });
    const reviewed = await service.review(created.work.id, created.work.revision);
    expect(reviewed.work.brief?.claims).toEqual([{ kind: 'next_action', basis: 'inference', text, evidence: [] }]);
  });
  it.each(['m7@d9.invalid', 'pii.Person3', 'cap_pii.Org2', 'd4.invalid'])('still rejects an unrestored %s', async token => {
    const created = await create();
    ai.mockResolvedValueOnce({ claims: [{ kind: 'next_action', basis: 'inference', sources: [],
      text: `Ask ${token} about the revised offer.` }], search_queries: [] });
    await expect(service.review(created.work.id, created.work.revision)).rejects.toMatchObject({ code: 'bad_request',
      message: expect.stringContaining('private reference that could not be matched back') });
  });
  it.each(['inference', 'owner'])('accepts an omitted citation list on an explicit %s claim from a live-model-shaped response', async basis => {
    const created = await create();
    const text = basis === 'owner' ? 'Find a workable offer; the solution is still open.' : 'Check pricing approval with your coworker.';
    ai.mockResolvedValueOnce({ claims: [answer().claims[0], { kind: 'next_action', basis, text }], search_queries: [] });
    const reviewed = await service.review(created.work.id, 1);
    expect(reviewed.work.brief?.claims[0]?.evidence).toEqual([{ slug: 'work', record_id: 'seed' }]);
    expect(reviewed.work.brief?.claims[1]).toEqual({ kind: 'next_action', basis: 'inference', text, evidence: [] });
    expect(reviewed.work.status).toBe('active');
  });
  it.each([
    { basis: 'email' },
    { basis: 'email', sources: null },
    { basis: 'inference', sources: null },
    { basis: 'inference', sources: 'm1' },
    { basis: 'owner', sources: ['mail_source_999'] },
    { basis: 'owner', sources: ['owner'] },
    { basis: 'email', sources: ['mail_source_1', 'owner'] },
  ])('still rejects invalid or missing email evidence: %j', async claim => {
    const created = await create();
    const original = await service.review(created.work.id, 1);
    ai.mockResolvedValueOnce({ claims: [{ kind: 'next_action', text: 'Check pricing approval.', ...claim }] });
    await expect(service.review(created.work.id, 2)).rejects.toMatchObject({ code: 'bad_request' });
    expect((await service.get(created.work.id)).work).toEqual(original.work);
  });
  it('rejects an array masquerading as the email basis with no supporting evidence', async () => {
    const created = await create();
    ai.mockResolvedValueOnce({ claims: [{ kind: 'agreement', basis: ['email'], text: 'The client accepted.', sources: [] }] });
    await expect(service.review(created.work.id, 1)).rejects.toMatchObject({ code: 'bad_request' });
    expect((await service.get(created.work.id)).work).toEqual(created.work);
  });
  it.each(['unknown citation', 'missing citation', 'invalid basis', 'invalid kind', 'empty'])('rejects %s without replacing a prior brief', async kind => {
    const created = await create(); const original = await service.review(created.work.id, 1);
    const response = answer();
    if (kind === 'unknown citation') response.claims[0]!.sources = ['mail_source_999'];
    if (kind === 'missing citation') response.claims[0]!.sources = [];
    if (kind === 'invalid basis') response.claims[0]!.basis = 'confirmed';
    if (kind === 'invalid kind') response.claims[0]!.kind = 'execute';
    if (kind === 'empty') response.claims = [];
    ai.mockResolvedValueOnce(response);
    await expect(service.review(created.work.id, 2)).rejects.toMatchObject({ code: 'bad_request' });
    expect((await service.get(created.work.id)).work).toEqual(original.work);
  });
  it.each(['new mail', 'message date', 'owner edit', 'unlink', 'archive', 'lock'])('rejects a late AI result after %s', async change => {
    const created = await create();
    const linked = await service.update({ id: created.work.id, expected_revision: 1, link_email: { slug: 'work', record_id: 'coworker' } });
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    ai.mockImplementationOnce(async () => { started(); return new Promise(resolve => { finish = resolve; }); });
    const review = service.review(created.work.id, 2);
    const rejection = expect(review).rejects.toMatchObject({ code: change === 'lock' ? 'server_locked' : 'conflict' });
    await entered;
    if (change === 'new mail') mail.set('reply', message('reply', 'client', 'Please change quantity.', 300));
    if (change === 'message date') mail.set('seed', { ...mail.get('seed')!, received_at: 900 });
    if (change === 'owner edit') await service.update({ id: created.work.id, expected_revision: 2, owner_notes: 'New constraint.' });
    if (change === 'unlink') await service.update({ id: created.work.id, expected_revision: 2, unlink_thread: linked.work.threads[1]! });
    if (change === 'archive') await service.update({ id: created.work.id, expected_revision: 2, status: 'archived' });
    if (change === 'lock') unlocked = false;
    finish(answer()); await rejection;
    unlocked = true;
    expect((await service.get(created.work.id)).work.brief).toBeNull();
  });
  it('checks for source changes even during final encryption', async () => {
    const created = await create();
    let mutate = false;
    const racingStore = createMailWorkStore(db, { ...codec, async seal(value) {
      const ciphertext = await codec.seal(value);
      if (mutate) mail.set('reply', message('reply', 'client', 'Changed just before commit.', 1000));
      return ciphertext;
    } });
    service = createMailWorkService({ ...deps, store: racingStore }); mutate = true;
    await expect(service.review(created.work.id, 1)).rejects.toMatchObject({ code: 'conflict' });
    expect((await service.get(created.work.id)).work.brief).toBeNull();
  });
  it('limits concurrent reviews and lets only one concurrent editor win', async () => {
    const created = await create();
    const edits = await Promise.allSettled([
      service.update({ id: created.work.id, expected_revision: 1, goal: 'First outcome' }),
      service.update({ id: created.work.id, expected_revision: 1, goal: 'Second outcome' }),
    ]);
    expect(edits.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    let finish!: (value: unknown) => void; let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    ai.mockImplementationOnce(async () => { started(); return new Promise(resolve => { finish = resolve; }); });
    const pending = service.review(created.work.id, 2); await entered;
    await expect(service.review(created.work.id, 2)).rejects.toMatchObject({ code: 'conflict' });
    finish(answer()); await pending;
    expect(ai).toHaveBeenCalledTimes(1);
  });
  it('reports partial bodies, bounded history, missing mailboxes and unavailable AI honestly', async () => {
    const created = await create();
    for (let index = 0; index < 45; index++) mail.set(`reply-${index}`, message(`reply-${index}`, 'client', 'a'.repeat(17000), 200 + index));
    const result = await service.review(created.work.id, 1);
    expect(result.sources).toHaveLength(41);
    expect(result.work.brief?.warnings.join(' ')).toContain('shortened');
    expect(result.warnings.join(' ')).toContain('latest 40');
    const withoutAI = createMailWorkService({ ...deps, ai: undefined });
    await expect(withoutAI.review(created.work.id, 2)).rejects.toMatchObject({ code: 'not_configured' });
    const withoutMail = createMailWorkService({ ...deps, registry: { get: () => undefined, list: () => [] } });
    expect((await withoutMail.get(created.work.id)).warnings).toContain('Mailbox work is unavailable.');
  });
  it('carries the stored attachment-presence flag without pretending to have attachment metadata', async () => {
    const seed = mail.get('seed')!;
    seed.hot_fields.has_attachments = true;
    const created = await create();
    const reviewed = await service.review(created.work.id, 1);
    const packet = JSON.parse(String(ai.mock.calls[0]![0]['llm.prompt']));
    expect(packet.prior_tool_calls[0].result).toMatchObject({ has_attachments: true, attachment_content_included: false });
    expect(reviewed.work.brief?.warnings.join(' ')).toContain('Attachment names and contents');
    seed.hot_fields.has_attachments = false;
    expect((await service.get(created.work.id)).needs_review).toBe(true);
  });
  it('escapes FTS queries, reports search failures, and never auto-links matches', async () => {
    const created = await create();
    const query = 'Acme OR "*"';
    const results = service.search(query);
    expect(results.emails.some(email => email.slug === 'personal')).toBe(true);
    expect(deps.registry.list()[0]!.search).toHaveBeenCalledWith(expect.objectContaining({ query: '"Acme" AND "OR" AND """*"""' }));
    expect((await service.get(created.work.id)).work.threads).toHaveLength(1);
    unlocked = false;
    expect(() => service.search(query)).toThrow();
  });
  it('reports a missing configured model and preserves the saved work after unreadable model output', async () => {
    const created = await create();
    ai.mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { code: 'AI_LLM_UNAVAILABLE' }));
    await expect(service.review(created.work.id, 1)).rejects.toMatchObject({ code: 'not_configured' });
    ai.mockResolvedValueOnce('not a JSON review');
    await expect(service.review(created.work.id, 1)).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('previous review is unchanged') });
    expect((await service.get(created.work.id)).work).toEqual(created.work);
  });
  it('requires the paired owner webclient on every RPC, including read and search', async () => {
    const handlers = makeMailWorkRpcHandlers(service)!.handlers;
    for (const client of [{}, { instance_id: 'agent', client_kind: 'bridge' }, { instance_id: 'cli', client_kind: 'cli' }]) {
      for (const method of Object.keys(handlers) as Array<keyof typeof handlers>) {
        await expect(handlers[method]({} as never, client as WsClient)).rejects.toMatchObject({ code: 'unauthorized' });
      }
    }
    const owner = { instance_id: 'owner-browser', client_kind: 'webclient' } as WsClient;
    await expect(handlers['mail.work.list'](undefined, owner)).resolves.toMatchObject({ works: [] });
    await expect(handlers['mail.work.create'](null as never, owner)).rejects.toMatchObject({ code: 'bad_request' });
  });
});
