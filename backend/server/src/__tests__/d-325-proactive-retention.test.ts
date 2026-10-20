/**
 * D-325 retention: the situation log, the proposal outbox, outcomes, offers and
 * their tombstones, intake receipts, learning signals, relation evidence, capture
 * receipts, dark-run candidates and clock cycles each keep what a reader can still
 * use, and nothing else.
 *
 * The clock cases drive real reminders through the occurrence and reminder
 * services. The last case composes the real collection context and trigger store,
 * so the subscribers that hold the log are the ones the dispatcher actually names.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { createRuntimeConfigStore } from '@recued/config';
import type { AssetRule, EpisodeInput, MailFact, MailFactThing, ProactiveProposalInput, SituationRef, SituationSnapshot } from '@recued/contracts';
import {
  createAskDeliveryStore, createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type AskDeliveryRecord, type NotificationSettings, type PendingAsk,
} from '@recued/notification';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { afterEach, describe, expect, it } from 'vitest';

import { createBootTrace } from '../cli/boot-trace.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import { createExecutionLateBoundRefs } from '../serve/compose-execution-context.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createAssetIntake } from '../situations/asset-intake.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createAssetReminderService, type AssetReminderService } from '../situations/asset-reminder-service.js';
import { declaredOccasionId } from '../situations/declared-occasions.js';
import { recallOfferKey } from '../situations/episode-runtime.js';
import { createHouseholdHomeAssistant } from '../situations/household-home-assistant.js';
import { createProactiveLearning } from '../situations/learning-runtime.js';
import { LEARNING_LOOKBACK_MS, RELATION_LOOKBACK_MS, relationKey, relationOfferKey, type ClockLearningSignal } from '../situations/learning.js';
import { collectProposalMeasures } from '../situations/measures.js';
import { createOccasionClockService } from '../situations/occasion-clock-service.js';
import { completionQuestionKey, lastDoneQuestionKey } from '../situations/owner-completion.js';
import { PROACTIVE_COUNT_RETENTION_MS, PROACTIVE_LOG_RETENTION_MS, createProactiveRetention } from '../situations/proactive-retention.js';
import { publishProposalEvents } from '../situations/proposal-events.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { createMailFactStore } from '../storage/mail-fact-store.js';
import { createOccurrenceReminderStore } from '../storage/occurrence-reminder-store.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { CAPTURE_RECEIPTS_KEPT, createProactiveTraceStore } from '../storage/proactive-trace-store.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createSphereStore } from '../storage/sphere-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createEventTriggerDispatcher } from '../triggers/dispatcher.js';
import { createEventTriggersStore } from '../triggers/store.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { unlockServerVault } from './helpers/unlocked-vault.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-17T12:00Z');
const OLD = NOW - PROACTIVE_LOG_RETENTION_MS - DAY;
const before = NOW - PROACTIVE_LOG_RETENTION_MS;
const dbs: Database.Database[] = []; const dirs: string[] = []; const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const db of dbs.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const open = () => { const db = new Database(':memory:'); dbs.push(db); return db; };
/** Each call is one meaningful change, so each save writes one revision. */
const snapshot = (omitted: number): SituationSnapshot => ({ id: 'trip', state: 'proposed', urgency: 'routine',
  cluster: { id: 'trip', subjects: [], span: { from: 1, to: 100 }, omitted, items: [] } });
const revisions = (store: ReturnType<typeof createSituationStore>) => store.revisionsAfter(0, 1000).map(row => row.revision);

describe('D-325 proactive retention — the situation log', () => {
  it('drops a revision every listed subscriber has handled once it is past the window, and the feed reads on across the gap', async () => {
    const store = createSituationStore(open());
    for (const [index, at] of [OLD - 3, OLD - 2, OLD - 1, NOW - DAY].entries()) store.save(snapshot(index), { source: 'brief' }, at);
    store.acknowledge('trigger:a', 1); store.acknowledge('trigger:a', 2);
    for (const revision of [1, 2, 3]) store.acknowledge('trigger:b', revision);
    store.acknowledge('trigger:gone', 1);

    expect(store.prune({ before, subscribers: ['trigger:a', 'trigger:b'] })).toEqual({ revisions: 2, runs: 0, checkpoints: 1, situations: 0 });
    expect(revisions(store)).toEqual([3, 4]);
    expect(store.checkpoint('trigger:gone')).toBe(0);
    const delivered: number[] = [];
    expect(await store.catchUp('trigger:a', async revision => { delivered.push(revision.revision); return true; })).toBe(2);
    expect(delivered).toEqual([3, 4]); expect(store.checkpoint('trigger:a')).toBe(4);
    // Trigger b has now handled revision 3 too. Revision 4 is recent, and trigger b has yet to handle it.
    expect(store.prune({ before, subscribers: ['trigger:a', 'trigger:b'] }).revisions).toBe(1);
    expect(revisions(store)).toEqual([4]);
  });

  it('holds the log for a listed subscriber with no checkpoint yet, and prunes by age alone when nobody is listed', () => {
    const store = createSituationStore(open());
    store.save(snapshot(0), { source: 'brief' }, OLD); store.save(snapshot(1), { source: 'brief' }, NOW);
    store.acknowledge('trigger:a', 1); store.acknowledge('trigger:a', 2);
    expect(store.prune({ before, subscribers: ['trigger:a', 'trigger:new'] }).revisions).toBe(0);
    expect(store.prune({ before, subscribers: [] })).toEqual({ revisions: 1, runs: 0, checkpoints: 1, situations: 0 });
    expect(revisions(store)).toEqual([2]);
  });

  it('drops a completed run its checkpoint has passed and keeps a run in doubt, also for a subscriber that is gone', () => {
    const store = createSituationStore(open());
    for (const index of [0, 1, 2]) store.save(snapshot(index), { source: 'brief' }, NOW);
    const run = (subscriber: string, revision: number, state: 'completed' | 'in_doubt') => {
      store.beginSubscriberRun(subscriber, revision, `${subscriber}-${revision}`, NOW); store.finishSubscriberRun(subscriber, revision, state, NOW);
    };
    run('trigger:a', 1, 'completed'); store.acknowledge('trigger:a', 1);
    run('trigger:a', 2, 'completed');
    run('trigger:b', 1, 'in_doubt');
    run('trigger:gone', 1, 'completed'); run('trigger:gone', 2, 'in_doubt');

    expect(store.prune({ before, subscribers: ['trigger:a', 'trigger:b'] })).toEqual({ revisions: 0, runs: 2, checkpoints: 0, situations: 0 });
    expect(store.subscriberRun('trigger:a', 1)).toBeNull();
    // Still above the checkpoint: the receipt keeps the run from being repeated.
    expect(store.subscriberRun('trigger:a', 2)?.state).toBe('completed');
    expect(store.subscriberRun('trigger:b', 1)?.state).toBe('in_doubt');
    expect(store.subscriberRun('trigger:gone', 2)?.state).toBe('in_doubt');
  });
  it('drops a resolved situation past the window, and keeps one still open or carrying the owner’s answer', () => {
    const store = createSituationStore(open());
    const put = (id: string, state: SituationSnapshot['state'], at: number) => store.save({ ...snapshot(0), id, state,
      cluster: { ...snapshot(0).cluster, id }, ...(state === 'dismissed' ? { dismissal: 'not_now' as const } : {}) }, { source: 'brief' }, at);
    put('resolved-old', 'resolved', OLD); put('resolved-recent', 'resolved', NOW);
    put('new-old', 'new', OLD); put('dismissed-old', 'dismissed', OLD); put('accepted-old', 'accepted', OLD);
    expect(store.prune({ before, subscribers: [] }).situations).toBe(1);
    expect(['resolved-old', 'resolved-recent', 'new-old', 'dismissed-old', 'accepted-old'].filter(id => store.get(id)))
      .toEqual(['resolved-recent', 'new-old', 'dismissed-old', 'accepted-old']);
  });
});

