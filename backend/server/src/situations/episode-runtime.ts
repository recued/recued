import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type Database from 'better-sqlite3';
import { assetDateAt, calendarDayMs, contactExcludedFromProactive, eventSpanIn, isAssetDate,
  type Episode, type EpisodeInput, type MailFact, type SituationCluster, type SituationFact,
  type SituationPlace, type SituationQuery, type SituationRef, type Sphere } from '@recued/contracts';
import { mintAskId, type AskDeliveryInput, type NotificationBlock } from '@recued/notification';
import type { ContactStore } from '../storage/contact-store.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import type { RecordsStore } from '../records/store.js';
import { readPhotoTraces } from './photo-traces.js';
import { arrivalTrace } from './arrival-traces.js';
import type { CollectionTable } from '../collections/table.js';
import type { MailFactStore } from '../storage/mail-fact-store.js';
import type { UserMemoryStore } from '../user-memory-store.js';
import type { CalendarCollectionTable } from '../collections/calendar/calendar-table.js';
import { createProactiveHistoryStore, episodeCandidateId } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createProactiveTraceStore, traceId, type ProactiveTrace } from '../storage/proactive-trace-store.js';
import type { SituationStore } from '../storage/situation-store.js';
import { assembleEpisodes, type EpisodePlan } from './episode-assembly.js';
import { SituationScanBoundError, type SituationReadContext, type SituationSource } from './query.js';
import { situationSourceReadOp } from './event-visibility.js';

const DAY = 86_400_000;
const MAX_ROWS = 20_000;
const RECALL_CLASSES = ['flowers', 'gifts', 'restaurants', 'photos', 'checkin'] as const;
const PRIVATE = /\b(health|hospital|clinic|medic(?:ine|al|ation)|pharmac\w*|prescription|pregnan\w*|fertility|miscarriage|cancer|therapy|insulin|contracepti\w*|debt|overdraft|arrears|bankruptcy|divorce|breakup|ex.partner|dating|romance|relationship)\b/iu;
const object = (raw: unknown): Record<string, unknown> => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
const string = (raw: unknown): string | undefined => typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
const hash = (raw: unknown) => createHash('sha256').update(JSON.stringify(raw)).digest('hex');
const ownerContext: SituationReadContext = { owner: true, grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true } };
const refKey = (ref: SituationRef) => JSON.stringify([ref.collection, ref.id]);
const instant = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15 ? value : undefined;
  if (typeof value !== 'string' || !isAssetDate(value.slice(0, 10))) return undefined;
  const at = value.length === 10 ? calendarDayMs(value)! : Date.parse(value); return Number.isFinite(at) ? at : undefined;
};
const sameSubject = (episode: Pick<EpisodeInput, 'people' | 'where' | 'subjects'>, trace: Pick<ProactiveTrace, 'people' | 'where' | 'subjects'>) => episode.people.length
  ? episode.people.length === trace.people.length && episode.people.every(person => trace.people.includes(person))
  : Boolean(episode.where && trace.where && episode.where.key === trace.where.key || episode.subjects.some(ref => trace.subjects.some(other => refKey(ref) === refKey(other))));
const shifted = (at: number, year: number): number => { const date = new Date(at); date.setUTCFullYear(year); return date.getTime(); };
/** A recall offer is made for one year's anniversary, so its key ends in the year. */
export const recallOfferKey = (episode_id: string, on: string): string => `recall:${episode_id}:${on.slice(0, 4)}`;
export const recallOfferYear = (key: string): number | null => { const match = /^recall:.+:(\d{4})$/u.exec(key); return match ? Number(match[1]) : null; };

export interface EpisodeRuntimeDeps {
  db: Database.Database;
  work: WorkEntityStore;
  situations: SituationStore;
  mailFacts?: MailFactStore;
  contacts?: ContactStore;
  calendars(): ReadonlyArray<{ slug: string; table: Pick<CalendarCollectionTable, 'listSnapshots'> }>;
  mailboxes?(): ReadonlyArray<{ slug: string; table: Pick<CollectionTable, 'bodyEvidencePage'> }>;
  photoFilePath?(id: string): string | undefined;
  timeZone(): string;
  sphere?(ref: SituationRef, source?: string): Sphere | undefined;
  isVaultUnlocked(): boolean;
  now?(): number;
}

