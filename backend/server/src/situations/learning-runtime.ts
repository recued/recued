import { setImmediate } from 'node:timers/promises';
import type Database from 'better-sqlite3';
import { assetDateAt, calendarDayMs, evaluateAssetRuleClock, occasionNextDate, nextAnnualDate, isAssetDate,
  type AssetRule, type EpisodeInput, type Occasion, type ProactiveProposal, type ProactiveProposalInput, type SituationFact, type SituationRef, type Sphere } from '@recued/contracts';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { createOccurrenceReminderStore } from '../storage/occurrence-reminder-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveLearningStore } from '../storage/proactive-learning-store.js';
import { createTripDetailsStore, tripFromSource } from '../storage/trip-details-store.js';
import type { SphereStore } from '../storage/sphere-store.js';
import type { SituationStore } from '../storage/situation-store.js';
import { publishProposalEvents } from './proposal-events.js';
import { collectProposalMeasures, recordDigestResponse } from './measures.js';
import type { EpisodeRuntime } from './episode-runtime.js';
import { clockLearningProposals, kindLearningPool, kindRankingFloor, kindRankingProposal, learningDigest, learningPool, LEARNING_LOOKBACK_MS, RELATION_LOOKBACK_MS, relationKey, relationOfferKey,
  type ClockLearningSignal, type LearningTarget, type ServiceLearningSignal } from './learning.js';

const DAY = 86_400_000;
const identity = (ref: SituationRef) => JSON.stringify([ref.collection, ref.id]);
const habitRuleId = (class_id = 'activity') => `habit_${class_id.toLowerCase().replace(/[^a-z0-9_]/gu, '_').slice(0, 55)}`;
const samePeople = (left: readonly string[], right: readonly string[]) => left.length > 0 && left.length === right.length && [...left].sort().every((person, index) => person === [...right].sort()[index]);
const nearAnnualDate = (left: string, right: string) => { const a = calendarDayMs(`2000-${left}`); const b = calendarDayMs(`2000-${right}`);
  if (a === null || b === null) return false; const days = Math.abs(a - b) / DAY; return Math.min(days, 366 - days) <= 14; };
export interface ProactiveLearningDeps {
  db: Database.Database; work: WorkEntityStore; spheres: SphereStore; situations: SituationStore; episodes?: EpisodeRuntime;
  timeZone(): string; isVaultUnlocked(): boolean; now?(): number;
  excludedPerson?(id: string): boolean;
  tripExists?(ref: SituationRef): boolean;
  /** The name the owner gave a mail-fact type of their own, for its kind's suggestion. */
  kindName?(kind: string): string | undefined;
}
/** An hourly, local learner. Its only writes are private evidence and inert
 * proposals. Accepted configuration is read by the query, never self-applied. */
