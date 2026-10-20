import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { PROSE_FUNCTION_WORDS } from '@recued/middleware-prompt-cache';
import type {
  SituationCluster, SituationDimension, SituationFact, SituationItem,
  SituationQuery, SituationReason, SituationRef, SituationResult, SituationVerdict, SituationWindow,
  Sphere,
} from '@recued/contracts';
import type { ReadGrantChecker } from '../read-grant-checker.js';

const DAY = 86_400_000;
const refKey = (ref: SituationRef): string => JSON.stringify([ref.collection, ref.id, ref.field ?? null]);
const intersects = (a: SituationWindow, b: SituationWindow): boolean => a.from <= b.to && b.from <= a.to;
/** Full-cluster projections need collision reasons before the item cap.
 * Sorted neighboring spans and prior maximum ends keep that work bounded. */
const collidingFacts = (facts: readonly SituationFact[]): ReadonlySet<SituationFact> => {
  const timed = facts.filter(fact => fact.when).sort((a, b) => a.when!.from - b.when!.from);
  const collisions = new Set<SituationFact>(); let latestEnd = -Infinity;
  for (let index = 0; index < timed.length; index++) {
    const fact = timed[index]!; const span = fact.when!; const next = timed[index + 1]?.when;
    if (latestEnd >= span.from || next && next.from <= span.to) collisions.add(fact);
    latestEnd = Math.max(latestEnd, span.to);
  }
  return collisions;
};
const tokens = (value: string): string[] => [...new Set(value.toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? [])];
/** How the query's text names an item, tokenized once. A tool question names
 * a title holding every one of its words; a chat message (prefetch) names a
 * title sharing any meaningful word, and a place whose every word it says. */
export const situationText = (query: Pick<SituationQuery, 'text' | 'surface'>) => {
  const all = tokens(query.text ?? ''); const words = new Set(all);
  return {
    title: (title: string): boolean => {
      if (!query.text) return true;
      if (query.surface === 'prefetch') return tokens(title).some(word => [...word].length >= 2 && !PROSE_FUNCTION_WORDS.has(word) && words.has(word));
      const found = new Set(tokens(title)); return all.length > 0 && all.every(token => found.has(token));
    },
    place: (name: string): boolean => {
      const place = tokens(name).filter(word => !PROSE_FUNCTION_WORDS.has(word));
      return place.length > 0 && place.every(word => words.has(word));
    },
  };
};
type SituationText = ReturnType<typeof situationText>;
const MAX_FACTS = 20_000;
/** A source holds more records than one read may. The owner keeps the rest of
 * the result with the source named in `partial`; a scoped contract is refused,
 * so no partial result or private count reaches it. */
export class SituationScanBoundError extends Error {}
export interface SituationLinks { refs: readonly SituationRef[]; subjects: readonly SituationRef[]; related: readonly SituationRef[] }
/** §6.3 — how an indexed read finds a source's records. Every method may name
 * more records than a read needs, never fewer. */