describe('D-325 proactive retention — proposals', () => {
  const input = (key: string): ProactiveProposalInput => ({ kind: 'asset', key, title: key, explanation: '', confidence: 'low', origin: 'intake', payload: {}, sources: [] });
  const fixture = () => {
    const db = open(); const situations = createSituationStore(db); const proposals = createProactiveProposalStore(db);
    return { db, situations, proposals, retention: createProactiveRetention({ db, situations, subscribers: () => [], isVaultUnlocked: () => true, now: () => NOW }) };
  };

  it('drops delivered outbox entries without publishing them again, and keeps the undelivered one', () => {
    const f = fixture();
    const first = f.proposals.ensure(input('a'), OLD); f.proposals.outcome(first.id, 'not_this_one', OLD); f.proposals.ensure(input('b'), OLD);
    publishProposalEvents(f.proposals, f.situations);
    f.proposals.ensure(input('c'), NOW);

    expect(f.retention.prune()).toMatchObject({ events: 3, outcomes: 1 });
    expect(f.db.prepare('SELECT count(*) AS n FROM proactive_proposal_events').get()).toEqual({ n: 1 });
    expect(f.proposals.pendingEvents().map(event => event.proposal.key)).toEqual(['c']);
    expect(f.proposals.read(first.id)?.state).toBe('dismissed');
  });

  it('keeps an old outcome that opt-in measures have yet to count, and drops it once counted', () => {
    const f = fixture();
    f.situations.writeSetting('metrics.opt_in', true); f.situations.writeSetting('metrics.enabled_at', OLD - DAY);
    const counted = f.proposals.ensure(input('counted'), OLD); f.proposals.outcome(counted.id, 'accepted', OLD);
    expect(f.retention.prune().outcomes).toBe(0);
    collectProposalMeasures(f.proposals, f.situations);
    expect(f.retention.prune().outcomes).toBe(1);
    expect(f.db.prepare('SELECT count(*) AS n FROM proactive_measures').get()).toEqual({ n: 1 });

    // Dated before the owner turned measures on, it can never be counted.
    const early = f.proposals.ensure(input('early'), OLD - 2 * DAY); f.proposals.outcome(early.id, 'accepted', OLD - 2 * DAY);
    expect(f.retention.prune().outcomes).toBe(1);
    // A recent outcome stays whatever measures do.
    const recent = f.proposals.ensure(input('recent'), NOW); f.proposals.outcome(recent.id, 'accepted', NOW);
    collectProposalMeasures(f.proposals, f.situations);
    expect(f.retention.prune().outcomes).toBe(0);
    expect(f.proposals.outcomes().map(row => row.proposal_id)).toEqual([recent.id]);
  });

  it('drops an offer its source withdrew past the window, which its source may then make again, and keeps an answered or open one', () => {
    const f = fixture();
    const withdrawn = f.proposals.ensure(input('withdrawn'), OLD); f.proposals.outcome(withdrawn.id, 'retracted', OLD);
    const accepted = f.proposals.ensure(input('accepted'), OLD); f.proposals.outcome(accepted.id, 'accepted', OLD);
    const declined = f.proposals.ensure(input('declined'), OLD); f.proposals.outcome(declined.id, 'not_this_one', OLD);
    // Offered long ago and withdrawn lately: the withdrawal dates it.
    const lately = f.proposals.ensure(input('lately'), OLD); f.proposals.outcome(lately.id, 'retracted', NOW - DAY);
    const waiting = f.proposals.ensure(input('waiting'), OLD);
    expect(f.retention.prune()).toMatchObject({ retracted: 1 });
    expect(f.proposals.read(withdrawn.id)).toBeNull();
    expect([accepted, declined, lately, waiting].map(row => f.proposals.read(row.id)?.state)).toEqual(['accepted', 'dismissed', 'retracted', 'proposed']);
    // Its source finds it again and offers it afresh; an answered one is never offered again.
    expect(f.proposals.ensure(input('withdrawn'), NOW)).toMatchObject({ state: 'proposed', created_at: NOW });
    expect(f.proposals.ensure(input('declined'), NOW).id).toBe(declined.id);
  });

  it('drops a tombstone once nothing can make its offer again, and an intake receipt once its fact, as read, is gone', async () => {
    const db = open(); const situations = createSituationStore(db); const proposals = createProactiveProposalStore(db); const mail = createMailFactStore(db);
    const purchase = (id: string): MailFact => {
      const fact: MailFact = { fact_id: `mfact_${id}`, type: 'purchase', template_id: null, email: { slug: 'personal', record_id: `email-${id}` }, email_at: OLD,
        position: 0, identity_keys: [`order:${id}`], thing_id: `mthing_${id}`, variables: { merchant: 'Store', order_id: id, state: 'paid' },
        passes: {}, data: { items: [{ name: `Television ${id}`, durable: true }] }, missing: [], refused: [], complete: true, source_hash: `hash-${id}`, revision: 1, created_at: OLD };
      const thing: MailFactThing = { thing_id: fact.thing_id!, type: 'purchase', identity_keys: fact.identity_keys, variables: fact.variables,
        passes: {}, variable_email_at: {}, last_email_at: OLD, missing: [], complete: true, created_at: OLD, updated_at: OLD };
      mail.saveThing(thing); mail.insertFact(fact); return fact;
    };
    const kept = purchase('kept'); const reread = purchase('reread'); const gone = purchase('gone');
    const intake = createAssetIntake({ db, proposals, mailFacts: mail, now: () => OLD });
    await intake.scan();
    expect(proposals.list({ kind: 'asset' })).toHaveLength(3);
    // The owner forgets the extractions: each leaves a tombstone, and the receipts stay.
    intake.forget();
    // An unpaired fact keys its own offer.
    const loose = purchase('loose'); mail.deleteThing(loose.thing_id!);
    const removed = (key: string) => { proposals.delete(proposals.ensure(input(key), OLD).id); };
    removed(`intake:${loose.fact_id}:item`);
    removed(recallOfferKey('episode-flowers', '2025-10-20')); removed(recallOfferKey('episode-flowers', '2026-10-20')); removed('learning:ranking:pool');
    db.prepare('UPDATE mail_fact SET source_hash=? WHERE fact_id=?').run('hash-reread-2', reread.fact_id);
    mail.deleteFacts([gone.fact_id]); mail.deleteThing(gone.thing_id!);
    const tombstones = () => (db.prepare('SELECT dedupe_key FROM proactive_proposal_tombstones ORDER BY dedupe_key').all() as { dedupe_key: string }[]).map(row => row.dedupe_key);
    const receipts = () => (db.prepare('SELECT source_key FROM proactive_intake_receipts ORDER BY source_key').all() as { source_key: string }[]).map(row => row.source_key);
    expect(tombstones()).toHaveLength(7); expect(receipts()).toHaveLength(3);
    const retain = (mailFacts?: typeof mail, at = NOW) => createProactiveRetention({ db, situations, subscribers: () => [], isVaultUnlocked: () => true, now: () => at,
      ...(mailFacts ? { mailFacts } : {}) });
    // Its year is over a month into the next.
    expect(retain(undefined, Date.parse('2026-01-20T12:00Z')).prune()).toMatchObject({ tombstones: 0 });
    // Without the mail they came from, nothing about an extraction goes; a recall offer from a year that is over does.
    expect(retain().prune()).toMatchObject({ tombstones: 1, intake_receipts: 0 });
    expect(tombstones()).not.toContain(recallOfferKey('episode-flowers', '2025-10-20'));
    expect(retain(mail).prune()).toMatchObject({ tombstones: 1, intake_receipts: 2 });
    expect(tombstones().filter(key => key.startsWith('intake:')).map(key => key.split(':')[1])).toEqual([loose.fact_id, kept.thing_id, reread.thing_id]);
    expect(tombstones()).toEqual(expect.arrayContaining([recallOfferKey('episode-flowers', '2026-10-20'), 'learning:ranking:pool']));
    expect(receipts().map(key => key.split(':')[0])).toEqual([kept.fact_id]);
    // What stays still does its work: a new email about a forgotten purchase is read, and its item is not offered again.
    const later = { ...kept, fact_id: 'mfact_kept-later', email: { slug: 'personal', record_id: 'email-kept-later' }, email_at: NOW, created_at: NOW };
    mail.insertFact(later); mail.saveThing({ ...mail.getThing(kept.thing_id!)!, updated_at: NOW });
    await intake.scan();
    expect(receipts().map(key => key.split(':')[0]).sort()).toEqual([kept.fact_id, later.fact_id].sort());
    expect(proposals.list({ kind: 'asset', state: 'proposed' })).toEqual([]);
  });
});