export const createProactiveLearning = (deps: ProactiveLearningDeps) => {
  const now = deps.now ?? Date.now; const rows = createAssetOccurrenceStore(deps.db); const points = createOccurrenceReminderStore(deps.db);
  const proposals = createProactiveProposalStore(deps.db); const history = createProactiveHistoryStore(deps.db, proposals);
  const store = createProactiveLearningStore(deps.db); const trips = createTripDetailsStore(deps.db);
  const scope = (ref: SituationRef) => deps.spheres.resolve(ref).sphere;
  const occasionAllowed = (occasion: Occasion, at = now()) => occasion.source_active !== false && !occasion.muted
    && !occasion.people.some(person => deps.excludedPerson?.(person))
    && !history.suppressed({ ...occasion, when: { from: at, to: at } });
  const targetOf = (ref: SituationRef, rule_id: string): LearningTarget | null => {
    if (ref.collection === 'asset') {
      const asset = deps.work.readAssetEffective(ref.id); const rule = asset?.rules.find(rule => rule.id === rule_id);
      if (!asset || asset.deleted_at != null || !['active', 'lent'].includes(asset.status) || !rule?.enabled || rule.muted || !rule.reaction.notify || rule.reaction.occurrence !== 'action') return null;
      const clock = evaluateAssetRuleClock(asset, rule, { now: now(), timeZone: deps.timeZone(),
        ...(rule.when.kind === 'objective' ? { readings: deps.work.assetReadingHistory(asset.id, rule.when.field) } : {}) });
      return { ref, name: asset.name, class_id: asset.class_id ?? 'unclassified', sphere: scope(ref), rule, due_on: clock.due_on };
    }
    if (ref.collection !== 'occasion') return null;
    const occasion = history.occasion(ref.id); const rule = occasion?.rules.find(rule => rule.id === rule_id);
    if (!occasion || !occasionAllowed(occasion) || !rule?.enabled || rule.muted || !rule.reaction.notify || rule.reaction.occurrence !== 'action') return null;
    const next = occasionNextDate(occasion, assetDateAt(now(), deps.timeZone()));
    if (!next) return null;
    const clock = evaluateAssetRuleClock({ status: 'active', dates: { next_on: next }, readings: {}, observations: {} }, rule, { now: now(), timeZone: deps.timeZone() });
    if (clock.due_on && !occasionAllowed(occasion, calendarDayMs(next!)!)) return null;
    return { ref, name: occasion.title, class_id: occasion.class_id ?? 'occasion', sphere: scope(ref), rule, due_on: clock.due_on, occasion_on: next };
  };
  const sourceStillAllowed = (signal: ClockLearningSignal): boolean => {
    let pool: unknown; try { pool = JSON.parse(signal.pool); } catch { return false; }
    if (!Array.isArray(pool) || typeof pool[0] !== 'string' || typeof pool[1] !== 'string') return false;
    const class_id = pool[0]; const sphere = pool[1] === 'unsorted' ? undefined : pool[1];
    return signal.evidence.every(ref => {
      if (ref.collection === 'asset') { const value = deps.work.readAssetEffective(ref.id); return !!value && value.deleted_at == null
        && (value.class_id ?? 'unclassified') === class_id && scope(ref) === sphere; }
      if (ref.collection === 'occasion') { const value = history.occasion(ref.id); return !!value && (value.class_id ?? 'occasion') === class_id
        && scope(ref) === sphere && occasionAllowed(value, signal.occasion_on ? calendarDayMs(signal.occasion_on)! : signal.at); }
      if (ref.collection === 'commitment') { const value = deps.work.readCommitment(ref.id); return !!value && value.deleted_at == null; }
      return true;
    });
  };
  const collectClocks = () => {
    for (const row of rows.all()) {
      if (!row.commitment_id || row.question) continue;
      const commitment = deps.work.readCommitment(row.commitment_id); if (!commitment || !['fulfilled', 'cancelled', 'expired'].includes(commitment.lifecycle_state)) continue;
      const ref = { collection: row.subject_kind === 'occasion' ? 'occasion' : 'asset', id: row.asset_id };
      const target = targetOf(ref, row.rule_id); if (!target) continue;
      const ownerAnswers = points.answersForOccurrence(row.id).filter(answer => answer.owner_action === true);
      const completion = rows.completion(row.id);
      const owner = completion?.owner_action === true && completion.known !== false;
      const declined = ownerAnswers.some(answer => answer.outcome === 'not_needed');
      if (commitment.lifecycle_state === 'fulfilled' && !owner || commitment.lifecycle_state === 'cancelled' && !declined) continue;
      const plans = points.plansForOccurrence(row.id);
      const due = commitment.promised_for_at === undefined ? null : new Date(commitment.promised_for_at).toISOString().slice(0, 10);
      // No released plan is a firm absence. A released UI event without a
      // display receipt is unknown; it cannot be called an unseen lapse.
      const released = plans.filter(plan => plan.phase === 'released');
      const before = due && released.some(plan => assetDateAt(plan.updated_at, deps.timeZone()) <= due);
      const surfaced: ClockLearningSignal['surfaced'] = !released.length ? 'none' : before ? 'unknown' : 'late';
      if (owner || declined) recordDigestResponse(deps.situations, [ref, { collection: 'commitment', id: commitment.id }], commitment.lifecycle_changed_at);
      if (commitment.lifecycle_state === 'expired') deps.situations.measure('clock.lapse', 1, { surfaced, class: target.class_id,
        sphere: target.sphere ?? 'unsorted' }, commitment.lifecycle_changed_at, `clock-lapse:${row.id}`);
      store.record({ id: `clock:${row.id}:${commitment.lifecycle_state}`, subject: { collection: 'commitment', id: commitment.id }, rule_id: row.rule_id,
        pool: learningPool(target.class_id, target.sphere, target.rule), at: commitment.lifecycle_changed_at,
        outcome: commitment.lifecycle_state === 'fulfilled' ? 'fulfilled' : commitment.lifecycle_state === 'cancelled' ? 'dismissed' : 'lapsed',
        actor: owner || declined ? 'owner' : 'system', due_on: due,
        ...(ref.collection === 'occasion' && isAssetDate(row.cycle) ? { occasion_on: row.cycle } : {}),
        ...(owner ? { acted_on: completion!.confirmed_on ?? assetDateAt(completion!.answered_at, deps.timeZone()) } : {}), surfaced,
        evidence: [ref, { collection: 'commitment', id: commitment.id }] });
    }
  };
  const serviceSignals = (): ServiceLearningSignal[] => {
    const result: ServiceLearningSignal[] = [];
    for (const service of rows.services()) {
      const ref = { collection: 'asset', id: service.asset_id }; const target = targetOf(ref, service.rule_id); if (!target) continue;
      result.push({ id: service.id, pool: learningPool(target.class_id, target.sphere, target.rule), asset_id: ref.id, on: service.on_date,
        evidence: [{ ...ref, field: `dates.${target.rule.when.field}` }] });
    }
    for (const row of rows.all()) {
      if (row.subject_kind === 'occasion') continue;
      const completion = rows.completion(row.id); if (completion?.owner_action !== true || completion.known === false) continue;
      const ref = { collection: 'asset', id: row.asset_id }; const target = targetOf(ref, row.rule_id); if (target?.rule.when.kind !== 'interval') continue;
      result.push({ id: `completed:${row.id}`, pool: learningPool(target.class_id, target.sphere, target.rule), asset_id: ref.id,
        on: completion.confirmed_on ?? assetDateAt(completion.answered_at, deps.timeZone()), evidence: [ref, ...(row.commitment_id ? [{ collection: 'commitment', id: row.commitment_id }] : [])] });
    }
    return result;
  };
  const currentTrip = (ref: SituationRef): boolean => {
    if (ref.collection === 'booking') { const row = deps.work.readBooking(ref.id); return !!row && row.deleted_at == null && row.lifecycle_state !== 'cancelled'
      && !!(trips.get(ref) ?? tripFromSource(ref, row.source_extension_blob)); }
    return deps.tripExists?.(ref) === true && trips.get(ref) !== null;
  };
  const offer = (input: ProactiveProposalInput) => {
    if (!proposals.allows(input)) return;
    // Replace an obsolete calculation, but never overwrite an owner's draft.
    if (input.payload.learning_pool) {
      for (const old of proposals.list({ state: 'proposed', kind: input.kind, limit: 10000 })) {
        if (old.origin !== 'learner' || old.payload.learning_pool !== input.payload.learning_pool || old.key === input.key) continue;
        if (input.kind !== 'ranking' && identity(old.subject!) !== identity(input.subject!)) continue;
        if (old.edited_at !== undefined) return;
        proposals.outcome(old.id, 'retracted', now());
      }
    }
    proposals.ensure(input, now());
  };
  const memoryOn = () => deps.situations.readSetting<'on' | 'off' | 'unasked'>('last_time.choice', 'unasked') === 'on';
  const memoryEvidenceAllowed = (ids: unknown, recall = false): ids is string[] => Array.isArray(ids) && ids.length > 0 && ids.length <= 10
    && memoryOn() && ids.every(id => {
      if (typeof id !== 'string' || !deps.episodes?.episodeAllowed(id)) return false;
      const episode = history.episode(id);
      return !!episode && (!recall || proposals.allows({ kind: 'recall', payload: { proposal_class: `recall:${episode.class_id}` } }));
    });
  const habitEvidenceAllowed = (proposal: Pick<ProactiveProposal, 'payload'>): boolean => {
    const ids = proposal.payload.episode_ids;
    if (!memoryEvidenceAllowed(ids, true) || new Set(ids).size < 3) return false;
    const accepted = proposals.list({ kind: 'recall', state: 'accepted', limit: 10000 })
      .filter(row => ids.includes(String(row.payload.episode_id)) && isAssetDate(row.payload.on));
    if (new Set(accepted.map(row => row.payload.episode_id)).size !== ids.length) return false;
    const episodes = ids.map(id => history.episode(id)!); const first = episodes[0]!;
    if (episodes.some(episode => episode.class_id !== first.class_id || episode.sphere !== first.sphere
      || !(first.occasion_id && episode.occasion_id === first.occasion_id || samePeople(first.people, episode.people)
        || first.where && episode.where?.key === first.where.key))) return false;
    const years = new Set(accepted.map(row => Number(String(row.payload.on).slice(0, 4)))); const last = Math.max(...years);
    return years.has(last - 1) && years.has(last - 2) && last >= Number(assetDateAt(now(), deps.timeZone()).slice(0, 4)) - 1
      && accepted.every(row => nearAnnualDate(String(row.payload.on).slice(5), String(accepted[0]!.payload.on).slice(5)));
  };
  const refreshPending = () => {
    for (let offset = 0; ;) {
      const page = proposals.list({ state: 'proposed', limit: 500, offset }); if (!page.length) break; let removed = 0;
      for (const proposal of page) {
        if (proposal.origin !== 'learner') continue;
        const payload = proposal.payload; let valid = true;
        if (payload.learning_pool && typeof payload.rule_id === 'string') {
          const ref = typeof payload.asset_id === 'string' ? { collection: 'asset', id: payload.asset_id } : { collection: 'occasion', id: String(payload.occasion_id) };
          const target = targetOf(ref, payload.rule_id);
          valid = !!target && learningDigest(target.rule) === payload.baseline_rule_hash && learningPool(target.class_id, target.sphere, target.rule) === payload.learning_pool;
          if (proposal.kind === 'ranking') valid &&= store.weight(String(payload.learning_pool)) === payload.baseline_weight;
        }
        if (Array.isArray(payload.episode_ids)) valid &&= memoryEvidenceAllowed(payload.episode_ids, proposal.kind === 'habit');
        if (proposal.kind === 'habit') valid &&= habitEvidenceAllowed(proposal);
        if (proposal.kind === 'habit' && typeof payload.occasion_id === 'string') {
          const occasion = history.occasion(payload.occasion_id); valid &&= !!occasion && occasionAllowed(occasion) && learningDigest(occasion.rules) === payload.baseline_occasion_hash;
        }
        // A kind's ranking was offered against its weight then (§8).
        if (proposal.kind === 'ranking' && typeof payload.item_kind === 'string') {
          valid &&= payload.learning_pool === kindLearningPool(payload.item_kind) && store.weight(String(payload.learning_pool)) === payload.baseline_weight;
        }
        if (proposal.kind === 'relation') {
          const relation = payload.relation as { evidence?: SituationRef[]; key?: string } | undefined;
          valid &&= Array.isArray(relation?.evidence) && relation.evidence.every(currentTrip) && !store.relations().some(row => row.key === relation.key);
        }
        if (!proposals.allows(proposal)) valid = false;
        if (!valid) { proposals.outcome(proposal.id, 'retracted', now()); removed++; }
      }
      offset += page.length - removed;
    }
  };
  const relationOffers = () => {
    for (const group of store.relationGroups()) {
      const evidence = group.evidence.filter(row => now() - row.at < RELATION_LOOKBACK_MS && currentTrip(row.from)
        && deps.work.readAssetEffective(row.target.id)?.class_id === group.target_class && scope(row.from) === group.sphere && scope(row.target) === group.sphere);
      const from = [...new Map(evidence.map(row => [identity(row.from), row.from])).values()];
      const key = relationKey(group.target_class, group.sphere);
      if (from.length < 3 || store.relations().some(row => row.key === key)) continue;
      offer({ kind: 'relation', key: relationOfferKey(key), title: `Relate trips to ${group.target_class}`, explanation: `The owner opened this class after ${from.length} distinct trips in the ${group.sphere ?? 'unsorted'} sphere. Include its records beside future trips?`,
        subject: evidence[0]!.target, sources: [...from.slice(0, 5), evidence[0]!.target], confidence: 'medium', origin: 'learner',
        payload: { relation: { key, from: 'trip', target_class: group.target_class, ...(group.sphere ? { sphere: group.sphere } : {}), evidence: from.slice(0, 5) },
          proposal_class: `trip-relation:${group.target_class}:${group.sphere ?? 'unsorted'}` } });
    }
  };
  const memoryOffers = async () => {
    if (!deps.episodes || !memoryOn()) return;
    const epoch = proposals.setting('history.epoch', 0); const episodes = (await deps.episodes.ownerEpisodes()).filter(row => row.id && row.when.to <= now() && deps.episodes!.episodeInputAllowed(row));
    if (epoch !== proposals.setting('history.epoch', 0) || !deps.isVaultUnlocked() || !memoryOn() || stopped) return;
    const groups = new Map<string, EpisodeInput[]>();
    for (const episode of episodes) {
      const subject = episode.people.length ? ['people', [...episode.people].sort()] : episode.where ? ['place', episode.where.key] : null;
      if (!subject) continue;
      const key = JSON.stringify([episode.class_id ?? 'activity', episode.sphere ?? 'unsorted', subject]); const group = groups.get(key) ?? []; group.push(episode); groups.set(key, group);
    }
    for (const [groupKey, group] of groups) {
      group.sort((a, b) => b.when.from - a.when.from); const latest = group[0]!;
      const prior = group.slice(1).find(row => { const days = (latest.when.from - row.when.from) / DAY; return days >= 330 && days <= 400; });
      if (!prior || latest.when.to < now() - 400 * DAY || !deps.episodes.episodeInputAllowed(latest) || !deps.episodes.episodeInputAllowed(prior)) continue;
      const month_day = assetDateAt(latest.when.from, deps.timeZone()).slice(5);
      if (history.occasions(10000).some(row => row.class_id === latest.class_id && scope({ collection: 'occasion', id: row.id }) === latest.sphere && nearAnnualDate(row.month_day, month_day) && (samePeople(row.people, latest.people)
        || row.where && latest.where && row.where.key === latest.where.key))) continue;
      // One question per recurring occasion: an earlier offer about the same people or
      // place near this date is the same question. Answered, it is not asked again;
      // still open, it gives way to this one, which cites the newer episode.
      const same = proposals.list({ kind: 'occasion', limit: 10000 }).filter(row => {
        const asked = row.payload.occasion as { class_id?: string; sphere?: string; month_day?: unknown; people?: string[]; where?: { key: string } } | undefined;
        return row.origin === 'learner' && asked !== undefined && asked.class_id === latest.class_id && (asked.sphere ?? 'unsorted') === (latest.sphere ?? 'unsorted')
          && typeof asked.month_day === 'string' && nearAnnualDate(asked.month_day, month_day)
          && (latest.people.length ? samePeople(asked.people ?? [], latest.people) : asked.where?.key === latest.where?.key);
      });
      if (same.some(row => row.state === 'accepted' || row.state === 'dismissed')) continue;
      const input: ProactiveProposalInput = { kind: 'occasion', key: `learning:occasion:${learningDigest([groupKey, month_day])}`, title: `Does this recur? · ${latest.title}`,
        explanation: `Two concrete episodes with the same ${latest.people.length ? 'people' : 'place'} are about a year apart. Confirm an annual occasion around ${month_day}?`,
        confidence: 'low', origin: 'learner', sources: [{ collection: 'episode', id: prior.id! }, { collection: 'episode', id: latest.id! }],
        payload: { occasion: { title: latest.title, month_day, people: latest.people, ...(latest.where ? { where: latest.where } : {}), class_id: latest.class_id,
          ...(latest.sphere ? { sphere: latest.sphere } : {}), muted: false, rules: [] }, episode_ids: [prior.id, latest.id], proposal_class: `occasion:${latest.class_id ?? 'activity'}` } };
      if (!proposals.allows(input)) continue;
      deps.db.transaction(() => { const proposal = proposals.ensure(input, now()); if (proposal.state !== 'proposed') return;
        for (const row of same) if (row.state === 'proposed' && row.id !== proposal.id) proposals.outcome(row.id, 'retracted', now());
        for (const episode of [prior, latest]) if (!history.episode(episode.id!)) history.saveEpisode({ ...episode, storage_reason: 'proposal_citation' }, now()); })();
    }
    const accepted = proposals.list({ state: 'accepted', kind: 'recall', limit: 10000 });
    const habitGroups = new Map<string, typeof accepted>();
    for (const proposal of accepted) {
      const episode = history.episode(String(proposal.payload.episode_id));
      if (!episode || !deps.episodes.episodeAllowed(episode.id) || !proposals.allows({ kind: 'recall', payload: { proposal_class: `recall:${episode.class_id}` } })
        || typeof proposal.payload.on !== 'string' || calendarDayMs(proposal.payload.on) === null) continue;
      const subject = episode.occasion_id ?? JSON.stringify([episode.people.length ? [...episode.people].sort() : episode.where?.key, episode.class_id, episode.sphere]);
      if (!episode.people.length && !episode.where && !episode.occasion_id) continue;
      const key = JSON.stringify([subject, episode.class_id ?? 'activity', episode.sphere ?? 'unsorted']); const group = habitGroups.get(key) ?? []; group.push(proposal); habitGroups.set(key, group);
    }
    for (const [key, group] of habitGroups) {
      const ordered = [...group].sort((a, b) => String(b.payload.on).localeCompare(String(a.payload.on))); const latest = ordered[0]!;
      const seasonal = ordered.filter(row => nearAnnualDate(String(row.payload.on).slice(5), String(latest.payload.on).slice(5)));
      const byYear = new Map<string, typeof latest>(); for (const row of seasonal) { const year = String(row.payload.on).slice(0, 4); if (!byYear.has(year)) byYear.set(year, row); }
      const years = new Set([...byYear.keys()].map(Number)); const latestYear = Math.max(...years);
      if (!years.has(latestYear - 1) || !years.has(latestYear - 2) || latestYear < Number(assetDateAt(now(), deps.timeZone()).slice(0, 4)) - 1) continue;
      const sample = [...byYear.values()]
        .filter(row => Number(String(row.payload.on).slice(0, 4)) >= latestYear - 2).slice(0, 3);
      const episode = history.episode(String(latest.payload.episode_id))!;
      const occasion = episode.occasion_id ? history.occasion(episode.occasion_id) : history.occasions(10000).find(row => row.class_id === episode.class_id
        && scope({ collection: 'occasion', id: row.id }) === episode.sphere && nearAnnualDate(row.month_day, String(latest.payload.on).slice(5))
        && (samePeople(row.people, episode.people) || row.where && episode.where && row.where.key === episode.where.key));
      if (occasion && (!occasionAllowed(occasion) || !occasionNextDate(occasion, assetDateAt(now(), deps.timeZone())) || occasion.rules.some(rule => rule.id === habitRuleId(episode.class_id)))) continue;
      const month_day = occasion?.month_day ?? assetDateAt(episode.when.from, deps.timeZone()).slice(5);
      const occasionOn = nextAnnualDate(month_day, `${latestYear}-01-01`);
      const difference = occasionOn ? Math.round((calendarDayMs(occasionOn)! - calendarDayMs(String(latest.payload.on))!) / DAY) : 7;
      const offset = difference >= 0 && difference <= 30 ? difference : 7;
      const rule: AssetRule = { id: habitRuleId(episode.class_id), title: String(latest.payload.statement), enabled: false, muted: false, pinned: false,
        consequence: 'routine', expiry_policy: 'strict_expire', when: { kind: 'expiry', field: 'next_on', ...(offset ? { offset: { amount: offset, unit: 'days' } as const } : {}) }, reaction: { notify: true, occurrence: 'action', emit: false },
        schedule: { before: [{ amount: 1, unit: 'weeks' }], on_day: true } };
      offer({ kind: 'habit', key: `learning:habit:${learningDigest(key)}`, title: `An annual task? · ${rule.title}`,
        explanation: 'The owner accepted this kind in three consecutive years. Offer an annual task on the occasion, with reminders asking the owner to act. It does not buy, book or send anything.',
        sources: sample.map(row => ({ collection: 'episode', id: String(row.payload.episode_id) })), confidence: 'medium', origin: 'learner',
        ...(occasion ? { subject: { collection: 'occasion', id: occasion.id } } : {}), payload: { occasion_id: occasion?.id,
          occasion_on: occasion ? occasionNextDate(occasion, assetDateAt(now(), deps.timeZone())) : nextAnnualDate(month_day, assetDateAt(now(), deps.timeZone())),
          ...(occasion ? { baseline_occasion_hash: learningDigest(occasion.rules) } : { occasion: { title: episode.title, class_id: episode.class_id,
            month_day, people: episode.people, ...(episode.where ? { where: episode.where } : {}), ...(episode.sphere ? { sphere: episode.sphere } : {}), muted: false, rules: [] } }),
          rule, episode_ids: sample.map(row => String(row.payload.episode_id)), proposal_class: `habit:${episode.class_id ?? 'activity'}` } });
    }
  };
  let running: Promise<void> | undefined; let stopped = false;
  const run = async () => {
    if (stopped || !deps.isVaultUnlocked()) return;
    collectClocks(); collectProposalMeasures(proposals, deps.situations);
    const confirmations = rows.services();
    for (const row of rows.all().filter(row => row.question)) {
      const evidence = confirmations.find(value => value.asset_id === row.asset_id && value.rule_id === row.rule_id && value.at >= row.created_at);
      if (evidence) deps.situations.measure('clock.last_done', 1, { outcome: 'confirmed' }, evidence.at, `last-done:${row.id}`);
    }
    const services = serviceSignals(); const since = now() - LEARNING_LOOKBACK_MS;
    for (let cursor = ''; ;) {
      const page = deps.work.walkByAssetId(cursor, 100); if (!page.length) break;
      for (const asset of page) for (const rule of asset.rules) { const target = targetOf({ collection: 'asset', id: asset.id }, rule.id); if (!target) continue;
        const pool = learningPool(target.class_id, target.sphere, rule);
        const signals = store.signals(pool, since).filter(sourceStillAllowed);
        for (const input of clockLearningProposals(target, signals, services, store.weight(pool))) offer(input); }
      cursor = page.at(-1)!.id; await setImmediate(); if (stopped || !deps.isVaultUnlocked()) return;
    }
    for (const occasion of history.occasions(10000)) for (const rule of occasion.rules) {
      const target = targetOf({ collection: 'occasion', id: occasion.id }, rule.id); if (!target) continue; const pool = learningPool(target.class_id, target.sphere, rule);
      for (const input of clockLearningProposals(target, store.signals(pool, since).filter(sourceStillAllowed), [], store.weight(pool))) offer(input);
    }
    // Option A: the kinds Today shows that no rule raises, from what the owner opened and
    // set aside there. One suggestion per kind, inert until accepted (§8).
    const kinds = store.kindSignals(since);
    const offered = proposals.list({ state: 'proposed', kind: 'ranking', limit: 10000 }).filter(row => row.origin === 'learner' && typeof row.payload.item_kind === 'string');
    for (const kind of new Set([...kinds.map(row => row.kind), ...offered.map(row => String(row.payload.item_kind))])) {
      const input = kindRankingProposal(kind, kinds, store.weight(kindLearningPool(kind)), deps.kindName?.(kind));
      if (input) { offer(input); continue; }
      // Evidence that no longer argues for a change (an answer undone, the other side
      // caught up) withdraws the offer it made, unless the owner edited it.
      for (const old of offered) if (old.payload.item_kind === kind && old.edited_at === undefined) proposals.outcome(old.id, 'retracted', now());
    }
    relationOffers(); await memoryOffers(); refreshPending(); publishProposalEvents(proposals, deps.situations, deps.spheres);
  };
  return {
    store, targetOf, refreshPending, memoryEvidenceAllowed, habitEvidenceAllowed, tick: () => running ??= run().finally(() => { running = undefined; }),
    allowsOccasion: (occasion: Occasion) => { const next = occasionNextDate(occasion, assetDateAt(now(), deps.timeZone())); return !!next && occasionAllowed(occasion, calendarDayMs(next)!); },
    async stop() { stopped = true; await running; },
    tripExists: currentTrip,
    recordOpened(ref: SituationRef, client: string) {
      if (!deps.isVaultUnlocked() || !client) return;
      if (currentTrip(ref)) { store.setContext(client, ref, scope(ref), now()); return; }
      const prior = store.context(client); store.clearContext(client);
      if (ref.collection !== 'asset' || !prior || now() - prior.at > 300_000 || !currentTrip(prior.ref) || scope(prior.ref) !== scope(ref)) return;
      const asset = deps.work.readAssetEffective(ref.id); if (!asset || asset.deleted_at != null || !asset.class_id) return;
      store.relationEvidence({ id: learningDigest([prior.ref, ref]), target_class: asset.class_id, sphere: scope(ref), from: prior.ref, target: ref, at: now() });
    },
    rank(fact: SituationFact): number {
      const ref = fact.evidence.find(ref => (ref.collection === 'asset' || ref.collection === 'occasion') && ref.field?.startsWith('rules.'));
      const target = ref ? targetOf({ collection: ref.collection, id: ref.id }, ref.field!.slice(6)) : null;
      if (target) return store.weight(learningPool(target.class_id, target.sphere, target.rule));
      // A bill or a delivery ranks by the factor the owner accepted for its kind (§8).
      return fact.ref.collection === 'mail_fact' ? Math.max(kindRankingFloor(fact.kind), store.weight(kindLearningPool(fact.kind))) : 1;
    },
    /** Option A — an item of a kind no rule raises, opened from Today or set aside there.
     * Only the owner's own actions teach (§8); an item only ignored teaches nothing. */
    recordKindSignal(input: { id: string; kind: string; ref: SituationRef; outcome: 'opened' | 'dismissed'; at?: number }): void {
      if (!deps.isVaultUnlocked()) return;
      store.recordKind({ id: input.id, pool: kindLearningPool(input.kind), kind: input.kind, subject: { collection: input.ref.collection, id: input.ref.id },
        at: input.at ?? now(), outcome: input.outcome, actor: 'owner' });
    },
    forgetKindSignal(id: string): void { store.forget(id); },
    /** The asset classes `related` pairs with trips, which a situation read loads whatever its window. */
    relationClasses: (): string[] => [...new Set(store.relations().map(relation => relation.target_class))],
    related(facts: readonly SituationFact[]): SituationFact[] {
      const result: SituationFact[] = [];
      for (const relation of store.relations()) for (const trip of facts.filter(fact => fact.trip && fact.sphere === relation.sphere)) for (const candidate of facts) {
        if (candidate.sphere !== relation.sphere || candidate.ref.collection !== 'asset' || deps.work.readAssetEffective(candidate.ref.id)?.class_id !== relation.target_class) continue;
        result.push({ ...candidate, related: [...candidate.related, trip.ref], subjects: [...candidate.subjects, trip.ref], basis: 'declared',
          evidence: [...candidate.evidence, ...trip.evidence] });
        if (result.length >= 20000) return result;
      }
      return result;
    },
  };
};
export type ProactiveLearning = ReturnType<typeof createProactiveLearning>;
