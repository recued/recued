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
const answer = () => {
  const input = ai?.mock.calls.at(-1)?.[0];
  const packet = input ? JSON.parse(String(input['llm.prompt'])) : null;
  const email = packet?.prior_tool_calls.find((c: { result: { source?: string } }) => c.result.source === 'mail_source_1')?.result;
  if (email && !email.body_text) return { review_format: 'source_actions_v2', claims: [{ id: 'q1', kind: 'question', basis: 'inference', text: 'Which missing source can clarify the request?', sources: [], targets: [] }], search_queries: [] };
  return { review_format: 'source_actions_v2', claims: [
    { id: 'f1', kind: 'request', basis: 'email', sources: ['mail_source_1'],
      excerpt: { source: 'mail_source_1', quote: email?.body_text?.slice(0, 800) ?? 'Can you send the revised offer?', state: 'current' } },
    { id: 'a1', kind: 'next_action', text: 'Check pricing approval with your coworker.', basis: 'inference', sources: [], targets: ['f1'],
      action: { mode: 'contact', scope: 'pricing approval', permission: 'requires_owner_approval', permission_quote: null, conditions: [] } },
  ], search_queries: ['Acme pricing'] };
};
const collection = (slug: string, rows: Map<string, CollectionRecord>) => ({
  platform: 'mail' as const, slug,
  get: (id: string) => rows.get(id) ?? null,
  list: (query: CollectionListQuery) => [...rows.values()].filter(row => row.hot_fields.thread_id === query.filters?.thread_id)
    .sort((a, b) => b.received_at - a.received_at).slice(0, query.limit),
  search: vi.fn((_query: CollectionSearchQuery) => [...rows.values()].map(row => ({ record_id: row.record_id, hot_fields: row.hot_fields, rank: 0 }))),
});
const create = (request_id = randomUUID()) => service.create({ request_id, email: { slug: 'work', record_id: 'seed' }, goal: 'Find a workable offer. The exact solution is still open.', separate: true });
const passage = (source: string): string => {
  const packet = JSON.parse(String(ai.mock.calls.at(-1)![0]['llm.prompt']));
  return packet.prior_tool_calls.find((call: any) => call.tool_name === 'mail.work.passage_catalog')
    .result.passage_catalog.find((row: any) => row.source === source).id;
};
const sectionAnswer = () => ({
  review_format: 'source_sections_v1',
  facts: [{ id: 'f1', kind: 'request', source: 'mail_source_1', quote: 'Can you send the revised offer?', state: 'current' }],
  questions: [], completion_conditions: [], search_queries: [],
  actions: [{ id: 'a1', activity: 'Draft the revised offer privately.', mode: 'private_preparation',
    permission: { kind: 'not_contact' }, targets: ['f1'], conditions: [] },
  { id: 'a2', activity: 'Send the revised offer.', mode: 'contact',
    permission: { kind: 'requires_owner_approval' }, targets: ['f1'], conditions: [] }],
});

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
  it('stores the native source plan with separate phone provenance, exact qualifications and scoped contact approval', async () => {
    const created = await create();
    const notes = 'The client withdrew the old request by phone. Ask me before contacting anybody.';
    const updated = await service.update({ id: created.work.id, expected_revision: created.work.revision, owner_notes: notes });
    ai.mockImplementation(async input => {
      expect(input['llm.output_schema']).toMatchObject({ type: 'object' });
      return { task: 'propose', facts: [passage('owner_notes'), passage('mail_source_1')], actions: [
        { operation: 'draft', target: 'options privately.', context: [passage('mail_source_1')], source_notes: [] },
        { operation: 'ask', target: 'the coworker about capacity.', context: [passage('owner_notes')], source_notes: [passage('owner_notes')] },
      ], questions: [{ kind: 'scope', context: [passage('mail_source_1')] }] };
    });
    const reviewed = await service.review(updated.work.id, updated.work.revision);
    expect(reviewed.work.brief!.claims[0]).toEqual({ kind: 'progress', basis: 'owner', text: `Source 1 — Your notes: “${notes}”`, evidence: [] });
    expect(reviewed.work.brief!.claims[1]!.evidence).toEqual([{ slug: 'work', record_id: 'seed' }]);
    expect(reviewed.work.brief!.claims[1]!.text).toBe('Source 2 — Email: “Can you send the revised offer?”');
    expect(reviewed.work.brief!.claims[2]!.text).toBe('Private preparation: Draft options privately.\nSource context:\nSource 2 — Email');
    expect(reviewed.work.brief!.claims[2]!.evidence).toEqual([{ slug: 'work', record_id: 'seed' }]);
    expect(reviewed.work.brief!.claims[3]!.text).toContain('After your approval: Ask the coworker');
    expect(reviewed.work.brief!.claims[3]!.text).toContain('Source notes for this step:\nSource 1 — Your notes');
    expect(reviewed.work.brief!.claims[3]!.evidence).toEqual([]); // phone report never becomes an email claim
    expect(reviewed.work.brief!.claims.map(item => item.text).join('\n').split(notes)).toHaveLength(2);
    expect(reviewed.work.status).toBe('active');
    expect(ai).toHaveBeenCalledTimes(1);
    expect((await service.get(reviewed.work.id)).work).toEqual(reviewed.work);
  });
  it('rejects an invalid native declaration without fallback, repair or replacing the saved review', async () => {
    const created = await create(), prior = await service.review(created.work.id, created.work.revision);
    ai.mockResolvedValueOnce({ task: 'propose', facts: [{ source: 'mail_source_1', quote: 'Permission was given over the phone.' }], actions: [], questions: [] });
    await expect(service.review(prior.work.id, prior.work.revision)).rejects.toMatchObject({ code: 'bad_request' });
    expect((await service.get(prior.work.id)).work).toEqual(prior.work);
    expect(ai).toHaveBeenCalledTimes(2);
  });
  it.each(['native', 'legacy'])('preserves the saved review when a %s plan calls an exact prohibition permission', async format => {
    const created = await create(), prior = await service.review(created.work.id, created.work.revision);
    const notes = 'Do not contact anyone without my approval.';
    const updated = await service.update({ id: prior.work.id, expected_revision: prior.work.revision, owner_notes: notes });
    const plan = () => ({ task: 'propose', facts: [passage('owner_notes')], actions: [
      { operation: 'send', target: 'the offer.', context: [passage('owner_notes')], source_notes: [],
        permission: { kind: 'explicitly_permitted', source: 'owner_notes', quote: notes } },
    ], questions: [] });
    const legacy = answer();
    ai.mockImplementationOnce(async () => format === 'native' ? plan() : { ...legacy, claims: legacy.claims.map((claim, index) => index === 1
      ? { ...claim, action: { mode: 'contact', scope: 'pricing approval', permission: 'explicitly_permitted', permission_quote: notes, conditions: [] } }
      : claim) });
    await expect(service.review(updated.work.id, updated.work.revision)).rejects.toMatchObject({ code: 'bad_request' });
    expect((await service.get(updated.work.id)).work).toEqual(updated.work);
    expect(JSON.stringify(ai.mock.calls.at(-1)![0]['llm.output_schema'])).not.toContain('explicitly_permitted');
    expect(ai).toHaveBeenCalledTimes(2); // no semantic repair or hidden retry
    // A later explicit review can still propose the contact with approval.
    ai.mockImplementationOnce(async () => ({ ...plan(), actions: [{ operation: 'send', target: 'the offer.',
      context: [passage('owner_notes')], source_notes: [] }] }));
    const next = await service.review(updated.work.id, updated.work.revision);
    expect(next.work.brief?.claims.at(-1)?.text).toContain('After your approval: Send the offer.');
    expect(ai).toHaveBeenCalledTimes(3);
  });
  it('stores the sectioned review with exact target-derived citations and permission rendering', async () => {
    ai.mockImplementation(async () => sectionAnswer());
    const created = await create();
    const result = await service.review(created.work.id, created.work.revision);
    expect(result.work.brief?.claims).toEqual([
      { kind: 'request', basis: 'email', text: 'Email (AI status: current): “Can you send the revised offer?”', evidence: [{ slug: 'work', record_id: 'seed' }] },
      { kind: 'next_action', basis: 'inference', text: 'Private preparation: Draft the revised offer privately.', evidence: [{ slug: 'work', record_id: 'seed' }] },
      { kind: 'next_action', basis: 'inference', text: 'After your approval: Send the revised offer.', evidence: [{ slug: 'work', record_id: 'seed' }] },
    ]);
    expect(result.work.status).toBe('active');
    expect((await service.get(created.work.id)).work).toEqual(result.work);
  });
  it.each(['source_sections_v2', 'source_sections_v3'])('persists %s conditions and exact owner wording while the private draft stays available', async format => {
    const prerequisite = 'Check pricing before sending the offer.';
    const ownerNotes = 'Review the offer with me before sending it.';
    mail.set('coworker', message('coworker', 'internal', prerequisite, 200));
    const created = await create();
    const updated = await service.update({ id: created.work.id, expected_revision: created.work.revision,
      owner_notes: ownerNotes, link_email: { slug: 'work', record_id: 'coworker' } });
    ai.mockImplementation(async (input) => {
      const packet = JSON.parse(String(input['llm.prompt']));
      const token = (body: string) => packet.prior_tool_calls.find((c: any) => c.result.body_text === body).result.source;
      const reply: any = sectionAnswer();
      reply.review_format = format;
      reply.facts[0].source = token('Can you send the revised offer?');
      reply.facts.push({ id: 'f2', kind: 'dependency', source: token(prerequisite), quote: prerequisite, state: 'current' },
        { id: 'f3', kind: 'dependency', source: 'owner_notes', quote: ownerNotes, state: 'current' });
      reply.actions[1].conditions = format === 'source_sections_v3' ? [{ target: 'f2' }, { target: 'f3' }]
        : [{ text: 'Pricing has been checked.', target: 'f2' }, { text: 'The owner has reviewed the offer.', target: 'f3' }];
      return reply;
    });
    const reviewed = await service.review(updated.work.id, updated.work.revision);
    const actions = reviewed.work.brief!.claims.filter(c => c.kind === 'next_action');
    expect(actions[0]).toMatchObject({ text: 'Private preparation: Draft the revised offer privately.',
      evidence: [{ slug: 'work', record_id: 'seed' }] });
    const conditions = format === 'source_sections_v3' ? `${prerequisite}; ${ownerNotes}` : 'Pricing has been checked.; The owner has reviewed the offer.';
    expect(actions[1]).toEqual({ kind: 'next_action', basis: 'inference',
      text: `After your approval: Send the revised offer. Conditions for Send the revised offer.: ${conditions} (owner notes: ${ownerNotes})`,
      evidence: [{ slug: 'work', record_id: 'seed' }, { slug: 'work', record_id: 'coworker' }] });
    expect((await service.get(reviewed.work.id)).work).toEqual(reviewed.work);
    expect(ai).toHaveBeenCalledTimes(1);
  });
  it('preserves saved work when v3 tries to rewrite a condition, then accepts a later explicit review', async () => {
    const created = await create(), prior = await service.review(created.work.id, created.work.revision);
    const prerequisite = 'Check pricing with me before sending the offer.';
    const updated = await service.update({ id: prior.work.id, expected_revision: prior.work.revision, owner_notes: prerequisite });
    const response: any = sectionAnswer(); response.review_format = 'source_sections_v3';
    response.facts.push({ id: 'f2', kind: 'dependency', source: 'owner_notes', quote: prerequisite, state: 'current' });
    response.actions[1].conditions = [{ target: 'f2', text: 'Pricing must be approved.' }];
    const raw = structuredClone(response); ai.mockResolvedValueOnce(response);
    await expect(service.review(updated.work.id, updated.work.revision)).rejects.toMatchObject({ code: 'bad_request' });
    expect(response).toEqual(raw);
    expect((await service.get(updated.work.id)).work).toEqual(updated.work);
    const corrected = structuredClone(response); corrected.actions[1].conditions = [{ target: 'f2' }];
    ai.mockResolvedValueOnce(corrected);
    const next = await service.review(updated.work.id, updated.work.revision);
    expect(next.work.revision).toBe(updated.work.revision + 1);
    expect(next.work.brief?.claims.at(-1)?.text).toContain(prerequisite);
    expect(next.work.brief?.claims.at(-1)?.text).not.toContain('Pricing must be approved');
    expect(ai).toHaveBeenCalledTimes(3);
  });
  it.each(['missing_fact', 'retired_fact', 'wrong_quote', 'legacy_condition'])(
    'preserves the saved review on v2 %s rejection and can accept the next explicit review', async problem => {
      const created = await create(), prior = await service.review(created.work.id, created.work.revision);
      const response: any = sectionAnswer(); response.review_format = 'source_sections_v2';
      response.actions[1].conditions = [{ text: 'Confirm the supplied request.', target: 'f1' }];
      if (problem === 'missing_fact') response.actions[1].conditions[0].target = 'missing';
      if (problem === 'retired_fact') response.facts[0].state = 'superseded';
      if (problem === 'wrong_quote') response.facts[0].quote = 'The request has been accepted.';
      if (problem === 'legacy_condition') response.actions[1].conditions = [{ text: 'Wait.', sources: ['owner_notes'], owner_quote: null }];
      const raw = structuredClone(response); ai.mockResolvedValueOnce(response);
      await expect(service.review(prior.work.id, prior.work.revision)).rejects.toMatchObject({ code: 'bad_request' });
      expect(response).toEqual(raw);
      expect((await service.get(prior.work.id)).work).toEqual(prior.work);
      ai.mockResolvedValueOnce({ ...sectionAnswer(), review_format: 'source_sections_v2' });
      const next = await service.review(prior.work.id, prior.work.revision);
      expect(next.work.revision).toBe(prior.work.revision + 1);
      expect(next.work.brief?.claims.at(-1)?.text).toBe('After your approval: Send the revised offer.');
      expect(ai).toHaveBeenCalledTimes(3);
    });
  it.each(['missing_permission', 'question_fact', 'wait_quote', 'wrong_source', 'retired_target'])(
    'preserves the previous saved work on a sectioned %s failure', async problem => {
      const created = await create();
      const prior = await service.review(created.work.id, created.work.revision);
      const response: any = sectionAnswer();
      if (problem === 'missing_permission') delete response.actions[0].permission;
      if (problem === 'question_fact') response.facts[0].kind = 'question';
      if (problem === 'wait_quote') {
        response.actions[1].mode = 'wait'; response.actions[1].permission.quote = 'Do not contact anyone.';
      }
      if (problem === 'wrong_source') response.facts[0].source = 'owner_notes';
      if (problem === 'retired_target') response.facts[0].state = 'withdrawn';
      ai.mockImplementation(async () => response);
      await expect(service.review(prior.work.id, prior.work.revision)).rejects.toMatchObject({ code: 'bad_request' });
      expect((await service.get(prior.work.id)).work).toEqual(prior.work);
    });
  it('keeps note recording time through unchanged saves, other edits, reviews and encrypted reopen', async () => {
    let clock = 1000;
    service = createMailWorkService({ ...deps, now: () => clock });
    let result = await create();
    expect(result.work.owner_notes_recorded_at).toBeNull();
    clock = 2000;
    result = await service.update({ id: result.work.id, expected_revision: result.work.revision,
      owner_notes: '  Phone report. Do not contact anyone.  ' });
    expect(result.work).toMatchObject({ owner_notes: 'Phone report. Do not contact anyone.', owner_notes_recorded_at: 2000 });
    for (const patch of [
      { owner_notes: '\nPhone report. Do not contact anyone.\n' },
      { title: 'Changed title', goal: 'New purpose' },
      { link_email: { slug: 'work', record_id: 'coworker' } },
      { status: 'resolved' as const, resolution_note: 'Recorded outcome.' },
      { status: 'active' as const },
    ]) {
      clock += 1000;
      result = await service.update({ id: result.work.id, expected_revision: result.work.revision, ...patch });
      expect(result.work.owner_notes_recorded_at).toBe(2000);
      expect(result.work.updated_at).toBe(clock);
    }
    clock += 1000;
    result = await service.review(result.work.id, result.work.revision);
    const packet = JSON.parse(String(ai.mock.calls.at(-1)![0]['llm.prompt']));
    const owner = packet.prior_tool_calls.find((call: { tool_name: string }) => call.tool_name === 'mail.work.owner_context');
    expect(owner.result.owner_notes_recorded_at_iso).toBe('1970-01-01T00:00:02.000Z');
    expect(owner.started_at).toBe(clock);
    expect(result.work.owner_notes_recorded_at).toBe(2000);
    const restarted = createMailWorkService({ ...deps, store: createMailWorkStore(db, codec) });
    expect((await restarted.get(result.work.id)).work).toEqual(result.work);
  });
  it('records changed normalized notes, clears absent notes and ignores client-supplied timestamps', async () => {
    let clock = 1000;
    service = createMailWorkService({ ...deps, now: () => clock });
    let result = await create();
    for (const [notes, expected] of [['A', 2000], ['B', 3000], ['  ', null], ['A', 5000]] as const) {
      clock += 1000;
      const patch = { owner_notes: notes, owner_notes_recorded_at: 999999 };
      result = await service.update({ id: result.work.id, expected_revision: result.work.revision, ...patch });
      expect(result.work.owner_notes_recorded_at).toBe(expected);
    }
    await expect(service.update({ id: result.work.id, expected_revision: result.work.revision - 1, owner_notes: 'Stale' }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect((await service.get(result.work.id)).work).toEqual(result.work);
  });
  it('leaves legacy note timing unknown until its text actually changes', async () => {
    service = createMailWorkService({ ...deps, now: () => 9000 });
    let result = await create();
    const legacy = (await store.get(result.work.id))!;
    legacy.work.owner_notes = 'Existing undated report.';
    delete legacy.work.owner_notes_recorded_at;
    db.prepare('UPDATE mail_work SET ciphertext=? WHERE id=?').run(await codec.seal(legacy), result.work.id);
    result = await service.update({ id: result.work.id, expected_revision: result.work.revision, owner_notes: ' Existing undated report. ' });
    expect(result.work.owner_notes_recorded_at).toBeUndefined();
    result = await service.review(result.work.id, result.work.revision);
    const packet = JSON.parse(String(ai.mock.calls.at(-1)![0]['llm.prompt']));
    expect(packet.prior_tool_calls.find((call: { tool_name: string }) => call.tool_name === 'mail.work.owner_context')
      .result.owner_notes_recorded_at_iso).toBeNull();
    expect(result.work.owner_notes_recorded_at).toBeUndefined();
    result = await service.update({ id: result.work.id, expected_revision: result.work.revision, owner_notes: 'New report.' });
    expect(result.work.owner_notes_recorded_at).toBe(9000);
  });
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
    expect(packet.prior_tool_calls).toHaveLength(4);
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
  it.each([['completion_condition', 'owner'], ['completion_condition', 'email'], ['next_action', 'owner'], ['next_action', 'email']] as const)('rejects %s proposals presented as %s facts', async (kind, basis) => {
    const created = await create();
    const response = answer();
    ai.mockResolvedValueOnce({ ...response, claims: [{ ...response.claims[0], kind, basis }] });
    await expect(service.review(created.work.id, 1)).rejects.toMatchObject({ code: 'bad_request' });
    expect((await service.get(created.work.id)).work).toEqual(created.work);
  });
  it('explains an unrestored private reference and preserves the previous review', async () => {
    const created = await create();
    const original = await service.review(created.work.id, 1);
    ai.mockResolvedValueOnce({ review_format: 'source_actions_v2', claims: [{ kind: 'request', basis: 'email', sources: ['mail_source_1'],
      text: 'pii.person1@client.test requested the pilot.' }], search_queries: [] });
    await expect(service.review(created.work.id, 2)).rejects.toMatchObject({ code: 'bad_request',
      message: expect.stringContaining('private reference that could not be matched back') });
    expect((await service.get(created.work.id)).work).toEqual(original.work);
  });
  it('accepts a faithful claim that says PII or names a pii.* file', async () => {
    const created = await create();
    const text = 'Send the redacted pii.csv file; it will not contain any PII.';
    ai.mockResolvedValueOnce({ review_format: 'source_actions_v2', claims: [answer().claims[0], { ...answer().claims[1], text }],
      search_queries: ['PII. export'] });
    const reviewed = await service.review(created.work.id, created.work.revision);
    expect(reviewed.work.brief?.claims[1]).toEqual({ kind: 'next_action', basis: 'inference', text: `After your approval: ${text}`, evidence: [] });
  });
  it.each(['m7@d9.invalid', 'pii.Person3', 'cap_pii.Org2', 'd4.invalid'])('still rejects an unrestored %s', async token => {
    const created = await create();
    ai.mockResolvedValueOnce({ review_format: 'source_actions_v2', claims: [{ kind: 'next_action', basis: 'inference', sources: [],
      text: `Ask ${token} about the revised offer.` }], search_queries: [] });
    await expect(service.review(created.work.id, created.work.revision)).rejects.toMatchObject({ code: 'bad_request',
      message: expect.stringContaining('private reference that could not be matched back') });
  });
  it('accepts an omitted empty citation list on a scoped inference with a current target', async () => {
    const created = await create();
    const response = answer();
    const { sources: _sources, ...proposal } = response.claims[1]!;
    ai.mockResolvedValueOnce({ ...response, claims: [response.claims[0], proposal] });
    const reviewed = await service.review(created.work.id, 1);
    expect(reviewed.work.brief?.claims[1]).toMatchObject({ basis: 'inference', evidence: [], text: expect.stringContaining('After your approval:') });
    expect(reviewed.work.status).toBe('active');
  });
  it.each([
    { basis: 'email' },
    { basis: 'email', sources: null },
    { basis: 'inference', sources: null },
    { basis: 'inference', sources: 'm1' },
    { basis: 'owner', sources: ['mail_source_999'] },
    { basis: 'owner', sources: ['owner'] },
    { basis: 'owner', sources: ['mail_source_1'] },
    { basis: 'email', sources: ['mail_source_1', 'owner'] },
  ])('still rejects invalid or missing email evidence: %j', async claim => {
    const created = await create();
    const original = await service.review(created.work.id, 1);
    ai.mockResolvedValueOnce({ review_format: 'source_actions_v2', claims: [{ kind: 'next_action', text: 'Check pricing approval.', ...claim }] });
    await expect(service.review(created.work.id, 2)).rejects.toMatchObject({ code: 'bad_request' });
    expect((await service.get(created.work.id)).work).toEqual(original.work);
  });
  it('rejects an array masquerading as the email basis with no supporting evidence', async () => {
    const created = await create();
    ai.mockResolvedValueOnce({ review_format: 'source_actions_v2', claims: [{ kind: 'agreement', basis: ['email'], text: 'The client accepted.', sources: [] }] });
    await expect(service.review(created.work.id, 1)).rejects.toMatchObject({ code: 'bad_request' });
    expect((await service.get(created.work.id)).work).toEqual(created.work);
  });
  it('keeps a phone withdrawal in an owner quote, separate from a current email quote', async () => {
    const created = await create();
    const notes = 'Phone correction: the client withdrew the earlier delivery request.';
    const updated = await service.update({ id: created.work.id, expected_revision: 1, owner_notes: notes });
    ai.mockResolvedValueOnce({ ...answer(), claims: [answer().claims[0],
      { id: 'phone', kind: 'progress', basis: 'owner', sources: [], excerpt: { source: 'owner_notes', quote: notes, state: 'withdrawn' } },
      answer().claims[1],
    ] });
    const reviewed = await service.review(created.work.id, updated.work.revision);
    expect(reviewed.work.brief?.claims[0]).toMatchObject({ basis: 'email', evidence: [{ slug: 'work', record_id: 'seed' }] });
    expect(reviewed.work.brief?.claims[1]).toMatchObject({ basis: 'owner', evidence: [], text: `Your notes (AI status: withdrawn): “${notes}”` });
  });
  it('renders structured action permission and retains prerequisite mail evidence', async () => {
    const created = await create();
    ai.mockResolvedValueOnce({ review_format: 'source_actions_v2', claims: [answer().claims[0], { id: 'action', targets: ['f1'], kind: 'next_action',
      basis: 'inference', sources: [], text: 'Ask the client about an offer.',
      action: { mode: 'contact', scope: 'revised offer', permission: 'requires_owner_approval', permission_quote: null,
        conditions: [{ scope: 'revised offer', text: 'The requested scope must be understood.', sources: ['mail_source_1'], owner_quote: null }] },
    }], search_queries: [] });
    const reviewed = await service.review(created.work.id, 1);
    expect(reviewed.work.brief?.claims?.slice(1)).toMatchObject([{ basis: 'inference',
      text: 'After your approval: Ask the client about an offer. Conditions for revised offer: The requested scope must be understood.',
      evidence: [{ slug: 'work', record_id: 'seed' }] }]);
  });
  it('preserves the prior review when a structured action omits its permission declaration', async () => {
    const created = await create();
    const original = await service.review(created.work.id, 1);
    ai.mockResolvedValueOnce({ review_format: 'source_actions_v2', claims: [answer().claims[0], { id: 'action', targets: ['f1'], kind: 'next_action', basis: 'inference',
      sources: [], text: 'Gather availability from colleagues.' }], search_queries: [] });
    await expect(service.review(created.work.id, 2)).rejects.toMatchObject({ code: 'bad_request' });
    expect((await service.get(created.work.id)).work).toEqual(original.work);
  });
  it('follows question and action references without inheriting permission from either', async () => {
    const created = await create();
    const reply = { ...answer(), claims: [answer().claims[0],
      { id: 'q1', kind: 'question', basis: 'inference', sources: [], targets: ['f1'], text: 'Which details should the outline cover?' },
      { id: 'draft', kind: 'next_action', basis: 'inference', sources: [], targets: ['q1'], text: 'Draft an outline privately.',
        action: { mode: 'private_preparation', scope: 'offer outline', permission: 'not_contact', permission_quote: null, conditions: [] } },
      { ...answer().claims[1], targets: ['draft'] },
    ] };
    ai.mockResolvedValueOnce(reply);
    const reviewed = await service.review(created.work.id, 1);
    expect(reviewed.work.brief?.claims.map(claim => claim.text)).toContain('After your approval: Check pricing approval with your coworker.');
    expect(reply.claims.at(-1)?.targets).toEqual(['draft']);
    ai.mockResolvedValueOnce({ ...reply, claims: reply.claims.map(claim => claim.id === 'a1' && 'action' in claim
      ? { ...claim, action: { ...claim.action, permission: 'not_contact' } } : claim) });
    await expect(service.review(created.work.id, reviewed.work.revision)).rejects.toMatchObject({ code: 'bad_request' });
    expect((await service.get(created.work.id)).work).toEqual(reviewed.work);
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

it('rejects an otherwise readable legacy review instead of bypassing the source contract', async () => {
  const created = await create();
  const previous = await service.review(created.work.id, 1);
  ai.mockResolvedValueOnce({ claims: [{ kind: 'request', basis: 'email', sources: ['mail_source_1'], text: 'An unsupported paraphrase.' }] });
  await expect(service.review(created.work.id, 2)).rejects.toMatchObject({ code: 'bad_request' });
  expect((await service.get(created.work.id)).work).toEqual(previous.work);
});
