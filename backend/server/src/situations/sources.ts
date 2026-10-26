import { setImmediate } from 'node:timers/promises';
import {
  assetDateAt, calendarDayMs, dueSpan, eventSpanIn, evaluateAssetRuleClock, getMailFactBuiltinType, nextAnnualDate, occasionNextDate, isDateOnlyDue, contactExcludedFromProactive, isContactAnnualDate,
  shiftAssetDate, type Asset, type ContactRecord, type MailFactThing, type Occasion, type SituationFact, type SituationPlace, type SituationQuery, type SituationRef, type Sphere,
  type WorkEntity,
} from '@recued/contracts';
import { ASSET_TABLE, BOOKING_TABLE, COMMITMENT_TABLE, NOTE_TABLE, TASK_TABLE, type WorkEntityStore } from '../storage/work-entity-store.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { createAssetClockStore } from '../storage/asset-clock-store.js';
import type { ReminderStore } from '../storage/reminder-store.js';
import type { MailFactStore } from '../storage/mail-fact-store.js';
import type { ContactStore } from '../storage/contact-store.js';
import type { CalendarCollectionTable, CalendarRowSnapshot } from '../collections/calendar/calendar-table.js';
import type Database from 'better-sqlite3';
import { SituationScanBoundError, situationText, type SituationSource, type SituationSourceIndex } from './query.js';
import { situationSourceReadOp } from './event-visibility.js';
import { createTripDetailsStore, tripFromSource } from '../storage/trip-details-store.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { declaredOccasionId } from './declared-occasions.js';
import { assetRuleTimings, isTravelDocument, isVisa } from './asset-rule-timing.js';
import { situationAssetDetails } from './asset-details.js';
import { rememberAssetDetailsRead } from './asset-projection-provenance.js';
import { placeCountry } from './country-place.js';
import { ruleStatement } from './rule-titles.js';
import { ASSET_SEARCH_TERMS } from '@recued/contracts';
import { assetSearchTermsFromJson, readAssetTypeSearchTerms } from '../asset-search-terms.js';

