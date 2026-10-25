import { contactExcludedFromProactive, type SituationItem, type SituationRef, type SituationResult } from '@recued/contracts';
import type { ContactStore } from '../storage/contact-store.js';
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

/** An item as a model reads it, from the tool or from the chat's lookup.
 *
 * ⛔ `who` holds contact ids, and its privacy tag is `name` (`canonical-pii-schemas.ts`):
 * an id aliased as a name mints a person alias of its own, so a model asked about Ana Lin
 * as `pii.Person2` met her records as `pii.Person1`. Live, with `who: match`, it said they
 * were someone else's. The model reads each person's name instead, aliased as the same
 * name is everywhere; a person without one (`situationPersonName`) keeps the id. */
export const situationItemForModel = (item: SituationItem, personName?: (id: string) => string | undefined): SituationItem => ({ ...item,
  ref: refForModel(item.ref), evidence: item.evidence.map(refForModel),
  what: { ...item.what, evidence: item.what.evidence.map(refForModel) },
  when: { ...item.when, evidence: item.when.evidence.map(refForModel) },
  where: { ...item.where, evidence: item.where.evidence.map(refForModel) },
  who: { ...item.who, ...(item.who.value && personName ? { value: item.who.value.map(id => personName(id) ?? id) } : {}),
    evidence: item.who.evidence.map(refForModel) },
});

/** Mark each structured value at its source, for a tool result: the egress
 * resolver reads the markers before any text is rendered. The chat's lookup
 * sends its items unmarked (`prefetch.ts`). */
export const situationModelProjection = (result: SituationResult, personName?: (id: string) => string | undefined): SituationResult => {
  const ref = (value: SituationRef): SituationRef => ({ ...refForModel(value), __entity: 'situation_ref' } as SituationRef);
  return { ...result, ...(result.fact_context ? { fact_context: assetContextModelProjection(result.fact_context) } : {}), clusters: result.clusters.map(cluster => ({ ...cluster,
    subjects: cluster.subjects.map(ref), items: cluster.items.map(item => situationItemForModel(item, personName)).map(item => ({ ...item,
      __entity: 'situation_item', ref: ref(item.ref), evidence: item.evidence.map(ref),
      what: { ...item.what, evidence: item.what.evidence.map(ref) },
      when: { ...item.when, evidence: item.when.evidence.map(ref) },
      where: { ...item.where, evidence: item.where.evidence.map(ref) },
      who: { ...item.who, evidence: item.who.evidence.map(ref) },
    })),
  })), ambiguous: result.ambiguous.map(value => ({ ...value, __entity: 'situation_ambiguity', choices: value.choices.map(ref) })) };
};
