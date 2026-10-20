import type { SituationRef, SituationResult } from '@recued/contracts';

/** Mark each structured value at its source. Both tools and speculative
 * prefetch traverse the existing egress resolver before any text is rendered. */
export const situationModelProjection = (result: SituationResult): SituationResult => {
  const ref = (value: SituationRef): SituationRef => ({ ...value, __entity: 'situation_ref' } as SituationRef);
  return { ...result, clusters: result.clusters.map(cluster => ({ ...cluster,
    subjects: cluster.subjects.map(ref), items: cluster.items.map(item => ({ ...item,
      __entity: 'situation_item', ref: ref(item.ref), evidence: item.evidence.map(ref),
      what: { ...item.what, evidence: item.what.evidence.map(ref) },
      when: { ...item.when, evidence: item.when.evidence.map(ref) },
      where: { ...item.where, evidence: item.where.evidence.map(ref) },
      who: { ...item.who, evidence: item.who.evidence.map(ref) },
    })),
  })), ambiguous: result.ambiguous.map(value => ({ ...value, __entity: 'situation_ambiguity', choices: value.choices.map(ref) })) };
};
