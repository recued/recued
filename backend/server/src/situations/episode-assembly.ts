import type { EpisodeInput, SituationRef, SituationWindow } from '@recued/contracts';
import { episodeCandidateId } from '../storage/proactive-history-store.js';
import type { ProactiveTrace } from '../storage/proactive-trace-store.js';

export interface EpisodePlan {
  ref: SituationRef;
  title: string;
  when: SituationWindow;
  where?: ProactiveTrace['where'];
  people: string[];
  subjects: SituationRef[];
  sphere?: ProactiveTrace['sphere'];
  routine?: boolean;
}
const key = (ref: SituationRef) => JSON.stringify([ref.collection, ref.id]);
const related = (plan: EpisodePlan, trace: ProactiveTrace): boolean => Boolean(plan.where && trace.where && plan.where.key === trace.where.key
  || plan.people.some(person => trace.people.includes(person)) || plan.subjects.some(subject => trace.subjects.some(other => key(subject) === key(other))));

/** Pure evidence assembly. A cancelled/routine plan is excluded by the
 * adapter. Time alone does not prove attendance, and ambiguity never chooses
 * one of two overlapping plans. No candidate is persisted here. */
export const assembleEpisodes = (plans: readonly EpisodePlan[], traces: readonly ProactiveTrace[], ownerRecords: readonly EpisodeInput[], at: number): EpisodeInput[] => {
  const eligible = plans.filter(plan => !plan.routine && plan.when.to <= at);
  const groups = new Map<EpisodePlan, ProactiveTrace[]>(); const unmatched: ProactiveTrace[] = [];
  for (const trace of traces) {
    if (trace.when.to > at) continue;
    const matching = eligible.filter(plan => plan.when.from <= trace.when.to && plan.when.to >= trace.when.from && related(plan, trace)
      && (!plan.sphere || !trace.sphere || plan.sphere === trace.sphere));
    if (matching.length !== 1) { unmatched.push(trace); continue; }
    const values = groups.get(matching[0]!) ?? []; values.push(trace); groups.set(matching[0]!, values);
  }
  const result = [...ownerRecords];
  for (const [plan, evidence] of groups) {
    const classes = [...new Set(evidence.map(trace => trace.class_id))];
    result.push({ id: episodeCandidateId([plan.ref]), title: plan.title, when: plan.when, people: [...new Set([...plan.people, ...evidence.flatMap(trace => trace.people)])],
      subjects: [plan.ref, ...plan.subjects], where: plan.where, sphere: plan.sphere, evidence: [plan.ref, ...evidence.flatMap(trace => trace.retained_at ? [{ collection: 'history_trace', id: trace.id }, ...trace.sources] : trace.sources)],
      ...(classes.length === 1 ? { class_id: classes[0] } : {}), notes: evidence.map(trace => trace.title).join('\n'), basis: 'derived',
      sensitive: [], storage_reason: 'proposal_citation', assembly_rule: 'plan_trace.v1' });
  }
  for (const trace of unmatched) result.push({ id: episodeCandidateId([{ collection: 'history_trace', id: trace.id }]), title: trace.title,
    when: trace.when, people: trace.people, subjects: trace.subjects, where: trace.where, sphere: trace.sphere,
    evidence: trace.retained_at ? [{ collection: 'history_trace', id: trace.id }, ...trace.sources] : trace.sources,
    basis: 'inferred', class_id: trace.class_id, sensitive: [], storage_reason: 'proposal_citation', assembly_rule: 'trace_only.v1' });
  return result;
};