export interface SituationSourceIndex {
  /** Records whose facts may be selected directly: due by the window's end,
   * named by a subject, place, person or text, or changed since the cursor. */
  seed(query: SituationQuery, people: ReadonlySet<string>, context: SituationReadContext): Iterable<string> | 'all';
  /** Records a declared relation reads whatever the window: trips, travel
   * documents and assets of the classes a learned relation names. */
  relations?(context: SituationReadContext, classes: readonly string[]): Iterable<string> | 'all';
  /** Records whose facts are one of `refs`, or carry one of `subjects` as a
   * subject or one of `related` as a relation. */
  find(links: SituationLinks): Iterable<string>;
  /** Records whose clocks may stand for one of these records. */
  representedBy?(refs: readonly SituationRef[]): Iterable<string>;
}
export interface SituationSource {
  id: string;
  verb_op: string;
  collection: string;
  grant_collection?: string;
  /** Called only after BOTH source grants pass. No private count escapes.
   * With `only`, it reads just those records, named by their facts' `ref.id`. */
  read(query: SituationQuery, signal?: AbortSignal, context?: SituationReadContext, only?: ReadonlySet<string>): Promise<readonly SituationFact[]> | readonly SituationFact[];
  /** Without an index the source is read whole. */
  index?: SituationSourceIndex;
}
export interface SituationReadContext {
  grants: ReadGrantChecker;
  /** Owner may see unknown spheres. A scoped door must declare its spheres. */
  owner: boolean;
  /** Host-verified active contract with no sphere restriction. Never an input. */
  all_spheres?: boolean;
  spheres?: readonly Sphere[];
  referenceSphere?: (ref: SituationRef) => Sphere | undefined;
  last_time_opted_in?: boolean;
  memoryAllowed?: (cluster: SituationCluster) => boolean;
  /** Host-only view policy, after grants and the inference limit, before item
   * and cluster caps. Return a reordered subset of supplied objects, or null. */
  projectClusterItems?: (items: readonly SituationItem[]) => readonly SituationItem[] | null;
  signal?: AbortSignal;
}
export interface SituationQueryDeps {
  sources: readonly SituationSource[];
  now?: () => number;
  /** Declared pack relations see ONLY facts already admitted by both source
   * and sphere fences. They perform no provider reads or writes. */
  relate?(facts: readonly SituationFact[], query: SituationQuery, context: SituationReadContext): readonly SituationFact[];
  rank?(fact: SituationFact): number;
  namedPeople?(text: string, context: SituationReadContext): Array<{ id: string; name: string }>;
  /** Evidence keeps its original source's verb, not the candidate's verb. */
  sourceForCollection(collection: string): { verb_op: string; collection: string } | undefined;
  /** Asset classes a learned relation pairs with trips. */
  relationClasses?(): readonly string[];
}

const validateQuery = (query: SituationQuery): SituationWindow => {
  const window = typeof query.time === 'number' ? { from: query.time, to: query.time } : query.time;
  if (!window || !Number.isSafeInteger(window.from) || !Number.isSafeInteger(window.to)
    || Math.abs(window.from) > 8.64e15 || Math.abs(window.to) > 8.64e15 || window.to < window.from) throw new Error('Situation time must be a valid instant or ordered span');
  if (query.changed_since !== undefined && !Number.isSafeInteger(query.changed_since)) throw new Error('Invalid change cursor');
  for (const key of ['limit_items', 'limit_clusters'] as const) {
    if (query[key] !== undefined && (!Number.isSafeInteger(query[key]) || query[key]! < 1)) throw new Error(`Invalid ${key}`);
  }
  if (query.people !== undefined && (!Array.isArray(query.people) || !query.people.every(id => typeof id === 'string' && id.trim()))) throw new Error('Invalid people');
  if (query.subjects !== undefined && (!Array.isArray(query.subjects) || !query.subjects.every(ref => ref && typeof ref.collection === 'string' && typeof ref.id === 'string' && ref.id))) throw new Error('Invalid subjects');
  return window;
};

/** Selector 1 (§6.3): the act-by has passed or falls in the window; with no
 * act-by, the item's own time meets it. */
export const situationDue = (fact: Pick<SituationFact, 'act_by' | 'when'>, window: SituationWindow): boolean =>
  fact.act_by !== undefined ? fact.act_by <= window.to : fact.when !== undefined && intersects(fact.when, window);
