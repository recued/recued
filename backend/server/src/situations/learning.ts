import { createHash } from 'node:crypto';
import { calendarDayMs, shiftAssetDate, type AssetRule, type ProactiveProposalInput, type SituationRef, type Sphere } from '@recued/contracts';

const DAY = 86_400_000;
export const learningDigest = (value: unknown): string => {
  const stable = (input: unknown): unknown => Array.isArray(input) ? input.map(stable) : input && typeof input === 'object'
    ? Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, stable(value)])) : input;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
};
export const learningPool = (class_id: string, sphere: Sphere | undefined, rule: AssetRule): string =>
  JSON.stringify([class_id, sphere ?? 'unsorted', rule.id, rule.when.kind, rule.when.field, rule.consequence]);
/** How far back clock signals are read: outcomes are sparse, one a year for a
 * boiler and one a decade for a passport (§8). Retention keeps the same span. */
export const LEARNING_LOOKBACK_MS = 30 * 366 * DAY;
/** How far back trip-to-class openings count towards a relation. */
export const RELATION_LOOKBACK_MS = 10 * 366 * DAY;
export const relationKey = (target_class: string, sphere: Sphere | undefined): string => learningDigest(['trip', target_class, sphere]);
export const relationOfferKey = (key: string): string => `learning:relation:${key}`;
export interface ClockLearningSignal {
  id: string; pool: string; subject: SituationRef; rule_id: string; at: number;
  outcome: 'fulfilled' | 'dismissed' | 'lapsed'; actor: 'owner' | 'system';
  due_on: string | null; acted_on?: string; surfaced: 'before' | 'late' | 'none' | 'unknown';
  occasion_on?: string;
  evidence: SituationRef[];
}
export interface ServiceLearningSignal {
  id: string; pool: string; asset_id: string; on: string; evidence: SituationRef[];
}
export interface LearningTarget {
  ref: SituationRef; name: string; class_id: string; sphere?: Sphere; rule: AssetRule; due_on: string | null;
  occasion_on?: string;
}
export const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2 : 0;
};
const offsetsInDays = (rule: AssetRule, on: string) => rule.schedule.before.map(offset =>
  (calendarDayMs(on)! - calendarDayMs(shiftAssetDate(on, offset, -1))!) / DAY);
const refs = (input: readonly SituationRef[]): SituationRef[] => [...new Map(input.map(ref => [JSON.stringify([ref.collection, ref.id]), ref])).values()].slice(0, 10);
/** Counting uses authenticated outcomes. No response alone cannot lower a
 * clock, and lateness never becomes a later deadline. Every output is inert. */
