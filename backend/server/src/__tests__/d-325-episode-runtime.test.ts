import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MailFact, SituationQuery, Sphere } from '@recued/contracts';
import { createAskDeliveryStore, createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type AskDeliveryRecord, type NotificationSettings, type PendingAsk } from '@recued/notification';
import { createEpisodeRuntime, recallOfferKey } from '../situations/episode-runtime.js';
import { createYoursService } from '../situations/yours-service.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createSituationQuery } from '../situations/query.js';
import { projectProactiveEvent } from '../situations/event-visibility.js';
import { proposalSituation, publishProposalEvents } from '../situations/proposal-events.js';
import { situationSourceAccess } from '../situations/sources.js';
import type { SituationReadContext } from '../situations/query.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import { createCollectionTable } from '../collections/table.js';
import { createCollectionRetention } from '../collections/retention.js';
import { createMailFactStore } from '../storage/mail-fact-store.js';
import { createMailFactWriter } from '../mail-facts/fact-writer.js';
import { createContactStore } from '../storage/contact-store.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createUserMemoryStore, type UserMemoryRow } from '../user-memory-store.js';
import { createBlobStore } from '../storage/blob-store.js';

const DAY = 86_400_000;
const allGrants: SituationReadContext['grants'] = { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const fixture = () => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const facts = createMailFactStore(db); const contacts = createContactStore(db); const calendar = createCalendarTable({ db, slug: 'personal' });
  const rawMail = createCollectionTable({ db, platform: 'mail', slug: 'personal' });
  const proposals = createProactiveProposalStore(db); const history = createProactiveHistoryStore(db, proposals); const situations = createSituationStore(db);
  let time = Date.parse('2026-10-17T08:00Z'); let open = true; let mailSphere: Sphere = 'personal'; let zone = 'UTC';
  const now = () => time;
  const runtime = createEpisodeRuntime({ db, work, mailFacts: facts, contacts, situations, calendars: () => [{ slug: 'personal', table: calendar }], mailboxes: () => [{ slug: 'personal', table: rawMail }],
    timeZone: () => zone, now, isVaultUnlocked: () => open, sphere: ref => ref.collection === 'mail' || ref.collection === 'mail_fact' ? mailSphere : 'personal' });
  const query = createSituationQuery({ sources: [runtime.source], sourceForCollection: situationSourceAccess, now });
  const run = (input: Partial<SituationQuery>, owner = true, grants = allGrants) => query({ time: { from: time, to: time + 7 * DAY }, ...input }, { owner, grants,
    ...(owner ? {} : { spheres: ['personal' as const], referenceSphere: ref => ref.collection === 'episode' || ref.collection === 'history_trace' ? runtime.referenceSphere(ref) : ref.collection === 'mail' || ref.collection === 'mail_fact' ? mailSphere : 'personal' as const }), last_time_opted_in: input.include_last_time });
  const purchase = (id: string, date: string, options: { person?: string; location?: string; name?: string; created_at?: number; data?: Record<string, unknown> } = {}) => {
    const fact: MailFact = { fact_id: id, type: 'purchase', template_id: null, email: { slug: 'personal', record_id: id }, email_at: Date.parse(date), position: 0,
      identity_keys: [], thing_id: null, variables: { merchant: 'Bloom & Co', order_id: id, ordered_at: date, state: 'paid', total: { amount: '45.00', currency: 'USD' } },
      passes: { merchant: 'standard', ordered_at: 'standard' }, data: { items: [{ name: options.name ?? 'Bouquet of flowers', ...(options.person ? { recipient_contact_id: options.person } : {}), ...(options.location ? { location: options.location } : {}), ...options.data }] },
      missing: [], refused: [], complete: true, source_hash: id, revision: 1, created_at: options.created_at ?? Date.parse(date) };
    facts.insertFact(fact); return fact;
  };
  const plan = (id: string, options: { cancelled?: boolean; routine?: boolean; location?: string } = {}) => calendar.upsert({ size_bytes: 0, now: time,
    event: { source_id: id, ical_uid: id, calendar_id: 'home', summary: 'Las Vegas trip', location: options.location ?? 'Las Vegas',
      start_at: Date.parse('2025-10-16'), end_at: Date.parse('2025-10-20'), timezone: 'UTC', is_all_day: true,
      status: options.cancelled ? 'cancelled' : 'confirmed', ...(options.routine ? { recurring_event_id: 'weekly', recurrence_rule: 'FREQ=WEEKLY' } : {}), created_at: 1, updated_at: time } });
  const bootNotification = () => {
    const block = createNotificationBlock({ askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'asks')),
      deliveryStore: createAskDeliveryStore(createSQLiteCollection<AskDeliveryRecord>(db, 'deliveries')),
      settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'settings')),
      channels: [createUiChannel({ busSink: () => {} })], now, isVaultUnlocked: () => open });
    runtime.bindNotifier(block); return block;
  };
  cleanups.push(async () => { await runtime.stop(); db.close(); });
  return { db, work, facts, contacts, calendar, rawMail, proposals, history, situations, runtime, query, run, purchase, plan, bootNotification, now,
    at: (value: string) => { time = Date.parse(value); }, open: (value: boolean) => { open = value; }, sphere: (value: Sphere) => { mailSphere = value; },
    zone: (value: string) => { zone = value; } };
};