const timeVerdict = (value: SituationWindow | undefined, window: SituationWindow): SituationVerdict => {
  if (!value) return 'unknown';
  if (intersects(value, window)) return 'match';
  return Math.min(Math.abs(value.from - window.to), Math.abs(window.from - value.to)) <= 14 * DAY ? 'near' : 'outside';
};
const dimension = <T>(value: T | undefined, verdict: SituationVerdict, fact: SituationFact): SituationDimension<T> => ({
  value: value ?? null, verdict: value === undefined ? 'unknown' : verdict, basis: fact.basis, evidence: fact.evidence,
});
const itemOf = (fact: SituationFact, reasons: Set<SituationReason>, query: SituationQuery, window: SituationWindow, text: SituationText): SituationItem => ({
  ref: fact.ref, kind: fact.kind,
  what: dimension(fact.title, text.title(fact.title) ? 'match' : 'outside', fact),
  when: dimension(fact.when, timeVerdict(fact.last_time ? fact.last_time_comparison ?? fact.when : fact.when, window), fact),
  where: dimension(fact.place, query.place && fact.place ? (query.place.key === fact.place.key ? 'match' : 'outside')
    : query.surface === 'prefetch' && query.text && fact.place && text.place(fact.place.name) ? 'match' : 'unknown', fact),
  who: dimension(fact.people.length ? fact.people : undefined, query.people?.length && fact.people.length
    ? query.people.every(person => fact.people.includes(person)) ? 'match' : query.people.some(person => fact.people.includes(person)) ? 'near' : 'outside' : 'unknown', fact),
  reasons: [...reasons], basis: fact.basis, evidence: fact.evidence, consequence: fact.consequence,
  ...(fact.when_day ? { when_day: fact.when_day } : {}),
  ...(fact.sphere ? { sphere: fact.sphere } : {}), updated_at: fact.updated_at,
});
const uniqueRefs = (refs: SituationRef[]): SituationRef[] => [...new Map(refs.map(ref => [refKey(ref), ref])).values()]
  .sort((a, b) => refKey(a).localeCompare(refKey(b)));

/** One query for every caller. The adapters resolve source data; this layer
 * selects, judges and clusters only facts this contract was allowed to read. */