export const clockLearningProposals = (target: LearningTarget, input: readonly ClockLearningSignal[], services: readonly ServiceLearningSignal[], weight = 1): ProactiveProposalInput[] => {
  const pool = learningPool(target.class_id, target.sphere, target.rule);
  const signals = input.filter(row => row.pool === pool && (row.actor === 'owner' || row.actor === 'system' && row.outcome === 'lapsed'));
  const distinct = [...new Map(signals.map(row => [JSON.stringify([row.subject.collection, row.subject.id]), row])).values()];
  const done = distinct.filter(row => row.outcome === 'fulfilled' && row.actor === 'owner' && row.due_on && row.acted_on);
  const dismissed = distinct.filter(row => row.outcome === 'dismissed' && row.actor === 'owner');
  const unseen = distinct.filter(row => row.outcome === 'lapsed' && row.surfaced === 'none');
  const late = done.filter(row => row.acted_on! > row.due_on!);
  const result: ProactiveProposalInput[] = [];
  const common = { subject: target.ref, sources: refs([target.ref, ...distinct.flatMap(row => row.evidence)]), confidence: 'medium' as const, origin: 'learner' as const };
  const baseline = learningDigest(target.rule); const scope = target.sphere ?? 'unsorted';
  const basePayload = { asset_id: target.ref.collection === 'asset' ? target.ref.id : undefined,
    occasion_id: target.ref.collection === 'occasion' ? target.ref.id : undefined, rule_id: target.rule.id,
    baseline_rule_hash: baseline, learning_pool: pool, proposal_class: `clock-learning:${target.class_id}:${scope}` };
  if (target.occasion_on) Object.assign(basePayload, { occasion_on: target.occasion_on });
  if (target.rule.enabled && !target.rule.muted && target.rule.reaction.notify && target.due_on
    && (done.length >= 3 || late.length >= 2 || unseen.length >= 2 || dismissed.length >= 3)) {
    const currentLead = Math.max(0, ...offsetsInDays(target.rule, target.due_on));
    let desired = currentLead; let explanation = '';
    if (late.length >= 2 || unseen.length >= 2) {
      const delay = median(late.map(row => (calendarDayMs(row.acted_on!)! - calendarDayMs(row.due_on!)!) / DAY));
      desired = Math.min(365, Math.max(7, Math.ceil(currentLead + delay + 7 + (unseen.length ? 7 : 0))));
      explanation = `${late.length} owner completions were late and ${unseen.length} lapses had no reminder released in time. Start ${desired} days before the same deadline?`;
    } else if (done.length >= 3) {
      const lead = median(done.map(row => Math.max(0, (calendarDayMs(row.due_on!)! - calendarDayMs(row.acted_on!)!) / DAY)));
      desired = Math.min(365, Math.max(7, Math.ceil(lead + 7)));
      explanation = `${done.length} owner completions in this class and ${scope} sphere had a median lead of ${Math.round(lead)} days. Start ${desired} days before the same deadline?`;
    } else if (dismissed.length >= 3) {
      desired = Math.min(currentLead, 7);
      explanation = `${dismissed.length} clocks in this class and ${scope} sphere were explicitly declined by the owner. Keep the date reminder and move the first reminder to ${desired} days before it?`;
    }
    if (Math.abs(desired - currentLead) >= 3) {
      const before = target.rule.schedule.before.filter((_, index) => offsetsInDays(target.rule, target.due_on!)[index]! <= desired);
      if (desired && !before.some(point => point.unit === 'days' && point.amount === desired)) before.push({ amount: desired, unit: 'days' });
      const schedule = { ...target.rule.schedule, before, on_day: true };
      result.push({ ...common, key: `learning:timing:${learningDigest([target.ref, baseline, pool, schedule])}`, kind: 'schedule',
        title: `Review reminder timing · ${target.name}`, explanation, payload: { ...basePayload, schedule } });
    }
  }
  if (distinct.length >= 3) {
    // An unseen lapse contributes to showing more. Floor ranking cannot be
    // reduced, and query ranking never alters the reminder caller's cadence.
    const score = done.length + unseen.length * 2 - dismissed.length;
    const desired = Math.max(target.rule.consequence === 'floor' ? 1 : 0.5, Math.min(1.5, Math.round((1 + score / Math.max(3, distinct.length) * 0.5) * 10) / 10));
    if (Math.abs(desired - weight) >= 0.15) result.push({ ...common,
      key: `learning:ranking:${learningDigest([pool, weight, desired])}`, kind: 'ranking', title: `Review situation ranking · ${target.class_id}`,
      explanation: `${done.length} owner completions, ${dismissed.length} explicit declines and ${unseen.length} unsurfaced lapses support a ranking factor of ${desired}. Reminder schedules and deadlines stay the same.`,
      payload: { ...basePayload, ranking_factor: desired, baseline_weight: weight } });
  }
  if (target.ref.collection === 'asset' && target.rule.when.kind === 'interval') {
    const grouped = new Map<string, ServiceLearningSignal[]>();
    for (const row of services.filter(row => row.pool === pool)) { const group = grouped.get(row.asset_id) ?? []; group.push(row); grouped.set(row.asset_id, group); }
    const gaps: number[] = []; const evidence: SituationRef[] = [];
    for (const group of grouped.values()) {
      const dates = [...new Set(group.map(row => row.on))].sort(); if (dates.length < 4) continue;
      for (let index = 1; index < dates.length; index++) { const gap = (calendarDayMs(dates[index]!)! - calendarDayMs(dates[index - 1]!)!) / DAY; if (gap >= 7 && gap <= 5 * 366) gaps.push(gap); }
      evidence.push(...group.flatMap(row => row.evidence));
    }
    if (gaps.length >= 3) {
      const cadence = Math.round(median(gaps)); const spread = median(gaps.map(value => Math.abs(value - cadence)));
      const anchor = target.due_on ?? '2026-01-01'; const expected = (calendarDayMs(anchor)! - calendarDayMs(shiftAssetDate(anchor, target.rule.when.every, -1))!) / DAY;
      // Adopt an earlier observed cadence only. A late service is never a
      // reason to extend a legal, safety or other existing deadline.
      if (cadence < expected * 0.9 && spread <= cadence * 0.1) {
        const rule = { ...target.rule, enabled: false, pinned: false, when: { ...target.rule.when, every: { amount: cadence, unit: 'days' as const } } };
        result.push({ ...common, sources: refs([target.ref, ...evidence]), key: `learning:cadence:${learningDigest([target.ref, baseline, pool, cadence])}`,
          kind: 'rule', title: `Review a service gap · ${target.name}`, explanation: `${gaps.length} confirmed service intervals have a median of ${cadence} days; the current interval is ${Math.round(expected)} days. Use the earlier cadence to flag a missing service record?`,
          payload: { ...basePayload, rule, proposal_class: `service-gap:${target.class_id}:${scope}` } });
      }
    }
  }
  return result;
};

