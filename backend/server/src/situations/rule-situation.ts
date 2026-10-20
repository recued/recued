import type { AssetOccurrenceServiceDeps } from './asset-occurrence-service.js';
import type { SituationSnapshot } from '@recued/contracts';
import type { OccasionClockDeps } from './occasion-clock-service.js';
import { ruleStatement } from './rule-titles.js';
import type { SituationStore } from '../storage/situation-store.js';

/** The cycle a rule published is over: its task closed, a notice's cycle ended, or
 * its asset or occasion went. Its situation resolves; a cycle that never published
 * has none, and nothing happens. */
export const resolveRuleSituation = (situations: Pick<SituationStore, 'get' | 'save'>, occurrence_id: string, source: string, at: number): void => {
  const current = situations.get(occurrence_id);
  if (current) situations.save({ ...current.snapshot, state: 'resolved' }, { source }, at);
};

/** Rule events expose deciding values, never the rest of the asset record. */
export const ruleSituation = ({ occurrence, asset, rule, clock }: Parameters<NonNullable<AssetOccurrenceServiceDeps['emitRule']>>[0]): SituationSnapshot => {
  const evidence = [{ collection: 'asset', id: asset.id, field: `rules.${rule.id}` }, ...clock.evidence];
  const date = clock.due_on ? Date.parse(clock.due_on) : undefined;
  const span = { from: date ?? occurrence.created_at, to: date ?? occurrence.created_at };
  return { id: occurrence.id, state: 'proposed', urgency: rule.consequence,
    cluster: { id: occurrence.id, subjects: [{ collection: 'asset', id: asset.id }], span: date === undefined ? null : span, omitted: 0,
      items: [{ ref: occurrence.commitment_id ? { collection: 'commitment', id: occurrence.commitment_id } : { collection: 'asset', id: asset.id },
        kind: 'asset_rule', what: { value: `${rule.title} · ${asset.name}`, verdict: 'match', basis: 'declared', evidence },
        when: { value: date === undefined ? null : span, verdict: date === undefined ? 'unknown' : 'match', basis: 'declared', evidence },
        where: { value: null, verdict: 'unknown', basis: 'declared', evidence: [] },
        who: { value: asset.holder_contact ? [asset.holder_contact] : null, verdict: asset.holder_contact ? 'match' : 'unknown', basis: 'declared', evidence },
        reasons: ['due'], basis: 'declared', evidence, consequence: rule.consequence,
        ...(asset.sphere ? { sphere: asset.sphere } : {}), updated_at: asset.updated_at }] } };
};

export const occasionRuleSituation = ({ occurrence, occasion, rule, clock }: Parameters<NonNullable<OccasionClockDeps['emitRule']>>[0]): SituationSnapshot => {
  const evidence = [{ collection: 'occasion', id: occasion.id, field: `rules.${rule.id}` }, ...(occasion.source ? [occasion.source] : []), ...clock.evidence];
  const date = clock.due_on ? Date.parse(clock.due_on) : undefined;
  const span = { from: date ?? occurrence.created_at, to: date ?? occurrence.created_at };
  return { id: occurrence.id, state: 'proposed', urgency: rule.consequence,
    cluster: { id: occurrence.id, subjects: [{ collection: 'occasion', id: occasion.id }], span: date === undefined ? null : span, omitted: 0,
      items: [{ ref: occurrence.commitment_id ? { collection: 'commitment', id: occurrence.commitment_id } : { collection: 'occasion', id: occasion.id },
        kind: 'occasion_rule', what: { value: ruleStatement(rule, occasion.title), verdict: 'match', basis: 'declared', evidence },
        when: { value: date === undefined ? null : span, verdict: date === undefined ? 'unknown' : 'match', basis: 'declared', evidence },
        where: { value: occasion.where ?? null, verdict: occasion.where ? 'match' : 'unknown', basis: 'declared', evidence },
        who: { value: occasion.people.length ? occasion.people : null, verdict: occasion.people.length ? 'match' : 'unknown', basis: 'declared', evidence },
        reasons: ['due'], basis: 'declared', evidence, consequence: rule.consequence,
        ...(occasion.sphere ? { sphere: occasion.sphere } : {}), updated_at: occasion.updated_at }] } };
};