describe('D-325 proactive retention — the learner', () => {
  const source = { kind: 'owner' as const, ref: 'owner:local' };
  const fixture = () => {
    const db = open(); ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
    let time = NOW; const now = () => time;
    const spheres = createSphereStore(db, work); const situations = createSituationStore(db); const proposals = createProactiveProposalStore(db);
    const learning = createProactiveLearning({ db, work, spheres, situations, now, timeZone: () => 'UTC', isVaultUnlocked: () => true });
    const retention = createProactiveRetention({ db, situations, subscribers: () => [], isVaultUnlocked: () => true, now });
    const asset = (class_id: string) => {
      const value = work.writeAsset({ source_id: 'recued.asset', source, name: class_id, class_id }, time);
      spheres.setItem({ collection: 'asset', id: value.id }, 'personal'); return value.id;
    };
    const opened = (asset_id: string) => {
      const booking = work.writeBooking({ source_id: 'recued.booking', title: 'Trip', slot_start_at: time, slot_end_at: time + DAY, source_extension_blob: { trip: { destination_country: 'FR' } } }, time);
      const trip: SituationRef = { collection: 'booking', id: booking.id }; spheres.setItem(trip, 'personal');
      learning.recordOpened(trip, 'client'); learning.recordOpened({ collection: 'asset', id: asset_id }, 'client');
    };
    const evidence = () => learning.store.relationGroups().map(group => [group.target_class, group.evidence.length]);
    return { db, proposals, learning, retention, asset, opened, evidence, at: (value: number) => { time = value; } };
  };

  it('keeps clock signals for the learner’s whole lookback and drops older ones', () => {
    const f = fixture();
    const signal = (id: string, at: number): ClockLearningSignal => ({ id, pool: '["boiler","personal","service","interval","last_service_on","routine"]',
      subject: { collection: 'commitment', id }, rule_id: 'service', at, outcome: 'fulfilled', actor: 'owner', due_on: null, surfaced: 'none', evidence: [] });
    f.learning.store.record(signal('ancient', NOW - LEARNING_LOOKBACK_MS - DAY));
    f.learning.store.record(signal('two decades', NOW - 20 * 366 * DAY));
    expect(f.retention.prune()).toMatchObject({ signals: 1 });
    expect(f.db.prepare('SELECT id FROM proactive_learning_signals').all()).toEqual([{ id: 'two decades' }]);
  });

  it('drops relation evidence past the lookback and once its question was asked, and keeps the evidence still counting', async () => {
    const f = fixture();
    const insurance = f.asset('insurance'); const tickets = f.asset('tickets'); const old = f.asset('old');
    f.at(NOW - RELATION_LOOKBACK_MS - DAY); f.opened(old); f.at(NOW);
    for (let index = 0; index < 3; index++) f.opened(insurance);
    for (let index = 0; index < 2; index++) f.opened(tickets);
    await f.learning.tick();
    expect(f.proposals.list({ kind: 'relation' }).map(row => row.key)).toEqual([relationOfferKey(relationKey('insurance', 'personal'))]);

    expect(f.retention.prune()).toMatchObject({ evidence: 4 });
    expect(f.evidence()).toEqual([['tickets', 2]]);
    // The kept evidence still counts: a third trip asks about tickets, and insurance is not asked again.
    f.opened(tickets); await f.learning.tick();
    expect(f.proposals.list({ kind: 'relation' }).map(row => row.payload.proposal_class).sort())
      .toEqual(['trip-relation:insurance:personal', 'trip-relation:tickets:personal']);
  });
});

