import { assetConditionExpected, assetDateAt, type Asset, type Commitment, type YoursAssetSummary } from '@recued/contracts';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import type { AssetOccurrence } from '../storage/asset-occurrence-store.js';
import { assetRuleTimings } from './asset-rule-timing.js';

/** A summary reads existing clocks and tasks. It never reconciles or writes. */
export const summarizeYoursAsset = (asset: Asset, input: {
  work: Pick<WorkEntityStore, 'readCommitment' | 'assetReadingHistory'>;
  occurrences: readonly AssetOccurrence[];
  now: number;
  timeZone: string;
}): YoursAssetSummary => {
  const today = assetDateAt(input.now, input.timeZone);
  const commitments = new Map<string, Commitment | null>();
  const readCommitment = (id: string): Commitment | null => {
    if (!commitments.has(id)) {
      const row = input.work.readCommitment(id);
      commitments.set(id, row && row.deleted_at == null && ['live', 'stale_unreachable'].includes(row.sync_state) ? row : null);
    }
    return commitments.get(id)!;
  };
  const occurrences = input.occurrences.filter(row => row.asset_id === asset.id && row.subject_kind !== 'occasion');
  const available = asset.deleted_at == null && ['live', 'stale_unreachable'].includes(asset.sync_state);
  const active = available && ['active', 'lent'].includes(asset.status);
  const timings = active ? assetRuleTimings(asset, { ...input, work: { readCommitment, assetReadingHistory: input.work.assetReadingHistory },
    occurrences, commitments: true }) : [];
  const dates: NonNullable<YoursAssetSummary['next_due']>[] = [];
  const state = (on: string) => on < today ? 'overdue' as const : on === today ? 'today' as const : 'upcoming' as const;
  const pending = new Set<string>();
  if (available) for (const row of occurrences) {
    const task = row.commitment_id ? readCommitment(row.commitment_id) : null;
    if (!task || task.lifecycle_state !== 'pending' || pending.has(task.id)) continue;
    pending.add(task.id);
    if (task.promised_for_at === undefined) continue;
    // Yours uses the canonical task's calendar day, including an owner edit.
    const on = new Date(task.promised_for_at).toISOString().slice(0, 10);
    const timing = timings.find(timing => timing.rule.id === row.rule_id && timing.represents === task.id);
    dates.push({ on, title: task.statement, rule_id: row.rule_id, commitment_id: task.id, state: state(on),
      estimated: timing?.clock.due_on === on && timing.clock.estimated === true });
  }
  const missing = new Map<string, YoursAssetSummary['missing'][number]>();
  for (const timing of timings) {
    const { rule, clock } = timing; const when = rule.when;
    if (!timing.settled && !timing.represents && clock.due_on && (timing.lapses_at === undefined || timing.lapses_at >= input.now)) {
      dates.push({ on: clock.due_on, title: rule.title, rule_id: rule.id, state: state(clock.due_on), estimated: clock.estimated === true });
    }
    const kind = when.kind === 'expiry' || when.kind === 'interval' ? 'dates' : when.kind === 'objective' ? 'readings' : 'observations';
    const path = `${kind}.${when.field}` as YoursAssetSummary['missing'][number]['path'];
    if (kind === 'dates') {
      if (!asset.dates[when.field]) missing.set(path, { path, reason: 'unknown' });
    } else {
      const value = asset[kind][when.field];
      if (!value) missing.set(path, { path, reason: 'unknown' });
      else if (value.as_of > input.now) missing.set(path, { path, reason: 'future' });
      // A state the owner marked expected needs no confirming.
      else if (when.kind === 'condition' && when.certainty === 'confirmed' && 'active' in value && value.active && value.certainty !== 'confirmed'
        && !assetConditionExpected(asset, when.field, value.active))
        missing.set(path, { path, reason: 'unconfirmed' });
    }
  }
  dates.sort((a, b) => a.on.localeCompare(b.on) || Number(!!b.commitment_id) - Number(!!a.commitment_id)
    || a.title.localeCompare(b.title) || a.rule_id.localeCompare(b.rule_id));
  return { asset_id: asset.id, open_tasks: pending.size, active_rules: timings.length,
    next_due: dates[0] ?? null, missing: [...missing.values()].sort((a, b) => a.path.localeCompare(b.path)) };
};
