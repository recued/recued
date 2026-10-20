import { calendarDayMs, dueSpan, evaluateAssetRuleClock, type Asset, type AssetRule, type AssetRuleClock, type SituationWindow } from '@recued/contracts';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import type { AssetOccurrence } from '../storage/asset-occurrence-store.js';
import type { AssetClockRow } from '../storage/asset-clock-store.js';
import { assetIntervalCycle, assetObjectiveCycle } from './asset-interval-cycle.js';

const DAY = 86_400_000;
/** An asset's own place labels, which its children inherit when they have none. */
export const assetPlaceLabels = (asset: Pick<Asset, 'anchors'>): string[] =>
  asset.anchors.flatMap(anchor => anchor.kind === 'place' && typeof anchor.name === 'string' && anchor.name.trim() ? [anchor.name] : []);
/** A document the travel validity table checks against a trip. */
export const isTravelDocument = (asset: Pick<Asset, 'class_id' | 'settings'>): boolean => asset.class_id === 'passport' || asset.settings.travel_document === true;
/** One enabled rule's clock as the situation query reads it. A reader without
 * the commitment grant sees the first cycle and never a commitment's lifecycle. */
export interface AssetRuleTiming {
  rule: AssetRule;
  clock: AssetRuleClock;
  /** Recovered, or the commitment of its cycle is no longer pending. */
  settled: boolean;
  /** The pending commitment this clock stands for. */
  represents?: string;
  when?: SituationWindow;
  act_by?: number;
  /** A notice's act-by lapses once its due day has ended. */
  lapses_at?: number;
}
export const assetRuleTimings = (asset: Asset, input: {
  work: Pick<WorkEntityStore, 'readCommitment' | 'assetReadingHistory'>;
  occurrences: readonly AssetOccurrence[];
  commitments: boolean;
  now: number;
  timeZone: string;
}): AssetRuleTiming[] => {
  const span = (day: string): SituationWindow => { const due = dueSpan(calendarDayMs(day)!, input.timeZone); return { from: due.start, to: due.end }; };
  return asset.rules.filter(rule => rule.enabled).map(rule => {
    const clock = evaluateAssetRuleClock(asset, rule, { now: input.now, timeZone: input.timeZone,
      ...(input.commitments ? { cycle: assetIntervalCycle({ asset, rule, occurrences: input.occurrences,
        readCommitment: input.work.readCommitment, now: input.now, timeZone: input.timeZone })
        ?? assetObjectiveCycle({ rule, occurrences: input.occurrences, readCommitment: input.work.readCommitment }) } : {}),
      ...(rule.when.kind === 'objective' ? { readings: input.work.assetReadingHistory(asset.id, rule.when.field) } : {}) });
    const timing: AssetRuleTiming = { rule, clock, settled: clock.recovered };
    if (input.commitments && !clock.recovered) {
      const cycle = input.occurrences.find(row => row.rule_id === rule.id && row.cycle === clock.cycle && Boolean(row.commitment_id) === (rule.reaction.occurrence === 'action'));
      if (cycle?.commitment_id) {
        if (input.work.readCommitment(cycle.commitment_id)?.lifecycle_state === 'pending') timing.represents = cycle.commitment_id;
        else timing.settled = true;
      }
    }
    if (clock.due_on) timing.when = span(clock.due_on);
    if (clock.act_by) timing.act_by = span(clock.act_by).from;
    if (clock.active && !clock.act_by && !clock.question) timing.act_by = rule.when.kind === 'condition'
      ? asset.observations[rule.when.field]?.as_of : rule.when.kind === 'objective' ? asset.readings[rule.when.field]?.as_of : undefined;
    if (rule.reaction.occurrence === 'notice' && timing.when) timing.lapses_at = timing.when.to;
    if (clock.question) timing.act_by = asset.created_at;
    return timing;
  });
};

/** What the clock index keeps for one asset: each rule's earliest act-by and
 * latest lapse over both views, so an indexed read finds every asset that either
 * view would select. The read still computes the facts itself. Values a later
 * clock reading could move earlier without a write are bounded below. */
export const assetClockRows = (asset: Asset, owner: readonly AssetRuleTiming[], plain: readonly AssetRuleTiming[], now: number): AssetClockRow[] =>
  owner.map(timing => {
    const views = [timing, ...plain.filter(other => other.rule.id === timing.rule.id)];
    const acting = views.filter(view => view.act_by !== undefined);
    const lapsing = acting.filter(view => view.lapses_at !== undefined);
    let act_by_at = acting.length ? Math.min(...acting.map(view => view.act_by!)) : null;
    let lapses_at = acting.length && lapsing.length === acting.length ? Math.max(...lapsing.map(view => view.lapses_at!)) : null;
    // A reading or observation dated ahead of now starts counting only then.
    const when = timing.rule.when;
    const future = when.kind === 'condition' ? asset.observations[when.field] : when.kind === 'objective' ? asset.readings[when.field] : undefined;
    if (future && future.as_of > now) {
      const floor = future.as_of - (Math.ceil(when.kind === 'objective' ? when.lead_days : 0) + 2) * DAY;
      act_by_at = Math.min(act_by_at ?? floor, floor); lapses_at = null;
    }
    return { rule_id: timing.rule.id, title: timing.rule.title, cycle: timing.clock.cycle, act_by_at, lapses_at,
      when_from: lapsing.length ? Math.min(...lapsing.map(view => view.when!.from)) : null,
      when_to: lapsing.length ? Math.max(...lapsing.map(view => view.when!.to)) : null };
  });
