import { assetDateAt, evaluateAssetRuleClock, shiftAssetDate, type Asset, type AssetReading, type AssetRule, type AssetRuleClock, type Commitment } from '@recued/contracts';
import type { AssetOccurrence } from '../storage/asset-occurrence-store.js';

/** A cancelled service skips one cycle without claiming a new last-done fact.
 * Readers and the occurrence service must select the same current interval. */
export const assetIntervalCycle = (input: {
  asset: Asset; rule: AssetRule; occurrences: readonly AssetOccurrence[];
  readCommitment(id: string): Commitment | null; now: number; timeZone: string;
}): number | undefined => {
  const { asset, rule } = input;
  if (rule.when.kind !== 'interval') return undefined;
  const anchor = asset.dates[rule.when.field]; if (!anchor) return undefined;
  const prefix = `${anchor}:`; let cycle = 1; let latest: AssetOccurrence | undefined;
  for (const row of input.occurrences) {
    if (row.asset_id !== asset.id || row.trigger_kind !== 'rule' || row.rule_id !== rule.id || !row.cycle.startsWith(prefix)
      || Boolean(row.commitment_id) !== (rule.reaction.occurrence === 'action')) continue;
    const value = Number(row.cycle.slice(prefix.length));
    if (Number.isSafeInteger(value) && value >= cycle) { cycle = value; latest = row; }
  }
  const closed = latest?.commitment_id ? input.readCommitment(latest.commitment_id) : null;
  if (closed?.lifecycle_state !== 'expired' && closed?.lifecycle_state !== 'cancelled') return cycle;
  // Skip elapsed cycles directly, retaining the real last-done anchor and the
  // original terminal outcome rather than creating a backlog of missed tasks.
  const today = assetDateAt(input.now, input.timeZone); const every = rule.when.every;
  const date = (n: number) => shiftAssetDate(anchor, { ...every, amount: every.amount * n });
  let low = cycle + 1; let high = low;
  while (date(high) <= today) { high *= 2; if (high > 1_000_000) throw new Error('Interval cycle out of range'); }
  while (low < high) { const middle = Math.floor((low + high) / 2); if (date(middle) <= today) low = middle + 1; else high = middle; }
  return low;
};

/** The episode an objective occurrence row belongs to, or undefined for another
 * rule shape or target. The first episode is the plain `field:target` key. */
export const objectiveCycleNumber = (rule: AssetRule, cycle: string): number | undefined => {
  if (rule.when.kind !== 'objective') return undefined;
  const base = `${rule.when.field}:${rule.when.target}`;
  if (cycle === base) return 1;
  const n = cycle.startsWith(`${base}:`) ? Number(cycle.slice(base.length + 1)) : NaN;
  return Number.isSafeInteger(n) && n > 1 ? n : undefined;
};

/** The clock an occurrence row still stands for, or null once the clock has
 * left it: a renewed date, a recovered condition or a later usage cycle. */
export const assetOccurrenceClock = (input: {
  asset: Asset; rule: AssetRule; row: Pick<AssetOccurrence, 'cycle' | 'question'>; now: number; timeZone: string; readings?: readonly AssetReading[];
}): AssetRuleClock | null => {
  const { rule, row } = input;
  const cycle = rule.when.kind === 'interval' && !row.question ? Number(row.cycle.split(':').at(-1)) : objectiveCycleNumber(rule, row.cycle);
  const clock = evaluateAssetRuleClock(input.asset, rule, { now: input.now, timeZone: input.timeZone,
    ...(cycle ? { cycle } : {}), ...(input.readings ? { readings: input.readings } : {}) });
  if ((!clock.active && !clock.question) || clock.recovered) return null;
  if (['expiry', 'interval'].includes(rule.when.kind) && clock.cycle !== row.cycle) return null;
  if (rule.when.kind === 'objective' && rule.when.mode === 'usage' && clock.cycle !== row.cycle) return null;
  return clock;
};

/** A condition breach after a recovery, and a usage target skipped as not needed,
 * are new episodes. A confirmed service moves the rule's own target instead, and an
 * acknowledged condition stays acknowledged until it recovers. Readers and the
 * occurrence service must select the same episode. */
export const assetObjectiveCycle = (input: {
  rule: AssetRule; occurrences: readonly AssetOccurrence[]; readCommitment(id: string): Commitment | null;
}): number | undefined => {
  const { rule } = input;
  if (rule.when.kind !== 'objective') return undefined;
  let cycle = 1; let latest: AssetOccurrence | undefined;
  for (const row of input.occurrences) {
    if (row.trigger_kind !== 'rule' || row.rule_id !== rule.id || Boolean(row.commitment_id) !== (rule.reaction.occurrence === 'action')) continue;
    const value = objectiveCycleNumber(rule, row.cycle);
    if (value !== undefined && value >= cycle) { cycle = value; latest = row; }
  }
  if (!latest) return cycle;
  if (rule.when.mode === 'condition') return latest.rearmed_at !== null ? cycle + 1 : cycle;
  const closed = latest.commitment_id ? input.readCommitment(latest.commitment_id) : null;
  return rule.when.every && (closed?.lifecycle_state === 'cancelled' || closed?.lifecycle_state === 'expired') ? cycle + 1 : cycle;
};