const PAGE = 500;
const DATED: Record<string, string> = { bill: 'due_at', statement: 'due_at', shipment: 'expected_at', reservation: 'starts_at' };
const BOUND = 20_000;
const DAY = 86_400_000;
const tagged = <K extends WorkEntity['_kind'], T>(kind: K, row: T | null): (T & { _kind: K }) | null => row ? { _kind: kind, ...row } : null;
const fact = (ref: SituationRef, title: string, kind: string, updated_at: number): SituationFact => ({
  ref, title, kind, updated_at, basis: 'declared', people: [], subjects: [], related: [],
  evidence: [{ ...ref }], consequence: 'routine',
});
const timeOf = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return calendarDayMs(value) ?? undefined;
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(value) || calendarDayMs(value.slice(0, 10)) === null) return undefined;
  const at = Date.parse(value); return Number.isFinite(at) ? at : undefined;
};
export interface SituationSourcesDeps {
  db: Database.Database;
  work: WorkEntityStore;
  reminders: ReminderStore;
  mailFacts?: MailFactStore;
  contacts?: ContactStore;
  calendars: () => ReadonlyArray<{ slug: string; table: Pick<CalendarCollectionTable, 'listSnapshots' | 'getByRecordId' | 'situationLines'> }>;
  timeZone: () => string;
  now?: () => number;
  /** A resolved place identity from the owner's aliases or a geocoder; the
   * fallback is an exact normalized label, never an invented city. */
  place?: (value: string) => SituationPlace | undefined;
  sphere?: (ref: SituationRef, source_key: string) => Sphere | undefined;
}
export const buildSituationSources = (deps: SituationSourcesDeps): SituationSource[] => {
  const now = deps.now ?? Date.now;
  const occurrences = createAssetOccurrenceStore(deps.db);
  const clocks = createAssetClockStore(deps.db);
  const trips = createTripDetailsStore(deps.db);
  const proposals = createProactiveProposalStore(deps.db);
  const history = createProactiveHistoryStore(deps.db, proposals);
  const place = (value: string | undefined): SituationPlace | undefined => value?.trim()
    ? deps.place?.(value) ?? { key: `label:${value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en')}`, name: value.trim() } : undefined;
  const scope = (item: SituationFact, source_key: string, own?: Sphere): SituationFact => {
    const sphere = deps.sphere?.(item.ref, source_key) ?? own; return sphere ? { ...item, sphere } : item;
  };
  const span = (date: number) => { const due = dueSpan(date, deps.timeZone()); return { from: due.start, to: due.end }; };
  // §6.3 — a place names an item by its resolved key, or a chat message by the
  // resolved name's every word. Each distinct label resolves once per read.
  const placeNamed = (query: SituationQuery): ((label: unknown) => boolean) | null => {
    const mentions = query.surface === 'prefetch' && Boolean(query.text?.trim());
    if (!query.place && !mentions) return null;
    const text = situationText(query); const seen = new Map<string, boolean>();
    return label => {
      if (typeof label !== 'string' || !label.trim()) return false;
      let hit = seen.get(label);
      if (hit === undefined) { const resolved = place(label)!; hit = query.place?.key === resolved.key || mentions && text.place(resolved.name); seen.set(label, hit); }
      return hit;
    };
  };
  const check = async (count: number, signal?: AbortSignal): Promise<void> => {
    if (count > BOUND) throw new SituationScanBoundError('Situation source exceeds its scan bound');
    await setImmediate(); signal?.throwIfAborted();
  };
  // Only open rows are read: a long history of done tasks or closed obligations
  // never counts against the bound, and the facts below drop them anyway.
  const OPEN = { task: { task_filter: { completion: 'open', due: { kind: 'all' }, sort: 'default' } },
    commitment: { commitment_lifecycle_states: ['pending'] }, booking: { booking_lifecycle_states: ['pending', 'confirmed'] }, note: {} } as const;
  const rowsOf = async (kind: 'task' | 'note' | 'commitment' | 'booking', signal?: AbortSignal): Promise<WorkEntity[]> => {
    const rows: WorkEntity[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = deps.work.listByKind(kind, { limit: PAGE, offset, sync_states: ['live', 'stale_unreachable'], ...OPEN[kind] });
      rows.push(...page); await check(rows.length, signal); if (page.length < PAGE) break;
    }
    return rows;
  };
  const source = (collection: string, read: SituationSource['read'], grant_collection?: string): SituationSource => ({
    id: collection, collection, verb_op: situationSourceReadOp(collection)!, ...(grant_collection ? { grant_collection } : {}), read,
  });
  const workFacts = (rows: WorkEntity[], query: SituationQuery): SituationFact[] => {
    // Only commitments carry questions, so the other work sources skip the read.
    const questions = new Set(rows.some(row => row._kind === 'commitment') ? occurrences.questionCommitments() : []);
    // Read once for the rows, when an occasion's commitment first needs them.
    let suppressions: ReturnType<typeof proposals.suppressions> | undefined;
    return rows.flatMap(row => {
      const ref = { collection: row._kind, id: row.id };
      let item: SituationFact;
      if (row._kind === 'task') {
        if (row.done) return [];
        item = fact(ref, row.title, 'task', row.updated_at);
        if (row.due_at !== undefined) { item.when = span(row.due_at); item.act_by = item.when.from; if (isDateOnlyDue(row.due_at)) item.when_day = assetDateAt(row.due_at, 'UTC'); }
        if (row.parent_project_id) item.subjects.push({ collection: 'project', id: row.parent_project_id });
        if (row.assigned_contact_id) item.people.push(row.assigned_contact_id);
      } else if (row._kind === 'commitment') {
        if (row.lifecycle_state !== 'pending') return [];
        const occurrenceId = row.source_extension_blob?.occurrence_id;
        const occurrence = typeof occurrenceId === 'string' ? occurrences.get(occurrenceId) : null;
        if (occurrence?.subject_kind === 'occasion') {
          const occasion = history.occasion(occurrence.asset_id); const date = calendarDayMs(occurrence.cycle);
          if (!occasion || date === null || occasion.source_active === false || occasion.people.some(id => {
            const contact = deps.contacts?.getByContactIdResolved(id) ?? deps.contacts?.get(id); return contact && contactExcludedFromProactive(contact);
          }) || history.suppressed({ ...occasion, when: span(date) }, suppressions ??= proposals.suppressions())) return [];
        }
        if (questions.has(row.id) && ['today', 'digest', 'push'].includes(query.surface ?? 'tool')) return [];
        item = fact(ref, row.statement, 'commitment', row.updated_at);
        if (row.promised_for_at !== undefined) { item.when = span(row.promised_for_at); item.act_by = item.when.from; if (isDateOnlyDue(row.promised_for_at)) item.when_day = assetDateAt(row.promised_for_at, 'UTC'); }
        if (questions.has(row.id)) { item.missing = true; item.act_by = row.created_at; }
        if (row.counterparty_contact_id) item.people.push(row.counterparty_contact_id);
      } else if (row._kind === 'booking') {
        if (!['pending', 'confirmed'].includes(row.lifecycle_state)) return [];
        item = fact(ref, row.title, 'booking', row.updated_at);
        if (row.slot_start_at !== undefined && row.slot_end_at !== undefined) {
          item.when = { from: row.slot_start_at, to: row.slot_end_at }; item.act_by = row.slot_start_at; item.valid_until = row.slot_end_at;
        }
        if (row.counterparty_contact_id) item.people.push(row.counterparty_contact_id);
        item.trip = trips.get(ref) ?? tripFromSource(ref, row.source_extension_blob);
        if (item.trip?.travellers.length) item.people = item.trip.travellers;
      } else if (row._kind === 'note') {
        item = fact(ref, row.title ?? row.body.slice(0, 200), 'note', row.updated_at);
        item.people = [...row.related_contact_ids];
        item.related = row.related_project_ids.map(id => ({ collection: 'project', id }));
      } else return [];
      return [scope(item, `work:${row.source_id}`)];
    });
  };
  // §6.3 — open rows by id, through the same filters as the pages above.
  type WorkKind = 'task' | 'note' | 'commitment' | 'booking';
  const LIVE = `deleted_at IS NULL AND sync_state IN ('live','stale_unreachable')`;
  const OPEN_SQL: Record<WorkKind, string> = { task: `done=0 AND ${LIVE}`, note: LIVE,
    commitment: `lifecycle_state='pending' AND ${LIVE}`, booking: `lifecycle_state IN ('pending','confirmed') AND ${LIVE}` };
  const TABLE: Record<WorkKind, string> = { task: TASK_TABLE, note: NOTE_TABLE, commitment: COMMITMENT_TABLE, booking: BOOKING_TABLE };
  const openIds = (kind: WorkKind, where: string, ...params: unknown[]): string[] =>
    (deps.db.prepare(`SELECT id FROM ${TABLE[kind]} WHERE ${OPEN_SQL[kind]} AND (${where})`).all(...params) as { id: string }[]).map(row => row.id);
  const readOpen = (kind: WorkKind, id: string): WorkEntity | null => {
    const row: WorkEntity | null = kind === 'task' ? tagged('task', deps.work.readTask(id)) : kind === 'note' ? tagged('note', deps.work.readNote(id))
      : kind === 'commitment' ? tagged('commitment', deps.work.readCommitment(id)) : tagged('booking', deps.work.readBooking(id));
    if (!row || row.deleted_at != null || !['live', 'stale_unreachable'].includes(row.sync_state)) return null;
    if (row._kind === 'task' && row.done || row._kind === 'commitment' && row.lifecycle_state !== 'pending'
      || row._kind === 'booking' && !['pending', 'confirmed'].includes(row.lifecycle_state)) return null;
    return row;
  };
  const ids = (refs: readonly SituationRef[], collection: string): string => JSON.stringify([...new Set(refs.filter(ref => ref.collection === collection).map(ref => ref.id))]);
  const IN = (column: string) => `${column} IN (SELECT value FROM json_each(?))`;
  const TITLE: Record<WorkKind, string> = { task: 'title', note: 'title,substr(body,1,200) AS head', commitment: 'statement AS title', booking: 'title' };
  const titled = (kind: WorkKind, query: SituationQuery): string[] => {
    if (!query.text?.trim()) return [];
    const text = situationText(query);
    return (deps.db.prepare(`SELECT id,${TITLE[kind]} FROM ${TABLE[kind]} WHERE ${OPEN_SQL[kind]}`).all() as Array<{ id: string; title: string | null; head?: string | null }>)
      .filter(row => text.title(row.title ?? (kind === 'note' ? (row.head ?? '').slice(0, 200) : ''))).map(row => row.id);
  };
  const workIndex = (kind: WorkKind): SituationSourceIndex => ({
    seed: (query, people) => {
      const window = typeof query.time === 'number' ? { from: query.time, to: query.time } : query.time;
      const persons = JSON.stringify([...people]);
      const found = new Set([...(query.subjects ?? []).filter(ref => ref.collection === kind).map(ref => ref.id), ...titled(kind, query)]);
      const add = (where: string, ...params: unknown[]): void => { for (const id of openIds(kind, where, ...params)) found.add(id); };
      if (query.changed_since !== undefined) add('updated_at>?', query.changed_since);
      // A day's due starts at local midnight, up to a day from its stored instant.
      // A chat message keeps only what it names, so it seeds nothing by date.
      const timed = query.surface !== 'prefetch';
      if (kind === 'task') { if (timed) add('due_at<=?', window.to + DAY); add(IN('assigned_contact_id'), persons); add(IN('parent_project_id'), ids(query.subjects ?? [], 'project')); }
      else if (kind === 'note') add(`EXISTS (SELECT 1 FROM json_each(related_contact_ids) WHERE ${IN('value')})`, persons);
      else if (kind === 'commitment') {
        add(IN('counterparty_contact_id'), persons);
        if (timed) { add('promised_for_at<=?', window.to + DAY); for (const id of occurrences.questionCommitments()) found.add(id); }
      } else { if (timed) add('slot_start_at<=?', window.to); add(IN('counterparty_contact_id'), persons); }
      return found;
    },
    find: ({ refs, subjects, related }) => {
      const found = new Set(refs.filter(ref => ref.collection === kind).map(ref => ref.id));
      if (kind === 'task') for (const id of openIds(kind, IN('parent_project_id'), ids(subjects, 'project'))) found.add(id);
      if (kind === 'note') for (const id of openIds(kind, `EXISTS (SELECT 1 FROM json_each(related_project_ids) WHERE ${IN('value')})`, ids(related, 'project'))) found.add(id);
      return found;
    },
    // A booking is a trip by its own fields (`tripFromSource`) or by details the owner gave.
    ...(kind === 'booking' ? { relations: () => [...trips.subjects('booking'), ...openIds(kind, `CASE WHEN json_valid(source_extension_blob) THEN
      json_type(source_extension_blob,'$.trip') IS NOT NULL OR json_type(source_extension_blob,'$.destination_country') IS NOT NULL
      OR json_extract(source_extension_blob,'$.is_trip')=1 OR json_extract(source_extension_blob,'$.kind') IN ('lodging','transport')
      OR (json_extract(source_extension_blob,'$.fact_type')='reservation' AND json_extract(source_extension_blob,'$.reservation_kind') IN ('lodging','transport'))
      ELSE 0 END`)] } : {}),
  });
  const sources: SituationSource[] = (['task', 'note', 'commitment', 'booking'] as const).map(kind => ({
    ...source(kind, async (query, signal, _context, only) => workFacts(only ? [...only].flatMap(id => readOpen(kind, id) ?? []) : await rowsOf(kind, signal), query)),
    index: workIndex(kind) }));
  const pendingReminders = deps.db.prepare("SELECT reminder_id FROM reminders WHERE state='pending' AND (at<=? OR updated_at>?)");
  const reminderTexts = deps.db.prepare("SELECT reminder_id,text FROM reminders WHERE state='pending'");
  sources.push({ ...source('reminder', (_query, _signal, _context, only) => (only ? [...only].flatMap(id => deps.reminders.get(id) ?? []).filter(row => row.state === 'pending')
    : deps.reminders.listPending(20_000)).filter(row => !row.clock).map(row => {
    const item = fact({ collection: 'reminder', id: row.reminder_id }, row.text, 'reminder', row.updated_at);
    item.when = { from: row.at, to: row.at }; item.act_by = row.at; return scope(item, 'reminders');
  })), index: {
    seed: query => {
      const text = situationText(query);
      return [...(query.subjects ?? []).filter(ref => ref.collection === 'reminder').map(ref => ref.id),
        ...(pendingReminders.all(query.surface === 'prefetch' ? -8.64e15 : typeof query.time === 'number' ? query.time : query.time.to,
          query.changed_since ?? 8.64e15) as { reminder_id: string }[]).map(row => row.reminder_id),
        ...(query.text?.trim() ? (reminderTexts.all() as { reminder_id: string; text: string }[]).filter(row => text.title(row.text)).map(row => row.reminder_id) : [])];
    },
    find: ({ refs }) => refs.filter(ref => ref.collection === 'reminder').map(ref => ref.id),
  } });
  const occasions = source('occasion', async (query, signal, context, only) => {
    const result: SituationFact[] = [];
    const start = typeof query.time === 'number' ? query.time : query.time.from;
    const today = assetDateAt(start, deps.timeZone());
    // Once for the pass, not once for each occasion.
    const suppressions = proposals.suppressions();
    const add = (occasion: Occasion): void => {
      if (occasion.muted || occasion.source_active === false || occasion.people.some(id => {
        const contact = deps.contacts?.getByContactIdResolved(id) ?? deps.contacts?.get(id); return contact && contactExcludedFromProactive(contact);
      })) return;
      const on = occasionNextDate(occasion, today); if (!on) return;
      const when = span(calendarDayMs(on)!);
      if (history.suppressed({ ...occasion, when }, suppressions)) return;
      // A persisted source-derived date never bypasses the original source's
      // own verb/data grants when the private occasion store is granted.
      if (occasion.source) {
        const access = situationSourceAccess(occasion.source.collection);
        if (!access || !context?.grants.isVerbOpGranted(access.verb_op) || !context.grants.isCollectionReadGranted(access.collection)) return;
      }
      const ref = { collection: 'occasion', id: occasion.id };
      for (const rule of occasion.rules.filter(rule => rule.enabled && !rule.muted)) {
        const clock = evaluateAssetRuleClock({ status: 'active', dates: { next_on: on }, readings: {}, observations: {} }, rule, { now: now(), timeZone: deps.timeZone() });
        const row = occurrences.byOccasion(occasion.id).find(row => row.rule_id === rule.id && row.cycle === on && Boolean(row.commitment_id) === (rule.reaction.occurrence === 'action'));
        const canReadCommitment = context?.grants.isVerbOpGranted('core.work-entity.read') && context.grants.isCollectionReadGranted('commitment');
        const commitment = row?.commitment_id && canReadCommitment ? deps.work.readCommitment(row.commitment_id) : null;
        if (commitment && commitment.lifecycle_state !== 'pending') continue;
        const item = fact({ ...ref, field: `rules.${rule.id}` }, rule.reaction.occurrence === 'action' ? ruleStatement(rule, occasion.title) : occasion.title,
          'occasion', occasion.updated_at);
        item.subjects = [ref]; item.people = occasion.people; item.place = occasion.where; item.consequence = rule.consequence;
        // A trip the owner repeats has its country as its place. Egress aliases a place,
        // so the country is also given as the trip's destination, which it leaves readable.
        const country = placeCountry(occasion.where);
        if (country) item.trip = { subject: ref, travellers: [], destination_country: country };
        item.evidence = [{ ...ref, field: `rules.${rule.id}` }, ...(occasion.source ? [occasion.source] : [])];
        if (clock.due_on) { item.when = span(calendarDayMs(clock.due_on)!); item.when_day = clock.due_on; }
        if (clock.act_by) item.act_by = span(calendarDayMs(clock.act_by)!).from;
        if (commitment && context?.grants.isVerbOpGranted('core.work-entity.read') && context.grants.isCollectionReadGranted('commitment')) item.represents = { collection: 'commitment', id: commitment.id };
        else if (rule.id === 'date' && occasion.source) item.represents = occasion.source;
        result.push(scope(item, `occasion:${occasion.id}`, occasion.sphere));
      }
    };
    if (only) {
      for (const id of only) { const occasion = history.occasion(id); if (occasion) add(occasion); }
      await check(result.length, signal);
    } else for (let cursor = ''; ;) {
      const page = history.walkOccasions(cursor, PAGE); if (!page.length) break;
      for (const occasion of page) add(occasion);
      cursor = page.at(-1)!.id; await check(result.length, signal);
    }
    return result;
  });
  const everyOccasion = function* (): Generator<Occasion> {
    for (let cursor = ''; ;) {
      const page = history.walkOccasions(cursor, PAGE); if (!page.length) return;
      yield* page; cursor = page.at(-1)!.id;
    }
  };
  // §6.3 — what a window holds turns on each occasion's next date and its rules'
  // lead times, so every surface but a chat message reads them all. A message keeps
  // only what it names (`query.ts`): the occasions it names by a person, a title word
  // or a place, the trips a travel check relates, and what a kept fact points at.
  // Read whole, 300 birthdays took 76 of a prefetch's 88 ms on a fast machine.
  occasions.index = {
    seed: (query, people) => {
      if (query.surface !== 'prefetch') return 'all';
      const text = situationText(query); const said = Boolean(query.text?.trim());
      const ids = new Set((query.subjects ?? []).filter(ref => ref.collection === 'occasion').map(ref => ref.id));
      for (const occasion of everyOccasion()) {
        if (occasion.people.some(id => people.has(id))
          || said && [occasion.title, ...occasion.rules.map(rule => ruleStatement(rule, occasion.title))].some(title => text.title(title))
          || occasion.where && (query.place?.key === occasion.where.key || said && text.place(occasion.where.name))) ids.add(occasion.id);
      }
      return ids;
    },
    // A trip the owner repeats is a trip for a travel check whatever the window.
    relations: () => [...everyOccasion()].filter(occasion => placeCountry(occasion.where)).map(occasion => occasion.id),
    find: ({ refs, subjects }) => [...refs, ...subjects].filter(ref => ref.collection === 'occasion').map(ref => ref.id),
    // A clock stands for the commitment its occurrence opened, or for the record its date came from.
    representedBy: refs => {
      const ids = new Set(refs.flatMap(ref => {
        const row = ref.collection === 'commitment' ? occurrences.byCommitment(ref.id) : null;
        return row?.subject_kind === 'occasion' ? [row.asset_id] : [];
      }));
      const records = new Set(refs.filter(ref => ref.collection !== 'commitment').map(ref => JSON.stringify([ref.collection, ref.id])));
      if (records.size) for (const occasion of everyOccasion()) {
        if (occasion.source && records.has(JSON.stringify([occasion.source.collection, occasion.source.id]))) ids.add(occasion.id);
      }
      return ids;
    },
  };
  sources.push(occasions);
  const linked = () => Boolean(deps.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='asset_identity_links'").get());
  const identities = (id: string): string[] => linked() ? (deps.db.prepare('SELECT left_id,right_id FROM asset_identity_links WHERE left_id=? OR right_id=?')
    .all(id, id) as { left_id: string; right_id: string }[]).map(row => row.left_id === id ? row.right_id : row.left_id) : [];
  const assets = source('asset', async (query, signal, context, only) => {
    const result: SituationFact[] = [];
    const canReadParent = (parent: Asset): boolean => {
      const sphere = deps.sphere?.({ collection: 'asset', id: parent.id }, `work:${parent.source_id}`) ?? parent.sphere_override ?? parent.sphere;
      return context?.owner === true || context?.all_spheres === true || (sphere !== undefined && context?.spheres?.includes(sphere) === true);
    };
    const add = (asset: Asset): void => {
      if (!['active', 'lent'].includes(asset.status)) return;
      const subject = { collection: 'asset', id: asset.id };
      const base = fact(subject, asset.name, 'asset', asset.updated_at);
      base.subjects = [subject]; base.people = asset.holder_contact ? [asset.holder_contact] : [];
      // Every item this asset produces carries its own fields, whatever its class.
      base.details = situationAssetDetails(asset);
      if (query.surface === 'tool' || query.surface === 'prefetch' && context?.citeAssetDetails === true) rememberAssetDetailsRead(asset, base.details, now());
      if (isTravelDocument(asset)) base.travel_document = {
        ...(asset.holder_contact ? { holder: asset.holder_contact } : {}), issued_on: asset.dates.issued_on, expires_on: asset.dates.expires_on,
        ...(typeof asset.settings.nationality === 'string' && /^[A-Z]{2}$/u.test(asset.settings.nationality) ? { nationality: asset.settings.nationality } : {}),
      };
      if (isVisa(asset)) base.visa = { name: asset.name,
        ...(typeof asset.settings.valid_for === 'string' && /^[A-Z]{2}$/u.test(asset.settings.valid_for) ? { valid_for: asset.settings.valid_for } : {}),
        ...(typeof asset.dates.expires_on === 'string' ? { expires_on: asset.dates.expires_on } : {}) };
      base.related = [...(asset.belongs_to ? [{ collection: 'asset', id: asset.belongs_to }] : []),
        ...deps.work.listAssetChildren(asset.id).map(child => ({ collection: 'asset', id: child.id })),
        ...identities(asset.id).map(id => ({ collection: 'asset', id }))];
      const anchor = asset.anchors.find(anchor => anchor.kind === 'place');
      if (anchor?.kind === 'place' && anchor.name) base.place = place(anchor.name);
      const beforeRules = result.length;
      const at = now();
      const timings = assetRuleTimings(asset, { work: deps.work, occurrences: occurrences.byAsset(asset.id), now: at, timeZone: deps.timeZone(),
        commitments: context?.grants.isVerbOpGranted('core.work-entity.read') === true && context.grants.isCollectionReadGranted('commitment') });
      for (const { rule, clock, ...timing } of timings) {
        if (timing.settled || (clock.question && ['today', 'digest', 'push'].includes(query.surface ?? 'tool'))) continue;
        const item = { ...base, ref: { ...subject, field: `rules.${rule.id}` }, kind: 'asset_rule', title: `${rule.title} · ${asset.name}`,
          consequence: rule.consequence, evidence: [{ ...subject, field: `rules.${rule.id}` }, ...clock.evidence] };
        if (timing.represents) item.represents = { collection: 'commitment', id: timing.represents };
        if (timing.when) { item.when = timing.when; item.when_day = clock.due_on!; }
        if (timing.act_by !== undefined && (timing.lapses_at === undefined || timing.lapses_at >= at)) item.act_by = timing.act_by;
        if (clock.question) item.missing = true;
        result.push(scope(item, `work:${asset.source_id}`, asset.sphere_override ?? asset.sphere));
      }
      if (result.length === beforeRules) result.push(scope(base, `work:${asset.source_id}`, asset.sphere_override ?? asset.sphere));
    };
    if (only) {
      let count = 0;
      for (const id of only) {
        const asset = deps.work.readAssetEffective(id, canReadParent);
        if (asset && asset.deleted_at == null && ['live', 'stale_unreachable'].includes(asset.sync_state)) add(asset);
        if (++count % PAGE === 0) await check(result.length, signal);
      }
      await check(result.length, signal);
    } else for (let cursor = ''; ;) {
      const page = deps.work.walkByAssetId(cursor, PAGE); if (!page.length) break;
      for (const raw of page) add(deps.work.readAssetEffective(raw.id, canReadParent)!);
      cursor = page.at(-1)!.id; await check(result.length, signal);
    }
    return result;
  });
  // §6.3 — the stored act-by finds what is due; names, holders and changes
  // come by index. A title is the asset's name or a rule's title with it, and
  // a child takes its parent's place, so a named place brings its descendants.
  // Rule titles and own place labels come from the clock index, current for
  // every evaluated asset; the unevaluated ones are read whatever they say.
  const holders = deps.db.prepare(`SELECT id FROM ${ASSET_TABLE} WHERE holder_contact=?`);
  const changed = deps.db.prepare(`SELECT id FROM ${ASSET_TABLE} WHERE updated_at>?`);
  const assetNames = deps.db.prepare(`SELECT id,name,class_id,json_quote(json_extract(data_blob,'$.attributes.${ASSET_SEARCH_TERMS}')) AS terms
    FROM ${ASSET_TABLE} WHERE deleted_at IS NULL AND sync_state IN ('live','stale_unreachable')`);
  assets.textMatcher = query => {
    const text = situationText(query); const types = readAssetTypeSearchTerms(deps.db); const rules = clocks.ruleTitles();
    const terms = new Map<string, string>(); const hits = new Map<string, number>(); const candidates = new Set<string>();
    for (const row of assetNames.all() as Array<{ id: string; name: string; class_id: string | null; terms: string }>) {
      const hints = [...(types.get(row.class_id ?? '') ?? []), ...assetSearchTermsFromJson(row.terms)].join(' ');
      terms.set(row.id, hints);
      hits.set(row.id, text.hits(hints));
      if (text.title(`${row.name} ${hints}`) || rules.get(row.id)?.some(title => text.title(`${title} · ${row.name} ${hints}`))) candidates.add(row.id);
    }
    // Search metadata must remain usable when the bounded model projection
    // omits an array, a long string, or all of an asset's details.
    return { candidates, matches: item => text.title(`${item.title} ${terms.get(item.ref.id) ?? ''}`), keywordHits: item => hits.get(item.ref.id) ?? 0 };
  };
  const descendants = deps.db.prepare(`WITH RECURSIVE tree(id) AS (SELECT value FROM json_each(?)
    UNION SELECT a.id FROM ${ASSET_TABLE} a JOIN tree ON a.belongs_to=tree.id WHERE a.deleted_at IS NULL) SELECT id FROM tree`);
  assets.index = {
    seed: (query, people) => {
      const window = typeof query.time === 'number' ? { from: query.time, to: query.time } : query.time;
      const unevaluated = clocks.unevaluated(deps.timeZone());
      const ids = new Set(query.surface === 'prefetch' ? unevaluated : clocks.candidates({ ...window, now: now(), zone: deps.timeZone() }));
      const named = placeNamed(query);
      if (named) {
        const roots = [...clocks.places().filter(row => row.places.some(named)).map(row => row.asset_id), ...unevaluated];
        if (roots.length) for (const row of descendants.all(JSON.stringify([...new Set(roots)])) as { id: string }[]) ids.add(row.id);
      }
      for (const ref of query.subjects ?? []) if (ref.collection === 'asset') ids.add(ref.id);
      for (const person of people) for (const row of holders.all(person) as { id: string }[]) ids.add(row.id);
      if (query.changed_since !== undefined) for (const row of changed.all(query.changed_since) as { id: string }[]) ids.add(row.id);
      return ids;
    },
    // A trip check lists its travellers' visas, so they are read whatever the window.
    relations: (_context, classes) => clocks.relations([...classes, ...clocks.classes().filter(class_id => isVisa({ class_id }))]),
    find: ({ refs, subjects, related }) => {
      const ids = new Set([...refs, ...subjects].filter(ref => ref.collection === 'asset').map(ref => ref.id));
      // An asset relates to its parent, its children and its linked identities.
      for (const id of new Set(related.filter(ref => ref.collection === 'asset').map(ref => ref.id))) {
        const parent = deps.work.readAsset(id)?.belongs_to; if (parent) ids.add(parent);
        for (const child of deps.work.listAssetChildren(id)) ids.add(child.id);
        for (const linked of identities(id)) ids.add(linked);
      }
      return ids;
    },
    representedBy: refs => refs.flatMap(ref => {
      const row = ref.collection === 'commitment' ? occurrences.byCommitment(ref.id) : null;
      return row && row.subject_kind !== 'occasion' ? [row.asset_id] : [];
    }),
  };
  sources.push(assets);
  const calendar = source('calendar', async (_query, signal, _context, only) => {
    const result: SituationFact[] = [];
    const add = (slug: string, row: CalendarRowSnapshot): void => {
      if (row.hot.status === 'cancelled') return;
      const item = fact({ collection: 'calendar', id: `${slug}:${row.record_id}` }, row.hot.summary, 'calendar', row.modified_at);
      const local = eventSpanIn(row.hot, deps.timeZone());
      item.when = { from: local.start, to: local.end }; item.act_by = local.start; item.valid_until = local.end;
      if (row.hot.is_all_day) item.when_day = assetDateAt(row.hot.start_at, 'UTC');
      item.place = place(row.hot.location);
      item.people = row.event.attendees?.flatMap(person => person.email ? [person.email] : []) ?? [];
      item.trip = trips.get(item.ref) ?? undefined;
      if (item.trip?.travellers.length) item.people = item.trip.travellers;
      result.push(scope(item, `calendar:${slug}:${row.hot.calendar_id}`));
    };
    if (only) {
      const tables = new Map(deps.calendars().map(source => [source.slug, source.table]));
      for (const id of only) {
        const colon = id.indexOf(':'); const row = colon > 0 ? tables.get(id.slice(0, colon))?.getByRecordId(id.slice(colon + 1)) : null;
        if (row && row.hot.end_at > now() - DAY) add(id.slice(0, colon), row);
      }
      await check(result.length, signal);
    } else for (const source of deps.calendars()) for (let offset = 0; ; offset += PAGE) {
      const page = source.table.listSnapshots({ end_after: now() - DAY, order_by: 'start_at', offset, limit: PAGE });
      for (const row of page) add(source.slug, row);
      await check(result.length, signal); if (page.length < PAGE) break;
    }
    return result;
  });
  // §6.3 — a local day starts up to a day from its stored start. A summary,
  // location or attendee is matched on each event's lines, never decoded.
  calendar.index = {
    seed: (query, people) => {
      const window = typeof query.time === 'number' ? { from: query.time, to: query.time } : query.time;
      const found = new Set((query.subjects ?? []).filter(ref => ref.collection === 'calendar').map(ref => ref.id));
      const text = situationText(query); const named = placeNamed(query);
      for (const source of deps.calendars()) {
        for (const filter of [...(query.surface !== 'prefetch' ? [{ start_until: window.to + DAY + 1 }] : []),
          ...(query.changed_since !== undefined ? [{ modified_since: query.changed_since }] : [])]) {
          for (let offset = 0; ; offset += PAGE) {
            const page = source.table.listSnapshots({ end_after: now() - DAY, ...filter, order_by: 'start_at', offset, limit: PAGE });
            for (const row of page) found.add(`${source.slug}:${row.record_id}`);
            if (page.length < PAGE) break;
          }
        }
        if (query.text?.trim() || named || people.size) for (const line of source.table.situationLines(now() - DAY, people.size > 0)) {
          if (query.text?.trim() && text.title(line.summary) || named?.(line.location) || line.attendees.some(email => people.has(email))) found.add(`${source.slug}:${line.record_id}`);
        }
      }
      return found;
    },
    relations: () => trips.subjects('calendar'),
    find: ({ refs }) => refs.filter(ref => ref.collection === 'calendar').map(ref => ref.id),
  };
  sources.push(calendar);
  if (deps.contacts) {
    const contacts = deps.contacts;
    const contact = source('contact', async (query, signal, _context, only) => {
      const start = typeof query.time === 'number' ? query.time : query.time.from;
      const from = assetDateAt(start, deps.timeZone());
      const result: SituationFact[] = [];
      const add = (contact: ContactRecord): void => {
        if (contactExcludedFromProactive(contact)) return;
        for (const field of ['birthday', 'anniversary'] as const) {
          const value = contact[field]; if (!isContactAnnualDate(value)) continue;
          if (history.occasionDeleted(declaredOccasionId({ collection: 'contact', id: contact.contact_id ?? contact.email, field }))) continue;
          const on = nextAnnualDate(value.slice(-5), from); if (!on) continue;
          const item = fact({ collection: 'contact', id: contact.contact_id ?? contact.email, field },
            `${contact.name ?? contact.email} · ${field}`, field, contact.projection_provenance?.[field]?.as_of ?? 0);
          item.when = span(calendarDayMs(on)!); item.act_by = item.when.from; item.people = [contact.contact_id ?? contact.email];
          item.when_day = on; item.valid_until = item.when.to;
          result.push(scope(item, `contact:${contact.contact_id ?? contact.email}`));
        }
      };
      if (only) {
        for (const id of only) {
          const email = (contactEmail.get(id, id) as { email: string } | undefined)?.email;
          const row = email ? contacts.get(email) : null; if (row) add(row);
        }
        await check(result.length, signal);
      } else for (let cursor = ''; ;) {
        const page = contacts.walkByEmail(cursor, PAGE); if (!page.length) break;
        for (const row of page) add(row);
        cursor = page.at(-1)!.email; await check(result.length, signal);
      }
      return result;
    });
    // §6.3 — a yearly date is due when its month and day fall in the window.
    const contactEmail = deps.db.prepare('SELECT email FROM contacts WHERE contact_id=? OR (contact_id IS NULL AND email=?)');
    const dated = (where: string, ...params: unknown[]): string[] => (deps.db.prepare(`SELECT COALESCE(contact_id,email) AS id FROM contacts
      WHERE (birthday IS NOT NULL OR anniversary IS NOT NULL) AND (${where})`).all(...params) as { id: string }[]).map(row => row.id);
    const contactTitles = deps.db.prepare(`SELECT COALESCE(contact_id,email) AS id,name,email,birthday IS NOT NULL AS birthday,anniversary IS NOT NULL AS anniversary
      FROM contacts WHERE birthday IS NOT NULL OR anniversary IS NOT NULL`);
    contact.index = {
      seed: (query, people) => {
        const window = typeof query.time === 'number' ? { from: query.time, to: query.time } : query.time;
        const found = new Set([...(query.subjects ?? []).filter(ref => ref.collection === 'contact').map(ref => ref.id), ...people]);
        if (query.text?.trim()) {
          const text = situationText(query);
          for (const row of contactTitles.all() as Array<{ id: string; name: string | null; email: string; birthday: number; anniversary: number }>) {
            for (const field of ['birthday', 'anniversary'] as const) if (row[field] && text.title(`${row.name ?? row.email} · ${field}`)) found.add(row.id);
          }
        }
        let days: string[] | null = query.surface === 'prefetch' ? [] : null;
        if (days === null && window.to - window.from < 366 * DAY) {
          days = []; const last = assetDateAt(window.to, deps.timeZone());
          for (let on = assetDateAt(window.from, deps.timeZone()); on <= last && days.length <= 366; on = shiftAssetDate(on, { amount: 1, unit: 'days' })) days.push(on.slice(5));
          // A 29 February date falls on the 28th in a common year.
          if (days.includes('02-28')) days.push('02-29');
        }
        for (const id of days === null ? dated('1') : dated(`substr(birthday,-5) IN (SELECT value FROM json_each(?)) OR substr(anniversary,-5) IN (SELECT value FROM json_each(?))`,
          JSON.stringify(days), JSON.stringify(days))) found.add(id);
        if (query.changed_since !== undefined) for (const id of dated(`json_extract(projection_provenance,'$.birthday.as_of')>? OR json_extract(projection_provenance,'$.anniversary.as_of')>?`,
          query.changed_since, query.changed_since)) found.add(id);
        return found;
      },
      find: ({ refs }) => refs.filter(ref => ref.collection === 'contact').map(ref => ref.id),
    };
    sources.push(contact);
  }
  if (deps.mailFacts) {
    const mailFacts = deps.mailFacts;
    const LABELS = ['issuer', 'merchant', 'provider', 'carrier'];
    // A kind as the owner names it, read once per query: a type of theirs can be renamed.
    const typeNames = (): ((type: string) => string) => {
      const names = new Map<string, string>();
      return type => {
        let name = names.get(type);
        if (name === undefined) {
          const spaced = type.replace(/^custom_/u, '').replaceAll('_', ' ').trim();
          name = getMailFactBuiltinType(type)?.name ?? mailFacts.getCustomType(type)?.name ?? (spaced ? spaced[0]!.toUpperCase() + spaced.slice(1) : type);
          names.set(type, name);
        }
        return name;
      };
    };
    const things = source('mail_fact', async (_query, signal, _context, only) => {
      const result: SituationFact[] = []; const typeName = typeNames();
      const add = (row: MailFactThing): void => {
        // A request the owner mailed their own server is an instruction its trigger carries
        // out (D-315 §7.4), not something to recall; what it makes, a task or a note, is an
        // item of its own. It has no date and no closing state, so it would stay forever.
        if (row.type === 'owner_request') return;
        const variables = row.variables; const state = variables.state;
        if (typeof state === 'string' && ['cancelled', 'paid', 'delivered', 'returned', 'refund_issued'].includes(state)) return;
        const field = DATED[row.type]; const at = field ? timeOf(variables[field]) : undefined;
        // Titled as its own page heads it ("Bill: Acme Power"); its kind stays the stored type.
        const label = LABELS.map(name => variables[name]).find((value): value is string => typeof value === 'string' && value.length > 0);
        const item = fact({ collection: 'mail_fact', id: row.thing_id }, `${typeName(row.type)}${label !== undefined ? `: ${label}` : ''}`, row.type, row.updated_at);
        item.basis = 'derived';
        if (at !== undefined) { item.when = span(at); item.act_by = item.when.from;
          if (typeof variables[field!] === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(variables[field!] as string)) item.when_day = variables[field!] as string; }
        if (row.type === 'reservation') {
          const end = timeOf(variables.ends_at);
          if (at !== undefined) { item.when = { from: at, to: end ?? at }; item.act_by = at; }
          item.valid_until = end; item.place = typeof variables.location === 'string' ? place(variables.location) : undefined;
          item.trip = trips.get(item.ref) ?? tripFromSource(item.ref, variables);
          if (item.trip?.travellers.length) item.people = item.trip.travellers;
        }
        const sourceFacts = mailFacts.factsForThing(row.thing_id);
        const mailboxes = [...new Set(sourceFacts.map(fact => fact.email.slug))];
        const known = mailboxes.map(slug => deps.sphere?.({ collection: 'mail', id: `${slug}:source` }, `mail:${slug}`));
        const derived = known.length && known.every(value => value !== undefined && value === known[0]) ? known[0] : undefined;
        result.push(scope(item, mailboxes.length === 1 ? `mail:${mailboxes[0]}` : `mail-fact:${row.type}`, derived));
      };
      if (only) {
        for (const id of only) { const row = mailFacts.getThing(id); if (row) add(row); }
        await check(result.length, signal);
      } else for (let cursor: { updated_at: number; thing_id: string } | undefined; ;) {
        const page = mailFacts.listThings({ limit: PAGE, ...(cursor ? { cursor_before: cursor } : {}) });
        for (const row of page) add(row);
        await check(result.length, signal); if (page.length < PAGE) break;
        const last = page.at(-1)!; cursor = { updated_at: last.updated_at, thing_id: last.thing_id };
      }
      return result;
    }, 'mail');
    // §6.3 — a dated thing by its own date, at most a day from the instant it
    // starts. Only a reservation carries people or a place, and every
    // reservation is read as a possible trip.
    const due = deps.db.prepare(`SELECT thing_id FROM (SELECT thing_id, json_type(variables_blob,path) AS kind, json_extract(variables_blob,path) AS at
      FROM (SELECT thing_id, variables_blob, CASE type WHEN 'shipment' THEN '$.expected_at' WHEN 'reservation' THEN '$.starts_at' ELSE '$.due_at' END AS path
        FROM mail_fact_thing WHERE type IN ('bill','statement','shipment','reservation') AND json_valid(variables_blob)))
      WHERE (kind IN ('integer','real') AND at<=?) OR (kind='text' AND substr(at,1,10)<=?)`);
    const changed = deps.db.prepare('SELECT thing_id FROM mail_fact_thing WHERE updated_at>?');
    const reservations = deps.db.prepare("SELECT thing_id FROM mail_fact_thing WHERE type='reservation'");
    // A title is the kind's name and a label. Matching every label field reads more
    // than a title holds, never less.
    const thingTitles = deps.db.prepare(`SELECT thing_id,type,${LABELS.map(field => `json_extract(variables_blob,'$.${field}') AS ${field}`).join(',')}
      FROM mail_fact_thing WHERE json_valid(variables_blob)`);
    const titledThings = (query: SituationQuery): string[] => {
      if (!query.text?.trim()) return [];
      const text = situationText(query); const typeName = typeNames();
      return (thingTitles.all() as Array<Record<string, unknown> & { thing_id: string; type: string }>)
        .filter(row => text.title([typeName(row.type), ...LABELS.map(field => row[field]).filter(value => typeof value === 'string')].join(' · '))).map(row => row.thing_id);
    };
    things.index = {
      seed: query => {
        const window = typeof query.time === 'number' ? { from: query.time, to: query.time } : query.time;
        const day = window.to + 2 * DAY <= 253_402_214_400_000 ? new Date(window.to + 2 * DAY).toISOString().slice(0, 10) : '9999-12-31';
        return [...(query.subjects ?? []).filter(ref => ref.collection === 'mail_fact').map(ref => ref.id), ...titledThings(query),
          ...(query.surface !== 'prefetch' ? due.all(window.to + DAY, day) as { thing_id: string }[] : []).map(row => row.thing_id),
          ...(query.changed_since !== undefined ? changed.all(query.changed_since) as { thing_id: string }[] : []).map(row => row.thing_id)];
      },
      relations: () => (reservations.all() as { thing_id: string }[]).map(row => row.thing_id),
      find: ({ refs }) => refs.filter(ref => ref.collection === 'mail_fact').map(ref => ref.id),
    };
    sources.push(things);
  }
  return sources;
};

export const situationSourceAccess = (collection: string): { verb_op: string; collection: string } | undefined => {
  const verb_op = situationSourceReadOp(collection);
  return verb_op ? { verb_op, collection: collection === 'mail_fact' ? 'mail' : collection === 'history_trace' ? 'episode' : collection } : undefined;
};