describe('D-325 proactive retention — capture receipts and the vault', () => {
  it('keeps exactly the capture receipts Yours shows', () => {
    const db = open(); const traces = createProactiveTraceStore(db);
    // Ties on the capture time are ordered the same way by the reader and the pruner.
    for (let index = 0; index < CAPTURE_RECEIPTS_KEPT + 5; index++) traces.recordCapture(index % 2 ? 'work' : 'home', index, NOW + Math.floor(index / 4), index);
    const shown = traces.receipts();
    const retention = createProactiveRetention({ db, situations: createSituationStore(db), subscribers: () => [], isVaultUnlocked: () => true, now: () => NOW });
    expect(retention.prune().receipts).toBe(5);
    expect(traces.receipts()).toEqual(shown);
    expect(db.prepare('SELECT count(*) AS n FROM proactive_history_capture_receipts').get()).toEqual({ n: CAPTURE_RECEIPTS_KEPT });
  });

  it('waits for the unlocked vault', () => {
    const db = open(); const situations = createSituationStore(db); situations.save(snapshot(0), { source: 'brief' }, OLD);
    let unlocked = false;
    const retention = createProactiveRetention({ db, situations, subscribers: () => [], isVaultUnlocked: () => unlocked, now: () => NOW });
    retention.tick(); expect(revisions(situations)).toEqual([1]);
    unlocked = true; retention.tick(); expect(revisions(situations)).toEqual([]);
  });
});

describe('D-325 proactive retention — counts', () => {
  const YEAR_AGO = NOW - PROACTIVE_COUNT_RETENTION_MS;
  const retain = (db: Database.Database, situations = createSituationStore(db)) =>
    createProactiveRetention({ db, situations, subscribers: () => [], isVaultUnlocked: () => true, now: () => NOW });

  it('drops a measure and its receipt past a year, and refuses an event that old, so a rescan cannot count it twice', () => {
    const db = open(); const situations = createSituationStore(db);
    situations.writeSetting('metrics.opt_in', true); situations.writeSetting('metrics.enabled_at', 0);
    expect(situations.measure('clock.lapse', 1, { surfaced: 'none' }, YEAR_AGO - DAY, 'clock-lapse:old')).toBe(true);
    expect(situations.measure('clock.lapse', 1, { surfaced: 'none' }, NOW - DAY, 'clock-lapse:recent')).toBe(true);
    expect(situations.measure('clock.lapse', 1, { surfaced: 'none' }, NOW - 100 * DAY, 'clock-lapse:spring')).toBe(true);
    expect(retain(db, situations).prune()).toMatchObject({ measures: 1, measure_receipts: 1 });
    // The learner rescans every clock each hour and measures each lapse again.
    expect(situations.measure('clock.lapse', 1, { surfaced: 'none' }, YEAR_AGO - DAY, 'clock-lapse:old')).toBe(false);
    expect(situations.measure('clock.lapse', 1, { surfaced: 'none' }, NOW - DAY, 'clock-lapse:recent')).toBe(false);
    expect(db.prepare('SELECT count(*) AS n FROM proactive_measures').get()).toEqual({ n: 2 });
  });

  it('dates a receipt written before receipts kept a time by the latest measure, which is no earlier than its event', () => {
    const legacy = (measures: number[]) => {
      const db = open();
      db.exec(`CREATE TABLE proactive_measures (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, name TEXT NOT NULL, value REAL NOT NULL, dimensions TEXT NOT NULL);
        CREATE TABLE proactive_measure_receipts (receipt TEXT PRIMARY KEY); INSERT INTO proactive_measure_receipts(receipt) VALUES ('clock-lapse:a'),('clock-lapse:b');`);
      for (const at of measures) db.prepare("INSERT INTO proactive_measures(at,name,value,dimensions) VALUES(?,'clock.lapse',1,'{}')").run(at);
      return db;
    };
    const db = legacy([YEAR_AGO - 2 * DAY, YEAR_AGO - DAY]); const situations = createSituationStore(db);
    expect(db.prepare('SELECT DISTINCT at FROM proactive_measure_receipts').all()).toEqual([{ at: YEAR_AGO - DAY }]);
    situations.writeSetting('metrics.opt_in', true);
    expect(situations.measure('clock.lapse', 1, {}, NOW, 'clock-lapse:c')).toBe(true);
    createSituationStore(db);
    expect(db.prepare("SELECT at FROM proactive_measure_receipts WHERE receipt='clock-lapse:c'").get()).toEqual({ at: NOW });
    expect(retain(db, situations).prune()).toMatchObject({ measures: 2, measure_receipts: 2 });
    // With no measure to date them, they stay rather than be dated wrongly.
    const bare = legacy([]); createSituationStore(bare);
    expect(retain(bare).prune()).toMatchObject({ measure_receipts: 0 });
    expect(bare.prepare('SELECT count(*) AS n FROM proactive_measure_receipts').get()).toEqual({ n: 2 });
  });

  it('drops an episode correction and the views it counts against together, past a year', () => {
    const db = open(); const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
    const episode = (id: string): EpisodeInput => ({ id, title: 'Birthday flowers', when: { from: 1, to: 2 }, people: [], subjects: [], evidence: [],
      basis: 'inferred', sensitive: [], storage_reason: 'proposal_citation', assembly_rule: 'trace_only.v1' });
    history.recordOwnerCorrection('episode-old', YEAR_AGO - DAY, 'trace_only.v1'); history.recordShown(episode('episode-old'), YEAR_AGO - DAY);
    history.recordOwnerCorrection('episode-spring', NOW - 100 * DAY, 'trace_only.v1'); history.recordShown(episode('episode-spring'), NOW - 100 * DAY);
    expect(retain(db).prune()).toMatchObject({ feedback: 1, shown: 1 });
    expect(db.prepare('SELECT episode_id FROM proactive_episode_feedback').all()).toEqual([{ episode_id: 'episode-spring' }]);
    expect(db.prepare('SELECT episode_id FROM proactive_episode_shown').all()).toEqual([{ episode_id: 'episode-spring' }]);
  });
});