export const createEpisodeRuntime = (deps: EpisodeRuntimeDeps) => {
  const now = deps.now ?? Date.now; const proposals = createProactiveProposalStore(deps.db);
  const history = createProactiveHistoryStore(deps.db, proposals); const retained = createProactiveTraceStore(deps.db);
  let memory: UserMemoryStore | undefined; let notifier: NotificationBlock | undefined; let running: Promise<void> | undefined; let stopped = false;
  let records: RecordsStore | undefined;
  const candidates = new Map<string, { episode: EpisodeInput; for_on: string }>();
  const sourceAllowed = (context: SituationReadContext, ref: SituationRef, knownSphere?: Sphere): boolean => {
    const verb = situationSourceReadOp(ref.collection); const collection = ref.collection === 'mail_fact' ? 'mail' : ref.collection === 'history_trace' ? 'episode' : ref.collection;
    if (!verb || !context.grants.isVerbOpGranted(verb) || !context.grants.isCollectionReadGranted(collection)) return false;
    if (context.owner || context.all_spheres) return true;
    const sphere = context.referenceSphere?.(ref) ?? knownSphere ?? deps.sphere?.(ref);
    return sphere !== undefined && context.spheres?.includes(sphere) === true;
  };
  const excluded = (people: readonly string[]) => people.some(id => {
    const contact = deps.contacts?.getByContactIdResolved(id) ?? deps.contacts?.get(id); return !!contact && contactExcludedFromProactive(contact);
  });
  const people = (raw: unknown): string[] => (Array.isArray(raw) ? raw : []).flatMap(value => {
    if (typeof value !== 'string' || !value.trim() || value.length > 2000) return [];
    const contact = deps.contacts?.getByContactIdResolved(value) ?? deps.contacts?.get(value);
    return contact?.contact_id ? [contact.contact_id] : /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) ? [value] : [];
  });
  const safe = (episode: EpisodeInput): boolean => !episode.sensitive.length && !PRIVATE.test(`${episode.title} ${episode.notes ?? ''}`)
    && !excluded(episode.people) && !history.suppressed({ ...episode, id: episode.id ?? episodeCandidateId(episode.evidence) })
    && !episode.evidence.some(ref => history.suppressed({ ...episode, id: episodeCandidateId([ref]) }))
    && (episode.basis === 'declared' || episode.evidence.every(ref => ref.collection !== 'history_trace' || retained.get(ref.id) !== null))
    && episode.evidence.every(ref => ref.collection !== 'mail' || proposals.sourceEnabled(`mail:${ref.id.slice(0, ref.id.indexOf(':'))}`));
  const admission = (context: SituationReadContext, refs: readonly SituationRef[], sphere?: Sphere) => refs.every(ref => sourceAllowed(context, ref, sphere));
  const bound = async (count: number, signal?: AbortSignal) => { if (count > MAX_ROWS) throw new SituationScanBoundError('Episode source exceeds its scan bound'); await setImmediate(); signal?.throwIfAborted();
    if (stopped || !deps.isVaultUnlocked()) throw new Error('Episode reads wait for the unlocked vault'); };

  const factTraces = (fact: MailFact, state: unknown): ProactiveTrace[] => {
    if (fact.type !== 'purchase' || ['cancelled', 'returned', 'refund_issued'].includes(String(state))) return [];
    if (!proposals.sourceEnabled(`mail:${fact.email.slug}`) || fact.created_at <= proposals.setting('history.forget_through', -1)) return [];
    const data = object(fact.data); const merchant = string(fact.variables.merchant); if (!merchant || PRIVATE.test(`${merchant} ${string(data.category) ?? ''}`)) return [];
    const at = instant(fact.variables.ordered_at); if (at === undefined || at > now() || at <= proposals.setting('history.forget_through', -1)) return [];
    const items = Array.isArray(data.items) ? data.items : data.item ? [data.item] : [];
    return items.slice(0, 200).flatMap(raw => {
      const item = typeof raw === 'string' ? { name: raw } : object(raw); const name = string(item.name ?? item.description ?? item.title);
      if (!name || name.length > 300 || item.health === true || item.sensitive === true || PRIVATE.test(`${name} ${string(item.category) ?? ''} ${string(item.purpose) ?? ''}`)) return [];
      const category = string(item.category) ?? string(data.category) ?? '';
      const class_id = /\b(flowers?|bouquet|florist)\b/iu.test(`${name} ${category}`) ? 'flowers'
        : item.gift === true || /\bgift\b/iu.test(category) ? 'gifts'
        : /\b(restaurant|dining)\b/iu.test(category) ? 'restaurants' : 'activity';
      const sources = [{ collection: 'mail', id: `${fact.email.slug}:${fact.email.record_id}` }, { collection: 'mail_fact', id: fact.thing_id ?? fact.fact_id }];
      const location = string(item.location ?? data.location); const person = string(item.recipient_contact_id);
      const total = object(fact.variables.total); const amount = typeof total.amount === 'string' || typeof total.amount === 'number' ? String(total.amount) : undefined;
      const currency = string(total.currency); const sphere = deps.sphere?.(sources[0]! , `mail:${fact.email.slug}`);
      return [{ id: traceId(sources[1]!, hash([name, item.sku ?? null])), title: `${name} · ${merchant}${amount && currency ? ` · ${amount} ${currency}` : ''}`,
        when: { from: at, to: at + (typeof fact.variables.ordered_at === 'string' && fact.variables.ordered_at.length === 10 ? DAY - 1 : 0) },
        ...(location ? { where: history.place(location) } : {}), people: people(person ? [person] : item.people), subjects: [], sources,
        class_id, ...(sphere ? { sphere } : {}), observed_at: fact.created_at, source_mailbox: fact.email.slug }];
    });
  };
  const liveTraces = async (context: SituationReadContext, signal?: AbortSignal): Promise<ProactiveTrace[]> => {
    if (!deps.mailFacts || !context.grants.isVerbOpGranted('core.mail.fact.list') || !context.grants.isVerbOpGranted('core.data.mail.get') || !context.grants.isCollectionReadGranted('mail')) return [];
    const result: ProactiveTrace[] = []; let scanned = 0; let before: import('@recued/contracts').MailFactRowsCursor | undefined;
    for (;;) {
      const page = deps.mailFacts.listFactPage({ type: 'purchase', limit: 200, ...(before ? { before } : {}) });
      for (const email of page.emails) for (const fact of email.facts) {
        // The source's sphere is fenced before its item descriptions or place
        // labels enter classification or cross-source correlation.
        const ref = { collection: 'mail', id: `${fact.email.slug}:${fact.email.record_id}` };
        if (!sourceAllowed(context, ref, deps.sphere?.(ref, `mail:${fact.email.slug}`))) continue;
        const state = fact.thing_id ? deps.mailFacts.getThing(fact.thing_id)?.variables.state : fact.variables.state;
        for (const trace of factTraces(fact, state)) if (admission(context, trace.sources, trace.sphere) && !excluded(trace.people)) result.push(trace);
      }
      scanned += page.emails.length; await bound(scanned, signal); if (!page.more || !page.emails.length) break;
      const last = page.emails.at(-1)!; before = { email_at: last.email_at, slug: last.email.slug, record_id: last.email.record_id };
    }
    return [...new Map(result.map(trace => [trace.id, trace])).values()];
  };
  const collect = async (context: SituationReadContext, signal?: AbortSignal): Promise<{ plans: EpisodePlan[]; traces: ProactiveTrace[]; owners: EpisodeInput[] }> => {
    if (!deps.isVaultUnlocked()) throw new Error('Unlock Recued to assemble episodes');
    const plans: EpisodePlan[] = []; const traces = await liveTraces(context, signal); const owners: EpisodeInput[] = [];
    traces.push(...await arrivalTraces(context, signal));
    if (records && context.owner && context.grants.isVerbOpGranted('core.data.file.get') && context.grants.isCollectionReadGranted('file')) {
      const people = deps.photoFilePath && deps.contacts && context.grants.isVerbOpGranted('core.contact.resolve') && context.grants.isCollectionReadGranted('contact')
        ? { filePath: deps.photoFilePath, contact: (email: string) => { const row = deps.contacts!.get(email.trim().toLowerCase());
          return row && !contactExcludedFromProactive(row) ? row.contact_id ?? row.email : undefined; } } : undefined;
      for (const trace of readPhotoTraces(records, now(), people)) {
        if (trace.when.to <= proposals.setting('history.forget_through', -1)) continue;
        if (excluded(trace.people)) continue;
        const sphere = deps.sphere?.(trace.sources[0]!); if (admission(context, trace.sources, sphere)) traces.push({ ...trace, ...(sphere ? { sphere } : {}), ...(trace.where ? { where: history.place(trace.where.name) } : {}) });
      }
      await bound(traces.length, signal);
    }
    for (let cursor = ''; ;) {
      const page = retained.walk(cursor); if (!page.length) break;
      for (const trace of page) if (proposals.sourceEnabled(`mail:${trace.source_mailbox}`) && admission(context, trace.sources, trace.sphere) && !excluded(trace.people)) traces.push({ ...trace,
        ...(trace.where ? { where: history.place(trace.where.name) } : {}) });
      cursor = page.at(-1)!.id; await bound(traces.length, signal);
    }
    if (context.grants.isVerbOpGranted('core.data.calendar.list') && context.grants.isCollectionReadGranted('calendar')) {
      let scanned = 0;
      for (const calendar of deps.calendars()) for (let offset = 0; ; offset += 500) {
        const page = calendar.table.listSnapshots({ start_until: now(), order_by: 'start_at', limit: 500, offset });
        for (const row of page) {
          const ref = { collection: 'calendar', id: `${calendar.slug}:${row.record_id}` };
          const sphere = deps.sphere?.(ref, `calendar:${calendar.slug}:${row.hot.calendar_id}`);
          if (!sourceAllowed(context, ref, sphere) || row.hot.status === 'cancelled' || row.hot.is_recurring || row.event.recurrence_rule) continue;
          const when = eventSpanIn(row.hot, deps.timeZone()); if (when.end > now()) continue;
          plans.push({ ref, title: row.hot.summary, when: { from: when.start, to: when.end }, people: people(row.event.attendees?.filter(person => !person.is_self).map(person => person.email)),
            subjects: [], ...(row.hot.location ? { where: history.place(row.hot.location) } : {}), ...(sphere ? { sphere } : {}) });
        }
        scanned += page.length; await bound(scanned, signal); if (page.length < 500) break;
      }
    }
    if (context.grants.isVerbOpGranted('core.work-entity.read')) for (const kind of ['booking', 'commitment'] as const) {
      if (!context.grants.isCollectionReadGranted(kind)) continue;
      for (let offset = 0; ; offset += 500) {
        const page = deps.work.listByKind(kind, { offset, limit: 500, sync_states: ['live', 'stale_unreachable'] });
        for (const row of page) {
          const ref = { collection: kind, id: row.id }; const sphere = deps.sphere?.(ref, `work:${row.source_id}`);
          if (!sourceAllowed(context, ref, sphere)) continue;
          if (row._kind === 'booking' && row.lifecycle_state !== 'cancelled' && row.slot_start_at !== undefined && row.slot_end_at !== undefined && row.slot_end_at <= now()) {
            const location = string(row.source_extension_blob?.location);
            plans.push({ ref, title: row.title, when: { from: row.slot_start_at, to: row.slot_end_at }, subjects: [ref],
              people: people(row.counterparty_contact_id ? [row.counterparty_contact_id] : []), ...(location ? { where: history.place(location) } : {}), ...(sphere ? { sphere } : {}) });
          } else if (row._kind === 'commitment') {
            const when = row.lifecycle_state === 'fulfilled' ? row.lifecycle_changed_at : row.promised_for_at;
            if (when === undefined || when > now() || !['pending', 'fulfilled'].includes(row.lifecycle_state)) continue;
            const plan: EpisodePlan = { ref, title: row.statement, when: { from: when, to: when }, people: people(row.counterparty_contact_id ? [row.counterparty_contact_id] : []), subjects: [ref], ...(sphere ? { sphere } : {}) };
            plans.push(plan);
            if (row.lifecycle_state === 'fulfilled') traces.push({ id: traceId(ref, 'fulfilled'), title: `Completed: ${row.statement}`, when: plan.when, people: plan.people,
              subjects: [ref], sources: [ref], class_id: 'activity', observed_at: row.lifecycle_changed_at, ...(sphere ? { sphere } : {}) });
          }
        }
        await bound(offset + page.length, signal); if (page.length < 500) break;
      }
    }
    if (memory && context.grants.isVerbOpGranted('core.memory.read') && context.grants.isCollectionReadGranted('memory')) {
      let before: { ts: number; id: string } | undefined; let scanned = 0;
      for (;;) {
        const page = await memory.listWindow({ limit: 500, ...(before ? { before } : {}) });
        for (const row of page) {
          if (row.origin_actor !== 'user_self' || row.event_at === undefined || row.event_at > now()) continue;
          const ref = { collection: 'memory', id: row.memory_id }; const sphere = deps.sphere?.(ref);
          if (!sourceAllowed(context, ref, sphere)) continue;
          const title = row.summary ?? row.body_preview ?? row.body_inline?.slice(0, 300); if (!title) continue;
          const refs = row.provenance_entity_ids?.flatMap(value => { const colon = value.indexOf(':'); return colon < 1 ? [] : [{ collection: value.slice(0, colon), id: value.slice(colon + 1) }]; }) ?? [];
          owners.push({ id: episodeCandidateId([ref]), title, when: { from: row.event_at, to: row.event_at }, people: refs.filter(ref => ref.collection === 'contact').map(ref => ref.id),
            subjects: refs, evidence: [ref], basis: 'declared', sensitive: [], storage_reason: 'owner_record', assembly_rule: 'owner_record.v1', ...(sphere ? { sphere } : {}) });
        }
        scanned += page.length; await bound(scanned, signal); if (page.length < 500) break;
        const row = page.at(-1)!; before = { ts: row.event_at ?? row.ts, id: row.memory_id };
      }
    }
    return { plans, traces: [...new Map(traces.map(trace => [trace.id, trace])).values()], owners };
  };
  const arrivalTraces = async (context: SituationReadContext, signal?: AbortSignal, mailbox?: string): Promise<ProactiveTrace[]> => {
    if (!context.owner || !context.grants.isVerbOpGranted('core.data.mail.get') || !context.grants.isCollectionReadGranted('mail')) return [];
    const result: ProactiveTrace[] = []; let scanned = 0;
    for (const source of deps.mailboxes?.() ?? []) {
      if (mailbox && source.slug !== mailbox || !proposals.sourceEnabled(`mail:${source.slug}`)) continue;
      let cursor = '';
      for (;;) {
        const page = source.table.bodyEvidencePage?.({ expression: '"checked in" OR "arrived at"', after: cursor, limit: 500 }) ?? [];
        for (const row of page) {
          const ref = { collection: 'mail', id: `${source.slug}:${row.record_id}` }; const sphere = deps.sphere?.(ref, `mail:${source.slug}`);
          if (!sourceAllowed(context, ref, sphere)) continue;
          const trace = arrivalTrace(source.slug, row, now());
          if (trace && !PRIVATE.test(trace.title) && trace.when.to > proposals.setting('history.forget_through', -1)) result.push({ ...trace, where: history.place(trace.where!.name), ...(sphere ? { sphere } : {}) });
        }
        scanned += page.length; await bound(scanned, signal); if (page.length < 500) break;
        cursor = page.at(-1)!.record_id;
      }
    }
    return result;
  };
  const derive = async (context: SituationReadContext, signal?: AbortSignal): Promise<EpisodeInput[]> => {
    const epoch = proposals.setting('history.epoch', 0);
    const data = await collect(context, signal);
    if (proposals.setting('history.epoch', 0) !== epoch) return [];
    // People link a plan to a trace, so the contact fence applies before assembly:
    // a contact this context may not read must not join two records into one.
    const fence = <T extends { people: string[] }>(value: T): T => ({ ...value, people: value.people.filter(id => sourceAllowed(context, { collection: 'contact', id })) });
    const result = assembleEpisodes(data.plans.filter(plan => admission(context, [plan.ref], plan.sphere)).map(fence),
      data.traces.filter(trace => admission(context, trace.sources, trace.sphere)).map(fence),
      data.owners.filter(episode => admission(context, episode.evidence, episode.sphere)).map(fence), now()).filter(safe);
    const stored: Episode[] = []; for (let offset = 0; ; offset += 500) { const page = history.episodes(500, offset); stored.push(...page); if (page.length < 500) break; }
    for (const raw of stored) {
      const episode = { ...raw, ...(raw.where ? { where: history.place(raw.where.name) } : {}) };
      if (!safe(episode)) continue;
      if (episode.basis !== 'declared' && episode.evidence.some(ref => ref.collection === 'history_trace' && !retained.get(ref.id))) continue;
      const sources = episode.evidence.flatMap(ref => ref.collection === 'history_trace' ? retained.get(ref.id)?.sources ?? [ref] : [ref]);
      if (!admission(context, sources, episode.sphere)) continue;
      const index = result.findIndex(value => value.id === episode.id); if (index >= 0) result[index] = episode; else result.push(episode);
    }
    return result.sort((a, b) => b.when.from - a.when.from || (a.id ?? '').localeCompare(b.id ?? ''));
  };
  const classBars = () => deps.situations.readSetting<Record<string, number>>('recall.class_bars', {});
  const recallChoice = () => deps.situations.readSetting<'on' | 'off' | 'unasked'>('last_time.choice', 'unasked');
  const qualified = () => history.darkRates().filter(row => row.scored >= 5 && Object.hasOwn(classBars(), row.class_id) && row.rate >= classBars()[row.class_id]!
    && proposals.allows({ kind: 'recall', payload: { proposal_class: `recall:${row.class_id}` } }));
  const readSource: SituationSource['read'] = async (query, signal, context) => {
    if (!context || query.surface === 'prefetch') return [];
    const window = typeof query.time === 'number' ? { from: query.time, to: query.time } : query.time;
    const recall = query.surface === 'digest' && query.include_last_time === true && context.last_time_opted_in === true
      && recallChoice() === 'on';
    if (!recall && (query.surface !== 'tool' || window.to > now())) return [];
    const episodes = await derive(context, signal); const accepted = new Set(qualified().map(row => row.class_id));
    const anchored = (episode: EpisodeInput) => Boolean(query.place && episode.where?.key === query.place.key || query.people?.some(person => episode.people.includes(person))
      || query.subjects?.some(ref => episode.occasion_id && ref.collection === 'occasion' && ref.id === episode.occasion_id || episode.subjects.some(subject => refKey(subject) === refKey(ref))));
    const selected = recall ? episodes.filter(episode => episode.class_id && accepted.has(episode.class_id) && anchored(episode)) : episodes;
    const mostRecent = new Map<string, EpisodeInput>();
    for (const episode of selected) if (episode.class_id && !mostRecent.has(episode.class_id)) mostRecent.set(episode.class_id, episode);
    const result: SituationFact[] = [];
    for (const episode of selected) {
      const year = new Date(window.from).getUTCFullYear(); const comparison = { from: shifted(episode.when.from, year), to: shifted(episode.when.to, year) };
      const anniversaryNear = comparison.from <= window.to + 14 * DAY && comparison.to >= window.from - 14 * DAY;
      if (recall && !anniversaryNear && mostRecent.get(episode.class_id!) !== episode) continue;
      const id = episode.id ?? episodeCandidateId(episode.evidence);
      const on = assetDateAt(window.from, deps.timeZone()); candidates.set(id, { episode: { ...episode, id }, for_on: on });
      while (candidates.size > MAX_ROWS) candidates.delete(candidates.keys().next().value!);
      result.push({ ref: { collection: 'episode', id }, title: recall ? `Would you like to repeat this? Last time: ${episode.notes ?? episode.title}` : episode.title,
        kind: 'episode', basis: recall ? 'inferred' : episode.basis, when: episode.when,
        ...(recall ? { last_time: true, last_time_comparison: comparison } : {}),
        people: episode.people, subjects: episode.subjects, related: episode.occasion_id ? [{ collection: 'occasion', id: episode.occasion_id }] : [],
        ...(episode.where ? { place: episode.where } : {}), evidence: episode.evidence, consequence: 'routine', ...(episode.sphere ? { sphere: episode.sphere } : {}),
        updated_at: 'updated_at' in episode && typeof episode.updated_at === 'number' ? episode.updated_at : episode.when.to });
    }
    return result;
  };
  const requestOptIn = async (): Promise<void> => {
    if (!notifier) return;
    let delivery = deps.situations.readSetting<AskDeliveryInput | null>('recall.opt_in_ask', null);
    if (!qualified().length || recallChoice() !== 'unasked') {
      for (const request of delivery?.asks ?? []) if ((await notifier.getAsk(request.ask_id!))?.status === 'open') await notifier.cancelAsk(request.ask_id!);
      return;
    }
    if (!delivery) {
      delivery = { group_id: randomUUID(), destinations: [{ id: 'owner:ui', channel: 'ui' }], asks: [{ ask_id: mintAskId(),
        message: { title: 'Allow “last time” offers?', text: 'Some offers drawn from what you did before, such as flowers before a yearly trip, have proved useful on your own records at the rate you accepted. Allow them in your overview? People, places and dates you excluded stay out. You can change this later in Settings → Privacy.' },
        ui_link_url: '#yours/episodes', options: [{ id: 'on', label: 'Allow in my overview' }, { id: 'off', label: 'No thanks' }],
        handler: { kind: 'situation-last-time-opt-in', payload: {} } }] };
      deps.situations.writeSetting('recall.opt_in_ask', delivery);
    }
    await notifier.askBundle(delivery);
  };
  /** An open recall offer is this runtime's to withdraw: when its episode goes or
   * is suppressed, when recall is switched off, and once its date (`on`, the day of
   * the situation it was offered with) is over in the owner's zone, since accepting
   * refuses a past date. A withdrawn offer is not made again that year. */
  const refreshSuppressed = (): void => {
    const today = assetDateAt(now(), deps.timeZone());
    for (let offset = 0; ;) {
      const page = proposals.list({ state: 'proposed', kind: 'recall', limit: 500, offset }); if (!page.length) break;
      let removed = 0;
      for (const proposal of page) { const episode = typeof proposal.payload.episode_id === 'string' ? history.episode(proposal.payload.episode_id) : null;
        const lapsed = isAssetDate(proposal.payload.on) && proposal.payload.on < today;
        if (!episode || !safe(episode) || lapsed || proposal.origin === 'learner' && recallChoice() !== 'on' || !proposals.allows(proposal)) { proposals.outcome(proposal.id, 'retracted', now()); removed++; } }
      offset += page.length - removed;
    }
  };
  const tickOnce = async (): Promise<void> => {
    if (stopped || !deps.isVaultUnlocked()) return;
    // Hourly too, so an offer past its date leaves even when nobody opens Yours.
    refreshSuppressed();
    const epoch = proposals.setting('history.epoch', 0);
    const episodes = await derive(ownerContext); const data = await collect(ownerContext); const at = now(); const year = new Date(at).getUTCFullYear();
    if (proposals.setting('history.epoch', 0) !== epoch) return;
    for (const episode of episodes) {
      if (!episode.class_id || !RECALL_CLASSES.includes(episode.class_id as typeof RECALL_CLASSES[number]) || !episode.where && !episode.people.length && !episode.occasion_id) continue;
      if (new Date(episode.when.to).getUTCFullYear() >= year) continue;
      const target = shifted(episode.when.from, year); const window = { from: target - 7 * DAY, to: target + 7 * DAY };
      if (at < window.from || at > window.to) continue;
      const anchor = episode.occasion_id ? ['occasion', episode.occasion_id] : episode.people.length ? ['people', [...episode.people].sort()] : ['place', episode.where!.key];
      history.darkCandidate({ id: `dark-${hash([anchor, year, new Date(target).getUTCMonth(), episode.class_id])}`, class_id: episode.class_id, episode, window }, at);
    }
    for (let cursor = ''; ;) {
      const page = history.darkPending(cursor, 500); if (!page.length) break;
      for (const candidate of page) {
      if (!safe(candidate.episode)) continue;
      const created_at = (deps.db.prepare('SELECT at FROM proactive_dark_candidates WHERE id=?').get(candidate.id) as { at: number }).at;
      const evidence = data.traces.find(trace => trace.class_id === candidate.class_id && trace.observed_at > created_at
        && trace.when.from <= candidate.window.to && trace.when.to >= candidate.window.from && sameSubject(candidate.episode, trace)
        && !deps.db.prepare('SELECT 1 FROM proactive_dark_candidates WHERE class_id=? AND relevant=1 AND evidence=?').get(candidate.class_id, JSON.stringify(trace.sources[0])));
      if (evidence) history.scoreDarkCandidate(candidate.id, true, evidence.sources[0]!, at);
      else if (candidate.window.to < at) history.scoreDarkCandidate(candidate.id, false, null, at);
      }
      cursor = page.at(-1)!.id;
    }
    await requestOptIn();
  };
  return {
    source: { id: 'episode', collection: 'episode', verb_op: 'core.situation.read', read: readSource } satisfies SituationSource,
    referenceSphere: (ref: SituationRef): Sphere | undefined => {
      const value = ref.collection === 'history_trace' ? retained.get(ref.id) : ref.collection === 'episode' ? candidates.get(ref.id)?.episode : undefined;
      if (!value?.sphere) return undefined;
      const refs = 'sources' in value ? value.sources : value.evidence.flatMap(ref => ref.collection === 'history_trace' ? retained.get(ref.id)?.sources ?? [ref] : [ref]);
      return refs.every(source => source.collection !== 'episode' && source.collection !== 'history_trace' && deps.sphere?.(source) === value.sphere) ? value.sphere : undefined;
    },
    derive,
    ownerEpisodes: () => derive(ownerContext),
    bindRecords(value: RecordsStore): void { records = value; },
    bindMemory(value: UserMemoryStore | undefined) { memory = value; },
    bindNotifier(value: NotificationBlock) { notifier = value; value.registerAskHandler('situation-last-time-opt-in', async (_payload, answer) => {
      if (!['on', 'off'].includes(answer.option)) throw new Error('Choose a last-time preference');
      // Asked once: an answer counts only while the question stands. A choice made in
      // Settings or Episodes meanwhile settled it, and a late answer must not undo it.
      if (recallChoice() === 'unasked') deps.situations.writeSetting('last_time.choice', answer.option);
    }); },
    /** §15.7 — a choice made outside the question settles it at once: the open ask is
     * withdrawn and learner offers follow, instead of at the next hourly pass. */
    async settleChoice(): Promise<void> { refreshSuppressed(); await requestOptIn(); },
    /** The once-only question is waiting in the bell. */
    async optInOpen(): Promise<boolean> {
      const delivery = deps.situations.readSetting<AskDeliveryInput | null>('recall.opt_in_ask', null);
      for (const request of notifier ? delivery?.asks ?? [] : []) if ((await notifier!.getAsk(request.ask_id!))?.status === 'open') return true;
      return false;
    },
    tick() { return running ??= tickOnce().finally(() => { running = undefined; }); },
    async stop() { stopped = true; await running; },
    async captureBeforeRetention(mailbox: string, cutoff: number): Promise<void> {
      if (stopped || !deps.isVaultUnlocked()) throw new Error('History capture waits for the unlocked vault before retention');
      const epoch = proposals.setting('history.epoch', 0); const captured = new Set<string>();
      if (deps.mailFacts && proposals.sourceEnabled(`mail:${mailbox}`)) for (let cursor: string | null = null; ;) {
        const page = deps.mailFacts.emailIdsOf(mailbox, cursor, 500); if (!page.length) break;
        deps.db.transaction(() => {
          for (const id of page) for (const fact of deps.mailFacts!.factsForEmail({ slug: mailbox, record_id: id })) {
            const state = fact.thing_id ? deps.mailFacts!.getThing(fact.thing_id)?.variables.state : fact.variables.state;
            for (const trace of factTraces(fact, state)) {
              if (!RECALL_CLASSES.includes(trace.class_id as typeof RECALL_CLASSES[number]) || trace.when.to >= cutoff || excluded(trace.people)
                || history.suppressed({ id: episodeCandidateId([{ collection: 'history_trace', id: trace.id }]), when: trace.when, people: trace.people, where: trace.where, class_id: trace.class_id })) continue;
              retained.save(trace, now()); captured.add(trace.id);
            }
          }
        })();
        cursor = page.at(-1)!; await setImmediate();
        if (stopped || !deps.isVaultUnlocked() || proposals.setting('history.epoch', 0) !== epoch) throw new Error('History capture changed before retention; retry the prune');
      }
      for (const trace of await arrivalTraces(ownerContext, undefined, mailbox)) {
        if (trace.when.to >= cutoff || history.suppressed({ id: episodeCandidateId([{ collection: 'history_trace', id: trace.id }]), when: trace.when, people: trace.people, where: trace.where, class_id: trace.class_id })) continue;
        retained.save(trace, now()); captured.add(trace.id);
      }
      if (stopped || !deps.isVaultUnlocked() || proposals.setting('history.epoch', 0) !== epoch) throw new Error('History capture changed before retention; retry the prune');
      retained.recordCapture(mailbox, cutoff, now(), captured.size);
    },
    retainCited(clusters: readonly SituationCluster[]): void {
      for (const item of clusters.flatMap(cluster => cluster.items)) {
        if (item.ref.collection !== 'episode' || !item.reasons.includes('last_time')) continue;
        const candidate = candidates.get(item.ref.id); if (!candidate || !safe(candidate.episode)) continue;
        if (recallChoice() !== 'on' || !qualified().some(row => row.class_id === candidate.episode.class_id)) continue;
        const episode = history.episode(item.ref.id) ?? history.saveEpisode({ ...candidate.episode, storage_reason: 'proposal_citation' }, now());
        const payload = { episode_id: episode.id, on: candidate.for_on, statement: `Repeat: ${episode.notes ?? episode.title}`, proposal_class: `recall:${episode.class_id}` };
        if (!proposals.allows({ kind: 'recall', payload })) continue;
        proposals.ensure({ key: recallOfferKey(episode.id, candidate.for_on), kind: 'recall', title: item.what.value ?? episode.title,
          explanation: 'An offer from your recorded precedent. Accept creates a task for you; it performs no purchase or message.', payload,
          sources: [{ collection: 'episode', id: episode.id }, ...episode.evidence], subject: { collection: 'episode', id: episode.id }, confidence: 'low', origin: 'learner' }, now());
      }
    },
    setClassBar(class_id: string, minimum_rate: number): void {
      if (!RECALL_CLASSES.includes(class_id as typeof RECALL_CLASSES[number]) || !Number.isFinite(minimum_rate) || minimum_rate < 0 || minimum_rate > 1) throw new Error('Choose a recall class and a rate from zero to one');
      const rate = history.darkRates().find(row => row.class_id === class_id); if (!rate || rate.scored < 5) throw new Error('At least five actual scored candidates are required');
      deps.situations.writeSetting('recall.class_bars', { ...classBars(), [class_id]: minimum_rate });
    },
    rates: () => history.darkRates().map(row => ({ ...row, minimum_rate: classBars()[row.class_id] ?? null, qualified: qualified().some(value => value.class_id === row.class_id) })),
    memoryAllowed: (cluster: SituationCluster): boolean => {
      const refs = [...cluster.subjects, ...cluster.items.flatMap(item => [item.ref, ...item.evidence, ...item.what.evidence, ...item.when.evidence, ...item.where.evidence, ...item.who.evidence])];
      if (cluster.items.some(item => item.kind === 'proposal') && refs.some(ref => ref.collection === 'episode') && recallChoice() !== 'on') return false;
      return refs.filter(ref => ref.collection === 'occasion').every(ref => {
      const occasion = history.occasion(ref.id); return !!occasion && occasion.source_active !== false && !excluded(occasion.people)
        && !history.suppressed({ ...occasion, when: cluster.span ?? { from: now(), to: now() } });
      }) && refs.filter(ref => ref.collection === 'episode').every(ref => { const episode = history.episode(ref.id) ?? candidates.get(ref.id)?.episode; return !!episode && safe(episode); })
      && cluster.items.every(item => item.kind !== 'episode' || (() => {
      const episode = history.episode(item.ref.id) ?? candidates.get(item.ref.id)?.episode;
      return !!episode && safe(episode) && (!item.reasons.includes('last_time') || recallChoice() === 'on' && qualified().some(row => row.class_id === episode.class_id));
      })());
    },
    episodeAllowed: (id: string): boolean => { const episode = history.episode(id) ?? candidates.get(id)?.episode; return !!episode && safe(episode); },
    episodeInputAllowed: (episode: EpisodeInput): boolean => safe(episode) && admission(ownerContext, episode.evidence, episode.sphere),
    refreshSuppressed,
    traces: (limit = 100) => { const result: ProactiveTrace[] = []; for (let cursor = ''; result.length < limit;) { const page = retained.walk(cursor, Math.min(500, limit - result.length)); if (!page.length) break; result.push(...page); cursor = page.at(-1)!.id; } return result; },
    receipts: retained.receipts,
    trace: retained.get,
    forgetSource(mailbox: string): void { retained.forgetSource(mailbox); proposals.setSource(`mail:${mailbox}`, false); proposals.setSetting('history.epoch', proposals.setting('history.epoch', 0) + 1); },
    forget(): void {
      deps.db.transaction(() => { retained.forget(); candidates.clear(); history.forgetDark(); proposals.setSetting('history.forget_through', now()); proposals.setSetting('history.epoch', proposals.setting('history.epoch', 0) + 1);
        // §4.9 — every recall offer not accepted leaves with its "Last time" text,
        // from the outbox and the situation log too.
        for (let offset = 0; ;) { const page = proposals.list({ kind: 'recall', limit: 500, offset }); if (!page.length) break;
          for (const proposal of page) {
            // An offer that stays (accepted, or not removed) is stepped over, never re-read.
            if (proposal.state === 'accepted' || !proposals.forget(proposal.id, now())) { offset++; continue; }
            deps.situations.forget(`proposal:${proposal.id}`);
          } }
        for (let offset = 0; ;) { const page = history.episodes(500, offset); if (!page.length) break;
          const remove = page.filter(row => row.storage_reason === 'proposal_citation'); for (const row of remove) history.deleteEpisode(row.id, now(), false);
          offset += page.length - remove.length; }
      })();
    },
  };
};
export type EpisodeRuntime = ReturnType<typeof createEpisodeRuntime>;
