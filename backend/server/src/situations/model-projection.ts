import { contactExcludedFromProactive, type SituationItem, type SituationRef, type SituationResult } from '@recued/contracts';
import type { ContactStore } from '../storage/contact-store.js';
import { eventWhenOnTurnClock } from '../chat-clock.js';
import { assetContextModelProjection } from './asset-context-model-projection.js';

/** A check's ref field names the record it is checked against
 * (`trip_validity:booking:<id>`, `trip_document:<traveller>`), and an id inside
 * a string is beyond every privacy tag: a traveller's contact id can be their
 * email. A model reads the kind of check alone; the trip is in the item's
 * evidence and the traveller in its `who`, both aliased. */
const refForModel = <T extends { field?: string }>(value: T): T => value.field === undefined ? value
  : { ...value, field: value.field.replace(/^(trip_validity|trip_document):.*$/su, '$1') };

/** A contact's name by an id an item's `who` carries, as the store names it; none
 * for a person no longer on file or one the owner marked (hidden, deceased, former
 * partner). */
export const situationPersonName = (contacts: Pick<ContactStore, 'get' | 'getByContactIdResolved'> | undefined) =>
  (id: string): string | undefined => {
    const contact = contacts?.getByContactIdResolved(id) ?? contacts?.get(id);
    return contact?.name && !contactExcludedFromProactive(contact) ? contact.name : undefined;
  };

/** What a model's copy of an item is written against: the turn's clock, and the Agenda's
 * rule for a private item. Neither is part of the item. */
export interface SituationModelView { zone?: string; isPrivate?: (item: SituationItem) => boolean }

const DAY_MS = 86_400_000;
const dayAfter = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** When an item happens, written for a model on the turn's clock, as `calendar.search`
 * writes an event: `2026-10-20 09:00–10:00 (UTC-07:00)`. A declared whole day keeps its
 * own label in every zone (`when_day`): `2026-10-20, all day`, and its last day too when
 * it spans several whole days. None without a zone (an MCP caller keeps its own clock)
 * or without a time. `when.value` stays epoch ms, which the overlap arithmetic reads.
 *
 * ⛔ Live (2026-11-04, qwen3.7-plus), given only the epoch ms, an Agenda suggestions run
 * put every one of the owner's meetings an hour early. */
export const situationWhenText = (item: Pick<SituationItem, 'when' | 'when_day'>, zone: string | undefined): string | undefined => {
  if (zone === undefined) return undefined;
  const window = item.when.value;
  if (item.when_day !== undefined) {
    const length = window ? window.to - window.from : 0;
    // Whole days, give or take a clock change (an hour; half of one in a few zones).
    // A span that is not (a trip's check, labelled with its entry day) keeps its one day.
    const days = Math.round(length / DAY_MS);
    const whole = days > 1 && Math.abs(length - days * DAY_MS) <= 90 * 60_000;
    const last = whole ? dayAfter(item.when_day, days - 1) : item.when_day;
    return last === item.when_day ? `${item.when_day}, all day` : `${item.when_day} – ${last}, all day`;
  }
  return window ? eventWhenOnTurnClock({ start_at: window.from, end_at: window.to }, zone) : undefined;
};

/** An item as a model reads it, from the tool or from the chat's lookup.
 *
 * ⛔ `who` holds contact ids, and its privacy tag is `name` (`canonical-pii-schemas.ts`):
 * an id aliased as a name mints a person alias of its own, so a model asked about Ana Lin
 * as `pii.Person2` met her records as `pii.Person1`. Live, with `who: match`, it said they
 * were someone else's. The model reads each person's name instead, aliased as the same
 * name is everywhere; a person without one (`situationPersonName`) keeps the id.
 * Given the turn's zone it says when the item happens (`situationWhenText`), and given the
 * Agenda's rule it marks an item the owner's notifications call only "a reminder in Yours". */
export const situationItemForModel = (item: SituationItem, personName?: (id: string) => string | undefined, view: SituationModelView = {}): SituationItem => {
  const when_text = situationWhenText(item, view.zone);
  // `private` goes beside the title and `when_text` beside `when`, where a model reading the row
  // meets each. ⛔ Live (2026-11-04), told to call "a private reminder" only that and given no
  // sign of which item it was, the model named the owner's private occasion 7 times in 7.
  const { ref, kind, what, when, ...rest } = item;
  return { ref: refForModel(ref), kind, ...(view.isPrivate?.(item) ? { private: true as const } : {}),
    what: { ...what, evidence: what.evidence.map(refForModel) },
    when: { ...when, evidence: when.evidence.map(refForModel) },
    ...(when_text !== undefined ? { when_text } : {}),
    ...rest, evidence: item.evidence.map(refForModel),
    where: { ...item.where, evidence: item.where.evidence.map(refForModel) },
    who: { ...item.who, ...(item.who.value && personName ? { value: item.who.value.map(id => personName(id) ?? id) } : {}),
      evidence: item.who.evidence.map(refForModel) },
  };
};

/** Mark each structured value at its source, for a tool result: the egress
 * resolver reads the markers before any text is rendered. The chat's lookup
 * sends its items unmarked (`prefetch.ts`). */
export const situationModelProjection = (result: SituationResult, personName?: (id: string) => string | undefined, view: SituationModelView = {}): SituationResult => {
  const ref = (value: SituationRef): SituationRef => ({ ...refForModel(value), __entity: 'situation_ref' } as SituationRef);
  return { ...result, ...(result.fact_context ? { fact_context: assetContextModelProjection(result.fact_context) } : {}), clusters: result.clusters.map(cluster => ({ ...cluster,
    subjects: cluster.subjects.map(ref), items: cluster.items.map(item => situationItemForModel(item, personName, view)).map(item => ({ ...item,
      __entity: 'situation_item', ref: ref(item.ref), evidence: item.evidence.map(ref),
      what: { ...item.what, evidence: item.what.evidence.map(ref) },
      when: { ...item.when, evidence: item.when.evidence.map(ref) },
      where: { ...item.where, evidence: item.where.evidence.map(ref) },
      who: { ...item.who, evidence: item.who.evidence.map(ref) },
    })),
  })), ambiguous: result.ambiguous.map(value => ({ ...value, __entity: 'situation_ambiguity', choices: value.choices.map(ref) })) };
};