export const createSituationQuery = (deps: SituationQueryDeps) => async (
  query: SituationQuery, context: SituationReadContext,
): Promise<SituationResult> => {
  const window = validateQuery(query);
  const text = situationText(query);
  const current = deps.now?.() ?? Date.now();
  const allowed = (verb: string, collection: string): boolean => context.grants.isVerbOpGranted(verb) && context.grants.isCollectionReadGranted(collection);
  const factsById = new Map<string, SituationFact>();
  const contactAccess = deps.sourceForCollection('contact');
  const personAllowed = (id: string): boolean => {
    if (!contactAccess || !allowed(contactAccess.verb_op, contactAccess.collection)) return false;
    if (context.owner || context.all_spheres) return true;
    const ref = { collection: 'contact', id };
    const sphere = context.referenceSphere?.(ref) ?? factsById.get(refKey(ref))?.sphere;
    return sphere !== undefined && context.spheres?.includes(sphere) === true;
  };
  const projectPeople = (fact: SituationFact): SituationFact => ({ ...fact, people: fact.people.filter(personAllowed),
    ...(fact.trip ? { trip: { ...fact.trip, travellers: fact.trip.travellers.filter(personAllowed) } } : {}),
    ...(fact.travel_document?.holder && !personAllowed(fact.travel_document.holder)
      ? { travel_document: { ...fact.travel_document, holder: undefined } } : {}),
  });
  const partial = new Set<string>();
  const degrade = (collection: string, error: unknown): void => {
    if (!(error instanceof SituationScanBoundError) || !(context.owner || context.all_spheres)) throw error;
    partial.add(collection);
  };
  // A timer cannot interrupt synchronous work, so the prefetch budget only
  // holds if the scan gives the event loop a turn between its stages.
  const yieldTurn = async (): Promise<void> => {
    await setImmediate();
    if (context.signal?.aborted) throw context.signal.reason ?? new Error('Situation query aborted');
  };
  const sources = deps.sources.filter(source => allowed(source.verb_op, source.grant_collection ?? source.collection));
  const namedPeople = query.surface === 'prefetch' && query.text && contactAccess && allowed(contactAccess.verb_op, contactAccess.collection)
    ? (deps.namedPeople?.(query.text, context) ?? []).filter(person => personAllowed(person.id)) : [];
  const namedIds = new Set(namedPeople.map(person => person.id));
  const read = new Map<SituationSource, SituationFact[]>();
  const loaded = new Map<SituationSource, Set<string> | 'all'>();
  // Await sources in inventory order; a capped scan is stable and never lets
  // the timing of a provider decide which private record enters a result.
  const load = async (source: SituationSource, ids: Iterable<string> | 'all'): Promise<SituationFact[]> => {
    const prior = loaded.get(source); if (prior === 'all') return [];
    const only = ids === 'all' ? undefined : new Set([...ids].filter(id => !prior?.has(id)));
    if (only?.size === 0) return [];
    loaded.set(source, only ? new Set([...prior ?? [], ...only]) : 'all');
    await yieldTurn();
    let facts: readonly SituationFact[];
    try { facts = await source.read(query, context.signal, context, only); } catch (error) { degrade(source.collection, error); return []; }
    const fresh = only ? facts.filter(fact => only.has(fact.ref.id)) : [...facts];
    read.set(source, [...read.get(source) ?? [], ...fresh]);
    return fresh;
  };
  // §6.3 — read what the window, the names and one hop of relations need. A
  // source without an index is read whole, so the facts selected are those a
  // read of every record would select.
  {
    const people = new Set([...query.people ?? [], ...namedIds]);
    const classes = deps.relationClasses?.() ?? [];
    let seeded: SituationFact[] = [];
    for (const source of sources) {
      seeded = seeded.concat(await load(source, source.index ? source.index.seed(query, people, context) : 'all'));
      if (source.index?.relations) seeded = seeded.concat(await load(source, source.index.relations(context, classes)));
    }
    // A clock's fact merges into the record it stands for, so both are read.
    const represent = async (facts: SituationFact[]): Promise<SituationFact[]> => {
      let all = facts;
      for (let fresh = facts; fresh.length;) {
        let next: SituationFact[] = [];
        const canonical = fresh.flatMap(fact => fact.represents ? [fact.represents] : []); const refs = fresh.map(fact => fact.ref);
        for (const source of sources) if (source.index) {
          next = next.concat(await load(source, canonical.filter(ref => ref.collection === source.collection).map(ref => ref.id)));
          if (source.index.representedBy) next = next.concat(await load(source, source.index.representedBy(refs)));
        }
        all = all.concat(next); fresh = next;
      }
      return all;
    };
    seeded = await represent(seeded);
    // Selection adds one hop of relations to what it selects; everything read
    // so far is a superset of that selection.
    const links = { refs: seeded.flatMap(fact => fact.related), subjects: seeded.flatMap(fact => fact.related),
      related: seeded.flatMap(fact => [fact.ref, ...fact.subjects]) };
    let hop: SituationFact[] = [];
    for (const source of sources) if (source.index) hop = hop.concat(await load(source, source.index.find(links)));
    await represent(hop);
  }
  // Admit in one order whatever order the reads ran in: relations and merges
  // see the same facts in the same sequence either way.
  for (const source of sources) {
    const facts = (read.get(source) ?? []).map(fact => [refKey(fact.ref), fact] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    for (const [key, fact] of facts) {
      if (fact.ref.collection !== source.collection || !fact.title.trim()) continue;
      if (!context.owner && !context.all_spheres && (!fact.sphere || !context.spheres?.includes(fact.sphere))) continue;
      if (fact.valid_until !== undefined && fact.valid_until <= current) continue;
      if (fact.last_time && (query.surface !== 'digest' || !query.include_last_time || !context.last_time_opted_in)) continue;
      if (query.surface === 'prefetch' && (fact.ref.collection === 'episode' || fact.last_time)) continue;
      const refAllowed = (ref: SituationRef): boolean => {
        const access = deps.sourceForCollection(ref.collection);
        return Boolean(access && allowed(access.verb_op, access.collection));
      };
      const evidence = fact.evidence.filter(refAllowed).map(({ value: _value, ...ref }) => ref);
      if (factsById.size >= MAX_FACTS && !factsById.has(key)) {
        degrade(source.collection, new SituationScanBoundError('Situation scan exceeds its bound; narrow the time or source query')); break;
      }
      factsById.set(key, { ...fact, evidence, subjects: fact.subjects.filter(refAllowed), related: fact.related.filter(refAllowed) });
    }
  }
  await yieldTurn();
  // Sources may yield while another owner action moves an earlier item. Scope
  // membership is checked again before relations, ranking or private counts.
  if (!context.owner && !context.all_spheres && context.referenceSphere) for (const [key, fact] of factsById) {
    const sphere = context.referenceSphere(fact.ref);
    if (sphere === undefined || !context.spheres?.includes(sphere)) factsById.delete(key);
    else fact.sphere = sphere;
  }
  // Foreign contact references need their own grants and placement before any
  // relation can turn a hidden holder into a verdict or a shared-person join.
  for (const [key, fact] of factsById) factsById.set(key, projectPeople(fact));
  if (deps.relate) for (const fact of deps.relate([...factsById.values()], query, context)) {
    const access = deps.sourceForCollection(fact.ref.collection);
    if (!access || !allowed(access.verb_op, access.collection) || (!context.owner && !context.all_spheres && (!fact.sphere || !context.spheres?.includes(fact.sphere)))) continue;
    if (fact.evidence.some(ref => {
      const source = deps.sourceForCollection(ref.collection);
      return !source || !allowed(source.verb_op, source.collection);
    })) continue;
    if (factsById.size >= MAX_FACTS && !factsById.has(refKey(fact.ref))) {
      degrade(fact.ref.collection, new SituationScanBoundError('Situation relations exceed the scan bound')); break;
    }
    factsById.set(refKey(fact.ref), projectPeople(fact));
  }
  // A clock's computed lead can describe a canonical obligation already in
  // another granted source. Keep one item, with the deciding clock evidence.
  // If that record was fenced out, its identity contributes nothing.
  for (const clock of [...factsById.values()]) {
    if (!clock.represents) continue;
    const canonicalKey = refKey(clock.represents); const canonical = factsById.get(canonicalKey);
    if (!canonical || canonical === clock) continue;
    factsById.set(canonicalKey, { ...canonical,
      when: clock.when ?? canonical.when, act_by: clock.act_by ?? canonical.act_by,
      ...(clock.when_day ? { when_day: clock.when_day } : {}),
      consequence: canonical.consequence === 'floor' || clock.consequence === 'floor' ? 'floor' : 'routine',
      subjects: uniqueRefs([...canonical.subjects, ...clock.subjects]), related: uniqueRefs([...canonical.related, ...clock.related]),
      evidence: [...canonical.evidence, ...clock.evidence], missing: canonical.missing || clock.missing,
      updated_at: Math.max(canonical.updated_at, clock.updated_at) });
    factsById.delete(refKey(clock.ref));
  }
  const facts = [...factsById.values()];
  if (!context.owner && !context.all_spheres && context.spheres?.length) {
    const baseKey = (ref: SituationRef) => JSON.stringify([ref.collection, ref.id]);
    const visible = new Set(facts.map(fact => baseKey(fact.ref)));
    const withinSphere = (ref: SituationRef): boolean => {
      if (visible.has(baseKey(ref))) return true;
      const sphere = context.referenceSphere?.(ref);
      return sphere !== undefined && context.spheres!.includes(sphere);
    };
    for (const fact of facts) {
      fact.evidence = fact.evidence.filter(withinSphere);
      fact.subjects = fact.subjects.filter(withinSphere);
      fact.related = fact.related.filter(withinSphere);
    }
  }
  const selected = new Map<string, Set<SituationReason>>();
  const querySubjects = new Set((query.subjects ?? []).map(refKey));
  const add = (fact: SituationFact, reason: SituationReason): void => {
    const key = refKey(fact.ref); const reasons = selected.get(key) ?? new Set(); reasons.add(reason); selected.set(key, reasons);
  };
  for (const fact of facts) {
    const due = situationDue(fact, window);
    const named = querySubjects.has(refKey(fact.ref)) || fact.subjects.some(ref => querySubjects.has(refKey(ref)))
      || Boolean(query.place && fact.place?.key === query.place.key)
      || Boolean(query.people?.some(id => fact.people.includes(id)))
      || fact.people.some(id => namedIds.has(id))
      || Boolean(query.text?.trim() && (text.title(fact.title)
        || (query.surface === 'prefetch' && fact.place && text.place(fact.place.name))));
    // Prefetch must match the message; a general overdue item alone isn't a hit.
    if (query.surface === 'prefetch' && !named) continue;
    if (due) add(fact, 'due');
    if (named) add(fact, fact.last_time ? 'last_time' : 'related');
    if (query.changed_since !== undefined && fact.updated_at > query.changed_since) add(fact, 'related');
    if (fact.missing && (due || named)) add(fact, 'missing');
  }
  // Declared edges pull near-misses in, including a parent's children and vice
  // versa. All nodes have already passed source and sphere gates.
  const seedKeys = new Set(selected.keys());
  const seedSubjects = new Set(facts.filter(fact => seedKeys.has(refKey(fact.ref))).flatMap(fact => [refKey(fact.ref), ...fact.subjects.map(refKey)]));
  const seedRelations = new Set(facts.filter(fact => seedKeys.has(refKey(fact.ref))).flatMap(fact => fact.related.map(refKey)));
  for (const fact of facts) {
    if (fact.related.some(ref => seedSubjects.has(refKey(ref)))
      || fact.subjects.some(ref => seedRelations.has(refKey(ref)))
      || seedRelations.has(refKey(fact.ref))) add(fact, 'related');
  }
  const picked = facts.filter(fact => selected.has(refKey(fact.ref)));
  const parents = picked.map((_, index) => index);
  const root = (index: number): number => { while (parents[index] !== index) { parents[index] = parents[parents[index]!]!; index = parents[index]!; } return index; };
  const union = (left: number, right: number): void => { parents[root(right)] = root(left); };
  const bySubject = new Map<string, number>();
  const byRef = new Map(picked.map((fact, index) => [refKey(fact.ref), index]));
  const overlapGroups = new Map<string, number[]>();
  picked.forEach((fact, index) => {
    for (const subject of [fact.ref, ...fact.subjects]) {
      const key = refKey(subject); const previous = bySubject.get(key);
      if (previous !== undefined) union(previous, index); else bySubject.set(key, index);
    }
    if (fact.when) for (const key of [...fact.people.map(id => `person:${id}`), ...(fact.place ? [`place:${fact.place.key}`] : [])]) {
      const group = overlapGroups.get(key) ?? []; group.push(index); overlapGroups.set(key, group);
    }
  });
  picked.forEach((fact, index) => {
    for (const ref of fact.related) { const target = byRef.get(refKey(ref)) ?? bySubject.get(refKey(ref)); if (target !== undefined) union(index, target); }
  });
  // Connected interval components per known person/place, rather than an
  // all-pairs comparison. Bounded prefetch must also stay cheap on a large vault.
  for (const group of overlapGroups.values()) {
    group.sort((a, b) => picked[a]!.when!.from - picked[b]!.when!.from);
    let representative: number | undefined; let end = -Infinity;
    for (const index of group) {
      const span = picked[index]!.when!;
      if (representative !== undefined && span.from <= end) union(representative, index);
      else representative = index;
      end = Math.max(span.to, span.from <= end ? end : -Infinity);
    }
  }
  const groups = new Map<number, SituationFact[]>();
  picked.forEach((fact, index) => { const key = root(index); const group = groups.get(key) ?? []; group.push(fact); groups.set(key, group); });
  const scores = new Map<SituationFact, number>();
  const score = (fact: SituationFact): number => {
    const prior = scores.get(fact); if (prior !== undefined) return prior;
    const proposed = deps.rank?.(fact) ?? 1; const factor = Number.isFinite(proposed) ? Math.max(fact.consequence === 'floor' ? 1 : 0.5, Math.min(1.5, proposed)) : 1;
    const value = (fact.consequence === 'floor' ? 1000 : 0) + factor * ((fact.basis === 'inferred' ? 0 : 100)
      + (fact.updated_at > (query.changed_since ?? current) ? 50 : 0) - Math.min(90, Math.abs((fact.when?.from ?? window.from) - window.from) / DAY));
    scores.set(fact, value); return value;
  };
  const maxItems = Math.min(3, query.limit_items ?? 3);
  const clusters: Array<SituationCluster & { score: number }> = [...groups.values()].flatMap(group => {
    group.sort((a, b) => score(b) - score(a) || refKey(a.ref).localeCompare(refKey(b.ref)));
    const allSubjects = uniqueRefs(group.flatMap(fact => fact.subjects));
    const anchors = group.filter(fact => ['booking', 'calendar', 'occasion'].includes(fact.kind))
      .sort((a, b) => (a.when?.from ?? Infinity) - (b.when?.from ?? Infinity) || refKey(a.ref).localeCompare(refKey(b.ref)));
    const counts = new Map<string, { ref: SituationRef; count: number }>();
    for (const fact of group) for (const ref of fact.subjects) {
      const key = refKey(ref); const value = counts.get(key) ?? { ref, count: 0 }; value.count += 1; counts.set(key, value);
    }
    const common = [...counts.values()].sort((a, b) => b.count - a.count || refKey(a.ref).localeCompare(refKey(b.ref)))[0];
    const primary = anchors[0]?.ref ?? common?.ref ?? [...group].sort((a, b) => refKey(a.ref).localeCompare(refKey(b.ref)))[0]!.ref;
    const anchor = anchors[0] ?? group.find(fact => refKey(fact.ref) === refKey(primary)) ?? group[0]!;
    // The source identity owns its span. A moving look-ahead window or a newly
    // related passport must revise this trip, not mint a new trip each minute.
    const identity = refKey(primary);
    let inferred = 0;
    const admitted = group.filter(fact => fact.basis !== 'inferred' || ++inferred <= 1);
    const projecting = context.projectClusterItems !== undefined;
    const collisions = projecting ? collidingFacts(group) : undefined;
    const supplied = (projecting ? admitted : admitted.slice(0, maxItems)).map(fact => {
      const reasons = selected.get(refKey(fact.ref))!;
      if (collisions ? collisions.has(fact) : fact.when && group.some(other => other !== fact && other.when && intersects(fact.when!, other.when))) reasons.add('collides');
      return itemOf(fact, reasons, query, window, text);
    });
    const projected = context.projectClusterItems ? context.projectClusterItems(supplied) : supplied;
    if (projected === null || !projected.length) return [];
    const allowedItems = new Set(supplied);
    if (projected.some(item => !allowedItems.has(item))) throw new Error('A situation projection must use supplied items');
    const ordered = [...new Set(projected)]; const items = ordered.slice(0, maxItems);
    const omitted = projecting ? group.length - admitted.length + ordered.length - items.length : group.length - items.length;
    return [{ id: `situation-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`,
      subjects: allSubjects, span: anchor.when ?? null, items, omitted, score: score(group[0]!) }];
  }).filter(cluster => query.surface !== 'push' || cluster.items.some(item => item.consequence === 'floor'
    || (item.when.value && intersects(item.when.value, window))));
  clusters.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const visibleClusters = clusters.slice(0, Math.min(query.surface === 'push' ? 2 : 5, query.limit_clusters ?? 5));
  const names = new Map<string, SituationRef[]>();
  if (query.text) for (const fact of picked) {
    if (!text.title(fact.title)) continue;
    const title = fact.title.toLocaleLowerCase('en'); const refs = names.get(title) ?? []; refs.push(fact.ref); names.set(title, refs);
  }
  const ambiguous = [...names].filter(([, refs]) => refs.length > 1).map(([name, choices]) => ({ name, choices }));
  if (namedPeople.length > 1) {
    const choices = uniqueRefs(picked.filter(fact => fact.people.some(id => namedIds.has(id))).map(fact => fact.ref));
    if (choices.length > 1) ambiguous.push({ name: namedPeople.map(person => person.name).join(' / '), choices });
  }
  return { clusters: visibleClusters.map(({ score: _score, ...cluster }) => cluster),
    omitted: picked.length - visibleClusters.reduce((sum, cluster) => sum + cluster.items.length, 0), ambiguous,
    ...(partial.size ? { partial: [...partial].sort() } : {}) };
};
