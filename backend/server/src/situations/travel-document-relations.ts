import { assetDateAt, calendarDayMs, shiftAssetDate, type SituationFact, type TravelValidityRule } from '@recued/contracts';
import type { SituationReadContext } from './query.js';

/** "No passport on file" is a claim about every travel document, so it needs a
 * reader that sees them all: the owner or an all-sphere contract granted the
 * asset source. Any other reader sees only the documents it was admitted. */
export const travelDocumentsVisible = (context: SituationReadContext, asset: { verb_op: string; collection: string } | undefined): boolean =>
  (context.owner || context.all_spheres === true) && asset !== undefined
  && context.grants.isVerbOpGranted(asset.verb_op) && context.grants.isCollectionReadGranted(asset.collection);

/** A check names this many of its traveller's visas and counts the rest. */
const VISAS_NAMED = 5;
/** The traveller's visas, as their owner recorded them, latest expiry first. */
const visasOnFile = (visas: readonly SituationFact[]): string => {
  if (!visas.length) return '';
  const named = visas.map(fact => fact.visa!)
    .sort((a, b) => (b.expires_on ?? '').localeCompare(a.expires_on ?? '') || a.name.localeCompare(b.name)).slice(0, VISAS_NAMED)
    .map(visa => {
      const recorded = [...(visa.valid_for ? [`valid for ${visa.valid_for}`] : []), ...(visa.expires_on ? [`expires ${visa.expires_on}`] : [])];
      return recorded.length ? `${visa.name} (${recorded.join(', ')})` : visa.name;
    });
  return ` · visas on file: ${named.join('; ')}${visas.length > named.length ? `; and ${visas.length - named.length} more` : ''}`;
};

/** Table arithmetic only. The table belongs to an installed pack, with
 * jurisdiction and applicability explicitly recorded beside its source. */
export const relateTravelDocuments = (facts: readonly SituationFact[], rules: readonly TravelValidityRule[], timeZone: string,
  documentsVisible = false): SituationFact[] => {
  const documents = [...new Map(facts.filter(fact => fact.travel_document).map(fact => [fact.ref.id, fact])).values()];
  const visas = [...new Map(facts.filter(fact => fact.visa).map(fact => [fact.ref.id, fact])).values()];
  const result: SituationFact[] = [];
  for (const tripFact of facts) {
    const trip = tripFact.trip; if (!trip || !tripFact.when) continue;
    const entry = trip.entry_on ?? assetDateAt(tripFact.when.from, timeZone);
    const exit = trip.exit_on ?? assetDateAt(tripFact.when.to, timeZone);
    if (!trip.travellers.length) continue; // one private proposal asks; no fabricated holder match
    for (const holder of trip.travellers) {
      const held = documents.filter(fact => fact.travel_document!.holder === holder);
      // The traveller's visas go with each check of theirs, tied to a passport or not.
      // Whether one covers this trip is the reader's call, so the check names each
      // with what its owner recorded and cites it (the owner, 2026-10-23).
      const theirs = visas.filter(fact => fact.people.includes(holder));
      const onFile = visasOnFile(theirs);
      const cited = theirs.map(fact => ({ collection: fact.ref.collection, id: fact.ref.id }));
      // §6.3 — each traveller's own document decides. A traveller with none on
      // file is asked about where the table covers the destination, never skipped;
      // without a document there is no nationality to rule them out.
      // A check names its traveller as its person (`people`), never in its title: the
      // holder is a contact id, which an owner cannot read and the egress aliases
      // only where it stands as a person.
      if (!held.length) {
        if (!documentsVisible || !rules.some(row => row.destination_countries.includes(trip.destination_country ?? ''))) continue;
        result.push({ ...tripFact, ref: { ...tripFact.ref, field: `trip_document:${holder}` }, kind: 'travel_validity',
          title: `${tripFact.title} · a traveller has no passport on file; check whether this trip needs one${onFile}`,
          related: [tripFact.ref], subjects: [tripFact.ref], people: [holder], when: tripFact.when, when_day: entry,
          act_by: calendarDayMs(entry)!, valid_until: tripFact.when.to, missing: true, basis: 'derived', consequence: 'routine',
          evidence: [...tripFact.evidence, ...cited], updated_at: Math.max(tripFact.updated_at, ...theirs.map(fact => fact.updated_at)),
          represents: undefined, travel_document: undefined, trip: undefined });
        continue;
      }
      // A citizen going home, or a national every table covering the destination
      // exempts, has nothing to check, whatever other passport they also hold.
      const destination = trip.destination_country ?? '';
      const covering = rules.filter(row => row.destination_countries.includes(destination));
      if (held.some(fact => {
        const nationality = fact.travel_document!.nationality;
        return nationality !== undefined && (nationality === destination
          || covering.length > 0 && covering.every(row => row.except_nationalities.includes(nationality)));
      })) continue;
      for (const document of held) {
        const data = document.travel_document!;
        const rule = covering.find(row => data.nationality !== undefined && !row.except_nationalities.includes(data.nationality));
        let verdict: string;
        let missing = false;
        let floor = false;
        if (!rule || trip.special_entry_status) { verdict = 'Entry validity needs checking: no applicable short-stay rule'; missing = true; }
        else {
          const minimum = shiftAssetDate(exit, { amount: rule.months_after_exit, unit: 'months' });
          const issueBoundary = shiftAssetDate(entry, { amount: rule.issued_within_years * 12, unit: 'months' }, -1);
          const problems: string[] = [];
          if (!data.expires_on) { problems.push('expiry date unknown'); missing = true; }
          else if (data.expires_on < minimum) { problems.push(`expires ${data.expires_on}; needs at least ${minimum}`); floor = true; }
          if (!data.issued_on) { problems.push('issue date unknown'); missing = true; }
          else if (data.issued_on <= issueBoundary || data.issued_on > entry) { problems.push(`issued ${data.issued_on}; needs issue after ${issueBoundary} and by ${entry}`); floor = true; }
          verdict = `${problems.length ? problems.join('; ') : `Date requirements met: expires ${data.expires_on}, issued ${data.issued_on}`} · ${rule.label}, verified as of ${rule.verified_as_of} · ${rule.source_url}`;
        }
        result.push({ ...document, ref: { ...document.ref, field: `trip_validity:${tripFact.ref.collection}:${tripFact.ref.id}` }, kind: 'travel_validity', title: `${document.title} · ${verdict}${onFile}`,
          related: [tripFact.ref], subjects: [tripFact.ref, { collection: document.ref.collection, id: document.ref.id }], people: [holder],
          when: tripFact.when, when_day: entry, act_by: floor || missing ? calendarDayMs(entry)! : undefined,
          valid_until: tripFact.when.to, missing, basis: 'derived', consequence: floor ? 'floor' : 'routine',
          evidence: [...document.evidence, ...tripFact.evidence, ...cited],
          updated_at: Math.max(document.updated_at, tripFact.updated_at, ...theirs.map(fact => fact.updated_at)),
          // A computed validity check is distinct from the renewal obligation.
          // Keeping its represents pointer would collapse the verdict into the
          // canonical commitment and discard the validity text entirely.
          represents: undefined, travel_document: undefined, trip: undefined });
      }
    }
  }
  return result;
};