describe('D-325 proactive retention — the dark run and occasions', () => {
  const YEAR_AGO = NOW - PROACTIVE_COUNT_RETENTION_MS;
  const retain = (db: Database.Database) => createProactiveRetention({ db, situations: createSituationStore(db), subscribers: () => [], isVaultUnlocked: () => true, now: () => NOW });
  const episode = (title: string): EpisodeInput => ({ title, when: { from: 1, to: 2 }, people: ['ann@example.com'], subjects: [], evidence: [],
    basis: 'inferred', sensitive: [], storage_reason: 'proposal_citation' });

  it('folds a candidate a year past its window into its class’s counts, so the measured rate holds, and drops one never scored', () => {
    const db = open(); const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
    const candidate = (id: string, class_id: string, to: number, evidence?: SituationRef | null) => {
      history.darkCandidate({ id, class_id, episode: episode(id), window: { from: to - 14 * DAY, to } }, to - 14 * DAY);
      if (evidence !== undefined) history.scoreDarkCandidate(id, evidence !== null, evidence, to);
    };
    candidate('old-hit', 'flowers', YEAR_AGO - DAY, { collection: 'mail', id: 'florist-1' });
    candidate('old-miss', 'flowers', YEAR_AGO - DAY, null);
    candidate('old-gift', 'gifts', YEAR_AGO - DAY, null);
    // Withheld from the run, it was never scored.
    candidate('withheld', 'flowers', YEAR_AGO - DAY);
    candidate('spring', 'flowers', NOW - 100 * DAY, { collection: 'mail', id: 'florist-2' });
    candidate('this-week', 'flowers', NOW + 3 * DAY);
    const rates = () => history.darkRates().sort((a, b) => a.class_id.localeCompare(b.class_id));
    const measured = rates();
    expect(measured).toEqual([{ class_id: 'flowers', scored: 3, relevant: 2, rate: 2 / 3 }, { class_id: 'gifts', scored: 1, relevant: 0, rate: 0 }]);
    expect(retain(db).prune()).toMatchObject({ dark_folded: 3, dark_dropped: 1 });
    expect(rates()).toEqual(measured);
    expect(db.prepare('SELECT id FROM proactive_dark_candidates ORDER BY id').all()).toEqual([{ id: 'spring' }, { id: 'this-week' }]);
    // A later fold adds to the counts, and nothing is counted twice.
    candidate('next-hit', 'flowers', YEAR_AGO - 2 * DAY, { collection: 'mail', id: 'florist-3' });
    expect(retain(db).prune()).toMatchObject({ dark_folded: 1, dark_dropped: 0 });
    expect(rates()).toEqual([{ class_id: 'flowers', scored: 4, relevant: 3, rate: 3 / 4 }, { class_id: 'gifts', scored: 1, relevant: 0, rate: 0 }]);
    history.forgetDark(); expect(history.darkRates()).toEqual([]);
  });

  it('keeps a deletion receipt only for an occasion a contact or calendar can declare again', () => {
    const db = open(); const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
    const own = history.saveOccasion({ title: 'Our anniversary', month_day: '06-01', people: [], muted: false, rules: [] }, NOW);
    const source = { collection: 'contact', id: 'ann@example.com', field: 'birthday' };
    const declared = history.saveOccasion({ id: declaredOccasionId(source), source, title: 'Ann · birthday', month_day: '03-04', people: ['ann@example.com'],
      muted: false, rules: [] }, NOW);
    history.deleteOccasion(own.id); history.deleteOccasion(declared.id);
    expect([history.occasion(own.id), history.occasion(declared.id)]).toEqual([null, null]);
    expect(history.occasionDeleted(declared.id)).toBe(true);
    expect(db.prepare('SELECT source_key FROM proactive_history_receipts').all()).toEqual([{ source_key: `deleted-occasion:${declared.id}` }]);
  });
});