/** D-325 §8, Option A — an item Today shows that no rule raises (a bill, a delivery) pools by
 * its kind, so what the owner does with it from Today can tune how that kind ranks. */
export const kindLearningPool = (kind: string): string => JSON.stringify(['kind', kind]);
export interface KindLearningSignal {
  id: string; pool: string; kind: string; subject: SituationRef; at: number;
  /** Opened from Today, or set aside there ("Not this one", "Never this kind"). */
  outcome: 'opened' | 'dismissed'; actor: 'owner';
}
const KIND_WORDS: Record<string, string> = { purchase: 'purchases', shipment: 'shipments', return_refund: 'returns and refunds',
  reservation: 'reservations', bill: 'bills', statement: 'statements', subscription: 'subscriptions', pay_tax_document: 'payslips and tax forms',
  lead: 'leads', order_received: 'orders received', owner_request: 'requests to your server' };
/** A mail fact kind as the owner reads it in a sentence. A type the owner made is named as they
 * named it (§4.5); its id is no word of theirs. */
export const kindWords = (kind: string, name?: string): string =>
  name ? `“${name}” items` : KIND_WORDS[kind] ?? `${kind.replace(/^custom_/u, '').replaceAll('_', ' ')} items`;
/** Travel and the law: every reservation is read as a possible trip, and a payslip or tax
 * form carries a filing duty. A mail fact's consequence is routine, so the query's floor
 * never covers these kinds; they never rank below where they start (§8). */
const KIND_FLOOR = new Set(['reservation', 'pay_tax_document']);
export const kindRankingFloor = (kind: string): number => KIND_FLOOR.has(kind) ? 1 : 0.5;
/** Two-sided, as clock ranking: an item the owner opened from Today argues for showing more
 * of its kind, one set aside for less, and one only ignored teaches nothing (§8). The output
 * is inert until the owner accepts it, and a travel or legal kind is never offered lower. */
export const kindRankingProposal = (kind: string, input: readonly KindLearningSignal[], weight = 1, name?: string): ProactiveProposalInput | null => {
  const pool = kindLearningPool(kind);
  const own = input.filter(row => row.pool === pool && row.actor === 'owner');
  const subjects = (outcome: KindLearningSignal['outcome']) =>
    new Set(own.filter(row => row.outcome === outcome).map(row => JSON.stringify([row.subject.collection, row.subject.id])));
  const opened = subjects('opened'); const setAside = subjects('dismissed');
  const distinct = new Set([...opened, ...setAside]).size;
  if (distinct < 3) return null;
  const desired = Math.max(kindRankingFloor(kind), Math.min(1.5, Math.round((1 + (opened.size - setAside.size) / Math.max(3, distinct) * 0.5) * 10) / 10));
  if (Math.abs(desired - weight) < 0.15) return null;
  const words = kindWords(kind, name); const direction = desired > weight ? 'higher' : 'lower';
  return { key: `learning:kind-ranking:${learningDigest([pool, weight, desired])}`, kind: 'ranking', title: `Rank ${words} ${direction} in Today`,
    explanation: `From Today you opened ${opened.size} and set aside ${setAside.size} of the ${words} it showed. Rank ${words} ${direction} in Today and your overview? Only their order changes: nothing is dismissed, and deadlines for safety, the law or travel still come first.`,
    sources: refs(own.map(row => row.subject)), confidence: 'medium', origin: 'learner',
    payload: { learning_pool: pool, item_kind: kind, ranking_factor: desired, baseline_weight: weight, proposal_class: `kind-ranking:${kind}` } };
};