describe('D-325 evidence-led episodes and measured recall', () => {
  it('forgets a recall offer’s “last time” from the outbox and the situation log, leaving only its withdrawal', () => {
    const f = fixture();
    const offer = f.proposals.ensure({ key: 'recall-bouquet', kind: 'recall', title: 'Last time?', explanation: 'Last time: Bouquet · Bloom & Co · 45 USD',
      confidence: 'medium', origin: 'learner', sources: [{ collection: 'episode', id: 'flowers' }], payload: { episode_id: 'flowers' } }, f.now());
    publishProposalEvents(f.proposals, f.situations);
    f.runtime.forget();
    publishProposalEvents(f.proposals, f.situations);
    const copies = JSON.stringify([f.db.prepare('SELECT value FROM proactive_proposal_events').all(),
      f.db.prepare('SELECT before_snapshot,after_snapshot FROM situation_revisions').all(), f.db.prepare('SELECT snapshot FROM situations').all()]);
    expect(copies).not.toContain('Bouquet');
    expect(f.situations.revisionsAfter(0, 100).filter(row => row.situation_id === `proposal:${offer.id}`).at(-1)!.after.state).toBe('resolved');
  });
  it('withdraws a recall offer once its day is over in the owner’s zone, hourly too, and does not make it again', async () => {
    const f = fixture(); f.situations.writeSetting('last_time.choice', 'on'); f.zone('America/Los_Angeles');
    const episode = f.history.saveEpisode({ title: 'Flowers for Mum', class_id: 'flowers', when: { from: Date.parse('2025-10-19'), to: Date.parse('2025-10-19') },
      people: [], subjects: [], evidence: [], basis: 'declared', sensitive: [], storage_reason: 'proposal_citation' }, f.now());
    const input = { key: recallOfferKey(episode.id, '2026-10-19'), kind: 'recall' as const, title: 'Flowers for Mum', explanation: 'An offer from your recorded precedent.',
      confidence: 'low' as const, origin: 'learner' as const, sources: [{ collection: 'episode', id: episode.id }], subject: { collection: 'episode', id: episode.id },
      payload: { episode_id: episode.id, on: '2026-10-19', statement: 'Repeat: Flowers for Mum', proposal_class: 'recall:flowers' } };
    const offer = f.proposals.ensure(input, f.now());
    // 23:59 on the 19th in Los Angeles: the offer's day is not over, and it can still be accepted.
    f.at('2026-10-20T06:59Z'); f.runtime.refreshSuppressed();
    expect(f.proposals.read(offer.id)!.state).toBe('proposed');
    // The 20th has begun there. Nobody opens Yours; the hourly pass withdraws it.
    f.at('2026-10-20T07:00Z'); await f.runtime.tick();
    expect(f.proposals.read(offer.id)!.state).toBe('retracted');
    // The next digest offers the same anniversary under the same key: it stays withdrawn.
    expect(f.proposals.ensure(input, f.now()).state).toBe('retracted');
  });
  it('forgets the dark run’s folded counts with its candidates', () => {
    const f = fixture();
    f.history.darkCandidate({ id: 'dark-flowers', class_id: 'flowers', window: { from: 1, to: 2 }, episode: { title: 'Flowers', when: { from: 1, to: 2 },
      people: [], subjects: [], evidence: [], basis: 'inferred', sensitive: [], storage_reason: 'proposal_citation' } }, 1);
    f.history.scoreDarkCandidate('dark-flowers', false, null, 3); f.history.foldDark(4);
    expect(f.history.darkRates()).toMatchObject([{ class_id: 'flowers', scored: 1 }]);
    f.runtime.forget();
    expect(f.history.darkRates()).toEqual([]);
  });
  it('applies memory consent and exclusions to proposal-shaped events and both of their snapshots', () => {
    const f = fixture(); f.situations.writeSetting('last_time.choice', 'on');
    const episode = f.history.saveEpisode({ title: 'Private museum visit', class_id: 'photos', when: { from: 1, to: 2 }, people: [], subjects: [], evidence: [],
      basis: 'declared', sensitive: [], storage_reason: 'owner_record' }, f.now());
    const proposal = f.proposals.ensure({ key: 'private-recurrence', kind: 'occasion', title: 'Private museum visit recurs?', explanation: 'Two recorded episodes',
      confidence: 'low', origin: 'learner', sources: [{ collection: 'episode', id: episode.id }], payload: { episode_ids: [episode.id] } }, f.now());
    const before = proposalSituation(proposal); const after = proposalSituation({ ...proposal, state: 'accepted' });
    expect(f.runtime.memoryAllowed(before.cluster)).toBe(true); f.situations.writeSetting('last_time.choice', 'off');
    const event = projectProactiveEvent({ platform: 'situation', slug: 'situation', entity_type: 'cluster', event_kind: 'updated', record_id: before.id, at: f.now(),
      record: { ...after }, prev: { record: after, prior: before }, changed_fields: ['state'] }, allGrants, { owner: true, grants: allGrants, memoryAllowed: f.runtime.memoryAllowed });
    expect(JSON.stringify(event)).not.toContain('museum'); expect(event.record).toEqual({ id: before.id, changed_fields: ['state'] });
    f.situations.writeSetting('last_time.choice', 'on'); f.history.deleteEpisode(episode.id, f.now()); expect(f.runtime.memoryAllowed(before.cluster)).toBe(false);
  });
  it('correlates an explicit completed check-in report with a past plan and captures it before pruning its raw mail', async () => {
    const f = fixture(); f.plan('trip');
    const body_inline = 'You have checked in at Las Vegas on 2025-10-17.';
    f.rawMail.upsert({ record_id: 'arrival', source_id: 'arrival', received_at: Date.parse('2025-10-17'), modified_at: Date.parse('2025-10-17'),
      hot_fields: { from: 'hotel@example.test', subject: 'Check-in confirmation', direction: 'inbound' }, body_inline, size_bytes: Buffer.byteLength(body_inline) });
    const episodes = await f.runtime.ownerEpisodes(); expect(episodes).toHaveLength(1); expect(episodes[0]).toMatchObject({ title: 'Las Vegas trip', basis: 'derived', class_id: 'checkin' });
    await f.runtime.captureBeforeRetention('personal', Date.parse('2025-10-20')); f.rawMail.delete('arrival');
    expect((await f.runtime.ownerEpisodes())[0]).toMatchObject({ title: 'Las Vegas trip', basis: 'derived' });
    expect(f.runtime.traces()).toHaveLength(1); expect(JSON.stringify(f.runtime.traces())).not.toContain('You have checked in');
    f.proposals.setSource('mail:personal', false); expect(await f.runtime.ownerEpisodes()).toEqual([]);
  });
  it('requires a matching trace for a plan, excludes cancelled/routine plans, and retains no harvest', async () => {
    const f = fixture(); f.plan('trip'); expect(await f.runtime.ownerEpisodes()).toEqual([]);
    f.purchase('flowers', '2025-10-17', { location: 'Las Vegas' });
    const derived = await f.runtime.ownerEpisodes(); expect(derived).toHaveLength(1); expect(derived[0]).toMatchObject({ title: 'Las Vegas trip', basis: 'derived', assembly_rule: 'plan_trace.v1' });
    expect(derived[0]!.notes).toBe('Bouquet of flowers · Bloom & Co · 45.00 USD'); expect(f.history.episodes()).toEqual([]);
    f.plan('trip', { cancelled: true }); const traceOnly = await f.runtime.ownerEpisodes(); expect(traceOnly).toHaveLength(1); expect(traceOnly[0]!.basis).toBe('inferred'); expect(traceOnly[0]!.title).not.toContain('trip');
    f.plan('weekly', { routine: true }); expect((await f.runtime.ownerEpisodes())[0]!.title).not.toContain('trip');
    f.proposals.saveSuppression({ kind: 'episode', value: traceOnly[0]!.id }, f.now()); expect(await f.runtime.ownerEpisodes()).toEqual([]);
  });
  it('keeps a dismissed trace-only episode dismissed when its trace later joins a plan', async () => {
    const f = fixture(); f.purchase('flowers', '2025-10-17', { location: 'Las Vegas' });
    const [traceOnly] = await f.runtime.ownerEpisodes(); expect(traceOnly).toMatchObject({ basis: 'inferred', assembly_rule: 'trace_only.v1' });
    f.history.saveEpisode({ ...traceOnly!, storage_reason: 'proposal_citation' }, f.now()); // Cited by its recall offer.
    f.history.suppressEpisode(traceOnly!.id!, f.now()); // "Not this one".
    expect(await f.runtime.ownerEpisodes()).toEqual([]);
    f.plan('trip'); // The calendar sync adds the trip the purchase belongs to.
    expect(await f.runtime.ownerEpisodes()).toEqual([]);
  });
  it('uses only the owner’s dated memory records as declarations and a fulfilled commitment as a real trace', async () => {
    const f = fixture(); const root = mkdtempSync(join(tmpdir(), 'd325-memory-')); cleanups.unshift(async () => rmSync(root, { recursive: true, force: true }));
    const memory = createUserMemoryStore(createSQLiteCollection<UserMemoryRow>(f.db, 'user_memory'), createBlobStore(root), { now: f.now }); f.runtime.bindMemory(memory);
    await memory.create({ kind: 'note', summary: 'I visited the museum', event_at: Date.parse('2025-10-17') });
    await memory.create({ kind: 'note', summary: 'A future plan', event_at: f.now() + DAY });
    await memory.writeAuthored({ kind: 'note', summary: 'The AI says it succeeded', event_at: Date.parse('2025-10-17'), origin_actor: 'system' });
    f.work.writeCommitment({ source_id: 'recued.commitment', statement: 'Service completed', direction: 'outbound', derivation: 'user_declared', lifecycle_state: 'fulfilled', lifecycle_changed_at: Date.parse('2025-10-18') }, f.now());
    const episodes = await f.runtime.ownerEpisodes(); expect(episodes.map(episode => episode.title).sort()).toEqual(['I visited the museum', 'Service completed']);
    expect(episodes.find(episode => episode.title.startsWith('I visited'))!.basis).toBe('declared'); expect(f.history.episodes()).toEqual([]);
  });
  it('fences people before assembly, so a contact the reader may not see joins nothing', async () => {
    // ⛔ A plan and a purchase that share only a contact were joined into one derived
    // episode before the contact fence, handing a door without contacts the link.
    const f = fixture(); f.contacts.upsertManual({ email: 'casey@example.test', name: 'Casey' }, Date.parse('2025-01-01'));
    const casey = f.contacts.get('casey@example.test')!.contact_id!;
    f.calendar.upsert({ size_bytes: 0, now: Date.parse('2025-10-01'), event: { source_id: 'dinner', ical_uid: 'dinner', calendar_id: 'home', summary: 'Dinner',
      start_at: Date.parse('2025-10-17T18:00Z'), end_at: Date.parse('2025-10-17T21:00Z'), timezone: 'UTC', is_all_day: false, status: 'confirmed',
      attendees: [{ email: 'casey@example.test', response_status: 'accepted' }], created_at: 1, updated_at: 1 } });
    f.purchase('lilies', '2025-10-17', { person: casey });
    const past = { time: { from: Date.parse('2025-10-16'), to: Date.parse('2025-10-21') }, surface: 'tool' as const };
    const items = async (owner: boolean, grants = allGrants) => (await f.run(past, owner, grants)).clusters.flatMap(cluster => cluster.items);
    expect((await items(true)).some(item => item.basis === 'derived')).toBe(true);
    const fenced = await items(false, { ...allGrants, isCollectionReadGranted: collection => collection !== 'contact' });
    expect(fenced.some(item => item.basis === 'derived')).toBe(false);
  });
  it('checks each source’s verb/data/sphere before correlation and rechecks placements after asynchronous reads', async () => {
    const f = fixture(); f.plan('trip'); f.purchase('flowers', '2025-10-17', { location: 'Las Vegas' });
    const read = vi.spyOn(f.facts, 'listFactPage'); const past = { time: { from: Date.parse('2025-10-16'), to: Date.parse('2025-10-21') }, surface: 'tool' as const };
    const denied = await f.run(past, true, { ...allGrants, isVerbOpGranted: op => op !== 'core.mail.fact.list' }); expect(denied.clusters).toEqual([]); expect(read).not.toHaveBeenCalled();
    await f.run(past, true, { ...allGrants, isCollectionReadGranted: collection => collection !== 'mail' }); expect(read).not.toHaveBeenCalled();
    f.sphere('professional'); expect((await f.run(past, false)).clusters).toEqual([]);
    f.sphere('personal'); const original = f.calendar.listSnapshots.bind(f.calendar); vi.spyOn(f.calendar, 'listSnapshots').mockImplementation(input => { f.sphere('professional'); return original(input); });
    expect((await f.run(past, false)).clusters).toEqual([]); expect(f.history.episodes()).toEqual([]);
  });
  it('captures minimal eligible evidence durably before actual mail prune, blocks a sealed-vault prune and survives fact deletion', async () => {
    const f = fixture(); const fact = f.purchase('old-mail', '2025-10-01', { location: 'Las Vegas' });
    f.purchase('health-mail', '2025-10-01', { location: 'Las Vegas', name: 'Flowers with prescription medicine', data: { health: true } });
    const table = createCollectionTable({ db: f.db, platform: 'mail', slug: 'personal' });
    table.upsert({ record_id: fact.email.record_id, received_at: Date.parse('2025-10-01'), modified_at: Date.parse('2025-10-01'), hot_fields: {}, size_bytes: 4, source_id: 'old', body_inline: 'body' });
    const writer = createMailFactWriter({ store: f.facts, now: f.now, emit: () => {} });
    const retention = createCollectionRetention({ table, slug: 'personal', platform: 'mail', config: () => ({ retentionDays: 365 }), now: f.now,
      beforePrune: cutoff => f.runtime.captureBeforeRetention('personal', cutoff), onPruned: ids => writer.removeEmails('personal', ids) });
    f.open(false); await expect(retention.run()).rejects.toThrow('unlocked'); expect(table.get('old-mail')).not.toBeNull(); expect(f.runtime.traces()).toEqual([]);
    f.open(true); f.db.exec("CREATE TRIGGER fail_history_capture BEFORE INSERT ON proactive_retained_traces BEGIN SELECT RAISE(ABORT,'capture fixture failure'); END");
    await expect(retention.run()).rejects.toThrow('capture fixture failure'); expect(table.get('old-mail')).not.toBeNull(); expect(f.runtime.receipts()).toEqual([]);
    f.db.exec('DROP TRIGGER fail_history_capture');
    const result = await retention.run(); expect(result.pruned_count).toBe(1); expect(table.get('old-mail')).toBeNull(); expect(f.facts.getFact(fact.fact_id)).toBeNull();
    expect(f.runtime.traces()).toHaveLength(1); expect(JSON.stringify(f.runtime.traces())).not.toContain('prescription'); expect(JSON.stringify(f.runtime.traces())).not.toContain('body');
    expect(f.runtime.receipts()).toMatchObject([{ mailbox: 'personal', candidates: 1 }]);
    const episodes = await f.runtime.ownerEpisodes(); expect(episodes).toHaveLength(1); expect(episodes[0]!.evidence.some(ref => ref.collection === 'history_trace')).toBe(true); expect(f.history.episodes()).toEqual([]);
    f.runtime.forgetSource('personal'); expect(f.runtime.traces()).toEqual([]); expect(await f.runtime.ownerEpisodes()).toEqual([]);
  });
  it('scores five later independent traces, waits for an owner rate and asks once before digest-only offers', async () => {
    const f = fixture(); const people = Array.from({ length: 5 }, (_, index) => f.contacts.upsertManual({ email: `person-${index}@example.test` }).contact_id!);
    for (let index = 0; index < 5; index++) f.purchase(`old-${index}`, '2025-10-17', { person: people[index] });
    const block = f.bootNotification(); await f.runtime.tick(); expect(f.history.darkPending()).toHaveLength(5); expect(f.runtime.rates()).toEqual([]);
    expect((await f.run({ surface: 'digest', include_last_time: true, people: [people[0]!] })).clusters).toEqual([]);
    f.at('2026-10-17T09:00Z'); for (let index = 0; index < 5; index++) f.purchase(`new-${index}`, '2026-10-17', { person: people[index], created_at: f.now() });
    await f.runtime.tick(); expect(f.runtime.rates()).toMatchObject([{ scored: 5, relevant: 5, rate: 1, qualified: false }]); expect(await block.listOpenAsks()).toEqual([]);
    f.runtime.setClassBar('flowers', 0.8); await f.runtime.tick(); const ask = (await block.listOpenAsks()).find(ask => ask.handler_kind === 'situation-last-time-opt-in')!;
    expect(ask).toBeDefined(); await block.submitAnswer({ ask_id: ask.ask_id, option: 'on', via: 'ui' }); await f.runtime.tick(); expect(await block.listOpenAsks()).toEqual([]);
    const restartedBlock = f.bootNotification(); await f.runtime.tick(); expect(await restartedBlock.listOpenAsks()).toEqual([]);
    const result = await f.run({ surface: 'digest', include_last_time: true, people: [people[0]!] });
    const offers = result.clusters.flatMap(cluster => cluster.items); expect(offers.some(item => item.reasons.includes('last_time'))).toBe(true);
    expect(offers[0]!.what.value).toContain('Would you like'); expect(offers[0]!.when.value!.from).toBe(Date.parse('2025-10-17'));
    for (const surface of ['today', 'push', 'prefetch', 'tool'] as const) expect((await f.run({ surface, include_last_time: true, people: [people[0]!] })).clusters).toEqual([]);
    expect(f.history.episodes()).toEqual([]); f.runtime.retainCited(result.clusters); expect(f.history.episodes()).toHaveLength(1); expect(f.proposals.list()).toMatchObject([{ kind: 'recall', state: 'proposed' }]);
    const person = f.contacts.upsertManual({ email: 'person-0@example.test', privacy_marks: ['former_partner'] }, f.now(), { origin_actor: 'user_self', origin_surface: 'client_rpc' });
    expect(person.privacy_marks).toEqual(['former_partner']); expect((await f.run({ surface: 'digest', include_last_time: true, people: [people[0]!] })).clusters).toEqual([]);
    f.runtime.refreshSuppressed(); expect(f.proposals.list({ state: 'proposed', kind: 'recall' })).toEqual([]);
    const snapshot = { id: 'recall', state: 'resolved' as const, urgency: 'routine' as const, cluster: result.clusters[0]! };
    const projected = projectProactiveEvent({ platform: 'situation', slug: 'situation', entity_type: 'cluster', event_kind: 'updated', record_id: 'recall', at: f.now(),
      record: snapshot, prev: { record: snapshot, prior: snapshot }, changed_fields: ['state'] }, allGrants, { owner: true, grants: allGrants, memoryAllowed: f.runtime.memoryAllowed });
    expect(JSON.stringify(projected)).not.toContain('Bloom'); expect(projected.record).toEqual({ id: 'recall', changed_fields: ['state'] });
  });
  // §15.7 — Settings → Privacy → Learning holds the same choice the once-only question asks for.
  const askedOnce = async () => {
    const f = fixture(); const people = Array.from({ length: 5 }, (_, index) => f.contacts.upsertManual({ email: `person-${index}@example.test` }).contact_id!);
    for (let index = 0; index < 5; index++) f.purchase(`old-${index}`, '2025-10-17', { person: people[index] });
    const block = f.bootNotification(); await f.runtime.tick();
    f.at('2026-10-17T09:00Z'); for (let index = 0; index < 5; index++) f.purchase(`new-${index}`, '2026-10-17', { person: people[index], created_at: f.now() });
    await f.runtime.tick(); f.runtime.setClassBar('flowers', 0.8); await f.runtime.tick();
    const ask = (await block.listOpenAsks()).find(row => row.handler_kind === 'situation-last-time-opt-in')!;
    expect(ask).toBeDefined(); expect(await f.runtime.optInOpen()).toBe(true);
    return { f, block, ask };
  };
  // The owner's own Yours service over this runtime, as the server composes it.
  const owner = { channel: 'user' as const, actor: 'user_self' as const, user_id: 'owner', client_token_id: 'paired' };
  const yoursFor = (f: ReturnType<typeof fixture>) => {
    const dispatchers = createWorkEntityDispatchers({ store: f.work, resolver: createWorkEntityResolver(f.work), now: f.now });
    const yours = createYoursService({ db: f.db, work: f.work, dispatchers, situations: f.situations, episodeRuntime: f.runtime, now: f.now, timeZone: () => 'UTC',
      occurrences: createAssetOccurrenceService({ db: f.db, work: f.work, dispatchers, timeZone: () => 'UTC', now: f.now }), isVaultUnlocked: () => true });
    cleanups.unshift(() => yours.stop()); return yours;
  };
  it('withdraws the once-only question when the owner chooses in Settings, so its late answer cannot undo the choice', async () => {
    const { f, block, ask } = await askedOnce(); const yours = yoursFor(f);
    expect(await yours.learningStatus()).toMatchObject({ last_time: 'unasked', asked: true, classes: [{ class_id: 'flowers', qualified: true }] });
    await yours.command({ action: 'settings.update', last_time: 'off' }, owner);
    expect(await block.listOpenAsks()).toEqual([]); expect(await yours.learningStatus()).toMatchObject({ last_time: 'off', asked: false });
    await block.submitAnswer({ ask_id: ask.ask_id, option: 'on', via: 'ui' }).catch(() => undefined);
    expect(f.situations.readSetting('last_time.choice', 'unasked')).toBe('off');
  });
  it('lets a late answer change nothing once a choice settled the question, even while its ask is still open', async () => {
    const { f, block, ask } = await askedOnce();
    f.situations.writeSetting('last_time.choice', 'off');
    await block.submitAnswer({ ask_id: ask.ask_id, option: 'on', via: 'ui' });
    expect(f.situations.readSetting('last_time.choice', 'unasked')).toBe('off');
  });
  // P44 — Hide where an episode is cited covers one Recued assembled and never stored.
  // Deleting one suppressed its id alone, so the same evening came back under its
  // trace's id once the plan was cancelled.
  for (const action of ['episode.hide', 'episode.delete'] as const) it(`keeps an assembled episode gone after ${action}, through a re-assembly under another id`, async () => {
    const f = fixture(); const yours = yoursFor(f); f.plan('trip'); f.purchase('flowers', '2025-10-17', { location: 'Las Vegas' });
    const [assembled] = await f.runtime.ownerEpisodes(); expect(assembled).toMatchObject({ basis: 'derived', title: 'Las Vegas trip' });
    await yours.command(action === 'episode.hide' ? { action, id: assembled!.id! } : { action, id: assembled!.id!, suppress: true }, owner);
    expect(await f.runtime.ownerEpisodes()).toEqual([]); expect(f.history.episodes()).toEqual([]);
    f.plan('trip', { cancelled: true });
    expect(await f.runtime.ownerEpisodes()).toEqual([]);
    const listed = (await yours.snapshot({})).suppressions.filter(row => row.kind === 'episode' && !row.of);
    expect(listed).toEqual([expect.objectContaining({ value: assembled!.id, label: 'Las Vegas trip' })]);
    await yours.command({ action: 'suppression.delete', id: listed[0]!.id }, owner);
    expect(await f.runtime.ownerEpisodes()).toMatchObject([{ basis: 'inferred' }]);
  });
  it('does not count repeated historical receipts or a single later email as five measured successes', async () => {
    const f = fixture(); const person = f.contacts.upsertManual({ email: 'ana@example.test' }).contact_id!;
    for (let index = 0; index < 7; index++) f.purchase(`old-${index}`, '2025-10-17', { person });
    await f.runtime.tick(); expect(f.history.darkPending()).toHaveLength(1);
    expect(() => f.runtime.setClassBar('flowers', 0.1)).toThrow('five');
  });
  it('does not rebuild forgotten candidates from a read already in flight, while leaving the raw source intact', async () => {
    const f = fixture(); f.purchase('old', '2025-10-17', { location: 'Las Vegas' }); f.plan('trip');
    expect(await f.runtime.ownerEpisodes()).toHaveLength(1);
    const original = f.calendar.listSnapshots.bind(f.calendar); vi.spyOn(f.calendar, 'listSnapshots').mockImplementation(input => { f.runtime.forget(); return original(input); });
    expect(await f.runtime.ownerEpisodes()).toEqual([]); expect(f.facts.getFact('old')).not.toBeNull(); expect(f.history.darkPending()).toEqual([]); expect(f.runtime.traces()).toEqual([]);
  });
});