describe('D-325 proactive retention — clock cycles', () => {
  const source = { kind: 'owner' as const, ref: 'owner:local' };
  const interval = (id: string, months: number): AssetRule => ({ id, title: 'Service', enabled: true, muted: false, pinned: false, consequence: 'routine',
    expiry_policy: 'escalate_overdue', when: { kind: 'interval', field: 'serviced_on', every: { amount: months, unit: 'months' } },
    reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [{ amount: 1, unit: 'months' }], on_day: true } });
  /** The occurrence and reminder services as the server composes them, owner reminders in the app. */
  const clocks = () => {
    const db = open(); ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
    let time = NOW; let reminders: AssetReminderService | undefined;
    const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => time });
    const occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'UTC', now: () => time,
      withdraw: async id => { reminders?.withdraw(id); }, emitRule: async () => {}, outcome: async () => {} });
    const service = createAssetReminderService({ db, work, dispatchers, occurrences, timeZone: () => 'UTC', isQuiet: () => false, now: () => time });
    reminders = service;
    const block = createNotificationBlock({ askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks')),
      deliveryStore: createAskDeliveryStore(createSQLiteCollection<AskDeliveryRecord>(db, 'ask_deliveries')),
      settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings')),
      channels: [createUiChannel({ busSink: () => {} })], now: () => time, isVaultUnlocked: () => true,
      resolveReminderDestinations: async () => ({ destinations: [{ id: 'owner-ui', channel: 'ui' }], issues: [] }) });
    service.bind(block); stops.push(() => service.stop());
    const proposals = createProactiveProposalStore(db); const history = createProactiveHistoryStore(db, proposals);
    const retention = () => createProactiveRetention({ db, situations: createSituationStore(db), subscribers: () => [], work, isVaultUnlocked: () => true, now: () => time });
    return { db, work, dispatchers, occurrences, service, block, proposals, history, retention, rows: createAssetOccurrenceStore(db), points: createOccurrenceReminderStore(db),
      put: (name: string, rules: AssetRule[], serviced_on = '2025-10-17') => work.writeAsset({ source_id: 'recued.asset', source, name, dates: { serviced_on }, rules }, time),
      at: (value: string | number) => { time = typeof value === 'number' ? value : Date.parse(value); }, now: () => time };
  };

  it('drops a finished cycle a year after it last changed, keeps a service the owner confirmed for the learner’s lookback, and keeps each clock’s newest cycle', async () => {
    const f = clocks();
    const boiler = f.put('Boiler', [interval('service', 12)]); const filter = f.put('Filter', [interval('swap', 3)], '2026-07-17');
    await f.service.tick();
    const [serviced] = f.rows.byAsset(boiler.id); const [skipped] = f.rows.byAsset(filter.id);
    const firstPlans = f.points.plansForOccurrence(serviced!.id).map(plan => plan.group_id);
    expect(firstPlans).toEqual(f.points.plansForOccurrence(skipped!.id).map(plan => plan.group_id));
    await f.block.submitAnswer({ ask_id: f.points.control(serviced!.id).current_ask_id!, option: 'done', via: 'ui' });
    await f.block.submitAnswer({ ask_id: f.points.control(skipped!.id).current_ask_id!, option: 'not_needed', via: 'ui' });
    await f.service.tick();
    expect(f.rows.completion(serviced!.id)).toMatchObject({ owner_action: true });
    expect(f.points.answersForOccurrence(skipped!.id)).toHaveLength(1);
    // Each clock moves on to its next cycle and reminds of it.
    f.at('2027-09-20T12:00Z'); await f.service.tick();
    const next = [f.rows.byAsset(boiler.id)[0]!, f.rows.byAsset(filter.id)[0]!];
    expect(next.map(row => row.id)).not.toContain(serviced!.id); expect(next.map(row => row.id)).not.toContain(skipped!.id);
    expect(next.map(row => f.points.control(row.id).current_ask_id)).not.toContain(null);

    // Within the year both first cycles stay.
    f.at('2027-10-17T12:00Z'); expect(f.retention().prune()).toMatchObject({ cycles: 0, cycle_logs: 0 });
    f.at('2027-10-20T12:00Z');
    expect(f.retention().prune()).toMatchObject({ cycles: 1, cycle_logs: 1 });
    expect(f.rows.get(skipped!.id)).toBeNull();
    expect([f.points.answersForOccurrence(skipped!.id), f.points.plansForOccurrence(skipped!.id)]).toEqual([[], []]);
    // The owner's confirmed service stays for the learner; what was sent and heard about it goes, with the plan both shared.
    expect(f.rows.get(serviced!.id)).toMatchObject({ id: serviced!.id }); expect(f.rows.completion(serviced!.id)).toMatchObject({ owner_action: true });
    expect([f.points.answersForOccurrence(serviced!.id), f.points.plansForOccurrence(serviced!.id)]).toEqual([[], []]);
    for (const table of ['occurrence_reminder_controls', 'occurrence_reminder_points', 'occurrence_reminder_replacements', 'occurrence_reminder_answers']) {
      expect(f.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE occurrence_id IN (?,?)`).get(serviced!.id, skipped!.id), table).toEqual({ n: 0 });
    }
    expect(f.db.prepare(`SELECT count(*) AS n FROM occurrence_reminder_plans WHERE group_id IN (${firstPlans.map(() => '?').join(',')})`).get(...firstPlans)).toEqual({ n: 0 });
    // The newest cycles keep theirs, and the clocks run on unchanged.
    expect(next.map(row => f.points.plansForOccurrence(row.id).length)).toEqual([1, 1]);
    expect(f.retention().prune()).toMatchObject({ cycles: 0, cycle_logs: 0 });
    await f.service.tick();
    expect(f.rows.get(skipped!.id)).toBeNull(); expect([f.rows.byAsset(boiler.id).length, f.rows.byAsset(filter.id).length]).toEqual([2, 1]);

    // Past the learner's lookback the confirmed service goes too.
    f.at(Date.parse('2026-10-17T12:00Z') + LEARNING_LOOKBACK_MS + DAY);
    expect(f.retention().prune()).toMatchObject({ cycles: 1 });
    expect([f.rows.get(serviced!.id), f.rows.completion(serviced!.id)]).toEqual([null, null]);
  });

  const LONG_AGO = Date.parse('2025-06-01T12:00Z');
  /** A cycle of the car's service clock, closed long ago unless told otherwise. */
  const cycles = (f: ReturnType<typeof clocks>) => {
    const car = f.put('Car', [interval('service', 12)]); let n = 0;
    const cycle = (input: { state?: 'fulfilled' | 'cancelled' | 'pending'; closed?: number; created?: number } = {}) => {
      const id = `occurrence-${car.id}-${String(++n).padStart(2, '0')}`; const created = input.created ?? LONG_AGO; const closed = input.closed ?? LONG_AGO;
      const { commitment } = f.work.ensureCommitment({ id: `commitment-${id}`, source_id: 'recued.commitment', direction: 'outbound', statement: 'Service · Car',
        derivation: 'rule_emitted', expiry_policy: 'escalate_overdue', promised_for_at: created, source_extension_blob: { occurrence_id: id } }, created);
      if ((input.state ?? 'cancelled') !== 'pending') f.work.writeCommitment({ ...commitment, lifecycle_state: input.state ?? 'cancelled', lifecycle_changed_at: closed, state_changed_at: closed }, closed);
      f.rows.ensure({ id, asset_id: car.id, rule_id: 'service', cycle: `2024-06-01:${n}`, commitment_id: commitment.id, question: false, trigger_kind: 'rule', created_at: created });
      return id;
    };
    return { car, cycle };
  };

  it('keeps a finished cycle while anything still waits on it or it changed within the year, and lets it go once nothing does', () => {
    const f = clocks(); const { car, cycle } = cycles(f);
    createOccasionClockService({ db: f.db, work: f.work, dispatchers: f.dispatchers, timeZone: () => 'UTC' });
    createHouseholdHomeAssistant({ db: f.db, work: f.work, occurrences: f.occurrences, connections: () => [], credential: async () => null });
    const notices = createReminderStore(f.db); const LATELY = NOW - DAY;
    const plan = (group: string, phase: string, updated: number, ...members: string[]) => {
      f.db.prepare('INSERT INTO occurrence_reminder_plans(group_id,payload,phase,created_at,updated_at) VALUES(?,?,?,?,?)').run(group, '{}', phase, LONG_AGO, updated);
      for (const id of members) f.db.prepare("INSERT INTO occurrence_reminder_points(occurrence_id,point_key,on_date,ask_id,group_id,at) VALUES(?,'due','2025-06-01',?,?,?)")
        .run(id, `ask-${group}-${id}`, group, LONG_AGO);
    };
    const plain = cycle();
    // The owner's Done without a date, and a close no owner confirmed: neither is a service the learner reads.
    const undated = cycle({ state: 'fulfilled' }); f.rows.recordCompletion(undated, LONG_AGO, null, false, true);
    const unconfirmed = cycle({ state: 'fulfilled' }); f.rows.recordCompletion(unconfirmed, LONG_AGO, null, true, false);
    const confirmed = cycle({ state: 'fulfilled' }); f.rows.recordCompletion(confirmed, LONG_AGO, null, true, true);
    f.points.answer({ ask_id: 'ask-confirmed', occurrence_id: confirmed, outcome: 'done', answered_at: LONG_AGO }); f.points.applied('ask-confirmed', LONG_AGO);
    const asked = cycle(); f.db.prepare('INSERT INTO occurrence_reminder_controls(occurrence_id,current_ask_id) VALUES(?,?)').run(asked, 'ask-current');
    const cancelling = cycle(); f.points.requestCancellation(cancelling, 'ask-cancel', LONG_AGO);
    const reserved = cycle(); f.db.prepare('INSERT INTO occurrence_reminder_pending(occurrence_id,group_id,ask_id) VALUES(?,?,?)').run(reserved, 'group-reserved', 'ask-reserved');
    const answered = cycle(); f.points.answer({ ask_id: 'ask-answer', occurrence_id: answered, outcome: 'later', answered_at: LONG_AGO });
    const ready = cycle();
    const emitting = cycle(); f.rows.queueRuleEvent(emitting, LONG_AGO);
    const closing = cycle(); f.rows.queueCloseOutcome({ occurrence: f.rows.get(closing)!, commitment: f.work.readCommitment(`commitment-${closing}`)!, asset: car });
    const occasionClosing = cycle(); f.db.prepare("INSERT INTO proactive_occasion_close_events(id,payload) VALUES(?,'{}')").run(occasionClosing);
    const projected = cycle(); f.db.prepare('INSERT INTO household_ha_projections(scope,occurrence_id,value) VALUES(?,?,?)').run('kitchen', projected, JSON.stringify({ withdrawn: false }));
    const noticed = cycle(); const notice = notices.ensureClock({ text: 'Service · Car', at: LONG_AGO, time_zone: 'UTC', origin: {},
      clock: { occurrence_id: noticed, point_key: 'due', ask_id: 'ask-notice' } }, LONG_AGO);
    const question = (key: string, kind: 'completion' | 'last_done', occurrence_id: string) => f.proposals.ensure({ key, kind, title: 'When was it done?', explanation: '',
      confidence: 'high', origin: 'owner', payload: { occurrence_id }, sources: [] }, LONG_AGO);
    const confirming = cycle(); const toConfirm = question(completionQuestionKey(confirming), 'completion', confirming);
    const dating = cycle(); const toDate = question(lastDoneQuestionKey(dating), 'last_done', dating);
    const waiting = [asked, cancelling, reserved, answered, ready, emitting, closing, occasionClosing, projected, noticed, confirming, dating];
    // Each changed within the year: by the task, the cycle, its completion or event, or what was sent and heard.
    const owed = cycle({ state: 'pending' });
    const lately = cycle({ state: 'fulfilled', closed: LATELY });
    const created = cycle({ created: NOW - 2 * DAY });
    const processed = cycle(); f.rows.markCloseProcessed(processed, LATELY);
    const rearmed = cycle(); f.rows.rearm(rearmed, LATELY);
    const completed = cycle({ state: 'fulfilled' }); f.rows.recordCompletion(completed, LATELY, null, false, false);
    const emitted = cycle(); f.rows.queueRuleEvent(emitted, LATELY); f.rows.acknowledgeRuleEvent(emitted);
    const pointed = cycle(); f.points.consumeQuestion(pointed, LATELY);
    const released = cycle(); plan('group-released', 'released', LATELY, released);
    const applied = cycle(); f.points.answer({ ask_id: 'ask-applied', occurrence_id: applied, outcome: 'done', answered_at: LONG_AGO }); f.points.applied('ask-applied', LATELY);
    const withdrawn = cycle(); f.points.requestCancellation(withdrawn, 'ask-withdrawn', LONG_AGO); f.points.acknowledgeReplacement('ask-withdrawn', LATELY);
    const newest = cycle({ created: NOW - DAY, closed: NOW - DAY });
    const recent = [owed, lately, created, processed, rearmed, completed, emitted, pointed, released, applied, withdrawn, newest];
    // One plan holds a waiting cycle's ask and a recent one's.
    plan('group-ready', 'ready', LONG_AGO, ready, lately);

    expect(f.retention().prune()).toMatchObject({ cycles: 3, cycle_logs: 1, close_events: 0, projections: 0 });
    expect([plain, undated, unconfirmed].filter(id => f.rows.get(id))).toEqual([]);
    expect([...waiting, ...recent].filter(id => !f.rows.get(id))).toEqual([]);
    // The confirmed service stays for the learner; what was heard about it goes.
    expect(f.rows.completion(confirmed)).toMatchObject({ owner_action: true }); expect(f.points.answersForOccurrence(confirmed)).toEqual([]);

    f.points.clearCurrent(asked, 'ask-current'); f.points.acknowledgeReplacement('ask-cancel', LONG_AGO);
    f.db.prepare('DELETE FROM occurrence_reminder_pending WHERE occurrence_id=?').run(reserved); f.points.applied('ask-answer', LONG_AGO);
    f.db.prepare("UPDATE occurrence_reminder_plans SET phase='released' WHERE group_id='group-ready'").run();
    f.rows.acknowledgeRuleEvent(emitting); f.rows.acknowledgeCloseOutcome(closing);
    f.db.prepare('UPDATE proactive_occasion_close_events SET delivered=1 WHERE id=?').run(occasionClosing);
    f.db.prepare('UPDATE household_ha_projections SET value=? WHERE occurrence_id=?').run(JSON.stringify({ withdrawn: true }), projected);
    notices.cancel(notice.reminder_id, LONG_AGO);
    f.proposals.outcome(toConfirm.id, 'not_this_one', LONG_AGO); f.proposals.outcome(toDate.id, 'accepted', LONG_AGO);

    // Delivered and withdrawn records go at once; then each cycle nothing waits on, with its records.
    expect(f.retention().prune()).toMatchObject({ cycles: waiting.length, cycle_logs: 0, close_events: 2, projections: 1 });
    expect(waiting.filter(id => f.rows.get(id))).toEqual([]);
    expect(recent.filter(id => !f.rows.get(id))).toEqual([]);
    expect(f.db.prepare('SELECT occurrence_id FROM occurrence_rule_events').all()).toEqual([{ occurrence_id: emitted }]);
    // The shared plan stays while the recent cycle's ask in it does.
    expect(f.db.prepare("SELECT count(*) AS n FROM occurrence_reminder_plans WHERE group_id='group-ready'").get()).toEqual({ n: 1 });
    // A task deleted while still owed no longer waits.
    f.work.deleteCommitment(`commitment-${owed}`, { tombstone: true, now: LONG_AGO });
    expect(f.retention().prune()).toMatchObject({ cycles: 1 }); expect(f.rows.get(owed)).toBeNull();
  });

  it('lets a clock’s newest cycle go once its asset, its rule or its occasion is gone, and drops service evidence past the learner’s lookback', () => {
    const f = clocks();
    const sold = cycles(f); const rewritten = cycles(f); const kept = cycles(f);
    const soldCycle = sold.cycle(); const rewrittenCycle = rewritten.cycle(); const keptCycle = kept.cycle();
    // The kept clock changed from a task to a notice: each kind counts from its own newest cycle.
    f.rows.ensure({ id: 'occurrence-kept-notice', asset_id: kept.car.id, rule_id: 'service', cycle: '2024-06-01:9', commitment_id: null, question: false,
      trigger_kind: 'rule', created_at: LONG_AGO + DAY });
    const party = f.history.saveOccasion({ title: 'Summer party', month_day: '07-01', people: [], muted: false, rules: [] }, LONG_AGO);
    const occasionCycle = (id: string) => f.rows.ensure({ id, asset_id: party.id, subject_kind: 'occasion', rule_id: party.rules[0]!.id, cycle: '2025-07-01',
      commitment_id: null, question: false, trigger_kind: 'rule', created_at: LONG_AGO });
    occasionCycle('occurrence-party');
    expect(f.retention().prune()).toMatchObject({ cycles: 0 });

    f.work.deleteAsset(sold.car.id, { tombstone: true, now: LONG_AGO });
    f.work.writeAsset({ id: rewritten.car.id, source_id: 'recued.asset', source, rules: [] }, LONG_AGO);
    f.history.deleteOccasion(party.id);
    expect(f.retention().prune()).toMatchObject({ cycles: 3 });
    expect([soldCycle, rewrittenCycle, keptCycle, 'occurrence-kept-notice', 'occurrence-party'].map(id => !!f.rows.get(id))).toEqual([false, false, true, true, false]);

    f.rows.recordService({ id: 'service-paper', asset_id: kept.car.id, rule_id: 'service', on: '1995-03-01', evidence_ref: 'paper', at: NOW - LEARNING_LOOKBACK_MS - DAY });
    f.rows.recordService({ id: 'service-mail', asset_id: kept.car.id, rule_id: 'service', on: '2026-03-01', evidence_ref: 'mail', at: NOW - DAY });
    expect(f.retention().prune()).toMatchObject({ services: 1 });
    expect(f.rows.services().map(row => row.id)).toEqual(['service-mail']);
  });
});

describe('D-325 proactive retention — composed', () => {
  it('is held by the triggers the real dispatcher feeds, and lets go of a removed one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-proactive-retention-')); dirs.push(dir);
    const dbPath = join(dir, 'server.db'); const runtimeConfig = createRuntimeConfigStore({});
    const storage = await composeStorageContext({ dbPath, runtimeConfig,
      bootTrace: createBootTrace({ entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {} }),
      vaultQuotas: { perPublisherBytes: 1_000_000, totalBytes: 5_000_000 } });
    try {
      const app = composeAppContext({ db: storage.db, dbPath, envLlmConfig: storage.envLlmConfig, gateRegistry: storage.gateRegistry,
        auditLog: storage.auditLog, eventBus: storage.eventBus, serverInstanceId: storage.serverInstanceId, recipeStore: storage.recipeStore,
        pairedInstances: storage.pairedInstances, workEntityStore: storage.workEntityStoreRef, chatLateBound: createExecutionLateBoundRefs() });
      await unlockServerVault(app.keys!);
      const collection = composeCollectionContext({ db: storage.db, dbPath, runtimeConfig, manifests: storage.manifests,
        baseVault: storage.baseVault, auditLog: storage.auditLog, cacheBlobs: app.cacheBlobs, warehouseBus: app.warehouseBus,
        contactStore: app.contactStoreRef, mailFactStore: storage.mailFactStoreRef, gateRegistry: storage.gateRegistry,
        accountStore: storage.accountStore, eventBus: storage.eventBus, keys: app.keys, connectionStore: app.connectionStoreRef,
        workEntityStore: storage.workEntityStoreRef, enrichmentCascade: app.enrichmentCascadeRef });
      const retention = collection.proactiveRetention!; const situations = collection.situationStore!;
      const triggers = createEventTriggersStore(storage.db); const failing = new Set<string>();
      const dispatcher = createEventTriggerDispatcher({ bus: createWarehouseEventBus(), store: triggers, situations,
        runtime: { runRecipe: async ({ trigger_id }) => { if (failing.has(trigger_id)) throw new Error('provider unavailable'); } } });
      const add = (id: string) => triggers.create({ trigger_id: id, recipe_id: `recipe-${id}`, publisher_id: 'local', pattern: 'data.situation.**', enabled: true, created_at: 0 });
      const catchUp = async () => { await dispatcher.catchUpSituations!(); await dispatcher.drained(); };
      const old = Date.now() - PROACTIVE_LOG_RETENTION_MS - DAY;

      add('one'); situations.save(snapshot(0), { source: 'brief' }, old); situations.save(snapshot(1), { source: 'brief' }, old);
      // The dispatcher has not fed trigger one yet, so it holds the whole log.
      expect(retention.prune().revisions).toBe(0);
      await catchUp();
      expect(retention.prune().revisions).toBe(2);

      add('two'); situations.save(snapshot(2), { source: 'brief' }, old);
      await catchUp();
      failing.add('two'); situations.save(snapshot(3), { source: 'brief' }, old);
      await catchUp();
      // Both handled revision 3. Trigger two failed on revision 4, which waits for its retry.
      expect(retention.prune().revisions).toBe(1);
      expect(revisions(situations)).toEqual([4]);
      expect(triggers.remove('two')).toBe(true);
      expect(retention.prune()).toMatchObject({ revisions: 1, checkpoints: 1 });
      expect(revisions(situations)).toEqual([]);
      dispatcher.dispose();

      // The overview is passed in: its older run goes, and the last one, which Settings shows, stays.
      const overviewRun = storage.db.prepare('INSERT INTO scheduled_situation_runs(id,mode,day,at,state) VALUES(?,?,?,?,?)');
      overviewRun.run('overview:older', 'overview', '2025-09-01', old - DAY, 'skipped'); overviewRun.run('overview:old', 'overview', '2025-09-02', old, 'skipped');
      expect(retention.prune()).toMatchObject({ overview_runs: 1 });
      expect(collection.scheduledSituations!.status().last_run?.at).toBe(old);
      // One pass drops a resolved situation, then what the overview kept about it.
      situations.save({ ...snapshot(4), id: 'gone', state: 'resolved', cluster: { ...snapshot(4).cluster, id: 'gone' } }, { source: 'brief' }, old);
      storage.db.prepare("INSERT INTO scheduled_situation_seen(id,fingerprint,sent_at) VALUES('gone','f',?)").run(old);
      expect(retention.prune()).toMatchObject({ situations: 1, overview_cached: 1 });
      // The work and mail stores are passed in: a cycle of an asset that is gone goes, and so does the tombstone of an offer from mail that is gone.
      createAssetOccurrenceStore(storage.db).ensure({ id: 'occurrence-gone', asset_id: 'asset-gone', rule_id: 'service', cycle: '2024-01-01:1', commitment_id: null,
        question: false, trigger_kind: 'rule', created_at: Date.now() - PROACTIVE_COUNT_RETENTION_MS - DAY });
      const offers = createProactiveProposalStore(storage.db);
      offers.delete(offers.ensure({ key: 'intake:mthing_gone:item', kind: 'asset', title: 'Television', explanation: '', confidence: 'low', origin: 'intake',
        payload: {}, sources: [] }, old).id);
      expect(retention.prune()).toMatchObject({ cycles: 1, tombstones: 1 });
    } finally { storage.db.close(); }
  }, 60_000);
});
